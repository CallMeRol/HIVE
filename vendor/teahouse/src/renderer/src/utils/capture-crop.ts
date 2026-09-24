export interface CaptureRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CaptureDimensions {
  width: number
  height: number
}

export interface ImageCrop {
  x: number
  y: number
  width: number
  height: number
  scaleX: number
  scaleY: number
}

/** 将窗口逻辑像素选区映射到截图实际像素；X/Y 独立换算以消除 DPI 误差。 */
export function mapCaptureRectToImage(
  rect: CaptureRect,
  viewport: CaptureDimensions,
  image: CaptureDimensions
): ImageCrop | null {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0 ||
    rect.w <= 0 ||
    rect.h <= 0
  ) {
    return null
  }
  const scaleX = image.width / viewport.width
  const scaleY = image.height / viewport.height
  const left = Math.max(0, Math.min(image.width - 1, Math.round(rect.x * scaleX)))
  const top = Math.max(0, Math.min(image.height - 1, Math.round(rect.y * scaleY)))
  const right = Math.max(
    left + 1,
    Math.min(image.width, Math.round((rect.x + rect.w) * scaleX))
  )
  const bottom = Math.max(
    top + 1,
    Math.min(image.height, Math.round((rect.y + rect.h) * scaleY))
  )
  return { x: left, y: top, width: right - left, height: bottom - top, scaleX, scaleY }
}
