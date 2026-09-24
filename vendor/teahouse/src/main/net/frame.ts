import { LIMITS, isScreenSessionId, isScreenToken, isScreenSize, SCREEN_MAX_FRAME_BYTES, type TcpFrame } from '../../shared/protocol'
import { decodeTcpEnvelopeObject } from './codec'

// TCP 帧编解码（protocol §8）：4 字节大端长度前缀 + UTF-8 JSON 控制帧；
// pull-ok 之后切换 raw 模式直收 len 字节裸流（零拷贝直传，不做 base64）。

const MAX_FRAME = 64 * 1024
const ERR_REASON_MAX = 128
const SHA256_RE = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** TCP 控制帧逐类型白名单校验；所有网络输入先经此处再进入服务层。 */
export function decodeTcpFrameObject(raw: unknown): TcpFrame | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null

  switch (raw.type) {
    case 'screen-open':
      if (!hasOnlyKeys(raw, ['type', 'from', 'sessionId', 'token'])) return null
      if (!isBoundedString(raw.from, LIMITS.from) || !isScreenSessionId(raw.sessionId) || !isScreenToken(raw.token)) return null
      return raw as unknown as TcpFrame
    case 'screen-ready':
      if (!hasOnlyKeys(raw, ['type', 'sessionId']) || !isScreenSessionId(raw.sessionId)) return null
      return raw as unknown as TcpFrame
    case 'screen-next':
      if (!hasOnlyKeys(raw, ['type', 'sessionId', 'seq']) || !isScreenSessionId(raw.sessionId)) return null
      if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) <= 0) return null
      return raw as unknown as TcpFrame
    case 'screen-frame':
      if (!hasOnlyKeys(raw, ['type', 'sessionId', 'seq', 'width', 'height', 'len'])) return null
      if (!isScreenSessionId(raw.sessionId) || !Number.isSafeInteger(raw.seq) || (raw.seq as number) <= 0) return null
      if (!isScreenSize(raw.width, raw.height) || !Number.isSafeInteger(raw.len) || (raw.len as number) <= 0 || (raw.len as number) > SCREEN_MAX_FRAME_BYTES) return null
      return raw as unknown as TcpFrame
    case 'pull':
      if (!hasOnlyKeys(raw, ['type', 'from', 'transferId', 'fileId', 'offset'])) return null
      if (!isBoundedString(raw.from, LIMITS.from)) return null
      if (!isBoundedString(raw.transferId, LIMITS.id)) return null
      if (!isBoundedString(raw.fileId, LIMITS.id)) return null
      if (!isNonNegativeSafeInteger(raw.offset)) return null
      return raw as unknown as TcpFrame
    case 'pull-ok':
      if (!hasOnlyKeys(raw, ['type', 'fileId', 'len'])) return null
      if (!isBoundedString(raw.fileId, LIMITS.id)) return null
      if (!isNonNegativeSafeInteger(raw.len)) return null
      return raw as unknown as TcpFrame
    case 'done':
      if (!hasOnlyKeys(raw, ['type', 'fileId', 'sha256'])) return null
      if (!isBoundedString(raw.fileId, LIMITS.id)) return null
      if (typeof raw.sha256 !== 'string' || !SHA256_RE.test(raw.sha256)) return null
      return raw as unknown as TcpFrame
    case 'finish':
      if (!hasOnlyKeys(raw, ['type', 'transferId'])) return null
      if (!isBoundedString(raw.transferId, LIMITS.id)) return null
      return raw as unknown as TcpFrame
    case 'err':
      if (!hasOnlyKeys(raw, ['type', 'reason'])) return null
      if (!isBoundedString(raw.reason, ERR_REASON_MAX)) return null
      return raw as unknown as TcpFrame
    case 'wait':
      if (!hasOnlyKeys(raw, ['type'])) return null
      return raw as unknown as TcpFrame
    case 'msg': {
      if (!hasOnlyKeys(raw, ['type', 'envelope'])) return null
      const decoded = decodeTcpEnvelopeObject(raw.envelope)
      if (!decoded.ok || !decoded.known) return null
      return { type: 'msg', envelope: decoded.env }
    }
    case 'msg-ack':
      if (!hasOnlyKeys(raw, ['type', 'ackFor'])) return null
      if (!isBoundedString(raw.ackFor, LIMITS.id)) return null
      return raw as unknown as TcpFrame
    default:
      return null
  }
}

export function encodeFrame(frame: TcpFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

/**
 * 流式帧读取器：frame 模式解析控制帧；expectRaw(n) 后转 raw 模式，
 * 把接下来的 n 字节按到达顺序回调（之后自动切回 frame 模式）。
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)
  private rawLeft = 0
  private failed = false

  constructor(
    private readonly onFrame: (frame: TcpFrame) => void,
    private readonly onRaw: (chunk: Buffer) => void,
    private readonly onError: (reason: string) => void
  ) {}

  expectRaw(bytes: number): void {
    if (this.failed) return
    if (!isNonNegativeSafeInteger(bytes)) {
      this.fail('bad-raw-length')
      return
    }
    this.rawLeft = bytes
    this.drain()
  }

  feed(chunk: Buffer): void {
    if (this.failed) return
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    this.drain()
  }

  private fail(reason: string): void {
    if (this.failed) return
    this.failed = true
    this.buf = Buffer.alloc(0)
    this.rawLeft = 0
    this.onError(reason)
  }

  private drain(): void {
    for (;;) {
      if (this.rawLeft > 0) {
        if (this.buf.length === 0) return
        const take = Math.min(this.rawLeft, this.buf.length)
        const piece = this.buf.subarray(0, take)
        this.buf = this.buf.subarray(take)
        this.rawLeft -= take
        this.onRaw(piece)
        continue
      }
      if (this.buf.length < 4) return
      const len = this.buf.readUInt32BE(0)
      if (len === 0 || len > MAX_FRAME) {
        this.fail('bad-frame-length')
        return
      }
      if (this.buf.length < 4 + len) return
      const body = this.buf.subarray(4, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      let raw: unknown
      try {
        raw = JSON.parse(body.toString('utf8'))
      } catch {
        this.fail('bad-frame-json')
        return
      }
      const frame = decodeTcpFrameObject(raw)
      if (!frame) {
        this.fail('bad-frame-shape')
        return
      }
      this.onFrame(frame)
    }
  }
}
