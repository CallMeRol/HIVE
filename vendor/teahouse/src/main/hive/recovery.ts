// 重启恢复（#58）：Hive 侧持久化的**唯一恢复入口**（契约「迁移规则 2」）。
//
// 启动时按所有者表逐本机账本恢复，纪律（契约「迁移规则 3」恢复不造假）：
//   - 接入成员（agent-attach.json）：按账本重新 spawn。进程不存在是重启的既成事实，
//     重新拉起不是重复派遣；起不来（端口被占 / health 不过）→ 忘掉该记录并留痕，不留幽灵。
//   - 派遣账本（dispatch.json）：执行阶段中断的任务**显式转待领取**——重启后残留的
//     outcome='started' 记录不伪装活跃；slot 归还，不伪造成功也不重复派遣（不自动补派）。
//   - pending / 授权 / 目标 / 机库索引：各 owner 构造函数已自带读回（#50/#51/#52），
//     本模块只做一致性收口：清掉指向已不存在成员的 pending 残留，防「确认键按给幽灵」。
//   - 全程留痕，不静默。
//
// 迁移（schemaVersion bump）各 owner 自带 parse 纯函数兼容读；本模块是它们的统一调用点。
import { existsSync } from 'node:fs'
import { forgetAttached, listAttached, type AttachResult } from './agent-attach'
import type { DispatchStore } from './dispatch-store'
import type { PendingService } from './pending-service'
import type { MemberRegistry } from './member-registry'

export interface RecoveryReport {
  /** 重启前账本里的接入成员数。 */
  attachedTotal: number
  /** 成功重新拉起的接入成员。 */
  respawned: string[]
  /** 起不来的接入成员（已忘掉并留痕）：memberId → 原因。 */
  respawnFailed: Record<string, string>
  /** 执行期中断、已转待领取的派遣 id。 */
  interruptedDispatches: string[]
  /** 清掉的 pending 残留（成员已不在登记表的）。 */
  droppedGhostPendings: string[]
}

export interface RecoveryDeps {
  selfId(): string
  attachStatePath(): string
  registry: MemberRegistry | null
  store: DispatchStore | null
  pending: PendingService | null
  /** 重新 spawn 一个接入成员（复用接入编排，端口避让 / health 校验都在里面）。 */
  respawn(input: { record: unknown }): Promise<AttachResult>
  log?(line: string): void
  now?(): number
}

/** 派遣账本里「执行期中断」的记录形态（outcome='started' 但进程已随上次退出消失）。 */
export function interruptedDispatchIds(state: { dispatches: Array<{ dispatchId: string; outcome: string }> }): string[] {
  return state.dispatches
    .filter((d) => d.outcome === 'started')
    .map((d) => d.dispatchId)
}

/**
 * 重启恢复唯一入口（app.whenReady → initRecovery）。幂等：只处理账本里的事实，
 * 不产生新状态；重复调用第二遍是 no-op（interrupted 已转 claimable、attached 已清账本）。
 */
export async function runRecovery(deps: RecoveryDeps): Promise<RecoveryReport> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const report: RecoveryReport = {
    attachedTotal: 0,
    respawned: [],
    respawnFailed: {},
    interruptedDispatches: [],
    droppedGhostPendings: []
  }

  // 1) 派遣账本收口：执行期中断 → 待领取（显式异常态），slot 归还。#59 的补派读这里。
  if (deps.store) {
    const snapshot = deps.store.snapshot()
    for (const dispatchId of interruptedDispatchIds(snapshot)) {
      const record = snapshot.dispatches.find((d) => d.dispatchId === dispatchId)
      if (!record) continue
      deps.store.settleFailed(
        {
          dispatchId: record.dispatchId,
          groupId: record.groupId,
          dispatcherId: record.dispatcherId,
          memberIds: record.memberIds,
          goalOneLine: record.goalOneLine,
          depth: record.depth,
          slot: record.slot,
          userDataDir: record.userDataDir
        },
        '主进程重启导致执行中断（恢复不造假：不伪装活跃，不自动补派）',
        undefined,
        undefined,
        // 恢复路径：这些成员确实已随上次进程退出消失，整批存在过等于整批中断 → 整条覆盖。
        { replaceStarted: true }
      )
      report.interruptedDispatches.push(dispatchId)
      log(`[recovery] 派遣 ${dispatchId} 执行中断 → 待领取（@${record.dispatcherId}）`)
    }
  }

  // 2) pending 残留收口：成员已不在登记表的 pending 是幽灵草稿——确认键按了也起不来。
  if (deps.pending && deps.registry) {
    for (const draft of deps.pending.list()) {
      if (deps.registry.get(draft.memberId)) continue
      deps.pending.drop(draft.memberId, 'recovery', draft.groupId)
      report.droppedGhostPendings.push(draft.memberId)
      log(`[recovery] 清掉幽灵 pending：${draft.memberId}（登记表已无此成员）`)
    }
  }

  // 3) 接入成员重新拉起：账本里每一条都代表「上次退出前活着的成员进程」。
  if (existsSync(deps.attachStatePath())) {
    const attached = listAttached({ attachStatePath: deps.attachStatePath })
    report.attachedTotal = attached.length
    for (const record of attached) {
      log(`[recovery] 重新拉起接入成员 ${record.memberId}（${record.runtime}）`)
      let result: AttachResult
      try {
        result = await deps.respawn({ record })
      } catch (err) {
        result = {
          ok: false,
          memberId: record.memberId,
          nodeId: '',
          dataDir: record.dataDir,
          apiPort: record.apiPort,
          udpPort: record.udpPort,
          tcpPort: record.tcpPort,
          runtime: record.runtime,
          adapterPath: '',
          model: record.model,
          permissionMode: record.permissionMode,
          hint: '',
          error: String((err as Error)?.message ?? err)
        }
      }
      if (result.ok) {
        report.respawned.push(record.memberId)
      } else {
        // 起不来就忘掉：账本留着只会让 existingPorts 永远避让一组死端口。
        // 成员登记表同步撤（spawn 失败路径同款纪律：不留幽灵成员）。
        forgetAttached(record.memberId, { attachStatePath: deps.attachStatePath })
        deps.registry?.unregister(record.memberId)
        report.respawnFailed[record.memberId] = result.error
        log(`[recovery] 接入成员 ${record.memberId} 拉起失败，已从账本移除：${result.error}`)
      }
    }
  }

  log(
    `[recovery] 完成：接入 ${report.respawned.length}/${report.attachedTotal} 拉起，` +
      `中断派遣 ${report.interruptedDispatches.length} 转待领取，幽灵 pending ${report.droppedGhostPendings.length}`
  )
  return report
}

/** 派遣成员 userData 目录（与 DispatchService 同源口径；恢复日志用）。 */
export function dispatchedUserDataDir(userDataRoot: string, nodeId: string): string {
  return `${userDataRoot}/dispatched/${nodeId}`
}
