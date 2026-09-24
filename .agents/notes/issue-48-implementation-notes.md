# Issue #48 实现记录

## 目标

让用户用一套声明式配置启动、检查和彻底停止当前 Mac 上的 Hive GUI 与 headless 节点。五条 AC：
① up 等全部节点 health 就绪后才成功退出；② status 展示节点、端口、进程实际状态；
③ doctor 检查 Node / 端口 / 数据目录 / 基础节点配置并给可操作诊断；④ down 优雅退出且无残留；
⑤ 命令失败返回非零，GUI 启动失败时也有可操作说明。

## 交付物

- `scripts/hive.mjs` —— CLI 入口（up/status/doctor/down、`--json`、`--timeout`、`-c`）
- `scripts/lib/hive-launcher.mjs` —— launcher 核心（配置校验、就绪判定、回滚、体检）
- `hive.config.example.json` —— 配置模板；根入口 `pnpm run hive -- <cmd>`
- `scripts/lib/hive-proc.mjs`、`scripts/lib/hive-node-config.mjs` —— 从 #44/#45 的 rig 里抽出的共享工具层
- `scripts/hive-ops-e2e.mjs` —— 43 项断言的黑盒验收（`pnpm run e2e:ops`）
- `docs/ops/launcher.md` —— 使用与排错

## 关键决策

- **边界锚在并行契约**：模块所有权表把「声明式配置 + up/status/doctor/down」判给 #48，并明令
  「禁止在业务模块内复制健康检查逻辑」。故健康检查只有一处实现——local-api 的 `GET /v1/health`（#44）；
  launcher 从不 parse 上游 SQLite、不读节点内部状态、不改 vendor 树（补丁面零变化）。
- **就绪 ≠ HTTP 可连**：判定为 `health 可用 ∧ nodeId 属本节点 ∧ udp/tcp 吻合 ∧ net.ok`。
  后两条是为挡住 #44 实测出的 landmine——残缺 config 会让节点 `net.ok=true`、`peers=0`、零报错。
  只按「health 200」判定会把这个静默失败放行成「就绪」。
- **全有或全无**：任一节点未就绪，就地回滚已启动的全部再非零退出。现场最怕半拉环境
  （GUI 起着、成员没起），比彻底失败更难排查。
- **抽共享工具层而不是复制**：#45 的教训是复制会让多条 rig 各自漂移。进程树/进程组、端口归属、
  完整字段集 config 预置抽到 `scripts/lib/`，rig 侧 re-export 保住既有 import 面（回归断言数不变）。
- **验收只经真 CLI**：e2e 全程 `execFile(node scripts/hive.mjs …)`，看退出码与 stdout，
  不 import launcher 内部函数——验的是「用户敲的那条命令」。
- **doctor 不假装检查通过**：SPEC #41 里更深的一层（ACP initialize、模型探活、时钟偏差、adapter 文件）
  属 #49+，doctor 显式打印「本轮范围外」，而不是给绿灯。全绿 ≠ 现场就绪。

## 实现过程中发现的 5 个真缺陷（都靠 e2e 暴露）

1. **detached 子进程继承 stdout 管道 → `up` 永不返回**。最初用 `stdio: pipe` 收节点输出（照搬 rig），
   但 rig 自己是长命进程、launcher 是短命 CLI：节点活着就没人关管道，`execFile` 等不到 EOF，
   被自己的 180s timeout 杀掉，表现为「up 卡死」。改为节点输出写 `<dataDir>/node.log`
   （顺带成了现场第一手材料，也是 `api: 0` 时端口的唯一来源）。
2. **`.bin/electron` 是 wrapper node 脚本**，it 再 spawn 真 Electron。拿 `child.pid` 当节点 pid 会错位：
   杀 wrapper 不动 Electron，`pidAlive` 也测不到真实存活。改为 `require('electron')`（上游官方路径解析，
   跨平台）拿真二进制。
3. **`parseLsof` 重复 `slice(1)`**，把第一行数据当表头丢了 → 只有单个占用者时 `portOwners` 返回空。
   端口检测因此静默失效（表现：UDP 被占但 doctor 报「空闲」）。
4. **up 的 spawn 循环里状态文件攒到最后才写** → 第 2 个节点 spawn 失败回滚时，`down` 读不到第 1 个节点
   的记录，孤儿无人认领（e2e 里表现为「回滚后残留 gui.tcp」）。改为每起一个就落盘。
5. **`down` 按进程树判残留会假绿**：detached 组长退出后真 Electron 被 reparent 到 launchd，
   `aliveTree` 什么都找不到而端口还被占着。改为按端口归属判（认 executable 路径避免误杀），
   并补上组信号漏掉的兄弟进程。

## 验证记录

| 项 | 结果 |
|---|---|
| `pnpm run e2e:ops`（#48，dev out/） | **43/43**（连跑两次均通过、零残留） |
| `pnpm run e2e`（#44 回归，重构共享层后） | **30/30** |
| `pnpm run e2e:multigroup`（#45 回归） | **57/57** |
| `pnpm run check:vendor` | 503 baseline files，**0 violations**（补丁面零变化） |
| `pnpm run test:guard` | 21 pass / 0 fail |
| `pnpm run typecheck` | 通过 |
| `pnpm run test`（上游全量） | 通过 |
| 真实 up 耗时 | 3 节点冷启动 **1.3–1.7s** 全部就绪 |

## Deviations

- **未写新增单测**：按用户「黑客松速度模式」指令，只为最关键 AC 保留验证，全部收敛进
  `scripts/hive-ops-e2e.mjs` 这条真 CLI 黑盒 rig。上游既有测试原样保留、全部通过。
- **未跑 `/code-review` 深度评审**，改为按用户指令做「能跑通的自查」：vendor 守卫、守卫单测、
  typecheck、上游全量测试、三条 e2e（ops + #44 + #45 回归）。
- **未做 App 模式（`.app`）的 ops e2e 实跑**：`--app` 参数已支持并接进脚本，但本票未打包 .app
  （打包耗时，且 #44/#45 已在打包产物上验过同一条启动路径）。`hive.config.json` 的 `app` 字段与
  doctor 的 `.app` 结构/codesign 检查都已实现。打包后可直接
  `node scripts/hive-ops-e2e.mjs --app <X.app>` 复跑同一套断言。
- **Windows 未验**：本轮平台范围仅 macOS（并行契约「Mac Product Complete」）；`down` 的
  「先 quit 后 kill」与 local-api 唯一的跨平台退出通道已按 Windows 语义写好，待 #63 三机门验证。
