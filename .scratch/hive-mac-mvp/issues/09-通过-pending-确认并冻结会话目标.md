# 09: [核心机制] 通过 pending 确认并冻结会话目标

GitHub: #50（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged 4bc7ae0
Blocked by:
- 05（GitHub #46）

## What to build

让人们先在群内聚合和修订派单，再由有权限者确认启动并冻结会话目标，执行期纠偏不重复审批。

## Acceptance criteria

- [ ] 每成员最多一个永不过期的 pending，可聚合、编辑和丢弃多人留言
- [ ] 无权者确认被拒，主人可逐人放权且权限异常 fail-closed
- [ ] 确认时恰好发送一次聚合 prompt，并可修订、确认和冻结会话目标
- [ ] GUI 显示 pending 药丸和目标未定/已冻结状态
- [ ] 运行中的 steering 与 queuing 不进入 pending、不触发二次确认
- [ ] pending、授权和目标状态可持久化并通过重启测试

## Recovery note

4bc7ae0 pending 确认并冻结会话目标

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
