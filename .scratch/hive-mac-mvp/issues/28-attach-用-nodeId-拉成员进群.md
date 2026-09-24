# 28: attach 编排用 nodeId 拉成员进群（消除 memberId 幽灵条目与「接了不进群」）

GitHub: —（本会话直接发布）

Status: needs-triage
Implementation: merged（e2e claude 全链路 PASS；AC5/codex 失败项为 #30 与本机环境问题，见 Comments）
Blocked by:

## What to build

修复 attach 编排的拉群缺口：GUI 接入对话框把成员接进指定群后，成员进程要**真正进群**——
不需要主人再手动拉一次。

## Problem Statement（现场实测，#49 live）

主人在 GUI 里把 Claude Code 成员接进群「launch-plan」后：

- GUI 侧群成员表多出一条 `claude-1790237866324-17978` 的**幽灵条目**（它不是任何节点的
  nodeId，网络层没人认领，最终要靠 #53 孤儿清理才消失）；
- 成员进程自己的 `groups=0`——它不认为自己在这个群里，群消息收不到、被 @ 不触发 turn；
- 主人必须手动再补一次 invite（这次用真 nodeId），成员才 `groups=1`、turn 链路才通。

原因（机制链，已在代码核实）：

1. 群成员表与一切入群判定（`amMember`、bridge 回复发消息的 `sendText` 门）用的都是
   **nodeId**；
2. attachMember 的 invite 发生在 **spawn 之前**（ADR-0006「先 invite 后起」），此刻成员
   节点还不存在、nodeId 还未生成，编排手里只有 memberId（`<runtime>-<ts>-<port>`）；
3. 于是 invite 把 memberId 塞进群表 —— 一个永远无人认领的幽灵；成员节点起来后收到的
   群 info 里没有自己的 nodeId，`groups=0`。

spawn 前的 memberId invite 实际上是**死代码 + 幽灵制造者**：它对成员入群零作用。

## Solution

把「拉进群」挪到成员节点就绪**之后**、以 health 校验拿到的 **nodeId** 执行：

1. spawn 前不再 invite（删除 memberId invite；主人登记 register 仍保留 spawn 前——
   它记的是 Hive 本机账本，不是群表）；
2. `waitHealth` 成功拿到 `nodeId` 后，若 `request.groupId` 非空，用 nodeId 走既有
   `updateGroup(invite)` 拉进群；
3. invite 失败 → 走既有全有或全无回滚（unregister + kill 子进程 + 清账本），返回
   可操作错误；
4. 成功后在接入账本与 AttachResult 中带上群关系事实（成员 health 的 `groups` 计数
   可作二次确认）。

ADR-0006「先 invite 后起」的原始理由（离线补发队列消「已起未入群」中间态）在 nodeId
invite 下自动成立：节点已在跑，invite 即收群 info，无中间态。

## User Stories

1. 作为群主，我想在 GUI 里把 agent 成员接进指定群后它立即真正入群，以便不用再手动补拉。
2. 作为群主，我想在群里 @ 刚接入的成员就得到回复，以便接入即用。
3. 作为群主，我想群成员表里不出现无法认领的幽灵条目，以免误以为有成员在线。
4. 作为群主，我想接入失败时（含拉群失败）得到明确报错且不留半拉成员，以便放心重试。
5. 作为运维者，我想成员进程的 health `groups` 计数与 GUI 群表一致，以便用 status 排查。
6. 作为开发者，我想 e2e 从**成员进程视角**断言入群（health.groups ≥ 1），以便此类
   「GUI 侧看似成功、成员侧实际没进」的缺口被测试抓住。
7. 作为开发者，我想重启恢复（recovery respawn）路径与首次接入行为一致，以便成员重启后
   群关系可预期（恢复路径当前 `groupId: ''` 的语义不变，但同一编排函数内两行为不应分叉）。
8. 作为 #53 判权的使用者，我想主人登记表与真实群成员表没有「幽灵 id」干扰，以便孤儿
   清理只处理真实对象。

## Implementation Decisions

- 修改 module：attach 编排（`hive/agent-attach.ts`，白名单内）。invite 的执行时机从
  spawn 前移到 `waitHealth` 成功后；`inviteToGroup` 依赖签名从 `memberId` 语义改为
  传入即群表成员 id（调用点改传 `health.nodeId`），接口形状不变。
- 回滚语义保持「全有或全无」：nodeId invite 失败 = 接入失败， unregister + 终止子进程 +
  不落 attach 账本。错误文案与 hint 沿用既有「拉群失败」样式。
- AttachResult 新增字段**不做**：既有 `nodeId`/`groupId` 信息已足够 GUI 回显；避免
  契约面扩散（`src/shared/ipc.ts` 不动）。
- 幽灵清理不另做：修复后不再产生新幽灵；存量幽灵由 #53 孤儿清理自然消解（live 已验证
  `orphan_removed` 生效）。
- recovery 重放（`index.ts` 的 respawn，白名单内）不改 `groupId: ''` 语义：账本仍不存
  groupId，重启后由主人在 GUI 补拉——这与 #58 的既有决定一致，本票只在注释里把该边界
  写明，防止下一个人把两处行为混同。
- 端口探测修复（port-probe 抽模块 + 异步语义）已在本次会话落地并通过全量测试，不在
  本票范围，但作为同一 live 排障的产物在 Comments 留痕。

## Testing Decisions

- **seam 沿用 #49 既有黑盒 rig（hive-attach-e2e）**，不新建 seam。补两类断言：
  1. 接进指定群后，轮询**成员自身** health（rig 已有 waitHealth 面）直到
     `groups >= 1`——这是「真正进群」的唯一权威信号（用户症状的直接对应）；
  2. GUI 群成员表在接入完成后**恰好**包含该 nodeId、且**不**包含 memberId 形态的条目
     （`/^<runtime>-\d+-\d+$/`）——锁死幽灵条目不再产生。
- 单测（agent-attach 既有注入式 deps 风格，先例：attach 校验单测）：注入 `inviteToGroup`
  记录调用参数，断言 spawn 前零调用、health 成功后恰一次且参数为 waitHealth 返回的
  nodeId；invite 返回 false 时断言 unregister 与子进程终止都被调用。
- e2e 全量（attach rig 两种 runtime 路径）回归，判据 = 退出码。

## Out of Scope

- 端口探测/分配（已另行落地）；#53 判权与孤儿清理逻辑本身；派遣（#51）的群关系语义；
  接入账本 schema 变更；跨机（三机）场景。

## Further Notes

- 现场证据：GUI 群表幽灵条目 + 成员 `groups=0`；手动以 nodeId 补 invite 后成员
  `groups=1`、@ 派单得到真实回复（replyTo 正确）——修复目标即把「手动补拉」这步消掉。
- 审计留痕：`member-audit.jsonl` 里 `orphan_remove ok (claude-…-17978)` 证明幽灵最终被
  孤儿清理回收，但这发生在接入之后数分钟，期间群里一直挂着不可用成员。

## Comments

- 2026-09-24 由 #49 live 排障会话直接发布（问题现场 + 机制链 + 修复方向已核实）。
- 2026-09-24 实现 Deviations：
  - Solution 第 4 点「成功后在接入账本与 AttachResult 中带上群关系事实」**未做**——
    按 Implementation Decisions 的优先决定（AttachResult 零新字段、账本 schema 不动）
    执行，两段自相矛盾处以 Decisions 为准；群关系事实改由 e2e 从成员 health.groups
    断言（实现说明见 agent-attach.ts 第 5 步注释）。
  - 通用 catch 回滚从「撤登记」扩为「撤登记 + kill 子进程」：spawn 后任何异常都应
    全有或全无，与 invite 失败路径同口径（hint 文案同步改为「子进程已终止」）。
  - e2e「恰好包含」落为「该 nodeId 恰出现一次 + 无 memberId 形态条目」——群表成员数
    是动态的，「恰好」无法对总数断言。
  - 遗留（非本票）：AC4 静态断言 `!/confirmKey|pendingConfirm|确认键/.test(bridgeSrc)`
    被 agent-bridge.ts 的 #50 注释命中，HEAD~1 即如此，属 e2e 自身过时（bridge 只在
    注释里提到确认键，无实现）——本票顺手修为「只查代码行」。
  - e2e 排障发现（非本票引入，rig 侧修复）：turn 假失败的根因是 **@ 走了离线补发回放**——
    mentions 不落消息表（agent-bridge.ts 头注释「绝不能查库回放」），成员直连未就绪时
    发的 @ 回放进来永远不带 mentioned，bridge 不触发 turn。rig 修为发 @ 前先等成员
    `health.peers>=1`（直连就绪）。产品侧是否要给「回放 @ 丢失 mentioned」补一个
    通知面，另开票。
  - 遗留（#49 面，非本票）：AC5 usage 断言——成员 turn 成功后 `usage_update` 未达
    bridge（成员 session ledger 只有 turn 前两条 update），负担行 stale。与本票无关，
    rig 改为该断言失败显式 FAIL 收场、不炸 rig。另开票排查。
  - 同 commit 前置：端口探测 port-probe 抽模块（#49 live 排障产物）先行落账
    （commit 98c0898），本票只做 invite 时机修复。
