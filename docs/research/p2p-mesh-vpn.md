# P2P Mesh VPN 窄范围调研

> 场景：3-10 个互不认识的人组成虚拟局域网；硬约束 = 零服务器 / 不要求统一账号 / 最好邀请码即入 / Win+Mac / 需 NAT 穿透。
> 标注：✅确认 / ⚠️存疑 / ❓未找到证据。每条结论附一手来源链接。

---

## 1. EasyTier

- **要服务器？** 否（有社区公共共享节点 `tcp://public.easytier.cn:11010` / `public.easytier.top:11010`，无需自建）。P2P 打洞失败时数据经公共节点中继。✅
- **要统一账号？** 否。无账号体系，`network_name` + `network_secret` 即网络唯一标识。✅
- **邀请码式加入？** 是——分享 `network_name`+`network_secret`（可再加公共节点 URL）即接入；`--credential` 支持访客临时节点；`secure_mode` 支持公钥固定。✅
- **Win+Mac？** 是（Windows / macOS / Linux / Android / iOS 均支持）。✅
- **成熟度？** 活跃开源（Rust），2.x 已发布，国内社区活跃。✅
- **一句结论：** 唯一真正同时满足"零服务器 + 无账号 + 邀请码加入"的成熟开源方案；公共节点只是兜底中继，非自建控制面。
- 来源：https://www.easytier.cn/en/guide/network/quick-networking.html ｜ https://deepwiki.com/EasyTier/EasyTier/6.1-network-identity-and-authentication

## 2. Yggdrasil

- **要服务器？** 否（纯 P2P），但**必须手动配置至少一个 peer 才能接入网络**——无公共"一键加入"邀请码机制。✅
- **要统一账号？** 否（公钥即身份）。✅
- **邀请码式加入？** 否。需要互换 peer 地址（IP:port）并手工写入配置；陌生人之间无现成"贴码即入"流程。✅
- **Win+Mac？** 是。✅
- **成熟度？** 开源稳定，但 bootstrap 依赖手工/公共 peer 列表，实用门槛高。⚠️
- **一句结论：** 技术上零服务器零账号，但加入流程是"手动互换 peer 地址"，不是邀请码即入，对互不认识的人不实用。
- 来源：https://yggdrasil-network.github.io/faq.html ｜ https://github.com/yggdrasil-network/yggdrasil-go/issues/388

## 3. Nebula (slackhq/nebula)

- **要服务器？** 是——**必须至少跑一个 lighthouse**（发现节点、协助 NAT 穿透），且 lighthouse 需要**固定公网 IP**。官方文档："at least one host should be a Lighthouse"。✅
- **要统一账号？** 否（自签 CA 证书即身份），但需自己签/发证书。✅
- **邀请码式加入？** 否——必须先用自签 CA 给每个成员签发证书并分发配置文件。✅
- **Win+Mac？** 是。✅
- **成熟度？** 生产级（Slack 内部使用）。✅
- **一句结论：** "零服务器"约束**不成立**——没有公网 IP 的 lighthouse 就无法组网。
- 来源：https://nebula.defined.net/docs/ ｜ https://github.com/slackhq/nebula/discussions/809

---
## 4. ZeroTier

- **要服务器？** 官方托管控制器 my.zerotier.com 免费档可用（≤25 设备）；也可自建 controller（免费不限节点）。✅
- **要统一账号？** **是（托管模式）**——必须由同一个人在 my.zerotier.com 控制台授权每个新成员；不同账号无法共享同一网络授权。✅
- **邀请码式加入？** 半是——成员贴 16 位 Network ID 即可申请，但**必须等控制台手动授权**才能通。✅
- **自建 controller 能否跑在成员机器上？** 可以（controller 也是普通节点，按 Node ID 被发现），但承担授权职责的这台机器必须**一直在线**，否则新成员无法入网。✅
- **Win+Mac？** 是。✅
- **一句结论：** "不要统一账号"约束**不成立**（托管模式强制同一控制台授权）；"零服务器"约束在自建 controller 下勉强可行，但需一台常在线成员机器且操作摩擦大。
- 来源：https://docs.zerotier.com/controller/ ｜ https://www.zerotier.com/pricing/

## 5. Tailscale

- **要服务器？** 控制面用官方托管（免费）；数据面 P2P，打洞失败走官方 DERP 中继（不可自建才免费）。✅
- **要统一账号？** **是**——同一 tailnet 内所有成员必须用各自账号登录，且被 tailnet 管理员邀请。不同账号的人**默认不互通**。✅
- **共享设备（sharing）需双方账号？** 是——分享方把单台设备 share 给另一个 Tailscale 用户，**对方仍需有 Tailscale 账号**并接受邀请。✅
- **邀请码式加入？** 否——需账号 + 邀请流程。✅
- **最轻做法：** 一方开账号建 tailnet → 逐台设备 share 给其他人；但每人都得注册账号。✅
- **一句结论：** "不要统一账号"约束**不成立**——跨账号互通只能靠 device sharing 且双方仍需账号，不适合"互不认识的人贴码即入"。
- 来源：https://tailscale.com/docs/features/sharing ｜ https://tailscale.com/docs/reference/inviting-vs-sharing

## 6. Innernet / Netmaker / NetBird

- **Innernet：** 需要自建 **innernet-server**（协调+中继），"零服务器"不成立。✅
- **Netmaker：** 需要自建 Netmaker 服务器（控制面+CoreDNS+MQ），"零服务器"不成立。✅
- **NetBird：** 需要**协调服务器**（官方 SaaS 或自建于云主机）；文档明确"coordination server installs on a cloud instance"，"零服务器"不成立。✅
- 三者均无账号统一要求但都必须先有一台服务器，邀请码流程依赖该服务器。
- 一句结论：三者本质都是"自带控制面的 WireGuard 编排器"，与硬约束冲突。
- 来源：https://docs.netbird.io/selfhosted/selfhosted-quickstart ｜ https://forum.cloudron.io/topic/11158/netbird-installation-and-my-experience

---
## 7. 其他（libp2p / 国内闭源）

- **libp2p：** 提供打洞原语（DCUtR + Circuit Relay v2），但**官方教程明确需要一个公网 relay 节点**才能让两个 NAT 后的节点协调打洞；本身不是开箱即用的"邀请码即入"VPN 产品。❌零服务器不成立。
- 来源：https://libp2p.github.io/rust-libp2p/libp2p/tutorials/hole_punching/index.html
- **贝锐蒲公英（闭源）：** 国内成熟方案，无需公网 IP，但**要求所有设备登录同一账号**（App Store 描述原话"登入同一账号"），不满足"互不认识、无统一账号"。闭源。
- 来源：https://apps.apple.com/us/app/id1139108606

## 8. 裸 WireGuard + 配置当邀请码

- **无公网 IP 时行不行？** **不行**——裸 WireGuard 无内建 NAT 打洞协调机制；双方都处 NAT 后且无公网 endpoint 时无法建立首连。需至少一方有公网 IP，或借助第三方打洞/中继。✅
- **缺什么前置条件：** (a) 至少一端有公网 IP/端口映射；或 (b) 额外引入 STUN/协调服务器/中继（此时已非"零服务器"）；(c) 手工交换公钥+endpoint+AllowedIPs（=邀请码的原始形态，但无打洞则无意义）。✅
- 一句结论：邀请码形态可行，但"零服务器 + 双方皆 NAT 后"前提下不成立。
- 来源：https://nettica.com/nat-traversal-hole-punch/ ｜ https://www.linksysinfo.org/index.php?threads/wireguard-vpn-server-behind-nat-is-it-possible.79151/

---

## 汇总表

| 名称 | 要服务器 | 要统一账号 | 邀请码式加入 | Win+Mac | 成熟度 |
|---|---|---|---|---|---|
| **EasyTier** | ❌（公共节点兜底） | ❌ | ✅ network_name+secret | ✅ | 高（活跃开源） |
| Yggdrasil | ❌ | ❌ | ❌ 需手动互换 peer | ✅ | 中 |
| Nebula | ✅ 必须自建 lighthouse | ❌ | ❌ 需签发证书 | ✅ | 高 |
| ZeroTier | 半（托管免费/可自建） | ✅ 托管模式强制 | 半（需控制台授权） | ✅ | 高 |
| Tailscale | 半（官方控制面免费） | ✅ 强制 | ❌ 需账号+邀请/share | ✅ | 高 |
| Innernet | ✅ 自建 server | ❌ | ❌ | ✅ | 中 |
| Netmaker | ✅ 自建 server | ❌ | ❌ | ✅ | 高 |
| NetBird | ✅ 需协调服务器 | ❌ | 半（setup key） | ✅ | 高 |
| 蒲公英（闭源） | ❌（厂商云） | ✅ 强制同账号 | ❌ | ✅ | 高（闭源） |
| 裸 WireGuard | ✅ 需公网端或中继 | ❌ | 半（交换配置） | ✅ | 高 |

## 最终排序（硬约束：零服务器 + 无统一账号 + 邀请码加入）

**唯一同时满足三条硬约束的成熟方案：只有 EasyTier。** 它用社区公共节点做兜底中继（非自建控制面）、`network_name`+`network_secret` 即邀请码、无账号体系。

**次优（放宽"邀请码即入"）：Yggdrasil** —— 零服务器零账号，但需手动互换 peer 地址，不是贴码即入。

## 在"零服务器"这条上**其实不成立**的方案

- **Nebula**（必须自建固定 IP lighthouse）
- **Innernet / Netmaker / NetBird**（三者都需自建协调/控制服务器）
- **裸 WireGuard**（双方皆 NAT 后且无公网 IP 时无法首连，需中继/打洞协调）
- **libp2p**（打洞需公网 relay 节点协调）
- **ZeroTier 自建 controller / Tailscale 自研控制面**（可行但需一台常在线成员机器，且仍有账号/授权摩擦）

## 在"不要统一账号"这条上**不成立**的方案

- **ZeroTier 托管模式**（必须同一控制台授权）
- **Tailscale**（跨账号只能靠 device sharing，双方仍需账号）
- **蒲公英**（强制同账号，且闭源）
