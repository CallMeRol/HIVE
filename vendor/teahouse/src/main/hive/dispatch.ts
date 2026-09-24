// Hive 派遣编排（#51 / ADR-0006）：为一次任务摇入一个全新上下文的成员。
//
// 顺序（ADR-0006 Decision「先 invite 后起」，零中间态）：
//   生成离线身份（uuid + 新 userData + 完整 config.json + identity.json）
//   → updateGroup(invite)（无权限门，rev+1，info 进补发队列）
//   → set-admin 派遣者（ADR-0006：建群时给派遣者 admin，服务性回收权）
//   → spawn headless 节点（PANTRY_HEADLESS=1、独立 userData/端口/静态对端）
//   → 轮询 /v1/health ≤30s，nodeId 必须等于预生成值（不等即失败，fail-closed）
//   → 成功：memberRegistry 登记 + member.lifecycle(spawn_ok) + dispatch.event(started)
//   失败：自动补试一次 → 仍失败 → 任务转待领取（claimable）+ @主人 + dispatch.event(claimable)。
//
// 纪律：新成员只拿到 goalOneLine（AC4「不注入父会话历史」）——prompt 组装由新成员自己的
// agent-bridge 完成（它只注入派单原文），本模块不携带任何父会话内容。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GroupsService } from '../services/groups'
import type { MemberRegistry } from './member-registry'
import {
  DispatchStore,
  portsForSlot,
  type ClaimableTask,
  type DispatchRecord
} from './dispatch-store'
import { verifyHandover, handoverOkText, handoverRejectText, type HandoffEvidence } from './handover'

export const HEALTH_TIMEOUT_MS = 30_000
export const HEALTH_POLL_MS = 500

/**
 * 完整字段集的 config.json 预置（#44 landmine 1：残缺 config 会静默杀死发现）。
 * 与 upstream `src/main/store/app-state.ts` 的 ConfigFile 逐字段对齐——scripts/lib/hive-node-config.mjs
 * 的同表拷贝（vendor 树不能 import 仓库 scripts；两处同步由「字段集 = upstream ConfigFile」注释锚定）。
 */
function writeNodeConfig({ dataDir, nick, udp, tcp }: { dataDir: string; nick: string; udp: number; tcp: number }): void {
  const config = {
    nick,
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    avatarHash: '',
    profileRev: 1,
    setupDone: false,
    fileDir: '',
    notifications: true,
    manualPeers: [],
    scanRanges: [],
    scanRangeSources: {},
    ignoredScanRanges: {},
    udpPort: udp,
    tcpPort: tcp,
    hideOnCapture: true,
    autoLaunch: false,
    closeToTray: false,
    language: 'zh-CN',
    theme: 'light',
    fontScale: 100,
    showMessagePreview: true,
    allowDirectFileSend: true,
    fileCabinet: { root: '', mode: 'off' },
    sound: 'none',
    sendKey: 'enter',
    captureShortcut: 'CommandOrControl+Alt+A',
    showHideShortcut: 'CommandOrControl+Alt+P'
  }
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
}

/** 一次派遣请求（Agent 可主动调用，经 local-api /v1/dispatch 进来）。 */
export interface DispatchRequest {
  groupId: string
  dispatcherId: string
  /** 会话目标一句话：新成员的会话目标（也是待领取任务展示的原目标）。 */
  goalOneLine: string
  /**
   * 派遣者当前深度（常驻=1）。缺省由节点自身的 HIVE_DISPATCH_DEPTH 决定（#56 递归派遣：
   * 子成员用自己收到的深度继续派，无需调用方每次手填）。
   */
  dispatcherDepth?: number
  /** 一次摇几个（默认 1）。 */
  count?: number
  /**
   * #54：输入交接 markdown（派遣者写给新成员）。给了就必过校验（fail-closed）；
   * 不给则为老式无交接派遣，保持向后兼容。
   * #60：校验失败另发群内拒绝接手消息并留痕（零实质输出、要求重发）。
   */
  handoverMarkdown?: string
}

export interface DispatchOutcomeView {
  dispatchId: string
  /** 有成员上线即 started（部分成功即成功）；一个都没上 = claimable；前置拒绝 = rejected。 */
  outcome: 'started' | 'claimable' | 'rejected'
  memberIds?: string[]
  /** 整批失败时的待领取任务（部分成功时看 tasks）。 */
  task?: ClaimableTask
  /** 部分成功时，失败成员各自的待领取任务（#56 成员级独立结算）。 */
  tasks?: ClaimableTask[]
  reason?: string
}

export interface DispatchDeps {
  selfId: string
  /** 本节点自身的派遣深度（常驻节点不设 = 1；派遣成员由父经 `HIVE_DISPATCH_DEPTH` 写入）。 */
  selfDepth?: number
  userDataRoot: () => string
  groups: GroupsService
  registry: MemberRegistry
  store: DispatchStore
  /**
   * spawn 一个 headless 节点子进程。注入而非内置：Electron 的 `utilityProcess`/child_process
   * 由 index.ts 接线；单测/rig 用替身。返回 { pid, apiPort }（apiPort 供 health 轮询）。
   */
  spawnNode(input: {
    nodeId: string
    userDataDir: string
    ports: { udp: number; tcp: number; api: number }
    peers: string[]
    goalOneLine: string
    /** 新成员的派遣深度（= 派遣者深度 + 1，#56 递归派遣：子成员据此知道自己的代数）。 */
    depth: number
    /** #60：输入交接落盘路径；子节点经 HIVE_HANDOFF_PATH 开工前复验（缺失/sha256 不匹配 = 拒绝）。 */
    handoffPath?: string
  }): { pid: number; apiPort: number }
  /** 补杀一个 spawn 出来但 health 未过的节点（失败重试前必须收干净，不残留孤儿）。 */
  killNode(pid: number): void
  /**
   * health 轮询（必注入）。Electron 22 内嵌 Node 16 无全局 fetch，HTTP 由 index.ts 用
   * node:http 提供实现；单测/rig 注入替身。nodeId 不等 / 超时 = 失败（fail-closed）。
   */
  pollHealth(apiPort: number, expectNodeId: string, timeoutMs: number): Promise<{ ok: boolean; reason?: string }>
  /** 群里发一条系统可见文本（派遣失败/待领取的 @主人 走群消息，Spec #41「群里可见」）。 */
  sendText(groupId: string, text: string, mentions?: string[], replyTo?: string): unknown | null
  /** 事件面（SSE）：dispatch.event / member.lifecycle 由 index.ts 接线到 localApi.emit。 */
  emit(type: 'dispatch.event' | 'member.lifecycle', data: unknown): void
  /** #54：读产物文件（输入交接 sha256 校验用）；null = 不可读（fail-closed）。 */
  readArtifact?(path: string): Buffer | null
  /** #54 回收：机库归档该成员当前实例全部活跃会话（reason 由调用方定，回收='reclaim'）。 */
  archiveMember(memberId: string, reason: 'reclaim'): string[]
  /** #54 回收：quit——杀成员节点进程 + 撤接入账本（幂等；非本机接入成员 no-op）。 */
  quitMember(memberId: string): void
  /** #60：把通过校验的输入交接落盘，返回绝对路径；null = 落盘失败（fail-closed 拒绝派遣）。 */
  writeHandoff?(dispatchId: string, markdown: string): string | null
  /** #60：交接校验证据进本机机库（SessionLedger handover 行）。 */
  emitHandoffEvidence?(evidence: HandoffEvidence): void
  log?(line: string): void
  now?: () => number
}

export class DispatchService {
  private readonly deps: DispatchDeps
  private readonly log: (line: string) => void
  private readonly now: () => number

  constructor(deps: DispatchDeps) {
    this.deps = deps
    this.log = deps.log ?? ((line: string) => console.log(line))
    this.now = deps.now ?? (() => Date.now())
  }

  /** 主入口：一次派遣（AC2 全链路）。并发请求串行由调用方保证（Electron 主进程单线程天然串行）。 */
  async dispatch(request: DispatchRequest): Promise<DispatchOutcomeView> {
    const count = Math.max(1, Math.min(request.count ?? 1, 8))
    const dispatchId = `dispatch-${this.now()}-${randomUUID().slice(0, 8)}`
    const group = this.deps.groups.get(request.groupId)
    if (!group || !group.members.includes(request.dispatcherId)) {
      return { dispatchId, outcome: 'rejected', reason: '派遣者不在目标群里' }
    }
    // 递归派遣（#56）：派遣者深度缺省 = 本节点自己的代数（常驻 1，派遣成员由父写入的
    // HIVE_DISPATCH_DEPTH 决定）。调用方显式给值时以调用方为准。
    const dispatcherDepth = request.dispatcherDepth ?? this.deps.selfDepth ?? 1
    // #54 AC1/AC2：带输入交接的派遣先过校验（fail-closed：缺节 / 缺三件套 / sha256 不匹配 = 拒绝）。
    // #60：拒绝时群内可见（零实质输出 + 要求重发）；失败证据进本机机库账本。
    // 校验通过后落盘并把路径交给子节点——接手成员开工前复验（缺失/sha256 漂移同样拒绝）。
    let handoffPath: string | undefined
    if (request.handoverMarkdown !== undefined) {
      const handover = verifyHandover(request.handoverMarkdown, {
        readArtifact: (path) => this.deps.readArtifact?.(path) ?? null
      })
      if (!handover.ok) {
        const reason = `输入交接校验未过：${handover.errors.join('；')}`
        this.log(`[dispatch] ${dispatchId} ${reason}`)
        this.deps.sendText(request.groupId, handoverRejectText(reason), [request.dispatcherId])
        this.deps.emitHandoffEvidence?.({
          phase: 'input',
          ok: false,
          errors: handover.errors,
          context: { dispatchId }
        })
        return { dispatchId, outcome: 'rejected', reason }
      }
      const written = this.deps.writeHandoff?.(dispatchId, request.handoverMarkdown) ?? null
      if (written === null) {
        const reason = '输入交接落盘失败（接手成员将无法复验，fail-closed 拒绝派遣）'
        this.log(`[dispatch] ${dispatchId} ${reason}`)
        this.deps.sendText(request.groupId, handoverRejectText(reason), [request.dispatcherId])
        this.deps.emitHandoffEvidence?.({
          phase: 'input',
          ok: false,
          errors: [reason],
          context: { dispatchId }
        })
        return { dispatchId, outcome: 'rejected', reason }
      }
      handoffPath = written
      this.deps.emitHandoffEvidence?.({
        phase: 'input',
        ok: true,
        errors: [],
        context: { dispatchId, artifactCount: handover.artifacts.length }
      })
    }
    const begin = this.deps.store.begin({
      dispatchId,
      groupId: request.groupId,
      dispatcherId: request.dispatcherId,
      dispatcherDepth,
      count
    })
    if (!begin.ok) {
      return { dispatchId, outcome: 'rejected', reason: begin.reason }
    }

    // 1:N 无 barrier（#56 / ADR-0007）：各成员在自己的 slot 上独立 spawn、独立结算。
    // 逐个 await 只为本机串行 spawn 的物理顺序（Electron 主进程单线程），不是汇合点：
    // 一个成员失败**不中断**同批其余成员，成功者照常 started，失败者各自转一条待领取。
    const memberIds: string[] = []
    /**
     * 与 `memberIds` **逐位对齐**的实际占用段。
     *
     * 不能用 `begin.slots.slice(0, memberIds.length)`：`begin.slots` 是连续预留段，而 memberIds
     * 只收**成功**的成员 —— `count=3` 且第 1 个失败（用 slot 1）时实际占用是 `[2,3]`，
     * 切片会写成 `[1,2]`。错位会让回收释放别人的段、自己那段永不归还，并让 #59 的
     * pids 探活按 index 摘错成员（把同批**还活着**的成员判成猝死）。
     */
    const usedSlots: number[] = []
    /** 与 memberIds 逐位对齐的本机子进程 pid（#59 猝死探活的判据）。 */
    const pids: number[] = []
    const failures: { reason: string; slot: number; failedMemberId: string }[] = []
    for (let i = 0; i < count; i += 1) {
      const slot = begin.slots[i]!
      const result = await this.spawnOne({
        dispatchId,
        groupId: request.groupId,
        dispatcherId: request.dispatcherId,
        dispatcherDepth,
        goalOneLine: request.goalOneLine,
        slot,
        ...(handoffPath ? { handoffPath } : {})
      })
      if (result.ok) {
        memberIds.push(result.nodeId)
        usedSlots.push(slot)
        pids.push(result.pid)
      } else {
        // nodeId 是预生成身份：失败成员各自的待领取任务必须指向它，不能指向同批的活成员。
        failures.push({ reason: result.reason, slot, failedMemberId: result.nodeId })
      }
    }

    // 成功的成员立刻结算（部分成功即成功，不整批回滚）。
    if (memberIds.length > 0) {
      const record: Omit<DispatchRecord, 'startedAt' | 'outcome'> = {
        dispatchId,
        groupId: request.groupId,
        dispatcherId: request.dispatcherId,
        memberIds,
        goalOneLine: request.goalOneLine,
        depth: dispatcherDepth + 1,
        slot: usedSlots[0]!,
        slots: usedSlots,
        pids,
        userDataDir: this.userDataDirOf(memberIds[0]!)
      }
      this.deps.store.settleStarted(record)
      this.deps.emit('dispatch.event', {
        dispatcherId: request.dispatcherId,
        memberIds,
        goalOneLine: request.goalOneLine,
        depth: dispatcherDepth + 1,
        outcome: 'started'
      })
    }

    // 预留段里没被**任何**成员用上的尾段整批归还（防御性收口）：
    // 正常循环里每个段都会被成功者占用或被失败者单独归还，但一旦将来加了提前 break，
    // 尾部预留段会永久占着 slot 不还（`releaseReserved` 就是为这条路径准备的）。
    if (memberIds.length + failures.length < count) {
      const claimed = new Set([...usedSlots, ...failures.map((f) => f.slot)])
      this.deps.store.releaseReserved(begin.slots.filter((s) => !claimed.has(s)))
    }

    // 失败成员各自独立结算成一条待领取（成员级独立结算；taskId 带 slot 保证同批互不覆盖）。
    const failedTaskIds: string[] = []
    for (const failure of failures) {
      const task = this.deps.store.settleFailed(
        {
          dispatchId,
          groupId: request.groupId,
          dispatcherId: request.dispatcherId,
          memberIds,
          goalOneLine: request.goalOneLine,
          depth: dispatcherDepth + 1,
          slot: failure.slot,
          slots: [failure.slot],
          userDataDir: this.userDataDirOf(memberIds[0] ?? 'unknown')
        },
        failure.reason,
        `${dispatchId}-slot${failure.slot}`,
        failure.failedMemberId
      )
      failedTaskIds.push(task.dispatchId)
      this.deps.emit('dispatch.event', {
        dispatcherId: request.dispatcherId,
        memberIds,
        goalOneLine: request.goalOneLine,
        depth: dispatcherDepth + 1,
        outcome: 'claimable'
      })
    }

    if (failures.length === 0) {
      return { dispatchId, outcome: 'started', memberIds }
    }

    // @主人（群内可见，Spec #41「任务进入待领取并 @ 原主人」）。
    const reasons = failures.map((f) => f.reason).join('；')
    this.deps.sendText(
      request.groupId,
      `⚠ 派遣部分/全部失败，${failures.length} 个任务待领取（${failedTaskIds.join(', ')}）：${reasons}。原目标：${request.goalOneLine}`,
      [request.dispatcherId]
    )
    const failedTasks = this.deps.store
      .listClaimable()
      .filter((t) => failedTaskIds.includes(t.dispatchId))
    // 有成员上线才是 started（部分成功即成功），否则整批 claimable（AC3 的返回面口径）。
    if (memberIds.length > 0) {
      return { dispatchId, outcome: 'started', memberIds, tasks: failedTasks }
    }
    return { dispatchId, outcome: 'claimable', task: failedTasks[0], tasks: failedTasks }
  }

  /**
   * 人工补派一条待领取任务（#59 AC3：**默认不自动补派**，主人可以人工补派）。
   *
   * 「默认不自动」落在代码结构上：没有任何自动路径调用本方法 —— 生产者（spawn 失败 #51、
   * 异常退群 #59、重启中断 #58）只落待领取账，补派只能由人经 GUI / local-api 显式发起。
   *
   * 幂等保护：只有 status=claimable 的任务能被领取（`claim` 会把它转 claimed）；
   * 已经被领过的任务再补派 = 显式拒绝，不重复摇人。
   */
  async claimAndDispatch(input: {
    dispatchId: string
    /** 补派发起者（人）。必须等于任务原主人（dispatcherId）——AC3「主人可以人工补派」。 */
    actorId: string
  }): Promise<DispatchOutcomeView> {
    const task = this.deps.store
      .listClaimable()
      .find((t) => t.dispatchId === input.dispatchId)
    if (!task) {
      return {
        dispatchId: input.dispatchId,
        outcome: 'rejected',
        reason: '任务不在待领取状态（可能已被补派或已取消）'
      }
    }
    if (task.dispatcherId !== input.actorId) {
      return { dispatchId: input.dispatchId, outcome: 'rejected', reason: '只有该任务的原主人可以补派' }
    }
    // 先领取（claimable → claimed）再摇人：摇人失败会重新落一条新的 claimable（settleFailed），
    // 不会让本条既 claimed 又不可补派 —— 账本上始终能看到「这次补派没成」，不静默丢任务。
    const claimed = this.deps.store.claim(input.dispatchId)
    if (!claimed) {
      return { dispatchId: input.dispatchId, outcome: 'rejected', reason: '任务已被领取' }
    }
    this.log(`[dispatch] 人工补派 ${input.dispatchId}（原目标：${task.goalOneLine}）`)
    const outcome = await this.dispatch({
      groupId: task.groupId,
      dispatcherId: input.actorId,
      goalOneLine: task.goalOneLine,
      count: 1
    })
    // 前置拒绝（深度/并发/slot 用尽）：新派遣压根没开始，既没 started 也没 settleFailed，
    // 任务会卡在 claimed 再也补不了。放回待领取，等资源到位后由人再补（不静默丢任务）。
    if (outcome.outcome === 'rejected') {
      this.deps.store.unclaim(input.dispatchId)
      return { ...outcome, reason: `补派未被接受：${outcome.reason ?? '未知原因'}` }
    }
    return outcome
  }

  /**
   * 摇一个成员：身份 → invite → spawn → health 校验。失败自动补试一次（AC5，
   * 与「异常退群后的补派默认人工」（#59）明确区分）。
   */
  private async spawnOne(input: {
    dispatchId: string
    groupId: string
    dispatcherId: string
    dispatcherDepth: number
    goalOneLine: string
    slot: number
    handoffPath?: string
  }): Promise<
    { ok: true; nodeId: string; pid: number } | { ok: false; reason: string; nodeId: string }
  > {
    // 端口带按**新成员的代数**选：递归派遣时祖父与孙子同机，不隔带会撞同一段端口（#56）。
    const ports = portsForSlot(input.slot, input.dispatcherDepth + 1)
    const nodeId = randomUUID()
    const userDataDir = this.userDataDirOf(nodeId)
    // 离线预生成身份（ADR-0006）：fail-closed 写 identity.json + 完整字段集 config.json（landmine 1）。
    try {
      mkdirSync(userDataDir, { recursive: true })
      writeFileSync(
        join(userDataDir, 'identity.json'),
        `${JSON.stringify({ nodeId, createdAt: this.now() }, null, 2)}\n`
      )
      writeNodeConfig({
        dataDir: userDataDir,
        nick: `派遣成员-${nodeId.slice(0, 6)}`,
        udp: ports.udp,
        tcp: ports.tcp
      })
    } catch (err) {
      return { ok: false, reason: `身份预生成失败：${String((err as Error)?.message ?? err)}`, nodeId }
    }

    // 先 invite（无权限门）：rev+1，新 nodeId 的群 info 进补发队列，节点上线即 bootstrap。
    const invited = this.deps.groups.updateGroup(input.groupId, { kind: 'invite', memberIds: [nodeId] })
    if (!invited || !invited.members.includes(nodeId)) {
      return { ok: false, reason: 'invite 未生效（群不存在或成员表未变化）', nodeId }
    }
    // ADR-0006：建群时 owner set-admin 给派遣者（服务性回收权，只作用于自己派出的成员）。
    // 已是 admin 时底座返回 view（changed=false），静默幂等。
    const group = this.deps.groups.get(input.groupId)
    if (group && !group.adminIds.includes(input.dispatcherId)) {
      this.deps.groups.updateGroup(input.groupId, {
        kind: 'set-admin',
        memberId: input.dispatcherId,
        enabled: true
      })
    }

    // spawn + health 校验，失败补试一次（换 slot 代价太大，同 slot 重试——失败根因多为瞬时资源）。
    let lastReason = ''
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const verified = await this.spawnAndVerify({
        nodeId,
        userDataDir,
        ports,
        goalOneLine: input.goalOneLine,
        depth: input.dispatcherDepth + 1,
        ...(input.handoffPath ? { handoffPath: input.handoffPath } : {})
      })
      if (verified.ok) {
        this.deps.registry.register({
          memberId: nodeId,
          ownerId: this.deps.selfId,
          kind: 'dispatched',
          spawnedBy: input.dispatcherId,
          groupId: input.groupId
        })
        this.deps.emit('member.lifecycle', { memberId: nodeId, phase: 'spawn_ok' })
        this.log(`[dispatch] ${input.dispatchId} 成员 ${nodeId.slice(0, 6)} 上线（attempt=${attempt}）`)
        // pid 一并交回：账本记下它，#59 才能把「进程猝死」与「只是离线」分开。
        return { ok: true, nodeId, pid: verified.pid }
      }
      lastReason = verified.reason
      this.log(`[dispatch] attempt ${attempt} 失败：${verified.reason}`)
    }
    return { ok: false, reason: lastReason, nodeId }
  }

  /** spawn + 轮询 health；成功回 pid（#59 探活用），失败回原因。 */
  private async spawnAndVerify(input: {
    nodeId: string
    userDataDir: string
    ports: { udp: number; tcp: number; api: number }
    goalOneLine: string
    depth: number
    handoffPath?: string
  }): Promise<{ ok: true; pid: number } | { ok: false; reason: string }> {
    const peers = this.selfUdpPeer()
    let child: { pid: number; apiPort: number }
    try {
      child = this.deps.spawnNode({
        nodeId: input.nodeId,
        userDataDir: input.userDataDir,
        ports: input.ports,
        peers,
        goalOneLine: input.goalOneLine,
        depth: input.depth,
        ...(input.handoffPath ? { handoffPath: input.handoffPath } : {})
      })
    } catch (err) {
      return { ok: false, reason: `spawn 失败：${String((err as Error)?.message ?? err)}` }
    }
    const verdict = await this.deps.pollHealth(child.apiPort, input.nodeId, HEALTH_TIMEOUT_MS)
    if (!verdict.ok) {
      // spawn 成功但 health 未过：先收掉这个节点再返回失败（不残留孤儿进程）。
      try {
        this.deps.killNode(child.pid)
      } catch {
        /* 已退出 */
      }
      return { ok: false, reason: verdict.reason ?? 'health 校验失败' }
    }
    return { ok: true, pid: child.pid }
  }

  /** 静态对端：派遣者把自己的 UDP 端口给新节点（同机互见的最短路径，叠加广播不绕过）。 */
  private selfUdpPeer(): string[] {
    return this.selfUdp !== null ? [`127.0.0.1:${this.selfUdp}`] : []
  }

  private selfUdp: number | null = null

  /** index.ts 接线：告知派遣者自己的 UDP 端口（新节点的 PANTRY_PEERS 用）。 */
  setSelfUdp(port: number): void {
    this.selfUdp = port
  }

  private userDataDirOf(nodeId: string): string {
    return join(this.deps.userDataRoot(), 'dispatched', nodeId)
  }

  /**
   * #54 回收（AC3/AC4/AC5）：成员完成后带着**输出交接文档**来，校验成功才放行。
   *
   * 顺序（每步 fail-closed，失败即中断并显式回报，不做半回收）：
   *  1. 判权：调用方必须是该成员的派遣者（record.spawnedBy）；
   *  2. 输出交接校验：七节齐全 + 产物三件套 + sha256 与磁盘一致（AC2，#60 同源函数）；
   *  3. 群内发「校验成功」结论（AC3：不含交接正文/路径/哈希）；
   *  4. 底座 remove（leave）→ 回查成员表真消失 → 撤登记（硬删除 AC4）；
   *  5. 机库归档（reason='reclaim'，AC5：仍可读可搜）；
   *  6. quit：杀节点进程 + 撤接入账本（端口不再被幽灵占用）；
   *  7. 释放 slot（dispatch-store「#54 回收释放」契约落点）。
   */
  async reclaim(input: {
    actorId: string
    memberId: string
    handoverMarkdown: string
  }): Promise<
    | { ok: true; memberId: string; archivedSessions: string[]; artifactCount: number }
    | { ok: false; reason: string }
  > {
    const record = this.deps.registry.get(input.memberId)
    if (!record || record.kind !== 'dispatched') {
      return { ok: false, reason: '成员不存在或不是派遣成员（无登记 = fail-closed）' }
    }
    if (record.spawnedBy !== input.actorId) {
      return { ok: false, reason: '只有派遣者本人可以回收该成员' }
    }
    const groupId = record.groupId ?? ''
    if (!groupId) return { ok: false, reason: '登记记录缺 groupId，无法定位所属群' }

    // 2. 输出交接校验（AC2）。
    const verdict = verifyHandover(input.handoverMarkdown, {
      readArtifact: (path) => this.deps.readArtifact?.(path) ?? null
    })
    if (!verdict.ok) {
      const reason = `交接校验未过：${verdict.errors.join('；')}`
      this.log(`[reclaim] ${input.memberId.slice(0, 6)} ${reason}`)
      // #60：拒绝回收也要群内可见（任务不标完成 + 要求重发），证据进机库。
      this.deps.sendText(groupId, handoverRejectText(reason), [input.actorId])
      this.deps.emitHandoffEvidence?.({
        phase: 'output',
        ok: false,
        errors: verdict.errors,
        context: { memberId: input.memberId }
      })
      return { ok: false, reason }
    }
    this.deps.emitHandoffEvidence?.({
      phase: 'output',
      ok: true,
      errors: [],
      context: { memberId: input.memberId, artifactCount: verdict.artifacts.length }
    })

    // 3. 群内结论（AC3：只有结论，不泄露内容）。
    const nick = `派遣成员-${input.memberId.slice(0, 6)}`
    this.deps.sendText(groupId, handoverOkText(nick, verdict.artifacts.length))

    // 4. 底座 remove（leave）+ 回查（底座对不在群里的目标会假成功，必须确认真消失）。
    const updated = this.deps.groups.updateGroup(groupId, { kind: 'remove', memberIds: [input.memberId] })
    if (!updated || updated.members.includes(input.memberId)) {
      return { ok: false, reason: '底座移出未生效（成员仍在成员表），回收中止' }
    }
    this.deps.registry.unregister(input.memberId)

    // 5. 机库归档（AC5）：实例终结，会话仍可读可搜。
    const archivedSessions = this.deps.archiveMember(input.memberId, 'reclaim')

    // 6. quit：进程收干净 + 接入账本消条（不残留幽灵）。
    this.deps.quitMember(input.memberId)

    // 7. 释放 slot：按登记时期该成员的派遣记录找 slot（recycle）。
    this.deps.store.releaseMemberSlot(input.memberId)

    this.deps.emit('member.lifecycle', { memberId: input.memberId, phase: 'reclaim' })
    const dispatchRecord = this.deps.store.recordOfMember(input.memberId)
    this.deps.emit('dispatch.event', {
      dispatcherId: input.actorId,
      memberIds: [input.memberId],
      goalOneLine: dispatchRecord?.goalOneLine ?? '',
      depth: dispatchRecord?.depth ?? 0,
      outcome: 'settled'
    })
    this.log(`[reclaim] ${input.memberId.slice(0, 6)} 回收完成：归档 ${archivedSessions.length} 个会话`)
    return { ok: true, memberId: input.memberId, archivedSessions, artifactCount: verdict.artifacts.length }
  }
}

/** GroupView.adminIds 直接可用（shared/ipc.ts 批内契约）。 */

export type { ClaimableTask, DispatchRecord } from './dispatch-store'
