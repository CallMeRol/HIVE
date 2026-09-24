// 跨机 agent 状态通道（#47；通道与参数定案见 ADR-0009 / issue #38 resolution）。
//
// 通道形态：Hive 私有信封类型 `agent-status`（v:1），best-effort 定向单播给
// 「同群 ∩ 声明 ag1 ∩ 在线」的对端；节拍 10s、无数据 TTL 30s。
// 上游改动 = 0：未知信封类型由 codec 放行、发现层/消息层按 known=false 忽略
// （src/main/net/codec.ts 的 KNOWN_TYPES 不含本类型）；`ag1` 只并进 caps 一位，
// caps 校验不枚举合法值（codec.validateProfile）。
//
// 纪律（本文件是入站不可信输入的唯一闸门）：
// - payload 不进 codec 白名单 ⇒ 字段级自校验；超标整包丢，**不降级、不猜**。
// - 明确不复用底座 offlineAfter(90s) 作衰减：节点在线而 agent 已死时继续显示旧档 = 撒谎；
//   离线是底座事实，由成员表置灰承担，不参与负担档判定（#26）。
// - 不落 messages 表 ⇒ 零 FTS 污染；best-effort ⇒ 零补发队列占用；不改在线态 ⇒ 不污染 presence。
import { EventEmitter } from 'node:events'
import { makeEnvelope } from '../net/codec'
import type { Envelope } from '../../shared/protocol'
import { BURDEN_TAGS, type BurdenTag, type PeerBurdenView } from '../../shared/ipc'

/**
 * 五档档名（#26 定案）。留在主进程：渲染层只透传 `PeerBurdenView.label`，
 * 避免把词表打进主窗 bundle（renderer 静态闭包有硬预算）。
 */
const BURDEN_LABEL: Record<BurdenTag, string> = {
  idle: '空闲',
  easy: '轻松',
  busy: '有点忙',
  overload: '过载',
  'about-to-blow': '快炸了'
}

/** 五档固定色相（sprite 契约 A2）。 */
const BURDEN_COLOR: Record<BurdenTag, string> = {
  idle: '#58a6ff',
  easy: '#3fb950',
  busy: '#d29922',
  overload: '#f0883e',
  'about-to-blow': '#f85149'
}

/** 私有信封类型名；不在 protocol.ts 的 MSG_TYPES 里，故对上游永远是「未知类型」。 */
export const AGENT_STATUS_TYPE = 'agent-status'
/** 能力位：声明本节点跑 agent 且能收发状态报文（#38 定案：不做 UI 开关，位本身就是开关）。 */
export const AGENT_STATUS_CAP = 'ag1'
/** 上报节拍（#38 拍板 10s：5s 在峰值规模下撞 UDP 入站令牌桶 30 包/秒/源 IP）。 */
export const AGENT_STATUS_INTERVAL_MS = 10_000
/** 无数据 TTL = 3 × 节拍；超过即落 idle 蓝（CONTEXT「空闲 = 没有在跑的会话 或 拿不到负担数据」）。 */
export const AGENT_STATUS_TTL_MS = 3 * AGENT_STATUS_INTERVAL_MS
/** 过期扫描节拍：只为把「停止上报」尽快反映成 stale，不影响上报节拍。 */
const AGENT_STATUS_SWEEP_MS = 5_000
/** 入站 ts 窗口：本机钟与对端钟差超过此值即丢（防重放与陈旧包）。 */
const AGENT_STATUS_TS_WINDOW_MS = 5 * 60_000
const GOAL_MAX_BYTES = 120
const ROLE_MAX_BYTES = 24
const SIZE_TOKENS_MAX = 1_000_000_000

/** 五档阈值（sprite 契约 A2：`<10%` 轻松 / `≥10%` 有点忙 / `≥20%` 过载 / `≥40%` 快炸了）。 */
export const BURDEN_THRESHOLDS = { busy: 10, overload: 20, aboutToBlow: 40 } as const

/** 状态载荷（不含 ts 的部分，供确定性状态生产器复用）。 */
export interface BurdenSpec {
  pct: number
  sizeTokens: number
  tag: BurdenTag
  goal?: string
  role?: string
}

/** 线上载荷定稿（#38 §3）：`{ ts, pct, sizeTokens, tag, goal?, role? }`。 */
export interface BurdenReport extends BurdenSpec {
  ts: number
}

/** `burden.updated` 事件 data（字段名批内冻结，见 docs/contracts/parallel-development.md）。 */
export interface BurdenUpdate {
  memberId: string
  /** stale 时无有效占用数据，显式给 null 而不是回退成 0。 */
  pct: number | null
  tag: BurdenTag
  /** 最后活动 = 最后一次有效上报的 ts；从未上报为 0。 */
  ts: number
  stale: boolean
}

export type AgentStatusEnvelopeListener = (
  env: Envelope,
  known: boolean,
  rinfo: { address: string }
) => void

/** udp 通道的最小结构（真实实现是 net/udp 的 UdpChannel，测试用假体）。 */
export interface AgentStatusEnvelopeSource {
  on(event: 'envelope', listener: AgentStatusEnvelopeListener): unknown
  off(event: 'envelope', listener: AgentStatusEnvelopeListener): unknown
}

export interface AgentStatusPeerRecord {
  ip: string
  online: boolean
  profile: { caps: string[] }
}

export interface AgentStatusPeerLookup {
  get(nodeId: string): AgentStatusPeerRecord | undefined
}

export interface AgentStatusGroupLookup {
  list(): Array<{ members: string[] }>
}

export interface AgentStatusSender {
  sendBestEffort(peerId: string, env: Envelope): void
}

export interface AgentStatusDeps {
  selfId: string
  envelopes: AgentStatusEnvelopeSource
  peers: AgentStatusPeerLookup
  groups: AgentStatusGroupLookup
  sender: AgentStatusSender
  now?: () => number
  intervalMs?: number
  ttlMs?: number
  sweepMs?: number
  /** 对端负担可见面发生变化（→ 重推 PeerView 列表）。 */
  onChanged?: () => void
  log?: (line: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isBurdenTag(value: unknown): value is BurdenTag {
  return typeof value === 'string' && (BURDEN_TAGS as readonly string[]).includes(value)
}

/** 状态点悬浮说明：档名 + 占用 % + 窗口大小（窗口必须与占用同屏，sprite 契约 A2）。 */
function burdenTitle(tag: BurdenTag, pct: number | null, sizeTokens: number | null): string {
  const parts = [BURDEN_LABEL[tag]]
  if (pct !== null) parts.push(`${pct}%`)
  // 窗口大小以 K 档展示：1M 默认窗口即 1000K，同屏可读优先于精确位数。
  if (sizeTokens !== null) parts.push(`${Math.round(sizeTokens / 1000)}K`)
  return parts.join(' · ')
}

/** 由占用百分比派生档位（idle 表达「没有在跑的会话」，不能从 pct 派生，需显式给出）。 */
export function burdenTagOfPct(pct: number): BurdenTag {
  if (pct >= BURDEN_THRESHOLDS.aboutToBlow) return 'about-to-blow'
  if (pct >= BURDEN_THRESHOLDS.overload) return 'overload'
  if (pct >= BURDEN_THRESHOLDS.busy) return 'busy'
  return 'easy'
}

/** 按 UTF-8 字节上限截断，且尽量落在词边界（#38 §3 的 `goal ≤120 B（词边界截断）`）。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let cut = text
  while (cut.length > 0 && Buffer.byteLength(cut, 'utf8') > maxBytes) {
    cut = cut.slice(0, -1) // 逐码点回退，避免截出半个 UTF-8 序列
  }
  const trimmed = cut.replace(/\s+$/, '')
  const lastSpace = trimmed.lastIndexOf(' ')
  return lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed
}

function intIn(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null
}

/**
 * 把 ACP 的 `usage_update` 转成本机负担上报（#49 AC5）。
 *
 * ACP 载荷形如 `{ used, size }`（上下文已用 token / 窗口总容量，claude-agent-acp 实测
 * `{used:12132,size:1000000}`）——这是**真实 usage**，不是估算：#47 的确定性状态生产器
 * 之所以存在，正是因为当时还没有真 agent 可用；接入落地后这条路径才是权威来源。
 *
 * 拿不到可用的 `used/size` 就返回 null：**整条不发**，由 TTL 表达「没有数据」，
 * 绝不用 0 或旧值伪造一个看起来正常的档位（#47 已定：无数据落 idle 蓝并继续显示）。
 */
export function burdenReportFromUsage(
  usage: unknown,
  opts: { ts: number; goal?: string; role?: string }
): BurdenReport | null {
  if (typeof usage !== 'object' || usage === null) return null
  const used = intIn((usage as Record<string, unknown>)['used'], 0, SIZE_TOKENS_MAX)
  const size = intIn((usage as Record<string, unknown>)['size'], 1, SIZE_TOKENS_MAX)
  if (used === null || size === null) return null
  // 上下文占用不可能超过窗口；超了说明数据不可信，按满窗处理而不是丢（宁可报警不装死）。
  const pct = Math.min(100, Math.round((used / size) * 100))
  const goal = truncateUtf8(opts.goal ?? '', GOAL_MAX_BYTES)
  const role = truncateUtf8(opts.role ?? '', ROLE_MAX_BYTES)
  return {
    ts: opts.ts,
    pct,
    sizeTokens: size,
    tag: burdenTagOfPct(pct),
    ...(goal ? { goal } : {}),
    ...(role ? { role } : {})
  }
}

/** 可选文本字段：缺省 / 空串 → ''；类型不对或超字节上限 → null（整包丢）。 */
function optionalText(value: unknown, maxBytes: number): string | null {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') return null
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return null
  return value
}

/**
 * 入站自校验（不可信输入）：任一必填字段不合法即返回 null，调用方整包丢。
 * 未知键忽略不计错（#38 §3）。
 */
export function validateBurdenReport(payload: unknown, now: number): BurdenReport | null {
  if (!isRecord(payload)) return null
  const pct = intIn(payload['pct'], 0, 100)
  const sizeTokens = intIn(payload['sizeTokens'], 1, SIZE_TOKENS_MAX)
  const ts = intIn(payload['ts'], 1, Number.MAX_SAFE_INTEGER)
  if (pct === null || sizeTokens === null || ts === null) return null
  if (!isBurdenTag(payload['tag'])) return null
  if (Math.abs(now - ts) > AGENT_STATUS_TS_WINDOW_MS) return null
  const goal = optionalText(payload['goal'], GOAL_MAX_BYTES)
  const role = optionalText(payload['role'], ROLE_MAX_BYTES)
  if (goal === null || role === null) return null
  return {
    ts,
    pct,
    sizeTokens,
    tag: payload['tag'],
    ...(goal ? { goal } : {}),
    ...(role ? { role } : {})
  }
}

/**
 * 确定性状态生产器（#47 AC5）：真实 usage 在 Agent 接入切片（#49）接线，
 * 在那之前用本解析器从 env 造状态，让黑盒验收不依赖任何 agent/LLM。
 *
 * 规范：`key=value;key=value`（值内可含 `,`）。
 *   `pct=42;size=1048576;tag=busy;goal=写一个测试;role=reviewer`
 *   `pct=42;size=1048576`            —— tag 缺省由 pct 派生
 *   `pct=42;size=1048576;for=15000`  —— 只上报 15s 后自动停（黑盒验 TTL 用）
 *   `off` / 空串                      —— 无本机生产者（拿不到数据整条不发，由 TTL 表达）
 */
export function parseProducerSpec(
  spec: string,
  now: number
): { report: BurdenReport; forMs: number } | null {
  const trimmed = spec.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'off') return null
  const fields = new Map<string, string>()
  for (const pair of trimmed.split(';')) {
    const at = pair.indexOf('=')
    if (at <= 0) continue
    fields.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
  const pct = intIn(Number(fields.get('pct')), 0, 100)
  const sizeTokens = intIn(Number(fields.get('size')), 1, SIZE_TOKENS_MAX)
  if (pct === null || sizeTokens === null) return null
  const rawTag = fields.get('tag')
  const tag = rawTag === undefined || rawTag === '' ? burdenTagOfPct(pct) : rawTag
  if (!isBurdenTag(tag)) return null
  const goal = truncateUtf8(fields.get('goal') ?? '', GOAL_MAX_BYTES)
  const role = truncateUtf8(fields.get('role') ?? '', ROLE_MAX_BYTES)
  const forMs = intIn(Number(fields.get('for')), 0, 3_600_000) ?? 0
  return {
    report: { ts: now, pct, sizeTokens, tag, ...(goal ? { goal } : {}), ...(role ? { role } : {}) },
    forMs
  }
}

/**
 * 跨机状态通道：发送侧按 10s 节拍定向单播本机状态；接收侧自校验、按 ts 去重、
 * 按 TTL 衰减，并把结果投影成 PeerView 上的一行负担。
 */
export class AgentStatusService extends EventEmitter {
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly ttlMs: number
  private readonly sweepMs: number
  /** nodeId → 最后一次有效上报（内存态，唯一所有者，见并行契约状态所有者表）。 */
  private readonly cache = new Map<string, BurdenReport>()
  /** 已按 TTL 判过期的节点，避免每轮扫描重复发事件。 */
  private readonly expired = new Set<string>()
  private localSpec: BurdenReport | null = null
  private reportUntil = 0
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private started = false
  /** 诊断计数（只读；用于日志与黑盒排查）。 */
  private dropped = 0

  constructor(private readonly deps: AgentStatusDeps) {
    super()
    this.now = deps.now ?? (() => Date.now())
    this.intervalMs = deps.intervalMs ?? AGENT_STATUS_INTERVAL_MS
    this.ttlMs = deps.ttlMs ?? AGENT_STATUS_TTL_MS
    this.sweepMs = deps.sweepMs ?? AGENT_STATUS_SWEEP_MS
  }

  /** 本机确定性状态生产器；`null` = 拿不到数据（整条不发）。 */
  setLocalReport(report: BurdenReport | null, reportForMs = 0): void {
    this.localSpec = report
    this.reportUntil = report && reportForMs > 0 ? this.now() + reportForMs : 0
    if (!report) this.deps.log?.('[agent-status] 本机生产者已停止上报')
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.deps.envelopes.on('envelope', this.onEnvelope)
    this.tickTimer = setInterval(() => this.tick(), this.intervalMs)
    this.tickTimer.unref?.()
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepMs)
    this.sweepTimer.unref?.()
    this.tick() // 首拍不等一个周期：启动即可见
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.deps.envelopes.off('envelope', this.onEnvelope)
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.tickTimer = null
    this.sweepTimer = null
  }

  /** 与本机有共同群的对端（可见边界的一半；另一半是 ag1）。 */
  sharedPeerIds(): Set<string> {
    const shared = new Set<string>()
    for (const group of this.deps.groups.list()) {
      if (!group.members.includes(this.deps.selfId)) continue
      for (const member of group.members) {
        if (member !== this.deps.selfId) shared.add(member)
      }
    }
    return shared
  }

  /**
   * 「本该上报的对端」= 同群 ∩ 声明 ag1（#38：结构性无状态的对端保留绿/灰点，不落 idle 蓝）。
   * 不含在线判定 —— 离线是另一条轴（#26：离线不换配色，可达性由成员表置灰承担）。
   */
  isEligible(nodeId: string, shared = this.sharedPeerIds()): boolean {
    if (nodeId === this.deps.selfId || !shared.has(nodeId)) return false
    const record = this.deps.peers.get(nodeId)
    return record !== undefined && this.hasCap(record)
  }

  /** PeerView 投影：`eligible=false` 时渲染层保留底座绿/灰点。 */
  viewFor(nodeId: string, shared = this.sharedPeerIds()): PeerBurdenView {
    const eligible = this.isEligible(nodeId, shared)
    const report = this.cache.get(nodeId)
    const stale = report === undefined || this.isExpired(report, this.now())
    const tag: BurdenTag = !stale && report ? report.tag : 'idle'
    const pct = !stale && report ? report.pct : null
    const sizeTokens = !stale && report ? report.sizeTokens : null
    return {
      eligible,
      tag,
      label: BURDEN_LABEL[tag],
      color: BURDEN_COLOR[tag],
      title: burdenTitle(tag, pct, sizeTokens),
      pct,
      sizeTokens,
      goal: report?.goal ?? '',
      role: report?.role ?? '',
      ts: report?.ts ?? 0,
      stale
    }
  }

  /** 诊断快照（测试与排障用）。 */
  snapshot(): { cached: number; dropped: number } {
    return { cached: this.cache.size, dropped: this.dropped }
  }

  private hasCap(record: AgentStatusPeerRecord): boolean {
    return Array.isArray(record.profile.caps) && record.profile.caps.includes(AGENT_STATUS_CAP)
  }

  private isExpired(report: BurdenReport, now: number): boolean {
    return now - report.ts > this.ttlMs
  }

  /** 目标集 = 同群 ∩ ag1 ∩ 在线（#38 §2）。 */
  private targets(): string[] {
    const out: string[] = []
    for (const nodeId of this.sharedPeerIds()) {
      const record = this.deps.peers.get(nodeId)
      if (record && record.online && this.hasCap(record)) out.push(nodeId)
    }
    return out
  }

  private tick(): void {
    const spec = this.localSpec
    if (!spec) return
    if (this.reportUntil > 0 && this.now() >= this.reportUntil) {
      this.localSpec = null
      this.reportUntil = 0
      this.deps.log?.('[agent-status] 本机生产者到期停止上报')
      return
    }
    const payload: BurdenReport = { ...spec, ts: this.now() }
    for (const peerId of this.targets()) {
      // best-effort：不 ACK / 不入队 / 不改在线态 / 不改 dedup（语义镜像 messenger.sendBestEffort）
      this.deps.sender.sendBestEffort(peerId, makeEnvelope(AGENT_STATUS_TYPE, this.deps.selfId, payload))
    }
  }

  private onEnvelope = (env: Envelope, _known: boolean, rinfo: { address: string }): void => {
    if (env.type !== AGENT_STATUS_TYPE) return
    const record = this.deps.peers.get(env.from)
    // 只认已知对端、且源地址与其登记地址一致；其余一律丢（不进 registry，故不污染 presence）
    if (!record || record.ip !== rinfo.address || !this.hasCap(record)) {
      this.dropped += 1
      return
    }
    const report = validateBurdenReport(env.payload, this.now())
    if (!report) {
      this.dropped += 1
      return
    }
    const previous = this.cache.get(env.from)
    if (previous && previous.ts >= report.ts) {
      this.dropped += 1 // 乱序 / 旧包按 ts 丢弃（#38：已删 rev，重启计数器归零问题一并消失）
      return
    }
    this.cache.set(env.from, report)
    this.expired.delete(env.from)
    this.emitBurden(env.from, report, false)
  }

  private sweep(): void {
    const now = this.now()
    for (const [nodeId, report] of this.cache) {
      if (this.expired.has(nodeId) || !this.isExpired(report, now)) continue
      this.expired.add(nodeId)
      this.emitBurden(nodeId, report, true)
    }
  }

  /** 群成员变化后目标集可能变化：重推一次负担面（渲染层用新的 eligible 集合重画）。 */
  recompute(): void {
    this.deps.onChanged?.()
  }

  private emitBurden(nodeId: string, report: BurdenReport, stale: boolean): void {
    const update: BurdenUpdate = {
      memberId: nodeId,
      pct: stale ? null : report.pct,
      tag: stale ? 'idle' : report.tag,
      ts: report.ts,
      stale
    }
    this.emit('burden.updated', update)
  }
}
