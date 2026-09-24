import { describe, expect, it } from 'vitest'
import { isImeCompositionKey } from './ime'

describe('输入法组合键判断', () => {
  it('本地 composition 状态活动时拦截候选确认键', () => {
    expect(isImeCompositionKey({ isComposing: false, keyCode: 13 }, true)).toBe(true)
  })

  it('浏览器 composition 标记与兼容 keyCode 229 均被拦截', () => {
    expect(isImeCompositionKey({ isComposing: true, keyCode: 13 }, false)).toBe(true)
    expect(isImeCompositionKey({ isComposing: false, keyCode: 229 }, false)).toBe(true)
  })

  it('候选结束后的普通 Enter 继续进入发送键分流', () => {
    expect(isImeCompositionKey({ isComposing: false, keyCode: 13 }, false)).toBe(false)
  })
})
