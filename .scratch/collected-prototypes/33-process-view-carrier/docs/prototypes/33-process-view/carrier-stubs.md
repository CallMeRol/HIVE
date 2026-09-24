# #33 · 过程台承载面 —— 三候选粗糙桩

> 目的：对比「台」的三种承载面：(a) local-api 本机网页（浏览器标签页）/ (b) 应用内新窗口加载同页（Electron BrowserWindow）/ (c) teahouse 内新面板（改上游 renderer）。  
> 桩是**静态、提纲级**，只服务对比与决策，不服务实现。  
> 结构对照 #33 三问。

---

## 候选 (a)：local-api 本机网页（浏览器标签页）

**桩文件**：[`local-api-static.html`](./local-api-static.html)

- 零行上游改动。`src/main/local-api/` 目录是上游设计预留（landmines 卡 9：全仓零代码、零残骸），新代码全部落新目录，与 #22 白名单天然兼容。
- 免费拿到：Markdown / 代码块（highlight.js）/ 实时滚动（SSE polyfill stub：占位一条 `/events` EventSource 注释）。
- 短板：**不在应用内**（多一个浏览器标签；演示时需切窗口）。

## 候选 (b)：应用内新窗口（BrowserWindow 加载同页）

**桩文件**：[`in-app-window-outline.md`](./in-app-window-outline.md)（window 代码轮廓）＋复用 (a) 的静态页。

- 同一 local-api 页面，只是套一层 `BrowserWindow` → **「应用内一个位置」达成**，同时保住 (a) 的零/极低上游改动 + 免费渲染 + SSE。
- `index.ts` 补丁：1 处 hunk（`createProcessWindow()` + IPC handler，≤20 行），符合 #22 白名单（仅 `index.ts` + 新文件新目录）。
- 卡 2（`window-all-closed → app.quit()`）处理：过程窗不计入主窗生命周期；headless 短路沿用 #14 已定的分支，新增窗口在 headless 下不创建（因 headless 不渲染任何窗口）。
- 上游 renderer 零改动（代价：与 teahouse 主窗风格略异，但两窗共用同一 CSS 基础）。

## 候选 (c)：teahouse 内新面板（改上游 renderer）

**桩文件**：[`teahouse-panel-outline.md`](./teahouse-panel-outline.md)（上游文件级改动清单）。

- 「应用内一个位置」最彻底；但最小要改 **2 个上游文件**（`GroupPanel.vue` 成员点击入口 + `index.html`/`App.vue` 路由注册新增成员详情卡），另加 1 个新组件文件。
- 连带必须解决「agent 成员与人在 UI 上无区别」（`GroupPanel.vue:308-345`：成员列表纯人形渲染、`CAPS` 无 agent 位）——按 #33 规则这归「成员身份标识」另一张票，不是本票范畴。
- 过程数据要从主进程 IPC 穿过 `preload` 边界，比 local-api 直连多一层桥。

---

## 评分（按 #33 问题 1 三轴）

| 候选 | 应用内一个位置 | 零/极低上游改动 | 免费 Markdown/代码块/实时滚动 | 备注 |
|---|---|---|---|---|
| (a) local-api 网页 | ✗（浏览器标签） | ✓✓（0 上游文件） | ✓✓（highlight.js + EventSource polyfill） | 演示需切窗 |
| (b) 应用内新窗口 | ✓✓ | ✓（1 hunk @ `index.ts`） | ✓✓（同 (a) 页） | **最优解** |
| (c) teahouse 内面板 | ✓✓ | ✗（2+ 上游文件 + CAPS 问题） | ✓ | 触及「成员身份标识」 |

**初步倾向**：(b) —— 同页套壳，成本最小、满足「应用内」+「低改动」双要求。
