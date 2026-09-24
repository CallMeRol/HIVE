import { describe, expect, it } from 'vitest'
import { messageStatusHint, shouldShowSeparator, textParts } from './message-row'

describe('消息行显示逻辑', () => {
  it('按上一条时间决定是否显示时间分隔线', () => {
    expect(shouldShowSeparator(1000, null)).toBe(true)
    expect(shouldShowSeparator(1000 + 5 * 60_000, 1000)).toBe(false)
    expect(shouldShowSeparator(1001 + 5 * 60_000, 1000)).toBe(true)
  })

  it('只给文本类发送状态显示行外提示', () => {
    expect(messageStatusHint('text', 'queued')).toBe('对方上线后自动送达')
    expect(messageStatusHint('image', 'failed')).toBe('发送失败，点击重发')
    expect(messageStatusHint('file', 'failed')).toBe('')
    expect(messageStatusHint('text', 'canceled')).toBe('')
    expect(messageStatusHint('text', 'recalled')).toBe('')
  })

  it('切分文本链接并保留尾随标点', () => {
    expect(textParts('看 https://example.com/a，')).toEqual([
      { text: '看 ', url: '' },
      { text: 'https://example.com/a', url: 'https://example.com/a' },
      { text: '，', url: '' }
    ])
    expect(textParts('纯文本')).toEqual([{ text: '纯文本', url: '' }])
  })
})
