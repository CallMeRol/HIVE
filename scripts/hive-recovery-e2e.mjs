#!/usr/bin/env node
// Hive #61 黑盒验收：packaged APP 在进程异常后恢复到安全状态。
//   node scripts/hive-recovery-e2e.mjs
//   node scripts/hive-recovery-e2e.mjs --app vendor/teahouse/release/mac-arm64/Hive.app
//
// 四条 AC 逐条钉成断言：
//   AC1 在 packaged APP 中依次注入 runner 猝死、守卫不可用和交接损坏
//   AC2 重启后失败任务不会被标记成功，也不会重复派遣
//   AC3 待领取任务、警告和拒绝记录完整保留
//   AC4 测试结束后无孤儿 Electron 或 Node 进程
//
// 手法：**崩溃恢复只能在重启路径上验**，进程内伪造「上次退出」是不成立的。
// 故这里不接受「起一个 app 然后调内部函数」——那验的是函数，不是恢复。
// 真实做法：预置「上次异常退出时留在磁盘上的账本」→ 起真进程 → 读它会话结束时写回的事实。
//
// 三个故障各自的注入点（都落在磁盘账本上，等于上次退出前的最后状态）：
//   ① runner 猝死   dispatch.json 里 outcome='started' 的派遣 = 执行期中断
//   ② 守卫不可用    无 HIVE_GOAL_GUARD_URL（= 判定器通路断开）+ 冻结目标在场
//   ③ 交接损坏      handover 账本里产物 sha256 被篡改
//
// 关于 ②③ 的一处如实说明：`#55` 的 fail-open 与 `#54` 的交接校验只在**收到消息**时触发，
// 重启本身不会重新判定它们（判定是消息驱动的，不是启动驱动的）。故 ②③ 的 AC1 断言
// 「注入后进程仍能起来且不把未判定/损坏当成成功」，AC2/AC3 的「不标记成功」由哈希与
// 账本状态直接断言。这不是跳过，是这两条故障的真实语义。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createChecker } from './lib/hive-rig.mjs'
import { killTree, pidAlive } from './lib/hive-proc.mjs'

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..')
const argv = process.argv.slice(2)
const appPathRaw = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null
const appPath = appPathRaw
  ? resolve(process.cwd(), appPathRaw)
  : null
const keep = argv.includes('--keep')

// 与其它 rig 端口错开（#44/#45/#48/#49）。
const GUI = { udp: 20878, tcp: 20879, api: 20880, cdp: 20881 }

const checker = createChecker()
const { check } = checker

const root = mkdtempSync(join(tmpdir(), 'hive-recovery-'))
const dataDir = join(root, 'gui')
const hiveDir = join(dataDir, 'hive')
console.log(`rig root: ${root}`)

const children = []

function seedFullConfig() {
  // 完整字段集：残缺 config 会让节点 net.ok=true、peers=0、零报错（#44 landmine 1）。
  const config = {
    nick: 'Hive-GUI', company: '', dept: '', team: '', avatar: -1, avatarHash: '', profileRev: 1,
    setupDone: true, fileDir: '', notifications: true, manualPeers: [], scanRanges: [],
    scanRangeSources: {}, ignoredScanRanges: {}, udpPort: GUI.udp, tcpPort: GUI.tcp,
    hideOnCapture: true, autoLaunch: false, closeToTray: false, language: 'zh-CN',
    theme: 'dark', fontScale: 100, showMessagePreview: true, allowDirectFileSend: true,
    fileCabinet: { root: '', mode: 'off' }, sound: 'none', sendKey: 'enter',
    captureShortcut: 'CommandOrControl+Alt+A', showHideShortcut: 'CommandOrControl+Alt+P'
  }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
}

function writeJson(path, value) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// ---------- 故障注入（写的是「上次退出前留在磁盘上的账本」） ----------

const GHOST = 'ghost-member'
const REAL = 'real-member'
const INTERRUPTED = 'dispatch-interrupted'
const OTHER_MEMBER = 'dispatch-victim'
const ARTIFACT = 'artifact-final'

/** ① runner 猝死：账本里留一条 started 的派遣（进程已随上次退出消失）。 */
function injectRunnerCrash() {
  const state = readJson(join(hiveDir, 'dispatch.json'))
  state.dispatches.push({
    dispatchId: INTERRUPTED,
    groupId: 'group-1',
    dispatcherId: REAL,
    memberIds: [OTHER_MEMBER],
    goalOneLine: '做调研并交回交接文档',
    depth: 1,
    slot: 1,
    userDataDir: join(root, 'dispatched', OTHER_MEMBER),
    startedAt: Date.now() - 60_000,
    outcome: 'started'
  })
  if (!state.slots.includes(1)) state.slots.push(1)
  writeJson(join(hiveDir, 'dispatch.json'), state)
}

/**
 * ② 守卫不可用：冻结目标在场，但不配 HIVE_GOAL_GUARD_URL（判定器通路断开）。
 * 另注入一条**上次降级时已写下的警告留痕**（fail-open 的 undetermined），
 * 用于验 AC3「警告记录完整保留」——恢复只收口状态，不许动审计面。
 */
function injectGuardDown() {
  const store = readJson(join(hiveDir, 'pending.json'))
  store.goals.push({
    memberId: REAL,
    groupId: 'group-1',
    state: 'frozen',
    text: '把 launch-plan 的 GTM 方案做完',
    frozenBy: 'owner-1',
    frozenAt: Date.now() - 120_000
  })
  writeJson(join(hiveDir, 'pending.json'), store)
  writeFileSync(
    join(hiveDir, 'goal-guard-audit.jsonl'),
    `${JSON.stringify({
      memberId: REAL,
      groupId: 'group-1',
      input: { goal: '把 launch-plan 的 GTM 方案做完', request: '顺便把按钮颜色改成 #2f81f7' },
      verdict: 'undetermined',
      confidence: 0,
      reason: '判定器不可用',
      action: 'deliver_warn',
      ts: Date.now() - 100_000
    })}\n`
  )
}

/** ③ 交接损坏：账本里的产物 sha256 与实际文件不符（篡改哈希）。 */
function injectHandoverCorruption() {
  const dir = join(hiveDir, 'handovers')
  mkdirSync(dir, { recursive: true })
  const body = '# 交接文档\n\n## 当前目标\n把方案做完\n'
  const realPath = join(dir, `${ARTIFACT}.md`)
  writeFileSync(realPath, body)
  const trueHash = createHash('sha256').update(body).digest('hex')
  writeJson(join(dir, 'index.json'), {
    schemaVersion: 1,
    records: [
      {
        handoverId: 'ho-1',
        dispatchId: INTERRUPTED,
        groupId: 'group-1',
        authorId: OTHER_MEMBER,
        memberIds: [OTHER_MEMBER],
        goalOneLine: '做调研并交回交接文档',
        depth: 1,
        slot: 1,
        userDataDir: join(root, 'dispatched', OTHER_MEMBER),
        artifactPath: realPath,
        // 篡改：账本记的哈希与文件实际内容对不上。
        artifactSha256: `${'0'.repeat(64)}`,
        trueHash,
        verified: false,
        createdAt: Date.now() - 50_000
      }
    ]
  })
}

/**
 * 一次启动的全部前置账本。`dispatch.json` 与 `pending.json` 的合法底稿也由这里生成 ——
 * 注入只在其上追加，不凭空拼半份（半份账本会走容错解析被丢弃，等于没注入）。
 */
function seedPreviousSession() {
  mkdirSync(hiveDir, { recursive: true })
  writeJson(join(hiveDir, 'dispatch.json'), {
    schemaVersion: 1, slots: [], nextSlot: 1, maxSlot: 20, maxDepth: 3, maxConcurrency: 5,
    dispatches: [], claimable: []
  })
  // 待领取任务：重启前就存在，必须原样保留（AC3）。
  const pendingStore = {
    schemaVersion: 1,
    pendings: [
      // 幽灵：登记表里没有这个成员 → 恢复时应清掉。
      { memberId: GHOST, groupId: 'group-1', entries: [{ senderId: 'owner-1', text: '幽灵请求', messageId: 'm-ghost', ts: Date.now() }], createdAt: Date.now() },
      // 真实成员：登记表里有 → 必须保留。
      { memberId: REAL, groupId: 'group-1', entries: [{ senderId: 'owner-1', text: '真实请求', messageId: 'm-real', ts: Date.now() }], createdAt: Date.now() }
    ],
    goals: [],
    confirmGrants: ['owner-1']
  }
  writeJson(join(hiveDir, 'pending.json'), pendingStore)
  writeJson(join(hiveDir, 'members.json'), {
    schemaVersion: 1,
    members: [{ memberId: REAL, ownerId: 'owner-1', kind: 'resident', registeredAt: Date.now() }]
  })
  writeJson(join(hiveDir, 'agent-attach.json'), { schemaVersion: 1, members: [] })
  // 拒绝记录：主人移除被拒（fail-closed 留痕），必须跨重启保留（AC3）。
  writeFileSync(
    join(hiveDir, 'member-audit.jsonl'),
    `${JSON.stringify({ v: 1, ts: Date.now(), action: 'remove', result: 'denied', actorId: 'intruder', targetId: REAL, groupId: 'group-1', code: 'not_owner', reason: '仅成员的主人可移除' })}\n`
  )
  injectRunnerCrash()
  injectGuardDown()
  injectHandoverCorruption()
}

// ---------- 启动 ----------

function launch() {
  const exe = appPath
    ? join(appPath, 'Contents', 'MacOS', 'Hive')
    : join(REPO, 'vendor', 'teahouse', 'node_modules', '.bin', 'electron')
  if (!existsSync(exe)) throw new Error(`找不到可执行文件：${exe}`)
  const args = appPath ? [] : ['.']
  const child = spawn(exe, [...args, `--remote-debugging-port=${GUI.cdp}`], {
    cwd: join(REPO, 'vendor', 'teahouse'),
    env: {
      ...process.env,
      PANTRY_USER_DATA: dataDir,
      PANTRY_UDP_PORT: String(GUI.udp),
      PANTRY_TCP_PORT: String(GUI.tcp),
      PANTRY_LOCAL_API_PORT: String(GUI.api),
      // ② 守卫不可用的注入点之一：**不**给 HIVE_GOAL_GUARD_URL。
      HIVE_GOAL_GUARD_URL: '',
      // 启用 pending 闸门，恢复路径才会碰 pending 账本。
      PANTRY_PENDING: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.lines = []
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const capture = (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      child.lines.push(line)
      if (/\[recovery\]|\[hive\]|\[local-api\]|\[hangar\]|Error/.test(line)) console.log(`  [gui] ${line}`)
    }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  children.push(child)
  return child
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${GUI.api}/v1/health`)
      if (res.ok) return await res.json()
      last = `status=${res.status}`
    } catch (err) {
      last = String(err?.message ?? err)
    }
    await sleep(500)
  }
  throw new Error(`等 health 超时：${last}`)
}

async function quit(child) {
  try {
    await fetch(`http://127.0.0.1:${GUI.api}/v1/lifecycle/quit`, { method: 'POST' })
  } catch {
    /* 已经没了 */
  }
  const raced = await Promise.race([child.exited, sleep(12000).then(() => 'timeout')])
  return raced
}

// ---------- 主流程 ----------

async function main() {
  console.log(`=== Hive #61 崩溃恢复 rig ===（app=${appPathRaw ?? 'dev out/'}）`)
  seedFullConfig()
  seedPreviousSession()

  const child = launch()
  let failed = 0
  try {
    await waitHealth()
    // 恢复是在 whenReady 里 fire-and-forget 的（不挡启动），给它落盘的时间。
    await sleep(6000)

    // ---------- AC2：失败任务不标记成功、不重复派遣 ----------
    const dispatch = readJson(join(hiveDir, 'dispatch.json'))
    const rec = dispatch.dispatches.find((d) => d.dispatchId === INTERRUPTED)
    check('AC2 中断派遣未被标记成功（outcome≠started）', rec?.outcome === 'failed', `outcome=${rec?.outcome}`)
    check(
      'AC2 中断派遣留了失败原因（显式报告，不静默）',
      typeof rec?.reason === 'string' && rec.reason.length > 0,
      `reason=${rec?.reason ?? '(空)'}`
    )
    check(
      'AC2 不重复派遣：派遣表仍只有这一条，memberIds 未被追加',
      dispatch.dispatches.length === 1 && rec?.memberIds.length === 1,
      `dispatches=${dispatch.dispatches.length} memberIds=${rec?.memberIds?.length}`
    )
    check('AC2 slot 已归还（未继续占用端口段）', !dispatch.slots.includes(1), `slots=${JSON.stringify(dispatch.slots)}`)

    // ---------- AC3：待领取 / 警告 / 拒绝记录完整保留 ----------
    const claimable = dispatch.claimable.find((t) => t.dispatchId === INTERRUPTED)
    check('AC3 中断派遣已转待领取且可被接手', claimable?.status === 'claimable', `status=${claimable?.status}`)
    check(
      'AC3 待领取保留了原始目标（接手者不需要父会话历史）',
      claimable?.goalOneLine === '做调研并交回交接文档',
      `goalOneLine=${claimable?.goalOneLine}`
    )

    const pendingAfter = readJson(join(hiveDir, 'pending.json'))
    check(
      'AC3 真实成员的待领取草稿完整保留',
      pendingAfter.pendings.some((p) => p.memberId === REAL),
      `pendings=${pendingAfter.pendings.map((p) => p.memberId).join(',')}`
    )
    check(
      'AC3 幽灵 pending 已清掉（确认键不会按给幽灵）',
      !pendingAfter.pendings.some((p) => p.memberId === GHOST)
    )
    check(
      'AC3 冻结目标跨重启保留（守卫降级后仍知道在守什么）',
      pendingAfter.goals.some((g) => g.memberId === REAL && g.state === 'frozen')
    )

    const audit = readFileSync(join(hiveDir, 'member-audit.jsonl'), 'utf8').trim().split('\n')
    check(
      'AC3 拒绝记录跨重启保留（fail-closed 留痕不丢）',
      audit.some((l) => JSON.parse(l).result === 'denied'),
      `${audit.length} 行`
    )

    // ---------- AC1：守卫不可用 ----------
    const guardAuditPath = join(hiveDir, 'goal-guard-audit.jsonl')
    const guardConfigured = child.lines.some((l) => l.includes('[goal-guard] 目标守卫已启用'))
    check(
      'AC1 守卫不可用（未配判定器通路）时进程仍正常启动',
      !guardConfigured,
      guardConfigured ? '意外启用了守卫' : ''
    )
    check(
      'AC1 守卫不可用不产生伪造的「已判定」记录',
      !readFileSync(guardAuditPath, 'utf8').includes('"verdict":"in-scope"'),
      '无判定器时不应写 in-scope'
    )
    const guardAudit = readFileSync(guardAuditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    check(
      'AC3 守卫降级警告（undetermined 留痕）跨重启完整保留',
      guardAudit.some((e) => e.verdict === 'undetermined' && e.action === 'deliver_warn'),
      `${guardAudit.length} 条`
    )
    const warned = guardAudit.find((e) => e.verdict === 'undetermined')
    check(
      'AC3 警告留痕保留了判定输入（可审计：目标 + 请求原文）',
      Boolean(warned?.input?.goal && warned?.input?.request),
      `goal=${warned?.input?.goal?.slice(0, 12) ?? '(缺)'}… request=${warned?.input?.request?.slice(0, 12) ?? '(缺)'}…`
    )

    // ---------- AC1/AC2：交接损坏 ----------
    const ho = readJson(join(hiveDir, 'handovers', 'index.json'))
    const record = ho.records[0]
    const actual = createHash('sha256').update(readFileSync(record.artifactPath)).digest('hex')
    check(
      'AC1 交接损坏已注入（账本哈希与文件实际内容不符）',
      actual !== record.artifactSha256,
      `账本=${record.artifactSha256.slice(0, 12)}… 实际=${actual.slice(0, 12)}…`
    )
    check(
      'AC2 损坏交接未被标记为已复验通过（不把坏的交手当成功）',
      record.verified !== true,
      `verified=${record.verified}`
    )
  } finally {
    const exited = await quit(child)
    check('AC4 优雅退出', exited !== 'timeout', exited === 'timeout' ? '超时未退出' : '')
    await sleep(1500)
    const stuck = children.flatMap((c) => (pidAlive(c.pid) ? [c.pid] : []))
    check('AC4 退出后无残留 Electron / Node 进程', stuck.length === 0, `残留 pid=${JSON.stringify(stuck)}`)
    for (const pid of stuck) killTree(pid)
    if (!keep) rmSync(root, { recursive: true, force: true })
    else console.log(`数据目录保留在 ${root}`)
    failed = checker.failures ?? 0
  }
  console.log(failed === 0 ? '\n全部通过。' : `\n${failed} 项失败。`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`rig 失败：${err?.stack ?? err}`)
  process.exit(1)
})
