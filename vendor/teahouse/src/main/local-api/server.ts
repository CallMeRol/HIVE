// local-api —— 与 ipc/ 并列的第二前台（ADR-0002 Decision 4）。
// 只做“薄适配器 → services”：这里不出现任何业务判定，也不 import electron。
// 传输：node:http 零新依赖，只绑回环；事件面：SSE，信封 { v, seq, type, ts, data }。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 冻结的事件信封（docs/contracts/parallel-development.md）：seq 单调递增作顺序字段。 */
export interface EventEnvelope {
  v: 1
  seq: number
  type: string
  ts: number
  data: unknown
}

/** 与契约表一致：错误一律走信封 type: "error" + 统一错误结构。 */
export interface ErrorBody {
  code: string
  message: string
  details?: unknown
}

/**
 * 机库读取面（#52）。全部是**读**：写入仍归 SessionLedger 与 Hangar 的唯一写者。
 * `null` 表示该成员/会话不存在（显式 404，不返回空数组冒充成功）。
 */
export interface LocalApiHangarDeps {
  /** 静态机库页面（自包含 HTML）。 */
  page(): string
  overview(): unknown
  timeline(query: {
    memberId: string
    sessionId?: string
    kinds?: string[]
    q?: string
    limit?: number
  }): unknown[] | null
  markdown(memberId: string, sessionId: string): string | null
  /**
   * clear（AC4）：终结旧实例并归档，同一身份位置开新实例，目标由人重定。
   *
   * 为什么命令面在 local-api 而不是只走 GUI IPC：归档索引与账本**必须同机**
   * （契约：归档索引落 artifacts root 下 per-member 目录），而成员实例可能是本机
   * 另一个 headless 节点进程 —— 只有那个进程能归档它自己的账本。`actorId` 由调用方
   * 声明，本节点用它对照自己的成员登记表判权（fail-closed）。
   */
  clear(input: { memberId: string; actorId: string }): { ok: boolean; archived: string[]; epoch: number; goalPending: boolean; reason?: string }
}

export interface LocalApiDeps {
  /** GET /v1/health：读本机身份与运行态（读、不判定）。 */
  health(): unknown | Promise<unknown>
  /** POST /v1/lifecycle/quit：唯一的跨平台优雅退出通道（注入闭包）。 */
  requestQuit(): void
  /** POST /v1/messages：发一条群文本。 */
  sendMessage(input: {
    groupId: string
    text: string
    mentions?: string[]
    replyTo?: string
  }): unknown | null
  /** 机库面（#52）；未装配时相关端点显式 503，不假装空机库。 */
  hangar?: LocalApiHangarDeps
  /**
   * POST /v1/dispatch（#51）：派遣一个全新上下文的成员。业务判定全在 DispatchService，
   * 这里只做输入形状校验；返回 view 或 null（null = 前置拒绝，转 409）。
   */
  dispatch?(input: {
    groupId: string
    dispatcherId: string
    goalOneLine: string
    /** 缺省 = 本节点自身的代数（由 DispatchService 决定，见 #56 递归派遣）。 */
    dispatcherDepth?: number
    count: number
    /** #54/#60：可选输入交接 Markdown；提供时派遣前七节 + sha256 fail-closed 校验。 */
    handoverMarkdown?: string
  }): unknown | null | Promise<unknown | null>
  /**
   * POST /v1/reclaim（#54）：回收一个派遣成员。编排与判权全在 DispatchService.reclaim
   * （输出交接七节 + 产物 sha256 校验 fail-closed → leave → 硬删 → 归档 → quit → 释放 slot）。
   * 返回 view 或 null（null = 前置拒绝，转 409）。
   */
  reclaim?(input: { memberId: string; actorId: string; handoverMarkdown: string }):
    | unknown
    | null
    | Promise<unknown | null>
  /** 空 = 仅回环可达即可信（ADR-0002 Decision 4）。 */
  token?: string
  now?: () => number
  log?: (line: string) => void
}

export interface LocalApi {
  /** 广播到所有 SSE 订阅者；无人订阅时是 no-op。 */
  emit(type: string, data: unknown): void
  /** 直接交给 node:http 的请求处理函数（便于无端口单测）。 */
  handle(req: IncomingMessage, res: ServerResponse): void
  subscriberCount(): number
  closeSubscribers(): void
}

/** 只回环可达即视为可信时，仍给一个上限，避免本机任意进程把事件流拉爆。 */
const MAX_SUBSCRIBERS = 32
const MAX_BODY_BYTES = 64 * 1024
/** 群文本上限沿用上游 TEXT_TCP_LIMIT / IPC 同款（4096 字符），越界显式报错而不是静默截断。 */
const MAX_TEXT_CHARS = 4096

function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined ? { code, message } : { code, message, details }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // 回环第二前台无需对外暴露；顺手关掉缓存与嗅探。
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(text)
}

function sendError(res: ServerResponse, status: number, body: ErrorBody): void {
  sendJson(res, status, body)
}

async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) {
      throw Object.assign(new Error('body too large'), { code: 'body_too_large', status: 413 })
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() === '' ? {} : JSON.parse(raw)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function createLocalApi(deps: LocalApiDeps): LocalApi {
  const now = deps.now ?? (() => Date.now())
  const token = (deps.token ?? '').trim()
  const subscribers = new Set<ServerResponse>()
  let seq = 0

  function emit(type: string, data: unknown): void {
    if (subscribers.size === 0) return
    seq += 1
    const envelope: EventEnvelope = { v: 1, seq, type, ts: now(), data }
    const frame = `data: ${JSON.stringify(envelope)}\n\n`
    for (const res of subscribers) {
      try {
        res.write(frame)
      } catch {
        subscribers.delete(res)
      }
    }
  }

  function authorized(req: IncomingMessage): boolean {
    if (token === '') return true
    const header = req.headers['authorization']
    return typeof header === 'string' && header === `Bearer ${token}`
  }

  function openEvents(req: IncomingMessage, res: ServerResponse): void {
    if (subscribers.size >= MAX_SUBSCRIBERS) {
      sendError(res, 503, errorBody('too_many_subscribers', 'SSE 订阅数已达上限'))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    // 先补一个 retry，断线后客户端按 1s 重连；本身不是业务事件，不占 seq。
    res.write('retry: 1000\n\n')
    subscribers.add(res)
    deps.log?.(`[local-api] SSE 订阅 +1（当前 ${subscribers.size}）`)
    const drop = (): void => {
      if (subscribers.delete(res)) {
        deps.log?.(`[local-api] SSE 订阅 -1（当前 ${subscribers.size}）`)
      }
    }
    req.on('close', drop)
    res.on('close', drop)
  }

  async function handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const e = err as { code?: string; status?: number; message?: string }
      if (e.code === 'body_too_large') {
        sendError(res, 413, errorBody('body_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`))
        return
      }
      sendError(res, 400, errorBody('invalid_json', '请求体不是合法 JSON'))
      return
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(res, 400, errorBody('invalid_body', '请求体必须是 JSON 对象'))
      return
    }
    const raw = body as Record<string, unknown>
    const groupId = typeof raw.groupId === 'string' ? raw.groupId.trim() : ''
    if (groupId === '') {
      sendError(res, 400, errorBody('invalid_group', 'groupId 必须是非空字符串'))
      return
    }
    const text = typeof raw.text === 'string' ? raw.text : ''
    if (text.trim() === '') {
      sendError(res, 400, errorBody('invalid_text', 'text 必须是非空字符串'))
      return
    }
    if (text.length > MAX_TEXT_CHARS) {
      sendError(res, 400, errorBody('invalid_text', `text 超过 ${MAX_TEXT_CHARS} 字符`))
      return
    }
    if (raw.mentions !== undefined && !isStringArray(raw.mentions)) {
      sendError(res, 400, errorBody('invalid_mentions', 'mentions 必须是字符串数组'))
      return
    }
    if (raw.replyTo !== undefined && typeof raw.replyTo !== 'string') {
      sendError(res, 400, errorBody('invalid_reply_to', 'replyTo 必须是字符串'))
      return
    }
    const sent = deps.sendMessage({
      groupId,
      text,
      ...(isStringArray(raw.mentions) ? { mentions: raw.mentions } : {}),
      ...(typeof raw.replyTo === 'string' && raw.replyTo !== '' ? { replyTo: raw.replyTo } : {})
    })
    if (sent === null || sent === undefined) {
      // sendText 返回 null 的成因很多（不在群里 / 超字节上限 / 群不存在）；显式报错，不假装成功。
      sendError(res, 409, errorBody('send_rejected', '消息未被接受（群不存在、本机不在群内或超长）'))
      return
    }
    sendJson(res, 200, { ok: true, message: sent })
  }

  /** 机库**只读**端点（#52）：未装配时显式 503。写面（clear）在 handle 里单独处理。 */
  function handleHangarRead(path: string, url: URL, method: string, res: ServerResponse): boolean {
    if (!path.startsWith('/v1/hangar')) return false
    const hangar = deps.hangar
    if (!hangar) {
      sendError(res, 503, errorBody('hangar_unavailable', '机库未装配'))
      return true
    }
    if (method !== 'GET') {
      sendError(res, 405, errorBody('method_not_allowed', '只支持 GET'))
      return true
    }
    if (path === '/v1/hangar' || path === '/v1/hangar/') {
      // 静态页面：自包含 HTML，headless 与 GUI 都能开（Spec #41）。
      const html = hangar.page()
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(html),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      })
      res.end(html)
      return true
    }
    if (path === '/v1/hangar/overview') {
      sendJson(res, 200, hangar.overview())
      return true
    }
    if (path === '/v1/hangar/timeline') {
      const memberId = (url.searchParams.get('memberId') ?? '').trim()
      if (memberId === '') {
        sendError(res, 400, errorBody('invalid_member', 'memberId 必须是非空字符串'))
        return true
      }
      const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
      const kindsRaw = (url.searchParams.get('kinds') ?? '').trim()
      const q = url.searchParams.get('q') ?? ''
      const limitRaw = Number(url.searchParams.get('limit') ?? '')
      const entries = hangar.timeline({
        memberId,
        ...(sessionId ? { sessionId } : {}),
        ...(kindsRaw ? { kinds: kindsRaw.split(',').map((k) => k.trim()).filter(Boolean) } : {}),
        ...(q ? { q } : {}),
        ...(Number.isInteger(limitRaw) && limitRaw > 0 ? { limit: Math.min(limitRaw, 5000) } : {})
      })
      if (entries === null) {
        sendError(res, 404, errorBody('unknown_member', `本机没有该成员的账本：${memberId}`))
        return true
      }
      sendJson(res, 200, { memberId, ...(sessionId ? { sessionId } : {}), entries })
      return true
    }
    if (path === '/v1/hangar/markdown') {
      const memberId = (url.searchParams.get('memberId') ?? '').trim()
      const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
      if (memberId === '' || sessionId === '') {
        sendError(res, 400, errorBody('invalid_query', 'memberId 与 sessionId 都必须是非空字符串'))
        return true
      }
      const text = hangar.markdown(memberId, sessionId)
      if (text === null) {
        sendError(res, 404, errorBody('no_markdown', '该会话还没有 Markdown 时间线（turn 未结算）'))
        return true
      }
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store'
      })
      res.end(text)
      return true
    }
    sendError(res, 404, errorBody('not_found', `未知路径 ${path}`))
    return true
  }

  /** #51：受约束的派遣端点——Agent 可主动调用的「摇人」入口（Spec #41 story 32）。 */
  async function handleDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.dispatch) {
      sendError(res, 501, errorBody('dispatch_unavailable', '本节点未启用派遣服务'))
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req)
    } catch (err) {
      const e = err as { code?: string; status?: number }
      if (e.code === 'body_too_large') {
        sendError(res, 413, errorBody('body_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`))
        return
      }
      sendError(res, 400, errorBody('invalid_json', '请求体不是合法 JSON'))
      return
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(res, 400, errorBody('invalid_body', '请求体必须是 JSON 对象'))
      return
    }
    const raw = body as Record<string, unknown>
    const groupId = typeof raw.groupId === 'string' ? raw.groupId.trim() : ''
    const goalOneLine = typeof raw.goal === 'string' ? raw.goal.trim() : ''
    // 省略 dispatcherId = 本节点自己派遣（Agent 调用自己的 local-api 的常规形态）。
    const dispatcherId = typeof raw.dispatcherId === 'string' ? raw.dispatcherId.trim() : 'self'
    const count = typeof raw.count === 'number' && Number.isInteger(raw.count) ? raw.count : 1
    // 省略 dispatcherDepth = 用本节点自身的代数（#56 递归派遣：派遣成员在自己的深度上继续派）。
    const dispatcherDepth =
      typeof raw.dispatcherDepth === 'number' && Number.isInteger(raw.dispatcherDepth)
        ? raw.dispatcherDepth
        : undefined
    if (groupId === '') {
      sendError(res, 400, errorBody('invalid_group', 'groupId 必须是非空字符串'))
      return
    }
    if (goalOneLine === '') {
      sendError(res, 400, errorBody('invalid_goal', 'goal（会话目标一句话）必填——新成员唯一的上下文来源'))
      return
    }
    if (goalOneLine.length > 2000) {
      sendError(res, 400, errorBody('invalid_goal', 'goal 超过 2000 字符'))
      return
    }
    if (count < 1 || count > 8) {
      sendError(res, 400, errorBody('invalid_count', 'count 必须是 1–8 的整数'))
      return
    }
    if (dispatcherDepth !== undefined && dispatcherDepth < 1) {
      sendError(res, 400, errorBody('invalid_depth', 'dispatcherDepth 必须 ≥1（常驻=1）'))
      return
    }
    // #54/#60：可选输入交接（Markdown 全文）。提供则交给 DispatchService fail-closed 校验。
    const handover = typeof raw.handover === 'string' ? raw.handover : undefined
    const outcome = await deps.dispatch({
      groupId,
      dispatcherId,
      goalOneLine,
      ...(dispatcherDepth !== undefined ? { dispatcherDepth } : {}),
      count,
      ...(handover !== undefined ? { handoverMarkdown: handover } : {})
    })
    if (outcome === null || outcome === undefined) {
      sendError(res, 409, errorBody('dispatch_rejected', '派遣未被接受'))
      return
    }
    // 超限（深度 / 并发 / slot 用尽 / 不在群里）是显式失败，不是静默降级：
    // 走 4xx + 可读 reason，调用方能直接从状态码分辨「拒绝」与「已接受但失败」。
    const view = outcome as { outcome?: string; reason?: string }
    if (view.outcome === 'rejected') {
      sendError(res, 409, errorBody('dispatch_rejected', view.reason ?? '派遣未被接受'))
      return
    }
    sendJson(res, 200, { ok: true, outcome })
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const method = req.method ?? 'GET'
    const rawUrl = req.url ?? '/'
    const path = rawUrl.split('?')[0]
    if (!authorized(req)) {
      sendError(res, 401, errorBody('unauthorized', '缺少或错误的 Bearer token'))
      return
    }
    if (path === '/v1/health') {
      if (method !== 'GET') {
        sendError(res, 405, errorBody('method_not_allowed', '只支持 GET'))
        return
      }
      void Promise.resolve(deps.health())
        .then((view) => sendJson(res, 200, view))
        .catch((err: unknown) => {
          deps.log?.(`[local-api] health 失败：${String(err)}`)
          sendError(res, 500, errorBody('health_failed', '本机健康数据不可用'))
        })
      return
    }
    if (path === '/v1/events') {
      if (method !== 'GET') {
        sendError(res, 405, errorBody('method_not_allowed', '只支持 GET'))
        return
      }
      openEvents(req, res)
      return
    }
    if (path === '/v1/lifecycle/quit') {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '只支持 POST'))
        return
      }
      deps.log?.('[local-api] 收到优雅退出请求')
      // 先回执再退出：调用方要能确认“请求已被接受”，而不是撞上连接断开。
      sendJson(res, 202, { ok: true })
      deps.requestQuit()
      return
    }
    if (path === '/v1/messages') {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '只支持 POST'))
        return
      }
      void handleMessage(req, res)
      return
    }
    if (path === '/v1/dispatch') {
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '只支持 POST'))
        return
      }
      void handleDispatch(req, res)
      return
    }
    if (path === '/v1/reclaim') {
      if (!deps.reclaim) {
        sendError(res, 501, errorBody('reclaim_unavailable', '本节点未启用派遣服务'))
        return
      }
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '只支持 POST'))
        return
      }
      // #54 回收端点：memberId + 交接文档（Markdown 全文）。判权在 DispatchService。
      void readJsonBody(req)
        .then((body) => {
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            sendError(res, 400, errorBody('invalid_body', '请求体必须是 JSON 对象'))
            return
          }
          const raw = body as Record<string, unknown>
          const memberId = typeof raw['memberId'] === 'string' ? raw['memberId'].trim() : ''
          const handover = typeof raw['handover'] === 'string' ? raw['handover'] : ''
          if (memberId === '') {
            sendError(res, 400, errorBody('invalid_member', 'memberId 必须是非空字符串'))
            return
          }
          if (handover.trim() === '') {
            sendError(res, 400, errorBody('invalid_handover', 'handover（输出交接文档全文）必填——回收必须过校验'))
            return
          }
          void Promise.resolve(
            deps.reclaim!({ memberId, actorId: 'self', handoverMarkdown: handover })
          )
            .then((outcome) => {
              if (outcome === null || outcome === undefined) {
                sendError(res, 409, errorBody('reclaim_rejected', '回收未被接受'))
                return
              }
              sendJson(res, 200, { ok: true, outcome })
            })
            .catch((err: unknown) => {
              deps.log?.(`[local-api] reclaim 失败：${String(err)}`)
              sendError(res, 500, errorBody('reclaim_failed', '回收编排失败'))
            })
        })
        .catch((err: unknown) => {
          const code = (err as { code?: string }).code
          if (code === 'body_too_large') {
            sendError(res, 413, errorBody('body_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`))
            return
          }
          sendError(res, 400, errorBody('invalid_json', '请求体不是合法 JSON'))
        })
      return
    }
    if (path === '/v1/hangar/clear') {
      if (!deps.hangar) {
        sendError(res, 503, errorBody('hangar_unavailable', '机库未装配'))
        return
      }
      if (method !== 'POST') {
        sendError(res, 405, errorBody('method_not_allowed', '只支持 POST'))
        return
      }
      // clear 是机库唯一的写面（其余全只读）；req 在这里可见，故不走只读辅助函数。
      void readJsonBody(req)
        .then((body) => {
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            sendError(res, 400, errorBody('invalid_body', '请求体必须是 JSON 对象'))
            return
          }
          const raw = body as Record<string, unknown>
          const memberId = typeof raw['memberId'] === 'string' ? raw['memberId'].trim() : ''
          const actorId = typeof raw['actorId'] === 'string' ? raw['actorId'].trim() : ''
          if (memberId === '') {
            sendError(res, 400, errorBody('invalid_member', 'memberId 必须是非空字符串'))
            return
          }
          const result = deps.hangar!.clear({ memberId, actorId })
          // 判权拒绝 = 403：调用方不该把拒绝当成功（与 200 + ok:false 区分开）。
          sendJson(res, result.ok ? 200 : 403, result)
        })
        .catch((err: unknown) => {
          const code = (err as { code?: string }).code
          if (code === 'body_too_large') {
            sendError(res, 413, errorBody('body_too_large', `请求体超过 ${MAX_BODY_BYTES} 字节`))
            return
          }
          sendError(res, 400, errorBody('invalid_json', '请求体不是合法 JSON'))
        })
      return
    }
    if (handleHangarRead(path, new URL(rawUrl, 'http://127.0.0.1'), method, res)) return
    sendError(res, 404, errorBody('not_found', `未知路径 ${path}`))
  }

  function closeSubscribers(): void {
    for (const res of subscribers) {
      try {
        res.end()
      } catch {
        // 对端已断开，忽略。
      }
    }
    subscribers.clear()
  }

  return {
    emit,
    handle,
    subscriberCount: () => subscribers.size,
    closeSubscribers
  }
}

export interface LocalApiServerOptions {
  port: number
  /** 0 = 临时端口（自检行打印实际值）。 */
  host?: string
}

export interface LocalApiServer {
  port: number
  stop(): Promise<void>
}

/** 起一个只绑回环的 HTTP 前台；返回实际端口（port=0 时由系统分配）。 */
export async function listenLocalApi(
  api: LocalApi,
  options: LocalApiServerOptions
): Promise<LocalApiServer> {
  const host = options.host ?? '127.0.0.1'
  const server: Server = createServer((req, res) => api.handle(req, res))
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  // Electron 22 内嵌 Node 16，没有 server.closeAllConnections；自己记 socket 才能真停干净。
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(options.port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    stop: async () => {
      api.closeSubscribers()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // SSE/keep-alive 连接会拖住 close；主动断开剩余 socket。
        for (const socket of sockets) socket.destroy()
        sockets.clear()
      })
    }
  }
}
