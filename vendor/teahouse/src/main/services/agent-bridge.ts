// agent-bridge（ADR-0002 Decision 3 / SPEC #41 第四阶段）：把群里的 @ 变成一次 ACP turn，
// 再把正式回复发回群。零 electron 依赖（deps 注入），可无 Electron 单测。
//
// 触发判定逐字依据 ADR-0002 Decision 6：
//   `view.mentioned` 只在 `payload.mentions.includes(selfId)` 那一瞬由 groups.ts 置位，
//   mentions 不落消息表 ⇒ **绝不能查库回放**；必须同时排除 isMine / system / dedup。
//
// 正式消息链逐字依据 ADR-0008：turn 内 `agent_message_chunk` 累积 → 自然边界分条 →
// 首条 `replyTo` 指回派单；过程（thought/tool/plan/usage）不进群，只落本机账本。

import type { MessageView } from '../../shared/ipc'
import { splitFormalMessage } from './formal-message'
import { SessionLedger, FORMAL_UPDATE_KIND } from './session-ledger'
import { PENDING_AGGREGATE_PREFIX } from '../hive/pending-gate'
import type { AcpRunner, RunnerUpdate } from '../acp/session'

/** 触发闸门：证伪任一条即不触发（fail-closed）。 */
export interface TriggerInput {
  isMine: boolean
  kind: MessageView['kind']
  mentioned?: boolean
}

/**
 * 一次 @ 是否应触发 turn。**纯函数**——SPEC #41 要求"仅 @ 触发一次"可被独立验证。
 * 四种不触发的情形：自己发的 / 系统消息 / 未 @ 本机 / 非文本消息。
 */
export function shouldTrigger(input: TriggerInput): boolean {
  if (input.isMine) return false
  if (input.kind !== 'text') return false
  if (input.mentioned !== true) return false
  return true
}

export interface AgentBridgeDeps {
  selfId: string
  /** 群消息事件面（`groups.on('message')`）。 */
  onGroupMessage(listener: (msg: MessageView) => void): void
  /** 发一条群文本；返回 null 表示被拒（不在群里 / 超限 / 群不存在）。 */
  sendText(groupId: string, text: string, mentions?: string[], replyTo?: string): MessageView | null
  /** 本机成员 id → artifacts root 下的会话账本目录根。 */
  artifactsRoot(): string
  /** 过程更新的事件面上报（`acp.update`，契约表 #46 生产者）。可选：无事件面时只落账本。 */
  emitAcpUpdate?(data: { memberId: string; sessionId: string; sessionUpdate: string; turnSeq: number }): void
  /**
   * 真实 usage 上报（#49 AC5）：把 ACP `usage_update` 的原始载荷交给成员状态通道，
   * 由它转成 burden 并广播 —— bridge 不算档位、不定阈值（那是状态通道的所有权）。
   * 未注入 = 不驱动负担（节点仍是普通成员）。
   */
  emitUsage?(usage: unknown): void
  log?(line: string): void
  now?(): number
}

export interface AgentBridgeOptions {
  /** runner 已就绪；未传 = 无 agent，节点仍是普通群成员（显式降级，不静默）。 */
  runner?: AcpRunner | null
  /** 单 turn 上限（ms）；超时即失败并留痕。 */
  turnTimeoutMs?: number
  /** 触发策略闸门；缺省全放行（`group`＝群成员即可，呼应"任何人可 steering"）。 */
  canTrigger?: (msg: MessageView) => boolean
  /**
   * pending 闸门（#50，可选）：未传 = 直接触发（#46 行为不变，e2e 回归不受影响）。
   * - `route(msg)`：返回 'collect'（进 pending 收集期）/ 'steer'（执行期直通，免审）/ 'reject'。
   * - `onCollect(msg)`：把留言收进 pending。
   * - `takeTurn(msg)`：取出已确认的聚合 turn（确认键通过后由服务层投递）。
   * - `onSteer(msg)`（#55，可选）：steering 消息先交目标守卫判定，由它决定放行/派遣/警告。
   */
  pendingGate?: {
    route(msg: MessageView): 'collect' | 'steer' | 'reject'
    onCollect(msg: MessageView): boolean
    takeTurn(msg: MessageView): string | null
    onSteer?(msg: MessageView): Promise<void>
  }
  /**
   * #60 输入交接接手闸（可选）：派遣成员开工前复验 HIVE_HANDOFF_PATH 指向的交接文档。
   * 未传 = 无交接要求（#51 goalOneLine-only 行为不变）。返回 errors 非空 = fail-closed：
   * 不启动 runner.prompt（零实质输出），群内发拒绝原因 + 要求重发，证据落 handover 账本行。
   */
  handoffGate?: {
    check(): { ok: true } | { ok: false; errors: string[] }
  }
}

export interface BridgeStatus {
  enabled: boolean
  running: boolean
  turns: number
  lastError?: string
}

/**
 * 胶水层：群消息 → ACP turn → 分条正式回复。
 * 同一时刻 ≤1 turn（串行）；turn 期间新到的 @ 排队，不并发、不丢。
 */
export class AgentBridge {
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly ledger: SessionLedger
  /** 已处理过的触发消息 id：dedup 兜底（groups 侧 insert 去重已挡住大部分，这里防重放）。 */
  private readonly handled = new Set<string>()
  private running = false
  private turns = 0
  private lastError: string | undefined
  private disposed = false
  private readonly queue: MessageView[] = []
  /** 当前 turn 的账本行缓冲（结算时写 Markdown 时间线）。 */
  private timeline: string[] = []
  private currentSessionKey = ''

  constructor(
    private readonly deps: AgentBridgeDeps,
    private readonly options: AgentBridgeOptions = {}
  ) {
    this.log = deps.log ?? ((line: string) => console.log(line))
    this.now = deps.now ?? (() => Date.now())
    this.ledger = new SessionLedger(deps.artifactsRoot(), deps.selfId, deps.selfId, this.now)
    this.deps.onGroupMessage((msg) => this.onGroupMessage(msg))
    this.options.runner?.on('update', (update: RunnerUpdate) => this.onRunnerUpdate(update))
  }

  status(): BridgeStatus {
    return {
      enabled: Boolean(this.options.runner),
      running: this.running,
      turns: this.turns,
      ...(this.lastError ? { lastError: this.lastError } : {})
    }
  }

  /**
   * #50：确认键通过后由装配层直接投递聚合 prompt（不走群消息，不污染群聊）。
   * 与 @ 触发的 turn 同一串行队列；groupId 显式给出（pending 归属群）。
   * 返回 false = 未启用 runner（调用方显式反馈，不静默）。
   */
  enqueueAggregate(prompt: string, groupId: string, replyTo?: string): boolean {
    if (!this.options.runner || this.disposed) return false
    const synthetic: MessageView = {
      id: `pending-confirm-${this.now()}`,
      convId: `group:${groupId}`,
      senderId: this.deps.selfId,
      isMine: true,
      kind: 'text',
      text: prompt,
      ts: this.now(),
      seq: 0,
      status: 'sent',
      ...(replyTo ? { replyTo } : {})
    }
    this.queue.push(synthetic)
    void this.drain()
    return true
  }

  private onGroupMessage(msg: MessageView): void {
    if (this.disposed) return
    const trigger = { isMine: msg.isMine, kind: msg.kind, ...(msg.mentioned ? { mentioned: msg.mentioned as boolean } : {}) }
    if (!shouldTrigger(trigger)) return
    if (this.handled.has(msg.id)) return
    if (this.options.canTrigger && !this.options.canTrigger(msg)) {
      this.log(`[bridge] 策略拒绝触发 ${msg.id}`)
      return
    }
    if (!this.options.runner) {
      // 未配置 agent：被 @ 不回复是**设计内降级**，但必须可观察，不静默。
      this.log(`[bridge] 收到 @ 但未启用 agent（无 PANTRY_AGENT_COMMAND），不产生回复：${msg.id}`)
      return
    }
    // pending 闸门（#50）：collect = 空闲收集期（不触发 turn）；steer = 执行期直通（免审，不进 pending）；
    // takeTurn 命中 = 确认键刚通过、带着聚合 prompt 回来的那条启动消息。
    if (this.options.pendingGate) {
      const route = this.options.pendingGate.route(msg)
      if (route === 'reject') return
      if (route === 'collect') {
        this.handled.add(msg.id)
        const accepted = this.options.pendingGate.onCollect(msg)
        this.log(`[bridge] pending 收集 ${accepted ? '已收' : '被拒'}：${msg.id}`)
        return
      }
      // steer 或已确认的启动消息：继续走下方触发路径。
      if (route === 'steer') {
        const aggregate = this.options.pendingGate.takeTurn(msg)
        if (aggregate !== null) {
          this.handled.add(msg.id)
          this.queue.push({ ...msg, text: aggregate })
          void this.drain()
          return
        }
        // #55 目标守卫：steering 消息先交守卫判定（fire-and-forget——不阻塞消息事件面，
        // 守卫放行时经 enqueueAggregate 把 turn 投回串行队列）。
        if (this.options.pendingGate.onSteer) {
          this.handled.add(msg.id)
          void this.options.pendingGate.onSteer(msg).catch((err: unknown) => {
            this.log(`[bridge] 目标守卫链路异常：${String((err as Error)?.message ?? err)}`)
          })
          return
        }
      }
    }
    this.handled.add(msg.id)
    this.queue.push(msg)
    void this.drain()
  }

  /** 串行执行队列；同一时刻 ≤1 turn。 */
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const msg = this.queue.shift()
        if (!msg) break
        await this.runTurn(msg)
      }
    } finally {
      this.running = false
    }
  }

  private groupIdOf(msg: MessageView): string {
    return msg.convId.startsWith('group:') ? msg.convId.slice('group:'.length) : msg.convId
  }

  private async runTurn(trigger: MessageView): Promise<void> {
    const runner = this.options.runner
    if (!runner) return
    const groupId = this.groupIdOf(trigger)
    // #50 聚合 turn：合成消息（enqueueAggregate），prompt 原样透传、不注入群历史。
    const isAggregate = trigger.text.startsWith(PENDING_AGGREGATE_PREFIX)
    // 每个 turn 一个 session key：一个会话只干一个任务（map 的第一性原理）。
    const sessionKey = `turn-${this.now()}-${trigger.id}`
    this.currentSessionKey = sessionKey
    this.timeline = []
    this.ledger.append('inbound', {
      messageId: trigger.id,
      groupId,
      senderId: trigger.senderId,
      text: trigger.text,
      mentioned: true,
      replyTo: trigger.replyTo
    })

    // #60 接手闸：交接缺失 / sha256 不匹配 → 不跑 runner（零实质输出）、不产生正式消息，
    // 群内只发一条拒绝原因 + 重发要求；证据落 handover 行（机库可查）。修复后下次 turn 重试。
    if (this.options.handoffGate) {
      const gate = this.options.handoffGate.check()
      if (!gate.ok) {
        const reason = gate.errors.join('；') || '交接文档缺失'
        const text = `⛔ 拒绝接手：${reason}。零实质输出，任务未标记完成；请修复交接后重发。`
        this.lastError = `${sessionKey}: ${reason}`
        this.ledger.append('handover', {
          phase: 'accept',
          ok: false,
          errors: gate.errors,
          messageId: trigger.id
        })
        this.deps.sendText(groupId, text, [trigger.senderId], trigger.id)
        this.log(`[bridge] 拒绝接手（#60）：${reason}`)
        return
      }
    }

    const promptText = isAggregate
      ? trigger.text.slice(PENDING_AGGREGATE_PREFIX.length).trim()
      : this.composePrompt(trigger)
    this.ledger.append('outbound', { kind: 'session/prompt', sessionId: sessionKey, text: promptText })
    this.timeline.push(`## 派单\n\n- 触发消息: \`${trigger.id}\`\n- 派单者: \`${trigger.senderId}\`\n\n\`\`\`\n${trigger.text}\n\`\`\``)
    this.log(`[bridge] 触发 turn：${trigger.id}`)

    let result: { stopReason: string; text: string }
    try {
      result = await runner.prompt(promptText, sessionKey)
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
      this.lastError = `${sessionKey}: ${message}`
      this.ledger.append('turn', { sessionId: sessionKey, ok: false, error: message })
      this.log(`[bridge] turn 失败：${message}`)
      // 失败也要入群可见（fail-closed 但不静默）：发一条系统可读的提示。
      this.deps.sendText(groupId, `⚠ 回复失败：${message}`, [], trigger.id)
      return
    }

    this.turns += 1
    this.ledger.append('turn', {
      sessionId: sessionKey,
      ok: true,
      stopReason: result.stopReason,
      formalBytes: Buffer.byteLength(result.text, 'utf8')
    })
    this.ledger.writeMarkdown(
      {
        成员: this.deps.selfId,
        会话: sessionKey,
        触发消息: trigger.id,
        结束原因: result.stopReason,
        结束时间: new Date(this.now()).toISOString()
      },
      this.timeline
    )

    const pieces = splitFormalMessage(result.text)
    if (pieces.length === 0) {
      // turn 结束但无正式产出：不伪造消息（"无 handoff = 没有结果"同源纪律）。
      this.log(`[bridge] turn ${sessionKey} 无正式产出（stopReason=${result.stopReason}）`)
      return
    }
    for (let i = 0; i < pieces.length; i += 1) {
      // 首条 replyTo 指回派单；后续条目不带（它们是同一次回复的续篇，seq 连续）。
      const sent = this.deps.sendText(
        groupId,
        pieces[i],
        [trigger.senderId],
        i === 0 ? trigger.id : undefined
      )
      if (!sent) {
        // sendText 返回 null 的处理：ADR-0008 明令"不允许底层发送返回空值后静默失败"。
        const reason = `第 ${i + 1}/${pieces.length} 条被拒（超限或已不在群内）`
        this.lastError = `${sessionKey}: ${reason}`
        this.ledger.append('turn', { sessionId: sessionKey, ok: false, error: reason, piece: i + 1 })
        this.log(`[bridge] ${reason}`)
        return
      }
      this.timeline.push(`## 正式消息 ${i + 1}/${pieces.length}\n\n\`\`\`\n${pieces[i]}\n\`\`\``)
    }
    this.log(`[bridge] turn ${sessionKey} 完成：${pieces.length} 条正式消息`)
  }

  /** 过程更新：只落账本 + 走上事件面，绝不进群（ADR-0008）。 */
  private onRunnerUpdate(update: RunnerUpdate): void {
    this.ledger.append('update', {
      sessionId: update.sessionId || this.currentSessionKey,
      sessionUpdate: update.sessionUpdate,
      ...(update.textDelta === undefined ? {} : { textDelta: update.textDelta }),
      raw: update.raw
    })
    // 事件面（契约表 acp.update）：正式消息增量也算一次更新，机库按 turn 分组要看它。
    this.deps.emitAcpUpdate?.({
      memberId: this.deps.selfId,
      sessionId: update.sessionId || this.currentSessionKey,
      sessionUpdate: update.sessionUpdate,
      turnSeq: this.turns + 1
    })
    // #49 AC5：真实 usage 驱动成员行负担。**先在过程分流之前处理**——usage_update 属过程
    // （不进群），但它同时是负担的唯一真实来源，不能跟着「过程只落账本」一起被咽掉。
    if (update.sessionUpdate === 'usage_update') {
      this.deps.emitUsage?.(update.raw)
    }
    if (update.sessionUpdate === FORMAL_UPDATE_KIND) {
      // 正式消息增量也留痕（出向证据），但进群由 turn 结算统一做（分条需要全文）。
      return
    }
    const label = update.sessionUpdate === 'agent_thought_chunk' ? '思考' : update.sessionUpdate
    this.timeline.push(`### 过程 · ${label}\n\n\`\`\`json\n${safeJson(update.raw)}\n\`\`\``)
  }

  /**
   * prompt 组装（SPEC #41："群聊内容如何进 agent 上下文 = 胶水层规格"）。
   * 采用 prompt 注入：只注入**这次派单的原文**，不带群历史——呼应"绝不共享上下文"。
   * pending 确认路径传入的 text 已是聚合 prompt（首行带 `pending-aggregate:` 标记），原样透传。
   */
  private composePrompt(trigger: MessageView): string {
    if (trigger.text.startsWith('pending-aggregate:')) {
      return trigger.text.slice('pending-aggregate:'.length).trim()
    }
    return [
      '你是本群的一个成员，刚在群里被 @ 到。请针对下面这条消息给出回复。',
      '',
      `派单者：${trigger.senderId}`,
      '派单原文：',
      '```',
      trigger.text,
      '```',
      '',
      '请直接给出要发到群里的正式回复（Markdown 可用）。',
      '不要复述本提示，不要输出思考过程。'
    ].join('\n')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.queue.length = 0
    await this.options.runner?.dispose()
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 1) ?? String(value)
  } catch {
    return '[unserializable]'
  }
}
