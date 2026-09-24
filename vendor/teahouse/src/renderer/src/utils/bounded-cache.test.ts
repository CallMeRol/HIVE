import { describe, expect, it, vi } from 'vitest'
import { BoundedLruCache, RetryableAsyncValue } from './bounded-cache'

describe('BoundedLruCache', () => {
  it('超过容量时淘汰最久未使用的条目', () => {
    const cache = new BoundedLruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(2)
  })

  it('读取与覆盖都会刷新条目的最近使用顺序', () => {
    const cache = new BoundedLruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('b', 20)
    cache.set('c', 3)

    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(20)
    expect(cache.get('c')).toBe(3)
  })

  it('拒绝无效容量', () => {
    expect(() => new BoundedLruCache(0)).toThrow('正整数')
    expect(() => new BoundedLruCache(1.5)).toThrow('正整数')
  })
})

describe('RetryableAsyncValue', () => {
  it('并发调用共享同一次初始化，成功后继续复用结果', async () => {
    const value = new RetryableAsyncValue<object>()
    const resolved = {}
    const factory = vi.fn(async () => resolved)

    const first = value.get(factory)
    const second = value.get(factory)

    expect(second).toBe(first)
    await expect(first).resolves.toBe(resolved)
    await expect(value.get(factory)).resolves.toBe(resolved)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('初始化失败后清空失败 Promise，下一次调用可以重试', async () => {
    const value = new RetryableAsyncValue<string>()
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('首次失败'))
      .mockResolvedValueOnce('ready')

    await expect(value.get(factory)).rejects.toThrow('首次失败')
    await expect(value.get(factory)).resolves.toBe('ready')
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
