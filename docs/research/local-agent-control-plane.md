# 本地 coding agent 接入群聊：控制面 + 可达性 硬事实调研

> 目标：为 hive（BYOA 群聊）提供可落地技术选型依据。
> 范围：A. 本地 CLI agent 的可编程控制面；B. 公网群聊服务端唤醒局域网内本机 agent 的可达性方案。
> 本文只报事实与出处，不含代码设计。

**调研日期**：2026 年（本地实测环境：macOS 15.6.1 / arm64）
**方法**：
1. **本地实测**（最强一手证据）——直接读取本机已安装 CLI 的 `--help` / `--version`，并对其中两个控制面**真实跑通**了握手命令（无 LLM 调用）。
2. **官方文档 / 源码**——官方文档站点、官方 GitHub raw 源文件、协议规范原文、npm registry。
3. 检索来源仅用于发现，不作为结论依据。

**证据分级约定**
- `确认` = 一手文档原文 / 本机实测输出 / 规范原文可直接支撑。
- `存疑` = 有出处但存在版本差异、条件限制、或文档间口径不一致。
- `未找到证据` = 未能在本次调研范围内找到权威表述（不等于不存在）。

**本机实测版本**
| CLI | 版本 | 二进制路径 |
|---|---|---|
| Claude Code | `2.1.228` | `~/Library/pnpm/bin/claude` → `@anthropic-ai/claude-code/bin/claude.exe` |
| OpenAI Codex CLI | `codex-cli 0.151.0` | `~/Library/pnpm/bin/codex` |
| pi | `0.86.1`（`@earendil-works/pi-coding-agent`） | `~/Library/pnpm/bin/pi` |

---

# A. 本地 CLI agent 的「可编程控制面」

## A.1 Claude Code CLI

一手来源：本机 `claude --help`（v2.1.228）；官方文档 <https://code.claude.com/docs/en/headless>、<https://code.claude.com/docs/en/cli-reference>、<https://code.claude.com/docs/en/sessions>、<https://code.claude.com/docs/en/agent-sdk/overview>。

### A.1.1 headless / print 模式 —— `确认`

```
claude -p "prompt"            # --print：非交互，打印结果后退出
```
- `-p, --print`：*"Print response and exit (useful for pipes)"*。**非交互模式下会跳过 workspace trust 对话框**（`-p` 或 stdout 非 TTY 时均跳过），文档明确警告"只在信任的目录里使用"。（来源：本机 `--help`；headless 文档"Basic usage"）
- `-p` 与部分选项不兼容：文档原文 *"Claude Code rejects `--bg`, and rejects `--cloud` with a task description, with an error naming the conflict; `--cloud` with a session ID and `-p` instead queues a message into that cloud session and exits."*（来源：headless 文档 Basic usage）
- 非交互模式会读 stdin（管道输入上限 **10MB**，超限报错并非零退出）。（来源：headless 文档"Pipe data through Claude"）
- 失败上报位置：启动前失败 → stderr；运行中失败（如缺认证）→ **作为 stdout 上的 result 输出**。（来源：headless 文档）

### A.1.2 `--output-format stream-json` —— `确认`

```
--output-format <format>   # 仅配合 --print：text(默认) | json(单次结果) | stream-json(实时流)
```
- `json`：结构化 JSON，含 `result`、`session_id`、metadata；官方示例 `claude -p "Summarize this project" --output-format json | jq -r '.result'`；payload 含 `total_cost_usd` 与按模型拆分的成本（**客户端估算值，可能与账单不符**）。
- `stream-json`：**newline-delimited JSON**，每行一个事件对象；文档示例搭配 `--verbose --include-partial-messages` 使用，并可按 `--include-partial-messages` 拿到 token 级增量。
- `--include-partial-messages`、`--forward-subagent-text`、`--include-hook-events` 均标注 *only works with `--print` / `--output-format=stream-json`*（本机 `--help`）。
- `--input-format text|stream-json`：仅配合 `--print`；`stream-json` 为 *"realtime streaming input"*。`--replay-user-messages` 需同时 `--input-format=stream-json` 与 `--output-format=stream-json`（本机 `--help`）。
- 权限拒绝在 `stream-json` 下表现为 `permission_denied` system message，最终 result message 在 `permission_denials` 中列出。（来源：headless 文档）
- **`存疑`**：`--verbose` 是否为 `stream-json` 的强制前置。文档所有示例都带 `--verbose`，`--help` 未把 `--verbose` 列为条件选项，官方也未明确写"必须"。社区帖（buildthisnow 等）称必需。→ 建议实测确认。

### A.1.3 结构化最终工件 —— `确认`

```
claude -p "..." --output-format json --json-schema '<JSON Schema>'
```
- 返回体包含请求 metadata（session ID、usage 等），结构化结果放在 **`structured_output`** 字段。
- schema 非法 → `Error: --json-schema is not a valid JSON Schema` + 校验器诊断并非零退出。
- 接受 `"format"` 关键字（如 `format: email`）但**当作注解、不强制**。v2.1.205 之前会静默忽略非法 schema 并返回非结构化文本。

### A.1.4 `--resume` / `--continue` / `--session-id` / `--fork-session` —— `确认`

| 参数 | 语义（本机 `--help` + sessions 文档） |
|---|---|
| `-c, --continue` | 继续当前目录最近一次对话 |
| `-r, --resume [value]` | 按 session ID 恢复；或打开交互式选择器；**也可传某个 session 的 `.jsonl` transcript 绝对路径** |
| `--session-id <uuid>` | *"Use a specific session ID for the conversation (must be a valid UUID)"* |
| `--fork-session` | 恢复时创建**新** session ID 而非复用原 ID（配合 `--resume` / `--continue`） |
| `-n, --name <name>` | 设置会话显示名 |
| `--no-session-persistence` | **仅配合 `--print`**：会话不落盘、**无法被 resume** |
| `--from-pr [value]` | 恢复与某个 PR 关联的会话 |
| `--teleport [session]` | 恢复 teleport 会话（可选指定 session ID） |

关键行为（来源：sessions 文档）：
- `claude --resume <session-id>` 可**在任意目录**执行：先在当前项目目录及其 git worktree 找，再全机扫描；跨项目解析仅在**恰好一个其他项目**持有该 ID 的 transcript 时生效（防止手抄副本导致恢复错误会话）。
- **`claude -p` / Agent SDK 创建的会话被排除在 session picker 和 `claude --continue` 之外**；但仍可显式 `claude --resume <session-id>` 恢复。
- `--continue` 会包含 `-p`、SDK、`/loop` 会话（原文：*"When you run `claude -p --continue`, Claude Code includes `-p`, SDK, and `/loop` sessions."*）→ 与上一条不矛盾，是"裸 `claude --continue`"与"`claude -p --continue`"两种口径。**`存疑`→实为口径差异，已澄清。**
- 恢复**不还原**：`--mcp-config`、`--settings`、`--plugin-dir`、`--fallback-model`、`--add-dir`（含会话中 `/add-dir` 添加的目录）需要重新传；`--system-prompt` / `--append-system-prompt` 另有专门规则。
- **权限模式**：非交互恢复（`claude -p --resume` / `-p --continue`）**不还原**存下来的权限模式，而是按"新 `claude -p` 会用的模式"启动（例外：结束于 plan mode 时，且需同时满足四个条件——传了 `--permission-prompt-tool`、未传 `--permission-mode`/`--dangerously-skip-permissions`、未传 `--fork-session`、不是通过 channels 启动）。

### A.1.5 「全新干净上下文一次性会话」怎么起 —— `确认`

三条原语可组合：

1. **干净上下文**：不传 `--continue` / `--resume`，每次 `claude -p` 就是新会话；也可显式 `--session-id <new-uuid>` 抢占命名。
2. **最小化上下文加载**：`--bare`（本机 `--help`）——跳过 hooks、LSP、plugin sync、attribution、auto-memory、background prefetches、keychain 读取、**CLAUDE.md 自动发现**；设置 `CLAUDE_CODE_SIMPLE=1`；Anthropic 认证强制走 `ANTHROPIC_API_KEY` 或 `--settings` 里的 `apiKeyHelper`（**不读 OAuth / keychain**）。文档原文：*"`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release."* 上下文需显式通过 `--system-prompt[-file]`、`--append-system-prompt[-file]`、`--add-dir`、`--mcp-config`、`--settings`、`--agents`、`--plugin-dir` 传入。
3. **不落盘**：`--no-session-persistence`（仅 `-p`）→ 无法被 resume（本机 `--help`）。另有 `CLAUDE_CODE_SKIP_PROMPT_HISTORY` 环境变量（全模式抑制 transcript 写入）。

另有更严格的隔离档：`--safe-mode`（禁用全部自定义：CLAUDE.md、skills、plugins、hooks、MCP servers、自定义命令/agent、输出样式、workflow、主题、键位等；管理员策略设置仍生效）。`--strict-mcp-config`（只使用 `--mcp-config` 指定的 MCP server）。

### A.1.6 「任务结束立即销毁」怎么保证 —— `确认`（文档有明确语义）

- **正常结束**：`-p` 在给出最终结果后退出。
- **SIGTERM**：退出码 **143**；把进行中的 turn 标记为**未完成、不记录 result**；**杀掉仍在运行的 Bash 命令的整个进程树**；然后跑 `SessionEnd` hooks 并退出；退出过程中不发新 tool call、不发新 model 请求、不跑除 `SessionEnd` 以外的 hook。若当时在等权限提示，SIGTERM 会让该提示**保持未回答**（若通过 Agent SDK 关闭输入，则输入一结束就取消该提示）。
  - 想"体面结束 turn" → 先发 **SIGINT**，或调用 Agent SDK 的 `interrupt()`，再停进程。恢复该会话时，Claude Code 会**继续 SIGTERM 打断的那个 turn**。
- **后台任务清理**：`-p` 期间启动的后台 Bash task（dev server / watch build）在 *"Claude 返回最终结果且 stdin 关闭后约 5 秒"* 被终止；后台 **subagent / workflow** 反而会让 `-p` 保持打开直到其完成（因为其结果属于最终输出），默认**连续空闲等待上限 10 分钟**（`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`，设 0 为无上限），到点停止并**丢弃部分结果**；Monitor watch 默认 5 分钟超时。

### A.1.7 `/clear` 在 CLI / headless 下的等价物 —— `确认`

- 交互式 `/clear`：*"start fresh with an empty context. Claude Code saves the previous conversation; resume it with `/resume`"*；`/clear <name>` 会为**离开的**会话命名，新会话则变为未命名。会话数据持续写入本地 transcript，所以 *"you can return to one after exiting or running `/clear`"*。→ 即：`/clear` = 开新会话 + 旧会话保留，**不是**清空存储。
- **headless 等价物**：新起一次 `claude -p`（不传 `--continue`/`--resume`）；要显式控制 ID 就配 `--session-id <uuid>`；要连旧会话都不留痕就加 `--no-session-persistence`。
- 另有 `/compact [instructions]`（用摘要替换历史，会话内、不换 session）与 `/context`（查看上下文占用）。
- 会话数据删除：`claude project purge`（清项目 transcript 及相关状态）；transcript 默认 **30 天** `cleanupPeriodDays` 保留策略自动清理；`claude rm <id>` 删后台会话时 transcript **仍留在磁盘**、仍可 `--resume`。

### A.1.8 MCP / Agent SDK 能否直接编程起停会话 —— `确认`（SDK 是官方路径）

- **Agent SDK**：Python + TypeScript 两个库，提供与 Claude Code 相同的 tools / agent loop / 上下文管理。官方表述：*"The SDK is available as a library for Python and TypeScript only. To drive the same agent loop from another language, run the CLI as a subprocess with the `-p` flag and `--output-format json`."*
- SDK 能力清单（官方表）：built-in tools、Hooks、Subagents、MCP、Permissions、**Sessions（"Maintain context across exchanges, resume or fork later"）**、Skills/commands/memory、Plugins。
- 提供 streaming input、interrupt()、结构化输出、approval 回调等（文档目录：Handle approvals and user input / Streaming Input / Get structured output from agents / Persist sessions to external storage）。
- **`存疑`（第三方来源）**：SDK 实现上是 **spawn Claude Code CLI 作为子进程**，而非纯 API 库（来源：<https://www.ksred.com/the-claude-agent-sdk-what-it-is-and-why-its-worth-understanding/>）。这解释"非 Py/TS 语言请直接 subprocess `-p`"的建议，也意味着 SDK 的隔离边界与 CLI 相同。官方文档未如此直白说明，故降级为存疑。
- **MCP**：`--mcp-config <configs...>`（文件或 JSON 字符串，可多个）、`--strict-mcp-config`、`claude mcp` 子命令管理。MCP server 条目启动时会校验、校验失败的条目被跳过（运行继续且干净退出，需自己检查字段）。
- **`未找到证据`**：Claude Code 是否有"常驻 JSON-RPC 会话服务器"（类比 codex app-server / pi rpc）。目前只见 `--input-format stream-json`（长驻进程 + JSONL 输入）与 SDK 两条路。另有**未深查**的既有远程面：`--remote-control [name]`、`--remote-control-session-name-prefix`、`claude agents`（后台 agent 管理）、`claude ultrareview`（云端多 agent code review）。

### A.1.9 其他与"无人值守"强相关 —— `确认`（本机 `--help`）

- 权限：`--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`；`--allowedTools` / `--disallowedTools` / `--tools`；`--dangerously-skip-permissions`；`--allow-dangerously-skip-permissions`。
- 预算/超时：`--max-budget-usd <amount>`（仅 `-p`）。
- 模型：`--model`、`--fallback-model`（仅 `-p`）、`--effort`。
- 后台：`--bg, --background`（起后台 agent 后立刻返回，用 `claude agents` 管理）——**但不能与 `-p` 同用**。

---

## A.2 OpenAI Codex CLI

一手来源：本机 `codex --help` / `codex exec --help` / `codex app-server --help`（v0.151.0）；官方文档 <https://learn.chatgpt.com/docs/non-interactive-mode>、<https://learn.chatgpt.com/docs/developer-commands>、<https://developers.openai.com/codex/app-server>、<https://learn.chatgpt.com/docs/codex-sdk>。

### A.2.1 `codex exec` 与非交互模式 —— `确认`

- `codex exec "<task>"`（别名 `codex e`）= 非交互模式，专为脚本 / CI 设计。
- 关键 IO 语义：*"While `codex exec` runs, Codex streams progress to **stderr** and prints only the final agent message to **stdout**."* → 便于 `| tee` / 重定向。
- stdin：不传 prompt（或用 `-`）则从 stdin 读；**若 stdin 被管道输入且同时给了 prompt，prompt 作为指令、stdin 作为附加上下文**（写入 `<stdin>` 块）。
- 默认**需要 git 仓库**，可用 `--skip-git-repo-check` 关闭。
- `--ephemeral`：**不把会话 rollout 文件落盘**。→ "一次性、结束即销毁"的直接原语。
- 上下文隔离：`--ignore-user-config`（不加载 `$CODEX_HOME/config.toml`，认证仍用 `CODEX_HOME`）、`--ignore-rules`（跳过用户/项目 execpolicy `.rules`）、`-C/--cd`、`--add-dir`。
- MCP：若配置了 `required = true` 的 MCP server 且初始化失败，`codex exec` **直接报错退出**而不是绕过。

### A.2.2 JSON 输出与结构化最终工件 —— `确认`

- `--json`：stdout 变 **JSON Lines (JSONL)** 事件流。事件类型：`thread.started`（含 `thread_id`）、`turn.started`、`turn.completed`（含 `usage`）、`turn.failed`、`item.*`、`error`。item 类型含 agent message、reasoning、command execution、file change、MCP tool call、web search、plan update。
  官方样例：
  ```
  {"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
  {"type":"turn.started"}
  {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
  {"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
  {"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
  ```
- `-o, --output-last-message <FILE>`：把最终消息写入文件（**同时也仍打印到 stdout**）。
- `--output-schema <FILE>`：要求最终响应符合给定 JSON Schema。官方示例：`codex exec "Extract project metadata" --output-schema ./schema.json -o ./project-metadata.json` → 落盘即结构化 JSON。**这是"以结构化 JSON 返回最终工件"的一等公民。**
- `--color always|never|auto`。

### A.2.3 `--resume` / 会话隔离 —— `确认`

- `codex exec resume <SESSION_ID|thread name> "<prompt>"`；`--last` 取最近一次；`--all` 关闭 cwd 过滤（列全部）。
- `codex exec fork <id>`：把某会话 fork 成新会话。
- 交互侧对应：`codex resume [--last]`、`codex fork [--last]`、`codex archive/delete/unarchive <id|name>`、`codex queue --thread <THREAD> --message <TEXT>`（向既有会话**追加消息**，支持 `--remote <ADDR>`）。
- 会话隔离原语：`--ephemeral`（不落盘）、`--thread-source <SOURCE>`（为新/fork 线程打来源标记）、`--ignore-user-config`、profile 分层 `-p/--profile <name>`。

### A.2.4 沙箱 / 审批开关 —— `确认`

- `-s, --sandbox read-only | workspace-write | danger-full-access`。**`codex exec` 默认 read-only**（官方文档：*"By default, `codex exec` runs in a read-only sandbox."*）。
- `-a, --ask-for-approval on-request | never`（`never` = 从不请求批准，执行失败立即回给模型）。
- `--approve-for-me`：把审批请求路由到"自动 review"，使用 `workspace-write` 沙箱。
- `--dangerously-bypass-approvals-and-sandbox`：跳过全部确认且不沙箱（文档用大写 EXTREMELY DANGEROUS 警告）。
- `--dangerously-bypass-hook-trust`：无需持久 hook 信任即运行 hooks（仅供已审查 hook 来源的自动化）。
- `--full-auto` 已废弃（仍兼容 + 打警告），官方推荐改用显式 `--sandbox workspace-write`。
- 认证：默认复用 CLI 已保存认证；CI 建议**只对需要的单次调用**设 `CODEX_API_KEY`（官方明确警告不要把 `OPENAI_API_KEY`/`CODEX_API_KEY` 设为 job 级环境变量）。`CODEX_API_KEY` 可用于 `codex exec`、`codex review`、TypeScript SDK 和 `codex exec-server --remote`。

### A.2.5 ★ `codex app-server`：完整的双向 JSON-RPC 控制面 —— `确认`

这是本次调研中"最接近现成控制面"的东西。

**协议**（官方原文）：*"Like MCP, codex app-server supports bidirectional communication using **JSON-RPC 2.0** messages (with the `"jsonrpc":"2.0"` header **omitted on the wire**)."*

**传输**（`--listen`）：
| 值 | 语义 |
|---|---|
| `stdio://`（默认） | newline-delimited JSON (JSONL) |
| `ws://IP:PORT` | WebSocket，**一条 JSON-RPC 消息 = 一个 WebSocket text frame**；官方标注 *experimental and unsupported* |
| `unix://` / `unix://PATH` | Codex 默认 app-server control socket 或自定义路径上的 WebSocket（走标准 HTTP Upgrade 握手） |
| `off` | 不暴露本地传输 |

`ws://IP:PORT` 监听器**同时**提供健康探针：`GET /readyz`（可接受新连接即 200）、`GET /healthz`（**不含 `Origin` 头**时 200；带 `Origin` → 403）。

**WebSocket 鉴权**（官方强调：*"Non-loopback WebSocket listeners currently allow unauthenticated connections by default during rollout, so configure WebSocket auth before exposing one remotely."* —— 这是**必须注意的 rollout 期默认放行**风险）：
```
--ws-auth capability-token --ws-token-file /absolute/path
--ws-auth capability-token --ws-token-sha256 HEX
--ws-auth signed-bearer-token --ws-shared-secret-file /absolute/path
（signed-bearer 另有 --ws-issuer / --ws-audience / --ws-max-clock-skew-seconds）
```
客户端在 WebSocket 握手时以 `Authorization: Bearer <token>` 出示凭证；app-server 在 JSON-RPC `initialize` **之前**即完成鉴权。官方建议优先 `--ws-token-file` 而非命令行明文 token。

**生命周期 / 背压**：WebSocket 模式使用有界队列；入站满时以 JSON-RPC 错误码 **-32001** 拒绝，消息 `"Server overloaded; retry later."`，客户端应指数退避 + 抖动重试。

**握手**：每条连接必须先发一次 `initialize`（带 `clientInfo`），随后发 `initialized` notification。未初始化前的请求 → `Not initialized`；重复 `initialize` → `Already initialized`。`initialize.params.capabilities` 支持 `optOutNotificationMethods`（精确匹配，支持通配/前缀？—— 原文明确 *"Matching is exact (no wildcards or prefixes)"*）、`requestAttestation`、`mcpServerOpenaiFormElicitation`。实验性 API 需 `capabilities.experimentalApi = true`，否则被拒：`<descriptor> requires experimentalApi capability`。

**核心原语**：`Thread`（会话）→ `Turn`（一次用户请求 + 后续 agent 工作）→ `Item`（输入/输出单元）。

**API 面（节选，均为文档原文方法名）**：
- 线程：`thread/start`、`thread/resume`、`thread/fork`（可 `lastTurnId` 或 `ephemeral: true` 内存 fork）、`thread/read`、`thread/list`、`thread/turns/list`、`thread/items/list`、`thread/loaded/list`、`thread/name/set`、`thread/metadata/update`、**`thread/archive`**、**`thread/delete`**（永久删除，含 spawn 出的后代线程）、`thread/unsubscribe`、`thread/unarchive`、`thread/compact/start`、`thread/rollback`（deprecated）、`thread/shellCommand`（**沙箱外、完全访问**）、`thread/backgroundTerminals/clean|list|terminate`。
- 回合：`turn/start`、**`turn/steer`**（把用户输入追加到进行中的 turn，返回 `turnId`）、**`turn/interrupt`**（取消；成功为 `{}`，turn 以 `status: "interrupted"` 结束）、`thread/inject_items`（把原始 Responses API items 追加进模型可见历史，不启动 user turn）。
- 审批 / 人机交互（**以 server→client request 形式**）：`item/permissions/requestApproval`（让客户端授予网络/文件系统权限子集）、`mcpServer/elicitation/request`、`tool/requestUserInput`（1–3 个短问题，可含自由选项）。
- 命令 / 进程：`command/exec`、`command/exec/write`、`command/exec/terminate`、`command/exec/resize`、`command/exec/outputDelta`（通知）；实验性 `process/spawn`、`process/writeStdin`、`process/kill`、`process/outputDelta`、`process/exited`。
- 其他：`review/start`、`model/list`、`modelProvider/capabilities/read`、`experimentalFeature/list|enablement/set`、`environment/info`、`permissionProfile/list`、`collaborationMode/list`、`skills/*`、`hooks/list`、`marketplace/*`、`plugin/*`、`app/*`、`mcpServer/*`（含 `mcpServer/oauth/login`）、`config/read|value/write|batchWrite`、`configRequirements/read`、**`fs/readFile|writeFile|createDirectory|getMetadata|readDirectory|remove|copy|watch|unwatch|changed`**、`feedback/upload`、`externalAgentConfig/detect|import`。

**Schema 生成**：`codex app-server generate-ts --out ./schemas`、`codex app-server generate-json-schema --out ./schemas`（生成物与所运行的 Codex 版本精确对应）。

**远程 TUI 用法（官方示例）**：
```bash
codex app-server --listen ws://127.0.0.1:4500
codex --remote ws://127.0.0.1:4500
# 非本地：
export CODEX_REMOTE_TOKEN="$(cat "$HOME/.codex/app-server-token")"
codex --remote wss://remote-host:4500 --remote-auth-token-env CODEX_REMOTE_TOKEN
```
`--remote` 接受 `ws://` / `wss://` / `unix://` / `unix://PATH`；官方明确 *"Use plain WebSockets only for localhost or an SSH port-forwarded connection."* `codex queue`、`codex agents` 都支持 `--remote` + `--remote-auth-token-env`。

**本机实测（重要）**：向 `codex app-server`（stdio）发送 `initialize` + `initialized` 后，**真实收到合法 JSON-RPC result**：
```json
{"id":0,"result":{"userAgent":"hive-research/0.151.0 (Mac OS 15.6.1; arm64) xterm-256color (hive-research; 0.1.0)","codexHome":"/Users/rolex/.codex","platformFamily":"unix","platformOs":"macos"}}
{"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"RolexdeMacBook-Air.local","installationId":"...","environmentId":null},"emittedAtMs":...}
```
→ 控制面**确认可用**，且 server 会主动推送 notification（`remoteControl/status/changed`）。

### A.2.6 ★ Codex 的"远程唤醒"既有设施 —— `确认`（直接命中问题 B）

| 命令 | 语义（`--help` 原文摘要） |
|---|---|
| `codex remote-control start\|stop\|pair` | *"[experimental] Manage the app-server daemon with remote control enabled"*；`pair` 生成并打印**短时效手动配对码**；支持 `--json` 机器可读输出 |
| `codex app-server --code-mode-host <URL>` | 让 app-server 作为客户端**主动出站**连到远程 Code Mode host（`wss://`；`ws://` 仅限 localhost/SSH 转发）。不改 `--listen`，只控制 app-server **出站**到其 Code Mode host 的连接；同一 app-server 进程内的所有 thread 共享该连接 |
| `codex exec-server` | *"[EXPERIMENTAL] Run the standalone exec-server service"*；`--listen ws://IP:PORT`（默认）或 `stdio`；**`--remote <URL>`：把这个 exec-server 注册为远程环境**；`--environment-id`、`--name`、**`--use-agent-identity-auth`**（用 `CODEX_ACCESS_TOKEN` 的 Agent Identity 认证做远程注册）；`--exit-on-stdin-close`（父进程 stdin 关闭即退出，环境变量 `CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE`）；`exec-server forward` 可把既有 WebSocket exec-server 注册为远程环境 |
| `codex agents [--remote <ADDR>]` | 浏览**共享本地 app-server daemon** 上的全部 agent 会话；`-C/--cd` 指定远程服务器上新任务的目录 |
| `codex app-server daemon` | 管理本地 app-server daemon |
| `codex app-server proxy` | 把 stdio 字节代理到运行中的 app-server control socket |

→ **`codex exec-server --remote` + `--use-agent-identity-auth` 就是"本机主动注册到远端、由远端下发任务"的第一方实现**，且是"环境注册"而非"入站端口暴露"。

### A.2.7 SDK —— `确认`

- 官方：*"If you are automating jobs or running Codex in CI, use the **Codex SDK** instead."*（言下之意：app-server 面向深集成产品，SDK 面向自动化）。
- Python SDK 通过 JSON-RPC 控制**本地** Codex app-server，要求 Python ≥ 3.10；发布的 SDK 绑定固定版本的 Codex CLI runtime。
- TypeScript SDK：`@openai/codex-sdk`，npm `latest = 0.155.1`（本次经 npm registry 实测确认存在与版本）。

---

## A.3 pi（`@earendil-works/pi-coding-agent`）

一手来源：本机 `pi --help`（v0.86.1）+ **本机已安装包内的 docs/**（`docs/rpc.md`、`docs/json.md`、`docs/sessions.md`、`docs/usage.md`、`docs/sdk.md`、`docs/session-format.md`），包路径 `~/Library/pnpm/global/5/node_modules/@earendil-works/pi-coding-agent/`；官方站点 <https://pi.dev/>。

### A.3.1 四种运行模式 —— `确认`

README 原文：*"Pi runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps."* 官方站点：*"**Print/JSON:** `pi -p "query"` for scripts, `--mode json` for event streams."*

| 模式 | 入口 | 输出 |
|---|---|---|
| interactive | `pi` | TUI |
| print | `pi -p "..."` | 处理后退出 |
| JSON | `pi --mode json "..."` | **全部事件按 JSON Lines 输出** |
| RPC | `pi --mode rpc` | stdin 收命令、stdout 收响应 + 事件（JSONL） |
| SDK | `createAgentSession()` / `createAgentSessionRuntime()` | 进程内库调用 |

### A.3.2 JSON 模式 —— `确认`

- 首行是**会话头**：`{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}`，随后按事件发生顺序输出 `agent_start` / `turn_start` / `message_start` / `message_update` / `message_end` / `turn_end` / `agent_end` 等。
- `AgentSessionEvent` = `AgentEvent` ∪ `queue_update` ∪ `compaction_start|end` ∪ `auto_retry_start|end`。
- 示例：`pi --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'`
- RPC 模式的 framing 有强约束（官方明确）：**严格 JSONL，仅以 LF (`\n`) 作为记录分隔符**；可选接受 `\r\n`（剥掉尾部 `\r`）；**不要用通用行读取器**——Node `readline` 对 RPC 模式**不合规**，因为它还会在 `U+2028`/`U+2029` 处切分，而这两个字符在 JSON 字符串内是合法的。

### A.3.3 RPC 模式：25+ 命令的完整控制面 —— `确认`（且本机实测跑通）

**命令（stdin，每行一个 JSON）**：

| 分类 | 命令 |
|---|---|
| 提示 | `prompt`（可带 images；流式中必须给 `streamingBehavior: "steer"\|"followUp"`，否则报错）、`steer`、`follow_up`、`abort` |
| 会话 | **`new_session`**（可带 `parentSession`；可被 `session_before_switch` 扩展取消）、`switch_session`、`fork`、`clone`、`get_fork_messages`、`set_session_name`、**`get_last_assistant_text`**、`get_messages`、`get_state`、`get_session_stats`、`export_html` |
| 模型/思考 | `set_model`、`cycle_model`、`get_available_models`、`set_thinking_level`、`cycle_thinking_level` |
| 队列策略 | `set_steering_mode`（`all` / `one-at-a-time`）、`set_follow_up_mode` |
| 上下文/重试 | `compact`（可 `customInstructions`）、`set_auto_compaction`、`set_auto_retry`、`abort_retry` |
| Shell | `bash`、`abort_bash` |
| 发现 | `get_commands`（extension commands / prompt templates / skills） |

**响应**：`{"type":"response","command":"...","success":true|false,"data":{...}}`；所有命令支持可选 `id` 用于请求/响应关联。`prompt` 的 `success: true` 只表示"已接受/入队/立即处理"；**接受之后的失败通过正常事件流报告，不会为同一 id 再发第二个 response**。

**事件（stdout）**：`agent_start`|`agent_end`|`turn_start`|`turn_end`|`message_start`|`message_update`（含 `assistantMessageEvent`: `text_delta`/`thinking_delta`/`toolcall_delta`/`done`/`error` 等）|`message_end`|`tool_execution_start`|`tool_execution_update`（`partialResult` 是**累计**输出，客户端可整体替换显示）|`tool_execution_end`|`queue_update`|`compaction_start|end`|`auto_retry_start|end`|`extension_error`。事件**不含** `id`（只有 response 含）。

**扩展 UI 子协议**（这也是控制面的一部分）：`extension_ui_request`（`select`/`confirm`/`input`/`editor` 为**阻塞式对话框**，需回 `extension_ui_response`，可带 `timeout` 由 agent 侧自动用默认值解决；`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` 为 fire-and-forget）。RPC 模式下 `ctx.hasUI === true`、`ctx.mode === "rpc"`。

**本机实测（关键证据）**：向 `pi --mode rpc --no-session` 依次发送 `get_state` / `get_session_stats` / `new_session`，**真实收到**：
```json
{"id":"1","type":"response","command":"get_state","success":true,"data":{"model":{...},"thinkingLevel":"high","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionId":"01a0c348-...","autoCompactionEnabled":true,"messageCount":1,"pendingMessageCount":0}}
{"id":"2","type":"response","command":"get_session_stats","success":true,"data":{"sessionId":"01a0c348-...","tokens":{...},"cost":0,"contextUsage":{"tokens":187,"contextWindow":1048576,"percent":0.0178}}}
```
→ 无需任何 LLM 调用即可完成状态查询与会话替换；控制面**确认可用**。
（附带观察：该进程会自动加载用户已装的扩展 —— 本机输出中出现 `pi-messenger-swarm`、`pi-fff`、`i-have-adhd` 等扩展的 `setStatus` 事件，以及 `session_shutdown` 阶段的 `extension_error`。**这意味着"干净上下文"还必须用 `--no-extensions`/`-ne` 显式关闭扩展发现**。）

### A.3.4 session 目录与 resume —— `确认`

- 会话自动保存到 `~/.pi/agent/sessions/`，**按工作目录组织**：`~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl`（`<path>` 为 cwd 把 `/` 换成 `-`）。
- 结构：JSONL，每行一个带 `type` 的 JSON 对象；条目通过 `id`/`parentId` 构成**树**，可在同一文件内原地分支。版本：v1 线性（自动迁移）、v2 树、v3 事件统一（`hookMessage` 改名 `custom`），加载时自动迁移到 v3。
- 相关参数：`-c/--continue`（最近一次）、`-r/--resume`（选择器）、`--session <path|id>`（具体文件或**部分 UUID**）、**`--session-id <id>`（精确 project session ID，不存在则创建）**、`--fork <path|id>`、`--session-dir <dir>`、**`--no-session`（临时，不保存）**、`--name/-n`。
- 删除：直接删 `~/.pi/agent/sessions/` 下的 `.jsonl`；或在 `/resume` 选择器里 `Ctrl+D` 并确认（**可用时会用 `trash` CLI 而非永久删除**）。
- 交互命令对照：`/resume`、**`/new`**、`/name`、`/session`、`/tree`、`/fork`、`/clone`、`/compact`、`/export`、`/share`。→ **`/clear` 的 pi 等价物是 `/new`**；headless 等价物是"不带 `-c/-r/--session` 起新进程"或 `--no-session`。
- 会话内消息队列语义（与 RPC 命令一一对应）：Enter = steering（当前 assistant turn 的工具调用跑完后投递）；Alt+Enter = follow-up（agent 全部做完后投递）；Escape = abort 并把排队消息还给编辑器。

### A.3.5 扩展机制 —— `确认`

- TypeScript 扩展：`-e/--extension <path>`（可多次）、`pi install <source> [-l]`、`pi remove/uninstall`、`pi list`、`pi config`；`--no-extensions/-ne` 关闭扩展发现（显式 `-e` 仍生效）。
- 扩展可注册命令（`pi.registerCommand()`）、工具、CLI flag，并订阅生命周期事件（文档中出现 `session_before_switch`、`session_before_fork`、`session_shutdown`、`project_trust`、`tool_call` 等）。
- **`存疑`（安全性关键）**：官方明确 *"Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` **ignore those project resources**, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run."* 注意 `ask` 在非交互下**等同 ignore**（不会变成允许），但会被错读成"会询问"。→ 部署时须显式决定 `-a` / `-na` / `defaultProjectTrust`。
- 工具白/黑名单：`--tools/-t`、`--exclude-tools/-xt`、`--no-tools/-nt`、`--no-builtin-tools/-nbt`。官方示例的只读模式：`pi --tools read,grep,find,ls -p "Review the code in src/"`。
- 其他上下文开关：`--no-context-files/-nc`（关闭 AGENTS.md / CLAUDE.md 发现）、`--system-prompt`、`--append-system-prompt`、`.pi/SYSTEM.md`、`--no-skills/-ns`、`--no-prompt-templates/-np`、`--offline`。

### A.3.6 SDK —— `确认`

- `createAgentSession({ sessionManager: SessionManager.inMemory(), authStorage, modelRegistry })` → `{ session }`；`session.prompt()` / `steer()` / `followUp()` / `subscribe()`（返回 unsubscribe）/ `abort()` / `compact()` / `dispose()`；可读 `sessionFile`、`sessionId`、`messages`、`isStreaming`。
- **`SessionManager.inMemory()` = 纯内存会话**（对应"一次性"）。
- 会话**替换**类 API 在 `AgentSessionRuntime`（不在 `AgentSession`）：`newSession()`、`switchSession()`、`fork()`、`importFromJsonl()`。官方明确告诫：替换后 `runtime.session` 变了，**事件订阅绑在具体 `AgentSession` 上，必须重新订阅**；用扩展的话要重新 `runtime.session.bindExtensions(...)`。
- 官方推荐：Node/TS 应用**直接使用 `AgentSession`** 而不是 spawn 子进程（`docs/rpc.md` 开头明确写了这点）；子进程式 TS 客户端参考 `src/modes/rpc/rpc-client.ts`。
- 真实世界 SDK 集成案例（官方点名）：`openclaw/openclaw`。

---

## A.4 通用模式：一次性 agent 会话的生命周期原语

### A.4.1 原语清单与三家的对应关系 —— `确认`

| 生命周期原语 | Claude Code | Codex CLI | pi |
|---|---|---|---|
| **spawn** | `claude -p`（前台）/ `--bg`（后台，不可与 `-p` 同用）；或 spawn 长驻 `--input-format stream-json` 进程；或 Agent SDK | `codex exec`；或 `codex app-server`（长驻控制面）；SDK | `pi -p` / `pi --mode json` / `pi --mode rpc`；SDK `createAgentSession()` |
| **注入任务** | 命令行 arg / stdin；长驻进程写 JSONL 到 stdin | `codex exec "<task>"`；长驻则 `turn/start`、`turn/steer`、`thread/inject_items`；`codex queue --thread --message` | stdin JSONL `prompt` / `steer` / `follow_up`；SDK `session.prompt/steer/followUp` |
| **取结构化事件** | `--output-format stream-json` (+`--verbose`, `--include-partial-messages`) | `codex exec --json`（JSONL：`thread.started`/`item.completed`/`turn.completed`...） | `--mode json`（JSONL 事件）/ `--mode rpc`（响应+事件） |
| **取结构化最终工件** | `--output-format json --json-schema <schema>` → `structured_output` | `--output-schema <file>` + `-o <file>` | `get_last_assistant_text`；或自行从 `agent_end` / `turn_end` 事件提取（**无内置 JSON Schema 约束 — `未找到证据`**） |
| **中断/取消** | SIGINT（体面结束 turn）或 SDK `interrupt()`；SIGTERM = 退出码 143、turn 未完成、无 result | `turn/interrupt`（turn 以 `status:"interrupted"` 结束）；`command/exec/terminate`；`process/kill` | RPC `abort` / `abort_bash` / `abort_retry` / `abortCompaction()` |
| **杀掉会话** | 杀进程；`claude rm <id>` 只删后台会话记录（**transcript 仍在磁盘**） | `thread/delete`（永久删除并连带 spawn 出的后代）；`thread/archive` | 杀进程；删对应 `.jsonl`；SDK `dispose()` |
| **临时（不落盘）** | `--no-session-persistence`（仅 `-p`）；`CLAUDE_CODE_SKIP_PROMPT_HISTORY` | `--ephemeral`（`exec` 与 `exec resume` 均支持）；`thread/fork --ephemeral` | `--no-session`；`SessionManager.inMemory()` |
| **复用（resume）** | `--resume <id\|transcript-path>` / `--continue` / `--session-id <uuid>` / `--fork-session` | `codex exec resume <id\|--last>` / `codex exec fork`；`thread/resume`、`thread/fork` | `-c` / `-r` / `--session <path\|id>` / `--session-id <id>` / `--fork` / `switch_session` / `fork` / `clone` |
| **常驻服务端（可被远端驱动）** | **`未找到证据`**（只有长驻 `--input-format stream-json` 子进程 / SDK） | ✅ `codex app-server`（JSON-RPC 2.0 over stdio/ws/unix）+ `--listen ws://` | ✅ `pi --mode rpc`（JSONL stdin/stdout） |
| **发现/列举会话** | session picker；`claude agents`（后台 agent） | `codex agents`（含 `--remote`）、`thread/list` | `get_state`/`get_messages`；`/resume` 选择器 |

### A.4.2 结论性判断

1. **三家都支持"以结构化 JSON 返回最终工件"**，但**严格程度不同** —— `确认`
   - Claude Code：`--json-schema` 做**校验**（非法 schema 直接报错），结果在 `structured_output`。
   - Codex：`--output-schema` 做**约束**（最终响应符合 schema）+ `-o` 落盘，官方文档给了完整示例。
   - pi：只有事件流 + `get_last_assistant_text`；**未找到**内置 JSON Schema 约束能力。
2. **"一次性会话、结束即销毁"三家都有官方开关** —— `确认`：`--no-session-persistence`（claude，仅 `-p`）/ `--ephemeral`（codex，exec 与 resume 均可用）/ `--no-session`（pi）。
3. **只有 Codex 与 pi 提供"常驻、双向、可被远端驱动的会话服务器"**（`codex app-server` / `pi --mode rpc`）；Claude Code 这一层要么靠 SDK，要么靠长驻 `--input-format stream-json` 子进程。→ 若控制面是"服务端下发任务给常驻 agent 进程"，**Codex 与 pi 有现成的一等公民接口**。
4. **Codex 的 app-server 控制面在方法面上远超另两家**（含 `fs/*`、审批以 server→client request 形式回流、`turn/steer` 中途转向、`thread/archive|delete` 清理、`generate-ts`/`generate-json-schema` 生成客户端绑定）。但官方标注 WebSocket 传输 **experimental and unsupported**，且**非 loopback 监听在 rollout 期默认允许未认证连接** → 必须显式配 `--ws-auth`。
5. **ACP（Agent Client Protocol）是现成的"统一适配层"** —— `确认`（npm registry 实测存在）：`@agentclientprotocol/codex-acp`（latest `1.12.0`）、`@agentclientprotocol/claude-agent-acp`（latest `0.79.0`，描述为 *"An ACP-compatible coding agent powered by the Claude Agent SDK (TypeScript)"*）。ACP 规范：<https://agentclientprotocol.com/protocol/v1/overview>。→ **如果不想为每个 CLI 写一套适配器，ACP 是业界已有的收敛点**（Buzz 就走了这条路，见 B.3）。

---

# B. 让公网群聊服务端唤醒局域网内本机 agent

## B.1 反向隧道 / 中继模式（本机主动出站长连接，服务端下发任务）

### B.1.1 通用 L4/L7 反向隧道实现 —— `确认`

| 项目 | 出站机制 | 一手来源 | 关键事实 |
|---|---|---|---|
| **frp** | 客户端主动连 frps，支持 TCP/UDP/HTTP/HTTPS 反向代理 | <https://github.com/fatedier/frp> | *"a fast reverse proxy that allows you to expose a local server located behind a NAT or firewall to the Internet. It currently supports TCP and UDP, as well as HTTP and HTTPS protocols"* |
| **rathole** | 客户端主动连 rathole server（需公网 IP） | <https://github.com/rapiz1/rathole> | Rust；*"A secure, stable and high-performance reverse proxy for NAT traversal"*；**每个 service 强制 token**；二进制可小至 ~500KiB；吞吐与时延优于 frp |
| **chisel** | 隧道本身跑在 **HTTP/WebSocket** 之上（SSH 协议加密） | <https://github.com/jpillora/chisel> | *"tunnel access to the target network via WebSockets"*；**客户端指数退避自动重连**（`--min/max-retry-interval`），keepalive ping 超时能检测"静默死连接"（sleep/wake、NAT 超时、服务端重启）；**一条 TCP 连接上可开多个 tunnel endpoint**；反向端口转发（连接穿过 server 再从 client 出去）；支持经 SOCKS/HTTP CONNECT 代理 |
| **Pangolin** | WireGuard-based（`Newt` 客户端出站建隧道）+ 零信任反向代理 | <https://github.com/fosrl/pangolin>、<https://docs.pangolin.net/> | 开源 SASE：零信任 VPN + 零信任反向代理 + 特权访问管理 + identity-aware AI gateway，**共享一个身份与策略模型**；可自托管 |

### B.1.2 "出站长轮询"的权威参考架构：OpenAI Secure MCP Tunnel —— `确认`（★ 最贴近本问题）

来源：<https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>、<https://github.com/openai/tunnel-client>

- 官方定义：*"Secure MCP Tunnel lets you connect private MCP servers to supported OpenAI products **without opening inbound firewall ports or exposing those servers to the public internet**. Run `tunnel-client` inside the network that can already reach your MCP server; it opens an **outbound HTTPS path** to OpenAI, **pulls queued MCP work**, forwards requests locally, and returns responses through the same tunnel."*
- 机制原文：*"`tunnel-client` **long-polls** for queued work, forwards each JSON-RPC request to the private MCP server, and posts the response back through the tunnel."*；*"The private MCP server does not need a public listener."*
- 网络要求（原文表格）：出站到 `api.openai.com:443`（或控制面 mTLS 时 `mtls.api.openai.com:443`）走 `/v1/tunnel/*`；本地可达私网 MCP server（stdio 或 HTTP）。**"tunnel-client does not need inbound internet access."**
- 流式支持：*"When a connector asks for streamed results, the tunnel path can forward intermediate server-sent events."*
- 客户端还有一整套运维面：`/healthz`、`/readyz`、`/metrics`、`/ui`；Go SDK 可在同进程内用 MCP in-memory transport 嵌入 MCP server；提供 `docs/protocol.md` + `docs/openapi.json` 供其它语言实现兼容客户端；Homebrew 安装 `brew install openai/tools/tunnel-client`（自带 `cloudflared` companion）。
- 另有 Rust 客户端：<https://github.com/openai/codex> 同名 capability 集在 Codex 侧也有 `--ws-auth signed-bearer-token`。
- **为什么这是最强参考**：它是"局域网内进程被公网服务端唤醒执行任务并把结果送回"的**第一方、有文档、有协议规范、有运维面**的生产实现，而且协议就是 MCP/JSON-RPC —— 与我们的 CLI agent 天然兼容。

### B.1.3 第一方"本机注册到远端环境"：`codex exec-server` —— `确认`

见 A.2.6。要点：`codex exec-server --listen ws://IP:PORT` 起服务，再用 `--remote <URL>` **主动注册为远程环境**；`--use-agent-identity-auth` 用 `CODEX_ACCESS_TOKEN` 做 Agent Identity 认证；`--exit-on-stdin-close` 让父进程一关就退出（避免孤儿）。此外 `codex app-server --code-mode-host wss://...` 是 app-server **出站**连到一个远端 host 的另一种形态。

### B.1.4 协议层面的总结 —— `确认`

"服务端唤醒局域网 agent"实际可用的传输族：
- **裸 WebSocket**（Nostr relay、Codex app-server `ws://`）— 双向、长连、天然支持服务端推送。
- **WebSocket over HTTP**（chisel）— 能穿过只允许 HTTP(S) 出站的网络。
- **HTTP 长轮询**（OpenAI MCP Tunnel、Matrix `/sync`）— 最保守、最易过企业网络策略，代价是延迟与连接开销（MCP Tunnel 明确说它 short/open 之后靠 long-poll 拉）。
- **TCP/UDP 反向隧道**（frp、rathole）— 通用但把"裸端口"暴露给 broker。
- **WireGuard overlay**（Pangolin、Tailscale）— 网络层可达，但不是应用层消息通道。

---

## B.2 Tailscale / ZeroTier 类 overlay、Cloudflare Tunnel、ngrok：适用性与"陌生人群体"信任问题

### B.2.1 Cloudflare Tunnel（含 Quick Tunnel）—— `确认`

来源：<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>

- Quick Tunnel：`cloudflared tunnel --url http://localhost:8080` → 生成**随机 `trycloudflare.com` 子域**；**无需账号、无需 DNS、无需开端口**。
- 官方限制（原文）：
  - *"Quick Tunnels are intended for **testing and development only**. For production use, create a remotely-managed tunnel."*
  - *"Quick Tunnels are subject to a hard limit on the number of concurrent requests... Currently, this limit is **200 in-flight requests**. If a Quick Tunnel hits this limit, the HTTP response will return a **429**."*
  - *"Quick Tunnels **do not support Server-Sent Events (SSE)**."*
  - *"We don't guarantee any SLA or uptime of TryCloudflare."*
  - 需 `cloudflared` ≥ 2020.5.1。
- 生产路径 = **remotely-managed tunnel**（需 Cloudflare 账号 + 把域名 DNS 交给 Cloudflare）。

**对 BYOA 群聊的适配性判断**（研究者推断，非文档结论）：Quick Tunnel 的**每次运行随机 URL** + **无 SSE** + **200 并发上限/无 SLA** 三点，与"成员本机作为长期群成员、需要持续下行推送通道"直接冲突。它适合"临时把某个 demo 端口暴露一下"，不适合作为 N 个成员各自 agent 的常驻注册机制。

### B.2.2 Tailscale Funnel / Serve / 设备共享 —— `确认`

来源：<https://tailscale.com/docs/features/tailscale-funnel>、<https://tailscale.com/docs/features/sharing>、<https://tailscale.com/docs/reference/inviting-vs-sharing>

- **Funnel**：*"route traffic from the broader internet to a local service running on a device in your Tailscale network"*，**即使对方不用 Tailscale 也能访问**。机制：*"Tailscale does this using a TCP proxy and **Funnel relay servers**"*；*"The Funnel relay server **cannot decrypt** data sent over this proxy"*（端到端加密保留，本机 IP 被隐藏）。
- 状态与限制（原文）：**currently in beta**；所有套餐可用；需 Tailscale ≥ v1.38.3、MagicDNS、HTTPS + 有效证书、tailnet 策略文件里的 `funnel` node attribute；**只能用 tailnet 域名下的 DNS 名**；**只能监听 443 / 8443 / 10000**；**只有 TLS**；*"Traffic sent over a Funnel is subject to **non-configurable bandwidth limits**"*；**仅在能跑 Tailscale CLI 的平台可用**；macOS 必须用开源变体；同一端口不能在 Serve 与 Funnel 间复用（以最后一条命令为准）；频繁申请证书可能触发 Let's Encrypt 限速（可能要等 34 小时）。
- **Serve vs Funnel**：Serve 只在 tailnet 内共享；Funnel 对公网开放。另有**设备共享（sharing a device）**：把某台设备共享给另一个 Tailscale 账号的人，以及**邀请他人加入 tailnet**（官方文档把两者作为两条不同路径）。
- **陌生人群体场景的信任问题**（研究者推断 + 官方事实支撑）：Funnel URL 一旦给出，**任何拿到 URL 的人都能访问**（Tailscale 不在此层做应用鉴权）。而"设备共享/邀请入 tailnet"是**账号对账号的、逐设备的**关系——N 个陌生人成员意味着 N 次邀请与 N 个账号，**摩擦高、且把每个人的设备拉进同一个网络平面**（组网层可达性 ≠ 应用层授权）。

### B.2.3 ngrok —— `未找到证据`（一手）

本次未获取 ngrok 官方文档以核实其免费档并发/URL 稳定性等具体条款。检索结果多为第三方对比文章（<https://ngrok.com/compare/cloudflare-tunnel> 为官方对比页，但未抓取）。→ **不作为结论依据**。

### B.2.4 关键结论：隧道/overlay 只解决"可达"，不解决"身份 + 授权" —— `确认`（问题定性）+ 研究者推断（结论）

- Tailscale Funnel / Cloudflare Tunnel / ngrok 都是**网络可达性**方案：给定 URL 就能访问，**默认不带 per-member 身份与 per-message 授权**。Tailscale 的账号体系只在"邀请入 tailnet / 共享设备"这一层生效，且是逐设备的。
- 对 BYOA 群聊，**真正的风险模型是"我允许群里的谁、以什么身份、让我本机 agent 做什么"**，这需要应用层 message bus 上的身份（密钥/账号）+ 策略，而不是隧道。
- **因此正确形态是**：成员本机 **不暴露任何入站监听**，只由 **agent 进程**主动出站连到公共 broker；broker 按身份把任务作为"消息"投递给该 agent。这样：
  - 不需要每个成员配置隧道/端口/证书；
  - broker 的鉴权边界是**agent 身份**而非 IP/网络；
  - 与"群聊"这个概念天然同构（任务就是消息，回复就是消息）。

---

## B.3 Nostr relay / Matrix bridge 作为消息与身份层的现状

### B.3.1 ★ Buzz（`block/buzz`）：目标功能的现成参考实现 —— `确认`

来源：<https://github.com/block/buzz>、<https://raw.githubusercontent.com/block/buzz/main/ARCHITECTURE.md>、`NOSTR.md`、`VISION_REMOTE_AGENTS.md`、`VISION_AGENT.md`、`crates/buzz-acp/README.md`、`docs/practical-information-flow-for-buzz-agents.md`、`docs/owned-agent-discovery.md`、`block.xyz` 发布公告。

**定位**（README 原文）：*"Buzz is a self-hostable workspace where humans and AI agents share the same rooms."*；*"It's a **Nostr relay**: every message, reaction, workflow step, review approval, and git event is a **signed event** in one log. Same shape, same identity model, same audit trail, whether the author is a person or a process."*；*"Agents are members, not bots. Add an agent to a channel the same way you add a person."*
License：Apache-2.0（Block, Inc.），Rust monorepo。GitHub: 33.8k stars / 4.4k forks（页面显示值）。

**架构**（ARCHITECTURE.md）：
- 线格式 = **Nostr NIP-01**：`{id, pubkey, kind, tags, content, sig}`，`count` 为唯一 dispatch 开关；新增功能 = 新增 `kind` 数字，老客户端零破坏。
- relay 是唯一真源：所有读写经 relay（WebSocket）；无 P2P、无 gossip、无复制。技术栈：Axum + Postgres（events/channels/tokens/workflows/audit）+ Redis（presence `SET EX`、typing `ZADD`/`PUBLISH`）。
- **社区 = 由请求 host 决定的租户**：`req.community = resolve_host(connection.host)`，在 AUTH/EVENT/REQ/REST/media/git/search/workflow/pub-sub **之前**确立；未知 host **fail closed**。
- crate 分层：`buzz-core`(零 IO) → `buzz-db`/`buzz-auth`(NIP-42, NIP-98, API token, scopes, rate limiting)/`buzz-pubsub`/`buzz-search`/`buzz-audit`(**hash-chain 防篡改日志**)/`buzz-workflow` → `buzz-relay`；另有 `buzz-acp`、`buzz-sdk`、`buzz-cli`（*"agent-first CLI"*）、`buzz-media`(Blossom/S3)、`buzz-agent`、`buzz-dev-mcp`、`buzz-backend-kubernetes`、`buzz-conformance`、`buzz-pair-relay`、`buzz-pairing-cli`、`buzz-persona`、`buzz-push-gateway`、`buzz-relay-mesh`、`buzz-voice`、`buzz-ws-client` 等。

**协议实现清单**（`NOSTR.md`，标注 ✅/⚠️/❌）：
- ✅ NIP-29 relay-based groups（kind:9 群聊 + `#h <channel-uuid>`）、NIP-25 reactions（kind:7）、NIP-09 删除（kind:5）、NIP-01 profiles（kind:0）、NIP-42 认证（主动挑战 + 可选 pubkey allowlist）、NIP-11 relay info、**NIP-17 DMs（gift wrap, kind:1059）**、NIP-10 threads、**NIP-50 搜索**、NIP-29 群管理事件（9000 加人 / 9001 移人 / 9002 改元数据 / 9005 管理员删事件 / 9007 建群 / 9008 删群 / 9021 join request / 9022 退群）、relay 签名的群状态事件（**39000** 元数据 / **39001** 管理员 / **39002** 成员）、成员变更通知（**44100** 加入 / **44101** 移除）、**presence kind:20001（ephemeral，写 Redis，`"offline"` 时 clear）**、typing kind:20002、Blossom 媒体（BUD-01/02）、NIP-34 git 事件。
- ⚠️ Buzz-only：kind:40003 编辑、kind:40002 富文本（线格式可行但标准 NIP-29 客户端不渲染）；kind:9009 create invite 已接受存储但**副作用 handler 未实现**（no-op + warning）。
- ❌ kind:39003 group roles 已在 kind registry 定义但 relay **不发出**；NIP-04/NIP-44 DM 未实现，kind:10050 延后。
- 自定义 kind 段：40000–49999（如 **43001 KIND_JOB_REQUEST**、45001/45003 forum、**46001–46012 workflow**）；核心定义在 `crates/buzz-core/src/kind.rs`（文档写作时 **127 个 kind**）。
- pubkey allowlist：`BUZZ_PUBKEY_ALLOWLIST=true` 时，仅用 pubkey 认证（无 API token）的连接要查 `pubkey_allowlist` 表；有合法 **API token 者绕过 allowlist**；**fail-closed**（查库失败即拒）；失败返回通用 `auth-required: verification failed`（不泄露 allowlist 信息）；只能通过直接 SQL 管理。

**★ `buzz-acp`：把本机 coding agent 变成群成员的 harness**（`crates/buzz-acp/README.md` 原文图）：
```
Buzz Relay ──WS──→ buzz-acp ──stdio──→ Your Agent
                                            │
                                       Buzz CLI
                                    (send_message, etc.)
```
- *"The harness listens for **@mentions** on the relay, prompts your agent, and the agent replies using the Buzz CLI."*
- 支持任何 **stdio ACP** agent：**goose**（原生）、**codex**（经 `codex-acp`）、**claude code**（经 `claude-agent-acp`）。
- 每个 agent 一个 **Nostr keypair** = 其 Buzz 身份（`buzz-admin generate-key`）；**"Running multiple agents? Mint a separate keypair for each. Every agent needs its own identity."**
- 配置（env 或同名 flag）—— 这些直接回答了"陌生人群体如何授权"：

| 变量 | 默认 | 语义 |
|---|---|---|
| `BUZZ_PRIVATE_KEY` | 必填 | agent 的 Nostr 私钥（`nsec1...`），用于 relay 认证与身份 |
| `BUZZ_RELAY_URL` | `ws://localhost:3000` | relay WebSocket URL |
| `BUZZ_ACP_AGENT_COMMAND` | `goose` | 要 spawn 的 agent 可执行文件 |
| `BUZZ_ACP_AGENT_ARGS` | `acp` | 参数（**逗号分隔**；带值用 `-c,key="value"`） |
| `BUZZ_ACP_MCP_COMMAND` | 空 | 可选 MCP server 二进制 |
| `BUZZ_ACP_IDLE_TIMEOUT` | `620` | 静默多久取消 turn（任何 agent stdout 活动都重置） |
| `BUZZ_ACP_MAX_TURN_DURATION` | `7200` | 单 turn 绝对墙钟上限（安全阀） |
| `BUZZ_ACP_AGENTS` / `--agents` | `1` | agent 子进程数 **1–32** |
| `BUZZ_ACP_LAZY_POOL` / `--lazy-pool` | `false` | **先连上、订阅、把接受的工作排队，再启动 ACP/LLM 子进程**；首个接受的事件唤醒一个 pool 初始化任务；失败时在有工作时按有界指数退避重试 |
| `--heartbeat-interval` | `0` | 心跳提示间隔秒（启用时须为 0 或 ≥10） |
| **`--respond-to`** | **`owner-only`** | 作者门：**`owner-only` \| `allowlist` \| `anyone` \| `nobody`**；不在允许集合内的事件**在到达订阅规则之前就被静默丢弃** |
| `--respond-to-allowlist` | — | 逗号分隔 64 位 hex pubkey（`allowlist` 模式必填；owner 始终隐含包含） |
| `BUZZ_API_TOKEN` | — | relay 强制 token 认证时必填 |

→ **"陌生人群体"这个场景下最关键的一行是默认值 `--respond-to owner-only`**。BYOA 群聊要开放给群成员，就必须显式选 `allowlist`（维护白名单 pubkey）或 `anyone`（承担 prompt injection 风险，见下）。

**★ Buzz 的"远程 agent"设计（`VISION_REMOTE_AGENTS.md`）—— 对"任务结束即销毁"给出了公开答案**：
- 核心命题：*"What makes an agent *that agent* was never the process. Its identity is a keypair. Its voice is its signed messages. Its durable memory is engrams on the relay. Its reputation is its contribution history."* → **身份可跨机器/进程迁移，社区状态不可**（*"identity is portable, community state is not"*）。
- **唯一约束（"The Only Tether"）**：*"**after deploy, the desktop retains no substrate control channel**"*。启动是单向交接；此后一切走 relay：*"you read the agent's messages to know how it's doing, you **mention it to steer it**, you tell a healthy agent to stop and it exits on its own. Presence means what it means for everyone else on the relay — available for conversation — not substrate telemetry."*
- **生命周期自限**：因为 desktop 没有 kill 通道，agent **自己带超时**——*"a timer that owes nothing to the agent's workload watches for silence, and after hours of quiet it finishes what's in flight, says goodbye to the relay, and exits. Not killed — finished. The default state of a remote agent is 'not running'."*
- **存在状态（presence）是 lease 而非 flag**：agent 续租，死了就不续，relay 忘记它；*"a bounded wrong dot, never an indefinite one"*（连接干净断开时差几秒，不干净时最多约 **3 分钟**）。
- **诚实的代价**（原文自陈，直接可用于路线图风险条目）：你得自带 substrate；交出 agent 的 identity key 是一个信任决定（K8s 上 key 是 Secret，能读该 namespace secret 的人都能读）；没有 backchannel 是双向的——**"It holds no guaranteed emergency kill switch into the substrate. Stopping a healthy agent is a message"**；自收割需要 reaper 本身活着（严重卡死的 body 无法自己跑完计时器，desktop 也不会替它做，需要 namespace TTL 之类 substrate 兜底）；body 的 state 是必死的（文件、checkout、半成品工作树）；运行中的 agent 只在**下次换 body** 时才应用新配置。

**★ Buzz 的 `remote-agents.md`（形式化规范）**：
- 定义 **provider 协议**：桌面上任何名为 `buzz-backend-<id>` 的可执行文件即为 provider；调用方式为**每操作一个进程**，stdin JSON 请求 / stdout JSON 响应 / 退出码只承载 1 bit（0 = 输出可信，非 0 = 失败，**无论 stdout 写了什么**）。**provider 对 desktop 而言不可信**，其所有输出按敌意处理。
- 五个不变量：**identity fail-closed**、**no secrets in configuration**、**presence-is-status**、**at-most-one-live-instance**、**intentional-termination-is-final**。
- 设计公理 **(M1) No management channel**：*"After a successful `deploy`, `D` holds no **persistent management session** to `A` on `S`, and the desktop↔provider protocol contains **no substrate API**: no status query, no exec, no log fetch, no kill. All post-deploy observation and control flows through `R`: status is relay presence (**kind:20001**), stop is a relay message (**`!shutdown`**)"*。
- **"Launchers" 章节的关键澄清**：*"the desktop is **one launcher among many**. What makes a process a live Buzz agent is a keypair, a NIP-OA auth tag, and a relay URL, handed as environment to the `buzz-acp` harness; anything that can set that environment and exec the harness — **a bash script, a systemd unit, a CI job**, or this document's provider protocol — is a conforming launcher."* → **对 hive 而言这意味着：不需要实现 provider/K8s 那一层，只要"设好环境变量并 exec harness"就是一个合规的远程 agent 启动方式。**
- NIP：**NIP-OA**（建立 ownership，不是 physical hosting / availability / lifecycle 控制）、**NIP-AE**、**NIP-AA** 等。

**★ 安全警告：confused deputy / prompt injection（`docs/practical-information-flow-for-buzz-agents.md`，作者 Jordan Mecom，标注 Draft，2026-08-27）**：
- 问题陈述：*"Buzz agents act with permissions belonging to their owner. This creates a **confused-deputy problem**: another user can prompt the agent, but the agent may still have access to its owner's private information in Buzz."*；*"the root problem is that an untrusted request can reach an agent process holding more authority than the requester should receive."*
- 攻击示例：Alice 的 `bot` 同时在公开 `#general`、受限 `#acquisition` 和与 Bob 的 DM 中；Mallory 在 `#acquisition` 里 prompt-inject，让 bot 把后续更新发到 `#general`。**如果进程持有 bot 的签名密钥（或能请求通用签名服务签任意事件），模型可以直接照做。**
- 他们明确放弃"教育模型不要照做"，改为**架构层面**解决：
  1. 一个**可信 broker 持有 agent 的 Buzz 签名密钥**，并控制其 Buzz 读取、受管内存与发布；
  2. **每个运行副本绑定一个受众（audience）**——*"An agent instance never switches audiences"*（因为进程不会在权限收窄后忘记私密信息）；
  3. broker **拒绝把该输出发布给更广的受众**。
- 架构：relay → broker（key/labels/memory/policy）→ **keyless** 实例（public instance / private instance）；实例只能做一小组语义操作（读允许的会话、检索带标签的内存、回复触发会话、请求一次显式检查过的 post）；实例**不能读到 broker 的 key**。broker 可在本地也可在远端，从 relay 视角它就是普通签名客户端。
- 发布与降密：普通回复无需审批直接回到触发会话；实例可提议其它目的地，但 broker 仅在"该目的地所有人都已被允许看到该实例的信息"时才放行；跨受众发布需人类**对精确内容 + 精确目的地做一次性/短时效授权（declassification）**。
- 边界自陈：*"This proposal does not mandate Buzz to sandbox arbitrary agent code or mediate every file, shell command, MCP server, email client, or network connection. It does not solve prompt injection generally."* 且承认：有不受限网络访问的私密实例仍可把私密文本外发；一旦有无中介路径把 label 剥掉，公开 broker 无法重建 provenance。
- **对 hive 的直接含义**：**"让群里的陌生人 @ 派活给别人的本机 agent" 本质上就是一个 confused deputy 场景**。至少要 (a) 默认 `respond-to owner-only`，开放时用 pubkey allowlist；(b) 让本机 agent 不持有可对外滥用的长期凭证；(c) 明确"agent 的产出回哪个房间"由本机侧策略决定，而不是由请求方决定。

**★ 会话与 presence 的时效性（`docs/agent-availability.md`）**：
- *"Availability means conversational presence on the relay, **not process health**."*；retained deployment receipt / PID / `running` 记录**都不能让可用性变绿**。
- 一次成功的 presence 快照中**没有该 key** → 仅对该快照请求的 key 集合判定 Offline；**未被查询的身份是 unknown，永不隐式 Offline**；初始 pending / 读取失败 / relay 断连 → unknown（即便缓存里之前是 Online）。Online / Away 必须有 presence 支撑。
- *"Shutdown sends a **request**, not a confirmed termination"*；*"This is a UI startup guard, **not a distributed singleton lock**"*。
- 删除有 deployment receipt 的 provider agent 时的策略表：Online/Away → 等 shutdown 请求并警告"这不确认终止"；Unknown → 同样等 shutdown，且**明确说明可用性未知，绝不声称 Offline**；已确定 Offline → 保留"有意离线移除"，不请求 shutdown，但警告远端部署可能仍存在；无 channel → 无 shutdown 路由，警告远端可能仍在运行但不声称它会。

**★ ownership 发现（`docs/owned-agent-discovery.md`）**：
- 用 owner 签名的 **kind 30177** 坐标作为发现种子，**独立于**本地运行时清单与共享频道成员关系；但**它不是 ownership 证明**（NIP-OA 才能证明 ownership）。
- 最新 agent kind 0 profile 必须**恰好带一个有效 NIP-OA auth tag**；所有签名条件按**事件时间**而非墙钟时间评估。
- **Membership 来自每个频道最新 relay 签名的 kind 39002 快照**；已知 owned agent 不必带 cosmetic `bot` role；**ownership 不会捏造 membership**（非成员可被发现但 `channel_ids` 为空）。
- 失败模式：invalid latest policy → 保留坐标并 **fail-closed**（不能复活 legacy 权限）；missing policy → 保留 OSS legacy 兼容，但 **marked build 要求已验证的 owner policy**。

**可用/在建/纯设想三栏（README 自陈）**：
- ✅ 可用：Relay、channels、threads、DMs、canvases、media、search、audit log；Desktop app（Tauri + React）；**`buzz-cli`（agent-first，JSON 进 JSON 出）+ ACP harness（Goose、Codex、Claude Code）**；YAML workflows（message/reaction/schedule/webhook 触发）；Git 事件（NIP-34）。
- 🚧 在建：Mobile（iOS+Android, Flutter）、Push notifications、Huddle lifecycle events、Workflow approval gates（infra 已有，胶水未干）。
- 💭 纯设想：跨 relay 的 web-of-trust reputation、Git hosting backend、Culture features。
- 并附一句自嘲式免责：*"Please do not plan your compliance program around the 💭 column yet."*

**其他生态信号**：Nous Research 的 Hermes Agent 已提供 **Buzz adapter**（*"connects Hermes to a Buzz community ... and relays messages"*），并发布了三条集成路径（Desktop runtime、relay bridge、Nostr gateway）——来源 <https://hermes-agent.nousresearch.com/docs/user-guide/messaging/buzz>、<https://www.marktechpost.com/2026/07/31/nous-research-ships-three-integration-paths-for-hermes-agent-and-buzz-blocks-open-source-nostr-workspace-for-humans-and-agents/>（二手，`存疑`，仅作生态活跃度信号）。

### B.3.2 Nostr 作为身份层的可复用性 —— `确认`

一手来源：<https://raw.githubusercontent.com/nostr-protocol/nips/master/29.md>、`.../46.md`、<https://nips.nostr.com/1>。

- **NIP-01**：基本协议；client→relay `EVENT`/`REQ`/`CLOSE`/`AUTH`，relay→client `EVENT`/`OK`/`EOSE`/`CLOSED`/`NOTICE`/`AUTH`。事件是签名的。
- **NIP-29（Relay-based Groups，draft/optional/relay）**：*"a standard for groups that are only writable by a closed set of users. They can be public for reading by external users or not."*；组由随机 `id` 标识；**"There is no way to create a group"** —— relay 只是围绕某个 id 建立规则。组 state 事件：`kind:39000`（metadata）、`39001`（admin list）、`39002`（member list）；`kind:10009`（用户的组列表）用于**检测迁移/分叉**（*"clients SHOULD periodically -- and MUST, if their primary relay for a group is offline or unreachable -- look at the `kind:10009` event of the group's admins and of trusted friends"*）。文档还专门论证**迁移与分叉是特性而非 bug**（同一个 id 可在不同 relay 上表示不同治理的社区）。
- **NIP-46（Nostr Remote Signing，draft）**：*"Private keys should be exposed to as few systems... as possible"*；客户端（可无密钥）通过 `bunker://<remote-signer-pubkey>?relay=...` 与 **remote-signer / bunker** 双向通信，请求 `get_public_key`、`sign_event` 等；另有 `remote-signer-pubkey` 与 `user-pubkey` 的区分。
  → **对 BYOA 极具价值**：可以让"群成员请求我的 agent 做事"而不把签名密钥交给群/服务端；本机 agent 充当 bunker 或使用 bunker。**本机 agent 的"行动授权"与"身份密钥"可分离。**

**身份模型可否直接复用？—— 研究者推断（基于上述一手事实）**
- **可以**：Nostr 的身份 = 自持 secp256k1 密钥对，**无需注册、无账号、无 homeserver**；成员本机 `buzz-admin generate-key` 即可凭空获得一个可被 @ 的身份。签名即 authorship，relay 广播即 transport，NIP-29 提供"闭集可写"的群语义，NIP-42 提供 relay 层认证。**对"多人各自带本机 agent 进同一个群"，这是摩擦最低的身份模型**：无中心注册流程、身份可随进程迁移（Buzz 正是建立在这一点上）。
- **代价**：密钥即身份 ⇒ 丢失不可恢复（Buzz README 明确 *"Save the secret key immediately — it is not stored and cannot be recovered"*）；无内建键轮换/撤销语义（Buzz 用 kind 30177 + NIP-OA + relay 成员表来做 owner/policy 编排）；陌生的 pubkey 在群里没有任何"人味"绑定，需要 relay 侧的 allowlist/成员表来把陌生人挡在门外。

### B.3.3 Matrix 作为消息与身份层 —— `确认`（部分）+ `未找到证据`（部分）

一手来源（已抓取）：<https://spec.matrix.org/latest/client-server-api/>。

- **`/sync` 长轮询**（规范原文）：*"Clients then receive new events by 'long-polling' the homeserver via the `/sync` API, passing the value of the `next_batch` field from the response to the previous call as the `since` parameter. The client should also pass a **`timeout`** parameter. **The server will then hold open the HTTP connection for a short period of time waiting for new events, returning early if an event occurs.** Only the `/sync` API (and the deprecated `/events` API) support long-polling in this way."*
  → **这是"本机不暴露任何入站端口也能被服务端唤醒"的标准、成熟、有规范背书的机制**（HTTP 长轮询族，与 OpenAI MCP Tunnel 同族），且 `prev_batch` / `next_batch` 的 token 语义让"断线续传"有明确定义。
- 生态：Matrix 已有 agent 生态（MindRoom：*"creates AI agents living in Matrix. Because Matrix bridges to Slack, Telegram, Discord..."*，来源 <https://www.nijho.lt/post/mindroom/>；Agent-Matrix / agent-matrix 组织 <https://github.com/agent-matrix>）—— 均为第三方，`存疑`。
- **`未找到证据`（本次未抓取）**：Matrix **Application Service API**（bridge 用的注册态身份与 namespace 抢占）、Matrix 的 agent 身份治理细节（如 MSC/提案级别的 agent 身份）、以及 Matrix 侧把"agent"与"human"在身份模型上区分的官方规范。**因此"Matrix 的身份模型能否直接复用"这一问题在本次调研中未获一手证据，标记为未解决。**
- **研究者推断**：Matrix 的身份 = `@user:homeserver` 账号 + 设备密钥，**绑定于某个 homeserver**；给每个成员的每个 agent 开账号意味着每人都要有一个 homeserver 账号（或有人代建），比 Nostr 的"凭空生成密钥对"重。另一方面 Matrix 的桥接生态（Slack/Telegram/Discord）意味着"也许能让现有 IM 群聊直接变成 agent 群"。

---

## B.4 关键结论：哪种方案在「多人各自带本机 agent 进同一个群」下摩擦最小、可演示性最强

**推荐形态（研究者综合判断，标注为推断）**：
> **每个成员本机不暴露任何入站监听；只需一个 agent 进程，用自持身份密钥主动出站连到一个共享的公共 broker；broker 把 @ 提及当作任务投递给该进程；进程用本地 CLI agent 执行后，把结果作为消息发回群里。**

这一形态同时满足题设的 A、B 两侧：A 侧用 `codex exec --json` / `pi --mode rpc` / `claude -p --output-format stream-json` 做"spawn → 注入 → 取结构化结果 → 杀"；B 侧用出站长连接消掉所有 NAT/防火墙/证书/端口配置。

**具体实现优先级**：

1. **最快落地 / 演示性最强：采用 Buzz 的既有形态（relay + `buzz-acp`）** —— `确认`（多方文档支撑）
   - 理由：它**就是本任务的目标功能的参考实现**（*"The harness listens for @mentions on the relay, prompts your agent, and the agent replies"*），Apache-2.0，且**已原生支持 goose / codex(`codex-acp`) / claude code(`claude-agent-acp`)**。
   - 摩擦力最小的证据链：成员侧只需 (a) 生成一个 keypair，(b) 把 pubkey 注册为 relay member，(c) 设 `BUZZ_RELAY_URL` + `BUZZ_PRIVATE_KEY` + `BUZZ_ACP_AGENT_COMMAND`，(d) `buzz-acp`。**零入站端口、零隧道、零证书。**
   - 与 hive 的架构同构度极高（仓库名就叫 hive，且 `block/buzz` 的 GitHub description 就是 "A hive mind communication platform"）。
   - 直接可用的旋钮：`--respond-to allowlist`（陌生人群体的授权开关）、`--agents 1..32`（并发）、`--lazy-pool`（**先连上再起 LLM 子进程**，对演示机的冷启动体验很关键）、`BUZZ_ACP_IDLE_TIMEOUT=620` / `MAX_TURN_DURATION=7200`（防孤儿）。
   - 风险已被告知（在其自己的文档里）：confused deputy / prompt injection；"没有应急 kill switch，停一个健康 agent 只能是发消息"。

2. **若不想采用 Buzz：自己搭一个 WebSocket/Nostr broker + 薄适配层** —— 推断
   - broker 侧：WebSocket（或 Nostr relay）承载"消息 = 任务"，身份用 keypair。
   - 本机侧：一个常驻进程，出站连 broker，收到提及后选择执行方式：
     - **Codex 路线**（控制面最完整）：`codex app-server` 或直接 `codex exec --ephemeral --json --output-schema schema.json -o out.json`；长驻场景用 `codex app-server --listen ws://127.0.0.1:4500` + `turn/start` / `turn/steer` / `turn/interrupt`。
     - **pi 路线**（最轻、控制面命令最语义化）：`pi --mode rpc --no-session`（**已实测可用**），用 `prompt` / `abort` / `get_last_assistant_text` / `new_session`。
     - **Claude Code 路线**：`claude -p --bare --no-session-persistence --output-format json --json-schema ...`；需要长驻就把 `--input-format stream-json` 的进程托管起来（**该语义未获明确文档支撑，需实测**）。
   - **不要为每个 CLI 各写一套适配器**：优先走 **ACP**（`@agentclientprotocol/codex-acp`、`@agentclientprotocol/claude-agent-acp` 均已存在于 npm，本次实测确认），这样本机侧只需实现一个 ACP client。

3. **不要用 Funnel / Quick Tunnel 作为主要机制** —— `确认`（基于官方限制）
   - Cloudflare Quick Tunnel：每次运行随机 URL、不支持 SSE、200 并发硬上限（429）、无 SLA、官方定性为 testing only。
   - Tailscale Funnel：beta、只能 tailnet 域名 + 443/8443/10000 + 强制 TLS + 不可配置带宽限制 + macOS 需开源变体；且"设备共享/邀请入 tailnet"是**逐设备、账号对账号**的关系，N 个陌生人 = N 次邀请。
   - 这两者只在"临时把一台 demo 机的 HTTP 端口暴露给别人看"时有价值，**不是"成为长期群成员"的注册机制**。

4. **把 OpenAI Secure MCP Tunnel 的架构当成蓝图抄** —— `确认`
   即使不使用 OpenAI，它的分层（本地进程只做出站 HTTPS 长轮询 / 任务队列在服务端 / 结果沿同一隧道回传 / 本地提供 `/healthz` `/readyz` `/metrics` `/ui` / 协议文档 + OpenAPI 供其它语言实现）是可直接照搬的**已被生产验证的**参考架构。

---

# 矛盾与存疑

1. **Claude Code `stream-json` 是否强制 `--verbose`** —— `存疑`。官方文档所有示例都带 `--verbose`，但 `--help` 未把它列为条件选项。→ 建议实测。
2. **`claude -p` 会话是否被 `--continue` 排除** —— 表面矛盾，实为口径差异（已澄清，`确认`）：裸 `claude --continue` **排除** `-p`/SDK/`/loop` 会话；`claude -p --continue` **包含**它们。来源同为 sessions 文档与 headless 文档。
3. **`--bg` 与 `-p`** —— `确认`但不直观：`--bg` 存在（起后台 agent），但 headless 文档明确 `-p` 会 **reject** `--bg`。想"后台起 agent 然后 poll"必须用 `--bg`（不带 `-p`）+ `claude agents`，或自己 spawn `-p` 子进程。
4. **Codex app-server 的 WebSocket 鉴权默认值** —— `确认`且是**高危默认**：官方原文 *"Non-loopback WebSocket listeners **currently allow unauthenticated connections by default during rollout**, so configure WebSocket auth before exposing one remotely."* 与"协议文档列了三种 ws-auth"给人的"默认安全"印象相反。
5. **`codex exec` 非交互下 MCP 工具调用被自动取消** —— `存疑`。GitHub issue <https://github.com/openai/codex/issues/24135>（针对 `0.125.0-alpha.3`）称 `codex exec` 下 MCP tool call 因 stdin 关闭且无配置项可抑制审批提示而被 auto-cancel，只能靠 `--dangerously-bypass-approvals-and-sandbox`。本机为 `0.151.0`，**未验证是否已修复**。→ 若走"headless agent 调 MCP"，必须实测。
6. **`--respond-to owner-only` 默认值 vs 陌生人群体需求** —— 不是矛盾，而是**默认值正好与 BYOA 目标相冲突**：`确认`（README 原文默认 `owner-only`）。开放给群成员必须先显式改配置。
7. **pi 的"干净上下文"默认不干净** —— 本机实测发现 `pi --mode rpc` 会自动加载用户级扩展并触发 `setStatus` / `extension_error` 事件。文档确实提供了 `--no-extensions/-ne`（并可 `PI_CODING_AGENT_DIR` 换配置目录），但**默认行为是加载**。→ 若要求上下文可复现，必须显式 `-ne`（及 `--no-context-files` 等）。
8. **pi 的 project trust 在非交互下的 `ask`** —— `存疑`（易误读）：文档原文是 `ask`(默认) 与 `never` 都**忽略**那些项目资源，而 `always` 才信任。即默认 `ask` 在非交互下等同"忽略"，不会弹窗。**这容易被误读为"会询问"从而假设了错误的安全边界。**

---

# 未找到证据 / 未解决

1. **Claude Code 的常驻 JSON-RPC 会话服务器** —— `未找到证据`。仅有 `--input-format stream-json`（长驻进程 + JSONL 输入）与 Agent SDK 两条路。对照：Codex 有 `app-server`、pi 有 `--mode rpc`。
2. **`claude -p --input-format stream-json` 的确切语义**：进程是否在同一会话内持续接受多条 user message、边界在哪、是否需要 `--replay-user-messages` 才能确认、超时/空闲清理策略 —— `未找到证据`，需实测。
3. **`--session-id <uuid>` 与已存在 UUID 冲突时的行为**（报错 or 恢复）—— `未找到证据`。
4. **pi 是否有内置的"最终结果 JSON Schema 约束"** —— `未找到证据`（只有事件流 + `get_last_assistant_text`）。对照：claude 有 `--json-schema`、codex 有 `--output-schema`。
5. **Matrix Application Service API 细节**，以及在 Matrix 上"agent 身份"是否有一手规范级支持 —— `未找到证据`（本次只验证了 `/sync` 长轮询）。
6. **ngrok 免费档的具体条款**（并发、URL 稳定性、SSE 支持）—— `未找到证据`（未抓一手文档）。
7. **Buzz 的"多人各自带本机 agent"在真实多机部署下的表现**：文档大量描述单机 desktop 与远端 provider 两条路径，但**未找到**关于"若干互不信任的成员各自运行 buzz-acp 连同一个 relay"的官方部署指南或 conformance 结果。`@-mention → 本机 harness` 的链路本身有多方文档支撑，但**跨主机、互不信任的成员**这个具体拓扑未获一手验证。
8. **`codex exec-server --remote` 的服务器侧契约**：`--remote <URL>` 指向什么服务、注册协议是什么、身份如何绑定（`--use-agent-identity-auth` + `CODEX_ACCESS_TOKEN` 的具体颁发方）—— `未找到证据`。这个能力看起来正好命中问题 B，但文档只给了 CLI 层描述。
9. **`claude --remote-control` / `claude agents` 的协议与用途** —— 本机 `--help` 显示其存在（`--remote-control [name]`、`--remote-control-session-name-prefix`、`claude agents` 用于管理后台 agent），但**未深查**其是否构成一条"从远端驱动本机 Claude Code"的官方通道。**这可能是本次调研最大的遗漏项，建议优先补查。**

---

# Sources

## Kept（作为结论依据）

**一手本地实测**
- 本机 `claude --help` / `--version`（Claude Code v2.1.228）— 全部 flag 语义与组合限制的第一手依据。
- 本机 `codex --help` / `codex exec --help` / `codex exec resume --help` / `codex app-server --help` / `codex remote-control --help` / `codex queue --help` / `codex agents --help` / `codex exec-server --help` / `--version`（v0.151.0）— Codex 控制面与远程注册能力的直接证据。
- 本机 `pi --help` / `--version`（v0.86.1）— pi 四模式、会话、扩展、工具开关的第一手依据。
- **实测**：`pi --mode rpc --no-session` + `get_state`/`get_session_stats`/`new_session` → 收到合法 response（控制面可用性直接证明）。
- **实测**：`codex app-server`（stdio）+ `initialize`/`initialized` → 收到合法 JSON-RPC result 与 `remoteControl/status/changed` notification。
- 本机已安装包内文档：`~/Library/pnpm/global/5/node_modules/@earendil-works/pi-coding-agent/docs/{rpc,json,sessions,usage,sdk,session-format}.md`、`README.md` — pi RPC 协议、JSON 模式、会话目录与 SDK 的一手规范。

**官方文档（一手）**
- Run Claude Code programmatically — <https://code.claude.com/docs/en/headless> — `-p`、`--output-format`、`--json-schema`、`--bare`、SIGTERM 语义、后台任务清理、`--continue`/`--resume` 用法。
- CLI reference — <https://code.claude.com/docs/en/cli-reference>
- Manage sessions — <https://code.claude.com/docs/en/sessions> — `/clear` 语义、`--session-id`、`--fork-session`、恢复不还原项、transcript 存储与删除、`-p` 会话与 picker 的关系。
- Agent SDK overview — <https://code.claude.com/docs/en/agent-sdk/overview> — SDK 能做什么、非 Py/TS 语言应 subprocess `-p`。
- Non-interactive mode — <https://learn.chatgpt.com/docs/non-interactive-mode> — `codex exec` 的 IO 语义、`--json` 事件类型、`--output-schema`、`--ephemeral`、沙箱默认值、CI 认证建议。
- Developer commands — <https://learn.chatgpt.com/docs/developer-commands> — `codex exec` flag 表与沙箱取值。
- Codex app-server — <https://developers.openai.com/codex/app-server> — JSON-RPC 2.0 协议、四种传输、ws-auth 三模式、-32001 背压、initialize 握手、完整方法清单、远程 TUI 示例。
- Codex SDK — <https://learn.chatgpt.com/docs/codex-sdk> — SDK 通过 JSON-RPC 控制本地 app-server。
- Secure MCP Tunnel — <https://developers.openai.com/api/docs/guides/secure-mcp-tunnels> — **出站 long-poll 参考架构的权威描述**。
- openai/tunnel-client — <https://github.com/openai/tunnel-client> — 实现细节、`/healthz` `/readyz` `/metrics` `/ui`、protocol.md/openapi.json、Go SDK。
- Quick Tunnels — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/> — 随机子域、200 并发上限/429、**不支持 SSE**、无 SLA。
- Tailscale Funnel — <https://tailscale.com/docs/features/tailscale-funnel> — TCP proxy + relay servers、beta、端口/TLS/带宽限制、证书限速。
- Share your machines with other users — <https://tailscale.com/docs/features/sharing>
- Inviting users vs sharing a device — <https://tailscale.com/docs/reference/inviting-vs-sharing>
- Matrix Client-Server API（`/sync` 长轮询章节）— <https://spec.matrix.org/latest/client-server-api/>
- MCP Transports 规范（stdio / Streamable HTTP、安全警告）— <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>
- buzz README / ARCHITECTURE.md / NOSTR.md / VISION_REMOTE_AGENTS.md / VISION_AGENT.md / docs/remote-agents.md / docs/agent-availability.md / docs/owned-agent-discovery.md / docs/practical-information-flow-for-buzz-agents.md / crates/buzz-acp/README.md — <https://github.com/block/buzz>（raw: `https://raw.githubusercontent.com/block/buzz/main/...`）— **目标功能的现成参考实现 + 安全模型 + 远程生命周期设计**。
- Introducing Buzz — <https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together>
- NIP-01 — <https://nips.nostr.com/1>；NIP-29 — <https://raw.githubusercontent.com/nostr-protocol/nips/master/29.md>；NIP-46 — <https://raw.githubusercontent.com/nostr-protocol/nips/master/46.md>
- ACP overview — <https://agentclientprotocol.com/protocol/v1/overview>
- Agent Client Protocol repo — <https://github.com/agentclientprotocol/agent-client-protocol>
- frp — <https://github.com/fatedier/frp>；rathole — <https://github.com/rapiz1/rathole>；chisel — <https://github.com/jpillora/chisel>；Pangolin — <https://github.com/fosrl/pangolin> + <https://docs.pangolin.net/>
- npm registry 实测：`@agentclientprotocol/codex-acp`(latest 1.12.0)、`@agentclientprotocol/claude-agent-acp`(latest 0.79.0)、`@openai/codex-sdk`(latest 0.155.1)、`@earendil-works/pi-coding-agent`(latest 0.86.1)

## Rejected / deprioritized

- Andymatuschak 类博客与 Reddit 线程（`r/ClaudeAI`、`r/codex`、`r/selfhosted`、`r/Tailscale`、`r/hermesagent`）— 非一手，仅用于发现线索，未作为结论依据。
- 第三方教程站（buildthisnow、continuumcode、eesel、opentools、avasdream、claude-world、heyuan110、blakecrosley、computingforgeeks、kingy.ai、deepakness、developersdigest、dev.to 等）— 非一手，且部分内容与官方 `--help` 不一致（例如把 `--verbose` 说成 stream-json 必需）。已明确标记为 `存疑` 或不采用。
- ngrok 官方对比与定价页 — 未抓取，故所有 ngrok 相关结论标记为 `未找到证据`。
- `awesome-tunneling`、xtom/instatunnel 对比文、sourceforge rathole 镜像 — 聚合/二手，仅作发现用途。
- openai/codex issue #24135、#53584（claude-code）— 单个特定版本的 issue，已降级为 `存疑`；代码行为可能已在新版本改变，未在本机验证。
- MindRoom / Agent-Matrix / Hermes Buzz adapter / marktechpost — 第三方与二手来源，仅作为生态活跃度信号，标注 `存疑`。

---

# 关键结论清单（一行一条）

1. **三家 CLI 都有一等公民 headless 模式，且都能返回结构化最终工件**：`claude -p --output-format json --json-schema`（结果在 `structured_output`）、`codex exec --output-schema <file> -o <file>`、`pi -p` / `--mode json`（pi **无**内置 schema 约束，只能从事件流或 `get_last_assistant_text` 取）。
2. **"一次性会话、结束即销毁"三家都有官方开关**：`claude --no-session-persistence`（仅 `-p`）、`codex exec --ephemeral`、`pi --no-session`；Claude Code 侧另有 `--bare` 做"最小上下文"（官方称其将成为 `-p` 默认），pi 侧需额外 `--no-extensions` 才是真干净（本机实测默认会加载用户扩展）。
3. **只有 Codex 和 pi 提供"常驻双向会话控制面"**：`codex app-server`（JSON-RPC 2.0 over stdio/ws/unix，含 `thread/start|resume|fork|delete`、`turn/start|steer|interrupt`、审批以 server→client request 回流、`fs/*`）与 `pi --mode rpc`（25+ JSONL 命令，含 `new_session`/`abort`/`get_last_assistant_text`）；**两者的可用性我在本机实测跑通**（`initialize` 握手、`get_state`/`get_session_stats`/`new_session` 均返回合法响应）。Claude Code 这一层是空白（只有 `--input-format stream-json` 长驻子进程与 Agent SDK）。
4. **`/clear` 的 headless 等价物 = 直接起一个新会话**（claude：新起 `claude -p` 或 `--session-id <new-uuid>`；pi：`/new` 对应 RPC 的 `new_session` 或 CLI 不带 `-c/-r`），不是"清空存储"——三家都会保留旧会话文件可 resume。
5. **"结束后立即回收"的语义是可查证的**：Claude Code 在 SIGTERM 下退出码 143、turn 标未完成、**杀掉 Bash 进程树**、后台 Bash 5 秒后回收；Codex 用 `thread/delete` 永久删除（含后代线程）；pi 靠删 `.jsonl` 或 `dispose()`。
6. **反向隧道的成熟开源实现是 frp / rathole / chisel / Pangolin**（chisel 走 WebSocket 且自带指数退避重连与死连接检测；rathole 每 service 强制 token、二进制 ~500KiB；Pangolin 基于 WireGuard 且自带身份+策略模型）；但**它们解决的只是"网络可达"，不解决"群成员身份与授权"**。
7. **"服务端唤醒局域网本机进程"的最权威参考架构是 OpenAI Secure MCP Tunnel + `openai/tunnel-client`**：本地只做出站 HTTPS **long-poll** 拉取排队工作、转发 JSON-RPC、沿同一隧道回传结果，**不需要任何入站端口**，并自带 `/healthz` `/readyz` `/metrics` `/ui` 与协议文档 —— 可直接照抄分层。
8. **Cloudflare Quick Tunnel 与 Tailscale Funnel 不适合"成为长期群成员"**：Quick Tunnel 每次随机 URL、**不支持 SSE**、200 并发硬上限（429）、无 SLA、官方定性 testing only；Funnel 是 beta、只能 tailnet 域名 + 443/8443/10000 + 强制 TLS + 不可配置带宽限制；且 Tailscale 的"设备共享"是逐设备账号对账号关系，N 个陌生人 = N 次邀请。
9. **`block/buzz` 就是本任务目标功能的现成参考实现**：Apache-2.0 的 Nostr relay + `buzz-acp` harness（*"listens for @mentions on the relay, prompts your agent, and the agent replies using the Buzz CLI"*），已原生支持 goose / **Codex(`codex-acp`)** / **Claude Code(`claude-agent-acp`)**，成员侧只需"生成 keypair + 注册 pubkey + 设三个环境变量 + `buzz-acp`"，**零入站端口、零隧道、零证书**。
10. **对"陌生人各自带本机 agent 进同一个群"，默认安全姿态必须显式改**：`buzz-acp` 的 `--respond-to` **默认 `owner-only`**，且 Buzz 自己的文档明确指出该场景存在 **confused-deputy / prompt injection** 风险（持有 owner 密钥的 agent 可被他人注入后向更广受众泄露私密信息），其官方缓解方案是"可信 broker 持密钥 + agent 实例 keyless 且绑定受众 + broker 拒绝跨受众发布"。
11. **Nostr 的身份模型最适合 BYOA**：keypair = 身份、无需注册/无 homeserver、签名即 authorship、身份可跨进程/主机迁移（Buzz 的远程 agent 设计正是建立在此之上：*"identity is portable, community state is not"*）；NIP-29 提供闭集可写的群语义，NIP-46 远程签名让"群里请求我的 agent 做事"与"我的密钥不外流"可分离——**这是直接可复用的部分**。
12. **Matrix 的 `/sync` 长轮询是"本机零入站端口被唤醒"的规范级标准机制**（服务端 hold 住 HTTP 连接直到有事件或 `timeout` 到期），但**其身份模型（homeserver 账号 + 设备密钥）比 Nostr 重**，且 Application Service API 与"agent 身份"的一手规范本次未取证 → 标记为未解决。
