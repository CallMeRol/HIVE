// #58 冒烟：恢复入口对「执行期中断派遣」与「幽灵 pending」的收口（纯账本操作，不 spawn）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DispatchStore } from './dispatch-store'
import { MemberRegistry } from './member-registry'
import { PendingService } from './pending-service'
import { interruptedDispatchIds, runRecovery, type RecoveryDeps } from './recovery'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-recovery-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('interruptedDispatchIds', () => {
  it('只挑 outcome=started 的派遣', () => {
    expect(
      interruptedDispatchIds({
        dispatches: [
          { dispatchId: 'a', outcome: 'started' },
          { dispatchId: 'b', outcome: 'failed' },
          { dispatchId: 'c', outcome: 'started' }
        ]
      })
    ).toEqual(['a', 'c'])
  })
})

describe('runRecovery', () => {
  it('中断派遣转待领取 + slot 归还；幽灵 pending 清理；无接入账本时不碰 attach', async () => {
    const dir = tempDir()
    const store = new DispatchStore({ path: join(dir, 'dispatch.json') })
    store.ensureDir()
    // 模拟上次退出前的活跃派遣（slot 1 借出）。
    const begin = store.begin({ dispatchId: 'd1', groupId: 'g', dispatcherId: 'me', dispatcherDepth: 1, count: 1 })
    expect(begin.ok).toBe(true)
    if (begin.ok) {
      store.settleStarted({
        dispatchId: 'd1',
        groupId: 'g',
        dispatcherId: 'me',
        memberIds: ['m1'],
        goalOneLine: '做调研',
        depth: 2,
        slot: begin.slot,
        userDataDir: join(dir, 'm1')
      })
    }

    const registry = new MemberRegistry({ path: join(dir, 'members.json'), auditPath: join(dir, 'audit.jsonl') })
    const pending = new PendingService({ path: join(dir, 'pending.json') })
    // 幽灵：pending 有，登记表没有。
    pending.open({ memberId: 'ghost', groupId: 'g', entries: [] })
    // 真实成员：登记表有，pending 也有 → 必须保留。
    registry.register({ memberId: 'real', ownerId: 'me', kind: 'resident', groupId: 'g' })
    pending.open({ memberId: 'real', groupId: 'g', entries: [] })

    const attachPath = join(dir, 'agent-attach.json')
    writeFileSync(attachPath, '{"schemaVersion":1,"members":[]}', 'utf8')

    const deps: RecoveryDeps = {
      selfId: () => 'me',
      attachStatePath: () => attachPath,
      registry,
      store,
      pending,
      respawn: () => {
        throw new Error('不应被调用')
      }
    }
    const report = await runRecovery(deps)
    expect(report.interruptedDispatches).toEqual(['d1'])
    expect(report.droppedGhostPendings).toEqual(['ghost'])
    expect(pending.get('ghost')).toBeUndefined()
    expect(pending.get('real')).toBeDefined()
    // slot 已归还、派遣记为 failed 轨迹 + 一条待领取。
    const snap = store.snapshot()
    expect(snap.slots).not.toContain(1)
    expect(snap.dispatches.find((d) => d.dispatchId === 'd1')?.outcome).toBe('failed')
    expect(snap.claimable.find((t) => t.dispatchId === 'd1')?.status).toBe('claimable')
  })

  it('幂等：第二遍不再产生新的转待领取 / 清理', async () => {
    const dir = tempDir()
    const store = new DispatchStore({ path: join(dir, 'dispatch.json') })
    store.ensureDir()
    const registry = new MemberRegistry({ path: join(dir, 'members.json'), auditPath: join(dir, 'audit.jsonl') })
    const pending = new PendingService({ path: join(dir, 'pending.json') })
    const attachPath = join(dir, 'agent-attach.json')
    writeFileSync(attachPath, '{"schemaVersion":1,"members":[]}', 'utf8')
    const deps: RecoveryDeps = {
      selfId: () => 'me',
      attachStatePath: () => attachPath,
      registry,
      store,
      pending,
      respawn: () => {
        throw new Error('不应被调用')
      }
    }
    await runRecovery(deps)
    const second = await runRecovery(deps)
    expect(second.interruptedDispatches).toEqual([])
    expect(second.droppedGhostPendings).toEqual([])
  })
})
