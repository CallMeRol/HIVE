# Hive

## Vendored teahouse 与补丁面守卫

`vendor/teahouse/` 是 teahouse v0.60.2 的冻结 snapshot vendor（上游 CI 已排除）。
白名单外对它的任何修改都必须 fail-closed 被拒。账本、语义、同步流程与本机入口见
`docs/vendor/teahouse.md`；改动它之前先读那份文档。守卫：`pnpm run check:vendor`
（pre-push 与 CI 同步执行）。根入口一律 `pnpm run …`（本机禁直接敲 npm）。

## Agent skills

### Issue tracker

issue 和 spec 都是 `.scratch/` 下的本地 markdown 文件，不使用 `gh` CLI。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个标准 triage 标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局：仓库根目录 `CONTEXT.md` + `docs/adr/`。详见 `docs/agents/domain.md`。