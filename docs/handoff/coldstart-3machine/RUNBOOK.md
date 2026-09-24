# 三机冷启动实测 · 现场 RUNBOOK（ticket #32）

> 拓扑：**1 Mac（中转宿主 + 客户端 1） + 2 Windows（客户端 2 / 3）**
> 依据：wayfinder #27 resolution §1.3 / §2.3 / §4；本文件是 #32 裁剪后的可执行版。
> 时间预算：**45–60 分钟**（不含两台 Windows 装 node 的时间）。超时不要硬啃，回报卡点。
> 硬边界：**不改 hive 仓库、不提交任何东西、不改 Windows 系统设置**（防火墙放行除外）。

---

## 0. 这次测什么 / 不测什么（**先读，避免白干**）

| 测 | 不测（**当前不可执行**） |
|---|---|
| ① 环境钉死（winver / node / npm / 架构） | ❌ 群内 `replyTo` 回复 |
| ② 离线安装（node 便携 zip + `npm ci --offline` + **两个 exe 字节断言**） | ❌ 建群 / 成员生命周期 / 仪表盘 |
| ③ runtime 验收（`verify.ps1`：`ACP_INITIALIZE_OK` ×2） | ❌ 端到端「群里 @ 一个 agent → 它回帖」 |
| ④ LLM 通路（`curl.exe` 打 `MAC_IP:2317/v1/models`） | |
| ⑤ **真 turn**（`acp-turn.mjs` 直驱 adapter，不经 hive app）：claude 一次 + codex 一次 | |
| ⑥ 失败项如实回报 | |
| ⑦ 防火墙弹窗记录 | |

**为什么 ⑤ 里的「真 turn」能测、「群内回复」不能测**：真 turn 只需要 ACP adapter + LLM 通路，不需要 hive 应用；「群内 replyTo」需要 teahouse headless 补丁 + local-api 胶水 + agent-bridge —— **这些代码在 hive 仓库里一行都还没有**（已核实：无 `vendor/teahouse/`、无 `src/main/acp/`、无 `scripts/fake-acp-agent.mjs`）。那部分已拆成独立 ticket，等实现落地后再测。

---

## 1. 前置资产清单（U 盘 payload，Mac 侧产）

| 路径 | 内容 | 大小 | 校验 |
|---|---|---:|---|
| `usb/node/` | 官方 `node-v22.23.2-win-x64.zip` 解压产物 | 99.5 MB | zip sha256 = `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97` |
| `usb/bundle/package.json` | 只声明两个 adapter，版本钉死 | 210 B | — |
| `usb/bundle/package-lock.json` | lockfileVersion 3，含 win32 x64/arm64 条目 | 65 KB | — |
| `usb/bundle/npmcache/` | 离线 registry（含两个 win32 tarball） | 289 MB / 503 文件 | 见 `usb/SHA256SUMS` |
| `usb/bundle/verify.ps1` | runtime 验收（**已硬化**：字节断言 + 退出码传播） | — | 见 `usb/SHA256SUMS` |
| `usb/bundle/acp-smoke.mjs` | initialize 握手探针（**已修假通过 bug**） | — | 见 `usb/SHA256SUMS` |
| `usb/bundle/acp-turn.mjs` | **真 turn** 仪器（initialize + session/new + set_config_option + prompt） | — | 见 `usb/SHA256SUMS` |
| `usb/config/` | 两台 Windows 的 4 个配置文件模板（`<MAC_IP>` / `<RELAY_TOKEN>` 占位） | — | — |

生成：`bash ~/hive-field-32/make-usb.sh`（幂等，会算 SHA256SUMS）。

**为什么带 cache 而不是拷 `node_modules`**：`npm i` 只装当前平台的 optionalDependencies，Mac 上装出来的是 darwin 二进制，拷到 Windows 两个 `*.exe` 全缺，adapter 启动即抛 `Missing optional dependency`。cache 里的 `.tgz` 与平台无关，Windows 上一条命令重建。**反过来说：Mac 上也`npm ci`不出 exe（平台过滤），所以「Mac 上装一遍」不能替代这次实测。**

---

## 2. 逐步对齐表（同一步骤号 = 同一时间做同一件事）

> 用户驱动节奏：说「执行第 N 步」→ 两端各做第 N 步 → 报成功/失败 → 「执行第 N+1 步」。

| 步 | Mac（宿主机 + 客户端 1） | Windows A / B（客户端 2 / 3） | 闸门（不满足就别往下走） |
|---|---|---|---|
| 0 | 现场前：`bash ~/hive-wayfinder-27/verify-relay.sh http://localhost:2317` | — | `VERDICT: READY`（5/5）。不 READY 就先修中转，**别动 Windows** |
| 1 | 记录 `MAC_IP`（`ipconfig getifaddr en0`）+ 读活模型映射表（§3）；`caffeinate -dimsu &` | `winver`；`C:\acp\node\node.exe -v`；`npm.cmd -v`；`echo $env:PROCESSOR_ARCHITECTURE` | Mac 拿到 `MAC_IP` 且**不休眠**；Windows node = `v22.23.2` |
| 2 | 确认 U 盘 payload 就位（§1 清单） | 拷 `usb/node/` → `C:\acp\node`；`usb/bundle/` → `C:\acp\bundle` | 路径**必须短**（`C:\acp\...`，绕 MAX_PATH 260） |
| 3 | — | `cd C:\acp\bundle` → `C:\acp\node\npm.cmd ci --offline --cache .\npmcache --os=win32 --cpu=x64 --no-audit --no-fund` | 输出 `added 123 packages`（**`--os/--cpu` 不能省**；省了会静默少装 2 个平台包且 exit 0） |
| 4 | — | `powershell -ExecutionPolicy Bypass -File .\verify.ps1` | `VERDICT: PASS`，且看到 `codex.exe 298169136 B` / `claude.exe 233691808 B` / `ACP_INITIALIZE_OK` ×2 / `HANDSHAKE_OK protocolVersion=1` ×2 |
| 5 | — | 写 4 个配置文件（§4），把 `<MAC_IP>` `<RELAY_TOKEN>` 填实 | 文件路径必须是 `%USERPROFILE%\.claude\settings.json` 与 `%USERPROFILE%\.codex\` |
| 6 | 同一条 curl 对照一下 | `curl.exe -s -m 6 -o NUL -w "%{http_code} %{time_total}" http://<MAC_IP>:2317/v1/models -H "Authorization: Bearer <RELAY_TOKEN>"` | `200`。**必须写 `curl.exe`**（PowerShell 里 `curl` 是 `Invoke-WebRequest` 别名）。`000` = 打不通 → 防火墙 / 不同网段 |
| 7 | ping 两台 Windows | `ping <MAC_IP>` | 4/4 通。不通 → 先解决 L3，别改代码 |
| 8 | 跑 **claude 真 turn** 做对照（§5 命令） | 跑 **claude 真 turn**：`acp-turn.mjs --bin ...claude-agent-acp\dist\index.js --set model=haiku` | `TURN_OK stopReason=end_turn`，并记 `elapsedMs` / `model=`。**别用 `sonnet`**（当前挂在慢上游上，180 s 超时） |
| 9 | 跑 **codex 真 turn** 做对照 | 跑 **codex 真 turn**：`--bin ...codex-acp\dist\index.js --set model=deepseek-v4.1-flash` | `TURN_OK` 且 `model=deepseek-v4.1-flash`。**不锁模型 = 每个 turn 先卡 30 s 再失败**（默认 `gpt-5.6-luna` 在死桶里） |
| 10 | 收 `result.md`，与 Mac 对照表合并 | 写 `result.md`（§6 格式），两窗一起交回 | 有失败项也交 —— **卡点原文比「好像能跑」有用** |

---

## 3. 现场锁模型表（**必须在现场重算，不能用 #27 的快照**）

别名→真实模型的映射写在 `~/.claude/settings.json` 的 `ANTHROPIC_DEFAULT_*_MODEL` 里，**用户随时会改**（#27 时 `sonnet→gemini-3.7-flash`，现在已经是别的了）。现场用这一条把当前映射读出来：

```bash
jq -r '.env | to_entries[] | select(.key|test("ANTHROPIC_DEFAULT.*_MODEL$")) | "\(.key)=\(.value)"' ~/.claude/settings.json
jq -r '.model' ~/.claude/settings.json      # 当前选中的别名
jq -r '.models[].slug' ~/.codex/ai-toolbox-codex-model-catalog.json   # codex 能选的 4 个
```

**2026-09-22 21:5x 实测（本机，仅供开局参考，现场要重跑）**：

| 通路 | 锁什么 | 实测 |
|---|---|---|
| codex-acp | `--set model=deepseek-v4.1-flash` | `/v1/responses` **200 / 3.4 s**（`deepseek/deepseek-v4.1-flash`）；**真 turn 实测 `TURN_OK stopReason=end_turn elapsedMs=4844`** ✅ |
| claude-agent-acp（haiku 别名） | `--set model=haiku` | **真 turn 实测 `TURN_OK end_turn elapsedMs=12829`** ✅ |
| claude-agent-acp（opus 别名） | `--set model=opus` | `/v1/messages` **200 / 5.2 s** ✅（真 turn 未单测，但同上游） |
| claude-agent-acp（sonnet 别名） | **别用** | `/v1/messages` 200 但 11.5 s/16 token；**真 turn 在 180 s 上超时（`TURN_FAIL stage=timeout`）** ❌ |
| codex 默认 `gpt-5.6-luna` | **不要用** | `/v1/responses` **http=000，8 s 超时**（Tailscale 死桶）；真 turn 每次先卡 30 s |

> 别名的桶内容由 `settings.json` 决定，所以「哪个别名快」是**当天的事实**，不是常数 —— `sonnet` 现在挂在 `mimo-v2.6-flash` 上就是慢的。现场先跑 §3 顶部那两条 `jq`，再选别名。

**仪器自检的两条对照（同一个 `acp-turn.mjs`，已实测）**：
- 坏树（win32-only 树在 Mac 上跑 codex）→ `TURN_FAIL stage=initialize error=code=1001 Codex process has exited...`，退出码非 0 ✅
- 给 `--set model=definitely-not-a-model` → `TURN_FAIL stage=set_config_option ... code=-32602 Invalid params` ✅（不会假绿）

`session/new` 返回的 `modelOptions` 是**本机配置声明的模型**，不是「此刻活着的模型」——所以探测必须在这一层（上面的 curl / `verify-relay.sh`）做，不能靠 `session/new` 枚举。

---

## 4. 两台 Windows 的 4 个文件（模板在 `usb/config/`）

`%USERPROFILE%\.claude\settings.json`（claude-acp 侧，**别名桶**）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://<MAC_IP>:2317",
    "ANTHROPIC_AUTH_TOKEN": "<RELAY_TOKEN>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "gpt-5.6-sol"
  },
  "model": "opus"
}
```

`%USERPROFILE%\.codex\config.toml`（codex-acp 侧）：

```toml
model_catalog_json = "ai-toolbox-codex-model-catalog.json"
model = "deepseek-v4.1-flash"
model_provider = "custom"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "http://<MAC_IP>:2317/v1"
```

`%USERPROFILE%\.codex\auth.json`：`{ "OPENAI_API_KEY": "<RELAY_TOKEN>", "auth_mode": "apikey" }`
`%USERPROFILE%\.codex\ai-toolbox-codex-model-catalog.json`：从 Mac 的 `~/.codex/` 整份复制（少了它 codex 的 `modelOptions` 里**一个活模型都没有**，全落在死桶）。

三个必须显式记住的坑：
1. **别写 `[1M]` 后缀**：那是 claude-code 客户端的标记，直发字面量会 `400 unknown provider`。统一写裸模型名。
2. **只设进程环境变量无效**：`settings.json` 的 `env` 会覆盖进程 env（已端到端实测），必须写文件。
3. **不要给 Windows 设 `OPENAI_API_KEY`**（shell 里那个 key 对中转 401，要用 `~/.codex/auth.json` 里的）。

---

## 5. 真 turn 命令（两端同一句，只换路径）

```powershell
# Windows（claude，别名桶）
C:\acp\node\node.exe acp-turn.mjs `
  --bin node_modules\@agentclientprotocol\claude-agent-acp\dist\index.js `
  --cwd C:\acp\turnwork --caps minimal --timeout 180 `
  --set model=opus --model-label opus `
  --prompt "reply with the single word: ok" `
  --log claude-turn.jsonl

# Windows（codex，必须锁模型）
C:\acp\node\node.exe acp-turn.mjs `
  --bin node_modules\@agentclientprotocol\codex-acp\dist\index.js `
  --cwd C:\acp\turnwork --caps minimal --timeout 180 `
  --set model=deepseek-v4.1-flash --model-label deepseek-v4.1-flash `
  --prompt "reply with the single word: ok" `
  --log codex-turn.jsonl
```

```bash
# Mac 对照（同一句，换 node_modules 路径；Mac 上有 darwin 树）
node ~/hive-field-32/helpers/acp-turn.mjs \
  --bin /tmp/acp-probe-21/node_modules/@agentclientprotocol/codex-acp/dist/index.js \
  --cwd /tmp/turnwork --caps minimal --timeout 180 \
  --set model=deepseek-v4.1-flash --model-label deepseek-v4.1-flash \
  --prompt "reply with the single word: ok" --log /tmp/codex-turn.jsonl
```

判据（机器可读那一行）：`TURN_OK stopReason=end_turn elapsedMs=<n> model=<名>`；失败是 `TURN_FAIL stage=... error=...` 且退出码非 0。

---

## 6. 回报格式（**每台 Windows 一份**，文件名 `<机器名>-result.md`）

```markdown
## 结论
runtime 冷启动：通过 / 失败    真 turn（claude / codex）：通过 / 失败 / 部分
一句话理由：

## 环境钉死
winver：  node -v：  npm -v：  架构（x64/ARM64）：

## 验收逐项
| # | 检查项 | 结果 | 证据（命令 + 关键输出，≤5 行） |
|---|---|---|---|
| ② | win32 两个 exe | 通过/失败 | 路径 + **精确字节数** |
| ② | npm ci --offline | | `added N packages`；是否出现 `ERR!` |
| ③ | verify.ps1 | | `VERDICT:` 行 + `ACP_INITIALIZE_OK` ×2 |
| ④ | LLM 通路 | | `http_code` + `time_total` |
| ⑤ | claude 真 turn | | `TURN_OK/TURN_FAIL` 原文 |
| ⑤ | codex 真 turn | | 同上 + `model=` |
| ⑦ | 防火墙 | | 是否弹窗 / 弹的是什么 / 选了什么 |

## 关键数字
npm ci 耗时：   verify.ps1 耗时：   两个 turn 各耗时：   实际模型名：

## 阻塞点（每项：现象 / 错误原文 / 已尝试 / 判断 —— ≤5 行）
```

---

## 7. 失败分支（先查这张表，别盲试）

| 现象 | 先查 | 判断 |
|---|---|---|
| `npm ci` 成功但 `verify.ps1` 报 `MISS node_modules\@openai\codex-win32-x64\...` | 是不是漏了 `--os=win32 --cpu=x64` | npm 对 optionalDependencies 失败**静默跳过且 exit 0**，只有数 exe 才能发现 |
| `curl.exe` 返回 `000` | 打的是不是 `curl.exe`；`Get-NetFirewallProfile`；`ping <MAC_IP>` | PowerShell 里 `curl` 是别名 |
| `TURN_FAIL stage=session/prompt` 且错误里有 `Please wait N seconds` | 429 冷却，绑在**凭证/模型**上不在进程上 —— 重启无用 | 换模型（§3 表），不重启任何东西 |
| codex turn 卡满 30 s 再失败 | 是不是没锁 `deepseek-v4.1-flash` | 默认 `gpt-5.6-luna` 在 Tailscale 死桶里 |
| 两个 turn 全灭、但 `/v1/models` 仍 200 | 外网断了（列表是本地配置拼的） | **断网时 LLM 必然全灭，没有离线替代**（本机无 ollama、无 gguf 权重）。别编造「切本地模型」 |
| `codex.exe` 被 Defender 拦 | 手动跑一次 `codex.exe --version` | 演示前先放行 |
| 某步超过 15 分钟没进展 | — | 停，回报「卡在哪一步 + 错误原文」，这比「好像能跑」有用得多 |
