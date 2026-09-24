# 08: [Agent 接入] 从 GUI 接入 Claude Code 与 Codex

GitHub: #49（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged 18f70a9
Blocked by:
- 05（GitHub #46）
- 06（GitHub #47）

## What to build

让用户通过 GUI 把本机已有的 Claude Code 和 Codex 接入群，分别完成真实 turn，并得到明确的环境诊断。

## Acceptance criteria

- [ ] 可选择 runtime、成员名称、工作目录、模型和 permission 策略
- [ ] 探测 CLI、既有认证、Node、adapter 与模型；失败时显示可操作错误
- [ ] Claude Code 与 Codex 各完成至少一次真实群聊 turn
- [ ] ACP permission 与 Hive 确认键使用不同处理面
- [ ] 真实 usage 驱动成员行上下文负担，凭据与会话数据不离开当前 Mac

## Recovery note

a838e6f + aed1297；合并总结 18f70a9；实现笔记 .agents/notes/issue-49-implementation-notes.md

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
