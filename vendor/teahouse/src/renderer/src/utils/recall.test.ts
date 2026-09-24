import { describe, expect, it } from 'vitest'
import {
  canRecallAt,
  formatRecallMenuMeta,
  isRecallMenuUrgent,
  recallRemainingMs
} from './recall'

describe('撤回倒计时工具', () => {
  it('按剩余毫秒生成撤回菜单文案', () => {
    expect(formatRecallMenuMeta(59_001)).toBe('01:00')
    expect(formatRecallMenuMeta(59_000)).toBe('00:59')
    expect(formatRecallMenuMeta(0)).toBe('超时')
    expect(formatRecallMenuMeta(30_000, '已接收')).toBe('已接收')
  })

  it('只在可用倒计时最后十秒标记紧急态', () => {
    expect(isRecallMenuUrgent(10_001)).toBe(false)
    expect(isRecallMenuUrgent(10_000)).toBe(true)
    expect(isRecallMenuUrgent(1)).toBe(true)
    expect(isRecallMenuUrgent(0)).toBe(false)
    expect(isRecallMenuUrgent(5_000, '已接收')).toBe(false)
  })

  it('按当前时间判断撤回窗口', () => {
    expect(recallRemainingMs(12_000, 10_000, 5_000)).toBe(3_000)
    expect(recallRemainingMs(16_000, 10_000, 5_000)).toBe(0)
    expect(canRecallAt(12_000, 10_000, 5_000)).toBe(true)
    expect(canRecallAt(15_000, 10_000, 5_000)).toBe(true)
    expect(canRecallAt(16_000, 10_000, 5_000)).toBe(false)
    expect(canRecallAt(12_000, 10_000, 5_000, '不可用')).toBe(false)
  })
})
