// 正式消息分条（ADR-0008）：把 turn 内累积的 `agent_message_chunk` 切成
// 群内可见的多条消息——按自然边界（空行 / 标题 / 列表块），单条 ≤3500 字节。
//
// 纯函数、零依赖：这是正式消息链唯一的判定点，便于无 Electron 单测。
// 3500 B 的上限低于上游 `TEXT_TCP_LIMIT = 4096`（protocol.ts:15），留切片余量；
// 超限的单个代码块/表格硬切并标 `(i/n)`（ADR-0008 Decision）。

/** 单条正式消息的 UTF-8 字节上限（ADR-0008 / SPEC #41）。 */
export const FORMAL_MESSAGE_LIMIT_BYTES = 3500

/** 硬切后的分片标注（`(1/3)`）会占用额外字节，预留出来避免分片本身越界。 */
const SLICE_LABEL_RESERVE = 24

interface Segment {
  text: string
  /** 该段是否是"不可再按自然边界拆"的原子块（代码块 / 表格）。 */
  atomic: boolean
}

/** 自然边界优先级：空行最高，其次是标题/列表/其他块起始行。 */
function splitNaturalBlocks(text: string): Segment[] {
  const lines = text.split('\n')
  const blocks: Segment[] = []
  let current: string[] = []
  let inFence = false
  /** 当前块是否含围栏：闭合 ``` 会把 `inFence` 翻回 false，不能靠它判原子性。 */
  let currentHasFence = false

  const flush = (): void => {
    const joined = current.join('\n')
    const atomic = currentHasFence
    current = []
    currentHasFence = false
    if (joined.trim() !== '') blocks.push({ text: joined, atomic })
  }

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      currentHasFence = true
      current.push(line)
      continue
    }
    if (inFence) {
      current.push(line)
      continue
    }
    // 空行 = 最强自然边界。
    if (line.trim() === '') {
      flush()
      continue
    }
    // 标题 / 列表项 / 引用 / 表格行：块起始（前面已有内容则先收口）。
    const isBlockStart = /^\s*(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/.test(line)
    if (isBlockStart && current.length > 0) flush()
    current.push(line)
  }
  flush()
  return blocks
}

/**
 * 硬切并逐片标注 `(i/n)`（ADR-0008：单个代码块/表格超限硬切、每片标序号）。
 * 预留标注占用的字节，保证含标注后仍不越界。
 */
function hardSliceLabeled(text: string, limitBytes: number): string[] {
  const pieces = hardSliceUtf8(text, limitBytes - SLICE_LABEL_RESERVE)
  const total = pieces.length
  return pieces.map((piece, i) => `${piece}\n(${i + 1}/${total})`)
}

/** 一张表格连着表头与分隔行，硬切会破坏可读性——整块当原子处理。 */
function isTableBlock(segment: Segment): boolean {
  const lines = segment.text.split('\n').filter((l) => l.trim() !== '')
  return lines.length > 0 && lines.every((l) => l.trim().startsWith('|'))
}

/**
 * 原子块超限时的硬切：按 UTF-8 字节切，绝不切坏多字节字符。
 * 返回的每片都不超过 `maxBytes`。
 */
export function hardSliceUtf8(text: string, maxBytes: number): string[] {
  const out: string[] = []
  let current = ''
  let used = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes && current !== '') {
      out.push(current)
      current = char
      used = size
    } else {
      current += char
      used += size
    }
  }
  if (current !== '') out.push(current)
  return out
}

/**
 * 把一次 turn 的正式回复切成待发送的多条消息。
 * - 空输入 → 空数组（调用方据此判定"这个 turn 没有正式产出"）。
 * - 每片（含硬切标注）的 UTF-8 字节数 ≤ `FORMAL_MESSAGE_LIMIT_BYTES`。
 */
export function splitFormalMessage(
  text: string,
  limitBytes: number = FORMAL_MESSAGE_LIMIT_BYTES
): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []

  const blocks = splitNaturalBlocks(trimmed)
  const chunks: string[] = []
  let current = ''

  const push = (): void => {
    if (current.trim() !== '') chunks.push(current)
    current = ''
  }

  for (const block of blocks) {
    const blockBytes = Buffer.byteLength(block.text, 'utf8')
    const atomic = block.atomic || isTableBlock(block)

    // 超限块 → 硬切；原子块（代码围栏 / 表格）额外逐片标注 (i/n)。
    if (blockBytes > limitBytes) {
      push()
      const pieces = atomic
        ? hardSliceLabeled(block.text, limitBytes)
        : hardSliceUtf8(block.text, limitBytes)
      for (const piece of pieces) chunks.push(piece)
      continue
    }

    if (current === '') {
      current = block.text
      continue
    }

    const merged = `${current}\n\n${block.text}`
    if (Buffer.byteLength(merged, 'utf8') <= limitBytes) {
      current = merged
      continue
    }
    push()
    current = block.text
  }
  push()
  return chunks
}

/** 单条是否可被上游 `sendText` 接受（只是本地快速判定，不代表权限/群成员校验通过）。 */
export function isSendableLength(text: string, byteLimit = 4096): boolean {
  return Buffer.byteLength(text.trim(), 'utf8') <= byteLimit
}
