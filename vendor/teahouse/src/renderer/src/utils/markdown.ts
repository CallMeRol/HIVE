// 群内统一 Markdown 渲染（ADR-0008 / SPEC #41）：
//   - 成熟 parser：`markdown-it`（**禁用原始 HTML**、开启 linkify）
//   - 成熟 sanitizer：`DOMPurify`（DOM 清洗；原始 HTML 已由 parser 转义，这是第二层）
//   - 渲染异常 / 依赖尚未就绪 → 回退纯文本（绝不因为渲染失败把消息内容吞掉）
//
// 为什么**动态加载**：markdown-it + DOMPurify 的静态闭包约 130KB，会顶破上游
// `scripts/check-renderer-bundles.mjs` 给 App.vue 的 800KB 预算——那是上游脚本、
// 不在补丁白名单内，不能改。动态 import 让它们进独立 chunk，不占根组件静态闭包。
//
// 代价：首次渲染前 `renderMarkdown` 返回纯文本回退，待依赖就绪后组件重渲染。
// 应用启动即 preload（见 renderer 入口），正常情况下用户看不到这一步。
//
// 链接不在此处注入 onclick —— 渲染结果只含安全 HTML，点击行为由组件用
// `window.pantry.openUrl` 绑定（受控外部链接打开）。

import type { MarkdownIt as MarkdownItInstance, RendererRule } from 'markdown-it'
import type DOMPurifyType from 'dompurify'

/** 允许的标签：Markdown 常规产出面，刻意不含 iframe / script / style / form / img。 */
const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del', 's', 'code', 'pre',
  'blockquote',
  'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'a', 'span'
]

const ALLOWED_ATTR = ['href', 'title']

/** 只放行 http/https：`javascript:` / `data:` / `file:` 等一律由 DOMPurify 去掉 href。 */
const ALLOWED_URI_RE = /^(?:https?|mailto):/i

interface MarkdownLibs {
  md: MarkdownItInstance
  purify: typeof DOMPurifyType
}

let libs: MarkdownLibs | null = null
let loading: Promise<MarkdownLibs | null> | null = null
const listeners = new Set<() => void>()

function createRenderer(MarkdownItCtor: typeof import('markdown-it').default): MarkdownItInstance {
  const md = new MarkdownItCtor({
    // 第一层防护：原始 HTML **不解析**，按纯文本转义。
    html: false,
    // 裸 URL 自动 linkify（SPEC #41 明确要求）。
    linkify: true,
    breaks: true,
    typographer: false
  })
  // 受控外链：href 只保留 http(s)/mailto，且外部链接在新窗口打开。
  const defaultLinkOpen: RendererRule =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const rawHref = tokens[idx].attrGet('href')
    const href = typeof rawHref === 'string' ? rawHref : ''
    if (!ALLOWED_URI_RE.test(href)) {
      tokens[idx].attrSet('href', '#')
      tokens[idx].attrSet('data-blocked-href', '1')
    } else {
      tokens[idx].attrSet('target', '_blank')
      tokens[idx].attrSet('rel', 'noopener noreferrer')
    }
    return defaultLinkOpen(tokens, idx, options, env, self)
  }
  return md
}

/** 是否已就绪（未就绪时 `renderMarkdown` 走纯文本回退）。 */
export function markdownReady(): boolean {
  return libs !== null
}

/**
 * 预加载 Markdown 依赖。应用启动时调用一次；返回的 promise 在依赖可用后 resolve。
 * 重复调用共用同一次加载。
 */
export function preloadMarkdown(): Promise<void> {
  if (libs) return Promise.resolve()
  if (!loading) {
    loading = Promise.all([import('markdown-it'), import('dompurify')])
      .then(([mdMod, purifyMod]) => {
        libs = { md: createRenderer(mdMod.default), purify: purifyMod.default }
        for (const listener of listeners) listener()
        return libs
      })
      .catch((err: unknown) => {
        // 加载失败不能变成静默空消息：留痕并让渲染永久走纯文本回退。
        console.error('[markdown] 依赖加载失败，群内消息回退纯文本：', err)
        return null
      })
  }
  return loading.then(() => undefined)
}

/** 订阅"依赖就绪"以便组件重渲染；返回取消订阅函数。 */
export function onMarkdownReady(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** HTML 转义（回退路径用；不依赖 DOM API，便于无 DOM 单测）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface MarkdownRenderResult {
  html: string
  /** true = 走了纯文本回退（依赖未就绪或渲染异常）；组件据此避开 v-html。 */
  plainFallback: boolean
}

/** 纯文本回退结果。 */
export function renderPlain(text: string): MarkdownRenderResult {
  return { html: escapeHtml(text), plainFallback: true }
}

/**
 * Markdown → 安全 HTML。依赖未就绪或任一环抛错 → 纯文本回退，并置 `plainFallback`。
 * 调用方用 `v-html` 渲染（内容已清洗），不得再自行拼 HTML。
 */
export function renderMarkdown(text: string): MarkdownRenderResult {
  if (!libs) return renderPlain(text)
  try {
    const raw = libs.md.render(text)
    const clean = libs.purify.sanitize(raw, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOWED_URI_REGEXP: ALLOWED_URI_RE,
      KEEP_CONTENT: true,
      RETURN_TRUSTED_TYPE: false
    })
    return { html: String(clean), plainFallback: false }
  } catch {
    return renderPlain(text)
  }
}
