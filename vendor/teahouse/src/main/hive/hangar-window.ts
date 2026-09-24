// 机库独立窗口（#52 / Spec #41：「机库由同一 loopback local-api 页面承载，并可在 GUI
// 模式中由独立 BrowserWindow 打开；headless 模式不创建该窗口」）。
//
// 关键取舍：窗口直接加载 **local-api 的静态机库页面**，不新增 Vue 入口。
// 两个好处：
//   ① headless 与 GUI 看到的是同一份机库实现（页面只依赖 local-api，页面里没有任何
//      Electron 依赖），不会出现「窗口里的机库」和「HTTP 的机库」两套语义；
//   ② 主窗 renderer 静态闭包字节数**零增加** —— 上游 App.vue 的 JS 预算已被 #46 顶到
//      只剩十几字节（见 docs/vendor/teahouse.md 未决约束），再加一个 Vue 组件必破。
//
// headless 纪律：`HEADLESS` 为真时 `open()` 恒为 no-op（ADR-0002：headless 不建
// 主窗、托盘、快捷键或**机库窗口**）。调用方不需要自己判，防止漏判。
import { app, BrowserWindow, screen, session } from 'electron'
import { join } from 'node:path'

const HANGAR_WIDTH = 1100
const HANGAR_HEIGHT = 760

export interface HangarWindowDeps {
  /** 真 headless（`PANTRY_HEADLESS=1`）：绝不建窗。 */
  headless(): boolean
  /** local-api 已绑定的实际端口；0 = 还没 listen 完。 */
  apiPort(): number
  /** local-api 的 token（空 = 仅回环即可信）。带 token 时窗口也要带上。 */
  token(): string
}

let win: BrowserWindow | null = null

/** 居中到主窗几何中心（与设置窗同款，决议 #123），主窗不可用时回退 Electron 默认。 */
function centeredOverParent(parent: BrowserWindow | null): { x: number; y: number } | Record<string, never> {
  if (!parent || parent.isDestroyed()) return {}
  const bounds = parent.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const x = Math.round(bounds.x + (bounds.width - HANGAR_WIDTH) / 2)
  const y = Math.round(bounds.y + (bounds.height - HANGAR_HEIGHT) / 2)
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - HANGAR_WIDTH)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - HANGAR_HEIGHT))
  }
}

function linuxWindowIcon(): { icon: string } | Record<string, never> {
  if (process.platform !== 'linux') return {}
  const icon = app.isPackaged
    ? join(process.resourcesPath, 'icons/pantry.png')
    : join(app.getAppPath(), 'build/icons/linux/256x256.png')
  return { icon }
}

/** 打开（或聚焦）机库窗口。返回是否可见——headless 与端口未就绪时返回 false。 */
export function openHangarWindow(parent: BrowserWindow | null, deps: HangarWindowDeps): boolean {
  if (deps.headless()) return false
  const port = deps.apiPort()
  if (!port) return false
  if (win && !win.isDestroyed()) {
    win.show()
    win.focus()
    return true
  }
  const token = deps.token()
  const url = `http://127.0.0.1:${port}/v1/hangar`
  // 独立内存 session：带 token 时要装 onBeforeSendHeaders，绝不能装到默认 session 上
  // ——那会把本地 API 的凭据附加到应用里**所有**窗口的每一个请求上。
  // 与 RemoteViewWindows 的 `session.fromPartition('remote-view')` 同一纪律。
  const hangarSession = session.fromPartition('hive-hangar', { cache: false })
  if (token) {
    // local-api 的鉴权读 `Authorization` 头；页面内的 fetch 加不了自定义头，
    // 故由本轮请求统一注入。与下方的 origin 白名单一起构成最小暴露面。
    hangarSession.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${port}/*`] }, (details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, authorization: `Bearer ${token}` } })
    })
  }
  const created = new BrowserWindow({
    width: HANGAR_WIDTH,
    height: HANGAR_HEIGHT,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Hive 机库',
    ...centeredOverParent(parent),
    ...linuxWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: hangarSession
    }
  })
  win = created
  created.setMenuBarVisibility(false)
  // 安全红线同主窗：不放行任何窗口内导航与新窗口。
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event, target) => {
    // 只允许 local-api 自己的页面（页面内的 hash/查询切换不走 will-navigate）。
    if (!target.startsWith(`http://127.0.0.1:${port}/`)) event.preventDefault()
  })
  created.once('ready-to-show', () => created.show())
  created.on('closed', () => {
    if (win === created) win = null
  })
  void created.loadURL(url)
  return true
}

export function closeHangarWindow(): void {
  const current = win
  win = null
  if (current && !current.isDestroyed()) current.destroy()
}

export function hangarWindowOpen(): boolean {
  return win !== null && !win.isDestroyed()
}
