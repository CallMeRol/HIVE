<script setup lang="ts">
// 消息正文（Markdown 渲染面）——**异步组件**，见 MessageRow 里的引入处。
//
// 为什么单独拆一个组件：markdown-it + DOMPurify 的闭包会顶破上游
// `scripts/check-renderer-bundles.mjs` 给 App.vue 的静态预算（上游脚本、不在补丁白名单内）。
// 拆成异步组件后，渲染逻辑与样式一起进动态 chunk，不占根组件静态闭包。
import { computed, onUnmounted, ref } from 'vue'
import { markdownReady, onMarkdownReady, renderMarkdown } from '../utils/markdown'

const props = defineProps<{ text: string }>()

const emit = defineEmits<{ 'open-url': [url: string] }>()

// 依赖动态加载：就绪前走纯文本回退，就绪后靠 epoch 触发重渲染。
const epoch = ref(markdownReady() ? 1 : 0)
const stop = onMarkdownReady(() => {
  epoch.value += 1
})
onUnmounted(stop)

const rendered = computed(() => {
  void epoch.value
  return props.text ? renderMarkdown(props.text) : { html: '', plainFallback: false }
})

/** 正文里的链接一律交给主进程 `openUrl`（受控外链），不让 renderer 直接导航。 */
function onClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement | null)?.closest('a')
  if (!anchor) return
  event.preventDefault()
  event.stopPropagation()
  if (anchor.hasAttribute('data-blocked-href')) return
  const href = anchor.getAttribute('href') ?? ''
  if (/^https?:/i.test(href)) emit('open-url', href)
}
</script>

<template>
  <span v-if="rendered.plainFallback" class="md-plain">{{ props.text }}</span>
  <!-- 内容经 markdown-it(html:false) + DOMPurify 双层清洗；异常时走上分支的纯文本回退 -->
  <div v-else class="md-body" v-html="rendered.html" @click="onClick" />
</template>

<style scoped>
.md-plain {
  white-space: pre-wrap;
  user-select: text;
}
.md-body {
  user-select: text;
  overflow-wrap: anywhere;
}
.md-body :deep(p) {
  margin: 0;
}
.md-body :deep(p + p),
.md-body :deep(p + ul),
.md-body :deep(p + ol),
.md-body :deep(p + pre),
.md-body :deep(p + blockquote) {
  margin-top: 8px;
}
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4),
.md-body :deep(h5),
.md-body :deep(h6) {
  margin: 8px 0 4px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
}
.md-body :deep(h1:first-child),
.md-body :deep(h2:first-child),
.md-body :deep(h3:first-child) {
  margin-top: 0;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}
.md-body :deep(li) {
  margin: 2px 0;
}
.md-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  background: rgb(0 0 0 / 7%);
  border-radius: 4px;
  padding: 1px 4px;
}
.md-body :deep(pre) {
  margin: 6px 0;
  padding: 8px 10px;
  background: rgb(0 0 0 / 7%);
  border-radius: 8px;
  overflow-x: auto;
}
.md-body :deep(pre code) {
  background: transparent;
  padding: 0;
  font-size: 12.5px;
  line-height: 1.5;
}
.md-body :deep(blockquote) {
  margin: 6px 0;
  padding: 2px 0 2px 10px;
  border-left: 2px solid var(--line);
  color: var(--text-2);
}
.md-body :deep(a) {
  color: var(--primary);
  text-decoration: underline;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.md-body :deep(table) {
  margin: 6px 0;
  border-collapse: collapse;
  font-size: 12.5px;
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--line);
  padding: 3px 8px;
  text-align: left;
}
.md-body :deep(hr) {
  margin: 8px 0;
  border: none;
  border-top: 1px solid var(--line);
}
</style>
