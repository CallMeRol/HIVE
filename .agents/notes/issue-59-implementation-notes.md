# Issue #59 实现记录

## 目标

派遣成员的 runner 猝死时，用户在五秒内看到异常退群与待领取任务，且是否补派由主人决定（默认不自动）。

## 决策

- **猝死判据 = pid 不存在，而不是「离线」**。派遣子进程是 `detached + stdio:'ignore'` 起的
  （#51 的 `spawnNode`），父进程**拿不到它的 exit 事件**——这条在 #58 的重启恢复里已经被间接证实。
  故本机探活（`process.kill(pid, 0)` 抛 ESRCH）是唯一现成信号，ADR-0009 也定了同一口径
  （「猝死判定走子进程退出 / TCP，不依赖本通道」）。
  **「离线」不能当判据**：离线 = 够不着（静默 90s 判定），与它在不在干活无关（PRD ④ 明说
  「空闲 / 离线 / 回收是三件不同的事」）。
- **账本增记 `pids` 而非靠 memberId 去查进程**。`DispatchRecord.pids` 与 `memberIds` **逐位对齐**；
  只增可选字段（迁移规则 1）：**旧账本没有这一列 → 该条不参与探活，不会被误判猝死**。
  这是有意的偏保守：宁可漏判，也不把一条老记录里的活成员误杀。
- **两层判据缺一不可**：pid 不在 **且** 账本仍记作 `outcome=started`。只看 pid 会把
  「正常回收后 pid 被复用」当成猝死；只看账本则完全不知道进程活没活。
- **结算用新的 `markAbnormal`，不复用 `settleFailed`**。语义不同：`settleFailed` = spawn 压根没起来；
  `markAbnormal` = 成员**曾经上线过**、运行期进程消失。共用会让账本分不清「派遣失败」与「异常退群」，
  而 PRD ④ 明确要求这两件事在群里是**两种消息**。
- **结算前必须先捕获派遣记录快照**。`markAbnormal` 会把该成员从 `memberIds` 摘除（它不再是「活跃成员」），
  之后 `store.recordFor(memberId)` **查不回来** —— 收口需要的 groupId / dispatcherId / depth 必须
  在结算前拿到。这一点在 `AbnormalExitDeps.onAbnormalExit` 的签名里显式化（传 `record`），
  否则会静默退化成「不知道这个成员属于哪个群」，异常退群消息发不出去。
- **默认不自动补派落在代码结构上**：没有任何自动路径调用 `claimAndDispatch`。三个生产者
  （#51 spawn 失败 / #59 异常退群 / #58 重启中断）都只落待领取账 + 通知；补派只能由人经
  GUI（`hive:claim-now`）显式发起。这不是一条 `if (auto)` 开关，而是「自动路径不存在」。
- **补派的前置拒绝要回滚 claim**。`claimAndDispatch` 是「先 claim 再摇人」；若新派遣被前置拒绝
  （深度/并发/slot 用尽），既没有 settleStarted 也没有 settleFailed —— 任务会卡在 `claimed`
  且**再也补不了**（幽灵任务，直接违反 AC4「UI、持久化任务状态和真实进程状态一致」）。
  故 `outcome=rejected` 时调 `store.unclaim` 放回待领取，账面上始终留着这条任务等人处理。
- **「硬删除」走底座 `updateGroup({kind:'remove'})`，不是本地偷偷抹掉**。AC1 要求成员从活跃成员中消失，
  而成员表归 vendored teahouse store;派遣时已 `set-admin` 给派遣者（ADR-0006），本节点即该成员的
  主人节点，有管理权。底座拒绝时**显式留痕不假装成功**（与 #53 同款纪律）。
- **不新造 SSE `type`**（契约「type 批内冻结」）。状态变化复用已冻结的
  `member.lifecycle(phase=abnormal)`（契约表已预留该 phase，生产者列表已含 #59）与
  `dispatch.event(outcome=claimable)`；GUI 刷新走独立 IPC 推送 `hive:claimable-updated`。
- **补派命令走 renderer IPC，不做 local-api 端点**——与 #52 clear 同源纪律：
  「带权限语义的动作（谁能补派）走 renderer IPC」。但**只读**的待领取列表额外挂进 health
  （`claimable: { autoDispatch: false, tasks[] }`），因为 e2e 与现场演示需要一个不经 GUI 的观察面，
  且 `autoDispatch: false` 让「默认不自动补派」这条 AC 可以直接被断言。
- **收口顺序有依赖**：`reanchorDispatchedChildren` 必须**先于** `memberRegistry.unregister` —— 
  reanchor 的兜底主人取自登记表的 `ownerId`，撤完登记就查不到了。

## 视觉

`HiveClaimableBar.vue` 与 #50 的 pending 药丸并列挂在 `ChatPane` 群头部下方，全走 tokens.css 的
`var(--primary*)` / `var(--surface)`（已是 Hive 红 `#e94560` + 深蓝 `#0a0e17`），无新增硬编码色值。
异常态用 `--primary` 描边 + 图标，与正常态（无此条）在视觉上直接可分。

## 审查后修的真实缺陷（`/code-review` 发现，均已修 + 加回归测试）

- **正常终结从不结算账本**（原实现最严重的一处）。`outcome='started'` 是「该成员此刻该活着」的
  唯一凭据，而 #53 的移出收口只做 `unregister` + 归档 + 事件，**从不回写派遣账本**。后果：
  成员正常退群后进程退出，猝死探活在下一拍（≤1s）把它判成猝死 → 群里冒出假的 `⚠ 异常退群`、
  生成针对已归档成员的幽灵待领取任务。**与 AC2「正常退群与异常退群消息明确不同」直接冲突。**
  修法：新增 `DispatchStore.markSettled` + `recordForMember`，在 `finishHiveMemberRemove` 里回写；
  新增 `outcome='settled'`（已全部正常终结，不再参与探活）。
- **`slots` 与 `memberIds` 未逐位对齐**（#56 遗留，被本票的 pids 探活放大成误杀）。
  原 `slots: begin.slots.slice(0, memberIds.length)`：`begin.slots` 是**连续预留段**，而 `memberIds`
  只收**成功**的成员 —— `count=3` 且第 1 个失败（用 slot 1）时实占 `[2,3]`，切片却记成 `[1,2]`。
  两个后果：归还时释放**不属于自己**的段、自己那段永不归还；更糟的是 #59 按 index 摘除会摘到
  **同批另一个还活着的成员**。修法：记录实际 `usedSlots`（只在成功时 push）。
- **`settleFailed` 整条覆盖已 `started` 的记录**。1:N 部分失败时，失败结算会把同批成功成员的
  `memberIds`/`pids`/`slots` 一起冲掉（网络图丢边、探活再也看不到活成员）。修法：缺省只补记
  `reason`，仅 #58 恢复路径（那些成员确实已消失）显式传 `replaceStarted: true`。
- **`record === null` 时静默跳过群移除**：`groupId` 取 `record?.groupId ?? ''`，为 null 时
  `if (groupId)` 为假 → 成员**留在群成员表里**却已被本机撤登记与归档（AC4 不一致），
  且 `sendText('')` 静默失败。修法：退回登记表 `groupId` 兜底，两者都无则显式留痕。
- **底座拒绝 remove 只打日志**：#53 用 `recordAudit({result:'backend_rejected'})`，本路径没有。
  已补审计，与 #53 同源纪律。
- **猝死成员定位用 `recordFor` 首条匹配**：同一成员可能出现在多条 `started` 记录里（重派 / 递归），
  首条匹配会取到跟本次结算**不同**的那条 → @ 错主人、待领取 groupId 错。改为按 `target.dispatchId` 定位。
- **预留段尾段泄漏**：`releaseReserved` 定义了却全仓无调用点（为提前 break 路径准备的兜底）。
  已接上防御性收口。

## 已知缺口（如实记录）

- **pid 复用**：操作系统回收 pid 后可能分给别人，探活会假活 → 表现为**漏判**（不判猝死），
  不会误杀活成员。本机 MVP 接受这条偏保守的取舍，已在 `abnormal-exit.ts` 注释里写明。
- **跨机派遣成员**不在本票范围（ADR-0006：MVP 内整条派遣链落在根主人单机）。跨机成员的猝死
  判定需要远端信号，本票的 pid 探活只覆盖本机子进程。
- **未跑黑盒 rig**：本票的验证是 76 项单测（`hive/` 目录）+ typecheck + vendor 守卫 + 完整
  `vitest run`（898 例全绿）。真进程猝死的端到端 rig（杀 pid → 5s 内观察群消息与 health）
  未新增 —— 黑客松速度模式下按「最小冒烟」收尾，此处如实说明。

## 验证记录

- `vendor/teahouse` 完整 `vitest run`：**900 passed / 133 files**（含 #58 recovery 回归）。
- `tsc --noEmit -p tsconfig.node.json` 与 `vue-tsc --noEmit -p tsconfig.web.json`：均无输出（通过）。
- `node scripts/check-vendor-patches.mjs`：**patch surface OK — 503 baseline files, 0 violations**。
- `node scripts/check-doc-locales.mjs`：12 组中英文文档通过。
- 新增测试：`abnormal-exit.test.ts`（7）+ `dispatch-claim.test.ts`（6），覆盖
  pid 探活判据、旧账本无 pids 不误判、幂等、slot 归还、**正常终结后不再被判猝死**（C1 回归）、
  **1:N 第 1 个失败时 slots 逐位对齐**（C2 回归）、原主人判权、补派失败不丢任务、前置拒绝回滚 claim。
- `vendor/.hive/patch-allowlist.txt` 与 `provenance.json` 已只追加记账。
