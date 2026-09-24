# 17: [持久化] 重启后恢复 Hive 产品状态

GitHub: #58（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged d1a907d
Blocked by:
- 09（GitHub #50）
- 10（GitHub #51）
- 11（GitHub #52）

## What to build

让 Hive 在意外退出或正常重启后恢复可恢复的产品状态，并把无法继续的运行中任务明确转为待领取，而不是伪装仍在执行。

## Acceptance criteria

- [ ] 重启后恢复 Agent 接入配置、pending、目标、授权、派遣关系、slot、待领取、机库和归档索引
- [ ] 在 pending 阶段强制退出重启后，草稿和权限按契约恢复
- [ ] 在派遣成员执行阶段强制退出重启后，任务进入明确异常或待领取状态
- [ ] 已归档会话在重启后仍可读取和搜索
- [ ] 恢复过程不会重复派遣、伪造成功或遗留孤儿进程

## Recovery note

42f8012 + 34da6d0；合并总结 d1a907d 重启恢复

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
