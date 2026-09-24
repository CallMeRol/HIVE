# 07: [本地运维] 一条命令管理基础 Hive 环境

GitHub: #48（原文已不可读取；正文由本会话发布脚本完整还原）

Status: resolved
Implementation: merged ca3fb0b
Blocked by:
- 03（GitHub #44）

## What to build

让用户用一套声明式配置启动、检查和彻底停止当前 Mac 上的 Hive GUI 与 headless 节点。

## Acceptance criteria

- [ ] up 等待所有节点 health 就绪后才成功退出
- [ ] status 展示节点、端口和进程实际状态
- [ ] doctor 检查 Node、端口、数据目录和基础节点配置，并对故障给出可操作诊断
- [ ] down 优雅退出全部节点且不残留 Electron 或 Node 进程
- [ ] 命令失败返回非零状态，GUI 启动失败时也有可操作说明

## Recovery note

ca3fb0b up/status/doctor/down；实现笔记 .agents/notes/issue-48-implementation-notes.md

## Comments

- [迁移] 2026-09-24 由本地数据源恢复：定义取自发布脚本，状态由 git log + 实现笔记 + owner 会话交叉验证。GitHub 账号 suspended、token invalid，未能回读原文评论。
