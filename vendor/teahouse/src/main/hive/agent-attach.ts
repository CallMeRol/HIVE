// Agent 接入编排（#49 AC3）：把「本机已有的 Claude Code / Codex」变成一个真的群成员。
//
// 为什么不是「在本节点内起个 runner 就算接入」：CONTEXT.md 定「成员表一条 = 一个独立
// agent 进程」，身份、上下文窗口、数据目录都要互相隔离。故接入 = **起一个真节点**：
//   建独立 userData → 生成独立身份 → 写完整 config → 注册主人 → 拉进群 → spawn 节点
//
// 三条从既有票继承的硬约束（踩过，别再犯）：
//   1. 完整字段集写 config.json：残缺 config 会让节点 net.ok=true、peers=0、零报错
//      （#44 landmine 1，记在 docs/local-api.md）；
//   2. userData 必须每次新建、永不复用：单例锁按 userData 隔离，复用 = 新成员背旧账本；
//   3. 身份不可从别处拷：拷 GUI 的 identity.json 会撞 nodeId，网络层直接灾难。
//      缺失时让节点自生成（app-state.ts 已实现），这里**不预置 identity.json**。
//
// 零 electron 依赖（依赖注入），可无 Electron 单测。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { findExecutable, RUNTIMES, type RuntimeKind } from './agent-probe'
import { unpackedPath } from './packaged-paths'

/** 一次接入的输入（= 接入对话框的五个可选项，AC1）。 */
export interface AttachRequest {
  runtime: RuntimeKind
  /** 成员在群里的显示名（写进该节点 config.json 的 nick）。 */
  nick: string
  /** ACP session 的 cwd —— 权限沙箱边界，不是节点 userData。 */
  cwd: string
  /** 模型（`session/new` 报回的选项之一）；空 = 用 adapter 默认。 */
  model: string
  /** ACP permission 档位（`session/new` 的 mode）；空 = adapter 默认。 */
  permissionMode: string
  /** 要拉进哪个群（空 = 只接入不进群，成员先在人名单里）。 */
  groupId: string
  /**
   * **探测给出的** adapter 绝对路径。带上它而不是在这里按 runtime 重猜一次：
   * 用户看到的是「探测到哪个 adapter」，接入就该用那一个 —— 一个 `PANTRY_AGENT_COMMAND`
   * 表达不了两种 runtime，重猜还可能选中另一份副本。空 = 退到按 runtime 解析。
   */
  adapterPath: string
  /**
   * Hive 侧的 permission 策略（`allow` | 缺省 fail-closed 拒绝）。
   *
   * 与 `permissionMode` 分工不同，别混：`permissionMode` 是 **adapter 自己的自主执行档位**
   * （ACP `set_config_option` 的 `mode`）；这一项是 **runner 对 agent 逐次工具请求的应答策略**。
   * 两者都与「Hive 确认键」无关 —— 确认键审批的是人发起的「空闲→开工」（#50）。
   */
  toolPermission: string
}

/** 接入结果：成功给 memberId，失败给可操作错误。 */
export interface AttachResult {
  ok: boolean
  memberId: string
  nodeId: string
  dataDir: string
  /** 该节点 local-api 端口（spawn 后从日志/配置读回）。 */
  apiPort: number
  udpPort: number
  tcpPort: number
  /** 实际使用的 adapter 与模型（回显给用户确认）。 */
  runtime: RuntimeKind
  adapterPath: string
  model: string
  permissionMode: string
  /** 失败时的可操作建议（ok=true 时为空）。 */
  hint: string
  error: string
}

/** 已接入成员的本机账本（接入状态，与 #53 的主人登记表分工：那里记「谁的」，这里记「怎么起的」）。 */
export interface AttachedMember {
  memberId: string
  ownerId: string
  runtime: RuntimeKind
  nick: string
  cwd: string
  model: string
  permissionMode: string
  dataDir: string
  udpPort: number
  tcpPort: number
  apiPort: number
  /** 起进程的 pid（用于状态展示；存活判定走 health）。 */
  pid: number
  attachedAt: number
}

export interface AttachStateFile {
  schemaVersion: number
  members: AttachedMember[]
}

/** 迁移规则（并行契约「迁移规则」第 1 条）：Hive 侧持久化一律带 schemaVersion。 */
export const ATTACH_STATE_SCHEMA_VERSION = 1

export function parseAttachState(raw: unknown): AttachStateFile {
  const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as AttachStateFile).members)
    ? (raw as AttachStateFile).members
    : []
  const members: AttachedMember[] = []
  for (const m of list) {
    if (typeof m !== 'object' || m === null) continue
    const r = m as unknown as Record<string, unknown>
    const memberId = typeof r['memberId'] === 'string' ? r['memberId'] : ''
    if (!memberId) continue
    members.push({
      memberId,
      ownerId: String(r['ownerId'] ?? ''),
      runtime: r['runtime'] === 'codex' ? 'codex' : 'claude',
      nick: String(r['nick'] ?? ''),
      cwd: String(r['cwd'] ?? ''),
      model: String(r['model'] ?? ''),
      permissionMode: String(r['permissionMode'] ?? ''),
      dataDir: String(r['dataDir'] ?? ''),
      udpPort: Number(r['udpPort'] ?? 0),
      tcpPort: Number(r['tcpPort'] ?? 0),
      apiPort: Number(r['apiPort'] ?? 0),
      pid: Number(r['pid'] ?? 0),
      attachedAt: Number(r['attachedAt'] ?? 0)
    })
  }
  return { schemaVersion: ATTACH_STATE_SCHEMA_VERSION, members }
}

export function upsertAttachedMember(file: AttachStateFile, member: AttachedMember): AttachStateFile {
  return {
    schemaVersion: ATTACH_STATE_SCHEMA_VERSION,
    members: [...file.members.filter((m) => m.memberId !== member.memberId), member]
  }
}

export function removeAttachedMember(file: AttachStateFile, memberId: string): AttachStateFile {
  return { schemaVersion: ATTACH_STATE_SCHEMA_VERSION, members: file.members.filter((m) => m.memberId !== memberId) }
}

// ---------- 端口分配 ----------

/**
 * 给新成员分一套不撞的端口。
 *
 * 沿用 launcher 的既有口径（docs/ops/launcher.md：按序号 +100 递增，逐节点独立），
 * 并叠加「跳过已被本机接入账本占用的」与「跳过实际被占用的」两道 —— 前一个接入的成员
 * 可能已经停了但端口还被别的进程听着，此时必须让开而不是硬上。
 */
export function allocatePorts(
  used: Array<{ udp: number; tcp: number; api: number }>,
  base = { udp: 17878, tcp: 17879, api: 17880 },
  /** 本机实际被占的端口集合（分配前由调用方异步批量探得；缺省视为无）。 */
  takenNow: Set<number> = new Set()
): { udp: number; tcp: number; api: number } {
  const takenUdp = new Set(used.map((u) => u.udp))
  const takenTcp = new Set(used.map((u) => u.tcp))
  const takenApi = new Set(used.map((u) => u.api))
  let step = 0
  for (;;) {
    step += 1
    const udp = base.udp + 100 * step
    const tcp = base.tcp + 100 * step
    // api 从 17880 起按同一节拍走，与 launcher 的 +100 一致。
    const api = base.api + 100 * step
    if (udp > 65535 || tcp > 65535 || api > 65535) {
      throw new Error('端口已用尽：本机接入的成员过多，先移出不再使用的成员')
    }
    if (takenUdp.has(udp) || takenTcp.has(tcp) || takenApi.has(api)) continue
    // 端口带是连续步进的：三个端口同带，任一实占整带让开（isTaken 口径既判 tcp 也判 udp）。
    if (takenNow.has(udp) || takenNow.has(tcp) || takenNow.has(api)) continue
    return { udp, tcp, api }
  }
}

/**
 * 分配前的实占探测：把候选端口带按 launcher 节拍逐带探过去（每带三个端口），直到探出
 * 一整带全空闲的为止，把这一带的端口集交给 `allocatePorts`。
 *
 * 为什么是「先批量探、再同步选」而不是在选端口循环里逐个探：探测本身要异步等事件
 * （同步探测在 Node 16 下会泄漏端口 —— 探测者把空闲端口占死在自己进程里），而探测是
 * 低频接入动作，多探几带的开销可忽略；换来的是「探过的端口绝不会被本进程持有」。
 */
export async function probeTakenPorts(
  used: Array<{ udp: number; tcp: number; api: number }>,
  base: { udp: number; tcp: number; api: number },
  isTaken: (port: number) => Promise<boolean>,
  maxBands = 64
): Promise<Set<number>> {
  const takenUdp = new Set(used.map((u) => u.udp))
  const takenTcp = new Set(used.map((u) => u.tcp))
  const takenApi = new Set(used.map((u) => u.api))
  for (let step = 1; step <= maxBands; step += 1) {
    const udp = base.udp + 100 * step
    const tcp = base.tcp + 100 * step
    const api = base.api + 100 * step
    if (udp > 65535 || tcp > 65535 || api > 65535) break
    // 账本/现有节点已声明的端口不用探（必然让开）；只实探尚未声明的。
    const toProbe = [...new Set([udp, tcp, api])].filter(
      (p) => !takenUdp.has(p) && !takenTcp.has(p) && !takenApi.has(p)
    )
    const results = await Promise.all(toProbe.map(async (p) => [p, await isTaken(p)] as const))
    const takenNow = new Set(results.filter(([, taken]) => taken).map(([p]) => p))
    if (takenNow.size === 0) return new Set()
    // 这一带有实占：整带记入并继续探下一带。
    for (const p of [udp, tcp, api]) takenNow.add(p)
    return probeTakenPorts(used, { udp: base.udp + 100 * step, tcp: base.tcp + 100 * step, api: base.api + 100 * step }, isTaken, maxBands - step)
      .then((rest) => new Set([...takenNow, ...rest]))
  }
  return new Set()
}

// ---------- 校验 ----------

const NICK_MAX_CHARS = 32
const GROUP_ID_MAX_CHARS = 64

/** 接入输入的校验（fail-closed：不合法就明说哪一项不对，不猜）。 */
export function validateAttachRequest(input: unknown): { ok: true; value: AttachRequest } | { ok: false; error: string; hint: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: '接入参数不是对象', hint: '这是界面内部错误，请重开接入对话框' }
  }
  const r = input as Record<string, unknown>
  const runtime = r['runtime']
  if (typeof runtime !== 'string' || !RUNTIMES.includes(runtime as RuntimeKind)) {
    return { ok: false, error: `未知 runtime：${String(runtime)}`, hint: `可选：${RUNTIMES.join(' / ')}` }
  }
  const nick = typeof r['nick'] === 'string' ? r['nick'].trim() : ''
  if (nick === '') return { ok: false, error: '成员名称不能为空', hint: '给成员起个名字，便于在群里 @ 它' }
  if (nick.length > NICK_MAX_CHARS) {
    return { ok: false, error: `成员名称过长（${nick.length} > ${NICK_MAX_CHARS}）`, hint: `截到 ${NICK_MAX_CHARS} 字以内` }
  }
  const cwd = typeof r['cwd'] === 'string' ? r['cwd'].trim() : ''
  if (cwd === '') {
    return {
      ok: false,
      error: '工作目录不能为空',
      hint: '选一个目录作为 agent 的工作区与权限沙箱边界（它读写文件的根）'
    }
  }
  if (!isAbsolute(cwd)) return { ok: false, error: `工作目录必须是绝对路径：${cwd}`, hint: '点「选择目录」挑一个' }
  if (!existsSync(cwd)) return { ok: false, error: `工作目录不存在：${cwd}`, hint: '重新选一个存在的目录' }

  const groupId = typeof r['groupId'] === 'string' ? r['groupId'].trim() : ''
  if (groupId.length > GROUP_ID_MAX_CHARS) {
    return { ok: false, error: '群 id 过长', hint: '这是界面内部错误，请重开接入对话框' }
  }
  return {
    ok: true,
    value: {
      runtime: runtime as RuntimeKind,
      nick,
      cwd: resolve(cwd),
      model: typeof r['model'] === 'string' ? r['model'].trim() : '',
      // permission 档位来自 adapter 的 mode 选项；空 = 用 adapter 默认，不替它做主。
      permissionMode: typeof r['permissionMode'] === 'string' ? r['permissionMode'].trim() : '',
      groupId,
      adapterPath: typeof r['adapterPath'] === 'string' ? r['adapterPath'].trim() : '',
      // 只有显式 allow 才放行；其余（含未填）一律 fail-closed。
      toolPermission: r['toolPermission'] === 'allow' ? 'allow' : ''
    }
  }
}

// ---------- env 装配 ----------

/**
 * 被接入节点的 agent 环境变量（env 契约见 docs/local-api.md）。
 *
 * 关键点：`PANTRY_AGENT_PERMISSION` 只表达**这个 agent 自己的工具放行档位**，
 * 与 Hive 的确认键（pending，#50）无关 —— 两条正交面，见 runner.mjs 的 permission handler。
 */
export function buildAgentEnv(
  request: AttachRequest,
  adapterPath: string,
  nodeExe: string
): Record<string, string> {
  const env: Record<string, string> = {
    PANTRY_AGENT_COMMAND: adapterPath,
    PANTRY_AGENT_CWD: request.cwd,
    PANTRY_AGENT_NODE: nodeExe
  }
  // runner 对 agent 逐次工具请求的应答策略（与 adapter 自己的 mode 是两层，见 AttachRequest）。
  if (request.toolPermission) env['PANTRY_AGENT_PERMISSION'] = request.toolPermission
  // 模型与 permission 都经 ACP 的 set_config_option 下发（#21：换掉坏默认模型的唯一干净手段）。
  const config: string[] = []
  if (request.model) config.push(`model=${request.model}`)
  if (request.permissionMode) config.push(`mode=${request.permissionMode}`)
  if (config.length > 0) env['PANTRY_AGENT_CONFIG'] = config.join(',')
  return env
}

// ---------- 依赖与编排 ----------

export interface AttachDeps {
  /** 本节点（主人）nodeId —— 写进成员登记表的 ownerId。 */
  selfId(): string
  /** 接入账本路径（userData 下）。 */
  attachStatePath(): string
  /** 数据根：每个成员在 `<dataRoot>/<memberId>/` 拿独立 PANTRY_USER_DATA。 */
  dataRoot(): string
  /**
   * 本机**真 Node** 可执行文件（必须 ≥22 的那一个）。
   * 注意别在 Electron 里裸写 'node'：那会解析到 Electron 自己的二进制，
   * 于是 runner 永不 ready、表现为握手超时（实测踩到）。
   */
  nodeExe(): string
  /**
   * 请求里带了探测结果就用它（用户看到哪个就用哪个）；没带才按 runtime 解析一次。
   * 一个 `PANTRY_AGENT_COMMAND` 表达不了两种 runtime，所以请求携带的优先级更高。
   */
  adapterPath(runtime: RuntimeKind, requested?: string): string
  /** 写完整字段集的节点 config.json（复用 launcher 的口径，别在这里拼半份）。 */
  writeNodeConfig(input: { dataDir: string; nick: string; udp: number; tcp: number }): void
  /** 起一个 headless 节点进程；返回 pid。 */
  spawnNode(input: {
    dataDir: string
    udp: number
    tcp: number
    api: number
    peers: string[]
    env: Record<string, string>
  }): { pid: number; logPath: string }
  /** 该节点 local-api 的 health（用于校验身份确实起来了）。 */
  waitHealth(input: { dataDir: string; apiPort: number; timeoutMs: number }): Promise<{ nodeId: string } | null>
  /** 把成员拉进群（走底座既有 invite，无权限门）。返回 false = 未进群。 */
  inviteToGroup(groupId: string, memberId: string): boolean
  /** 登记成员主人（#53 的 register；ownerId = 本机 selfId）。 */
  registerMember(input: { memberId: string; ownerId: string; kind: 'resident'; groupId?: string }): void
  /**
   * 撤销登记（回滚用）。**必须**提供：登记了却没起成节点，会让主人以为有个成员而实际没有，
   * 这种「幽灵成员」正是 #53 判权表的反例。
   */
  unregisterMember(memberId: string): void
  /**
   * 端口是否被本机占用（缺省用真实探测，注入以便单测）。**异步**：bind 的失败在 Node
   * 里是异步 emit 的，同步探测既收不到「被占」也挡不住「探完泄漏」（#49 live 实测）。
   */
  isPortTaken?(port: number): Promise<boolean>
  /** 本机现有接入成员的端口（避让用）。 */
  existingPorts(): Array<{ udp: number; tcp: number; api: number }>
  log?(line: string): void
  now?(): number
}

/** health 轮询上限：起节点到能握手，实测远快于此，留足余量。 */
const HEALTH_TIMEOUT_MS = 30_000

function readAttachState(path: string): AttachStateFile {
  try {
    return parseAttachState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { schemaVersion: ATTACH_STATE_SCHEMA_VERSION, members: [] }
  }
}

function writeAttachState(path: string, file: AttachStateFile): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

/**
 * 接入一个成员（AC3 的落地动作）。**全有或全无**：任一步失败就回滚已做的部分，
 * 并把「卡在哪一步 + 下一步做什么」交给调用方（不静默留半拉成员）。
 */
export async function attachMember(input: unknown, deps: AttachDeps): Promise<AttachResult> {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const statePath = deps.attachStatePath()

  const invalid: AttachResult = {
    ok: false,
    memberId: '',
    nodeId: '',
    dataDir: '',
    apiPort: 0,
    udpPort: 0,
    tcpPort: 0,
    runtime: 'claude',
    adapterPath: '',
    model: '',
    permissionMode: '',
    hint: '',
    error: ''
  }

  const validated = validateAttachRequest(input)
  if (!validated.ok) {
    return { ...invalid, error: validated.error, hint: validated.hint }
  }
  const request = validated.value

  const adapterPath = deps.adapterPath(request.runtime, request.adapterPath)
  if (!adapterPath || !existsSync(adapterPath)) {
    return {
      ...invalid,
      runtime: request.runtime,
      error: `adapter 不可用：${adapterPath || '（未探测到）'}`,
      hint: '先在接入对话框点「重新探测」，按提示装好 adapter 再接入'
    }
  }

  const nodeExe = deps.nodeExe() || findExecutable('node') || 'node'
  const state = readAttachState(statePath)
  const isTaken = deps.isPortTaken ?? (async () => false)

  let ports: { udp: number; tcp: number; api: number }
  try {
    const usedPorts = [
      ...deps.existingPorts(),
      ...state.members.map((m) => ({ udp: m.udpPort, tcp: m.tcpPort, api: m.apiPort }))
    ]
    // 先批量实探候选端口带，再同步选：探测必须异步等事件（同步版在 Node 16 会把
    // 空闲端口泄漏成占用），不能塞进选端口的同步循环里。
    const takenNow = await probeTakenPorts(usedPorts, { udp: 17878, tcp: 17879, api: 17880 }, isTaken)
    ports = allocatePorts(usedPorts, undefined, takenNow)
  } catch (err) {
    return { ...invalid, runtime: request.runtime, error: String((err as Error).message), hint: '先移出不再使用的成员，腾出端口' }
  }

  // 成员 id 用 runtime + 时间戳 + 端口，够唯一、又能在账本里一眼看出是什么。
  const memberId = `${request.runtime}-${now()}-${ports.udp}`
  const dataDir = join(deps.dataRoot(), memberId)

  let spawned: { pid: number; logPath: string } | null = null
  let invited = false

  try {
    // 1) 独立数据目录 + 完整字段集 config.json（#44 landmine 1）
    mkdirSync(dataDir, { recursive: true })
    deps.writeNodeConfig({ dataDir, nick: request.nick, udp: ports.udp, tcp: ports.tcp })

    // 2) 先登记 + 拉进群，再起进程。
    //    顺序有讲究：底座对未知群会走离线补发队列，先 invite 后 spawn 能消掉「已起未入群」
    //    的中间态（ADR-0006 Decision「先 invite 后起」），也不需要回滚邀请。
    deps.registerMember({
      memberId,
      ownerId: deps.selfId(),
      kind: 'resident',
      ...(request.groupId ? { groupId: request.groupId } : {})
    })
    if (request.groupId) {
      invited = deps.inviteToGroup(request.groupId, memberId)
      if (!invited) {
        log(`[attach] 拉群失败：${request.groupId} ← ${memberId}`)
        deps.unregisterMember(memberId)
        return {
          ...invalid,
          runtime: request.runtime,
          adapterPath,
          error: `未能把成员拉进群 ${request.groupId}`,
          hint: '确认这个群还在、且本节点仍在群里；或先在 GUI 里手动把成员加进群，再重试接入'
        }
      }
    }

    // 3) 起 headless 节点
    const peers = [
      ...deps.existingPorts().map((p) => `127.0.0.1:${p.udp}`),
      ...state.members.map((m) => `127.0.0.1:${m.udpPort}`)
    ]
    const env = {
      ...buildAgentEnv(request, adapterPath, nodeExe),
      PANTRY_HEADLESS: '1',
      PANTRY_USER_DATA: dataDir,
      PANTRY_UDP_PORT: String(ports.udp),
      PANTRY_TCP_PORT: String(ports.tcp),
      PANTRY_LOCAL_API_PORT: String(ports.api)
    }
    spawned = deps.spawnNode({ dataDir, udp: ports.udp, tcp: ports.tcp, api: ports.api, peers, env })

    // 4) 等 health 并校验身份：这一步才证明「这个成员真的起来了」。
    const health = await deps.waitHealth({ dataDir, apiPort: ports.api, timeoutMs: HEALTH_TIMEOUT_MS })
    if (!health) {
      log(`[attach] ${memberId} 未在 ${HEALTH_TIMEOUT_MS}ms 内就绪`)
      return {
        ...invalid,
        runtime: request.runtime,
        adapterPath,
        memberId,
        nodeId: '',
        dataDir,
        udpPort: ports.udp,
        tcpPort: ports.tcp,
        apiPort: ports.api,
        error: `成员节点未在 ${HEALTH_TIMEOUT_MS / 1000}s 内就绪`,
        hint: `看节点日志 ${spawned.logPath}；常见原因：端口被占、adapter 路径失效、Node 版本不足`
      }
    }

    const member: AttachedMember = {
      memberId,
      ownerId: deps.selfId(),
      runtime: request.runtime,
      nick: request.nick,
      cwd: request.cwd,
      model: request.model,
      permissionMode: request.permissionMode,
      dataDir,
      udpPort: ports.udp,
      tcpPort: ports.tcp,
      apiPort: ports.api,
      pid: spawned.pid,
      attachedAt: now()
    }
    writeAttachState(statePath, upsertAttachedMember(state, member))
    log(`[attach] ${memberId} 接入完成：nodeId=${health.nodeId} pid=${spawned.pid} api=${ports.api}`)

    return {
      ok: true,
      memberId,
      nodeId: health.nodeId,
      dataDir,
      apiPort: ports.api,
      udpPort: ports.udp,
      tcpPort: ports.tcp,
      runtime: request.runtime,
      adapterPath,
      model: request.model,
      permissionMode: request.permissionMode,
      hint: '',
      error: ''
    }
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    log(`[attach] ${memberId} 失败：${message}`)
    // 回滚：撤登记，不留幽灵成员（进程若已起由调用方的 down 路径收）。
    if (invited) deps.unregisterMember(memberId)
    return {
      ...invalid,
      runtime: request.runtime,
      adapterPath,
      memberId,
      dataDir,
      udpPort: ports.udp,
      tcpPort: ports.tcp,
      apiPort: ports.api,
      error: message,
      hint: spawned
        ? `节点已起但接入未完成；先跑 \`pnpm run hive -- down\` 清干净，再看日志 ${spawned.logPath}`
        : '重开接入对话框重试；若反复失败，跑 `pnpm run hive -- doctor`'
    }
  }
}

/** 列出本机已接入的成员（GUI 展示与端口避让都用它）。 */
export function listAttached(deps: { attachStatePath(): string }): AttachedMember[] {
  return readAttachState(deps.attachStatePath()).members
}

/** 忘掉一条接入记录（成员已被移出/回收时调用）。 */
export function forgetAttached(memberId: string, deps: { attachStatePath(): string }): boolean {
  const path = deps.attachStatePath()
  const before = readAttachState(path)
  const next = removeAttachedMember(before, memberId)
  if (next.members.length === before.members.length) return false
  writeAttachState(path, next)
  return true
}

/**
 * runner 入口所在目录。
 *
 * `runner.mjs` 是**裸 .mjs**（不是 ts 编译产物），故不在 electron-vite 的入口图里 ——
 * `scripts/copy-acp-runtime.mjs` 负责把它复制进 `out/main/acp/`（#52）。
 *
 * 打包态还有第二道坎（#25 修 #62 的验收缺口）：runner 由**系统 node 子进程**执行，
 * 而 node 读不穿 asar —— `…/app.asar/out/main/acp/runner.mjs` 对它是 ENOENT。故
 * `build.asarUnpack` 把 `out/main/acp/**` 解包出来，这里也**先**把候选路径映射到
 * `app.asar.unpacked/`。调用方给的候选按顺序找：
 *   1. `out/main/acp/`（构建后 / 打包后应有的位置）
 *   2. `src/main/acp/`（dev 直接跑源码树）
 * 两处都没有就抛，不静默降级成一个「连不上 agent」的节点。
 */
export function resolveRunnerDir(candidates: string[]): string {
  const expanded: string[] = []
  for (const dir of candidates) {
    for (const candidate of [unpackedPath(dir), dir]) {
      if (!expanded.includes(candidate)) expanded.push(candidate)
    }
  }
  for (const dir of expanded) {
    if (existsSync(join(dir, 'runner.mjs'))) return dir
  }
  throw new Error(
    `找不到 runner.mjs，试过：${expanded.join(' / ')}（先 \`pnpm run build\`；打包分发属 #62）`
  )
}

/** 供 index.ts 装配时判断 env 是否齐（探测报告用）。 */
export function envHasAgent(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean((env['PANTRY_AGENT_COMMAND'] ?? '').trim())
}

/**
 * 给新成员节点写**完整字段集**的 config.json。
 *
 * 与 `scripts/lib/hive-node-config.mjs` 同源纪律（#44 landmine 1）：只写一两个字段的残缺
 * config 会让 packaged 节点 `net.ok=true`、`peers=0`、**零报错**，怎么等都发现不到对端。
 * 那一份是 rig/launcher 侧的（仓库根，不受 vendor 守卫约束）；这里是运行期路径，
 * 不能跨出 vendor 树去 import 它，故按同一份字段集在这里复刻，并保持逐字段对齐
 * `src/main/store/app-state.ts` 的 `ConfigFile`。
 *
 * **不写 identity.json**：缺失时节点自生成（app-state.ts），这才是「每次新建身份、
 * 永不复用」的落点；预置一份会引入 nodeId 撞车的风险。
 */
export function writeFullNodeConfig(input: {
  dataDir: string
  nick: string
  udp: number
  tcp: number
  /** 打包版会真的改开机自启项，默认关掉，别动这台机器的登录项。 */
  autoLaunch?: boolean
  closeToTray?: boolean
}): string {
  const config = {
    nick: input.nick,
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
    udpPort: input.udp,
    tcpPort: input.tcp,
    hideOnCapture: true,
    autoLaunch: input.autoLaunch ?? false,
    closeToTray: input.closeToTray ?? false,
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
  mkdirSync(input.dataDir, { recursive: true })
  const path = join(input.dataDir, 'config.json')
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return path
}

/**
 * 待 spawn 的可执行文件（`{exe, args}`）。
 *
 * 从**正在运行的 Electron 进程内部**起兄弟节点，与 launcher 从外部起节点不同，
 * 这里是更省事的那一侧：`process.execPath` 就是**当前真二进制**
 * （dev = Electron.app/Contents/MacOS/Electron；打包 = Teahouse.app/Contents/MacOS/Teahouse），
 * 天然满足「不许拿 `node_modules/.bin/electron` wrapper 的 pid」这条纪律（那是 launcher
 * 从外部解析时才会踩的坑）。dev 下补一个 `.` 让它加载 app 目录，打包下不需要。
 *
 * cwd 由调用方给（dev = app 目录，打包 = .app 的父目录）。
 */
export function resolveNodeExecutable(options: {
  isPackaged: boolean
  execPath: string
}): { exe: string; args: string[] } {
  return { exe: options.execPath, args: options.isPackaged ? [] : ['.'] }
}
