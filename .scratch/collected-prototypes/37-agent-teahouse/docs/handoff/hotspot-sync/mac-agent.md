# Mac agent · 手机热点两机互见操作说明书

> 对应 Windows 版：`windows-agent.md`。步骤号完全对齐。
> 本机角色：teahouse 客户端 1。UDP 17878 / TCP 17879。数据目录 `/tmp/pantry-hotspot-1`。
> 绝不要设 `PANTRY_SMOKE=1`（它会强制 bind 127.0.0.1 + 关广播）。

---

## 第 1 步：环境自检

```bash
node -v
ls /tmp/teahouse/src/main/net/discovery.ts
ls /tmp/teahouse/node_modules/.bin/electron-vite
```

期望：node ≥ 18；两个 `ls` 都有输出。

**失败分支**：
- 没有 `/tmp/teahouse` → 跑 `cd /tmp && git clone https://github.com/skyjt/teahouse`，然后 `cd /tmp/teahouse && npm install`（Mac 上 known-good，你不会卡）。
- 没有 `node_modules` → 同上 `npm install`。

**handoff 附带诊断**：`node -v; npm -v; ls /tmp/teahouse | head`

---

## 第 2 步：收集本机信息

```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
ipconfig getifaddr en0
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
```

记录输出（写到本地文件，后面每步都要追加）：
- 所有非 127.0.0.1 的 IPv4 地址
- 防火墙状态：enabled / disabled

**失败分支**：没有非回环地址 → 你还没联网，先连任何 Wi-Fi 再来。

---

## 第 3 步：加防火墙放行规则

macOS 的 Application Firewall 对开发者签名的 app 默认放行，但确认一下：

```bash
/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate
# 若显示 disabled → 无需任何操作，记一行 ✅ 3 防火墙未启用
# 若显示 enabled → 继续：
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /tmp/teahouse/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
# 或干脆临时关掉（测试完再开）：
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off
```

期望：防火墙不拦 Electron 的 UDP 入站。

**失败分支**：`sudo` 要密码但你没有 → 记录，跳到第 4 步（防火墙大概率不拦）。

---

## 第 4 步：连手机热点，拿热点 IP

用户开手机热点，Mac 连上。然后：

```bash
ipconfig getifaddr en0
```

期望：拿到一个 192.168.x.x 或 172.20.x.x（iPhone 热点常见网段）。记录为 `MAC_IP`。

**handoff 附带诊断**：`networksetup -getairportnetwork en0`（确认 SSID 和用户手机上显示的一致）

---

## 第 5 步：L3 连通（ping Windows）

等 Windows 侧报完它的 IP（用户会转达，或你主动问用户）。

```bash
ping -c 4 <WIN_IP>
```

期望：4 个 reply，丢包 0%。

**失败分支**：
- `Request timeout` × 4 → AP 隔离或 Windows 防火墙拦 ICMP。诊断：`ping -c 4 192.168.1.1`（网关通不通）。把两边 IP 和 ping 输出写 handoff。
- `No route to host` → 不在同一网段，确认连的是同一个热点。

---

## 第 6 步：起 teahouse 客户端 1（关键：不设 PANTRY_PEERS）

```bash
cd /tmp/teahouse
PANTRY_USER_DATA=/tmp/pantry-hotspot-1 \
PANTRY_UDP_PORT=17878 \
PANTRY_TCP_PORT=17879 \
npm run dev
```

期望：Electron 窗口起来，控制台无 `EADDRINUSE` / 无 bind 错误。

**失败分支**：
- `EADDRINUSE` → 17878 被占了。诊断：`lsof -i :17878`。把 PID 写 handoff（先不要自己 kill）。
- 窗口起来但白屏 → 等 10s 再判断，electron-vite dev 首次编译慢。
- `npm run dev` 报缺依赖 → 回第 1 步重新 `npm install`。

**handoff 附带诊断**：`lsof -i :17878; lsof -i :17879; ps aux | grep -i electron | grep -v grep`

---

## 第 7 步：观察联系人列表 90 秒

不要关窗口。看 teahouse 主界面的"在线"或"联系人"列表。同时另开一个终端：

```bash
lsof -i :17878
# 每 30s 跑一次，共 3 次，记录 UDP 连接状态
```

期望：90s 内，列表里出现 Windows 的 nodeId（一个随机字符串，不是 IP）。

记录：`<时间> <看到/没看到> <nodeId 前 8 位>`。

---

## 第 8 步：判定

按 `README.md` 的判定表，结合 Windows 侧（用户转达）的结论，给出四方格判定：
- 广播通 → 直接跳第 10 步
- 单向 → 先查防火墙
- 不通 → 第 9 步

把你的判定写一行：`✅ 8 - <判定结果>`

---

## 第 9 步（仅当第 8 步 = 不通）：降级静态对端

**先诊断是不是 AP 隔离**：

```bash
# Mac 能收到 Windows 的广播吗？
sudo tcpdump -i en0 udp port 17878 -c 5 -q
# 如果 90s 内一个包都没有 → AP 隔离实锤
```

确认 AP 隔离后，**只改 Mac 侧**（Windows 侧由 Windows agent 自己改）：

```bash
# 先 Ctrl+C 杀掉第 6 步的 teahouse
PANTRY_USER_DATA=/tmp/pantry-hotspot-1 \
PANTRY_UDP_PORT=17878 \
PANTRY_TCP_PORT=17879 \
PANTRY_PEERS=<WIN_IP>:27878 \
npm run dev
```

期望：重启后 30s 内看到对方。

**handoff 附带诊断**：`sudo tcpdump -i en0 udp port 17878 -c 5 -q` 的完整输出。

---

## 第 10 步：建讨论组，拉对方

在 teahouse 窗口里：
1. 发起"讨论组"（或"群聊"），命名 `hotspot-test`。
2. 把对方（Windows 的 nodeId）拉进组。

期望：组创建成功，成员列表有 2 个。

**失败分支**：拉人时对方不在线 → 说明第 7/9 步的互见是假象，回第 8 步重新判定。

---

## 第 11 步：互发消息 + @

在组里：
1. Mac 发一条消息，@对方（输入 @ 会弹补全，选 Windows 那个 nodeId）。
2. 等 Windows 侧（用户转达）确认收到。

期望：消息出现在消息流，@ 有高亮（或至少消息到达）。

**失败分支**：消息发出去但对方没收到 → 查 TCP：`lsof -i :17879`，写 handoff。

---

## 第 12 步：汇总回报

把第 1-11 步的所有记录整理成回报（格式见下），写到本地文件，用户会拿去对 Windows 侧的结果。

```markdown
## Mac 侧回报（手机热点两机互见）
- 广播发现：<通 / 不通（AP 隔离）/ 单向>
- 互见耗时：<秒>
- 防火墙弹窗：<有 / 无>
- 建群/互发/@：<通过 / 失败，原因>
- 关键数字：UDP 17878，互见 <秒>，ping <ms>
- 证据：第 7 步观察记录 + 第 9 步 tcpdump 输出（如有）
```
