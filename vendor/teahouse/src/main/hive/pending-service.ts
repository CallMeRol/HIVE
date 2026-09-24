// pending 服务（#50）：pending-core 状态机 + 本机 JSON 落盘 + SSE `pending.updated`。
//
// 形状对齐 member-registry.ts（本机账本，`schemaVersion`，坏数据丢弃不崩）。
// 持久化：`<userData>/hive/pending.json`（owner：本文件；#58 重启恢复按所有者表读它）。
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { atomicWriteJson } from '../util/atomic-write'
import {
  GOAL_TEXT_MAX_BYTES,
  PENDING_SCHEMA_VERSION,
  appendEntry,
  authorizeConfirm,
  authorizeGrant,
  composeAggregatePrompt,
  dropPending,
  goalOf,
  parsePendingStore,
  setGoal,
  upsertPending,
  type ConfirmDenyCode,
  type PendingDraft,
  type PendingEntry,
  type PendingStoreFile,
  type SessionGoal
} from './pending-core'

/** SSE `pending.updated` data（契约表冻结字段：memberId, goal, entries[], waitingConfirm, confirmedBy?）。 */
export interface PendingUpdateData {
  memberId: string
  /** 目标一句话（未冻结时 = 聚合草稿首条，未定则空串）。 */
  goal: string
  /** 已收集留言数。 */
  entries: number
  waitingConfirm: boolean
  confirmedBy?: string
}

export interface PendingServiceOptions {
  /** 落盘路径（`<userData>/hive/pending.json`）。 */
  path: string
  now?: () => number
  log?: (line: string) => void
}

/** 确认动作的完整出参：授权通过时带聚合 prompt，供 bridge 发送一次。 */
export interface ConfirmOutcome {
  ok: boolean
  code?: ConfirmDenyCode
  reason?: string
  prompt?: string
  goalText?: string
}

export interface PendingAuditEntry {
  ts: number
  action: 'confirm' | 'drop' | 'grant' | 'revoke' | 'freeze_goal' | 'entry'
  result: 'ok' | 'denied'
  actorId: string
  memberId: string
  groupId: string
  code?: string
  reason?: string
}

export class PendingService extends EventEmitter {
  private file: PendingStoreFile
  private readonly path: string
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly auditPath: string

  constructor(options: PendingServiceOptions) {
    super()
    this.path = options.path
    this.auditPath = join(dirname(options.path), 'pending-audit.jsonl')
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? ((line: string) => console.log(line))
    this.file = parsePendingStore(this.readSeed())
  }

  private readSeed(): unknown {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return null
    }
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      atomicWriteJson(this.path, this.file)
    } catch (err) {
      console.error('[hive] pending 落盘失败：', err)
    }
  }

  private recordAudit(entry: Omit<PendingAuditEntry, 'ts'>): void {
    const line = JSON.stringify({ v: PENDING_SCHEMA_VERSION, ts: this.now(), ...entry })
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true })
      appendFileSync(this.auditPath, `${line}\n`, 'utf8')
    } catch (err) {
      console.error('[hive] pending 留痕失败：', err)
    }
  }

  // ---------- 查询 ----------

  get(memberId: string): PendingDraft | undefined {
    return this.file.pendings.find((p) => p.memberId === memberId)
  }

  list(): PendingDraft[] {
    return this.file.pendings.map((p) => ({ ...p, entries: [...p.entries] }))
  }

  goal(memberId: string, groupId: string): SessionGoal | undefined {
    return goalOf(this.file, memberId, groupId)
  }

  grants(): string[] {
    return [...this.file.confirmGrants]
  }

  /** 全量目标视图（#50 GUI 目标徽标 / #55 守卫只读判定用）。 */
  allGoals(): SessionGoal[] {
    return this.file.goals.map((g) => ({ ...g }))
  }

  /** SSE 投影：pending 或 goal 变化后都推一份（渲染层药丸 + 目标状态徽标共用）。 */
  emitUpdate(memberId: string, confirmedBy?: string): void {
    const draft = this.get(memberId)
    const goal = draft ? this.goal(memberId, draft.groupId) : undefined
    const data: PendingUpdateData = {
      memberId,
      goal: goal?.text ?? '',
      entries: draft?.entries.length ?? 0,
      waitingConfirm: Boolean(draft),
      ...(confirmedBy ? { confirmedBy } : {})
    }
    this.emit('pending.updated', data)
    this.log(`[pending] ${memberId} entries=${data.entries} waiting=${data.waitingConfirm}`)
  }

  // ---------- 写入面（权限由调用方在 confirm/grant 内判定） ----------

  /** 开一个 pending（每成员最多一个；重复调用覆盖为同一空 pending 的语义是「重开」，由调用方避免）。 */
  open(draft: Omit<PendingDraft, 'createdAt'> & { createdAt?: number }): PendingDraft {
    const full: PendingDraft = { ...draft, createdAt: draft.createdAt ?? this.now() }
    this.file = upsertPending(this.file, full)
    this.flush()
    this.emitUpdate(draft.memberId)
    return full
  }

  /** 往 pending 里加一条留言；无 pending 或超限 = null（调用方决定是否反馈）。 */
  addEntry(memberId: string, entry: PendingEntry): PendingEntry | null {
    const next = appendEntry(this.file, memberId, entry)
    if (!next) return null
    this.file = next
    this.flush()
    this.emitUpdate(memberId)
    return entry
  }

  /** 主人丢弃 pending（唯一出口之二）。 */
  drop(memberId: string, actorId: string, groupId: string): boolean {
    const existed = Boolean(this.get(memberId))
    if (existed) {
      this.file = dropPending(this.file, memberId)
      this.flush()
      this.emitUpdate(memberId)
    }
    this.recordAudit({
      action: 'drop',
      result: 'ok',
      actorId,
      memberId,
      groupId,
      ...(existed ? {} : { reason: 'no_pending' })
    })
    return existed
  }

  /**
   * 确认键：授权判定（fail-closed）→ 聚合为一条 prompt → 清空 pending → 冻结会话目标。
   * 「恰好发送一次」由返回 prompt 的调用方（bridge）保证：prompt 只在这里产出一份。
   */
  confirm(input: {
    actorId: string
    memberId: string
    ownerId: string | undefined
    group: { members: string[] } | null
    /** 确认时修订/确认的目标文本；空 = 用聚合 prompt 首条。 */
    goalText?: string
  }): ConfirmOutcome {
    const draft = this.get(input.memberId)
    const decision = authorizeConfirm({
      actorId: input.actorId,
      ownerId: input.ownerId,
      confirmGrants: this.file.confirmGrants,
      group: input.group,
      pendingExists: Boolean(draft)
    })
    if (!decision.ok || !draft) {
      this.recordAudit({
        action: 'confirm',
        result: 'denied',
        actorId: input.actorId,
        memberId: input.memberId,
        groupId: draft?.groupId ?? '',
        ...(decision.code ? { code: decision.code } : {}),
        ...(decision.reason ? { reason: decision.reason } : {})
      })
      return { ok: false, ...(decision.code ? { code: decision.code } : {}), ...(decision.reason ? { reason: decision.reason } : {}) }
    }
    const prompt = composeAggregatePrompt(draft)
    const goalText =
      (input.goalText ?? '').trim().slice(0, GOAL_TEXT_MAX_BYTES) ||
      draft.entries[0]?.text.slice(0, GOAL_TEXT_MAX_BYTES) ||
      prompt.slice(0, GOAL_TEXT_MAX_BYTES)
    this.file = dropPending(this.file, input.memberId)
    this.file = setGoal(this.file, {
      memberId: input.memberId,
      groupId: draft.groupId,
      state: 'frozen',
      text: goalText,
      frozenBy: input.actorId,
      frozenAt: this.now()
    })
    this.flush()
    this.recordAudit({
      action: 'confirm',
      result: 'ok',
      actorId: input.actorId,
      memberId: input.memberId,
      groupId: draft.groupId
    })
    this.emitUpdate(input.memberId, input.actorId)
    return { ok: true, prompt, goalText }
  }

  /** 主人逐人放权 / 收权。 */
  grant(input: {
    actorId: string
    targetId: string
    ownerId: string | undefined
    group: { members: string[] } | null
    grant: boolean
    groupId: string
  }): ConfirmOutcome {
    const decision = authorizeGrant({
      actorId: input.actorId,
      targetId: input.targetId,
      ownerId: input.ownerId,
      group: input.group,
      grant: input.grant,
      alreadyGranted: this.file.confirmGrants.includes(input.targetId)
    })
    if (!decision.ok) {
      this.recordAudit({
        action: input.grant ? 'grant' : 'revoke',
        result: 'denied',
        actorId: input.actorId,
        memberId: input.targetId,
        groupId: input.groupId,
        ...(decision.code ? { code: decision.code } : {}),
        ...(decision.reason ? { reason: decision.reason } : {})
      })
      return { ok: false, ...(decision.code ? { code: decision.code } : {}), ...(decision.reason ? { reason: decision.reason } : {}) }
    }
    this.file = {
      ...this.file,
      confirmGrants: input.grant
        ? [...new Set([...this.file.confirmGrants, input.targetId])]
        : this.file.confirmGrants.filter((id) => id !== input.targetId)
    }
    this.flush()
    this.recordAudit({
      action: input.grant ? 'grant' : 'revoke',
      result: 'ok',
      actorId: input.actorId,
      memberId: input.targetId,
      groupId: input.groupId
    })
    return { ok: true }
  }

  /** 主人修订/冻结目标（不经过 pending 确认键的独立入口；#50 AC「可修订、确认和冻结会话目标」）。 */
  freezeGoal(input: {
    actorId: string
    memberId: string
    ownerId: string | undefined
    groupId: string
    text: string
  }): ConfirmOutcome {
    if (!input.ownerId || input.ownerId !== input.actorId) {
      this.recordAudit({
        action: 'freeze_goal',
        result: 'denied',
        actorId: input.actorId,
        memberId: input.memberId,
        groupId: input.groupId,
        code: 'not_owner',
        reason: '只有成员主人可以冻结目标'
      })
      return { ok: false, code: 'not_owner', reason: '只有成员主人可以冻结目标' }
    }
    const text = input.text.trim().slice(0, GOAL_TEXT_MAX_BYTES)
    if (!text) {
      return { ok: false, code: 'invalid_actor', reason: '目标文本不能为空' }
    }
    this.file = setGoal(this.file, {
      memberId: input.memberId,
      groupId: input.groupId,
      state: 'frozen',
      text,
      frozenBy: input.actorId,
      frozenAt: this.now()
    })
    this.flush()
    this.recordAudit({
      action: 'freeze_goal',
      result: 'ok',
      actorId: input.actorId,
      memberId: input.memberId,
      groupId: input.groupId
    })
    this.emitUpdate(input.memberId, input.actorId)
    return { ok: true, goalText: text }
  }
}
