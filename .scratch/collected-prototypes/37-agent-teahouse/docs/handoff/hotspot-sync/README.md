# 手机热点两机互见 · 同步操作说明书

> 本目录下两份文档步骤完全对齐：同一步骤号 = 同一时间做同一件事。
> Mac agent 读 `mac-agent.md`，Windows agent 读 `windows-agent.md`。
> 用户驱动节奏：说「执行第 N 步」→ 两边 agent 各做第 N 步 → 报成功/失败 → 说「执行第 N+1 步」。

## 拓扑

```
        手机热点（同一 SSID）
       ┌──────────┬──────────┐
   Mac 客户端 1          Windows 客户端 2
   UDP 17878 / TCP 17879   UDP 27878 / TCP 27879
   无 PANTRY_PEERS         无 PANTRY_PEERS（广播发现）
```

## 核心事实（源码确认，/tmp/teahouse @ f6607ff）

- 身份 = nodeId，不是 IP。
- `PANTRY_USER_DATA`：数据目录隔离（同时绕开单实例锁）。
- `PANTRY_UDP_PORT` / `PANTRY_TCP_PORT`：UDP 发现 / TCP 消息，默认值 17878 / 17879。
- `PANTRY_PEERS`：静态对端，格式 `IP:UDP端口`，逗号分隔。**本测试第一阶段不设它**。
- 广播目标 = 自动枚举所有非回环网卡的子网定向广播 + 255.255.255.255（`src/main/net/udp.ts: computeBroadcastTargets`）。
- **`PANTRY_SMOKE=1` 会强制 bind 127.0.0.1 + 空广播目标**——本测试绝不能用。
- 正常启动 = `npm run dev`（不 build 也能跑）。

## 变量表（双方都用这套，不要改）

| 变量 | Mac | Windows |
|---|---|---|
| PANTRY_USER_DATA | /tmp/pantry-hotspot-1 | C:\pantry-hotspot-2 |
| PANTRY_UDP_PORT | 17878 | 27878 |
| PANTRY_TCP_PORT | 17879 | 27879 |
| PANTRY_PEERS | （不设） | （不设） |

## 记录规范

每一步成功：记一行 `✅ N - <一句话>`。
每一步失败：**不前进**，按该文档的失败分支生成 handoff（见文末模板），用户微信发对侧，对侧 agent 读完决定修复还是改计划。

## handoff 模板（复制填）

```markdown
## HANDOFF
- 步骤号: <N>
- 机器: <Mac / Windows>
- 用户原话: "<执行第 N 步>"
- 执行命令: <原文>
- 期望: <文档里写的期望输出>
- 实际: <完整错误输出，不要摘要，不要截断>
- 诊断: <该文档要求该步附带的诊断命令输出>
```

---

## 步骤索引

| 步骤 | Mac 做什么 | Windows 做什么 |
|---|---|---|
| 1 | 环境自检（node / teahouse 源码 / out/） | 环境自检（node / teahouse 源码 / out/） |
| 2 | 收集本机信息（IP / 网卡 / 防火墙） | 收集本机信息（IP / 网卡 / 防火墙） |
| 3 | 加防火墙放行规则（入站 UDP 17878/27878） | 加防火墙放行规则（入站 UDP 17878/27878） |
| 4 | 连手机热点，拿热点 IP | 连同一个手机热点，拿热点 IP |
| 5 | L3 连通：ping Windows IP | L3 连通：ping Mac IP |
| 6 | 起 teahouse 客户端 1（无 PEERS） | 起 teahouse 客户端 2（无 PEERS） |
| 7 | 观察联系人列表 90s，记录 | 观察联系人列表 90s，记录 |
| 8 | 判定：广播通 / 不通 / 单向 | 判定：广播通 / 不通 / 单向 |
| 9 | （仅当 8=不通）设 PANTRY_PEERS 重起 | （仅当 8=不通）设 PANTRY_PEERS 重起 |
| 10 | 建讨论组，拉对方 | （等待被拉入，确认进群） |
| 11 | 发消息，@对方 | 发消息，@对方 |
| 12 | 汇总回报，写验收表 | 汇总回报，写验收表 |

---

## 判定表（第 8 步用）

| Mac 看到 Win | Win 看到 Mac | 判定 | 下一步 |
|---|---|---|---|
| ✅ | ✅ | 广播通 | 直接第 10 步 |
| ❌ | ✅ | Windows 防火墙单向拦 UDP | Mac 先查防火墙，Win 查入站规则 |
| ✅ | ❌ | macOS 防火墙拦（罕见） | 两边都查，Mac 看 /usr/libexec/ApplicationFirewall/socketfilterfw |
| ❌ | ❌ | AP 隔离 或 双方防火墙 | 第 9 步降级：至少一边设 PANTRY_PEERS |
