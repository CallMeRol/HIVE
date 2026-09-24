# 11: [机库] 查看成员过程、归档并执行 clear

GitHub: #52（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged fac4960
Blocked by:
- 05（GitHub #46）

## What to build

让用户在独立机库窗口查看每个成员的原始过程，搜索活跃与归档会话，并安全地 clear 当前实例。

## Acceptance criteria

- [ ] 按成员、会话和 turn 显示 append-only JSONL/Markdown 原始时间线
- [ ] 支持过程类型过滤和全文搜索，不加工、不总结
- [ ] 活跃与归档分区清晰，索引在重启后可恢复
- [ ] clear 终结旧实例并归档，同一身份位置创建新实例，目标由人重定
- [ ] headless 模式不创建窗口，GUI 可打开独立机库窗口

## Recovery note

7a3df29 + 1ab6b1f；合并总结 fac4960 机库

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
