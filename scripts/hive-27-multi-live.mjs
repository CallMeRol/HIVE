// Hive #27 多 agent 演示实例（黑客松 demo 用，长期运行）：
// GUI + 3 个 headless agent 成员（真 runner + fake ACP peer，@ 即回话）。
// 群「launch-plan」打开后右栏 Members/Active agents 可见五档负担点。
// 用完：pkill -f hive-27-multi-live（或让我杀）。
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRig } from './lib/hive-rig.mjs'

const PORTS = {
  gui: { udp: 32878, tcp: 32879, api: 32890, cdp: 32881 },
  'agent-a': { udp: 22878, tcp: 22879, api: 22890 },
  'agent-b': { udp: 23878, tcp: 23879, api: 23890 },
  'agent-c': { udp: 24878, tcp: 24879, api: 24890 }
}

const rig = createRig({ ports: PORTS, keep: true })
const cdpPort = () => rig.portOf('gui', 'cdp')
const apiOf = (label) => rig.portOf(label, 'api')
const VENDOR = join(process.cwd(), 'vendor', 'teahouse')
const FAKE_AGENT = join(VENDOR, 'src', 'main', 'acp', 'fake-acp-agent.mjs')

/** fake agent 走真 runner + 真 bridge（与真 adapter 同契约），产出确定性内容。 */
function agentEnv(label) {
  return {
    PANTRY_AGENT_COMMAND: process.execPath,
    PANTRY_AGENT_ARGS: FAKE_AGENT,
    PANTRY_ARTIFACTS_ROOT: join(rig.dataDirs[label], 'artifacts')
  }
}

async function main() {
  // GUI：深色 + 已 onboarding
  rig.seedConfig('gui', { nick: 'Hive-GUI' })
  const cfgPath = join(rig.dataDirs['gui'], 'config.json')
  const config = JSON.parse(readFileSync(cfgPath, 'utf8'))
  config.setupDone = true
  config.theme = 'dark'
  writeFileSync(cfgPath, `${JSON.stringify(config, null, 2)}\n`)

  // 3 个 agent 成员节点（不同 FAKE_ACP_REPLY 让群里一眼看出谁在回）
  const replies = {
    'agent-a': '收到。我是 agent-a（蓝），当前上下文占用很低，随时可以接活。',
    'agent-b': '收到。我是 agent-b，任务拆解我来做。',
    'agent-c': '收到。我是 agent-c，测试与验收归我。'
  }
  for (const label of ['agent-a', 'agent-b', 'agent-c']) {
    rig.seedConfig(label, { nick: label })
    mkdirSync(rig.dataDirs[label], { recursive: true })
    writeFileSync(join(rig.dataDirs[label], 'reply.txt'), replies[label])
  }

  const guiChild = rig.up('gui', { peers: ['agent-a', 'agent-b', 'agent-c'] })
  const kids = {}
  kids['agent-a'] = rig.up('agent-a', { headless: true, peers: ['127.0.0.1'], extraEnv: { ...agentEnv('agent-a'), FAKE_ACP_REPLY_FILE: join(rig.dataDirs['agent-a'], 'reply.txt') } })
  kids['agent-b'] = rig.up('agent-b', { headless: true, peers: ['127.0.0.1'], extraEnv: { ...agentEnv('agent-b'), FAKE_ACP_REPLY_FILE: join(rig.dataDirs['agent-b'], 'reply.txt') } })
  kids['agent-c'] = rig.up('agent-c', { headless: true, peers: ['127.0.0.1'], extraEnv: { ...agentEnv('agent-c'), FAKE_ACP_REPLY_FILE: join(rig.dataDirs['agent-c'], 'reply.txt') } })
  void kids

  await rig.waitLine(guiChild, (l) => l.includes('[local-api]'), 60000)
  await rig.waitCdp(cdpPort(), 'return document.readyState', (v) => v === 'complete', 'readyState', 60000)
  await new Promise((r) => setTimeout(r, 4000))

  const cdpEval = (expr) => rig.cdpEvaluate(cdpPort(), expr)
  const healths = {}
  for (const label of ['agent-a', 'agent-b', 'agent-c']) {
    healths[label] = await rig.waitHealth(apiOf(label), label)
  }

  // 建群：GUI + 3 agent
  await cdpEval(
    `await window.pantry.saveProfile({ nick: 'Hive-GUI', company: '', dept: '', team: '', avatar: -1, fileDir: '' });
     const g = await window.pantry.createGroup('launch-plan', ['${healths['agent-a'].nodeId}', '${healths['agent-b'].nodeId}', '${healths['agent-c'].nodeId}']);
     if (!g) throw new Error('建群失败');
     return g.groupId;`
  )

  // 等成员关系收敛后打开群会话（真 UI 点击）
  await new Promise((r) => setTimeout(r, 4000))
  await cdpEval(
    `const btns = [...document.querySelectorAll('.conv-list .conv')];
     const target = btns.find(el => el.textContent.includes('launch-plan'));
     if (target) { target.click(); await new Promise(r => setTimeout(r, 1200)); return true; }
     return false;`
  )

  // 开场消息
  await cdpEval(
    `const ta = document.querySelector('.input-shell textarea, textarea');
     if (ta) {
       ta.focus();
       ta.value = '@agent-a 到一下，报下当前状态';
       ta.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise(r => setTimeout(r, 300));
       ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
     }
     return true;`
  )

  // 结构探针：三栏 + 横幅 + 右栏 Members 数
  const probe = await cdpEval(
    `return {
       banner: !!document.querySelector('.conv-banner'),
       details: !!document.querySelector('.details'),
       memberRows: document.querySelectorAll('.details section')[1]?.querySelectorAll('li, .member, .row').length ?? 0,
       burdenDots: document.querySelectorAll('.burden-dot').length
     };`
  )
  console.log('DEMO UP', JSON.stringify(probe))
  console.log('DEMO ROOT ' + rig.root)
  // 常驻：让用户直接在真窗口里玩
  setInterval(() => {}, 1 << 30)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
