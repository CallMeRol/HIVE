import { tr } from './i18n'
import type { MessageView } from '../../../shared/ipc'

export interface TextPart {
  text: string
  url: string
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi
const URL_TRAILING = /[),.，。!！?？;；:：]+$/
const SEPARATOR_GAP_MS = 5 * 60_000

export function shouldShowSeparator(ts: number, prevTs: number | null): boolean {
  return prevTs === null || ts - prevTs > SEPARATOR_GAP_MS
}

export function messageStatusHint(
  kind: MessageView['kind'],
  status: MessageView['status']
): string {
  if (kind === 'file') return ''
  if (status === 'recalled') return ''
  if (status === 'queued') return tr('对方上线后自动送达')
  if (status === 'failed') return tr('发送失败，点击重发')
  return ''
}

export function textParts(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]
    const index = match.index ?? 0
    const trimmed = raw.replace(URL_TRAILING, '')
    if (!trimmed) continue
    if (index > last) parts.push({ text: text.slice(last, index), url: '' })
    parts.push({ text: trimmed, url: trimmed })
    const tailStart = index + trimmed.length
    if (tailStart < index + raw.length) {
      parts.push({ text: text.slice(tailStart, index + raw.length), url: '' })
    }
    last = index + raw.length
  }
  if (last < text.length) parts.push({ text: text.slice(last), url: '' })
  return parts.length > 0 ? parts : [{ text, url: '' }]
}
