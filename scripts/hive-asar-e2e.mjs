#!/usr/bin/env node
// Hive #25 黑盒 rig：packaged Hive.app 能真的拉起 ACP runner 子进程并完成一次 turn。
//   node scripts/hive-asar-e2e.mjs                                   # 默认 release/mac-arm64/Hive.app
//   node scripts/hive-asar-e2e.mjs --app path/to/Hive.app
//
// 为什么需要这条 rig：#62 发布验收实测发现 packaged APP **从未**跑起来过 runner ——
// `app.asar.unpacked/` 里只有 better-sqlite3，`out/main/acp/runner.mjs` 被封在
// app.asar 内，而 runner 必须由**系统 node ≥22 子进程**执行，node 读不穿 asar。
// 既有各条 e2e 都跑 dev 产物（`electron .`，源码树里没有 asar），故完全没有覆盖这条路径。
//
// 覆盖 AC：
//   1) app.asar.unpacked/ 下存在 runner.mjs / fake-acp-agent.mjs 及其运行时依赖（SDK / zod）
//   2) packaged APP 中 spawn runner 子进程成功（用系统 node，非 Electron 内建）
//   3) app.getAppPath() 的路径解析在打包态落在 app.asar.unpacked/（而非 asar 内）
//   4) packaged APP 中 fake ACP peer 完成一次 turn（黑盒，不依赖真实 LLM）
//
// 判据 = 退出码 0 / 非 0。真进程、真 local-api、真 renderer（CDP），不 import 被测模块内部函数。
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRig } from './lib/hive-rig.mjs'

const argv = process.argv.slice(2)
const appPathRaw = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : 'release/mac-arm64/Hive.app'
const keep = argv.includes('--keep')
const APP = resolve(process.cwd(), appPathRaw)
const RESOURCES = join(APP, 'Contents', 'Resources')
const UNPACKED = join(RESOURCES, 'app.asar.unpacked')

const PORTS = {
  gui: { udp: 47178, tcp: 47179, api: 47190, cdp: 47341 },
  agent: { udp: 47278, tcp: 47279, api: 47290 }
}

const rig = createRig({ appPath: APP, ports: PORTS, keep })
const { check, sleep } = rig

/** 打包产物内的 runner 入口（必须在 unpacked 里，且与主进程解析到的位置一致）。 */
const UNPACKED_RUNNER = join(UNPACKED, 'out', 'main', 'acp', 'runner.mjs')
const UNPACKED_FAKE = join(UNPACKED, 'out', 'main', 'acp', 'fake-acp-agent.mjs')

async function waitFor(fn, label, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = `err:${String(err.message ?? err)}`
    }
    await sleep(500)
  }
  throw new Error(`等待「${label}」超时，最后取值：${JSON.stringify(last)}`)
}

async function main() {
  console.log(`rig root: ${rig.root}`)
  console.log(`app: ${APP}`)

  // ---- AC1：unpacked 里有 runner 及其依赖（纯静态检查，先于起进程）----
  check('AC1 app.asar.unpacked 下存在 runner.mjs', existsSync(UNPACKED_RUNNER), UNPACKED_RUNNER)
  check('AC1 app.asar.unpacked 下存在 fake-acp-agent.mjs', existsSync(UNPACKED_FAKE), UNPACKED_FAKE)
  // runner 与 fake peer 都 `await import('@agentclientprotocol/sdk')`，SDK 又 require zod/v4；
  // 少了任一个，子进程都在加载期就 fatal（sdk_load_failed），turn 无从谈起。
  check(
    'AC1 unpacked 含 ACP SDK 与 zod（runner 的运行时依赖）',
    existsSync(join(UNPACKED, 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js')) &&
      existsSync(join(UNPACKED, 'node_modules', 'zod', 'v4', 'index.js')),
    'node_modules/@agentclientprotocol/sdk + zod'
  )
  check(
    'AC1 asar 归档存在（确认验的是 asar 打包路径，不是源码树）',
    existsSync(join(RESOURCES, 'app.asar'))
  )

  rig.assertPortsFree()

  // ---- 起两个真节点：GUI（人） + agent 成员（跑真 runner + 真 fake peer）----
  rig.seedConfig('gui', { nick: 'Hive ASAR GUI' })
  rig.up('gui', { peers: [`127.0.0.1:${PORTS.agent.udp}`] })
  const hGui = await rig.waitHealth(PORTS.gui.api, 'gui')

  // agent 节点的 env 指向**unpacked** 里的 fake peer —— 这正是打包态主进程该给的东西：
  // PANTRY_AGENT_COMMAND = 系统 node（不是 Electron 内建），ARGS = unpacked 的 .mjs。
  const agent = rig.up('agent', {
    headless: true,
    peers: [`127.0.0.1:${PORTS.gui.udp}`],
    extraEnv: {
      PANTRY_AGENT_COMMAND: process.execPath,
      PANTRY_AGENT_ARGS: UNPACKED_FAKE,
      FAKE_ACP_REPLY: 'packaged runner 已回话'
    }
  })
  const hAgent = await rig.waitHealth(PORTS.agent.api, 'agent')
  check('AC2 agent 成员节点 up 且 agent=on', hAgent.agent === 'on', JSON.stringify({ agent: hAgent.agent }))

  // ---- AC3：主进程把 runner 目录解析到 unpacked（而非 asar 内）----
  // 打包态 bridge 若仍按 `app.getAppPath()`（= app.asar 文件）拼路径，只会拿到
  // 「找不到 runner 入口」并降级成不回复的普通成员 —— 故以「日志里没有该报错」判定。
  await sleep(1500)
  const allLines = [...agent.lines]
  check(
    'AC3 主进程未报「找不到 runner 入口」（路径解析落在 unpacked）',
    !allLines.some((l) => l.includes('找不到 runner 入口')),
    allLines.filter((l) => l.includes('runner')).slice(-3).join(' | ') || '（无相关行）'
  )
  check(
    'AC3 未出现 asar 内的 runner 路径（node 读不穿 asar）',
    !allLines.some((l) => /app\.asar\/out\/main\/acp/.test(l)),
    ''
  )

  // ---- AC4：@ 一次 → 真 runner turn → 正式回复进群 ----
  const seen = await rig.waitForPeer(PORTS.gui.cdp, [hAgent.nodeId], 40000)
  check('AC4 GUI 与 agent 成员互见（否则 @ 到不了）', seen.includes(hAgent.nodeId), JSON.stringify(seen))

  const group = await rig.cdpEvaluate(
    PORTS.gui.cdp,
    `const s = await window.pantry.saveProfile({ nick: 'Hive ASAR GUI', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
     if (!s.setupDone) throw new Error('setupDone 未置位');
     const g = await window.pantry.createGroup('asar rig', ['${hAgent.nodeId}']);
     return g ? g.groupId : null;`
  )
  check('AC4 建群成功（GUI 与成员同群）', typeof group === 'string' && group.length > 0, String(group))
  const groupsSynced = await rig.waitGroupCount(PORTS.agent.api, 1, 30000)
  check('AC4 成员已同步到群（否则收不到 @）', groupsSynced === 1, `群数=${groupsSynced}`)

  const guiEvents = await rig.openSse(PORTS.gui.api, 'gui')
  await sleep(500)
  const sent = await rig.cdpEvaluate(
    PORTS.gui.cdp,
    `const m = await window.pantry.sendGroupText('${group}', '@packaged 请回一次', ['${hAgent.nodeId}']);
     return m ? m.id : null;`
  )
  check('AC4 派单消息已发（@ 成员）', typeof sent === 'string', String(sent))

  // 正式回复必须由 packaged 里的 runner 子进程真跑出来 —— 这是本票的核心判据。
  const reply = await waitFor(async () => {
    const hit = guiEvents.find(
      (e) => e.type === 'message.new' && e.data.senderId === hAgent.nodeId && e.data.kind === 'formal'
    )
    return hit ?? null
  }, 'packaged runner 的正式回复', 60000)
  check(
    'AC4 packaged APP 中 fake ACP peer 完成一次 turn（正式回复进群）',
    reply.data.text.includes('packaged runner 已回话'),
    JSON.stringify(reply.data.text).slice(0, 160)
  )

  const nodeExe = await waitFor(async () => {
    const h = await rig.health(PORTS.agent.api)
    return h.ok ? h : null
  }, 'agent health', 10000)
  check('AC2 agent 节点用系统 node 跑 runner 后仍健康', nodeExe.ok === true, JSON.stringify(nodeExe.ok))

  await rig.teardown()
  for (const child of rig.children) {
    check(`${child.nodeLabel} 退出后无残留进程`, rig.alivePids().length === 0, '')
  }

  console.log(`\n${rig.checker.summary()}`)
  rig.cleanup()
  process.exit(rig.checker.failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(`\nASAR E2E ERROR: ${err?.stack ?? err}`)
  await rig.teardown().catch(() => undefined)
  rig.cleanup()
  process.exit(1)
})
