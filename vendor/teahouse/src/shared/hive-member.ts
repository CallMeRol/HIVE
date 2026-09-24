// Hive 成员移出的**拒绝码与返回形状**（#53）。放 shared 是因为三面都要用同一套词：
// 主进程判定、preload 透传、renderer 出人话文案。判定本身在 `main/hive/member-removal.ts`（纯函数）。
//
// 通道复用既有的 `group:update`（不新开 IPC 通道）：成功 = `GroupView`（与上游同形）；
// 拒绝 = `{ hiveDenied: true, code, reason }` —— 结构上不可能与 GroupView 混淆。
import type { GroupView } from './ipc'

export type HiveMemberRemoveDenyCode =
  | 'unknown_group'
  | 'not_member'
  | 'unknown_target'
  | 'not_member_owner'
  | 'group_manage_denied'
  | 'group_mismatch'
  | 'dispatch_not_owner'
  | 'target_online'
  | 'invalid_target'
  /** 判权通过，但底座 `updateGroup` 拒绝了本次变更（被移出者其实没动过）。 */
  | 'backend_rejected'

export interface HiveMemberRemoveDeny {
  hiveDenied: true
  code: HiveMemberRemoveDenyCode
  reason: string
  /** 判权已通过、Action 落在底座上被判失败；与「权限不足」不是同一件事。 */
  stage: 'authorize' | 'apply'
}

export type HiveMemberRemoveResult = GroupView | HiveMemberRemoveDeny

export function isHiveMemberRemoveDenied(value: unknown): value is HiveMemberRemoveDeny {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { hiveDenied?: unknown }).hiveDenied === true
  )
}

/**
 * 拒绝码 → 人话。renderer 与主进程留痕共用同一张表；缺项时回退到 code 本身，
 * 保证「留下明确原因」这一条永远成立（不静默）。
 */
export const HIVE_MEMBER_REMOVE_TEXT: Record<HiveMemberRemoveDenyCode, string> = {
  unknown_group: '群不存在或本机不在该群',
  not_member: '操作者不是该群成员',
  unknown_target: '目标不是本机管理的成员（无成员主人登记，按他人所有处理）',
  not_member_owner: '只有该成员的主人可以移出',
  group_manage_denied: '本节点在该群没有管理权限（需群主或管理员）',
  group_mismatch: '目标成员不属于该群，拒绝跨群操作',
  dispatch_not_owner: '只有派遣该成员的人可以清理孤儿',
  target_online: '目标成员仍在线，不能按孤儿清理',
  invalid_target: '目标成员无效（不能移出自己或群主）',
  backend_rejected: '群管理操作被底座拒绝（成员未变更）'
}

export function hiveMemberRemoveText(code: HiveMemberRemoveDenyCode): string {
  return HIVE_MEMBER_REMOVE_TEXT[code] ?? code
}
