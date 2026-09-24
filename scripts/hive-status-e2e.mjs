#!/usr/bin/env node
// Hive #47 端到端 rig：真两节点上的跨机 agent 状态通道黑盒验收。
//   node scripts/hive-status-e2e.mjs
//
// 覆盖 #47 五条 AC：
//   AC1 静态 peers 下多节点互见 + 定向 agent-status 到达
//   AC2 按 10s 节拍上报，停止上报 30s 后过期（stale → idle）
//   AC3 非法 / 超限 / 乱序状态被丢弃，且不污染 presence
//   AC4 成员行显示五档；空闲 / 离线 / 回收保持不同状态轴
//   AC5 确定性状态生产器独立完成黑盒验证（不依赖任何 agent/LLM）
//
// 为什么是「GUI + headless」而不是两个 headless：成员行五档是 renderer 面的证据，
// 只有真 renderer 才有无可替代的观测点（CDP 读 window.pantry.getPeers()）。
// 纯 Node 22（global fetch + WebSocket），零新依赖。判据 = 退出码 0/非 0。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(REPO, 'vendor', 'teahouse')
const keep = process.argv.includes('--keep')

let failures = 0
let total = 0
function check(name, ok, detail = '') {
  total += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const GUI = { udp: 28878, tcp: 28879, api: 28890, cdp: 29334 }
const HEAD = { udp: 18878, tcp: 18879, api: 18890 }
const root = mkdtempSync(join(tmpdir(), 'hive-status-e2e-'))
const guiData = join(root, 'gui')
const headData = join(root, 'head')
console.log(`rig root: ${root}`)

const children = []

function childrenOf(pid) {
  try {
    return execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([c, p]) => p === pid && c !== pid).map(([c]) => c)
  } catch {
    return []
  }
}
function killTree(pid) {
  for (const child of childrenOf(pid)) killTree(child)
  try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
}
function aliveTree(pid) {
  if (!pidAlive(pid)) return []
  return [pid, ...childrenOf(pid).flatMap((c) => aliveTree(c))]
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function launch(label, args, env) {
  const exe = join(VENDOR, 'node_modules', '.bin', 'electron')
  const child = spawn(exe, args, { cwd: VENDOR, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.label = label
  child.lines = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const capture = (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      child.lines.push(line)
      if (/\[headless\]|\[agent-status\]|error|Error/.test(line)) console.log(`  [${label}] ${line}`)
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  children.push(child)
  return child
}

// packaged 版会真写登录项；预置完整 config 关掉它。
// 残缺 config.json 会静默杀死发现（#44 已确认的 landmine）——字段必须写全。
function seedConfig(dir, nick, ports) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({
    nick, company: '', dept: '', team: '', avatar: -1, avatarHash: '',
    profileRev: 1, setupDone: false, fileDir: '', notifications: true, manualPeers: [],
    scanRanges: [], scanRangeSources: {}, ignoredScanRanges: {},
    udpPort: ports.udp, tcpPort: ports.tcp, hideOnCapture: true, autoLaunch: false,
    closeToTray: false, language: 'zh-CN', theme: 'light', fontScale: 100,
    showMessagePreview: true, allowDirectFileSend: true, fileCabinet: { root: '', mode: 'off' },
    sound: 'none', sendKey: 'enter', captureShortcut: 'CommandOrControl+Alt+A',
    showHideShortcut: 'CommandOrControl+Alt+P'
  }, null, 2)}\n`)
}

async function health(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/health`)
  if (!res.ok) throw new Error(`health ${res.status}`)
  return res.json()
}
async function waitHealth(port, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try { return await health(port) } catch (err) { last = String(err.message ?? err); await sleep(300) }
  }
  throw new Error(`${label} health 超时：${last}`)
}

async function openSse(port, label) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/events`, { headers: { accept: 'text/event-stream' } })
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
          try { events.push(JSON.parse(line.slice(6))) } catch { /* 非 JSON 帧 */ }
        }
      }
    } catch { /* 连接关闭 */ }
  })()
  return events
}

/** 轮询直到 cond 返回 {ok:true}；超时返回最后一次结果并带 timedOut。 */
async function waitFor(cond, timeoutMs, what, stepMs = 500) {
  const deadline = Date.now() + timeoutMs
  let last = {}
  while (Date.now() < deadline) {
    last = await cond()
    if (last?.ok) return last
    await sleep(stepMs)
  }
  return { ...last, timedOut: true, what }
}

// ---------- CDP：读真 renderer 的窗口面 ----------
async function cdpTarget(cdpPort) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'))
      if (page) return page
    } catch { /* 未起来 */ }
    await sleep(400)
  }
  throw new Error('CDP 没有可用的 page target')
}

async function cdpEvalOnce(target, expression, timeoutMs = 30000) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  let id = 0
  const pending = new Map()
  const failAll = (err) => { for (const e of pending.values()) e.reject(err); pending.clear() }
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
  const call = (method, params) => new Promise((resolve2, reject) => {
    const myId = ++id
    const timer = setTimeout(() => { pending.delete(myId); reject(new Error(`CDP ${method} 超时`)) }, timeoutMs)
    pending.set(myId, { resolve: resolve2, reject, timer })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  try {
    const result = await call('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true
    })
    if (result.error) throw new Error(`CDP Runtime.evaluate: ${result.error.message}`)
    if (result.result.exceptionDetails) {
      throw new Error(`renderer 求值抛错：${result.result.exceptionDetails.exception?.description ?? JSON.stringify(result.result.exceptionDetails)}`)
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
      return await cdpEvalOnce(await cdpTarget(cdpPort), expression, timeoutMs)
    } catch (err) {
      lastErr = err
      const message = String(err?.message ?? err)
      const retryable = /Execution context was destroyed|Cannot find context|连接关闭|连接错误|超时/.test(message)
      if (!retryable) throw err
      await sleep(700)
    }
  }
  throw lastErr
}

/**
 * 伪造一个 agent-status 信封直接单播给目标节点（走 UDP，不经任何本机 service）。
 * AC3 的唯一手段：入站校验必须挡住「不可信输入」，而不是只挡住自家发送侧。
 */
async function forgeStatus(target, fromNodeId, payload) {
  const { createSocket } = await import('node:dgram')
  const socket = createSocket({ type: 'udp4' })
  const env = { v: 1, type: 'agent-status', id: `forge-${Date.now()}-${Math.random()}`, from: fromNodeId, ts: Date.now(), payload }
  const buf = Buffer.from(JSON.stringify(env), 'utf8')
  await new Promise((res) => socket.bind(0, '127.0.0.1', res))
  await new Promise((res) => socket.send(buf, target.udp, '127.0.0.1', () => res()))
  socket.close()
}

async function teardown() {
  for (const child of children) {
    try { await fetch(`http://127.0.0.1:${child.apiPort}/v1/lifecycle/quit`, { method: 'POST' }).catch(() => undefined) } catch { /* 已退出 */ }
  }
  await sleep(2500)
  for (const child of children) killTree(child.pid)
  await sleep(300)
}

async function main() {
  seedConfig(guiData, 'hive-status-gui', GUI)
  seedConfig(headData, 'hive-status-head', HEAD)

  // GUI：45% ⇒ about-to-blow；headless：5% ⇒ easy（阈值 10/20/40）
  const gui = launch('gui', ['.', `--remote-debugging-port=${GUI.cdp}`], {
    PANTRY_USER_DATA: guiData,
    PANTRY_UDP_PORT: String(GUI.udp), PANTRY_TCP_PORT: String(GUI.tcp),
    PANTRY_LOCAL_API_PORT: String(GUI.api),
    PANTRY_PEERS: `127.0.0.1:${HEAD.udp}`,
    PANTRY_AGENT_STATUS: 'pct=45;size=1048576'
  })
  gui.apiPort = GUI.api
  const head = launch('head', ['.'], {
    PANTRY_HEADLESS: '1',
    PANTRY_USER_DATA: headData,
    PANTRY_UDP_PORT: String(HEAD.udp), PANTRY_TCP_PORT: String(HEAD.tcp),
    PANTRY_LOCAL_API_PORT: String(HEAD.api),
    PANTRY_PEERS: `127.0.0.1:${GUI.udp}`,
    PANTRY_AGENT_STATUS: 'pct=5;size=200000'
  })
  head.apiPort = HEAD.api

  const hGui = await waitHealth(GUI.api, 'gui')
  const hHead = await waitHealth(HEAD.api, 'head')
  check('两节点身份互异', hGui.nodeId !== hHead.nodeId)
  check('AC5 headless 自检行打印', head.lines.some((l) => l.startsWith('[headless] up ')))
  check('AC5 断言抓手：health 报出 ag1 与生产者状态',
    hGui.agentStatus?.cap === 'ag1' && hGui.agentStatus?.producer === 'on',
    JSON.stringify(hGui.agentStatus))

  // ---- AC1：静态 peers 下互见 ----
  const seen = await waitFor(async () => {
    const h = await health(GUI.api)
    return { ok: h.peers >= 1, peers: h.peers }
  }, 40000, 'GUI 看到 headless')
  check('AC1 静态 peers 下两节点互见', seen.ok, `GUI 在线对端 ${seen.peers}`)

  // ---- 建群（renders 面唯一入口；local-api 端点表冻结，不加第五个端点） ----
  const groupId = await cdpEvaluate(GUI.cdp, `
    const s = await window.pantry.saveProfile({ nick: 'hive-status-gui', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
    if (!s.setupDone) throw new Error('setupDone 未置位');
    const g = await window.pantry.createGroup('hive-status', ['${hHead.nodeId}']);
    if (!g) throw new Error('createGroup 返回 null');
    return g.groupId;`)
  check('AC1 建群成功（GUI 与 headless 同群）', typeof groupId === 'string' && groupId.length > 0, groupId)

  const headEvents = await openSse(HEAD.api, 'head')

  // 读真 renderer 的成员行视图（PeerView.burden 是 #47 的渲染投影）
  const peerBurden = async (nodeId) => cdpEvaluate(GUI.cdp, `
    const peers = await window.pantry.getPeers();
    const p = peers.find(x => x.nodeId === '${nodeId}');
    return p ? { burden: p.burden ?? null, online: p.online, caps: p.caps } : null;`)

  // ---- AC1 + AC2 + AC4：GUI 侧成员行拿到 headless 的负担档 ----
  // 注意等待条件必须是「首拍真的到了」（stale=false）：eligible 只依赖 caps + 同群，
  // 在数据到达之前就已经为 true，拿它当条件会读到未上报的 idle 假象。
  const guiSide = await waitFor(async () => {
    const p = await peerBurden(hHead.nodeId)
    return { ok: Boolean(p?.burden?.eligible) && p.burden.stale === false, p }
  }, 30000, 'GUI 成员行出现 headless 的负担面')
  check('AC4 成员行出现五档负担面（eligible = 同群 ∩ ag1）',
    guiSide.ok, JSON.stringify(guiSide.p?.burden ?? null))
  check('AC4 成员行显示 5% 落 easy 档',
    guiSide.p?.burden?.tag === 'easy' && guiSide.p.burden.pct === 5,
    JSON.stringify(guiSide.p?.burden ?? null))
  check('AC4 同屏给出窗口大小（必须与占用同屏）',
    guiSide.p?.burden?.sizeTokens === 200000, `sizeTokens=${guiSide.p?.burden?.sizeTokens}`)
  check('AC4 状态点带五档文案与配色（sprite A2）',
    guiSide.p?.burden?.label === '轻松' && guiSide.p?.burden?.color === '#3fb950',
    `label=${guiSide.p?.burden?.label} color=${guiSide.p?.burden?.color}`)

  // ---- headless 侧：SSE 收到 GUI 的负担（定向单播的另一向） ----
  const headSide = await waitFor(async () => {
    const hit = headEvents.find((e) => e.type === 'burden.updated' && e.data.memberId === hGui.nodeId && !e.data.stale)
    return { ok: Boolean(hit), hit }
  }, 30000, 'headless 收到 GUI 的 burden.updated')
  check('AC1 GUI→headless 定向 agent-status 到达（SSE burden.updated）',
    headSide.ok, headSide.hit ? JSON.stringify(headSide.hit.data) : '未收到')
  check('AC2 burden.updated 信封字段完整（批内冻结表）',
    Boolean(headSide.hit) && headSide.hit.v === 1 && Number.isInteger(headSide.hit.seq) &&
      typeof headSide.hit.ts === 'number' && headSide.hit.data.memberId === hGui.nodeId &&
      headSide.hit.data.stale === false,
    headSide.hit ? JSON.stringify(headSide.hit) : '')
  check('AC4 GUI 的 45% 落 about-to-blow 档（阈值 40）',
    headSide.hit?.data.tag === 'about-to-blow' && headSide.hit?.data.pct === 45,
    `tag=${headSide.hit?.data.tag} pct=${headSide.hit?.data.pct}`)

  // ---- AC2：节拍 —— 30s 内应看到多拍，间隔 ≈10s ----
  const beat = await waitFor(async () => {
    const n = headEvents.filter((e) => e.type === 'burden.updated' && e.data.memberId === hGui.nodeId && !e.data.stale).length
    return { ok: n >= 3, n }
  }, 35000, 'GUI 按节拍持续上报')
  check('AC2 按节拍持续上报（30s 内 ≥3 拍）', beat.ok, `已收到 ${beat.n} 拍`)
  const stamps = headEvents
    .filter((e) => e.type === 'burden.updated' && e.data.memberId === hGui.nodeId && !e.data.stale)
    .map((e) => e.ts)
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i])
  check('AC2 上报间隔 ≈10s', gaps.length > 0 && gaps.every((g) => g >= 7000 && g <= 15000),
    `gaps=${JSON.stringify(gaps)}`)

  // ---- AC3：非法 / 超限 / 乱序被丢弃，且不污染 presence ----
  const hBefore = await health(GUI.api)

  // (a) 未知来源 nodeId：不是已知对端 → 整包丢
  await forgeStatus(GUI, '00000000-0000-4000-8000-000000000000', { ts: Date.now(), pct: 45, sizeTokens: 1048576, tag: 'about-to-blow' })
  // (b) 同群已知来源但字段非法：pct 越界 / tag 非法 / ts 陈旧 / sizeTokens 非正 / goal 超 120B
  const badPayloads = [
    { ts: Date.now(), pct: 101, sizeTokens: 1048576, tag: 'busy' },
    { ts: Date.now(), pct: 30, sizeTokens: 1048576, tag: 'about-to-explode' },
    { ts: Date.now() - 10 * 60_000, pct: 30, sizeTokens: 1048576, tag: 'busy' },
    { ts: Date.now(), pct: 30, sizeTokens: 0, tag: 'busy' },
    { ts: Date.now(), pct: 30, sizeTokens: 1048576, tag: 'busy', goal: 'x'.repeat(400) }
  ]
  for (const payload of badPayloads) {
    await forgeStatus(GUI, hHead.nodeId, payload)
    await sleep(300)
  }
  await sleep(2000)
  const hAfter = await health(GUI.api)
  const pAfter = await peerBurden(hHead.nodeId)
  check('AC3 非法/超限/陈旧包计入 dropped，未静默接受',
    hAfter.agentStatus.dropped >= hBefore.agentStatus.dropped + badPayloads.length + 1,
    `${hBefore.agentStatus.dropped} → ${hAfter.agentStatus.dropped}`)
  check('AC3 伪造包不污染 presence（在线对端数不变）',
    hAfter.peers === hBefore.peers, `${hBefore.peers} → ${hAfter.peers}`)
  check('AC3 非法包不改变成员行档位（仍是 headless 自己的 5% easy）',
    pAfter?.burden?.tag === 'easy' && pAfter?.burden?.pct === 5,
    JSON.stringify(pAfter?.burden ?? null))

  // (c) 乱序：比已存 ts 更旧的合法包不得覆盖当前档
  await forgeStatus(GUI, hHead.nodeId, { ts: Date.now() - 60_000, pct: 45, sizeTokens: 1048576, tag: 'about-to-blow' })
  await sleep(2500)
  const pOutOfOrder = await peerBurden(hHead.nodeId)
  check('AC3 乱序旧包被丢弃（档位未被旧值覆盖）',
    pOutOfOrder?.burden?.tag === 'easy',
    `tag=${pOutOfOrder?.burden?.tag} pct=${pOutOfOrder?.burden?.pct}`)

  // ---- AC5 + AC2：确定性生产器到期 → 停止上报 → 30s 后过期落 idle ----
  // 另起一个只有 5s 上报窗口的节点，精确验 TTL（不撞 GUI 的持续上报）。
  const dData = join(root, 'short')
  seedConfig(dData, 'hive-status-short', { udp: 38878, tcp: 38879 })
  const short = launch('short', ['.'], {
    PANTRY_HEADLESS: '1',
    PANTRY_USER_DATA: dData,
    PANTRY_UDP_PORT: '38878', PANTRY_TCP_PORT: '38879', PANTRY_LOCAL_API_PORT: '38890',
    PANTRY_PEERS: `127.0.0.1:${GUI.udp}`,
    // 上报窗口必须留够「发现 → 建群 → 首拍」的时间：建群前目标集为空，一条都不发。
    PANTRY_AGENT_STATUS: 'pct=25;size=200000;for=30000'
  })
  short.apiPort = 38890
  const hShort = await waitHealth(38890, 'short')
  await cdpEvaluate(GUI.cdp, `
    const g = await window.pantry.createGroup('hive-status-short', ['${hShort.nodeId}']);
    if (!g) throw new Error('createGroup 返回 null');
    return g.groupId;`)
  const shortSeen = await waitFor(async () => {
    const p = await peerBurden(hShort.nodeId)
    return { ok: p?.burden?.pct === 25, p }
  }, 45000, '短命节点出现 25% overload 档（阈值 20）')
  check('AC4 25% 落 overload 档（阈值 20）',
    shortSeen.p?.burden?.tag === 'overload', `tag=${shortSeen.p?.burden?.tag}`)

  // 过期点 = 最后一次上报的 ts + 30s TTL。记下过期前最后一次有效 ts，据此判间隔。
  const lastLiveTs = shortSeen.p?.burden?.ts ?? 0
  const expiredAt = Date.now()
  // 上报窗口本身 30s，故给到 90s 余量。
  const expired = await waitFor(async () => {
    const p = await peerBurden(hShort.nodeId)
    const stale = p?.burden?.eligible === true && p.burden.stale === true
    return { ok: stale, p, at: Date.now() }
  }, 90000, '短命节点停止上报后过期')
  check('AC2 停止上报 30s 后过期：落 idle 蓝、pct 置空',
    expired.ok && expired.p.burden.tag === 'idle' && expired.p.burden.pct === null && expired.p.burden.label === '空闲',
    JSON.stringify(expired.p?.burden ?? null))
  check('AC2 过期发生在最后一次上报后 ~30s（3× 节拍，非复用 offlineAfter 90s）',
    expired.ok && expired.at - lastLiveTs >= 28_000 && expired.at - lastLiveTs <= 55_000,
    `Δ=${expired.ok ? expired.at - lastLiveTs : 'n/a'}ms（观测起点 ${expiredAt}）`)
  check('AC4 空闲轴：拿不到数据落 idle 且仍显示（「没停顿」）—— 不是离线',
    expired.p?.burden?.stale === true && expired.p?.burden?.eligible === true,
    JSON.stringify(expired.p?.burden ?? null))

  // ---- AC4：离线是另一条轴（presence 事实），不与负担档混同 ----
  const guiBeforeQuit = await health(GUI.api)
  await fetch('http://127.0.0.1:38890/v1/lifecycle/quit', { method: 'POST' }).catch(() => undefined)
  await waitFor(async () => ({ ok: !pidAlive(short.pid) }), 15000, 'short 退出')
  killTree(short.pid)
  const offlineAxis = await waitFor(async () => {
    const h = await health(GUI.api)
    const p = await peerBurden(hShort.nodeId)
    return { ok: h.peers < guiBeforeQuit.peers, peers: h.peers, before: guiBeforeQuit.peers, burden: p?.burden ?? null, online: p?.online }
  }, 120000, 'short 在 GUI 侧转为离线（presence 事实）')
  check('AC4 离线轴：节点退出后在线对端数下降（可达性由底座成员表承担）',
    offlineAxis.ok, `在线对端 ${offlineAxis.before} → ${offlineAxis.peers}`)
  check('AC4 离线不冒充负担档：仍按负担面渲染（离线 ≠ idle / ≠ 回收）',
    offlineAxis.burden?.eligible === true && offlineAxis.burden.tag === 'idle' && offlineAxis.online === false,
    JSON.stringify({ burden: offlineAxis.burden, online: offlineAxis.online }))

  // ---- 结构性无状态的对端不画环（#38）：未声明 ag1 的对端保留绿/灰点 ----
  const noAg1 = await cdpEvaluate(GUI.cdp, `
    const peers = await window.pantry.getPeers();
    return peers.filter(p => !p.caps.includes('ag1')).map(p => ({ nodeId: p.nodeId, burdenEligible: p.burden?.eligible ?? null }));`)
  check('AC4 未声明 ag1 的对端不落 idle 蓝（burden 面缺席或 eligible=false）',
    noAg1.every((p) => p.burdenEligible !== true), JSON.stringify(noAg1))

  await teardown()
  for (const child of children) {
    check(`${child.label} 退出后无残留进程`, aliveTree(child.pid).length === 0)
  }

  console.log(`\n${failures === 0 ? 'STATUS E2E OK' : `STATUS E2E FAILED — ${failures} 项`}（${total} 项断言）`)
  if (!keep) rmSync(root, { recursive: true, force: true })
  else console.log(`数据目录保留在 ${root}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(`\nSTATUS E2E ERROR: ${err?.stack ?? err}`)
  await teardown().catch(() => undefined)
  if (!keep) rmSync(root, { recursive: true, force: true })
  process.exit(1)
})
