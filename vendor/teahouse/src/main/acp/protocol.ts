// runner 与 Electron 主进程之间的**私有**控制协议（Hive 新增命名空间，ADR-0004）。
//
// 为什么不是 ACP：ACP 是 client↔agent 的协议，跑在 runner **内部**（runner 是 client）。
// 主进程 ↔ runner 之间需要的是「发一条 prompt / 收过程更新 / 收正式回复」这种更粗的语义，
// 且必须跨 Node 16（Electron 主进程）↔ Node 22（runner 子进程）的 JSON 边界，
// 因此用一份极小的 NDJSON 控制协议，而不是把 ACP 的 JSON-RPC 再透传一层。
//
// 方向：父 → 子用 stdin（NDJSON），子 → 父用 stdout（NDJSON）。
// 子进程的 stderr 只用于人读日志，不参与协议。

/** 控制协议版本；不匹配时主进程 fail-closed 拒绝接管。 */
export const RUNNER_PROTOCOL_VERSION = 1

/** 父 → 子：发起一次 turn（一次 @ = 一次 turn）。 */
export interface RunnerPromptCommand {
  v: 1
  type: 'prompt'
  /** 父侧生成的 turn id，回复里原样带回，用于去重与配对。 */
  turnId: string
  /** 要喂给 agent 的完整 prompt 文本（由 bridge 组装，已含派单原文）。 */
  text: string
  /** ACP session 的 cwd（权限沙箱边界）。 */
  cwd?: string
  /** 可选：ACP session/new 之后要设置的配置项（如 model=…）。 */
  configOptions?: Record<string, string>
}

/** 父 → 子：优雅停机。 */
export interface RunnerShutdownCommand {
  v: 1
  type: 'shutdown'
}

/**
 * 父 → 子：**只握手、不发 prompt**（#49 接入探测）。
 * 用于在真正接入前回答「这个 adapter 能不能起来、它支持哪些模型与 permission 档位」——
 * 探测若不落地成一次真握手，就会变成猜。
 */
export interface RunnerProbeCommand {
  v: 1
  type: 'probe'
}

export type RunnerCommand = RunnerPromptCommand | RunnerShutdownCommand | RunnerProbeCommand

/** 子 → 父：握手完成，报告实际协商到的能力。 */
export interface RunnerReadyEvent {
  v: 1
  type: 'ready'
  protocolVersion: number
  agentInfo?: { name: string; version: string }
  /** 协商到的 agent 能力（原样透传，供诊断）。 */
  capabilities?: unknown
}

/** 子 → 父：过程更新（不进群，落本机账本）。 */
export interface RunnerUpdateEvent {
  v: 1
  type: 'update'
  turnId: string
  sessionId: string
  /** ACP `sessionUpdate` 判别值（agent_message_chunk / agent_thought_chunk / tool_call / …）。 */
  sessionUpdate: string
  /** 正式消息增量（仅 agent_message_chunk 有）。 */
  textDelta?: string
  /** 其余过程的原始 update 载荷，落账本用。 */
  raw?: unknown
}

/** 子 → 父：turn 结束。 */
export interface RunnerTurnDoneEvent {
  v: 1
  type: 'turn_done'
  turnId: string
  sessionId: string
  stopReason: string
  /** 本 turn 内 `agent_message_chunk` 累积出的正式回复全文。 */
  text: string
}

/**
 * 子 → 父：探测结果（#49）。`session/new` 的 `configOptions` 原样带回：
 * adapter 自己声明它接受哪些模型（`category: "model"`）与哪些 permission 档位
 * （`category: "mode"`），GUI 的选择项由此而来，不靠硬编码清单。
 */
export interface RunnerProbeResultEvent {
  v: 1
  type: 'probe_result'
  /** 协商到的 agent 能力（原样透传）。 */
  capabilities?: unknown
  agentInfo?: { name: string; version: string }
  sessionId: string
  configOptions: unknown[]
}

/** 子 → 父：turn 失败（协议错误、agent 崩溃、超时…）。 */
export interface RunnerTurnErrorEvent {
  v: 1
  type: 'turn_error'
  turnId: string
  sessionId?: string
  code: string
  message: string
  details?: unknown
}

/** 子 → 父：致命错误（initialize / session-new 失败，或进程即将退出）。 */
export interface RunnerFatalEvent {
  v: 1
  type: 'fatal'
  code: string
  message: string
  details?: unknown
}

export type RunnerEvent =
  | RunnerReadyEvent
  | RunnerProbeResultEvent
  | RunnerUpdateEvent
  | RunnerTurnDoneEvent
  | RunnerTurnErrorEvent
  | RunnerFatalEvent

/** 一行 NDJSON 的安全解析：坏行返回 null，调用方决定是否致命。 */
export function parseRunnerLine<T>(line: string): T | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null
  } catch {
    return null
  }
}

/** 写入一行 NDJSON（stdout 协议面 / stdin 命令面共用）。 */
export function encodeRunnerLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}
