import { tr } from './i18n'
import { AVATAR_MAX_BYTES, AVATAR_OUTPUT_SIZE } from '../../../shared/protocol'

export interface AvatarCropState {
  imageWidth: number
  imageHeight: number
  viewportSize: number
  zoom: number
  offsetX: number
  offsetY: number
}

export function avatarCoverScale(
  imageWidth: number,
  imageHeight: number,
  viewportSize: number
): number {
  return Math.max(viewportSize / imageWidth, viewportSize / imageHeight)
}

export function clampAvatarOffset(state: AvatarCropState): { x: number; y: number } {
  const scale = avatarCoverScale(state.imageWidth, state.imageHeight, state.viewportSize) * state.zoom
  const maxX = Math.max(0, (state.imageWidth * scale - state.viewportSize) / 2)
  const maxY = Math.max(0, (state.imageHeight * scale - state.viewportSize) / 2)
  return {
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, state.offsetX)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, state.offsetY))
  }
}

export function avatarCropSourceRect(state: AvatarCropState): {
  x: number
  y: number
  size: number
} {
  const scale = avatarCoverScale(state.imageWidth, state.imageHeight, state.viewportSize) * state.zoom
  const size = state.viewportSize / scale
  return {
    x: state.imageWidth / 2 - state.offsetX / scale - size / 2,
    y: state.imageHeight / 2 - state.offsetY / scale - size / 2,
    size
  }
}

/** 最大缩放随源图动态放宽：允许放大到裁剪区约等于输出分辨率（192px 源像素），小图不放大（决议 #249）。 */
export function avatarMaxZoom(imageWidth: number, imageHeight: number): number {
  return Math.max(1, Math.min(imageWidth, imageHeight) / AVATAR_OUTPUT_SIZE)
}

/** 供 createImageBitmap 使用的整数裁剪矩形；取整与浮点误差都夹回图内，避免采到界外透明像素。 */
export function clampedAvatarCropRect(state: AvatarCropState): {
  x: number
  y: number
  size: number
} {
  const source = avatarCropSourceRect(state)
  const size = Math.max(
    1,
    Math.min(Math.round(source.size), Math.floor(state.imageWidth), Math.floor(state.imageHeight))
  )
  return {
    x: Math.max(0, Math.min(Math.round(source.x), Math.floor(state.imageWidth) - size)),
    y: Math.max(0, Math.min(Math.round(source.y), Math.floor(state.imageHeight) - size)),
    size
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
}

export function hasVisibleAvatarPixels(pixels: Uint8ClampedArray): boolean {
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 0) return true
  }
  return false
}

export async function renderAvatarWebp(
  bytes: ArrayBuffer,
  mime: string,
  state: AvatarCropState
): Promise<ArrayBuffer> {
  // 裁剪与降采样合并进 createImageBitmap：Chromium 的 resize 是多级滤波，
  // 大图一步 drawImage 到 192px 会明显锯齿（决议 #249）
  const rect = clampedAvatarCropRect(state)
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: mime }),
    rect.x,
    rect.y,
    rect.size,
    rect.size,
    {
      resizeWidth: AVATAR_OUTPUT_SIZE,
      resizeHeight: AVATAR_OUTPUT_SIZE,
      resizeQuality: 'high'
    }
  )
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_OUTPUT_SIZE
  canvas.height = AVATAR_OUTPUT_SIZE
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error(tr('无法创建图片处理画布'))
    context.drawImage(bitmap, 0, 0)
    const pixels = context.getImageData(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE).data
    if (!hasVisibleAvatarPixels(pixels)) throw new Error(tr('裁剪结果为空，请重新选择图片'))
    for (const quality of [0.86, 0.78, 0.68, 0.56, 0.44, 0.32]) {
      const blob = await canvasBlob(canvas, quality)
      if (blob?.type === 'image/webp' && blob.size <= AVATAR_MAX_BYTES) {
        return blob.arrayBuffer()
      }
    }
    throw new Error(tr('图片细节过多，请调整裁剪范围后重试'))
  } finally {
    bitmap.close()
  }
}
