# 27: [UI] 主界面像素级复刻 UI-draft 三栏布局与五档状态点

GitHub: （本地新建，无对应 GitHub 号）
Labels: ready-for-agent

Status: ready-for-agent

## Seam（唯一）

**renderer 展示层外壳**：`App.vue` 的 shell 栅格（栏宽、层级）+ `ChatPane` 头部/消息区插入点 + `AvatarMark` 状态点槽位。

- 上下文负担数据已由主进程经 `PeerBurdenView`（`burden.color` / `burden.title` / `burden.pct`）透传到渲染层，**不新增 IPC、不改主进程判定**。
- 右栏详情、群聊横幅均为该 seam 内的展示层扩展；横幅素材与五档 GIF 已在 `assets/hive/` 就位。
- 不新建第二个 seam；机库 3D（#26）、adapter 内嵌（#08）不在本 seam。

---

## Problem Statement

Hive 主界面仍是「图标 rail + 会话列表 + 主区」的两栏结构，与美术交付的 `docs/UI-draft/*.png`（9 张 Tachikoma 外壳稿）差距明显：缺右侧成员/详情栏、缺主群 185px 攻壳城市夜景横幅、消息流头像右下角只有在线绿/灰点而没有按上下文负担着色的五档状态点。owner 要求按设计稿尽可能一比一复刻，尤其是 agent 在不同上下文窗口占用下的五档配色表达。

## Solution

在不改动任何业务行为（会话、消息、派遣、pending、负担判定）的前提下，把主窗改成设计稿的三栏构图：

1. 左栏总宽约 260–280px：品牌区 + 图标导航 + 会话/通讯录列表（合并现有 rail+list 的视觉宽度，交互入口全部保留）。
2. 中栏：会话头 + **仅群聊**显示 185px 城市夜景横幅 + 消息流 + 输入区（现有 ChatPane 行为原样保留）。
3. 右栏 320px（仅会话打开时）：Channel/会话信息、Members、Active agents、Pinned；**懒加载**，不进 App.vue 静态闭包。
4. 消息流与会话列表头像位：名字头像 + 右下角**五档状态点**（有 `burden` 用五档 hex，否则回落 presence 绿/灰）——不放精灵（契约 A1）。

## User Stories

1. 作为 owner，我想主窗呈现设计稿的三栏结构，以便演示时与 `docs/UI-draft` 并排比对不再有布局级偏差。
2. 作为 owner，我想左栏总宽落在设计稿约 260–280px 区间，以便导航、品牌与列表的密度接近美术稿。
3. 作为使用者，我想现有图标导航（会话/通讯录/网络图/文件柜/刷新/设置）全部保留且可点，以便复刻不减少任何入口。
4. 作为使用者，我想会话列表与搜索框行为不变，以便视觉改版不影响既有操作路径。
5. 作为群聊使用者，我想打开群会话时顶部出现 185px 攻壳城市夜景横幅，以便符合 PRD §5 冻结的头部横幅规格。
6. 作为单聊使用者，我想单聊不显示横幅，以便「仅主群有横幅」的规格成立。
7. 作为会话使用者，我想中栏保留现有消息头、pending 药丸、待领取条、机库入口与全部消息操作，以便业务行为零变化。
8. 作为会话使用者，我想会话打开时右栏展示会话/频道信息，以便一眼看到名称、描述与统计。
9. 作为会话使用者，我想右栏 Members 列出当前群成员及在线/五档点，以便不打开通讯录也能看到谁在。
10. 作为会话使用者，我想右栏 Active agents 按上下文负担展示成员，以便掌握 agent 忙闲。
11. 作为会话使用者，我想右栏在无会话或非会话页签时不占位，以便空态与网络图页签保持原布局。
12. 作为消息阅读者，我想人消息发送者的头像右下角在对端有负担面时显示五档色点，以便扫一眼消息流就知道谁快炸了。
13. 作为消息阅读者，我想拿不到负担数据时状态点回落为现有绿/灰 presence，以便不把「无数据」误画成空闲蓝以外的档（有 burden 且 stale 的语义已由主进程收口为 idle，渲染层只透传）。
14. 作为消息阅读者，我想五档点的悬浮说明直接用主进程拼好的 `burden.title`（档名+%+窗口大小），以便渲染层不新增中文字面量、口径与通讯录一致。
15. 作为会话列表使用者，我想列表行头像同样尊重负担点规则（有 burden 用五档色），以便列表与消息流一致。
16. 作为 agent，我想新组件（右栏面板）走懒加载，以便 App.vue 静态闭包体积不再被推高。
17. 作为维护者，我想本次只改展示层（模板结构、样式、className、静态素材引用），以便 ADR-0003 补丁面清晰、可记账。
18. 作为维护者，我想所有被改的 vendor 文件进入 `patch-allowlist.txt`、新文件有 `new` 条目、`provenance.json` 多行追加一笔，以便 `check:vendor` fail-closed 通过。
19. 作为维护者，我想交付时跑 `check:renderer-bundles` 并如实记录新读数（门已超不挡构建），以便体积债务可见。
20. 作为演示者，我想交付后用 `snapshot:dark` 截主界面，与 `8a1abe5`（launch-plan 三栏稿）并排目视，以便验收有像素证据。
21. 作为色觉受限使用者，我想五档仍由 GIF 配色+周期在允许槽位表达、消息流只用色点+悬浮文案，以便不新增只有颜色单通道的信息。
22. 作为无障碍使用者，我想右栏开关、横幅装饰（`aria-hidden`）与状态点 `title` 符合现有语义习惯，以便键盘与读屏不回退。
23. 作为使用者，我想 `prefers-reduced-motion` 下不新增强制动画，以便与契约 A5 一致。
24. 作为 owner，我想 PRD 禁用画面（Agents 模板网格/Workflows/Community/全局搜索/Projects）不被复刻进来，以便不扩画产品明确不做的页面。
25. 作为 owner，我想设计稿仅作风格参考的区域（如日语标语、底部状态条）可以省略或极简处理，以便优先对齐结构与负担表达，而不是烧入营销文案。

## Implementation Decisions

### 构建/修改的 modules

- **App shell（展示层）**：shell 栅格从「rail + list + content」调整为视觉三栏——左栏合并 rail 与 list 的宽度预算至约 260–280px；content 仍为中栏；**新增右栏槽位**（仅 `chatStore.activeConv` 存在且当前为会话语境时挂载）。
- **右栏详情面板（新，懒加载）**：`defineAsyncComponent`（或项目既有的 shallowRef+dynamic import 模式，与 MessageBody 同策略，避免把异步组件机制拉进静态闭包）；数据全部来自已有 renderer store：会话/群 `GroupView`、`peers`（含 `burden`/`hive`）、`getHiveNetwork()` 可选精简投影。分节：会话信息、Members、Active agents、Pinned（Pinned 若无数据源则显示空节或省略，**不造假数据**）。
- **ChatPane 头部/横幅**：在既有 header 与 pending 条之前插入横幅节点；`v-if` 仅群聊。横幅为纯装饰图 + 底部渐隐，`aria-hidden`；不叠烧入文字的 DOM 双份文案（素材已含频道视觉时不再叠字，或无图时用兜底底纹——与 stage4 原型同一策略）。
- **AvatarMark**：新增可选 `burdenColor?: string`（或等价 prop）；有值时右下角状态点用该色，否则保持现有 `presence` 绿/灰分支。不改头像本体形状、不引入精灵 GIF。
- **MessageRow / ConvList**：计算并传入发送者/会话对端的 `burden.color`；悬浮 `title` 用透传的 `burden.title`。
- **tokens.css**：仅在需要补横幅遮罩、右栏底色等缺失 token 时追加；已有 `#0a0e17` / `#e94560` 不动。

### Interfaces

- `AvatarMark` props 增加可选负担色字段；默认缺省行为与现状逐字节等价（未传 = 现状）。
- 右栏面板 props：会话标识 + 是否群聊 +（可选）关闭回调；内部自取 store，不把成员数组从 App 层穿透。
- 横幅无 props 或仅 `show: boolean`；素材用构建期 URL 引用（与 DispatchNetwork GIF 同模式）。

### 架构决策

- **唯一 seam**：renderer 展示层；burden 判定、跨机通道、阈值、i18n 中文文案生产全部不动。
- **体积**：右栏新组件 + 其样式必须懒加载；App.vue/ChatPane 静态闭包只允许「接线级」增量（插槽、v-if、一行 async 引用）。不抬预算。
- **PRD 禁用画面**不实现；Agents 网格页尤其禁止。
- **精灵位置遵守契约 A1**：消息流/成员行 = 名字头像+五档点；64px GIF 槽仅保留给既有派遣网络图等已合规位；本票不在消息流放 GIF。
- **五档 hex 不改**：`#58a6ff/#3fb950/#d29922/#f0883e/#f85149`，由 `burden.color` 透传，渲染层不建色表。
- 左栏改造以「视觉合并」为主：不删除任何 `.rail-btn` 功能；若 list 宽度压缩导致拥挤，优先缩 padding/字号，不砍行。
- 右栏出现时不挤压消息区可读宽度：中栏 `min-width` 保护 + 右栏固定 320px，设计稿视口（1536 宽）下三栏和 ≈ 画布宽。

### 来自 prototype 的决策片段

stage4 `tachikoma-shell` 已验证的布局常量（来自设计稿测量，直接采用）：

```css
/* 布局蓝图（1536×1024 设计稿） */
--rail-w: 260px;        /* 左栏（PRD）；实现可 260–280 含 list */
--details-w: 320px;     /* 右栏 */
--chat-head-h: 66px;    /* 会话头；现实现另有 84px 等高约束，以现实现对齐线为准微调 */
--banner-h: 185px;      /* PRD 冻结 */
```

横幅策略（prototype 同款）：有图 `object-fit: cover` + 底部 34px 渐隐接到 `--bg-chat`；无图走底纹兜底，不假装有摄影图。

## Testing Decisions

- **好测试的形状**：只断言外部可见行为与契约面——模板结构存在性、懒加载不进静态闭包、未传 burden 时 DOM 与现状一致、`check:vendor` 0 违规、i18n coverage 不红；不断言 CSS 像素的每一处 magic number（像素对齐靠截图目视/compare-screenshots，不写脆弱的 computed style 快照）。
- **将测的 modules**：
  1. `check:renderer-bundles` 输出（记录 JS/CSS 读数，允许已知超支、不允许暴涨到失控——增量应在接线级百～千字节，而非万级）。
  2. `check:vendor`（allowlist/provenance 完整性）。
  3. 既有 `contact-presence.test.ts`（PeerList 分支仍存在，不回归 #252/#57）。
  4. i18n `coverage.test.ts`（新组件若用 `tr('中文')` 必须有 en 模板；更优：右栏文案全部来自 `burden.label`/`burden.title`/store 已有字符串，零新增中文字面量）。
  5. 可选轻量单测：AvatarMark 有/无 burdenColor 两类 class/title 断言（先例：`contact-presence.test.ts` 读源码 contains 的风格）。
- **先例**：`ui/contact-presence.test.ts`（源码结构断言）、`scripts/check-renderer-bundles.test.mjs`（体积门）、`scripts/hive-snapshot.mjs`（真进程 CDP 截图作视觉证据）、handoff 要求的与 `docs/UI-draft` 并排比对。
- **不测**：主进程 burden 算法（已有 agent-status 单测面）、e2e 消息收发（既有 e2e 套件已覆盖，本票不改其行为）。

## Out of Scope

- **adapter 内嵌 vs 探测**（handoff §1①，待 owner 定路线）。
- **机库 3D 网络视图**（issue #26，待 owner 决策完整/轻量/搁置）；liquid-neural-space 原型复刻不进主窗。
- **PRD 禁用画面**：Agents 模板网格、Workflows、Community、全局搜索、Projects 页。
- **pending 跨机缺口**、真 turn 验证、#59 真进程猝死 e2e、#55 黑盒 e2e 等功能票。
- 主进程负担判定、跨机 `agent-status` 通道、阈值调整。
- 抬 renderer 体积预算。
- 浅色主题强制对齐（PRD：深色为主，浅色不强制）。
- 底部营销状态条/日语标语的完整烧入（可选极简，非 AC）。
- 打包产物重建与 `e2e:asar:app` 复验（除非 owner 另开发布票）。

## Further Notes

- **素材已就位**：`assets/hive/state/*.gif`（五档）、`assets/hive/ref/channel-banner.png` + 塔奇克马 PNG（自 stage4 拷入，源于 UI-draft 裁切）。
- **布局蓝图**：`.scratch/ui-blueprint.json`（若生成脚本被 hook 拦截则以本 spec 的常量 + 设计稿 `8a1abe5` 目视为准）。
- **收集归档**：三个 prototype 分支已导出到 `.scratch/collected-prototypes/`；stage4 可运行原型在 main 的 `docs/design-drafts/stage4/`。
- **已知体积**：改前 App.vue 静态 JS 830841/821248、CSS 121233/118784（已超，不挡构建）；本票只许小幅接线增量。
- **视觉权威链**：sprite 契约（硬）> PRD §5 > UI-draft 稿 > stage4 原型；冲突时按 `VISUAL-AUTHORITY.md`。
- **验收口**：`pnpm run check:vendor` + `check:renderer-bundles` 读数 + `snapshot:dark` 与 `8a1abe5` 并排；偏差记本票评论。
- 长程/契约向改动建议 fable 槽；短程样式接线可 opus（参见 `.agents/notes/hive-model-allocation.md`）。
- 环境红线（实现者必读）：禁 `pnpm/npm install`；pnpm 只在仓库根；typecheck 用 vendor 内 `tsc`/`vue-tsc --noEmit --composite false`；vendor 改动只追加记账。
