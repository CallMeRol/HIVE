// 待领取任务（claimable）的 GUI 面形状（#59）。
//
// 三面共用一套词：主进程投影、preload 透传、renderer 出人话。
// 通道走 renderer IPC（`hive:claimable-list` / `hive:claim-now`）—— 与 #52 clear 同源纪律：
// 「带权限语义的动作（谁能补派）走 renderer IPC，不做成 local-api 端点」。
// 状态本身仍由派遣账本唯一持有（契约状态所有者表：待领取任务属 #59）。
/** 渲染层看到的待领取任务（账本 `ClaimableTask` 的对外子集）。 */
export interface HiveClaimableView {
  dispatchId: string
  groupId: string
  /** 原主人（要 @ 的人，也是唯一有权补派的人）。 */
  dispatcherId: string
  goalOneLine: string
  /** 猝死/失败的成员（异常退群时有值）。 */
  failedMemberId?: string
  reason: string
  createdAt: number
}

export interface HiveClaimableState {
  selfId: string
  tasks: HiveClaimableView[]
}

export interface HiveClaimResult {
  ok: boolean
  /** 补派成功时新派遣的 id（与旧任务 id 不是同一个）。 */
  dispatchId?: string
  /** 补派摇上线的成员。 */
  memberIds?: string[]
  reason?: string
}

export const HIVE_CLAIM_TEXT = {
  /** AC3 的默认口径：系统**不**自动补派，这是给用户看的说明。 */
  noAuto:
    '任务回到待领取后不会自动补派——补派是主人的动作，避免在根因（端口/资源）未解决时反复摇人。',
  notOwner: '只有该任务的原主人可以补派',
  gone: '任务不在待领取状态（可能已被补派或已取消）'
} as const

/** 账本条目 → 渲染层视图（只挑 GUI 需要的字段，不外泄内部结构）。 */
export function toClaimableView(task: ClaimableTask): HiveClaimableView {
  return {
    dispatchId: task.dispatchId,
    groupId: task.groupId,
    dispatcherId: task.dispatcherId,
    goalOneLine: task.goalOneLine,
    ...(task.failedMemberId ? { failedMemberId: task.failedMemberId } : {}),
    reason: task.reason,
    createdAt: task.createdAt
  }
}

/** 账本条目在 shared 面的最小形状（避免 renderer 依赖主进程模块）。 */
export interface ClaimableTask {
  dispatchId: string
  groupId: string
  dispatcherId: string
  goalOneLine: string
  failedMemberId?: string
  reason: string
  createdAt: number
}
