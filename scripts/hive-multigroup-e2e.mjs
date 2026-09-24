#!/usr/bin/env node
// Hive #45 端到端 rig：一个 APP 内的多群 —— 创建、GUI 切换、群间不串流、重启全量恢复。
//   node scripts/hive-multigroup-e2e.mjs                # 用 dev 构建产物（out/）
//   node scripts/hive-multigroup-e2e.mjs --app <X.app>  # 用打包 .app
//
// 覆盖 #45 的四条 AC：
//   AC1 可从 GUI 创建至少两个群并在群列表中切换
//   AC2 不同群的成员和消息不会串流
//   AC3 重启 APP 后多个群及其消息完整恢复
//   AC4 群、身份、成员和消息继续使用 teahouse 的权威模型与存储
//
// 拓扑：一个 GUI 节点（owner）+ 两个 headless 成员节点（agent-a / agent-b）。
// GUI 建 groupA（含 agent-a）与 groupB（含 agent-b）；每个 headless 只该看到自己被邀请的那个群。
//
// 群列表 / 切换 / 服务端隔离走 CDP 驱动真 renderer 与真 IPC 面；AC2 另有一组纯 UI 断言：
// 真点「发送」按钮、读真消息 DOM，证明人可见的那一层也不串流。AC4 直查 teahouse SQLite。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRig } from './lib/hive-rig.mjs'

const argv = process.argv.slice(2)
const appPath = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null
const keep = argv.includes('--keep')

// 三节点端口全独立（GUI 带 CDP，供真 UI 断言用）。
const PORTS = {
  gui: { udp: 31878, tcp: 31879, api: 31890, cdp: 31333 },
  'agent-a': { udp: 21878, tcp: 21879, api: 21890 },
  'agent-b': { udp: 12878, tcp: 12879, api: 12890 }
}

const rig = createRig({ appPath, ports: PORTS, keep })
const { check, checker } = rig
const GUI = 'gui'
const A = 'agent-a'
const B = 'agent-b'
const cdp = () => rig.portOf(GUI, 'cdp')
const apiOf = (label) => rig.portOf(label, 'api')

/** GUI 侧 app 数据库 = teahouse 权威存储（AC4 直查上游表）。多语句用 `-json` 逐条跑再合并。 */
function readAppDb(dataDir, statements) {
  const dbPath = join(dataDir, 'data', 'db', 'chat.db')
  const out = statements.map((sql) => {
    const raw = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim()
    return raw ? JSON.parse(raw)[0] : null
  })
  return out
}

/** 从 DOM 读当前消息区里的气泡正文（人真正能看到的那一层）。 */
const READ_BUBBLES = `
  const root = document.querySelector('.msgs .msgs-content');
  if (!root) return null;
  return [...root.querySelectorAll('.row .bubble')].map(el => el.textContent.trim());
`

/**
 * 点会话列表里名字含 `name` 的那一项。**不 return** —— 它是可拼接的语句片段。
 *
 * `via`（另一个会话名）用来强制一次真实切换：如果目标已是选中项，先点 `via` 再点回来。
 * renderer 只在「打开会话」时从库里拉最新一页；经 CDP 直连 `sendGroupText` 发出的消息
 * 不会进 renderer 缓存（只有 UI 自己的发送路径会本地追加）。已选中就跳过点击，读到的是
 * 陈旧缓存 —— 那是读法问题，会伪装成串流/丢消息。
 */
const clickConv = (name, via = null) => `
  const btns = [...document.querySelectorAll('.conv-list .conv')];
  const target = btns.find(el => el.textContent.includes(${JSON.stringify(name)}));
  if (!target) return null;
  if (target.classList.contains('active') && ${via ? 'true' : 'false'}) {
    const other = btns.find(el => el.textContent.includes(${JSON.stringify(via)}));
    if (other) {
      other.click();
      await new Promise(r => setTimeout(r, 500));
    }
  }
  if (!target.classList.contains('active')) {
    target.click();
    await new Promise(r => setTimeout(r, 700));
  }
`

/** 读当前选中会话 + 头部标题（配合 clickConv 用）。 */
const READ_ACTIVE_CONV = `
  const active = document.querySelector('.conv-list .conv.active');
  const title = document.querySelector('.head .title-text .title, .head .title');
  return { active: active ? active.textContent.trim() : '', title: title ? title.textContent.trim() : '' };
`

async function main() {
  rig.assertPortsFree()
  console.log(`可执行文件：${rig.exe}${appPath ? '（打包 .app）' : '（dev out/）'}`)
  console.log(`数据根：${rig.root}`)

  const gui = rig.up(GUI, { peers: [`127.0.0.1:${rig.portOf(A, 'udp')}`, `127.0.0.1:${rig.portOf(B, 'udp')}`] })
  const a = rig.up(A, { peers: [`127.0.0.1:${rig.portOf(GUI, 'udp')}`], headless: true })
  const b = rig.up(B, { peers: [`127.0.0.1:${rig.portOf(GUI, 'udp')}`], headless: true })

  const guiHealth = await rig.waitHealth(apiOf(GUI), 'gui')
  const aHealth = await rig.waitHealth(apiOf(A), A)
  const bHealth = await rig.waitHealth(apiOf(B), B)
  check('三个节点身份互不相同', new Set([guiHealth.nodeId, aHealth.nodeId, bHealth.nodeId]).size === 3)
  check('三个节点的 userData 各自独立', new Set(Object.values(rig.dataDirs)).size === 3)

  // 互见：GUI 要看到两个成员，否则建群时选不到人。
  const seen = await rig.waitForPeer(cdp(), [aHealth.nodeId, bHealth.nodeId])
  check(
    'GUI 同时找到 agent-a 与 agent-b',
    seen.includes(aHealth.nodeId) && seen.includes(bHealth.nodeId),
    JSON.stringify(seen)
  )

  const aEvents = await rig.openSse(apiOf(A), A)
  const bEvents = await rig.openSse(apiOf(B), B)

  // ---- AC1：GUI 建两个群，成员各不相同 ----
  const groups = await rig.cdpEvaluate(
    cdp(),
    `const s = await window.pantry.saveProfile({ nick: 'Hive GUI multi', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
     if (!s.setupDone) throw new Error('setupDone 未置位');
     const ga = await window.pantry.createGroup('hive-群A', ['${aHealth.nodeId}']);
     const gb = await window.pantry.createGroup('hive-群B', ['${bHealth.nodeId}']);
     if (!ga || !gb) throw new Error('建群失败');
     return { a: ga.groupId, b: gb.groupId, aName: ga.name, bName: gb.name, aMembers: ga.members, bMembers: gb.members };`
  )
  check('AC1 从 GUI 创建两个不同的群', Boolean(groups?.a && groups?.b) && groups.a !== groups.b, JSON.stringify(groups))
  check(
    'AC1 两个群成员互不相同',
    groups.aMembers.includes(aHealth.nodeId) && !groups.aMembers.includes(bHealth.nodeId) &&
      groups.bMembers.includes(bHealth.nodeId) && !groups.bMembers.includes(aHealth.nodeId),
    `A=${JSON.stringify(groups.aMembers)} B=${JSON.stringify(groups.bMembers)}`
  )

  const listed = await rig.cdpEvaluate(
    cdp(),
    `const gs = await window.pantry.listGroups();
     const convs = await window.pantry.listConversations();
     const domNames = [...document.querySelectorAll('.conv-list .conv .conv-name')]
       .map(el => el.textContent.replace(/置顶|静音/g, '').trim());
     return {
       groupIds: gs.map(g => g.groupId),
       convIds: convs.map(c => c.id).filter(id => id.startsWith('group:')),
       domNames
     };`
  )
  check(
    'AC1 群列表里有两个群',
    listed.groupIds.includes(groups.a) && listed.groupIds.includes(groups.b),
    JSON.stringify(listed.groupIds)
  )
  check(
    'AC1 两个群的会话都进了会话列表',
    listed.convIds.includes(`group:${groups.a}`) && listed.convIds.includes(`group:${groups.b}`),
    JSON.stringify(listed.convIds)
  )
  check(
    'AC1 会话列表 UI 渲染出两个群名',
    listed.domNames.includes(groups.aName) && listed.domNames.includes(groups.bName),
    JSON.stringify(listed.domNames)
  )

  const switchedA = await rig.waitCdp(
    cdp(),
    `${clickConv(groups.aName)}${READ_ACTIVE_CONV}`,
    (v) => v != null && v.active.includes('群A'),
    '切到群A'
  )
  check('AC1 点群A后该会话选中、头部标题切到群A', switchedA.title.includes(groups.aName), JSON.stringify(switchedA))
  const switchedB = await rig.waitCdp(
    cdp(),
    `${clickConv(groups.bName)}${READ_ACTIVE_CONV}`,
    (v) => v != null && v.active.includes('群B'),
    '切到群B'
  )
  check('AC1 点群B后该会话选中、头部标题切到群B', switchedB.title.includes(groups.bName), JSON.stringify(switchedB))

  // ---- AC2：两个群各自收发，消息不串流 ----
  const textA = `群A的消息 ${Date.now()}`
  const textA2 = `群A的第二条 ${Date.now()}`
  const textB = `群B的消息 ${Date.now()}`

  const sendVia = (groupId, text, mention) =>
    rig.cdpEvaluate(
      cdp(),
      `const m = await window.pantry.sendGroupText('${groupId}', ${JSON.stringify(text)}${mention ? `, ['${mention}']` : ''});
       return m ? m.text : null;`
    )
  check('AC2 向群A发消息成功', (await sendVia(groups.a, textA, aHealth.nodeId)) === textA)
  check('AC2 向群B发消息成功', (await sendVia(groups.b, textB, bHealth.nodeId)) === textB)

  // 成员隔离：agent-a 只该收到群A那条，agent-b 只该收到群B那条。
  const aGot = await rig.waitEvent(aEvents, (e) => e.type === 'message.new' && e.data.text === textA)
  check('AC2 agent-a 收到群A消息', Boolean(aGot), aGot ? JSON.stringify(aGot.data) : '未收到')
  const aLeak = aEvents.find((e) => e.data?.text === textB)
  check('AC2 agent-a 没有收到群B消息（成员不串流）', !aLeak, aLeak ? JSON.stringify(aLeak.data) : '')

  const bGot = await rig.waitEvent(bEvents, (e) => e.type === 'message.new' && e.data.text === textB)
  check('AC2 agent-b 收到群B消息', Boolean(bGot), bGot ? JSON.stringify(bGot.data) : '未收到')
  const bLeak = bEvents.find((e) => e.data?.text === textA)
  check('AC2 agent-b 没有收到群A消息（成员不串流）', !bLeak, bLeak ? JSON.stringify(bLeak.data) : '')

  // 每个成员各自按自己的 groupId 回执，回流不串群。
  const backA = `A回执 ${Date.now()}`
  const backB = `B回执 ${Date.now()}`
  const reply = async (label, port, groupId, text) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ groupId, text })
    })
    check(`AC2 ${label} 回执被接受`, res.status === 200, `status=${res.status}`)
  }
  await reply(A, apiOf(A), groups.a, backA)
  await reply(B, apiOf(B), groups.b, backB)

  const perGroup = await rig.waitCdp(
    cdp(),
    `const a = (await window.pantry.pageMessages('group:${groups.a}', null, 50)).map(m => m.text);
     const b = (await window.pantry.pageMessages('group:${groups.b}', null, 50)).map(m => m.text);
     return { a, b };`,
    (v) => v?.a?.includes(`${backA}`) && v?.b?.includes(`${backB}`),
    '两侧回执都到 GUI'
  )
  check(
    'AC2 群A会话只含群A消息',
    perGroup.a.includes(textA) && perGroup.a.includes(backA) && !perGroup.a.includes(textB),
    JSON.stringify(perGroup.a)
  )
  check(
    'AC2 群B会话只含群B消息',
    perGroup.b.includes(textB) && perGroup.b.includes(backB) && !perGroup.b.includes(textA),
    JSON.stringify(perGroup.b)
  )

  // UI 层隔离：切换会话，读真 DOM。先在群B里用界面「发送」按钮手打一条。
  await sendVia(groups.a, textA2)
  const textB2 = `群B的手打消息 ${Date.now()}`
  const typed = await rig.waitCdp(
    cdp(),
    `${clickConv(groups.bName)}
     const ta = document.querySelector('.chat textarea.input');
     const btn = document.querySelector('.chat button.send');
     if (!ta || !btn) return null;
     const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
     setter.call(ta, ${JSON.stringify(textB2)});
     ta.dispatchEvent(new Event('input', { bubbles: true }));
     await new Promise(r => setTimeout(r, 200));
     if (btn.disabled) return null;
     btn.click();
     await new Promise(r => setTimeout(r, 900));
     return { sent: true };`,
    (v) => v?.sent === true,
    '在群B用发送按钮发出消息'
  )
  check('AC2 在群B里用界面「发送」按钮发出消息', typed?.sent === true)

  const bubblesB = await rig.waitCdp(
    cdp(),
    // 从群A切回群B，强制重载群B的最新一页（已选中时直接读会拿到陈旧缓存）。
    `${clickConv(groups.bName, groups.aName)}${READ_BUBBLES}`,
    (v) => v != null && v.includes(textB2) && v.includes(textB),
    '群B消息区渲染'
  )
  check(
    'AC2 UI 消息流：群B只显示群B的消息',
    bubblesB.includes(textB) && bubblesB.includes(textB2) && !bubblesB.some((t) => t.includes('群A的')),
    JSON.stringify(bubblesB)
  )

  const bubblesA = await rig.waitCdp(
    cdp(),
    `${clickConv(groups.aName, groups.bName)}${READ_BUBBLES}`,
    (v) => v != null && v.includes(textA2),
    '群A消息区渲染'
  )
  check(
    'AC2 UI 消息流：群A只显示群A的消息',
    bubblesA.includes(textA) && bubblesA.includes(textA2) && bubblesA.includes(backA) &&
      !bubblesA.some((t) => t.includes('群B的')),
    JSON.stringify(bubblesA)
  )

  // 成员侧：每个 headless 只该看到自己被邀请的那个群（群元数据由 GUI 单播，需要等同步到位）。
  const aGroups = await rig.waitGroupCount(apiOf(A), 1)
  check('AC2 agent-a 只在自己被邀请的那个群里', aGroups === 1, `groups=${aGroups}`)
  const bGroups = await rig.waitGroupCount(apiOf(B), 1)
  check('AC2 agent-b 只在自己被邀请的那个群里', bGroups === 1, `groups=${bGroups}`)

  // ---- AC4：权威模型与存储（重启前先直查上游库） ----
  const [beforeGroups, bA, bB] = readAppDb(rig.dataDirs[GUI], [
    `SELECT COUNT(*) AS n FROM groups`,
    `SELECT members FROM groups WHERE group_id='${groups.a}'`,
    `SELECT members FROM groups WHERE group_id='${groups.b}'`
  ])
  check('AC4 上游 groups 表存了两个群', beforeGroups.n === 2, JSON.stringify(beforeGroups))
  const membersA = JSON.parse(bA.members)
  const membersB = JSON.parse(bB.members)
  check(
    'AC4 群成员按 teahouse 权威模型落库且各自独立',
    membersA.includes(aHealth.nodeId) && !membersA.includes(bHealth.nodeId) &&
      membersB.includes(bHealth.nodeId) && !membersB.includes(aHealth.nodeId),
    `A=${bA.members} B=${bB.members}`
  )
  const identity = JSON.parse(readFileSync(join(rig.dataDirs[GUI], 'identity.json'), 'utf8'))
  check('AC4 身份来自 teahouse identity.json 且与 health 一致', identity.nodeId === guiHealth.nodeId)

  // ---- AC3：重启。杀全部节点，用同一 userData 重开 GUI ----
  await rig.gracefullyQuit(a, 'agent-a')
  await rig.gracefullyQuit(b, 'agent-b')
  await rig.gracefullyQuit(gui, 'gui')
  check('全部节点退出后无残留进程', rig.alivePids().length === 0, JSON.stringify(rig.alivePids()))
  await rig.waitPortsFree()

  const beforePid = gui.pid
  const gui2 = rig.up(GUI, { peers: [] })
  const gui2Health = await rig.waitHealth(apiOf(GUI), 'gui#2')
  check('AC3 重启拉起的是新进程', gui2.pid !== beforePid, `pid ${beforePid} → ${gui2.pid}`)
  check('AC3 重启后身份沿用同一 nodeId', gui2Health.nodeId === guiHealth.nodeId)
  check('AC3 重启后两个群都在', gui2Health.groups === 2, `groups=${gui2Health.groups}`)

  // 重启后 renderer 要等 store init 才把会话列表画出来；DOM 那一项轮询等，别一把梭。
  const READ_RESTORED = `
     const gs = await window.pantry.listGroups();
     const a = gs.find(g => g.groupId === '${groups.a}');
     const b = gs.find(g => g.groupId === '${groups.b}');
     const ma = (await window.pantry.pageMessages('group:${groups.a}', null, 50)).map(m => m.text);
     const mb = (await window.pantry.pageMessages('group:${groups.b}', null, 50)).map(m => m.text);
     const domNames = [...document.querySelectorAll('.conv-list .conv .conv-name')]
       .map(el => el.textContent.replace(/置顶|静音/g, '').trim());
     return {
       count: gs.length,
       membersA: a ? a.members.length : -1,
       membersB: b ? b.members.length : -1,
       ma, mb, domNames
     };`
  const restored = await rig.waitCdp(
    cdp(),
    READ_RESTORED,
    (v) => v?.domNames?.includes(`${groups.aName}`) && v?.domNames?.includes(`${groups.bName}`),
    '重启后群列表重新渲染'
  )
  check('AC3 重启后群列表仍是两个群', restored.count === 2, JSON.stringify(restored))
  check('AC3 重启后群成员完整恢复', restored.membersA === 2 && restored.membersB === 2, `A=${restored.membersA} B=${restored.membersB}`)
  check(
    'AC3 重启后群A消息完整恢复',
    restored.ma.length === 3 && restored.ma.includes(textA) && restored.ma.includes(textA2) && restored.ma.includes(backA),
    JSON.stringify(restored.ma)
  )
  check(
    'AC3 重启后群B消息完整恢复',
    restored.mb.length === 3 && restored.mb.includes(textB) && restored.mb.includes(backB) && restored.mb.includes(textB2),
    JSON.stringify(restored.mb)
  )
  check(
    'AC3 重启后消息仍未串群',
    !restored.ma.some((t) => t.includes('群B的')) && !restored.mb.some((t) => t.includes('群A的')),
    `A=${JSON.stringify(restored.ma)} B=${JSON.stringify(restored.mb)}`
  )
  check(
    'AC3 重启后会话列表 UI 仍渲染两个群',
    restored.domNames.includes(groups.aName) && restored.domNames.includes(groups.bName),
    JSON.stringify(restored.domNames)
  )

  // 恢复出来的群要能继续用，不是只读快照。
  const afterRestart = `重启后群B ${Date.now()}`
  check('AC3 重启后群仍可继续发送', (await sendVia(groups.b, afterRestart)) === afterRestart)

  const [afterGroups, afterMsgsB] = readAppDb(rig.dataDirs[GUI], [
    `SELECT COUNT(*) AS n FROM groups`,
    `SELECT COUNT(*) AS n FROM messages WHERE conv_id='group:${groups.b}'`
  ])
  check('AC4 重启后权威存储里群数仍是 2', afterGroups.n === 2, JSON.stringify(afterGroups))
  // 重启前群B有 3 条（textB / backB / textB2），重启后又发了 1 条。
  check('AC4 重启后新消息继续落上游 messages 表', afterMsgsB.n === 4, JSON.stringify(afterMsgsB))

  // ---- AC1 收口：走**真 UI** 建第三个群（点 + → 选人 → 下一步 → 组名 → 创建） ----
  // 前面的建群走 window.pantry IPC 面（快且稳），但 AC1 说的是「可从 GUI 创建」，
  // 所以这里补一条纯界面路径，证明人真的点得出来。
  const groupCName = `hive-群C-UI ${Date.now()}`
  const uiCreated = await rig.waitCdp(
    cdp(),
    `const openBtn = document.querySelector('.new-group');
     if (!openBtn) return null;
     openBtn.click();
     await new Promise(r => setTimeout(r, 600));
     const dialog = document.querySelector('[role="dialog"][aria-label="发起讨论组"]');
     if (!dialog) return null;
     const box = dialog.querySelector('.pick input[type="checkbox"]');
     if (!box) return null;
     if (!box.checked) { box.click(); await new Promise(r => setTimeout(r, 300)); }
     const next = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === '下一步');
     if (!next || next.disabled) return null;
     next.click();
     await new Promise(r => setTimeout(r, 500));
     const nameInput = document.getElementById('group-name');
     if (!nameInput) return null;
     const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
     setter.call(nameInput, ${JSON.stringify(groupCName)});
     nameInput.dispatchEvent(new Event('input', { bubbles: true }));
     await new Promise(r => setTimeout(r, 250));
     const create = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === '创建');
     if (!create || create.disabled) return null;
     create.click();
     await new Promise(r => setTimeout(r, 1200));
     const gs = await window.pantry.listGroups();
     const made = gs.find(g => g.name === ${JSON.stringify(groupCName)});
     const domNames = [...document.querySelectorAll('.conv-list .conv .conv-name')]
       .map(el => el.textContent.replace(/置顶|静音/g, '').trim());
     return made ? { groupId: made.groupId, members: made.members.length, domNames } : null;`,
    (v) => v != null && v.groupId,
    '用界面建第三个群'
  )
  check('AC1 走真界面（+ → 选人 → 下一步 → 创建）建出第三个群', Boolean(uiCreated?.groupId), JSON.stringify(uiCreated))
  check('AC1 界面建的群立刻出现在群列表 UI 里', uiCreated.domNames.includes(groupCName), JSON.stringify(uiCreated.domNames))
  check('AC1 界面建的群成员 = 我 + 1 个成员', uiCreated.members === 2, `members=${uiCreated.members}`)

  const uiText = `界面建的群 ${Date.now()}`
  check('AC1 界面建的群可继续发消息', (await sendVia(uiCreated.groupId, uiText)) === uiText)

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
