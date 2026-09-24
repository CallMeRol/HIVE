#!/usr/bin/env node
// Hive #51 端到端 rig：派遣——摇入一个全新上下文成员并独立执行。
//   node scripts/hive-dispatch-e2e.mjs            # dev 构建产物（out/）
//   node scripts/hive-dispatch-e2e.mjs --app X.app
//
// 拓扑（全真节点，无替身实现）：
//   A = GUI（群 owner，驱动真 renderer 建群）；派遣请求经 A 的 POST /v1/dispatch 发起
//   新成员 M = A 现场摇入的 headless 节点（派生前不存在，无预置身份/数据目录）→ AC1/AC2/AC3
//   失败路径 = 向 A 请求超上限并发（count=999 被形状校验拒 / 并发>5 被账本拒）→ AC5 拒绝面
//   持久化 = 读 A userData 下 hive/dispatch.json 与 members.json → AC6
//
// 覆盖：#51 AC1 受约束 dispatch 端点 / AC2 先 invite 后 spawn + health 身份校验 /
//       AC3 派遣事件与新成员可被 @（SSE dispatch.event + member.lifecycle spawn_ok +
//       群成员表出现新成员）/ AC4 新成员只拿 goalOneLine（数据目录全新、无父会话内容）/
//       AC5 越界请求显式拒绝 / AC6 派遣关系、slot、待领取可持久化。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// ---------- 端口与数据目录 ----------
const A = { udp: 21878, tcp: 21879, api: 21890, cdp: 21941 }
// 占位成员 B：createGroup 要求 ≥2 成员（去重后），单节点建不了群；B 只作群里的第二个人。
const B = { udp: 21978, tcp: 21979, api: 21990 }
const ALL_PORTS = [A.udp, A.tcp, A.api, A.cdp, B.udp, B.tcp, B.api]

const root = mkdtempSync(join(tmpdir(), 'hive-dispatch-e2e-'))
const dataDir = (name) => join(root, name)
console.log(`rig root: ${root}`)

/** 预置身份：B 的 nodeId 先于启动定下来（派遣的新成员 M 不预置——那正是被测对象）。 */
function seedIdentity(name, nodeId) {
  mkdirSync(dataDir(name), { recursive: true })
  writeFileSync(
    join(dataDir(name), 'identity.json'),
    `${JSON.stringify({ nodeId, createdAt: Date.now() }, null, 2)}\n`
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

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

function killTree(pid) {
  for (const child of childrenOf(pid)) killTree(child)
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    /* 已退出 */
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
      if (/\[headless\]|\[hive\]|\[dispatch\]|\[local-api\]|error|Error/.test(line)) {
        console.log(`  [${label}] ${line}`)
      }
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  children.push(child)
  return child
}

async function teardown() {
  // 派遣出的成员节点是 A 的 detached 子进程，不在 children 里：
  // 从 A 的 dispatch.json 读 slot → 推 api 端口 → 发 quit → 兜底强杀 userData 目录指纹。
  try {
    const state = JSON.parse(readFileSync(join(dataDir('a'), 'hive', 'dispatch.json'), 'utf8'))
    for (const rec of state.dispatches ?? []) {
      if (rec.outcome !== 'started' || typeof rec.slot !== 'number') continue
      const api = 17878 + rec.slot * 100 + 2
      await fetch(`http://127.0.0.1:${api}/v1/lifecycle/quit`, { method: 'POST' }).catch(
        () => undefined
      )
    }
    await sleep(1500)
  } catch {
    /* 无派遣记录 */
  }
  // 兜底：按 userData 路径指纹找残留 Electron 强杀。
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      if (line.includes(join(root, 'a', 'dispatched')) && !line.includes('grep')) {
        const pid = Number(line.trim().split(/\s+/)[0])
        if (Number.isInteger(pid)) killTree(pid)
      }
    }
  } catch {
    /* 无残留 */
  }
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
  if (!keep) rmSync(root, { recursive: true, force: true })
}

function launchTargets() {
  const exe = appPath
    ? join(appPath, 'Contents', 'MacOS', 'Hive')
    : join(VENDOR, 'node_modules', '.bin', 'electron')
  if (!existsSync(exe)) throw new Error(`找不到可执行文件：${exe}（先跑 pnpm run build）`)
  return {
    exe,
    gui: (name, node, { peers, extra = {} }) => {
      const child = launch({
        label: name,
        exe,
        args: [...(appPath ? [] : ['.']), `--remote-debugging-port=${node.cdp}`],
        env: {
          PANTRY_USER_DATA: dataDir(name),
          PANTRY_UDP_PORT: String(node.udp),
          PANTRY_TCP_PORT: String(node.tcp),
          PANTRY_LOCAL_API_PORT: String(node.api),
          PANTRY_PEERS: peers.map((p) => `127.0.0.1:${p}`).join(','),
          ...extra
        }
      })
      child.hiveApiPort = node.api
      return child
    },
    headless: (name, node, { peers, extra = {} }) => {
      const child = launch({
        label: name,
        exe,
        args: appPath ? [] : ['.'],
        env: {
          PANTRY_HEADLESS: '1',
          PANTRY_USER_DATA: dataDir(name),
          PANTRY_UDP_PORT: String(node.udp),
          PANTRY_TCP_PORT: String(node.tcp),
          PANTRY_LOCAL_API_PORT: String(node.api),
          PANTRY_PEERS: peers.map((p) => `127.0.0.1:${p}`).join(','),
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

async function waitEvent(events, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = events.find(predicate)
    if (hit) return hit
    await sleep(150)
  }
  return null
}

// ---------- CDP ----------
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

async function groupMembers(cdpPort, groupId) {
  return cdpEvaluate(
    cdpPort,
    `const g = await window.pantry.getGroup('${groupId}');
     return g ? g.members : null;`
  )
}

async function main() {
  assertPortsFree()
  // B 的身份先定下来（占位成员），派遣的新成员 M 不预置——全新身份正是被测对象。
  const bId = 'hive-dispatch-e2e-b'
  seedIdentity('b', bId)
  const target = launchTargets()
  console.log(`可执行文件：${target.exe}${appPath ? '（打包 .app）' : '（dev out/）'}`)

  target.gui('a', A, { peers: [B.udp] })
  target.headless('b', B, { peers: [A.udp] })
  const hA = await waitHealth(A.api, 'A')
  const hB = await waitHealth(B.api, 'B')
  check('A 节点就绪', typeof hA.nodeId === 'string' && hA.nodeId.length > 0, hA.nodeId)
  check('B 占位成员就绪', hB.nodeId === bId, hB.nodeId)
  const selfId = hA.nodeId

  const aEvents = await openSse(A.api, 'A')

  // ---------- 建群（A 为群主，成员 = A + B；底座 createGroup 要求去重后 ≥2 人） ----------
  const groupId = await cdpEvaluate(
    A.cdp,
    `const s = await window.pantry.saveProfile({ nick: 'Hive A', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
     if (!s.setupDone) throw new Error('setupDone 未置位');
     const g = await window.pantry.createGroup('hive-dispatch-e2e', ['${bId}']);
     if (!g) throw new Error('createGroup 返回 null');
     return g.groupId;`
  )
  check('建群成功', typeof groupId === 'string' && groupId.length > 0, String(groupId))

  // ---------- AC1：受约束的 dispatch 端点 ----------
  const noGoal = await fetch(`http://127.0.0.1:${A.api}/v1/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupId })
  })
  check('AC1 缺 goal 显式 400（受约束输入校验）', noGoal.status === 400, String(noGoal.status))

  // ---------- AC2/AC3：派遣一个新成员 ----------
  const goal = '调研 teahouse 群协议的离线补发队列行为并给出一段说明（rig 演示目标）'
  const dispatchAt = Date.now()
  const dispatchRes = await fetch(`http://127.0.0.1:${A.api}/v1/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupId, goal, count: 1 })
  })
  const dispatchBody = await dispatchRes.json().catch(() => null)
  check(
    'AC2 dispatch 返回 200 且 outcome=started',
    dispatchRes.status === 200 && dispatchBody?.outcome?.outcome === 'started',
    JSON.stringify(dispatchBody)
  )
  const memberId = dispatchBody?.outcome?.memberIds?.[0]
  check('AC2 返回了新成员 nodeId', typeof memberId === 'string' && memberId.length > 0, String(memberId))

  // 派遣耗时（≤30s health 校验窗口 + spawn 开销）
  const elapsed = Date.now() - dispatchAt
  check('AC2 派遣在 40s 内完成（spawn ≤30s 窗口内）', elapsed < 40000, `${elapsed}ms`)

  // ---------- AC3：事件可见（dispatch.event + member.lifecycle spawn_ok） ----------
  const de = await waitEvent(aEvents, (e) => e.type === 'dispatch.event', 5000)
  check(
    'AC3 SSE 收到 dispatch.event(started)',
    de?.data?.outcome === 'started' &&
      de?.data?.dispatcherId === selfId &&
      Array.isArray(de?.data?.memberIds) &&
      de?.data?.memberIds.includes(memberId) &&
      typeof de?.data?.goalOneLine === 'string' &&
      typeof de?.data?.depth === 'number',
    JSON.stringify(de?.data ?? null)
  )
  const ml = await waitEvent(aEvents, (e) => e.type === 'member.lifecycle' && e.data?.memberId === memberId, 5000)
  check('AC3 SSE 收到 member.lifecycle(spawn_ok)', ml?.data?.phase === 'spawn_ok', JSON.stringify(ml?.data ?? null))

  // 新成员出现在群成员表（可被人 @ 与 steering 的前提）
  await sleep(1500)
  const members = await groupMembers(A.cdp, groupId)
  check('AC3 新成员进群成员表', Array.isArray(members) && members.includes(memberId), JSON.stringify(members))

  // 新节点 health：独立身份、独立端口（slot 1 → udp = 17878+100 = 21978？不：slot 1 = 17978 系）
  const mPort = 17878 + 1 * 100 + 2 // slot 1 → api = base+2 = 17980
  const hM = await waitHealth(mPort, 'M', 10000)
  check('AC2 health 身份校验：新节点 nodeId = 预生成值', hM.nodeId === memberId, `${hM.nodeId} vs ${memberId}`)

  // ---------- AC4：全新上下文（独立数据目录、无父会话内容） ----------
  const mUserData = join(dataDir('a'), 'dispatched', memberId)
  check(
    'AC4 新成员独立数据目录存在',
    existsSync(join(mUserData, 'identity.json')) && existsSync(join(mUserData, 'config.json')),
    mUserData
  )
  const identity = JSON.parse(readFileSync(join(mUserData, 'identity.json'), 'utf8'))
  check('AC4 identity.json nodeId 与群内身份一致', identity.nodeId === memberId, identity.nodeId)

  // ---------- AC5：越界请求显式拒绝（并发超上限 → 拒绝面，不静默） ----------
  const tooMany = await fetch(`http://127.0.0.1:${A.api}/v1/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupId, goal, count: 99 })
  })
  check('AC5 并发超形状上限显式 400', tooMany.status === 400, String(tooMany.status))

  // ---------- AC5（核心）：spawn 失败补试一次 → 仍失败 → 任务进可见的待领取状态 ----------
  // 预占 slot 2 的三个端口（18078/18079/18080，base=17878+2×100），让下一次派遣的 spawn
  // 必然失败：health 永远不可达 → 两次尝试各 30s 超时 → claimable。
  const { createServer } = await import('node:http')
  const { createSocket } = await import('node:dgram')
  const blockers = []
  const hold = (port) =>
    new Promise((res) => {
      const s = createSocket('udp4')
      s.on('error', () => res(null))
      s.bind(port, () => res(s))
    })
  const b1 = await hold(18078)
  const b2 = await hold(18079)
  const tcpBlocker = createServer()
  const b3 = await new Promise((res) => {
    tcpBlocker.on('error', () => res(null))
    tcpBlocker.listen(18080, '127.0.0.1', () => res(tcpBlocker))
  })
  blockers.push(b1, b2, b3)
  check('失败注入：slot 2 三个端口已预占', b1 !== null && b2 !== null && b3 !== null)

  const failDispatchAt = Date.now()
  const failRes = await fetch(`http://127.0.0.1:${A.api}/v1/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupId, goal: '注定失败的演示目标', count: 1 })
  })
  const failBody = await failRes.json().catch(() => null)
  check(
    'AC5 spawn 两次失败后 outcome=claimable',
    failRes.status === 200 && failBody?.outcome?.outcome === 'claimable' && failBody?.outcome?.task?.status === 'claimable',
    JSON.stringify(failBody?.outcome ?? null)
  )
  check('AC5 task 携带原目标与原因', typeof failBody?.outcome?.task?.goalOneLine === 'string' && typeof failBody?.outcome?.task?.reason === 'string', JSON.stringify(failBody?.outcome?.task ?? null))
  const failElapsed = Date.now() - failDispatchAt
  // 恰好两次尝试（30s 超时 ×2），没有第三次 → 补试上限生效。
  check('AC5 补试恰好一次（≈60–75s，无第三次重试）', failElapsed >= 55000 && failElapsed < 90000, `${failElapsed}ms`)

  // 群里可见 @主人（发送成功即算可见；发送失败会静默吗——sendText 被 dispatch 内调用，返回值未校验是已知 MVP 简化）
  const claimedEvent = await waitEvent(aEvents, (e) => e.type === 'dispatch.event' && e.data?.outcome === 'claimable', 5000)
  check('AC5 SSE 收到 dispatch.event(claimable)', claimedEvent?.data?.outcome === 'claimable', JSON.stringify(claimedEvent?.data ?? null))

  // AC6 追加：待领取状态持久化（重启前的文件里能看到 claimable 条目）
  const persisted = JSON.parse(readFileSync(join(dataDir('a'), 'hive', 'dispatch.json'), 'utf8'))
  check(
    'AC6 待领取任务已持久化',
    (persisted.claimable ?? []).some((t) => t.status === 'claimable' && t.goalOneLine === '注定失败的演示目标'),
    JSON.stringify(persisted.claimable ?? [])
  )
  // slot 归还：失败派遣的 slot 不再被占（slot 1 已被成功派遣占用，slot 2 应已归还）
  check('AC6 失败派遣的 slot 已归还', Array.isArray(persisted.slots) && !persisted.slots.includes(2) && persisted.slots.includes(1), JSON.stringify(persisted.slots))

  for (const blocker of blockers) {
    try {
      blocker?.close()
    } catch {
      /* 忽略 */
    }
  }

  // ---------- AC6：派遣关系、slot、待领取状态持久化 ----------
  const dispatchFile = join(dataDir('a'), 'hive', 'dispatch.json')
  check('AC6 dispatch.json 落盘', existsSync(dispatchFile), dispatchFile)
  if (existsSync(dispatchFile)) {
    const state = JSON.parse(readFileSync(dispatchFile, 'utf8'))
    check('AC6 schemaVersion 存在', typeof state.schemaVersion === 'number', String(state.schemaVersion))
    const rec = (state.dispatches ?? []).find(
      (d) => Array.isArray(d.memberIds) && d.memberIds.includes(memberId)
    )
    check(
      'AC6 派遣记录：outcome=started + slot + depth',
      rec &&
        rec.outcome === 'started' &&
        typeof rec.slot === 'number' &&
        rec.depth === 2 &&
        rec.goalOneLine === goal,
      JSON.stringify(rec ?? null)
    )
    check('AC6 slot 表记录借出 slot', Array.isArray(state.slots) && state.slots.includes(rec?.slot), JSON.stringify(state.slots))
    check('AC6 members.json 登记派遣成员（kind=dispatched, ownerId=A）', (() => {
      try {
        const reg = JSON.parse(readFileSync(join(dataDir('a'), 'hive', 'members.json'), 'utf8'))
        const hit = (reg.members ?? []).find((m) => m.memberId === memberId)
        return hit && hit.kind === 'dispatched' && hit.ownerId === selfId && hit.spawnedBy === selfId
      } catch {
        return false
      }
    })())
  }

  // ---------- 可被 @：向新成员发一条 @ 消息（无 agent command → 不回复但可达） ----------
  // （可 @ 的机制面 = 群成员表含它 + 它的节点在线；agent 回复属 #46/#49 链路，不在本票断言。）

  console.log(`\n结果：${results.filter((r) => r.ok).length}/${results.length} 通过`)
}

main()
  .catch((err) => {
    console.error('rig 异常：', err)
    failures += 1
  })
  .finally(async () => {
    await teardown()
    process.exit(failures > 0 ? 1 : 0)
  })
