import { describe, expect, it } from 'vitest'
import { isWindowAttended } from './window-attention'

function doc(visibilityState: DocumentVisibilityState, focused: boolean) {
  return { visibilityState, hasFocus: () => focused }
}

describe('窗口注视判定（决议 #220）', () => {
  it('可见且聚焦时视为正在看', () => {
    expect(isWindowAttended(doc('visible', true))).toBe(true)
  })

  it('最小化 / 隐藏到托盘（不可见）时不算正在看', () => {
    expect(isWindowAttended(doc('hidden', false))).toBe(false)
  })

  it('窗口可见但被其他窗口压住失焦时不算正在看', () => {
    expect(isWindowAttended(doc('visible', false))).toBe(false)
  })
})
