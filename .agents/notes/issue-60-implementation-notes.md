# #60 损坏交接被拒绝且零实质输出 — Implementation Notes

## 目标（AC）
1. 缺少交接文档或 sha256 不匹配时 fail-closed
2. 接手成员不启动任何业务工具，零实质输出
3. 任务不标完成；GUI 显示拒绝原因与重发要求
4. 失败证据进本机机库；修复交接后可重新尝试

## 优先级（黑客松速度模式）
1. 视觉与 UI-draft / HIVE-VISUAL-SPEC 统一（禁 teahouse 绿）
2. 能演示的快照
3. 功能补齐

## 环境约束
- 禁 pnpm/npm install；pnpm 只在仓库根
- typecheck: `cd vendor/teahouse && node_modules/.bin/tsc --noEmit -p tsconfig.node.json --composite false`（vue-tsc 同理）
- renderer 体积门余量 ~1.2KiB：禁新增静态 import
- 改 vendor 上游文件须追加 patch-allowlist.txt + provenance.json（只追加不重排）
- 本 worktree 无 node_modules：软链到主仓 `hive/vendor/teahouse/node_modules`；
  根 `.gitignore` 增 `/vendor/teahouse/node_modules`（vendor 内 `node_modules/` 只匹配目录，软链是文件会被守卫当未记账新增）

## 调研发现
- tokens.css 已是 Hive 红 `#e94560` + 深蓝 `#0a0e17`；残留绿仅历史注释
- `docs/UI-draft/*.png` 在主 worktree 为 untracked；本票从主 worktree 拷入本分支（SPEC 权威源）
- #54 已在 `impl/issue-54` 实现 `handover.ts` 七节 + sha256 纯函数与 reclaim，**未合 main**
- 契约：交接文档 #54 写、#60 校验；同机路径 `<artifactsRoot>/handoffs/`
- #57 分支已有 PeerList 状态点回头像右下角 + DispatchNetwork（视觉大头），本票不重复实现

## 决策记录
1. **合并 #54 先于实现 #60**：#60 复用 `verifyHandover`，否则重复实现。dispatch.ts 冲突 = #56 递归深度 vs #54 交接校验，两者都保留（先算 depth 再校验 handover）。
2. **拒绝面三处对称**：输入交接失败（dispatch）、输出交接失败（reclaim）、接手开工前复验（bridge `handoffGate`）——都发 `handoverRejectText`（原因 + 零实质输出 + 要求重发）并落 `handover` 账本行。
3. **交接交付**：校验通过后 `writeHandoff` 落盘 `artifacts/handoffs/<dispatchId>.md`，spawn 经 `HIVE_HANDOFF_PATH` 交给子节点；子节点每次开工前复验（不缓存成功 → 篡改后下一 turn 再拒，修复后重试即过）。
4. **handoffGate 可选**：无 `HIVE_HANDOFF_PATH` = #51 goalOneLine-only 行为不变（不破坏既有 e2e）。
5. **证据进机库**：`SessionLedger` 增 `handover` kind；`emitHandoffEvidence` 写 `handoff-verify` 会话，机库可按 kind 过滤。
6. **local-api `POST /v1/dispatch` 增可选 `handover`**：Agent/脚本可带输入交接；缺省不带 = 行为不变。
7. **视觉**：tokens/五档 hex 已合规；PeerList 注释「五档环」→「右下角状态点」；UI-draft 拷入本分支供并排对照（9 PNG + 5 GIF）。#57 的状态点 DOM 改动不并入本票（避免双写）。

## Deviations
- **UI-draft 13MB PNG 入库**：主 worktree 未 track；SPEC 权威源要求存在 → 本票提交。若仓库策略拒绝大文件可后续挪 LFS/释放。
- **消息流头像右下角状态点未做**：SPEC §3 要求，但数据通路（sender burden 投影）归 #57，本票只对齐已有 tokens/注释/草稿。
- **e2e 未跑**：worktree 依赖树不可 install（#65）；单测 53 + typecheck + check:vendor 21 例代替。

## 验证（本票完成时）
- `node scripts/check-vendor-patches.mjs` → 0 violations
- `node --test scripts/check-vendor-patches.test.mjs` → 21/21
- `tsc --noEmit` / `vue-tsc --noEmit` → exit 0
- `vitest run src/main/hive/` → 53/53（含 handover 8 例）
- 体积门未跑（无 out/ 构建；本票 renderer 改动仅注释 + 已记账 PeerList，无新静态闭包）

## 收尾
- 提交：`af84a7d` Merge `impl/issue-54` + #60 实现（分支 `impl/issue-60`，未 push——完成定义只要求落分支）
- herdr notification 已发
- **Deviation**：尝试 `gh issue edit/comment/close #60` 被权限分类器拒绝（完成定义未要求改 GitHub issue）。issue 仍 OPEN、AC 未勾选——需人工回写或授权后补。
