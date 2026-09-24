// 目标守卫（#55）最小冒烟：判定归一化 + 动作决策 + fail-open。
// 黑客松口径：只锁语义核心，HTTP 面与派遣链路由 e2e/人工验收覆盖。
import { describe, expect, it } from 'vitest'
import { decideAction, normalizeVerdict } from './goal-guard'

describe('goal-guard', () => {
  it('normalizeVerdict：合法载荷原样收下', () => {
    expect(
      normalizeVerdict({ verdict: 'out-of-scope', confidence: 0.9, reason: '目标不相关' })
    ).toEqual({ verdict: 'out-of-scope', confidence: 0.9, reason: '目标不相关' })
  })

  it('normalizeVerdict：非法/缺字段一律 null（fail-open 的输入侧）', () => {
    expect(normalizeVerdict(null)).toBeNull()
    expect(normalizeVerdict({ verdict: 'maybe' })).toBeNull()
    expect(normalizeVerdict({ verdict: 42 })).toBeNull()
    expect(normalizeVerdict('out-of-scope')).toBeNull()
  })

  it('decideAction：越界→派遣；未判定/不可用→放行+警告；在界→直通', () => {
    expect(decideAction({ verdict: 'out-of-scope', confidence: 1, reason: '' })).toBe('dispatch')
    expect(decideAction({ verdict: 'in-scope', confidence: 1, reason: '' })).toBe('deliver')
    expect(decideAction({ verdict: 'undetermined', confidence: 0, reason: '' })).toBe('deliver_warn')
    expect(decideAction(null)).toBe('deliver_warn')
  })
})
