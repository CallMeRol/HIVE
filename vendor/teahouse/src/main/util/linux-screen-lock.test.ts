import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { LinuxScreenLock, parseLockReply } from './linux-screen-lock'

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }))
let reply = '(<false>,)'
let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> }
const monitors: LinuxScreenLock[] = []
beforeEach(() => {
  vi.useFakeTimers()
  reply = '(<false>,)'
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1] as (error: Error | null, stdout: string) => void
    callback(null, reply)
    return {} as ReturnType<typeof execFile>
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
})
afterEach(() => { monitors.splice(0).forEach(monitor => monitor.close()); vi.useRealTimers(); vi.clearAllMocks() })

it.each([['(<true>,)', true], ['(false,)', false], ['unknown', null], ['(false, true)', null], ['', null]])('锁状态只接受明确布尔值 %s', (text, value) => {
  expect(parseLockReply(text as string)).toBe(value)
})
async function start(): Promise<{ monitor: LinuxScreenLock; states: Array<boolean | null> }> {
  const states: Array<boolean | null> = []
  const monitor = new LinuxScreenLock(value => states.push(value)); monitors.push(monitor)
  const promise = monitor.start()
  await Promise.resolve()
  child.stdout.emit('data', Buffer.from("Monitoring signals\nThe name com.deepin.SessionManager is owned by :1.10\n"))
  await promise
  return { monitor, states }
}
it('监控就绪和初始读取后才能用；锁信号立即生效，失败保守结束', async () => {
  const { monitor, states } = await start()
  expect(monitor.locked).toBe(false)
  reply = '(<true>,)'
  child.stdout.emit('data', Buffer.from("/com/deepin/SessionManager: org.freedesktop.DBus.Properties.PropertiesChanged ('com.deepin.SessionManager', {'Locked': <true>}, [])\n"))
  expect(states).toContain(true)
  await monitor.refresh()
  reply = 'unexpected output'
  await monitor.refresh()
  expect(monitor.locked).toBeNull()
  expect(states.at(-1)).toBeNull()
})
it('服务失去所有者、监控退出后不再接受旧回调', async () => {
  const { monitor } = await start()
  child.stdout.emit('data', Buffer.from('The name com.deepin.SessionManager has no owner\n'))
  expect(monitor.locked).toBeNull()
  child.stdout.emit('data', Buffer.from('The name com.deepin.SessionManager is owned by :1.20\n'))
  await monitor.refresh()
  expect(monitor.locked).toBeNull()
  expect(child.kill).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(1) // 只保留低频恢复探测
})
it('迟到的未锁定查询不能覆盖刚到达的锁屏信号', async () => {
  const { monitor } = await start()
  let finish: (error: Error | null, reply: string) => void = () => undefined
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    finish = args[args.length - 1] as typeof finish
    return {} as ReturnType<typeof execFile>
  })
  const reading = monitor.refresh()
  child.stdout.emit('data', Buffer.from("/com/deepin/SessionManager: org.freedesktop.DBus.Properties.PropertiesChanged ('com.deepin.SessionManager', {'Locked': <true>}, [])\n"))
  finish(null, '(<false>,)')
  await reading
  expect(monitor.locked).toBe(true)
})
it('监控连接不上不会启用能力，关闭后清理轮询', async () => {
  const monitor = new LinuxScreenLock(() => undefined); monitors.push(monitor)
  const promise = monitor.start()
  await vi.advanceTimersByTimeAsync(4600)
  await promise
  expect(monitor.locked).toBeNull()
  monitor.close()
  expect(vi.getTimerCount()).toBe(0)
})
it('DDE 不可用时使用 UKUI 声明的根对象路径及锁屏接口', async () => {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const command = args[1] as string[]
    const callback = args[args.length - 1] as (error: Error | null, stdout: string) => void
    callback(command.includes('com.deepin.SessionManager') ? new Error('服务不存在') : null, reply)
    return {} as ReturnType<typeof execFile>
  })
  const monitor = new LinuxScreenLock(() => undefined); monitors.push(monitor)
  const starting = monitor.start()
  await vi.advanceTimersByTimeAsync(0)
  child.stdout.emit('data', Buffer.from('The name org.ukui.ScreenSaver is owned by :1.12\n'))
  await starting
  expect(monitor.locked).toBe(false)
  expect(execFile).toHaveBeenCalledWith('gdbus', ['call', '--session', '--dest', 'org.ukui.ScreenSaver',
    '--object-path', '/', '--method', 'org.ukui.ScreenSaver.GetLockState'], expect.anything(), expect.any(Function))
  reply = '(true,)'
  child.stdout.emit('data', Buffer.from('/: org.ukui.ScreenSaver.lock ()\n'))
  expect(monitor.locked).toBe(true)
})

it('闲置每分钟复核，协助期间每五秒；无关属性不会重复启动查询', async () => {
  const { monitor } = await start()
  vi.mocked(execFile).mockClear()
  child.stdout.emit('data', Buffer.from("/com/deepin/SessionManager: org.freedesktop.DBus.Properties.PropertiesChanged ('com.deepin.SessionManager', {'Stage': <2>}, [])\n"))
  await vi.advanceTimersByTimeAsync(59_999)
  expect(execFile).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(execFile).toHaveBeenCalledTimes(1)
  monitor.setActive(true)
  await vi.advanceTimersByTimeAsync(5000)
  expect(execFile).toHaveBeenCalledTimes(2)
  monitor.setActive(false)
  await vi.advanceTimersByTimeAsync(5000)
  expect(execFile).toHaveBeenCalledTimes(2)
})
it('监控中断后低频重连，旧进程信号不能恢复能力', async () => {
  const { monitor, states } = await start()
  const oldChild = child
  oldChild.emit('exit', 1)
  expect(monitor.locked).toBeNull()
  child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  await vi.advanceTimersByTimeAsync(60_000)
  oldChild.stdout.emit('data', Buffer.from('The name com.deepin.SessionManager is owned by :1.10\n'))
  expect(monitor.locked).toBeNull()
  child.stdout.emit('data', Buffer.from('The name com.deepin.SessionManager is owned by :1.11\n'))
  await vi.advanceTimersByTimeAsync(0)
  expect(monitor.locked).toBe(false)
  expect(states).toEqual([false, null, false])
})
it('新 DDE 的独立 LockedChanged 信号立即结束共享', async () => {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const command = args[1] as string[]
    const callback = args[args.length - 1] as (error: Error | null, stdout: string) => void
    callback(command.includes('org.deepin.dde.SessionManager1') ? null : new Error('服务不存在'), reply)
    return {} as ReturnType<typeof execFile>
  })
  const monitor = new LinuxScreenLock(() => undefined); monitors.push(monitor)
  const starting = monitor.start()
  await vi.advanceTimersByTimeAsync(0)
  child.stdout.emit('data', Buffer.from('The name org.deepin.dde.SessionManager1 is owned by :1.10\n'))
  await starting
  expect(monitor.locked).toBe(false)
  reply = '(<true>,)'
  child.stdout.emit('data', Buffer.from('/org/deepin/dde/SessionManager1: org.deepin.dde.SessionManager1.LockedChanged (true,)\n'))
  expect(monitor.locked).toBe(true)
})
it('初始化查询未返回时退出不会再启动子进程', async () => {
  let finish: (error: Error | null, reply: string) => void = () => undefined
  vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
    finish = args[args.length - 1] as typeof finish
    return {} as ReturnType<typeof execFile>
  })
  const monitor = new LinuxScreenLock(() => undefined); monitors.push(monitor)
  const starting = monitor.start()
  monitor.close()
  finish(null, '(<false>,)')
  await starting
  expect(spawn).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it('等待监控归属时关闭也立即清理就绪计时器', async () => {
  const monitor = new LinuxScreenLock(() => undefined); monitors.push(monitor)
  const starting = monitor.start()
  await Promise.resolve()
  expect(spawn).toHaveBeenCalledTimes(1)
  monitor.close()
  await starting
  expect(vi.getTimerCount()).toBe(0)
  expect(monitor.locked).toBeNull()
})
