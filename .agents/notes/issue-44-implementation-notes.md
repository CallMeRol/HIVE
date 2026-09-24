# Issue #44 实现记录

## 目标

交付第一条完整 walking skeleton：从 Finder 启动 GUI、与独立 headless 成员互见并双向收发群消息、
loopback local-api（health / 消息 / SSE / 优雅 quit）、重启后群与消息仍在，以及基础 macOS .app。

## 决策

- **真 headless**：按 ADR-0002 Decision 2 走 `PANTRY_HEADLESS=1` 不建主窗，不动 `show:false` 降级。
  7 个 hunk 全部落在白名单文件 `src/main/index.ts`；`app.dock.hide()` 不需要（headless 下无 Dock 图标）。
- **local-api 严格 4 端点**：按 ADR-0002 Decision 4 只做 health / quit / messages / events，
  **不为测试加第五个建群端点**——建群是带 owner/admin 权限语义的 GUI 动作，且绕过 renderer 会
  削弱 AC2 的证明力（要验的恰是 renderer）。建群由 e2e 经 CDP 驱动真 renderer 的 `window.pantry` 完成。
- **CDP 驱动面是 `window.pantry`（IPC），不是 DOM 选择器**：renderer 重构不会弄脆验收；
  Node 22 自带全局 `WebSocket`/`fetch`，零新依赖。
- **e2e 一个脚本覆盖全部 5 条 AC**，两种模式（dev `out/`、packaged `.app`）；
  不抽通用 `up` 编排——那是 #48 的交付物，避免第二套实现。
- **记账三处联动**（ADR-0003）：`patch-allowlist.txt` 加 `new src/main/local-api/**`、
  `provenance.json` 加 `patchSurface`、`docs/vendor/teahouse.md` 表格，并记录「`new` 条目按命名空间
  整目录记账（已记两条）」的口径，避免后来者误以为裸 `dir/**` 合规。
- **打包不重命名**：AC5 只要「基础 macOS .app + ad-hoc 签名 + Finder 启动」，用上游 electron-builder
  原样出 `Teahouse.app`；改 `productName=Hive` 会与 `app.setName('茶话间')`（决定 userData 路径）、
  `CFBundleDisplayName`、`appId` 打架，产出半改名产物。改名属 #48/#62。

## 验证记录

- `pnpm run e2e`（dev）：30/30 断言通过。
- `pnpm run e2e:app`（packaged .app）：30/30 断言通过。
- 真实「从 Finder 启动」：`open --env … -a Teahouse.app`（带 quarantine）→ LaunchServices 正常拉起、
  主窗 1 个、health 可用、`POST /v1/lifecycle/quit` 后 0 残留进程。macOS 因其 quarantine gate 把 app
  跑在 AppTranslocation 随机路径下，这是 ad-hoc 签名的预期边界，不是缺陷。
- `codesign --force --deep --sign -`：`valid on disk` / `satisfies its Designated Requirement` /
  `flags=0x2(adhoc)` / `TeamIdentifier=not set`。
- `pnpm run typecheck`（tsc + vue-tsc）通过；`pnpm run test` 上游 126 files / 842 tests 全过；
  `pnpm run check:vendor` 503 baseline files、0 violations。

## 已确认的两个 landmine（已写进 `docs/local-api.md`）

1. **残缺 `config.json` 静默杀死发现**：packaged 节点 `net.ok=true`、`peers=0`、零报错。
   写全字段即恢复。#48 预置配置时同风险。
2. **`--remote-debugging-port` 拖住 GUI 的 `before-quit`**：无 CDP 时 1s 退出，带 CDP 时被拖过 3s；
   headless 不受影响（始终 ≤100ms）。

## Deviations

- 未写任何新增单测：按用户「黑客松速度模式」指令，只为最关键的 AC 保留验证，且全部收敛进
  `scripts/hive-e2e.mjs` 这一条真节点端到端 rig（比单测更能证明 AC2 的双向收发）。上游既有
  842 项测试原样保留、全部通过。
- 未跑 `/code-review` 深度评审，改为按用户指令做「能跑通的自查」：守卫、typecheck、上游全量测试、
  两条 e2e 模式 + Finder 启动实测。
- e2e 会顺带断言 `net.ok`（新增 health 诊断字段），用于区分「网络没起来」与「网络起来但收不到」
  ——这一字段是为排查本 ticket 的静默失败而加的，后续可被 #47/#48 复用。
