export interface CaptureRectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureSize {
  width: number
  height: number
}

export interface CaptureGeometry {
  windowBounds: CaptureRectangle
  imageCrop: CaptureRectangle
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function validRectangle(rect: CaptureRectangle): boolean {
  return rect.width > 0 && rect.height > 0
}

function intersect(a: CaptureRectangle, b: CaptureRectangle): CaptureRectangle | null {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Windows 普通置顶窗会受任务栏工作区约束。截图窗与桌面位图统一裁到 workArea，
 * 避免把含任务栏的整屏图压进较矮客户区；其余平台继续使用整屏（决议 #221）。
 */
export function planCaptureGeometry(
  platform: NodeJS.Platform,
  displayBounds: CaptureRectangle,
  workArea: CaptureRectangle,
  imageSize: CaptureSize
): CaptureGeometry {
  const fallback: CaptureGeometry = {
    windowBounds: { ...displayBounds },
    imageCrop: { x: 0, y: 0, width: imageSize.width, height: imageSize.height }
  }
  if (!validRectangle(displayBounds) || imageSize.width <= 0 || imageSize.height <= 0) {
    return fallback
  }
  if (platform !== 'win32') return fallback

  const windowBounds = intersect(displayBounds, workArea)
  if (!windowBounds || !validRectangle(windowBounds)) return fallback

  const scaleX = imageSize.width / displayBounds.width
  const scaleY = imageSize.height / displayBounds.height
  const left = clamp(
    Math.round((windowBounds.x - displayBounds.x) * scaleX),
    0,
    imageSize.width - 1
  )
  const top = clamp(
    Math.round((windowBounds.y - displayBounds.y) * scaleY),
    0,
    imageSize.height - 1
  )
  const right = clamp(
    Math.round((windowBounds.x + windowBounds.width - displayBounds.x) * scaleX),
    left + 1,
    imageSize.width
  )
  const bottom = clamp(
    Math.round((windowBounds.y + windowBounds.height - displayBounds.y) * scaleY),
    top + 1,
    imageSize.height
  )

  return {
    windowBounds,
    imageCrop: { x: left, y: top, width: right - left, height: bottom - top }
  }
}
