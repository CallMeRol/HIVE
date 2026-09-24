import type { SettingsView } from '../../../shared/ipc'

export function applyAppearance(settings: Pick<SettingsView, 'theme'>): void {
  document.documentElement.dataset.theme = settings.theme
  // 字体倍率由主进程 webContents.setZoomFactor 统一应用（决议 #257）。
  // 清理热更新或旧 renderer 留下的 inline CSS zoom，避免它参与输入法坐标换算。
  document.body.style.removeProperty('zoom')
}
