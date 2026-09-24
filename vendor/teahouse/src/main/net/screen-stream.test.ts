import { afterEach, describe, expect, it } from 'vitest'
import { createConnection, type AddressInfo, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode, makeEnvelope } from './codec'
import { decodeTcpFrameObject, encodeFrame, FrameReader } from './frame'
import { createScreenSender, ScreenReceiver, ScreenRate, screenImageSize, type ScreenSender } from './screen-stream'
import { TransferServer, pullTransfer } from './transfer'
import { SCREEN_MAX_FRAME_BYTES, type ScreenFrame, type ScreenPayload, type TcpFrame } from '../../shared/protocol'

const id = randomUUID()
const token = 'ab'.repeat(16)
// 仅用于网络元数据校验；实际 JPEG 编解码由 Electron 自测覆盖。
const jpeg = Buffer.from([255,216,255,192,0,11,8,0,2,0,3,1,1,17,0,255,217])
const servers: TransferServer[] = []
const sockets: Socket[] = []
const receivers: ScreenReceiver[] = []
const senders: ScreenSender[] = []
const dirs: string[] = []
const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
afterEach(async () => {
  receivers.splice(0).forEach(receiver => receiver.stop())
  senders.splice(0).forEach(sender => sender.stop())
  sockets.splice(0).forEach(socket => socket.destroy())
  await Promise.all(servers.splice(0).map(server => server.stop()))
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})
async function listen(lookup: ConstructorParameters<typeof TransferServer>[1]): Promise<number> {
  const server = new TransferServer(0, lookup, '127.0.0.1')
  servers.push(server)
  await server.start()
  return ((server as unknown as { server: Server }).server.address() as AddressInfo).port
}
async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port })
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  return socket
}
function frame(seq = 1): ScreenFrame {
  return { type: 'screen-frame', sessionId: id, seq, width: 3, height: 2, len: jpeg.length }
}

describe('屏幕控制与帧边界', () => {
  it.each<ScreenPayload>([
    { op: 'request', sessionId: id }, { op: 'accept', sessionId: id, token },
    { op: 'reject', sessionId: id, reason: 'busy' }, { op: 'end', sessionId: id, reason: 'locked' }
  ])('接受声明的控制载荷并拒绝多余字段 %j', payload => {
    expect(decode(encode(makeEnvelope('screen', 'peer', payload))).ok).toBe(true)
    expect(decode(encode(makeEnvelope('screen', 'peer', { ...payload, control: true }))).ok).toBe(false)
  })
  it.each([
    { op: 'request', sessionId: 'bad' }, { op: 'accept', sessionId: id, token: 'bad' },
    { op: 'end', sessionId: id, reason: 'arbitrary' }, { op: 'mouse', sessionId: id }
  ])('拒绝未声明或损坏控制 %j', payload => {
    expect(decode(encode(makeEnvelope('screen', 'peer', payload))).ok).toBe(false)
  })
  it.each([
    { ...frame(), len: SCREEN_MAX_FRAME_BYTES + 1 }, { ...frame(), width: 100000 },
    { ...frame(), width: 1920, height: 1920 }, { ...frame(), seq: 0 },
    { ...frame(), len: -1 }, { ...frame(), sessionId: 'not-uuid' }, { ...frame(), extra: true },
    { type: 'screen-open', sessionId: id, from: 'peer', token: token.toUpperCase() },
    { type: 'screen-next', sessionId: id, seq: Number.MAX_SAFE_INTEGER + 1 }
  ])('在分配裸流前拒绝非法头 %j', value => expect(decodeTcpFrameObject(value)).toBeNull())
  it('JPEG 必须有界且格式和尺寸可校验', () => {
    expect(screenImageSize(jpeg)).toEqual({ width: 3, height: 2 })
    expect(screenImageSize(jpeg.subarray(0, jpeg.length - 1))).toBeNull()
    expect(screenImageSize(Buffer.alloc(SCREEN_MAX_FRAME_BYTES + 1))).toBeNull()
    expect(screenImageSize(Buffer.from('not jpeg'))).toBeNull()
  })
})

describe('真实 TCP 回环屏幕流', () => {
  it('消费前只采集一帧，文件拉取可共用监听端口', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pantry-screen-')); dirs.push(dir)
    const path = join(dir, 'source.txt'); writeFileSync(path, '共享期间文件正常传输')
    const size = Buffer.byteLength('共享期间文件正常传输')
    let samples = 0
    let displays = 0
    let release: (() => void) | undefined
    let ended = ''
    const port = await listen({ resolve: () => ({ absPath: path, size, fileId: 'f' }), openScreen: (socket, open) => {
      expect(open.sessionId).toBe(id)
      const sender = createScreenSender(socket, id, async () => { samples++; return jpeg }, reason => { ended = reason })
      senders.push(sender); return sender.handle
    } })
    const receiver = new ScreenReceiver({ host: '127.0.0.1', port, selfId: 'viewer', sessionId: id, token,
      display: async () => { displays++; if (displays === 1) await new Promise<void>(resolve => { release = resolve }) },
      onReady: () => undefined, onTarget: () => undefined, onEnd: reason => { ended = reason } })
    receivers.push(receiver)
    await expect.poll(() => displays).toBe(1)
    await pause(220)
    expect(samples).toBe(1)
    // 普通文件同时使用同一个 TransferServer，与屏幕连接互不占槽。
    await pullTransfer({ host: '127.0.0.1', port, selfId: 'viewer', transferId: 'file', saveDir: dir,
      files: [{ fileId: 'f', relPath: 'received.txt', size }], onProgress: () => undefined,
      cancelRef: { canceled: false, socket: null } })
    expect(readFileSync(join(dir, 'received.txt'), 'utf8')).toBe('共享期间文件正常传输')
    release!()
    await expect.poll(() => displays).toBeGreaterThanOrEqual(3)
    receiver.stop()
    await expect.poll(() => ended).toBe('disconnected')
    const stoppedSamples = samples; await pause(160); expect(samples).toBe(stoppedSamples)
  })

  it('首包粘连 open + next 不丢帧；重复 next 关闭连接', async () => {
    let samples = 0
    let reason = ''
    const port = await listen({ resolve: () => null, openScreen: socket => {
      const sender = createScreenSender(socket, id, () => { samples++; return new Promise(() => undefined) }, value => { reason = value })
      senders.push(sender); return sender.handle
    } })
    const socket = await connect(port)
    socket.write(Buffer.concat([encodeFrame({ type: 'screen-open', from: 'v', sessionId: id, token }),
      encodeFrame({ type: 'screen-next', sessionId: id, seq: 1 })]))
    await expect.poll(() => samples).toBe(1)
    socket.write(encodeFrame({ type: 'screen-next', sessionId: id, seq: 2 }))
    await expect.poll(() => reason).toBe('protocol-error')
  })

  it('已授权屏幕连接拒绝文件/消息帧，旧文件连接拒绝改为屏幕连接', async () => {
    let reason = ''; let opens = 0
    const port = await listen({ resolve: () => null, openScreen: socket => {
      opens++
      const sender = createScreenSender(socket, id, async () => jpeg, value => { reason = value }); senders.push(sender)
      return sender.handle
    } })
    const socket = await connect(port)
    socket.write(Buffer.concat([encodeFrame({ type: 'screen-open', from: 'v', sessionId: id, token }),
      encodeFrame({ type: 'pull', from: 'v', transferId: 't', fileId: 'f', offset: 0 })]))
    await expect.poll(() => reason).toBe('protocol-error')
    const second = await connect(port)
    second.resume()
    second.write(Buffer.concat([encodeFrame({ type: 'finish', transferId: 't' }), encodeFrame({ type: 'screen-open', from: 'v', sessionId: id, token })]))
    await expect.poll(() => second.destroyed).toBe(true)
    expect(opens).toBe(1)
  })

  it.each(['wrong-size', 'wrong-seq', 'truncated'] as const)('拒绝异常数据 %s', async kind => {
    let end = ''; let displays = 0
    const port = await listen({ resolve: () => null, openScreen: socket => {
      socket.write(encodeFrame({ type: 'screen-ready', sessionId: id }))
      return () => {
        const head = frame(kind === 'wrong-seq' ? 2 : 1)
        if (kind === 'wrong-size') head.width = 4
        socket.write(encodeFrame(head))
        if (kind === 'truncated') socket.end(jpeg.subarray(0, 5))
        else socket.write(jpeg)
      }
    } })
    receivers.push(new ScreenReceiver({ host: '127.0.0.1', port, selfId: 'v', sessionId: id, token,
      display: async () => { displays++ }, onReady: () => undefined, onTarget: () => undefined, onEnd: reason => { end = reason } }))
    await expect.poll(() => end).not.toBe('')
    expect(displays).toBe(0)
  })

  it('TCP 控制回退携带真实来源 IP', async () => {
    let ip = ''
    const port = await listen({ resolve: () => null, receiveMessage: (_env, address) => { ip = address; return true } })
    const socket = await connect(port)
    socket.write(encodeFrame({ type: 'msg', envelope: makeEnvelope('screen', 'v', { op: 'request', sessionId: id }) }))
    await expect.poll(() => ip).toBe('127.0.0.1')
  })

  it('消费卡住和逐字节慢发均受单帧 5 秒绝对期限约束', async () => {
    const reasons = ['', '']
    let delivered = 0
    for (const kind of [0, 1]) {
      const port = await listen({ resolve: () => null, openScreen: socket => {
        socket.write(encodeFrame({ type: 'screen-ready', sessionId: id }))
        return () => {
          socket.write(encodeFrame(frame()))
          if (kind === 0) socket.write(jpeg)
          else {
            let offset = 0
            const timer = setInterval(() => socket.write(jpeg.subarray(offset, ++offset)), 400)
            socket.once('close', () => clearInterval(timer))
          }
        }
      } })
      receivers.push(new ScreenReceiver({ host: '127.0.0.1', port, selfId: 'v', sessionId: id, token,
        display: () => { delivered++; return new Promise(() => undefined) }, onReady: () => undefined,
        onTarget: () => undefined, onEnd: reason => { reasons[kind] = reason } }))
    }
    await expect.poll(() => reasons, { timeout: 6500 }).toEqual(['timeout', 'timeout'])
    expect(delivered).toBe(1)
  }, 8000)

  it.each(['sample', 'display'] as const)('同步 %s 异常也会结束会话', async kind => {
    let ended = ''
    const port = await listen({ resolve: () => null, openScreen: socket => {
      const sender = createScreenSender(socket, id, () => {
        if (kind === 'sample') throw new Error('采集宿主已销毁')
        return Promise.resolve(jpeg)
      }, reason => { if (kind === 'sample') ended = reason })
      senders.push(sender); return sender.handle
    } })
    receivers.push(new ScreenReceiver({ host: '127.0.0.1', port, selfId: 'v', sessionId: id, token,
      display: () => { throw new Error('查看宿主已销毁') }, onReady: () => undefined, onTarget: () => undefined,
      onEnd: reason => { if (kind === 'display') ended = reason } }))
    await expect.poll(() => ended).toBe(kind === 'sample' ? 'capture-ended' : 'protocol-error')
  })

  it('FrameReader 可按逐字节碎片读出帧头及恰好 len 裸流', () => {
    const frames: TcpFrame[] = []; const chunks: Buffer[] = []
    const reader = new FrameReader(value => {
      frames.push(value)
      if (value.type === 'screen-frame') reader.expectRaw(value.len)
    }, chunk => chunks.push(chunk), reason => { throw new Error(reason) })
    const encoded = Buffer.concat([encodeFrame(frame()), jpeg, encodeFrame({ type: 'screen-next', sessionId: id, seq: 2 })])
    for (const byte of encoded) reader.feed(Buffer.from([byte]))
    expect(Buffer.concat(chunks)).toEqual(jpeg)
    expect(frames).toHaveLength(2)
  })
})

describe('自动档与手动档', () => {
  it('连续慢帧降一级，稳定和冷却均满足才升档', () => {
    const rate = new ScreenRate()
    for (let n = 0; n < 3; n++) rate.observe(90, n * 100)
    expect(rate.fps).toBe(5)
    rate.observe(30, 300)
    rate.observe(30, 9000)
    expect(rate.fps).toBe(5)
    rate.observe(30, 10400)
    expect(rate.fps).toBe(10)
    for (let n = 0; n < 6; n++) rate.observe(300, 11000 + n * 100)
    expect(rate.fps).toBe(3)
  })
  it('抖动不会持续升档；手动档不随耗时变化', () => {
    const rate = new ScreenRate()
    for (let n = 0; n < 3; n++) rate.observe(90, n * 100)
    rate.observe(20, 500); rate.observe(90, 10500); rate.observe(20, 12000)
    expect(rate.fps).toBe(5)
    rate.setMode('smooth')
    for (let n = 0; n < 50; n++) rate.observe(900, n * 1000)
    expect(rate.fps).toBe(10)
    rate.setMode('economy'); expect(rate.fps).toBe(3)
    rate.setMode('standard'); expect(rate.fps).toBe(5)
    rate.setMode('auto'); expect(rate.fps).toBe(10)
  })
})
