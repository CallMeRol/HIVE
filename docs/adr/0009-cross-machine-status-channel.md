# 跨机状态走私有 agent-status 定向单播：10s 节拍、30s TTL

跨机 agent 状态可见性已由 #34 证明零上游改动可行（未知信封放行 + caps 空位）；两条待 owner 拍板的边界——可见范围与上报节拍——由 #38 定案。我们决定：hive 私有 `agent-status` 信封 best-effort **定向单播**给「同群 ∩ `ag1` 在线」节点；每节点独立上报、节拍 10s、无数据 TTL 30s（不复用 `offlineAfter` 90s）；payload 定稿并入站自校验；不做隐私 UI 开关（`ag1` 位即开关）；UI = PeerList 就地五色环。参数表已落 `docs/handoff/sprite-and-network-contract.md` A2，此处补 why。

## Status

accepted

## Decision

- **通道**
  - hive 私有信封类型 `agent-status`（`v:1`），best-effort 单播，语义镜像 `messenger.sendBestEffort`（不 ACK / 不入队 / 不改在线态 / 不改 dedup）。
  - payload **不进 codec 白名单** ⇒ 入站必须 hive 自校验（不可信输入）。
  - 上游改动 = 0（未知类型放行由 `codec.ts` + 测试固定）。
- **可见边界 = 定向单播给「同群 ∩ `ag1` 在线」**
  - nodeId 直接取自群成员表，零新发现机制。
  - `ag1` 经既有 `saveProfileCaps` + `announceProfile` 传播，不改 `protocol.ts` 的 `CAPS` 常量——因此不需要按 #22/#35 规矩做第二次白名单破口记账。
- **节拍 10s、无数据 TTL 30s（3× 节拍）**
  - 拿不到数据落 idle 蓝，对齐 `CONTEXT.md`"空闲 = 无在跑会话 **或** 拿不到负担数据"。
  - **明确不复用 `offlineAfter` 90s**——节点在线而 agent 已死会继续显示旧档 = 撒谎；离线是底座事实，由成员表置灰承担，不参与圆点判定（#26 口径不变）。
- **payload 定稿**：`{ts, pct, sizeTokens, tag, goal?≤120B, role?≤24B}`
  - 已删 `rev`（上报进程重启计数器归零问题一并消失），乱序/旧包按 `ts` 丢弃；拿不到数据整条不发，由 TTL 表达"没数据"。
  - 入站超标即整包丢、不降级不猜；字段约束与校验规则见参数表指针（A2）。
- **不做隐私 UI 开关**：`ag1` 位本身就是开关——不声明就只有绿/灰点，MVP 只留隐藏配置位。
- **UI = PeerList 就地五色环**
  - 就地升级 `PeerList.vue` 绿/灰点，对齐 #17 A1"头像右下角五档点"，不新增组件、不动头像位。
  - 只对「同群 `ag1`」行画环；结构性无状态的对端（不同群 / 未声明 `ag1` / 旧版本）保留绿/灰点，**不**落 idle 蓝。
- **拍板节拍的量化**：入站令牌桶 30 包/秒/源 IP（burst 60），同机多节点**共享一个桶**。
  - 峰值 31 成员 3 机均分 ⇒ 本机 10 节点、远端 `ag1` 对端 21：@10s = 21 pps + presence 7.7 pps ≈ 29 pps 贴桶顶；@5s = 42 pps 必超。
  - 溢出是优雅的——丢的只是本拍状态、下一拍恢复；猝死判定走子进程退出 / TCP，不依赖本通道。

## Considered Options

- **子网广播（否决）**：向全网段泄露"你机器上的 agent 快炸了"；多网卡/VPN 机器会喷到无关网段。
- **发给所有 `ag1` 节点（否决）**：多发包又扩大可见面，收益为零——目标集本该是同群交集。
- **复用 `offlineAfter` 90s 作衰减（否决）**：节点在线而 agent 死后持续显示旧档；离线与负担档不同轴（#26）。
- **每机聚合单包（否决）**：需要一条本机跨进程协调通道（每节点独立 Electron 进程 + 独立 userData），MVP 不值；退路留在"同机多 agent 节点的资源与上限"迷雾，实测真丢包再 graduate。
- **30s / 5s 节拍（否决）**：30s 对齐 presence 最省但负担档变化太钝；5s 峰值 42 pps 超桶顶、量化下丢 ~40%。10s 是实时性与桶预算的平衡点（量化见上）。

## 源

- Issue: https://github.com/toRolex/hive/issues/38 （两轮 11 条拍板 resolution 为终版）
- 证据：https://github.com/toRolex/hive/issues/34 、`docs/research/cross-machine-agent-status.md` §4.2/§4.4
- 参数表：`docs/handoff/sprite-and-network-contract.md` A2（跨机行 / 结构性无状态不画环 / 节拍与 TTL 已同步）
- 关联：#26（idle 五档）、#17（A1 五档点）、#29 决定 8（本机视角边界）、#37（仪表盘拼法归它）
