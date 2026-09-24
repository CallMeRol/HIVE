# 05: [Agent 链路] @fake 获得一次安全的正式回复

GitHub: #46（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged 3da96a9
Blocked by:
- 03（GitHub #44）

## What to build

让 fake ACP 成员通过与真实 adapter 相同的 runner 和 bridge，被群内 @ 后恰好完成一次 turn，并显示安全的正式回复。

## Acceptance criteria

- [ ] 使用官方 ACP SDK 和 Node 22 runner，JSON-RPC 错误非零退出
- [ ] 一次 @fake 恰好触发一次 turn；未 @、自身消息和系统消息不触发
- [ ] 正式回复带 reply_to，长 UTF-8 内容按自然边界限制为单条不超过 3500B
- [ ] Markdown 经过成熟 parser 和 sanitizer 渲染，XSS 被拒且异常回退纯文本
- [ ] thought、tool、plan、usage 等过程不进入群，只追加写入本机 JSONL/Markdown
- [ ] 冻结后续切片共用的会话、事件、SSE 与 UI 扩展契约

## Recovery note

3da96a9 @fake 安全正式回复

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
