# Wayfinder 历史 issue 索引（#1–#40, #20）

GitHub 账号 suspended + token invalid，无法回读原文与评论。
这些决策票**已全部 closed**，其结论已固化进 `docs/adr/` 与 `docs/PRD.md`，
因此本索引只保留可考据的映射，不重建正文。

| issue | 可考据内容 | ADR 中提及 |
|---|---|---|
| #1 | ADR-0001 载体选型：fork teahouse 完整节点作为 IM 底座 | 0001-teahouse-as-im-foundation.md |
| #2 | ADR-0010 目标守卫用无状态 LLM 判定（Plan A） | — |
| #3 | 视觉/海报相关（git 有引用，正文缺失） | 0002-true-headless-plus-local-api.md |
| #4 | 研究/决策票（正文缺失） | — |
| #5 | 权限与放权口径（ADR-0006 引用） | 0002-true-headless-plus-local-api.md, 0006-dispatch-spawns-local-nodes.md |
| #6 | 研究/决策票（正文缺失） | — |
| #7 | ADR-0011 P0 只做 LAN，跨网留接口（EasyTier 不落地） | 0006-dispatch-spawns-local-nodes.md |
| #8 | 生命周期相关（git 有引用，正文缺失） | — |
| #9 | 研究/决策票（正文缺失） | — |
| #10 | 研究/决策票（正文缺失） | — |
| #11 | 研究/决策票（正文缺失） | — |
| #12 | logo/视觉资产相关（git 有引用，正文缺失） | — |
| #13 | nodes.conf + 一键启动脚本（ADR-0006 引用） | 0003-snapshot-vendor-with-patch-whitelist.md, 0005-three-machine-llm-topology-model-lock.md, 0006-dispatch-spawns-local-nodes.md |
| #14 | ADR-0002 真 headless + loopback local-api（其手写 NDJSON 口径已被 #25 推翻） | 0002-true-headless-plus-local-api.md, 0003-snapshot-vendor-with-patch-whitelist.md, 0004-acp-sdk-via-runner-subprocess.md, 0005-three-machine-llm-topology-model-lock.md, 0006-dispatch-spawns-local-nodes.md |
| #15 | 交接文档契约相关（正文缺失） | 0007-parallel-dispatch-no-barrier.md |
| #16 | CONTEXT.md 增量（ADR/词表引用） | — |
| #17 | sprite/network 契约与状态档位（git 有引用，正文缺失） | 0004-acp-sdk-via-runner-subprocess.md, 0007-parallel-dispatch-no-barrier.md, 0009-cross-machine-status-channel.md |
| #18 | 三个故障剧本可演示设计（PRD 引用） | 0006-dispatch-spawns-local-nodes.md, 0007-parallel-dispatch-no-barrier.md |
| #19 | PRD 落盘 docs/PRD.md 的验收来源 | 0004-acp-sdk-via-runner-subprocess.md |
| #20 | wayfinder map：通往 PRD 的上下文治理方案（destination 已达成） | — |
| #21 | ACP 能力集实测证据（为 ADR-0004 供证） | 0004-acp-sdk-via-runner-subprocess.md, 0005-three-machine-llm-topology-model-lock.md |
| #22 | ADR-0003 snapshot vendor + 补丁面白名单 + on-demand 同步 | 0003-snapshot-vendor-with-patch-whitelist.md, 0008-formal-messages-only-in-group.md, 0009-cross-machine-status-channel.md |
| #23 | 涌现性演示协议修订：三方对照 + 攻壳城市 + 22 条判据 | — |
| #24 | ADR-0007 1:N 派遣语义（无 barrier） | 0006-dispatch-spawns-local-nodes.md, 0007-parallel-dispatch-no-barrier.md |
| #25 | ADR-0004 官方 ACP SDK 经 runner 子进程（推翻 #14 手写 NDJSON） | 0002-true-headless-plus-local-api.md, 0004-acp-sdk-via-runner-subprocess.md, 0006-dispatch-spawns-local-nodes.md, 0008-formal-messages-only-in-group.md |
| #26 | 空闲/离线/回收三轴与状态档位口径 | 0009-cross-machine-status-channel.md |
| #27 | ADR-0005 三机拓扑与模型锁定三层归属 | 0005-three-machine-llm-topology-model-lock.md |
| #28 | ADR-0007 交接每人一份、完成即回收、成员级独立结算 | 0007-parallel-dispatch-no-barrier.md |
| #29 | ADR-0008 群内只发正式消息，过程落本机机库（≤3500B 分条） | 0003-snapshot-vendor-with-patch-whitelist.md, 0008-formal-messages-only-in-group.md, 0009-cross-machine-status-channel.md |
| #30 | 研究/决策票（正文缺失） | — |
| #31 | 回收语义修订（废弃回收三件套/遗迹口径） | 0007-parallel-dispatch-no-barrier.md |
| #32 | 同机 RSS 上限 graduate 票（ADR-0006 引用） | 0001-teahouse-as-im-foundation.md, 0005-three-machine-llm-topology-model-lock.md, 0006-dispatch-spawns-local-nodes.md |
| #33 | 机库承载面：应用内 BrowserWindow + 卡片网格（prototype/33） | 0003-snapshot-vendor-with-patch-whitelist.md |
| #34 | 跨机状态通道可行性证明（为 ADR-0009 供证） | 0009-cross-machine-status-channel.md |
| #35 | ADR-0003 修订：白名单首破记账（MessageRow.vue + package.json） | 0003-snapshot-vendor-with-patch-whitelist.md, 0004-acp-sdk-via-runner-subprocess.md, 0008-formal-messages-only-in-group.md, 0009-cross-machine-status-channel.md |
| #36 | CONTEXT 增量（词表引用） | — |
| #37 | 仪表盘拼法（prototype 分支） | 0009-cross-machine-status-channel.md |
| #38 | ADR-0009 agent-status 定向单播，10s 节拍 / 30s TTL | 0009-cross-machine-status-channel.md |
| #39 | ADR-0006 派遣链在根主人单机 spawn 本地节点 | 0006-dispatch-spawns-local-nodes.md |
| #40 | 实现前 preflight：确认 vendor/local-api/acp 等路径当时均不存在 | — |

## 恢复优先级

若 GitHub 恢复，优先回读：#20（map）、#41（Spec）、#14/#22/#25/#38（被 ADR 引用的实现口径）。
其余决策票的可执行结论已在 ADR 中，回读价值主要是补 resolution 评论原文。