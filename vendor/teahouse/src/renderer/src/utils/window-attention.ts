/**
 * 主窗口是否处于「用户正在看」状态：页面可见且窗口聚焦。
 * 最小化、隐藏到托盘、被其他窗口压住失焦时为 false——此时当前会话的新消息
 * 不能静默置读，必须保留未读，驱动托盘闪烁与角标（决议 #220）。
 * 判定口径与主进程通知抑制条件（isFocused && isVisible）保持一致。
 */
export function isWindowAttended(
  doc: Pick<Document, 'visibilityState' | 'hasFocus'> = document
): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus()
}
