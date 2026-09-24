# 20: [容错] Packaged APP 在进程异常后恢复到安全状态

GitHub: #61（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged 2b45106
Blocked by:
- 13（GitHub #54）
- 14（GitHub #55）
- 17（GitHub #58）

## What to build

让打包后的 Hive APP 经历 runner 猝死、守卫降级和交接损坏后，重启仍处于一致、可见且可恢复的安全状态。

## Acceptance criteria

- [ ] 在 packaged APP 中依次注入 runner 猝死、守卫不可用和交接损坏
- [ ] 重启后失败任务不会被标记成功，也不会重复派遣
- [ ] 待领取任务、警告和拒绝记录完整保留
- [ ] 测试结束后无孤儿 Electron 或 Node 进程

## Recovery note

bf9ae41 + f923822；合并总结 2b45106 packaged APP 异常恢复

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
