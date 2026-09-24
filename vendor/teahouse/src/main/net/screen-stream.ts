import { createConnection, type Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import {
  SCREEN_CONNECT_TIMEOUT_MS, SCREEN_FRAME_TIMEOUT_MS, SCREEN_IDLE_TIMEOUT_MS,
  SCREEN_MAX_FRAME_BYTES, SCREEN_MAX_BYTES_PER_SECOND, SCREEN_MIN_FRAME_INTERVAL_MS,
  isScreenSize, type ScreenEndReason, type ScreenFrame, type TcpFrame
} from '../../shared/protocol'
import type { ScreenMode } from '../../shared/remote-view'
import { inspectImageMetadata } from '../../shared/image-metadata'
import { encodeFrame, FrameReader } from './frame'

/** 复用图片元数据检查；完整 JPEG 的解码结果还须由查看窗口确认。 */
export function screenImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength === 0 || bytes.byteLength > SCREEN_MAX_FRAME_BYTES) return null
  const meta = inspectImageMetadata(bytes)
  if (!meta || meta.format !== 'jpeg' || !isScreenSize(meta.width, meta.height)) return null
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null
  return { width: meta.width, height: meta.height }
}

/** ponytail: 先用耗时与滞回判断三档，目标机数据表明需要时再调整阈值。 */
export class ScreenRate {
  mode: ScreenMode = 'auto'
  fps = 10
  private slow = 0
  private stableSince: number | null = null
  private lastDown = -Infinity

  setMode(mode: ScreenMode): void {
    this.mode = mode
    this.fps = mode === 'economy' ? 3 : mode === 'standard' ? 5 : 10
    this.slow = 0
    this.stableSince = null
    this.lastDown = -Infinity
  }

  observe(duration: number, now: number): void {
    if (this.mode !== 'auto') return
    this.slow = duration > (1000 / this.fps) * 0.8 ? this.slow + 1 : 0
    if (this.slow >= 3 && this.fps > 3) {
      this.fps = this.fps === 10 ? 5 : 3
      this.slow = 0
      this.stableSince = null
      this.lastDown = now
      return
    }
    const faster = this.fps === 3 ? 5 : 10
    if (this.fps === 10 || duration >= (1000 / faster) * 0.6) {
      this.stableSince = null
      return
    }
    this.stableSince ??= now
    if (now - this.lastDown >= 10_000 && now - this.stableSince >= 10_000) {
      this.fps = faster
      this.stableSince = null
      this.slow = 0
    }
  }
}

export interface ScreenSender {
  handle(frame: TcpFrame): void
  stop(): void
}

/** 握手已由服务校验；复用监听器的 FrameReader，粘在首包后的 next 不会丢失。 */
export function createScreenSender(
  socket: Socket,
  sessionId: string,
  sample: (seq: number) => Promise<Uint8Array>,
  onEnd: (reason: ScreenEndReason) => void
): ScreenSender {
  let stopped = false
  let busy = false
  let sequence = 0
  let lastSample = -Infinity
  let credit = SCREEN_MAX_FRAME_BYTES
  let creditedAt = performance.now()
  let timer: ReturnType<typeof setTimeout>
  let scheduled: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
    clearTimeout(scheduled)
    socket.destroy()
  }
  const end = (reason: ScreenEndReason): void => {
    if (stopped) return
    stop()
    onEnd(reason)
  }
  const deadline = (ms: number): void => {
    clearTimeout(timer)
    timer = setTimeout(() => end('timeout'), ms)
  }
  socket.once('close', () => end('disconnected'))
  socket.once('error', () => end('disconnected'))
  socket.setNoDelay(true)
  socket.write(encodeFrame({ type: 'screen-ready', sessionId }))
  deadline(SCREEN_IDLE_TIMEOUT_MS)

  return {
    stop,
    handle(frame) {
      if (stopped) return
      if (frame.type !== 'screen-next' || frame.sessionId !== sessionId || frame.seq !== sequence + 1 || busy) {
        end('protocol-error'); return
      }
      busy = true
      sequence = frame.seq
      deadline(SCREEN_FRAME_TIMEOUT_MS)
      scheduled = setTimeout(() => {
        if (stopped) return
        lastSample = performance.now()
        void Promise.resolve().then(() => sample(sequence)).then((bytes) => {
          if (stopped) return
          const size = screenImageSize(bytes)
          if (!size) { end('capture-ended'); return }
          const now = performance.now()
          credit = Math.min(SCREEN_MAX_FRAME_BYTES, credit + (now - creditedAt) * SCREEN_MAX_BYTES_PER_SECOND / 1000)
          creditedAt = now
          const wait = Math.max(0, (bytes.byteLength - credit) * 1000 / SCREEN_MAX_BYTES_PER_SECOND)
          scheduled = setTimeout(() => {
            if (stopped) return
            const at = performance.now()
            credit = Math.min(SCREEN_MAX_FRAME_BYTES, credit + (at - creditedAt) * SCREEN_MAX_BYTES_PER_SECOND / 1000) - bytes.byteLength
            creditedAt = at
            const header: ScreenFrame = { type: 'screen-frame', sessionId, seq: sequence, ...size, len: bytes.byteLength }
            // 一帧一次写出；回调前保持 busy，慢 socket 不产生第二份编码结果。
            socket.write(Buffer.concat([encodeFrame(header), Buffer.from(bytes)]), () => {
              if (stopped) return
              busy = false
              deadline(SCREEN_IDLE_TIMEOUT_MS)
            })
          }, Math.ceil(wait))
        }).catch(() => end('capture-ended'))
      }, Math.max(0, Math.ceil(SCREEN_MIN_FRAME_INTERVAL_MS - (performance.now() - lastSample))))
    }
  }
}

export class ScreenReceiver {
  private readonly socket: Socket
  private readonly rate = new ScreenRate()
  private stopped = false
  private ready = false
  private waiting = false
  private sequence = 0
  private sentAt = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  private scheduled: ReturnType<typeof setTimeout> | undefined
  private minimized = false
  private body: Buffer | null = null
  private header: ScreenFrame | null = null
  private offset = 0

  constructor(private readonly opts: {
    host: string; port: number; selfId: string; sessionId: string; token: string
    display: (seq: number, bytes: Uint8Array, width: number, height: number) => Promise<void>
    onReady: () => void
    onTarget: (fps: number) => void
    onEnd: (reason: ScreenEndReason) => void
  }) {
    this.socket = createConnection({ host: opts.host, port: opts.port })
    this.socket.setNoDelay(true)
    this.deadline(SCREEN_CONNECT_TIMEOUT_MS)
    const reader = new FrameReader((frame) => {
      if (this.stopped) return
      if (!this.ready && frame.type === 'screen-ready' && frame.sessionId === opts.sessionId) {
        this.ready = true
        clearTimeout(this.timer)
        opts.onReady()
        this.schedule()
        return
      }
      if (!this.ready || !this.waiting || this.header || frame.type !== 'screen-frame' ||
          frame.sessionId !== opts.sessionId || frame.seq !== this.sequence) {
        this.end('protocol-error'); return
      }
      this.header = frame
      this.body = Buffer.alloc(frame.len)
      this.offset = 0
      reader.expectRaw(frame.len)
    }, (chunk) => {
      if (this.stopped) return
      const body = this.body
      const header = this.header
      if (!body || !header || this.offset + chunk.length > body.length) { this.end('protocol-error'); return }
      chunk.copy(body, this.offset)
      this.offset += chunk.length
      if (this.offset !== body.length) return
      const size = screenImageSize(body)
      if (!size || size.width !== header.width || size.height !== header.height) { this.end('protocol-error'); return }
      this.body = null
      void Promise.resolve().then(() => opts.display(header.seq, body, size.width, size.height)).then(() => {
        if (this.stopped) return
        this.header = null
        this.waiting = false
        clearTimeout(this.timer)
        if (!this.minimized) this.rate.observe(performance.now() - this.sentAt, performance.now())
        opts.onTarget(this.targetFps)
        this.schedule()
      }).catch(() => this.end('protocol-error'))
    }, () => this.end('protocol-error'))
    this.socket.on('connect', () => {
      if (!this.stopped) this.socket.write(encodeFrame({ type: 'screen-open', from: opts.selfId, sessionId: opts.sessionId, token: opts.token }))
    })
    this.socket.on('data', chunk => reader.feed(chunk))
    this.socket.once('error', () => this.end('disconnected'))
    this.socket.once('close', () => this.end('disconnected'))
  }

  get targetFps(): number { return this.minimized ? 3 : this.rate.fps }

  setMode(mode: ScreenMode): void {
    this.rate.setMode(mode)
    this.opts.onTarget(this.targetFps)
    this.schedule()
  }

  setMinimized(value: boolean): void {
    this.minimized = value
    this.opts.onTarget(this.targetFps)
    this.schedule()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.scheduled)
    this.body = null
    this.header = null
    this.socket.destroy()
  }

  private end(reason: ScreenEndReason): void {
    if (this.stopped) return
    this.stop()
    this.opts.onEnd(reason)
  }

  private deadline(ms: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.end('timeout'), ms)
  }

  private schedule(): void {
    clearTimeout(this.scheduled)
    if (this.stopped || !this.ready || this.waiting) return
    this.scheduled = setTimeout(() => {
      if (this.stopped) return
      this.waiting = true
      this.sentAt = performance.now()
      this.sequence += 1
      this.deadline(SCREEN_FRAME_TIMEOUT_MS)
      this.socket.write(encodeFrame({ type: 'screen-next', sessionId: this.opts.sessionId, seq: this.sequence }))
    }, Math.max(0, Math.ceil(1000 / this.targetFps - (performance.now() - this.sentAt))))
  }
}
