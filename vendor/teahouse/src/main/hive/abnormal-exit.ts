// 异常退群探测（#59）：派遣成员**上线之后**进程猝死 → 5 秒内异常退群 + 任务回待领取。
//
// 为什么靠 pid 轮询而不是子进程 exit 事件：派遣子进程是 detached + stdio:'ignore' 起的
// （dispatch.ts spawnNode），父进程拿不到它的 exit 事件；本机探活是唯一现成的信号。
// ADR-0009 也定了同一口径：「猝死判定走子进程退出 / TCP，不依赖本通道」。
//
// 判据分层（两层都在，缺一不能判猝死）：
//   1. pid 不在了（`process.kill(pid, 0)` 抛 ESRCH）—— 进程真的没了；
//   2. 该成员仍被账本记作活跃派遣（outcome=started 且 memberIds 里有它）。
// 只凭「离线」不能判猝死：离线是够不着（静默 90s），与它在不在干活无关（PRD ④）。
//
// 判据**不含 pid 的语义解释**：pid 复用（操作系统回收后分给别的进程）会让探活假活，
// 表现为「不判猝死」—— 偏保守的一侧（宁可漏判也不误杀活成员），Hive 本机 MVP 接受。
import type { DispatchRecord, DispatchStore } from './dispatch-store'

/** pid 是否仍在本机存活。ESRCH = 进程没了；EPERM = 存在但不属于我 → 仍算活着。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

/** 一个待判猝死的派遣成员（成员与它上线时记下的 pid 一起给）。 */
export interface WatchTarget {
  dispatchId: string
  memberId: string
  pid: number
}

/**
 * 从派遣账本里挑出「记了 pid 且 pid 已不在」的活跃派遣成员。
 *
 * `pids` 与 `memberIds` 逐位对齐（#56 部分失败路径保证）；旧账本没有 `pids` 列
 * （迁移规则 1 的只增字段）→ 该条不参与探活，**不会被误判猝死**。
 */
export function collectDeadTargets(
  records: DispatchRecord[],
  isAlive: (pid: number) => boolean = isProcessAlive
): WatchTarget[] {
  const dead: WatchTarget[] = []
  for (const record of records) {
    if (record.outcome !== 'started') continue
    const pids = record.pids
    if (!pids || pids.length === 0) continue
    record.memberIds.forEach((memberId, index) => {
      const pid = pids[index]
      if (pid === undefined) return
      if (!isAlive(pid)) dead.push({ dispatchId: record.dispatchId, memberId, pid })
    })
  }
  return dead
}

export interface AbnormalExitDeps {
  store: DispatchStore
  /**
   * 对一个刚判死的成员收口（退群 / 撤登记 / 归档 / 广播 / @主人）。
   *
   * `record` 是**结算前**的派遣记录快照：`markAbnormal` 会把该成员从 `memberIds` 摘掉，
   * 之后 `store.recordFor(memberId)` 就查不到了 —— 收口所需的目标 / 派遣者 / 深度
   * 必须在结算前捕获，否则会静默退化成「不知道这个成员属于哪个群」。
   */
  onAbnormalExit(input: {
    dispatchId: string
    memberId: string
    reason: string
    record: DispatchRecord | null
  }): void
  isAlive?(pid: number): boolean
  now?(): number
  log?(line: string): void
}

/** 探活节拍：AC「杀死 runner 后**五秒内**成员异常退群」。1s 轮询留足余量。 */
export const WATCH_INTERVAL_MS = 1_000

/**
 * 异常退群探测器：定时扫账本，把「记了 pid 但 pid 已不在」的成员逐个结算成异常退群。
 *
 * 幂等：结算交给 `DispatchStore.markAbnormal`（它按 outcome=started 闸门去重），
 * 所以某一拍重复看到同一个死成员也不会重复落账/重复发消息。
 */
export class AbnormalExitWatcher {
  private readonly deps: AbnormalExitDeps
  private readonly log: (line: string) => void
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: AbnormalExitDeps) {
    this.deps = deps
    this.log = deps.log ?? ((line: string) => console.log(line))
  }

  /** 扫一拍：返回本拍判死并结算过的成员（供测试与日志断言）。 */
  poll(): { dispatchId: string; memberId: string }[] {
    const dead = collectDeadTargets(
      this.deps.store.snapshot().dispatches,
      this.deps.isAlive ?? isProcessAlive
    )
    const settled: { dispatchId: string; memberId: string }[] = []
    for (const target of dead) {
      const reason = `成员进程猝死（pid ${target.pid} 已不存在）——未交回交接文档即退出`
      // 结算前先捕获记录：markAbnormal 会把该成员从 memberIds 摘掉（见 onAbnormalExit 注释）。
      // 必须按 target.dispatchId 定位（不能用 recordFor 的首条匹配）：同一成员可能出现在
      // 多条 started 记录里（重派 / 递归派遣），首条匹配会取到跟本次结算不同的那条，
      // 导致群里 @ 错主人、待领取任务的 groupId 也错。
      const record =
        this.deps.store.snapshot().dispatches.find((d) => d.dispatchId === target.dispatchId) ?? null
      const task = this.deps.store.markAbnormal({
        dispatchId: target.dispatchId,
        memberId: target.memberId,
        reason
      })
      if (!task) continue // 已被别的路径结算过（正常回收 / 上一拍）→ 不重复处理
      settled.push({ dispatchId: target.dispatchId, memberId: target.memberId })
      this.log(`[runner-watch] 异常退群：${target.memberId.slice(0, 6)} → 待领取 ${task.dispatchId}`)
      this.deps.onAbnormalExit({
        dispatchId: target.dispatchId,
        memberId: target.memberId,
        reason,
        record
      })
    }
    return settled
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.poll(), WATCH_INTERVAL_MS)
    // 不挡进程退出（与其它 Hive 定时器同款纪律）。
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}

/**
 * 异常退群的群内文案（AC2：与正常退群**明确不同**的两种消息）。
 *
 * 正常退群：`X 退出了群聊`（底座系统事件，占位说明「干完回收」）。
 * 异常退群：这条 —— 「⚠ 异常退群」+ 未交回交接文档 + @原主人 + 任务已回待领取。
 * 两者在群里必须一眼分得开，所以这里刻意带上「异常」二字与「待领取」的状态。
 */
export function abnormalExitText(input: {
  memberName: string
  reason: string
  taskId: string
  goalOneLine: string
}): string {
  return (
    `⚠ 异常退群：${input.memberName} 进程猝死，未交回交接文档即退出（${input.reason}）。` +
    `任务已回到待领取（${input.taskId}），原目标：${input.goalOneLine}。` +
    '默认不自动补派，请主人决定是否补派。'
  )
}
