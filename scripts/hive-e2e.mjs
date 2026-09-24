#!/usr/bin/env node
// Hive #44 端到端 rig：GUI 与 headless 两条真节点的黑盒验收。
//   node scripts/hive-e2e.mjs                # 用 dev 构建产物（out/）
//   node scripts/hive-e2e.mjs --app <X.app>  # 用打包 .app（AC5）
//
// 覆盖：#44 AC1 身份初始化+建群 / AC2 双向收发+互见 / AC3 local-api + 优雅 quit 无残留 /
//       AC4 重启后群与消息仍在 / AC5 打包 .app 从 Finder 等价路径启动。
//
// 通用能力（进程树、local-api、CDP、断言记账）在 scripts/lib/hive-rig.mjs；
// 本文件只保留 #44 的拓扑与断言。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRig } from './lib/hive-rig.mjs'

const argv = process.argv.slice(2)
const appPathRaw = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null
// 相对路径按调用者 cwd 解析（子进程 cwd 会被换成 vendor/teahouse）。
const appPath = appPathRaw ? join(process.cwd(), appPathRaw).replace(/\/$/, '') : null
const keep = argv.includes('--keep')

// 两节点全独立（含 CDP，GUI 侧要驱动真 renderer）。
const PORTS = {
  gui: { udp: 27878, tcp: 27879, api: 27890, cdp: 29333 },
  headless: { udp: 17878, tcp: 17879, api: 17890 }
}

const rig = createRig({ appPath, ports: PORTS, keep })
const { check, checker } = rig
const GUI = 'gui'
const HEADLESS = 'headless'

async function main() {
  rig.assertPortsFree()
  console.log(`可执行文件：${rig.exe}${appPath ? '（打包 .app）' : '（dev out/）'}`)

  // packaged 版会真的写登录项；验收只验「从 Finder 等价路径能起」，不碰本机设置。
  rig.seedConfig(GUI, { nick: `Hive GUI ${appPath ? 'app' : 'dev'}` })
  const gui = rig.up(GUI, { peers: [`127.0.0.1:${rig.portOf(HEADLESS, 'udp')}`] })
  const headless = rig.up(HEADLESS, { peers: [`127.0.0.1:${rig.portOf(GUI, 'udp')}`], headless: true })

  // ---- AC1 / AC3：两节点都完成本机身份初始化，local-api 提供 health ----
  const guiHealth = await rig.waitHealth(rig.portOf(GUI, 'api'), 'gui')
  const headlessHealth = await rig.waitHealth(rig.portOf(HEADLESS, 'api'), 'headless')
  check('headless local-api health 可用', headlessHealth.nodeId.length > 0, JSON.stringify(headlessHealth))
  check('两节点身份不同', guiHealth.nodeId !== headlessHealth.nodeId)
  check(
    'health 报出 udp/tcp/api 端口',
    headlessHealth.ports.udp === PORTS.headless.udp &&
      headlessHealth.ports.tcp === PORTS.headless.tcp &&
      headlessHealth.ports.api === PORTS.headless.api,
    JSON.stringify(headlessHealth.ports)
  )
  const selfCheck = await rig.waitLine(headless, (l) => l.startsWith('[headless] up '))
  check('headless 自检行打印', Boolean(selfCheck), selfCheck ?? '未打印')
  check(
    'AC1 干净数据目录生成 identity.json',
    existsSync(join(rig.dataDirs[GUI], 'identity.json')) && existsSync(join(rig.dataDirs[HEADLESS], 'identity.json'))
  )
  const identity0 = JSON.parse(readFileSync(join(rig.dataDirs[GUI], 'identity.json'), 'utf8'))
  check('AC1 identity.json 的 nodeId 与 health 一致', identity0.nodeId === guiHealth.nodeId)

  const guiEvents = await rig.openSse(rig.portOf(GUI, 'api'), 'gui')
  const headlessEvents = await rig.openSse(rig.portOf(HEADLESS, 'api'), 'headless')

  // ---- 互见：headless 出现在 GUI 的在线对端里（peer 列表经 CDP 读真 renderer 数据源） ----
  const peersSeen = await rig.waitForPeer(rig.portOf(GUI, 'cdp'), headlessHealth.nodeId)
  check('AC2 GUI 与 headless 互见', peersSeen.includes(headlessHealth.nodeId), JSON.stringify(peersSeen))

  // ---- AC1 续：GUI 侧建群（createGroup 要求 ≥2 成员，故带 headless 入群） ----
  const groupId = await rig.cdpEvaluate(
    rig.portOf(GUI, 'cdp'),
    `const s = await window.pantry.saveProfile({ nick: 'Hive GUI ${appPath ? 'app' : 'dev'}', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
     if (!s.setupDone) throw new Error('setupDone 未置位');
     const g = await window.pantry.createGroup('hive-e2e', ['${headlessHealth.nodeId}']);
     if (!g) throw new Error('createGroup 返回 null');
     return g.groupId;`
  )
  check('AC1 GUI 首次启动即可建群', typeof groupId === 'string' && groupId.length > 0, groupId)

  // ---- AC2 方向 1：GUI → headless ----
  const guiText = `hello from gui ${Date.now()}`
  const sent = await rig.cdpEvaluate(
    rig.portOf(GUI, 'cdp'),
    `const m = await window.pantry.sendGroupText('${groupId}', ${JSON.stringify(guiText)}, ['${headlessHealth.nodeId}']);
     return m ? { id: m.id, text: m.text } : null;`
  )
  check('AC2 GUI 发群消息成功', sent?.text === guiText, JSON.stringify(sent))
  const atHeadless = await rig.waitEvent(
    headlessEvents,
    (e) => e.type === 'message.new' && e.data.text === guiText
  )
  check(
    'AC2 headless 收到 GUI 的群消息（SSE message.new）',
    Boolean(atHeadless),
    atHeadless ? JSON.stringify(atHeadless.data) : '未收到'
  )
  check(
    'message.new 信封字段完整',
    Boolean(atHeadless) &&
      atHeadless.v === 1 &&
      Number.isInteger(atHeadless.seq) &&
      atHeadless.data.groupId === groupId &&
      atHeadless.data.senderId === guiHealth.nodeId &&
      atHeadless.data.messageId === sent.id &&
      atHeadless.data.kind === 'formal' &&
      typeof atHeadless.ts === 'number',
    atHeadless ? JSON.stringify(atHeadless) : ''
  )

  // ---- AC2 方向 2：headless → GUI（走 local-api 的 POST /v1/messages） ----
  const headText = `hello from headless ${Date.now()}`
  const postRes = await fetch(`http://127.0.0.1:${rig.portOf(HEADLESS, 'api')}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupId, text: headText })
  })
  check('AC3 POST /v1/messages 返回 200', postRes.status === 200, `status=${postRes.status}`)
  const atGui = await rig.waitEvent(guiEvents, (e) => e.type === 'message.new' && e.data.text === headText)
  check(
    'AC2 GUI 收到 headless 的群消息（SSE message.new）',
    Boolean(atGui),
    atGui ? JSON.stringify(atGui.data) : '未收到'
  )
  check('message.new 的 senderId = headless', atGui?.data.senderId === headlessHealth.nodeId, '')

  // ---- AC3：每条 SSE 流自己的 seq 单调递增（seq 是 per-连接流字段，不跨流比较） ----
  const guiSeqs = guiEvents.filter((e) => e.type === 'message.new').map((e) => e.seq)
  const headlessSeqs = headlessEvents.filter((e) => e.type === 'message.new').map((e) => e.seq)
  const monotonic = (list) => list.every((s, i) => i === 0 || s > list[i - 1])
  check(
    'SSE seq 逐流单调递增',
    monotonic(guiSeqs) && monotonic(headlessSeqs),
    `gui=${JSON.stringify(guiSeqs)} headless=${JSON.stringify(headlessSeqs)}`
  )

  // ---- AC3：优雅退出（先 headless 后 GUI），且无残留进程 ----
  await rig.gracefullyQuit(headless, 'headless', 3000)
  await rig.gracefullyQuit(gui, 'gui', 6000)
  check('全部节点退出后无残留进程', rig.alivePids().length === 0, JSON.stringify(rig.alivePids()))

  // ---- AC4：同 userData 重启，群与消息仍在 ----
  await rig.waitPortsFree()
  const gui2 = rig.up(GUI, { peers: [] })
  const gui2Health = await rig.waitHealth(rig.portOf(GUI, 'api'), 'gui#2')
  check(
    'AC4 重启拉起的确实是新进程',
    gui2Health.nodeId === guiHealth.nodeId && gui2.pid !== gui.pid,
    `pid ${gui.pid} → ${gui2.pid}`
  )
  check('AC4 重启后身份沿用同一 nodeId', gui2Health.nodeId === guiHealth.nodeId)
  check('AC4 重启后群仍在', gui2Health.groups === 1, `groups=${gui2Health.groups}`)
  const restored = await rig.cdpEvaluate(
    rig.portOf(GUI, 'cdp'),
    `const groups = await window.pantry.listGroups();
     const g = groups.find(x => x.groupId === '${groupId}');
     if (!g) return null;
     const msgs = await window.pantry.pageMessages('group:${groupId}', null, 50);
     return { members: g.members.length, texts: msgs.map(m => m.text) };`
  )
  check('AC4 重启后群成员完整', restored?.members === 2, JSON.stringify(restored?.members))
  check(
    'AC4 重启后两条消息仍存在',
    Boolean(restored) && restored.texts.includes(guiText) && restored.texts.includes(headText),
    JSON.stringify(restored?.texts)
  )

  await rig.gracefullyQuit(gui2, 'gui#2')
  await rig.teardown()
  rig.cleanup()

  console.log(`\n${checker.summary()}`)
  process.exit(checker.failures === 0 ? 0 : 1)
}

main().catch(async (err) => {
  console.error(`\nE2E ERROR: ${err?.stack ?? err}`)
  await rig.teardown().catch(() => undefined)
  rig.cleanup()
  process.exit(1)
})
