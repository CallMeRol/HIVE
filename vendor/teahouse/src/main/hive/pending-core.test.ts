// #50 关键 AC 的最小验证（黑客松口径：只锁最关键的行为，不追覆盖率）。
// - 每成员最多一个 pending、聚合、编辑（追加）、丢弃
// - 无权者确认被拒（fail-closed：无登记同样拒）
// - 确认产出恰好一份聚合 prompt + 冻结目标
import { describe, expect, it } from 'vitest'
import {
  authorizeConfirm,
  composeAggregatePrompt,
  dropPending,
  emptyPendingStore,
  appendEntry,
  parsePendingStore,
  upsertPending,
  goalOf,
  setGoal
} from './pending-core'

const GROUP = { members: ['owner', 'alice', 'bob'] }

describe('pending 收集期（AC1）', () => {
  it('每成员最多一个 pending：重复 open 覆盖，不产生第二条', () => {
    let file = emptyPendingStore()
    file = upsertPending(file, { memberId: 'm1', groupId: 'g', entries: [], createdAt: 1 })
    file = upsertPending(file, { memberId: 'm1', groupId: 'g', entries: [], createdAt: 2 })
    file = upsertPending(file, { memberId: 'm2', groupId: 'g', entries: [], createdAt: 3 })
    expect(file.pendings).toHaveLength(2)
    expect(file.pendings.find((p) => p.memberId === 'm1')?.createdAt).toBe(2)
  })

  it('多人留言聚合按时间序收拢为一条 prompt；丢弃后为空', () => {
    let file = emptyPendingStore()
    file = upsertPending(file, {
      memberId: 'm1',
      groupId: 'g',
      createdAt: 1,
      entries: [
        { senderId: 'alice', text: '先写测试', messageId: 'msg1', ts: 10 },
        { senderId: 'owner', text: '用 vitest', messageId: 'msg2', ts: 20 },
        { senderId: 'alice', text: '补充：跑 CI', messageId: 'msg3', ts: 30 }
      ]
    })
    const prompt = composeAggregatePrompt(file.pendings[0])
    expect(prompt).toContain('先写测试')
    expect(prompt).toContain('用 vitest')
    expect(prompt).toContain('补充：跑 CI')
    expect(prompt.split('\n').length).toBeGreaterThan(3)
    file = dropPending(file, 'm1')
    expect(file.pendings).toHaveLength(0)
  })

  it('追加留言受条数上限约束（超限拒绝而不是静默丢）', () => {
    let file = emptyPendingStore()
    file = upsertPending(file, { memberId: 'm1', groupId: 'g', entries: [], createdAt: 1 })
    for (let i = 0; i < 50; i += 1) {
      file = appendEntry(file, 'm1', { senderId: 'a', text: `t${i}`, messageId: `m${i}`, ts: i })!
      expect(file).not.toBeNull()
    }
    expect(appendEntry(file, 'm1', { senderId: 'a', text: 'x', messageId: 'mx', ts: 99 })).toBeNull()
  })
})

describe('确认键权限（AC2 fail-closed）', () => {
  const base = { group: GROUP, pendingExists: true, confirmGrants: [] as string[] }

  it('主人可确认', () => {
    expect(authorizeConfirm({ ...base, actorId: 'owner', ownerId: 'owner' }).ok).toBe(true)
  })

  it('无权者确认被拒（not_owner）', () => {
    const d = authorizeConfirm({ ...base, actorId: 'bob', ownerId: 'owner' })
    expect(d.ok).toBe(false)
    expect(d.code).toBe('not_owner')
  })

  it('被放权者可确认（主人逐人放权）', () => {
    expect(
      authorizeConfirm({ ...base, actorId: 'alice', ownerId: 'owner', confirmGrants: ['alice'] }).ok
    ).toBe(true)
  })

  it('无主人登记 = fail-closed 拒绝（无法证明授权状态）', () => {
    const d = authorizeConfirm({ ...base, actorId: 'bob', ownerId: undefined })
    expect(d.ok).toBe(false)
    expect(d.code).toBe('not_owner')
  })

  it('没有 pending 时拒绝', () => {
    const d = authorizeConfirm({ ...base, actorId: 'owner', ownerId: 'owner', pendingExists: false })
    expect(d.ok).toBe(false)
    expect(d.code).toBe('no_pending')
  })
})

describe('确认输出（AC3 恰好一次 + 目标冻结）', () => {
  it('确认后 pending 清空、目标落 frozen 且带 frozenBy', () => {
    let file = emptyPendingStore()
    file = upsertPending(file, {
      memberId: 'm1',
      groupId: 'g',
      createdAt: 1,
      entries: [{ senderId: 'owner', text: '写一个爬虫', messageId: 'msg1', ts: 10 }]
    })
    // 服务层 confirm = 聚合 + drop + setGoal；这里锁文件级不变量。
    const prompt = composeAggregatePrompt(file.pendings[0])
    file = dropPending(file, 'm1')
    file = setGoal(file, { memberId: 'm1', groupId: 'g', state: 'frozen', text: '写一个爬虫', frozenBy: 'owner', frozenAt: 42 })
    expect(file.pendings).toHaveLength(0)
    const goal = goalOf(file, 'm1', 'g')
    expect(goal?.state).toBe('frozen')
    expect(goal?.frozenBy).toBe('owner')
    expect(prompt).toContain('写一个爬虫')
  })
})

describe('持久化（AC6 重启恢复）', () => {
  it('落盘结构 round-trip：pending / 目标 / 放权表都能回来', () => {
    let file = emptyPendingStore()
    file = upsertPending(file, {
      memberId: 'm1',
      groupId: 'g',
      createdAt: 5,
      entries: [{ senderId: 'alice', text: '需求 A', messageId: 'msg1', ts: 1 }]
    })
    file = setGoal(file, { memberId: 'm1', groupId: 'g', state: 'frozen', text: '目标 X', frozenBy: 'owner', frozenAt: 2 })
    file = { ...file, confirmGrants: ['alice'] }
    const restored = parsePendingStore(JSON.parse(JSON.stringify(file)))
    expect(restored.pendings).toHaveLength(1)
    expect(restored.pendings[0].entries[0].text).toBe('需求 A')
    expect(restored.goals[0].state).toBe('frozen')
    expect(restored.confirmGrants).toEqual(['alice'])
  })

  it('坏数据丢弃不崩（schemaVersion 缺失 / 条目畸形）', () => {
    const restored = parsePendingStore({ pendings: [{ memberId: 'x' }], goals: 'nope', confirmGrants: 'nope' })
    expect(restored.pendings).toHaveLength(0)
    expect(restored.schemaVersion).toBe(1)
  })
})
