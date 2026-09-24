# 跨机 agent 状态可见性：teahouse 承载面与代价（GitHub ticket #34 · prong 2）

- 上游只读对象：`/tmp/teahouse-recon`（`git remote = https://github.com/skyjt/teahouse.git`，HEAD `f6607ff`，`package.json` version `0.60.2`，提交 2026-09-18）
- hive 侧需求来源：`/Users/rolex/Documents/Codes/githubProject/MyProject/hive`（只读）：`docs/handoff/sprite-and-network-contract.md`、`docs/research/teahouse-landmines.md`、`CONTEXT.md`
- 纪律：**未修改上游任何文件**；本文件是本次任务唯一写入。
- 置信：高＝直接读到代码且语义唯一（含测试佐证）；中＝代码＋文档交叉推断；低＝推断未实测。

---

## 0. 速览：五个承载面能否承载「一个高频状态字段」

需求侧要携带的量（hive 定案，`docs/handoff/sprite-and-network-contract.md` A2 表 + B 表）：`上下文负担 pct = used/size`（五档阈值 10/20/40%）、必须同屏记录 `window size`、会话目标（当前任务）、派遣者/深度/派遣于；离线不占负担档（无数据按 `idle` 蓝）。

| 承载面 | 能否承载高频状态值 | 为塞入该值必须改的上游文件 | 主要代价 | 置信 |
|---|---|---|---|---|
| **presence / profile**（§2.1） | 只能承载**慢变**值；高频不可用 | `protocol.ts`（`Profile`/`PresencePayload`）+ `codec.ts`（4 个 case）+ `discovery.ts` | 全子网广播（越权可见）、`profileRev` 递增触发全量资料交换 churn、30s 节拍、上游已在协议史里否决「alive 搭车」 | 高 |
| **gossip `peers`**（§2.2） | **不能**（摘要只有地址，且转述不入表） | `protocol.ts` + `codec.ts` + `discovery.ts` | 5 分钟节拍、fanout 2、条目必须再 `entry` 验证 → 时延与可信度都不成立 | 高 |
| **自定义群消息 group-text**（§2.3） | 可以，但**必须改上游 codec 白名单** | `codec.ts:184-187` + `protocol.ts` `MsgPayload` + 渲染层 `ipc.ts`/`MessageRow.vue` + `msg-repo.ts` | 每成员一包（≤200）、落 `messages` 表 + FTS 污染、离线占 200 条补发队列、显示成聊天气泡 | 高 |
| **文件传输 `file_ref`**（§2.4） | 技术上能，工程上荒谬 | `protocol.ts` `FileCtlOffer.purpose` + `codec.ts` + `files.ts` + `FileCard.vue` | 每次更新=offer+落盘+用户可见文件卡；`FILE_OFFER_TTL` 24h、`PULL_IDLE_TIMEOUT` 60s | 高 |
| **`caps` 能力位**（§2.5） | **能承载布尔位，不能承载值**；但**零上游改动** | 无（`codec.ts:108-109` 通用校验） | 只在资料交换时传播（非心跳）、16 位预算已用 10、每次变更要全量广播资料 | 高 |
| **（新增私有信封类型）**（§4 MVP） | **能**，且**零上游 codec/protocol 改动** | 无（`codec.test.ts:151` 证实） | 上游会忽略（`known=false` 被两处过滤）、无 ACK/无补发，需自建校验与 TTL | 高 |

**一句话**：「一个位置看见所有 agent（含别机）」**能做**；最小可行方案是把状态当作**一条新的私有信封类型 + 一个 caps 位**，走 best-effort 单播，**不碰上游 codec/protocol**。若坚持「一行上游都不动」，只能降级为「这台机器有没有 agent」的布尔可见性。

---

## 1. 底座事实（后面所有代价计算的基准）

- 出站单包上限 `UDP_MAX_PAYLOAD = 1200`、入站硬上限 `UDP_MAX_INBOUND = 4096`：`src/shared/protocol.ts:9,11`；超限出站直接丢弃：`src/main/net/udp.ts:71-74`。置信高。
- **每源 IP 令牌桶限速：默认 30 包/秒、突发 60**：`src/main/net/udp.ts:41`；装配处未覆盖该默认值（`src/main/index.ts:1173` 只传 `port`/smoke 覆盖）。**这是高频状态的硬天花板**。置信高。
- 广播目标 = 所有非回环 IPv4 网卡的子网定向广播 + `255.255.255.255`：`src/main/net/udp.ts:139-156`；多网卡/VPN 机器会把报文喷到所有网段（hive 侧已记录：`docs/research/teahouse-landmines.md` 卡 6）。置信高。
- 时序常量：`presenceInterval 30_000`、`offlineAfter 90_000`、`sweepInterval 10_000`、`profileProbeInterval 10_000`、`gossipInterval 300_000`、`gossipFreshness 600_000`、`queueTtl 7*24h`、`queueMaxPerPeer 200`、`ackRetrySchedule [1s,2s,4s]`：`src/shared/protocol.ts:48-68,79-83`。置信高。
- 离线判定：`registry.sweep(offlineAfter)` 由 `discovery.ts:126` 每 10s 调用，超过 90s 未 `lastSeen` 置灰：`src/main/net/peer-registry.ts:117-121`。置信高。
- **实测信封大小**（本机 node 计算，字段按 LIMITS 上限构造）：`presence` 信封 **173 B**；`alive`（含全量 Profile）**510 B**。都远低于 1200 B。置信高。
- 消息落库即进 FTS：`INSERT INTO messages_fts ...`：`src/main/store/msg-repo.ts:109`；FTS 表定义：`src/main/store/migrations.ts:56-58`。置信高。
- 联系人 UI 当前只有「绿/灰点」二态，无状态载荷：`src/renderer/src/components/PeerList.vue:159`、决议 #252 测试 `src/renderer/src/ui/contact-presence.test.ts:7-16`。置信高。
- 全仓无 typing / 忙碌 / 上下文类状态字段（grep `typing|正在输入` 零命中）。即「状态面」目前只有 online/offline。置信高（排除法 + grep）。

---

## 2. 五个承载面逐面评估

### 2.1 presence / profile（`discovery.ts`、`profileRequests`）

**机制证据**
- `PresencePayload = { seq, profileRev }`：`src/shared/protocol.ts:221-225`；`Profile` 是固定字段集（nodeId/nick/company/dept/team/avatar/avatarHash/profileRev/host/platform/tcpPort/ver/caps），无自由字段：`src/shared/protocol.ts:135-155`。
- 每 30s 广播 `presence`，并对已知在线节点单播：`sendPresence()` `src/main/net/discovery.ts:344-352`；定时器 `discovery.ts:124`。
- `profileRev` 失配 → 收端单播 `entry`，对方回全量 `alive`：`src/main/net/discovery.ts:362-364`（presence case 内 `requestProfile`）；协议文档 `docs/protocol.md:115` 明说「零新增报文类型，最迟一个心跳周期内纠正资料漂移」。
- 资料类报文（entry/alive/profile）由 `validateProfile` 逐字段白名单校验：`src/main/net/codec.ts:83-110`。
- `profileRequests` 有节流与在途上限：同节点 10s 内不重复探测（`profileProbeInterval`）、在途上限 1024：`src/main/net/discovery.ts:311-313`；节流表上限 1024：`discovery.ts:315-317`。

**能否承载高频状态值：否（只能慢变）**
1. **无字段可放**。要加字段必须同时改 `protocol.ts` 的 `Profile`/`PresencePayload` **和** `codec.ts` 的 `validatePayload`（entry/alive/profile 共用一个 case `codec.ts:124-129`，presence 一个 case `codec.ts:130-134`），属**协议层改动**，rebase 冲突面最大。
2. **上游已明确否决「搭车」**。协议变更史写：「弃用『alive 搭车』（alive 保持轻量，1200B 限制下易超）」：`docs/protocol.md:514`。虽然实测 510 B 并不超，但上游的设计选择是「资料报文只承载慢变身份」。
3. **越权可见**。presence/alive/profile 是**子网广播 + 对全部在线节点单播**（`discovery.ts:124,344-352`），与群成员关系无关。把 agent 负担放进 profile ＝ 向全网段（含不在你群里的同事）暴露「你机器上的 agent 快炸了」。这是 hive 侧最不该接受的一条。
4. **高频会引发全量资料交换 churn**。每次状态变更都要求 `profileRev+1`（语义「每次修改 +1」`protocol.ts:143`），而收端在「rev 相同但内容不同」时会主动重新握手：`discovery.ts:372-375`。于是每次状态更新都要 `announceProfile()`（广播 + 逐在线节点单播全量 Profile，`discovery.ts:214-226`），且 caps/资料变更落库：`src/main/index.ts:310-312`。
5. **刷新粒度 = 30s**（presenceInterval），且「够不着」的判定粒度 = 90s（offlineAfter）。hive 要求「没停顿」（无数据按 idle 蓝继续循环，`sprite-and-network-contract.md` A2），30s/90s 节拍与之不冲突，但也不足以表达「几秒级的负担跳动」。

**代价小结**：改上游面积＝**协议层（最大）**；带宽＝0 增量（复用已有心跳，但每条 173 B→加长后仍 <1200 B）；污染＝落库 peers 表但**不进 FTS**（FTS 只索引 messages，`migrations.ts:56-58`）；隐私＝**全子网可见（最差）**。置信高。

### 2.2 gossip（`gossipInterval`、`peerCacheProbeTtl`）

**机制证据**
- `PeerSummary = { nodeId, ip, udpPort, tcpPort, lastSeen }`、`PeersPayload = { peers }`：`src/shared/protocol.ts:229-241`；单包条目上限 `PEERS_PER_PACKET = 8`、fanout `GOSSIP_FANOUT = 2`：`protocol.ts:103,105`。
- 每 5 分钟向随机 2 个在线节点交换摘要（`discovery.ts:161-168`），分批发包间隔 50ms（`discovery.ts:196-215`）；「结识即交换」（`discovery.ts:88-92`）。
- **转述不入表**：收到 `peers` 只对「陌生且新鲜（< `gossipFreshness` 10 分钟）」的条目做 `entry` 单播验证：`src/main/net/discovery.ts:392-403`。

**结论：不能作为状态载体。** 摘要里没有可用字段；即使加字段，gossip 的语义是「地址散播 + 必须回证」，10 分钟新鲜度门槛 + 5 分钟周期 + 只扇出 2 个节点，使状态值既**慢**又**不可信**。改上游面积＝协议层 + codec（`codec.ts:366-388` 的 peers case）。带宽＝极低（但也没用）。置信高。

### 2.3 自定义群消息（codec 白名单）

**机制证据**
- `kind: 'group-text'` 的**键白名单**：只认 `kind/text/groupId/groupRev/mentions/resend/replyTo`，多一个键 → 整包 `bad-payload` 拒收：`src/main/net/codec.ts:184-187`。
- 对比：`kind: 'text'`（单聊）**没有键白名单**，只校验 `text` 非空且 ≤ `textLimit`：`src/main/net/codec.ts:172-174,189`。→ 单聊消息可携带任意额外键而**不改上游**（置信高；这是本次最有用的发现之一）。
- 文本长度上限：UDP 路径 `TEXT_UDP_LIMIT = 800`、TCP 路径 `TEXT_TCP_LIMIT = 4096`：`protocol.ts:13,15`；超 1200 B 自动走 TCP 控制帧：`src/main/net/messenger.ts:230-232`。
- 群发是**逐成员单播**：`for (const member of meta.members) ... sendUserMessage(member, env)`：`src/main/services/groups.ts:265-268`（群成员上限 `GROUP_MAX_MEMBERS = 200`，`protocol.ts:254`）。
- 可靠通道：ACK + 退避重传 `[1s,2s,4s]` 后转 TCP，仍失败则入补发队列并**立即把对端标离线**：`src/main/net/messenger.ts:82-94,238-262`；队列 7 天 / 单端 200 条：`protocol.ts:67-68`，prune 每小时：`src/main/index.ts:1382-1383`。
- 入站群消息**入库 + 进 FTS**：`src/main/services/groups.ts:341-351`（`msgRepo.insert`）→ `msg-repo.ts:109` → `migrations.ts:56-58`。

**能否承载高频：能，但代价最重且必须改上游。**
- 改上游面积：`codec.ts:184-187` **必改**；若要显示成状态而不是聊天气泡，还要改 `protocol.ts` `MsgPayload`、`src/shared/ipc.ts:301` 的 `MessageKind`、`MessageRow.vue` 渲染分支、`msg-repo` 落库语义。
- 带宽：每次状态更新 = **O(成员数) 包**（200 人组 = 200 包），且 UDP 令牌桶 30 包/秒/源 IP（`udp.ts:41`）会先把它掐住。
- 污染：每次状态更新落一行 `messages` + 一行 FTS → 全局搜索被 agent 状态刷屏、DB 无界增长；这正是 ticket 里说的「FTS/上下文污染」。
- 队列污染：对端离线时，每次状态更新占 1 条补发槽，用 ~200 次更新就能把真实消息挤出队列（`queueMaxPerPeer = 200`）。
- 结论：group-text **只适合低频事件**（例如「会话目标变更」一天几次），**不适合 10s 级负担值**。

### 2.4 文件传输（`file_ref`，真传文件）

**机制证据**
- `file_ref` 只是 `messages` 表的一个 JSON 列：`src/main/store/migrations.ts:49`；`FileCtlOffer.purpose` 是封闭枚举 `image|sticker|update|share-get|share-put`，未知值拒收：`src/main/net/codec.ts:293-302`。
- 领取窗口 24h：`FILE_OFFER_TTL`、`protocol.ts:361`；拉流空闲超时 60s：`PULL_IDLE_TIMEOUT`、`protocol.ts:359`。
- 传输需 offer/accept/direct + TCP 拉流（`messenger.ts` + `files.ts`）。

**结论：技术上能塞，工程上荒谬。** 每次状态更新要做一次 offer + 建 TCP + 落盘 + 在聊天里生成文件卡；改上游面积＝协议层 + `files.ts` + 渲染层 `FileCard.vue`。**降级形态都不值得**（唯一勉强成立的用法：agent 的「会话目标交接文档」这类低频、需要留痕的东西，正好走文件柜/文件通道）。置信高。

### 2.5 `caps` 能力位（`protocol.ts:157-177`）

**机制证据**
- `CAPS` 现有 10 位：`upd1,fd1,mrec1,tbl1,tw1,gr1,av1,shr1,rv1,rvs1`：`src/shared/protocol.ts:157-178`（另有发现层专用 `DISCOVERY_PROBE_CAP='dp1'`，`protocol.ts:44`）。
- 预算：`LIMITS.caps = 16`（最多 16 项）、`LIMITS.capItem = 16`（每项 ≤16 字符）：`protocol.ts:117-118`。→ **剩余 6 个空位**。
- 校验是**通用**的——只查「数组、长度、每项是 ≤16 字符串」，**不枚举合法值**：`src/main/net/codec.ts:108-109`；协议注释明说「入站未知位忽略」：`protocol.ts:156`。
- caps 随 Profile 走，只在 entry/alive/profile 传播；变更需落库 + `announceProfile()`：`src/main/index.ts:310-312`。

**结论：能承载「布尔能力位」，不能承载「值」；但这是唯一一个新功能零改上游 codec 的正规口子。**
- 用法：声明一个 `ag1`（=本节点跑 agent 且能收发状态报文）。对端通过**已有资料传播**学到「这台机器有 agent」，无需改上游。
- 不能承载 pct：caps 是字符串集合，不是键值通道；而且 16 位预算（已用 10）不支持「每位一个状态档」这种用法。
- 代价：caps 变更走 `profileRev+1` + 全量资料广播（同 §2.1 第 4 点），所以只适合**极低频**（开/关一个能力），不适合状态值。
- 附带事实：caps 会被持久化进 peers 表并参与功能门控：`src/main/services/porter.ts:292,381-397`、`src/main/services/*.ts` 多处 `caps.includes(...)`。

---

## 3. 横切代价对照

| 代价轴 | 事实 / 证据 | 对「高频状态」的含义 |
|---|---|---|
| 改上游面积 | 新私有信封类型：**0 文件**（`codec.test.ts:151`）· caps：**0 文件**（`codec.ts:108-109`）· 单聊 msg 加键：**0 文件**（`codec.ts:172-174,189`）· group-text 加键：`codec.ts` · presence/profile：`protocol.ts`+`codec.ts`+`discovery.ts` · 文件：`protocol.ts`+`codec.ts`+`files.ts`+渲染 | 选「新类型」或「caps / 单聊加键」可把 rebase 冲突面压到**接近零** |
| 带宽 | 单包 ≤1200 B（`protocol.ts:9`）；presence 173 B、alive 510 B（实测）；广播 = 每网卡一条 + 每在线节点一条（`discovery.ts:344-352`） | 300 B 状态包 @10s = ~30 B/s/对端，LAN 上可忽略；真正的瓶颈是**包数**不是字节 |
| 入站限速 | 30 包/秒、突发 60，按**源 IP**（`udp.ts:41`） | 同一台机器上跑多个 agent 节点（hive headless 方案）会**共享同一个令牌桶** → 多 agent 并发上报会互相挤掉 |
| FTS/上下文污染 | 只有 `messages` 进 FTS（`msg-repo.ts:109`、`migrations.ts:56-58`）；peer/profile/caps 不进 FTS | 只要**不落消息表**（新类型 / caps / 专用服务内存态），就**完全没有 FTS 污染** |
| 时序 offlineAfter 90s | `protocol.ts:49`；sweep 10s：`peer-registry.ts:117-121`；presence 30s：`protocol.ts:48` | 复用底座心跳 → 状态最陈旧 30s、判定「够不着」最长 90s；要更灵敏必须自建更快节拍与自建 TTL |
| queueMaxPerPeer 200 / TTL 7d | `protocol.ts:67-68`；离线即标灰：`messenger.ts:91-93` | 走**可靠通道**传高频状态会把真实消息挤出补发队列；走 **best-effort**（`messenger.ts:104-120`，不 ACK/不入队/不改在线态）则零占用 |
| 隐私边界 | presence/profile/caps 是**子网广播**（`discovery.ts:124,214-226`）；单播需先知道 nodeId（`discovery.ts:344-352`） | 状态进 profile/caps = 全网段可见；走 `ag1` 门控的单播 = 只对声明了能力的节点可见 |

---

## 4. 结论：能不能做 / 最小可行方案 / 降级形态

### 4.1 能不能做

**能。** 前提是：**不要**把状态塞进 presence/profile/caps 的值语义，也**不要**塞进群消息。teahouse 的 codec 对**未知信封类型天然放行**（只校验外层信封，payload 不校验），且发现层/消息层都按 `known` 过滤：`src/main/net/codec.ts:479-495`、`src/main/net/discovery.ts:81-84`、`src/main/net/messenger.ts:60-62`；由测试固定该行为：`src/main/net/codec.test.ts:151-157`（「未知类型：信封合法即接受，标记 known=false（向前兼容）」）。udp 层无条件把信封交给监听者：`src/main/net/udp.ts:131-134`。

### 4.2 最小可行方案（MVP，推荐）

1. **传输**：新增 hive 私有信封类型（如 `agent-status`），`v:1`，**best-effort 单播**给「声明了 `ag1` 且在线」的对端。语义镜像 `messenger.sendBestEffort`（`src/main/net/messenger.ts:104-120`）：不 ACK、不入队、不改在线状态、不改 dedup。
   - payload（建议 ≤300 B）：`{ rev, pct, sizeTokens, tag, goal?, ts }`（`tag` ∈ idle/easy/busy/overload/about-to-blow，对齐 `sprite-and-network-contract.md` A2）。
   - **因为 payload 不经过 codec 白名单，hive 必须自己做入站校验**（不可信输入）：数值范围、字符串长度、上限条数。
2. **能力协商**：caps 里声明 `ag1`（`src/shared/protocol.ts:157-178` 加一项，或干脆在 fork 内常量声明——`codec.ts:108-109` 不枚举合法值）。收到 `ag1` 才向该节点发状态，也才在 UI 上画状态环。剩余 6 位预算（`protocol.ts:117`）足够。
3. **节拍与衰减**：上报 10–30s（对齐 `presenceInterval 30s` 或更快）；hive 侧自建 TTL（如 2× 周期）决定「无数据 → idle 蓝」，**不复用** 90s 的 `offlineAfter`（`protocol.ts:49`）。
4. **展示**：`PeerList.vue:159` 的绿/灰点升级为五色环（与 sprite 契约 A1「头像右下角 5 色小圆点」一致），详细字段走 hover/卡片。
5. **接线位置**：hive 侧新 service（`src/main/services/agent-status.ts`）+ 装配处一行 `udp.on('envelope', ...)`（`src/main/index.ts:1173` 附近，与 `messenger.on('incoming')` `index.ts:1216` 并列）。**不改 `codec.ts` / `protocol.ts`。**

**代价**：改上游面积＝0（codec/protocol 不动）；带宽＝约 300 B × 在线对端数 / 周期（10 对端 @10s ≈ 0.3 KB/s）；FTS 污染＝0；补发队列占用＝0；隐私＝只对 `ag1` 节点可见（远优于 profile 广播）。

### 4.3 降级形态（按「不许动上游」的严格程度排序）

| 档 | 做法 | 看得见什么 | 代价 |
|---|---|---|---|
| **D0（零改动，正式）** | 只声明 caps `ag1`，状态走新私有类型（§4.2） | 五档负担 + 窗口 + 目标，全机可见 | fork 加 service + 装配一行 |
| **D1（零 codec 改动）** | 单聊 `msg(kind:'text')` 携带额外键发给每个对端 | 同上，但**会落库进 FTS 且显示成聊天气泡**；对端离线会占补发槽 | 需在入库前拦一道（groups/chat 侧拦截），否则污染聊天与搜索 |
| **D2（只允许加 caps）** | 只加 caps 位，不带值 | 「这台机器有 agent / 没有」二元；更新粒度＝资料刷新（秒~心跳级） | 每次开关都要 `profileRev+1` + 全量资料广播（`index.ts:310-312`） |
| **D3（允许改上游协议）** | 在 `MSG_TYPES` + codec 注册 `agent-status` 为已知类型，走 messenger 可靠通道 | 校验+类型化+可靠送达 | 改 `protocol.ts`+`codec.ts`；可靠通道带来 ACK/重传/补发队列污染（`messenger.ts:82-94`） |
| **D4（不建议）** | 塞进 `group-text` 或 presence/profile | —— | §2.1 / §2.3 的全部代价，且隐私最差 |

**明确不可行**：gossip 作为状态载体（§2.2）；文件传输作为高频状态载体（§2.4）。

### 4.4 给 #34 下一步决策的一句话

「跨机可见」不是 teahouse 的能力缺口，而是**协议留了未知类型的口子、caps 留了 6 个空位**；用这两个口子可以做到**零上游改动**的 MVP。真正需要 owner 拍板的只有两条：**(a) 状态是否只对声明 `ag1` 的节点可见（推荐）还是走子网广播（省事但泄露）**；**(b) 更新节拍取 30s（对齐既有心跳、最省）还是 5–10s（更「实时」，但要自建 TTL 且撞 30 包/秒的入站限速）**。

---

## 5. 未确认

- 「同一个位置看见**所有** agent」的聚合语义未在 ticket 里定义：是「本机 UI 列出本机所有 agent」，还是「列出全网段所有机器上的 agent」？本报告按后者（跨机）评估；若只是前者，`offlineAfter`/带宽问题基本消失。置信：低（需求歧义）。
- 未实测「新私有类型在 200 节点在线时对 udp 令牌桶的实际压力」。令牌桶按源 IP（`udp.ts:41`），hive 的 headless「每 agent 一节点」方案下同机多节点共享一个桶——**这是量级风险，未量化**。
- 未验证 `announceProfile()`（`discovery.ts:214-226`）在「在线节点数很多」时的实际单播条数与耗时；上限未在代码中看到。
- 未验证旧版 teahouse（`< 0.60.2`）对未知信封类型的处理是否也走同一条 `known=false` 路径——`codec.test.ts:151` 是当前 HEAD 的测试，未跑旧版本。
- 未实测单聊 `msg(kind:'text')` 携带额外键后，**渲染层**是否会显示异常（codec 放行、但 `groups.ts`/`chat.ts` 入库路径与 `MessageView` 映射未逐行核对）。置信：中。
- 未确认 caps 的 `LIMITS.caps = 16` 是否在别处还有更严的二次约束（如 DB 列长度、渲染层展示上限）。
- 未运行上游任何代码 / 未跑测试套件（遵守只读纪律）；所有结论均为静态阅读 + 一次纯 node 的字节数计算。

---

## 附：关键行号速查

| 事实 | 位置 |
|---|---|
| 未知类型放行（向前兼容） | `src/main/net/codec.ts:479-495`；测试 `src/main/net/codec.test.ts:151-157` |
| group-text 键白名单（必改上游） | `src/main/net/codec.ts:184-187` |
| 单聊 text 无键白名单 | `src/main/net/codec.ts:172-174,189` |
| caps 通用校验（新位零改动） | `src/main/net/codec.ts:108-109`；`src/shared/protocol.ts:117-118,156-178` |
| presence 载荷（无空位） | `src/shared/protocol.ts:221-225`；发送 `src/main/net/discovery.ts:344-352` |
| Profile 固定字段 | `src/shared/protocol.ts:135-155`；校验 `src/main/net/codec.ts:83-110` |
| profileRev 失配触发全量握手 | `src/main/net/discovery.ts:362-364,372-375`；`docs/protocol.md:115` |
| 上游否决 alive 搭车 | `docs/protocol.md:514` |
| gossip 摘要 + 转述不入表 | `src/shared/protocol.ts:229-241`；`src/main/net/discovery.ts:392-403` |
| 群发逐成员单播 | `src/main/services/groups.ts:265-268`；上限 `src/shared/protocol.ts:254` |
| 可靠通道 ACK/重传/补发 | `src/main/net/messenger.ts:82-94,238-262`；队列上限 `src/shared/protocol.ts:67-68` |
| best-effort 单发（MVP 语义） | `src/main/net/messenger.ts:104-120` |
| 消息落库 + FTS | `src/main/services/groups.ts:341-351`；`src/main/store/msg-repo.ts:109`；`src/main/store/migrations.ts:56-58` |
| 入站限速 30/s/源 IP | `src/main/net/udp.ts:41,104-113` |
| 单包 1200 / 入站 4096 | `src/shared/protocol.ts:9,11`；出站丢弃 `src/main/net/udp.ts:71-74` |
| presence 30s / offline 90s | `src/shared/protocol.ts:48-50`；sweep `src/main/net/peer-registry.ts:117-121` |
| 广播目标 = 全网卡子网 + 受限广播 | `src/main/net/udp.ts:139-156` |
| 联系人 UI 只有绿/灰点 | `src/renderer/src/components/PeerList.vue:159`；`src/renderer/src/ui/contact-presence.test.ts:7-16` |
| 装配接线点 | `src/main/index.ts:1173`（`new UdpChannel`）、`1216`（`messenger.on('incoming')`） |
| hive 需求（五档阈值/窗口/离线不占档） | `docs/handoff/sprite-and-network-contract.md` A2 表、B 表 |
| hive 侧底座地雷（单实例锁/限速/队列） | `docs/research/teahouse-landmines.md` 卡 2/6/7/10 |
