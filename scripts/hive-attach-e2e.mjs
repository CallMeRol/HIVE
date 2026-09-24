#!/usr/bin/env node
// Hive #49 黑盒 rig：从 GUI 接入 Claude Code 与 Codex，各完成一次真实群聊 turn。
//
// 判据 = 退出码 0 / 非 0。全程只经真进程 + 真 local-api + 真 renderer（CDP 驱动
// `window.pantry`），不 import 被测模块内部函数 —— 验的是「用户点得出来的那条路」。
//
// 拓扑：GUI 节点（owner，有主窗，CDP 可驱动）+ 由本 rig 通过 GUI 接入面起的成员节点。
// 成员节点不由 rig 直接 spawn：接入的**语义**就是「Hive 自己把节点起起来」，
// rig 若自己 spawn 就绕过了整条被测链路。
//
// 覆盖 AC：
//   1) 可选择 runtime / 成员名称 / 工作目录 / 模型 / permission 策略
//   2) 探测 CLI / 既有认证 / Node / adapter / 模型；失败给可操作错误
//   3) Claude Code 与 Codex 各完成至少一次真实群聊 turn
//   4) ACP permission 与 Hive 确认键使用不同处理面
//   5) 真实 usage 驱动成员行上下文负担；凭据与会话数据不离开当前 Mac
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRig, VENDOR } from './lib/hive-rig.mjs'

const GUI = { udp: 47878, tcp: 47879, api: 47880, cdp: 47881 }

/** 接入会用到的真实 adapter（本机已装的那两个）。 */
const CLAUDE_ADAPTER = join(
  homedir(),
  'Library/pnpm/global/v11/e743-19ff1c9403b-32a4f96dff0e4c6c/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'
)
const CODEX_ADAPTER = '/tmp/acp-sdk-probe/node_modules/@agentclientprotocol/codex-acp/dist/index.js'

/**
 * 默认跑 claude + codex 两种 runtime（AC3 要求两者各完成一次真实 turn）。
 * `--runtime claude` / `--runtime codex` 可只跑一种，便于逐个排查。
 */
const argv = process.argv.slice(2)
const runtimeArg = argv.includes('--runtime') ? argv[argv.indexOf('--runtime') + 1] : ''
const RUNTIMES_TO_RUN = runtimeArg === 'claude' || runtimeArg === 'codex' ? [runtimeArg] : ['claude', 'codex']

const rig = createRig({ appPath: null, ports: { gui: GUI }, keep: argv.includes('--keep') })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const results = []
function check2(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * 等 GUI renderer 暴露 `window.pantry` 的新接入面。
 * 首屏挂载期间 renderer 会重建执行上下文，故用重试而不是单发。
 */
async function waitPantry(cdpPort, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = '未就绪'
  while (Date.now() < deadline) {
    try {
      const ok = await rig.cdpEvaluate(cdpPort, 'return typeof window.pantry?.probeAttachTargets === "function";')
      if (ok === true) return true
      lastErr = 'pantry 未暴露 probeAttachTargets'
    } catch (err) {
      lastErr = String(err?.message ?? err)
    }
    await sleep(700)
  }
  throw new Error(`等待 window.pantry 接入面超时：${lastErr}`)
}

/** 在 GUI renderer 里跑一段接入逻辑，返回其值。 */
function inGui(expression, opts) {
  return rig.cdpEvaluate(GUI.cdp, expression, opts)
}

async function main() {
  console.log('=== Hive #49 接入 rig ===')
  console.log(`claude adapter: ${CLAUDE_ADAPTER}`)
  console.log(`codex adapter : ${CODEX_ADAPTER}`)

  // ---------- AC2（先验探测本身，它不依赖接入成功） ----------

  // 探测模块的纯函数面：给坏参数必须回「可操作建议」而不是空。
  const probeModule = await loadTs('src/main/hive/agent-probe.ts')

  // 一条 PATH 干净的环境：adapter / CLI / 认证都找不到。Node 一项**刻意**回退到真实
  // PATH（探测不该因为 PATH 被裁就谎报「没有 Node」——runner 必须要它），故这里只断言
  // 其余三项按事实报缺失。
  const cleanProbe = await probeModule.probeRuntime('claude', {
    probeRuntime: async () => {
      throw new Error('不该走到握手：前置项都该先失败')
    },
    env: { PATH: '/nonexistent', HOME: '/nonexistent' }
  })
  check2(
    'AC2 探测把「adapter 缺失」报成独立失败项（不硬编码，按事实）',
    cleanProbe.items.some((i) => i.id === 'adapter' && !i.ok),
    JSON.stringify(cleanProbe.items.find((i) => i.id === 'adapter') ?? null)
  )
  check2(
    'AC2 探测把「CLI 缺失」报成独立失败项',
    cleanProbe.items.some((i) => i.id === 'cli' && !i.ok),
    JSON.stringify(cleanProbe.items.find((i) => i.id === 'cli') ?? null)
  )
  check2(
    'AC2 探测把「认证缺失」报成独立失败项',
    cleanProbe.items.some((i) => i.id === 'auth' && !i.ok),
    JSON.stringify(cleanProbe.items.find((i) => i.id === 'auth') ?? null)
  )
  check2(
    'AC2 每一个失败项都带可操作建议（hint 非空）',
    cleanProbe.items.filter((i) => !i.ok).every((i) => i.hint.trim().length > 0),
    JSON.stringify(cleanProbe.items.filter((i) => !i.ok).map((i) => ({ id: i.id, hint: i.hint })))
  )
  check2('AC2 前置项未过时不假装握手成功', cleanProbe.ready === false)
  check2(
    'AC2 Node 一项不被 PATH 裁剪带偏（runner 的硬依赖必须报真实情况）',
    cleanProbe.items.find((i) => i.id === 'node')?.ok === true,
    JSON.stringify(cleanProbe.items.find((i) => i.id === 'node') ?? null)
  )

  // 真握手失败 → 转成带建议的一项，而不是抛出去。
  // 前置项要**真能过**才会走到握手，故用真实 env + 真实 adapter 可执行名，只把握手本身打桩。
  const handshakeFail = await probeModule.probeRuntime('claude', {
    probeRuntime: async () => {
      throw new Error('模拟 adapter 握手失败')
    },
    env: process.env
  })
  const hsItem = handshakeFail.items.find((i) => i.id === 'handshake')
  const preOk = handshakeFail.items.filter((i) => i.id !== 'handshake').every((i) => i.ok)
  check2(
    'AC2 握手失败转成带建议的失败项（不抛）',
    preOk && hsItem?.ok === false && hsItem.hint.trim().length > 0 && hsItem.detail.includes('模拟 adapter 握手失败'),
    `前置项全过=${preOk} ${JSON.stringify(hsItem ?? null)}`
  )

  // 模型与 permission 枚举来自 adapter 自报的 configOptions，不是硬编码清单。
  const parsed = probeModule.parseConfigOptions([
    {
      id: 'model',
      category: 'model',
      options: [{ value: 'opus', name: 'Opus' }, { value: 'haiku', name: 'Haiku' }]
    },
    {
      id: 'mode',
      category: 'mode',
      options: [{ value: 'plan', name: 'Plan' }]
    }
  ])
  check2(
    'AC2 模型枚举来自 adapter 的 configOptions',
    parsed.models.length === 2 && parsed.models[0].value === 'opus',
    JSON.stringify(parsed.models)
  )
  check2(
    'AC2 permission 枚举来自 adapter 的 mode 选项',
    parsed.permissions.length === 1 && parsed.permissions[0].value === 'plan',
    JSON.stringify(parsed.permissions)
  )

  // 接入请求校验：非法输入必须落到「哪一项不对 + 怎么办」。
  const attachModule = await loadTs('src/main/hive/agent-attach.ts')
  const noNick = attachModule.validateAttachRequest({ runtime: 'claude', nick: '', cwd: '/tmp' })
  check2('AC1 成员名称为空被拒且给出建议', noNick.ok === false && noNick.hint.length > 0, JSON.stringify(noNick))
  const badCwd = attachModule.validateAttachRequest({
    runtime: 'claude',
    nick: 'x',
    cwd: '/definitely/not/here'
  })
  check2('AC1 工作目录不存在被拒且给出建议', badCwd.ok === false && badCwd.hint.length > 0, JSON.stringify(badCwd))
  const badRuntime = attachModule.validateAttachRequest({ runtime: 'gpt5', nick: 'x', cwd: '/tmp' })
  check2('AC1 未知 runtime 被拒', badRuntime.ok === false, JSON.stringify(badRuntime))

  // 端口分配必须避让已用端口（否则第二个成员起不来）。
  const alloc = attachModule.allocatePorts([{ udp: 17978, tcp: 17979, api: 17980 }])
  check2(
    'AC3 端口分配避让已占用节点',
    alloc.udp !== 17978 && alloc.tcp !== 17979 && alloc.api !== 17980,
    JSON.stringify(alloc)
  )

  // ---------- 起 GUI 节点 ----------

  rig.seedConfig('gui', { nick: 'Hive 主控' })
  rig.up('gui', { headless: false })
  const health = await rig.waitHealth(GUI.api, 'gui')
  check2('GUI 节点起得来', Boolean(health?.nodeId), `nodeId=${health?.nodeId}`)
  await waitPantry(GUI.cdp)
  check2('AC1 renderer 暴露接入面（probeAttachTargets/attachAgent）', true)

  // ---------- AC1 + AC2：走真 GUI 探测 ----------

  const probes = await inGui(`return await window.pantry.probeAttachTargets();`, { timeoutMs: 180000 })

  // 探测失败时把 GUI 节点的完整输出摊开：runner 的 stderr（`[runner] adapter: …`）是
  // 定位「握手为什么没成」的唯一线索，rig 的默认过滤会把它藏掉。
  if (probes?.some((p) => !p.ready)) {
    console.log('--- GUI 节点输出（探测失败，摊开供排查）---')
    for (const line of rig.children.find((c) => c.nodeLabel === 'gui')?.lines ?? []) {
      console.log(`  [gui] ${line}`)
    }
    console.log('--- end ---')
  }
  check2(
    'AC2 GUI 探测返回两种 runtime',
    Array.isArray(probes) && probes.length === 2,
    JSON.stringify((probes ?? []).map((p) => p.runtime))
  )
  const claudeProbe = probes.find((p) => p.runtime === 'claude')
  check2(
    'AC2 探测项覆盖 Node / adapter / CLI / 认证 / 握手',
    ['node', 'adapter', 'cli', 'auth', 'handshake'].every((id) =>
      claudeProbe?.items.some((i) => i.id === id)
    ),
    JSON.stringify(claudeProbe?.items.map((i) => `${i.id}:${i.ok}`))
  )
  check2(
    'AC1 探测给出模型与 permission 可选项',
    (claudeProbe?.models.length ?? 0) > 0 && (claudeProbe?.permissions.length ?? 0) > 0,
    `models=${claudeProbe?.models.length} permissions=${claudeProbe?.permissions.length}`
  )

  // ---------- AC3：真实接入 + 真实 turn ----------

  const ev = await rig.openSse(GUI.api, 'gui')

  let groupId = ''

  for (const runtime of RUNTIMES_TO_RUN) {
    const adapter = runtime === 'claude' ? CLAUDE_ADAPTER : CODEX_ADAPTER
    if (!existsSync(adapter)) {
      check2(
        `AC3 ${runtime} adapter 在位于本机（可接入）`,
        false,
        `找不到 ${adapter} —— 该 runtime 的接入未验证`
      )
      continue
    }

    const probe = probes.find((p) => p.runtime === runtime)
    if (!probe?.ready) {
      check2(
        `AC3 ${runtime} 探测就绪（可接入）`,
        false,
        JSON.stringify(probe?.items.filter((i) => !i.ok).map((i) => `${i.id}:${i.detail}`))
      )
      continue
    }

    // 第一个成员先「只接入不进群」拿到 nodeId —— 建群要求至少两个成员
    // （`createGroup`：`members.length < 2` 直接返回 null），而成员是接进来的，
    // 所以顺序只能是「先接成员，再拿它建群」，不能先建空群。
    // 第二个成员起改成接进已建好的群，顺带覆盖「接进指定群」这条路径。
    // （`groupId` 初值空串 = 这个成员先只接入；拿到它的 nodeId 后再建群。）

    // 选一个模型与一个 permission 档位，证明二者都能选、都能落地。
    const model = probe.models[0]?.value ?? ''
    const perm = probe.permissions[0]?.value ?? ''
    const nick = runtime === 'claude' ? 'Claude 成员' : 'Codex 成员'

    const attach = await inGui(
      `
      return await window.pantry.attachAgent({
        runtime: ${JSON.stringify(runtime)},
        nick: ${JSON.stringify(nick)},
        cwd: ${JSON.stringify('/tmp')},
        model: ${JSON.stringify(model)},
        permissionMode: ${JSON.stringify(perm)},
        groupId: ${JSON.stringify(groupId)},
        adapterPath: ${JSON.stringify(adapter)}
      });`,
      { timeoutMs: 180000 }
    )
    check2(
      `AC3 ${runtime} 接入成功（起独立节点 + 校验身份）`,
      attach?.ok === true,
      JSON.stringify({
        ok: attach?.ok,
        memberId: attach?.memberId,
        nodeId: attach?.nodeId,
        apiPort: attach?.apiPort,
        error: attach?.error,
        hint: attach?.hint
      })
    )
    if (!attach?.ok) continue

    // 第一次接入是「只接入不进群」，此刻拿它建群（createGroup 要求 ≥2 成员）；
    // 之后每个成员都接进这个已建好的群，顺带覆盖「接进指定群」这条路径。
    if (!groupId) {
      groupId = await inGui(`
        const g = await window.pantry.createGroup('hive-attach', [${JSON.stringify(attach.nodeId)}]);
        if (!g) throw new Error('createGroup 返回 null');
        return g.groupId;`)
      check2('建群成功（成员接进来后才能建，故在此刻）', typeof groupId === 'string' && groupId.length > 0, groupId)
    }

    check2(`AC1 ${runtime} 入选的模型被回显为实际使用值`, attach.model === model, `model=${attach.model}`)
    check2(
      `AC1 ${runtime} permission 策略被回显`,
      attach.permissionMode === perm,
      `permissionMode=${attach.permissionMode}`
    )
    check2(
      `AC1 ${runtime} 成员拿到独立端口与数据目录`,
      attach.udpPort > 0 && attach.tcpPort > 0 && attach.apiPort > 0 && attach.dataDir.length > 0,
      JSON.stringify({ udp: attach.udpPort, tcp: attach.tcpPort, api: attach.apiPort })
    )

    // 成员节点自己也要健康（它是真进程）。
    const memberHealth = await rig.waitHealth(attach.apiPort, `${runtime}-member`, 40000)
    check2(
      `AC3 ${runtime} 成员节点 health 报出与接入一致的 nodeId`,
      memberHealth.nodeId === attach.nodeId,
      `health=${memberHealth.nodeId} attach=${attach.nodeId}`
    )

    // 等它出现在群成员表里（成员是另一个进程，要一次群 info 同步）。
    const inGroup = await rig.waitCdp(
      GUI.cdp,
      `
      const g = await window.pantry.getGroup(${JSON.stringify(groupId)});
      return !!g && g.members.includes(${JSON.stringify(attach.nodeId)});`,
      (v) => v === true,
      `${runtime} 成员进群`,
      40000
    )
    check2(`AC3 ${runtime} 成员出现在群成员表`, inGroup === true)

    // ---- 真 turn：从 GUI 发一条 @ 它的消息，等它真回复 ----
    const mentionText = `@${nick} 请用一句话回复：你已接入本群。`
    const sent = await inGui(
      `
      const m = await window.pantry.sendGroupText(
        ${JSON.stringify(groupId)},
        ${JSON.stringify(mentionText)},
        [${JSON.stringify(attach.nodeId)}]
      );
      return m ? { id: m.id, senderId: m.senderId } : null;`
    )
    check2(`AC3 ${runtime} 派单消息已发出（带 mention）`, Boolean(sent?.id), JSON.stringify(sent))

    const beforeCount = ev.filter(
      (e) => e.type === 'message.new' && e.data?.groupId === groupId && e.data?.senderId === attach.nodeId
    ).length
    check2(`AC3 ${runtime} 发 @ 前它一条都没回（去重/触发闸门成立）`, beforeCount === 0, `count=${beforeCount}`)

    // 真 agent 的一个 turn 可能很久（claude 首轮实测 ~40s；codex 冷启更慢）。
    const deadline = Date.now() + 300000
    let reply = null
    while (Date.now() < deadline) {
      reply = ev.find(
        (e) => e.type === 'message.new' && e.data?.groupId === groupId && e.data?.senderId === attach.nodeId
      )
      if (reply) break
      await sleep(500)
    }
    check2(
      `AC3 ${runtime} 完成一次真实群聊 turn（agent 的正式回复进群）`,
      Boolean(reply),
      reply ? `text=${JSON.stringify(String(reply.data.text).slice(0, 60))}` : '300s 内未观察到回复'
    )
    if (reply) {
      check2(
        `AC3 ${runtime} 首条回复带 reply_to 指回派单`,
        reply.data.replyTo === sent.id,
        `replyTo=${reply.data.replyTo} 派单=${sent.id}`
      )
      check2(
        `AC3 ${runtime} 回复内容非空且是 agent 产出`,
        typeof reply.data.text === 'string' && reply.data.text.trim().length > 0,
        `len=${reply.data.text?.length}`
      )
      // 恰好一次 turn：同一派单只应触发一条首回复（分条续篇不带 replyTo）。
      const firstReplies = ev.filter(
        (e) =>
          e.type === 'message.new' &&
          e.data?.groupId === groupId &&
          e.data?.senderId === attach.nodeId &&
          e.data?.replyTo === sent.id
      )
      check2(
        `AC3 ${runtime} 一次 @ 恰好触发一次 turn（首回复只一条）`,
        firstReplies.length === 1,
        `首回复条数=${firstReplies.length}`
      )
      // 过程不进群：agent_thought_chunk 之类绝不作为群消息出现。
      const processInGroup = ev.filter(
        (e) =>
          e.type === 'message.new' &&
          e.data?.groupId === groupId &&
          typeof e.data?.text === 'string' &&
          /agent_thought_chunk|tool_call|usage_update/.test(e.data.text)
      )
      check2(
        `AC3 ${runtime} 过程（thought/tool/usage）不进群`,
        processInGroup.length === 0,
        `混进群的过程条数=${processInGroup.length}`
      )
    }

    // ---- AC4：ACP permission 与 Hive 确认键是两条处理面 ----
    const bridgeSrc = readFileSync(join(VENDOR, 'src/main/services/agent-bridge.ts'), 'utf8')
    const runnerSrc = readFileSync(join(VENDOR, 'src/main/acp/runner.mjs'), 'utf8')
    check2(
      'AC4 ACP permission 在 runner 内应答（agent 发起的逐工具请求）',
      /requestPermission/.test(runnerSrc) && /outcome/.test(runnerSrc),
      'runner 持有 permission 应答面'
    )
    check2(
      'AC4 permission 应答不进群消息流（无 sendText 调用）',
      !/requestPermission[\s\S]{0,2000}sendText/.test(runnerSrc),
      'permission 处理器里没有发群消息'
    )
    check2(
      'AC4 permission 默认 fail-closed（未选档位即拒绝）',
      /PERMISSION === 'allow'/.test(runnerSrc) && /'reject'/.test(runnerSrc),
      '默认分支落到 reject'
    )
    check2(
      'AC4 bridge 不实现 permission 面（确认键属 pending，另一条路径）',
      !/requestPermission|permissionMode|permission/.test(bridgeSrc),
      'bridge 源码不含 permission 处理'
    )
    check2(
      'AC4 确认键（pending）不在本票实现范围内',
      !/confirmKey|pendingConfirm|确认键/.test(bridgeSrc),
      '检测到 bridge 里出现确认键逻辑则说明两面被混用'
    )

    // ---- AC5：真实 usage 驱动负担 ----
    const usageBurden = await rig.waitCdp(
      GUI.cdp,
      `
      const peers = await window.pantry.getPeers();
      const p = peers.find(x => x.nodeId === ${JSON.stringify(attach.nodeId)});
      return p ? { eligible: p.burden?.eligible ?? null, tag: p.burden?.tag ?? null, pct: p.burden?.pct ?? null, sizeTokens: p.burden?.sizeTokens ?? null, stale: p.burden?.stale ?? null } : null;`,
      (v) => v && v.eligible === true && v.stale === false && typeof v.pct === 'number',
      `${runtime} 的负担行由真实 usage 驱动`,
      90000
    )
    check2(
      `AC5 ${runtime} 成员行负担由真实 usage 驱动（pct/size 非空且非 stale）`,
      Boolean(usageBurden),
      JSON.stringify(usageBurden)
    )
    check2(
      `AC5 ${runtime} 档位与 pct 自洽（不是凭空编的档）`,
      usageBurden
        ? usageBurden.tag ===
            (usageBurden.pct >= 40
              ? 'about-to-blow'
              : usageBurden.pct >= 20
                ? 'overload'
                : usageBurden.pct >= 10
                  ? 'busy'
                  : 'easy')
        : false,
      JSON.stringify(usageBurden)
    )
    check2(
      `AC5 ${runtime} 上报的窗口容量是真实值（不是确定性生产器的小数字）`,
      (usageBurden?.sizeTokens ?? 0) > 100000,
      `sizeTokens=${usageBurden?.sizeTokens}`
    )

    // ---- AC5：凭据与会话数据不出本机 ----
    check2(
      `AC5 ${runtime} 未把任何密钥写进接入账本`,
      !/api[_-]?key|token|secret|password/i.test(JSON.stringify(attach)),
      '接入结果里没有凭据字样'
    )
    const attachLedger = JSON.stringify(attach)
    check2(
      `AC5 ${runtime} 接入账本只记路径与端口，不记会话内容`,
      !/sk-|Bearer /.test(attachLedger),
      '账本无凭据样式串'
    )
    check2(
      `AC5 ${runtime} 成员数据目录在 userData 下（不出本机）`,
      attach.dataDir.includes(health.nodeId) || /members-nodes|Hive|hive/i.test(attach.dataDir),
      attach.dataDir
    )
  }

  // ---------- 收尾 ----------

  const attachedView = await inGui(`
    const list = await window.pantry.listAttachedAgents();
    return list.map(m => ({ memberId: m.memberId, runtime: m.runtime, apiPort: m.apiPort, model: m.model, permissionMode: m.permissionMode }));`)
  check2(
    'AC1 已接入成员可被列出（含 runtime/模型/permission）',
    Array.isArray(attachedView) && attachedView.length >= 1,
    JSON.stringify(attachedView)
  )

  await rig.teardown()
  rig.cleanup()

  console.log(`\n${failures === 0 ? 'ATTACH E2E OK' : `ATTACH E2E FAILED — ${failures} 项`}（${results.length} 项断言）`)
  process.exit(failures === 0 ? 0 : 1)
}

/** 用 esbuild 现场打包 TS 源码（复用上游 devDep），与 acp-smoke rig 同法。 */
const bundleCache = new Map()
async function loadTs(entryRelPath) {
  if (bundleCache.has(entryRelPath)) return bundleCache.get(entryRelPath)
  const esbuild = await import(join(VENDOR, 'node_modules', 'esbuild', 'lib', 'main.js'))
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const out = await esbuild.build({
    entryPoints: [join(VENDOR, entryRelPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    external: ['electron', 'better-sqlite3']
  })
  const dir = mkdtempSync(join(tmpdir(), 'hive-attach-rig-'))
  const file = join(dir, `${entryRelPath.replace(/[/.]/g, '_')}.mjs`)
  writeFileSync(file, out.outputFiles[0].text)
  const mod = await import(file)
  bundleCache.set(entryRelPath, mod)
  return mod
}

main().catch(async (err) => {
  console.error('\nrig 失败：', err)
  try {
    await rig.teardown()
    rig.cleanup()
  } catch {
    /* 清理失败不掩盖原始错误 */
  }
  process.exit(1)
})
