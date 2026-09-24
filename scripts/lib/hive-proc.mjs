// 本机进程 / 端口机械工具层（黑盒 rig 与本地运维 launcher 共用，#44 #45 #48）。
//
// 纪律：这一层只做「观察与终止本机进程」的机械动作，不含任何 Hive 业务语义，
// 也不做健康判定（那是调用方的事）。抽取的动因是 #45 的教训：复制这套逻辑会让两条
// rig 各自漂移；#48 的 up/down/status/doctor 需要同一套「进程树 + 端口归属」事实。
import { execFileSync } from 'node:child_process'

/** 直接子进程 pid 列表（macOS 上 Electron 主进程会 fork Helpers）。 */
export function childrenOf(pid) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
    return out
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([childPid, parentPid]) => parentPid === pid && childPid !== pid)
      .map(([childPid]) => childPid)
  } catch {
    return []
  }
}

/** 递归杀整棵进程树（含 Electron Helpers）。 */
export function killTree(pid, signal = 'SIGKILL') {
  for (const child of childrenOf(pid)) killTree(child, signal)
  try {
    process.kill(pid, signal)
  } catch {
    /* 已退出 */
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 存活的后代 pid（含自身）；用于「退出后无残留」判定。 */
export function aliveTree(pid, acc = []) {
  if (pidAlive(pid)) acc.push(pid)
  for (const child of childrenOf(pid)) aliveTree(child, acc)
  return acc
}

/**
 * 按进程组杀：`spawn(..., { detached: true })` 起的孩子自成组长（setsid），
 * 一次 `kill(-pid)` 覆盖整组，比逐个 ps 递归更不容易漏掉刚 fork 出来的孙子。
 */
export function killGroup(pid, signal = 'SIGKILL') {
  try {
    process.kill(-pid, signal)
  } catch {
    /* 组已不存在 */
  }
}

/**
 * 进程组是否还有成员活着。
 *
 * 为什么不能只看 `aliveTree(pid)`：`detached: true` 起的组长是 electron wrapper，
 * 它先退出后，真正的 Electron 主进程与 Helpers 会被 reparent 到 launchd —— 按 ppid
 * 递归就什么都找不到，于是「无残留」被误判为真，而端口其实还被占着。
 * 组 id 不随 reparent 改变，故这里按组判。
 */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

/** 进程命令行（用于识别「pid 复用」：pid 活着但不一定是我们的节点）。 */
export function cmdlineOf(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

function lsof(args) {
  try {
    const out = execFileSync('lsof', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return out
  } catch {
    return ''
  }
}

/** 只解析数据行（不要 header）。调用方负责先丢掉 lsof 的表头。 */
function parseLsofRows(rows) {
  const owners = []
  for (const line of rows) {
    if (!line.trim()) continue
    const cols = line.trim().split(/\s+/)
    if (cols.length < 3) continue
    const pid = Number(cols[1])
    if (!Number.isInteger(pid)) continue
    if (!owners.some((o) => o.pid === pid)) owners.push({ command: cols[0], pid })
  }
  return owners
}

function lsofRows(args) {
  const out = lsof(args)
  return out.split('\n').slice(1)
}

/** 某 TCP 端口上的 LISTEN 进程（可能多个：SO_REUSEPORT 少见但存在）。 */
export function tcpListeners(port) {
  return parseLsofRows(lsofRows(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']))
}

/**
 * 某 UDP 端口的本机绑定者。lsof 对 UDP 没有 LISTEN 状态，且会把「发往该端口的外向
 * socket」也列进来，故只认本地名形如 `*:17878` / `127.0.0.1:17878`（无 `->`）的条目。
 */
export function udpBinders(port) {
  return parseLsofRows(
    lsofRows(['-nP', `-iUDP:${port}`]).filter(
      (line) => line.includes(`:${port}`) && !line.includes('->')
    )
  )
}

/** 端口是否被占用（TCP LISTEN 或 UDP 绑定），返回占用者数组。 */
export function portOwners(port, { udp = false } = {}) {
  return udp ? udpBinders(port) : tcpListeners(port)
}

/**
 * 端口预检（rig 与 launcher 共用）：被占就立刻停。
 * 不预检的话，`waitHealth` 会读到上一个残留节点的 health 而假通过。
 */
export function assertPortsFree(ports) {
  const taken = []
  for (const port of ports) {
    const owners = tcpListeners(port)
    if (owners.length > 0) taken.push(`${port}(${owners[0].pid})`)
  }
  if (taken.length > 0) {
    throw new Error(`端口被占用，先清掉残留节点：${taken.join(', ')}`)
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
