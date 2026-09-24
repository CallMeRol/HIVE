# Windows agent · 手机热点两机互见操作说明书

> 对应 Mac 版：`mac-agent.md`。步骤号完全对齐。
> 本机角色：teahouse 客户端 2。UDP 27878 / TCP 27879。数据目录 `C:\pantry-hotspot-2`。
> 绝不要设 `PANTRY_SMOKE=1`（它会强制 bind 127.0.0.1 + 关广播）。

---

## 第 1 步：环境自检

```powershell
node -v
Test-Path C:\teahouse\src\main\net\discovery.ts
Test-Path C:\teahouse\node_modules\.bin\electron-vite.cmd
```

期望：node ≥ 18；两个 `Test-Path` 都返回 `True`。

**失败分支**：
- 没有 `C:\teahouse` → 用户会从 Mac 发一份 teahouse 源码 zip（微信文件传输）。收到后解压到 `C:\teahouse`（右键 zip → 全部解压缩）。如果用户没发，写 handoff 请 Mac 侧打包发过来。
- 没有 `node_modules` → `cd C:\teahouse; npm install`。如果卡 better-sqlite3 编译超过 5 分钟，写 handoff（附完整错误原文）。
- 没有 node → 用户会从 Mac 发 `node-v22.23.2-win-x64.zip`，解压到 `C:\acp\node`。验证：`C:\acp\node\node.exe -v`。

**handoff 附带诊断**：`node -v; npm -v; Get-ChildItem C:\teahouse | Select-Object -First 10 Name`

---

## 第 2 步：收集本机信息

```powershell
ipconfig | Select-String -Pattern "IPv4|适配器|Adapter"
Get-NetFirewallProfile | Select-Object Name, Enabled
```

记录输出（写到本地文件，后面每步都要追加）：
- 所有非 127.0.0.1 的 IPv4 地址（可能有多个网卡，逐个记）
- 三个防火墙 profile（Domain / Private / Public）的 Enabled 状态

**失败分支**：没有非回环地址 → 你还没联网，先连任何 Wi-Fi 再来。

---

## 第 3 步：加防火墙放行规则（关键，不做后面必踩）

PowerShell **以管理员身份**运行（右键开始菜单 → Windows PowerShell (管理员)）：

```powershell
New-NetFirewallRule -DisplayName "Teahouse UDP 17878 In" -Direction Inbound -Protocol UDP -LocalPort 17878 -Action Allow -Profile Private,Public
New-NetFirewallRule -DisplayName "Teahouse UDP 27878 In" -Direction Inbound -Protocol UDP -LocalPort 27878 -Action Allow -Profile Private,Public
New-NetFirewallRule -DisplayName "Teahouse TCP 27879 In" -Direction Inbound -Protocol TCP -LocalPort 27879 -Action Allow -Profile Private,Public
New-NetFirewallRule -DisplayName "Teahouse TCP 17879 In" -Direction Inbound -Protocol TCP -LocalPort 17879 -Action Allow -Profile Private,Public
# ICMP echo（ping 回显，第 5 步要用）
New-NetFirewallRule -DisplayName "ICMP Echo In" -Direction Inbound -Protocol ICMPv4 -IcmpType 8 -Action Allow -Profile Private
```

验证：

```powershell
Get-NetFirewallRule -DisplayName "Teahouse*" | Select-Object DisplayName, Enabled, Direction, Action
```

期望：6 条规则全部 `Enabled = True`。

**失败分支**：没有管理员权限 → 写 handoff 说明，用户手动去"Windows Defender 防火墙 → 高级设置 → 入站规则"加同样的规则（协议 UDP / 本地端口 17878 和 27878 / 允许连接）。

**handoff 附带诊断**：`Get-NetFirewallProfile | Select-Object Name, Enabled`

---

## 第 4 步：连手机热点，拿热点 IP

用户开手机热点，Windows 连上（设置 → 网络和 Internet → Wi-Fi → 选手机热点 SSID）。然后：

```powershell
ipconfig
# 找 "无线局域网适配器 WLAN:" 下面的 "IPv4 地址"
```

期望：拿到一个 192.168.x.x 或 172.20.x.x。记录为 `WIN_IP`。

**handoff 附带诊断**：`netsh wlan show interfaces`（确认 SSID 和用户手机上显示的一致）

---

## 第 5 步：L3 连通（ping Mac）

等 Mac 侧报完它的 IP（用户会转达，或你主动问用户）。

```powershell
ping <MAC_IP> -n 4
```

期望：4 个 Reply，丢包 0%。

**失败分支**：
- `Request timed out` × 4 → AP 隔离或 Mac 防火墙拦 ICMP。诊断：`ping <网关 IP> -n 4`（网关通不通）。把两边 IP 和 ping 输出写 handoff。
- `Destination host unreachable` → 不在同一网段，确认连的是同一个热点。

---

## 第 6 步：起 teahouse 客户端 2（关键：不设 PANTRY_PEERS）

PowerShell **普通窗口**（不要管理员）：

```powershell
cd C:\teahouse
$env:PANTRY_USER_DATA = "C:\pantry-hotspot-2"
$env:PANTRY_UDP_PORT = "27878"
$env:PANTRY_TCP_PORT = "27879"
# 关键：不要设 $env:PANTRY_PEERS
npm run dev
```

期望：Electron 窗口起来，控制台无 `EADDRINUSE` / 无 bind 错误。

**失败分支**：
- `EADDRINUSE` → 27878 被占了。诊断：`Get-NetUDPEndpoint -LocalPort 27878 | Select-Object OwningProcess`。把 PID 写 handoff（先不要自己 kill）。
- 窗口起来但白屏 → 等 10s 再判断，electron-vite dev 首次编译慢。
- `npm run dev` 报缺依赖 → 回第 1 步重新 `npm install`。

**handoff 附带诊断**：`Get-NetUDPEndpoint -LocalPort 27878; Get-Process | Where-Object {$_.ProcessName -like "*electron*"} | Select-Object Id, ProcessName`

---

## 第 7 步：观察联系人列表 90 秒

不要关窗口。看 teahouse 主界面的"在线"或"联系人"列表。同时另开一个 PowerShell：

```powershell
Get-NetUDPEndpoint -LocalPort 27878
# 每 30s 跑一次，共 3 次，记录
```

期望：90s 内，列表里出现 Mac 的 nodeId（一个随机字符串，不是 IP）。

记录：`<时间> <看到/没看到> <nodeId 前 8 位>`。

---

## 第 8 步：判定

按 `README.md` 的判定表，结合 Mac 侧（用户转达）的结论，给出四方格判定：
- 广播通 → 直接跳第 10 步
- 单向 → 先查防火墙（第 3 步的规则有没有真的生效）
- 不通 → 第 9 步

把你的判定写一行：`✅ 8 - <判定结果>`

---

## 第 9 步（仅当第 8 步 = 不通）：降级静态对端

**先诊断是不是 AP 隔离**：

```powershell
# Windows 能收到 Mac 的广播吗？
# 需要 netcat 或 PacketMon；没有就用 PowerShell 原始 socket（见诊断脚本）
# 简化版：直接看 teahouse 窗口里有没有任何入站连接的日志
```

确认 AP 隔离后，**只改 Windows 侧**（Mac 侧由 Mac agent 自己改）：

```powershell
# 先 Ctrl+C 杀掉第 6 步的 teahouse
$env:PANTRY_PEERS = "<MAC_IP>:17878"    # Mac 的 IP : Mac 的 UDP 端口
npm run dev
```

期望：重启后 30s 内看到对方。

**handoff 附带诊断**：`Get-NetUDPEndpoint -LocalPort 27878 | Select-Object LocalAddress, LocalPort, OwningProcess`

---

## 第 10 步：等被拉进群，确认

Mac 侧（用户转达）会建一个叫 `hotspot-test` 的讨论组并拉你。在 teahouse 窗口里：

1. 看有没有新组出现。
2. 点进去，确认成员列表有 2 个（Mac + Windows）。

期望：组出现，成员 2 人。

**失败分支**：等 60s 组没出现 → 说明互见是假象，回第 8 步重新判定。

---

## 第 11 步：互发消息 + @

在组里：
1. Windows 发一条消息，@对方（输入 @ 会弹补全，选 Mac 那个 nodeId）。
2. 等 Mac 侧（用户转达）确认收到。

期望：消息出现在消息流，@ 有高亮（或至少消息到达）。

**失败分支**：消息发出去但对方没收到 → 查 TCP：`Get-NetTCPConnection -LocalPort 27879 | Select-Object State, RemoteAddress`，写 handoff。

---

## 第 12 步：汇总回报

把第 1-11 步的所有记录整理成回报（格式见下），写到本地文件，用户会拿去对 Mac 侧的结果。

```markdown
## Windows 侧回报（手机热点两机互见）
- 广播发现：<通 / 不通（AP 隔离）/ 单向>
- 互见耗时：<秒>
- 防火墙弹窗：<有 / 无>
- 建群/互发/@：<通过 / 失败，原因>
- 关键数字：UDP 27878，互见 <秒>，ping <ms>
- 证据：第 7 步观察记录 + 第 9 步诊断输出（如有）
```
