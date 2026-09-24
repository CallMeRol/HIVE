# buzz：agent 接入与状态面（hive #34 · prong 1）

> 调研对象：`block/buzz` 上游仓库副本 `/tmp/buzz-recon`（HEAD `77729ab`，2026-09-21）。
> 只读，未修改上游。所有结论带 `文件:行` 证据 + 置信度（高/中/低）。
> 路径均相对 `/tmp/buzz-recon`；hive 侧路径会显式标注。状态：**完成**。

## 速览表

| # | 问题 | 一句话答案 | 关键证据 | 置信度 |
|---|------|-----------|----------|--------|
| Q1 | 接入链路各层职责 | 人只操作桌面端；桌面端管身份（keyring nsec）+配置+启停；relay 是唯一事实源（认证/存储/门控/fan-out）；`buzz-acp` 管会话与子进程池、发 presence/lifecycle/metric；agent 子进程只经 ACP stdio 干活、不落库 | `ARCHITECTURE.md:7-11`、`docs/remote-agents.md:74-112`、`ARCHITECTURE.md:672-704` | 高 |
| Q2 | agent 状态产生/存储/可见性/UI | 在线档=kind:20001 presence（harness/桌面端产生，relay Redis TTL 180s，社区级可见，online/away/offline 三档）；忙闲=24200 observer 派生；生命周期=24200 lifecycle 帧→桌面端**内存** runtime 表+状态事件；**上下文占用/成本不上行、零 UI**。UI 位置=频道成员侧栏行 + 托管 agent 行 + 资料面板 Status 字段 | `crates/buzz-pubsub/src/presence.rs:3,16`、`crates/buzz-acp/src/lib.rs:2743`、`crates/buzz-relay/src/api/bridge.rs:2270`、`crates/buzz-acp/src/usage.rs:80,85`、`desktop/src/features/channels/ui/MembersSidebarMemberCard.tsx:174,224` | 高 |
| Q3 | 实时 transcript 视图 | 有：NIP-AO kind:24200（relay-ephemeral、逐帧流式）→ AppShell 全局摄取解密 → `ManagedAgentSessionPanel`「Live ACP session」转写 + `RawEventRail` 原始帧栏；实时窗上限 3000 帧（低水位 2700） | `desktop/src/app/AppShell.tsx:200-210`、`desktop/src/features/agents/ui/ManagedAgentSessionPanel.tsx:189,252`、`observerTranscriptRetention.test.mjs:34-35` | 高 |
| Q4 | 归档/历史视图 | 有：桌面本地 SQLite archive（`archived_events` + `observer_channel_index` + `agent_metric_index`），24200/44200 以 `owner_p` 落本地；历史=同一面板滚动加载归档页（200 帧/页，首屏 10 页）；入口=设置页 `LocalArchiveSettingsCard` 开关 + 会话面板向上翻页 | `desktop/src-tauri/src/archive/store.rs:21-76`、`desktop/src/features/agents/ui/useObserverEvents.ts:95-119`、`desktop/src/features/settings/ui/SettingsPanels.tsx:856` | 高 |
| Q5 | 远程 agent 状态回传 | 规格（draft）明确 M1「无管理通道」：部署后**全部**观测走 relay——状态=relay presence（kind:20001，错窗 ≤180s）、停机=relay `!shutdown`、无 substrate 状态查询/exec/日志拉取；24200 观测帧本可经 relay 回传（HEAD 的 deploy payload 已注入 `BUZZ_ACP_RELAY_OBSERVER=true`），但 lifecycle 徽标依赖本地 tracked runtime，远程进程没有 | `docs/remote-agents.md:96-104,198-218`、`desktop/src-tauri/src/commands/agents_deploy.rs:76`、`desktop/src-tauri/src/managed_agents/runtime_commands.rs:127-130` | 高（M1/I3）/ 中（远程 UI 细节） |

---

## Q1 接入链路各层职责

| 层 | 身份 | 唤醒/启停 | 会话 | 上下文 |
|---|------|----------|------|--------|
| **人** | 不直接持有密钥；经桌面端操作 | 在 UI 点 Start/Stop/Restart | 只发消息/mention | 无感知 |
| **桌面端 (D)** | nsec 存 OS keyring，agent record 含 NIP-OA `auth` tag、命令、模型等 | `start/stop/restart_managed_agent_runtime`（本地 spawn）或 `deploy`（provider）；唤醒即 harness 被 mention/启动 | 只做 UI 与记录，不跑会话 | 配置 `system_prompt`/`model`/`provider` 并注入 harness env；自身不读上下文占用 |
| **relay (R)** | NIP-42 挑战/认证；「single source of truth」 | 无（不启动 agent） | 事件持久化 + fan-out + 结果门控 | 无 |
| **buzz-acp harness** | 以 env 持 keypair + auth tag + relay URL 连 WS | 订阅就绪后发 presence online；60s presence 心跳；接收 `!shutdown`/mention 唤醒 | 每频道队列、单 prompt in-flight、ACP `session/prompt` 驱动子进程池（1–32） | 不持久化任何状态；上报 44200 指标但 `used/contextLimit` 是死字段 |
| **agent 子进程** | 无（继承 harness 会话） | 崩溃由 harness 检测并重启 | goose/codex/claude-agent-acp 等，经 ACP stdio | 经 ACP `usage_update` 上报 token（可选字段） |

证据：

1. **Claim:** relay 是唯一事实源：所有读写经 relay，其负责 auth、签名验证、持久化、fan-out、搜索索引。**Sources:** `ARCHITECTURE.md:7-11`（"The relay is the single source of truth…"）。**Support:** direct。**Confidence:** 高。
2. **Claim:** 五主体模型——桌面端 D（持 nsec/keyring、配置记录、唯一 UI、可信）、provider P（`buzz-backend-<id>` 可执行文件，一次性进程，输出视为敌意）、substrate S（对 D 不透明）、agent A（S 上的 `buzz-acp` harness + 其下 ACP agent）、relay R（连接 D 与存活 A 的**唯一**通道）。**Sources:** `docs/remote-agents.md:69-105`（System Model）。**Support:** direct。**Confidence:** 高。
3. **Claim:** agent 身份 = Nostr 密钥对；agent record 携带 name/relay_url/nsec（keyring 水合）/NIP-OA auth tag/`agent_command`+`agent_args`/`system_prompt`/`model`/`provider`/超时与并行/`respond_to` 门/env/`backend` 判别（Local 或 Provider）。任何设置该 env 并 exec harness 的东西（bash/systemd/CI/provider）都是合规 launcher。**Sources:** `docs/remote-agents.md:107-112,115-149`。**Support:** direct。**Confidence:** 高。
4. **Claim:** `buzz-acp` 职责：经 WS+NIP-42 连 relay、REST 发现频道、队列 @mention、spawn 1–32 个 agent 子进程（默认 1）、每频道单 prompt in-flight、批量合并为一次 `session/prompt`；关键模块 relay.rs/queue.rs/main.rs/pool.rs/acp.rs；**明确「Does NOT: persist state」**。**Sources:** `ARCHITECTURE.md:672-704`。**Support:** direct。**Confidence:** 高。
5. **Claim:** 桌面端身份水合走 keyring（`agent_keyring_name, hydrate_keys_with`），且 spawn/deploy 均有「空密钥拒绝」（I1 identity fail-closed：`build_deploy_payload` 在 nsec 为空时拒绝，镜像本地 `spawn_key_refusal`）。**Sources:** `desktop/src-tauri/src/managed_agents/storage_tests.rs:15-20`、`docs/remote-agents.md:168-176`（I1）。**Support:** direct。**Confidence:** 高。
6. **Claim:** harness 上线次序：订阅频道就绪后才发 presence online——「Online means the harness can receive work, not merely that its socket is connected」，给桌面端一个可依赖的就绪边界。**Sources:** `crates/buzz-acp/src/lib.rs:2739-2747`。**Support:** direct。**Confidence:** 高。
7. **Claim:** 子进程层的上下文信息：ACP `usage_update` 的 `used`（context-usage proxy）与 `contextLimit` 均为 Optional 且注释明说「buzz-agent omits … does not track a context window limit」。**Sources:** `crates/buzz-acp/src/usage.rs:74-86`。**Support:** direct。**Confidence:** 高。

## Q2 agent 状态：产生 / 存储 / 可见性 / UI

### 2a. 在线档（presence）

1. **Claim:** 产生：harness 订阅就绪发 `kind:20001` online（`publish_presence`，lib.rs:2743-2746），此后 **60s 心跳**（`Duration::from_secs(60)`，lib.rs:2821-2822）；桌面端自己也签发 20001（`desktop/src/shared/api/relayClientSession.ts:284`）。20001 走 WS（HTTP bridge 拒收 ephemeral kinds）。**Sources:** `crates/buzz-acp/src/lib.rs:88-95,2743-2746,2821-2822`、`desktop/src/shared/api/relayClientSession.ts:284`。**Support:** direct。**Confidence:** 高。
2. **Claim:** 存储：relay Redis——`SET buzz:{community}:presence:{pubkey} "online" EX 180`，`PRESENCE_TTL_SECS = 180`（=3×60s 心跳，避免单次丢心跳闪断；clean disconnect 立即 DEL）。**不落 Postgres。** **Sources:** `crates/buzz-pubsub/src/presence.rs:1-16,36-43,47-56`。**Support:** direct。**Confidence:** 高。
3. **Claim:** 查询面：HTTP 桥对全为 20001/40902 + authors 的过滤器**从 Redis 合成快照**（ephemeral 事件从不入库；40902 快照由 relay 按需生成、relay 自签，content=status、p-tag=subject）。**Sources:** `crates/buzz-relay/src/api/bridge.rs:2270-2340`。**Support:** direct。**Confidence:** 高。
4. **Claim:** 档位只有 **online/away/offline** 三档（REST/MCP 结构化面用该枚举；WS 20001 content 为向前兼容可任意字符串，但桌面端解析只认这三值，其余返回 null）。**Sources:** `crates/buzz-core/src/presence.rs:7-31`、`desktop/src/features/presence/lib/presence.ts:3-16`。**Support:** direct。**Confidence:** 高。
5. **Claim:** 可见性=**社区级**：任何已认证成员可带 authors 过滤任意查询 presence（bridge 合成不校验请求者是否为 subject），live 20001 经全局 pubsub fan-out（`global_presence_pubsub_event_fans_out_to_local_subscribers` 测试）。客户端信任规则：live 20001 只信 event.pubkey（自签），p-tag 不可信；relay 签名的 REST/seed 路径才可信 p-tag subject。**Sources:** `crates/buzz-relay/src/api/bridge.rs:2274-2340`、`crates/buzz-relay/src/handlers/event.rs:1905-1946`、`desktop/src/features/presence/lib/presence.ts:1-6`。**Support:** direct。**Confidence:** 高。
6. **Claim:** 桌面端消费链：`usePresence` query（REST `getPresence`，`desktop/src/shared/api/tauri.ts:324`）+ **焦点回退轮询**（`refetchInterval`，注释：catches REST-only writers and TTL expiry，`hooks.ts:104-115`）+ 单一 live 订阅 reconcile（`usePresenceSubscription`，`hooks.ts:109-160`，query cache 变化 100ms debounce 重挂作者集）。桌面端镜像 relay 常量：`PRESENCE_HEARTBEAT_INTERVAL_MS = 60_000`、`PRESENCE_TTL_SECONDS = 180`。**Sources:** `desktop/src/features/presence/hooks.ts:104-160`、`desktop/src/features/presence/lib/presence.ts:50-53`。**Support:** direct。**Confidence:** 高。

### 2b. 忙闲 / 当前会话

1. **Claim:** 「Working/忙闲」由 **kind:24200 observer 派生**：`agentWorkingSignal.ts` 注释明说「Observer-derived active turns (kind:24200 → activeAgentTurnsStore)」。**Sources:** `desktop/src/features/agents/agentWorkingSignal.ts:19`。**Support:** direct。**Confidence:** 高。
2. **Claim:** 「当前会话」= observerRelayStore 按 (agent, channel) 记录 latest-live-session-id（带 sessionId+channelId 的帧，按 timestamp→seq 单调推进）。**Sources:** `desktop/src/features/agents/observerRelayStore.ts:495-512`。**Support:** direct。**Confidence:** 高。
3. **Claim:** 生命周期状态产生：harness `emit_runtime_lifecycle` 发 `managed_agent_runtime_lifecycle` 帧（starting/listening/waking/ready/stopped/failed+error），调用点覆盖 lazy-pool listening（:2751）、waking（:2994,2999）、其余转换（:3176,3635,3970,3990）。**Sources:** `crates/buzz-acp/src/lib.rs:112-122,2751,2994,3176,3635,3970,3990`。**Support:** direct。**Confidence:** 高。
4. **Claim:** 生命周期存储：桌面端 observerRelayStore 解析该帧 kind 后调 `putManagedAgentRuntimeLifecycle`（`observerRelayStore.ts:529-534`）→ Tauri 命令校验（签名者=pubkey、observer 不得author starting/stopped、failed 必带 error、start_nonce 匹配当前代、进程未退出，`runtime_commands.rs:85-141`）→ 写入**内存** `managed_agent_processes` map 并 `emit_status`（STATUS_EVENT）广播 UI。**修正**：上游 HEAD 无 `managed_agent_runtime` SQLite 表（archive 建表清单仅 archived_events/archived_event_scopes/save_subscriptions/observer_channel_index/agent_metric_index/archive_migrations，`store.rs:21-76`）。**Sources:** `desktop/src/shared/api/tauriManagedAgents.ts:102-107`、`desktop/src-tauri/src/managed_agents/runtime_commands.rs:75-141`、`desktop/src-tauri/src/archive/store.rs:21-76`。**Support:** direct。**Confidence:** 高。
5. **Claim:** 状态行结构 `ManagedAgentRuntimeStatus = {pubkey, requestedRelayUrl?, relayUrl, localSetup, lifecycle, pid, error, logPath}`（types.ts:289-300），由 `status_for_with` 组装：localSetup=agent_readiness 判定、lifecycle 默认 Stopped、pid=子进程 id、logPath=runtime 日志路径。**Sources:** `desktop/src/shared/api/types.ts:289-300`、`desktop/src-tauri/src/managed_agents/runtime_commands.rs:50-74`。**Support:** direct。**Confidence:** 高。
6. **Claim:** lifecycle→人类可读可用性映射：`agentCommunityAvailability` = `Here`（ready）/`Waking`（starting/listening/waking）/`Needs setup on this device`（!localSetup）/`Unavailable`（failed/stopped）；detail 行给出 "Stopped by you" / error 原文。**Sources:** `desktop/src/features/agents/managedAgentRuntimeStatus.ts:4-33`。**Support:** direct。**Confidence:** 高。

### 2c. 上下文占用 / token / 成本

1. **Claim:** 出量档=**NIP-AM kind:44200** agent turn metric：每完成一个 turn 发一条，NIP-44 加密落库（relay 侧 44200 校验：global-only、需 MessagesWrite scope、不可搜索），payload 含 used/contextLimit/accumulated/cost 类字段。**Sources:** `crates/buzz-core/src/agent_turn_metric.rs:1-12,106,200`、`crates/buzz-core/src/kind.rs:545`、`crates/buzz-relay/src/handlers/ingest.rs:3959-3968`、`crates/buzz-search/tests/postgres_fts_integration.rs:1257`。**Support:** direct。**Confidence:** 高。
2. **Claim:** **上下文占用不上行**：`usage.rs` 中 `used`（:80-81）与 `context_limit`（:84-85）都标 `#[allow(dead_code)]`，且字段注释明说 buzz-agent 不追踪 context window limit → 44200 里 context-usage proxy 为空壳。**Sources:** `crates/buzz-acp/src/usage.rs:74-86`。**Support:** direct。**Confidence:** 高。
3. **Claim:** 桌面端有取数 IPC `get_agent_usage_series`（tauriArchive.ts:511-514）与本地索引 `agent_metric_index`（store.rs:38 及 metric_store_tests），但**全仓没有 `useAgentUsageSeries` 的定义**（仅注释引用：`useArchiveAgentMetricsBridge.ts:12`、`tauriArchive.ts:165`）→ token/成本/上下文占用**零 UI 消费方**。桥接 hook 本身存在且挂载（AppShell.tsx:68,219），但它只把 Tauri 事件转发给不存在的消费者。**Sources:** `desktop/src/shared/api/tauriArchive.ts:165,511-514`、`desktop/src/features/local-archive/useArchiveAgentMetricsBridge.ts:1-21`、`desktop/src/app/AppShell.tsx:68,219`、grep `function useAgentUsageSeries` 全仓 0 命中。**Support:** direct（grep 证据）+ interpretation（「零 UI」为枚举推断）。**Confidence:** 高。
4. **Claim:** 44200/24200 可见性=**owner 私有**：读面统一走 `event_visible_to_reader`（author-only → shared-gate → result-gate 三段，result-gate 覆盖 44200/30622 等，per-event `reader_authorized_for_event`），WS REQ/COUNT/fan-out 与 HTTP /query /count/FTS 全部调用；bridge 侧另有 defense-in-depth 拦截。**Sources:** `crates/buzz-relay/src/handlers/req.rs:1504-1528`（调用点 :465,:798）、`crates/buzz-relay/src/api/bridge.rs:1312,1380`、`crates/buzz-relay/src/handlers/count.rs:115`。**Support:** direct。**Confidence:** 高。
5. **Claim:** 对比总括（解释）：presence（20001/40902）=社区级可见、不落库；observer/metric（24200/44200）=owner 私有（44200 落 relay Postgres，24200 relay-ephemeral 仅落 owner 本地归档）。**Sources:** 上述 bridge.rs/req.rs + `desktop/src/app/AppShell.tsx:208-210`。**Support:** interpretation（由多条直接证据合并）。**Confidence:** 高。

### 2d. UI 位置与每行字段

1. **Claim:** **频道成员侧栏**（主展示位）：`MembersSidebar` 过滤列表逐员渲染（`filteredActiveMembers.map → renderMemberCard`，`MembersSidebar.tsx:608-635,772-773`；归档员 :860-861），行组件 `MembersSidebarMemberCard`。行字段：① 头像+**PresenceDot** 状态点（:174-180，testid `sidebar-member-presence-*`）；② 名称/角色标签、bot 图标、悬停显 npub（:183-215）；③ bot/托管 agent 追加 **availability Badge**（`Here/Waking/…/Running/Stopped`，:222-241，testid `sidebar-managed-agent-status-*`）+ provenance 标记；④ 行动作菜单按 `availability`（presenceStatus ?:）使能 Start/Stop（:297）。**Sources:** `desktop/src/features/channels/ui/MembersSidebar.tsx:608-635,772-773`、`desktop/src/features/channels/ui/MembersSidebarMemberCard.tsx:57,76,174-241,297`。**Support:** direct。**Confidence:** 高。
2. **Claim:** **托管 agent 行**（agents 面板）`ManagedAgentRow`：PresenceDot（:235-236）、`AgentStatusBadge`（:120-129,143-151）、`RuntimeBlock` 含 **PID**（`PID ${agent.pid}`，:76-77）、日志行（logContent/error/loading，:182-187，testid `managed-agent-log-row`）、persona/origin 徽标（:244-246）、RestartDiffBadge（:163）。**Sources:** `desktop/src/features/agents/ui/ManagedAgentRow.tsx:6-8,33-51,56-77,120-187,210-246`。**Support:** direct。**Confidence:** 高。
3. **Claim:** `AgentStatusBadge` 合成逻辑：输入 `status`（ManagedAgent 状态）+`isWorking`+`presenceStatus`+`presenceLoaded`；running 但 presence 缺失/离线超过 15s 宽限 → 「Starting…」（warning 脉冲）；isWorking → 「Working」（default 脉冲）；否则显示状态原文（running/deployed/stopped…）。**Sources:** `desktop/src/features/agents/ui/AgentStatusBadge.tsx:6-51`。**Support:** direct。**Confidence:** 高。
4. **Claim:** **资料面板** Status 字段：`UserProfilePanelFields` 把托管 agent 状态渲染为字段行（label "Status"，testid `user-profile-agent-status`，值经 `AgentStatusBadge` presenceLoaded/presenceStatus，:330-344,414-426）；agent 资料页还可挂 `ManagedAgentSessionPanel`（`UserProfilePanelTabs.tsx:458,525`）。人侧资料有 `ProfileAvatarWithStatus`/`PresenceBadge`。**Sources:** `desktop/src/features/profile/ui/UserProfilePanelFields.tsx:92-144,237-250,330-344,414-426`、`desktop/src/features/profile/ui/UserProfilePanelTabs.tsx:458,525`。**Support:** direct。**Confidence:** 高。
5. **Claim:** `AgentRuntimeAvatarControl`（头像悬停控件）用 `getPresenceDotClassName/getPresenceLabel` 显示 availability，并按 `agentPresenceStartBlockReason` 决定 Start 是否被阻止。**Sources:** `desktop/src/features/agents/ui/AgentRuntimeAvatarControl.tsx:11-17,164-166,244`。**Support:** direct。**Confidence:** 高。
6. **Claim:** **每行不渲染** token/成本/上下文占用（无字段、无组件——见 2c.3）。**Sources:** 同 2c.3。**Support:** interpretation（枚举）。**Confidence:** 高。

## Q3 实时信息流 / transcript / log 视图

1. **Claim:** 传输：NIP-AO observer 帧 `kind:24200`（NIP-44 加密，agent 为 sender），relay 将其视为「durable telemetry, not droppable ephemera」做限速门控排队，但事件类别属 ephemeral（`ephemeral_kinds = [20000,20001,20002,24200,29999]`）——**relay 不落库**；桌面端注释确认「Kind 24200 is relay-ephemeral … Frames before the listener opens are permanently lost」，因此重连时请求 5 分钟回放。**Sources:** `crates/buzz-sdk/src/builders.rs:265`、`crates/buzz-acp/src/relay.rs:1671-1681,1196`、`crates/buzz-relay/src/rejection/quota_tests.rs:128`、`desktop/src/app/AppShell.tsx:208-210`、`desktop/src/features/local-archive/useArchiveSync.ts:37-38`、`desktop/src/features/agents/observerRelayStore.ts:483-491`。**Support:** direct。**Confidence:** 高。
2. **Claim:** 摄取：`useAgentObserverIngestion` 在 AppShell **app 级挂载一次**，收帧→解密→折入 active-turns store，「if the current identity owns an agent … its turn activity is ingested app-wide — not only while a panel … is open」；未信任帧先入 pending 缓冲直至 knownAgentPubkeys 就绪，且做 sender==claimed-agent 防御校验。**Sources:** `desktop/src/app/AppShell.tsx:200-207`、`desktop/src/features/agents/useAgentObserverIngestion.ts:55-75`、`desktop/src/features/agents/observerRelayStore.ts:541-570`。**Support:** direct。**Confidence:** 高。
3. **Claim:** 实时视图=**`ManagedAgentSessionPanel`**，标题 "Live ACP session"，头部含 `ObserverStatusBadge`（connectionState）、`Session <short-id>` 或 "Waiting for the next agent turn."、event 计数徽标。**Sources:** `desktop/src/features/agents/ui/ManagedAgentSessionPanel.tsx:62-78,186-214`。**Support:** direct。**Confidence:** 高。
4. **Claim:** 粒度：**逐帧流式**——transcript 由 raw 窗口经 `buildTranscriptState` 派生，状态化关系（tool start/update、plan replacement、permission request/response）在同一状态机里折叠；实时窗与归档页按 (seq, timestamp) 合并去重后单次派生。视图两栏：`AgentSessionTranscriptList`（人读转写）+ `RawEventRail`（原始帧侧栏/独占模式，布局 `side|exclusive`）。**Sources:** `desktop/src/features/agents/ui/ManagedAgentSessionPanel.tsx:100-130,244-300`、`desktop/src/features/agents/ui/useObserverEvents.ts:73-79`、`desktop/src/features/agents/ui/RawEventRail.tsx:7`、`desktop/src/features/agents/ui/agentSessionPanelLayout.ts:59`。**Support:** direct。**Confidence:** 高。
5. **Claim:** 实时窗保留：每 agent journal 上限 **3000 帧**，低水位 2700 触发驱逐（防每 append 全量 replay 的 CPU 问题 #5718）。**Sources:** `desktop/src/features/agents/observerTranscriptRetention.test.mjs:5-16,34-35`。**Support:** direct。**Confidence:** 高。
6. **Claim:** 视图入口不止一处：agent 资料页（`UserProfilePanelTabs.tsx:458,525`）与频道内 agent 会话线程面板（`AgentSessionThreadPanel.tsx:19,124,518`）都挂 `ManagedAgentSessionPanel`。**Sources:** 上述文件:行。**Support:** direct。**Confidence:** 高。
7. **Claim:** log 视图：托管 agent 行内嵌日志行（`ManagedAgentRow.tsx:182-187`，logContent 来自 `managed_agent_runtime_log_path` 文件 tail，`runtime_commands.rs:70-73`）；远程/本地同源。**Sources:** 同左。**Support:** direct。**Confidence:** 高。

## Q4 归档 / 历史会话视图

1. **Claim:** 存储=桌面**本地 SQLite**（`desktop/src-tauri/src/archive/store.rs:21-76`）：`archived_events`、`archived_event_scopes`（owner_p 范围）、`save_subscriptions`、`observer_channel_index`（24200 按 channelId 索引）、`agent_metric_index`（44200 解密投影）、`archive_migrations`。**Sources:** `desktop/src-tauri/src/archive/store.rs:21-76`。**Support:** direct。**Confidence:** 高。
2. **Claim:** 落库路径：owner_p 订阅——24200 由 `useObserverArchiveSeed`+`useArchiveSync` 收（24200 relay-ephemeral 必须先 seed 再开 listener，顺序由 AppShell reconciliation 保证），44200 由 `useAgentMetricArchiveSeed` 播（relay 持久故可延后 replay）。**Sources:** `desktop/src/features/local-archive/useObserverArchiveSeed.ts:25`、`useArchiveSync.ts:37-38`、`useAgentMetricArchiveSeed.ts:10`、`desktop/src/app/AppShell.tsx:208-223`、`desktop/src/shared/api/tauriArchive.ts:223`。**Support:** direct。**Confidence:** 高。
3. **Claim:** 历史视图=**同一实时面板向上翻页**：`useLoadArchivedObserverEvents` 经 `observer_channel_index` 按 channel 分页读归档（200 帧/页，面板打开先 eager 加载 10 页=2000 帧，覆盖一次重代码审查 ~900 帧的 turn），滚动 load-older；首次挂载还对未索引的 owner_p 24200 行做解密回填索引。转写合并 live+archive 后单次派生，历史与实时状态机不分裂。**Sources:** `desktop/src/features/agents/ui/useObserverEvents.ts:95-119,317`、`desktop/src/shared/api/tauriArchive.ts:420-435,487`、`desktop/src-tauri/src/archive/mod.rs:559-585`。**Support:** direct。**Confidence:** 高。
4. **Claim:** 配置入口=设置页 `LocalArchiveSettingsCard`（`SettingsPanels.tsx:856` 渲染）：两个开关——"Archive my agents' observer frames"（ObserverArchiveSection :73-102）与 "Archive my agents' turn metrics"（AgentMetricArchiveSection :118-147，文案说明存 kind:44200 供 token-usage 工具读取）+ kind 摘要/清理。**Sources:** `desktop/src/features/local-archive/ui/LocalArchiveSettingsCard.tsx:51-61,73-102,118-147`、`desktop/src/features/settings/ui/SettingsPanels.tsx:856`。**Support:** direct。**Confidence:** 高。
5. **Claim:** 44200 归档可读（`get_agent_usage_series` 分页查询 + `agent_metric_index`），但因缺前端消费者（Q2c.3）**没有浏览 UI**——只存不看。**Sources:** 同 Q2c.3、`desktop/src-tauri/src/archive/agent_usage.rs:1-10`。**Support:** interpretation。**Confidence:** 高。

## Q5 远程 agent（buzz-backend-*）状态回传

1. **Claim:** 形态：零注册插件协议——D 机上任何可执行 `buzz-backend-<id>` 即 provider；唯一已实现绑定 `buzz-backend-kubernetes`（裸 Pod 跑 `sprig` 镜像，label `app.kubernetes.io/managed-by=buzz-backend-kubernetes`）。规格状态=**draft**。**Sources:** `docs/remote-agents.md:1-24,75,991`、`crates/buzz-backend-kubernetes/src/naming.rs:10`、`crates/buzz-backend-kubernetes/src/cluster.rs:305`。**Support:** direct。**Confidence:** 高。
2. **Claim:** **M1（核心答案）**：deploy 成功后 D 对远程 A **无持久管理会话**，desktop↔provider 协议**不含 substrate API**——「no status query, no exec, no log fetch, no kill」；部署后一切观测/控制走 R：**状态=relay presence（kind:20001）**、停机=relay 消息 `!shutdown`、重配=再 deploy。代价=presence 陈旧界。**Sources:** `docs/remote-agents.md:89-105`（尤其 :96-100）。**Support:** direct。**Confidence:** 高。
3. **Claim:** **I3 presence-is-status**：D 只从 agent 自签 presence 推导存活；部署轴（deployed/not_deployed，来自 `backend_agent_id` 簿记）非存活信号。异常死亡（SIGKILL/节点丢失）到 relay 过期的最大错窗=**180s**（引 `PRESENCE_TTL_SECS`，`buzz-pubsub/src/presence.rs:16`；#3783 从 90s 上调以保三心跳窗）。附带边界：presence 按 **community 作用域**（relay 由 host 推导），跨 community 观察会看到 offline。`BUZZ_ACP_NO_PRESENCE` 必须进 `RESERVED_ENV_KEYS`（远程下 presence 是唯一信号，用户 env 关掉它=无限错）。**Sources:** `docs/remote-agents.md:198-232`、`docs/remote-agents.md:168-176` 语境。**Support:** direct。**Confidence:** 高。
4. **Claim:** 状态回传的具体链路（远程与本地同构，都经 relay、不经 substrate）：harness 自签 20001 presence（`remote-agents.md` Implementation Correspondence 表：`crates/buzz-acp/src/lib.rs` publish_presence/offline-on-exit）+ `!shutdown` owner 校验（`crates/buzz-acp/src/lib.rs:3347-3369`）+ 24200 observer 帧。桌面端 deploy payload 已注入 `policy_env.BUZZ_ACP_RELAY_OBSERVER=true`（HEAD），即远程 pod 也推 observer 遥测。**Sources:** `docs/remote-agents.md:1687-1707`、`desktop/src-tauri/src/commands/agents_deploy.rs:76,347`、`crates/buzz-acp/src/config.rs:501`。**Support:** direct。**Confidence:** 高（env 注入）/ 中（远程 24200 端到端未见集成测试）。
5. **Claim:** 缺什么（对照 hive 需求）：① 无 substrate 侧状态查询/exec/日志拉取（M1 明文）——「当前会话/上下文占用/pid」这类信息远程一概拿不到 pid 与本机 logPath（这两项来自本地子进程，`runtime_commands.rs:66-73`）；② lifecycle 徜标 `putManagedAgentRuntimeLifecycle` 要求帧匹配**本地 tracked runtime**（"lifecycle frame does not match a tracked runtime pair"）→ 远程进程无本地 runtime，生命周期徽标路径对 provider agent 不适用，存活只剩 presence 点（推断）；③ 已知缺陷清单（`Known Defects` at 28ae6cd21）：I5 自动停止 reaper **尚不存在**（`BUZZ_ACP_EXIT_AFTER_INACTIVITY` 无实现，`lib.rs:1743` 维护 tick 受 pool_ready 门控）、退出码契约未成文、关尾超 60s grace、deploy 路径不查 protocol_version 等。**Sources:** `docs/remote-agents.md:1581-1685`（defect 3-8）、`desktop/src-tauri/src/managed_agents/runtime_commands.rs:127-130`。**Support:** direct + 标注 interpretation（②）。**Confidence:** 高（缺陷清单）/ 中（②UI 影响）。
6. **Claim:** 规格自带的诚实边界：provider 二进制**按设计拿到 agent nsec**（信任决定由 UI 告知用户）；substrate 安全与 pod 存活属外部经验事实；桌面端「is one launcher among many」。**Sources:** `docs/remote-agents.md:29-67`。**Support:** direct。**Confidence:** 高。

## Contradictions

1. **上一轮线索「desktop observerRelayStore 消费 24200 并写本地 SQLite `managed_agent_runtime` 表」不成立（HEAD）**：无该表（archive 建表清单 `store.rs:21-76`），实际写入内存 `managed_agent_processes` + `emit_status` 事件，且拒绝 untracked frame（`runtime_commands.rs:127-130`）。以本轮证据为准。来源：`desktop/src-tauri/src/archive/store.rs:21-76`、`runtime_commands.rs:75-141`。
2. **上一轮线索「useArchiveAgentMetricsBridge.ts:12 引用不存在的 hook」表述不准**：hook 本身存在且被 AppShell 挂载（`AppShell.tsx:68,219`）；不存在的是它注释里声称的下游消费者 `useAgentUsageSeries`（全仓 0 定义）。结论（零 UI）不变，理由修正。来源：`useArchiveAgentMetricsBridge.ts:1-21`、grep。
3. **remote-agents.md Known Defect 3（at 28ae6cd21）称 deploy payload 缺 `BUZZ_ACP_RELAY_OBSERVER`，但 HEAD `agents_deploy.rs:76` 已写入 `policy_env`**——该子项在 77729ab 已修复；引用缺陷清单时须标注 commit 差异（规格也自注 "file:line verified against 28ae6cd21"）。来源：`docs/remote-agents.md:1583-1585`、`desktop/src-tauri/src/commands/agents_deploy.rs:76`。
4. presence 的 20001 content 在 WS 面「任意字符串向前兼容」（`presence.rs:7`）与桌面端只认三档（`presence.ts:12-14`）——非真冲突，但意味着 harness 若发第四档会被桌面端丢弃。来源：`crates/buzz-core/src/presence.rs:7`、`desktop/src/features/presence/lib/presence.ts:12-14`。

## Missing evidence

- 远程（provider）agent 的 24200 observer 帧端到端（pod → relay → 桌面端转写面板）未找到专门集成测试，仅由「harness 行为与位置无关 + policy_env 注入」推断（置信中）。
- `getPresence` REST 的服务端路由（`tauri.ts:324` 之对端）未逐行核对；presence REST/MCP 面细节以 `buzz-core/src/presence.rs` 文档注释为准。
- hive #34 prong2 / `cross-machine-agent-status.md` 只按 mission 提示列为参照，本轮未复核其内容。
- mobile/web 端的成员行字段未查（本 prong 聚焦 desktop）。

## Sources

**Kept**

- `docs/remote-agents.md`（/tmp/buzz-recon）— Q5 权威规格：M1/I3/launchers/已知缺陷，几乎每条 Q5 结论的锚点。
- `ARCHITECTURE.md` — Q1 各层职责（relay 事实源、buzz-acp 模块表）。
- `crates/buzz-pubsub/src/presence.rs` — presence 存储与 TTL 180 的唯一实证。
- `crates/buzz-acp/src/lib.rs` / `usage.rs` / `pool.rs` — harness 上线/心跳/lifecycle/metric 产生点。
- `crates/buzz-relay/src/api/bridge.rs` / `handlers/req.rs` — 可见性两极（社区级 presence vs owner 门控）。
- `desktop/src/features/channels/ui/MembersSidebarMemberCard.tsx` 等 UI 文件 — Q2d 行字段实证。
- `desktop/src-tauri/src/archive/store.rs` 与 `desktop/src/features/agents/ui/useObserverEvents.ts` — Q4 归档结构与历史视图。
- `docs/research/buzz-without-self-hosting.md`、`docs/research/no-server-agent-groupchat.md`、`docs/research/cross-machine-agent-status.md`（hive 仓库，只读参照）— hive 侧需求对照（未逐行复核）。
- https://github.com/block/buzz （上游仓库，HEAD 77729ab）— 调研对象本体。

**Rejected/deprioritized**

- 上一轮的口头线索清单（mission 内嵌）— 无行号、且其中两条已被本轮证据修正（见 Contradictions）。
- 官方文档型二手解读（未使用）— 本仓 NIP 文档与代码互相印证，直接采信代码+同仓 spec。

## Next steps

1. 若 hive 需要「远程 agent 的会话可见性」保证：在 buzz 上游验证 provider 路径 24200 端到端（或提集成测试）——当前只有推断链。
2. 对照 hive 需求设计「上下文占用上行」：buzz 的 `used/contextLimit` 死字段是现成的改造缝（`usage.rs:80,85`），可评估直接复活+44200 payload 消费。
3. 若采用 presence 模型：确认 relay TTL（180s）与 hive 心跳频率的三倍关系约束（`presence.rs:4-5,14-16`）。
