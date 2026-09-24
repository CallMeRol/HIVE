# PROTOTYPE · Tachikoma 外壳像素级复刻（wayfinder ticket #37）

**问题**：把 buzz 的 agent 成员概念注入茶话间，左侧群聊框架 + 完整消息流该长什么样？

**参考图（唯一视觉真相）**：`docs/UI-draft/*.png`（美术交付的 9 张 Tachikoma 外壳）

| 参考图 | 复刻内容 |
|--------|----------|
| `804f1f6…png` | launch-plan 频道视图（主结构） |
| `6b2a777…png` | DM 详情面板（右侧 agent 卡片） |
| `33cde72…png` | Agent 网格（AI 徽章 + Active/Idle 药丸） |

**业务行为（唯一行为真相）**：wayfinder map #20 的已定 decisions。

## 实现要点

- **深色主题**：`#0a0e17` 背景 + `#e94560` 红色 accent + 等宽数字
- **左栏**：Tachikoma logo（红色精灵）+ 导航（Home/Agents/Projects/Search/Settings）+ Channels / Direct messages / Agent 成员三段
- **agent = 塔奇克马精灵图**（红/蓝/白 128px，像素风）+ `AI` 徽章 + `Active`/`Idle`/`pending` 药丸
- **群聊消息流**：人 = 圆形字母头像；agent = 塔奇克马方形头像 + 五档状态点（#17 契约位置）
- **右侧详情面板**：Channel 信息 / Members / Active agents（塔奇克马 + Online/Idle）/ Pinned files
- **头部 banner**：攻壳城市夜景（自美术稿裁切）
- **底部状态条**：`HUMAN × AI × A BRIGHTER TOMORROW` + `TACHIKOMA V1.0.0`

## 约束（map #20 decisions）

- **#36**：机库 = 过程明细、仪表盘 = 聚合概览、不同轴
- **#17**：五档色 idle `#58a6ff` / easy `#3fb950` / busy `#d29922` / over `#f0883e` / blow `#f85149`
- **#34**：本机视角（Mac = 演示主机）
- **#29 / #30**：群内只发正式消息；@agent 需 pending 收集期（点击 pending 药丸 = 主人确认键）

## 文件

- `index.html` — 单文件 prototype（state 全在内存）
- `tachikoma-assets/` — 自美术稿裁切的精灵图 + banner
  - `tachikoma-red.png` / `tachikoma-blue.png` / `tachikoma-white.png`
  - `channel-banner.png`

## 启动

双击 `index.html`，无需服务器。

## 后续

- 答案（结构是否需要调整 / 从美术稿还偷什么）记入 #37 resolution
- 本分支 throwaway：不进入 main，只作 primary source 存档
