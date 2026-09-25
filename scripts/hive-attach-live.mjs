// Hive live 接入脚本：对已在跑的 live GUI（32881 CDP）接入本机 Claude Code 成员。
// 只驱动 window.pantry 接入面，不 import 内部模块；run 结束后 GUI 与成员节点保持运行。
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRig } from './lib/hive-rig.mjs'

const CDP = 32881
const CLAUDE_ADAPTER = join(
  homedir(),
  'Library/pnpm/global/v11/e743-19ff1c9403b-32a4f96dff0e4c6c/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
)

const rig = createRig({ ports: {}, keep: true })
const cdpEval = (expr, opts) => rig.cdpEvaluate(CDP, expr, opts)

async function main() {
  if (!existsSync(CLAUDE_ADAPTER)) throw new Error(`找不到 claude adapter：${CLAUDE_ADAPTER}`)

  console.log('探测 runtime…')
  const probes = await cdpEval('return await window.pantry.probeAttachTargets();', { timeoutMs: 180000 })
  const claude = (probes ?? []).find((p) => p.runtime === 'claude')
  if (!claude?.ready) {
    console.log('探测结果：', JSON.stringify(claude, null, 2))
    throw new Error('claude runtime 探测未就绪')
  }
  console.log('探测就绪：models=', claude.models.map((m) => m.value), 'permissions=', claude.permissions.map((p) => p.value))

  const model = claude.models[0]?.value ?? ''
  const perm = claude.permissions[0]?.value ?? ''
  console.log(`接入 Claude Code 成员（model=${model} permission=${perm}）…`)

  const attach = await cdpEval(
    `return await window.pantry.attachAgent({
       runtime: 'claude',
       nick: 'Claude Code',
       cwd: ${JSON.stringify(process.cwd())},
       model: ${JSON.stringify(model)},
       permissionMode: ${JSON.stringify(perm)},
       groupId: '',
       adapterPath: ${JSON.stringify(CLAUDE_ADAPTER)}
     });`,
    { timeoutMs: 180000 }
  )
  console.log('attach 结果：', JSON.stringify(attach, null, 2))
  if (!attach?.ok) process.exit(1)

  // 加入 live 已建好的群
  const joined = await cdpEval(
    `const groups = await window.pantry.listGroups?.() ?? [];
     return groups.map(g => ({ id: g.groupId ?? g.id, name: g.name ?? g.title }));`
  )
  console.log('现有群：', JSON.stringify(joined))

  console.log('UP：Claude Code 成员已接入，nodeId=', attach.nodeId, 'apiPort=', attach.apiPort)
  setInterval(() => {}, 1 << 30)
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
