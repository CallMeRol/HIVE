# Implementer 派发模板（唯一权威）

> 每次派发 implementer 都逐字使用本模板，只替换占位符。规则由 owner 下达，持续生效。

## 占位符

| 占位符 | 填什么 |
|---|---|
| `<N>` | issue 号 |
| `<branch>` | `impl/issue-<N>` |
| `<base>` | `main` |

## 模板（单行整条下发，首字符必须是 `/`）

```
/implement issue #<N>；当前 worktree 分支 <branch>，base 是 <base>；【黑客松速度模式 · 优先级重排】目标：最快交付可演示的 app。优先级从高到低：① 视觉与 docs/UI-draft/*.png 统一（必读 docs/design-drafts/HIVE-VISUAL-SPEC.md：Hive 红 #e94560 + 深蓝底 #0a0e17，禁 teahouse 绿）② 能演示的快照 ③ 功能补齐。不要死磕测试——跑不通就跳过或只留最小冒烟并如实说明，不要反复调试非关键断言；不写不必要的代码，不做不必要的检查，不追覆盖率；超过 30 分钟就收尾提交，别过度打磨。issue 正文按 docs/agents/issue-tracker.md 读取本地文件 `.scratch/hive-mac-mvp/issues/<NN>-<slug>.md`（NN = issue 号 - 41；不用 gh，GitHub 已不可用）；完成定义：核心 acceptance criteria 满足且收尾提交到当前分支；完成后运行 herdr notification show "implement #<N> done"
```

## 超时介入指令（agent 运行超 30 分钟仍无提交时投递）

```
【状态确认 · owner 指令】请用一句话回报你的进度（做到哪一步、还差什么），然后立即按以下优先级收尾：
1) 优先级从高到低：① 视觉与 docs/UI-draft/*.png 统一（详见 docs/design-drafts/HIVE-VISUAL-SPEC.md，禁 teahouse 绿）② 能演示的快照 ③ 功能补齐。
2) 不要死磕测试：跑不通就跳过或只留最小冒烟，如实说明即可。
3) 不写不必要的代码，不做不必要的检查，不追覆盖率。
4) 现在就收尾：核对核心 AC → 跑一次能跑通的验证（不行就跳过并说明）→ 立即 git add + commit 到当前分支 → herdr notification show。
5) AC 有缺口就在 commit 信息或 issue 评论里如实说明，不要假装完成。
```

## 环境约束（写入派单上下文）

- **不要在任何情况下跑 `pnpm install` / `npm install`**：`vendor/teahouse` 的上游锁文件是 npm 的 `package-lock.json`，pnpm 接管会破坏依赖树（曾导致 electron 二进制缺失、app 无法启动，见 #65）。需要装依赖时从仓库根跑 `pnpm run setup`。
- **`pnpm run typecheck --prefix vendor/teahouse` 本机不可用**（会触发 pnpm 重装报错）。改用 `cd vendor/teahouse && node_modules/.bin/tsc --noEmit -p tsconfig.node.json` 与 `node_modules/.bin/vue-tsc --noEmit -p tsconfig.web.json`。
- **renderer 体积门当前红**（JS 超 4110B / CSS 超 923B，跨票累积）。不要为此改上游脚本或抬预算——该决策归 ticket owner。
- **补丁纪律**：改任何 `vendor/teahouse/` 上游文件必须在 `vendor/.hive/patch-allowlist.txt` 加 `path <file>` 并在 `provenance.json` 记账，否则 guard fail-closed。
- **记账文件只追加、不重排**：并行票都改 `provenance.json` / `patch-allowlist.txt` / `package.json`，重排会导致合并冲突。
