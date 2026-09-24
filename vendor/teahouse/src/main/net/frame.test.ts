import { describe, expect, it } from 'vitest'
import {
  AVATAR_MAX_BYTES,
  MSG_TYPES,
  type AvatarPayload,
  type TcpFrame
} from '../../shared/protocol'
import { makeEnvelope } from './codec'
import { FrameReader, encodeFrame } from './frame'

const SHA256 = 'a'.repeat(64)

function encodeUnknownFrame(frame: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

describe('FrameReader', () => {
  it('黏包/半包：多帧一次喂入与逐字节喂入结果一致', () => {
    const frames: TcpFrame[] = [
      { type: 'pull', from: 'n1', transferId: 't1', fileId: 'f1', offset: 0 },
      { type: 'pull-ok', fileId: 'f1', len: 5 },
      { type: 'done', fileId: 'f1', sha256: SHA256 }
    ]
    const wire = Buffer.concat(frames.map(encodeFrame))

    const collect = (chunks: Buffer[]): string[] => {
      const got: string[] = []
      const reader = new FrameReader(
        (f) => got.push(f.type),
        () => undefined,
        (r) => got.push(`err:${r}`)
      )
      for (const c of chunks) reader.feed(c)
      return got
    }

    expect(collect([wire])).toEqual(['pull', 'pull-ok', 'done'])
    const byteByByte = Array.from(wire).map((b) => Buffer.from([b]))
    expect(collect(byteByByte)).toEqual(['pull', 'pull-ok', 'done'])
  })

  it('raw 模式：帧后裸流按量切出，随后自动回到帧模式', () => {
    const raw = Buffer.from('hello-raw-bytes')
    const rawChunks: Buffer[] = []
    const types: string[] = []
    const reader = new FrameReader(
      (f) => {
        types.push(f.type)
        if (f.type === 'pull-ok') reader.expectRaw((f as { len: number }).len)
      },
      (chunk) => rawChunks.push(Buffer.from(chunk)),
      () => types.push('err')
    )
    reader.feed(
      Buffer.concat([
        encodeFrame({ type: 'pull-ok', fileId: 'f', len: raw.length }),
        raw,
        encodeFrame({ type: 'done', fileId: 'f', sha256: SHA256 })
      ])
    )
    expect(types).toEqual(['pull-ok', 'done'])
    expect(Buffer.concat(rawChunks).toString()).toBe('hello-raw-bytes')
  })

  it('超长帧拒收', () => {
    const errors: string[] = []
    const reader = new FrameReader(
      () => undefined,
      () => undefined,
      (r) => errors.push(r)
    )
    const head = Buffer.alloc(4)
    head.writeUInt32BE(10 * 1024 * 1024)
    reader.feed(head)
    expect(errors).toEqual(['bad-frame-length'])
  })

  it('32 KiB 头像响应可完整落在单个 TCP 控制帧内', () => {
    const envelope = makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, 'node-avatar', {
      op: 'data',
      hash: 'b'.repeat(64),
      bytesBase64: Buffer.alloc(AVATAR_MAX_BYTES).toString('base64')
    })
    const wire = encodeFrame({ type: 'msg', envelope })
    expect(wire.readUInt32BE(0)).toBeLessThanOrEqual(64 * 1024)
    const frames: TcpFrame[] = []
    const reader = new FrameReader(
      (frame) => frames.push(frame),
      () => undefined,
      () => undefined
    )
    reader.feed(wire)
    expect(frames).toHaveLength(1)
  })

  it.each([
    { frame: { type: 'finish', transferId: {} }, label: 'finish transferId 类型错误' },
    {
      frame: { type: 'pull', from: 'n1', transferId: 't1', fileId: 'f1', offset: -1 },
      label: 'pull 负偏移'
    },
    { frame: { type: 'pull-ok', fileId: 'f1', len: 1.5 }, label: 'pull-ok 非整数长度' },
    { frame: { type: 'done', fileId: 'f1', sha256: 'ABC' }, label: 'done 非标准哈希' },
    { frame: { type: 'err', reason: 'x'.repeat(129) }, label: 'err 原因过长' },
    { frame: { type: 'msg-ack', ackFor: 'a', extra: true }, label: '未知字段' },
    { frame: { type: 'wait', extra: 1 }, label: 'wait 带未知字段' },
    {
      frame: {
        type: 'msg',
        envelope: { v: 1, type: 'msg', id: 'm1', from: 'n1', ts: 1, payload: { kind: 'text' } }
      },
      label: 'msg 内层信封非法'
    },
    { frame: { type: 'future-frame', value: 1 }, label: '未知帧型' }
  ])('严格拒收 $label', ({ frame }) => {
    const frames: TcpFrame[] = []
    const errors: string[] = []
    const reader = new FrameReader(
      (item) => frames.push(item),
      () => undefined,
      (reason) => errors.push(reason)
    )

    reader.feed(encodeUnknownFrame(frame))

    expect(frames).toEqual([])
    expect(errors).toEqual(['bad-frame-shape'])
  })

  it('wait 帧（决议 #211）：无字段合法帧正常解析', () => {
    const frames: TcpFrame[] = []
    const reader = new FrameReader(
      (item) => frames.push(item),
      () => undefined,
      () => undefined
    )
    reader.feed(encodeUnknownFrame({ type: 'wait' }))
    expect(frames).toEqual([{ type: 'wait' }])
  })

  it('首次解析失败后清空状态，后续数据不再回调', () => {
    const frames: TcpFrame[] = []
    const errors: string[] = []
    const reader = new FrameReader(
      (frame) => frames.push(frame),
      () => undefined,
      (reason) => errors.push(reason)
    )

    reader.feed(encodeUnknownFrame({ type: 'finish', transferId: {} }))
    reader.feed(encodeFrame({ type: 'finish', transferId: 't1' }))
    reader.feed(Buffer.from([0, 0, 0, 0]))

    expect(frames).toEqual([])
    expect(errors).toEqual(['bad-frame-shape'])
  })
})
