import { app, BrowserWindow, desktopCapturer, ipcMain, powerMonitor, screen, session, systemPreferences,
  type DesktopCapturerSource, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { tr } from '../../i18n'
import { IpcChannels, IpcEvents } from '../../shared/ipc'
import { CAPS, LIMITS, SCREEN_MAX_FRAME_BYTES, isScreenSessionId } from '../../shared/protocol'
import { isScreenMode, type ScreenAvailability, type ScreenImage, type ScreenSource, type ScreenState } from '../../shared/remote-view'
import { RemoteViewService, type RemoteViewDeps } from '../services/remote-view'
import { LinuxScreenLock } from '../util/linux-screen-lock'
import { resolveDevRendererUrl } from '../util/renderer-url'
import { isWaylandSession } from './capture-support'

interface Pending<T> { sessionId: string; seq: number; resolve: (value: T) => void; reject: (error: Error) => void }

/** Electron 装配：权限/窗口身份留在此处，会话业务由 RemoteViewService 负责。 */
export class RemoteViewWindows {
  service: RemoteViewService | null = null
  private win: BrowserWindow | null = null
  private source: DesktopCapturerSource | null = null
  private grant: DesktopCapturerSource | null = null
  private mediaPermitUsed = false
  private sources = new Map<string, DesktopCapturerSource>()
  private enumerating = false
  private locked: boolean | null = null
  private suspended = false
  private networkReady = false
  private linux: LinuxScreenLock | null = null
  private pendingSample: Pending<Uint8Array> | null = null
  private pendingDisplay: Pending<void> | null = null
  private queuedImage: ScreenImage | null = null
  private viewerReady = false

  constructor(private readonly main: () => BrowserWindow | null, private readonly capabilitiesChanged: () => void, private readonly beforeCapture?: () => Promise<void>) {
    this.registerIpc()
  }

  start(): void {
    if (process.platform === 'linux') {
      this.linux = new LinuxScreenLock(value => this.setLocked(value))
      void this.linux.start()
    } else {
      this.refreshNativeLock()
      powerMonitor.on('lock-screen', () => this.setLocked(true))
      powerMonitor.on('unlock-screen', () => this.setLocked(false))
    }
    powerMonitor.on('suspend', () => { this.suspended = true; this.service?.stopAll('suspended') })
    powerMonitor.on('resume', () => { this.suspended = false; void this.refreshLock() })
    screen.on('display-removed', (_event, display) => {
      if (this.source?.display_id === String(display.id)) this.service?.stopAll('capture-ended')
    })
    screen.on('display-metrics-changed', () => {
      if (this.source && this.win) this.dockSharing(this.win)
    })
  }

  attach(deps: Omit<RemoteViewDeps, 'available' | 'sample' | 'display'>): RemoteViewService {
    const service = new RemoteViewService({ ...deps, available: () => this.availability(),
      sample: (id, seq) => this.sample(id, seq), display: (id, seq, bytes, width, height) => this.display(id, seq, bytes, width, height) })
    this.service = service
    service.on('state', (state: ScreenState) => this.update(state))
    service.on('focus', () => { this.win?.show(); this.win?.focus() })
    return service
  }

  capabilities(): string[] {
    if (!this.networkReady || this.locked === null) return []
    return this.captureSupported() ? [CAPS.remoteView, CAPS.remoteShare] : [CAPS.remoteView]
  }

  availability(): ScreenAvailability {
    if (!this.networkReady) return { view: false, share: false, reason: tr('网络未就绪，暂不能使用屏幕协助') }
    if (this.locked === null) return { view: false, share: false, reason: tr('当前桌面缺少可用的锁屏检测，暂不能使用屏幕协助') }
    if (this.locked || this.suspended) return { view: false, share: false, reason: tr('锁屏或休眠期间无法使用屏幕协助') }
    return { view: true, share: this.captureSupported(), reason: this.captureSupported() ? '' : tr('当前系统暂不支持共享屏幕，可查看他人屏幕') }
  }

  close(): void { this.service?.stopAll('app-exit'); this.linux?.close(); this.destroyWindow() }
  setNetworkReady(value: boolean): void {
    this.networkReady = value
    if (!value) this.service?.stopAll('disconnected')
    this.capabilitiesChanged()
  }

  private captureSupported(): boolean {
    return !(process.platform === 'linux' && process.arch === 'arm64' && isWaylandSession())
  }
  private setLocked(value: boolean | null): void {
    this.locked = value
    if (value !== false) this.service?.stopAll('locked')
    this.capabilitiesChanged()
  }
  private refreshNativeLock(): void {
    const value = powerMonitor.getSystemIdleState(1)
    this.setLocked(value === 'locked' ? true : value === 'active' || value === 'idle' ? false : null)
  }
  private async refreshLock(): Promise<void> {
    if (this.linux) this.setLocked(await this.linux.refresh())
    else this.refreshNativeLock()
  }

  private update(state: ScreenState): void {
    this.linux?.setActive(state.phase !== 'ended')
    if (state.phase === 'ended') this.destroyWindow()
    else if (!this.win) this.open(state)
    else if (state.role === 'sharer' && state.phase === 'preparing') {
      const win = this.win
      win.setMinimumSize(1, 1)
      this.dockSharing(win)
      win.setResizable(false)
    }
    this.win?.webContents.send(IpcEvents.screenState, state)
    const main = this.main()
    if (main && !main.isDestroyed()) main.webContents.send(IpcEvents.screenState, state)
  }

  private dockSharing(win: BrowserWindow): void {
    const area = (screen.getAllDisplays().find(display => String(display.id) === this.source?.display_id)
      ?? screen.getDisplayMatching(win.getBounds())).workArea
    const width = Math.min(320, area.width), height = Math.min(56, area.height)
    win.setBounds({ width, height, x: area.x + area.width - width, y: area.y })
  }

  private open(state: ScreenState): void {
    const sharer = state.role === 'sharer'
    const main = this.main()
    const area = (main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()).workArea
    const width = Math.min(sharer ? 560 : 1100, area.width)
    const height = Math.min(sharer ? 480 : 760, area.height)
    // 独立内存 session 不继承其他窗口的媒体授权或磁盘缓存。
    const mediaSession = session.fromPartition('remote-view', { cache: false })
    mediaSession.setPermissionCheckHandler(() => false)
    const win = new BrowserWindow({
      width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
      minWidth: Math.min(480, area.width), minHeight: Math.min(300, area.height),
      show: false, title: tr('屏幕协助'), frame: !sharer, alwaysOnTop: sharer, minimizable: !sharer, maximizable: !sharer,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true,
        sandbox: true, nodeIntegration: false, backgroundThrottling: false, session: mediaSession }
    })
    this.win = win
    // Electron 22 将显示媒体上报为 media + 空 mediaTypes；摄像头/麦克风含对应类型。
    // 权限只给当前已同意的主 frame 一次，随后显示媒体 handler 再绑定具体屏幕。
    mediaSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const current = this.service?.getState()
      const allowed = this.win === win && contents === win.webContents && details.isMainFrame &&
        details.requestingUrl === win.webContents.getURL() && permission === 'media' &&
        Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0 && this.grant !== null &&
        !this.mediaPermitUsed && current?.sessionId === state.sessionId && current.phase === 'preparing' &&
        current.role === 'sharer' && this.availability().share
      if (allowed) this.mediaPermitUsed = true
      callback(allowed)
    })
    mediaSession.setDisplayMediaRequestHandler((request, callback) => {
      const current = this.service?.getState()
      const grant = this.grant
      this.grant = null
      if (this.win === win && request.frame === win.webContents.mainFrame && request.videoRequested &&
          !request.audioRequested && this.mediaPermitUsed && grant && current?.sessionId === state.sessionId &&
          current.role === 'sharer' && current.phase === 'preparing' && this.availability().share) {
        callback({ video: grant })
      } else callback({})
    })
    win.setMenuBarVisibility(false)
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => { event.preventDefault(); this.service?.stop(state.sessionId, 'capture-ended') })
    win.webContents.on('render-process-gone', () => this.service?.stop(state.sessionId, 'capture-ended'))
    win.on('unresponsive', () => this.service?.stop(state.sessionId, 'capture-ended'))
    win.on('minimize', () => {
      if (sharer) win.restore()
      else this.service?.setMinimized(true)
    })
    win.on('restore', () => this.service?.setMinimized(false))
    win.on('close', () => this.service?.stop(state.sessionId))
    win.on('closed', () => { if (this.win === win) this.win = null })
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      if (sharer) win.showInactive()
      else win.show()
    })
    const hash = '/remote-view'
    const url = resolveDevRendererUrl(process.env['ELECTRON_RENDERER_URL'], hash, app.isPackaged)
    const load = url ? win.loadURL(url) : win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
    void load.catch(() => this.service?.stop(state.sessionId, 'capture-ended'))
  }

  private destroyWindow(): void {
    this.grant = null
    this.mediaPermitUsed = false
    this.source = null
    this.sources.clear()
    this.pendingSample?.reject(new Error('会话已结束'))
    this.pendingDisplay?.reject(new Error('会话已结束'))
    this.pendingSample = null
    this.pendingDisplay = null
    this.queuedImage = null
    this.viewerReady = false
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }

  private sample(sessionId: string, seq: number): Promise<Uint8Array> {
    if (!this.win || this.pendingSample) return Promise.reject(new Error('采集窗口不可用'))
    return new Promise((resolve, reject) => {
      this.pendingSample = { sessionId, seq, resolve, reject }
      this.win!.webContents.send(IpcEvents.screenSample, { sessionId, seq })
    })
  }

  private display(sessionId: string, seq: number, bytes: Uint8Array, width: number, height: number): Promise<void> {
    if (!this.win || this.pendingDisplay) return Promise.reject(new Error('查看窗口不可用'))
    return new Promise((resolve, reject) => {
      this.pendingDisplay = { sessionId, seq, resolve, reject }
      this.queuedImage = { sessionId, seq, width, height, bytes: Uint8Array.from(bytes).buffer }
      this.deliverImage()
    })
  }

  private deliverImage(): void {
    if (!this.viewerReady || !this.queuedImage || !this.win) return
    this.win.webContents.send(IpcEvents.screenImage, this.queuedImage)
    this.queuedImage = null
  }

  private isWindow(event: IpcMainInvokeEvent, which: 'main' | 'remote'): boolean {
    const win = which === 'main' ? this.main() : this.win
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame)
  }
  private owns(event: IpcMainInvokeEvent, id: unknown, role?: ScreenState['role']): boolean {
    const state = this.service?.getState()
    return this.isWindow(event, 'remote') && isScreenSessionId(id) && state?.sessionId === id &&
      state.phase !== 'ended' && (!role || state.role === role)
  }

  private registerIpc(): void {
    ipcMain.handle(IpcChannels.screenAvailability, event =>
      this.isWindow(event, 'main') || this.isWindow(event, 'remote') ? this.availability() : { view: false, share: false, reason: '' })
    ipcMain.handle(IpcChannels.screenState, event =>
      this.isWindow(event, 'main') || this.isWindow(event, 'remote') ? this.service?.getState() ?? null : null)
    ipcMain.handle(IpcChannels.screenRequest, async (event, peer: unknown, focusOnly: unknown = false) => {
      if (!this.isWindow(event, 'main') || typeof peer !== 'string' || !peer || peer.length > LIMITS.from || typeof focusOnly !== 'boolean') return { ok: false, reason: 'unsupported' }
      await this.refreshLock()
      return this.isWindow(event, 'main') ? this.service?.request(peer, focusOnly) ?? { ok: false, reason: 'unsupported' } : { ok: false, reason: 'unsupported' }
    })
    ipcMain.handle(IpcChannels.screenSources, async (event, id: unknown): Promise<ScreenSource[]> => {
      if (!this.owns(event, id, 'sharer') || this.service?.getState()?.phase !== 'awaiting-consent' || this.enumerating) return []
      this.enumerating = true
      try {
        await this.refreshLock()
        if (!this.owns(event, id, 'sharer') || !this.availability().share) return []
        if (process.platform === 'darwin' && ['denied', 'restricted'].includes(systemPreferences.getMediaAccessStatus('screen'))) {
          this.service?.failPreparation(id as string, 'permission-denied'); return []
        }
        await this.beforeCapture?.()
        if (!this.owns(event, id, 'sharer') || !this.availability().share) return []
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 240, height: 150 }, fetchWindowIcons: false })
        if (!this.owns(event, id, 'sharer')) return []
        this.sources = new Map(sources.slice(0, 32).map(source => [source.id, source]))
        if (!this.sources.size) this.service?.failPreparation(id as string, 'capture-failed')
        return [...this.sources.values()].map(source => ({ id: source.id, name: source.name.slice(0, 128), thumbnail: source.thumbnail.toDataURL() }))
      } catch { this.service?.failPreparation(id as string, 'capture-failed'); return [] }
      finally { this.enumerating = false }
    })
    ipcMain.handle(IpcChannels.screenRespond, async (event, id: unknown, accepted: unknown, sourceId: unknown) => {
      if (!this.owns(event, id, 'sharer') || typeof accepted !== 'boolean') return false
      if (!accepted) return sourceId === undefined && this.service!.respond(id as string, false)
      if (typeof sourceId !== 'string' || !this.sources.has(sourceId)) return false
      await this.refreshLock()
      if (!this.owns(event, id, 'sharer') || !this.sources.has(sourceId)) return false
      const source = this.sources.get(sourceId)!
      this.source = source
      if (!this.service!.respond(id as string, true)) return false
      this.grant = source
      this.sources.clear()
      return true
    })
    ipcMain.handle(IpcChannels.screenReady, (event, id: unknown) => {
      if (this.owns(event, id, 'viewer')) { this.viewerReady = true; this.deliverImage(); return true }
      return this.owns(event, id, 'sharer') && this.grant === null && this.source !== null && this.service!.captureReady(id as string)
    })
    ipcMain.handle(IpcChannels.screenFail, (event, id: unknown, reason: unknown) => {
      if (this.owns(event, id) && (reason === 'permission-denied' || reason === 'capture-failed')) this.service!.failPreparation(id as string, reason)
    })
    ipcMain.handle(IpcChannels.screenStop, (event, id: unknown) => {
      if (this.owns(event, id) || (this.isWindow(event, 'main') && isScreenSessionId(id))) this.service?.stop(id as string)
    })
    ipcMain.handle(IpcChannels.screenMode, (event, id: unknown, mode: unknown) =>
      this.owns(event, id, 'viewer') && isScreenMode(mode) && this.service!.setMode(id as string, mode))
    ipcMain.handle(IpcChannels.screenFrame, (event, id: unknown, seq: unknown, bytes: unknown) => {
      const pending = this.pendingSample
      if (!this.owns(event, id, 'sharer') || !pending || pending.sessionId !== id || pending.seq !== seq) return false
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > SCREEN_MAX_FRAME_BYTES) {
        this.service!.stop(id as string, 'protocol-error'); return false
      }
      this.pendingSample = null
      pending.resolve(new Uint8Array(bytes))
      return true
    })
    ipcMain.handle(IpcChannels.screenConsumed, (event, id: unknown, seq: unknown) => {
      const pending = this.pendingDisplay
      if (!this.owns(event, id, 'viewer') || !pending || pending.sessionId !== id || pending.seq !== seq) return false
      this.pendingDisplay = null
      pending.resolve()
      return true
    })
  }
}
