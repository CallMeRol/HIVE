import { describe, expect, it } from 'vitest'
import { placeCaptureToolbar } from './capture-toolbar'

describe('placeCaptureToolbar', () => {
  it('空间充足时放在选区下方并靠选区左缘', () => {
    expect(
      placeCaptureToolbar(
        { x: 100, y: 100, width: 300, height: 200 },
        { width: 240, height: 40 },
        { width: 1200, height: 800 }
      )
    ).toEqual({ left: 100, top: 308 })
  })

  it('选区下方空间不足时翻到上方', () => {
    expect(
      placeCaptureToolbar(
        { x: 300, y: 700, width: 200, height: 70 },
        { width: 260, height: 40 },
        { width: 1200, height: 800 }
      )
    ).toEqual({ left: 240, top: 652 })
  })

  it('靠近右缘时把工具条夹紧在视口内', () => {
    expect(
      placeCaptureToolbar(
        { x: 1180, y: 120, width: 20, height: 80 },
        { width: 200, height: 40 },
        { width: 1200, height: 800 }
      )
    ).toEqual({ left: 992, top: 208 })
  })

  it('视口小于工具条时保持可操作起点且不产生负坐标', () => {
    expect(
      placeCaptureToolbar(
        { x: 40, y: 20, width: 30, height: 20 },
        { width: 200, height: 80 },
        { width: 120, height: 60 }
      )
    ).toEqual({ left: 8, top: 8 })
  })
})
