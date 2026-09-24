// Hive pending 收集期 + 确认键 + 会话目标状态（#50 / CONTEXT.md 术语）。
//
// 职责（docs/contracts/parallel-development.md 状态所有者表）：
// - pending 草稿与逐人授权：本模块是唯一写者，持久化到 Hive 侧独立文件。
// - 会话目标（未定 / 已冻结）：#50 写入并冻结，#55 只读判定。
// - 永不自动过期：pending 没有任何 TTL / 定时器；出口仅主人确认或主人丢弃（#30）。
// - 权限一律 fail-closed：无法确定授权状态 = 拒绝，并显式返回原因。
//
// 本文件是纯逻辑 + 状态机（无 electron / 无 IPC），便于无 Electron 单测；
// 落盘与接线见 pending-service.ts。

/** 迁移规则：Hive 侧持久化结构一律带 schemaVersion（整数，起 1）。 */
export const PENDING_SCHEMA_VERSION = 1

/** 单条留言的 UTF-8 字节上限（与群文本同量级，防 pending 被单条灌爆）。 */
export const PENDING_ENTRY_MAX_BYTES = 4096
/** 单个 pending 的留言条数上限（聚合后的 prompt 仍受 TEXT_TCP_LIMIT 约束）。 */
export const PENDING_ENTRY_MAX_COUNT = 50
/** 会话目标文本上限。 */
export const GOAL_TEXT_MAX_BYTES = 2000

export interface PendingEntry {
  /** 贡献者（群成员 nodeId）。 */
  senderId: string
  /** 留言原文（派单的一部分）。 */
  text: string
  /** 该条留言对应的群消息 id（审计用）。 */
  messageId: string
  ts: number
}

export interface PendingDraft {
  /** pending 归属的 agent 成员（本机拥有的成员 nodeId）。 */
  memberId: string
  groupId: string
  entries: PendingEntry[]
  createdAt: number
}

export type GoalState = 'unset' | 'frozen'

export interface SessionGoal {
  memberId: string
  groupId: string
  state: GoalState
  /** 已冻结的目标文本；state=unset 时为 ''。 */
  text: string
  /** 冻结动作执行者（放权后的 confirm 代理人 = 主人）。 */
  frozenBy?: string
  frozenAt?: number
}

export interface PendingStoreFile {
  schemaVersion: number
  /** 每成员最多一个 pending（CONTEXT.md「pending 收集期」）。 */
  pendings: PendingDraft[]
  goals: SessionGoal[]
  /** 确认键放权表：被授权的 actorId（默认仅主人，无需在此记录）。 */
  confirmGrants: string[]
}

export function emptyPendingStore(): PendingStoreFile {
  return { schemaVersion: PENDING_SCHEMA_VERSION, pendings: [], goals: [], confirmGrants: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 容错解析：坏条目丢弃而不是让整张表失效（本机账本，宁可少一条也不能崩）。 */
export function parsePendingStore(raw: unknown): PendingStoreFile {
  const out = emptyPendingStore()
  if (!isRecord(raw)) return out
  const pendings = Array.isArray(raw['pendings']) ? raw['pendings'] : []
  for (const item of pendings) {
    if (!isRecord(item)) continue
    const memberId = typeof item['memberId'] === 'string' ? item['memberId'].trim() : ''
    const groupId = typeof item['groupId'] === 'string' ? item['groupId'].trim() : ''
    if (!memberId || !groupId) continue
    const entries: PendingEntry[] = []
    if (Array.isArray(item['entries'])) {
      for (const rawEntry of item['entries']) {
        if (!isRecord(rawEntry)) continue
        const senderId = typeof rawEntry['senderId'] === 'string' ? rawEntry['senderId'].trim() : ''
        const text = typeof rawEntry['text'] === 'string' ? rawEntry['text'] : ''
        const messageId = typeof rawEntry['messageId'] === 'string' ? rawEntry['messageId'] : ''
        const ts = typeof rawEntry['ts'] === 'number' ? rawEntry['ts'] : 0
        if (!senderId || !text.trim() || !messageId) continue
        entries.push({ senderId, text, messageId, ts })
      }
    }
    if (entries.length === 0) continue
    out.pendings.push({ memberId, groupId, entries, createdAt: typeof item['createdAt'] === 'number' ? item['createdAt'] : 0 })
  }
  const goals = Array.isArray(raw['goals']) ? raw['goals'] : []
  for (const item of goals) {
    if (!isRecord(item)) continue
    const memberId = typeof item['memberId'] === 'string' ? item['memberId'].trim() : ''
    const groupId = typeof item['groupId'] === 'string' ? item['groupId'].trim() : ''
    if (!memberId || !groupId) continue
    const state: GoalState = item['state'] === 'frozen' ? 'frozen' : 'unset'
    const text = typeof item['text'] === 'string' ? item['text'] : ''
    const frozenBy = typeof item['frozenBy'] === 'string' ? item['frozenBy'] : ''
    const frozenAt = typeof item['frozenAt'] === 'number' ? item['frozenAt'] : 0
    out.goals.push({
      memberId,
      groupId,
      state,
      text,
      ...(frozenBy ? { frozenBy } : {}),
      ...(frozenAt ? { frozenAt } : {})
    })
  }
  if (Array.isArray(raw['confirmGrants'])) {
    for (const id of raw['confirmGrants']) {
      if (typeof id === 'string' && id.trim()) out.confirmGrants.push(id.trim())
    }
  }
  out.confirmGrants = [...new Set(out.confirmGrants)]
  return out
}

// ---------- 纯操作（文件 → 新文件；服务层负责落盘） ----------

export function upsertPending(file: PendingStoreFile, draft: PendingDraft): PendingStoreFile {
  const pendings = file.pendings.filter((p) => p.memberId !== draft.memberId)
  pendings.push(draft)
  return { ...file, pendings }
}

export function dropPending(file: PendingStoreFile, memberId: string): PendingStoreFile {
  return { ...file, pendings: file.pendings.filter((p) => p.memberId !== memberId) }
}

export function appendEntry(
  file: PendingStoreFile,
  memberId: string,
  entry: PendingEntry,
  limits = { maxEntries: PENDING_ENTRY_MAX_COUNT, maxBytes: PENDING_ENTRY_MAX_BYTES }
): PendingStoreFile | null {
  const draft = file.pendings.find((p) => p.memberId === memberId)
  if (!draft) return null
  if (draft.entries.length >= limits.maxEntries) return null
  if (Buffer.byteLength(entry.text, 'utf8') > limits.maxBytes) return null
  const next: PendingDraft = { ...draft, entries: [...draft.entries, entry] }
  return upsertPending(file, next)
}

/** 聚合 prompt：按人分组、按时间序收拢为一条（按键瞬间收拢，CONTEXT「确认键」）。 */
export function composeAggregatePrompt(draft: PendingDraft): string {
  const bySender = new Map<string, string[]>()
  for (const entry of draft.entries) {
    const list = bySender.get(entry.senderId) ?? []
    list.push(entry.text)
    bySender.set(entry.senderId, list)
  }
  const sections: string[] = []
  let n = 0
  for (const [senderId, texts] of bySender) {
    n += 1
    sections.push([`发起人 ${n}（${senderId}）：`, ...texts.map((t) => `- ${t.replace(/\n+/g, ' ')}`)].join('\n'))
  }
  return sections.join('\n')
}

// ---------- 权限（#50 AC：无权者确认被拒，权限异常 fail-closed） ----------

export type ConfirmDenyCode =
  | 'unknown_group'
  | 'not_member'
  | 'no_pending'
  | 'not_owner'
  | 'invalid_actor'

export interface ConfirmDecision {
  ok: boolean
  code?: ConfirmDenyCode
  reason?: string
}

export interface ConfirmInput {
  actorId: string
  /** 该 agent 成员的**主人**（人对成员）；无登记 = fail-closed 拒绝。 */
  ownerId: string | undefined
  /** 主人逐人放权表（actorId 列表）。 */
  confirmGrants: string[]
  /** 底座群视图；null = 群不存在或本机不认识。 */
  group: { members: string[] } | null
  pendingExists: boolean
}

export function authorizeConfirm(input: ConfirmInput): ConfirmDecision {
  if (!input.actorId || input.actorId !== input.actorId.trim()) {
    return { ok: false, code: 'invalid_actor', reason: '操作者身份无效' }
  }
  // 无登记 = 无法证明主人是谁 → fail-closed（Spec #41：权限判断始终 fail-closed）。
  if (!input.ownerId) {
    return { ok: false, code: 'not_owner', reason: '该成员无主人登记，拒绝确认（fail-closed）' }
  }
  if (!input.group) {
    return { ok: false, code: 'unknown_group', reason: '群不存在或本机不认识该群' }
  }
  if (!input.group.members.includes(input.actorId)) {
    return { ok: false, code: 'not_member', reason: '操作者不是该群成员' }
  }
  if (!input.pendingExists) {
    return { ok: false, code: 'no_pending', reason: '该成员没有待确认的 pending' }
  }
  if (input.ownerId !== input.actorId && !input.confirmGrants.includes(input.actorId)) {
    return { ok: false, code: 'not_owner', reason: '只有成员主人或被放权者可以按确认键' }
  }
  return { ok: true }
}

export interface GrantInput {
  actorId: string
  targetId: string
  ownerId: string | undefined
  /** 底座群视图（含 ownerId 字段 = 群主；确认键放权是成员主人权限，不是群主权限）。 */
  group: { members: string[] } | null
  grant: boolean
  alreadyGranted: boolean
}

/** 主人逐人放权 / 收权。放权给的是「按」的权力，不免审（每次确认仍走 authorizeConfirm）。 */
export function authorizeGrant(input: GrantInput): ConfirmDecision {
  if (!input.actorId || !input.targetId) {
    return { ok: false, code: 'invalid_actor', reason: '操作者或目标身份无效' }
  }
  if (!input.ownerId) {
    return { ok: false, code: 'not_owner', reason: '该成员无主人登记，拒绝放权（fail-closed）' }
  }
  if (input.ownerId !== input.actorId) {
    return { ok: false, code: 'not_owner', reason: '只有成员主人可以放权' }
  }
  if (!input.group || !input.group.members.includes(input.targetId)) {
    return { ok: false, code: 'not_member', reason: '被放权者不是该群成员' }
  }
  if (input.grant && input.alreadyGranted) {
    return { ok: false, code: 'invalid_actor', reason: '该成员已被放权' }
  }
  return { ok: true }
}

export function setGoal(file: PendingStoreFile, goal: SessionGoal): PendingStoreFile {
  const goals = file.goals.filter((g) => !(g.memberId === goal.memberId && g.groupId === goal.groupId))
  goals.push(goal)
  return { ...file, goals }
}

export function goalOf(file: PendingStoreFile, memberId: string, groupId: string): SessionGoal | undefined {
  return file.goals.find((g) => g.memberId === memberId && g.groupId === groupId)
}
