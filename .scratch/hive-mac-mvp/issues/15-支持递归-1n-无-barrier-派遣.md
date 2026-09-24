# 15: [派遣机制] 支持递归 1:N 无 barrier 派遣

GitHub: #56（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged 3cc7543
Blocked by:
- 10（GitHub #51）

## What to build

让成员一次摇入多个独立成员，并允许在深度边界内继续派遣，各成员按自己的完成节奏独立结算。

## Acceptance criteria

- [ ] 支持 1:N 派遣、默认派遣深度 3 和派遣并发 5
- [ ] 不存在全局 barrier，任一成员完成即可独立结算
- [ ] 部分成员失败不阻塞其他成员，超限产生可读失败而非静默降级
- [ ] 子成员可继续派遣，父成员退出后子成员挂靠最近活跃祖先
- [ ] 每个成员仍保持独立身份、进程、上下文与任务状态

## Recovery note

4be57cc 递归 1:N 无 barrier 派遣；合并总结 3cc7543

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
