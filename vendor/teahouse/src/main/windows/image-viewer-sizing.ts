export const IMAGE_VIEWER_MAX_WORK_AREA_RATIO = 0.7
export const IMAGE_VIEWER_MIN_CONTENT_WIDTH = 560
export const IMAGE_VIEWER_MIN_CONTENT_HEIGHT = 360
export const IMAGE_VIEWER_MIN_WINDOW_WIDTH = 560
export const IMAGE_VIEWER_MIN_WINDOW_HEIGHT = 420

export interface ImageViewerFitInput {
  imageWidth: number
  imageHeight: number
  workAreaWidth: number
  workAreaHeight: number
}

export interface ImageViewerFitResult {
  scale: number
  contentWidth: number
  contentHeight: number
}

export function fitImageViewerContent(input: ImageViewerFitInput): ImageViewerFitResult {
  const maxWidth = Math.max(1, Math.floor(input.workAreaWidth * IMAGE_VIEWER_MAX_WORK_AREA_RATIO))
  const maxHeight = Math.max(1, Math.floor(input.workAreaHeight * IMAGE_VIEWER_MAX_WORK_AREA_RATIO))
  const scale = Math.min(1, maxWidth / input.imageWidth, maxHeight / input.imageHeight)
  return {
    scale,
    contentWidth: Math.max(IMAGE_VIEWER_MIN_CONTENT_WIDTH, Math.round(input.imageWidth * scale)),
    contentHeight: Math.max(IMAGE_VIEWER_MIN_CONTENT_HEIGHT, Math.round(input.imageHeight * scale))
  }
}
