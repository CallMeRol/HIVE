export interface CaptureRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureSize {
  width: number
  height: number
}

export interface CaptureToolbarPosition {
  left: number
  top: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** 将截图工具条放进可用视口；优先下方，空间不足时翻到上方。 */
export function placeCaptureToolbar(
  selection: CaptureRect,
  toolbar: CaptureSize,
  viewport: CaptureSize,
  margin = 8,
  gap = 8
): CaptureToolbarPosition {
  const maxLeft = Math.max(margin, viewport.width - toolbar.width - margin)
  const preferredLeft = Math.min(
    selection.x,
    selection.x + selection.width - toolbar.width
  )
  const left = clamp(preferredLeft, margin, maxLeft)

  const maxTop = Math.max(margin, viewport.height - toolbar.height - margin)
  const below = selection.y + selection.height + gap
  const above = selection.y - gap - toolbar.height
  const top =
    below + toolbar.height <= viewport.height - margin
      ? below
      : above >= margin
        ? above
        : clamp(below, margin, maxTop)

  return { left, top }
}
