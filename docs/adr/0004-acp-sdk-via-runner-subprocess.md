# ACP 客户端经 runner 子进程接入官方 SDK

- **Status**: accepted
- **源 issue**: [toRolex/hive#25](https://github.com/toRolex/hive/issues/25)（推翻 [#14](https://github.com/toRolex/hive/issues/14) 口径）

ACP 的 JSON-RPC 协议层不再手写：复用官方 `@agentclientprotocol/sdk`，以系统 node ≥22 的 runner 子进程形态跑 stdio。该决定推翻 #14「手写 NDJSON JSON-RPC、不引 SDK 进 app」的旧口径——根因是 Electron 22 主进程（内嵌 Node 16.17.1、CJS-only）装不进 ESM-only 包，子进程是唯一通路。

## Context

- #14 原 resolution 定「客户端手写 NDJSON JSON-RPC」；owner 在 #17 明确转向「复用现成开源实现」，#25 裁定复用哪一个、怎么复用，并要求据此作废 #14 那一行。
- 硬约束（#25 一手核实）：Electron 22.3.27 主进程 = Node 16.17.1、仅 CJS（原生 ESM 需 Electron 28+）→ ESM-only 的现代 npm 包进不了主进程；而 #14 已定 adapter 用系统 node ≥22 当子进程，两者形态天然一致。
- 能力集已被 [#21](https://github.com/toRolex/hive/issues/21) 实测收敛：最小 client ≈ 45 行（`initialize` / `session/new` / `session/prompt` + 应答 `session/request_permission` + 通知丢弃），`clientCapabilities` 可置空，fs/terminal 不 advertise 则 agent 按协议零调用 → 选型价值不在省行数，在成熟度（并发/取消/半包）与后续扩展。
- 分发硬约束：断网演示要求依赖树随包内嵌、运行时零网络。
- License 不构成否决项：map 上限为「接受 GPL-3.0」，候选全部 Apache-2.0/MIT，低于上限。
- 两个必做 adapter（`claude-agent-acp@0.79.0` / `codex-acp@1.12.0`）均协商 `protocolVersion:1`，共同依赖 `@agentclientprotocol/sdk`——客户端与 agent 侧本就同源。

## Considered Options

1. **（选定）官方 `@agentclientprotocol/sdk` + runner 子进程。** v1.5.0，Apache-2.0，0 运行时依赖（peer `zod`），5.6 MB，官方 typescript-sdk 日更；`src/main/acp/` 内的 runner 跑系统 node ≥22，Electron 主进程 spawn 之、stdio JSON-RPC 通信。
2. **手写 NDJSON JSON-RPC（#14 原口径）——否决。** owner 在 #17 推翻，要求复用开源件；且 #21 表明自研仅 ~45 行，拿不到成熟度收益却自担协议演进成本。#14 resolution 中该句作废，以 #25 为准。
3. **buzz 字面复用（`crates/buzz-acp`）——否决。** Rust crate，无 NAPI/WASM/JS 绑定，只能当独立二进制；「复用 buzz 这样的」按精神执行 = 复用 Node 生态现成件。
4. **`acpx`——备选不首选。** MIT、`engines.node >=22.13.0`、ESM，库用法无 semver 承诺；若 runner 实测缺关键能力再换。

## Decision

- JSON-RPC 层由官方 SDK 吃掉，不再手写；形态 = 系统 node ≥22 的 runner 子进程 + stdio。
- runner 位于 `src/main/acp/`：Electron 主进程 spawn，`PANTRY_AGENT_NODE` 显式指向系统 node（不继承 `process.execPath`，后者是 `electron.exe`），stdio 上跑 JSON-RPC。
- 依赖新增仅 `@agentclientprotocol/sdk` + peer `zod`。
- 与 #14 的差异仅在协议层载体；#14 其余口径不变（#25 时点「上游零改动」后被 #35 白名单首破修订，见 [ADR-0003](0003-snapshot-vendor-with-patch-whitelist.md) 修订节）：headless 补丁、`src/main/acp/` 目录、`agent-bridge` 胶水、`local-api/`、`scripts/fake-acp-agent.mjs`。
- scope 边界：群聊内容如何进 agent 上下文（prompt 注入为主、读群聊日志为辅）属胶水层规格，协议层无差别，不改本选型；ACP 请求/流回路原生全双工，「agent 主动发问」无需特殊能力。

## Consequences

- SDK 与 runner 依赖树随包内嵌，运行时零网络，满足断网演示硬约束。
- 多一层子进程生命周期管理（spawn / stdio / 优雅退出），换取主进程免受 Node 16 CJS 限制。
- #19 PRD 验收必须按 SDK 载体写，不得再沿用 #14 手写口径。
- 协议版本锚定 `protocolVersion:1`（v2 schema 仍为 draft）；未来 fs/terminal/elicitation 扩展由 SDK 承接，advertise 即须实现。
- 换载体的再评估条件：runner 实测缺关键能力时切 `acpx`（备选已核 license/engines）；手写方案不因行数优势复活——#21 已证明行数不是选型变量。
- 选型验证过的三个条件（#21 映射）均满足：① `clientCapabilities` 可置空/渐进式 advertise；② `session/request_permission` 有可插拔应答钩子（对接 hive 审批 UI/策略）；③ `session/set_config_option` 可由 hive 显式调用（选模型/模式）。
- 主进程与 runner 的失败域隔离：runner 崩溃不拖垮 Electron 主进程，协议层升级只需换子进程依赖、不动 app 运行时。
