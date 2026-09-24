// #53 判权纯函数的拒绝码矩阵。AC1（非主人被拒且原因明确）与 AC4（不误删他人/他群成员）
// 的每一条分支都在这里钉住；端到端剧本见仓库根 `scripts/hive-member-e2e.mjs`。
import { describe, expect, it } from 'vitest'
import { authorizeMemberRemoval, hasGroupManagePower } from './member-removal'
import type { MemberRecord } from './member-registry'

const GROUP = 'g-1'

/** 群：owner 是 owner，另一个人类节点 peer 是普通成员；目标 target 也在群里。 */
const group = { members: ['owner', 'peer', 'target'], ownerId: 'owner', adminIds: [] as string[] }

function record(over: Partial<MemberRecord> = {}): MemberRecord {
  return { memberId: 'target', ownerId: 'owner', kind: 'resident', registeredAt: 1, ...over }
}

function judge(over: Partial<Parameters<typeof authorizeMemberRemoval>[0]> = {}) {
  return authorizeMemberRemoval({
    actorId: 'owner',
    targetId: 'target',
    groupId: GROUP,
    targetOnline: true,
    group,
    record: record(),
    ...over
  })
}

describe('authorizeMemberRemoval', () => {
  it('主人移出在线成员 → leave（AC2）', () => {
    expect(judge()).toEqual({ ok: true, phase: 'leave' })
  })

  it('非主人移出在线成员 → 明确拒绝 not_member_owner（AC1/AC4）', () => {
    const d = judge({ actorId: 'peer' })
    expect(d.ok).toBe(false)
    expect(d.code).toBe('not_member_owner')
    expect(d.reason).toContain('主人')
  })

  it('操作者不在群里 → not_member', () => {
    expect(judge({ actorId: 'outsider' }).code).toBe('not_member')
  })

  it('目标不在本群成员表 → unknown_target（不误删他群成员，AC4）', () => {
    expect(judge({ targetId: 'someone-else' }).code).toBe('unknown_target')
  })

  it('目标没有主人登记 → unknown_target（按他人所有，fail-closed）', () => {
    expect(judge({ record: undefined }).code).toBe('unknown_target')
  })

  it('不能移出自己或群主 → invalid_target', () => {
    expect(judge({ targetId: 'owner' }).code).toBe('invalid_target')
    expect(judge({ actorId: 'peer', targetId: 'peer' }).code).toBe('invalid_target')
  })

  it('群不存在 → unknown_group', () => {
    expect(judge({ group: null }).code).toBe('unknown_group')
  })

  it('主人但本节点无群管理权 → group_manage_denied（两层判定）', () => {
    const d = judge({
      actorId: 'peer',
      record: record({ ownerId: 'peer' }),
      group: { members: group.members, ownerId: 'owner', adminIds: [] }
    })
    expect(d.code).toBe('group_manage_denied')
  })

  it('主人且是群管理员 → 放行', () => {
    const d = judge({
      actorId: 'peer',
      record: record({ ownerId: 'peer' }),
      group: { members: group.members, ownerId: 'owner', adminIds: ['peer'] }
    })
    expect(d.ok).toBe(true)
  })

  it('节点死亡 + 授权 admin 清理 → orphan_removed（AC3）', () => {
    const d = judge({
      actorId: 'peer',
      targetOnline: false,
      group: { members: group.members, ownerId: 'owner', adminIds: ['peer'] }
    })
    expect(d).toEqual({ ok: true, phase: 'orphan_removed' })
  })

  it('离线但操作者无管理权 → 拒绝（孤儿清理也要授权）', () => {
    expect(judge({ actorId: 'peer', targetOnline: false }).code).toBe('group_manage_denied')
  })

  it('派遣成员的孤儿只归派遣者清理（ADR-0006）', () => {
    const dispatched = record({ kind: 'dispatched', spawnedBy: 'owner', groupId: GROUP })
    const d = judge({
      actorId: 'peer',
      targetOnline: false,
      record: dispatched,
      group: { members: group.members, ownerId: 'owner', adminIds: ['peer'] }
    })
    expect(d.code).toBe('dispatch_not_owner')
  })

  it('派遣成员记的是别的群 → group_mismatch（不跨群误删，AC4）', () => {
    const d = judge({
      record: record({ kind: 'dispatched', spawnedBy: 'owner', groupId: 'group-other' })
    })
    expect(d.code).toBe('group_mismatch')
  })

  it('常驻成员的主人关系与群无关：换个群仍认主人', () => {
    expect(judge({ groupId: 'group-other' }).ok).toBe(true)
  })
})

describe('hasGroupManagePower', () => {
  it('群主与管理员有管理权，普通成员没有', () => {
    expect(hasGroupManagePower({ ownerId: 'owner', adminIds: [] }, 'owner')).toBe(true)
    expect(hasGroupManagePower({ ownerId: 'owner', adminIds: ['a'] }, 'a')).toBe(true)
    expect(hasGroupManagePower({ ownerId: 'owner', adminIds: [] }, 'b')).toBe(false)
  })
})
