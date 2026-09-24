# ticket #32 开工前审计（2026-09-22 21:4x–22:0x，Mac）

> 目的：在动真机之前，先把「这次实测能不能跑、跑出来的证据可不可信、资产还在不在」查清楚。
> 结论：**原票据 7 项里有 1 项当前不可执行**；**验收仪器有假通过 bug**；**离线 kit 躺在 /tmp**。

---

## F1 · 范围：第 5 项的「群内带 `replyTo` 的回复」当前不可执行

`#32` 要求“两个 adapter 各跑通一次真 turn，并给出群内是否出现带 `replyTo` 的回复”。
后者需要 hive 应用本体（teahouse headless 补丁 + `src/main/local-api/` + `src/main/services/agent-bridge.ts` + `scripts/fake-acp-agent.mjs`），
而 **hive 仓库里这四样一样都不存在**：

```
$ git ls-files | grep -E 'vendor/|src/|scripts/'      → 空
$ find . -maxdepth 2 -name vendor                     → 空
$ find ~ /tmp -name fake-acp-agent.mjs                → 空
$ find ~ /tmp -type d -path '*src/main/acp*'          → 空
```

`#14`（headless 补丁与 local-api 胶水的执行方案）只是**执行方案**，其 §6 的 S1–S5 从未落地。
⇒ 「真 turn」本身不需要 hive 应用（`acp-turn.mjs` 直驱 adapter 即可），但**「群内 replyTo」需要**。
⇒ 处置：本条拆票（见下）。

## F2 · 验收仪器有**假通过** bug（新增，最严重）

`acp-smoke.mjs` 只判断 `m.id === 1`，然后取 `m.result || {}`。**当 adapter 回的是 JSON-RPC `error` 时它照样报成功。**

本机复现（win32-only 树，`/tmp/wayfinder-32-pf`，codex-acp 因为找不到 darwin 二进制而 `initialize` 失败）：

```
$ node acp-smoke.mjs node_modules/@agentclientprotocol/codex-acp/dist/index.js 30000
HANDSHAKE_OK protocolVersion=undefined agent=undefined@undefined authMethods=[]
ACP_INITIALIZE_OK
exit=0
```

而同一条命令下的原始报文是：

```
{"jsonrpc":"2.0","id":1,"error":{"code":1001,"message":"Codex process has exited with code 1:\n...
  Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest"}}
```

**后果**：`#32` 的判据「期望 `ACP_INITIALIZE_OK` ×2」**可以被一个彻底坏掉的 adapter 满足**，`verify.ps1` 还会 exit 0。
也就是说，现场最容易失败的一项（codex 平台二进制缺失 / codex.exe 起不来）**会被报告成绿**——假证据比没有证据更糟。
⇒ 必须先修仪器再上场。硬化版已产出并验证（见 `helpers/HARDENING.md`）。

## F3 · 范围：第 6 项提到的另两处

1. **`verify.ps1` 永不失败**：PS 5.1 下 `$ErrorActionPreference='Stop'` **不覆盖原生命令的非零退出码**，脚本里每句 `node ...` 失败都不中断，最终 exit 0。
2. **缺精确字节断言**：票据要求 `codex.exe` = 298,169,136 B / `claude.exe` = 233,691,808 B，但脚本只打印 MB。（`#27` WS1 §3.3 的手工版有这两个数，脚本版没有。）
3. 票据正文「与《两机手机热点跨设备局域网实测》可在同一次现场一并执行」**已过期**：`#12` 已关闭且 `docs/handoff/hotspot-sync/result.md` 已回报。

## F4 · 离线 kit 完整性：**通过**（并新增一条更强的证明）

| 项 | 实测 |
|---|---|
| `node-v22.23.2-win-x64.zip` | 35,683,585 B；sha256 = `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97` == 官方 `SHASUMS256.txt` ✅ |
| `npmcache/` | 289 MB / 503 文件；索引里有 121 个 tarball，**含两个 win32 平台包**：`@openai/codex-0.154.0-win32-x64.tgz`、`@anthropic-ai/claude-agent-sdk-win32-x64-0.3.274.tgz` ✅ |
| `package-lock.json` | lockfileVersion 3；win32 x64/arm64 条目都带正确 `os`/`cpu` 约束 ✅ |

**新证明（`#27` 只用 `npm install --os=win32` 证过，没证过 `npm ci --offline` 这条路）**：

```
$ npm ci --offline --os=win32 --cpu=x64 --cache /tmp/wayfinder-27/ws1/npmcache
added 123 packages in 3s
$ ls -la node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe   → 298169136
$ ls -la node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe                   → 233691808
```

⇒ 票据里写的两个期望字节数**可复现**，cache + lockfile 已经足够。
**同一条命令不带 `--os/--cpu` 时**：`added 121 packages`、exit 0、**两个 exe 全缺**（npm 对 optionalDependencies 失败静默跳过）。
⇒ `--os=win32 --cpu=x64` 在现场是**必需参数**，不是可选项；这也解释了为什么验收必须数 exe 而不是看 `npm ci` 成不成功。

**同时确认一条容易误判的事**：Mac 上**装不出**这两个 win32 exe（平台过滤），所以「在 Mac 上先装一遍」**不能**替代真机实测。

## F5 · 资产持久性：**当前不安全**

U 盘 payload（node zip 34 MB + cache 289 MB + 仪器 + 配置模板 ≈ **322 MB**）全部只在
`/tmp/wayfinder-27/ws1/`（小文件副本在 `~/hive-wayfinder-27/`）。**重启即丢，重建要联网重新下载 + 重新暖 cache。**
⇒ 已落 `~/hive-field-32/`：`RUNBOOK.md` + `make-usb.sh`（幂等组装 U 盘目录）+ 配置模板 + 硬化仪器。

## F6 · LLM 通路现值（**现场必须重算，不要用 #27 的快照**）

`bash verify-relay.sh http://localhost:2317` → `pass=5 fail=0`、`VERDICT: READY`。
逐模型探活（`max_tokens` / `max_output_tokens` ≤16，2026-09-22 21:5x）：

| 模型 | 协议 | 实测 |
|---|---|---|
| `deepseek-v4.1-flash` | responses | **200 / 3.4 s** ✅（codex 锁它） |
| `deepseek-v4.1-flash` | messages | **200 / 5.2 s** ✅ |
| `mimo-v2.6-flash` | messages | **200 / 11.5 s** ✅（慢） |
| `gpt-5.6-luna` | responses | **http=000 / 8 s 超时** ❌（codex 默认模型，在 Tailscale 死桶） |

**关键坑（票据和 RUNBOOK 都要说清）**：claude 侧的别名→真实模型映射写在 `~/.claude/settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 里，
**用户会改**：`#27` 时 `sonnet→gemini-3.7-flash`，现在已是 `mimo-v2.6-flash[1M]`；`opus→deepseek-v4.1-flash[1M]`。
⇒ 现场锁模型表必须**从当刻的 settings.json 重算**，不能抄 `#27`。

## F7 · 结论

| 项 | 判决 |
|---|---|
| 票据第 1–4、7 项 | ✅ 可执行 |
| 票据第 5 项的「真 turn（stopReason / 耗时 / 实际模型名）」 | ✅ 可执行（**不经 hive app**，用 `acp-turn.mjs`） |
| 票据第 5 项的「群内带 `replyTo` 的回复」 | ❌ **不可执行**（hive 零实现）→ 拆成新票，等实现落地 |
| 验收仪器 | ⚠️ 原版有假通过 bug → 必须用硬化版 |
