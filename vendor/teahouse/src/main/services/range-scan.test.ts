import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TIMINGS } from '../../shared/protocol'
import { Discovery } from '../net/discovery'
import { PeerRegistry } from '../net/peer-registry'
import type { UdpChannel } from '../net/udp'
import { loadAppState } from '../store/app-state'
import { RangeScanScheduler } from './range-scan'

const cleanup: Array<() => void> = []
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); vi.useRealTimers() })
function setup(lastAutoScanAt?: number) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-18T00:00:00Z'))
  const dir = mkdtempSync(join(tmpdir(), 'teahouse-range-test-'))
  const state = loadAppState(dir, '0.60.2')
  const cidr = '127.0.0.0/30'
  state.config.scanRanges = [cidr]
  state.config.scanRangeSources[cidr] = { source: 'remote', addedAt: Date.now(), lastAutoScanAt }
  const udp = Object.assign(new EventEmitter(), { send: vi.fn(), broadcast: vi.fn() })
  const discovery = new Discovery({ udp: udp as unknown as UdpChannel, registry: new PeerRegistry(state.nodeId), profile: state.profile })
  const onUpdated = vi.fn(), onlineCount = vi.fn(() => 0)
  const scheduler = new RangeScanScheduler({ discovery, getState: () => state, onlineCount, udpPort: 1, onUpdated,
    timings: { scanRangeAutoScanInitialMin: 10, scanRangeAutoScanInitialMax: 10 } })
  cleanup.push(() => { scheduler.stop(); discovery.stop(); rmSync(dir, { recursive: true, force: true }) })
  return { state, cidr, udp, scheduler, discovery, onUpdated, onlineCount }
}

it('12 小时内重启保留下一次排期，完成才记时间并继续周期调度', () => {
  const now = new Date('2026-09-18T00:00:00Z').getTime()
  const s = setup(now - 3600000)
  s.scheduler.start()
  vi.advanceTimersByTime(11 * 3600000 + 11)
  expect(s.udp.send).toHaveBeenCalledTimes(1)
  expect(s.state.config.scanRangeSources[s.cidr].lastAutoScanAt).toBe(now - 3600000)
  vi.advanceTimersByTime(62)
  expect(s.onUpdated).toHaveBeenCalledTimes(1)
  const completed = Date.now()
  expect(s.state.config.scanRangeSources[s.cidr].lastAutoScanAt).toBe(completed)
  vi.advanceTimersByTime(TIMINGS.scanRangeAutoScanMinInterval + 11 + 62)
  expect(s.onUpdated).toHaveBeenCalledTimes(2)
})

it('重复配置同步不重排；删除进行中的后台扫描不记完成', () => {
  const s = setup()
  s.scheduler.start(); s.scheduler.sync(); s.scheduler.sync()
  vi.advanceTimersByTime(11)
  expect(s.udp.send).toHaveBeenCalledTimes(1)
  s.state.config.scanRanges = []
  s.scheduler.sync()
  vi.advanceTimersByTime(100000)
  expect(s.udp.send).toHaveBeenCalledTimes(1)
  expect(s.onUpdated).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('执行时复核抽样资格，取消后仍可在后续周期补排', () => {
  const s = setup()
  // 显式选择不参与大网扫描的 nodeId。
  s.state.nodeId = 'alice'
  s.scheduler.start()
  s.onlineCount.mockReturnValue(1000)
  vi.advanceTimersByTime(11)
  expect(s.udp.send).not.toHaveBeenCalled()
  s.onlineCount.mockReturnValue(0)
  vi.advanceTimersByTime(80)
  expect(s.onUpdated).toHaveBeenCalledTimes(1)
})

it('手动抢占不取消后台；退出取消余下任务且不重新排期', () => {
  const s = setup()
  s.scheduler.start()
  vi.advanceTimersByTime(11)
  s.discovery.scanHosts(['127.0.0.8', '127.0.0.9'], 1)
  vi.advanceTimersByTime(78)
  expect(s.udp.send.mock.calls.map(call => call[1])).toEqual(['127.0.0.1', '127.0.0.8', '127.0.0.9', '127.0.0.2'])
  expect(s.onUpdated).toHaveBeenCalledTimes(1)
  s.scheduler.stop()
  expect(vi.getTimerCount()).toBe(0)
})
