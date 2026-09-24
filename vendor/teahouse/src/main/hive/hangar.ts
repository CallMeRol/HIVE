// 机库读取面（#52，ADR-0008「机库 per-member 过程台」）。
//
// 边界（docs/contracts/parallel-development.md 状态所有者表）：
// - **写**归 #46 的 SessionLedger（append-only JSONL + Markdown 时间线）；
//   本模块**只读**，绝不改写历史账本（白名单纪律）。
// - 归档（Archive）= 机库里**已终结实例**的保存态，基本单元 = 会话（agent 实例）。
//   「终结」由 owner 模块（#53 移出 / #54 回收 / 本票 clear）显式调用 `archive()` 落账，
//   不靠推断——CONTEXT「归档」明说「成员行的归属是推论」，故这里只消费显式事件。
// - 索引落 `<artifactsRoot>/hangar/index.json`（本机账本，`schemaVersion`），
//   重启后据此恢复活跃/归档分区（AC3）。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from '../util/atomic-write'
import { PROCESS_UPDATE_KINDS } from '../services/session-ledger'

/** 迁移规则：Hive 侧持久化结构一律带 schemaVersion（整数，起 1）。 */
export const HANGAR_SCHEMA_VERSION = 1

/** 归档原因：clear 掉的旧实例、随回收/移出终结的实例都进归档。 */
export type ArchiveReason = 'clear' | 'reclaim' | 'remove' | 'orphan_removed' | 'abnormal'

export interface SessionSummary {
  sessionId: string
  /** 该会话的最小 ts / 最大 ts（JSONL 首末行）。 */
  startedAt: number
  endedAt: number
  /** turn 结算行的 stopReason（末次）；未结算为 null。 */
  stopReason: string | null
  /** turn 数（kind='turn' 的行数）。 */
  turns: number
  /** 账本行数（含过程与出向）。 */
  lines: number
  /** 过程类型直方图（`sessionUpdate` → 次数），供类型过滤面板直接渲染。 */
  kinds: Record<string, number>
  /** 归档态；null = 仍活跃。 */
  archive: { reason: ArchiveReason; at: number } | null
}

export interface MemberHangar {
  memberId: string
  /** 昵称（可达时由调用方注入；不可达时回退 memberId）。 */
  nick: string
  /** 负担面（#47 的 PeerBurdenView 投影；未启用状态通道时为 null）。 */
  burden: { tag: string; label: string; color: string; pct: number | null; goal: string; role: string; lastActivity: number } | null
  /** 当前实例纪元与目标（AC4；clear 后 `goalPending=true` 等人重定）。 */
  instance: MemberInstance
  /**
   * 派遣深度。**恒为 null**：深度归 #51 的派遣网络；未接入时按 CONTEXT 口径显示「—」，
   * 不猜、不用 0 冒充。
   */
  depth: number | null
  sessions: SessionSummary[]
}

/** 会话目标（CONTEXT「会话目标」）：来源是人的原始派单，clear 后必须由人重定。 */
export interface SessionGoal {
  text: string
  setAt: number
  setBy: string
}

/**
 * 成员的一个**实例**（CONTEXT「会话」：一个成员的一段运行实例）。
 *
 * 纪元语义（AC4）：`clear` 终结旧实例、在同一身份与位置开新实例。会话归属用
 * `startedAt >= since` 判定 —— 判定依据是**本机单调时钟**（同一台机器上的 Date.now()），
 * 不与任何跨机时钟比较。clear 会先归档本实例的全部活跃会话，故不存在跨纪元的会话。
 */
export interface MemberInstance {
  /** 纪元：从 1 起，每次 clear 递增。 */
  epoch: number
  /** 本实例的起点（ms）。 */
  since: number
  /** 当前会话目标；null = 未定 / clear 后被清空。 */
  goal: SessionGoal | null
  /** 目标是否待重定（clear 后为 true，人设定目标后转 false）。 */
  goalPending: boolean
  /** 上次 clear 的时间与执行者（0 / '' = 从未 clear）。 */
  clearedAt: number
  clearedBy: string
}

export function defaultInstance(): MemberInstance {
  return { epoch: 1, since: 0, goal: null, goalPending: false, clearedAt: 0, clearedBy: '' }
}

/** 一行账本（`LedgerEntry` 的读取侧形状）。坏行在解析处丢弃，不让整份时间线失效。 */
export interface TimelineEntry {
  v: number
  kind: string
  ts: number
  data: unknown
  /** 所属会话（读 JSONL 时为文件名，不经 data 推断）。 */
  sessionId: string
}

export interface TimelineQuery {
  memberId: string
  sessionId?: string
  /** 过程类型过滤（`sessionUpdate` 值，或账本 kind：inbound/outbound/verdict/turn）。 */
  kinds?: string[]
  /** 全文搜索（大小写不敏感，匹配 JSONL 原文）；不加工、不总结。 */
  q?: string
  /** 返回条数上限（默认 500；按 ts 升序取前 N 之后仍按 ts 升序）。 */
  limit?: number
}

export interface HangarIndexFile {
  schemaVersion: number
  /** sessionKey → 归档记录。key 用 `memberId/sessionId`，两段都经保守字符集。 */
  archived: Record<string, { reason: ArchiveReason; at: number }>
  /** memberId → 当前实例纪元（AC4 clear 的持久化落点，重启后恢复）。 */
  instances: Record<string, MemberInstance>
}

/** 只允许保守字符集，与 SessionLedger 的 safeSegment 同源纪律（不得把路径带出预期目录）。 */
export function safeSegment(value: string): string {
  const cleaned = String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return cleaned === '' ? 'unknown' : cleaned
}

export function archiveKey(memberId: string, sessionId: string): string {
  return `${safeSegment(memberId)}/${safeSegment(sessionId)}`
}

export function parseHangarIndex(raw: unknown): HangarIndexFile {
  const empty: HangarIndexFile = { schemaVersion: HANGAR_SCHEMA_VERSION, archived: {}, instances: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty
  const record = raw as { archived?: unknown; instances?: unknown }
  return {
    schemaVersion: HANGAR_SCHEMA_VERSION,
    archived: parseArchived(record.archived),
    instances: parseInstances(record.instances)
  }
}

function parseArchived(source: unknown): HangarIndexFile['archived'] {
  const archived: HangarIndexFile['archived'] = {}
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return archived
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (key === '' || key.includes('..')) continue
    if (typeof value !== 'object' || value === null) continue
    const record = value as { reason?: unknown; at?: unknown }
    if (!isArchiveReason(record.reason)) continue
    archived[key] = { reason: record.reason, at: typeof record.at === 'number' ? record.at : 0 }
  }
  return archived
}

function parseInstances(source: unknown): HangarIndexFile['instances'] {
  const instances: HangarIndexFile['instances'] = {}
  if (typeof source !== 'object' || source === null || Array.isArray(source)) return instances
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (key === '' || key.includes('..')) continue
    if (typeof value !== 'object' || value === null) continue
    const record = value as Record<string, unknown>
    const epoch = typeof record['epoch'] === 'number' && record['epoch'] >= 1 ? Math.floor(record['epoch']) : 1
    const goalRaw = record['goal']
    const goal = isRecord(goalRaw) && typeof goalRaw['text'] === 'string' && goalRaw['text'] !== ''
      ? {
          text: goalRaw['text'],
          setAt: typeof goalRaw['setAt'] === 'number' ? goalRaw['setAt'] : 0,
          setBy: typeof goalRaw['setBy'] === 'string' ? goalRaw['setBy'] : ''
        }
      : null
    instances[key] = {
      epoch,
      since: typeof record['since'] === 'number' ? record['since'] : 0,
      goal,
      goalPending: goal === null,
      clearedAt: typeof record['clearedAt'] === 'number' ? record['clearedAt'] : 0,
      clearedBy: typeof record['clearedBy'] === 'string' ? record['clearedBy'] : ''
    }
  }
  return instances
}

export function isArchiveReason(value: unknown): value is ArchiveReason {
  return (
    value === 'clear' ||
    value === 'reclaim' ||
    value === 'remove' ||
    value === 'orphan_removed' ||
    value === 'abnormal'
  )
}

/** JSONL 单行 → 账本条目；坏行/缺字段返回 null（容错：宁可少一条也不能崩）。 */
export function parseLedgerLine(line: string, sessionId: string): TimelineEntry | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as { v?: unknown; kind?: unknown; ts?: unknown; data?: unknown }
  if (typeof record.kind !== 'string') return null
  return {
    v: typeof record.v === 'number' ? record.v : 1,
    kind: record.kind,
    ts: typeof record.ts === 'number' ? record.ts : 0,
    data: record.data,
    sessionId
  }
}

/**
 * 一条账本条目属于哪一类「过滤标签」。过程行（`kind='update'`）向外暴露其
 * `sessionUpdate` 判别值——ADR-0008 的过滤判据是**类型**，UI 要按过程类型过滤，
 * 而不是按账本的存储 kind 过滤。
 */
export function entryTags(entry: TimelineEntry): string[] {
  const tags = [entry.kind]
  if (entry.kind === 'update' && isRecord(entry.data)) {
    const sessionUpdate = entry.data['sessionUpdate']
    if (typeof sessionUpdate === 'string' && sessionUpdate !== '') tags.push(sessionUpdate)
  }
  return tags
}

/** 该条目是否为「过程」（ADR-0008 判据；出向/入向/判定/结算各有自己的标签）。 */
export function isProcessEntry(entry: TimelineEntry): boolean {
  return entryTags(entry).some((tag) => PROCESS_UPDATE_KINDS.has(tag))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 全文匹配：对**原文行**做子串匹配，不加工、不总结（ADR-0008）。 */
export function matchesQuery(line: string, query: string): boolean {
  if (query === '') return true
  return line.toLowerCase().includes(query.toLowerCase())
}

/** 机库根目录：artifacts root 下 `hangar/`。 */
export function hangarRoot(artifactsRoot: string): string {
  return join(artifactsRoot, 'hangar')
}

export function hangarIndexPath(artifactsRoot: string): string {
  return join(hangarRoot(artifactsRoot), 'index.json')
}

/** 会话账本目录：`<artifactsRoot>/sessions/<memberId>/`（与 SessionLedger 同源约定）。 */
export function memberLedgerDir(artifactsRoot: string, memberId: string): string {
  return join(artifactsRoot, 'sessions', safeSegment(memberId))
}

export interface HangarOptions {
  artifactsRoot(): string
  now?(): number
  log?(line: string): void
}

/**
 * 机库读取面 + 归档索引。**单写者**：只有 `archive()` 改索引，其余全是读。
 *
 * 不做轮询、不做缓存——每次查询直读磁盘。理由：机库是审计面（无 TTL、要看到最新），
 * 且单机账本量级（几十个成员 × 几百行）远不到需要索引缓存的规模；
 * 加一层缓存反而会引入「重启后索引与磁盘不一致」这类 AC3 要防的问题。
 */
export class Hangar {
  private readonly log: (line: string) => void
  private readonly now: () => number
  private index: HangarIndexFile | null = null

  constructor(private readonly options: HangarOptions) {
    this.log = options.log ?? ((line: string) => console.log(line))
    this.now = options.now ?? (() => Date.now())
  }

  private root(): string {
    return this.options.artifactsRoot()
  }

  /** 惰性读索引：重启后第一次读时从磁盘恢复（AC3）。 */
  private loadIndex(): HangarIndexFile {
    if (this.index) return this.index
    const path = hangarIndexPath(this.root())
    let raw: unknown = null
    try {
      if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      // 坏索引不致命（历史账本仍在磁盘上）：显式告警，按「尚未归档」继续。
      this.log(`[hangar] 索引读取失败（按空索引继续）：${String((err as Error)?.message ?? err)}`)
    }
    this.index = parseHangarIndex(raw)
    return this.index
  }

  /** 归档一个会话实例（clear / 回收 / 移出 / 异常 终结点调用）。append 语义，不覆盖历史。 */
  archive(memberId: string, sessionId: string, reason: ArchiveReason): void {
    const index = this.loadIndex()
    const key = archiveKey(memberId, sessionId)
    // 已归档不重复改写时间戳：归档是「第一次终结」的事实。
    if (!index.archived[key]) {
      index.archived[key] = { reason, at: this.now() }
      try {
        atomicWriteJson(hangarIndexPath(this.root()), index)
      } catch (err) {
        this.log(`[hangar] 归档索引落盘失败：${String((err as Error)?.message ?? err)}`)
      }
    }
    this.log(`[hangar] 归档会话 ${key}（${reason}）`)
  }

  archiveOf(memberId: string, sessionId: string): { reason: ArchiveReason; at: number } | null {
    return this.loadIndex().archived[archiveKey(memberId, sessionId)] ?? null
  }

  /** 已被归档的全部会话 key（`memberId/sessionId`），供 AC3 分区判定。 */
  archivedKeys(): Set<string> {
    return new Set(Object.keys(this.loadIndex().archived))
  }

  /**
   * 归档该成员**当前实例**的全部活跃会话（clear 的前半步）。
   * 返回被归档的会话 id 列表——clear 的留痕要用，且 GUI 要能说清「旧实例进归档」了哪些。
   */
  archiveActiveSessions(memberId: string, reason: ArchiveReason): string[] {
    const instance = this.instanceOf(memberId)
    const done: string[] = []
    for (const sessionId of this.sessionIds(memberId)) {
      if (!this.isActive(memberId, sessionId, instance)) continue
      this.archive(memberId, sessionId, reason)
      done.push(sessionId)
    }
    return done
  }

  /** 指定会话是否属于**该成员当前实例**（= 未归档）。 */
  isActive(memberId: string, sessionId: string, instance = this.instanceOf(memberId)): boolean {
    if (this.archiveOf(memberId, sessionId)) return false
    const summary = this.sessionSummary(memberId, sessionId)
    if (!summary || summary.lines === 0) return false
    // since=0（尚未记录实例起点）时不禁用；起点之后开始的会话才算本实例。
    // 用 `>=`：clear 的纪元和紧随其后的新会话可能落在同一毫秒（实测会撞），
    // 偏严会误判「刚开的会话已归档」。
    return instance.since === 0 || summary.endedAt >= instance.since
  }

  /** 读某成员的实例状态（未记录时给默认实例，不假装它 clear 过）。 */
  instanceOf(memberId: string): MemberInstance {
    return this.loadIndex().instances[safeSegment(memberId)] ?? defaultInstance()
  }

  /**
   * AC4 clear：**终结旧实例并归档，同一身份位置开新实例，目标由人重定**。
   *
   * 这里只做机库侧的事实登记（归档 + 纪元递增 + 清空目标）；
   * 「同位置开新实例」的进程动作归生命周期 owner（#59）——本模块不 spawn、不 kill。
   * 分离的理由：clear 是身份位置上的换实例，而 kill/spawn 是另一条已有的通路。
   */
  clear(memberId: string, actorId: string): { archived: string[]; instance: MemberInstance } {
    const archived = this.archiveActiveSessions(memberId, 'clear')
    const previous = this.instanceOf(memberId)
    const next: MemberInstance = {
      epoch: previous.epoch + 1,
      since: this.now(),
      // 会话目标由人重定：clear 后清空，`goalPending=true` 让人一眼看到「还没定目标」。
      goal: null,
      goalPending: true,
      clearedAt: this.now(),
      clearedBy: actorId
    }
    const index = this.loadIndex()
    index.instances[safeSegment(memberId)] = next
    try {
      atomicWriteJson(hangarIndexPath(this.root()), index)
    } catch (err) {
      this.log(`[hangar] clear 落盘失败：${String((err as Error)?.message ?? err)}`)
    }
    this.log(`[hangar] clear 成员 ${memberId}：归档 ${archived.length} 个会话，新实例 epoch=${next.epoch}`)
    return { archived, instance: next }
  }

  /** 设定会话目标（人在 clear 后重定目标，或由派单冻结写入）。 */
  setGoal(memberId: string, goal: SessionGoal | null): MemberInstance {
    const index = this.loadIndex()
    const key = safeSegment(memberId)
    const current = index.instances[key] ?? defaultInstance()
    const next: MemberInstance = {
      ...current,
      since: current.since === 0 ? this.now() : current.since,
      goal,
      goalPending: goal === null
    }
    index.instances[key] = next
    try {
      atomicWriteJson(hangarIndexPath(this.root()), index)
    } catch (err) {
      this.log(`[hangar] 目标落盘失败：${String((err as Error)?.message ?? err)}`)
    }
    return next
  }

  /** 本机账本里出现过的全部成员（目录枚举；一个新会话也没有的成员不占行）。 */
  memberIds(): string[] {
    const dir = join(this.root(), 'sessions')
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => item.name)
        .sort()
    } catch {
      return []
    }
  }

  /** 本机是否有该成员的账本目录（调用方不必自己 safeSegment）。 */
  hasMember(memberId: string): boolean {
    try {
      return statSync(memberLedgerDir(this.root(), memberId)).isDirectory()
    } catch {
      return false
    }
  }

  /** 某成员的会话 id 列表（.jsonl 文件名去掉扩展名）。 */
  sessionIds(memberId: string): string[] {
    const dir = memberLedgerDir(this.root(), memberId)
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((item) => item.isFile() && item.name.endsWith('.jsonl'))
        .map((item) => item.name.slice(0, -'.jsonl'.length))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * 某会话的原始时间线（JSONL 逐行解析，坏行丢弃）。
   * 不做分组、不做加工——分组交给上层（turn 分组按 `kind='turn'` 行切段）。
   */
  timeline(memberId: string, sessionId: string): TimelineEntry[] {
    const path = join(memberLedgerDir(this.root(), memberId), `${safeSegment(sessionId)}.jsonl`)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return []
    }
    const out: TimelineEntry[] = []
    for (const line of text.split('\n')) {
      const entry = parseLedgerLine(line, sessionId)
      if (entry) out.push(entry)
    }
    return out
  }

  /** 会话摘要（AC1「按成员、会话和 turn 分组」的会话级聚合）。 */
  sessionSummary(memberId: string, sessionId: string): SessionSummary | null {
    const path = join(memberLedgerDir(this.root(), memberId), `${safeSegment(sessionId)}.jsonl`)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    let lines = 0
    let turns = 0
    let startedAt = 0
    let endedAt = 0
    let stopReason: string | null = null
    const kinds: Record<string, number> = {}
    for (const rawLine of text.split('\n')) {
      const entry = parseLedgerLine(rawLine, sessionId)
      if (!entry) continue
      lines += 1
      if (startedAt === 0 || entry.ts < startedAt) startedAt = entry.ts
      if (entry.ts > endedAt) endedAt = entry.ts
      for (const tag of entryTags(entry)) kinds[tag] = (kinds[tag] ?? 0) + 1
      if (entry.kind === 'turn') {
        turns += 1
        if (isRecord(entry.data) && typeof entry.data['stopReason'] === 'string') {
          stopReason = entry.data['stopReason']
        }
      }
    }
    if (lines === 0) return null
    return {
      sessionId,
      startedAt,
      endedAt,
      stopReason,
      turns,
      lines,
      kinds,
      archive: this.archiveOf(memberId, sessionId)
    }
  }

  /**
   * 机库总览：成员 → 会话（含归档态）。`nick` / `burden` 由调用方注入
   * ——机库只读账本，不认识 registry 与状态通道。
   */
  overview(decorate: (memberId: string) => { nick: string; burden: MemberHangar['burden'] }): MemberHangar[] {
    return this.memberIds().map((memberId) => {
      const instance = this.instanceOf(memberId)
      const sessions: SessionSummary[] = []
      for (const sessionId of this.sessionIds(memberId)) {
        const summary = this.sessionSummary(memberId, sessionId)
        if (!summary) continue
        // 归属是推论：不属当前实例（= 已归档）的会话不进活跃列表，只从归档读。
        if (!this.isActive(memberId, sessionId, instance)) continue
        sessions.push(summary)
      }
      // 最近活动的排前面：机库第一眼要看的是「刚刚发生了什么」。
      sessions.sort((a, b) => b.endedAt - a.endedAt)
      const { nick, burden } = decorate(memberId)
      return { memberId, nick, burden, instance, depth: null, sessions }
    })
  }

  /**
   * 过滤 + 全文搜索（AC2：支持过程类型过滤和全文搜索，不加工、不总结）。
   * 全文搜索匹配**原始行**（未二次序列化），故搜得到任何字段的字面值。
   */
  search(query: TimelineQuery): TimelineEntry[] {
    const { memberId, sessionId, kinds, q = '', limit = 500 } = query
    const wanted = kinds && kinds.length > 0 ? new Set(kinds) : null
    const needle = q.trim()
    const sessionIds = sessionId ? [sessionId] : this.sessionIds(memberId)
    const out: TimelineEntry[] = []
    for (const sid of sessionIds) {
      const path = join(memberLedgerDir(this.root(), memberId), `${safeSegment(sid)}.jsonl`)
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      for (const rawLine of text.split('\n')) {
        if (rawLine.trim() === '') continue
        if (!matchesQuery(rawLine, needle)) continue
        const entry = parseLedgerLine(rawLine, sid)
        if (!entry) continue
        if (wanted && !entryTags(entry).some((tag) => wanted.has(tag))) continue
        out.push(entry)
        if (out.length >= limit) return out
      }
    }
    return out
  }

  /** 会话 Markdown 时间线（人类可读视图；由 SessionLedger 在 turn 结算时覆盖写）。 */
  markdown(memberId: string, sessionId: string): string | null {
    const path = join(memberLedgerDir(this.root(), memberId), `${safeSegment(sessionId)}.md`)
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }

  /** 磁盘占用（诊断用：Owner 手动清理前先看一眼）。 */
  sizeOf(memberId: string, sessionId: string): number {
    const path = join(memberLedgerDir(this.root(), memberId), `${safeSegment(sessionId)}.jsonl`)
    try {
      return statSync(path).size
    } catch {
      return 0
    }
  }
}

/** 确保目录存在（归档索引落盘前调用；atomicWriteJson 自己会 mkdir，这里给索引目录占位）。 */
export function ensureHangarRoot(artifactsRoot: string): void {
  const dir = hangarRoot(artifactsRoot)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
