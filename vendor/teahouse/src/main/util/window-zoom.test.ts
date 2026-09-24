import { describe, expect, it, vi } from 'vitest'
import { applyWindowZoom, fontScaleToZoomFactor } from './window-zoom'

describe('窗口原生页面缩放', () => {
  it('只接受字体缩放白名单', () => {
    expect(fontScaleToZoomFactor(100)).toBe(1)
    expect(fontScaleToZoomFactor(110)).toBe(1.1)
    expect(fontScaleToZoomFactor(125)).toBe(1.25)
    expect(fontScaleToZoomFactor(0)).toBe(1)
    expect(fontScaleToZoomFactor(150)).toBe(1)
    expect(fontScaleToZoomFactor('125')).toBe(1)
  })

  it('向存活的 WebContents 应用倍率', () => {
    const contents = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setZoomFactor: vi.fn()
    }

    expect(applyWindowZoom(contents, 125)).toBe(true)
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.25)
  })

  it('窗口缺失、已销毁或退出竞态时安全跳过', () => {
    expect(applyWindowZoom(null, 100)).toBe(false)

    const destroyed = {
      isDestroyed: vi.fn().mockReturnValue(true),
      setZoomFactor: vi.fn()
    }
    expect(applyWindowZoom(destroyed, 110)).toBe(false)
    expect(destroyed.setZoomFactor).not.toHaveBeenCalled()

    const racing = {
      isDestroyed: vi.fn().mockReturnValue(false),
      setZoomFactor: vi.fn(() => {
        throw new Error('destroyed')
      })
    }
    expect(applyWindowZoom(racing, 110)).toBe(false)
  })
})
