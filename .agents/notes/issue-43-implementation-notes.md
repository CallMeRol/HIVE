# Issue #43 implementation notes

## 目标

冻结 teahouse v0.60.2，并建立文件级 fail-closed 补丁守卫与可重复的本机构建入口。

## 决策

- 复用 `afk/issue-43` 已完成并有完整本机验证记录的两个提交，而非重新生成 503 个 vendor 文件；通过 cherry-pick 保留实现边界和审计历史。
- baseline 使用上游 `git archive` 摘要和 per-file SHA-256 manifest。前者固定来源，后者让守卫不依赖 Git 历史、浅克隆或 squash 状态。
- 保留上游 `package-lock.json`，根入口虽由 `pnpm run` 调用，内部仍用 `npm ci --prefix vendor/teahouse`，避免换包管理器后重解析依赖。
- allowlist 区分 `path`（精确上游文件）与 `new`（仅 baseline 外新增路径），防止新增目录规则豁免既有上游文件。

## 验证记录

- `pnpm run check:vendor`：503 个 baseline 文件，0 violations。
- `pnpm run test:guard`：19/19 通过。
- `pnpm run setup`：安装及 Electron native rebuild 成功；上游锁定依赖报告 28 个既有漏洞，未在本基础设施 ticket 中擅自升级。
- `pnpm run typecheck`：`tsc` 与 `vue-tsc` 通过。
- `pnpm run build`：Electron/Vite 构建及五入口 bundle 检查通过。
- 初始 `pnpm run test`：守卫 19/19、上游 Vitest 126 files / 842 tests 全部通过。
- Review 发现 vendored `.gitignore` 会隐藏未跟踪新增文件；改为直接遍历 vendor 树（跳过确定的可再生产物），新增回归测试后守卫 21/21 通过。
- Review 后将 provenance 纳入守卫必需账本并校验固定 tag、commit/hash 格式、许可及 manifest fileCount；CI 增加 build 门。

## Deviations

- `wt` 已在仓库同级创建 worktree，但当前 harness 无法持久切换到该路径；所有命令和文件操作显式使用该 worktree 的绝对路径，避免误改主 worktree。
