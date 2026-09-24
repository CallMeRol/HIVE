# Handoff · Windows 端可行性验证

> 类型：交接文档（历史归档；当时标题使用的「任务信封」旧词已废弃，见 `docs/contracts/parallel-development.md` 旧口径登记表）
> 目标机器：Windows（本批 2 台）
> 发起：Mac 端（hive 项目主开发）
> 时间：2026-09-21

---

## 1. 目标（objective）

**在这台 Windows 机器上验证：teahouse 能否"装得起来、跑得起来、两个实例能互相发现"。**

这是载体选型的关键一步。结论只有两种：

- **通过** → 项目采取「形态 A」：fork teahouse，agent = 一个完整的 teahouse 节点（打 headless 补丁）。
- **不通过** → 项目改采「形态 B」：放弃 Electron 运行时，写一个只实现群文本子集的瘦 Node 节点。

**不要改任何代码、不要提交任何东西。**你只需要产出证据 + 结论。

---

## 2. 为什么是这件事（context）

- 产品：一个把"本地 agent"拉进群当群友的聊天软件（BYOA）。核心创新是**任务级上下文生命周期**（一个会话只干一个任务，任务结束即回收），载体决定权在 teahouse 手上。
- 关键事实（已在 Mac 上确认）：teahouse 的**身份是 `nodeId` 而不是 IP**；官方**支持单机多开**（三个联调客户端），靠环境变量隔离；**没有 headless 模式**（主窗无条件创建）；群聊/讨论组、群内 `@`（协议里已有 `mentions?: string[]`）都是现成的。
- 在 Mac 上这套已经**装好并且构建成功**（electron 22.3.27 + `better-sqlite3` 原生模块已编译 + `out/` 产物齐全）。**未知的只有 Windows。**
- 硬约束：3 台机器 = 1 Mac + 2 Windows；**没有服务器**、不要自托管、要 P2P；接受 GPL-3.0；MVP 只做局域网，跨网留接口。

参考材料（需要细节时再看，不要全文读）：

- 上游仓库：<https://github.com/skyjt/teahouse>（GPL-3.0-only，Electron + Vue + TS）
- 身份与多开：`src/main/net/peer-registry.ts`（按 `nodeId` 建表）、`scripts/dev-client-1.sh`（`PANTRY_USER_DATA` / `PANTRY_UDP_PORT` / `PANTRY_TCP_PORT` / `PANTRY_PEERS`）
- 无 headless：`src/main/index.ts`（主窗无条件创建）
- `@` 在协议里：`src/shared/protocol.ts`（`mentions?: string[]`）
- 本项目调研：`docs/research/local-agent-control-plane.md`、`docs/research/p2p-mesh-vpn.md`

---

## 3. 验收标准（acceptance criteria）

逐条给"通过 / 失败 + 原文证据"：

| # | 检查项 | 通过判据 |
|---|---|---|
| A1 | 环境 | `node -v` ≥ 18；`npm -v` 可用；能访问 npm registry |
| A2 | 克隆 | `git clone https://github.com/skyjt/teahouse` 成功 |
| A3 | 安装 | `npm install` 成功（注意 `postinstall` 会 rebuild `better-sqlite3` 原生模块） |
| A4 | 构建 | `npm run build` 成功，存在 `out/main/`、`out/preload/`、`out/renderer/` |
| A5 | 启动 | 能起一个客户端窗口（`npm run dev` 或 `npm start`） |
| A6 | 单机多开 | 用官方脚本或环境变量起**第二个**实例，两窗口互相出现在联系人/在线列表里 |
| A7 | 群聊 | 能建一个"讨论组"，两实例都在组里，能互发消息 |
| A8 | `@` | 群内能 @ 到另一个实例（被 @ 方有更明确的提示） |
| A9 | 三开（可选） | 能同时跑 3 个实例（模拟"人 + 2 个 agent 节点"） |

**只要 A1–A6 全过，就把结论写成"形态 A 可用"**；A7–A9 是加分证据。

---

## 4. 步骤

1. 记录环境：Windows 版本（`winver`）、`node -v`、`npm -v`、是否走代理。
2. 克隆到一个**临时目录**（不要放进任何现有项目）。
3. `npm install`。**如果失败，把完整错误原文留下来**（尤其是 `better-sqlite3` / `node-gyp` / 网络相关），不要自己尝试各种 workaround 超过 2 次。
4. `npm run build`，确认三个产物目录存在。
5. 起第一个实例，确认窗口出现、能进主界面。
6. 起第二个实例（用 `scripts/dev-client-2.sh` 的等价环境变量，Windows 下直接设 `PANTRY_USER_DATA` / `PANTRY_UDP_PORT` / `PANTRY_TCP_PORT` / `PANTRY_PEERS`，端口用不同的，例如 17878+27878、17879+27879）。
7. 确认两实例互相可见 → 建讨论组 → 互发消息 → 试群内 `@`。
8. 观察并记录：**Windows 防火墙是否弹窗拦截 UDP**（这是最可能的坑，若弹窗请记录弹窗原文与你的选择）。

---

## 5. 回报格式（请照抄这个结构，缺项写"未验证"）

```markdown
## 结论
形态 A（teahouse 完整节点）：可用 / 不可用
一句话理由：

## 验收逐项
| # | 检查项 | 结果 | 证据（命令 + 关键输出，≤5 行） |
|---|---|---|---|
| A1 | ... | 通过/失败 | ... |

## 阻塞点
（每一项：现象 / 错误原文 / 已尝试 / 猜测原因）

## 关键数字
npm install 耗时：  构建耗时：  单实例内存占用（任务管理器）：

## 下一步建议
（一句话：如果要在 2 天内在这台机器上跑 3 个节点，你建议怎么做）
```

---

## 6. 边界（不要做的事）

- ❌ 不要修改 teahouse 任何源码（这一步只验证，不改）
- ❌ 不要提交 / 推送 / 开 PR
- ❌ 不要为了让它跑起来而改系统设置（除了允许防火墙弹窗）
- ❌ 不要尝试装 headless 相关的东西（那是下一步的事）
- ❌ 不要在这台机器上 clone 本项目的其他仓库

## 7. 建议调用哪些 skill

- `run` —— 需要"怎么把应用跑起来并确认它在工作"时
- `diagnosing-bugs` —— `npm install` / 构建失败且原因不明时（不要盲试）

## 8. 已知地雷

1. **`better-sqlite3` 原生模块**要按 Electron 的 ABI 重编译（`postinstall` 会做），Windows 上需要编译工具链；失败概率最高的一项。
2. **Windows 防火墙**会拦 UDP 17878（局域网发现靠 UDP 广播）。
3. **两个实例在同一台机器**时，端口必须错开，否则后起的实例会占用失败。
4. 局域网发现走 `255.255.255.255` 广播；**若所在 Wi-Fi 开了客户端隔离（AP isolation），发现会直接失效**——遇到"两实例互不可见"先用静态对端 `PANTRY_PEERS` 排除这个变量。

---

## 9. 补充要求（Mac 端追加）

**时间预算：45 分钟。**超时不要继续硬啃，直接回报"卡在哪一步 + 错误原文"，这比一个"好像能跑"的模糊结论有用得多。

**必须记录、不许省略的四项**（否则结论无法复现）：

1. **版本钉死**：`git -C <teahouse 目录> rev-parse HEAD`（拿到 commit hash）、`node -v`、`npm -v`、`winver` 的版本号。
2. **代理**：如果 npm 需要走代理才装得上，如实写明用了什么代理/镜像（这台 Mac 上就是靠代理 workaround 才装成功的）。**不要把"我改了 npm 源"这类信息当成内部细节略过。**
3. **防火墙**：Windows 防火墙是否弹窗拦了 UDP？你选了什么？（这是最可能被忽略的变量）
4. **内存占用**：任务管理器里**每个** teahouse 实例的 RSS（内存）。这直接决定 demo 时一台机器能不能同时跑 3 个节点。

**失败也要有价值**：如果只卡在 A3（`npm install`）或 A4（`npm run build`），请把**完整错误原文**贴出来（尤其 `better-sqlite3` / `node-gyp` / 网络相关的部分），并说明你是否已经试过 workaround、试了几次。

**不要让 clone 目录被清掉**：如果结论是"形态 A 可用"，下一步就是在这个目录上打 headless 补丁，所以把那份 clone 留着（并记下它的绝对路径）。

**顺手带一条额外情报（不在验收项内，但很省一趟）**：这台机器上 `claude`（Claude Code）和 `codex` CLI 装了没有？版本多少？（demo 时 agent 要跑在真实机器上。）
