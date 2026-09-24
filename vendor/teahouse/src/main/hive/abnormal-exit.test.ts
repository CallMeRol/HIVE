// #59 冒烟：runner 猝死 → 异常退群 + 任务转待领取（纯账本 + 探活判据，不 spawn 真进程）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DispatchStore } from './dispatch-store'
import { AbnormalExitWatcher, abnormalExitText, collectDeadTargets, isProcessAlive } from './abnormal-exit'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-abnormal-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 起一本账，记一条「已上线」的派遣（成员 m1 / pid 随入参）。 */
function startedStore(dir: string, pids?: number[]): DispatchStore {
  const store = new DispatchStore({ path: join(dir, 'dispatch.json') })
  store.ensureDir()
  const begin = store.begin({ dispatchId: 'd1', groupId: 'g', dispatcherId: 'me', dispatcherDepth: 1, count: 1 })
  if (!begin.ok) throw new Error('slot 借用失败')
  store.settleStarted({
    dispatchId: 'd1',
    groupId: 'g',
    dispatcherId: 'me',
    memberIds: ['m1'],
    goalOneLine: '做调研',
    depth: 2,
    slot: begin.slot,
    ...(pids ? { pids } : {}),
    userDataDir: join(dir, 'm1')
  })
  return store
}

describe('isProcessAlive', () => {
  it('自己进程活着；不存在的 pid 判死', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    // 极大的 pid 在本机不可能存在（pid_max 远小于它）。
    expect(isProcessAlive(99_999_999)).toBe(false)
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})

describe('collectDeadTargets', () => {
  it('pid 不在 → 判死；pid 在 → 不判', () => {
    const dir = tempDir()
    const store = startedStore(dir, [4242])
    const dead = collectDeadTargets(store.snapshot().dispatches, (pid) => pid !== 4242)
    expect(dead).toEqual([{ dispatchId: 'd1', memberId: 'm1', pid: 4242 }])
  })

  it('旧账本没有 pids 列 → 不参与探活（迁移规则 1：只增字段不误判）', () => {
    const dir = tempDir()
    const store = startedStore(dir)
    expect(collectDeadTargets(store.snapshot().dispatches, () => false)).toEqual([])
  })
})

describe('AbnormalExitWatcher', () => {
  it('判死 → 任务转待领取 + slot 归还 + onAbnormalExit 恰一次（幂等）', () => {
    const dir = tempDir()
    const store = startedStore(dir, [4242])
    const seen: string[] = []
    let capturedGroup: string | undefined
    const watcher = new AbnormalExitWatcher({
      store,
      // 快照必须带上群 / 派遣者：结算后 memberIds 已摘除该成员，回查是查不到的。
      onAbnormalExit: ({ memberId, record }) => {
        seen.push(memberId)
        capturedGroup = record?.groupId
      },
      isAlive: () => false,
      log: () => undefined
    })

    expect(watcher.poll()).toEqual([{ dispatchId: 'd1', memberId: 'm1' }])
    // 幂等：第二拍看到同一个死成员，不重复结算、不重复通知。
    expect(watcher.poll()).toEqual([])
    expect(seen).toEqual(['m1'])
    expect(capturedGroup).toBe('g')

    const snapshot = store.snapshot()
    expect(snapshot.slots).toEqual([]) // slot 归还
    const task = store.listClaimable().find((t) => t.failedMemberId === 'm1')
    expect(task?.goalOneLine).toBe('做调研')
    expect(task?.dispatcherId).toBe('me')
    expect(task?.reason).toContain('猝死')
    // 派遣记录不再代表活跃成员（不伪装活跃，契约迁移规则 3）。
    expect(snapshot.dispatches[0]?.outcome).not.toBe('started')
  })

  it('正常终结（markSettled）后的成员不再被判猝死 —— AC2 的关键回归', () => {
    const dir = tempDir()
    const store = startedStore(dir, [4242])
    // 成员正常退群：账本回写终结（#59 修复 C1 前，这条路径根本不存在）。
    expect(store.markSettled({ dispatchId: 'd1', memberId: 'm1' })).toBe(true)
    expect(store.snapshot().slots).toEqual([]) // slot 归还

    const seen: string[] = []
    const watcher = new AbnormalExitWatcher({
      store,
      onAbnormalExit: ({ memberId }) => seen.push(memberId),
      isAlive: () => false, // 进程确实没了 —— 但它是正常退的，不该报异常
      log: () => undefined
    })
    expect(watcher.poll()).toEqual([])
    expect(seen).toEqual([])
    expect(store.listClaimable()).toEqual([]) // 不生成幽灵待领取任务
    // 幂等：重复终结不报错、不重复释放。
    expect(store.markSettled({ dispatchId: 'd1', memberId: 'm1' })).toBe(false)
  })

  it('活着的成员不动', () => {
    const dir = tempDir()
    const store = startedStore(dir, [process.pid])
    const watcher = new AbnormalExitWatcher({
      store,
      onAbnormalExit: () => {
        throw new Error('不该判猝死')
      }
    })
    expect(watcher.poll()).toEqual([])
    expect(store.listClaimable()).toEqual([])
  })
})

describe('abnormalExitText', () => {
  it('与正常退群明确不同：带「异常」+ 待领取 id + 默认不补派说明', () => {
    const text = abnormalExitText({ memberName: '阿蜂', reason: 'pid 已不存在', taskId: 'd1-m1', goalOneLine: '做调研' })
    expect(text).toContain('异常退群')
    expect(text).toContain('d1-m1')
    expect(text).toContain('默认不自动补派')
  })
})
