# snapshot vendor 上游进 `vendor/teahouse/`，补丁面白名单 + on-demand 手动同步

fork 落在哪、跟上游到什么程度、谁来守补丁面——三条一起定：**不开 GitHub fork**，把上游 v0.60.2 snapshot 进本仓库 `vendor/teahouse/`（冻结 `f6607ff`，`vendor/.hive/provenance.json` 记账）；补丁面白名单**精确到文件、拒绝目录级放宽**，机器守 `scripts/check-vendor-patches.mjs` pre-push；同步只在需要时**手动**做，无周期 rebase。源：[#22](https://github.com/toRolex/hive/issues/22)（grilling 逐轮定案 + 顾问复核）、首破修订 [#35](https://github.com/toRolex/hive/issues/35)。改动面清单见 [#14](https://github.com/toRolex/hive/issues/14)；分层铁律与冲突面见 `docs/research/teahouse-landmines.md` 卡 8。

## Considered Options

- **GitHub fork（`toRolex/teahouse`，保留 fork 关系）（否决）**——只买到「看上游 diff 便利」，代价是协作/评审/PR 拆到第二仓库；且代码可能来自多个仓库（teahouse、buzz 个别文件、日后虚拟局域网），单仓 vendor 才能统一走 hive 的评审。
- **纯 patch-set（`patches/*.patch`）（否决）**——最薄，但本地必须先打补丁才能跑，单人 2 天节奏下每次开工多一道易碎工序。
- **git subtree / upstream remote 分支（否决）**——周期维护开销，与「覆盖式快照同步」不自洽。
- **周期 rebase / 周期 merge 上游 tag（否决）**——上游 2 天内几乎不会出现非采不可的修复，周期同步是纯开销；冻结 + on-demand 与 snapshot 形态自洽。

## Decision

1. **落点 = snapshot 复制**：上游 v0.60.2 树复制进 `vendor/teahouse/`，冻结 `f6607ff`（2026-09-18）。
2. **记账**：`vendor/.hive/provenance.json` 记 `repo@tag / commit / 日期 / 可复算 archive sha256`（**archive tar 不入库**；per-file baseline = `vendor/.hive/baseline.sha256`）——**用到才进，进了必记账**。P0 只 vendor teahouse；buzz 用到则单文件复制 + manifest 记来源，不开 `vendor/buzz/`；EasyTier 不 vendor（P0 不做跨网）。上游 `.github/` **不进** vendor 树（避免上游 release 工作流混进 hive 的 Actions）。
3. **内部布局**：fork 根 = `vendor/teahouse/`，#14 的 3 新目录 + 脚本整体加前缀放其内部；hive 的 `docs/` 与 teahouse 的 `docs/` 因 subdir 不撞。
4. **白名单 = 精确到文件，拒绝目录级放宽**：只许改白名单内上游文件 + 新文件新目录；新代码不复用上游文件名；上游 `docs/` `net/` `store/` 零改动。
5. **同步 = on-demand 手动**：上游树覆盖回来（新目录不会被碰）→ 重贴 hunks → 本地 headless 烟测（R2 复发门）。固定三步，平时冻结。
6. **机器守**：`scripts/check-vendor-patches.mjs`——baseline = `vendor/.hive/baseline.sha256` per-file 账本（pristine 上游生成）；`provenance.json` 记可复算 `archiveSha256`，**archive tar 不入库**（不联网对照本地 manifest，上游消失/force-push 不脆）；diff 域**覆盖 `package-lock.json`**（白名单 `path` 条目显式记账，不再排除）；挂 **pre-push hook** 为默认守卫（离线、即时，单人最便宜）。CI Action 仅采用 PR 流时追加；headless/local-api/smoke 职责归 **#44**（#43 只预留 `index.ts` 白名单；烟测同步后本地跑、不进 CI，Electron 太重）。
7. License（判词引用 #22 §5，不复读）：上游 GPL-3.0-only；demo 本机跑不发布 = 无分发无义务；赛后开源产品代码则整个 fork 树 GPL-3.0-only 附源码，hive 的 PRD/docs 不传染。

## 修订：白名单首破记账（#35）

#29 定「群里统一渲染 Markdown」后**首次主动破白名单**（teahouse 正文是纯文本 + `white-space: pre-wrap`，改渲染必动上游 renderer 文件），精确记账、仍拒绝目录级放宽：

- 白名单扩为：**`src/main/index.ts` + `src/renderer/src/components/MessageRow.vue` + `package.json` + 新文件新目录**。
- `package.json` 是 ticket 正文没写但事实上的**第二破口**：上游 dependencies 仅 `better-sqlite3`（精确锁版）、renderer 零 markdown 依赖，引 `markdown-it` + `dompurify` 必改；`package-lock.json` 自 #43 起**纳入守卫**（allowlist `path package-lock.json`），改动须记账。
- **三处联动记账**：① `vendor/.hive/patch-allowlist.txt` 白名单加两条；② `docs/vendor/teahouse.md` / provenance 加「主动破口」条目（理由 = #29、hunk 描述）；③ 同步手工步骤改为「重贴 7 hunks + `MessageRow.vue` 1 hunk + `package.json` 依赖行」。
- **明确拒绝 `src/renderer/**` 目录级放宽**——那是白名单被逐条蚕食的起点。
- 记账次数 = **一次**：#33 已定应用内新窗口（只碰白名单内 `index.ts` + 新文件，零新破口），「等 #33 回来再记」的前提消失。
- 渲染口径（markdown-it `html:false` + `linkify` + DOMPurify 双层 XSS、替换 fragment 层、异常回退纯文本）与 license 无新增传染的判词见 #35 §2；本 ADR 不复读。

## Consequences

- 对下游：#14 方案零改动、仅路径加 `vendor/teahouse/` 前缀；#13 env 契约不变、启动脚本按 vendor 相对路径写。
- 落点解除实现 session 的前置阻塞：所有路径按 `vendor/teahouse/` 相对书写，落点不再可变。
- 对评委口径：「上游零改动」**作废**，改为「白名单内 3 个文件改动（`index.ts` 7 hunk、`MessageRow.vue` 1 hunk、`package.json` +2 依赖），其余零改动，pre-push 机器守全量生效」（#35 §4）。
- 今后白名单增删必须一次显式记账（守卫条目 + `docs/vendor/teahouse.md`/provenance + 同步步骤三处同步），不接受目录级条目。
- 同步固定三步跑完才算完成：覆盖 → 重贴 hunks → headless 烟测；烟测失败即回滚，不带着破窗上游走。
- `baseline.sha256` 与 `provenance.json` 的 `f6607ff` 冻结值是守卫的信任根（archive tar 可复算、不入库）：换上游版本 = 重生成 baseline + 更新 provenance，属显式决策而非顺手改动。
