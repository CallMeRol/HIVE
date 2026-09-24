// pending 闸门装配（#50）：把群 @ 消息按「空闲收集 / 执行期直通」路由到 pending 服务，
// 确认键通过后把聚合 prompt 投回 bridge。本模块只做路由判定（无 electron 依赖），
// 服务与 UI 接线在 index.ts。
//
// 路由依据：MessageView 不携带 mentions 数组（只有 mentioned 布尔），且 bridge 挂在本机
// 成员节点上——被 @ 的成员就是 selfId 对应的本机成员。谁被 @ 由 index.ts 注入。
import type { MessageView } from '../../shared/ipc'
import { PendingService } from './pending-service'

export interface PendingGateDeps {
  service: PendingService
  /** 被触达的本机成员（selfId；本进程就是一个成员节点）。 */
  selfMemberId: string
  /** 本机成员的主人（member-registry 读数；undefined = 无登记，路由面不猜）。 */
  ownerId: string | undefined
  /** pending 归属群。 */
  groupIdOf(memberId: string): string | undefined
  /** 该成员当前是否有已冻结目标（执行期判定依据之一）。 */
  hasFrozenGoal(memberId: string, groupId: string): boolean
  /** 该成员是否正在跑 turn（bridge 的 running 状态；running = steering/queuing 直通）。 */
  isRunning(memberId: string): boolean
  log?(line: string): void
}

/** 打点：路由决策可观察（不静默）。 */
export function describeRoute(deps: PendingGateDeps, decision: 'collect' | 'steer' | 'reject'): string {
  return `self=${deps.selfMemberId} owner=${deps.ownerId ?? 'none'} running=${deps.isRunning(deps.selfMemberId)} → ${decision}`
}

export const PENDING_AGGREGATE_PREFIX = 'pending-aggregate:'

/**
 * 路由规则（PRD ⑤ / CONTEXT「pending 收集期」）：
 * - 成员空闲（无 frozen goal 且不 running）→ @ 进 pending 收集期（不触发 turn）。
 * - 成员执行中（有 frozen goal 或 running）→ steering 直通，不进 pending、不二次确认。
 * - 未知/异常状态保守归 collect：宁可攒着等人确认，也不能绕过审批直接开工（fail-closed 的路由面表达）。
 */
export function routeMessage(deps: PendingGateDeps, _msg: MessageView): 'collect' | 'steer' | 'reject' {
  if (!deps.selfMemberId) return 'reject'
  const groupId = deps.groupIdOf(deps.selfMemberId)
  if (!groupId) return 'reject'
  if (deps.isRunning(deps.selfMemberId) || deps.hasFrozenGoal(deps.selfMemberId, groupId)) return 'steer'
  return 'collect'
}

/** 把一条 @ 消息收进 pending（route=collect 时由 index.ts 调）。返回是否被接受。 */
export function collectIntoPending(deps: PendingGateDeps, msg: MessageView): boolean {
  const memberId = deps.selfMemberId
  const groupId = deps.groupIdOf(memberId)
  if (!groupId) return false
  const entry = { senderId: msg.senderId, text: msg.text, messageId: msg.id, ts: msg.ts }
  if (!deps.service.get(memberId)) {
    deps.service.open({ memberId, groupId, entries: [] })
  }
  return deps.service.addEntry(memberId, entry) !== null
}

/**
 * 确认键：服务层判权 + 聚合，产出恰好一份 prompt。
 * 返回的 prompt 以 `pending-aggregate:` 前缀投给 bridge（由 bridge takeTurn 消费）。
 * 这里不直接 sendText —— turn 由 bridge 的既有串行队列执行。
 */
export function confirmedPromptText(prompt: string): string {
  return `${PENDING_AGGREGATE_PREFIX}${prompt}`
}
