# Issue #53 实现记录

## 目标

让主人从 GUI 安全移出常驻成员、并在节点整体死亡后由授权 admin 清理孤儿，不误伤其他群/其他主人的成员。

## 决策

- **「主人」= 该成员的主人（人），不是群主**。CONTEXT「移出」+ ADR-0006 Consequences
  （「派遣者的 admin 只是服务性回收权…『移出仅主人』针对人对成员的口径不变」）钉死了这一点。
  因此判权是**两层**：Hive 语义闸门（`memberId → ownerId` 登记）+ 底座群管理权（群主/管理员）。
  两层各给不同拒绝码（`not_member_owner` / `group_manage_denied`），否则第二层会掩盖第一层、AC4 测不出来。
- **不新开 IPC 通道，也不加 local-api 第五个端点**。移出复用既有 `group:update`：Hive 判权塞进该 handler，
  拒绝以 `{ hiveDenied, code, reason, stage }` 从原返回面回传。理由：#44 已定「带权限语义的动作走
  renderer IPC，local-api 严格四端点」；`hiveDenied` 判别位让拒绝值在结构上不可能与 `GroupView` 混淆。
- **登记表是成员级（不含 groupId）**。主人是人对成员的关系，不随群变；同一个成员被拉进第二个群时主人不变，
  记 groupId 反而制造「跨群误删」误判。只有 `kind=dispatched` 保留 groupId 作跨群护栏。
- **刻意不按「谁 invite 谁拥有」猜主人**。底座看不到「agent 节点」与「人类节点」的区别，猜错会把别人的
  成员记成自己的，与「每个成员恰有一个主人」直接冲突。生产侧写入归 #49（人接入）/ #51（派遣），
  它们落地前由 `PANTRY_MEMBER_REGISTRY` 播种（路径或内联 JSON，与 `PANTRY_PEERS` 同属本机联调面）。
  登记表**判权前热重读**，外部写入立即生效。
- **必须回查底座结果**。`groups.updateGroup({kind:'remove'})` 对「不在群里的目标」会过滤后返回 view
  而不报错（假成功）——判权通过后回查目标是否真的从成员表消失，否则记 `backend_rejected`，不假装成功。
- **被移出节点退出进程挂在 `services/groups.ts` 的远端 info 分支**（`removed` 事件），不是主进程的
  remove handler：只有**被移出的那个节点**才知道自己该收工。headless 成员节点退 app；
  GUI 节点是人的客户端，只离群不退 app。退出走既有 `before-quit` 链，不另开第二套退出通道；
  且必须 `setImmediate` 让出一轮事件循环——同步在 UDP 收包回调里进 `before-quit` 链会走不完
  （实测 `app.quit()` 被调用但进程存活）。
- **presence 时序 env 覆盖三参数同轴**（`PANTRY_OFFLINE_AFTER_MS` / `_PRESENCE_INTERVAL_MS` /
  `_SWEEP_INTERVAL_MS`）：孤儿判定自然口径是 90s 失联。单独压 `offlineAfter` 会让所有对端立刻假离线。
- **renderer 只做展示**：拒绝原因用主进程回传的 `reason`（已是人话），不在 renderer 复制一份文案表
  ——renderer bundle 预算只剩几十字节余量。

## 验证记录

- `node scripts/hive-member-e2e.mjs`：**27/27 断言通过**（四节点真拓扑）。
  - AC1：A 移出 C 的成员 D → `not_member_owner` + 「只有该成员的主人可以移出」，成员表未变。
  - AC2：A 移出自己的 B → B 离群 + 自行退出进程（alive=0，含 Helpers）+ 成员表消失。
  - AC3：E 登记为 A 的成员 → SIGKILL 整棵树 → A 判离线 → 群主 A 清理孤儿成功。
  - AC4：先 A 移 D 被拒（不误删他人成员），再 A 授 C 群管理员后 C 移 D 成功且只删 D。
  - AC5：两条 `member.lifecycle`（`leave` / `orphan_removed`）经 SSE 广播；
    GUI 面为真 renderer 的 `window.pantry.getGroup` / `updateGroup`。
- `node scripts/hive-e2e.mjs`（#44 回归）：**30/30 通过**。
- `vitest run src/main/hive/`：15/15（判权纯函数拒绝码矩阵）。
- 上游全量 `vitest run`：127 files / **857 tests 全过**（上游 842 + 本票新增 15）。
- `tsc -p tsconfig.node.json` + `vue-tsc -p tsconfig.web.json`：通过。
- `pnpm run check:vendor`：503 baseline files、0 violations；`pnpm run test:guard`：21/21。
- `bash scripts/check-authoritative-specs.sh`：全部通过。

## 已知问题（非本票引入）

- **`check:renderer-bundles` 的 App.vue JS 预算已超**。在本票 base commit（23c58e4）上把本票
  renderer 改动 stash 后重测仍是 **819245 > 819200 字节**（超 45 字节）；带本票改动为 819353。
  即该预算在 #44 合并后就已经破了，不是 #53 引入。`pnpm run build` 因此在本分支非零退出；
  本票用 `electron-vite build` 直接出 `out/` 跑 e2e。
  建议由拥有 renderer 模块写权的 ticket（#57 或发布票 #62）把 `App.vue` 的 `js` 预算随版本上调并记账。

## Deviations

- 按用户「黑客松速度模式」指令：不写非必要测试。新增验证只有两处——判权纯函数的 15 例拒绝码矩阵
  （AC1/AC4 的每条分支）与一条四节点端到端 rig（AC2/AC3/AC5 只能真跑）。跳过快照/边界/组件测试。
- 未跑 `/code-review` 深度评审，改为「能跑通的自查」：守卫、双 typecheck、上游全量测试、
  两条 e2e + 权威规格脚本。
- `PANTRY_EXIT_ON_REMOVED` 最终**不做**成 env 开关：被移出即收工是 headless 成员的正确语义，
  留一个默认关闭的开关等于默认不满足 AC2。设备分支改用 `HEADLESS`（本就存在的常量）。
