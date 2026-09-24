// #59 冒烟：待领取任务的人工补派（默认不自动补派 —— 只有显式调用才有动作）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DispatchService, type DispatchDeps } from './dispatch'
import { DispatchStore } from './dispatch-store'
import { MemberRegistry } from './member-registry'
import type { GroupsService } from '../services/groups'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-claim-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 最小替身：只实现 DispatchService 真正会碰的那几个方法。 */
function fakeGroups(): GroupsService {
  const members = ['me']
  const view = (): unknown => ({ groupId: 'g', members: [...members], ownerId: 'me', adminIds: ['me'] })
  return {
    get: () => view(),
    // invite 必须真的把新成员加进去：DispatchService 会回查 `members.includes(nodeId)`，
    // 用一个不变的成员表会让每次派遣都停在「invite 未生效」。
    updateGroup: (_g: string, patch: { kind: string; memberIds?: string[] }) => {
      for (const id of patch.memberIds ?? []) if (!members.includes(id)) members.push(id)
      return view()
    }
  } as unknown as GroupsService
}

/**
 * 可控替身：`fail` 为 true 时 spawn 抛错（制造待领取任务），翻成 false 后同一实例即可补派成功。
 * 一个实例贯穿整个用例，避免多份替身之间账本状态串味。
 */
function makeService(dir: string, maxSlot?: number): {
  service: DispatchService
  store: DispatchStore
  setSpawnFailing(v: boolean): void
  sent: string[]
} {
  const store = new DispatchStore({ path: join(dir, 'dispatch.json'), ...(maxSlot ? { maxSlot } : {}) })
  store.ensureDir()
  const registry = new MemberRegistry({ path: join(dir, 'members.json'), auditPath: join(dir, 'audit.jsonl') })
  const sent: string[] = []
  let failing = true
  const deps: DispatchDeps = {
    selfId: 'me',
    userDataRoot: () => join(dir, 'ud'),
    groups: fakeGroups(),
    registry,
    store,
    spawnNode: () => {
      if (failing) throw new Error('spawn 失败（替身）')
      return { pid: process.pid, apiPort: 1 }
    },
    killNode: () => undefined,
    pollHealth: async () =>
      failing ? { ok: false, reason: 'health 不过（替身）' } : { ok: true },
    sendText: (_g, text) => {
      sent.push(text)
      return null
    },
    emit: () => undefined,
    log: () => undefined,
    // #54 回收专用替身：本用例只走派遣/补派，回收路径不参与。
    archiveMember: () => [],
    quitMember: () => undefined
  }
  return {
    service: new DispatchService(deps),
    store,
    setSpawnFailing: (v) => {
      failing = v
    },
    sent
  }
}

describe('claimAndDispatch（#59 AC3：默认不自动补派，主人可人工补派）', () => {
  it('失败留下的待领取任务：原主人补派 → 摇入新成员，任务转 claimed', async () => {
    const dir = tempDir()
    const { service, store, setSpawnFailing } = makeService(dir)
    const first = await service.dispatch({ groupId: 'g', dispatcherId: 'me', goalOneLine: '做调研' })
    expect(first.outcome).toBe('claimable')
    const taskId = first.task!.dispatchId
    expect(store.listClaimable()).toHaveLength(1)

    // 没有任何自动补派：干等也不会有动作（AC3 的默认口径）。
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.listClaimable()).toHaveLength(1)

    // 原主人人工补派（这次 spawn 成功）。
    setSpawnFailing(false)
    const again = await service.claimAndDispatch({ dispatchId: taskId, actorId: 'me' })
    expect(again.outcome).toBe('started')
    expect(again.memberIds).toHaveLength(1)
    expect(store.listClaimable()).toEqual([]) // 已领取
  })

  it('1:N 第 1 个失败：slots 与实际占用逐位对齐（#59 修复 C2）', async () => {
    const dir = tempDir()
    const store = new DispatchStore({ path: join(dir, 'dispatch.json') })
    store.ensureDir()
    // 第 1 个成员失败（含它的补试）、后两个成功：实际占用应是预留段的后两段，而不是切片 [0,1]。
    // 注意 spawnOne 失败会补试一次 → 必须按 nodeId 判，不能按调用次数。
    let firstNodeId = ''
    const deps: DispatchDeps = {
      selfId: 'me',
      userDataRoot: () => join(dir, 'ud'),
      groups: fakeGroups(),
      registry: new MemberRegistry({ path: join(dir, 'members.json'), auditPath: join(dir, 'audit.jsonl') }),
      store,
      spawnNode: ({ nodeId }) => {
        if (firstNodeId === '') firstNodeId = nodeId
        if (nodeId === firstNodeId) throw new Error('spawn 失败（替身）')
        return { pid: process.pid, apiPort: 1 }
      },
      killNode: () => undefined,
      pollHealth: async () => ({ ok: true }),
      sendText: () => null,
      emit: () => undefined,
      log: () => undefined,
      // #54 回收专用替身：本用例只走派遣/补派，回收路径不参与。
      archiveMember: () => [],
      quitMember: () => undefined
    }
    const service = new DispatchService(deps)
    const outcome = await service.dispatch({ groupId: 'g', dispatcherId: 'me', goalOneLine: '做调研', count: 3 })
    expect(outcome.outcome).toBe('started')
    expect(outcome.memberIds).toHaveLength(2)

    const record = store.snapshot().dispatches.find((d) => d.outcome === 'started')!
    // 预留段是 [1,2,3]，第 1 段（slot 1）失败并已归还 → 记录里应只剩 [2,3]，且与 pids 逐位对齐。
    expect(record.slots).toEqual([2, 3])
    expect(record.pids).toHaveLength(2)
    expect(store.snapshot().slots).toEqual([2, 3])
  })

  it('非原主人补派 → 显式拒绝，任务仍待领取', async () => {
    const dir = tempDir()
    const { service, store } = makeService(dir)
    const first = await service.dispatch({ groupId: 'g', dispatcherId: 'me', goalOneLine: '做调研' })
    const taskId = first.task!.dispatchId

    const denied = await service.claimAndDispatch({ dispatchId: taskId, actorId: 'someone-else' })
    expect(denied.outcome).toBe('rejected')
    expect(denied.reason).toContain('原主人')
    expect(store.listClaimable()).toHaveLength(1) // 没被消费
  })

  it('补派又失败 → 重新落一条待领取（不静默丢任务）', async () => {
    const dir = tempDir()
    const { service, store } = makeService(dir)
    const first = await service.dispatch({ groupId: 'g', dispatcherId: 'me', goalOneLine: '做调研' })
    const taskId = first.task!.dispatchId

    const retry = await service.claimAndDispatch({ dispatchId: taskId, actorId: 'me' })
    expect(retry.outcome).toBe('claimable')
    expect(store.listClaimable()).toHaveLength(1)
    expect(store.listClaimable()[0]!.goalOneLine).toBe('做调研')
  })

  it('已领取的任务再补派 → 拒绝（幂等，不重复摇人）', async () => {
    const dir = tempDir()
    const { service, store } = makeService(dir)
    const first = await service.dispatch({ groupId: 'g', dispatcherId: 'me', goalOneLine: '做调研' })
    const taskId = first.task!.dispatchId
    expect(store.listClaimable()).toHaveLength(1)

    await service.claimAndDispatch({ dispatchId: taskId, actorId: 'me' })
    const twice = await service.claimAndDispatch({ dispatchId: taskId, actorId: 'me' })
    expect(twice.outcome).toBe('rejected')
  })

  it('补派被前置拒绝（slot 用尽）→ 任务放回待领取，不卡成幽灵', async () => {
    const dir = tempDir()
    // slot 表只有 2 段：先让一条待领取任务用掉一段，再占满，补派时必然 slot 用尽。
    const { service, store, setSpawnFailing } = makeService(dir, 2)
    const first = await service.dispatch({ groupId: 'g', dispatcherId: 'me', goalOneLine: '做调研' })
    expect(first.outcome).toBe('claimable')
    const taskId = first.task!.dispatchId
    // 失败的派遣已把 slot 归还，所以此刻还有 2 段 —— 摇醒替身占满它们。
    setSpawnFailing(false)
    await service.dispatch({ groupId: 'g', dispatcherId: 'me', goalOneLine: '占位', count: 2 })
    expect(store.snapshot().slots).toEqual([1, 2])

    const retry = await service.claimAndDispatch({ dispatchId: taskId, actorId: 'me' })
    expect(retry.outcome).toBe('rejected')
    expect(retry.reason).toContain('slot')
    // 关键：任务必须还在待领取里（不是 claimed 之后消失）。
    expect(store.listClaimable().map((t) => t.dispatchId)).toEqual([taskId])
  })
})
