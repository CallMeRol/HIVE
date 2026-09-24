import { describe, expect, it } from 'vitest'
import { planCaptureGeometry } from './capture-geometry'

describe('截图窗口与桌面源几何（决议 #221）', () => {
  it('Windows 底部任务栏从截图源裁掉，不压缩到工作区', () => {
    expect(
      planCaptureGeometry(
        'win32',
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 1920, height: 1040 },
        { width: 1920, height: 1080 }
      )
    ).toEqual({
      windowBounds: { x: 0, y: 0, width: 1920, height: 1040 },
      imageCrop: { x: 0, y: 0, width: 1920, height: 1040 }
    })
  })

  it('Windows 顶部任务栏同时修正窗口原点与截图裁剪原点', () => {
    expect(
      planCaptureGeometry(
        'win32',
        { x: 0, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 40, width: 1920, height: 1040 },
        { width: 1920, height: 1080 }
      )
    ).toEqual({
      windowBounds: { x: 0, y: 40, width: 1920, height: 1040 },
      imageCrop: { x: 0, y: 40, width: 1920, height: 1040 }
    })
  })

  it('Windows 左侧任务栏与负坐标副屏按相对显示器坐标裁剪', () => {
    expect(
      planCaptureGeometry(
        'win32',
        { x: -1600, y: 0, width: 1600, height: 900 },
        { x: -1552, y: 0, width: 1552, height: 900 },
        { width: 1600, height: 900 }
      )
    ).toEqual({
      windowBounds: { x: -1552, y: 0, width: 1552, height: 900 },
      imageCrop: { x: 48, y: 0, width: 1552, height: 900 }
    })
  })

  it('Windows 125% DPI 使用截图实际像素计算裁剪矩形', () => {
    expect(
      planCaptureGeometry(
        'win32',
        { x: 0, y: 0, width: 1536, height: 864 },
        { x: 0, y: 0, width: 1536, height: 824 },
        { width: 1920, height: 1080 }
      )
    ).toEqual({
      windowBounds: { x: 0, y: 0, width: 1536, height: 824 },
      imageCrop: { x: 0, y: 0, width: 1920, height: 1030 }
    })
  })

  it('macOS 与 Linux 保持整屏截图范围', () => {
    const bounds = { x: 0, y: 0, width: 1440, height: 900 }
    const workArea = { x: 0, y: 25, width: 1440, height: 850 }
    const expected = {
      windowBounds: bounds,
      imageCrop: { x: 0, y: 0, width: 2880, height: 1800 }
    }
    expect(planCaptureGeometry('darwin', bounds, workArea, { width: 2880, height: 1800 })).toEqual(
      expected
    )
    expect(planCaptureGeometry('linux', bounds, workArea, { width: 2880, height: 1800 })).toEqual(
      expected
    )
  })
})
