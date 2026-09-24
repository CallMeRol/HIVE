import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  avatarCoverScale,
  avatarCropSourceRect,
  avatarMaxZoom,
  clampAvatarOffset,
  clampedAvatarCropRect,
  hasVisibleAvatarPixels,
  renderAvatarWebp
} from './avatar-crop'

describe('头像裁剪几何', () => {
  it('横图和竖图以居中覆盖作为最小缩放', () => {
    expect(avatarCoverScale(400, 200, 200)).toBe(1)
    expect(
      avatarCropSourceRect({
        imageWidth: 400,
        imageHeight: 200,
        viewportSize: 200,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    ).toEqual({ x: 100, y: 0, size: 200 })

    expect(avatarCoverScale(200, 400, 200)).toBe(1)
    expect(
      avatarCropSourceRect({
        imageWidth: 200,
        imageHeight: 400,
        viewportSize: 200,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    ).toEqual({ x: 0, y: 100, size: 200 })
  })

  it('拖动边界始终填满裁剪区', () => {
    expect(
      clampAvatarOffset({
        imageWidth: 400,
        imageHeight: 200,
        viewportSize: 200,
        zoom: 1,
        offsetX: 999,
        offsetY: -999
      })
    ).toEqual({ x: 100, y: 0 })
  })

  it('缩放后按当前比例换算源图裁剪区域', () => {
    expect(
      avatarCropSourceRect({
        imageWidth: 400,
        imageHeight: 200,
        viewportSize: 200,
        zoom: 4,
        offsetX: 0,
        offsetY: 0
      })
    ).toEqual({ x: 175, y: 75, size: 50 })
  })

  it('方图放大后允许在两个方向拖动并映射到不同裁剪位置', () => {
    const state = {
      imageWidth: 400,
      imageHeight: 400,
      viewportSize: 200,
      zoom: 2,
      offsetX: 60,
      offsetY: -40
    }
    expect(clampAvatarOffset(state)).toEqual({ x: 60, y: -40 })
    expect(avatarCropSourceRect(state)).toEqual({ x: 40, y: 140, size: 200 })
  })

  it('最大缩放随源图短边放宽到输出分辨率粒度，小图不放大', () => {
    expect(avatarMaxZoom(8192, 8192)).toBeCloseTo(8192 / 192)
    expect(avatarMaxZoom(1920, 1080)).toBeCloseTo(1080 / 192)
    expect(avatarMaxZoom(192, 400)).toBe(1)
    expect(avatarMaxZoom(100, 100)).toBe(1)
  })

  it('整数裁剪矩形夹回图内，不采到界外像素', () => {
    // 常规：浮点结果四舍五入
    expect(
      clampedAvatarCropRect({
        imageWidth: 400,
        imageHeight: 200,
        viewportSize: 200,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    ).toEqual({ x: 100, y: 0, size: 200 })
    // 边缘：极限偏移下取整不得越界
    expect(
      clampedAvatarCropRect({
        imageWidth: 301,
        imageHeight: 200,
        viewportSize: 200,
        zoom: 3,
        offsetX: -9999,
        offsetY: 9999
      }).x
    ).toBeLessThanOrEqual(301 - 67)
    const rect = clampedAvatarCropRect({
      imageWidth: 301,
      imageHeight: 200,
      viewportSize: 200,
      zoom: 3,
      offsetX: -9999,
      offsetY: 9999
    })
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.y).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.size).toBeLessThanOrEqual(301)
    expect(rect.y + rect.size).toBeLessThanOrEqual(200)
  })
})

describe('头像画布输出', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('区分可见像素与全透明像素', () => {
    expect(hasVisibleAvatarPixels(new Uint8ClampedArray([12, 34, 56, 0, 1, 2, 3, 0]))).toBe(false)
    expect(hasVisibleAvatarPixels(new Uint8ClampedArray([12, 34, 56, 0, 1, 2, 3, 1]))).toBe(true)
  })

  it('从原始字节创建位图、绘制并在完成后释放', async () => {
    const close = vi.fn()
    const bitmap = { close }
    const drawImage = vi.fn()
    const context = {
      drawImage,
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) })),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low'
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: (callback: BlobCallback): void =>
        callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' }))
    }
    const createImageBitmapMock = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })

    const bytes = new Uint8Array([137, 80, 78, 71]).buffer
    const result = await renderAvatarWebp(bytes, 'image/png', {
      imageWidth: 400,
      imageHeight: 400,
      viewportSize: 200,
      zoom: 2,
      offsetX: 0,
      offsetY: 0
    })

    expect(createImageBitmapMock).toHaveBeenCalledWith(expect.any(Blob), 100, 100, 200, 200, {
      resizeWidth: 192,
      resizeHeight: 192,
      resizeQuality: 'high'
    })
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0)
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]))
    expect(close).toHaveBeenCalledOnce()
  })

  it('全透明裁剪结果拒绝保存并释放位图', async () => {
    const close = vi.fn()
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) })),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low'
    }
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn()
    }
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close })))
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })

    await expect(
      renderAvatarWebp(new Uint8Array([1]).buffer, 'image/png', {
        imageWidth: 100,
        imageHeight: 100,
        viewportSize: 100,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    ).rejects.toThrow('裁剪结果为空')
    expect(canvas.toBlob).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
})
