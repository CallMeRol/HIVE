import type { SettingsView } from '../../shared/ipc'

type FontScale = SettingsView['fontScale']

export interface ZoomableWebContents {
  isDestroyed(): boolean
  setZoomFactor(factor: number): void
}

/** 将设置白名单中的字体百分比换成 Electron WebContents 页面缩放倍率。 */
export function fontScaleToZoomFactor(fontScale: unknown): number {
  if (fontScale === 110 || fontScale === 125) return fontScale / 100
  return 1
}

/**
 * 主进程统一应用页面缩放，让 Chromium 自己维护 DOM、视口和屏幕坐标换算。
 * 窗口退出阶段可能在检查后立即销毁，调用失败按无窗口处理。
 */
export function applyWindowZoom(
  contents: ZoomableWebContents | null | undefined,
  fontScale: FontScale
): boolean {
  try {
    if (!contents || contents.isDestroyed()) return false
    contents.setZoomFactor(fontScaleToZoomFactor(fontScale))
    return true
  } catch {
    return false
  }
}
