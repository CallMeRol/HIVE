# 03: [产品主干] 从 Finder 启动 Hive 并与 headless 成员完成群聊

GitHub: #44（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged 23c58e4
Blocked by:
- 01（GitHub #42）
- 02（GitHub #43）

## What to build

交付第一条完整 walking skeleton：用户从 Finder 启动 Hive，创建群，与独立 headless 成员收发消息，重启后仍可继续使用。

## Acceptance criteria

- [ ] 干净数据目录首次启动时完成本机身份初始化并可创建群
- [ ] GUI 与独立身份、数据目录和端口的 headless 成员互见并双向收发群消息
- [ ] loopback local-api 提供 health、消息、SSE 和优雅 quit，退出后无残留进程
- [ ] 退出并重新启动后群和消息仍存在
- [ ] 生成基础 macOS .app，经 ad-hoc 签名后可从 Finder 启动并完成黑盒 smoke

## Recovery note

23c58e4 headless + local-api + 黑盒 walking skeleton；实现笔记 .agents/notes/issue-44-implementation-notes.md

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
