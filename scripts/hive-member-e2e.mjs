#!/usr/bin/env node
// Hive #53 端到端 rig：三节点真拓扑下验「移出常驻成员 + 清理孤儿节点」。
//   node scripts/hive-member-e2e.mjs            # dev 构建产物（out/）
//   node scripts/hive-member-e2e.mjs --app X.app
//
// 拓扑（全真节点，无替身实现）：
//   A = GUI，群 owner（驱动真 renderer 的 window.pantry）
//   B = headless，**A 的成员**（登记 ownerId=A）→ AC2/AC3/AC5 的主角
//   C = GUI，**另一个人类节点**，群普通成员；D = C 的成员
//       → AC1/AC4：C 移 D 合法、A 移 D 被拒（D 不是 A 的成员）
//
// 覆盖：#53 AC1 非主人被拒且原因明确 / AC2 主人移出在线成员（离群+退出进程+成员表消失）/
//       AC3 节点整体死亡成孤儿后授权 admin 清理 / AC4 不误删他人或他群成员 /
//       AC5 GUI 观察结果 + 本脚本即自动化黑盒测试。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(REPO, 'vendor', 'teahouse')

const argv = process.argv.slice(2)
const appPathRaw = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null
const appPath = appPathRaw ? resolve(process.cwd(), appPathRaw) : null
const keep = argv.includes('--keep')

let failures = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 端口与数据目录（每节点全独立） ----------
const A = { udp: 28178, tcp: 28179, api: 28190, cdp: 29341 }
const B = { udp: 18178, tcp: 18179, api: 18190 }
const C = { udp: 38178, tcp: 38179, api: 38190, cdp: 29342 }
const D = { udp: 48178, tcp: 48179, api: 48190 }
const ALL_PORTS = [A, B, C, D].flatMap((n) => [n.udp, n.tcp, n.api, ...(n.cdp ? [n.cdp] : [])])

const root = mkdtempSync(join(tmpdir(), 'hive-member-e2e-'))
const dataDir = (name) => join(root, name)
console.log(`rig root: ${root}`)

/** 让「节点整体死亡」在可验收的时间内成立：三个 presence 时序参数同轴压缩（自然口径 90s）。 */
const FAST_TIMING = {
  PANTRY_OFFLINE_AFTER_MS: '4000',
  PANTRY_PRESENCE_INTERVAL_MS: '1000',
  PANTRY_SWEEP_INTERVAL_MS: '1000'
}

/** 预置身份：identity.json 的 nodeId 必须先于启动存在，登记表才能引用它。 */
function seedIdentity(name, nodeId) {
  mkdirSync(dataDir(name), { recursive: true })
  writeFileSync(
    join(dataDir(name), 'identity.json'),
    `${JSON.stringify({ nodeId, createdAt: Date.now() }, null, 2)}\n`
  )
}

/** 完整字段集 config.json；残缺会让 packaged 节点静默发现不到对端（#44 地雷）。 */
function seedGuiConfig(name, { nick, udp, tcp, autoLaunch = false }) {
  writeFileSync(
    join(dataDir(name), 'config.json'),
    `${JSON.stringify(
      {
        nick,
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
        udpPort: udp,
        tcpPort: tcp,
        hideOnCapture: true,
        autoLaunch,
        closeToTray: false,
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
      },
      null,
      2
    )}\n`
  )
}

/** 成员主人登记表：登记 = 谁拥有这个成员（生产侧写入属 #49/#51，本票只读）。 */
function seedRegistry(name, members) {
  mkdirSync(dataDir(name), { recursive: true })
  writeFileSync(
    join(dataDir(name), 'members.json'),
    `${JSON.stringify({ schemaVersion: 1, members }, null, 2)}\n`
  )
}

function assertPortsFree() {
  const taken = []
  for (const port of ALL_PORTS) {
    try {
      const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const owner = out.split('\n')[1]?.trim().split(/\s+/)[0]
      if (owner) taken.push(`${port}(${owner})`)
    } catch {
      /* lsof 无输出即空闲 */
    }
  }
  if (taken.length > 0) throw new Error(`端口被占用，先清掉残留节点：${taken.join(', ')}`)
}

// ---------- 进程 ----------
const children = []

function childrenOf(pid) {
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

function killTree(pid, signal = 'SIGKILL') {
  for (const child of childrenOf(pid)) killTree(child, signal)
  try {
    process.kill(pid, signal)
  } catch {
    /* 已退出 */
  }
}

function aliveTree(pid, acc = []) {
  if (pidAlive(pid)) acc.push(pid)
  for (const child of childrenOf(pid)) aliveTree(child, acc)
  return acc
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function launch({ label, exe, args, env }) {
  const child = spawn(exe, args, {
    cwd: VENDOR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.lines = []
  const capture = (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      child.lines.push(line)
      if (/\[headless\]|\[hive\]|\[local-api\]|error|Error/.test(line)) console.log(`  [${label}] ${line}`)
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  children.push(child)
  return child
}

async function teardown() {
  await Promise.all(
    children.map(async (child) => {
      try {
        if (child.hiveApiPort && pidAlive(child.pid)) {
          await fetch(`http://127.0.0.1:${child.hiveApiPort}/v1/lifecycle/quit`, {
            method: 'POST'
          }).catch(() => undefined)
          await Promise.race([child.exited, sleep(4000)])
        }
      } catch {
        /* 已经没了 */
      }
      killTree(child.pid)
    })
  )
  await sleep(300)
}

function launchTargets() {
  const exe = appPath
    ? join(appPath, 'Contents', 'MacOS', 'Hive')
    : join(VENDOR, 'node_modules', '.bin', 'electron')
  const baseArgs = appPath ? [] : ['.']
  if (!existsSync(exe)) throw new Error(`找不到可执行文件：${exe}（先跑 pnpm run build）`)
  return {
    exe,
    gui: (name, node, { nick, peers, cdp, registry, extra = {} }) => {
      const child = launch({
        label: name,
        exe,
        args: [...baseArgs, `--remote-debugging-port=${node.cdp}`],
        env: {
          PANTRY_USER_DATA: dataDir(name),
          PANTRY_UDP_PORT: String(node.udp),
          PANTRY_TCP_PORT: String(node.tcp),
          PANTRY_LOCAL_API_PORT: String(node.api),
          PANTRY_PEERS: peers.map((p) => `127.0.0.1:${p}`).join(','),
          PANTRY_MEMBER_REGISTRY: join(dataDir(name), 'members.json'),
          ...FAST_TIMING,
          ...extra
        }
      })
      void cdp
      void nick
      void registry
      child.hiveApiPort = node.api
      return child
    },
    headless: (name, node, { peers, registry, extra = {} }) => {
      const child = launch({
        label: name,
        exe,
        args: baseArgs,
        env: {
          PANTRY_HEADLESS: '1',
          PANTRY_USER_DATA: dataDir(name),
          PANTRY_UDP_PORT: String(node.udp),
          PANTRY_TCP_PORT: String(node.tcp),
          PANTRY_LOCAL_API_PORT: String(node.api),
          PANTRY_PEERS: peers.map((p) => `127.0.0.1:${p}`).join(','),
          ...(registry ? { PANTRY_MEMBER_REGISTRY: join(dataDir(name), 'members.json') } : {}),
          ...FAST_TIMING,
          ...extra
        }
      })
      child.hiveApiPort = node.api
      return child
    }
  }
}

// ---------- local-api ----------
async function health(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
  if (!res.ok) throw new Error(`health ${res.status}`)
  return res.json()
}

async function waitHealth(port, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      return await health(port)
    } catch (err) {
      last = String(err.message ?? err)
      await sleep(300)
    }
  }
  throw new Error(`${label} health 超时：${last}`)
}

async function openSse(port, label) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events`, {
    headers: { accept: 'text/event-stream' }
  })
  if (!res.ok) throw new Error(`${label} SSE ${res.status}`)
  const events = []
  const reader = res.body.getReader()
  ;(async () => {
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          try {
            events.push(JSON.parse(line.slice(6)))
          } catch {
            /* 非 JSON 帧忽略 */
          }
        }
      }
    } catch {
      /* 连接关闭即结束 */
    }
  })()
  return events
}

async function waitEvent(events, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = events.find(predicate)
    if (hit) return hit
    await sleep(150)
  }
  return null
}

// ---------- CDP：驱动真 GUI 的 renderer（走 window.pantry，不吃 DOM 选择器） ----------
async function cdpTarget(cdpPort) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://')
      )
      if (page) return page
    } catch {
      /* 未起来 */
    }
    await sleep(400)
  }
  throw new Error('CDP 没有可用的 page target')
}

async function cdpEvalOnce(target, expression, timeoutMs) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  let id = 0
  const pending = new Map()
  const failAll = (err) => {
    for (const entry of pending.values()) entry.reject(err)
    pending.clear()
  }
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    clearTimeout(entry.timer)
    entry.resolve(msg)
  })
  ws.addEventListener('close', () => failAll(new Error('CDP 连接关闭')))
  ws.addEventListener('error', () => failAll(new Error('CDP 连接错误')))

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const timer = setTimeout(() => {
        pending.delete(myId)
        reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
      pending.set(myId, { resolve, reject, timer })
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  try {
    const result = await call('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.error) throw new Error(`CDP Runtime.evaluate: ${result.error.message}`)
    if (result.result.exceptionDetails) {
      const text =
        result.result.exceptionDetails.exception?.description ??
        JSON.stringify(result.result.exceptionDetails)
      throw new Error(`renderer 求值抛错：${text}`)
    }
    return result.result.result.value
  } finally {
    ws.close()
  }
}

async function cdpEvaluate(cdpPort, expression, { timeoutMs = 30000, attempts = 6 } = {}) {
  let lastErr = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      const target = await cdpTarget(cdpPort)
      return await cdpEvalOnce(target, expression, timeoutMs)
    } catch (err) {
      lastErr = err
      const message = String(err?.message ?? err)
      const retryable =
        message.includes('Execution context was destroyed') ||
        message.includes('Cannot find context') ||
        message.includes('连接关闭') ||
        message.includes('连接错误') ||
        message.includes('超时')
      if (!retryable) throw err
      await sleep(700)
    }
  }
  throw lastErr
}

/** 等 discovery 把对端灌进 registry（互见不是起进程就成立）。 */
async function waitForPeer(cdpPort, nodeId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let seen = []
  while (Date.now() < deadline) {
    seen = await cdpEvaluate(
      cdpPort,
      `const peers = await window.pantry.getPeers();
       return peers.filter(p => p.online).map(p => p.nodeId);`
    )
    if (seen.includes(nodeId)) return seen
    await sleep(800)
  }
  return seen
}

/** 群成员表（经真 renderer 读，AC5 的 GUI 观察面）。 */
async function groupMembers(cdpPort, groupId) {
  return cdpEvaluate(
    cdpPort,
    `const g = await window.pantry.getGroup('${groupId}');
     return g ? g.members : null;`
  )
}

async function main() {
  assertPortsFree()

  // ---------- 预置身份与登记表（nodeId 必须先于启动定下来） ----------
  const ids = { a: 'hive-e2e-a', b: 'hive-e2e-b', c: 'hive-e2e-c', d: 'hive-e2e-d' }
  for (const [key, nodeId] of Object.entries(ids)) seedIdentity(key, nodeId)
  seedGuiConfig('a', { nick: 'Hive A', udp: A.udp, tcp: A.tcp })
  seedGuiConfig('c', { nick: 'Hive C', udp: C.udp, tcp: C.tcp })
  // 成员主人目录（成员级事实：每个成员恰有一个主人）。
  // A 的副本含自己的 B **和** C 的 D —— 这样「移出别人的成员」才能给出明确原因
  // （not_member_owner）而不是含混的「查无此人」；C 只需知道自己那一份。
  seedRegistry('a', [
    { memberId: ids.a, ownerId: ids.a, kind: 'resident' },
    { memberId: ids.b, ownerId: ids.a, kind: 'resident' },
    { memberId: ids.c, ownerId: ids.c, kind: 'resident' },
    { memberId: ids.d, ownerId: ids.c, kind: 'resident' }
  ])
  seedRegistry('c', [
    { memberId: ids.c, ownerId: ids.c, kind: 'resident' },
    { memberId: ids.d, ownerId: ids.c, kind: 'resident' }
  ])

  const target = launchTargets()
  console.log(`可执行文件：${target.exe}${appPath ? '（打包 .app）' : '（dev out/）'}`)

  const a = target.gui('a', A, { peers: [B.udp, C.udp], nick: 'Hive A' })
  // headless 节点就是一个成员进程：被移出即退出（AC2 的「退出进程」）
  const b = target.headless('b', B, { peers: [A.udp, C.udp] })
  target.gui('c', C, { peers: [A.udp, D.udp], nick: 'Hive C' })
  target.headless('d', D, { peers: [A.udp, C.udp] })

  const hA = await waitHealth(A.api, 'A')
  const hB = await waitHealth(B.api, 'B')
  const hC = await waitHealth(C.api, 'C')
  const hD = await waitHealth(D.api, 'D')
  check('四节点身份互不相同', new Set([hA.nodeId, hB.nodeId, hC.nodeId, hD.nodeId]).size === 4)
  check('预置身份生效（登记表引用的 nodeId 与实际一致）', hA.nodeId === ids.a && hB.nodeId === ids.b && hC.nodeId === ids.c && hD.nodeId === ids.d)
  check('A 载入成员登记表', a.lines.some((l) => l.includes('[hive] 成员登记表')), '')

  const aEvents = await openSse(A.api, 'A')

  // 互见：A 要看见 B 与 C；C 要看见 D 与 A
  const aSeen = await waitForPeer(A.cdp, ids.b)
  check('A 与 B 互见', aSeen.includes(ids.b), JSON.stringify(aSeen))
  const aSeenC = await waitForPeer(A.cdp, ids.c)
  check('A 与 C 互见', aSeenC.includes(ids.c), JSON.stringify(aSeenC))
  const cSeen = await waitForPeer(C.cdp, ids.d)
  check('C 与 D 互见', cSeen.includes(ids.d), JSON.stringify(cSeen))

  // ---------- 建群：A 建群（owner=A），成员 = A/B/C/D ----------
  const groupId = await cdpEvaluate(
    A.cdp,
    `const s = await window.pantry.saveProfile({ nick: 'Hive A', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
     if (!s.setupDone) throw new Error('setupDone 未置位');
     const g = await window.pantry.createGroup('hive-member-e2e', ['${ids.b}', '${ids.c}', '${ids.d}']);
     if (!g) throw new Error('createGroup 返回 null');
     return g.groupId;`
  )
  check('建群成功（A 为群主）', typeof groupId === 'string' && groupId.length > 0, groupId)
  // C 侧要拿到同一份群元数据（否则 C 在群里但不知道）
  await cdpEvaluate(C.cdp, `await window.pantry.getGroup('${groupId}'); return true;`)
  await sleep(1500)
  const members0 = await groupMembers(A.cdp, groupId)
  check('群初始成员 4 人', members0?.length === 4, JSON.stringify(members0))

  // ---------- AC1：非主人移出被拒，且原因明确 ----------
  const denied = await cdpEvaluate(
    A.cdp,
    `const r = await window.pantry.updateGroup('${groupId}', { kind: 'remove', memberIds: ['${ids.d}'] });
     return r;`
  )
  check(
    'AC1 A 移出 D（D 的主人是 C）被拒绝',
    denied && denied.hiveDenied === true && denied.code === 'not_member_owner',
    JSON.stringify(denied)
  )
  check(
    'AC1 拒绝带明确原因',
    typeof denied?.reason === 'string' && denied.reason.includes('主人'),
    String(denied?.reason)
  )
  const stillThere = await groupMembers(A.cdp, groupId)
  check('AC1 被拒后成员表未变（D 仍在）', stillThere?.includes(ids.d) === true, JSON.stringify(stillThere))

  // 拒绝留痕
  const auditLines = a.lines.filter((l) => l.includes('[hive]'))
  void auditLines

  // ---------- AC4：C 移出自己的成员 D 合法（不误伤他人管理的成员） ----------
  // 双层判定里的第二层：C 是本群成员但非群主 → 需 A 授予群管理员（沿用 ADR-0006「建群 set-admin」）。
  const promoted = await cdpEvaluate(
    A.cdp,
    `const r = await window.pantry.updateGroup('${groupId}', { kind: 'set-admin', memberId: '${ids.c}', enabled: true });
     return r && r.adminIds ? r.adminIds : r;`
  )
  check('AC4 A 授予 C 群管理员（底座群管理权）', Array.isArray(promoted) && promoted.includes(ids.c), JSON.stringify(promoted))

  const cRemoved = await cdpEvaluate(
    C.cdp,
    `const r = await window.pantry.updateGroup('${groupId}', { kind: 'remove', memberIds: ['${ids.d}'] });
     return r && r.groupId ? { groupId: r.groupId, members: r.members } : r;`
  )
  check(
    'AC4 C 移出自己的成员 D 成功',
    cRemoved && cRemoved.groupId === groupId && !cRemoved.members.includes(ids.d),
    JSON.stringify(cRemoved)
  )
  await sleep(1200)
  const afterD = await groupMembers(A.cdp, groupId)
  check(
    'AC4 只删了 D，B/C/A 未被误删',
    afterD?.length === 3 && afterD.includes(ids.a) && afterD.includes(ids.b) && afterD.includes(ids.c),
    JSON.stringify(afterD)
  )

  // ---------- AC2：主人移出在线成员 → 离群 + 退出进程 + 成员表消失 ----------
  check('AC2 移出前 B 在线', (await health(B.api, 'B')).nodeId === ids.b)
  const bExit = await (async () => {
    const res = await cdpEvaluate(
      A.cdp,
      `const r = await window.pantry.updateGroup('${groupId}', { kind: 'remove', memberIds: ['${ids.b}'] });
       return r && r.groupId ? { groupId: r.groupId, members: r.members } : r;`
    )
    return res
  })()
  check(
    'AC2 A 移出自己的成员 B 成功',
    bExit && bExit.groupId === groupId && !bExit.members.includes(ids.b),
    JSON.stringify(bExit)
  )
  const bGone = await Promise.race([b.exited.then(() => true), sleep(12000).then(() => false)])
  check('AC2 被移出的 B 节点自行退出进程', bGone === true, `alive=${aliveTree(b.pid).length}`)
  await sleep(500)
  check('AC2 B 退出后无残留进程（含 Helpers）', aliveTree(b.pid).length === 0, JSON.stringify(aliveTree(b.pid)))
  const afterB = await groupMembers(A.cdp, groupId)
  check('AC2 成员表里 B 已消失', afterB?.includes(ids.b) === false, JSON.stringify(afterB))

  // 生命周期事件（冻结表 member.lifecycle / phase=leave）
  const leaveEvent = await waitEvent(
    aEvents,
    (e) => e.type === 'member.lifecycle' && e.data.memberId === ids.b && e.data.phase === 'leave'
  )
  check('AC5 SSE 广播 member.lifecycle phase=leave', Boolean(leaveEvent), leaveEvent ? JSON.stringify(leaveEvent.data) : '未收到')

  // ---------- AC3：节点整体死亡 → 孤儿 → 授权 admin 清理 ----------
  // 新起节点 E 并把它登记为 **A 的成员**（写入 A 的登记表；判权前会热重读，无需重启），
  // 拉进群后 SIGKILL 整棵树 = 节点整体死亡，再由群主 A 清理该孤儿（AC3）。
  const E = { udp: 58178, tcp: 58179, api: 58190 }
  ALL_PORTS.push(E.udp, E.tcp, E.api)
  seedIdentity('e', 'hive-e2e-e')
  const e = target.headless('e', E, { peers: [A.udp] })
  const hE = await waitHealth(E.api, 'E')
  check('E 节点起来了（孤儿制造前置）', hE.nodeId === 'hive-e2e-e')
  seedRegistry('a', [
    { memberId: ids.b, ownerId: ids.a, kind: 'resident' },
    { memberId: hE.nodeId, ownerId: ids.a, kind: 'resident' }
  ])
  await cdpEvaluate(
    A.cdp,
    `const g = await window.pantry.updateGroup('${groupId}', { kind: 'invite', memberIds: ['${hE.nodeId}'] });
     return g ? g.members.length : null;`
  )
  await sleep(800)
  const withE = await groupMembers(A.cdp, groupId)
  check('E 已进群且登记为 A 的成员', withE?.includes(hE.nodeId) === true, JSON.stringify(withE))

  // 节点整体死亡（SIGKILL 整棵树，不是优雅退出）
  killTree(e.pid, 'SIGKILL')
  await sleep(300)
  check('AC3 E 已被 SIGKILL（节点整体死亡）', aliveTree(e.pid).length === 0)
  const offlineDeadline = Date.now() + 25000
  let eOffline = false
  while (Date.now() < offlineDeadline) {
    const online = await cdpEvaluate(
      A.cdp,
      `const peers = await window.pantry.getPeers();
       const hit = peers.find(p => p.nodeId === '${hE.nodeId}');
       return hit ? hit.online : null;`
    )
    if (online === false) {
      eOffline = true
      break
    }
    await sleep(700)
  }
  check('AC3 A 判定 E 离线（孤儿成立）', eOffline, '')

  const a2Events = await openSse(A.api, 'A#2')
  const orphan = await cdpEvaluate(
    A.cdp,
    `const r = await window.pantry.updateGroup('${groupId}', { kind: 'remove', memberIds: ['${hE.nodeId}'] });
     return r && r.groupId ? { groupId: r.groupId, members: r.members } : r;`
  )
  check(
    'AC3 授权 admin（群主 A）清理孤儿 E 成功',
    orphan && orphan.groupId === groupId && !orphan.members.includes(hE.nodeId),
    JSON.stringify(orphan)
  )
  const orphanEvent = await waitEvent(
    a2Events,
    (ev) => ev.type === 'member.lifecycle' && ev.data.memberId === hE.nodeId && ev.data.phase === 'orphan_removed'
  )
  check(
    'AC5 SSE 广播 member.lifecycle phase=orphan_removed',
    Boolean(orphanEvent),
    orphanEvent ? JSON.stringify(orphanEvent.data) : '未收到'
  )

  // ---------- AC4 续：孤儿清理不误删其他群/其他主人的成员 ----------
  const finalMembers = await groupMembers(A.cdp, groupId)
  check(
    'AC4 全部操作后群成员恰为 A/C 两人',
    finalMembers?.length === 2 && finalMembers.includes(ids.a) && finalMembers.includes(ids.c),
    JSON.stringify(finalMembers)
  )

  await fetch(`http://127.0.0.1:${A.api}/v1/lifecycle/quit`, { method: 'POST' }).catch(() => undefined)
  await fetch(`http://127.0.0.1:${C.api}/v1/lifecycle/quit`, { method: 'POST' }).catch(() => undefined)
  await sleep(2000)
  await teardown()

  console.log(`\n${failures === 0 ? 'E2E OK' : `E2E FAILED — ${failures} 项`}（${results.length} 项断言）`)
  if (!keep) rmSync(root, { recursive: true, force: true })
  else console.log(`数据目录保留在 ${root}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(`\nE2E ERROR: ${err?.stack ?? err}`)
  await teardown().catch(() => undefined)
  if (!keep) rmSync(root, { recursive: true, force: true })
  process.exit(1)
})
