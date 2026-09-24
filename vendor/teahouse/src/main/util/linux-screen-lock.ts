import { execFile, spawn, type ChildProcess } from 'node:child_process'

const PROVIDERS = [
  { name: 'com.deepin.SessionManager', path: '/com/deepin/SessionManager', args: ['org.freedesktop.DBus.Properties.Get', 'com.deepin.SessionManager', 'Locked'] },
  { name: 'org.ukui.ScreenSaver', path: '/', args: ['org.ukui.ScreenSaver.GetLockState'] },
  { name: 'org.deepin.dde.SessionManager1', path: '/org/deepin/dde/SessionManager1', args: ['org.freedesktop.DBus.Properties.Get', 'org.deepin.dde.SessionManager1', 'Locked'] }
] as const
type Provider = typeof PROVIDERS[number]

export function parseLockReply(reply: string): boolean | null {
  const match = /^\(\s*<?(true|false)>?\s*,?\s*\)\s*$/.exec(reply.trim())
  return match ? match[1] === 'true' : null
}

/** 只探测有明确锁状态语义的桌面接口；缺命令或接口时保守禁用。 */
export class LinuxScreenLock {
  locked: boolean | null = null
  private provider: Provider | null = null
  private monitor: ChildProcess | null = null
  private poll: ReturnType<typeof setTimeout> | undefined
  private starting: Promise<void> | null = null
  private cancelWatch: (() => void) | null = null
  private active = false
  private pending: Promise<boolean | null> | null = null
  private revision = 0
  private closed = false

  constructor(private readonly changed: (locked: boolean | null) => void) {}

  start(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.starting) return this.starting
    if (this.monitor) return this.refresh().then(() => undefined)
    this.starting = this.probe().finally(() => { this.starting = null; this.schedule() })
    return this.starting
  }

  setActive(value: boolean): void {
    if (this.active === value) return
    this.active = value
    this.schedule()
  }

  private schedule(): void {
    clearTimeout(this.poll)
    if (this.closed) return
    this.poll = setTimeout(() => {
      void (this.monitor ? this.refresh() : this.start()).finally(() => this.schedule())
    }, this.active && this.monitor ? 5000 : 60_000)
  }

  private async probe(): Promise<void> {
    for (const provider of PROVIDERS) {
      if (this.closed) return
      const locked = await this.read(provider)
      if (this.closed) return
      if (locked === null) continue
      this.provider = provider
      if (await this.watch(provider)) {
        await this.refresh()
        return
      }
      this.monitor?.kill()
      this.monitor = null
    }
    this.provider = null
    this.update(null)
  }

  refresh(): Promise<boolean | null> {
    if (!this.provider || this.closed || !this.monitor) return Promise.resolve(null)
    if (this.pending) return this.pending
    const revision = this.revision
    const monitor = this.monitor
    this.pending = this.read(this.provider).then(value => {
      // 新锁屏信号优先于更早发出的属性查询，迟到 false 不得重新放行。
      if (!this.closed && this.monitor === monitor && revision === this.revision) this.update(value)
      return this.locked
    }).finally(() => { this.pending = null })
    return this.pending
  }

  close(): void {
    this.closed = true
    clearTimeout(this.poll)
    this.cancelWatch?.()
    this.monitor?.kill()
    this.monitor = null
    this.locked = null
  }

  private update(value: boolean | null): void {
    const previous = this.locked
    this.locked = value
    if (value !== previous) { this.revision++; this.changed(value) }
  }

  private read(provider: Provider): Promise<boolean | null> {
    return new Promise(resolve => {
      execFile('gdbus', ['call', '--session', '--dest', provider.name, '--object-path', provider.path,
        '--method', ...provider.args], { timeout: 1500, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? null : parseLockReply(stdout)))
    })
  }

  private watch(provider: Provider): Promise<boolean> {
    return new Promise(resolve => {
      let initialized = false
      let buffer = ''
      const monitor = spawn('gdbus', ['monitor', '--session', '--dest', provider.name, '--object-path', provider.path],
        { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] })
      this.monitor = monitor
      const timer = setTimeout(() => finish(false), 1500)
      const finish = (ok: boolean): void => {
        if (initialized) return
        initialized = true
        clearTimeout(timer)
        this.cancelWatch = null
        resolve(ok)
      }
      this.cancelWatch = () => finish(false)
      const lost = (): void => {
        finish(false)
        if (this.monitor === monitor && !this.closed) {
          this.monitor = null
          this.update(null)
          monitor.kill()
          this.schedule()
        }
      }
      monitor.on('error', lost)
      monitor.on('exit', lost)
      monitor.stderr?.on('data', lost)
      monitor.stdout?.on('data', (chunk: Buffer) => {
        if (this.closed || this.monitor !== monitor) return
        buffer += chunk.toString('utf8')
        if (buffer.length > 8192) { lost(); return }
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.includes('has no owner')) { lost(); return }
          if (line.includes('is owned by')) {
            if (initialized) { lost(); return }
            finish(true); continue
          }
          if (!line.startsWith(provider.path + ':')) continue
          if (/\.lock\s*\(|Locked.*<true>|LockedChanged\s*\(true/.test(line)) {
            this.revision++
            this.update(true)
          }
          if (/\.(?:lock|unlock|LockedChanged)\s*\(|PropertiesChanged.*['"]Locked['"]/.test(line)) void this.refresh()
        }
      })
    })
  }
}
