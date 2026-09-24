// ACP runner 的**主进程侧托管**（ADR-0004）：spawn 系统 node ≥22 跑 runner.mjs，
// 用 NDJSON 控制协议（./protocol.ts）收发，不 import electron。
//
// 纪律：这里只做进程托管 + 协议转发，不含任何"回复怎么进群"的业务判定（那是 agent-bridge）。
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { EventEmitter } from 'node:events'
import {
  encodeRunnerLine,
  parseRunnerLine,
  type RunnerCommand,
  type RunnerEvent,
  type RunnerPromptCommand
} from './protocol'

/** runner 入口：与 session.ts 同目录，构建后仍是裸 .mjs（不是 ts 编译产物）。 */
const RUNNER_ENTRY = 'runner.mjs'

export interface AcpRunnerOptions {
  /** ACP adapter 可执行文件（绝对路径，或 PATH 上的命令名）。 */
  command: string
  /** adapter 参数（`PANTRY_AGENT_ARGS`，逗号分隔后传入）。 */
  args?: string[]
  /** ACP session 的 cwd（权限沙箱边界）。 */
  cwd?: string
  /** 系统 node 可执行文件（`PANTRY_AGENT_NODE`）；缺省用 PATH 上的 `node`。 */
  node?: string
  /** session/new 后要设置的配置项（`k=v,k=v`）。 */
  config?: Record<string, string>
  /**
   * ACP 工具 permission 策略（`PANTRY_AGENT_PERMISSION`）：`allow` | 缺省拒绝。
   * **与 Hive 确认键（pending，#50）是两条正交面**：这里应答 agent 发起的逐工具请求，
   * 确认键审批人发起的「空闲→开工」。两者不共用代码路径、不互相代表。
   */
  permission?: string
  /** runner 自身入口所在目录（打包后由 index.ts 注入，避免猜路径）。 */
  entryDir: string
  /** 单 turn 上限（ms）。 */
  turnTimeoutMs?: number
  /** 日志面（默认 console.error，绝不写 stdout 协议面）。 */
  log?: (line: string) => void
}

/** 探测结果（#49 AC1）：adapter 自报的模型与 permission 档位，GUI 选择项由此而来。 */
export interface AcpProbeResult {
  sessionId: string
  agentInfo?: { name: string; version: string }
  capabilities?: unknown
  /** `session/new` 的 configOptions 原样透传（含 category=model / category=mode 两组 select）。 */
  configOptions: unknown[]
}

export interface TurnResult {
  stopReason: string
  /** turn 内 `agent_message_chunk` 累积的正式回复全文。 */
  text: string
}

export interface RunnerUpdate {
  turnId: string
  sessionId: string
  sessionUpdate: string
  textDelta?: string
  raw?: unknown
}

/** 事件面（agent-bridge 消费）：update = 过程；turnDone / turnError 结算一次 turn。 */
export interface AcpRunnerEvents {
  ready: [info: { protocolVersion: number; agentInfo?: { name: string; version: string } }]
  update: [update: RunnerUpdate]
  fatal: [error: { code: string; message: string }]
}

const DEFAULT_TURN_TIMEOUT_MS = 7_200_000

/** node ≥22 是硬要求（SDK 与 adapter 的 engines）：低了必须显式报错，不静默降级。 */
const MIN_NODE_MAJOR = 22

export function checkNodeVersion(nodeExe: string): { ok: true } | { ok: false; reason: string } {
  try {
    const raw = execFileSync(nodeExe, ['-v'], { encoding: 'utf8' }).trim()
    const major = Number(raw.replace(/^v/, '').split('.')[0])
    if (!Number.isFinite(major)) return { ok: false, reason: `无法解析 node 版本：${raw}` }
    if (major < MIN_NODE_MAJOR) {
      return { ok: false, reason: `需要 node ≥${MIN_NODE_MAJOR}，实际 ${raw}（${nodeExe}）` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `无法执行 ${nodeExe}：${String((err as Error)?.message ?? err)}` }
  }
}

interface PendingTurn {
  turnId: string
  resolve: (result: TurnResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 一个 runner 子进程 = 一个 ACP 子进程 = 一个群成员背后的 agent。
 * 同一时刻 ≤1 个 turn（与 runner 侧一致）；重复 prompt 由调用方排队/拒绝。
 */
export class AcpRunner extends EventEmitter {
  private child: ChildProcess | null = null
  private pending: PendingTurn | null = null
  private stdoutBuf = ''
  private seq = 0
  private disposed = false
  private exitWaiters: Array<() => void> = []
  private readonly log: (line: string) => void

  constructor(private readonly options: AcpRunnerOptions) {
    super()
    this.log = options.log ?? ((line: string) => console.error(line))
  }

  /** runner 是否活着（用于"降级为普通群成员"的判定）。 */
  isAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.disposed
  }

  /** spawn runner 并等 `ready` 事件（initialize 成功）。失败即抛，由调用方决定降级。 */
  async start(): Promise<void> {
    if (this.child) throw new Error('runner 已启动')
    const nodeExe = this.options.node || 'node'
    const runnerPath = join(this.options.entryDir, RUNNER_ENTRY)
    if (!existsSync(runnerPath)) {
      throw new Error(`找不到 runner 入口：${runnerPath}`)
    }

    const version = checkNodeVersion(nodeExe)
    if (!version.ok) {
      // ADR-0002 env 契约：低于 22 明确报错退出，不静默。
      throw new Error(`ACP runner 的 node 不可用：${version.reason}`)
    }

    const args = [
      runnerPath,
      '--command',
      this.options.command,
      ...(this.options.args && this.options.args.length > 0
        ? ['--args', this.options.args.join(',')]
        : []),
      ...(this.options.cwd ? ['--cwd', this.options.cwd] : []),
      ...(this.options.permission ? ['--permission', this.options.permission] : []),
      ...(this.options.config && Object.keys(this.options.config).length > 0
        ? ['--config', Object.entries(this.options.config).map(([k, v]) => `${k}=${v}`).join(',')]
        : [])
    ]

    this.child = spawn(nodeExe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // runner 自己会解析自己的 node_modules（@agentclientprotocol/sdk）；
      // 不设 cwd：cwd 只对 ACP session 有意义，经 --cwd 传下去。
      env: { ...process.env, PATH: process.env['PATH'] ?? '', ...pathWithNodeDelimiter(nodeExe) }
    })

    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) this.log(line)
    })
    this.child.on('error', (err) => {
      this.log(`[acp] runner spawn 失败：${String(err.message)}`)
      this.failPending(new Error(`runner spawn 失败：${err.message}`))
    })
    this.child.on('exit', (code, signal) => {
      const wasDisposed = this.disposed
      this.child = null
      for (const waiter of this.exitWaiters.splice(0)) waiter()
      if (!wasDisposed) {
        this.failPending(new Error(`runner 已退出（code=${code} signal=${signal}）`))
        this.probeRejecter?.(new Error(`runner 已退出（code=${code} signal=${signal}）`))
        this.emit('fatal', { code: 'runner_exited', message: `runner 退出 code=${code} signal=${signal}` })
      }
    })

    await this.waitForReady()
  }

  /** ready 事件由 onStdout 触发；这里只等它（含超时）。 */
  private readyResolver: (() => void) | null = null
  private readyRejecter: ((err: Error) => void) | null = null

  private waitForReady(timeoutMs = 30_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyResolver = null
        this.readyRejecter = null
        reject(new Error(`ACP runner initialize 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.readyResolver = () => {
        clearTimeout(timer)
        this.readyResolver = null
        this.readyRejecter = null
        resolve()
      }
      this.readyRejecter = (err) => {
        clearTimeout(timer)
        this.readyResolver = null
        this.readyRejecter = null
        reject(err)
      }
    })
  }

  /**
   * 只握手不发 prompt（#49 AC1/AC2 的探测面）：起得来 → 拿到模型与 permission 枚举。
   * 与 `start()` 的区别：`start()` 只证明 initialize 成功，`probe()` 会真的建 session。
   * 探测失败即抛，由调用方转成给用户看的可操作错误。
   */
  probe(timeoutMs = 60_000): Promise<AcpProbeResult> {
    if (!this.child) return Promise.reject(new Error('runner 未启动'))
    return new Promise<AcpProbeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.probeResolver = null
        this.probeRejecter = null
        reject(new Error(`ACP 探测超时（${timeoutMs}ms）：adapter 握手未完成`))
      }, timeoutMs)
      this.probeResolver = (result) => {
        clearTimeout(timer)
        this.probeResolver = null
        this.probeRejecter = null
        resolve(result)
      }
      this.probeRejecter = (err) => {
        clearTimeout(timer)
        this.probeResolver = null
        this.probeRejecter = null
        reject(err)
      }
      this.send({ v: 1, type: 'probe' })
    })
  }

  private probeResolver: ((result: AcpProbeResult) => void) | null = null
  private probeRejecter: ((err: Error) => void) | null = null

  /** 发一次 turn；同一时刻只允许一个（并发调用直接拒绝，由 bridge 保证串行）。 */
  prompt(text: string, turnId?: string, cwd?: string): Promise<TurnResult> {
    if (!this.child) return Promise.reject(new Error('runner 未启动'))
    if (this.pending) return Promise.reject(new Error('上一个 turn 尚未结束'))
    const id = turnId ?? `turn-${++this.seq}-${Date.now()}`
    const command: RunnerPromptCommand = { v: 1, type: 'prompt', turnId: id, text, ...(cwd ? { cwd } : {}) }
    return new Promise<TurnResult>((resolve, reject) => {
      const timeoutMs = this.options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
      const timer = setTimeout(() => {
        this.pending = null
        reject(new Error(`turn 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending = { turnId: id, resolve, reject, timer }
      this.send(command)
    })
  }

  /** 优雅停机：先 shutdown 命令，再 SIGTERM → 1s → SIGKILL（并入 index.ts 既有 2s 预算）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    if (!child) return
    this.send({ v: 1, type: 'shutdown' })
    try {
      child.stdin?.end()
    } catch {
      /* 已关 */
    }
    const exited = this.waitExit(900)
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 已退 */
      }
    }, 900)
    await exited
    clearTimeout(killTimer)
    if (child.exitCode === null && this.child === null) return // 已退
    const hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退 */
      }
    }, 300)
    await this.waitExit(600)
    clearTimeout(hardTimer)
  }

  private waitExit(timeoutMs: number): Promise<void> {
    if (!this.child) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.exitWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private send(command: RunnerCommand): void {
    try {
      this.child?.stdin?.write(encodeRunnerLine(command))
    } catch (err) {
      this.log(`[acp] 写 runner stdin 失败：${String((err as Error)?.message ?? err)}`)
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      const event = parseRunnerLine<RunnerEvent>(line)
      if (!event) continue
      this.onEvent(event)
    }
  }

  private onEvent(event: RunnerEvent): void {
    switch (event.type) {
      case 'ready':
        this.readyResolver?.()
        this.emit('ready', { protocolVersion: event.protocolVersion, ...(event.agentInfo ? { agentInfo: event.agentInfo } : {}) })
        return
      case 'probe_result':
        this.probeResolver?.({
          sessionId: event.sessionId,
          ...(event.agentInfo ? { agentInfo: event.agentInfo } : {}),
          ...(event.capabilities === undefined ? {} : { capabilities: event.capabilities }),
          configOptions: Array.isArray(event.configOptions) ? event.configOptions : []
        })
        return
      case 'update':
        this.emit('update', {
          turnId: event.turnId,
          sessionId: event.sessionId,
          sessionUpdate: event.sessionUpdate,
          ...(event.textDelta === undefined ? {} : { textDelta: event.textDelta }),
          ...(event.raw === undefined ? {} : { raw: event.raw })
        } satisfies RunnerUpdate)
        return
      case 'turn_done': {
        const pending = this.takePending(event.turnId)
        pending?.resolve({ stopReason: event.stopReason, text: event.text })
        return
      }
      case 'turn_error': {
        const pending = this.takePending(event.turnId)
        pending?.reject(new Error(`${event.code}: ${event.message}`))
        return
      }
      case 'fatal': {
        this.readyRejecter?.(new Error(`${event.code}: ${event.message}`))
        this.probeRejecter?.(new Error(`${event.code}: ${event.message}`))
        this.failPending(new Error(`${event.code}: ${event.message}`))
        this.emit('fatal', { code: event.code, message: event.message })
        return
      }
      default:
        return
    }
  }

  private takePending(turnId: string): PendingTurn | null {
    const pending = this.pending
    if (!pending || (turnId !== '' && pending.turnId !== turnId)) return null
    clearTimeout(pending.timer)
    this.pending = null
    return pending
  }

  private failPending(err: Error): void {
    const pending = this.pending
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending = null
    pending.reject(err)
  }
}

/** 保证 node 所在目录在 PATH 前（adapter 可能需要再 spawn node）。 */
function pathWithNodeDelimiter(nodeExe: string): Record<string, string> {
  if (nodeExe === 'node' || !nodeExe.includes('/')) return {}
  const dir = nodeExe.slice(0, nodeExe.lastIndexOf('/'))
  if (!dir) return {}
  return { PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}` }
}
