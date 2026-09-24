# 41: Spec — 构建可交付的 Hive BYOA 群聊 MVP

GitHub: #41（父 Spec，保持 open，不由子票关闭）
Status: ready-for-agent
Implementation: 子票 #42–#62 执行中；本 Spec 的关闭判定等 #62 通过后再做

## What to build

把 #20 收口的全部决策压成单一可验收 MVP 实现规格，交付一个可在当前 Mac 使用的
Hive 群聊软件（Mac Product Complete）。完整产品行为与验收以仓库内权威文档为准：

- `docs/PRD.md` —— 产品唯一入口
- `CONTEXT.md` —— 领域词表
- `docs/adr/` —— 11 份 accepted ADR

## 完成定义（两级，勿混淆）

- **Mac Product Complete**：本轮目标，由 #62 发布门验收。
- **Original MVP Complete**：含 Windows、1 Mac + 2 Windows 真机、网络降级阶梯、
  三方涌现对照与六轴；已延期为 #63。

## Blocked by

- None (can start immediately)

## Sub-issues

本轮 tickets 见 `issues/`（GitHub #42–#65）。依赖关系记录在各票 `Blocked by:` 行。

## Comments

- [迁移] 2026-09-24 从 GitHub 恢复。#41 原文与评论未能回读；其内容与 PRD/ADR 高度重合，
  权威实体在仓库文档，本文件作 tracker 入口。
