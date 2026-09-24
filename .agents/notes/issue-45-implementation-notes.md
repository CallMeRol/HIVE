# Issue #45 实现记录

## 目标

让用户在同一个 Hive APP 中创建和切换多个彼此隔离的群，并在重启后恢复全部群和消息。

四条 AC：① 可从 GUI 创建至少两个群并在群列表中切换；② 不同群的成员和消息不会串流；
③ 重启 APP 后多个群及其消息完整恢复；④ 群、身份、成员和消息继续使用 teahouse 的权威模型与存储。

## 结论：底座已具备，本票交付的是「证明」+ 两处 tooling 修复

teahouse 底座的群模型本来就是多群的：`groups` 表以 `group_id` 为主键、`GroupMeta.members` 是成员数组、
消息按 `conv_id`（`group:<groupId>`）分区、`createGroup` / `GroupRepo.list()` / `convRepo.ensureGroup`
都天然支持 N 个群。#44 的 e2e 只用了一个群，于是隔离与多群恢复**从未被验证过**。

因此本票的主体是 `scripts/hive-multigroup-e2e.mjs`：三节点真黑盒 rig，逐条把 AC1–AC4 钉成可复跑断言。
产品代码零改动 —— 没有新增群协议、没有第二套存储，符合并行契约「群协议复用 teahouse、禁止自建群协议表」。

## 决策

- **三节点拓扑**：GUI（owner）+ 两个真 headless 成员（agent-a / agent-b）。两个成员分别只被请进一个群，
  这样「成员不串流」有结构性证明 —— 不是断言 GUI 的显示，而是断言 agent-a 的 SSE 流里根本没有群B 的消息。
- **AC1 双路径**：先走 `window.pantry` IPC 面建两个群（快、稳、便于后续断言），最后**再走一遍真界面**
  （点 `+` → 勾选成员 → 下一步 → 填组名 → 创建）建第三个群。AC1 说的是「可从 GUI 创建」，
  只验 IPC 面不足以证明人点得出来。
- **AC2 三层证明**：① 成员侧 SSE 无泄漏；② 每个成员按自己的 groupId 回执、回流不串群；
  ③ 真 DOM + 真「发送」按钮 —— 切换会话后读真气泡文本，证明人可见的那一层也不串流。
- **AC4 直查上游库**：用 `sqlite3 -json` 读 `chat.db` 的 `groups` / `messages` / `conversations` 三张上游表，
  证明数据确实落在 teahouse 权威 schema 上，而不是 Hive 侧自建的影子表。
- **抽 `scripts/lib/hive-rig.mjs`**：#45 需要 #44 已有的全部工具（进程树、local-api、CDP、断言）。
  复制 600 行会让两条 rig 各自漂移，故抽共享工具层，#44 的 rig 一并改用它（回归断言数不变，仍 30 项）。
- **不新增 local-api 端点**：建群/切群是带 owner/admin 权限语义的 GUI 动作，且绕过 renderer 会削弱
  AC1 的证明力。local-api 保持 #44 的严格 4 端点。

## 修复的两个 tooling 缺陷（都不是产品 bug）

1. **`up()` 漏了 `PANTRY_HEADLESS=1`**。重构进共享层时丢了真 headless 开关，所谓「headless 节点」
   其实是普通 GUI 节点（因为带 CDP 参数，自检行不打印而只在 health 上暴露）——
   功能照样跑通，但验的不是 ADR-0002 Decision 2 的路径。现在 `headless: true` 必须显式给，
   且与 CDP 同时要求时直接抛错（自相矛盾）。
2. **`waitForPeer` 只等第一个 peer**。三节点场景里等一个就返回，建群时第二个成员还没进 registry，
   表现为间歇性「找不到人」。现在接受数组语义，要求**全部**在线才返回。

## 已确认的 rig 读法陷阱（会伪装成产品缺陷）

1. **经 CDP 直连 IPC 发的消息不进 renderer 缓存**。`sendGroupText` 只写库；renderer 缓存只在 UI 自己的
   发送路径或「打开会话」时刷新。若该会话已是选中态，再点它不会重载 —— 读到陈旧缓存，看起来像**丢消息**。
   这正是第一次跑时 `群B 只显示群B的消息` FAIL 的原因（缺了最早那条 textB），靠强制一次真实切换解决。
2. **自检行在 health 之后才打印**：开发过程中还撞到一次自检行 race，改为 `rig.waitLine` 轮询等行。
   这条是 rig 自身的时序问题，已在共享层修掉。

两者都写进了 `docs/local-api.md`。

## 验证记录

| 项 | 结果 |
|---|---|
| `pnpm run e2e:multigroup`（dev out/） | **57/57** |
| `pnpm run e2e:multigroup:app`（packaged .app） | **57/57** |
| `pnpm run e2e`（#44 回归，重构后） | **30/30** |
| `pnpm run e2e:app`（#44 回归） | **30/30** |
| `pnpm run check:vendor` | 503 baseline files，**0 violations** |
| `pnpm run test:guard` | 21 pass / 0 fail |
| `pnpm run typecheck` | 通过（tsc + vue-tsc） |
| `pnpm run test` | 126 files / **842 tests 全过** |
| `codesign` | ad-hoc（`flags=0x2(adhoc)`、`TeamIdentifier=not set`）|

## 过程中踩到的环境坑（非本票交付物，记录备查）

- **误触发的 pnpm install 弄坏了 vendor 树**：跑 `cd vendor/teahouse && ... electron-builder ...` 时，
  `cd` 生效后紧跟的另一条命令被 pnpm 当作在该目录下执行，于是在 `vendor/teahouse/` 里生成了
  `pnpm-lock.yaml` / `pnpm-workspace.yaml`（**守卫正确拦下了**），并抹掉了 `node_modules/electron/dist`
  与 `path.txt`（electron postinstall 产物，守卫不覆盖，故静默）。
  清理两文件后守卫恢复；`dist` 从 `~/Library/Caches/electron/…/electron-v22.3.27-darwin-arm64.zip`
  解压并按 installer 语义写回 `path.txt` 恢复（installer 直接跑会走网络且失败）。
  教训：打包命令不要用 `cd` 进 vendor 树，用绝对路径。

## Deviations

- 未写新增单测：按用户「黑客松速度模式」指令，只为最关键 AC 保留验证，且全部收敛进真节点端到端 rig
  （比单测更能证明 AC2 的「不串流」——那是个关于**没发生什么**的断言）。上游既有 842 项测试原样保留、全部通过。
- 未跑 `/code-review` 深度评审，改为按用户指令做「能跑通的自查」：守卫、守卫单测、typecheck、
  上游全量测试、四条 e2e 模式（dev/app × #44/#45）。
- 产品代码零改动：AC1–AC4 全部由底座既有能力满足，本票只补验证与 tooling。这意味着**本票不改变白名单**、
  vendor 补丁面不变（→ 无需更新 `docs/vendor/teahouse.md` 与 `provenance.json`）。
