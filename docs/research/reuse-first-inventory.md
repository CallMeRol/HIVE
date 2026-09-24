# Reuse-First 盘点报告（窄范围调研）

> 调研日期：2026-09-21。原则：凡 GitHub/npm 上有维护中的现成件，绝不自研。
> 证据标注：✅确认（一手来源）/ ⚠️存疑 / ❓未找到证据。
> **历史证据，不是实现规格**：S1 的 `acpx` 推荐已被 ADR-0004 替代为官方 ACP SDK；S3 的 JSON envelope 推荐已被 Markdown 交接文档契约替代；S6 的 React Flow 推荐已被批内 Vue Flow 复用契约替代。

## S1 · ACP 客户端 / harness（最急）

npm registry 元数据（`registry.npmjs.org/<pkg>/latest`，2026-09-21 查询，✅确认）：

| 包 | 最新版 | 最近发布 | 直接依赖 | License |
|---|---|---|---|---|
| `acpx` (openclaw) | 0.18.0 | 2026-09-20（1天前） | 6 | MIT |
| `@acp-kit/core` | 0.10.2 | 2026-06-08（3个月前） | 1 | MIT |
| `@productfactory/agent-supervisor` | 0.6.24 | 2026-09-19 | 5 | 无声明 ⚠️ |
| `pi-acp` (svkozak) | 0.0.33 | 2026-07-30 | 2 | MIT |

GitHub 侧（gh api，✅确认）：
- `openclaw/acpx`：3269 stars，pushed 2026-09-21，MIT，"Headless CLI client for stateful ACP sessions"。
- Buzz 的 `crates/buzz-acp`：未在 GitHub 搜到活跃主仓（搜索仅见零星 fork，2 stars 级）⚠️存疑，生态远小于 acpx。

结论（S1）：
- **最成熟/最活跃：`acpx`**——3.3k stars、日更、MIT、依赖仅 6 个，定位就是"headless CLI client，不刮 PTY"，天然支持 stdio 双向与 stateful session；嵌 Node/Electron 用 spawn + JSON-RPC over stdio 即可。中断/cancel 属 ACP 协议内建（`session/cancel`），✅确认 ACP 规范支持，acpx 作为 ACP client 继承该能力。
- `@acp-kit/core` 依赖最轻（1 个）但 3 个月未发版，活跃度弱于 acpx。
- `@productfactory/agent-supervisor` 发布活跃但无 license 声明，复用有法律风险 ⚠️。
- 推荐：**acpx 做 harness 底座**；若想直接编程式集成可叠加官方 `@agentclientprotocol/sdk`（TS 官方 SDK）。

来源：
- https://github.com/openclaw/acpx
- https://acpx.sh/
- https://www.npmjs.com/package/@agentclientprotocol/sdk

## S2 · Coding agent 的 ACP 适配器

npm + GitHub 元数据（✅确认，2026-09-21 查询）：

| 适配器 | 版本/发布 | stars | License | 归属 |
|---|---|---|---|---|
| `@agentclientprotocol/claude-agent-acp` | 0.79.0 / 2026-09-17（4天前） | 2556 | Apache-2.0 | agentclientprotocol 官方 org（Zed 系） |
| `@agentclientprotocol/codex-acp` | 1.12.0 / 2026-09-15 | 396 | Apache-2.0（repo 标 NOASSERTION） | agentclientprotocol 官方 org |
| `pi-acp` (svkozak) | 0.0.33 / 2026-07-30 | — | MIT | 社区个人 |
| `salman1993/buzz-pi-acp` | ❓未找到 npm/GitHub 一手证据 | — | — | 存疑 |

结论（S2）：
- claude / codex 两个适配器均为 **agentclientprotocol 官方 org 维护**（Zed 主导的协议方），发布活跃（数天前），属"官方"。
- claude-agent-acp 走 Claude Agent SDK，认证复用本机 `~/.claude/` 凭证（libraries.io 描述佐证），无需额外认证 ⚠️（间接证据）。
- `pi-acp` 是社区个人项目，0.0.x、7月底停更，活跃度最低；`buzz-pi-acp` 未找到证据。
- 推荐：claude 系用官方 `claude-agent-acp`，codex 系用官方 `codex-acp`；pi 若必须接入只能暂用社区 `pi-acp`，风险自担。

来源：
- https://github.com/agentclientprotocol/claude-agent-acp
- https://github.com/agentclientprotocol/codex-acp
- https://agentclientprotocol.com/get-started/agents

---



## S3 · 交接工件（handoff document）schema

- **A2A（Agent2Agent）规范**：`Task`/`Artifact`/`Message`/`contextId` 是 Linux Foundation 托管的开放规范（a2aproject/A2A，spec 仓库活跃 ✅），有官方 JS SDK（`@a2a-js/sdk`）。语义最接近"任务信封 + 产物 + 上下文关联"。**能用，但它是"线上 RPC 协议"，不是"本地交接文档"格式**——缺：文件级持久化约定、人类可读的 handoff 文档模板。
- **OpenAI Agents SDK `handoff()`**：handoff 是运行时控制流原语（把控制权+对话历史转给另一 agent），**不产出可序列化的交接文档 schema** ✅（官方文档只定义运行时行为）。缺：工件 schema。
- **VS Code Copilot custom agents `handoffs:` frontmatter**：只是 UI 按钮定义（label/agent/prompt），✅确认是"引导下一步"的声明，**不是上下文传输格式**。缺：一切载荷语义。
- npm/pypi 上独立的 "handoff document / context transfer / task envelope" 库：**❓未找到维护中的通用库**。

结论（S3）：**没有完全现成的"handoff 文档 schema"可直接用**。最省事路径：借用 A2A 的 `Task`+`Artifact`+`contextId` 字段语义（成熟、有规范背书）自定义一个 JSON envelope；不需要引入 A2A 传输层。需自研：文档模板 + 文件持久化约定。

来源：
- https://github.com/a2aproject/A2A/blob/main/docs/specification.md
- https://openai.github.io/openai-agents-js/
- https://code.visualstudio.com/docs/agent-customization/custom-agents

## S4 · 任务级 session 生命周期编排

- **LangGraph / langgraph-swarm**：有 handoff 语义与 checkpointer（状态可观测）✅，但 swarm 库是 Python 为主；JS 侧 `@langchain/langgraph` 存在且可嵌 Node，但"派生子 agent + 独立上下文 + 结果回收"要自己搭 supervisor 图 ⚠️（原语齐、无开箱内核）。
- **OpenAI Agents SDK (TS, openai-agents-js)**：Runner + handoffs + 内建 tracing，纯 npm 可嵌本地 Node ✅；但 handoff 是"对话内转交"，不管理"子进程生命周期/冷启/回收"——那是给 LLM agent 编排的，不是给 OS 进程编排的 ⚠️。
- **Mastra**：TS 原生、agents+workflows+observability、可本地跑 ✅，同样面向 LLM agent 而非外部 CLI 进程。
- **Temporal / Restate**：提供"派发→执行→回收→可观测状态"的持久化执行内核 ✅，但需起 server，嵌入本地 Electron 偏重 ⚠️。
- AutoGen/AG2、CrewAI、Semantic Kernel、Agno、Letta：Python 系为主，嵌 Node 不合适。Dify/n8n 是独立 SaaS/服务，排除 ✅。

结论（S4）：**没有一个开源件直接提供"派发子 agent 进程 + 独立上下文 + 结果回收 + 可观测状态"且能嵌进本地 Node 进程**。最接近的是 LangGraph(JS) 的 supervisor/handoff/checkpoint 原语（用它做状态机）+ 自己写进程生命周期层；`@productfactory/agent-supervisor`（S1）是 ACP 场景下最接近"进程 supervisor"的现成件但无 license。需自研：进程冷启/回收层。

来源：
- https://reference.langchain.com/python/langgraph-swarm
- https://openai.github.io/openai-agents-js/
- https://mastra.ai/
- https://langfuse.com/blog/2025-03-19-ai-agent-comparison



## S5 · 上下文占用率统计

库侧（npm registry ✅确认，2026-09-21 查询）：
- `gpt-tokenizer` 4.0.0（2026-08-16 发版，0 依赖）——纯 JS BPE，维护最活跃；第三方维护评分 100/100 vs js-tiktoken 20/100（pkgpulse ⚠️间接证据）。
- `js-tiktoken` 1.0.21 / `tiktoken`（JS 官方 wasm 包）1.0.22，均停在 2025-08，一年多未动 ⚠️。
- 注意：BPE 词表只覆盖 OpenAI 系；Claude token 数本地算不准（Anthropic 不开源 tokenizer），只能近似 ⚠️。

CLI 暴露值侧：
- **pi**：`get_session_stats` 含 `contextUsage` ✅（题设已知，直接读）。
- **claude code**：statusline JSON 已暴露 `context_window` 数据（2.1.6 起 statusline 可显示真实 context % ✅，官方 issue #13783 佐证字段存在），TUI 有 "Context low (x% remaining)"。
- **codex**：TUI status line 有 context-left 百分比/进度条（openai/codex issue #3630、#17450 ✅），且有 `/status` 命令。

结论（S5）：**优先读 CLI 暴露值**——三家都有官方输出（pi 的 `get_session_stats`、claude 的 statusline JSON、codex 的 TUI/status），比自己用 gpt-tokenizer 算更准（尤其 Claude）。自己算仅作为 CLI 不提供时的降级方案，此时用 `gpt-tokenizer`（维护最好），且对 Claude 只能给近似值。

来源：
- https://www.npmjs.com/package/gpt-tokenizer
- https://github.com/anthropics/claude-code/issues/13783
- https://github.com/openai/codex/issues/3630
- https://www.pkgpulse.com/compare/gpt-tokenizer-vs-js-tiktoken

## S6 · Agent 状态可视化 / 派发关系图

npm registry ✅确认（2026-09-21 查询）：
- `@xyflow/react` 12.11.6（2026-09-01 发版，3 依赖，MIT）——xyflow 团队自 2019 年专职维护，React 原生、节点完全自定义（可做像素风节点+按状态着色）、有官方 dagre/elk 布局集成示例。
- `cytoscape` 3.34.3（2026-09-07，0 依赖）——功能强但偏图分析，UI 定制度低。
- `vis-network` 10.1.2（2026-08-19，0 依赖）——维护中但生态与文档弱于前两者。

像素风素材方向（✅方向性确认）：
- **Kenney.nl（CC0）**——最稳妥，商用免署名；itch.io 免费像素 sprite 多为 CC0 或 CC-BY（需逐包核对授权页 ⚠️）；OpenGameArt 以 CC0/CC-BY/GPL 混合为主。

结论（S6）：**最省事推荐 `@xyflow/react`（React Flow）**——React/Electron 项目无缝嵌入，节点即 React 组件，状态着色=改 className，像素动图直接 `<img>` 进节点；素材走 Kenney（CC0）。需要自动布局时配 `dagre` 或 `@dagrejs/dagre`。

来源：
- https://github.com/xyflow/xyflow
- https://reactflow.dev/
- https://itch.io/game-assets/free/tag-pixel-art

---

## 总表

| 自研点 | 现成件 | 维护状态 | 能不能直接用 | 复用代价 |
|---|---|---|---|---|
| S1 ACP 客户端/harness | `acpx`（+`@agentclientprotocol/sdk`） | ✅ 3.3k stars，日更，MIT | 能（spawn+stdio JSON-RPC） | 低：包一层进程管理 |
| S2 ACP 适配器 | 官方 `claude-agent-acp` / `codex-acp`；pi 仅社区 `pi-acp` | ✅ 官方两个数日一更；pi-acp ⚠️ 停更 2 个月 | claude/codex 能；pi 勉强 | 低；pi 适配器需自担风险 |
| S3 handoff schema | 无完全现成；借 A2A `Task`/`Artifact`/`contextId` 语义 | ✅ A2A spec+SDK 活跃 | 不能直接用；借字段语义自定义 JSON envelope | 中：设计文档模板+持久化约定 |
| S4 session 编排内核 | 无直接现成；LangGraph(JS) 原语最近 | ✅ 活跃 | 不能直接用；需在其上搭进程生命周期层 | 中高：自研冷启/回收层 |
| S5 上下文占用 | 读 CLI 暴露值（pi/claude/codex 均有）；降级用 `gpt-tokenizer` | ✅ gpt-tokenizer 上月发版 | 能（读 CLI）；自算仅降级 | 低 |
| S6 状态图前端 | `@xyflow/react` + Kenney CC0 像素素材 | ✅ 本月发版 | 能 | 低：自定义节点组件 |

## 必须自研的部分（一句话清单）

只剩三块必须自研：**handoff 文档模板与文件持久化约定**（借 A2A 字段语义）、**agent 子进程的冷启/回收生命周期层**（架在 acpx 之上）、**群聊 @ 订阅与消息路由胶水**（把聊天事件翻译成 ACP session 调用）——其余全部有维护中的现成开源件。
