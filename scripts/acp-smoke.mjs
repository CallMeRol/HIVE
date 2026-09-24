#!/usr/bin/env node
// Hive #46 黑盒 rig：@fake 获得一次安全的正式回复。
//
// 用**真进程**（真 runner 子进程 + 真 fake ACP peer）跑通 agent 链路，
// 不依赖 Electron、不需要任何 LLM key。纯 Node 22，零新依赖。
//
// 覆盖 AC：
//   1) 官方 ACP SDK + Node 22 runner，JSON-RPC 错误非零退出
//   2) 一次 @ 恰好一次 turn；未 @ / 自身 / 系统消息不触发
//   3) 正式回复带 reply_to；长 UTF-8 按自然边界分条，单条 ≤3500B
//   4) Markdown 经 parser + sanitizer；XSS 被拒
//   5) thought / tool 等过程不进群，只落本机 JSONL/Markdown
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(REPO, 'vendor', 'teahouse')
const ACP_DIR = join(VENDOR, 'src', 'main', 'acp')

let failures = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 加载被测模块（TS 源码，用 esbuild 现场打包，复用上游 devDep） ----------
// bundle: true —— 被测模块之间有相对导入（agent-bridge → formal-message / session-ledger），
// 逐个 transform 会留下无法解析的相对说明符。
const bundleCache = new Map()
async function loadTs(entryRelPath) {
  if (bundleCache.has(entryRelPath)) return bundleCache.get(entryRelPath)
  const esbuild = await import(join(VENDOR, 'node_modules', 'esbuild', 'lib', 'main.js'))
  const out = await esbuild.build({
    entryPoints: [join(VENDOR, entryRelPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    // Electron 原语与 native 模块不进 rig：被测的四个模块本身零 electron 依赖。
    external: ['electron', 'better-sqlite3']
  })
  const file = join(TMP, `${entryRelPath.replace(/[/.]/g, '_')}.mjs`)
  writeFileSync(file, out.outputFiles[0].text)
  const mod = await import(file)
  bundleCache.set(entryRelPath, mod)
  return mod
}

const TMP = mkdtempSync(join(tmpdir(), 'hive-acp-smoke-'))
console.log(`rig root: ${TMP}`)

// ---------- 驱动 runner ----------
function startRunner(env = {}, extraArgs = []) {
  const child = spawn(process.execPath, [
    join(ACP_DIR, 'runner.mjs'),
    '--command', process.execPath,
    '--args', join(ACP_DIR, 'fake-acp-agent.mjs'),
    '--cwd', TMP,
    ...extraArgs
  ], {
    cwd: VENDOR,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const events = []
  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (c) => {
    buf += c
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch { /* 坏行 */ }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderrText = ''
  child.stderr.on('data', (c) => { child.stderrText += c })
  child.events = events
  child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))
  return child
}

async function runOneTurn(env = {}) {
  const child = startRunner(env)
  child.stdin.write(JSON.stringify({ v: 1, type: 'prompt', turnId: 't1', text: '请自我介绍' }) + '\n')
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (child.events.some((e) => e.type === 'turn_done' || e.type === 'turn_error' || e.type === 'fatal')) break
    await sleep(100)
  }
  child.stdin.write(JSON.stringify({ v: 1, type: 'shutdown' }) + '\n')
  await Promise.race([child.exited, sleep(3000)])
  try { child.kill('SIGKILL') } catch { /* 已退 */ }
  return child
}

async function main() {
  const { shouldTrigger } = await loadTs('src/main/services/agent-bridge.ts')
  const { splitFormalMessage, FORMAL_MESSAGE_LIMIT_BYTES } = await loadTs('src/main/services/formal-message.ts')
  const { isProcessUpdate, FORMAL_UPDATE_KIND } = await loadTs('src/main/services/session-ledger.ts')

  // ---- AC1：官方 ACP SDK + Node 22 runner 跑通一次 turn ----
  check('AC1 runner 可执行文件存在', existsSync(join(ACP_DIR, 'runner.mjs')))
  const ok = await runOneTurn()
  const ready = ok.events.find((e) => e.type === 'ready')
  const done = ok.events.find((e) => e.type === 'turn_done')
  check('AC1 用官方 ACP SDK 完成 initialize（ready 事件）', Boolean(ready), ready ? JSON.stringify(ready.agentInfo) : '无 ready')
  check('AC1 Node 22 runner 完成一次 turn（end_turn）', done?.stopReason === 'end_turn', `stopReason=${done?.stopReason}`)
  check('AC1 正式回复由 agent_message_chunk 累积而成', (done?.text ?? '').length > 0, `len=${done?.text?.length}`)

  // ---- AC1 续：JSON-RPC 错误 → 非零退出 / 显式 turn_error ----
  const bad = spawn(process.execPath, [
    join(ACP_DIR, 'runner.mjs'), '--command', '/nonexistent/adapter-binary'
  ], { cwd: VENDOR, stdio: ['ignore', 'pipe', 'pipe'] })
  let badOut = ''
  bad.stdout.setEncoding('utf8')
  bad.stdout.on('data', (c) => { badOut += c })
  const badExit = await Promise.race([new Promise((r) => bad.on('exit', (code) => r(code))), sleep(8000).then(() => 'timeout')])
  check('AC1 无效 adapter 命令 → 非零退出', badExit !== 0 && badExit !== 'timeout', `exit=${badExit}`)
  check('AC1 失败走 fatal 信封而非静默', badOut.includes('"type":"fatal"'), badOut.trim().slice(0, 120))

  // ---- AC2：触发闸门（纯函数，逐条证伪） ----
  check('AC2 被 @ 的他人文本消息 → 触发', shouldTrigger({ isMine: false, kind: 'text', mentioned: true }) === true)
  check('AC2 未 @ 不触发', shouldTrigger({ isMine: false, kind: 'text', mentioned: false }) === false)
  check('AC2 无 mentioned 字段不触发', shouldTrigger({ isMine: false, kind: 'text' }) === false)
  check('AC2 自身消息不触发', shouldTrigger({ isMine: true, kind: 'text', mentioned: true }) === false)
  check('AC2 系统消息不触发', shouldTrigger({ isMine: false, kind: 'system', mentioned: true }) === false)
  check('AC2 非文本消息不触发', shouldTrigger({ isMine: false, kind: 'image', mentioned: true }) === false)

  // ---- AC2 续：同一 turn 只跑一次（runner 拒绝并发） ----
  const concurrent = startRunner()
  concurrent.stdin.write(JSON.stringify({ v: 1, type: 'prompt', turnId: 'a', text: 'x' }) + '\n')
  concurrent.stdin.write(JSON.stringify({ v: 1, type: 'prompt', turnId: 'b', text: 'y' }) + '\n')
  const cDeadline = Date.now() + 20000
  while (Date.now() < cDeadline) {
    if (concurrent.events.filter((e) => e.type === 'turn_done' || e.type === 'turn_error').length >= 2) break
    await sleep(100)
  }
  const inFlight = concurrent.events.find((e) => e.type === 'turn_error' && e.code === 'turn_in_flight')
  check('AC2 并发 prompt 被拒（同一时刻 ≤1 turn）', Boolean(inFlight), inFlight ? inFlight.code : '未观察到拒绝')
  try { concurrent.kill('SIGKILL') } catch { /* 已退 */ }

  // ---- AC3：正式消息分条与 reply_to ----
  const short = splitFormalMessage('一句话回复。')
  check('AC3 短回复不分条', short.length === 1 && short[0] === '一句话回复。', JSON.stringify(short))

  // 长 UTF-8（中文 3 字节/字）：验证按自然边界分条且单条 ≤3500B
  const para = '这是一段用于验证分条的中文内容。'.repeat(40) // ~600 字 ≈ 1800B
  const longText = [para, para, para].join('\n\n')
  const pieces = splitFormalMessage(longText)
  const oversize = pieces.filter((p) => Buffer.byteLength(p, 'utf8') > FORMAL_MESSAGE_LIMIT_BYTES)
  check('AC3 长回复被分条（>1 条）', pieces.length > 1, `条数=${pieces.length}`)
  check(
    `AC3 每条 ≤${FORMAL_MESSAGE_LIMIT_BYTES}B`,
    oversize.length === 0,
    `超限 ${oversize.length} 条，最大 ${Math.max(...pieces.map((p) => Buffer.byteLength(p, 'utf8')))}B`
  )
  check('AC3 分条不切坏多字节字符', !pieces.join('').includes('�'))

  // 原子块（代码块）超限 → 硬切并标注 (i/n)
  const codeBlock = '```\n' + 'const x = 1\n'.repeat(400) + '```'
  const codePieces = splitFormalMessage(codeBlock)
  check('AC3 超限代码块硬切并标注 (i/n)', codePieces.length > 1 && /\(1\/\d+\)/.test(codePieces[0]), `${codePieces.length} 片`)
  check(
    'AC3 硬切片也不越界',
    codePieces.every((p) => Buffer.byteLength(p, 'utf8') <= FORMAL_MESSAGE_LIMIT_BYTES)
  )

  // reply_to：bridge 把首条指回派单（源码级断言 + 运行时行为见 e2e）
  const bridgeSrc = readFileSync(join(VENDOR, 'src/main/services/agent-bridge.ts'), 'utf8')
  check('AC3 首条正式回复带 replyTo=派单消息 id', /i === 0 \? trigger\.id : undefined/.test(bridgeSrc))

  // ---- AC5：过程不进群 ----
  const updateKinds = ok.events.filter((e) => e.type === 'update').map((e) => e.sessionUpdate)
  check('AC5 收到 thought 过程', updateKinds.includes('agent_thought_chunk'), JSON.stringify(updateKinds))
  check('AC5 收到 tool_call 过程', updateKinds.includes('tool_call'))
  check('AC5 thought/tool 被判为过程（不进群）', isProcessUpdate('agent_thought_chunk') && isProcessUpdate('tool_call'))
  check('AC5 plan/usage 被判为过程', isProcessUpdate('plan') && isProcessUpdate('usage_update'))
  check('AC5 agent_message_chunk 是唯一正式消息类型', FORMAL_UPDATE_KIND === 'agent_message_chunk' && !isProcessUpdate('agent_message_chunk'))
  check(
    'AC5 进群消息只来自 agent_message_chunk 增量',
    done?.text === ok.events.filter((e) => e.sessionUpdate === 'agent_message_chunk').map((e) => e.textDelta).join('')
  )

  // ---- AC5 续：账本落盘（JSONL + Markdown，append-only） ----
  const { SessionLedger } = await loadTs('src/main/services/session-ledger.ts')
  const ledger = new SessionLedger(TMP, 'member-test', 'session-test')
  ledger.append('inbound', { text: '派单原文' })
  ledger.append('update', { sessionUpdate: 'agent_thought_chunk' })
  ledger.append('turn', { ok: true, stopReason: 'end_turn' })
  ledger.writeMarkdown({ 成员: 'member-test' }, ['## 派单', '', '内容'])
  const paths = ledger.filePaths()
  check('AC5 JSONL 落盘存在', existsSync(paths.jsonl), paths.jsonl)
  check('AC5 Markdown 时间线落盘存在', existsSync(paths.markdown), paths.markdown)
  const jsonlLines = readFileSync(paths.jsonl, 'utf8').trim().split('\n')
  check('AC5 JSONL 是 append-only 多行', jsonlLines.length === 3, `行数=${jsonlLines.length}`)
  check('AC5 JSONL 每行可解析且带版本', jsonlLines.every((l) => { const e = JSON.parse(l); return e.v === 1 && e.kind && e.ts }))

  // ---- AC4：Markdown parser + sanitizer ----
  // renderer 的 markdown.ts 依赖 DOM（DOMPurify），这里用最小 DOM stub 驱动其纯逻辑部分。
  // 完整渲染在 renderer 侧由 Vue 组件承担；此处验证"依赖被正确锁定 + 回退策略存在"。
  const mdSrc = readFileSync(join(VENDOR, 'src/renderer/src/utils/markdown.ts'), 'utf8')
  check('AC4 用 markdown-it（成熟 parser）', /from 'markdown-it'/.test(mdSrc))
  check('AC4 用 DOMPurify（成熟 sanitizer）', /from 'dompurify'/.test(mdSrc))
  check('AC4 parser 禁用原始 HTML', /html: false/.test(mdSrc))
  check('AC4 启用 linkify', /linkify: true/.test(mdSrc))
  check('AC4 有纯文本回退路径', /plainFallback: true/.test(mdSrc) && /escapeHtml/.test(mdSrc))
  check('AC4 只放行 http(s)/mailto 链接', /ALLOWED_URI_RE/.test(mdSrc) && /mailto/.test(mdSrc))

  // 第一层防护用**真实 parser** 验证：markdown-it 不依赖 DOM，可直接在 Node 下跑。
  const mdMod = await import(join(VENDOR, 'node_modules', 'markdown-it', 'dist', 'markdown-it.mjs'))
  const md = new mdMod.default({ html: false, linkify: true, breaks: true })
  const dirty = '<img src=x onerror=alert(1)><script>alert(2)</script>\n\n[点我](javascript:alert(3))\n\nhttps://example.com'
  const parsed = md.render(dirty)
  check('AC4 原始 HTML 被转义（script/onerror 不出现在标签位）', !/<script|<img/i.test(parsed), parsed.slice(0, 100))
  check('AC4 转义后仍可见为文本', parsed.includes('&lt;script&gt;'))
  check('AC4 javascript: 链接被 parser 拒绝（不生成 a 标签）', !/<a[^>]*javascript:/i.test(parsed))
  check('AC4 裸 URL 被 linkify 成链接', /<a href="https:\/\/example\.com"/.test(parsed))
  // 第二层（DOMPurify）需要 DOM，其配置面已在上面按源码断言覆盖；
  // 真实清洗由 renderer 侧组件在浏览器环境承担（SPEC #41：UI 由真实数据驱动验收）。

  console.log(`\n${failures === 0 ? 'ACP SMOKE OK' : `ACP SMOKE FAILED — ${failures} 项`}（${results.length} 项断言）`)
  rmSync(TMP, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\nACP SMOKE ERROR: ${err?.stack ?? err}`)
  rmSync(TMP, { recursive: true, force: true })
  process.exit(1)
})
