import { TIMINGS, type Timings } from '../../shared/protocol'
import { parseCidr } from '../net/cidr'
import type { Discovery } from '../net/discovery'
import { markScanRangeAutoScanned, type AppState } from '../store/app-state'

interface Options {
  discovery: Discovery
  getState: () => AppState | null
  onlineCount: () => number
  udpPort: number
  onUpdated: () => void
  timings?: Partial<Timings>
}

/** 后台扫描只负责周期和持久化，逐地址限速复用 Discovery 的共同队列。 */
export class RangeScanScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly queued = new Set<string>()
  private readonly t: Timings
  private running = false

  constructor(private readonly opts: Options) {
    this.t = { ...TIMINGS, ...opts.timings }
  }

  start(): void {
    this.running = true
    this.sync()
  }

  private remote(cidr: string): boolean {
    const config = this.opts.getState()?.config
    return !!config?.scanRanges.includes(cidr) && config.scanRangeSources[cidr]?.source === 'remote'
  }

  private eligible(cidr: string): boolean {
    const state = this.opts.getState()
    if (!state || !this.remote(cidr)) return false
    if (this.opts.onlineCount() <= this.t.scanRangeAutoScanLargeOnlineThreshold) return true
    let hash = 2166136261
    for (const char of `${state.nodeId}:${cidr}`) {
      hash ^= char.charCodeAt(0)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0) % this.t.scanRangeAutoScanLargeOnlineModulo === 0
  }

  /** 配置变更后同步；删除网段同时取消未完成扫描。 */
  sync(): void {
    if (!this.running) return
    for (const cidr of new Set([...this.timers.keys(), ...this.queued])) {
      if (this.remote(cidr)) continue
      const timer = this.timers.get(cidr)
      if (timer) clearTimeout(timer)
      this.timers.delete(cidr)
      this.opts.discovery.cancelScan(`auto:${cidr}`)
      this.queued.delete(cidr)
    }
    for (const cidr of this.opts.getState()?.config.scanRanges ?? []) this.schedule(cidr)
  }

  stop(): void {
    this.running = false
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const cidr of this.queued) this.opts.discovery.cancelScan(`auto:${cidr}`)
    this.queued.clear()
  }

  private schedule(cidr: string): void {
    if (!this.running || !this.remote(cidr) || this.timers.has(cidr) || this.queued.has(cidr)) return
    const last = this.opts.getState()!.config.scanRangeSources[cidr].lastAutoScanAt
    const remaining = last ? Math.max(0, last + this.t.scanRangeAutoScanMinInterval - Date.now()) : 0
    const jitter = this.t.scanRangeAutoScanInitialMin + Math.floor(Math.random() *
      (this.t.scanRangeAutoScanInitialMax - this.t.scanRangeAutoScanInitialMin + 1))
    const timer = setTimeout(() => {
      this.timers.delete(cidr)
      const hosts = parseCidr(cidr)
      if (!hosts || !this.eligible(cidr)) {
        this.schedule(cidr)
        return
      }
      this.queued.add(cidr)
      const settled = (completed: boolean): void => {
        this.queued.delete(cidr)
        const state = this.opts.getState()
        try {
          if (completed && state && this.remote(cidr)) {
            markScanRangeAutoScanned(state, cidr)
            this.opts.onUpdated()
          }
        } finally {
          this.schedule(cidr)
        }
      }
      this.opts.discovery.scanHosts(hosts, this.opts.udpPort, this.t.scanRangeAutoScanHostDelay, {
        key: `auto:${cidr}`, background: true,
        shouldRun: () => this.running && this.eligible(cidr),
        onComplete: () => settled(true), onCancel: () => settled(false)
      })
    }, remaining + jitter)
    this.timers.set(cidr, timer)
    timer.unref?.()
  }
}
