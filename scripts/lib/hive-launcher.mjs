// Hive 本机运维 launcher（#48）：一套声明式配置驱动 up / down / status / doctor。
//
// 交付物边界（并行契约「模块所有权」表）：本模块拥有「声明式配置 + up/status/doctor/down 脚本」，
// 明令禁止的是「在业务模块内复制健康检查逻辑」——故健康检查只有一处实现：
// local-api 的 `GET /v1/health`（#44）。本文件从不 parse 上游 SQLite、不读节点内部状态。
//
// 纪律：
//   - 不 import electron，不进 vendor 树（守卫生效面之外，是 Hive 自有工具层）。
//   - 健康就绪的定义 = health 返回的 nodeId 与本节点预期一致 + net.ok + 端口吻合。
//     只等 HTTP 起来不算就绪：残缺 config 会让节点 health 可用但 peers=0（#44 landmine 1）。
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { writeNodeConfig } from './hive-node-config.mjs'
import { cmdlineOf, killGroup, killTree, pidAlive, portOwners, sleep, udpBinders } from './hive-proc.mjs'

const require = createRequire(import.meta.url)
export const REPO = resolve(dirname(require.resolve('../../package.json')))

/** 数据根缺省：`~/Library/Application Support/Hive`（macOS）；其他平台用 XDG 风格兜底。 */
function defaultDataRoot() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Hive')
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? homedir(), 'Hive')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'hive')
}

export const DEFAULT_CONFIG_PATH = join(REPO, 'hive.config.json')
export const STATE_FILE = 'launcher-state.json'

// ---------- 配置 ----------

/** 节点的默认端口基址：GUI 用 17878 系，其余节点按序号 +100 递增，互不重叠。 */
const GUI_UDP = 17878
const PORT_STRIDE = 100

class ConfigError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'ConfigError'
    this.hint = hint
  }
}

function fail(message, hint) {
  throw new ConfigError(message, hint)
}

function asPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`${label} 必须是 1–65535 的整数（当前 ${JSON.stringify(value)}）`, '改 hive.config.json 对应字段')
  }
  return value
}

/**
 * 读并校验 hive.config.json。所有校验错误都带 `hint`（可操作诊断），
 * 由 CLI 层统一渲染为 `错误：… / 建议：…` 并非零退出。
 */
export function loadConfig(configPath = DEFAULT_CONFIG_PATH, { needNodes = true } = {}) {
  if (!existsSync(configPath)) {
    fail(`找不到配置文件 ${configPath}`, '先 cp hive.config.example.json hive.config.json 并按需修改')
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (err) {
    fail(`配置文件不是合法 JSON：${err.message}`, `用编辑器或 jq 校验 ${configPath}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('配置根必须是 JSON 对象', `检查 ${configPath} 的最外层`)
  }

  const dataRoot = raw.dataRoot
    ? resolve(isAbsolute(raw.dataRoot) ? raw.dataRoot : join(dirname(configPath), raw.dataRoot))
    : defaultDataRoot()

  // app：打包 .app 优先，缺省用 dev 构建产物（vendor/teahouse/out/）。
  const app = raw.app ?? null
  if (app !== null && typeof app !== 'string') fail('app 必须是 .app 路径字符串或缺省', '删掉 app 字段即用 dev 构建产物')
  const appPath = app ? resolve(isAbsolute(app) ? app : join(dirname(configPath), app)) : null

  const rawNodes = raw.nodes
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    if (needNodes) fail('nodes 必须是非空数组', '至少声明一个节点；GUI 节点请标 "gui": true')
    return { configPath, dataRoot, appPath, nodes: [], cliPort: raw.cliPort }
  }

  const seenIds = new Set()
  const nodes = rawNodes.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`nodes[${index}] 必须是对象`, '形如 { "id": "gui", "gui": true }')
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '') fail(`nodes[${index}].id 必须是非空字符串`, '给每个节点一个稳定且唯一的 id')
    if (seenIds.has(id)) fail(`节点 id 重复：${id}`, '节点 id 用于定位数据目录与端口，必须唯一')
    seenIds.add(id)

    const isGui = entry.gui === true
    if (entry.gui !== undefined && typeof entry.gui !== 'boolean') {
      fail(`nodes[${index}].gui 必须是布尔`, '不需要 GUI 就删掉该字段（默认 headless）')
    }
    const autoLaunch = entry.autoLaunch === true
    if (entry.autoLaunch !== undefined && typeof entry.autoLaunch !== 'boolean') {
      fail(`nodes[${index}].autoLaunch 必须是布尔`, '删掉即默认 false')
    }

    const base = GUI_UDP + index * PORT_STRIDE
    const udp = asPort(entry.udp ?? (isGui ? GUI_UDP : base), `nodes[${index}].udp`)
    const tcp = asPort(entry.tcp ?? (isGui ? GUI_UDP + 1 : base + 1), `nodes[${index}].tcp`)
    // api 缺省给具体端口（base+2）：up/status/doctor 都要在起进程**之前**知道它。
    // 填 0 = 由系统分配临时端口，此时端口只能从节点日志里读回来（见 resolveApiPort）。
    const api = entry.api === undefined ? base + 2 : asPort(entry.api, `nodes[${index}].api`)
    const cdp = entry.cdp === undefined ? null : asPort(entry.cdp, `nodes[${index}].cdp`)

    if (isGui && cdp !== null) fail(`节点 ${id} 同时是 GUI 与 CDP 调试目标`, 'CDP 只给 e2e rig 用；现场配置请删掉 cdp')

    return {
      id,
      gui: isGui,
      headless: !isGui,
      autoLaunch,
      udp,
      tcp,
      api,
      cdp,
      nick: typeof entry.nick === 'string' && entry.nick.trim() !== '' ? entry.nick.trim() : `Hive ${id}`,
      dataDir: join(dataRoot, id)
    }
  })

  // 端口必须两两不同（UDP 与 TCP 分开看；同一节点的 udp/tcp 也不同是上游惯例）。
  const claimed = new Map()
  for (const node of nodes) {
    for (const [kind, port] of [['udp', node.udp], ['tcp', node.tcp], ['api', node.api], ['cdp', node.cdp]]) {
      if (port === null || port === 0) continue
      const key = `${kind}:${port}`
      if (claimed.has(key)) {
        fail(
          `端口冲突：${node.id}.${kind}=${port} 与 ${claimed.get(key)}.${kind} 相同`,
          '给每个节点分配不同端口（缺省按 +100 递增，通常无需手写）'
        )
      }
      claimed.set(key, node.id)
    }
  }

  return { configPath, dataRoot, appPath, nodes }
}

// ---------- 可执行文件解析 ----------

/**
 * dev 模式可执行文件 = Electron **真二进制**，不走 `node_modules/.bin/electron`。
 *
 * 那个 .bin 是个 node wrapper 脚本，它再 spawn 真 Electron：拿它的 pid 当节点 pid 会错位
 * —— 杀 wrapper 不动 Electron，`pidAlive` 也测不到真实存活。`require('electron')` 是上游
 * 官方路径解析（跨平台，读 package 的 path.txt），拿到什么就是什么。
 */
function devElectron() {
  const vendorRequire = createRequire(join(REPO, 'vendor', 'teahouse', 'package.json'))
  let exe
  try {
    exe = vendorRequire('electron')
  } catch (err) {
    fail(
      `无法解析 vendored Electron：${err.message}`,
      '先跑 `pnpm run setup`（npm ci --prefix vendor/teahouse）'
    )
  }
  const out = join(REPO, 'vendor', 'teahouse', 'out', 'main', 'index.js')
  if (!existsSync(exe) || !existsSync(out)) {
    fail(
      'dev 构建产物缺失',
      '先跑 `pnpm run setup && pnpm run build`，或在 hive.config.json 里用 "app" 指向打包好的 .app'
    )
  }
  return { exe, args: ['.'], cwd: join(REPO, 'vendor', 'teahouse'), kind: 'dev' }
}

/** 解析成 { exe, args, cwd, kind }。`appPath` 为 null 时用 dev 构建产物。 */
export function resolveExecutable(appPath) {
  if (!appPath) return devElectron()
  if (!existsSync(appPath)) {
    fail(`找不到 app：${appPath}`, '检查 hive.config.json 的 "app" 路径，或先 electron-builder 打包')
  }
  const exe = join(appPath, 'Contents', 'MacOS', 'Hive')
  if (!existsSync(exe)) {
    fail(
      `app 结构不对，缺 ${exe}`,
      '传的应是 .app 目录本身（如 vendor/teahouse/release/mac-arm64/Hive.app）'
    )
  }
  return { exe, args: [], cwd: dirname(appPath), kind: 'app' }
}

// ---------- 状态文件 ----------

function statePath(dataRoot) {
  return join(dataRoot, STATE_FILE)
}

export function readState(dataRoot) {
  try {
    const raw = JSON.parse(readFileSync(statePath(dataRoot), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { nodes: {} }
  } catch {
    return { nodes: {} }
  }
}

function writeState(dataRoot, state) {
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(statePath(dataRoot), `${JSON.stringify(state, null, 2)}\n`)
}

// ---------- health ----------

export async function health(port, token = '', timeoutMs = 2000) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * 节点实际 api 端口。配置写了具体端口就用它；写了 0（系统分配）时端口只有运行时才知道，
 * 从节点自己的日志行 `[local-api] 监听 127.0.0.1:<port>` 里读回来。
 * 这也是 status/down 在 api=0 时唯一的抓手 —— 故这个端口**必须**落进状态文件。
 */
function apiPortOf(node, record) {
  if (node.api > 0) return node.api
  const recorded = record?.api
  return Number.isInteger(recorded) && recorded > 0 ? recorded : null
}

/** 节点日志路径：现场排查的第一手材料，也是 api=0 时端口的唯一来源。 */
export function nodeLogPath(node) {
  return join(node.dataDir, 'node.log')
}

/** 从节点日志里抠出 local-api 实际端口（仅 api=0 时需要）。 */
function scrapeApiPort(node) {
  const log = readTail(node, 200)
  for (const line of log) {
    const m = /\[local-api\] 监听 127\.0\.0\.1:(\d+)/.exec(line)
    if (m) return Number(m[1])
  }
  return null
}

/** 读节点日志的最后 n 行（文件不存在时返回空）。 */
function readTail(node, n = 40) {
  try {
    const text = readFileSync(nodeLogPath(node), 'utf8')
    const lines = text.split('\n').filter((l) => l.trim() !== '')
    return lines.slice(-n)
  } catch {
    return []
  }
}

/**
 * 就绪判定：health 可用 **且** 报出的 nodeId 是本节点（防止误读上一个残留节点的 health），
 * 且 udp/tcp 端口吻合，且 net.ok。返回 { ok, view, reason }。
 */
async function probeReadiness(node, record, { expectNodeId = null, timeoutMs = 2000 } = {}) {
  const port = apiPortOf(node, record)
  if (port === null) return { ok: false, reason: '未知 api 端口（节点尚未上报）', port: null }
  let view
  try {
    view = await health(port, '', timeoutMs)
  } catch (err) {
    return { ok: false, reason: `health 不可达（${err.message}）`, port }
  }
  if (expectNodeId && view.nodeId !== expectNodeId) {
    return { ok: false, reason: `health 来自别的节点（nodeId=${view.nodeId}）`, port, view }
  }
  if (view.ports?.udp !== node.udp || view.ports?.tcp !== node.tcp) {
    return {
      ok: false,
      reason: `health 报出的端口与本节点配置不符（udp=${view.ports?.udp} tcp=${view.ports?.tcp}）`,
      port,
      view
    }
  }
  if (view.net?.ok !== true) {
    return { ok: false, reason: `网络栈未就绪${view.net?.error ? `：${view.net.error}` : ''}`, port, view }
  }
  return { ok: true, view, port }
}

async function waitReadiness(node, record, opts, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = { ok: false, reason: '未开始探测' }
  for (;;) {
    last = await probeReadiness(node, record, opts)
    if (last.ok) return last
    if (Date.now() >= deadline) return last
    await sleep(400)
  }
}

/** 等 `[local-api] 监听` 行出现并返回端口（仅 node.api === 0 时走这条路）。 */
async function waitScrapedApiPort(node, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const port = scrapeApiPort(node)
    if (port !== null) return port
    if (Date.now() >= deadline) return null
    await sleep(300)
  }
}

// ---------- 启动 ----------

/**
 * 起一个节点进程。`detached: true` 让它自成进程组：
 * 现场 launcher 是短命进程，节点必须活得比它久，且 down 时能整组收干净。
 *
 * 输出**写日志文件而不是接管道**：#44 的 rig 可以用管道是因为它自己就是长命进程；
 * launcher 是短命 CLI，若节点继承 stdout 管道，调用方（乃至 e2e 里 wrap 它的 execFile）
 * 会一直等不到 EOF 而被自己的 timeout 杀掉 —— 表现为「up 永远不返回」。
 * 日志文件同时是现场排查的第一手材料（api=0 时端口的唯一来源）。
 */
function spawnNode(node, exe, { peers, token }) {
  mkdirSync(node.dataDir, { recursive: true })
  writeNodeConfig({ dataDir: node.dataDir, nick: node.nick, udp: node.udp, tcp: node.tcp })

  const env = {
    ...process.env,
    PANTRY_USER_DATA: node.dataDir,
    PANTRY_UDP_PORT: String(node.udp),
    PANTRY_TCP_PORT: String(node.tcp),
    PANTRY_LOCAL_API_PORT: String(node.api),
    PANTRY_LOCAL_API_TOKEN: token,
    ...(node.headless ? { PANTRY_HEADLESS: '1' } : {}),
    ...(peers.length > 0 ? { PANTRY_PEERS: peers.join(',') } : {})
  }
  const args = [...exe.args, ...(node.cdp ? [`--remote-debugging-port=${node.cdp}`] : [])]
  const logFd = openSync(nodeLogPath(node), 'w')
  let child
  try {
    child = spawn(exe.exe, args, {
      cwd: exe.cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd]
    })
  } finally {
    // 父进程必须立刻关掉自己那一份 fd，否则 down 后 fd 仍持有会让文件句柄悬空。
    closeSync(logFd)
  }
  child.unref()
  return child
}

/**
 * `up`：预检端口 → 起全部节点 → 逐个等就绪。
 *
 * 语义是**全有或全无**：任何一个节点没就绪，就地把已起的全部收掉再非零退出。
 * 否则现场会留下半拉环境（GUI 起着、成员没起），比彻底失败更难排查。
 */
export async function up(config, { verbose = true, timeoutMs = 60000 } = {}) {
  const log = verbose ? (line) => console.log(line) : () => {}
  const exe = resolveExecutable(config.appPath)
  const token = process.env.PANTRY_LOCAL_API_TOKEN ?? ''
  const peers = config.nodes.map((n) => `127.0.0.1:${n.udp}`)

  log(`启动 ${config.nodes.length} 个节点（${exe.kind}：${exe.exe}）`)
  log(`数据根：${config.dataRoot}`)

  // 端口预检：被占就先停。不等就绪直接起会读到上一个残留节点的 health 而假通过。
  const conflicts = []
  for (const node of config.nodes) {
    for (const [kind, port] of [['udp', node.udp], ['tcp', node.tcp], ['api', node.api], ['cdp', node.cdp]]) {
      if (port === null || port === 0) continue
      const owners = portOwners(port, { udp: kind === 'udp' })
      if (owners.length > 0) conflicts.push(`${node.id}.${kind}=${port} 被 pid ${owners[0].pid} 占用`)
    }
  }
  if (conflicts.length > 0) {
    fail(
      `端口被占用：\n  - ${conflicts.join('\n  - ')}`,
      '先跑 `pnpm run hive -- down` 清本环境；仍占用则 `lsof -nP -iTCP:<端口>` 找占用者'
    )
  }

  const started = []
  const state = { nodes: {}, startedAt: Date.now(), configPath: config.configPath }

  for (const node of config.nodes) {
    // 外部对端要排除自己：把本节点 udp 从 peers 里去掉。
    const peerList = peers.filter((p) => p !== `127.0.0.1:${node.udp}`)
    let child
    try {
      child = spawnNode(node, exe, { peers: peerList, token })
    } catch (err) {
      // 起不来（数据目录不可写等）也要走同一条回滚路径，否则前面起的节点变成孤儿。
      log(`  ✗ ${node.id} 启动失败：${err.message}`)
      log('\n有节点未就绪，回滚全部已启动节点')
      await down(config, { verbose: false })
      throw new ConfigError(
        `up 失败：节点 ${node.id} 无法启动（${err.message}）`,
        '跑 `pnpm run hive -- doctor` 看数据目录与端口两项；数据目录不可写时改 hive.config.json 的 dataRoot'
      )
    }
    started.push({ node, child })
    state.nodes[node.id] = {
      pid: child.pid,
      gui: node.gui,
      udp: node.udp,
      tcp: node.tcp,
      requestedApi: node.api,
      api: node.api > 0 ? node.api : null,
      dataDir: node.dataDir,
      startedAt: Date.now()
    }
    // 每起一个就落盘一次：spawn 失败要立刻回滚，而 down 只能靠状态文件找到已起的节点。
    // 攒到最后一起写会让「第 2 个起不来」时第 1 个无人认领 —— 现场表现就是回滚不干净。
    writeState(config.dataRoot, state)
    log(`  ↑ ${node.id} pid=${child.pid} udp=${node.udp} tcp=${node.tcp} api=${node.api || '自动'}`)
  }

  const failed = []
  for (const { node, child } of started) {
    const record = state.nodes[node.id]
    // api=0（系统分配临时端口）时，端口只能从节点日志里读回来；先把它捞进状态，
    // 否则 waitReadiness 无从下手，status/down 也找不到这个节点。
    if (node.api === 0) {
      const scraped = await waitScrapedApiPort(node, timeoutMs)
      if (scraped === null) {
        failed.push({
          node,
          child,
          record,
          reason: 'local-api 未上报监听端口（节点日志里没有 `[local-api] 监听` 行）'
        })
        continue
      }
      record.api = scraped
      writeState(config.dataRoot, state)
    }
    const result = await waitReadiness(node, record, {}, timeoutMs)
    if (!result.ok) {
      failed.push({ node, child, record, reason: result.reason })
      continue
    }
    record.api = result.port
    record.nodeId = result.view.nodeId
    record.groups = result.view.groups
    record.peers = result.view.peers
    record.readyAt = Date.now()
    writeState(config.dataRoot, state)
    log(`  ✓ ${node.id} 就绪 nodeId=${result.view.nodeId} api=${result.port} groups=${result.view.groups} peers=${result.view.peers}`)
  }

  if (failed.length > 0) {
    const lines = failed.map((f) => {
      const alive = pidAlive(f.child.pid) ? `pid ${f.child.pid} 仍在` : '进程已退出'
      const tail = readTail(f.node, 8)
        .map((l) => `      ${l}`)
        .join('\n')
      return `  - ${f.node.id}：${f.reason}（${alive}）\n${tail}`
    })
    log('\n有节点未就绪，回滚全部已启动节点')
    await down(config, { verbose: false })
    throw new ConfigError(
      `up 失败，以下节点未就绪：\n${lines.join('\n')}`,
      [
        '跑 `pnpm run hive -- doctor` 逐项体检；常见成因：',
        '  1. 节点起来就退 → 看上面 stderr 尾巴；userData 冲突/权限被拒都会这样',
        '  2. 端口被占 → 见 doctor 的端口段',
        '  3. GUI 在无显示环境下起不来 → 先只声明 headless 节点验证底座',
        `  4. 超时太短 → 现场冷启动可加 --timeout（当前 ${timeoutMs}ms）`
      ].join('\n')
    )
  }

  log(`\n全部 ${config.nodes.length} 个节点已就绪。停：pnpm run hive -- down；查：pnpm run hive -- status`)
  return state
}

// ---------- 停止 ----------

/** 节点占用的端口（含 api；api=0 时用状态文件里记下的实际端口）。 */
function portsOfNode(node, record) {
  const list = [
    ['udp', node.udp, true],
    ['tcp', node.tcp, false],
    ['cdp', node.cdp, false]
  ]
  const api = apiPortOf(node, record)
  if (api !== null) list.push(['api', api, false])
  return list.filter(([, port]) => port !== null && port !== 0)
}

/** 端口上是否还有本环境的节点在听（认 executable 路径，避免误杀无关进程）。 */
function hiveOwnersOn(port, udp) {
  return portOwners(port, { udp }).filter((o) => /Hive|electron/i.test(cmdlineOf(o.pid)))
}

/**
 * `down`：**先 quit 后 kill**（docs/local-api.md 的硬要求）。
 * Windows 无 SIGTERM，`kill()` 走 TerminateProcess 时 `before-quit` 链不执行，
 * 对端要等 90s 才判离线；故必须先走 `POST /v1/lifecycle/quit` 并给 ≥3s 优雅窗口。
 *
 * 收尾判定按**端口是否真的空出来**，而不是「组长 pid 还在不在」：detached 组长退出后
 * 真正的 Electron 进程会被 reparent 到 launchd，按进程树找不到它（见 hive-proc.groupAlive）。
 */
export async function down(config, { verbose = true, graceMs = 3000 } = {}) {
  const log = verbose ? (line) => console.log(line) : () => {}
  const state = readState(config.dataRoot)
  const records = Object.entries(state.nodes ?? {})
  if (records.length === 0) {
    log('状态文件里没有节点记录（可能从未 up 过，或已 down 干净）')
    return { stopped: 0, leftover: [] }
  }

  const leftover = []
  let stopped = 0

  for (const [id, record] of records) {
    const node = config.nodes.find((n) => n.id === id) ?? {
      id,
      api: record.requestedApi ?? 0,
      udp: record.udp ?? null,
      tcp: record.tcp ?? null,
      cdp: null
    }
    const pid = record.pid
    const apiPort = apiPortOf(node, record)
    const wasUp = portsOfNode(node, record).some(([, port, udp]) => hiveOwnersOn(port, udp).length > 0)
    let quitAccepted = false

    if (apiPort && (wasUp || (typeof pid === 'number' && pidAlive(pid)))) {
      try {
        const res = await fetch(`http://127.0.0.1:${apiPort}/v1/lifecycle/quit`, {
          method: 'POST',
          signal: AbortSignal.timeout(3000)
        })
        quitAccepted = res.status === 202
        log(`  ↓ ${id} 已发优雅退出请求（pid ${pid ?? '?'}，api ${apiPort}）`)
      } catch {
        // health 都不可达的节点只能硬杀；这不是错误，是兜底。
        log(`  ! ${id} local-api 不可达，直接走进程组终止（pid ${pid ?? '?'}）`)
      }
    }

    // 先给优雅退出留窗口；到点还占着端口再整组 SIGTERM → SIGKILL。
    if (typeof pid === 'number') {
      const deadline = Date.now() + graceMs
      while (Date.now() < deadline) {
        const stillListening = portsOfNode(node, record).some(([, port, udp]) => hiveOwnersOn(port, udp).length > 0)
        if (!stillListening && !pidAlive(pid)) break
        await sleep(150)
      }
      killGroup(pid, 'SIGTERM')
      await sleep(300)
      killGroup(pid, 'SIGKILL')
      killTree(pid, 'SIGKILL')
    }

    // 端口兜底：组信号漏掉的兄弟进程（或组长已退出、pid 复用）在这里收掉。
    const stragglers = []
    for (const [kind, port, udp] of portsOfNode(node, record)) {
      for (const owner of hiveOwnersOn(port, udp)) {
        killTree(owner.pid, 'SIGKILL')
        stragglers.push(`${kind}=${port}(pid ${owner.pid})`)
      }
    }
    if (stragglers.length > 0) {
      await sleep(400)
      log(`  · ${id} 补收端口上的残留：${stragglers.join(', ')}`)
    }

    const stillHeld = portsOfNode(node, record).filter(([, port, udp]) => hiveOwnersOn(port, udp).length > 0)
    if (stillHeld.length > 0) {
      leftover.push(`${id}(${stillHeld.map(([k, p]) => `${k}=${p}`).join(',')})`)
    } else if (wasUp || quitAccepted || typeof pid === 'number') {
      stopped += 1
      log(`  ✓ ${id} 已退出且无残留`)
    } else {
      log(`  · ${id} 已不在（pid ${pid ?? '?'}）`)
    }
  }

  rmSync(statePath(config.dataRoot), { force: true })

  // 最后一轮兜底：配置里声明但状态文件没记到的节点（例如状态文件被删过）。
  const orphans = []
  for (const node of config.nodes) {
    if (state.nodes?.[node.id]) continue
    for (const [kind, port, udp] of portsOfNode(node, null)) {
      for (const owner of hiveOwnersOn(port, udp)) {
        killTree(owner.pid, 'SIGKILL')
        orphans.push(`${node.id}.${kind}=${port}(pid ${owner.pid})`)
      }
    }
  }
  if (orphans.length > 0) {
    await sleep(500)
    log(`  ✓ 清理状态文件外的孤儿节点：${orphans.join(', ')}`)
    for (const node of config.nodes) {
      for (const [kind, port, udp] of portsOfNode(node, null)) {
        if (hiveOwnersOn(port, udp).length > 0) leftover.push(`${node.id}.${kind}=${port}`)
      }
    }
  }

  if (leftover.length > 0) {
    throw new ConfigError(
      `down 后仍有残留：${leftover.join(', ')}`,
      '手动 `kill -9 <pid>` 兜底，并把该节点 id 与端口记下来回报（这是 launcher 的缺陷）'
    )
  }
  log(`\n已停止 ${stopped} 个节点，无残留。`)
  return { stopped, leftover }
}

// ---------- 状态 ----------

/**
 * `status`：节点、端口、进程**实际**状态。
 * 只报观测事实（进程是否活着、端口谁在听、health 怎么说），不做“应该怎样”的推断。
 */
export async function status(config, { verbose = true } = {}) {
  const log = verbose ? (line) => console.log(line) : () => {}
  const state = readState(config.dataRoot)
  const rows = []

  for (const node of config.nodes) {
    const record = state.nodes?.[node.id] ?? null
    const pid = record?.pid ?? null
    const alive = typeof pid === 'number' && pidAlive(pid)
    const udpOwners = udpBinders(node.udp)
    const tcpOwners = portOwners(node.tcp)
    const apiPort = apiPortOf(node, record)
    const probe = await probeReadiness(node, record, { expectNodeId: record?.nodeId ?? null })
    rows.push({ node, record, pid, alive, udpOwners, tcpOwners, apiPort, probe })
  }

  log(`配置：${config.configPath}`)
  log(`数据根：${config.dataRoot}`)
  log('')
  const pad = (s, n) => String(s).padEnd(n)
  log(`${pad('节点', 12)}${pad('角色', 9)}${pad('进程', 22)}${pad('端口 udp/tcp/api', 24)}状态`)

  let ready = 0
  for (const row of rows) {
    const { node, pid, alive, apiPort, probe, record } = row
    const proc = pid === null ? '未记录' : `${pid} ${alive ? '运行中' : '已退出'}`
    const ports = `${node.udp}/${node.tcp}/${apiPort ?? '?'}`
    const owner = row.udpOwners[0] ?? row.tcpOwners[0]
    // 「状态文件说它起着、实况说它没了」是最值得报警的一类：单看健康探测只会说「未运行」，
    // 运维者会以为是没 up 过。凡 up 过（有 record）就必须显式指出记录与实况不符，并给出处置。
    const lostWhileRecorded = !alive && !probe.ok && record !== null
    let stateText
    if (probe.ok) {
      stateText = `就绪（nodeId=${probe.view.nodeId} groups=${probe.view.groups} peers=${probe.view.peers}）`
      ready += 1
    } else if (lostWhileRecorded) {
      stateText = `异常：进程已不在（pid ${pid}），但状态文件仍记着它`
    } else if (!alive && row.udpOwners.length === 0 && row.tcpOwners.length === 0) {
      stateText = '未运行'
    } else {
      stateText = `异常：${probe.reason}`
      if (owner && owner.pid !== pid) stateText += `；端口被 pid ${owner.pid} 占用`
    }
    log(`${pad(node.id, 12)}${pad(node.gui ? 'GUI' : 'headless', 9)}${pad(proc, 22)}${pad(ports, 24)}${stateText}`)

    // 失联行的可操作线索：节点日志路径（第一手现场材料）+ 端口归属。
    if (lostWhileRecorded || (!probe.ok && alive)) {
      log(`${' '.repeat(12)}数据目录：${record.dataDir}（日志 node.log）`)
      if (!lostWhileRecorded) log(`${' '.repeat(12)}诊断：${probe.reason}`)
      if (owner && owner.pid !== pid) log(`${' '.repeat(12)}端口 ${ports} 被 pid ${owner.pid}（${owner.command}）占用`)
      log(`${' '.repeat(12)}处置：pnpm run hive -- down 后重新 up；反复失败看 node.log`)
    } else if (!probe.ok && !record) {
      log(`${' '.repeat(12)}处置：该节点未在状态文件中，先 pnpm run hive -- up`)
    }
  }

  log('')
  log(`${ready}/${rows.length} 就绪${ready === rows.length && rows.length > 0 ? '（全部正常）' : ''}`)
  return { rows, ready, total: rows.length }
}

// ---------- 体检 ----------

function nodeVersionOf(bin) {
  try {
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out.trim().replace(/^v/, '')
  } catch {
    return null
  }
}

function major(version) {
  const m = /^(\d+)/.exec(String(version ?? ''))
  return m ? Number(m[1]) : NaN
}

/**
 * `doctor`：检查 Node、端口、数据目录和基础节点配置，对故障给出**可操作**诊断。
 *
 * 每项结果形如 { name, ok, detail, hint }。CLI 层把 hint 打印成「→ 」一行。
 * 范围锚定 issue #48 的四项；SPEC #41 里更深的一层（ACP initialize、模型探活、
 * adapter 文件、时钟偏差）属 #49+ 的交付物，这里**不假装检查通过**——缺依赖时显式
 * 报「本轮范围外」，而不是给绿灯。
 */
export async function doctor(config, { verbose = true } = {}) {
  const log = verbose ? (line) => console.log(line) : () => {}
  const results = []
  const add = (name, ok, detail = '', hint = '') => {
    results.push({ name, ok, detail, hint })
    log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    if (!ok && hint) log(`      → ${hint}`)
  }

  // 1) runtime 版本
  const required = 22
  const nodeBin = process.execPath
  const v = nodeVersionOf(nodeBin)
  const vMajor = major(v)
  add(
    `Node 运行时 ≥ ${required}（当前 ${v ?? '未知'}）`,
    Number.isFinite(vMajor) && vMajor >= required,
    nodeBin,
    `用 nvm/fnm 装 Node ${required}+：\`nvm install ${required}\`；Hive 的 vendor 依赖与 e2e 都锚在这一档`
  )
  // 便携/备用 node 也报一下，现场常有多个 node。
  const altNode = nodeVersionOf('node')
  if (altNode && altNode !== v) {
    add(`PATH 上的 node 也满足 ≥ ${required}（${altNode}）`, major(altNode) >= required, 'which node', 'PATH 上的 node 版本偏低会让子进程（adapter/runner）行为与预期不符')
  }

  // 2) 可执行文件 / 构建产物
  try {
    const exe = resolveExecutable(config.appPath)
    const detail = `${exe.kind}：${exe.exe}`
    if (exe.kind === 'app') {
      let size = 0
      try {
        size = statSync(exe.exe).size
      } catch {
        /* 无权限读大小不影响可执行性 */
      }
      add(`app 可执行文件存在${size ? `（${size} 字节）` : ''}`, true, detail)
      // ad-hoc 签名状态：现场双击/`open` 起不来时第一条要查的就是它。
      try {
        execFileSync('codesign', ['-dv', '--verbose=2', config.appPath], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        })
        add('app 签名可读（codesign -dv）', true, 'ad-hoc 亦满足本地启动')
      } catch {
        add(
          'app 签名可读（codesign -dv）',
          false,
          'codesign 读取失败',
          `cd 到 app 的父目录跑：codesign --force --deep --sign - ${config.appPath.split('/').pop()}`
        )
      }
    } else {
      add('dev 构建产物存在（out/ + electron）', true, detail)
    }
  } catch (err) {
    add('可执行文件就位', false, err.message, err.hint ?? '检查 hive.config.json 的 app 或先 pnpm run build')
  }

  // 3) 数据目录可写
  for (const node of config.nodes) {
    let ok = true
    let detail = node.dataDir
    try {
      mkdirSync(node.dataDir, { recursive: true })
      const probe = join(node.dataDir, '.hive-write-probe')
      writeFileSync(probe, 'ok')
      rmSync(probe, { force: true })
      const st = statSync(node.dataDir)
      if (!st.isDirectory()) {
        ok = false
        detail = `${node.dataDir} 不是目录`
      }
    } catch (err) {
      ok = false
      detail = `${node.dataDir}：${err.message}`
    }
    add(
      `数据目录可写：${node.id}`,
      ok,
      detail,
      '检查路径权限；也可在 hive.config.json 里把 dataRoot 指到有写权限的位置'
    )
  }

  // 4) 节点配置自洽（端口冲突 / GUI 数 / id 唯一）
  const guis = config.nodes.filter((n) => n.gui)
  add(
    `配置至少有一个 GUI 节点（当前 ${guis.length}）`,
    guis.length >= 1,
    guis.map((n) => n.id).join(', ') || '无',
    '纯 headless 集群没有主窗；现场演示请把主节点标 "gui": true'
  )
  if (guis.length > 1) {
    log(`      · 提示：声明了 ${guis.length} 个 GUI 节点，本机会起 ${guis.length} 个主窗（不是错误，但确认是有意的）`)
  }

  // 5) 端口可用性：区分「我们的节点已在跑」与「被别人占了」。
  const state = readState(config.dataRoot)
  for (const node of config.nodes) {
    const record = state.nodes?.[node.id] ?? null
    for (const [kind, port] of [['udp', node.udp], ['tcp', node.tcp], ['cdp', node.cdp]]) {
      if (port === null || port === 0) continue
      const owners = portOwners(port, { udp: kind === 'udp' })
      if (owners.length === 0) {
        add(`端口可用：${node.id}.${kind}=${port}`, true, '空闲')
        continue
      }
      const own = record?.pid === owners[0].pid
      add(
        `端口可用：${node.id}.${kind}=${port}`,
        own,
        own ? `已被本环境节点 pid ${owners[0].pid} 占用（正常）` : `被 pid ${owners[0].pid}（${owners[0].command}）占用`,
        own ? '' : `先 \`pnpm run hive -- down\`；仍占用则 \`lsof -nP -iTCP:${port}\` 找占用者并处理`
      )
    }
  }

  // 6) 状态文件一致性：记录了 pid 但进程已不在 = 上一轮 down 不干净。
  const stale = []
  for (const node of config.nodes) {
    const record = state.nodes?.[node.id]
    if (record?.pid && !pidAlive(record.pid)) stale.push(`${node.id}(pid ${record.pid})`)
  }
  if (Object.keys(state.nodes ?? {}).length > 0) {
    add(
      '状态文件与进程实况一致',
      stale.length === 0,
      stale.length === 0 ? '记录中的进程都在' : `失联：${stale.join(', ')}`,
      '跑 `pnpm run hive -- down` 清掉陈旧记录与端口占用'
    )
  }

  // 7) 明确划出本 ticket 范围外的体检项，避免误读为「全绿 = 现场就绪」。
  log('')
  log('本轮范围外（属 #49+，这里不做假检查）：adapter 文件与 ACP initialize、模型探活、时钟偏差、局域网站点可达。')
  log(
    process.env.PANTRY_AGENT_COMMAND
      ? '  现状：已设 PANTRY_AGENT_COMMAND（Agent 链路可用）'
      : '  现状：未设 PANTRY_AGENT_COMMAND → 节点 agent=off，群内 @ 不会有真回复（机制演示可用 fake peer）'
  )

  const failed = results.filter((r) => !r.ok)
  log('')
  log(`${results.length - failed.length}/${results.length} 项通过`)
  return { results, failed }
}
