# 群内只发正式消息，过程落本机机库

agent 的 `session/update` 流含大段思考与工具调用：全量转发进群会刷屏、丢弃又伤演示与审计。我们决定：群里只有正式消息——turn 内 `agent_message_chunk` 累计，自然边界分条、单条 ≤3500B、首条 `reply_to` 指回派单；过程按类型不进群，完整落成员所在机器的 append-only jsonl + md（含出向与守卫判定，无 TTL）；机库（Hangar）per-member 看过程；唯一例外 = turn 未结束时含 @ 的插话；群内统一 Markdown。词形已进 `CONTEXT.md`，此处只记 why 与边界。

## Status

accepted

## Decision

- **正式消息 = turn 内 `agent_message_chunk` 累计**
  - turn 结束 = `session/prompt` 返回 `stopReason`。
  - 分条按自然边界（空行 / 标题 / 列表块），单条 ≤3500 B（#29 定的分条上限，低于 teahouse 4096 硬限，留切片余量）。
  - 多条 = 同一 turn 连续群消息、seq 连续，首条 `reply_to` 指回派单；单个代码块/表格超限硬切、每片标 `(1/n)`。
- **过程按类型不进群、不按长度**
  - 过程 = `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `plan_update` / `plan_removed` / `usage_update` / `session_info_update`，一律不产生群消息。
  - 协议控制面（`available_commands_update` 等）只进本机 transcript。
  - 类型全集出自 `@agentclientprotocol/sdk@1.4.0`；不按长度阈值——阈值随模型/语言漂移，不可判定。
- **过程落盘（成员所在机器）**
  - 无服务器 ⇒ 跨机写不可能：`<artifactsRoot>/sessions/<memberId>/<sessionId>.jsonl` append-only。
  - 入向全部判别值 + **出向**（`session/prompt` 正文、`session/request_permission` 应答、`initialize` 等）+ 守卫判定单独一条 `{目标, 新请求原文} → {判定, 置信度, 理由}`；turn 结算时同目录写 `.md`。
  - **无 TTL、不自动清理**（7 天 TTL 只属于离线补发队列），磁盘告警时主人手动清。
- **机库（Hangar）per-member 过程台**
  - 活跃 / 归档两区，成员下按会话、会话内按 turn 的原始时间线，类型过滤 + 全文搜索，不加工不总结。
  - 本机 per-member 账本，**不是**群级历史回放（词形与边界见 `CONTEXT.md`）。
- **唯一例外 = 含 @ 插话**：turn 未结束时含 @ 的 `agent_message_chunk` 立即按普通群消息发出——否则 agent 向人提问会被折进过程，人答不上来。
- **群内统一 Markdown**
  - 人机同渲染；按 sender 区分会引入"谁是 agent"概念，而 teahouse 无 agent 位。
  - 代价 = 改上游 `MessageRow.vue` + 引 `markdown-it` + DOMPurify，**主动破 #22 白名单**，记账见 #35 与 ADR-0003 修订节。
- **过程为什么不进群（why）**
  - ① 第一性原理"绝不共享上下文"——被 @ 唤醒的成员注入群历史时会读到别人的思考流。
  - ② 群消息进 FTS 索引与离线补发队列（单对端 200 条）；③ 一个 turn 几十条 update 会淹没群聊。
  - 可观测性归机库 + 落盘，不归群聊。

## Considered Options

- **全量转发进群（否决）**：刷屏 + FTS/补发队列污染 + 过程进群历史 = 变相共享上下文。
- **按长度截断（否决）**：阈值随模型与语言漂移不可判定；长短不代表是不是过程。
- **丢弃过程不落盘（否决）**：演示要看 agent 怎么想；守卫出向记录是"输入里没有历史"的唯一证据，丢了审计价值清零。
- **折叠条放群里（否决，修订 #25 前提）**：#25 原前提"终版消息 + 折叠条"被本票修订——折叠载体是本机机库，群内零过程痕迹；前提实质（不丢弃、要时能看）不变。

## 源

- Issue: https://github.com/toRolex/hive/issues/29 （resolution comment 为终版口径）
- 被修订前提：#25 ；白名单破口记账：#22 、#35 、ADR-0003 修订节
- 词形：`CONTEXT.md`（正式消息 / 过程 / 机库 / 归档）；产品层 why：`docs/PRD.md` §5 A3、§10 术语表
