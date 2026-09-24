// dispatch-store 纯函数单测（#51）：slot 借还、深度/并发门槛、待领取结算、持久化解析。
// 黑客松速度模式：只覆盖最关键 acceptance criteria 的不变量（Spec #41：摇人测试子集）。
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  parseDispatchState,
  acquireSlot,
  acquireSlots,
  releaseSlot,
  depthExceeded,
  concurrencyExceeded,
  portsForSlot,
  recordClaimable,
  claimTask,
  dispatchEdges,
  reanchor,
  recomputeDepths,
  activeParent,
  DISPATCH_SCHEMA_VERSION,
  type DispatchStateFile,
  type DispatchRecord
} from './dispatch-store'

function empty(): DispatchStateFile {
  return parseDispatchState(null)
}

describe('dispatch-store', () => {
  it('slot 端口段：slot 1 = 17978 系（base=17878+100）', () => {
    assert.deepEqual(portsForSlot(1), { udp: 17978, tcp: 17979, api: 17980 })
    assert.deepEqual(portsForSlot(2), { udp: 18078, tcp: 18079, api: 18080 })
  })

  it('端口带按代数错开：深度 2 的节点不与深度 1 撞段（#56 递归派遣同机）', () => {
    const d1 = portsForSlot(1, 1)
    const d2 = portsForSlot(1, 2)
    assert.notDeepEqual(d1, d2)
    assert.deepEqual(d2, { udp: 27978, tcp: 27979, api: 27980 })
    // 同代内 slot 仍互斥
    assert.deepEqual(portsForSlot(2, 2), { udp: 28078, tcp: 28079, api: 28080 })
  })

  it('slot 借还互斥：借出的 slot 不会再借出，归还后可复用', () => {
    const state = empty()
    const s1 = acquireSlot(state)
    assert.equal(s1, 1)
    const s2 = acquireSlot(state)
    assert.equal(s2, 2)
    releaseSlot(state, 1)
    const s3 = acquireSlot(state)
    assert.equal(s3, 1)
  })

  it('slot 用尽显式返回 null（不静默降级）', () => {
    const state = empty()
    state.maxSlot = 2
    assert.equal(acquireSlot(state), 1)
    assert.equal(acquireSlot(state), 2)
    assert.equal(acquireSlot(state), null)
  })

  it('1:N 整批预留：一次借 count 段，互不重叠（#56）', () => {
    const state = empty()
    const slots = acquireSlots(state, 5)
    assert.deepEqual(slots, [1, 2, 3, 4, 5])
    assert.deepEqual(state.slots, [1, 2, 3, 4, 5])
    // 再借一段不会撞上已预留的
    assert.deepEqual(acquireSlots(state, 2), [6, 7])
  })

  it('1:N 预留不足时整批拒绝，不留半批占用（#56 不静默降级）', () => {
    const state = empty()
    state.maxSlot = 3
    assert.equal(acquireSlots(state, 4), null)
    assert.deepEqual(state.slots, [])
  })

  it('深度门槛：常驻(1)可派到 2；深度达上限 3 者不能再派', () => {
    const state = empty()
    state.maxDepth = 3
    assert.equal(depthExceeded(state, 1), false)
    assert.equal(depthExceeded(state, 2), false)
    assert.equal(depthExceeded(state, 3), true)
  })

  it('并发门槛：count 超上限拒绝', () => {
    const state = empty()
    state.maxConcurrency = 5
    assert.equal(concurrencyExceeded(state, 5), false)
    assert.equal(concurrencyExceeded(state, 6), true)
  })

  it('待领取：同 dispatchId 覆盖、claim 一次性', () => {
    const state = empty()
    recordClaimable(state, {
      dispatchId: 'd1',
      groupId: 'g',
      dispatcherId: 'p',
      goalOneLine: '目标',
      reason: '失败',
      status: 'claimable',
      createdAt: 1
    })
    recordClaimable(state, {
      dispatchId: 'd1',
      groupId: 'g',
      dispatcherId: 'p',
      goalOneLine: '目标改',
      reason: '失败',
      status: 'claimable',
      createdAt: 2
    })
    assert.equal(state.claimable.length, 1)
    const task = claimTask(state, 'd1')
    assert.equal(task?.status, 'claimed')
    assert.equal(claimTask(state, 'd1'), null)
  })

  it('派遣边只取 started 的记录（failed/claimable 没有成员上线）', () => {
    const state = empty()
    const base: Omit<DispatchRecord, 'startedAt' | 'outcome'> = {
      dispatchId: 'd1',
      groupId: 'g',
      dispatcherId: 'A',
      memberIds: ['B'],
      goalOneLine: '目标',
      depth: 2,
      slot: 1,
      userDataDir: '/tmp/x'
    }
    state.dispatches = [
      { ...base, startedAt: 1, outcome: 'started' },
      { ...base, dispatchId: 'd2', memberIds: ['C'], startedAt: 2, outcome: 'failed' }
    ]
    assert.deepEqual(dispatchEdges(state), [{ dispatcherId: 'A', memberId: 'B' }])
  })

  it('父退群后子跳级挂靠最近活跃祖先（#56 AC4 / ADR-0007）', () => {
    // A(根) → B → C → D；B 被回收后 C/D 应挂到 A。
    const edges = [
      { dispatcherId: 'A', memberId: 'B' },
      { dispatcherId: 'B', memberId: 'C' },
      { dispatcherId: 'C', memberId: 'D' }
    ]
    const active = new Set(['A', 'C', 'D'])
    assert.deepEqual(reanchor(edges, 'B', active, 'owner'), [
      { memberId: 'C', from: 'B', to: 'A' }
    ])
    // 链上再无活跃祖先 → 兜底主人
    assert.deepEqual(reanchor(edges, 'A', new Set(['C', 'D']), 'owner'), [
      { memberId: 'B', from: 'A', to: 'owner' }
    ])
  })

  it('跳级挂靠后深度按活跃链重算，而不是留在绝对代数（#56 AC4）', () => {
    const edges = [
      { dispatcherId: 'A', memberId: 'B' },
      { dispatcherId: 'B', memberId: 'C' },
      { dispatcherId: 'C', memberId: 'D' }
    ]
    // B 退群：活跃边只剩 新挂靠 A→C 与 C→D
    const reanchored = edges.filter((e) => e.dispatcherId !== 'B').concat([{ dispatcherId: 'A', memberId: 'C' }])
    const active = new Set(['A', 'C', 'D'])
    const depths = recomputeDepths(reanchored, active)
    assert.equal(depths.get('A'), 1) // 根 / 常驻
    assert.equal(depths.get('C'), 2) // 跳级挂靠到 A 后重算，不是原来的 3
    assert.equal(depths.get('D'), 3)
    assert.equal(activeParent(reanchored, 'C', active), 'A')
    assert.equal(activeParent(reanchored, 'A', active), null) // 根无父
  })

  it('容错解析：坏输入回空账本且 schemaVersion 正确；slots/nextSlot 恢复', () => {
    const parsed = parseDispatchState({ hello: 1 })
    assert.equal(parsed.schemaVersion, DISPATCH_SCHEMA_VERSION)
    assert.deepEqual(parsed.slots, [])
    const restored = parseDispatchState({
      schemaVersion: 1,
      slots: [1, 3],
      nextSlot: 2,
      maxDepth: 4,
      maxConcurrency: 7,
      dispatches: [{ garbage: true }],
      claimable: [{ garbage: true }]
    })
    assert.deepEqual(restored.slots, [1, 3])
    assert.equal(restored.maxDepth, 4)
    assert.equal(restored.maxConcurrency, 7)
    assert.deepEqual(restored.dispatches, [])
    assert.deepEqual(restored.claimable, [])
  })
})
