// 成员移出 / 孤儿清理的**纯函数**权限判定（#53）。
//
// 口径（CONTEXT.md「移出」/ ADR-0006 Consequences）：
// - **主人**（人对成员）= 把成员拉进群、拥有它生命周期的人；「移出仅主人」说的是这个，不是群主/管理员。
// - 双层判定：Hive 语义闸门（主人 / 授权 admin）**且**底座群管理权（groups.updateGroup 会再校验一次）。
// - 拒绝原因显式返回，由调用方留痕；无登记 = 视为他人所有（fail-closed）。
import { hiveMemberRemoveText, type HiveMemberRemoveDenyCode } from '../../shared/hive-member'
import type { MemberRecord } from './member-registry'

/** 移出动作两轴：actor 是成员主人（`leave`）还是节点死亡后的授权 admin（`orphan_removed`）。 */
export type MemberRemovalPhase = 'leave' | 'orphan_removed'

export interface MemberRemovalDecision {
  ok: boolean
  code?: HiveMemberRemoveDenyCode
  reason?: string
  phase?: MemberRemovalPhase
}

export interface MemberRemovalInput {
  actorId: string
  targetId: string
  groupId: string
  /** 目标成员当前是否可达（registry 在线判定）。离线/无记录 = 节点已死 → 孤儿路径。 */
  targetOnline: boolean
  /** 底座群视图：null = 群不存在或本机不认识。 */
  group: { members: string[]; ownerId: string; adminIds: string[] } | null
  /** 目标成员的登记记录；无记录 = 不是本机管理的成员。 */
  record: MemberRecord | undefined
}

function deny(code: HiveMemberRemoveDenyCode): MemberRemovalDecision {
  return { ok: false, code, reason: hiveMemberRemoveText(code) }
}

/** 本节点在该群是否具备底座群管理权（群主或管理员）。 */
export function hasGroupManagePower(
  group: { ownerId: string; adminIds: string[] },
  actorId: string
): boolean {
  return group.ownerId === actorId || group.adminIds.includes(actorId)
}

/**
 * 判定一次移出/清理是否放行。纯函数：所有外部状态由入参注入，便于单测与复用。
 *
 * 顺序（每一步都 fail-closed）：
 * 1. 群存在且 actor 在群里；目标不是自己、不是群主（底座 `remove` 同样禁止）。
 * 2. 目标必须在本群成员表里，且有本机登记（否则按「他人所有」拒）。
 * 3. 登记记录的 groupId 必须与请求群一致（防跨群误删，AC4）。
 * 4. 主人路径：actor === record.ownerId（人），且本节点有群管理权。
 * 5. 孤儿路径：目标离线 + actor 有群管理权；派遣成员额外要求 actor === spawnedBy。
 */
export function authorizeMemberRemoval(input: MemberRemovalInput): MemberRemovalDecision {
  const { actorId, targetId, group, record, targetOnline } = input
  if (!group) return deny('unknown_group')
  if (!group.members.includes(actorId)) return deny('not_member')
  if (!targetId || targetId === actorId) return deny('invalid_target')
  if (targetId === group.ownerId) return deny('invalid_target')
  if (!group.members.includes(targetId)) return deny('unknown_target')
  // 登记是成员级（主人是人对成员的关系，不随群变）：记录里的 kind=dispatched 属于别的群时，
  // 说明这本该是另一个群的操作 —— 拒绝跨群误删（AC4），而不是让「同一个人拥有」当通行证。
  if (!record) return deny('unknown_target')
  if (record.kind === 'dispatched' && record.groupId && record.groupId !== input.groupId) {
    return deny('group_mismatch')
  }

  const isMemberOwner = record.ownerId === actorId
  const managePower = hasGroupManagePower(group, actorId)

  if (targetOnline) {
    // 在线成员：只有它的主人能移出；底座群管理权是第二道闸门。
    if (!isMemberOwner) return deny('not_member_owner')
    if (!managePower) return deny('group_manage_denied')
    return { ok: true, phase: 'leave' }
  }

  // 节点整体死亡：授权 admin 清理孤儿（ADR-0006）。
  if (!managePower) return deny('group_manage_denied')
  if (record.kind === 'dispatched' && record.spawnedBy && record.spawnedBy !== actorId) {
    return deny('dispatch_not_owner')
  }
  return { ok: true, phase: 'orphan_removed' }
}
