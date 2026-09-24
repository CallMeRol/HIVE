# 21: [发布验收] 生成并验收 Mac Product Complete

GitHub: #62（原文已不可读取；正文由本会话发布脚本完整还原）

Status: ready-for-agent
Implementation: running
Blocked by:
- 04（GitHub #45）
- 07（GitHub #48）
- 08（GitHub #49）
- 12（GitHub #53）
- 13（GitHub #54）
- 14（GitHub #55）
- 15（GitHub #56）
- 16（GitHub #57）
- 18（GitHub #59）
- 19（GitHub #60）
- 20（GitHub #61）

## What to build

交付一个从 Finder 首次启动即可建群、接入本地 Agent、完成摇人制协作并安全恢复的 Hive.app，以及全部留在当前 Mac 的可复验开发构件。

## Acceptance criteria

- [ ] 最终 APP 内嵌 runner、ACP SDK、Claude/Codex adapters、fake peer、视觉资源和 Markdown 依赖
- [ ] 干净数据目录从 Finder 启动后，可初始化身份、创建和切换多个群、接入 Claude Code 与 Codex 并完成真 turn
- [ ] 完整走通 pending、确认、目标冻结、正式回复、单次越界、派遣、输入与输出交接、回收、重启恢复和机库查询
- [ ] runner 猝死、守卫不可用和交接损坏三个故障剧本全部通过
- [ ] ad-hoc 签名、架构、动态依赖、LaunchServices、quarantine 边界和退出后无残留均有验证报告
- [ ] 源码、vendor、依赖锁、构建测试脚本、配置、许可、测试报告和已知限制全部保留在当前 Mac
- [ ] 本票只执行黑盒发布验收，不首次补实现；任何缺失退回对应实现票

## Recovery note

唯一在跑：verify62 已派发，正在主仓库做黑盒验收（AC 全文手写进派发 prompt，非 gh 拉取）

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
