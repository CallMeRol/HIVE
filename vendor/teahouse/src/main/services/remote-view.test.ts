import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket, type Server, type AddressInfo } from 'node:net'
import { RemoteViewService, type RemoteViewDeps, type ScreenPeer } from './remote-view'
import { ScreenReceiver } from '../net/screen-stream'
import { TransferServer } from '../net/transfer'
import { encodeFrame } from '../net/frame'
import type { ScreenState } from '../../shared/remote-view'
import { CAPS, SCREEN_REQUEST_TIMEOUT_MS, type ScreenPayload } from '../../shared/protocol'

const services: RemoteViewService[] = []
const servers: TransferServer[] = []
const sockets: Socket[] = []
afterEach(async () => {
  services.splice(0).forEach(service => service.stopAll('app-exit'))
  sockets.splice(0).forEach(socket => socket.destroy())
  await Promise.all(servers.splice(0).map(server => server.stop()))
  vi.useRealTimers()
})
function setup(overrides: Partial<RemoteViewDeps> = {}, now?: () => number) {
  const sent: ScreenPayload[] = []
  const peer: ScreenPeer = { ip: '127.0.0.1', tcpPort: 17879, online: true, name: '同事', caps: [CAPS.remoteView, CAPS.remoteShare] }
  const available = { view: true, share: true, reason: '' }
  const deps: RemoteViewDeps = {
    selfId: 'self', peer: id => id === 'peer' ? peer : null, available: () => available,
    send: async (_peer, payload) => { sent.push(payload); return true },
    sample: async () => new Uint8Array(), display: async () => undefined, ...overrides
  }
  const service = new RemoteViewService(deps, now); services.push(service)
  return { service, sent, peer, available }
}
function invite(service: RemoteViewService, id = randomUUID()) {
  service.receive('peer', '127.0.0.1', { op: 'request', sessionId: id })
  return id
}

describe('屏幕会话授权与终止', () => {
  it('收到请求不采集；未同意不能 ready/open；拒绝后迟到 ready 不复活', () => {
    const { service, sent } = setup()
    const id = invite(service)
    expect(service.getState()?.phase).toBe('awaiting-consent')
    expect(service.captureReady(id)).toBe(false)
    expect(sent).toHaveLength(0)
    expect(service.open({ remoteAddress: '127.0.0.1' } as Socket, { type: 'screen-open', from: 'peer', sessionId: id, token: 'a'.repeat(32) })).toBeNull()
    expect(service.respond(id, false)).toBe(true)
    expect(service.getState()?.reason).toBe('declined')
    expect(sent).toEqual([{ op: 'reject', sessionId: id, reason: 'declined' }])
    expect(service.captureReady(id)).toBe(false)
    service.receive('peer', '127.0.0.1', { op: 'request', sessionId: id })
    expect(service.getState()?.phase).toBe('ended')
  })
  it('end 先到、request 后到和迟到 accept 均不复活', () => {
    const { service, sent } = setup()
    const id = randomUUID()
    service.receive('peer', '127.0.0.1', { op: 'end', sessionId: id, reason: 'canceled' })
    service.receive('peer', '127.0.0.1', { op: 'request', sessionId: id })
    expect(service.getState()).toBeNull()
    service.receive('peer', '127.0.0.1', { op: 'accept', sessionId: id, token: 'ab'.repeat(16) })
    expect(service.getState()).toBeNull()
    expect(sent.at(-1)).toEqual({ op: 'end', sessionId: id, reason: 'canceled' })
  })
  it('忽略未知节点/错误 IP/错误会话的控制包', () => {
    const { service } = setup()
    service.receive('other', '127.0.0.1', { op: 'request', sessionId: randomUUID() })
    service.receive('peer', '127.0.0.2', { op: 'request', sessionId: randomUUID() })
    expect(service.getState()).toBeNull()
    const id = invite(service)
    service.receive('peer', '127.0.0.2', { op: 'end', sessionId: id, reason: 'user' })
    service.receive('other', '127.0.0.1', { op: 'end', sessionId: id, reason: 'user' })
    expect(service.getState()?.phase).toBe('awaiting-consent')
  })
  it('一节点只允许一场；交叉邀请按忙碌拒绝；连续请求限流', () => {
    const { service, sent } = setup()
    expect(service.request('peer')).toEqual({ ok: true })
    const own = service.getState()!.sessionId
    const incoming = invite(service)
    expect(sent).toContainEqual({ op: 'reject', sessionId: incoming, reason: 'busy' })
    expect(service.getState()?.sessionId).toBe(own)
    service.stop(own)
    expect(service.request('peer')).toEqual({ ok: false, reason: 'rate-limited' })
  })
  it('能力、离线和锁屏前置条件每次同意都重新检查', () => {
    const { service, peer, available, sent } = setup()
    peer.online = false
    expect(service.request('peer').reason).toBe('offline')
    peer.online = true; peer.caps = [CAPS.remoteView]
    expect(service.request('peer').reason).toBe('unsupported')
    const id = invite(service)
    available.share = false
    expect(service.respond(id, true)).toBe(false)
    expect(sent).toContainEqual({ op: 'reject', sessionId: id, reason: 'unsupported' })
  })
  it('同意、采集准备、连接阶段依次计时，旧邀请计时器被取消', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { service, sent } = setup()
    const id = invite(service)
    await vi.advanceTimersByTimeAsync(SCREEN_REQUEST_TIMEOUT_MS - 1000)
    expect(service.respond(id, true)).toBe(true)
    expect(service.captureReady(id)).toBe(true)
    expect(sent.at(-1)?.op).toBe('accept')
    await vi.advanceTimersByTimeAsync(2000)
    expect(service.getState()?.phase).toBe('connecting')
    await vi.advanceTimersByTimeAsync(13001)
    expect(service.getState()?.reason).toBe('timeout')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('准备仍受原请求期限限制；取消立即中止可靠发送', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let signal: AbortSignal | undefined
    const outgoing = setup({ send: async (_peer, payload, _best, abort) => { if (payload.op === 'request') signal = abort; return true } })
    outgoing.service.request('peer')
    outgoing.service.stopAll('canceled')
    expect(signal?.aborted).toBe(true)
    const { service } = setup()
    const id = invite(service)
    await vi.advanceTimersByTimeAsync(59_000)
    service.respond(id, true)
    await vi.advanceTimersByTimeAsync(1001)
    expect(service.getState()?.phase).toBe('ended')
    expect(service.captureReady(id)).toBe(false)
  })
  it('地址变化、离线与退出终止；连续 30 次循环没有会话计时器残留', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let now = 0
    const { service, peer } = setup({}, () => now)
    for (let n = 0; n < 30; n++) {
      const id = invite(service)
      expect(service.respond(id, true)).toBe(true)
      service.captureReady(id)
      peer.online = false
      service.checkPeer()
      expect(service.getState()?.reason).toBe('disconnected')
      expect(vi.getTimerCount()).toBe(0)
      peer.online = true
      now += 20_001
      await vi.advanceTimersByTimeAsync(20_001)
    }
    invite(service)
    peer.ip = '127.0.0.2'; service.checkPeer()
    expect(service.getState()?.phase).toBe('ended')
  })
  it('握手绑定真实 IP、nodeId、会话和一次性 token；时长排除等待且不随系统时钟漂移', async () => {
    let now = 0
    const { service, sent } = setup({}, () => now)
    const id = invite(service)
    service.respond(id, true); service.captureReady(id)
    const accepted = sent.find(value => value.op === 'accept')!
    if (accepted.op !== 'accept') throw new Error('缺少授权')
    const open = { type: 'screen-open' as const, sessionId: id, from: 'peer', token: accepted.token }
    expect(service.open({ remoteAddress: '127.0.0.2' } as Socket, open)).toBeNull()
    expect(service.open({ remoteAddress: '127.0.0.1' } as Socket, { ...open, from: 'other' })).toBeNull()
    expect(service.open({ remoteAddress: '127.0.0.1' } as Socket, { ...open, token: 'c'.repeat(32) })).toBeNull()
    const server = new TransferServer(0, { resolve: () => null, openScreen: (socket, frame) => service.open(socket, frame) }, '127.0.0.1')
    servers.push(server); await server.start()
    const port = ((server as unknown as { server: Server }).server.address() as AddressInfo).port
    const socket = createConnection({ host: '127.0.0.1', port }); sockets.push(socket)
    await new Promise<void>(resolve => socket.once('connect', resolve))
    now = 30000
    socket.write(encodeFrame(open))
    await expect.poll(() => service.getState()?.phase).toBe('active')
    expect(service.open({ remoteAddress: '127.0.0.1' } as Socket, open)).toBeNull()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    now = 34250
    service.stop(id)
    clock.mockRestore()
    expect(service.getState()?.durationMs).toBe(4250)
    expect(service.getState()?.endedAt).toBe(1000)
    expect(service.getState()?.phase).toBe('ended')
    expect(service.open({ remoteAddress: '127.0.0.1' } as Socket, open)).toBeNull()
  })
})

it('邀请等待期间最小化在收到同意后仍保持低帧率', async () => {
  const { service, peer } = setup()
  const server = new TransferServer(0, { resolve: () => null }, '127.0.0.1')
  servers.push(server); await server.start()
  peer.tcpPort = ((server as unknown as { server: Server }).server.address() as AddressInfo).port
  const minimized = vi.spyOn(ScreenReceiver.prototype, 'setMinimized')
  try {
    service.request('peer')
    service.setMinimized(true)
    service.receive('peer', '127.0.0.1', { op: 'accept', sessionId: service.getState()!.sessionId, token: 'a'.repeat(32) })
    expect(minimized).toHaveBeenLastCalledWith(true)
    expect(service.getState()?.targetFps).toBe(3)
    service.setMinimized(false)
    expect(service.getState()?.targetFps).toBe(10)
  } finally { minimized.mockRestore() }
})


it('历史事件只跟生命周期变化；拒绝与忙碌保留，定位旧窗口不会绕过发送确认', () => {
  const { service, sent } = setup()
  const records: Array<{ state: ScreenState; initial: boolean }> = []
  const order: string[] = []
  service.on('state', () => order.push('state'))
  service.on('history', (state, initial) => { order.push('history'); records.push({ state, initial }) })
  expect(service.request('peer', true).ok).toBe(false)
  expect(sent).toEqual([])
  service.request('peer')
  expect(records).toHaveLength(1)
  expect(records[0].initial).toBe(true)
  service.setMode(service.getState()!.sessionId, 'economy')
  expect(records).toHaveLength(1)
  invite(service)
  expect(records[1]).toMatchObject({ initial: true, state: { role: 'sharer', phase: 'ended', reason: 'busy' } })
  service.receive('peer', '127.0.0.1', { op: 'reject', sessionId: service.getState()!.sessionId, reason: 'declined' })
  expect(records[2]).toMatchObject({ initial: false, state: { role: 'viewer', phase: 'ended', reason: 'declined' } })
  expect(records[2].state.startedAt).toBeUndefined()
  expect(records[2].state.durationMs).toBeUndefined()
  expect(order.slice(-2)).toEqual(['state', 'history'])
  expect(service.request('peer', true).ok).toBe(false)
})
