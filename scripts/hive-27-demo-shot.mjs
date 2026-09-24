// Hive #27 演示截图（黑客松验收用，一次性脚本）：
// 起 GUI + 1 个 headless agent 节点 → 建群 → 打开群会话 → 截三栏 + 横幅 + 右栏 + 五档点。
// 底层与 hive-snapshot.mjs 同款：createRig + CDP Page.captureScreenshot。
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRig } from './lib/hive-rig.mjs'

const OUT = join(process.cwd(), 'docs/demo/snapshots')
const GUI = { udp: 32878, tcp: 32879, api: 32890, cdp: 32881 }
const AGENT = { udp: 22878, tcp: 22879, api: 22890 }

const rig = createRig({ ports: { gui: GUI, agent: AGENT }, keep: false })
const cdpPort = () => rig.portOf('gui', 'cdp')
const apiOf = (label) => rig.portOf(label, 'api')

/** 一次性 CDP 连接（照抄 hive-snapshot.mjs 的 withCdp）。 */
async function withCdp(fn) {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort()}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('CDP 没有可用的 page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    entry.resolve(msg)
  })
  const call = (method, params) =>
    new Promise((res, rej) => {
      const myId = ++id
      pending.set(myId, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id: myId, method, params }))
      setTimeout(() => {
        if (pending.delete(myId)) rej(new Error(`CDP ${method} 超时`))
      }, 30000)
    })
  try {
    return await fn(call)
  } finally {
    ws.close()
  }
}

async function capture() {
  return withCdp(async (call) => {
    const res = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    if (res.error) throw new Error(`captureScreenshot 失败：${res.error.message}`)
    return Buffer.from(res.result.data, 'base64')
  })
}

async function main() {
  rig.seedConfig('gui', { nick: 'Hive-GUI', setupDone: true, theme: 'dark' })
  // 直接改 config.json 兜底（与 hive-snapshot.mjs 同策略：稳定可复现的初始态）
  const cfgPath = join(rig.dataDirs['gui'], 'config.json')
  const config = JSON.parse(readFileSync(cfgPath, 'utf8'))
  config.setupDone = true
  config.theme = 'dark'
  writeFileSync(cfgPath, `${JSON.stringify(config, null, 2)}\n`)
  rig.seedConfig('agent', { nick: 'agent-blue' })
  const guiChild = rig.up('gui', { peers: ['agent'] })
  const agentChild = rig.up('agent', { peers: ['127.0.0.1'], headless: true })
  void agentChild
  try {
    await rig.waitLine(guiChild, (l) => l.includes('[local-api]'), 60000)
    await rig.waitCdp(cdpPort(), 'return document.readyState', (v) => v === 'complete', 'readyState', 60000)
    await new Promise((r) => setTimeout(r, 5000))

    const agentHealth = await rig.waitHealth(apiOf('agent'), 'agent')
    const cdpEval = (expr) => rig.cdpEvaluate(cdpPort(), expr)

    // 建群（GUI + agent 两人群，名字对齐设计稿的 launch-plan 频道）
    await cdpEval(
      `await window.pantry.saveProfile({ nick: 'Hive-GUI', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
       const g = await window.pantry.createGroup('launch-plan', ['${agentHealth.nodeId}']);
       if (!g) throw new Error('建群失败');
       return g.groupId;`
    )
    console.log('PASS 建群 launch-plan')

    // 打开群会话（走真 UI 点击）
    const opened = await cdpEval(
      `await new Promise(r => setTimeout(r, 1500));
       const btns = [...document.querySelectorAll('.conv-list .conv')];
       const target = btns.find(el => el.textContent.includes('launch-plan'));
       if (!target) return 'conv-not-found:' + btns.length;
       target.click();
       await new Promise(r => setTimeout(r, 1500));
       return true;`
    )
    if (opened !== true) throw new Error(`打开会话失败：${opened}`)
    console.log('PASS 打开群会话')

    // 结构探针：三栏 + 横幅 + 右栏 + 状态点
    const probe = await cdpEval(
      `return {
         banner: !!document.querySelector('.conv-banner'),
         bannerH: Math.round(document.querySelector('.conv-banner')?.getBoundingClientRect().height ?? 0),
         details: !!document.querySelector('.details'),
         detailsW: Math.round(document.querySelector('.details')?.getBoundingClientRect().width ?? 0),
         listW: Math.round(document.querySelector('.list')?.getBoundingClientRect().width ?? 0),
         railW: Math.round(document.querySelector('.rail')?.getBoundingClientRect().width ?? 0),
         burdenDots: document.querySelectorAll('.burden-dot').length,
         detailSections: document.querySelectorAll('.details section').length
       };`
    )
    console.log('PASS 结构探针', JSON.stringify(probe))

    mkdirSync(OUT, { recursive: true })
    const png = await capture()
    const file = join(OUT, 'hive-27-three-column.png')
    writeFileSync(file, png)
    console.log(`PASS 截图 → ${file}（${png.length} 字节）`)
  } finally {
    await rig.teardown()
    rig.cleanup()
  }
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
