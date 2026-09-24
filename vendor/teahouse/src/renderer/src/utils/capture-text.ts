import { isImeCompositionKey, type ImeKeyEvent } from './ime'

export interface CaptureTextPoint {
  x: number
  y: number
}

export interface CaptureTextSize {
  width: number
  height: number
}

export interface CaptureTextKeyEvent extends ImeKeyEvent {
  key: string
}

export const CAPTURE_TEXT_MAX_LENGTH = 80

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** 把截图文字输入框夹在视口内；标注锚点仍保留用户原始点击坐标。 */
export function placeCaptureTextEditor(
  anchor: CaptureTextPoint,
  editor: CaptureTextSize,
  viewport: CaptureTextSize,
  margin = 8
): CaptureTextPoint {
  const maxLeft = Math.max(margin, viewport.width - editor.width - margin)
  const maxTop = Math.max(margin, viewport.height - editor.height - margin)
  return {
    x: clamp(anchor.x, margin, maxLeft),
    y: clamp(anchor.y, margin, maxTop)
  }
}

/** 中文输入法确认候选时会发出 composing Enter / keyCode 229，不能提前提交标注。 */
export function shouldCommitCaptureText(
  event: CaptureTextKeyEvent,
  compositionActive: boolean
): boolean {
  return event.key === 'Enter' && !isImeCompositionKey(event, compositionActive)
}

export function normalizeCaptureText(value: string): string {
  return value.trim().slice(0, CAPTURE_TEXT_MAX_LENGTH)
}
