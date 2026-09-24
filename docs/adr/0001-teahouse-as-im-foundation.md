# 复用 teahouse 完整节点作为 IM 底座，agent = 本机附加节点

> **落点修订**：本文中的 “fork” 指基于完整节点二次开发，不代表 GitHub fork 工作流。代码以 snapshot vendor 进入 `vendor/teahouse/`，以 ADR-0003 为准。

在「无自托管、不注册账号、私人小群、跨网可达」的硬约束下，我们复用 teahouse 的完整节点作为人机群聊底座（形态 A：以 `src/main/services/` 新 service 承载胶水），agent 以「本机附加节点」形态接入——独立 `nodeId`、独立 `PANTRY_USER_DATA`、独立 UDP/TCP 端口，别人能像 @ 人一样 @ 它。产品层理由（为什么二次开发而不是自研协议）见 `docs/PRD.md` §「载体与网络决策」；本文只记录被否决的备选与取舍。源：[#1](https://github.com/toRolex/hive/issues/1)。

三条件（难逆转 / 无 context 会让人惊讶 / 真正权衡）已在上游评审通过，不再重论证。

## Status

accepted

## Considered Options

**Buzz（否决）**——注意：Buzz 才是「现成人机共处」（agent = Nostr 密钥对 = 协议一等成员），teahouse 不是。否决理由：

- **relay = 服务器**。四条「不自己跑 relay」的路每条都付代价：
  - Block 官方托管社区 → 要 **Builderlab 账号**；
  - 连别人 relay → 自托管者**无法邀请外部成员**（block/buzz#6923，邀请 UI 缺失）；
  - 自托管 relay → **默认不私密**（知道 URL 就能进），且群聊是**明文签名事件 → relay 运营者看得到全部内容**；
  - Railway 模板 → 第三方托管 + 账号。
- **工具链**：`buzz-cli` / `buzz-relay` / `buzz-admin` / `buzz-acp` **全部 cargo 构建**，npm 上无 `buzz-acp` → 两台 Windows 都要装 Rust 编译链。

否决证据引用（不复读）：`docs/research/buzz-without-self-hosting.md`（Q3/Q4 三坑）、`docs/research/no-server-agent-groupchat.md`（黑名单节）。

**OpenClaw / nanobot / switch（否决）**——形状是「agent 挤进别人的 IM」，会继承平台账号体系 + 平台网络可达性；国内黑客松现场 Telegram/Discord 大概率不可达（硬约束：不注册账号、现场要可达）。三者都没有「agent = 群成员一等公民」的落点，接入后 agent 的身份、提及、权限全部受制于宿主平台。

**纯 P2P 群聊替换（否决）**——候选全线没有 agent 桥：

- Jami：bot API 官方称「在做未发」；
- qTox：已归档；
- Tox/Briar/Berty/Veilid/Keet/Session：无任何现成 agent 接入面。

证据引用：`docs/research/no-server-agent-groupchat.md`（黑名单节 + 排序前 5 接入代价小表）。

**自研群聊协议（否决）**——群、成员表、消息、成员管理是成熟问题；复用底座只加「agent 作为成员」一层。产品层论证见 `docs/PRD.md` §「载体与网络决策」。

## Decision

以 snapshot vendor 复用 teahouse **完整节点**（非 GitHub fork；落点与同步纪律见 ADR-0003），agent = 本机附加节点，胶水钩 `groups.on('message')` 的 `view.mentioned`。

**关键权衡**：胶水工作量两边相当——`buzz-acp` 写好的只是「监听 @ → 喂 ACP agent → 回帖」，而这段在 teahouse 上本来也要写；我们已有完整协议知识 + 10 张地雷卡。**真正的差别只在底座依赖**。要偷 Buzz 的是**设计**（身份 = 密钥对、agent 与人在成员表里同构、@ → ACP → 回帖的 harness 形态），不是它的依赖。

## Consequences

- 单例锁按 `userData` 隔离 → 每 agent 必须独立 `PANTRY_USER_DATA` 与端口（只改端口会被 `app.quit()` 毙掉）。
- 地雷与协议知识集中在 teahouse（`docs/research/teahouse-landmines.md` 10 张卡）；Windows 端 A1–A9 全通过（`docs/handoff/windows-verification.md`）。每实例 RSS 未验证，归 [#32](https://github.com/toRolex/hive/issues/32)。
- 后续形态由 [ADR-0002](0002-true-headless-plus-local-api.md)（headless + local-api）与 [ADR-0003](0003-snapshot-vendor-with-patch-whitelist.md)（落点与同步纪律）承接。
- 更多调研指针：`docs/research/agent-group-chat-landscape.md`、`docs/research/local-agent-control-plane.md`。
