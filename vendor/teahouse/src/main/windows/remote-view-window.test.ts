import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { powerMonitor, screen } from 'electron'
import { RemoteViewWindows } from './remote-view-window'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
const sessionType = process.env.XDG_SESSION_TYPE
const mocks = vi.hoisted(() => ({ lock: null as null | ((value: boolean | null) => void), idle: 'active', deferred: false }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: { handle: vi.fn() }, powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleState: () => mocks.idle }),
    screen: Object.assign(new EventEmitter(), { getAllDisplays: vi.fn(), getDisplayMatching: vi.fn() }) }
})
vi.mock('../util/linux-screen-lock', () => ({ LinuxScreenLock: class {
  locked: boolean | null = null
  constructor(changed: (value: boolean | null) => void) { mocks.lock = changed }
  async start(): Promise<void> { if (!mocks.deferred) mocks.lock?.(false) }
  async refresh(): Promise<boolean | null> { return this.locked }
  setActive(): void {}
  close(): void {}
} }))
let windows: RemoteViewWindows
beforeEach(() => { mocks.idle = 'active'; mocks.deferred = false; windows = new RemoteViewWindows(() => null, () => undefined) })
afterEach(() => {
  windows.close()
  powerMonitor.removeAllListeners()
  screen.removeAllListeners()
  Object.defineProperty(process, 'platform', platform)
  Object.defineProperty(process, 'arch', arch)
  if (sessionType === undefined) delete process.env.XDG_SESSION_TYPE
  else process.env.XDG_SESSION_TYPE = sessionType
  vi.clearAllMocks()
})
function environment(os: string, cpu: string, desktop = ''): void {
  Object.defineProperty(process, 'platform', { value: os })
  Object.defineProperty(process, 'arch', { value: cpu })
  process.env.XDG_SESSION_TYPE = desktop
}
it.each([
  ['win32', 'ia32', '', true], ['win32', 'x64', '', true], ['darwin', 'arm64', '', true],
  ['linux', 'x64', 'x11', true], ['linux', 'arm64', 'x11', true], ['linux', 'arm64', 'wayland', false]
])('平台前置条件 %s / %s / %s 按角色声明能力', (os, cpu, desktop, share) => {
  environment(os as string, cpu as string, desktop as string)
  windows.start()
  expect(windows.capabilities()).toEqual([])
  windows.setNetworkReady(true)
  expect(windows.availability()).toMatchObject({ view: true, share })
  expect(windows.capabilities()).toEqual(share ? ['rv1', 'rvs1'] : ['rv1'])
})
it('Linux 慢探测不阻塞调用方；失效/恢复只改变能力', () => {
  environment('linux', 'arm64', 'x11')
  mocks.deferred = true
  expect(windows.start()).toBeUndefined()
  windows.setNetworkReady(true)
  expect(windows.availability().view).toBe(false)
  mocks.lock?.(false)
  expect(windows.availability().share).toBe(true)
  mocks.lock?.(null)
  expect(windows.capabilities()).toEqual([])
  mocks.lock?.(false)
  expect(windows.availability().share).toBe(true)
  expect(windows.service).toBeNull()
})
it('原生未知状态禁用，锁屏/休眠期间拒绝新协助', () => {
  environment('win32', 'ia32')
  mocks.idle = 'unknown'
  windows.start()
  windows.setNetworkReady(true)
  expect(windows.capabilities()).toEqual([])
  powerMonitor.emit('unlock-screen')
  expect(windows.availability().view).toBe(true)
  powerMonitor.emit('lock-screen')
  expect(windows.availability().share).toBe(false)
  powerMonitor.emit('unlock-screen')
  powerMonitor.emit('suspend')
  expect(windows.availability().share).toBe(false)
})


it('共享条按所选显示器工作区贴边，支持负坐标和小工作区', () => {
  const left = { id: 2, workArea: { x: -1280, y: 30, width: 1280, height: 690 } }
  const right = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  vi.mocked(screen.getAllDisplays).mockReturnValue([right, left] as Electron.Display[])
  vi.mocked(screen.getDisplayMatching).mockReturnValue(right as Electron.Display)
  const host = windows as unknown as { source: { display_id: string } | null; dockSharing: (win: unknown) => void }
  const win = { getBounds: () => ({ x: 0, y: 0, width: 560, height: 480 }), setBounds: vi.fn() }
  host.source = { display_id: '2' }
  host.dockSharing(win)
  expect(win.setBounds).toHaveBeenLastCalledWith({ x: -320, y: 30, width: 320, height: 56 })
  host.source = { display_id: '' }
  host.dockSharing(win)
  expect(win.setBounds).toHaveBeenLastCalledWith({ x: 1600, y: 0, width: 320, height: 56 })
  right.workArea = { x: 50, y: -20, width: 300, height: 50 }
  host.dockSharing(win)
  expect(win.setBounds).toHaveBeenLastCalledWith({ x: 50, y: -20, width: 300, height: 50 })
})
