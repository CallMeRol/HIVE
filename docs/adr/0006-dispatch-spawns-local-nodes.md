# 派遣链在根主人单机 spawn 本地节点

- **Status**: accepted
- **源 issue**: [toRolex/hive#39](https://github.com/toRolex/hive/issues/39)（经五轮 grilling 定案，机制结论均带 teahouse `file:line`）

成员的机器归属 = 成员主人的机器，派遣链的「主人」沿链传递 ⇒ MVP 内整条派遣链落在根主人单机、无跨机派遣（记 P1）。摇新成员 = 离线预生成 `identity.json` → `updateGroup(invite)`（无权限门）→ spawn 节点，靠 teahouse 既有离线补发队列 bootstrap，零中间态；1 成员 = 1 Electron 节点 + 1 ACP 子进程；userData 每次新建永不复用；回收不对称（活着自 `leave`、猝死需 admin `remove`，建群时 `set-admin`）；**不设总成员上限**，规模只由深度×并发管，扛不住 = 一条派遣失败消息。

## Context

- `CONTEXT.md` 定「成员表一条 = 一个独立 agent 进程」，#24 定了 1:N 派遣的编排语义，但机制是空的：谁在什么时候起什么进程未定。[#13](https://github.com/toRolex/hive/issues/13) 把「初始节点」交给 `nodes.conf` + 一键启动脚本、「动态成员」留给 bridge，而 #14 的 bridge 规格没有起节点动作。
- 三条一手事实（teahouse v0.60.2）：① 身份 = `<userData>/identity.json`，仅缺失/非法时自生成；② `updateGroup(kind:'invite')` **无权限门**（`canManage` 只在 rename/remove 等分支检查），`remove` **需要** owner/admin/密码；③ 离线不阻碍登记——无 ACK 入补发队列，对端上线 `flushQueue`，新节点对未知群 `canApplyRemoteInfo → true`。
- `local-api` 只绑 `127.0.0.1`（#14 §3）⇒ 天然没有「远端命令起进程」的面。
- 同机 spawn 让「生命周期归派遣者」从约定变成 OS 事实：新节点是派遣者节点进程的子进程，`exit` 事件即时可见——正是 #18 剧本一需要的 ≤5s 触发源。
- 任何成员可自 `leave()`（零权限）；节点进程猝死时没人能替它 leave → 必须有 admin 路径。

- `mentions` 不落消息表、单例锁按 `userData` 隔离等既有地雷（#14）决定了「每成员独立 `PANTRY_USER_DATA`、新建不复用」是硬约束而非偏好。
- 端口与 peers 注入沿用 #13 契约：`PANTRY_PEERS` 是叠加广播而非绕过，同机多节点时必须静态对端（`127.0.0.1:<udpPort>` 兄弟清单）。

## Considered Options

1. **（选定）MVP 单机：谁摇人谁在本机 fork。** 成员一律跑在主人的机器上，派遣者又跑在自己主人的机器上 ⇒ 整链 = 根主人单机，1:N 展开范围 = 那一台机器。
2. **跨机 daemon / LAN 开放 local-api + 鉴权——否决，记 P1。** 新控制面 + 新白名单面，与 #7「跨网 P1」冲突；留在迷雾「跨网落地」。超限的人肉出口 = @主人 用 #13 `scripts/live/up.sh` 在另一台机器起节点（复用 `nodes.conf`，零新增面），那是路径不是机制。
3. **预置 userData / 身份池复用——否决。** 复用 = 新成员背着旧账本，违反任务级隔离；每次派遣**新建、永不复用**。另：buzz 的 `--agents 1..32` 不是先例——那是同一把身份 + N 子进程池，与「每次摇人 = 新身份 + 新进程」不是一回事（buzz 代码本身也因无 JS 绑定被 #25 裁掉，此处只借其「离线生成身份 → 显式登记 → 启动注入」的做法）。
4. **机器级闸门（`HIVE_MAX_NODES_PER_MACHINE` 一类）——否决。** 成员规模只由 #24 已定的两旋钮管：单次派遣并发（默认 5）× 派遣深度（默认 3）；扛不住 = 进程起不来 → 失败语义（不预防、不静默降级）。此前「同机钉在 6」口径作废；RSS 实测降级为现场容量事实，graduate 至 #32。

## Decision

- **起进程**：派遣者 bridge 本机 spawn；`local-api` 不出 loopback，MVP 无跨机派遣。
- **身份与入群（先 invite 后起）**：现场生成 uuid → 建新目录 → 写 `identity.json`（fail-closed：缺失即报错，不静默 `randomUUID()` 兜底）+ 预置 `config.json` 的 `nick`（否则默认取 OS 用户名、群里一堆同名）→ `updateGroup(invite)`（rev+1、新 nodeId 的 info 进补发队列）→ spawn → 上线补发 → 节点自己建群。顺序零成本（补发队列保证），消掉「已起未入群」中间态与邀请回滚分支。
- **进程结构**：1 成员 = 1 Electron 节点（`PANTRY_HEADLESS=1`）+ 1 ACP 子进程（节点内 `agent-bridge` 拉起）；端口 `base + 10000×slot`，slot 表归本机派遣者 bridge（内存+落盘），退出后归还。
- **身份注入校验**：轮询 `/v1/health` ≤30s，nodeId 必须等于预生成值，不等即失败。
- **回收不对称**：活着（正常回收 / ACP 子进程猝死）→ 节点自己 `leave()`，零权限；节点进程整体猝死 → 没人能自 leave → 派遣者以 admin `remove`（建群时 owner `set-admin` 给派遣者，bridge 自我约束只 remove 自己派遣的成员）。杀法 = `POST /v1/lifecycle/quit` 等 ≥3s → 强杀进程树，ACP 孙进程用 `/v1/health` 的 `agentPid` 补杀。
- **失败语义**：spawn/health/入群任一失败 → 群里一条「派遣失败：原因」、任务回待领取、@原主人，自动重试 ≤1 次；仍失败则 admin `remove` 或 @主人。不设总成员上限。

## Consequences

- 跨机派遣、同机真实 RSS 上限均为 P1/未验证：前者留迷雾，后者 graduate 至 #32（`windows-verification.md` 里「95–120 MiB/节点」是模板数字、仓库无出处，不得再当依据）。
- 对 #13 的实现期增量：建群时 `set-admin` 派遣者、起节点时预置 nick——均在既有零白名单破口内；不改 `nodes.conf`。
- 对 #14 的增量：`/v1/health` 增 `agentPid` 字段；「spawn 子节点」是 `agent-bridge` 新职责（新文件内，零破口）。
- 对 #5 的边界：派遣者的 admin 只是服务性回收权、只作用于自己派遣的成员；「移出仅主人」针对人对成员的口径不变。
- 演示峰值不人为压制（此前「钉在 6」口径作废）；规模失控的对外表现是一条可读的失败消息，不是静默降级。
- 「先 invite 后起」整链未在真机跑过（判定点：起节点 ≤30s 内群里出现新成员行且能被 @）；`invite` 与并发变更（移出/改名）叠加行为未查；闲置自净（复用 buzz `EXIT_AFTER_INACTIVITY` 语义：无活跃 turn 超阈值 → 自 leave + 退出）阈值未定标。
