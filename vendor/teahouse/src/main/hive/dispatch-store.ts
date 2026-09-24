// Hive 派遣账本（#51）：slot 表、派遣关系、待领取任务的持久化与事件结算。
//
// 边界（docs/contracts/parallel-development.md 状态所有者表）：
// - 「派遣关系 / slot / 深度 / 并发计数」唯一写者是本模块（#51 创建、#56 递归、#54 回收释放）；
// - 「待领取任务（claimable）」由本模块落状态（#51 的 spawn 失败只发转换命令）；
// - Hive 侧独立账本，绝不进上游 schema（迁移规则 4）；带 schemaVersion（迁移规则 1）。
//
// 编排（身份生成 → invite → spawn → health 校验）在 dispatch.ts；本文件只管状态。
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJson } from '../util/atomic-write'

export const DISPATCH_SCHEMA_VERSION = 1

/** 派遣深度：活跃链代数，常驻派遣者=1；默认上限 3（Spec #41，可配置）。 */
export const DEFAULT_MAX_DEPTH = 3
/** 派遣并发：一次最多摇进几个成员；默认 5。与深度独立相乘。 */
export const DEFAULT_DISPATCH_CONCURRENCY = 5
/** 单成员一次派遣占用连续的端口段（udp/tcp/api 各占 3 个，与 launcher 的 stride 口径一致）。 */
export const SLOT_STRIDE = 100
/** slot 段内相对偏移：udp=+0 tcp=+1 api=+2（与 hive-launcher/hive-member-e2e 的编号一致）。 */
export const SLOT_OFFSETS = { udp: 0, tcp: 1, api: 2 } as const

export type ClaimableStatus = 'claimable' | 'claimed' | 'cancelled'

export interface ClaimableTask {
  /** = 派遣尝试 id（dispatchId）：一次派遣结算失败即转一条待领取任务。 */
  dispatchId: string
  groupId: string
  dispatcherId: string
  /** 会话目标一句话（给接手者的原始目标，不注入任何父会话历史）。 */
  goalOneLine: string
  /** 失败成员的 nodeId（spawn 失败时是预生成身份；异常退群 #59 会补写）。 */
  failedMemberId?: string
  /** 失败原因（显式报告，不静默）。 */
  reason: string
  status: ClaimableStatus
  createdAt: number
  claimedAt?: number
}

export interface DispatchRecord {
  dispatchId: string
  groupId: string
  dispatcherId: string
  /** 派出的成员 nodeId（= 预生成身份）。 */
  memberIds: string[]
  goalOneLine: string
  /** 派遣者当前深度（派出后孩子 = 深度 + 1）。 */
  depth: number
  /**
   * 本机子进程 pid（与 memberIds 一一对齐；#59 猝死探活的判据）。
   * 只增可选字段（迁移规则 1）：旧账本没有这一列 = 不参与探活，不会被误判猝死。
   */
  pids?: number[]
  /** 本机端口 slot（首次预留段；1:N 时 = slots[0]，保留单值面给既有读者）。 */
  slot: number
  /** 本次派遣预留的全部 slot 段（#56 新增；1:1 时长度为 1）。回收时逐段归还。 */
  slots?: number[]
  /** 新成员 userData 目录（slot 归还时同步清理判断用，MVP 只记录不清理）。 */
  userDataDir: string
  startedAt: number
  /**
   * `started` = 有成员在线（**唯一**「该成员此刻该活着」的凭据，猝死探活据此判定）；
   * `settled` = 派出的成员已全部正常终结（正常退群 / 回收）；
   * `failed` = spawn 没起来（整批）；`claimable` = 成员全挂、任务已转待领取。
   */
  outcome: 'started' | 'settled' | 'failed' | 'claimable'
  reason?: string
}

export interface DispatchStateFile {
  schemaVersion: number
  /** 已借出的 slot（1..maxSlot）：借出期间端口段独占，回收后归还。 */
  slots: number[]
  nextSlot: number
  maxSlot: number
  /** 活跃派遣深度上限（可配置，默认 3）。 */
  maxDepth: number
  /** 一次派遣并发上限（可配置，默认 5）。 */
  maxConcurrency: number
  dispatches: DispatchRecord[]
  claimable: ClaimableTask[]
}

function emptyState(): DispatchStateFile {
  return {
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    slots: [],
    nextSlot: 1,
    maxSlot: 64,
    maxDepth: DEFAULT_MAX_DEPTH,
    maxConcurrency: DEFAULT_DISPATCH_CONCURRENCY,
    dispatches: [],
    claimable: []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 容错解析：坏条目丢弃而不是让整本账失效（本机账本，宁可少一条也不能崩）。 */
export function parseDispatchState(raw: unknown): DispatchStateFile {
  const state = emptyState()
  if (!isRecord(raw)) return state
  if (typeof raw.maxSlot === 'number' && raw.maxSlot >= 1) state.maxSlot = raw.maxSlot
  if (typeof raw.maxDepth === 'number' && raw.maxDepth >= 1) state.maxDepth = raw.maxDepth
  if (typeof raw.maxConcurrency === 'number' && raw.maxConcurrency >= 1) {
    state.maxConcurrency = raw.maxConcurrency
  }
  if (Array.isArray(raw.slots)) {
    state.slots = raw.slots.filter((s): s is number => typeof s === 'number' && s >= 1)
  }
  if (Array.isArray(raw.dispatches)) {
    state.dispatches = raw.dispatches.filter((d) => {
      if (!isRecord(d)) return false
      return (
        typeof d.dispatchId === 'string' &&
        typeof d.groupId === 'string' &&
        typeof d.dispatcherId === 'string' &&
        Array.isArray(d.memberIds)
      )
    }) as DispatchRecord[]
  }
  if (Array.isArray(raw.claimable)) {
    state.claimable = raw.claimable.filter((t) => {
      if (!isRecord(t)) return false
      return typeof t.dispatchId === 'string' && typeof t.groupId === 'string'
    }) as ClaimableTask[]
  }
  if (typeof raw.nextSlot === 'number' && raw.nextSlot >= 1) {
    // nextSlot 永远指向一个未被借出的 slot（借出列表里的不算）。
    state.nextSlot = state.slots.includes(raw.nextSlot)
      ? state.slots.reduce((a, b) => Math.max(a, b), 0) + 1
      : raw.nextSlot
  }
  return state
}

/**
 * slot → 本机端口段（udp/tcp/api）。
 *
 * `depth` = **本节点自己的**派遣深度：递归派遣时子成员与祖父在**同一台机**上各有一本
 * slot 账，两本账的 slot 1 会算出同一段端口（后起的那个静默绑不上，看起来像 spawn 随机失败）。
 * 故按代数错开 10000 的端口带：深度 1 恒为 17878 起（与 #51 口径一致），深度 d 的节点用
 * 17878 + (d-1)×10000 起。一台上最多 31 个成员、每成员 100 段 → 单带 6400 段绰绰有余。
 */
export function portsForSlot(
  slot: number,
  depth = 1
): { udp: number; tcp: number; api: number } {
  const band = 17878 + Math.max(0, depth - 1) * 10_000
  const base = band + slot * SLOT_STRIDE
  return { udp: base + SLOT_OFFSETS.udp, tcp: base + SLOT_OFFSETS.tcp, api: base + SLOT_OFFSETS.api }
}

/** 深度门槛：派遣者深度 +1 超上限 ⇒ 不能再派（Spec #41「深度达上限者不能再派」）。 */
export function depthExceeded(state: DispatchStateFile, dispatcherDepth: number): boolean {
  return dispatcherDepth + 1 > state.maxDepth
}

/** 并发门槛：本次要摇的数量超上限 ⇒ 拒绝（显式失败，不静默降级）。 */
export function concurrencyExceeded(state: DispatchStateFile, count: number): boolean {
  return count > state.maxConcurrency
}

/**
 * 借一批 slot（1:N 派遣，#56）：线性找 count 个空位；不足 = 本机 slot 表满
 * （64 个，资源不足显式失败——Spec #41「不设机器级硬成员上限；资源不足显式报告派遣失败」）。
 *
 * 必须整批预留：1:N 一次要用 count 段端口，「只留第一段」会让下一次派遣抢到同段
 * 端口（同一台机上两个成员绑同一端口 → 后起的那个静默起不来）。
 */
export function acquireSlots(state: DispatchStateFile, count: number): number[] | null {
  const picked: number[] = []
  for (let slot = 1; slot <= state.maxSlot && picked.length < count; slot += 1) {
    if (!state.slots.includes(slot)) picked.push(slot)
  }
  if (picked.length < count) return null
  state.slots.push(...picked)
  state.nextSlot = state.slots.includes(state.nextSlot)
    ? state.slots.reduce((a, b) => Math.max(a, b), 0) + 1
    : state.nextSlot
  return picked
}

/** 借一个 slot（1:1 便捷形）。 */
export function acquireSlot(state: DispatchStateFile): number | null {
  const slots = acquireSlots(state, 1)
  return slots ? slots[0] : null
}

export function releaseSlot(state: DispatchStateFile, slot: number): void {
  state.slots = state.slots.filter((s) => s !== slot)
  if (slot < state.nextSlot) state.nextSlot = slot
}

/** 批量归还（1:N 部分失败时逐段归还，#56）。 */
export function releaseSlots(state: DispatchStateFile, slots: number[]): void {
  for (const slot of slots) releaseSlot(state, slot)
}

export function recordDispatch(state: DispatchStateFile, record: DispatchRecord): void {
  state.dispatches = state.dispatches.filter((d) => d.dispatchId !== record.dispatchId)
  state.dispatches.push(record)
}

export function recordClaimable(state: DispatchStateFile, task: ClaimableTask): void {
  state.claimable = state.claimable.filter((t) => t.dispatchId !== task.dispatchId)
  state.claimable.push(task)
}

export function claimTask(state: DispatchStateFile, dispatchId: string): ClaimableTask | null {
  const task = state.claimable.find((t) => t.dispatchId === dispatchId && t.status === 'claimable')
  if (!task) return null
  task.status = 'claimed'
  task.claimedAt = Date.now()
  return task
}

/** 派遣关系一条边：dispatcher 把 member 摇进群（父 → 子）。 */
export interface DispatchEdge {
  dispatcherId: string
  memberId: string
}

/** 从派遣记录里还原全部活跃父子边（只取 started 的，failed/claimable 无成员上线）。 */
export function dispatchEdges(state: DispatchStateFile): DispatchEdge[] {
  const edges: DispatchEdge[] = []
  for (const record of state.dispatches) {
    if (record.outcome !== 'started') continue
    for (const memberId of record.memberIds) {
      edges.push({ dispatcherId: record.dispatcherId, memberId })
    }
  }
  return edges
}

/**
 * 父退群后子挂靠**最近活跃祖先**（#56 AC4 / ADR-0007；一路无祖先兜底主人）。
 *
 * 沿父链上溯直到第一个仍活跃的节点：活跃 = 在 `activeIds` 里。父自己就是被回收者时
 * 从**祖父**开始找；找不到任何活跃祖先 = 返回 `fallbackId`（主人或群中心）。
 * 纯函数：输入 `edges` + `activeIds`，不改任何状态。
 */
export function reanchor(
  edges: DispatchEdge[],
  removedId: string,
  activeIds: Set<string>,
  fallbackId: string
): { memberId: string; from: string; to: string }[] {
  const parentOf = new Map<string, string>()
  for (const edge of edges) {
    if (!parentOf.has(edge.memberId)) parentOf.set(edge.memberId, edge.dispatcherId)
  }
  const reanchored: { memberId: string; from: string; to: string }[] = []
  for (const edge of edges) {
    if (edge.dispatcherId !== removedId) continue
    // 从这个孩子的祖父开始上溯，跳过刚被回收的父。
    let cursor = parentOf.get(removedId) ?? ''
    let resolved = ''
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      if (activeIds.has(cursor)) {
        resolved = cursor
        break
      }
      cursor = parentOf.get(cursor) ?? ''
    }
    if (resolved === '') resolved = fallbackId
    reanchored.push({ memberId: edge.memberId, from: removedId, to: resolved })
  }
  return reanchored
}

/**
 * 深度重算（#56 AC4）：活跃链代数 = 从根往下数，根（无父 / 父已不在活跃集）= 深度 1。
 * 跳级挂靠后子成员深度随之重算，而不是留在原先的绝对代数上。
 */
export function recomputeDepths(edges: DispatchEdge[], activeIds: Set<string>): Map<string, number> {
  const parentOf = new Map<string, string>()
  for (const edge of edges) {
    if (parentOf.has(edge.memberId)) continue
    if (!activeIds.has(edge.dispatcherId)) continue // 父已不活跃 = 这条边已由 reanchor 换掉
    parentOf.set(edge.memberId, edge.dispatcherId)
  }
  const depths = new Map<string, number>()
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 1 // 环（不该出现）→ 当作根，绝不死循环
    seen.add(id)
    const parent = parentOf.get(id)
    const depth = parent === undefined ? 1 : depthOf(parent, seen) + 1
    depths.set(id, depth)
    return depth
  }
  for (const id of activeIds) depthOf(id, new Set())
  return depths
}

/** 派遣链上某个成员的当前活跃挂靠父（无 = 根 / 主人）；供网络图悬停面与 #54 用。 */
export function activeParent(edges: DispatchEdge[], memberId: string, activeIds: Set<string>): string | null {
  for (const edge of edges) {
    if (edge.memberId === memberId && activeIds.has(edge.dispatcherId)) return edge.dispatcherId
  }
  return null
}

export interface DispatchStoreOptions {
  /** 账本文件绝对路径（userData/hive/dispatch.json）。 */
  path: string
  maxDepth?: number
  maxConcurrency?: number
  maxSlot?: number
  now?: () => number
}

/**
 * 派遣账本。进程内一份 + 原子落盘（AC6「派遣关系、slot 和待领取状态可持久化」）；
 * 读不重灌磁盘（本模块是唯一写者，不存在外部写入路径）。
 */
export class DispatchStore {
  private state: DispatchStateFile
  private readonly path: string
  private readonly now: () => number

  constructor(options: DispatchStoreOptions) {
    this.path = options.path
    this.now = options.now ?? (() => Date.now())
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(options.path, 'utf8'))
    } catch {
      /* 缺文件 = 空账本（首次启动） */
    }
    this.state = parseDispatchState(raw)
    if (options.maxDepth) this.state.maxDepth = options.maxDepth
    if (options.maxConcurrency) this.state.maxConcurrency = options.maxConcurrency
    if (options.maxSlot) this.state.maxSlot = options.maxSlot
  }

  snapshot(): DispatchStateFile {
    return JSON.parse(JSON.stringify(this.state)) as DispatchStateFile
  }

  /**
   * 新派遣前的前置校验与 slot 借用；任何拒绝都显式给原因（不静默）。
   * 1:N 时整批预留 count 段端口（#56）：不足则整批拒绝，不留半批占用。
   */
  begin(input: {
    dispatchId: string
    groupId: string
    dispatcherId: string
    dispatcherDepth: number
    count: number
  }): { ok: true; slot: number; slots: number[] } | { ok: false; reason: string } {
    if (depthExceeded(this.state, input.dispatcherDepth)) {
      return { ok: false, reason: `派遣深度超上限（当前 ${input.dispatcherDepth}，上限 ${this.state.maxDepth}）` }
    }
    if (concurrencyExceeded(this.state, input.count)) {
      return { ok: false, reason: `单次并发超上限（请求 ${input.count}，上限 ${this.state.maxConcurrency}）` }
    }
    const slots = acquireSlots(this.state, input.count)
    if (slots === null) {
      return { ok: false, reason: '本机端口 slot 已用尽，资源不足（显式失败，不静默降级）' }
    }
    this.flush()
    return { ok: true, slot: slots[0]!, slots }
  }

  /** 派遣成功结算：记 started + 占住的 slot 与 userData 目录。 */
  settleStarted(record: Omit<DispatchRecord, 'startedAt' | 'outcome'>): DispatchRecord {
    const full: DispatchRecord = { ...record, startedAt: this.now(), outcome: 'started' }
    recordDispatch(this.state, full)
    this.flush()
    return full
  }

  /** 未产出成员的预留段整批归还（1:N 派遣里这些段没被真正用上，#56）。 */
  releaseReserved(slots: number[]): void {
    if (slots.length === 0) return
    releaseSlots(this.state, slots)
    this.flush()
  }

  /** 派遣失败结算（重试也失败后）：slot 归还、任务转待领取、记 failed 轨迹。 */
  settleFailed(
    record: Omit<DispatchRecord, 'startedAt' | 'outcome'>,
    reason: string,
    /** 待领取任务的 key（1:N 里每个失败成员各一条，须互不相同；缺省 = 整批一条）。 */
    taskId?: string,
    /**
     * 失败成员的 nodeId（预生成身份）。**不能拿 `record.memberIds[0]` 顶替**：
     * 1:N 部分失败时 memberIds 是**成功**的成员，用它会让待领取任务指向一个活着的成员。
     */
    failedMemberId?: string,
    /**
     * 整条覆盖已 `started` 的记录（#58 重启恢复用）。
     *
     * 缺省 **false**：1:N 部分失败时本 dispatchId 可能已有成功成员上线（记录 = started），
     * 整条覆盖成 failed 会把活成员的 `memberIds`/`pids`/`slots` 一起冲掉 —— 网络图丢边、
     * #59 的猝死探活也再看不到它们。只有恢复路径（那些成员确实已随上次退出消失）才传 true。
     */
    options?: { replaceStarted?: boolean }
  ): ClaimableTask {
    releaseSlots(this.state, record.slots ?? [record.slot])
    const existing = this.state.dispatches.find((d) => d.dispatchId === record.dispatchId)
    if (existing?.outcome === 'started' && options?.replaceStarted !== true) {
      existing.reason = reason
    } else {
      recordDispatch(this.state, { ...record, startedAt: this.now(), outcome: 'failed', reason })
    }
    const task: ClaimableTask = {
      dispatchId: taskId ?? record.dispatchId,
      groupId: record.groupId,
      dispatcherId: record.dispatcherId,
      goalOneLine: record.goalOneLine,
      ...(failedMemberId ? { failedMemberId } : {}),
      reason,
      status: 'claimable',
      createdAt: this.now()
    }
    recordClaimable(this.state, task)
    this.flush()
    return task
  }

  /**
   * 成员级**正常**终结（#59）：成员正常退群 / 被回收 → 从账本里摘掉它，不再算活跃派遣。
   *
   * 为什么必须有：`outcome='started'` 是「这个成员此刻该活着」的唯一凭据。#59 的猝死探活
   * 只看「outcome=started 且 pid 不在」——若正常退群不回写账本，成员进程一退出就会被下一拍
   * （≤1s）判成**猝死**：群里冒出假的 `⚠ 异常退群`、生成针对已归档成员的幽灵待领取任务，
   * 与 AC2「正常退群与异常退群消息明确不同」直接冲突。
   *
   * 与 `markAbnormal` 的区别只在**要不要转待领取**：正常终结是任务已交付，不落待领取。
   * 幂等：记录不是 started、或 memberIds 里已无此人 → 返回 false。
   */
  markSettled(input: { dispatchId: string; memberId: string }): boolean {
    const record = this.state.dispatches.find((d) => d.dispatchId === input.dispatchId)
    if (!record || record.outcome !== 'started') return false
    const index = record.memberIds.indexOf(input.memberId)
    if (index < 0) return false

    const freedSlot = record.slots?.[index] ?? (record.memberIds.length === 1 ? record.slot : undefined)
    record.memberIds = record.memberIds.filter((id) => id !== input.memberId)
    if (record.slots) record.slots = record.slots.filter((_, i) => i !== index)
    if (record.pids) record.pids = record.pids.filter((_, i) => i !== index)
    if (freedSlot !== undefined) releaseSlot(this.state, freedSlot)
    // 整批成员都已终结 → 这条记录不再代表任何活跃派遣（不伪装活跃）。
    if (record.memberIds.length === 0) record.outcome = 'settled'
    else record.slot = record.slots?.[0] ?? record.slot
    this.flush()
    return true
  }

  /** 按成员查它的派遣记录（跨批次）；正常终结时用来定位 dispatchId。 */
  recordForMember(memberId: string): DispatchRecord | null {
    return this.state.dispatches.find((d) => d.outcome === 'started' && d.memberIds.includes(memberId)) ?? null
  }

  /**
   * 异常退群结算（#59）：派遣成员**上线之后**进程猝死 → 任务转待领取 + slot 归还。
   *
   * 与 `settleFailed`（spawn 没起来）分开：这里成员曾经上线过，失败来自运行期进程消失；
   * 与「正常回收」分开：没交回交接文档就退 = **异常**（PRD ④）。
   * 幂等：record 已不是 started、或 memberIds 里已无此人 → 返回 null，不重复落账。
   *
   * `slots` / `pids` 与 `memberIds` **逐位对齐**，故按 index 摘除（#56 部分失败路径已保证对齐）。
   */
  markAbnormal(input: { dispatchId: string; memberId: string; reason: string }): ClaimableTask | null {
    const record = this.state.dispatches.find((d) => d.dispatchId === input.dispatchId)
    if (!record || record.outcome !== 'started') return null
    const index = record.memberIds.indexOf(input.memberId)
    if (index < 0) return null

    // slot 与 pid 逐位摘除；slots 可能比 memberIds 短（旧账本 / 部分失败），越界即跳过。
    const freedSlot = record.slots?.[index] ?? (record.memberIds.length === 1 ? record.slot : undefined)
    record.memberIds = record.memberIds.filter((id) => id !== input.memberId)
    if (record.slots) record.slots = record.slots.filter((_, i) => i !== index)
    if (record.pids) record.pids = record.pids.filter((_, i) => i !== index)
    if (freedSlot !== undefined) releaseSlot(this.state, freedSlot)
    // 整批只剩这一个成员时，record 自己也不再代表任何活跃成员（回落到单值 slot 面）。
    if (record.memberIds.length === 0) record.outcome = 'claimable'
    else record.slot = record.slots?.[0] ?? record.slot

    const task: ClaimableTask = {
      dispatchId: `${input.dispatchId}-${input.memberId}`,
      groupId: record.groupId,
      dispatcherId: record.dispatcherId,
      goalOneLine: record.goalOneLine,
      failedMemberId: input.memberId,
      reason: input.reason,
      status: 'claimable',
      createdAt: this.now()
    }
    recordClaimable(this.state, task)
    this.flush()
    return task
  }

  /** 当前全部活跃派遣边（父 → 子）；网络图与挂靠重算的输入面（#56 / #57）。 */
  edges(): DispatchEdge[] {
    return dispatchEdges(this.state)
  }

  /** 某成员的派遣记录（含原始目标）；事件面与网络图悬停面用（#56）。 */
  recordFor(memberId: string): DispatchRecord | null {
    return this.state.dispatches.find((d) => d.memberIds.includes(memberId)) ?? null
  }

  listClaimable(): ClaimableTask[] {
    return this.state.claimable.filter((t) => t.status === 'claimable').map((t) => ({ ...t }))
  }

  /** #54：按成员找最近一笔 started 派遣记录（回收时取 slot / goalOneLine / depth）。 */
  recordOfMember(memberId: string): DispatchRecord | null {
    const hits = this.state.dispatches.filter(
      (d) => d.outcome === 'started' && d.memberIds.includes(memberId)
    )
    const last = hits[hits.length - 1]
    return last ? { ...last } : null
  }

  /**
   * #54 回收释放（契约表「#51 创建、#56 递归、#54 回收释放」的落点）：
   * 按成员的最近 started 记录归还 slot。无记录 / slot 已释放 = no-op（幂等）。
   */
  releaseMemberSlot(memberId: string): boolean {
    const record = this.recordOfMember(memberId)
    if (!record || !this.state.slots.includes(record.slot)) return false
    releaseSlot(this.state, record.slot)
    this.flush()
    return true
  }

  claim(dispatchId: string): ClaimableTask | null {
    const task = claimTask(this.state, dispatchId)
    if (task) this.flush()
    return task
  }

  /**
   * 把一条**已领取但没能补派出去**的任务放回待领取（#59）。
   *
   * 为什么需要：`claimAndDispatch` 是「先 claim 再摇人」——若新派遣被**前置拒绝**
   * （深度/并发/slot 用尽），既没有 settleStarted 也没有 settleFailed，任务会卡在 claimed
   * 且无人再能补派（幽灵任务，AC4「UI 与持久化任务状态一致」的反面）。这里把它放回去，
   * 帐面上始终留着这条任务等人处理。
   */
  unclaim(dispatchId: string): ClaimableTask | null {
    const task = this.state.claimable.find((t) => t.dispatchId === dispatchId && t.status === 'claimed')
    if (!task) return null
    task.status = 'claimable'
    delete task.claimedAt
    this.flush()
    return { ...task }
  }

  private flush(): void {
    try {
      atomicWriteJson(this.path, this.state)
    } catch (err) {
      console.error('[hive] 派遣账本落盘失败：', err)
    }
  }

  /** 账本目录预创建（userData/hive 可能还不存在）。 */
  ensureDir(): void {
    mkdirSync(dirname(this.path), { recursive: true })
  }
}
