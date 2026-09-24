# 无服务器 · 人机共处群聊 — 第三轮（看群聊产品本体 + 已有的"多 agent 群聊"项目）

调研日：2026-09-21 · cwd=hive。口径按本轮放宽版：**自己不出服务器/公网 IP/证书；用别人的公共中继/公共 DHT/公共 relay 可以接受**（但必须注明依赖谁、可靠性如何）。不限定 overlay、不限定协议。
**唯一硬门槛：agent 能作为"一等群成员"加入，群里其他人能 @ 它、它能回复。**
标注：**确认**=一手来源明说；**存疑**=来源间接或未定论；**未找到证据**=搜过没有。
星数/最近提交读自 GitHub REST API 的 `pushed_at`/`stargazers_count`（本环境星数普遍异常高，只当活跃度参考，不当质量依据）。

## Summary
**有，而且不止一个项目已经做到"人机共处群聊 + agent 一等成员 + 无自建服务器"**：① `openclaw/openclaw` —— 本地 gateway，把你**已有的** Telegram/Discord/Matrix/Signal/Slack/WhatsApp/Teams 群当群聊底座，`requireMention:true` 就是"被 @ 才回"，一个进程还能跑多个互相隔离的 agent，官方安装器支持 macOS/Linux/**Windows**（本轮第一名）。② `block/buzz` —— agent 是**协议层一等公民**，而且**确认存在公共 Buzz 社区目录**（buzz.directory / buzzdir.xyz），不必自己跑 relay；代价是"社区/relay 归别人管，想要自己的新社区仍需有人跑 relay"。③ `HKUDS/nanobot`（MIT/Python，`groupPolicy:"mention"`）与 `sandbox-quantum/switch`（把 agent 接进 Slack/Teams/Discord）是同一形态的另两条路。**所有纯 P2P 系（teahouse/Jami/Tox/Briar/Berty/Veilid/Keet/Session）都没有现成 agent 桥**，群聊体验（历史同步/成员管理/离线）也普遍是弱项。

## Findings · A 类：群聊/IM 产品本体

| 名称 | 自建服务器?（公共中继可用?） | 账号/注册 | 群聊能力（多人 / @ / 成员管理） | agent 能一等成员加入?（现成桥） | 无桥时接入代价 | Win+Mac 客户端 | 维护 + License |
|---|---|---|---|---|---|---|---|
| **OpenClaw** `openclaw/openclaw` | **不需要**：会话/文件在本机，消息走**别人的平台**（Discord/iMessage/Matrix/Teams/Signal/Slack/Telegram/WhatsApp/Zalo） | 需要：用**你自己的**账号；Telegram 走 BotFather 免费 bot token 最干净 | 群能力=宿主平台原生（多人、@、成员管理全有）；OpenClaw 侧有 per-group 规则 + `requireMention` 默认门控（**确认**） | **是，本身就是一等成员**：被 @ 才唤醒；`agents.entries` 多 agent 各自独立 workspace/state/SQLite 会话（**确认**） | 0（配置即用）；接自研 agent 只需暴露 CLI/HTTP | **确认**：README 安装器支持 macOS/Linux/**Windows PowerShell** | pushed 2026-09-21；**MIT**（README badge；GitHub API 报 NOASSERTION，存疑） |
| **block/buzz** | **不需要自建**：**确认**存在公共 Buzz 社区目录（buzz.directory / buzzdir.xyz），填 relay URL 即可加入；但**新建自己的社区仍需有人跑 relay** | 需要：Nostr 密钥对（本地生成，无注册） | 强：频道/线程/成员/huddle | **是**：协议层一等公民，每个 agent 有独立可移植身份 | 低—中：Nostr 事件订阅 + bot 客户端 | 有桌面端（Rust/Tauri） | pushed 2026-09-21；**Apache-2.0**；33.8k★ |
| **HKUDS/nanobot** | **不需要**：本地跑，消息走别人的平台（Telegram/Discord/Slack/Teams/WeChat/Feishu/Mattermost/Linear/Email） | 需要：平台账号/bot token；有 pairing code 审批机制 | 有群渠道；`groupPolicy:"mention"`（默认）只在被 @ 时响应（**确认**） | **是**：agent 作为平台 bot 进群，被 @ 才动手（Slack 侧只要 `app:mentionable`） | 0—低：Python 3.11+ 起进程、填 token | 跨平台（Python），无原生安装器；桌面成熟度**存疑** | pushed 2026-09-21；MIT；48.4k★ |
| **sandbox-quantum/switch** | **不需要自建**（可 self-host 但非必须）：把 agent 接进你已有 Slack/Teams/Discord | 需要：Slack/Teams/Discord workspace 账号 | 群能力=宿主平台原生；支持同一 workspace 里多个可 @ 的 bot 身份 | **是**：定位就是"让 agent 成为频道成员，被 @ 参与" | 低：编写 agent adapter | 客户端=Slack/Teams/Discord 原生（Win/Mac 都成熟） | pushed 2026-09-21；License 未识别（NOASSERTION，**存疑**）；650★ |
| **Matrix + 本地 bot（公共 homeserver）** | **不需要**：**确认**有公共 homeserver 列表（servers.joinmatrix.org）；agent 是本地进程用 client-server API 登录 | 需要：公共 hs 注册账号（E2EE 下 bot 需处理设备验证） | 最强：房间/@/成员权限/线程/搜索 | **有成熟生态**：`matrix-nio`（pushed 2026-08-08）、mautrix 系等，bot 就是普通房间成员 | **最低**：几十行订阅+发送脚本 | Element 等 Win/Mac 都很成熟 | element-hq/synapse pushed 2026-09-21（已从 matrix-org 迁出）；AGPL-3.0 |
| **SimpleX Chat** | **不需要**：无服务器设计，消息走 relay 队列（官方或他人 relay） | **无账号/无用户标识**（设计卖点） | 有群组、成员角色/权限/审核；v6.3 起支持**群内 @ 成员**（**确认**） | **有**：官方 bot API + 第三方 `NCalex42/simplex-bot`（Java，可做群管理与接本地 Ollama） | 中：用 bot API 起常驻进程；"群内 @bot"的语义**存疑** | 终端 CLI 强、GUI 偏移动端；Win/Mac GUI 成熟度**存疑** | pushed 2026-09-21；AGPL-3.0；19.5k★ |
| **Nostr 客户端 + bot（NIP-29）** | **不需要**：公共 relay（可多 relay 冗余；但公共 relay 会丢历史/限速/随时关） | 需要：Nostr 密钥对（无注册） | NIP-29 relay 托管群：成员/角色/审核由 relay 管；@ 走 p-tag | **有**：bot 生态好写（nostr-tools/nostr-sdk），bot 就是普通密钥身份 | 低 | 客户端多但桌面成熟度一般（Damus=iOS；amethyst 已 archived 2021） | nips pushed 2026-09-21；规范无 License；damus GPL-3.0 |
| **Jami（GNU）** | **不需要**：自建 DHT（OpenDHT） | 需要：本地生成 Jami 账号 | 有 conversation 群聊/多人；成员管理弱 | **在建未发布**：官方论坛回复"chat bots 由 Aline 在做"；社区有 `jami-bot`（GNU ELPA，驱动**本地** Jami 客户端） | 中—高：等官方 API，或本地客户端自动化（脆弱） | Jami-Qt 有 Win/Mac 桌面 | pushed 2026-09-17；GPL-3.0 |
| **Tox / qTox** | **不需要**：他人公共 DHT bootstrap 节点 | 不需要：本地 Tox ID | 旧式 tox group：无成员管理、无历史同步 | **无**官方 bot API（未找到证据），第三方生态停滞 | 高：自己封 toxcore 写常驻节点 | qTox **已 archived 2025-02-16** | **死系**：qTox 归档；toxcore 推进慢 |
| **Briar** | **不需要**：公共 Tor 网络 + 局域网直连 | 不需要：本地身份 | 群聊 + 论坛（threaded） | **无** bot API（未找到证据） | 极高：Android 优先，需改代码 | **弱**：桌面长期 beta | 活跃（briarproject.org）；GPL-3.0 |
| **Berty** | **不需要**：p2p + 公共中继协助 NAT 穿透 | 不需要账号 | 有群组/按媒体分享 | **无**官方 bot API（未找到证据）；有 daemon gRPC 可外部驱动 | 中—高：用 daemon 当 agent 客户端，自写编排 | 移动优先；桌面**未找到证据** | pushed 2026-09-17；多许可混合（**存疑**）；9.3k★ |
| **Veilid / VeilidChat** | **不需要**：公共 Veilid DHT | 不需要 | **只有 1:1 文本**（Play 描述 "person-to-person text only"）；群聊仍在路线图 | **无** bot API（未找到证据） | 高：基于 Veilid API 自研群聊 + agent | 官方**无发布构建**；桌面未找到证据 | 核心活跃（veilid.com）；License 混合（**存疑**） |
| **Keet / Holepunch（Pear + Autobase）** | **不需要**：Pear 运行时 + Hypercore 系 p2p | 不需要账号（邀请制 room） | 有群聊/多人通话；成员基于邀请 | **无**现成 agent 桥（未找到证据），但 JS P2P 运行时可跑 agent peer | 高：要在 Pear 里常驻一个 peer | Keet 有 Win/Mac 桌面，成熟度中等 | holepunch.to 运营中；核心仓库活跃度**未找到证据** |
| **Session** | **不需要自建**：用其**公共节点网络**（onion routing） | 需要：Session ID（无手机号/邮箱，但非无标识） | 有群聊（大群），成员管理弱 | **无**官方 bot API（未找到证据） | 极高：协议封闭，只能改客户端 | 有 Win/Mac 桌面 | 活跃；GPL-3.0 |

## Findings · B 类：组网层（给现成 IM 垫一层）
- 前轮结论保持不变，一句话确认：**EasyTier / Yggdrasil / iroh / EdgeVPN / anywherelan** 只解决"可达性"，不解决"群聊 + agent 一等成员"；垫完之后仍要选一个群聊产品，产品的账号体系/客户端问题一个都没少。
- 唯一实质增益：把 **P2P 型 IM（teahouse/Briar 系）** 的"局域网直连"升级成"跨网直连"，且**不用**给它们搭信令服务器。代价：所有参与者都要装叠加网客户端 + 拿到同一个网络凭据。**结论：对"想 @ 一个 agent"这个需求，B 类是纯拖累。**

## Findings · C 类：已存在的"多 agent 群聊"开源项目（本轮重点）
**真·人机共处群聊（人类和 agent 在同一个房间/频道里）：**
1. **openclaw/openclaw** — 人机共处，agent 一等成员（`requireMention`），活在"别人的群"里；同进程多隔离 agent。**本轮最强的现成答案。**
2. **block/buzz** — 人机共处 + agent 可移植身份，群聊本身就是产品；社区可加入公共 relay 目录里的现成社区。
3. **HKUDS/nanobot** — 同形态（本地 agent 进别人的群），`groupPolicy:"mention"`；更轻，但多 agent 共存不是它的原语。
4. **sandbox-quantum/switch** — 把任意 agent 接进 Slack/Teams/Discord，agent 是**可 @ 的 channel 成员**；面向企业 workspace。
5. **stacklok/mecatl** — 生态里明确提"一个 workspace 里多个可 @ bot 身份、每身份背后一个 agent"（issue #1053）；但它是 **cloud-native harness**（要 K8s 那套）→ 对"无服务器"负分。
6. **OpenAI Agents API 官方 cookbook 的 Slack bot 示例** — "在 Slack 里做可 @ 的 agent bot"已是官方示范，说明这条路是**行业默认解**（代价：绑 OpenAI 生态）。
7. `jaylfc/taOS`（AGPL-3.0，self-hosted agent OS，含 chat/agents）— 人机共处，但 **self-hosted 就是自建服务器**，不符合口径。
8. `EKKOLearnAI/hermes-studio`、`AlessandroFare/fluxychat`（Cloudflare Durable Objects）、`beatmadsen/agent-chat`、`knoxio-labs/room`、`Fever-Wits/room-agent`、`bohutang/ChatTok`、`ZZMoore/group-chat-agent-runtime` — 全是"人类 + 多个 agent 在一个房间"的**小项目**（1—11★），只配当设计参考；fluxychat 额外绑 Cloudflare。
**只是"多 agent 之间的消息总线/编排"，人类不是群成员（对用户需求=错类）：**
9. `LittleLittleCloud/Agent-ChatRoom`（AutoGen 多 agent 聊天室，2024 停更）、AutoGen/AG2 `GroupChat`、CrewAI、LangGraph、`OpenBMB/ChatDev`、`Farama-Foundation/ChatArena`。
10. Google **A2A** / Zed **ACP** 是 agent↔agent 或 editor↔agent 协议，**不是"人类群聊"**；只能当"让 agent 互通"的补充层。

## 排序前 5（针对"多人互通 + agent 一等成员 + 能 @ 它"）
1. **OpenClaw**（本地 gateway + 你现有的群，0 自建服务器，Win/Mac 官方安装器，多 agent 同进程隔离）
2. **block/buzz**（唯一"群聊协议本身把 agent 当一等公民"的开源产品，可加入公共社区 relay）
3. **HKUDS/nanobot**（同形态的 MIT/Python 版，渠道更杂：WeChat/Feishu/Linear）
4. **Matrix + 本地 bot**（最成熟标准 + 公共 homeserver 列表，bot 天然是房间成员）
5. **SimpleX**（无账号无服务器 + 群内 @ + bot API，代价在桌面体验与群内 bot 语义）
> **第 1 名相对第 2 名的实质优势**：OpenClaw 是**0 行代码、群聊底座就用你已经在用的 App、agent 身份就是平台里的一个可 @ 成员**，而且"多个 agent 在一个 gateway 里各自身份/记忆隔离地共存"是它的产品原语；Buzz 更"正统"（agent 是协议一等公民、群聊是自研产品），但你必须加入**别人管的**社区，或自己/熟人跑一个 relay，且要自己写 bot 客户端。

## 接入代价小表（前 5 变成"人机共处群聊"最少要写什么）
| 排名 | 最少工作量 | 产出物 |
|---|---|---|
| 1 OpenClaw | **0 行代码**：装 gateway → 登录渠道 / 填 bot token → 配 `requireMention` 与 `agents.entries` | 一个配置目录 + 一个常驻进程 |
| 2 Buzz | **~1 个 bot 客户端**（订阅 relay 事件 + 回帖）+ 加入公共社区（或自备 relay） | Nostr 密钥对 + bot 进程 |
| 3 nanobot | **0—50 行**：起 Python 服务 + 填 token + `groupPolicy:"mention"`；多 agent 要各自起实例 | 一个 Python 进程/agent |
| 4 Matrix | **~50—150 行**：`matrix-nio` 登录公共 hs → 进房间 → 收 mention 回消息（E2EE 需处理设备验证） | 一个本地 Python/Node bot |
| 5 SimpleX | **~100—300 行**：跑官方 bot API（或改 `simplex-bot`）→ 进群 → 响应 @（需自行验证群内 @ 语义） | 常驻 bot 进程 |

## 黑名单（看起来行、实际不行）
- **Tox / qTox**：qTox 2025-02 已归档，无 bot API，群聊无成员管理/历史 → 死系。
- **Jami**：官方 bot API"在做但没发"，现只能靠本地客户端自动化 → 现在做要自己填坑。
- **Briar**：无成熟桌面客户端 + 无任何 bot 接口 + Tor 群聊延迟高 → 工程自杀。
- **Berty**：daemon gRPC 理论可行，但无桌面端、无群内 bot 编排 → 中等偏大工程。
- **VeilidChat**：官方自述**只有 1:1 文本**、无发布构建 → 连"群聊"这一条都不满足。
- **Keet / Holepunch**：无 agent 桥，且要学 Pear/Autobase 一整套 → 学习成本过高。
- **Session**：协议封闭、无 bot API、成员管理弱 → 只能 fork 客户端。
- **teahouse**：项目本身不错（GPL-3.0、活跃），但**无 bot/API、无成员管理、还要信令**（前轮 landmines 已记）→ 只能当 UI 参考。
- **taOS / Mattermost / Zulip / 自托管 Synapse**：等于"自建服务器" → 违反本轮唯一硬约束。
- **mecatl、Agent-ChatRoom、ChatDev、ChatArena、AutoGen GroupChat**：前者 cloud-native（要 K8s），后几者是"agent 互相聊"的框架，人类不是群成员 → 错类。
- **Nostr 裸用公共 relay 自建群**：技术上可行，但公共 relay 随时删群/丢历史/限速，NIP-29 群还要求 relay 实现成员与审核逻辑 → 自建群基本要自己或熟人提供 relay（这就是 Buzz 的唯一短板）。
- **搜索结果里 GitHub API 直查 404 的仓库**（如 `ChesterRa/cccc`、`ChenKuanSun/openclaw-world`）：疑似不存在，不予采信。

## 明确回答第 4 问
**有。** 最直接的是 **OpenClaw（`openclaw/openclaw`）**：本地运行、无自建服务器、agent 以可 @ 成员身份出现在你已有的 Telegram/Discord/Matrix/Signal/Slack 群里，还能同进程跑多个隔离 agent；**`block/buzz` 也明确算**（agent 一等公民 + 人机共处 + 可加入公共 Buzz 社区 relay，只是新社区仍要有人跑 relay）；**HKUDS/nanobot** 与 **sandbox-quantum/switch** 是同一答案的另外两种实现（Python 版 / Slack-Teams 版）。

## Contradictions / 存疑点
- **OpenClaw License**：README 显示 MIT 且指向 LICENSE，但 GitHub API license 检测为 NOASSERTION → 以仓库文件为准，标注不撤。
- **星数异常**：API 返回的星数（openclaw 390,200、nanobot 48,457）远超常见量级，可能被镜像/注入改写 → 只用于"谁更像主流"的相对判断。
- **Buzz**：support 页"可填别人的 relay" + 社区目录（buzz.directory）**确认公共社区存在**；但"relay 间是否共享同一 community""目录里有多少 relay 真活着"未验证，且治理/审核权在别人手里。
- **SimpleX 群内 bot**：官方有 bot API、群内 @ 成员确认存在，但"bot 是否是群内被 @ 的成员"两条证据没直接接上 → **存疑**。
- **公共 Matrix homeserver**：取到公共列表（servers.joinmatrix.org），但 matrix.org 具体注册政策页面多次 fetch 失败 → 具体 hs 的开放度**存疑**。

## Missing evidence
- 没有任何项目一手文档明确写"**多个不同 owner 的 agent** 在同一个群里各自有身份并共存"——OpenClaw 的多 agent 是同一 gateway 内多身份，跨 owner 的多 agent 群聊**未找到证据**。
- OpenClaw/nanobot 在**纯群聊**下的 @ 解析与"多 agent 谁该回"的行为：未验证。
- SimpleX 桌面 GUI 的 Win/Mac 成熟度、Jami bot API 时间表：未验证。
- Buzz 公共社区目录里的 relay 存活率/延迟/历史保留：未验证。

## Sources
- Kept：OpenClaw README/LICENSE + `docs.openclaw.ai/channels/groups`、`/concepts/multi-agent`（mention 门控、渠道清单、多 agent 隔离、安装器支持 Windows）— 支撑第 1 名。
- Kept：block.github.io/buzz/support.html、block/buzz `ARCHITECTURE.md`、buzz.directory、pavlenex/buzz-directory（可填他人 relay / 公共社区目录）— 支撑 Buzz 判断；Buzz 细节另见前轮 `agent-group-chat-landscape.md`。
- Kept：HKUDS/nanobot README + `docs/chat-apps.md`（`groupPolicy:"mention"`、渠道、MIT）— 支撑第 3 名。
- Kept：github.com/sandbox-quantum/switch README + sandboxaq.com 新闻稿（把 agent 接进 Slack/Teams/Discord）。
- Kept：simplex.chat 博客 v6.3（群内 @ 成员）+ github.com/NCalex42/simplex-bot（第三方群 bot 可接本地 LLM）。
- Kept：`matrix-nio` 活跃 + element-hq/synapse 活跃 + servers.joinmatrix.org（公共 homeserver 列表）。
- Kept：veilid.com/chat + Google Play VeilidChat 描述（1:1 text-only、无官方构建）；qTox 归档通知（2025-02-16）；nips.nostr.com/29（relay 托管群语义）。
- Deprioritized：Medium/TNW/LinkedIn/YouTube 关于 Buzz、OpenClaw 的二手解读 — 只用于发现对象，不作结论依据。
- Rejected：GitHub API 直查 404 的搜索结果仓库（ChesterRa/cccc、ChenKuanSun/openclaw-world）— 疑似不存在。

## Next steps
1. 只做一件验证：**OpenClaw 在 Discord/Telegram 群里"多人 @ 同一个 agent"的真实体感**（装一次，10 分钟）——它决定用户是否还需要自研。
2. 若要"多 owner 的多个 agent 同群共存"，查 OpenClaw group 白名单 + 多实例是否支持（当前只有同 owner 多身份的证据）。
3. 若坚持"不依赖任何人的商业平台"，实测 Buzz：用 buzz.directory 里一个公共社区跑通"人 + agent"的完整链路。
