import { describe, expect, it } from 'vitest'
import { resolveRendererEntry } from './renderer-entry'

describe('resolveRendererEntry', () => {
  it.each([
    ['', 'main'],
    ['#/', 'main'],
    ['#/chat', 'main'],
    ['#/settings', 'settings'],
    ['#/settings/about', 'settings'],
    ['#/cabinet', 'main'],
    ['#/capture', 'capture'],
    ['#/capture?peer=node-1', 'capture'],
    ['#/image-viewer', 'image-viewer'],
    ['#/image-viewer?id=image-1', 'image-viewer'],
    ['#/remote-view', 'remote-view']
  ] as const)('将 %s 解析为 %s 入口', (hash, expected) => {
    expect(resolveRendererEntry(hash)).toBe(expected)
  })

  it('未知 hash 安全回退到主窗口', () => {
    expect(resolveRendererEntry('#/unknown')).toBe('main')
  })
})
