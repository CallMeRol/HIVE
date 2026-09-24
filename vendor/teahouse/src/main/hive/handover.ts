import { createHash } from 'node:crypto'

// 交接文档解析与产物校验（#54，docs/handoff/RULES.md + TEMPLATE.md）。
//
// 契约（docs/contracts/parallel-development.md 状态所有者表「交接文档与产物三件套」）：
// - 交接 = Markdown 头部元数据 + 7 个 H2 节（不是 JSON schema）；
// - 每条「已完成」必须带产物三件套：绝对路径 + sha256 + 复跑命令；
// - 校验 fail-closed：缺节 / 缺三件套 / sha256 不匹配 = 拒绝开工（#60 同源语义）；
// - 群内可见文本只发「校验成功」结论，绝不泄露交接内容（RULES §6）。
//
// 纯函数边界：文件读取经注入的 hashFile / readFile，便于单测与跨节点复用。
export const HANDOVER_SECTIONS = [
  '当前目标',
  '已完成',
  '关键决策',
  '产物引用',
  '未决问题',
  '下一步',
  'suggested skills'
] as const

export type HandoverSection = (typeof HANDOVER_SECTIONS)[number]

/** 一条产物三件套（RULES §1）：`<machine>:<abs-path>` · sha256 `<hash>` · 复跑 `<command>`。 */
export interface HandoverArtifact {
  /** 机器前缀（`<machine>:`）；同机也不得省略（RULES §5）。 */
  machine: string
  /** 产物绝对路径。 */
  path: string
  /** 自报 sha256（hex，64 位）。 */
  sha256: string
  /** 复跑命令原文。 */
  rerun: string
}

export interface HandoverParseResult {
  /** 头部元数据行（`- key：value`），原样保留。 */
  header: Record<string, string>
  /** H2 节名 → 正文。未知节原样保留并忽略校验（RULES §8）。 */
  sections: Record<string, string>
  /** 缺失的必填节。 */
  missing: HandoverSection[]
}

export interface HandoverVerifyResult {
  ok: boolean
  /** 显式失败原因（fail-closed，逐条列出，不静默）。 */
  errors: string[]
  /** 解析出的产物三件套（仅 ok=true 时可信）。 */
  artifacts: HandoverArtifact[]
}

/** 产物行语法：`产物：` 前缀 + 机器:路径 + `· sha256 <hex>` + `· 复跑：<命令>`（前缀已在切片时去掉）。 */
const ARTIFACT_RE =
  /^`?([^`·]+?)`?\s*·\s*sha256\s*`?([0-9a-f]{64})`?\s*·\s*复跑：?`?([^`]+?)`?\s*$/i

/**
 * 解析交接文档：H1/H2 切节，头部元数据 = 第一个 H2 之前的 `- key：value` 行。
 * 缺节容忍（missing 列出）；未知节原样保留（RULES §8 向后兼容）。
 */
export function parseHandoverDoc(markdown: string): HandoverParseResult {
  const header: Record<string, string> = {}
  const sections: Record<string, string> = {}
  let current: string | null = null
  const body: string[] = []
  const flush = (): void => {
    if (current !== null) sections[current] = body.join('\n').trim()
  }
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    const h2 = line.match(/^##\s+(.+?)\s*$/)
    if (h2 && !line.startsWith('###')) {
      flush()
      current = h2[1]
      body.length = 0
      continue
    }
    if (current === null) {
      const meta = line.match(/^-([^：:]{1,32})[：:](.*)$/)
      if (meta) header[meta[1].trim()] = meta[2].trim()
      continue
    }
    body.push(rawLine)
  }
  flush()
  const missing = HANDOVER_SECTIONS.filter((name) => !(name in sections))
  return { header, sections, missing }
}

/** 从一节正文抽取全部产物三件套；写法不合语法的行为报错（防幻觉，RULES §1）。 */
export function extractArtifacts(text: string): { artifacts: HandoverArtifact[]; errors: string[] } {
  const artifacts: HandoverArtifact[] = []
  const errors: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('产物：') && !line.includes('产物：')) continue
    const idx = line.indexOf('产物：')
    const payload = line.slice(idx + '产物：'.length).trim()
    const m = payload.match(ARTIFACT_RE)
    if (!m) {
      errors.push(`产物行语法不合法：${line.slice(0, 120)}`)
      continue
    }
    const machinePath = m[1].trim()
    const sep = machinePath.indexOf(':')
    const machine = sep > 0 ? machinePath.slice(0, sep).trim() : ''
    const path = sep > 0 ? machinePath.slice(sep + 1).trim() : machinePath
    if (!machine || !path.startsWith('/')) {
      errors.push(`产物路径必须是绝对路径且带机器前缀：${machinePath}`)
      continue
    }
    artifacts.push({ machine, path, sha256: m[2].toLowerCase(), rerun: m[3].trim() })
  }
  return { artifacts, errors }
}

export interface HandoverVerifyDeps {
  /** 读产物文件内容（fail-closed：读不到 = 校验失败）。 */
  readArtifact(path: string): Buffer | null
}

/**
 * 交接校验（#54 AC1/AC2，#60 同一函数复用）：
 * 1. 头部元数据 + 7 个 H2 节齐全；
 * 2. 「已完成」「产物引用」两节各至少一条产物三件套；
 * 3. 每条产物的 sha256 与实际文件内容一致（fail-closed：不匹配 / 读不到 = 拒绝）。
 */
export function verifyHandover(markdown: string, deps: HandoverVerifyDeps): HandoverVerifyResult {
  const errors: string[] = []
  if (markdown.trim() === '') {
    return { ok: false, errors: ['交接文档为空'], artifacts: [] }
  }
  const parsed = parseHandoverDoc(markdown)
  for (const name of parsed.missing) errors.push(`缺少必填节：${name}`)

  const artifacts: HandoverArtifact[] = []
  for (const name of ['已完成', '产物引用'] as const) {
    const text = parsed.sections[name]
    if (text === undefined) continue // 缺节已报，不重复。
    if (text.trim() === '') {
      errors.push(`「${name}」节为空（每条已完成必须带产物三件套）`)
      continue
    }
    const { artifacts: found, errors: syntax } = extractArtifacts(text)
    errors.push(...syntax.map((e) => `「${name}」${e}`))
    if (found.length === 0 && syntax.length === 0) {
      errors.push(`「${name}」节没有任何产物三件套（路径 + sha256 + 复跑）`)
    }
    artifacts.push(...found)
  }

  for (const artifact of artifacts) {
    const content = deps.readArtifact(artifact.path)
    if (!content) {
      errors.push(`产物不可读：${artifact.path}`)
      continue
    }
    const actual = createHash('sha256').update(content).digest('hex')
    if (actual !== artifact.sha256) {
      errors.push(`sha256 不匹配：${artifact.path}（文档 ${artifact.sha256}，实际 ${actual}）`)
    }
  }
  return { ok: errors.length === 0, errors, artifacts }
}
/**
 * 群内可见结论（#54 AC3：不泄露完整交接内容）——只说成员、结论与产物数量，
 * 不带路径、哈希、命令或任何交接正文。
 */
export function handoverOkText(memberNick: string, artifactCount: number): string {
  return `✅ ${memberNick} 交接与产物校验成功（${artifactCount} 项产物已复验），成员正常回收`
}

/** #60 群内可见拒绝文案：含原因与重发要求，不带交接正文/产物内容。 */
export function handoverRejectText(reason: string): string {
  return `⛔ 拒绝接手：${reason}。零实质输出，任务未标记完成；请修复交接后重发。`
}

/** #60 交接校验证据（进本机机库；phase 区分输入派遣 / 输出回收 / 接手开工前）。 */
export interface HandoffEvidence {
  phase: 'input' | 'output' | 'accept'
  ok: boolean
  errors: string[]
  context?: Record<string, unknown>
}
