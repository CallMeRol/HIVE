// local-api 装配层（ADR-0002）：把 services 的读取面与命令面接到回环 HTTP+SSE 上。
// 纪律：本文件与 server.ts 一律不 import electron —— 依赖全部由 index.ts 注入闭包。
import type { MessageView } from '../../shared/ipc'
import { createLocalApi, listenLocalApi, type LocalApi, type LocalApiServer } from './server'
import { HANGAR_PAGE_HTML } from './hangar-page'

/** 事件面只依赖“能发 message 事件”这一件事，便于无 Electron 单测。 */
export interface GroupMessageSource {
  on(event: 'message', listener: (msg: MessageView) => void): unknown
}

/** `message.new` 的信封 data（字段名批内冻结，见 docs/contracts/parallel-development.md）。 */
export interface MessageNewData {
  messageId: string
  groupId: string
  senderId: string
  kind: 'formal' | 'system'
  text: string
  replyTo?: string
}

/** 群会话 id 形如 `group:<groupId>`（ConvRepo.ensureGroup 约定）；非群会话原样返回。 */
export function groupIdOfConv(convId: string): string {
  return convId.startsWith('group:') ? convId.slice('group:'.length) : convId
}

/** MessageView → `message.new` 投影（是否进群由上游决定，这里不二次筛选）。 */
export function toMessageNewData(msg: MessageView): MessageNewData {
  return {
    messageId: msg.id,
    groupId: groupIdOfConv(msg.convId),
    senderId: msg.senderId,
    kind: msg.kind === 'system' ? 'system' : 'formal',
    text: msg.text,
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {})
  }
}

/** `acp.update` 的信封 data（批内冻结，见 docs/contracts/parallel-development.md）。 */
export interface AcpUpdateData {
  memberId: string
  sessionId: string
  sessionUpdate: string
  turnSeq: number
}

/** 过程更新 → `acp.update` 投影（过程不进群，只走事件面，落本机机库）。 */
export function toAcpUpdateData(input: {
  memberId: string
  sessionId: string
  sessionUpdate: string
  turnSeq: number
}): AcpUpdateData {
  return {
    memberId: input.memberId,
    sessionId: input.sessionId,
    sessionUpdate: input.sessionUpdate,
    turnSeq: input.turnSeq
  }
}

export interface HiveLocalApiDeps {
  nodeId(): string
  nick(): string
  setupDone(): boolean
  /** 请求的 local-api 端口；0 = 临时端口。 */
  requestPort(): number
  udpPort(): number
  tcpPort(): number
  token(): string
  agentEnabled(): boolean
  /** 机库读取面（#52）：四端点全部只读，写归 SessionLedger / Hangar 唯一写者。 */
  hangar?: {
    overview(): unknown
    timeline(query: {
      memberId: string
      sessionId?: string
      kinds?: string[]
      q?: string
      limit?: number
    }): unknown[] | null
    markdown(memberId: string, sessionId: string): string | null
    clear(input: { memberId: string; actorId: string }): {
      ok: boolean
      archived: string[]
      epoch: number
      goalPending: boolean
      reason?: string
    }
  }
  /** #51：派遣服务（DispatchService.dispatch）；未启用 = undefined，端点返回 501。 */
  dispatch?(input: {
    groupId: string
    dispatcherId: string
    goalOneLine: string
    dispatcherDepth: number
    count: number
    /** #54/#60：可选输入交接 Markdown（fail-closed 校验）。 */
    handoverMarkdown?: string
  }): Promise<unknown | null>
  /** #54：回收派遣成员（DispatchService.reclaim）；未启用 = undefined，端点返回 501。 */
  reclaim?(input: { memberId: string; actorId: string; handoverMarkdown: string }): Promise<unknown | null>
  /** 跨机状态通道诊断（#47）：能力位、生产者开关、缓存与丢弃计数。 */
  agentStatus(): { cap: string; producer: string; cached: number; dropped: number }
  /** #50 pending 面（未启用闸门时为 null）；e2e 经 health 观察药丸与目标状态。 */
  pendingState(): unknown | null
  /**
   * #59 待领取任务面：`{ autoDispatch: false, tasks[] }`（未装配派遣账本时为空表）。
   * e2e 与现场经 health 直接看到「runner 猝死后任务回了待领取」及「默认不自动补派」。
   */
  claimable(): unknown
  /** #55 目标守卫面：启用状态 + 最近判定审计（机库审计数据源，未配置守卫时 enabled=false）。 */
  goalGuard(): { enabled: boolean; recentAudits: unknown[] }
  groupCount(): number
  onlinePeerCount(): number
  /** UDP 是否真的起来了；没起来时附上原因（打包后本地网络权限被拒会体现为 ok=false）。 */
  netState(): { ok: boolean; error?: string }
  sendMessage(input: {
    groupId: string
    text: string
    mentions?: string[]
    replyTo?: string
  }): MessageView | null
  /** #51：派遣服务（DispatchService.dispatch）；未启用 = undefined，端点返回 501。 */
  dispatch?(input: {
    groupId: string
    dispatcherId: string
    goalOneLine: string
    dispatcherDepth?: number
    count: number
    /** #54/#60：可选输入交接 Markdown。 */
    handoverMarkdown?: string
  }): Promise<unknown | null>
  requestQuit(): void
  log?(line: string): void
}

export interface HiveLocalApi {
  /** 已绑定的实际端口（listen 成功后才有意义）。 */
  port(): number
  /** 把群消息事件面接上（在 groups service 就绪后调用一次）。 */
  attachGroups(source: GroupMessageSource): void
  /**
   * 广播一条信封到所有 SSE 订阅者（`docs/contracts/parallel-development.md` 冻结表内的事件
   * 由各 owner ticket 自己投影）。不做业务判定，只转发。
   */
  emit(type: string, data: unknown): void
  /**
   * 把一个批内冻结事件类型的生产者接上（如 #47 的 `burden.updated`）。
   * 只透传到 SSE，业务判定仍留在各自 owner 模块里。
   */
  attachEventSource<K extends string>(
    type: K,
    source: { on(event: K, listener: (data: unknown) => void): unknown }
  ): void
  /** 广播一条 `acp.update`（过程更新；不进群，只走事件面）。 */
  emitAcpUpdate(data: AcpUpdateData): void
  listen(): Promise<void>
  stop(): Promise<void>
}

export function createHiveLocalApi(deps: HiveLocalApiDeps): HiveLocalApi {
  const log = deps.log ?? ((line: string) => console.log(line))
  let actualPort = 0
  let server: LocalApiServer | null = null

  const api: LocalApi = createLocalApi({
    token: deps.token(),
    log,
    requestQuit: () => deps.requestQuit(),
    sendMessage: (input) => deps.sendMessage(input),
    // 机库端点按「未装配 = 显式 503」接：不假装空机库，也不让页面静默空白。
    ...(deps.hangar
      ? {
          hangar: {
            page: () => HANGAR_PAGE_HTML,
            overview: () => deps.hangar!.overview(),
            timeline: (query) => deps.hangar!.timeline(query),
            markdown: (memberId, sessionId) => deps.hangar!.markdown(memberId, sessionId),
            clear: (input) => deps.hangar!.clear(input)
          }
        }
      : {}),
    ...(deps.dispatch
      ? {
          dispatch: (input) =>
            deps.dispatch?.({
              groupId: input.groupId,
              dispatcherId: input.dispatcherId === 'self' ? deps.nodeId() : input.dispatcherId,
              goalOneLine: input.goalOneLine,
              ...(input.dispatcherDepth !== undefined
                ? { dispatcherDepth: input.dispatcherDepth }
                : {}),
              count: input.count,
              ...(input.handoverMarkdown !== undefined
                ? { handoverMarkdown: input.handoverMarkdown }
                : {})
            }) ?? Promise.resolve(null)
        }
      : {}),
    ...(deps.reclaim
      ? {
          reclaim: (input: { memberId: string; actorId: string; handoverMarkdown: string }) =>
            deps.reclaim?.({
              memberId: input.memberId,
              actorId: input.actorId === 'self' ? deps.nodeId() : input.actorId,
              handoverMarkdown: input.handoverMarkdown
            }) ?? Promise.resolve(null)
        }
      : {}),
    health: () => ({
      ok: true,
      v: 1,
      nodeId: deps.nodeId(),
      nick: deps.nick(),
      setupDone: deps.setupDone(),
      ports: { udp: deps.udpPort(), tcp: deps.tcpPort(), api: actualPort },
      groups: deps.groupCount(),
      peers: deps.onlinePeerCount(),
      agent: deps.agentEnabled() ? 'on' : 'off',
      agentStatus: deps.agentStatus(),
      pending: deps.pendingState(),
      claimable: deps.claimable(),
      goalGuard: deps.goalGuard(),
      net: deps.netState()
    })
  })

  return {
    port: () => actualPort,
    attachGroups(source) {
      source.on('message', (msg: MessageView) => {
        api.emit('message.new', toMessageNewData(msg))
      })
    },
    emit(type, data) {
      api.emit(type, data)
    },
    attachEventSource(type, source) {
      source.on(type, (data) => api.emit(type, data))
    },
    emitAcpUpdate(data) {
      api.emit('acp.update', toAcpUpdateData(data))
    },
    async listen() {
      server = await listenLocalApi(api, { port: deps.requestPort() })
      actualPort = server.port
      log(`[local-api] 监听 127.0.0.1:${actualPort}`)
    },
    async stop() {
      const current = server
      server = null
      if (current) await current.stop()
    }
  }
}
