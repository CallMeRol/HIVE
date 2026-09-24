// Hive 黑盒 e2e rig 的共享工具层（#44 / #45 复用）。
//
// 提供：断言记账、真进程启动/进程树清理、local-api（health/SSE/messages/quit）、
// CDP 驱动真 renderer、优雅退出判定。纯 Node 22（global fetch + WebSocket），零新依赖。
//
// 纪律：这里只放两条 rig 都需要的通用能力；每个 ticket 的验收断言留在各自的 rig 脚本里。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeNodeConfig } from './hive-node-config.mjs'
import { assertPortsFree as assertPortsFreeShared } from './hive-proc.mjs'
import { aliveTree, killTree, pidAlive, sleep } from './hive-proc.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const VENDOR = join(REPO, 'vendor', 'teahouse')

// 进程/端口机械动作在 scripts/lib/hive-proc.mjs（launcher 共用）；这里转出，保住既有 import 面。
export { aliveTree, childrenOf, killTree, pidAlive, sleep } from './hive-proc.mjs'
export { configPathFor, defaultConfig } from './hive-node-config.mjs'

/** 断言记账。`check` 立即打印，`summary()` 汇总退出码。 */
export function createChecker() {
  const results = []
  let failures = 0
  return {
    results,
    get failures() {
      return failures
    },
    check(name, ok, detail = '') {
      results.push({ name, ok, detail })
      if (!ok) failures += 1
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    },
    summary() {
      return `${failures === 0 ? 'E2E OK' : `E2E FAILED — ${failures} 项`}（${results.length} 项断言）`
    }
  }
}

// ---------- 进程树 / 端口 / 配置：实现在 scripts/lib/hive-proc.mjs 与
// scripts/lib/hive-node-config.mjs（launcher 与 rig 共用），本文件顶部已 re-export。 ----------

/**
 * 打包版会跑真实的开机自启设置（applyAutoLaunch 只在 packaged 生效）；
 * 预置一条“关掉”的 config，避免验收过程改到这台机器。
 * 完整字段集的理由见 hive-node-config.mjs 顶部注释（残缺 config 会静默杀死发现）。
 */
export function writeSeedConfig({ dataDir, udp, tcp, nick, autoLaunch = false, closeToTray = false }) {
  return writeNodeConfig({ dataDir, udp, tcp, nick, autoLaunch, closeToTray })
}

/**
 * 一条黑盒 rig：持有子进程表、临时数据根与全部断言/观察工具。
 *
 * `ports` 形如 `{ gui: { udp, tcp, api, cdp }, agentA: { udp, tcp, api }, … }`，
 * 每个节点一套独立端口 + 独立 userData（单例锁按 userData 隔离，只改端口救不了）。
 */
export function createRig({ appPath = null, ports, keep = false, verbose = true }) {
  const checker = createChecker()
  const { check } = checker
  const children = []
  const root = mkdtempSync(join(tmpdir(), 'hive-e2e-'))
  const dataDirs = {}
  for (const label of Object.keys(ports)) {
    dataDirs[label] = join(root, label)
  }

  // appPath 按调用者 cwd 解析；子进程 cwd 会被换成 vendor/teahouse，相对路径会 ENOENT。
  const appExe = appPath ? resolve(process.cwd(), appPath) : null
  const exe = appExe
    ? join(appExe, 'Contents', 'MacOS', 'Hive')
    : join(VENDOR, 'node_modules', '.bin', 'electron')
  if (!existsSync(exe)) {
    throw new Error(`找不到可执行文件：${exe}（dev 模式先跑 pnpm run build；app 模式先打包签名）`)
  }
  const baseArgs = appExe ? [] : ['.']

  /** 全部节点占用的 TCP 端口（含 CDP），用于端口预检。 */
  function tcpPorts() {
    const list = []
    for (const spec of Object.values(ports)) {
      for (const key of ['tcp', 'api', 'cdp']) if (spec[key]) list.push(spec[key])
    }
    return list
  }
  function allPorts() {
    const list = []
    for (const spec of Object.values(ports)) {
      for (const key of ['udp', 'tcp', 'api', 'cdp']) if (spec[key]) list.push(spec[key])
    }
    return list
  }

  function launch({ label: nodeLabel, args, env }) {
    const child = spawn(exe, args, {
      cwd: VENDOR,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.lines = []
    child.nodeLabel = nodeLabel
    const capture = (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue
        child.lines.push(line)
        if (verbose && /\[headless\]|\[local-api\]|\[bridge\]|\[agent\]|\[hangar\]|error|Error/.test(line)) {
          console.log(`  [${nodeLabel}] ${line}`)
        }
      }
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
    children.push(child)
    return child
  }

  /**
   * 起节点。`peers` 是静态对端列表（形如 `127.0.0.1:17878`），`extraEnv` 供个别用例覆盖。
   *
   * `headless: true` 必须显式给（ADR-0002 Decision 2：真 headless = `PANTRY_HEADLESS=1`
   * 不建窗）。漏了它拿到的是普通 GUI 节点 —— 功能照样跑，但验的不是 headless 路径。
   * GUI 节点默认带 `--remote-debugging-port`（CDP 驱动真 renderer）。
   */
  function up(label, { peers = [], extraEnv = {}, cdp = true, headless = false } = {}) {
    const spec = ports[label]
    if (!spec) throw new Error(`未知节点：${label}`)
    if (headless && spec.cdp) throw new Error(`${label} 同时要 headless 与 CDP 是自相矛盾的`)
    const env = {
      PANTRY_USER_DATA: dataDirs[label],
      PANTRY_UDP_PORT: String(spec.udp),
      PANTRY_TCP_PORT: String(spec.tcp),
      PANTRY_LOCAL_API_PORT: String(spec.api),
      ...(headless ? { PANTRY_HEADLESS: '1' } : {}),
      ...(peers.length > 0 ? { PANTRY_PEERS: peers.join(',') } : {}),
      ...extraEnv
    }
    const child = launch({
      label,
      args: cdp && spec.cdp ? [...baseArgs, `--remote-debugging-port=${spec.cdp}`] : baseArgs,
      env
    })
    child.hiveApiPort = spec.api
    child.cdpPort = cdp ? spec.cdp : null
    child.dataDir = dataDirs[label]
    child.headless = headless
    return child
  }

  /** 给某节点预置 config.json（打包版必需的完整字段集）。要赶在 up() 之前调用。 */
  function seedConfig(label, opts = {}) {
    const spec = ports[label]
    if (!spec) throw new Error(`未知节点：${label}`)
    writeSeedConfig({ dataDir: dataDirs[label], udp: spec.udp, tcp: spec.tcp, ...opts })
  }

  let teardownHook = null
  /** 退出清理：先请 local-api 优雅退出，再杀整棵树（含 Electron Helpers）。 */
  async function teardown() {
    if (teardownHook) {
      const hook = teardownHook
      teardownHook = null
      await hook().catch(() => undefined)
    }
    await Promise.all(
      children.map(async (child) => {
        try {
          if (child.hiveApiPort && pidAlive(child.pid)) {
            await fetch(`http://127.0.0.1:${child.hiveApiPort}/v1/lifecycle/quit`, {
              method: 'POST'
            }).catch(() => undefined)
            await waitExit(child, 3000)
          }
        } catch {
          /* 已经没了 */
        }
        killTree(child.pid)
      })
    )
    await sleep(300)
  }

  function cleanup() {
    if (!keep) rmSync(root, { recursive: true, force: true })
    else console.log(`数据目录保留在 ${root}`)
  }

  /**
   * 等子进程 stdout 里出现某行。自检行是在 local-api `listen()` 的 .then() 里打印的，
   * 而 HTTP 面在打印之前就已可用 —— 只按 health 判定会撞上这个 race。
   */
  async function waitLine(child, predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hit = child.lines.find(predicate)
      if (hit) return hit
      await sleep(100)
    }
    return null
  }

  // ---------- local-api ----------

  async function health(port, token = '') {
    const res = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
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

  /** SSE 订阅：回传 push 出来的信封数组（信封 { v, seq, type, ts, data }）。 */
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

  // ---------- CDP：驱动真 GUI 的 renderer（走 window.pantry / 真 DOM，不吃内部实现） ----------

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

  /** 单次 CDP 求值；renderer 在首次挂载时会重建执行上下文，故由调用方重试。 */
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
        // 首屏挂载会销毁执行上下文 / target 未就绪 —— 都是可重试的瞬态。
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

  // ---------- 断言辅助 ----------

  async function waitExit(child, timeoutMs) {
    const timer = sleep(timeoutMs).then(() => 'timeout')
    return Promise.race([child.exited, timer])
  }

  /** 轮询 CDP 直到 predicate 返回真值（用于等 UI 渲染出来）。 */
  async function waitCdp(cdpPort, expression, predicate, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await cdpEvaluate(cdpPort, expression)
      if (predicate(last)) return last
      await sleep(300)
    }
    throw new Error(`等待「${label}」超时，最后取值：${JSON.stringify(last)}`)
  }

  /**
   * `budgetMs`：headless 按 ADR-0002 的 ≤3s 硬判；GUI 带 CDP/devtools 连接时会被拖住
   * （无 CDP 时单独实测 1s 退出），故给宽窗口只判「最终干净退出」。
   */
  async function gracefullyQuit(child, label, budgetMs = 3000) {
    const started = Date.now()
    const res = await fetch(`http://127.0.0.1:${child.hiveApiPort}/v1/lifecycle/quit`, {
      method: 'POST'
    })
    check(`${label} 优雅退出请求被接受（202）`, res.status === 202, `status=${res.status}`)
    const exited = await waitExit(child, budgetMs + 9000)
    const elapsed = Date.now() - started
    check(
      `${label} 进程退出 ≤${budgetMs / 1000}s`,
      exited !== 'timeout' && elapsed <= budgetMs,
      `elapsed=${elapsed}ms`
    )
    await sleep(1500)
    const stuck = aliveTree(child.pid)
    check(`${label} 退出后无残留进程（含 Helpers）`, stuck.length === 0, JSON.stringify(stuck))
    if (stuck.length > 0) for (const pid of stuck) killTree(pid)
    return exited
  }

  /**
   * 互见要等 discovery 把对方灌进 registry，不能起进程后立刻判。
   * `nodeIds` 传数组时要求**全部**在线才返回 —— 三节点 rig 里只等一个会让后面的建群选不到人。
   */
  async function waitForPeer(cdpPort, nodeIds, timeoutMs = 25000) {
    const wanted = Array.isArray(nodeIds) ? nodeIds : [nodeIds]
    const deadline = Date.now() + timeoutMs
    let seen = []
    while (Date.now() < deadline) {
      seen = await cdpEvaluate(
        cdpPort,
        `const peers = await window.pantry.getPeers();
         return peers.filter(p => p.online).map(p => p.nodeId);`
      )
      if (wanted.every((id) => seen.includes(id))) return seen
      await sleep(800)
    }
    return seen
  }

  /** 等某个节点的群数稳定到期望值（群元数据是单播给成员的，要等同步到位）。 */
  async function waitGroupCount(port, expected, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs
    let last = -1
    while (Date.now() < deadline) {
      try {
        last = (await health(port)).groups
        if (last === expected) return last
      } catch {
        /* 还没起来 */
      }
      await sleep(400)
    }
    return last
  }

  /** 等本机端口重新空闲（上一轮节点刚退出时可能仍在收敛）。 */
  async function waitPortsFree(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        assertPortsFreeShared(allPorts())
        return
      } catch (err) {
        if (Date.now() > deadline) throw err
        await sleep(1000)
      }
    }
  }

  return {
    checker,
    check,
    root,
    dataDirs,
    portOf: (label, kind) => ports[label][kind],
    exe,
    appPath,
    children,
    up,
    seedConfig,
    waitLine,
    teardown,
    cleanup,
    onTeardown: (fn) => {
      teardownHook = fn
    },
    health,
    waitHealth,
    openSse,
    waitEvent,
    cdpEvaluate,
    waitCdp,
    waitExit,
    gracefullyQuit,
    waitForPeer,
    waitGroupCount,
    waitPortsFree,
    assertPortsFree: () => assertPortsFreeShared(allPorts()),
    tcpPorts,
    tcpPortsOf: (label) => ports[label].tcp,
    sleep,
    kill: (child) => killTree(child.pid),
    alivePids: () => children.filter((c) => aliveTree(c.pid).length > 0).map((c) => c.pid)
  }
}
