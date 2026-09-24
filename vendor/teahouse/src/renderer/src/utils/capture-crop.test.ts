import { describe, expect, it } from 'vitest'
import { mapCaptureRectToImage } from './capture-crop'

describe('截图选区像素映射（决议 #221）', () => {
  it('按实际自然尺寸分别换算 X/Y', () => {
    expect(
      mapCaptureRectToImage(
        { x: 100, y: 80, w: 400, h: 200 },
        { width: 1536, height: 824 },
        { width: 1920, height: 1030 }
      )
    ).toEqual({
      x: 125,
      y: 100,
      width: 500,
      height: 250,
      scaleX: 1.25,
      scaleY: 1.25
    })
  })

  it('边缘选区被安全夹紧到图片像素范围', () => {
    expect(
      mapCaptureRectToImage(
        { x: 790, y: 590, w: 30, h: 30 },
        { width: 800, height: 600 },
        { width: 1600, height: 1200 }
      )
    ).toEqual({
      x: 1580,
      y: 1180,
      width: 20,
      height: 20,
      scaleX: 2,
      scaleY: 2
    })
  })

  it('无效视口或空选区不生成裁剪矩形', () => {
    expect(
      mapCaptureRectToImage(
        { x: 0, y: 0, w: 0, h: 10 },
        { width: 800, height: 600 },
        { width: 800, height: 600 }
      )
    ).toBeNull()
  })
})
