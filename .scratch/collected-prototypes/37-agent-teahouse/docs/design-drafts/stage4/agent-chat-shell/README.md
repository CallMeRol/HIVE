# PROTOTYPE · 茶话间 + agent 完整群聊外壳（wayfinder ticket #37）

**问题**：Slack / buzz 式完整应用外壳 —— 左侧 = 工作区 rail + 群聊列表（无人物头像），群聊消息流里才出现头像。agent 成员怎么长？

**形态**：UI prototype（子形态 A：对 teahouse 应用外壳的调整），单文件 HTML + 截图底图，双击 `index.html` 启动，无需服务器。

## 外壳结构（三 variant 共用）

```
┌─────────────────────────────────────┐
│ 工作区（茶话间 logo + 名称）          │
├─────────────────────────────────────┤
│ 左栏（272px）        │ 右区：群聊     │
│ 群聊列表 / agent     │ 聊天头（堆叠头像│
│ （三 variant 分歧）   │ + 成员数）    │
│                     │ 消息流（头像） │
│                     │ 输入框        │
└─────────────────────────────────────┘
```

- **头像只出现在群聊**：聊天头右侧「堆叠头像」（人圆 / agent 方 + 五档点）、消息流每条消息左侧（人圆角圆 / agent 圆角方 + AI 徽章）
- **左栏零人物头像**：只有群（# hash）与 agent（bot 方块）

## 三个 variant（底部浮动条 / `?variant=A|B|C` / `← →` 键）

| Variant | 名称 | 结构 |
|---------|------|------|
| **A** | 群列表内混合 | 群 + agent 同列；agent 行内嵌五档点 + 负担% + pending 计数；顶部 chips（全部/群/Agent） |
| **B** | 两段式 | 群聊列表 + 独立「Agent 成员」分段；agent 行多「过程」按钮 → 机库（#33） |
| **C** | 悬浮 Agent Dock | 列表纯群；agent 收进底部悬浮 Dock（4 槽 + 弹出迷你派遣网络图） |

## 约束

- **#36**：机库 = 过程明细、仪表盘 = 聚合概览、不同轴
- **#17**：五档色 idle `#58a6ff` / easy `#3fb950` / busy `#d29922` / over `#f0883e` / blow `#f85149`
- **#34**：本机视角（Mac = 演示主机）
- **#29 / #30**：群内只发正式消息；@agent 需 pending 收集期

## 文件

- `index.html` — 单文件 prototype（state 全在内存）
- `teahouse-screenshot.png` — teahouse 空状态截图（底图，CleanShot 2026-09-22 at 16.58.51）

## 后续

- 答案（哪个 variant 胜出 / 各偷一点）记入 #37 resolution
- 本分支 throwaway：不进入 main，只作 primary source 存档
