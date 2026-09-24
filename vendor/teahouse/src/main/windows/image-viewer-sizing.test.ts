import { describe, expect, it } from 'vitest'
import {
  IMAGE_VIEWER_MIN_CONTENT_HEIGHT,
  IMAGE_VIEWER_MIN_CONTENT_WIDTH,
  fitImageViewerContent
} from './image-viewer-sizing'

describe('fitImageViewerContent', () => {
  it('小图片保持 100% 显示但窗口内容区不小于工具条可用尺寸', () => {
    expect(
      fitImageViewerContent({
        imageWidth: 80,
        imageHeight: 60,
        workAreaWidth: 1440,
        workAreaHeight: 900
      })
    ).toEqual({
      scale: 1,
      contentWidth: IMAGE_VIEWER_MIN_CONTENT_WIDTH,
      contentHeight: IMAGE_VIEWER_MIN_CONTENT_HEIGHT
    })
  })

  it('大图片仍按屏幕工作区 70% 等比缩放，并只补足短边最小内容区', () => {
    expect(
      fitImageViewerContent({
        imageWidth: 4000,
        imageHeight: 2000,
        workAreaWidth: 1000,
        workAreaHeight: 800
      })
    ).toEqual({
      scale: 0.175,
      contentWidth: 700,
      contentHeight: IMAGE_VIEWER_MIN_CONTENT_HEIGHT
    })
  })
})
