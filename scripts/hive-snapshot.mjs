#!/usr/bin/env node
// Hive 演示快照：起一个真 GUI 节点，CDP 驱动 renderer，把窗口截图落盘。
//
//   node scripts/hive-snapshot.mjs                       # 默认落 docs/demo/snapshots/
//   node scripts/hive-snapshot.mjs --out <dir>            # 换输出目录
//   node scripts/hive-snapshot.mjs --app <Hive.app>       # 用打包产物（#61 的 packaged 语境）
//   node scripts/hive-snapshot.mjs --setup-done           # 预置已 onboarding，截主界面而非向导
//   node scripts/hive-snapshot.mjs --dark                 # 深色主题（PRD §5 冻结的 #0a0e17 底）
//   node scripts/hive-snapshot.mjs --name <base>          # 输出文件名（默认 hive-main）
//   node scripts/hive-snapshot.mjs --tab network          # 截图前切到某个右侧 tab（本地动作，mock）
//   node scripts/hive-snapshot.mjs --keep                 # 保留数据目录供排查
//
// 为什么是 CDP 原生 `Page.captureScreenshot` 而不是神一看截图工具：
// 快照必须是**被测进程自己渲染出来的像素**（含真 font / 真裁切 / 真缩放），
// 用外部截屏会带上窗口管理器与缩放的不确定性，不能当演示素材，也不能当视觉回归基线。
//
// 纪律（沿用 rig 的既有约束）：
//   - 只经真进程 + 真 renderer，不 import 被测模块内部函数；
//   - 退出前一定 teardown，不留孤儿 Electron / Node（#61 AC4 的同款要求）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRig } from './lib/hive-rig.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const OUT = resolve(arg('--out', 'docs/demo/snapshots'))
const appPath = arg('--app', null)
const baseName = arg('--name', 'hive-main')
const tab = arg('--tab', null)
const setupDone = argv.includes('--setup-done')
const dark = argv.includes('--dark')
const keep = argv.includes('--keep')

// 与 #48/#49 的 rig 端口错开，避免并行时互踩。
const GUI = { udp: 19878, tcp: 19879, api: 19880, cdp: 19881 }

const rig = createRig({ appPath, ports: { gui: GUI }, keep })

/** 侧栏 tab 的中文 aria-label（左栏按钮只给 aria-label，没有 data-tab）。 */
const TAB_LABELS = { network: '派遣网络图', contacts: '通讯录', chat: '会话' }

/** 一次性 CDP 连接，调用若干方法后关掉。 */
async function withCdp(fn) {
  const targets = await (await fetch(`http://127.0.0.1:${GUI.cdp}/json/list`)).json()
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

/** 截当前视口，返回 PNG 字节。 */
async function capture() {
  return withCdp(async (call) => {
    const res = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    if (res.error) throw new Error(`captureScreenshot 失败：${res.error.message}`)
    return Buffer.from(res.result.data, 'base64')
  })
}

async function main() {
  console.log(`=== Hive 快照 ===（app=${appPath ?? 'dev out/'}，落盘 ${OUT}）`)
  rig.seedConfig('gui', { nick: 'Hive-GUI' })
  // 预置 onboarding 已完成 / 目标主题：向导会盖住主界面，浅色也不是设计稿的观感。
  // 直接改 config.json 而不是走 UI —— 快照要的是「稳定可复现的初始态」，点向导反而引入时序。
  if (setupDone || dark) {
    const path = join(rig.dataDirs['gui'], 'config.json')
    const config = JSON.parse(readFileSync(path, 'utf8'))
    if (setupDone) config.setupDone = true
    if (dark) config.theme = 'dark'
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  }
  const child = rig.up('gui', { peers: [] })
  try {
    await rig.waitLine(child, (l) => l.includes('[local-api]'), 60000)
    await rig.waitCdp(GUI.cdp, 'return document.readyState', (v) => v === 'complete', 'readyState', 60000)
    // 首屏字体与首帧动画稳定下来再截；截图要能当演示素材，不能抢跑。
    await new Promise((r) => setTimeout(r, 6000))

    // 切到目标 tab：走真 UI 的点击（不是改内部状态），否则截的可能是个空面板。
    if (tab) {
      const target = TAB_LABELS[tab] ?? tab
      const clicked = await rig.cdpEvaluate(
        GUI.cdp,
        `const btn = [...document.querySelectorAll('button[aria-label]')]
           .find((el) => el.getAttribute('aria-label') === ${JSON.stringify(target)});
         if (!btn) return [...document.querySelectorAll('button[aria-label]')].map((el) => el.getAttribute('aria-label'));
         btn.click();
         return true;`
      )
      if (clicked === true) console.log(`PASS  已切到 tab「${target}」`)
      else console.log(`WARN  没找到 tab「${target}」，可选：${JSON.stringify(clicked)}`)
      await new Promise((r) => setTimeout(r, 2500))
    }

    mkdirSync(OUT, { recursive: true })
    const png = await capture()
    const file = join(OUT, `${baseName}.png`)
    writeFileSync(file, png)
    console.log(`PASS  主窗快照 → ${file}（${png.length} 字节）`)

    // 顺带把「换肤是否真的生效」变成可核对的事实，而不是靠肉眼看图。
    const vars = await rig.cdpEvaluate(
      GUI.cdp,
      `const cs = getComputedStyle(document.documentElement);
       return {
         theme: document.documentElement.dataset.theme || '',
         primary: cs.getPropertyValue('--primary').trim(),
         bgWindow: cs.getPropertyValue('--bg-window').trim(),
         bgChat: cs.getPropertyValue('--bg-chat').trim(),
         railBg: cs.getPropertyValue('--rail-bg').trim()
       };`
    )
    console.log(`PASS  当前 token：${JSON.stringify(vars)}`)
    return 0
  } finally {
    await rig.teardown()
    rig.cleanup()
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`快照失败：${err?.stack ?? err}`)
    process.exit(1)
  })
