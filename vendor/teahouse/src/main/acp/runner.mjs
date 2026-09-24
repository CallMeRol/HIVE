#!/usr/bin/env node
// ACP runner —— 跑在**系统 node ≥22** 上的子进程，持有官方 `@agentclientprotocol/sdk`
// 与 ACP adapter（ADR-0004 / #25）。
//
// 为什么是子进程：Electron 22 主进程内嵌 Node 16.17、仅 CJS，而 SDK 是 ESM-only 且
// adapter `engines.node >= 22` —— 子进程是唯一通路。主进程只做进程托管与 NDJSON 转发。
//
// 用法（由 Electron 主进程 spawn，不面向人手敲）：
//   node runner.mjs --command <adapter 可执行> --args a,b --cwd <dir> [--config k=v,...]
//
// 契约：见 ./protocol.ts。stdin = 命令，stdout = 事件，stderr = 人读日志。
// **stdout 只允许出现协议 NDJSON**，任何调试输出都必须走 stderr。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import process from 'node:process'

const RUNNER_PROTOCOL_VERSION = 1

// ---------- stdout 协议面 ----------
function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function log(line) {
  process.stderr.write(`[runner] ${line}\n`)
}

function fatal(code, message, details) {
  emit({ v: 1, type: 'fatal', code, message, ...(details === undefined ? {} : { details }) })
}

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = { command: '', args: [], cwd: '', config: {}, permission: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--command') {
      out.command = value ?? ''
      i += 1
    } else if (flag === '--args') {
      out.args = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      i += 1
    } else if (flag === '--cwd') {
      out.cwd = value ?? ''
      i += 1
    } else if (flag === '--permission') {
      out.permission = value ?? ''
      i += 1
    } else if (flag === '--config') {
      for (const pair of (value ?? '').split(',')) {
        const eq = pair.indexOf('=')
        if (eq > 0) out.config[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
      }
      i += 1
    }
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))

if (!opts.command) {
  fatal('missing_command', 'runner 需要 --command 指定 ACP adapter 可执行文件')
  process.exit(2)
}
if (!existsSync(opts.command)) {
  fatal('command_not_found', `ACP adapter 不存在：${opts.command}`)
  process.exit(2)
}
const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : process.cwd()

// ---------- 动态加载 SDK（ESM，node ≥22）----------
// SDK 与 adapter 同源（都依赖 @agentclientprotocol/sdk），但**各自解析自己的副本**：
// runner 用自己进程内的这份即可，adapter 走它自己 node_modules。
let acp
try {
  acp = await import('@agentclientprotocol/sdk')
} catch (err) {
  fatal('sdk_load_failed', `无法加载 @agentclientprotocol/sdk：${String(err?.message ?? err)}`)
  process.exit(2)
}

// ---------- 拉起 adapter 子进程 ----------
const child = spawn(opts.command, opts.args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
  // Windows 上 .cmd/.bat shim 需要 shell；直接给 node + .js 时不需要。
  shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(opts.command)
})

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) {
    if (line.trim()) log(`adapter: ${line}`)
  }
})

let childExited = false
child.on('exit', (code, signal) => {
  childExited = true
  log(`adapter 退出 code=${code} signal=${signal}`)
  // adapter 死了但 turn 还挂着 → 显式报错，不让父进程空等。
  failActiveTurn('adapter_exited', `ACP adapter 已退出（code=${code} signal=${signal}）`)
})

// ---------- ACP 客户端装配 ----------
const { ndJsonStream } = acp

// 用官方的 node:stream 互操作（SDK 示例同款），不要手搓 web 流适配。
const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout)
)

// 每个 turn 一个 session（"一个会话只干一个任务"是 map 的第一性原理的落点）。
let sessionId = null
let sessionPromise = null

/** 当前活跃 turn：收集正式回复增量 + 落过程更新。 */
let activeTurn = null

function failActiveTurn(code, message, details) {
  if (!activeTurn) return
  const turn = activeTurn
  activeTurn = null
  emit({
    v: 1,
    type: 'turn_error',
    turnId: turn.turnId,
    ...(sessionId ? { sessionId } : {}),
    code,
    message,
    ...(details === undefined ? {} : { details })
  })
}

// ---------- client 侧处理器 ----------
// 只 advertise 空 clientCapabilities（#21 实测：两个必做 adapter 在不 advertise fs/terminal
// 时一次都不会调用它们）。因此这里只实现 permission 应答 + session/update 消费。
const clientApp = acp.client({ name: 'hive-runner', version: '0.1.0' })

/**
 * ACP 工具 permission 应答（#49 AC4 的第一面）。
 *
 * 这是**机器对机器**的一面：agent 逐次工具调用发问，runner 当场应答。它与 Hive 的
 * 确认键（人发起的「空闲→开工」审批，属 pending，#50）是两条正交路径 —— 确认键在这里
 * 永远不会出现，permission 也永远不进群消息。
 *
 * 策略来自 `--permission`（接入对话框选的档位），**缺省一律拒绝**：
 * adapter 自带工具在本机自行读写（#21 实测），需要客户端代跑的操作不在沙箱承诺内，
 * fail-closed，不静默放行。
 */
const PERMISSION = (() => {
  const raw = (opts.config['permission'] ?? opts.permission ?? '').trim().toLowerCase()
  return raw === 'allow' ? 'allow' : 'reject'
})()

clientApp.onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
  const options = ctx.params?.options ?? []
  // 策略为 allow 时优先选「一次」而不是「总是」，把放行面收到最小。
  const wanted = PERMISSION === 'allow'
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always']
  const pick = wanted.map((kind) => options.find((o) => o.kind === kind)).find(Boolean)
  if (!pick) {
    // 没有可选项时不能假装选了：显式取消，让 agent 走它自己的取消路径。
    log(`permission 请求无可选档位（策略 ${PERMISSION}），应答 cancelled`)
    return { outcome: { outcome: 'cancelled' } }
  }
  // permission 应答留痕（stderr = 人读日志面，不进群、不进 stdout 协议面）。
  log(`permission 应答 ${pick.kind}（策略 ${PERMISSION}）tool=${String(ctx.params?.toolCall?.title ?? '')}`)
  return { outcome: { outcome: 'selected', optionId: pick.optionId } }
})

clientApp.onNotification(acp.methods.client.session.update, async (ctx) => {
  const notification = ctx.params
  const update = notification?.update
  if (!update) return
  const kind = String(update.sessionUpdate ?? 'unknown')
  const sid = String(notification.sessionId ?? sessionId ?? '')
  const turnId = activeTurn?.turnId ?? ''
  if (kind === 'agent_message_chunk') {
    const text = update.content?.type === 'text' ? String(update.content.text ?? '') : ''
    if (activeTurn && text) activeTurn.chunks.push(text)
    emit({ v: 1, type: 'update', turnId, sessionId: sid, sessionUpdate: kind, textDelta: text, raw: update })
    return
  }
  // 过程（thought / tool_call / plan / usage / session_info / available_commands…）：
  // 一律不进群，只原样上报给父进程落本机账本（ADR-0008）。
  emit({ v: 1, type: 'update', turnId, sessionId: sid, sessionUpdate: kind, raw: update })
})

const connection = clientApp.connect(stream)

// ---------- 握手：initialize → session/new ----------
async function ensureSession() {
  if (sessionPromise) return sessionPromise
  sessionPromise = (async () => {
    const init = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      // 空能力集：不 advertise fs/terminal/elicitation（#21 一手实测结论）。
      clientCapabilities: {},
      clientInfo: { name: 'hive-runner', version: '0.1.0' }
    })
    lastInit = init ?? null
    emit({
      v: 1,
      type: 'ready',
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      ...(init?.agentInfo ? { agentInfo: init.agentInfo } : {}),
      ...(init?.agentCapabilities ? { capabilities: init.agentCapabilities } : {})
    })
    const created = await connection.agent.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: []
    })
    sessionId = String(created?.sessionId ?? '')
    if (!sessionId) throw new Error('session/new 未返回 sessionId')
    lastConfigOptions = Array.isArray(created?.configOptions) ? created.configOptions : []
    // 可选：把 --config 的 k=v 逐个 set_config_option（#21：换掉坏默认模型的唯一干净手段）。
    for (const [configId, value] of Object.entries(opts.config)) {
      try {
        await connection.agent.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId,
          value
        })
      } catch (err) {
        log(`set_config_option ${configId}=${value} 失败（忽略）：${String(err?.message ?? err)}`)
      }
    }
    return sessionId
  })().catch((err) => {
    sessionPromise = null
    throw err
  })
  return sessionPromise
}

/** session/new 报回的配置项（模型 / permission 档位的权威枚举，供 probe 复用）。 */
let lastConfigOptions = []
/** initialize 报回的 agent 能力与身份（probe 用）。 */
let lastInit = null

/** 只握手不发 prompt：把 adapter 自报的模型与 permission 档位原样交给父进程（#49 AC1）。 */
async function handleProbe() {
  try {
    const sid = await ensureSession()
    emit({
      v: 1,
      type: 'probe_result',
      sessionId: sid,
      ...(lastInit?.agentInfo ? { agentInfo: lastInit.agentInfo } : {}),
      ...(lastInit?.agentCapabilities ? { capabilities: lastInit.agentCapabilities } : {}),
      configOptions: lastConfigOptions
    })
  } catch (err) {
    emit({
      v: 1,
      type: 'fatal',
      code: 'probe_failed',
      message: String(err?.message ?? err)
    })
  }
}

// ---------- 命令面 ----------
async function handlePrompt(cmd) {
  if (activeTurn) {
    emit({
      v: 1,
      type: 'turn_error',
      turnId: cmd.turnId,
      code: 'turn_in_flight',
      message: '上一个 turn 尚未结束（同一时刻 ≤1 turn）'
    })
    return
  }
  // 占位必须在任何 await **之前**：`ensureSession()` 首次会 await initialize + session/new，
  // 期间若放行第二条 prompt，两个 turn 会交错（实测复现过）。
  activeTurn = { turnId: cmd.turnId, chunks: [] }
  let sid
  try {
    sid = await ensureSession()
  } catch (err) {
    activeTurn = null
    emit({
      v: 1,
      type: 'turn_error',
      turnId: cmd.turnId,
      code: 'session_failed',
      message: String(err?.message ?? err)
    })
    return
  }
  try {
    const response = await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: sid,
      prompt: [{ type: 'text', text: cmd.text }]
    })
    const turn = activeTurn
    activeTurn = null
    emit({
      v: 1,
      type: 'turn_done',
      turnId: cmd.turnId,
      sessionId: sid,
      stopReason: String(response?.stopReason ?? 'unknown'),
      text: turn ? turn.chunks.join('') : ''
    })
  } catch (err) {
    activeTurn = null
    emit({
      v: 1,
      type: 'turn_error',
      turnId: cmd.turnId,
      sessionId: sid,
      code: 'prompt_failed',
      message: String(err?.message ?? err),
      ...(err?.code === undefined ? {} : { details: { code: err.code } })
    })
  }
}

let shuttingDown = false
async function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    connection.close()
  } catch {
    /* 已关 */
  }
  try {
    child.stdin.end()
  } catch {
    /* 已关 */
  }
  // adapter 不走 SIGTERM 就直接杀（父进程侧还有一层兜底，见 session.ts）。
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退 */
    }
  }, 1000)
  if (!childExited) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退 */
    }
  }
  killTimer.unref?.()
  process.exit(code)
}

// stdin：逐行 NDJSON 命令。
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    void handleCommand(line)
  }
})
process.stdin.on('end', () => void shutdown(0))

// 启动即握手：`ready` 必须在**任何 prompt 之前**发出。
// 主进程 `AcpRunner.start()` 是 `await waitForReady()`（默认 30s），而 `ready` 只在
// `ensureSession()` 里发 —— 上一版把它挂在首个 prompt 上，于是 start() 永远等不到
// ready，30s 后抛「initialize 超时」，每个真节点都降级成「不回复的普通群成员」，
// 机库也就永远没有过程数据（#46 遗留缺口之二，已实测复现）。
// 失败必须显式：fatal 信封 + 非零退出，绝不静默半死（与既有 fatal 通路同款）。
void ensureSession().catch((err) => {
  emit({
    v: 1,
    type: 'fatal',
    code: 'initialize_failed',
    message: String(err?.message ?? err),
    ...(err?.stack === undefined ? {} : { details: String(err.stack) })
  })
  void shutdown(2)
})

async function handleCommand(line) {
  const trimmed = line.trim()
  if (!trimmed) return
  let cmd
  try {
    cmd = JSON.parse(trimmed)
  } catch {
    emit({ v: 1, type: 'fatal', code: 'bad_command_json', message: 'stdin 收到非 JSON 行' })
    return
  }
  if (cmd?.type === 'shutdown') {
    await shutdown(0)
    return
  }
  if (cmd?.type === 'prompt') {
    await handlePrompt(cmd)
    return
  }
  if (cmd?.type === 'probe') {
    await handleProbe()
    return
  }
  emit({ v: 1, type: 'fatal', code: 'unknown_command', message: `未知命令：${String(cmd?.type)}` })
}

// 兜底：未捕获异常不能让 runner 静默半死。
process.on('uncaughtException', (err) => {
  emit({ v: 1, type: 'fatal', code: 'uncaught', message: String(err?.message ?? err), details: String(err?.stack ?? '') })
  void shutdown(1)
})
process.on('unhandledRejection', (reason) => {
  emit({ v: 1, type: 'fatal', code: 'unhandled_rejection', message: String(reason) })
  void shutdown(1)
})
