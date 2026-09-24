// Agent 接入探测（#49 AC1/AC2）：在把人拉进群之前，先回答「这台机器现在能不能接、
// 接起来能选什么、不能接是卡在哪一步」。
//
// 两条纪律（Spec #41「不静默降级」）：
//   1. 每一项都返回 `{ ok, detail, hint }`——失败**必须**给出可操作建议，不许只报不对；
//   2. 模型与 permission 档位来自 adapter 自报的 `session/new.configOptions`，
//      **不硬编码清单**。adapter 升级换了模型名，这里自动跟着变。
//
// 本模块只读本机事实，不写任何文件、不发群消息。
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

/** 一个探测项的结果。`hint` 是要给用户看的下一条动作，不是复述错误。 */
export interface ProbeItem {
  /** 稳定标识（渲染层按此分组，不用中文当 key）。 */
  id: string
  label: string
  ok: boolean
  detail: string
  /** 失败时的可操作建议（成功时为空串）。 */
  hint: string
}

/** 一个可选的模型档位（来自 adapter 的 configOptions）。 */
export interface ModelOption {
  value: string
  name: string
  description: string
}

/** 一个可选的 permission 档位。 */
export interface PermissionOption {
  value: string
  name: string
  description: string
}

/** 一种 runtime 的探测全集。 */
export interface RuntimeProbe {
  runtime: RuntimeKind
  /** 该 runtime 是否可以真的接入（所有必需项 ok）。 */
  ready: boolean
  items: ProbeItem[]
  /** adapter 实际解析到的绝对路径（空 = 没找到）。 */
  adapterPath: string
  /** 探测用的 CLI 可执行文件。 */
  cliPath: string
  models: ModelOption[]
  permissions: PermissionOption[]
  /** adapter 自报身份（握手成功时才有）。 */
  agentInfo?: { name: string; version: string }
}

export type RuntimeKind = 'claude' | 'codex'

export const RUNTIMES: RuntimeKind[] = ['claude', 'codex']

/** 接入所需的最小 node 主版本（ADR-0004 / runner 的硬要求）。 */
const MIN_NODE_MAJOR = 22

/** 每种 runtime 的 adapter 包名 + CLI 可执行名（探测不到时用它们给建议）。 */
const RUNTIME_SPEC: Record<RuntimeKind, { adapterPackage: string; adapterBin: string; cliName: string; authHint: string }> = {
  claude: {
    adapterPackage: '@agentclientprotocol/claude-agent-acp',
    // PATH 上真正可执行的那个名字（包名含 `/`，不能当文件名找）。
    adapterBin: 'claude-agent-acp',
    cliName: 'claude',
    authHint: '跑 `claude` 并按提示登录（或用 `claude setup-token` 设长期 token），凭证留在本机 ~/.claude/'
  },
  codex: {
    adapterPackage: '@agentclientprotocol/codex-acp',
    adapterBin: 'codex-acp',
    cliName: 'codex',
    authHint: '跑 `codex login` 登录；凭证留在本机 ~/.codex/，不上传'
  }
}

function item(id: string, label: string, ok: boolean, detail: string, hint = ''): ProbeItem {
  return { id, label, ok, detail, hint: ok ? '' : hint }
}

/**
 * 在 PATH 上找可执行文件。不用 `which`（Windows 没有）也不用 shell
 * （避免把路径里的空格与元字符交给 shell 解释）。
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const pathValue = env['PATH'] ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile() || statSync(candidate).isSymbolicLink()) return candidate
    } catch {
      /* 不在这个目录，继续 */
    }
  }
  return ''
}

/** 绝对路径直接判存；否则当命令名在 PATH 上找。空串 = 没配。 */
export function resolveAgentCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  if (isAbsolute(trimmed)) return existsSync(trimmed) ? trimmed : ''
  return findExecutable(trimmed, env)
}

function nodeVersionOf(nodeExe: string): { version: string; major: number } | null {
  try {
    const raw = execFileSync(nodeExe, ['-v'], { encoding: 'utf8', timeout: 5000 }).trim()
    const major = Number(raw.replace(/^v/, '').split('.')[0])
    return Number.isFinite(major) ? { version: raw, major } : null
  } catch {
    return null
  }
}

/**
 * 从 `session/new` 的 configOptions 里挑出模型与 permission 两组。
 *
 * 判据是 adapter 自己给的 `category`（ACP schema 的稳定字段），不是 id 字符串匹配 ——
 * 实测两组分别是 `category: "model"` 与 `category: "mode"`，但 id 可能随版本变。
 * 拿不到时各自退到「按 id 找」一次，仍拿不到就是空表（GUI 显式说明「adapter 未声明」，
 * 不拿一份硬编码假装能选）。
 */
export function parseConfigOptions(rawOptions: unknown): {
  models: ModelOption[]
  permissions: PermissionOption[]
} {
  const list = Array.isArray(rawOptions) ? rawOptions : []
  const groups = list.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)

  function optionsOf(entry: Record<string, unknown>): Array<{ value: string; name: string; description: string }> {
    const opts = Array.isArray(entry['options']) ? entry['options'] : []
    return opts
      .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
      .map((o) => ({
        value: String(o['value'] ?? ''),
        name: String(o['name'] ?? o['value'] ?? ''),
        description: String(o['description'] ?? '')
      }))
      .filter((o) => o.value !== '')
  }

  const byCategory = (category: string, idFallback: string): Record<string, unknown> | undefined =>
    groups.find((g) => g['category'] === category) ?? groups.find((g) => g['id'] === idFallback)

  const modelEntry = byCategory('model', 'model')
  const modeEntry = byCategory('mode', 'mode')
  return {
    models: modelEntry ? optionsOf(modelEntry) : [],
    permissions: modeEntry ? optionsOf(modeEntry) : []
  }
}

/** 探测依赖；全部可注入，便于无 Electron 单测与黑盒 rig 驱动。 */
export interface ProbeDeps {
  /** 起一个 runner 并握手（注入以便 rig 用真 adapter、单测用 fake）。 */
  probeRuntime(options: {
    command: string
    args: string[]
    cwd: string
    node: string
  }): Promise<{
    agentInfo?: { name: string; version: string }
    configOptions: unknown[]
  }>
  /** 环境变量（缺省 process.env）。 */
  env?: NodeJS.ProcessEnv
  /** 本机 node 可执行文件（缺省 PATH 上的 node）。 */
  nodeExe?: string
  log?(line: string): void
}

/**
 * 探测一种 runtime（#49 AC2）。
 *
 * 分四项，逐项独立汇报 —— 现场最需要知道的是「卡在哪一项」，不是一句「接入失败」：
 *   1. Node 运行时 ≥22（runner 的硬要求）
 *   2. adapter 可执行文件在位
 *   3. CLI 与既有认证在位（凭证只读存在性，**不读内容、不复制**）
 *   4. ACP 真握手（这一步才拿到模型与 permission 枚举）
 */
export async function probeRuntime(runtime: RuntimeKind, deps: ProbeDeps): Promise<RuntimeProbe> {
  const env = deps.env ?? process.env
  const spec = RUNTIME_SPEC[runtime]
  const items: ProbeItem[] = []

  // 1) Node 运行时
  const nodeExe = deps.nodeExe || findExecutable('node', env) || 'node'
  const nodeVersion = nodeVersionOf(nodeExe)
  items.push(
    item(
      'node',
      `Node 运行时 ≥ ${MIN_NODE_MAJOR}`,
      nodeVersion !== null && nodeVersion.major >= MIN_NODE_MAJOR,
      nodeVersion ? `${nodeVersion.version}（${nodeExe}）` : `无法执行 ${nodeExe}`,
      `用 fnm/nvm 装 Node ${MIN_NODE_MAJOR}+ 再重试：runner 子进程跑不动低版本（ADR-0004）`
    )
  )

  // 2) adapter 可执行文件
  // PANTRY_AGENT_COMMAND 优先（现场手动指定）；否则按 adapter 的**可执行名**在 PATH 上找。
  // 包名（`@scope/name`）自己带 `/`，不能拿去当文件名 —— 那样永远找不到。
  const configured = (env['PANTRY_AGENT_COMMAND'] ?? '').trim()
  const adapterPath = configured
    ? resolveAgentCommand(configured, env)
    : findExecutable(spec.adapterBin, env)
  items.push(
    item(
      'adapter',
      'ACP adapter 在位',
      adapterPath !== '',
      adapterPath || `PATH 上没有 ${spec.adapterBin}${configured ? `（PANTRY_AGENT_COMMAND=${configured} 也解析不到）` : ''}`,
      `全局装 adapter：\`pnpm add -g ${spec.adapterPackage}\`；装完 PATH 上会出现 \`${spec.adapterBin}\`；或把 PANTRY_AGENT_COMMAND 指向它的绝对路径`
    )
  )

  // 3) CLI 与既有认证（只看存在性，不读内容）
  const cliPath = findExecutable(spec.cliName, env)
  items.push(
    item(
      'cli',
      `${spec.cliName} CLI 在位`,
      cliPath !== '',
      cliPath || `PATH 上没有 ${spec.cliName}`,
      `装 ${spec.cliName} CLI 并登录：${spec.authHint}`
    )
  )

  const home = env['HOME'] || env['USERPROFILE'] || ''
  const authDir = runtime === 'claude' ? join(home, '.claude') : join(home, '.codex')
  const authOk = home !== '' && existsSync(authDir)
  items.push(
    item(
      'auth',
      '既有认证可用',
      authOk,
      authOk ? `${authDir}（只检查存在性，不读内容）` : `未找到 ${authDir}`,
      spec.authHint
    )
  )

  // 4) ACP 真握手 —— 前面的静态检查都过了才值得花这一趟；未过时显式跳过而不是假装绿。
  const staticOk = items.every((i) => i.ok)
  let models: ModelOption[] = []
  let permissions: PermissionOption[] = []
  let agentInfo: { name: string; version: string } | undefined

  if (!staticOk) {
    items.push(
      item(
        'handshake',
        'ACP 握手（拿模型与 permission 枚举）',
        false,
        '前置项未通过，未发起握手',
        '先把上面标红的项修好，再点「重新探测」'
      )
    )
  } else {
    try {
      const result = await deps.probeRuntime({
        command: adapterPath,
        args: [],
        cwd: home,
        node: nodeExe
      })
      const parsed = parseConfigOptions(result.configOptions)
      models = parsed.models
      permissions = parsed.permissions
      agentInfo = result.agentInfo
      items.push(
        item(
          'handshake',
          'ACP 握手（拿模型与 permission 枚举）',
          true,
          `${result.agentInfo ? `${result.agentInfo.name}@${result.agentInfo.version}` : 'adapter'}：${models.length} 个模型 / ${permissions.length} 个 permission 档位`
        )
      )
    } catch (err) {
      const message = String((err as Error)?.message ?? err)
      deps.log?.(`[attach] ${runtime} 握手失败：${message}`)
      items.push(
        item(
          'handshake',
          'ACP 握手（拿模型与 permission 枚举）',
          false,
          message,
          `确认 adapter 能独立跑起来：\`${adapterPath}\`；若报认证失败，先跑 ${spec.cliName} 完成登录`
        )
      )
    }
  }

  return {
    runtime,
    ready: items.every((i) => i.ok),
    items,
    adapterPath,
    cliPath,
    models,
    permissions,
    ...(agentInfo ? { agentInfo } : {})
  }
}

/** 该 runtime 的 adapter 包名（探测不到时给用户看的安装建议用它）。 */
export function defaultAdapterPackage(runtime: RuntimeKind): string {
  return RUNTIME_SPEC[runtime].adapterPackage
}

/**
 * 在 PATH 上找某个 runtime 的默认 adapter（`PANTRY_AGENT_COMMAND` 未设时的兜底）。
 * 找不到返回空串 —— 由探测项负责告诉用户装什么。
 */
export function findAdapterOnPath(runtime: RuntimeKind, env: NodeJS.ProcessEnv = process.env): string {
  return findExecutable(RUNTIME_SPEC[runtime].adapterBin, env)
}

/** 探测全部 runtime（GUI 打开接入对话框时调一次）。 */
export async function probeAll(deps: ProbeDeps): Promise<RuntimeProbe[]> {
  const out: RuntimeProbe[] = []
  for (const runtime of RUNTIMES) {
    out.push(await probeRuntime(runtime, deps))
  }
  return out
}
