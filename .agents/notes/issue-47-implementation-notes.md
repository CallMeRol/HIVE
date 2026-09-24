# Issue #47 实现记录

## 目标

让本机多个独立节点像跨机成员一样同步上下文负担，并在成员行中可靠显示五档状态。

## 决策

- **通道完全按 ADR-0009 / #38 resolution 落地，零上游 codec/protocol 改动**：
  私有信封类型 `agent-status`（`v:1`）走 best-effort 单播（镜像 `messenger.sendBestEffort`：
  不 ACK / 不入队 / 不改在线态 / 不改 dedup）。上游 `KNOWN_TYPES` 不含它，故对上游永远是
  「未知类型」并被发现层/消息层忽略——这一点由上游既有测试固定，本票不需要碰协议。
- **`ag1` 走既有 caps 通道，不新增破口**：`loadAppState` 的 caps 数组按 env 追加一位，
  经既有 `saveProfileCaps` + `announceProfile` 传播。caps 校验不枚举合法值，故不需要
  按 #22/#35 规矩做第二次白名单破口记账。
- **可见边界 = 同群 ∩ `ag1` ∩ 在线**：目标集从群成员表取（零新发现机制）。
  `eligible`（同群 ∩ ag1）与「在线」是两条独立轴：前者决定画不画环，后者由底座成员表置灰承担。
- **TTL 30s 明确不复用 `offlineAfter` 90s**：节点在线而 agent 已死时继续显示旧档 = 撒谎。
  无数据落 `idle` 蓝并继续显示（#17 Q3「没停顿」）。
- **payload 入站自校验**（不进 codec 白名单 ⇒ 不可信输入）：`pct` 0–100 整数 ·
  `sizeTokens` 正整数 ≤10⁹ · `tag` ∈ 五档 · `goal` ≤120 B · `role` ≤24 B · `|now−ts| ≤5min` ·
  未知键忽略。**超标整包丢，不降级不猜**。另加两道来源校验：必须是已知对端，
  且源地址与其登记地址一致；乱序/旧包按 `ts` 丢弃（已删 `rev`）。
- **确定性状态生产器**（AC5）：`PANTRY_AGENT_STATUS="pct=45;size=1048576;tag=…;goal=…;role=…;for=…"`
  从 env 造状态，`off`/空 = 无生产者。真实 usage 在 #49 接线；本票的黑盒验收完全不依赖 agent/LLM。
- **渲染层只透传，不算不拼**：五档档名（`label`）、色值（`color`）、悬浮说明（`title`）
  都由主进程算好后经 `PeerView.burden` 下发。原因有二：① 渲染层不得新增中文字面量
  （上游 `i18n/coverage.test.ts` 要求 `tr()` 字面量必须有英文模板，而 `en.ts` 不在白名单内）；
  ② 主窗静态闭包有硬字节预算，词表与色值表留在主进程省主窗体积。
- **`burden.updated` 走批内冻结的 SSE 事件表**：service 是 EventEmitter，主进程用
  `localApi.attachEventSource(type, source)` 一行接上（local-api 保持薄适配器，不做业务判定）。

## 记账（ADR-0003 三处联动）

白名单新增 4 条 `path` + 1 条 `new`（单文件，因为 `services/` 同目录其余都是上游文件）：

| 条目 | 理由 |
|---|---|
| `path src/main/index.ts` | 已在表内：agent-status 装配 + caps 一位 + PeerView 投影 + health 诊断 |
| `path src/renderer/src/components/PeerList.vue` | 绿/灰点就地升级五档环 |
| `path src/renderer/src/ui/contact-presence.test.ts` | **该测试原样钉死了被本票替换的旧 DOM 字面量**，按 #252 意图改为断言绿/灰点分支仍存在 |
| `path src/shared/ipc.ts` | `PeerView` 增 `burden` + 五档 tag 常量 |
| `new src/main/services/agent-status.ts` | 新 service（发/收/自校验/TTL） |

`provenance.json` 增 `patchSurface.entries` 按 ticket 分组记账（#44 / #47 各一组），
`docs/vendor/teahouse.md` 表格同步。

## 验证记录

- `pnpm run test`：守卫 0 violations、守卫测试 21 例、上游 **842 例全过**。
- `pnpm run typecheck`：tsc + vue-tsc 通过。
- `node scripts/hive-e2e.mjs`（#44 既有 rig）：**30/30 通过**，无回归。
- `pnpm run e2e:status`（本票新 rig）：**28/28 通过**，覆盖全部五条 AC：
  - AC1 静态 peers 互见 + GUI→headless 定向 `agent-status` 到达（SSE `burden.updated`）
  - AC2 节拍实测 `gaps=[10146, 10115]`；停止上报后 `Δ≈40s`（最后上报 + 30s TTL，含扫描粒度）落 stale
  - AC3 伪造包（未知来源 1 条 + 字段非法 5 条 + 乱序 1 条）全部计入 `dropped` 0→6，
    **presence 在线数不变、负担缓存不增、档位未被旧值覆盖**
  - AC4 成员行五档（5%→easy、25%→overload、45%→about-to-blow）、
    同屏窗口大小、sprite A2 文案与色值；空闲/离线两轴分离；未声明 `ag1` 的对端不落 idle 蓝
  - AC5 全程由确定性生产器驱动，无 agent/LLM 依赖

## Deviations

- **未新增单测**：按用户「黑客松速度模式」指令，只为最关键 AC 保留验证，且全部收敛进
  `scripts/hive-status-e2e.mjs` 这条真节点端到端 rig（比单测更能证明入站校验与 TTL）。
  上游既有 842 项测试原样保留、全部通过。
- **未跑 `/code-review` 深度评审**，改为按指令做「能跑通的自查」：守卫、typecheck、
  上游全量测试、两条 e2e。
- **`pnpm run build` 的 renderer bundle 预算门仍是红的**，但**与本票无关**：
  干净基线（#44 交付态，stash 掉本票全部改动后实测）App.vue JS 闭包已是 819245 B，
  超 819200 B 预算 45 B —— 该门在 main 上本就是红的。本票已把自身占用压到最小
  （词表/色值/展示串全部移到主进程，renderer 只透传；CSS 只保留必要的类），
  实测增量约 +100 B JS、+92 B CSS。**该门的修复属 #57（可视化）或独立基建票**，
  不在本票范围内，且检查脚本 `scripts/check-renderer-bundles.mjs` 在白名单外、不得改。

## 未决（不进本票）

- 31 节点峰值下的实际丢包率未实测（ADR-0009 已量化推算，溢出是优雅的：丢一拍下一拍恢复）。
- 旧版 teahouse（< 0.60.2）对未知信封的处理未验证（#38 已记录为未决项）。
- 五档阈值当前硬编码为 10/20/40（sprite 契约 A2 默认值）；若后续要可调，归 #37 仪表盘面。
