# P2P Mesh VPN 组网调研 · 第二轮（2026-09-21）

> 三条硬约束：① 无自建服务器 ② 无统一账号 ③ "贴邀请码即入"。
> 证据标注：✅确认 / ⚠️存疑 / ❓未找到证据。活跃性经 GitHub API 核实（2026-09）。

## 第一轮结论复核
- EasyTier：维持——开箱即用虚拟局域网中唯一满足三条约束者；中继为社区公共节点（他人基础设施）。
- 推翻：第一轮"裸 libp2p 打洞要公网 relay"——准确说法是 libp2p 提供公共 bootstrap 节点 + circuit-relay-v2（Kubo 节点普遍充当受限 relay），因此基于 libp2p 的成品（EdgeVPN、anywherelan）实际上**无需用户自建任何服务器**（✅，见 aws/edgevpn README、libp2p DCUtR 文档）。
- Nebula / Innernet / Netmaker / NetBird / ZeroTier 托管 / Tailscale / 蒲公英 / Yggdrasil 原判不变。

## A. 候选全集（本轮新增 + 复核，共 18 个）

| # | 项目 | 服务器 | 账号 | 邀请码即入 | 公共中继 | 打洞 | Win+Mac | 最近更新 | 许可 |
|---|------|--------|------|-----------|---------|------|---------|---------|------|
| 1 | **EasyTier** | 否 | 否 | ✅ network_name+secret | ✅ 社区公共节点 | 强 | ✅ | 活跃 | Apache-2.0 |
| 2 | **EdgeVPN** (mudler) | 否（libp2p bootstrap 公共） | 否 | ✅ token | ✅ libp2p 公共 relay | DCUtR | ⚠️ Win 支持有限，主线 Linux/Mac | 2026-09 | Apache-2.0 |
| 3 | **anywherelan (awl)** | 否（libp2p DHT bootstrap 公共） | 否 | ⚠️ 互换 peer_id + 接受邀请（双向） | ✅ libp2p circuit relay | DCUtR | ✅ (wintun/TUN) | 2026-09 | MPL-2.0 |
| 4 | **Hyprspace** | 否（IPFS bootstrap） | 否 | ⚠️ 配置 peer 列表 | ⚠️ 依赖 libp2p relay | DCUtR | ⚠️ Win 需手动装 wintun/管理员配置 | 2026-08 | Apache-2.0 |
| 5 | **iroh** (n0-computer) | 否（n0 公共 relay/pkarr） | 否 | ✅ 公钥即地址 | ✅ n0 官方公共 relay | 强（QUIC） | ✅ 库级 | 2026-09 | Apache-2.0 |
| 6 | **HyperDHT** (holepunch.to) | 否（公共 DHT 引导） | 否 | ✅ 公钥拨号 | ⚠️ DHT 协助打洞，通用 relay 弱 | 内建 | 库级（JS） | 2026-09 | MIT |
| 7 | **Syncthing** 机制 | 否（公共 discovery+relay） | 否 | ✅ device ID | ✅ 社区 relay（限速） | 有 | ✅ | 活跃 | MPL-2.0 |
| 8 | **Yggdrasil** | 否 | 否 | ❌ 手工互换 peer | 公共 peer 即中继 | 无打洞 | ✅ | 活跃 | LGPL-3.0 |
| 9 | **Nebula** | ✅ lighthouse（公网 IP） | 否 | ❌ | ❌ | 有 | ✅ | 活跃 | MIT |
| 10 | **n2n** | ✅ supernode 需公网可达 | 否 | ❌ | ❌ | 有 | ✅ | 活跃 | GPL-3.0 |
| 11 | **tinc** | 部分（首连需互换 host 文件） | 否 | ❌ | ❌ | 弱 | ✅ | 低活跃 | GPL |
| 12 | **SoftEther** | ✅ VPN Server | 否 | ❌ | ❌ | 无 | ✅ | 活跃 | Apache-2.0 |
| 13 | **OpenZiti** | ✅ Controller+Router | 是 | ❌ | ❌ | 有 | ✅ | 活跃 | Apache-2.0 |
| 14 | **Firezone** | ✅ 服务端/云账号 | 是 | ❌ | ❌ | 有 | ✅ | 活跃 | Apache-2.0 |
| 15 | **Pangolin** | ✅ 公网 VPS（官方文档明示） | 是 | ❌ | ❌ | 有 | ✅ | 活跃 | AGPL |
| 16 | **Netrinos** | ⚠️ 商业闭源，宣称 P2P 无中继 | 是 | ❌ | ⚠️ | 有 | ✅ | ❓ | 闭源 |
| 17 | **WGMesh** (wgmesh.dev) | ⚠️ "nothing phoning home"，发现机制❓ | 否 | ❓ | ❓ | ❓ | ❓（仅 Linux 二进制） | ❓ | ❓ |
| 18 | **pwnat** | 否（无第三方打洞技巧） | 否 | ❌ 非组网产品 | ❌ | 特定场景 | 仅 Linux | 陈旧 | MIT |

来源：github.com/{EasyTier/EasyTier, mudler/edgevpn, anywherelan/awl, hyprspace/hyprspace, n0-computer/iroh, holepunchto/hyperdht, ntop/n2n, dswd/vpncloud}、docs.iroh.computer、docs.pangolin.net/self-host/quick-install、openziti 架构文档、tailscale.com/blog/nat-traversal-improvements-pt-1、probelab dcutr 报告。活跃性经 GitHub API 核实。

## B. 三约束下排序

1. **EasyTier** —— 唯一"开箱虚拟局域网 + token 即入 + 公共中继兜底"的成品。
2. **EdgeVPN** —— 同样 token 即入、无账号无自建服务器（libp2p 公共 bootstrap/relay），但定位偏 Linux/集群场景，Windows 桌面体验弱，且 issue #1074 显示双 NAT 直连失败案例仍需 relay 兜底。
3. **anywherelan** —— 桌面/移动端体验最完整（Win/Mac/Linux/Android），但加入需**双向互换 peer_id 并各自接受**，不是单向"贴邀请码"，且面向个人小规模。

**第 1 名相对第 2 名的实质优势**：EasyTier 是完整的 L3 虚拟局域网产品（自动分配 IP、子网路由、共享中转、GUI 全平台），EdgeVPN 本质是 libp2p 账本+TUN 的半成品工具链（文档以 CLI/集群为主）；且 EasyTier 的社区公共 relay 是为 VPN 流量设计的，EdgeVPN 依赖的 libp2p circuit-relay-v2 是受限通用 relay。

## C. 打洞成功率现实
- **唯一公开的厂商数字**：Tailscale 称典型环境下直连成功率"远高于 90%"（对称 NAT/企业防火墙/CGNAT 是主要失败源，回落 DERP）。来源：tailscale.com/blog/nat-traversal-improvements-pt-1 ✅。
- **学术测量（libp2p DCUtR，适用于 EdgeVPN/anywherelan/Hyprspace）**：ProbeLab/IMC'26 报告跨全部 NAT 类型的条件打洞成功率 **70% ± 7.1%** ✅（github.com/probe-lab/dcutr-project）。
- 决定因素：NAT 类型（全锥形≈必成；对称 NAT 基本失败）、UDP 是否被运营商/防火墙阻断、端口映射稳定性、CGNAT 叠加层数。
- EasyTier 未公布打洞成功率数字（❓）；对称 NAT 场景其文档亦承认需走公共中转。

## D. "看起来行但实际不行"
- **OpenZiti/zrok**：打着"P2P、zero trust"旗号，实际必须有 Controller + Edge Router（自建或 NetFoundry 云）。
- **Pangolin**：宣传"自托管 Cloudflare Tunnel 替代"，官方文档明示需要公网 VPS。
- **Netrinos**：宣称"无中央服务器路由流量"，但闭源商业产品，协调/账号依赖其云服务（⚠️无开源证据）。
- **vpncloud**：自称 P2P mesh + NAT traversal，但需至少一个可达 beacon 节点，且 2024-03 后停止维护。
- **tinc / Yggdrasil**：零服务器零账号，但加入要手工互换地址/配置，非邀请码即入。
- **Syncthing 复用**：机制成熟但深度耦合 BEP 协议，公共 relay 限速且为同步流量设计，不能当通用组网层。
- **WGMesh**：官网信息过少，仅 Linux 二进制，"decentralized"发现机制无文档佐证（⚠️）。

## 问题 7 专门回答：满足"token 即入 + 无账号 + 无自建服务器 + 打洞失败有免费公共中继"
- **开箱 VPN 成品：只有 EasyTier 一个**（✅ 高置信）。
- 放宽到"需在代码里封装 IP 层"：另有 **iroh**（n0 公共 relay + pkarr/DNS 发现，公钥即地址）和 **HyperDHT** 两个库级候选。
- EdgeVPN 也算满足四条，但 Windows 支持与成熟度的差距使其排第 2。

## 存疑/未找到证据
- ⚠️ EdgeVPN / Hyprspace 的 Windows 支持完整度（README 提到 wintun/TAP 需手动配置）。
- ⚠️ anywherelan 的 libp2p bootstrap 节点是否完全社区公共（awl-bootstrap-node 仓库存在，推断可用公共默认）。
- ❓ iroh 公共 relay 的流量配额/速率限制政策（免费层条款未核实到一手文档数字）。
- ❓ EasyTier、EdgeVPN 官方打洞成功率统计（均无公布）。
