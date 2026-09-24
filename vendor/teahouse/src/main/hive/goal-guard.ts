// 目标守卫（#55 / CONTEXT「目标守卫」）：无状态判定调用。
// 结构性约束（AC1）：输入只有 {会话目标, 新请求原文} —— 不含会话历史，类型上就带不进去。
// 判定面经 `HIVE_GOAL_GUARD_URL` 注入本机 HTTP 判定器；判定器不可用/返回不合法 →
// fail-open `undetermined`（AC5），由调用方显式警告并放行；权限门（pending 确认键）
// 不在本模块管辖，仍是 fail-closed（pending-core）。
import { appendFileSync, mkdirSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { dirname } from 'node:path'

export type GoalVerdict = 'in-scope' | 'out-of-scope' | 'undetermined'

/** 守卫唯一输入形状（AC1：无会话历史字段）。 */
export interface GoalGuardInput {
  goal: string
  request: string
}

export interface GoalGuardVerdict {
  verdict: GoalVerdict
  confidence: number
  reason: string
}

/** null = 判定器不可用（fail-open 信号，不抛错）。 */
export type GoalGuardJudge = (input: GoalGuardInput) => Promise<GoalGuardVerdict | null>

export const GOAL_GUARD_TIMEOUT_MS = 8_000

const VERDICTS: readonly GoalVerdict[] = ['in-scope', 'out-of-scope', 'undetermined']

/** 容错解析：形状不合法一律返回 null（fail-open），不让坏载荷变成一次误判。 */
export function normalizeVerdict(raw: unknown): GoalGuardVerdict | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const verdict = rec['verdict']
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as GoalVerdict)) return null
  const confidence = typeof rec['confidence'] === 'number' && rec['confidence'] >= 0 && rec['confidence'] <= 1
    ? rec['confidence']
    : 0
  const reason = typeof rec['reason'] === 'string' ? rec['reason'].slice(0, 500) : ''
  return { verdict: verdict as GoalVerdict, confidence, reason }
}

/** 判定动作（纯函数）：越界 → 派遣；未判定/不可用 → fail-open 放行 + 警告；在界 → 直通。 */
export function decideAction(verdict: GoalGuardVerdict | null): 'dispatch' | 'deliver' | 'deliver_warn' {
  if (!verdict) return 'deliver_warn'
  if (verdict.verdict === 'out-of-scope') return 'dispatch'
  if (verdict.verdict === 'undetermined') return 'deliver_warn'
  return 'deliver'
}

/**
 * 本机 HTTP 判定器（node:http —— Electron 22 内嵌 Node 16 无全局 fetch，与 pollDispatchHealth 同理）。
 * 任何失败（连接/超时/非 2xx/坏 JSON/坏形状）都返回 null，绝不抛——fail-open 的单点在这里。
 */
export function httpJudge(url: string, timeoutMs = GOAL_GUARD_TIMEOUT_MS): GoalGuardJudge {
  return (input) =>
    new Promise((resolve) => {
      let body: string
      let target: URL
      try {
        body = JSON.stringify(input)
        target = new URL(url)
      } catch {
        resolve(null)
        return
      }
      try {
        const req = httpRequest(
          {
            hostname: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body)
            },
            timeout: timeoutMs
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
              try {
                resolve(normalizeVerdict(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
              } catch {
                resolve(null)
              }
            })
          }
        )
        req.on('timeout', () => {
          req.destroy()
          resolve(null)
        })
        req.on('error', () => resolve(null))
        req.end(body)
      } catch {
        resolve(null)
      }
    })
}

// ---------- 审计（AC2：判定、置信度、理由和输入可审计） ----------

export interface GoalGuardAuditEntry {
  ts: number
  memberId: string
  groupId: string
  /** 完整输入（目标 + 请求原文）：判定可复核的前提。 */
  input: GoalGuardInput
  /** null = 判定器不可用。 */
  verdict: GoalVerdict | 'unavailable'
  confidence: number
  reason: string
  action: ReturnType<typeof decideAction> | 'no_goal' | 'guard_disabled'
  dispatchId?: string
}

/** 追加一行审计（jsonl）；审计失败只打日志，绝不影响消息主链路。 */
export function appendGoalGuardAudit(
  path: string,
  entry: Omit<GoalGuardAuditEntry, 'ts'>,
  ts = Date.now()
): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({ ts, ...entry })}\n`, 'utf8')
  } catch (err) {
    console.error('[goal-guard] 审计落盘失败：', err)
  }
}
