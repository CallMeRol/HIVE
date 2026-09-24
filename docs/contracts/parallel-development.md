# 并行开发契约（Batch Contract）

> 父 SPEC：[#41 构建可交付的 Hive BYOA 群聊 MVP](https://github.com/toRolex/hive/issues/41) · 本票：[#42](https://github.com/toRolex/hive/issues/42)
> 地位：**批内冻结契约**。#41 拆出的全部 ticket（#43–#63）在开工前必须遵守本文；与本文冲突的旧文档口径一律以本文登记表为准。
> 权威层级：术语 = 仓库根 `CONTEXT.md`；产品行为 = `docs/PRD.md` + Spec #41；工程边界 = `docs/adr/`；**批内并行协作面 = 本文**。
> 机器检查：`./scripts/check-authoritative-specs.sh`（断言 AC1–AC4 可查项，非零即失败）。

## 完成定义（两种 Complete 分开）

### Mac Product Complete（#62，本轮唯一交付目标）

**定义**：一台干净 Mac 上，从 Finder 首次启动即可完成「建群 → 接入 Claude Code/Codex 真 turn → pending 确认 → 目标冻结 → 单次越界立即派遣 → 输入/输出交接 → 回收硬删除 → 重启恢复 → 机库查询」全链路的 Hive.app，外加全部留在本 Mac 的可复验开发构件。

- 验收票 = **#62**（黑盒发布验收，不首次补实现；缺失退回实现票）。
- 必含：内嵌 runner、ACP SDK、Claude/Codex adapters、fake peer、视觉资源、Markdown 依赖；ad-hoc 签名与 LaunchServices/quarantine/无残留验证报告；三个故障剧本（runner 猝死、守卫不可用、交接损坏）通过。
- 平台范围 = **仅 macOS**；Windows 与三机发布门统一延期至 #63。

### Original MVP Complete（#63，延期，非本轮）

**定义**：Spec #41 与原始 PRD 的完整完成态——Windows 构建与离线 runtime/adapter 包、1 台 Mac + 2 台 Windows 冷启动互见与真 turn、跨机状态过期、网络降级阶梯与现场 playbook、三方涌现六轴对照，且交付完整度满足预注册胜负判据。

- 验收票 = **#63**（blocked by #62；Status: Deferred — not ready for the current Mac-only AFK run）。
- 只有 #63 的全部原始发布门通过后，才可声明 Original MVP Complete。

### 本轮边界（冻结）

**本轮仅交付 Mac Product Complete。** 任何 ticket 不得以「三机/Windows/涌现门未做」为由阻塞本轮交付，也不得把 #62 的通过表述为 Original MVP Complete；反向地，#62 通过前 Spec #41 不得整体宣称完成。

## 共享事件

local-api SSE 是唯一最高层主 seam 的观察面（Spec #41 Testing Decisions）。以下事件 `type` **批内冻结**：实现者可以增字段，不得改名、复用语义或另起私有通道绕过。信封统一为 `{ v, seq, type, ts, data }`：`seq` 单调递增作顺序字段；错误一律走信封 `type: "error"` + 统一错误结构 `{ code, message, details? }`，无效输入显式报错、不静默忽略。

| type | 触发面 | data 关键字段（可增不可改名） | 生产者 ticket |
|---|---|---|---|
| `message.new` | 群消息到达（正式消息 + 系统事件） | `messageId, groupId, senderId, kind(formal\|system), text, replyTo?` | #44 / #46 |
| `acp.update` | runner/adapter 过程更新（不进群） | `memberId, sessionId, sessionUpdate, turnSeq` | #46 / #49 |
| `guard.verdict` | 目标守卫判定结果 | `sessionId, verdict(in_scope\|out_of_scope\|undetermined), confidence, reason, inputHash, dispatchDraft?` | #55 |
| `member.lifecycle` | 成员生命周期 | `memberId, phase(join\|spawn_ok\|leave\|reclaim\|abnormal\|orphan_removed\|archive), depth?`；`leave` = 常驻成员移出，`reclaim` = 派遣成员正常回收 | #51 / #53 / #54 / #59 |
| `pending.updated` | pending 收集期变化 | `memberId, goal, entries[], waitingConfirm, confirmedBy?` | #50 |
| `dispatch.event` | 派遣发生/结算 | `dispatcherId, memberIds[], goalOneLine, depth, outcome(started\|settled\|failed\|claimable)` | #51 / #56 / #59 |
| `burden.updated` | 上下文负担档位 | `memberId, pct, tag(idle\|easy\|busy\|overload\|about-to-blow), ts, stale` | #47 / #49 |
| `error` | 任何面的显式失败 | `code, message, details?` | 各生产者 |

跨机 `agent-status` 私有信封（10s 节拍 / 30s TTL / `ag1` 门控）走 UDP 而非本 SSE，参数以 ADR-0009 与 sprite 契约 A2 为准，本文不复读。群内可见文本由正式消息与系统事件组成（ADR-0008）；process（thought/tool/plan/usage）只落本机账本，不进 `message.new`。

## 状态所有者

每个可变状态恰有一个写者（single writer）；其他模块只读或发命令，不得就地改写。批内冻结如下：

| 状态 | 唯一所有者 | 持久化位置 | 读者 |
|---|---|---|---|
| 群 / 身份 / 成员表 / 消息（底座模型） | vendored teahouse store（上游 schema，白名单外零改动） | teahouse userData SQLite | Hive 模块只通过 teahouse 既有 API 读写；#51 可 invite，#53/#54 可按权限 remove/leave |
| pending 草稿与逐人授权 | pending/权限模块（#50） | Hive 侧 store，独立表 | GUI 药丸、bridge |
| 会话目标（未定/已冻结） | 目标模块（#50 写入、冻结；#55 只读判定） | 同上 | 守卫、交接头部、成员卡 |
| 守卫判定账本 | 守卫模块（#55） | 本机会话账本（append-only） | 机库、审计投屏 |
| 派遣关系 / slot / 深度 / 并发计数 | 派遣模块（#51 创建、#56 递归、#54 回收释放） | Hive 侧 store | 网络图、仪表盘 |
| 待领取任务（claimable） | task/lifecycle 模块（#59） | Hive 侧 store；#51 的 spawn 失败和 #59 的异常退出只发状态转换命令 | GUI、@主人、人工补派 |
| 机库 JSONL / Markdown 时间线与归档索引 | 机库模块（#52，append-only，无 TTL） | artifacts root 下 per-member 目录 | 机库页、重启恢复（#58） |
| 交接文档与产物三件套 | 派遣链（#54 写、#60 校验） | 派遣者机器 `<artifactsRoot>/handoffs/` | 接手成员、复验 |
| 成员主人登记（`memberId → ownerId`）+ 移出拒绝留痕 | 成员管理（#53 读；#49 接入、#51 派遣写） | `<userData>/members.json`（`schemaVersion`）+ `hive/member-audit.jsonl` | 判权、GUI 拒绝原因 |
| 跨机 agent-status 缓存 | 状态通道（#47） | 内存，TTL 30s | 成员行、网络图 |
| 模型探测/锁定 | Agent 接入（#49） | 启动探测 → 仪表盘 override → 配置兜底三层 | runner |
| vendored 上游记账与补丁白名单 | vendor 守卫（#43） | `vendor/.hive/provenance.json` + `baseline.sha256` + `patch-allowlist.txt` + `scripts/check-vendor-patches.mjs` | pre-push / CI |

权限判断独立于目标守卫、始终 fail-closed 并记录拒绝原因（Spec #41）；守卫自身 fail-open 不得放宽上表任何写权限。

## 迁移规则

批内所有 Hive 侧持久化结构携带 `schemaVersion`（整数，起 1），迁移规则冻结为：

1. **只增不改**：同 `schemaVersion` 内只允许新增可选字段；改名、删字段、改语义必须 bump `schemaVersion` 并提供纯函数迁移 `migrate(old) → new`。
2. **单一入口**：重启恢复与迁移统一由持久化模块（#58）按所有者表调用各 owner 注册的 `migrate`；其他 ticket 不得自开恢复路径、不得在业务代码里散落兼容分支。
3. **恢复不造假**：迁移/恢复不得重复派遣、伪造成功或遗留孤儿进程；执行阶段中断的任务显式转待领取（#58/#59）。
4. **teahouse 底座不迁移**：上游 store schema 零改动（ADR-0003 白名单纪律）；Hive 状态存自己的表/文件，不得把字段塞进上游 schema 绕过补丁面。
5. **事件不迁移**：SSE `type` 批内不版本化——只能新增 type，不能改语义；确需换语义 = 新 type + 旧 type 停产，并更新本文表格。
6. **append-only 格式可演进**：JSONL 每行携带所属 owner 管理的版本；读取兼容和纯函数迁移集中在 owner 模块，不原地改写历史文件。
7. **迁移可测**：每个 `migrate` 是纯函数，具备旧样本 → 新结构的单测（Spec #41：守卫/交接/状态校验保持纯函数边界，同理适用）。

## 模块所有权

批内（#43–#63）按模块划分写权限，跨模块改动 = 先改本文再动手；同一模块同一时间只有一张活跃 ticket 持写头。

| 模块 / 路径面 | Owner | 覆盖 ticket | 禁止他人做的事 |
|---|---|---|---|
| `vendor/teahouse/` 上游树 + `vendor/.hive/` 账本 + `scripts/check-vendor-patches.mjs` | vendor 守卫 | #43 | 白名单外改上游文件；目录级放宽 |
| 真 headless 补丁（`index.ts` hunk）+ `local-api/` 骨架 + env 契约 + smoke | 底座运行时 | #44（#43 仅预留 `index.ts` 白名单，不实现 headless/local-api/smoke） | 擅自加第二套退出通道 |
| 群 / 多群 GUI 与底座存储消费 | 产品主干 | #44 #45 | 自建群协议表 |
| ACP runner + fake peer + Agent bridge + 正式消息链（含 markdown-it/DOMPurify 渲染面） | Agent 链路 | #46 | 手写 JSON-RPC；改 MessageRow 白名单文件不记账 |
| 跨机/本机状态通道与五档显示 | 成员状态 | #47 | 复用 presence 90s 当负担 TTL |
| 声明式配置 + up/status/doctor/down 脚本 | 本地运维 | #48 | 在业务模块内复制健康检查逻辑 |
| GUI 接入 Claude Code/Codex + 模型三层锁定 | Agent 接入 | #49 | 凭据出本机；绕过探测直接锁模型 |
| pending 收集期 + 确认键 + 逐人放权 + 会话目标冻结 | 核心机制 | #50 | 让 pending 自动过期；权限 fail-open |
| 派遣 spawn/invite/slot + 递归 1:N 无 barrier + 网络图事件源 | 派遣 | #51 #56 | barrier 汇聚；把已有成员「再派」 |
| 机库窗口 + JSONL/MD 追加 + clear 归档 | 机库 | #52 | 自动清理过程；改写历史 JSONL |
| 移出 + 孤儿清理 + 权限拒绝留痕 | 成员管理 | #53 | 非主人路径放行 |
| 交接文档七节校验 + 回收硬删除 + fail-closed 接手 | 交接与回收 | #54 #60 | 缺失/sha256 不匹配仍开工 |
| 目标守卫 LLM judge + 故障注入 + 判定账本 | 目标守卫 | #55 | 输入塞会话历史；越界要求连续两次 |
| 成员表 + 星系派遣网络图渲染 | 可视化 | #57 | 幽灵节点/历史图/折叠隐藏 |
| 持久化 `schemaVersion` + 迁移/恢复唯一入口 | 持久化 | #58 | 业务代码散落恢复分支 |
| runner 猝死 5s 异常退群 + 待领取 + 补派默认人工 | 容错 | #59 | 自动补派默认开 |
| packaged APP 三故障恢复门 | 容错（打包） | #61 | 静默吞失败 |
| 发布验收（黑盒） | 发布门 | #62 #63 | 在验收票里首次补实现 |

**并行规则**：同表不同行可并行；跨行协作（如 #57 读 #51 事件、#58 迁移 #50 表）只依赖本文冻结的事件 `type` 与所有者表，不依赖对方内部实现。Spec #41 的八阶段顺序仍然有效：前一阶段门未过后一阶段 ticket 不得视为可完成。

## 复用与禁止

### 必须复用（给定件，不得替换）

| 给定件 | 用途 | 依据 |
|---|---|---|
| **teahouse** v0.60.2（snapshot vendor 至 `vendor/teahouse/`） | 群协议、身份系统、成员表、消息存储、presence、离线补发——整个 IM 底座 | ADR-0001 / ADR-0003 / #43 |
| **官方 `@agentclientprotocol/sdk`** | ACP JSON-RPC client，跑在 Node ≥22 runner 子进程 | ADR-0004 / #25 |
| **Claude Code adapter**（`claude-agent-acp`） | 第一版必做 ACP adapter，真实多轮 turn | ADR-0004 / #49 |
| **Codex adapter**（`codex-acp`） | 第一版必做 ACP adapter，真实多轮 turn | ADR-0004 / #49 |
| **markdown-it** | 消息 Markdown 解析（`html:false` + linkify） | ADR-0003 白名单首破 #35 / #46 |
| **DOMPurify** | Markdown 渲染 DOM 清洗（双层 XSS 防护，异常回退纯文本） | ADR-0003 #35 / #46 |
| **Vue Flow `@vue-flow/core`** | Vue 3 派遣网络图的通用节点/边、缩放、平移、选择与自定义节点能力；Hive 只实现星系语义布局与业务投影。缩放时须保持精灵清晰度约束 | Vue Flow 官方文档；替代历史 research 的 React-only 推荐 |

### 禁止重复实现

以下能力**已有给定件，禁止重复实现**（发现第二套实现 = 契约违规，评审应打回）：

- **群协议**——不得绕开 teahouse 另写消息传输/同步/加密；Hive 只加「agent 作为成员」胶水层。
- **身份系统**——不得自建账号、密钥或成员身份模型；身份 = teahouse 身份 + 每成员独立 nodeId/userData。
- **ACP client**——不得手写 NDJSON/JSON-RPC 客户端；一律官方 `@agentclientprotocol/sdk`（#14 手写口径已作废）。
- **Markdown parser**——不得自写解析器或用正则拼凑；一律 markdown-it + DOMPurify。
- **通用图引擎**——不得自研节点/边、缩放、平移、选择等通用能力；统一复用 Vue Flow `@vue-flow/core`。Hive 只实现星系布局、活跃挂靠和事件到节点/边的业务投影。

边界说明：fake ACP peer、目标守卫、交接校验、跨机状态校验、派遣编排属「必须自研的 Hive 业务层」（#8 裁决的自研点 + Spec #41 范围），不在禁止之列；它们必须建在上表给定件之上，而非替代给定件。

## 旧口径登记表

被本文与 Spec #41 替代的旧口径清单。历史 research、旧 prototype、已关闭 ticket 中出现这些词 = **证据，不是实现规格**；实现与文案一律用「现口径」。权威文档正文已同步修正（本表是索引与兜底）。

| 旧口径（作废） | 现口径 | 出处与替代依据 |
|---|---|---|
| **连续两次越界**才触发派遣 | **单次越界立即派遣**，不要求连续两次 | CONTEXT.md「越界」、RULES.md §7 已改；Spec #41「单次越界请求立即触发派遣」 |
| **回收遗迹**（置灰 + 虚线环 + 退群 HH:MM + 冻帧）+ 历史网络图 | 回收 = 成员表与网络图**硬删除直接消失**；历史只在群消息流 | sprite 契约术语表已改；#24/#28 推翻 #17 遗迹规格，ADR-0007 |
| **塔奇克马精灵作为头像**（消息流/成员表播放精灵、64px 精灵槽） | 名字头像 + 右下角五档状态点；精灵只用于派遣网络图 / 仪表盘 / 机库卡片 | PRD A1/A4、sprite 契约修订表已改；Spec #41「不在头像位播放塔奇克马精灵」 |
| **JSON envelope**（交接用 JSON schema/信封） | 交接 = Markdown 头部元数据 + 7 个 H2 节 | RULES.md「不是 JSON schema（原三张已砍，不复活）」；#15/#16 |
| **任务信封** / **交接工件** / 引用卡片 | **交接文档** + 产物本身；群内只发派遣事件 | windows-verification 头、emergence-ab 已改；#3 口径修订、#16、CONTEXT _Avoid_ |
| **手写 NDJSON** JSON-RPC（不引 SDK 进 app） | 官方 `@agentclientprotocol/sdk` + Node ≥22 runner 子进程 | ADR-0004 明确作废 #14 该句；#25 |
| `@xyflow/react` / 手写 SVG 作为派遣网络图底座 | Vue 3 renderer 复用 Vue Flow `@vue-flow/core`；只自研 Hive 星系语义布局 | 历史 research S6 / prototype；#42 |
| 能力卡 / 预设人设 / 按能力路由 | 角色由会话目标派生，随目标来去 | CONTEXT「角色」_Avoid_；#16、rubric-audit |
| 过程折叠条进群 / 终版消息进群可见折叠 | 群内只有正式消息；过程落本机机库 | ADR-0008 修订 #25 前提；CONTEXT「正式消息」_Avoid_ |
| 按 presence 90s 表达 agent 负担过期 | agent-status 独立 10s 节拍 / 30s TTL | ADR-0009 明确不复用 `offlineAfter`；#38 |
| headless = `show:false` 隐藏窗降级 | 真 headless（`PANTRY_HEADLESS=1` 不建窗） | ADR-0002 Decision 2 否决 |
| GitHub fork 工作流 | snapshot vendor 至 `vendor/teahouse/`，不开 fork | ADR-0003 否决 GitHub fork |
| pending 超时/自动过期 | pending 永不自动过期，出口仅确认或丢弃 | Spec #41 / #30 |
| 机器级硬成员上限 | 无硬上限；资源不足显式报告派遣失败 | Spec #41 摇人制章节 |
| 攻壳机动队作为产品叙事主轴 | 演示素材可用赛博朋克城市题材，叙事不用攻壳 | Spec #41 Out of Scope |

## 变更规则

本文批内冻结。确需变更：在对应 ticket 内提出 → 更新本文表格/章节 → 同步跑 `./scripts/check-authoritative-specs.sh` → 在 ticket 评论记录变更点。单方面引入与本文冲突的事件、状态写者或复用替换 = 违反并行契约。
