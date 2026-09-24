#!/usr/bin/env node
// Hive #52 黑盒 rig：机库（查看成员过程 / 归档 / clear）。
//   node scripts/hive-hangar-e2e.mjs          # dev 构建产物（out/）
//   node scripts/hive-hangar-e2e.mjs --app X.app
//
// 拓扑（真进程，无替身实现）：
//   G = GUI 节点（人，可开独立机库窗口、可 clear 自己的成员）
//   A = headless 成员节点（G 的成员，跑真 runner + 真 fake ACP peer）
//       → @ 一次即产出一次 turn，过程（thought/tool）落本机账本，构成机库数据源
//
// 覆盖：#52 AC1 按成员/会话/turn 的原始时间线 / AC2 过程类型过滤 + 全文搜索（不加工）/
//       AC3 活跃与归档分区（重启后可恢复）/ AC4 clear 归档旧实例并开新实例（目标待人重定）/
//       AC5 headless 不建窗口 + GUI 可开独立机库窗口。
//
// 依赖前置：真节点跑 agent 链路要求 `out/main/acp/runner.mjs` 存在 —— 这正是本票
// 修正的 #46 缺口（构建脚本曾不复制裸 .mjs，任何真节点都拿不到过程数据）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRig, VENDOR } from './lib/hive-rig.mjs'

const argv = process.argv.slice(2)
const appPathRaw = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null
const keep = argv.includes('--keep')

// 四个节点：G（GUI）+ A（headless agent 成员）+ B（headless 第二个成员，验分区隔离）
// + G2（GUI 重启复验，与 G 同 userData 但不同端口 → 单例锁按 userData 隔离，所以 G2 用独立目录）
const PORTS = {
  g: { udp: 17178, tcp: 17179, api: 17190, cdp: 19341 },
  a: { udp: 17278, tcp: 17279, api: 17290 },
  b: { udp: 17378, tcp: 17379, api: 17390 },
  g2: { udp: 17478, tcp: 17479, api: 17490, cdp: 19342 }
}

const rig = createRig({ appPath: appPathRaw ? join(process.cwd(), appPathRaw) : null, ports: PORTS, keep })
const { check, sleep, root, dataDirs } = rig

const FAKE_AGENT = join(VENDOR, 'src', 'main', 'acp', 'fake-acp-agent.mjs')

/** fake agent 走**真 runner + 真 bridge**（与真 adapter 同一契约），只是产出确定性内容。 */
function agentEnv(label, extra = {}) {
  return {
    PANTRY_AGENT_COMMAND: process.execPath,
    PANTRY_AGENT_ARGS: FAKE_AGENT,
    PANTRY_ARTIFACTS_ROOT: join(dataDirs[label], 'artifacts'),
    // clear 的判权读成员主人登记表：路径必须显式给（#53 的同一约定），
    // 否则 MemberRegistry 落到 userData 默认路径而读不到我们预置的那份 → clear 恒被拒。
    PANTRY_MEMBER_REGISTRY: join(dataDirs[label], 'members.json'),
    ...extra
  }
}

/** 成员登记表：A/B 都登记为 G 的成员（clear 的判权依据）。 */
function seedRegistry(label, members) {
  mkdirSync(dataDirs[label], { recursive: true })
  writeFileSync(
    join(dataDirs[label], 'members.json'),
    `${JSON.stringify({ schemaVersion: 1, members }, null, 2)}\n`
  )
}

function seedIdentity(label, nodeId) {
  mkdirSync(dataDirs[label], { recursive: true })
  writeFileSync(
    join(dataDirs[label], 'identity.json'),
    `${JSON.stringify({ nodeId, createdAt: Date.now() }, null, 2)}\n`
  )
}

/** 经 local-api 的机库端点读数据（与 GUI 窗口加载的是同一份页面/端点）。 */
async function hangarOverview(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/hangar/overview`)
  if (!res.ok) throw new Error(`overview ${res.status}`)
  return res.json()
}

async function hangarTimeline(port, query) {
  const params = new URLSearchParams(query)
  const res = await fetch(`http://127.0.0.1:${port}/v1/hangar/timeline?${params}`)
  return { status: res.status, body: res.ok ? await res.json() : await res.json().catch(() => null) }
}

/** 轮询直到 predicate 为真（账本落盘是 append 的，要给一点时间）。 */
async function waitFor(fn, label, timeoutMs = 25000) {
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
  console.log(`rig root: ${root}`)
  rig.assertPortsFree()
  check(
    'AC1 构建产物含 runner 运行时（#46 缺口修正）',
    // 上一版构建不复制裸 .mjs，真节点上 bridge 必报「找不到 runner 入口」。
    existsInOut('acp', 'runner.mjs') && existsInOut('acp', 'fake-acp-agent.mjs'),
    'out/main/acp/{runner.mjs,fake-acp-agent.mjs}'
  )

  // ---------- 起节点 ----------
  seedIdentity('g', 'hive-hangar-g')
  rig.up('g', { cdp: true })
  const hG = await rig.waitHealth(PORTS.g.api, 'G')
  check('AC5 GUI 节点 up（建窗、可开独立窗口）', hG.nodeId === 'hive-hangar-g', JSON.stringify({ ok: hG.ok, peers: hG.peers }))

  seedIdentity('a', 'hive-hangar-a')
  seedRegistry('a', [{ memberId: 'hive-hangar-a', ownerId: 'hive-hangar-g', kind: 'resident' }])
  const a = rig.up('a', { headless: true, peers: [`127.0.0.1:${PORTS.g.udp}`], extraEnv: agentEnv('a') })
  const hA = await rig.waitHealth(PORTS.a.api, 'A')
  check('AC5 headless 成员节点 up 且 agent=on', hA.nodeId === 'hive-hangar-a' && hA.agent === 'on', JSON.stringify({ agent: hA.agent }))
  const aUp = await rig.waitLine(a, (line) => line.includes('[headless] up'), 15000)
  check('AC5 headless 启动自检行可读', Boolean(aUp), aUp ?? '无自检行')

  // ---------- AC5：headless 不创建机库窗口 ----------
  // 经 local-api 的页面必须仍然可读（headless 只是不建窗，不是没有机库）。
  const headlessPage = await fetch(`http://127.0.0.1:${PORTS.a.api}/v1/hangar`)
  const html = await headlessPage.text()
  check('AC5 headless 节点承载机库页面（仅不建窗）', headlessPage.status === 200 && html.includes('机库'), `status=${headlessPage.status}`)

  // ---------- AC1：@ 一次 → 一次 turn → 账本落盘 ----------
  // A 先声明 ag1（无 agent-status 生产者时 caps 里没有该位，A 是可被选的普通成员）。
  const seen = await rig.waitForPeer(PORTS.g.cdp, ['hive-hangar-a'], 40000)
  check('AC1 G 发现成员 A（互见成立）', seen.includes('hive-hangar-a'), JSON.stringify(seen))

  const group = await rig.cdpEvaluate(
    PORTS.g.cdp,
    `const r = await window.pantry.createGroup('机库 rig', ['hive-hangar-a']);
     return r ? r.groupId : null;`
  )
  check('AC1 C2 建群成功（G 与 A 同群）', typeof group === 'string' && group.length > 0, String(group))

  // 等 A 侧看到群（群元数据是单播的）：A 不在群里就收不到那条 @，也就不会有 turn。
  const aGroups = await rig.waitGroupCount(PORTS.a.api, 1, 30000)
  check('AC1 成员 A 已同步到群（否则收不到 @）', aGroups === 1, `A 的群数=${aGroups}`)

  // SSE 必须在发消息**之前**订阅，否则会漏掉这一帧。
  const aEvents = await rig.openSse(PORTS.a.api, 'A')
  await sleep(500)

  const sent = await rig.cdpEvaluate(
    PORTS.g.cdp,
    `const m = await window.pantry.sendGroupText('${group}', '@hive-hangar-a 请汇报一次 turn', ['hive-hangar-a']);
     return m ? m.id : null;`
  )
  check('AC1 派单消息已发（@ 成员）', typeof sent === 'string', String(sent))

  // 账本由 A 的本机进程写；轮询它的机库端点直到出现会话。
  const gotMention = await rig.waitEvent(
    aEvents,
    (ev) => ev.type === 'message.new' && ev.data.senderId === 'hive-hangar-g',
    20000
  )
  check('AC1 成员 A 收到派单消息（@ 到达）', Boolean(gotMention), gotMention ? JSON.stringify(gotMention.data) : JSON.stringify(aEvents.map((e) => e.type)))
  const overviewA = await waitFor(async () => {
    const body = await hangarOverview(PORTS.a.api)
    return body.members.length > 0 && body.totals.activeSessions > 0 ? body : null
  }, 'A 的机库出现活跃会话', 40000)

  const memberA = overviewA.members.find((m) => m.memberId === 'hive-hangar-a')
  check('AC1 机库按成员列出账本', Boolean(memberA), JSON.stringify(overviewA.members.map((m) => m.memberId)))
  check('AC1 成员下按会话分组', memberA.sessions.length >= 1, `会话数=${memberA.sessions.length}`)
  const session = memberA.sessions[0]
  check('AC1 会话带 turn 计数与结束原因', session.turns >= 1 && session.stopReason === 'end_turn', JSON.stringify({ turns: session.turns, stopReason: session.stopReason }))

  // ---------- AC1：随机 turn 分组（原始时间线） ----------
  const tl = await hangarTimeline(PORTS.a.api, { memberId: 'hive-hangar-a', sessionId: session.sessionId })
  check('AC1 时间线端点可读该会话', tl.status === 200 && Array.isArray(tl.body.entries), `status=${tl.status}`)
  const entries = tl.body.entries ?? []
  check('AC1 时间线含 turn 结算行（turn 分组判据）', entries.some((e) => e.kind === 'turn'), JSON.stringify(entries.map((e) => e.kind)))
  check('AC1 时间线含入向派单原文', entries.some((e) => e.kind === 'inbound'), '')
  check('AC1 时间线含出向 prompt', entries.some((e) => e.kind === 'outbound'), '')
  const turnEntry = entries.find((e) => e.kind === 'turn')
  check('AC1 turn 结算行含 stopReason', turnEntry?.data?.stopReason === 'end_turn', JSON.stringify(turnEntry?.data))

  // ---------- AC2：过程类型过滤（不加工、不总结） ----------
  const processEntry = await waitFor(async () => {
    const r = await hangarTimeline(PORTS.a.api, {
      memberId: 'hive-hangar-a',
      kinds: 'agent_thought_chunk'
    })
    return (r.body.entries ?? []).length > 0 ? r.body.entries : null
  }, 'thought 过程进入账本', 30000)
  check('AC2 按过程类型（agent_thought_chunk）过滤命中', processEntry.length > 0, `条数=${processEntry.length}`)
  check(
    'AC2 过滤结果只含该类型',
    processEntry.every((e) => e.data?.sessionUpdate === 'agent_thought_chunk'),
    JSON.stringify([...new Set(processEntry.map((e) => e.data?.sessionUpdate))])
  )

  const toolOnly = await hangarTimeline(PORTS.a.api, { memberId: 'hive-hangar-a', kinds: 'tool_call' })
  check('AC2 换一个过程类型（tool_call）同样可过滤', (toolOnly.body.entries ?? []).length > 0, `条数=${(toolOnly.body.entries ?? []).length}`)

  const formalOnly = await hangarTimeline(PORTS.a.api, { memberId: 'hive-hangar-a', kinds: 'agent_message_chunk' })
  check(
    'AC2 正式消息增量与过程可分辨（类型过滤不混淆）',
    (formalOnly.body.entries ?? []).every((e) => e.data?.sessionUpdate === 'agent_message_chunk'),
    `条数=${(formalOnly.body.entries ?? []).length}`
  )

  // ---------- AC2：全文搜索（匹配原始行，不加工） ----------
  const needle = 'fake ACP peer 已收到派单'
  const search = await hangarTimeline(PORTS.a.api, { memberId: 'hive-hangar-a', q: needle })
  check('AC2 全文搜索命中原始过程内容', (search.body.entries ?? []).length > 0, `条数=${(search.body.entries ?? []).length}`)

  const miss = await hangarTimeline(PORTS.a.api, { memberId: 'hive-hangar-a', q: 'zzz-绝不可能出现的串-zzz' })
  check('AC2 全文搜索无命中时返回空（不伪造）', (miss.body.entries ?? []).length === 0, `条数=${(miss.body.entries ?? []).length}`)

  const badMember = await hangarTimeline(PORTS.a.api, { memberId: 'no-such-member' })
  check('AC2 未知成员显式 404（不假装空机库）', badMember.status === 404, `status=${badMember.status}`)

  // Markdown 人类可读时间线（turn 结算时写）。
  const md = await fetch(
    `http://127.0.0.1:${PORTS.a.api}/v1/hangar/markdown?memberId=hive-hangar-a&sessionId=${encodeURIComponent(session.sessionId)}`
  )
  const mdText = await md.text()
  check('AC1 Markdown 时间线可读（人类可读视图）', md.status === 200 && mdText.includes('会话时间线'), `status=${md.status}`)

  // ---------- AC3：活跃 / 归档分区 ----------
  check('AC3 clear 前该会话在活跃区', session.archive === null, JSON.stringify(session.archive))

  // ---------- AC4：clear —— 旧实例归档 + 同位置新实例 + 目标待人重定 ----------
  // clear 必须落在**账本所在节点**（归档索引与账本同机，见 docs/local-api.md），
  // 即成员 A 自己的进程；`actorId` 声明为主人 G（A 的登记表登记 G 为 owner）。
  // 先证伪：非主人发起必须被拒（fail-closed）。
  const denied = await fetch(`http://127.0.0.1:${PORTS.a.api}/v1/hangar/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: 'hive-hangar-a', actorId: 'hive-hangar-nobody' })
  })
  check('AC4 非主人 clear 被拒（403 + 显式理由）', denied.status === 403, `status=${denied.status}`)

  const clearRes = await fetch(`http://127.0.0.1:${PORTS.a.api}/v1/hangar/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: 'hive-hangar-a', actorId: 'hive-hangar-g' })
  })
  const clearResult = await clearRes.json()
  check('AC4 clear 被接受（主人发起）', clearRes.status === 200 && clearResult?.ok === true, JSON.stringify(clearResult))
  check('AC4 clear 归档了旧实例的会话', (clearResult?.archived ?? []).length >= 1, JSON.stringify(clearResult?.archived))
  check('AC4 clear 后目标待人重定（goalPending=true）', clearResult?.goalPending === true, JSON.stringify(clearResult?.goalPending))
  check('AC4 clear 后实例纪元递增到 2', clearResult?.epoch === 2, `epoch=${clearResult?.epoch}`)

  const afterClear = await hangarOverview(PORTS.a.api)
  const memberAfter = afterClear.members.find((m) => m.memberId === 'hive-hangar-a')
  check('AC4 身份沿用（成员行仍在）', Boolean(memberAfter), JSON.stringify(afterClear.members.map((m) => m.memberId)))
  check('AC4 旧会话已离开活跃区', memberAfter.sessions.every((s) => s.sessionId !== session.sessionId), JSON.stringify(memberAfter.sessions.map((s) => s.sessionId)))
  check('AC4 目标为未定 + pending 标记', memberAfter.instance.goal === null && memberAfter.instance.goalPending === true, JSON.stringify(memberAfter.instance))

  // 归档区读得到旧会话（数据仍在本机、可读可搜）。
  const archivedTimeline = await hangarTimeline(PORTS.a.api, { memberId: 'hive-hangar-a', sessionId: session.sessionId })
  check('AC3 归档会话仍可读（不删数据）', archivedTimeline.status === 200 && (archivedTimeline.body.entries ?? []).length > 0, `条数=${(archivedTimeline.body.entries ?? []).length}`)

  // 跨节点隔离：G 自己的账本里没有 A 的会话（成员账本归成员所在机器）。
  const overviewG = await hangarOverview(PORTS.g.api)
  check(
    'AC1 机库是本机 per-member 账本（不是群级历史回放）',
    !overviewG.members.some((m) => m.memberId === 'hive-hangar-a'),
    JSON.stringify(overviewG.members.map((m) => m.memberId))
  )

  // ---------- AC5：GUI 可开独立机库窗口 ----------
  const opened = await rig.cdpEvaluate(PORTS.g.cdp, `return await window.pantry.openHangar();`)
  check('AC5 GUI 打开独立机库窗口成功', opened?.ok === true, JSON.stringify(opened))
  check('AC5 窗口地址指向 local-api 的机库页面', typeof opened?.url === 'string' && opened.url.includes('/v1/hangar'), String(opened?.url))

  // 真窗口存在（CDP target 里能看到第二个 page）。
  const targets = await (await fetch(`http://127.0.0.1:${PORTS.g.cdp}/json/list`)).json()
  const hangarTarget = targets.find((t) => t.type === 'page' && String(t.url).includes('/v1/hangar'))
  check('AC5 独立窗口是真 BrowserWindow（CDP 可见）', Boolean(hangarTarget), JSON.stringify(targets.map((t) => t.url)))

  // headless 侧同一命令必须被显式拒绝（不静默，也不建窗）。
  const headlessOpen = await fetch(`http://127.0.0.1:${PORTS.a.api}/v1/hangar/overview`)
  check('AC5 headless 仍可读机库数据（只是不建窗）', headlessOpen.status === 200, `status=${headlessOpen.status}`)

  // ---------- AC3：重启后可恢复 ----------
  // A 的机库数据在它自己的 artifacts 目录里；重启 A 后归档分区与索引必须还在。
  await rig.gracefullyQuit(a, 'A', 4000).catch(() => undefined)
  await sleep(500)
  const a2 = rig.up('a', { headless: true, peers: [`127.0.0.1:${PORTS.g.udp}`], extraEnv: agentEnv('a') })
  await rig.waitHealth(PORTS.a.api, 'A#2')
  await rig.waitLine(a2, (line) => line.includes('[headless] up'), 15000)
  check('AC3 重启后无残留进程', rig.alivePids().length >= 1, JSON.stringify(rig.alivePids()))
  const reopened = await waitFor(async () => {
    const body = await hangarOverview(PORTS.a.api)
    return body.members.length > 0 ? body : null
  }, 'A 重启后机库索引恢复', 30000)
  const memberReopened = reopened.members.find((m) => m.memberId === 'hive-hangar-a')
  check('AC3 重启后归档分区恢复（旧会话仍在归档）', memberReopened !== undefined, JSON.stringify(reopened.members.map((m) => m.memberId)))
  check(
    'AC3 重启后实例纪元恢复（不回到 epoch=1）',
    memberReopened?.instance.epoch === 2,
    `epoch=${memberReopened?.instance.epoch}`
  )
  const recoveredTimeline = await hangarTimeline(PORTS.a.api, { memberId: 'hive-hangar-a', sessionId: session.sessionId })
  check('AC3 重启后归档会话内容仍可读', (recoveredTimeline.body.entries ?? []).length > 0, `条数=${(recoveredTimeline.body.entries ?? []).length}`)

  console.log(`\n${rig.checker.summary()}`)
  await teardownAll()
  process.exit(rig.checker.failures === 0 ? 0 : 1)
}

function existsInOut(...segments) {
  try {
    return readFileSync(join(VENDOR, 'out', 'main', ...segments)).length > 0
  } catch {
    return false
  }
}

async function teardownAll() {
  await rig.teardown().catch(() => undefined)
  rig.cleanup()
}

main().catch(async (err) => {
  console.error(`\nE2E ERROR: ${err?.stack ?? err}`)
  await teardownAll().catch(() => undefined)
  process.exit(1)
})
