# Issue tracker: Local Markdown

本仓库的 issue 与 spec 以本地 markdown 文件存在，位于 `.scratch/`。不使用 `gh` CLI。

> 2026-09-24 由 GitHub 切换而来：账号 suspended + token invalid，`gh` 读写均不可用。
> 历史 GitHub issue 已迁移到 `.scratch/hive-mac-mvp/` 与 `.scratch/wayfinder-history/`。

## 惯例

- 每个 feature 一个目录：`.scratch/<feature-slug>/`
- spec 是 `.scratch/<feature-slug>/spec.md`
- 实现 issue 每票一个文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 起按依赖顺序编号（blocker 在前）；**绝不合并成单个 tickets 文件**
- triage 状态写在文件顶部附近的 `Status:` 行（词形见 `triage-labels.md`）
- 实现进度另记 `Implementation:` 行（`merged` / `running` / `pending` / `constraint-only`），与 triage 分轴
- 评论与会话历史追加到文件底部 `## Comments` 下

## 当某个 skill 说“发布到 issue tracker”时

在 `.scratch/<feature-slug>/` 下创建新文件（必要时先建目录）。

## 当某个 skill 说“获取相关 ticket”时

读取所引用路径的文件。用户通常会直接给出路径或票号。

## Wayfinding 操作

由 `/wayfinder` 使用。**map** 是一个文件，每张 **child** ticket 一个文件。

- **Map**：`.scratch/<effort>/map.md` —— Notes / Decisions-so-far / Fog 正文。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 起编号，正文写问题。`Type:` 行记录票类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **Blocking**：文件顶部附近写 `Blocked by: NN, NN`。所列文件全部为 `resolved` 时该票解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/`，取 open、无 blocker、无人认领的文件；编号最小者优先。
- **Claim**：动工前先把 `Status:` 设为 `claimed` 并保存。
- **Resolve**：在 `## Answer` 下追加答案，把 `Status:` 设为 `resolved`，再把 context 指针（gist + 链接）追加到 `map.md` 的 Decisions-so-far。

## 已知缺口

GitHub 原生 sub-issue / blocked-by 图已丢失，等价信息保存在各票 `Blocked by:` 行；
issue 评论原文未迁移，待 GitHub 恢复后回读补全。恢复清单见
`.scratch/hive-mac-mvp/MIGRATION.md`。
