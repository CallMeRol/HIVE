import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  const instances: Array<Record<string, any>> = []
  const BrowserWindow = vi.fn(function (this: Record<string, any>, options: Record<string, any>) {
    const handlers = new Map<string, (...args: any[]) => void>()
    const webHandlers = new Map<string, (...args: any[]) => void>()
    this.options = options
    this.handlers = handlers
    this.webContents = {
      handlers: webHandlers,
      isDestroyed: vi.fn().mockReturnValue(false),
      setZoomFactor: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => webHandlers.set(event, handler)),
      send: vi.fn()
    }
    this.setMenuBarVisibility = vi.fn()
    this.once = vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler))
    this.on = vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler))
    this.loadURL = vi.fn().mockResolvedValue(undefined)
    this.loadFile = vi.fn().mockResolvedValue(undefined)
    this.show = vi.fn()
    this.focus = vi.fn()
    this.isDestroyed = vi.fn().mockReturnValue(false)
    instances.push(this)
  })
  return {
    instances,
    BrowserWindow,
    app: { isPackaged: false, getAppPath: vi.fn().mockReturnValue('/tmp/pantry') },
    screen: {
      getDisplayMatching: vi.fn().mockReturnValue({
        workArea: { x: 0, y: 0, width: 1920, height: 1040 }
      })
    }
  }
})

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow,
  screen: electronMock.screen
}))

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function makeParent(): Record<string, any> {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    getBounds: vi.fn().mockReturnValue({ x: 100, y: 80, width: 960, height: 640 }),
    webContents: {
      isDestroyed: vi.fn().mockReturnValue(false),
      send: vi.fn()
    }
  }
}

async function loadSettingsWindow(platform: NodeJS.Platform): Promise<typeof import('./settings-window')> {
  setPlatform(platform)
  vi.resetModules()
  return import('./settings-window')
}

describe('设置窗口模态层级', () => {
  beforeEach(() => {
    electronMock.instances.length = 0
    electronMock.BrowserWindow.mockClear()
  })

  afterAll(() => setPlatform(originalPlatform))

  it('Windows 使用 modal 子窗、显式阴影并通知主窗显示遮罩', async () => {
    const parent = makeParent()
    const { openSettingsWindow } = await loadSettingsWindow('win32')

    openSettingsWindow(parent as never, 125)

    const instance = electronMock.instances[0]
    expect(instance.options.parent).toBe(parent)
    expect(instance.options.modal).toBe(true)
    expect(instance.options.hasShadow).toBe(true)
    expect(instance.options.frame).toBe(false)
    expect(instance.webContents.setZoomFactor).toHaveBeenCalledWith(1.25)
    instance.webContents.setZoomFactor.mockClear()
    instance.webContents.handlers.get('did-finish-load')?.()
    expect(instance.webContents.setZoomFactor).toHaveBeenCalledWith(1.25)
    expect(parent.webContents.send).toHaveBeenCalledWith('ui:settings-window-state', true)

    instance.handlers.get('closed')?.()
    expect(parent.webContents.send).toHaveBeenLastCalledWith('ui:settings-window-state', false)
  })

  it('重复打开现有窗口时维持遮罩并聚焦原窗口', async () => {
    const parent = makeParent()
    const { openSettingsWindow } = await loadSettingsWindow('linux')

    openSettingsWindow(parent as never, 100)
    openSettingsWindow(parent as never, 110)

    const instance = electronMock.instances[0]
    expect(electronMock.instances).toHaveLength(1)
    expect(parent.webContents.send).toHaveBeenLastCalledWith('ui:settings-window-state', true)
    expect(instance.show).toHaveBeenCalledTimes(1)
    expect(instance.focus).toHaveBeenCalledTimes(1)
    expect(instance.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.1)
  })

  it('macOS 保留原生阴影与父子窗口，不向主窗增加遮罩', async () => {
    const parent = makeParent()
    const { openSettingsWindow } = await loadSettingsWindow('darwin')

    openSettingsWindow(parent as never, 100)

    const instance = electronMock.instances[0]
    expect(instance.options.modal).toBeUndefined()
    expect(instance.options.hasShadow).toBe(true)
    expect(instance.options.titleBarStyle).toBe('hiddenInset')
    expect(parent.webContents.send).not.toHaveBeenCalled()
  })
})
