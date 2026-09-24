# Hive 视觉规范（每个 UI ticket 必守）

> **本文是硬约束，不是参考。** 任何改动 renderer 的 ticket 都必须在交付前对照本文件自查。
> 权威源：`docs/handoff/sprite-and-network-contract.md`（精灵）、`docs/PRD.md` §5（视觉语言）、
> `docs/UI-draft/*.png`（界面稿）、`docs/design-drafts/stage4/`（可运行原型）、`docs/poster/`（物料）。

## 0. 最重要的一条：**不要 teahouse 的绿色**

vendored teahouse 是绿色品牌（`--primary: #3d8b6b` / 深色 `#5bbf91`）。
**Hive 必须换成自己的红+深蓝风格**，否则看起来就是换了名字的茶话间。

改法：`vendor/teahouse/src/renderer/src/styles/tokens.css` 是唯一杠杆点（33 个组件引用 `var(--primary*)`），
换掉该文件的色值即全站换肤。

## 1. 配色 token（Hive 目标值）

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--primary` | `#e94560` | `#e94560` | **Hive 强调红**（替换 teahouse 绿） |
| `--primary-weak` | `rgba(233,69,96,.12)` | `rgba(233,69,96,.18)` | 选中底、气泡底 |
| `--bg-window` | `#0f1420` | `#0a0e17` | 窗口底（PRD 冻结） |
| `--bg-chat` | `#0c111a` | `#080b12` | 聊天区底 |
| `--bg-list` | `#141a26` | `#0d121c` | 列表底 |
| `--text-1` | `#e6edf3` | `#e6edf3` | 主文字 |
| `--text-2` | `#9aa7b5` | `#9aa7b5` | 次文字 |
| `--line` | `rgba(230,237,243,.10)` | `rgba(230,237,243,.10)` | 分隔线 |
| `--rail-bg` | `rgba(15,20,32,.94)` | `rgba(10,14,23,.94)` | 左栏 |

- **底色 `#0a0e17` + 强调红 `#e94560` 是 PRD §5 冻结值，不得改。**
- 深色为主；数字用等宽字体。
- 左栏宽 260px；主群头部横幅高 185px（攻壳城市夜景，仅主群）。

## 2. 五档上下文负担（契约 A2 冻结）

轴名 = **上下文负担**。档位由**配色 + 周期**双重表达，**不画色环**。

| 档 | tag | 判据（used/size） | hex | 资源 | 周期 |
|---|---|---|---|---|---|
| 空闲 | `idle` | 无会话/拿不到数据 | 蓝 `#58a6ff` | `sleep.gif` | 1.5s |
| 轻松 | `easy` | < 10% | 绿 `#3fb950` | `ease.gif` | 1.0s |
| 有点忙 | `busy` | ≥ 10% | 黄 `#d29922` | `tired.gif` | 1.5s |
| 过载 | `overload` | ≥ 20% | 橙 `#f0883e` | `super_tired.gif` | 1.5s |
| 快炸了 | `about-to-blow` | ≥ 40% | 红 `#f85149` | `ran_out.gif` | 2.0s |

离线 / 回收是**独立轴**，不占负担档。

## 3. 精灵用在哪（契约 A1）

| 位置 | 槽位 |
|---|---|
| 派遣网络图节点 | 64px |
| 仪表盘卡片 / 成员详情 | 64px |
| 机库卡片 | 64px |
| 单成员大图 | 128px |
| **消息流 / 成员表头像位** | **不放精灵** → 名字头像 + 右下角**五档状态点**（不是环！） |

缩放只允许整数比或 0.5×；`image-rendering: auto`；min 64px，放不下就不画。

## 4. 已知偏差（遇到就修）

- **#47 把成员行的五档状态点做成了「负担环」**（`PeerList.vue`）。契约要求**名字头像 + 右下角状态点**。
  由 #57 统一修正，或任何后续 ticket 触碰该文件时顺手改正。

## 5. 自查清单（每个 UI ticket 交付前）

- [ ] 没有残留 teahouse 绿（`#3d8b6b` / `#5bbf91`）
- [ ] 底色 `#0a0e17`、强调红 `#e94560`
- [ ] 五档 hex 与上表一致，未自造色环
- [ ] 精灵只在允许位置、槽位 ≥64px、整数比缩放
- [ ] 成员表/消息流用名字头像 + 右下角状态点
- [ ] 对 `docs/UI-draft/*.png` 做一次并排目视比对，偏差记录在 ticket 评论

## 6. 素材位置（都在 main 上了）

```
docs/UI-draft/*.png            9 张界面稿
docs/UI-draft/state/*.gif      五档精灵
docs/design-drafts/stage4/     可运行原型（浏览器直接开）
  tachikoma-shell/             塔奇克马外壳 + state/ 五档 GIF
  tachikoma-assets/            塔奇克马 PNG（蓝/红/白 + 频道横幅）
  agent-chat-shell/            agent 群聊外壳
  agent-teahouse/              群聊承载面
  dispatch-network.html        派遣网络图三方案 + shots/
  sprite-playground.html       精灵播放台
docs/poster/                   易拉宝 + 4 个 icon
```
