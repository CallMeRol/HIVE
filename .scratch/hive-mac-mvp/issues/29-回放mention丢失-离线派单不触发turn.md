# 29: 回放进群的 @ 消息永久丢失 mentioned——成员永远不回这类派单

Status: ready-for-agent
Implementation: pending
Blocked by:

## What to build

让「经离线补发队列回放进群」的 @ 消息也能触发成员 turn（或给出明确的产品面决策：
这是设计内降级）。

## Problem Statement（#28 e2e 排障实测）

成员节点刚起、与主人 TCP 直连尚未建立时，主人 @ 它发出的群消息走底座离线补发队列；
成员后来收到回放入库。但 `mentions` 数组不落消息表（`groups.ts` 入库时只写 text/replyTo），
回放重建的 MessageView 永远没有 `mentioned=true`——`agent-bridge.ts` 头注释明说
「mentions 不落消息表 ⇒ 绝不能查库回放」，于是这条 @ 永远不触发 turn，成员静默。

实测：成员 DB 里 `conversations.mentioned=1`（convRepo.markMentioned 走了），
但 bridge 零日志——trigger 判定在 MessageView 面上就丢了。

接入编排（#28 修后）本身时序健康；此问题在「主人先 @、成员节点后起/后连」的任何
时序下都触发，与接入无关。

## Directions（未决策，需先二选一）

1. **产品面**：认定「离线 @ 不触发 agent turn」是设计内降级（人不在场 = 不派活），
   在文档写明即可——但接入场景（GUI 刚拉进群就 @ 它）恰好撞上，体验差。
2. **机制面**：给 mentions 一个可回放的承载（消息表加列 / envelope 补发面带上
   payload），让回放路径也能重建 mentioned。注意与「绝不查库回放」这条既有纪律的
   冲突要正面解决，不能偷偷回放。

## Out of Scope

- attach 编排（#28 已修，health 后 invite，直连前不会有 GUI 侧群表确认）。
- pending 闸门与确认键语义。

## Comments

- 2026-09-24 由 #28 e2e 排障会话发布（rig 修为发 @ 前等 `health.peers>=1` 绕过，
  产品侧缺口仍开放）。
