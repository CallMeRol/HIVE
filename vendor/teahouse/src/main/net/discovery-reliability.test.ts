import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DISCOVERY_PROBE_CAP, MSG_TYPES, TIMINGS, type Envelope, type Profile } from '../../shared/protocol'
import { Discovery } from './discovery'
import { PeerRegistry } from './peer-registry'
import { UdpChannel } from './udp'
import { encode, makeEnvelope } from './codec'

const source = { address: '127.0.0.1', port: 17878, family: 'IPv4', size: 0 }
function profile(nodeId: string, caps = [DISCOVERY_PROBE_CAP]): Profile {
  return { nodeId, nick: '测试', company: '', dept: '', team: '', avatar: -1, profileRev: 1,
    host: '测试', platform: 'linux', tcpPort: 17879, ver: '0.60.2', caps }
}
const discoveries: Discovery[] = []
function stack() {
  const udp = Object.assign(new EventEmitter(), { send: vi.fn(), broadcast: vi.fn() })
  const registry = new PeerRegistry('alice')
  const discovery = new Discovery({ udp: udp as unknown as UdpChannel, registry, profile: profile('alice') })
  discoveries.push(discovery)
  return { udp, registry, discovery }
}
afterEach(() => {
  for (const discovery of discoveries.splice(0)) discovery.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('发现与扫描可靠性', () => {
  it('重复陌生心跳只发一次握手，超时后可重试', () => {
    vi.useFakeTimers()
    const { udp, registry } = stack()
    const heartbeat = makeEnvelope(MSG_TYPES.presence, 'bob', { seq: 1, profileRev: 1 })
    for (let i = 0; i < 5; i++) udp.emit('envelope', heartbeat, true, source)
    expect(registry.get('bob')).toBeUndefined()
    expect(udp.send).toHaveBeenCalledTimes(1)
    expect(udp.send.mock.calls[0][0].payload.probeId).toBeTruthy()
    vi.advanceTimersByTime(TIMINGS.legacyProbeTimeout + 1)
    udp.emit('envelope', heartbeat, true, source)
    expect(udp.send).toHaveBeenCalledTimes(3) // 初发、一次重试、下一次心跳重新握手
  })

  it('手动扫描插队后后台续扫，进度完整且共同遵守间隔', () => {
    vi.useFakeTimers()
    const { udp, discovery } = stack(), done = vi.fn(), progress = vi.fn()
    discovery.scanHosts(['127.0.0.2', '127.0.0.3', '127.0.0.4'], 1, 62, { background: true, onComplete: done, onProgress: progress })
    vi.advanceTimersByTime(1)
    discovery.scanHosts(['127.0.0.5', '127.0.0.6'], 1)
    vi.advanceTimersByTime(60)
    expect(udp.send).toHaveBeenCalledTimes(1)
    expect(done).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(udp.send.mock.calls.map(call => call[1])).toEqual(['127.0.0.2', '127.0.0.5', '127.0.0.6', '127.0.0.3', '127.0.0.4'])
    expect(done).toHaveBeenCalledTimes(1)
    expect(progress.mock.calls.flat()).toEqual([1, 2, 3])
  })

  it('相同扫描键合并，取消与 stop 不会误报完成', () => {
    vi.useFakeTimers()
    const { discovery, udp } = stack(), done = vi.fn(), canceled = vi.fn()
    for (let i = 0; i < 3; i++) discovery.scanHosts(['127.0.0.1', '127.0.0.2'], 1, 62, { key: 'range', onComplete: done, onCancel: canceled })
    discovery.cancelScan('range')
    expect(canceled).toHaveBeenCalledTimes(1)
    discovery.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(done).not.toHaveBeenCalled()
    udp.send.mockClear()
    udp.emit('envelope', makeEnvelope(MSG_TYPES.presence, 'late', { seq: 1, profileRev: 1 }), true, source)
    expect(udp.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('拒绝相同版本的延迟旧资料，关联应答可确认时钟回拨后的当前资料', () => {
    vi.useFakeTimers()
    const { udp, registry } = stack()
    const send = (company: string, ts: number, probeId?: string) => udp.emit('envelope', {
      ...makeEnvelope(probeId ? MSG_TYPES.alive : MSG_TYPES.profile, 'bob', { profile: { ...profile('bob'), company }, probeId }), ts
    }, true, source)
    send('旧公司', 100)
    send('新公司', 200)
    send('旧公司', 100)
    expect(registry.get('bob')!.profile.company).toBe('新公司')
    const request = udp.send.mock.calls.find(call => call[0].payload.probeId)![0]
    send('时钟回拨后修改', 50, '错误标识')
    expect(registry.get('bob')!.profile.company).toBe('新公司')
    send('时钟回拨后修改', 50, request.payload.probeId)
    expect(registry.get('bob')!.profile.company).toBe('时钟回拨后修改')
    send('回拨前迟到报文', 300)
    expect(registry.get('bob')!.profile.company).toBe('时钟回拨后修改')
  })

  it.each([true, false])('探活超时覆盖支持端/旧端：快速=%s', fast => {
    vi.useFakeTimers()
    const { discovery, registry } = stack()
    registry.touch('bob', source.address, source.port, profile('bob', fast ? [DISCOVERY_PROBE_CAP] : []))
    discovery.probeNode('bob')
    vi.advanceTimersByTime(TIMINGS.probeTimeout - 1)
    expect(registry.get('bob')!.online).toBe(true)
    vi.advanceTimersByTime(1)
    expect(registry.get('bob')!.online).toBe(!fast)
    if (!fast) {
      vi.advanceTimersByTime(TIMINGS.legacyProbeTimeout - TIMINGS.probeTimeout)
      expect(registry.get('bob')!.online).toBe(false)
    }
  })

  it('探活期间有有效心跳则保留在线；错误来源不确认请求', () => {
    vi.useFakeTimers()
    const { udp, discovery, registry } = stack()
    registry.touch('bob', source.address, source.port, profile('bob'))
    discovery.probeNode('bob')
    const request = udp.send.mock.calls[0][0]
    const alive = makeEnvelope(MSG_TYPES.alive, 'bob', { profile: profile('bob'), probeId: request.payload.probeId })
    udp.emit('envelope', alive, true, { ...source, port: 2 })
    vi.advanceTimersByTime(1000)
    udp.emit('envelope', makeEnvelope(MSG_TYPES.presence, 'bob', { seq: 1, profileRev: 1 }), true, source)
    vi.advanceTimersByTime(1000)
    expect(registry.get('bob')!.online).toBe(true)
  })

  it('千节点 gossip 分包无接收限速丢弃，重复目标合并', () => {
    vi.useFakeTimers()
    const { udp, registry, discovery } = stack()
    // 静态回灌后直接在线，避免将测试数据装载当成 1000 次新结识。
    const records = Array.from({ length: 999 }, () => ({ profile: profile(randomUUID()), ip: '127.0.0.1', udpPort: 17878, online: true, lastSeen: Date.now() }))
    registry.seed(records)
    for (const record of registry.values()) record.online = true
    const receiver = new UdpChannel({ port: 0, bindAddress: '127.0.0.1', broadcastTargets: [] })
    const received = vi.fn(), drop = vi.fn()
    receiver.on('envelope', received); receiver.on('drop', drop)
    udp.send.mockImplementation((env: Envelope) => Reflect.get(receiver, 'onMessage').call(receiver, encode(env), source))
    for (let i = 0; i < 3; i++) Reflect.get(discovery, 'sendPeersTo').call(discovery, records[0].profile.nodeId)
    vi.runAllTimers()
    expect(received).toHaveBeenCalledTimes(125)
    expect(drop).not.toHaveBeenCalled()
  })
})
