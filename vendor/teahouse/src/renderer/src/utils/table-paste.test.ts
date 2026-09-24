import { describe, expect, it } from 'vitest'
import {
  TABLE_PASTE_HINT_MS,
  draftWithoutTablePaste,
  tablePasteHintIntact,
  tablePasteHintText,
  type TablePasteHint
} from './table-paste'

function hintOf(before: string, text: string, oversize = false): TablePasteHint {
  return { start: before.length, text, draft: `${before}${text}`, oversize }
}

describe('表格粘贴提示条（决议 #270）', () => {
  it('按是否超上限给出不同文案', () => {
    expect(tablePasteHintText(false)).toBe('检测到表格')
    expect(tablePasteHintText(true)).toBe('表格过大，只能按图片发送')
  })

  it('草稿一被改动就判为过期', () => {
    const hint = hintOf('已有内容\n', 'A\tB\n1\t2')
    expect(tablePasteHintIntact(hint.draft, hint)).toBe(true)
    expect(tablePasteHintIntact(`${hint.draft}补充`, hint)).toBe(false)
    expect(tablePasteHintIntact(`前缀${hint.draft}`, hint)).toBe(false)
    expect(tablePasteHintIntact('', hint)).toBe(false)
  })

  it('改发图片时只摘掉插入的那段，保留草稿原有内容', () => {
    expect(draftWithoutTablePaste(hintOf('已有内容\n', 'A\tB\n1\t2'))).toBe('已有内容\n')
    expect(draftWithoutTablePaste(hintOf('', 'A\tB\n1\t2'))).toBe('')
  })

  it('自动消失时长为 5 秒', () => {
    expect(TABLE_PASTE_HINT_MS).toBe(5000)
  })
})
