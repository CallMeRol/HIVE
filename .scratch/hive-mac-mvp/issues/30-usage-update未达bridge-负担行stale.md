# 30: 成员 turn 成功后 usage_update 未达 bridge——AC5 负担行 stale

Status: ready-for-agent
Implementation: pending
Blocked by:

## What to build

修复「真实 usage → 成员行负担」链路：turn 正常完成、agent 正常回复，但成员侧
session ledger 里只有 turn 前的 `available_commands_update` / `current_mode_update`，
没有任何 `usage_update` 到达 bridge（`emitUsage` 零调用），负担行永远 stale
（health 的 burden pct=null）。

## Problem Statement（#28 e2e 排障实测，第四次 run）

- turn PASS（成员真实回复进群、replyTo 正确）；
- 成员 session ledger（artifacts/sessions/<nodeId>/<nodeId>.jsonl）仅 2 条
  turn 前 update，无 usage_update / agent_message_chunk 落账；
- GUI 侧 `getPeers()` 的 burden 一直 `{eligible:true, tag:'idle', pct:null,
  sizeTokens:null, stale:true}`，AC5 断言 90s 超时。

adapter 侧（claude-agent-acp dist）确认会在 `session/update` notification 里发
`sessionUpdate: "usage_update"`（含 used/size 字段）；runner.mjs 的
`session.update` handler 也按类型透传 `emit({type:'update', sessionUpdate: kind,
raw})`。断点在 runner→session→bridge 的某一环，待查。

## Hints

- `agent-bridge.ts:345` 的 `usage_update` 分支从未命中——先确认 runner 的 update
  事件是否到达 bridge（`onRunnerUpdate` 的 ledger.append 都没落，说明 update 事件面
  在 turn 期间整条没通，不只 usage）。
- 第四次 run 时 rig 已等 `health.peers>=1` 才发 @（#29 的绕过），直连已就绪，
  排除 #29 干扰。
- 对比 live 成功 run（hive-e2e-VRaMiB 遗留目录）：那次 turn 完成且 usage 链路状态
  未知，可作对照。

## Out of Scope

- attach 编排与拉群（#28）；回放 mentioned（#29）。

## Comments

- 2026-09-24 由 #28 e2e 排障会话发布；rig 已改「该断言失败显式 FAIL 不炸 rig」。
