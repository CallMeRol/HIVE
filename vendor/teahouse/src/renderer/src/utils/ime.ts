export interface ImeKeyEvent {
  isComposing: boolean
  keyCode: number
}

/** 输入法组词期间的键盘事件必须完整交还给原生编辑控件处理。 */
export function isImeCompositionKey(
  event: ImeKeyEvent,
  compositionActive: boolean
): boolean {
  return compositionActive || event.isComposing || event.keyCode === 229
}
