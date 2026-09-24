# Teahouse 地雷卡清单（headless fork 前置侦察）

> 目标仓库：`/tmp/teahouse-recon`（skyjt/teahouse 只读 clone）。扫描日期：2026-09-21。扫描者：JadeOwl。
> 计划背景：fork 后加 headless 模式，"每 agent = 一个本机 teahouse 节点进程"（独立 nodeId + UDP/TCP 端口），加"订阅群内 @ → 喂本地 coding agent → 回帖"胶水。

### 卡 1 · 单实例锁按 userData 隔离，多开靠 `PANTRY_USER_DATA` 而非端口
- 证据：`src/main/index.ts:225` `const gotLock = app.requestSingleInstanceLock()`；`index.ts:221-223` `PANTRY_USER_DATA` 设不同 userData 即绕锁（README 注释明言"同时绕开单实例锁"）。
- 为什么会咬：锁的粒度是 Electron 默认 userData 路径，**不是端口**；两实例共享 userData 时第二个 `app.quit()` 直接退。
- 改变我们的什么：headless 多开方案沿用 dev 脚本三件套（独立 userData + UDP + TCP 端口），**端口不同不能救锁，数据目录必须独立**。
- 置信：确认

### 卡 2 · `window-all-closed → app.quit()`：headless 不建主窗会立刻退出
- 证据：`src/main/index.ts:3249-3251` `app.on('window-all-closed', () => { app.quit() })`；`index.ts:3184` ready 后无条件 `createMainWindow()`（`index.ts:1583` 定义）；mac `activate → showMainWindow()`（`index.ts:3208`）。
- 为什么会咬：headless 若跳过 `createMainWindow`，Electron 启动即触发 window-all-closed；即便建窗，关窗会 `app.quit()`（托盘拦截只在 `closeToTray` 开启且托盘存在时防退出）。
- 改变我们的什么：headless 分支需 (a) 跳过 `createMainWindow`/`setupTray`/`registerGlobalShortcuts`/`second-instance` 的 mainWindow 聚焦（`index.ts:3077-3082` 有 `if (mainWindow)` 保护，安全），(b) 给 `window-all-closed` 和 `activate` 加 headless 短路；`before-quit` 清理链（`index.ts:3210-3247`）必须保留。
- 置信：确认

### 卡 3 · `mentions` 不落消息表，只在 codec 校验层 + 内存会话层存活
- 证据：落库语句 `src/main/store/msg-repo.ts:106-107` 只有 `content, file_ref, reply_to` 等列，无 mentions；codec 白名单校验 `src/main/net/codec.ts:178-186`；接收侧在 `src/main/services/groups.ts:359-366` 用 `payload.mentions.includes(selfId)` 置 `view.mentioned = true` 后 emit。
- 为什么会咬：消息行里没有 mentions 字段；订阅方只能在收到事件当刻从 payload 判定，**事后翻库补不出来**（重启后无从知道哪些历史消息 @ 了我，只能靠未读/convRepo.markMentioned 这个布尔）。
- 改变我们的什么：@ 订阅胶水应钩 `groups` service 的 `'message'` 事件（`MessageView.mentioned === true`）或在 `groups.ts:359` 同款位置拿 `payload.mentions`；不要指望查库回放。若需持久化 @ 记录，自己加 repo（或迁移加列）。
- 置信：确认

### 卡 4 · nodeId = `userData/identity.json` 里的 randomUUID，删目录即换身份
- 证据：`src/main/store/app-state.ts:341-348` 读 `identity.json`，缺失/非法则 `randomUUID()` 新建落盘；`app-state.ts:19` 注释"节点身份，永不变"。
- 为什么会咬：清 userData / 换机器 = 换 nodeId = 旧会话/群成员列表全部不认你；同机两实例只要 userData 不同（卡 1 已强制）就各自生成独立 nodeId，**不会撞**。
- 改变我们的什么：agent 身份稳定性 = userData 目录的存续；部署方案里 identity.json 要当机密资产对待，CI/重建环境需预置或接受"新成员进群"。
- 置信：确认

### 卡 5 · 群成员视图靠 groupRev 全量快照追赶，无仲裁，落后靠"谁发消息谁带 rev"收敛
- 证据：`src/main/services/groups.ts:377-381` 收消息时 `payload.groupRev > meta.rev` 才向发送者 `need` 全量；`:553-556` info 快照权限校验"版本差须覆盖操作数"否则拒绝；退群 `groups.ts:206-225` 本地 rev+1 广播。
- 为什么会咬：离线期间别人退群，若无人发消息触发 rev 比较，本地成员列表长期显示旧成员；收敛触发器是"任意一条带新 rev 的群消息/info"，无定时主动同步。
- 改变我们的什么：agent 胶水若依赖成员列表做路由（向谁回帖），需在启动/判活时主动拉 info，不能假设 member 视图新鲜；对"已退群者仍收离线补发"要容忍。
- 置信：确认（触发收敛的精确最坏时长取决于群活跃度，协议无上限——此为存疑子项）

### 卡 6 · 广播目标 = 每网卡子网定向广播 + 255.255.255.255；`PANTRY_PEERS` 不绕过广播，是叠加
- 证据：`src/main/net/udp.ts:139-156` `computeBroadcastTargets()` 枚举所有非回环 IPv4 网卡算定向广播地址；`udp.ts:94-97` 有 `broadcastTargets` 注入口（测试用）；`src/main/net/discovery.ts:117-122` start 时**先广播 entry 再向 manualPeers 单播**，二者并存。
- 为什么会咬：多网卡机器会把 entry/presence 喷到所有网段（VPN 网卡也算）；`PANTRY_PEERS` 不会关闭广播，想"纯静态对端"得自己改代码或配 `broadcastTargets`。
- 改变我们的什么：跨网方案可以用 PANTRY_PEERS 起步（presence 也会向已知在线节点单播，`discovery.ts:347-350`），但要接受本机仍持续广播；headless 容器化部署时考虑加 env 开关覆盖 broadcastTargets=[]。
- 置信：确认

### 卡 7 · 补发队列有双上限：7 天 TTL + 单对端 200 条；静默节点不会被清，只会 90s 后变灰
- 证据：`src/shared/protocol.ts:47-49` `offlineAfter: 90_000`；`:67-68` `queueTtl: 7*24h, queueMaxPerPeer: 200`；prune 调度 `src/main/index.ts:1382-1383` 启动一次 + 每小时；`messenger.ts:113` 对端 online 事件触发 flush。
- 为什么会咬：agent 若沉默 >7 天，别人发给它的消息从队列蒸发且**无任何信号**；反向地，"只监听不说话"的节点仍每 30s 发 presence（`discovery.ts:124`），不会被诊断离线——但 queueMaxPerPeer=200 意味着高频群里沉默 agent 的未读会被截断。
- 改变我们的什么：常驻 agent 无离线风险（它自己会发 presence）；风险在**别人重启后**队列里旧消息过期。若 agent 离线 >7 天须接受消息丢失。
- 置信：确认

### 卡 8 · 隐形工程规则铁律集（违一条就堵死 local-api 预留口）
- 证据：`docs/tech-design.md:150` "renderer 永不直接碰网络/磁盘/DB——一切经 IPC；services 是用例编排层，net/、store/ 互不感知"；`:164` 决议 #21 "任何人不得把业务逻辑写进 ipc/ 层"；`docs/handoff.md:152` 同款；DB 迁移 `src/main/store/migrations.ts:212-217` PRAGMA user_version 递增；codec 手写白名单校验 `src/main/net/codec.ts:178+`；依赖精确锁版本 + native 只允许 better-sqlite3（tech-design.md:29）。
- 为什么会咬：我们的 @→agent 胶水如果图省事写在 `index.ts` 的 ipcMain.handle 里（98 个 handler 全在这一个文件），就违反了项目唯一明文分层铁律，上游 rebase 时必然冲突。
- 改变我们的什么：胶水应实现为 `src/main/services/` 下的新 service（如 `agent-bridge.ts`），挂在 `groups.on('message')` 上（接线点 `index.ts:1341` 旁）；headless 分支判断同样下沉到装配处，不散落。
- 置信：确认

### 卡 9 · `local-api/`（AI 接口）只有设计预留、零代码——没有"做了又回退"的残骸
- 证据：全仓 grep `local-api|localApi` 源码零命中；唯一出处 `docs/tech-design.md:164`（决议 #21，"当前版本不实现"）；决议 #21 在 protocol.md/tech-design.md 中也无其他落地记录。
- 为什么会咬：不存在可参考/可复活的半成品 HTTP/WS 服务；但好消息是设计文档已为我们要做的事留好了名义和位置（"与 ipc/ 并列的第二个前台，复用 services/"）。
- 改变我们的什么：我们的 headless+agent 胶水可以直接认领 `local-api/` 这个名分，与上游设计意图兼容，未来 rebase 有据可依；不必绕开任何人的废弃代码。
- 置信：确认（"为什么没有实现"的原因未在文档中找到，仅知"当前版本不实现"）

### 卡 10 · 退出链路是异步的：before-quit preventDefault + 最长 2s 诊断收尾
- 证据：`src/main/index.ts:3210-3247` `before-quit` 先 `event.preventDefault()`，做 db close/peers 落库/discovery exit 广播，再 `Promise.race([diagnostics.close(), 2s 超时])` 后真正 quit。
- 为什么会咬：headless 场景里 kill 进程若不经 SIGTERM 正常退出路径（例如 docker stop 超时强杀），补发队列最后一次落库与 exit 广播都会丢，对端要等 90s 才把它判离线。
- 改变我们的什么：agent 进程管理器必须给足优雅退出窗口（≥2s），并依赖正常退出路径广播 exit 以快速收敛对端状态。
- 置信：确认

---

## 覆盖范围声明

实际扫描的文件/目录：
- `src/main/index.ts`（约 3300 行，重点窗口：200-280、1250-1390、1583-1660、2890-2910、3060-3260 行段，grep 全量定位）
- `src/main/net/discovery.ts`、`udp.ts`、`cidr.ts`、`messenger.ts`（窄窗口 + grep）
- `src/main/store/app-state.ts`、`msg-repo.ts`、`queue-repo.ts`、`migrations.ts`（窄窗口 + grep）
- `src/main/services/groups.ts`（窄窗口：225-270、340-385、440-475、540-565）
- `src/shared/protocol.ts`（TIMINGS 全段 + mentions 定义）、`src/shared/ipc.ts`（grep）
- `scripts/dev-client-1.sh`、`dev-client-2.sh`（全读，短文件）
- `docs/tech-design.md`、`docs/handoff.md`、`docs/protocol.md`（grep 命中窗口）
- 全仓 grep：`requestSingleInstanceLock`、`PANTRY_`、`nodeId`、`mentions`、`local-api`、`AI|MCP|webhook|bot`

**未确认**（没来得及验证、不能当作事实）：
- 群成员视图收敛的**最坏时长**（协议无定时主动同步机制，依赖消息流量触发 rev 比较；真实收敛时长取决于群活跃度，未在协议文档中找到兜底周期）。
- `profileRequests` 1024 上限（`discovery.ts:313`）在超大网络下是否会顶掉 agent 的探活——量级问题，未评估。
- `PANTRY_PEERS` 格式校验的严格程度（`index.ts:267-273` 简单 split，坏输入会静默丢弃或产生 NaN 端口，未实测）。
- renderer 侧 `groupSend` IPC 的 mentions 上限 64 字符/id（`index.ts:2900`）与 codec 的 `LIMITS.from` 是否一致——数字不同但都用 `GROUP_MAX_MEMBERS` 截断，未逐一核对。
- `msg-repo.ts` 是否有 FTS 触发器会索引 system/mention 相关字段——未查 fts.ts。
- 决议 #21 提出的具体时间与搁置原因——文档中只写"当前版本不实现"，未找到动机记录。
- 未运行任何代码（遵守只读纪律），所有结论均为静态阅读所得。
