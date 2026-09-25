// Hive #27 演示实例（黑客松 demo 用）：起 GUI + 1 个 headless agent → 建群 → 打开会话，
// 全部保持运行不退出，让用户直接在真窗口里看三栏 + 横幅 + 右栏效果。
// 用完 Ctrl+C（或让我 kill）即可。
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRig } from './lib/hive-rig.mjs'

const GUI = { udp: 32878, tcp: 32879, api: 32890, cdp: 32881 }
const AGENT = { udp: 22878, tcp: 22879, api: 22890 }

const rig = createRig({ ports: { gui: GUI, agent: AGENT }, keep: true })
const cdpPort = () => rig.portOf('gui', 'cdp')
const apiOf = (label) => rig.portOf(label, 'api')

async function main() {
  rig.seedConfig('gui', { nick: 'Hive-GUI', setupDone: true, theme: 'dark' })
  const cfgPath = join(rig.dataDirs['gui'], 'config.json')
  const config = JSON.parse(readFileSync(cfgPath, 'utf8'))
  config.setupDone = true
  config.theme = 'dark'
  writeFileSync(cfgPath, `${JSON.stringify(config, null, 2)}\n`)
  rig.seedConfig('agent', { nick: 'agent-blue' })

  const guiChild = rig.up('gui', { peers: ['agent'] })
  rig.up('agent', { peers: ['127.0.0.1'], headless: true })
  await rig.waitLine(guiChild, (l) => l.includes('[local-api]'), 60000)
  await rig.waitCdp(cdpPort(), 'return document.readyState', (v) => v === 'complete', 'readyState', 60000)
  await new Promise((r) => setTimeout(r, 4000))

  const agentHealth = await rig.waitHealth(apiOf('agent'), 'agent')
  const cdpEval = (expr) => rig.cdpEvaluate(cdpPort(), expr)

  await cdpEval(
    `await window.pantry.saveProfile({ nick: 'Hive-GUI', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
     const g = await window.pantry.createGroup('launch-plan', ['${agentHealth.nodeId}']);
     if (!g) throw new Error('建群失败');
     return g.groupId;`
  )
  // 打开群会话（真 UI 点击）
  await cdpEval(
    `await new Promise(r => setTimeout(r, 1500));
     const btns = [...document.querySelectorAll('.conv-list .conv')];
     const target = btns.find(el => el.textContent.includes('launch-plan'));
     if (target) { target.click(); await new Promise(r => setTimeout(r, 1200)); return true; }
     return false;`
  )
  // 进群里发一条开场消息，演示更真实
  await cdpEval(
    `const ta = document.querySelector('.input-shell textarea, textarea');
     if (ta) {
       ta.focus();
       ta.value = '欢迎来到 launch-plan 频道——右栏是成员与 agent 负担面板。';
       ta.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise(r => setTimeout(r, 300));
       ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     }
     return true;`
  )
  console.log('DEMO UP：群「launch-plan」已建好并保持运行（GUI + 1 agent 成员）。数据目录：' + rig.root)
  // 保持进程活着，让用户操作真窗口
  setInterval(() => {}, 1 << 30)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
