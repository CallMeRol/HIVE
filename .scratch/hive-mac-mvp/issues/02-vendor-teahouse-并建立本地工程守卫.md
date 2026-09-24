# 02: [基础设施] Vendor teahouse 并建立本地工程守卫

GitHub: #43（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged db4e37e
Blocked by:
- None (can start immediately)

## What to build

提供可在当前 Mac 离线核验和构建的 teahouse 工程基线，使所有后续产品切片在受控补丁面上开发。

## Acceptance criteria

- [ ] 冻结 teahouse v0.60.2 的来源、commit、许可和 baseline
- [ ] 文件级补丁白名单生效，白名单外修改 fail-closed
- [ ] 本机安装、构建、类型检查和测试入口可重复运行
- [ ] 上游与新增代码边界清晰，不引入第二套群聊底座

## Recovery note

76000fa + dbc0a98 + 643bfc3 + 8f7d9c4；合并总结 db4e37e；实现笔记 .agents/notes/issue-43-implementation-notes.md

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
