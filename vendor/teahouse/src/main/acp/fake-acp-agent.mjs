#!/usr/bin/env node
// fake ACP agent —— 主 seam 的可控 peer（SPEC #41 Testing Decisions）。
//
// 与真实 adapter（claude-agent-acp / codex-acp）走**同一个** runner 与 bridge：
// 协议面只用官方 `@agentclientprotocol/sdk` 的 agent 侧，因此它对 runner 而言
// 与真 adapter 不可区分；差别只在"智能产出"——这里返回确定性内容，不需要任何 key。
//
// 为什么放在 `src/main/acp/` 而不是仓库根 `scripts/`：它必须与 runner 用同一份
// node_modules（SDK 的 agent 侧），且随 vendor 树一起被记账。
//
// 可用环境变量（全部可选，用于脚本化各种剧本）：
//   FAKE_ACP_REPLY        固定回复文本（默认一段带 Markdown 的自我介绍）
//   FAKE_ACP_REPLY_FILE   从文件读回复文本（优先级高于 REPLY）
//   FAKE_ACP_CHUNKS       把回复切成 N 片发（默认 1 片；用于验证 chunk 累积）
//   FAKE_ACP_THOUGHT      先发一段 agent_thought_chunk（默认发，验证"过程不进群"）
//   FAKE_ACP_TOOL         发一个 tool_call（默认发，验证"过程不进群"）
//   FAKE_ACP_DELAY_MS     收到 prompt 后先延迟 N ms（默认 0）
//   FAKE_ACP_CRASH_AFTER  收到第 N 个 prompt 后自杀（默认不崩；1 = 首个 prompt 就崩）
//   FAKE_ACP_NO_REPLY     设 1 则只结束 turn 不发正式消息
import { readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'
import process from 'node:process'

let acp
try {
  acp = await import('@agentclientprotocol/sdk')
} catch (err) {
  process.stderr.write(`[fake-acp] 无法加载 SDK：${String(err?.message ?? err)}\n`)
  process.exit(2)
}

const DEFAULT_REPLY = [
  '# fake ACP peer 已收到派单',
  '',
  '这是一条**确定性**的正式回复，用于验证：',
  '',
  '- 一次 @ 恰好触发一次 turn',
  '- 首条回复带 `reply_to`',
  '- Markdown 经 parser + sanitizer 渲染',
  '',
  '长内容会按自然边界切分为单条 ≤3500B 的多条消息。',
  '',
  '```ts',
  'const ok: boolean = true',
  '```',
  ''
].join('\n')

function replyText() {
  const file = process.env['FAKE_ACP_REPLY_FILE']
  if (file) {
    try {
      return readFileSync(file, 'utf8')
    } catch (err) {
      process.stderr.write(`[fake-acp] 读 REPLY_FILE 失败：${String(err?.message ?? err)}\n`)
    }
  }
  return process.env['FAKE_ACP_REPLY'] ?? DEFAULT_REPLY
}

/** 按 UTF-8 边界把文本切成 n 片（不切坏多字节字符）。 */
function splitUtf8(text, n) {
  if (n <= 1) return [text]
  const bytesPer = Math.ceil(Buffer.byteLength(text, 'utf8') / n)
  const out = []
  let current = ''
  for (const char of text) {
    if (Buffer.byteLength(current + char, 'utf8') > bytesPer && current !== '') {
      out.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current !== '') out.push(current)
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let promptCount = 0

const app = acp.agent({ name: 'fake-acp-agent', version: '0.1.0' })

app.onRequest(acp.methods.agent.initialize, async () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentInfo: { name: 'fake-acp-agent', version: '0.1.0' },
  agentCapabilities: {}
}))

app.onRequest(acp.methods.agent.session.new, async () => ({
  sessionId: `fake-session-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}))

app.onRequest(acp.methods.agent.session.setConfigOption, async () => ({ configOptions: [] }))

app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
  promptCount += 1
  const sessionId = ctx.params?.sessionId

  const crashAfter = Number(process.env['FAKE_ACP_CRASH_AFTER'] ?? '0')
  if (crashAfter > 0 && promptCount >= crashAfter) {
    process.stderr.write(`[fake-acp] 按剧本在第 ${promptCount} 个 prompt 上崩溃\n`)
    process.exit(9)
  }

  const delay = Number(process.env['FAKE_ACP_DELAY_MS'] ?? '0')
  if (delay > 0) await sleep(delay)

  // 过程：先发 thought 与 tool_call —— 它们**不得**进群（ADR-0008），
  // 但要出现在 runner 的 update 事件里，供机库落盘。
  if (process.env['FAKE_ACP_THOUGHT'] !== '0') {
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '（fake）正在组织回复…' } }
    })
  }
  if (process.env['FAKE_ACP_TOOL'] !== '0') {
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `fake-tool-${promptCount}`,
        title: 'fake tool call',
        kind: 'read',
        status: 'completed'
      }
    })
  }

  if (process.env['FAKE_ACP_NO_REPLY'] === '1') {
    return { stopReason: 'end_turn' }
  }

  const text = replyText()
  const chunks = splitUtf8(text, Math.max(1, Number(process.env['FAKE_ACP_CHUNKS'] ?? '1')))
  for (const piece of chunks) {
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } }
    })
  }
  return { stopReason: 'end_turn' }
})

app.onNotification(acp.methods.agent.session.cancel, async () => undefined)

// 官方示例同款：node 流 → web 流（agent 侧是 stdout 写、stdin 读）。
const connection = app.connect(
  acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
)
void connection
