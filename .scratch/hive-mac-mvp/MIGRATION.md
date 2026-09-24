# 迁移说明：GitHub → 本地 markdown tracker

日期：2026-09-24
触发：GitHub 账号 suspended（`HTTP 403 account suspended`）且 keyring token invalid，
`gh` 读写均不可用。owner 指令：把 issue 尽可能恢复到本地，并把 tracker 切到本地 markdown。

## 恢复结果

- 24 张 ticket 文件：`issues/`
- 1 张父 Spec：`spec.md`（#41）
- 历史 #1–#40 / #20：`../wayfinder-history/INDEX.md`（只存映射，正文不可恢复）

## 数据源与权威度

| 票 | 来源 | 权威度 |
|---|---|---|
| #42–#63 | `/tmp/publish_hive_tickets.py`（本会话发布时的原始定义） | 高：title/AC/blockers 逐字 |
| #64 | commit 879e301 + b317754 | 中：由提交信息重建 |
| #65 | 派单模板 + #60 笔记引用 | 低：仅约束语义 |
| 全部实现状态 | `git log` + `.agents/notes/` + owner 会话 | 高：可本地复核 |
| #41 | 会话摘要 + 仓库 PRD/ADR | 中：权威实体在文档 |
| #1–#40 / #20 | 仅 ADR source 映射 | 低：正文未恢复 |

## 未能恢复的内容

1. 全部 issue 的**评论原文**（AFK 的 summary/close 评论尤其值钱）。
2. #1–#40、#20 的正文。
3. #64/#65 的原始 AC 措辞。
4. GitHub 原生 sub-issue / blocked-by 图 —— 已用各票 `Blocked by:` 行等价表达。

## 状态汇总（2026-09-24）

- **resolved**：#42, #43, #44, #45, #46, #47, #48, #49, #50, #51, #52, #53, #54, #55, #56, #57, #58, #60, #61, #64, #65
- **ready-for-agent**：#59（仅剩关票）、#62（verify62 在跑）
- **ready-for-human**：#63（Deferred，需 Windows）
- **父 Spec**：#41 open，不由子票关闭

## 待办

- [ ] GitHub 恢复后：回读评论原文，补进各票 `## Comments`
- [ ] #59 补一次 `gh issue close`
- [ ] #62 完成后回写并关票
- [ ] liquid-neural-space-frontend 美术资产处置票未建（owner 尚未定路线：演示物料 vs 新票）
