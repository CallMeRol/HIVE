# local-api（回环第二前台，#44）

headless 与 GUI 节点都暴露一个**只绑回环**的 HTTP+SSE 控制面——与上游 `ipc/` 并列的第二前台
（ADR-0002 Decision 4）。实现在 `vendor/teahouse/src/main/local-api/`（Hive 新增命名空间，
白名单条目见 `docs/vendor/teahouse.md`），不 import electron：依赖全部由 `src/main/index.ts` 注入。

## 端点

| 方法 路径 | 作用 | 备注 |
|---|---|---|
| `GET /v1/health` | nodeId、nick、setupDone、udp/tcp/api 端口、群数、在线对端数、agent 开关 | 建群时要先把 agent 的 nodeId 抄给 GUI |
| `GET /v1/events` | SSE：事件信封 `{ v, seq, type, ts, data }` | `seq` 是**每条连接流**内单调递增，不跨流比较 |
| `POST /v1/messages` | `{ groupId, text, mentions?, replyTo? }` → 发一条群文本 | 复用 `GroupsService.sendText`；被拒（不在群里/超长）显式 409，不静默成功 |
| `POST /v1/dispatch` | `{ groupId, goal, count?, dispatcherDepth?, dispatcherId? }` → 派遣一个全新上下文成员（#51 / 1:N + 递归 #56） | 顺序 = 离线身份 → invite → set-admin 派遣者 → spawn headless → health 校验 nodeId（≤30s，不等即失败）；失败补试一次后任务转待领取（claimable）；`goal` 必填——新成员唯一的上下文来源（不注入父会话历史）。**`count` = 1:N 一次摇几个**（1–8，受并发上限约束）；各成员独立 spawn、独立结算，**无 barrier**：部分成功即成功，失败成员各自转一条 claimable（返回面 `tasks[]`），不拖住成功成员。**省略 `dispatcherDepth` = 用本节点自身的代数**（递归派遣：派遣成员在自己的深度上继续派；代数由父经 `HIVE_DISPATCH_DEPTH` 写入）。返回 `{ ok, outcome: { dispatchId, outcome, memberIds?, task?, tasks?, reason? } }`；前置拒绝与超限（深度/并发/slot 用尽）走 **409 + 可读 reason**，不静默降级。旋钮：`HIVE_MAX_DISPATCH_DEPTH`（默认 3）、`HIVE_DISPATCH_CONCURRENCY`（默认 5）。账本：`<userData>/hive/dispatch.json`（schemaVersion，含派遣关系/slot/claimable） |
| `POST /v1/lifecycle/quit` | 唯一**跨平台**优雅退出通道 | 先回 202 再走既有 `before-quit` 链（exit 广播、补发队列落库） |

无效输入一律 `type: "error"` 信封 + `{ code, message, details? }`，非 2xx；不静默忽略。
鉴权：设了 `PANTRY_LOCAL_API_TOKEN` 就要求 `Authorization: Bearer …`；空 = 仅回环可达即可信
（不自动生成 token，避免现场去 console 抄）。

### 为什么 `quit` 必须存在

Windows 无 SIGTERM：`child.kill()` 走 TerminateProcess，`before-quit` 链**不执行**，卡 10 的
「≥2s 优雅窗口」直接失效，对端要等 90s 才判离线。launcher 必须「**先 quit 后 kill**」并给 ≥3s。

## SSE 事件（当前子集）

批内冻结表见 `docs/contracts/parallel-development.md`。本 ticket 只生产：

| type | 生产者 | data |
|---|---|---|
| `message.new` | #44（本 ticket） | `messageId, groupId, senderId, kind(formal\|system), text, replyTo?` |
| `member.lifecycle` | #53（phase=`leave` 主人移出 / `orphan_removed` 孤儿清理）、#51（phase=`spawn_ok` 派遣成员上线）、#56（phase=`reanchor` 父退群后子挂靠最近活跃祖先）、#59（phase=`abnormal` runner 猝死异常退群） | `memberId, phase`；`reanchor` 另带 `reanchoredTo` + 重算后的 `depth` |
| `dispatch.event` | #51（outcome=`started` 派遣成功 / `claimable` 失败转待领取）；#56 递归派遣（`depth` 随活跃链递增）；#59（异常退群后 outcome=`claimable`，任务回待领取） | `dispatcherId, memberIds[], goalOneLine, depth, outcome` |
| `error` | #44 | `code, message, details?`（HTTP 面） |

其余 type（`acp.update` / `guard.verdict` / …）由各自 owner ticket 追加；
实现者可以增字段，不得改名或另起私有通道绕过。

`#53` 的 `member.lifecycle` 由主进程经 `HiveLocalApi.emit` 广播（#44 新增的转发出入口，**不是**第五个端点）；
移出/清理的**命令面**走 GUI IPC（`group:update` 的 `remove`），因为「谁能移出谁」是权限动作，与建群同源。

## env 契约（#44 消费项）

全表见 [issue #14](https://github.com/toRolex/hive/issues/14) §6；本 ticket 落地的是：

| env | 缺省 | 说明 |
|---|---|---|
| `PANTRY_HEADLESS` | 未设（GUI） | `1` = 无主窗节点（真 headless，不建窗） |
| `PANTRY_USER_DATA` | Electron 默认 | **每节点必填且独立**（单例锁按 userData 隔离，只改端口救不了） |
| `PANTRY_UDP_PORT` / `PANTRY_TCP_PORT` | 17878 / 17879 | 每节点独立 |
| `PANTRY_LOCAL_API_PORT` | 未设 → `0`（临时端口） | `0` = 临时端口，实际值以自检行/health 为准 |
| `PANTRY_LOCAL_API_TOKEN` | 空 | 空 = 仅回环即可信 |
| `PANTRY_PEERS` | 空 | 静态对端，**叠加**广播而非绕过 |

**自检行**（headless 启动后打印，smoke 与现场共用抓手）：

```
[headless] up nodeId=<id> udp=<n> tcp=<n> api=<n> agent=on|off
```

`PANTRY_SMOKE=1` 与 `--remote-debugging-port` 在 headless 下也走同一套自检行 + 无窗退出路径。

## 本机可重复验收

```sh
pnpm run e2e              # #44 两节点黑盒 rig（dev out/）
pnpm run e2e:multigroup   # #45 三节点多群 rig（dev out/）
```

两条 rig 共用 `scripts/lib/hive-rig.mjs`（Hive 自有，不受 vendor 守卫约束）：进程树、
local-api（health / SSE / messages / quit）、CDP 驱动真 renderer、断言记账与端口预检。
每个 ticket 的拓扑与断言留在各自的 rig 脚本里，不复制工具层。

- `scripts/hive-e2e.mjs`（#44，30 项断言）：真 GUI + 真 headless 两条节点跑五条 AC —— 起 headless
  （无窗、自检行、health）→ CDP 驱动真 renderer 走 `window.pantry.saveProfile` / `createGroup` /
  `sendGroupText` → 两侧 SSE 断言双向 `message.new` 与信封字段 → `POST /v1/lifecycle/quit` 后断言
  无残留进程（含 Electron Helpers）→ 同 `userData` 重启断言群与消息仍在。
- `scripts/hive-multigroup-e2e.mjs`（#45，57 项断言）：GUI（owner）+ 两个 headless 成员三节点，
  跑四条 AC —— 建两个成员互不相同的群、GUI 会话列表切换、群间消息与成员互不串流（含真 DOM 与真
  「发送」按钮路径）、重启后两群与全部消息完整恢复、直查 teahouse SQLite 三张上游表。
  另有一条纯界面建群路径（点 `+` → 选人 → 下一步 → 组名 → 创建），证明 AC1 的「可从 GUI 创建」
  不只是 IPC 面成立。

判据 = 退出码 0/非 0；**不抽通用 `up` 编排**——那是 #48 的交付物，`up` 落地后可直接包这一层，
不产生第二套实现。

`up` 已落地（#48，见 `docs/ops/launcher.md`）：`pnpm run hive -- up|status|doctor|down`。
它复用了本 rig 的两个工具层（`scripts/lib/hive-proc.mjs`、`scripts/lib/hive-node-config.mjs`），
没有第二套进程/端口/配置实现。launcher 的就绪判定比「health 200」更严——额外要求
`nodeId` 属本节点、udp/tcp 吻合、`net.ok === true`，正是为了挡住下面 landmine 1 的静默失败。

```sh
pnpm run e2e                   # dev 构建产物（out/）
pnpm run e2e:app               # 打包 .app
pnpm run e2e:multigroup        # dev 多群
pnpm run e2e:multigroup:app    # 打包多群
pnpm run e2e:hangar            # #52 机库（48 项断言）
pnpm run e2e:hangar:app        # 打包机库 rig
# 打包前先：
cd vendor/teahouse && ELECTRON_OVERRIDE_DIST_PATH="$PWD/node_modules/electron/dist" \
  ./node_modules/.bin/electron-builder --mac --arm64 --dir --publish never -c.mac.identity=null
cd vendor/teahouse/release/mac-arm64 && codesign --force --deep --sign - Hive.app
```

### rig 的两个读法陷阱（都会伪装成产品缺陷）

1. **直连 IPC 发的消息不进 renderer 消息缓存**。`window.pantry.sendGroupText` 只往库里写；renderer
   缓存只在 UI 自己的发送路径或「打开会话」时刷新。已选中该会话时再点它不会重载，读到的是陈旧
   缓存 —— 看起来像丢消息/串流。rig 里靠 `clickConv(name, via)` 强制一次真实切换来规避。
2. **自检行要等，不能只等 health**：自检行在 local-api `listen()` 的 `.then()` 里打印，而 HTTP 面
   在打印之前就可用。只等 health 就断言自检行会撞 race，要用 `rig.waitLine`。

## 成员移出与孤儿清理（#53）

`pnpm run e2e:member`（`scripts/hive-member-e2e.mjs`）跑四节点真拓扑：
A=群主（拥有 B）、C=另一个人类节点（拥有 D）、B/D=headless 成员、E=事后 SIGKILL 的孤儿。

- **权限两层**：Hive 语义闸门（`memberId → ownerId` 登记，仅主人可移出自己的成员）+ 底座群管理权
  （群主/管理员）。两层都过才放行；每一步拒绝都带明确 code（`not_member_owner` / `group_manage_denied` /
  `unknown_target` / `group_mismatch` / `dispatch_not_owner` / …），经既有 `group:update` 返回面回渲染层。
- **登记表**：`<userData>/members.json`（`schemaVersion`），逐成员记 `ownerId`/`kind`；判权前热重读，
  外部写入（#49 接入 / #51 派遣）立即生效。**这是「谁拥有这个成员」的唯一事实源**——底座看不到
  「agent 节点」与「人类节点」的区别，按「谁 invite 谁拥有」猜会把别人的成员记成自己的。
- **留痕**：`<userData>/hive/member-audit.jsonl`，append-only，成功/拒绝/底座拒绝三类都记。
- **被移出节点**：headless 成员节点收到群 info 判定自己已被移出 → 优雅退出（GUI 节点只离群不退 app）。
- **孤儿判定**：目标节点整体死亡（registry 判离线）才走 `orphan_removed` 路径；`PANTRY_OFFLINE_AFTER_MS` /
  `PANTRY_PRESENCE_INTERVAL_MS` / `PANTRY_SWEEP_INTERVAL_MS` 允许整体压缩 presence 时序（默认 90s），
  三个必须**同轴**设置，单独压 `offlineAfter` 会让所有对端假离线。

## 机库（#52）


机库是「每成员看过程」的地方（ADR-0008 / CONTEXT「机库」）：活跃 / 归档两区，成员下按会话、
会话内按 turn 的**原始时间线**，类型过滤 + 全文搜索，不加工不总结。

| 方法 路径 | 作用 |
|---|---|
| `GET /v1/hangar` | 静态机库页面（自包含 HTML，headless 与 GUI **同源**） |
| `GET /v1/hangar/overview` | 成员 → 会话（含归档区）总览；`nick`/`burden` 由主进程装饰 |
| `GET /v1/hangar/timeline?memberId&sessionId&kinds&q&limit` | 原始账本行（类型过滤 + 全文搜索） |
| `GET /v1/hangar/markdown?memberId&sessionId` | 该会话的 Markdown 时间线（turn 结算时写） |
| `POST /v1/hangar/clear` | **唯一写面**：`{memberId, actorId}` → 归档旧实例 + 纪元递增 + 目标待重定 |

- **读取面**（overview/timeline/markdown）只读账本；写归 #46 的 `SessionLedger`（append-only）
  与机库唯一写者 `Hangar.clear`。未知成员显式 404，不假装空机库。
- **`clear` 在 local-api 而非只走 GUI IPC**：归档索引与账本**必须同机**（契约：落 artifacts
  root 下 per-member 目录），而成员实例可能是本机**另一个 headless 节点进程** —— 只有那个进程
  能归档它自己的账本。`actorId` 由调用方声明，目标节点用它对照自己的成员登记表判权
  （非主人 → 403，fail-closed）。
- **headless 不建窗但机库可读**（ADR-0002）：`GET /v1/hangar` 在 headless 节点上照常 200。
- **GUI 独立窗口**：`hive:open-hangar` 开第二个 BrowserWindow，直接加载上面的页面 —— 复用同一份
  机库实现，且主窗 renderer 静态闭包**零增长**（体积门已被 #46 顶到只剩约 1 KiB）。headless 下
  该 IPC 恒 `{ok:false, reason}`。

## 已确认的两个 landmine

1. **残缺的 `config.json` 会静默杀死发现**。预置配置文件时必须写**完整字段集**：只写一两个字段
   （如只有 `autoLaunch`）时，packaged 节点会 `net.ok=true`、`peers=0`、**零报错**，怎么等都发现不到
   对端；补全字段即恢复。#48 做声明式配置预置时同样要小心（#44 只在本机 rig 里踩到）。
2. **`--remote-debugging-port` 会拖住 GUI 进程的 `before-quit`**。无 CDP 时 `POST /v1/lifecycle/quit`
   实测 1s 内退出；带 CDP/devtools 连接时会被拖过 3s（headless 不受影响，始终 ≤100ms）。
   故 e2e 对 GUI 用宽窗口判「最终干净退出」，headless 按 ADR-0002 的 ≤3s 硬判。
