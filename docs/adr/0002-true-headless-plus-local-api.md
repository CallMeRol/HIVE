# 真 headless（PANTRY_HEADLESS=1 不建主窗）+ local-api 回环 HTTP+SSE 第二前台

agent 节点需要无窗常驻，且需要一个不经过 Electron renderer 的控制面（读状态 / 发消息 / 优雅退出）。我们用 `PANTRY_HEADLESS=1` 走**真 headless**——完全不建主窗，在 `vendor/teahouse/src/main/index.ts` 打 7 处 ≤3 行补丁——并新增 `src/main/local-api/` 作回环 HTTP+SSE 第二前台。执行规范全文（hunk 级、未改代码）见 [#14 resolution](https://github.com/toRolex/hive/issues/14)；本文只记录形态取舍。地雷依据：`docs/research/teahouse-landmines.md`。

三条件已上游评审通过；此处只记否决与退出通道。

## Status

accepted

## Decision

1. **真 headless**：`HEADLESS = process.env['PANTRY_HEADLESS'] === '1'`，7 个 hunk 短路——常量（H1）、`createMainWindow()`（H2）、tray（H3）、`registerGlobalShortcuts()`（H4）、`window-all-closed → app.quit()`（H5，唯一防自杀闸门）、`activate`（H6 可选）、装配点（H7：`startAgentBridge` + `startLocalApi`，并入 `before-quit` 既有 2s 预算、`Promise.race` 不延长）。
2. **否决 `show:false` 隐藏窗降级**（#14 ticket 正文写的备选）：逐处核实后放弃——全仓非可选 `mainWindow` 使用仅 3 组且都在保护内/headless 不可达（`createMainWindow` 函数体内、`if (mainWindow)` 内、截图 IPC 内；其余 21 处均为 `mainWindow?.`），tray null-safe、`showMainWindow` 首行 `if (!mainWindow) return`。隐藏窗要点两处分支、renderer 白白常驻，**反而比真 headless 多改**。
3. **业务全落新目录**：`src/main/acp/`、`src/main/services/agent-bridge.ts`（胶水 service，零 electron 依赖）、`src/main/local-api/`、`scripts/fake-acp-agent.mjs`。上游 `docs/`、`net/`、`store/`、`shared/protocol.ts` 既有文件一行不改；分层铁律（业务禁入 `ipc/` 层）指针：`docs/research/teahouse-landmines.md` 卡 8。
4. **local-api = 与 `ipc/` 并列的第二前台**：`node:http` 零新依赖、只绑 `127.0.0.1`、薄适配器 → services。4 端点：`GET /v1/health`、`POST /v1/lifecycle/quit`、`POST /v1/messages`、`GET /v1/events`（SSE）。token 可选（`PANTRY_LOCAL_API_TOKEN`），空 = 仅回环可达即可信。
5. **`POST /v1/lifecycle/quit` 是唯一跨平台优雅退出**：Windows 无 SIGTERM，`child.kill()` 走 TerminateProcess → `before-quit` 链（exit 广播、补发队列落库）不执行，≥2s 优雅窗口直接失效；launcher 必须「先 quit 后 kill」并给 ≥3s。更便宜的 stdin `quit\n` 替代被否决——买不到 health/events 读数与 vitest「无 Electron 驱动真节点」入口，也丢掉 local-api 作为第二前台的预留名分。
6. **触发判定沿用地雷结论**：`view.mentioned` 只在 `payload.mentions.includes(selfId)` 那一瞬置位，mentions 不落消息表 → 绝不能查库回放；须排除 `isMine` / `system` / dedup。

## Considered Options

（show:false 隐藏窗降级见 Decision 第 2 条。）

- **stdin `quit\n` 通道替代 local-api 的退出职责（否决）**——只解决退出一条，买不到 `/v1/health` 读数（建群要复制 agent nodeId）、SSE 事件、vitest 集成入口，且丢掉 local-api 第二前台的预留名分。
- **引 express/fastify（否决）**——`node:http` 手写解析即可，零新依赖进 Electron 主进程。
- **只改端口多开节点（地雷否决）**——单例锁按 `userData` 隔离，只改端口会被 `app.quit()` 毙掉；每 agent 必须独立 `PANTRY_USER_DATA`。
- **查库回放 mentions（地雷否决）**——`mentions` 不落消息表，胶水只能钩 `groups.on('message')` 的 `view.mentioned` 实时判定。

## env 契约（要点，全表见 #14 §6）

`PANTRY_HEADLESS`（`1` = 无主窗）、`PANTRY_USER_DATA`（每 agent 必填且独立）、`PANTRY_UDP_PORT`/`PANTRY_TCP_PORT`/`PANTRY_LOCAL_API_PORT`（每 agent 独立，`0` = 临时端口）、`PANTRY_LOCAL_API_TOKEN`（空 = 仅回环即可信）、`PANTRY_AGENT_COMMAND`（空 = bridge 关闭）、`PANTRY_AGENT_NODE`（必须 ≥22，低则明确报错退出）、`PANTRY_AGENT_TRIGGER=mention`、`PANTRY_AGENT_RESPOND_TO=group`（呼应 #5 群成员即可触发）。

## Status note

本票「手写 NDJSON JSON-RPC 客户端、不把 `@agentclientprotocol/sdk` 装进主进程」的口径**已被 [#25](https://github.com/toRolex/hive/issues/25) 推翻**——改用**官方 ACP SDK**，见 [ADR-0004](0004-acp-sdk-via-runner-subprocess.md)。**其余方案不变**：真 headless 7 hunks、`local-api/` 四端点、`/v1/lifecycle/quit` 退出通道、env 契约、agent-bridge 触发与回收策略，均维持 #14 定案。

## Consequences

- 验收抓手：headless 自检行 `[headless] up nodeId=… udp=… api=…`；`PANTRY_HEADLESS=1 PANTRY_SMOKE=1` = 无窗启动 + 1.5s 干净退出的 CI 前门，每次上游同步后必跑（R2 门）。
- 关键验收（全表 H1–H6 / A1–A7 见 #14 §9）：
  - H1：headless 常驻 ≥60s 无窗、被 GUI 节点发现；
  - H5：`POST /v1/lifecycle/quit` 后进程 ≤3s 退出、对端 ≤2s 变灰（对比自然 offlineAfter 90s）；
  - H6：Windows 同 H5 且无残留 `node.exe`/`electron.exe`。
- 回收：bridge `dispose()` SIGTERM → 1s → SIGKILL，并入既有 2s 预算。
- 降级：未设 `PANTRY_AGENT_COMMAND` → 无 bridge，节点仍是普通群成员（能收能被 @，只是不回复）。
- 长回复硬约束：`TEXT_TCP_LIMIT = 4096` 字节超限 `sendText` 静默返回 null → 桥接层自截断 + 产物引用（呼应 #3）。
- 执行顺序每步一个验证门（S0 NDJSON 探针 → S1 hunks → S2 local-api → S3 acp+fake agent → S4 真桥 → S5 真 adapter → S6 Windows → S7 三节点），见 #14 §7。
