import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Socket } from 'node:net'
import {
  CAPS, SCREEN_REQUEST_TIMEOUT_MS, SCREEN_CONNECT_TIMEOUT_MS, SCREEN_REQUEST_INTERVAL_MS,
  SCREEN_TERMINAL_TTL_MS, SCREEN_TERMINAL_MAX,
  type ScreenPayload, type ScreenOpenFrame, type TcpFrame, type ScreenEndReason, type ScreenRejectReason
} from '../../shared/protocol'
import type { ScreenAvailability, ScreenMode, ScreenState, ScreenRequestResult } from '../../shared/remote-view'
import { createScreenSender, ScreenReceiver, type ScreenSender } from '../net/screen-stream'

export interface ScreenPeer { ip: string; tcpPort: number; online: boolean; name: string; caps: string[] }
export interface RemoteViewDeps {
  selfId: string
  peer: (id: string) => ScreenPeer | null
  available: () => ScreenAvailability
  send: (id: string, payload: ScreenPayload, bestEffort: boolean, signal?: AbortSignal) => Promise<boolean>
  sample: (sessionId: string, seq: number) => Promise<Uint8Array>
  display: (sessionId: string, seq: number, bytes: Uint8Array, width: number, height: number) => Promise<void>
}

/** 单节点只持有一个会话；UI、协议和采集均由本服务的状态授权。 */
export class RemoteViewService extends EventEmitter {
  private state: ScreenState | null = null
  private revision = 0
  private token: string | null = null
  private control: AbortController | null = null
  private tcpPort = 0
  private sender: ScreenSender | null = null
  private receiver: ScreenReceiver | null = null
  private minimized = false
  private startedMono: number | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly terminal = new Map<string, number>()
  private readonly incomingRate = new Map<string, number>()
  private readonly outgoingRate = new Map<string, number>()

  constructor(private readonly deps: RemoteViewDeps, private readonly now = () => performance.now()) { super() }

  getState(): ScreenState | null { return this.state ? { ...this.state } : null }
  getAvailability(): ScreenAvailability { return this.deps.available() }

  request(peerId: string, focusOnly = false): ScreenRequestResult {
    const active = this.active()
    if (active) {
      if (active.peerId === peerId) { this.emit('focus'); return { ok: true } }
      return { ok: false, reason: 'busy' }
    }
    if (focusOnly) return { ok: false, reason: 'unsupported' }
    const peer = this.deps.peer(peerId)
    if (!peer?.online) return { ok: false, reason: 'offline' }
    if (!this.deps.available().view || !peer.caps.includes(CAPS.remoteView) || !peer.caps.includes(CAPS.remoteShare)) return { ok: false, reason: 'unsupported' }
    if (!this.allow(this.outgoingRate, peerId)) return { ok: false, reason: 'rate-limited' }
    const sessionId = randomUUID()
    this.begin(peerId, peer, sessionId, 'viewer')
    void this.send(peerId, { op: 'request', sessionId }).then(ok => {
      if (!ok && this.matches(sessionId) && this.state?.phase === 'requesting') this.stop(sessionId, 'disconnected')
    })
    return { ok: true }
  }

  receive(peerId: string, ip: string, payload: ScreenPayload): void {
    const peer = this.deps.peer(peerId)
    if (!peer || ip.replace(/^::ffff:/, '') !== peer.ip || peerId === this.deps.selfId || !peer.caps.includes(CAPS.remoteView)) return
    const { sessionId } = payload
    this.prune()
    const current = this.active()
    const matching = current?.sessionId === sessionId && current.peerId === peerId && current.peerIp === peer.ip
    if (payload.op === 'request') {
      if (matching || this.terminal.has(`${peerId}|${sessionId}`)) return
      if (!this.allow(this.incomingRate, peerId)) return
      const reason = current ? 'busy' : !peer.online || !this.deps.available().share ? 'unsupported' : null
      if (reason) {
        this.remember(peerId, sessionId)
        const at = Date.now()
        this.emit('history', { revision: 0, sessionId, peerId, peerName: peer.name, peerIp: peer.ip,
          role: 'sharer', phase: 'ended', mode: 'auto', targetFps: 10, requestedAt: at, endedAt: at, reason } satisfies ScreenState, true)
        void this.send(peerId, { op: 'reject', sessionId, reason })
        return
      }
      this.begin(peerId, peer, sessionId, 'sharer')
      return
    }
    if (payload.op === 'end') {
      if (matching) this.finish(payload.reason)
      else if (!this.terminal.has(`${peerId}|${sessionId}`) && this.allow(this.incomingRate, peerId)) this.remember(peerId, sessionId)
      return
    }
    if (!matching) {
      if (payload.op === 'accept') void this.send(peerId, { op: 'end', sessionId, reason: 'canceled' }, true)
      return
    }
    if (payload.op === 'reject') {
      if (current.role === 'viewer' && current.phase === 'requesting') this.finish(payload.reason)
      return
    }
    if (payload.op !== 'accept' || current.role !== 'viewer' || current.phase !== 'requesting') return
    if (!this.deps.available().view || !this.peerValid()) { this.stop(sessionId, 'disconnected'); return }
    this.phase('connecting', SCREEN_CONNECT_TIMEOUT_MS)
    this.receiver = new ScreenReceiver({
      host: peer.ip, port: this.tcpPort, selfId: this.deps.selfId, sessionId, token: payload.token,
      display: (seq, bytes, width, height) => this.deps.display(sessionId, seq, bytes, width, height),
      onReady: () => { if (this.matches(sessionId)) this.phase('active') },
      onTarget: fps => {
        if (!this.matches(sessionId) || this.state!.targetFps === fps) return
        this.state!.targetFps = fps
        this.publish()
      },
      onEnd: reason => this.stop(sessionId, reason)
    })
    this.receiver.setMode(current.mode)
    this.receiver.setMinimized(this.minimized)
  }

  /** sourceId 的本地枚举归属在窗口层验证；本方法只接受当前邀请。 */
  respond(sessionId: string, accept: boolean): boolean {
    const s = this.active()
    if (!s || s.sessionId !== sessionId || s.role !== 'sharer' || s.phase !== 'awaiting-consent') return false
    if (!accept) { this.failPreparation(sessionId, 'declined'); return true }
    if (!this.deps.available().share || !this.peerValid()) { this.failPreparation(sessionId, 'unsupported'); return false }
    // 准备仍用原邀请期限，系统权限等待不能无限续期。
    s.phase = 'preparing'
    this.publish(true)
    return true
  }

  captureReady(sessionId: string): boolean {
    const s = this.active()
    if (!s || s.sessionId !== sessionId || s.role !== 'sharer' || s.phase !== 'preparing') return false
    if (!this.deps.available().share || !this.peerValid()) { this.failPreparation(sessionId, 'unsupported'); return false }
    this.token = randomBytes(16).toString('hex')
    this.phase('connecting', SCREEN_CONNECT_TIMEOUT_MS)
    void this.send(s.peerId, { op: 'accept', sessionId, token: this.token }).then(ok => {
      if (!ok && this.matches(sessionId) && this.state?.phase === 'connecting') this.stop(sessionId, 'disconnected')
    })
    return true
  }

  failPreparation(sessionId: string, reason: ScreenRejectReason): void {
    const s = this.active()
    if (!s || s.sessionId !== sessionId) return
    if (s.role === 'sharer' && (s.phase === 'awaiting-consent' || s.phase === 'preparing')) {
      void this.send(s.peerId, { op: 'reject', sessionId, reason })
      this.finish(reason)
    } else this.stop(sessionId, 'capture-ended')
  }

  open(socket: Socket, frame: ScreenOpenFrame): ((frame: TcpFrame) => void) | null {
    const s = this.active()
    if (!s || s.role !== 'sharer' || s.phase !== 'connecting' || s.sessionId !== frame.sessionId ||
        s.peerId !== frame.from || socket.remoteAddress?.replace(/^::ffff:/, '') !== s.peerIp ||
        !this.token || this.token !== frame.token || !this.peerValid() || !this.deps.available().share) return null
    this.token = null
    this.sender = createScreenSender(socket, s.sessionId, seq => this.deps.sample(s.sessionId, seq), reason => this.stop(s.sessionId, reason))
    this.phase('active')
    return this.sender.handle
  }

  setMode(sessionId: string, mode: ScreenMode): boolean {
    const s = this.active()
    if (!s || s.sessionId !== sessionId || s.role !== 'viewer') return false
    s.mode = mode
    s.targetFps = mode === 'economy' ? 3 : mode === 'standard' ? 5 : 10
    this.receiver?.setMode(mode)
    this.publish()
    return true
  }
  setMinimized(value: boolean): void { this.minimized = value; this.receiver?.setMinimized(value) }

  stop(sessionId: string, reason: ScreenEndReason = 'user'): void {
    const s = this.active()
    if (!s || s.sessionId !== sessionId) return
    // 本机清理先于任何网络 I/O。
    this.finish(reason)
    void this.send(s.peerId, { op: 'end', sessionId, reason }, true)
  }
  stopAll(reason: ScreenEndReason): void {
    const s = this.active()
    if (s) this.stop(s.sessionId, reason)
  }
  checkPeer(): void { if (this.active() && !this.peerValid()) this.stopAll('disconnected') }

  private begin(peerId: string, peer: ScreenPeer, sessionId: string, role: ScreenState['role']): void {
    this.minimized = false
    this.startedMono = null
    this.tcpPort = peer.tcpPort
    this.state = { revision: 0, sessionId, peerId, peerName: peer.name, peerIp: peer.ip, role,
      phase: role === 'viewer' ? 'requesting' : 'awaiting-consent', mode: 'auto', targetFps: 10, requestedAt: Date.now() }
    this.phase(this.state.phase, SCREEN_REQUEST_TIMEOUT_MS, true)
  }
  private phase(phase: ScreenState['phase'], timeout?: number, initial = false): void {
    clearTimeout(this.timer)
    this.state!.phase = phase
    if (phase === 'active' && this.startedMono === null) {
      this.startedMono = this.now()
      this.state!.startedAt = Date.now()
    }
    if (timeout) this.timer = setTimeout(() => this.stopAll('timeout'), timeout)
    this.publish(true, initial)
  }
  private finish(reason: ScreenState['reason']): void {
    const s = this.active()
    if (!s) return
    s.phase = 'ended'
    s.reason = reason
    s.endedAt = Date.now()
    if (this.startedMono !== null) s.durationMs = Math.max(0, Math.round(this.now() - this.startedMono))
    clearTimeout(this.timer)
    this.token = null
    this.control?.abort()
    this.control = null
    this.sender?.stop()
    this.receiver?.stop()
    this.sender = null
    this.receiver = null
    this.remember(s.peerId, s.sessionId)
    this.publish(true)
  }
  private active(): ScreenState | null { return this.state?.phase !== 'ended' ? this.state : null }
  private matches(id: string): boolean { return this.active()?.sessionId === id }
  private peerValid(): boolean {
    const s = this.active()
    const p = s ? this.deps.peer(s.peerId) : null
    return Boolean(s && p?.online && p.ip === s.peerIp && p.tcpPort === this.tcpPort)
  }
  private publish(history = false, initial = false): void {
    this.state!.revision = ++this.revision
    // 先销毁采集宿主/通知界面，持久化不能挡住停止共享。
    this.emit('state', this.getState())
    if (history) this.emit('history', this.getState(), initial)
  }
  private send(id: string, payload: ScreenPayload, bestEffort = false): Promise<boolean> {
    let signal: AbortSignal | undefined
    if (payload.op === 'request' || payload.op === 'accept') {
      this.control?.abort()
      this.control = new AbortController()
      signal = this.control.signal
    }
    return this.deps.send(id, payload, bestEffort, signal).catch(() => false)
  }
  private prune(): void {
    const now = this.now()
    for (const [key, at] of this.terminal) if (now - at >= SCREEN_TERMINAL_TTL_MS) this.terminal.delete(key)
  }
  private remember(peer: string, id: string): void {
    this.prune()
    const key = `${peer}|${id}`
    if (this.terminal.has(key)) return
    if (this.terminal.size >= SCREEN_TERMINAL_MAX) this.terminal.delete(this.terminal.keys().next().value!)
    this.terminal.set(key, this.now())
  }
  private allow(map: Map<string, number>, peer: string): boolean {
    const now = this.now()
    for (const [id, at] of map) if (now - at >= SCREEN_REQUEST_INTERVAL_MS) map.delete(id)
    if (map.has(peer)) return false
    if (map.size >= 256) return false
    map.set(peer, now)
    return true
  }
}
