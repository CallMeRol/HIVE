// 本机会话账本（ADR-0008）：`<artifactsRoot>/sessions/<memberId>/<sessionId>.jsonl` append-only
// + 同名 `.md` 人类可读时间线。过程（thought / tool / plan / usage）与出向 prompt、
// permission 应答、守卫判定都落这里，**不进群**。
//
// 无 TTL、不自动清理（7 天 TTL 只属于离线补发队列）；磁盘告警时主人手动清。
// 机库（#52）读它，本模块只负责 append-only 写入。

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 账本行类型：owner 管理的版本随行携带（迁移规则 6）。 */
export type LedgerKind =
  | 'inbound'   // 入向：触发本次 turn 的群消息判别值
  | 'outbound'  // 出向：session/prompt 正文、initialize、permission 应答
  | 'update'    // ACP session/update（过程 + 正式消息增量）
  | 'verdict'   // 守卫判定（#55 写入；本 ticket 只留通道）
  | 'handover'  // 交接校验证据（#60：拒绝接手 / 输入输出校验，机库可查）
  | 'turn'      // turn 结算

export interface LedgerEntry {
  v: 1
  kind: LedgerKind
  ts: number
  data: unknown
}

export interface LedgerPaths {
  /** 该会话的 JSONL 绝对路径。 */
  jsonl: string
  /** 该会话的 Markdown 绝对路径。 */
  markdown: string
  /** 所在目录（成员目录）。 */
  dir: string
}

/** 一个会话一个账本文件；memberId / sessionId 都要能安全当路径用。 */
export function ledgerPaths(artifactsRoot: string, memberId: string, sessionId: string): LedgerPaths {
  const dir = join(artifactsRoot, 'sessions', safeSegment(memberId))
  return {
    dir,
    jsonl: join(dir, `${safeSegment(sessionId)}.jsonl`),
    markdown: join(dir, `${safeSegment(sessionId)}.md`)
  }
}

/** 只允许保守字符集，避免 memberId/sessionId 里的分隔符把落盘位置带出预期目录。 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return cleaned === '' ? 'unknown' : cleaned
}

export class SessionLedger {
  private readonly paths: LedgerPaths
  private readonly now: () => number

  constructor(artifactsRoot: string, memberId: string, sessionId: string, now: () => number = () => Date.now()) {
    this.paths = ledgerPaths(artifactsRoot, memberId, sessionId)
    this.now = now
  }

  /** 惰性建目录：进程活着但从未被 @ 时不留空目录。 */
  private ensureDir(): void {
    if (!existsSync(this.paths.dir)) mkdirSync(this.paths.dir, { recursive: true })
  }

  /** append-only JSONL：一行一条，绝不改写历史行。 */
  append(kind: LedgerKind, data: unknown): void {
    try {
      this.ensureDir()
      const entry: LedgerEntry = { v: 1, kind, ts: this.now(), data }
      appendFileSync(this.paths.jsonl, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (err) {
      // 落盘失败不能让 turn 挂掉——但必须显式可见（fail-closed 的是"不许进程进群"，不是落盘）。
      console.error(`[ledger] 写 ${this.paths.jsonl} 失败：${String((err as Error)?.message ?? err)}`)
    }
  }

  /**
   * turn 结算时以**覆盖**方式写人类可读时间线。
   * 与 JSONL 的分工：JSONL 是 append-only 的真相源，Markdown 是可重建的视图。
   */
  writeMarkdown(header: Record<string, string>, lines: string[]): void {
    try {
      this.ensureDir()
      const head = Object.entries(header).map(([k, v]) => `- ${k}: ${v}`).join('\n')
      writeFileSync(this.paths.markdown, `# 会话时间线\n\n${head}\n\n${lines.join('\n')}\n`, 'utf8')
    } catch (err) {
      console.error(`[ledger] 写 ${this.paths.markdown} 失败：${String((err as Error)?.message ?? err)}`)
    }
  }

  /** 供诊断/机库读取。 */
  filePaths(): LedgerPaths {
    return this.paths
  }
}

/** 过程类型白名单（ADR-0008：这些一律不进群）。判据是**类型**，不是长度。 */
export const PROCESS_UPDATE_KINDS: ReadonlySet<string> = new Set([
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'plan_update',
  'plan_removed',
  'usage_update',
  'session_info_update',
  'available_commands_update',
  'user_message_chunk',
  'current_mode_update'
])

/** 正式消息增量类型（唯一进群的 session/update）。 */
export const FORMAL_UPDATE_KIND = 'agent_message_chunk'

export function isProcessUpdate(kind: string): boolean {
  return PROCESS_UPDATE_KINDS.has(kind)
}
