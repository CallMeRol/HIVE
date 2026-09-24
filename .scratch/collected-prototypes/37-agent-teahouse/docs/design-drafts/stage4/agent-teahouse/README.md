# PROTOTYPE · 茶话间 + agent 接入（wayfinder ticket #37）

**问题**：把 buzz 的 agent 成员概念注入 teahouse 茶话间，左侧群聊框架该怎么长？

**形态**：UI prototype（子形态 A：对现有 teahouse 左侧通讯录的调整），单文件 HTML + 截图底图，双击 `index.html` 即可启动，无需服务器。

## 三个 variant（底部浮动条 / `?variant=A|B|C` / `←` `→` 键切换）

| Variant | 名称 | 结构 |
|---------|------|------|
| **A** | 通讯录内混合 | agent 与人同列；五档状态点（#17 契约位置 = 头像右下角）+「AI」徽章 + 角色行；顶部 filter chips（全部 / 人 / Agent） |
| **B** | 两段式 | 通讯录分「成员（人）」与「Agent 成员」两段；agent 行多一个「过程」按钮 → 打开机库（#33 定案：应用内新窗口 + 形态 C 卡片网格） |
| **C** | 悬浮 Agent Dock | 通讯录保持纯人；agent 收进底部悬浮 Dock（常驻 4 槽 + 弹出迷你派遣网络图 = 仪表盘入口） |

## 约束（来自 map #20 的 decisions）

- **#36 词表**：机库 = per-member 过程明细、仪表盘 = 聚合概览，不同轴
- **#17**：五档色 idle 蓝 `#58a6ff` / `<10%` 绿 `#3fb950` / `≥10%` 黄 `#d29922` / `≥20%` 橙 `#f0883e` / `≥40%` 红 `#f85149`
- **#34 迷雾**：跨机可见性未决 → 本 prototype 只演示本机视角（Mac = 演示主机）
- **#29 / #30**：群内只发正式消息；@agent 需 pending 收集期确认（badge 已预留）

## 文件

- `index.html` — 单文件 prototype（state 全在内存，无持久化）
- `teahouse-screenshot.png` — teahouse 空状态截图（底图，来源 CleanShot 2026-09-22 at 16.58.51）

## 后续

- 答案（哪个 variant 胜出 / 各偷一点）记入 #37 的 resolution
- 本分支是 throwaway：不进入 main，只作为 primary source 存档
