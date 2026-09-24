# 18: [容错] runner 猝死后任务进入待领取

GitHub: #59（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged 989baaf
Blocked by:
- 10（GitHub #51）
- 17（GitHub #58）

## What to build

让派遣成员的 runner 猝死时，用户在五秒内看到异常退群和待领取任务，并能由主人决定是否补派。

## Acceptance criteria

- [ ] 杀死 runner 后五秒内成员异常退群并从活跃成员中消失
- [ ] 任务进入待领取并 @ 原主人，正常退群与异常退群消息明确不同
- [ ] 默认不自动补派，主人可以人工补派
- [ ] UI、持久化任务状态和真实进程状态一致

## Recovery note

代码已合入 main：bde47ff + 9012d61 + 93fc2f7 + d494f98 + 989baaf。仅剩关票动作失败（gh 403 账号暂停），账号恢复后补一次即可

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
