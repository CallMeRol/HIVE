# P0 只做局域网，跨网留接口，第一顺位 EasyTier

MVP（P0）只做局域网互通，跨网不落地、只留接口 = `PANTRY_PEERS` 静态对端 + 网络层可替换；若未来做跨网，第一顺位是 EasyTier。产品层「故意的 P0 边界」理由见 `docs/PRD.md` §3（MVP 不做跨网）、§6（载体与网络决策）、§9 反方五，此处只给指针。

## Status

accepted

## Decision

- **P0 范围**：局域网内多机协作（1 台 Mac + 2 台 Windows），跨网只留接口不实现。
- **接口形态**：`PANTRY_PEERS` 静态对端列表 + 网络层可替换（跨网栈是实现细节，应用层不感知）。
- **跨网第一顺位 = EasyTier**：`network_name` + `network_secret` 即邀请码；公共节点只作打洞失败时的兜底中继（非自建控制面）；`--credential` 支持访客；Win/Mac 全平台；Apache-2.0。是两轮 research 中唯一同时满足「零自建服务器 + 无统一账号 + 邀请码即入」的成熟开箱 VPN 成品。
- **安全对照**（沿用 issue 结论）：网络层中继（EasyTier/WireGuard）是加密隧道，中继看不到内容；应用层 relay（Buzz/Nostr 类）是明文中转，运营者可见内容——跨网选网络层方案。

### 两个必须记住的硬事实

- `PANTRY_PEERS` 是**叠加广播、不是绕过广播**：想纯静态对端需改代码或用 `broadcastTargets` 注入。
- **UDP 广播不穿越 TUN overlay**：跨网场景下发现必须靠静态对端，不能指望局域网广播穿透。

### 发现主路径（与本决策强相关，一节带过）

局域网发现以静态对端为主、统一 UDP 17878——与「网络层可替换」同构：P0 靠静态对端即可完成发现与互通，广播只是局域网内的便利，跨网时不被依赖。细节属实现层，不在本 ADR 展开。

## Considered Options（跨网栈否决理由）

- **EasyTier（第一顺位，P0 不落地）**——唯一三约束全满足的成品，见上。
- **Yggdrasil（否决）**——虽满足零服务器 + 零账号，但：① 默认一张全球统一的网、**无私有网隔离**；② **IPv6-only overlay（200::/7）**，而 teahouse 网络层是 **IPv4 假设**（只枚举非回环 IPv4 网卡、广播 `255.255.255.255`），直接组合必撞；③ 加入需手动互换 peer 地址，非邀请码即入。
- **Tailscale 类（否决）**——强制账号体系（跨账号互通双方仍需账号），且控制面闭源托管，违反「零服务器 + 零账号」硬约束（见 `docs/PRD.md` §3「不做云端账号体系」）。
- **纯打洞自研（否决）**——打洞无法保证：Tailscale 自报典型环境 >90%，libp2p DCUtR 学术实测 70% ± 7.1%；中继兜底是必需品，而免费公共中继 = 他人的基础设施，自研等于把可用性押在别人身上。
- **其余开箱方案（否决）**——Nebula/Innernet/Netmaker/NetBird 需自建服务器；ZeroTier 托管强制账号；裸 WireGuard 无打洞协调。完整对照见两轮 research。

## Consequences

- P0 演示与验收全部限定局域网；答辩口径按 PRD §9 反方五：「故意的 P0 边界，不是能力缺失，跨网接口已留」。
- 换跨网栈 = 换 `PANTRY_PEERS` 背后的网络层实现，应用层协议不动——这是把接口留在 P0 的全部意义。
- 引入 EasyTier 后，公共中继仍是他人基础设施，需在文档中明示降级路径（打洞失败走公共节点）。

## 源

- Issue: https://github.com/toRolex/hive/issues/7
- 证据：`docs/research/p2p-mesh-vpn.md`、`docs/research/p2p-mesh-vpn-round2.md`
- 产品层 why：`docs/PRD.md` §3、§6（载体与网络决策）、§9 反方五
