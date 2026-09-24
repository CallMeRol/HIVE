// `src/main/acp/` 的对外入口（ADR-0004）：把 env 契约 + runner 托管收成一个工厂，
// 让 `index.ts` 的装配点保持一行。
//
// 环境变量契约见 docs/local-api.md / issue #14 §6：
//   PANTRY_AGENT_COMMAND      空 = bridge 关闭（节点仍是普通群成员）
//   PANTRY_AGENT_ARGS         逗号分隔
//   PANTRY_AGENT_CWD          ACP session 的 cwd（权限沙箱边界）；空 = userData
//   PANTRY_AGENT_NODE         系统 node 可执行文件；必须 ≥22，低了明确报错
//   PANTRY_AGENT_CONFIG       `k=v,k=v`，session/new 后逐项 set_config_option
//   PANTRY_AGENT_TURN_TIMEOUT_MS  单 turn 上限

import { AcpRunner } from './session'

export { AcpRunner, checkNodeVersion } from './session'
export type { AcpRunnerOptions, TurnResult, RunnerUpdate } from './session'
export * from './protocol'

export interface AgentEnv {
  command: string
  args: string[]
  cwd: string
  node: string
  config: Record<string, string>
  turnTimeoutMs: number | undefined
  /**
   * ACP 工具 permission 策略（`PANTRY_AGENT_PERMISSION`）：`allow` | 缺省拒绝。
   * **与 Hive 确认键（pending，#50）是两条正交面**，见 runner.mjs 的 permission handler。
   */
  permission: string
}

function parseConfig(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (raw ?? '').split(',')) {
    const eq = pair.indexOf('=')
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}

/** 从环境变量读出 agent 配置；`command` 为空表示未启用 agent。 */
export function readAgentEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const timeout = Number(env['PANTRY_AGENT_TURN_TIMEOUT_MS'] ?? '')
  return {
    command: (env['PANTRY_AGENT_COMMAND'] ?? '').trim(),
    args: (env['PANTRY_AGENT_ARGS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    cwd: (env['PANTRY_AGENT_CWD'] ?? '').trim(),
    node: (env['PANTRY_AGENT_NODE'] ?? '').trim() || 'node',
    config: parseConfig(env['PANTRY_AGENT_CONFIG']),
    turnTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    // 只有显式 `allow` 才放行；其余（含未设）一律 fail-closed。
    permission: (env['PANTRY_AGENT_PERMISSION'] ?? '').trim() === 'allow' ? 'allow' : ''
  }
}

/**
 * 按 env 建并启动 runner。**未配置 command 时返回 null**（显式降级：节点仍是普通群成员，
 * 能收能被 @，只是不回复——ADR-0002 Decision "降级"）。
 * 启动失败时抛出，由调用方决定是否降级并留痕（不静默吞掉）。
 */
export async function startAcpRunner(options: {
  entryDir: string
  agent: AgentEnv
  defaultCwd: string
  log?: (line: string) => void
}): Promise<AcpRunner | null> {
  const { agent } = options
  if (!agent.command) return null
  const runner = new AcpRunner({
    command: agent.command,
    args: agent.args,
    cwd: agent.cwd || options.defaultCwd,
    node: agent.node,
    config: agent.config,
    permission: agent.permission,
    entryDir: options.entryDir,
    ...(agent.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: agent.turnTimeoutMs }),
    ...(options.log ? { log: options.log } : {})
  })
  await runner.start()
  return runner
}
