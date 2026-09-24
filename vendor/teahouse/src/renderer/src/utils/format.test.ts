import { describe, expect, it } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes（决议 #281）', () => {
  it('字节不带小数', () => {
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('小于 10 的数值保留一位小数', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('不小于 10 的数值取整，避免长数字撑爆行宽', () => {
    expect(formatBytes(1024 * 12)).toBe('12 KB')
    expect(formatBytes(1024 * 1024 * 12.4)).toBe('12 MB')
    expect(formatBytes(1024 * 1024 * 1024 * 25.6)).toBe('26 GB')
  })

  it('逐级进位到 TB 为止', () => {
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB')
    expect(formatBytes(1024 ** 5)).toBe('1024 TB')
  })

  it('零与非法输入统一显示 0 B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })
})
