# 24: [环境约束] vendor 依赖树禁止 pnpm/npm install

GitHub: #65（原文已不可读取；正文由 git 与本地笔记还原）

Status: resolved
Implementation: constraint-only
Blocked by:
- None (can start immediately)

## What to build

见下方正文重建。

## Acceptance criteria

记录并约束 vendor 依赖树破坏问题：对 vendor/teahouse 跑 pnpm install / npm install 会让 pnpm 接管
上游 npm 锁文件，破坏依赖树，导致 electron 二进制缺失、app 无法启动。

## Acceptance criteria

- [ ] 派单环境约束中明令禁止 pnpm install / npm install
- [ ] 装依赖统一走从仓库根执行 pnpm run setup
- [ ] typecheck 改走 vendor/teahouse/node_modules/.bin 直调

> 正文缺失，依据 .agents/notes/implementer-dispatch-template.md 与 issue-60-implementation-notes.md 的引用还原。

## Recovery note

正文缺失。仅从引用还原：pnpm/npm install 接管 vendor 依赖树导致 electron 二进制缺失、app 无法启动；现约束为从仓库根跑 pnpm run setup（见 .agents/notes/implementer-dispatch-template.md、issue-60-implementation-notes.md）。git 无 #65 commit，应为纯约束/问题票

## Comments

- [迁移] 2026-09-24 恢复。非本会话发布脚本产物，正文为推断重建，权威度低于 #42–#63。
