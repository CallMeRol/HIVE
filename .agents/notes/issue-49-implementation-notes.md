# Issue #49 实现记录

## 目标

让用户通过 GUI 把本机已有的 Claude Code 与 Codex 接入群，分别完成真实 turn，并得到明确的环境诊断。

## 决策

- **接入 = 起一个真节点**，不是在本进程里再塞一个 runner。CONTEXT.md 定「成员表一条 = 一个独立
  agent 进程」，身份与上下文窗口都要隔离。顺序照 ADR-0006「先 invite 后起」：
  建独立 userData → 写完整字段集 config → 注册成员主人 → invite 进群 → spawn headless 节点 →
  等 /v1/health 并校验 nodeId。
- **不预置 `identity.json`**：缺失时节点自生成（`app-state.ts`），这才是「每次新建身份、
  永不复用」的落点；预置一份会引入 nodeId 撞车。
- **config.json 必须写完整字段集**（#44 landmine 1）：残缺 config 会让节点 `net.ok=true`、
  `peers=0`、零报错。运行期不能跨出 vendor 树去 import 仓库根的 `hive-node-config.mjs`，
  故在 `agent-attach.ts` 按同一份字段集复刻并保持与上游 `ConfigFile` 逐字段对齐。
- **模型与 permission 枚举来自 adapter 自报**：给 runner 加一次性 `probe` 命令，只握手不发 prompt，
  把 `session/new` 的 `configOptions` 原样带回。**不硬编码清单** —— adapter 升级换模型名时自动跟随。
  实测两组分别是 `category: "model"` 与 `category: "mode"`，按 category 取而不是按 id 字符串匹配。
- **AC4 两条正交面**：
  - ACP permission = **agent 发起、逐次工具请求、runner 机器应答**（`runner.mjs` 的
    `request_permission`）。从硬编码全拒改为按 `--permission` 策略应答，**缺省仍 fail-closed**；
    应答只进 stderr 人读日志，不进群。
  - Hive 确认键 = **人发起、逐任务「空闲→开工」审批**，属 pending（#50）。
  - 本票只需不把两者接到同一条路径：bridge 源码里**不含** permission/确认键逻辑（rig 断言钉住）。
- **AC5 真实 usage 驱动负担**：`usage_update`（实测 `{used:12132,size:1000000}`）→
  `burdenReportFromUsage`（纯函数）→ `AgentStatusService.setLocalReport`。
  **只在未设 `PANTRY_AGENT_STATUS` 时接管** —— 确定性生产器是 #47 黑盒验收的可控输入，
  两者同时在场会让「谁说了算」不可解释；#47 的 e2e 全部显式设了它，故不破。
  拿不到可用 `used/size` 就整条不发，由 30s TTL 表达「没数据」，不伪造档位。
- **带 agent 的节点必须声明 `ag1`**：只在设了 `PANTRY_AGENT_STATUS` 时挂 ag1 的话，
  接入进来的成员在别人的成员表里**根本不 eligible**，真实 usage 报了也画不出环。
  故 caps 表达式加 `|| PANTRY_AGENT_COMMAND`。
- **接入对话框懒加载且不 import store**：主窗静态闭包有硬字节预算。更关键的是——
  懒加载组件若与主闭包共享模块，Rollup 会把 `App.vue` 的 facade 并进匿名共享块，
  manifest 里就没有 `src/App.vue` 这个动态入口，`check-renderer-bundles.mjs` 的
  四入口契约随之失效。故群列表由 `GroupPanel` 算好经 props 传入。

## 记账（ADR-0003）

白名单新增 `path` 6 条（acp 四文件 + agent-bridge + agent-status）、`new` 1 条
（`AgentAttachDialog.vue`）。`src/main/hive/**` 命名空间已在表内，两个新模块自动覆盖。
`provenance.json` 增 `byTicket."#49"` 分组；`docs/vendor/teahouse.md` 同步。

## 验证记录

- `pnpm run check:vendor`：503 baseline files，**0 violations**。
- `pnpm run typecheck`：tsc + vue-tsc **通过**。
- `pnpm run test`：守卫测试 21 例 + 上游 **857 例全过**（含新增 i18n 19 条英文模板后
  coverage/i18n 测试全绿）。
- `pnpm run build`：构建通过；renderer bundle 预算门**未过**（见下）。
- `node scripts/hive-attach-e2e.mjs`（本票新 rig）：**20/23 通过**，3 项失败，详见 Deviations。

## Deviations

- **AC3「两种 runtime 各完成一次真实群聊 turn」未验证通过**。
  探测链路的静态项全过（Node / adapter / CLI / 认证四项 `ok=true`，adapter 路径解析正确），
  但**真 ACP 握手在 Electron 主进程内超时**（`ACP runner initialize 超时（30000ms）`），
  同一个 runner.mjs 由 Node 直接跑（`/tmp/runner-diag.mjs`）**秒回 ready + probe_result**。
  差异指向 Electron 主进程 spawn 子进程的环境（PATH / Electron 自身二进制干扰），
  已定位但未在本次时限内修完：
  - 已修一部分：`nodeExe` 从裸 `'node'` 改为 `findExecutable('node')`（Electron 里裸 `node`
    会解析到它自己的二进制）；给 probe 的 AcpRunner 接上 `log`（runner stderr 是唯一线索）。
  - 仍待查：Electron 主进程 spawn 出的 runner 为何不 ready。未完成的调查**如实记在此**。
- **rig 里 codex 一项未跑**（默认两 runtime，本次只跑了 `--runtime claude`）。
  codex adapter 需从 npm 下载（`@agentclientprotocol/codex-acp`），执行外部包需用户授权。
- **`pnpm run build` 的 renderer bundle 预算门未过**：App.vue JS 闭包 820578 B > 819200 B。
  **该门在 main 上本就是红的**（干净基线实测 819561 B，已超 361 B）。本票已把自身占用压到最小
  （对话框懒加载 + CSS 从超限 120351 B 压回预算内），实测增量 +1017 B JS。
  与 #46 记录的「余量只有两位数字节」同源，属既有未决约束。
- **未跑 `/code-review` 深度评审**，按 owner 收尾指令改为「能跑通的自查」：
  守卫、typecheck、上游全量测试、#46 冒烟。

## 未决（不进本票）

- Electron 内真 ACP 握手超时的根因（AC3 的最后一步）。
- 打包产物内嵌 runner.mjs 与 adapter 属 #62（ADR-0004「依赖随 App 或离线包分发」）；
  当前 `runnerDir()` 按 `out/main/acp/` → `src/main/acp/` 顺序回退，dev 走源码树。
- 模型三层锁定（启动探测 / 仪表盘 override / 配置兜底）的仪表盘 override 面未实现。
