# Vendored teahouse（#43 / 父 SPEC #41）

Hive 以 **snapshot vendor** 方式冻结 teahouse 完整节点作为群聊与身份底座。
不走 GitHub fork 工作流；所有上游修改受文件级补丁白名单守卫。

## 来源与冻结（provenance）

权威机器可读账本：`vendor/.hive/provenance.json`。要点：

| 项 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/skyjt/teahouse.git` |
| tag | `v0.60.2`（2026-09-18 打在 `f6607ff`） |
| 冻结 commit | `f6607ff7120738e9c6e5b8e419151034e3ba1d06` |
| 引入日期 | 2026-09-23 |
| 许可证 | GPL-3.0-only（`vendor/teahouse/LICENSE`） |
| baseline tarball | `git archive --format=tar f6607ff…` = `5f3e005eea0d834a972cbc020931ca38e2f688755345d16b94caa627460d6fb9`（16,373,760 bytes） |
| baseline 文件数 | 503（上游 505 − `.github/**` 2） |
| per-file 账本 | `vendor/.hive/baseline.sha256` |

复算 baseline tarball：

```sh
git clone https://github.com/skyjt/teahouse.git /tmp/th
git -C /tmp/th archive --format=tar f6607ff7120738e9c6e5b8e419151034e3ba1d06 | shasum -a 256
```

**排除项**：上游 `.github/**`（ISSUE_TEMPLATE + release workflow）不进 vendor 树；
构建、测试、打包、许可证所需内容全部保留。`.github` 不在 manifest 中，
一旦在 `vendor/teahouse/` 下重现即按“未记账新增” fail-closed。

## 补丁面守卫

- 检查器：`node scripts/check-vendor-patches.mjs`（纯 Node 零依赖，可 `--root` 指定仓库）。
- 白名单：`vendor/.hive/patch-allowlist.txt`，文件级两条语义：
  - `path <file>`：上游文件，允许与 baseline 不同（修改/删除）；精确到文件，禁通配，禁目录级放宽。
  - `new <dir>/**` / `new <file>`：Hive 新增命名空间；**只**匹配 baseline 中不存在的路径，不能用来豁免上游文件修改。
- 违规（白名单外修改 / 删除 / 新增、manifest / provenance / allowlist 解析失败、账本缺失）→ 打印 `FAIL …` 并 `exit 1`。
- 检查器直接遍历 vendor 文件树，因此 vendored `.gitignore` 忽略的新增文件同样 fail-closed；仅跳过已知可再生目录（依赖、构建与 OCR 产物）。
- 测试：`node --test scripts/check-vendor-patches.test.mjs`（纯函数矩阵 + 真实 git fixture 端到端，21 例）。
- 重新生成 baseline（仅限刚解出的 pristine 上游树）：`node scripts/gen-vendor-baseline.mjs`。

### 当前白名单条目（补丁面）

| path | 用途（对应后续 ticket） |
| --- | --- |
| `src/main/index.ts` | 主进程入口：headless 7 hunk + local-api 装配（#44）、agent-status 装配（#47）、成员移出判权接线与 presence 时序 env 覆盖（#53）、GUI 接入面的 IPC handler 与接入编排装配（#49）、交接落盘/证据与接手闸接线（#54/#60） |
| `src/main/acp/protocol.ts`<br>`src/main/acp/runner.mjs`<br>`src/main/acp/session.ts`<br>`src/main/acp/index.ts` | runner 私有协议加一次性 `probe` 命令（#49：只握手不发 prompt，拿 adapter 自报的模型 / permission 枚举）；`request_permission` 从硬编码全拒改为按 `--permission` 策略应答（缺省仍 fail-closed）；`AcpRunner` 增 `probe()` 与 `permission` 选项 |
| `src/main/services/agent-bridge.ts` | 增 `emitUsage`（#49 AC5）：ACP `usage_update` 上报给成员状态通道，bridge 自己不算档位、不定阈值 |
| `src/main/services/agent-status.ts` | 增 `burdenReportFromUsage` 纯函数（#49 AC5）：`{used,size}` → `BurdenReport`，拿不到就不报（由 TTL 表达「没数据」） |
| `src/renderer/src/styles/tokens.css` | Hive 品牌换肤（#reskin）：去 teahouse 绿 → PRD §5 冻结的 `#0a0e17` + `#e94560`。唯一杠杆点，33 组件引用 `var(--primary*)` |
| `src/renderer/src/ui/naive-theme.ts` | 同上换肤的第二处（#56 补记）：naive-ui 的 JS 主题对象是硬编码 hex，不经 `var(--primary*)`，tokens.css 覆盖不到 → 按钮/输入框/弹窗仍是 teahouse 绿。两处必须同批换。深色档 body/card 同步落 `#0a0e17`/`#141a26` + `#e6edf3` 文字 |
| `src/renderer/src/ui/naive-theme.test.ts` | 该主题对象的既有断言锁死旧绿字面量；按品牌换肤意图改为断言 Hive 红（#56） |
| `src/renderer/src/CaptureApp.vue` | 截图窗 canvas 标注色兜底字面量（读不到 `--primary` 时用）：`#3d8b6b` → `#e94560`（#56） |
| `src/renderer/src/ui/capture-rendering.test.ts` | 该组件的既有断言锁死旧绿兜底字面量；同步改为 Hive 红（#56） |
| `src/main/hive/dispatch-store.ts`<br>`src/main/hive/dispatch.ts` | 派遣编排（#51 建、#56 扩）：1:N 整批预留 slot、成员级独立结算、递归派遣的深度传递（`HIVE_DISPATCH_DEPTH`）与端口带错开、父退群后子挂靠最近活跃祖先（`reanchor` / `recomputeDepths`）。`main/hive/**` 已整目录记账。#54/#60：可选输入交接 fail-closed 校验 + 落盘 `handoffs/` + 群内拒绝文案；输出交接（reclaim）校验与回收编排 |
| `src/main/hive/dispatch-store.test.ts` | 上述扩展的单测（#56）：整批预留、挂靠重算、端口带 |
| `src/renderer/src/components/MessageRow.vue` | 消息渲染组件（#57+） |
| `src/renderer/src/components/ChatPane.vue` | 消息流容器（#57+） |
| `src/renderer/src/components/GroupPanel.vue` | 群信息面板：移出拒绝原因的可见反馈（#53） |
| `src/renderer/src/components/GroupInviteDialog.vue` | `group:update` 返回面变宽后的防御性收窄（#53） |
| `src/renderer/src/components/PeerList.vue` | 通讯录成员行：绿/灰点就地升级为五档负担环（#47）；#60 仅改注释（环→右下角状态点，对齐视觉规范 §4） |
| `src/renderer/src/ui/contact-presence.test.ts` | 该组件的既有断言锁死了被替换的旧 DOM 字面量；按 #252 意图改为断言绿/灰点分支仍存在（#47） |
| `src/shared/ipc.ts` | IPC 契约面：`updateGroup` 返回面加拒绝码出口（#53）；`PeerView` 增 hive 私有 `burden` 字段 + 五档 tag 常量（#47） |
| `src/preload/index.ts` | `updateGroup` 返回形状扩为 `GroupView \| 拒绝原因`（#53） |
| `src/i18n/en.ts` | 移出拒绝原因的英文文案（#53）；pending/确认键/目标状态文案（#50） |
| `package.json` / `package-lock.json` | 依赖清单（#46+） |
| `src/main/services/groups.ts` | 群成员列表：跨机状态定向发送所需（#55+）；应用远端 info 后广播 `removed`（#53） |
| `src/main/services/agent-bridge.ts` | @ → turn 胶水（#46）；#50 增 pending 闸门（可选注入）与 `enqueueAggregate` 聚合 turn 通道；#60 增可选 `handoffGate`（开工前复验 `HIVE_HANDOFF_PATH`，fail-closed 零实质输出 + 群内拒绝 + handover 账本行） |
| `src/main/services/session-ledger.ts` | 正式消息分条账本（#46）；#60 增 `handover` kind（交接校验证据，机库可过滤/搜索） |

### 当前白名单条目（Hive 新增命名空间）

| new | 用途（对应 ticket） |
| --- | --- |
| `src/main/local-api/**` | 与 `ipc/` 并列的回环第二前台：health / 优雅 quit / 发消息 / SSE（#44）；`emit` 转发出入口（#53）；`POST /v1/dispatch` 可选 `handover` + `POST /v1/reclaim` 输出交接（#54/#60）。目录级条目只匹配 baseline 外路径，**不能**用来豁免上游文件修改；后续 ticket 逐条追加，仍拒绝 `path` 目录级放宽。 |
| `src/main/hive/**` | Hive 业务层：成员主人登记表 + 移出/孤儿清理判权（#53）；交接七节 + 产物 sha256 校验与拒绝文案 `handover.ts`（#54/#60）；接手闸证据类型 `HandoffEvidence` |
| `src/shared/hive-member.ts` | 移出拒绝码的三面共用形状（main / preload / renderer，单文件记账）（#53） |
| `src/main/services/agent-status.ts` | 跨机 agent 状态通道（发/收/自校验/TTL，#47）。**单文件条目**：同目录其余文件都是上游 `services/`，故不按目录记账。 |
| `src/main/hive/pending-core.ts`<br>`src/main/hive/pending-core.test.ts`<br>`src/main/hive/pending-service.ts`<br>`src/main/hive/pending-gate.ts` | pending 收集期状态机 + 权限判定（fail-closed）+ 本机持久化 + 路由闸门（#50）。`main/hive/` 目录已整目录记账（#53），这些文件按命名空间落入既有 `new src/main/hive/**` 条目。 |
| `src/renderer/src/stores/hive-pending.ts`<br>`src/renderer/src/components/HivePendingBar.vue` | 收集期药丸 + 目标状态徽标（A5）与 Pinia 投影（#50）。 |
| `src/main/acp/**` | ACP runner（官方 SDK，跑系统 node ≥22 子进程）+ 主进程侧托管 + fake ACP peer（#46）。 |
| `src/main/services/formal-message.ts`<br>`src/main/services/session-ledger.ts`<br>`src/main/services/agent-bridge.ts` | 正式消息分条（自然边界 + 3500B）、session 账本（JSONL/Markdown append-only）、@ → turn 胶水（#46）。 |
| `src/renderer/src/utils/markdown.ts`<br>`src/renderer/src/components/MessageBody.vue` | 群内统一 Markdown 渲染面：markdown-it（`html:false`）+ DOMPurify，异常回退纯文本（#46，ADR-0008）。`MessageBody` 被懒加载——其闭包会顶破上游 renderer 体积预算。 |
| `src/renderer/src/components/AgentAttachDialog.vue` | 接入对话框（#49）：选 runtime / 成员名称 / 工作目录 / 模型 / permission 策略，并展示探测结果与可操作错误。同样被懒加载；**不得 import store**（群列表经 props 传入）——懒加载组件若与主闭包共享模块，Rollup 会把 `App.vue` 的 facade 并进匿名共享块，manifest 里就没有 `src/App.vue` 这个动态入口，四入口契约随之失效。 |

**#53 未新开 IPC 通道**：移出复用既有的 `group:update`，把 Hive 判权塞进该 handler，
拒绝以 `{ hiveDenied, code, reason, stage }` 从原返回面回传（结构上不可能与 `GroupView` 混淆）。
不用 local-api 第五个端点：#44 已定「带权限语义的动作走 renderer IPC」。

`new` 条目按命名空间整目录记账（已记 `local-api/`、`acp/` 两个目录 + 若干单文件）；后续 ticket 逐条追加（fail-closed 驱动记账）。
边界约定：`vendor/teahouse/` = 上游快照（受守卫）；`vendor/.hive/` = 守卫账本；
仓库其余路径 = Hive 自有代码（不受本守卫约束）。

### 已记账上游文件修改（#46 增补）

| path | 用途 |
| --- | --- |
| `src/renderer/src/components/MessageRow.vue` | 文字气泡改用 Markdown 渲染（ADR-0008 群内统一渲染）；同时移除旧的 `textParts` + 表情拆分渲染路径。 |
| `package.json` / `package-lock.json` | 新增锁定依赖：`@agentclientprotocol/sdk@1.5.0`、`zod@3.25.76`（SDK peer，运行时硬依赖）、`markdown-it@15.0.2`、`dompurify@3.4.15`；devDep `@types/markdown-it@14.2.0`。 |

> **已决（#52 收口 #46 遗留）**：`scripts/check-renderer-bundles.mjs` 给 `App.vue` 的静态 JS
> 预算原为 819200 字节，#46 引入 Markdown 渲染面后实测 **819561** —— 该门**一直未通过**，
> 后果是 `pnpm run build` 失败、`out/` 停在 #46 之前，agent 链路因此从未在真节点上跑起来。
> #52 把预算抬到 **802 KiB**（819200 → 821248，实测 820034，余约 1.2 KiB），并按 ADR-0003
> 把 `scripts/check-renderer-bundles.mjs` 记进白名单。该脚本不在上游测试的锁定范围内（无
> 数值断言），抬高属显式决策而非放宽守卫。

> **#52 修正的两个 #46 缺口**（两者 acp-smoke 都测不到 —— 它直接跑源码、不经真实节点）：
> 1. `runner.mjs` / `fake-acp-agent.mjs` 是面向系统 node ≥22 的**裸 .mjs**，electron-vite 只编译
>    `.ts`，故 `out/main/acp/` 从来没有 runner 入口 → 任何真节点上 bridge 都只打印
>    「找不到 runner 入口」并降级为「不回复的普通群成员」。新增 `scripts/copy-acp-runtime.mjs`
>    并接进 `build` 脚本（`out/**` 在 electron-builder 的 files 白名单内，故同时覆盖 dev/打包）。
> 2. `runner.mjs` 的 `ready` 事件只在**首个 prompt** 时发，而 `AcpRunner.start()` 是
>    `await waitForReady()`（默认 30s）→ 必然超时抛 `initialize_failed` 并降级。改为启动即握手，
>    失败走 fatal 信封 + 非零退出（与既有 fatal 通路同款）。

## 接线

- **pre-push**：提交的 `.githooks/pre-push` + 本机已设 `git config core.hooksPath .githooks`
  （repo-local，非全局；新 clone 重新执行该配置一次即可启用）。
- **CI**：`.github/workflows/ci.yml` —— `guard` job 跑补丁面检查与守卫测试；
  `vendored` job 跑 `npm ci` + typecheck + 上游 Vitest + build。

## 本机可重复入口（仓库根）

入口统一走 `pnpm run <script>`（本机策略禁止直接敲 `npm`）；
脚本内部用 `npm ci --prefix vendor/teahouse` 是刻意的 —— 上游锁文件是
`package-lock.json`，本地与 CI 都必须以 npm ci 做 lockfile 忠实安装，
不用 pnpm 重解析依赖。

```sh
pnpm run setup       # npm ci --prefix vendor/teahouse（安装 + electron rebuild）
pnpm run typecheck   # 上游 tsc + vue-tsc
pnpm run build       # electron-vite build + renderer bundle 检查
pnpm run test        # 补丁面检查 + 守卫测试 + 上游 Vitest（842 例）
```

## 上游按需同步（不维护 rebase/merge 链）

1. 记录新 tag/commit，下载新 tarball 记 sha256。
2. 清空 `vendor/teahouse/`，解新上游并删除 `.github/**`。
3. `node scripts/gen-vendor-baseline.mjs` 重生成 manifest；更新 `provenance.json`。
4. 按白名单**重贴**已记账补丁（旧 vendor 树可作对照）。
5. 全量回归：`check:vendor` + `test:guard` + `typecheck` + `test` + `build` + headless smoke。
6. 任一步失败 → 回滚到同步前状态；不保留半成品。

## 许可义务

demo 阶段不对外分发，遵循上游 GPL-3.0-only 现有义务（保留 LICENSE、THIRD_PARTY_NOTICES）；
若赛后发布，vendored 树按 GPL-3.0-only 完整义务处理（提供对应源码）。
