# 视觉权威索引（Visual Authority）

> **所有 UI 实现票开工前必读。** 本文件是视觉还原的唯一入口索引；冲突时以本表列出的「权威源」为准。
> 起因：拆票时没有把视觉还原写进任何 ticket 的 AC，导致实现者不知道去哪对齐。本文件是补救。

## 权威层级

| 层级 | 文档 | 管什么 |
|---|---|---|
| **硬约束** | `docs/handoff/sprite-and-network-contract.md` | 精灵规格（128×128/6 帧/GIF）、五档 hex 与周期、64px 槽位下限、禁非整数比缩放、网络图语义 |
| **视觉语言** | `docs/PRD.md` §5「已冻结的视觉语言」 | 配色（底 `#0a0e17` / 强调 `#e94560`）、等宽数字、左栏 260px、头部横幅 185px |
| **界面稿** | `docs/UI-draft/*.png`（9 张）+ `docs/UI-draft/state/*.gif`（5 档精灵） | 布局、间距、组件形态的实际观感 |
| **可运行原型** | `docs/design-drafts/stage4/` 下的 HTML | 交互与视觉的参考实现（可直接在浏览器打开对照） |
| **对外物料** | `docs/poster/` | 易拉宝（`Final-Roll-up Banner.jpg`）+ 应用 icon（`icon.png` 等 4 个） |

## 五档上下文负担（契约 A2 冻结值）

**轴名 = 上下文负担（Burden）**；档位由**配色 + 周期**双重表达，**不另画色环**。

| 档位 | tag | 判据（窗口占用 used/size） | 配色 hex | 资源 | 周期 |
|---|---|---|---|---|---|
| 空闲 | `idle` | 无会话或拿不到数据 | 蓝 `#58a6ff` | `sleep.gif` | 1.5s |
| 轻松 | `easy` | < 10% | 绿 `#3fb950` | `ease.gif` | 1.0s |
| 有点忙 | `busy` | ≥ 10% | 黄 `#d29922` | `tired.gif` | 1.5s |
| 过载 | `overload` | ≥ 20% | 橙 `#f0883e` | `super_tired.gif` | 1.5s |
| 快炸了 | `about-to-blow` | ≥ 40% | 红 `#f85149` | `ran_out.gif` | 2.0s |

离线、回收是**独立状态轴**，不占负担档、不改小圆点。

## 精灵出现位置（契约 A1）

| 位置 | 槽位 | 说明 |
|---|---|---|
| 派遣网络图节点 | 64px | 主用场 |
| 仪表盘卡片 / 成员详情 | 64px | |
| 机库卡片 | 64px | |
| 单成员大图 | 128px（1×） | |
| **消息流 / 成员表头像位** | **不放精灵** | 名字头像 + 右下角**五档状态点**（不是色环） |

**缩放只允许整数比或 0.5×**；`image-rendering: auto`（不用 `pixelated`）。min 64px，放不下就不画精灵。

## 可运行原型（浏览器直接打开）

- `stage4/tachikoma-shell/index.html` —— 塔奇克马外壳（含 `state/` 五档 GIF）
- `stage4/tachikoma-assets/` —— 塔奇克马 PNG 素材（蓝/红/白 + 频道横幅）
- `stage4/agent-chat-shell/index.html` —— agent 群聊外壳
- `stage4/agent-teahouse/index.html` —— 群聊承载面
- `stage4/dispatch-network.html` —— 派遣网络图三方案 + `shots/` 截图
- `stage4/sprite-playground.html` —— 精灵播放台

## 已知形态偏差（待修）

**#47 把成员行的「五档状态点」实现成了「负担环」**（`PeerList.vue`，7 行改动）。
契约 A1 要求的是**名字头像 + 右下角五档状态点**，不是环。处置：由 #57（成员表 + 网络图，视觉最重）统一修正，
或在 #62 视觉验收时打回。

## 待补齐（票据缺口）

当前没有任何 ticket 的 AC 显式要求「按上述权威源还原」。已补：
- #57：追加视觉还原 AC
- #52：追加机库卡片/下钻的视觉 AC
- #62：追加与设计稿的并排比对验收

后续新票也必须在 AC 里引用本文件。
