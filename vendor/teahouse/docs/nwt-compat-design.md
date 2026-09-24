# 内网通兼容模式设计文档

> [简体中文](nwt-compat-design.md) · [English](en/nwt-compat-design.md)

| | |
|---|---|
| 状态 | **暂缓实现（决议 #199）**。设计与第二轮复测结论保留；`SENDMSG` 等链路在当前 VM 不复现；**代码零落地，不排近期**，调研周期长后再由用户启动 |
| 日期 | 2026-07-08（设计）；2026-07-09（#199 暂缓） |
| 关系 | 上游：[requirements.md](requirements.md) 决议 #194 / #195 / #196 / #199；不替代 [protocol.md](protocol.md) 的茶话间自有协议，只定义独立兼容适配器 |

## 1. 背景与目标

部分办公内网已经长期部署内网通，用户希望茶话间可以在迁移期识别这些节点，并能与其进行基础通信。内网通本体可能继续运行在 Windows 终端上，茶话间需要在不破坏现有纯内网、无服务器、基于 IP 的架构前提下，提供一个可开关的兼容入口。

本功能目标是新增“内网通兼容模式”：

1. 用户可以在设置中单独维护内网通兼容 IP 段或单个 IP。
2. 茶话间可以扫描这些地址，发现开启飞鸽 / 飞秋互通能力的内网通节点。
3. 茶话间可以向已发现的内网通节点发送普通文本，并根据 IPMSG 回执显示送达结果。
4. 茶话间可以接收来自内网通 / 飞鸽兼容节点的普通文本，并展示为独立兼容会话。
5. 茶话间 UI 对内网通用户显示明确的兼容标志，并按能力矩阵隐藏 PK、窗口震动、群聊、直接文件等不兼容能力。
6. 对图片、文件、震动等功能先做协议映射与探测结论归档；达到闭环验证后再进入可用范围。

该模式服务迁移与混用，不能把内网通节点伪装成完整茶话间节点。兼容节点没有茶话间的 nodeId、profileRev、caps、群聊、离线补发、自更新、媒体撤回、PK 和私有文件通道能力；附件与图片只在 IPMSG 兼容层单独评估。

## 2. 调研结论

### 2.1 测试环境

在 Parallels Windows VM 中测试内网通 `3.4.3055`：

- 进程为 `ShiYeLine.exe`，路径 `C:\Program Files (x86)\Nwt\ShiYeLine.exe`。
- VM 地址为 `10.211.55.3/24`，宿主机地址为 `10.211.55.2`。
- 实测进程监听：

| 端口 | 传输 | 标准探测结果 | 设计判断 |
|---:|---|---|---|
| 2425 | UDP | 源端口同为 2425 时响应 `ANSENTRY`；随机源端口无响应 | IPMSG / 飞鸽兼容主通道 |
| 2425 | TCP | 可连接 | IPMSG 文件拉取通道候选 |
| 9011 | UDP | 标准 `BR_ENTRY` 无响应 | 内网通私有通道，首版只做观测 |
| 9011 | TCP | 连接超时 | 不纳入兼容实现 |
| 9012 | UDP | 标准 `BR_ENTRY` 无响应 | 私有通道，首版只做观测 |
| 9012 | TCP | 可连接 | 私有通道候选，不默认接入 |
| 9013 | TCP | 可连接 | 私有通道候选，不默认接入 |
| 9014 | TCP | 可连接 | 私有通道候选，不默认接入 |

### 2.2 IPMSG 标准协议摘取

参考 `references/ipmsg/prot-eng.txt`、`references/ipmsg/protocol.txt` 与 `references/ipmsg/src/ipmsg.h`：

- 默认 UDP / TCP 端口均为 `2425`。
- UDP 报文基础格式为 `version:packetNo:user:host:command:message\0`。
- `SENDMSG | SENDCHECKOPT` 需要接收方返回 `RECVMSG`，正文为原始 `packetNo`。
- 文件 / 文件夹 / 剪贴板图片均通过 `FILEATTACHOPT` 表达，附件列表拼在消息正文后的 `\0` 扩展区。
- 附件列表格式为 `fileId:fileName:size:mtime:fileAttr[:extAttr=value[,value...]]:\a...`，其中 size / mtime / attr 为十六进制；文件名里的 `:` 需要转义为 `::`。
- 接收方通过 TCP 连接到发送方 `2425` 端口，并发送 `GETFILEDATA` 或 `GETDIRFILES` 拉取内容。
- 剪贴板图片使用 `IPMSG_FILE_CLIPBOARD` 文件属性，常见扩展属性为 `IPMSG_FILE_CLIPBOARDPOS=pos`，本质仍是附件。
- `GETINFO` / `GETABSENCEINFO` / `BR_ABSENCE` 属信息与离开状态扩展，不影响基础互通。
- IPMSG 没有标准“窗口震动 / nudge”命令；茶话间自己的 `msg.kind="nudge"` 不能直接投给内网通。

参考 `references/iptux/protocol`：

- iptux 有 `IPTUX_SENDMSG`、`IPTUX_SENDICON`、`IPTUX_SENDSIGN`、`IPTUX_ASKSHARED` 等自定义扩展。
- 这些扩展可作为后续对比样本，当前未证明内网通使用同一套扩展，首版不得依赖。

### 2.3 内网通实测事实

调研分两轮进行，第二轮复测发现 `SENDMSG` 链路与第一轮存在重大出入，下方按轮次留痕，**以第二轮结论为准**。

#### 第一轮（2026-07-08 早段，Mac 侧 Python + Parallels PowerShell + Computer Use）

- 从本机绑定源端口 `2425/UDP` 向 `10.211.55.3:2425` 发送 `BR_ENTRY`，内网通返回 `ANSENTRY(3)`。
- 同一次发现有机会收到重复 `ANSENTRY`，compat service 必须按 `ip + port + user + packetNo` 或短时间窗口去重。
- 回包头部形如 `1@shiyeline:<packetNo>:SYSTEM:P9FD:3:P9FD\0内网通联系人\0<corpId>\0`。
- 回包扩展字段包含 GBK 编码的分组名 `内网通联系人` 与类似企业 / 组织标识的 32 位十六进制字符串。
- 即使茶话间探测包声明 `CAPUTF8OPT`、`CLIPBOARDOPT`、`FILEATTACHOPT`，内网通 `ANSENTRY` 仍只返回基础命令 `3`，没有能力位。实现不能依赖内网通的 `ANSENTRY` 选项位判断图片 / 文件能力。
- 向 `2425/UDP` 发送带 `SENDCHECK` 的 `SENDMSG`，内网通返回 `RECVMSG(33)`，载荷为原始包号，可作为文本送达确认。**（此条在第二轮复测中未能复现，见下方）**
- 发送 `GETINFO(0x40)` 与 `GETABSENCEINFO(0x50)` 没有收到应答。
- 发送标准 IPMSG 文件 offer（`SENDMSG | SENDCHECKOPT | FILEATTACHOPT`）后，内网通返回 `RECVMSG`，UI 的“文件传输”页出现 `test.txt(5字节)`，并显示“接收 / 另存为 / 拒绝”。**（此条在第二轮复测中未能复现，见下方）**
- 发送标准 IPMSG 剪贴板图片 offer（`FILEATTACHOPT | CLIPBOARDOPT`，附件 attr 为 `IPMSG_FILE_CLIPBOARD`）后，内网通返回 `RECVMSG`，UI 更像把它展示成文件传输项 `ipmsgclip.png`，未确认其按聊天内联图片渲染。**（此条在第二轮复测中未能复现，见下方）**
- 试图通过 Computer Use 点击“接收 / 全部接收”时，宿主机 TCP 2425 监听未捕获到 `GETFILEDATA`。当前只能确认内网通 ACK 并展示 offer，尚未确认其会从茶话间拉取标准 IPMSG 文件数据。
- 重启内网通后，宿主机未捕获到可用启动广播；可能与 Parallels NAT / 隔离有关，也可能是内网通默认不向宿主网段广播。首版扫描仍采用用户配置 IP / CIDR 后主动单播。
- 静态字符串观察显示 `Remote.dll` 含大量 VNC / RFB / FileTransfer 相关符号，说明远程协助和部分文件能力可能走内网通私有 TCP 通道。该线索只用于风险判断，首版不接入私有远控协议。

#### 第二轮（2026-07-08 复测，同一 VM `10.211.55.3`、同一内网通 `3.4.3055`，进程 `ShiYeLine.exe` 2021-11-09 构建）

复测动机：准备推进文本收发闭环时，发现 `SENDMSG` 链路不再回执。重新验证后得到以下**与第一轮矛盾**的事实，以下结论以本轮为准：

- `BR_ENTRY`（纯命令 `0x1`，不带任何选项位）仍稳定返回 `ANSENTRY(3)`，回包格式与第一轮一致：`1@shiyeline:<packetNo>:SYSTEM:P9FD:3:P9FD\0<GBK 分组>\0<corpId>\0`。本轮连续 8 次探测每次都拿到 `ANSENTRY`，**未观察到重复 `ANSENTRY`**（第一轮记录的重复应答在当前 VM 环境下不复现，去重逻辑仍保留为防御性设计）。
- **`BR_ENTRY` 一旦携带任何选项位（`SENDCHECKOPT`、`CAPUTF8OPT`、`FILEATTACHOPT`、`CLIPBOARDOPT` 等任意组合），内网通不再回 `ANSENTRY`**。只对纯 `0x1` 响应。实现时出站 `BR_ENTRY` 不得声明能力位。
- **`SENDMSG`（`0x20`）无论是否带 `SENDCHECKOPT`、是否带 `UTF8OPT`/`CAPUTF8OPT`、正文用 ASCII/UTF-8/GBK、正文是否为空、是否在 `BR_ENTRY`/`ANSENTRY` 后立即发送、是否先回 `RECVMSG` 或 `ANSENTRY`、是否模拟内网通自身的 `1@shiyeline:SYSTEM:P9FD` 头部格式——内网通一律不返回 `RECVMSG`，也完全不回任何 UDP 应答**。
- 开 TCP `2425` 监听后发标准 IPMSG 文件 offer（`SENDMSG | SENDCHECKOPT | FILEATTACHOPT`，附件 `nwt-test.txt:4B`），**既没有收到 `RECVMSG`，也没有等来 `GETFILEDATA` 连接**。第一轮记录的“内网通 ACK 并在文件传输页展示 offer”在当前环境不复现。
- 通过 `prlctl exec` 调用 VM 内 PowerShell `EnumWindows`：内网通进程（PID 11900）内部**为 `pantry-probe` 节点创建了一个隐藏窗口**（标题 `pantry-probe`，`Visible=False`），证明内网通确实解析了 `BR_ENTRY` 并在进程内登记了节点。但该窗口始终隐藏，**主界面联系人列表仍只有 `P9FD` 自己**，没有把 `pantry-probe` 加入可见联系人。
- 截图内网通主窗口（通过 `prlctl capture` + `ShowWindow(SW_RESTORE)` 激活）后发送中文 `SENDMSG`：主窗口未弹出消息、未出现新联系人、托盘未闪烁、无任何通知。**消息没有到达可见 UI**。
- 内网通 CEF 调试日志（`%LocalAppData%\Temp\ShiYeLine\debug.log`）只有 DNS 读取失败和 SSL 握手失败（内网通嵌入的 CEF 试图连外网被内网环境拒绝），**没有 IPMSG 协议层处理记录**，无法从日志侧确认内网通对 `SENDMSG` 的内部处理路径。
- 内网通可执行文件 `ShiYeLine.exe` 的 `VersionInfo` 字段全空（`ProductVersion`、`FileVersion` 均为空），无法通过文件属性确认精确版本；构建时间戳为 2021-11-09，与第一轮记录的 `3.4.3055` 是否同一版本无法从文件本身证实。

#### 第二轮差异初步判断

第一轮与第二轮矛盾的可能原因（尚未证实，实现前需进一步排查）：

1. **联系人准入策略**：内网通可能只对"同企业/同组织"节点处理 `SENDMSG`，外来 IPMSG 节点即使被 `BR_ENTRY` 登记也不进联系人列表、消息被静默丢弃。第一轮记录的“收到 `RECVMSG` + UI 展示”可能发生在内网通已手动将茶话间节点加入通讯录之后，或当时 VM 处于不同配置状态。
2. **版本/配置漂移**：VM 可能被重置或内网通配置变更（如“拒绝陌生人消息”开关），导致当前行为收紧。
3. **Computer Use 副作用**：第一轮通过 Computer Use 操作过内网通 UI，可能在 UI 侧触发了“接受陌生节点”流程，使后续 `SENDMSG` 被处理；纯脚本路径无法复现。

#### 结论（以第二轮为准）

- **`BR_ENTRY` / `ANSENTRY` 发现链路稳定可用**，兼容适配器可基于此实现节点扫描与可见性。
- **`SENDMSG` 文本收发链路当前不通**：内网通不回 `RECVMSG`，消息也不进入可见 UI。兼容适配器实现 `SENDMSG` 后**不能假设送达**，必须保留超时失败态和重发机制，并在 VM 手测中先打通“内网通将茶话间节点加入联系人”这一前置条件。
- **文件 offer / 剪贴板图片 offer / TCP `GETFILEDATA` 拉取链路当前不通**：第一轮的 ACK 与 UI 展示在当前环境不复现。实验阶段实现前必须先在 VM 中复现第一轮条件，否则不应向 UI 开放任何文件 / 图片入口。
- **首版实现必须先解决"入联系人"问题**：在 VM 中找到让内网通把茶话间节点加入可见联系人的可靠路径（可能是手动添加、特定协议交换、或内网通服务端配置），否则 `SENDMSG` 链路无法闭环。这是实现阶段 A 的阻塞项，需在 VM 手测中先打通。
- **稳定首版的可用能力降级为：仅发现（`BR_ENTRY`/`ANSENTRY`）+ 兼容联系人展示**。文本收发、文件 offer、图片 offer、TCP 拉取全部降级为"已映射但未闭环"，直到 VM 复测打通。
- 窗口震动、PK、群聊、公告、共享文件柜、远程协助和内网通私有 `901x` 通道维持隐藏或后续专项。

## 3. 设计原则

1. **独立适配**：兼容模式使用独立 UDP socket、独立 parser、独立 service，不复用茶话间 JSON codec。
2. **协议隔离**：茶话间自有协议仍是 UTF-8 JSON，现有 `UdpChannel` / `Discovery` / `Messenger` 不接受 GBK 或 IPMSG 文本报文。
3. **显式开启**：兼容模式默认关闭；用户打开后才绑定 `2425/UDP` 并扫描兼容网段。
4. **单独网段**：内网通兼容网段独立保存，不能混入现有茶话间 `scanRanges`，也不参与 `scan-ranges` 低频同步。
5. **能力分级**：每个兼容联系人都有 `CompatCapabilities`，UI 只展示已确认可用的动作；未确认能力默认隐藏。
6. **证据驱动**：文档和代码区分“标准协议支持”“内网通 ACK / UI 已观察”“端到端闭环已确认”三个状态。
7. **纯内网**：所有探测和通信只发生在用户配置的内网 IP / CIDR 范围内；不新增外网请求。
8. **日志脱敏**：兼容消息正文、附件文件名细节和文件内容不写日志；日志只记录 IP、端口、命令号、长度、兼容 peerId、附件数量等元数据。
9. **端口友好**：`2425/UDP` 被占时，不影响茶话间主协议；UI 明确显示兼容模式不可用。

## 4. 功能范围

### 4.1 稳定首版必须实现

> **第二轮复测后范围调整**：文本收发链路在当前 VM 环境不复现，降级到 §4.2。稳定首版只保留发现与联系人展示。

- 设置页新增“内网通兼容”开关，默认关闭。
- 设置页新增兼容端口，默认 `2425`，修改后重启生效。
- 设置页新增兼容 IP 段列表，支持单 IP 与 CIDR。
- 用户可手动扫描某个兼容 IP 段，也可全量刷新兼容节点。
- 扫描时对每个目标单播纯 `BR_ENTRY`（命令位 `0x1`，**不携带任何选项位**），本机源端口绑定 `2425/UDP`。
- 收到 `ANSENTRY` 后生成兼容联系人，显示在线状态、IP、端口、名称、分组和兼容标志。
- 对重复 `ANSENTRY` 做短期去重，避免联系人或系统提示重复闪动（防御性设计，第二轮未复现重复但保留）。
- 兼容联系人与茶话间联系人分组隔离展示，放在“内网通兼容”节点下。
- 兼容会话头部、联系人列表、搜索结果和资料页都显示“内网通”或“兼容”标志。
- 兼容会话隐藏 PK、窗口震动、截图、图片、文件、文件夹、表情包、直接发送、撤回媒体、群成员等茶话间专属动作。
- 兼容会话输入区默认显示“文本收发尚未打通”提示，不开放发送按钮，直到 VM 手测确认 `SENDMSG` 链路闭环。
- 停止兼容模式或应用退出时，对已发现兼容节点发送 `BR_EXIT`。

### 4.2 已映射但暂不默认开放

> **第二轮复测后范围扩大**：文本收发、文件 offer、剪贴板图片 offer 从“稳定首版”或“ACK 已观察”降级到此处，全部标注为“已映射未闭环”。

- **普通文本收发（`SENDMSG | SENDCHECKOPT` / `RECVMSG`）**：第一轮记录收到 `RECVMSG`，第二轮不复现。实现时按标准 IPMSG 编解码，但 UI 必须保留超时失败态，且在 VM 手测打通“内网通将茶话间节点加入联系人”前置条件前，不向用户承诺送达。
- **标准 IPMSG 文件 offer（`FILEATTACHOPT`）**：第一轮记录 ACK + UI 展示，第二轮不复现。parser 仍实现，发送入口默认隐藏。
- **标准 IPMSG 剪贴板图片 offer（`CLIPBOARDOPT` + `FILE_CLIPBOARD`）**：第一轮记录 ACK，第二轮不复现。parser 仍实现，默认按兼容文件处理。
- **标准 IPMSG 文件接收**：如果内网通主动发来 `FILEATTACHOPT`，茶话间可以先解析 offer 并展示只读记录；实际接收需要实现 TCP `GETFILEDATA` 客户端并完成 VM 闭环。
- 目录 / 文件夹：标准 IPMSG 使用 `GETDIRFILES`，内网通行为未验证；首版不开放。
- `GETINFO` / `GETABSENCEINFO` / `BR_ABSENCE`：两轮均无应答；首版不展示离开状态。

### 4.3 明确不做

- 不实现内网通 `9011/UDP`、`9012/TCP`、`9013/TCP`、`9014/TCP` 等私有协议。
- 不实现兼容群聊、讨论组、公告、全员广播。
- 不实现兼容离线补发；兼容节点离线时发送直接失败。
- 不把兼容节点参与茶话间 gossip、scan-ranges、P2P 自更新或群成员选择。
- 不向兼容节点暴露茶话间 profile、nodeId、历史联系人或群组元数据。
- 不把兼容节点写入现有 `peers` 表，避免破坏 nodeId 身份模型。
- 不把茶话间 PK、窗口震动、媒体撤回、表格图片文字切换等主协议能力翻译成内网通消息。
- 不自动接收任何兼容文件或图片，后续实验阶段也必须用户显式接收。

## 5. IPMSG 兼容协议子集

### 5.1 报文格式

IPMSG 文本报文使用空字符结尾：

```text
version:packetNo:user:host:command:message\0
```

内网通实测回包使用变体前缀：

```text
1@shiyeline:19538:SYSTEM:P9FD:3:P9FD\0内网通联系人\0<corpId>\0
```

parser 必须支持：

- `version` 为 `1` 或形如 `1@shiyeline` 的版本标识。
- `packetNo` 为十进制正整数，按字符串保存，避免整数溢出。
- `user`、`host`、`message` 按兼容编码解码。
- 第一个 `\0` 后的内容按扩展字段处理。
- 入站未知 command mode 忽略并记录安全摘要。

### 5.2 命令与选项

| 命令 / 选项 | 数值 | 状态 | 用途 |
|---|---:|---|---|
| `IPMSG_BR_ENTRY` | `0x00000001` | 稳定首版 | 上线 / 探测 |
| `IPMSG_BR_EXIT` | `0x00000002` | 稳定首版 | 退出兼容可见性 |
| `IPMSG_ANSENTRY` | `0x00000003` | 稳定首版 | 发现应答 |
| `IPMSG_BR_ABSENCE` | `0x00000004` | 暂不实现 | 离开状态广播 |
| `IPMSG_SENDMSG` | `0x00000020` | 稳定首版 | 普通文本；可携带附件 offer |
| `IPMSG_RECVMSG` | `0x00000021` | 稳定首版 | `SENDCHECKOPT` 回执 |
| `IPMSG_GETINFO` | `0x00000040` | 已探测无应答 | 信息查询 |
| `IPMSG_SENDINFO` | `0x00000041` | 暂不实现 | 信息查询应答 |
| `IPMSG_GETABSENCEINFO` | `0x00000050` | 已探测无应答 | 离开状态查询 |
| `IPMSG_SENDABSENCEINFO` | `0x00000051` | 暂不实现 | 离开状态查询应答 |
| `IPMSG_GETFILEDATA` | `0x00000060` | 实验阶段 | TCP 拉取单文件 |
| `IPMSG_RELEASEFILES` | `0x00000061` | 实验阶段 | 释放附件资源 |
| `IPMSG_GETDIRFILES` | `0x00000062` | 后续评估 | TCP 拉取目录 |
| `IPMSG_SENDCHECKOPT` | `0x00000100` | 稳定首版 | 要求 `RECVMSG` |
| `IPMSG_FILEATTACHOPT` | `0x00200000` | 解析必备；发送实验 | 消息携带附件列表 |
| `IPMSG_UTF8OPT` | `0x00800000` | 稳定首版 | 当前报文为 UTF-8 |
| `IPMSG_CAPUTF8OPT` | `0x01000000` | 稳定首版 | 声明支持 UTF-8 |
| `IPMSG_CLIPBOARDOPT` | `0x08000000` | 解析必备；发送实验 | 支持剪贴板图片 |

常量建议集中在 `src/main/net/compat/ipmsg.ts`：

```ts
export const IPMSG_BR_ENTRY = 0x00000001
export const IPMSG_BR_EXIT = 0x00000002
export const IPMSG_ANSENTRY = 0x00000003
export const IPMSG_SENDMSG = 0x00000020
export const IPMSG_RECVMSG = 0x00000021
export const IPMSG_GETFILEDATA = 0x00000060
export const IPMSG_RELEASEFILES = 0x00000061
export const IPMSG_GETDIRFILES = 0x00000062

export const IPMSG_SENDCHECKOPT = 0x00000100
export const IPMSG_FILEATTACHOPT = 0x00200000
export const IPMSG_UTF8OPT = 0x00800000
export const IPMSG_CAPUTF8OPT = 0x01000000
export const IPMSG_CLIPBOARDOPT = 0x08000000

export const IPMSG_FILE_REGULAR = 0x00000001
export const IPMSG_FILE_DIR = 0x00000002
export const IPMSG_FILE_RETPARENT = 0x00000003
export const IPMSG_FILE_CLIPBOARD = 0x00000020
export const IPMSG_FILE_CLIPBOARDPOS = 0x00000008
```

### 5.3 附件格式

带附件的 UDP `SENDMSG` 结构：

```text
1:<packetNo>:<user>:<host>:<SENDMSG|options>:<message>\0
<fileId>:<fileName>:<sizeHex>:<mtimeHex>:<attrHex>[:<extAttr>=<value>[,<value>...]]:\a
```

解析规则：

- `message` 是用户可见文本，附件列表在第一个 `\0` 后。
- 多个附件用 `\a` 分隔。
- `sizeHex`、`mtimeHex`、`attrHex` 均按十六进制解析，保留原始字符串用于调试摘要。
- 文件名中的 `::` 解码为 `:`；路径分隔符必须清洗，不能直接落盘。
- `attrHex & IPMSG_FILE_CLIPBOARD` 时，附件类型投影为 `clipboard-image`。
- `attrHex & IPMSG_FILE_DIR` 时，附件类型投影为 `directory`，首版只显示不可接收。
- 未识别扩展属性保留到 `extAttrs`，但不写日志明文。

TCP 文件拉取候选格式：

```text
1:<packetNo>:<user>:<host>:<IPMSG_GETFILEDATA>:<offerPacketNo>:<fileId>:<offsetHex>\0
```

目录拉取候选格式：

```text
1:<packetNo>:<user>:<host>:<IPMSG_GETDIRFILES>:<offerPacketNo>:<fileId>\0
```

该部分需要 VM 闭环后进入实现；当前先完成 parser、fixture 与 UI 降级。

### 5.4 能力矩阵

| 功能 | 协议依据 | 内网通观察（第二轮复测后） | 茶话间处理 |
|---|---|---|---|
| 发现 | `BR_ENTRY` / `ANSENTRY` | 纯 `0x1` 稳定响应；带任何选项位不响应；本轮未见重复应答 | 稳定首版实现，出站 `BR_ENTRY` 不声明能力位，保留去重防御 |
| 下线 | `BR_EXIT` | 未专项验证 | 退出时发送，收到时标离线 |
| 文本发送 | `SENDMSG \| SENDCHECKOPT` | **第二轮不复现 `RECVMSG`**，消息不进 UI；第一轮记录待条件复现 | 降级为"已映射未闭环"；实现后必须保留超时失败态，VM 手测先打通入联系人 |
| 文本接收 | `SENDMSG` | 未验证（需 VM 侧主动发） | 降级为"已映射未闭环"；实现并回 `RECVMSG`，但送达不保证 |
| UTF-8 能力 | `UTF8OPT` / `CAPUTF8OPT` | `ANSENTRY` 不声明能力；`BR_ENTRY` 带这些位反而不回 | 出站 `BR_ENTRY` 不带能力位；`SENDMSG` 出站可先 UTF-8，失败降 GBK |
| 文件 offer | `FILEATTACHOPT` | **第二轮不复现 ACK 与 UI 展示** | 降级为"已映射未闭环"；parser 仍实现，发送入口默认隐藏 |
| 文件拉取 | TCP `GETFILEDATA` | TCP 2425 可连；第二轮未抓到拉取 | 实验阶段，VM 闭环后开放 |
| 文件夹 | TCP `GETDIRFILES` | 无证据 | 隐藏 |
| 剪贴板图片 | `FILE_CLIPBOARD` / `CLIPBOARDOPT` | **第二轮不复现 ACK 与 UI 展示** | 降级为"已映射未闭环"；parser 仍实现，默认按兼容文件处理 |
| 内联图片 | 标准上由剪贴板图片实现 | 未确认 | 不承诺内联效果 |
| 离开信息 | `GETABSENCEINFO` / `BR_ABSENCE` | 查询无响应 | 隐藏 |
| 信息查询 | `GETINFO` / `SENDINFO` | 查询无响应 | 隐藏 |
| 窗口震动 | 无标准 IPMSG 命令 | 未捕获私有命令 | 兼容会话隐藏 |
| PK | 茶话间自有协议 | 无互通基础 | 兼容会话隐藏 |
| 群聊 / 公告 | 内网通私有能力可能存在 | 未抓到协议 | 兼容会话隐藏 |
| 远程协助 | `Remote.dll` / 901x 线索 | 私有协议迹象 | 不接入 |
| 共享文件柜 | 可能为内网通私有协议 | 无协议证据 | 不接入 |

## 6. 编码策略

茶话间自有协议仍坚持 UTF-8 JSON。兼容适配器内部单独处理 GBK：

- 出站 nickname / group / message 默认优先 UTF-8 + `UTF8OPT/CAPUTF8OPT`，目标曾表现异常时降级 GBK。
- 对未声明 UTF-8 能力或回包出现 GBK 字段的节点，保存 `encoding: 'gbk' | 'utf8' | 'unknown'`。
- 入站字段按命令位和实测启发式解码。
- 内网通回包中的分组字段已实测为 GBK，例如 `c4 da cd f8 cd a8 c1 aa cf b5 c8 cb` 解码为 `内网通联系人`。

实现选择：

1. 推荐新增精确锁依赖 `iconv-lite`，先查 `engines`，确认 Node 16 可用且无 native 模块。
2. 若不新增依赖，则首版只能完整支持 UTF-8 与 ASCII，GBK 中文显示会降级，迁移价值会明显下降。

本设计推荐方案 1，因为 GBK 是内网通兼容的现实前提，`iconv-lite` 是纯 JS，符合 native 依赖纪律。

## 7. 模块与接口设计

### 7.1 新增目录

```text
src/main/net/compat/
  ipmsg-codec.ts          # IPMSG 编解码、GBK/UTF-8 解码、命令位解析
  ipmsg-attachment.ts     # FILEATTACHOPT 附件列表解析与安全清洗
  ipmsg-channel.ts        # 独立 UDP socket，绑定兼容端口，限速与单播发送
  ipmsg-file.ts           # 实验阶段 TCP GETFILEDATA / 文件 offer 管理
  nwt-capabilities.ts     # 兼容能力矩阵、UI 投影和动作门控
  nwt-discovery.ts        # 兼容节点扫描、在线状态、退出通知
  nwt-messenger.ts        # 兼容文本发送、SENDCHECK 等待表、入站文本回执
  nwt-types.ts            # NwtPeer、NwtMessage、配置类型
```

这些模块保持零 Electron 依赖，可用 vitest 直接实例化。

### 7.2 协议类型

```ts
export interface IpmsgPacket {
  versionTag: string
  packetNo: string
  userName: string
  hostName: string
  command: number
  commandMode: number
  options: number
  message: string
  extensions: string[]
  attachments: IpmsgAttachment[]
  encoding: 'utf8' | 'gbk' | 'unknown'
  remote: { ip: string; port: number }
  rawLength: number
}

export interface IpmsgAttachment {
  fileId: string
  name: string
  size: number
  mtime: number | null
  attr: number
  kind: 'file' | 'directory' | 'clipboard-image' | 'ret-parent' | 'unknown'
  extAttrs: Record<string, string[]>
  raw: string
}

export interface CompatCapabilities {
  canText: boolean
  canFileOffer: 'unsupported' | 'observed' | 'verified'
  canFilePull: 'unsupported' | 'observed' | 'verified'
  canInlineImage: 'unsupported' | 'observed' | 'verified'
  canClipboardImage: 'unsupported' | 'observed' | 'verified'
  canNudge: false
  canPk: false
  canGroup: false
  canRecall: false
  canOfflineQueue: false
}
```

### 7.3 Service 层

新增 `src/main/services/nwt-compat.ts`，负责：

- 按设置启动 / 停止兼容适配器。
- 管理内存态兼容节点表。
- 将兼容节点投影为 renderer 可展示的联系人。
- 将兼容消息写入本地消息存储或独立兼容存储。
- 维护 `CompatCapabilities`，给 UI 和发送接口提供统一门控。
- 对 renderer 暴露发送、扫描、列表查询能力。
- 后续实验阶段管理文件 offer 生命周期和 TCP 拉取 / 被拉取状态。

`index.ts` 只负责装配与 IPC 转发，业务逻辑留在 service。

### 7.4 IPC / 信息接口

后续实现时在 `shared/ipc.ts` 固化以下通道。所有入参需要手写白名单校验；`ipc/` 层只校验和转发。

```ts
export interface NwtStateView {
  enabled: boolean
  available: boolean
  port: number
  status: 'disabled' | 'listening' | 'port-in-use' | 'scanning' | 'error'
  lastError?: string
}

export interface NwtPeerView {
  kind: 'nwt'
  id: string
  name: string
  group: string
  userName: string
  hostName: string
  ip: string
  port: number
  online: boolean
  lastSeen: number
  protocol: 'ipmsg'
  encoding: 'utf8' | 'gbk' | 'unknown'
  capabilities: CompatCapabilities
}

export interface NwtFileOfferView {
  id: string
  peerId: string
  offerPacketNo: string
  messageText: string
  attachments: Array<{
    fileId: string
    name: string
    size: number
    kind: 'file' | 'directory' | 'clipboard-image' | 'unknown'
  }>
  status: 'offered' | 'unsupported' | 'ready-to-accept' | 'receiving' | 'done' | 'failed'
}
```

调用通道：

| IPC | 方向 | 稳定阶段 | 说明 |
|---|---|---|---|
| `nwt:state` | renderer → main | A | 读取兼容模式状态 |
| `nwt:configure` | renderer → main | B | 保存 enabled / port / ranges / manualPeers |
| `nwt:scan` | renderer → main | B | 扫描指定兼容 IP / CIDR |
| `nwt:list-peers` | renderer → main | B | 获取兼容联系人 |
| `nwt:send-text` | renderer → main | C | 发送普通文本并等待 `RECVMSG` |
| `nwt:list-file-offers` | renderer → main | 实验 | 查询兼容文件 offer |
| `nwt:accept-file-offer` | renderer → main | 实验 | 用户显式接收后发起 `GETFILEDATA` |
| `nwt:reject-file-offer` | renderer → main | 实验 | 拒绝并释放本地记录 |

事件通道：

| IPC | 方向 | 说明 |
|---|---|---|
| `nwt:state-updated` | main → renderer | 端口、扫描、错误状态变化 |
| `nwt:peers-updated` | main → renderer | 兼容联系人新增 / 在线状态变化 |
| `nwt:message` | main → renderer | 入站兼容文本 |
| `nwt:message-status` | main → renderer | 发送中 / 已送达 / 失败 |
| `nwt:file-offer` | main → renderer | 解析到兼容附件 offer |
| `nwt:file-transfer-updated` | main → renderer | 实验阶段附件接收进度 |

### 7.5 Renderer 投影

兼容会话 ID 建议为：

```text
compat:nwt:<ip>:<port>:<user>:<host>
```

联系人 ID 建议为：

```text
nwt:<ip>:<port>:<user>:<host>
```

renderer 不应把 `NwtPeerView` 转成 `PeerView`。会话 store 可以使用统一 `ConversationView`，但必须保留 `source: 'pantry' | 'nwt'` 和 `capabilities` 字段，用它驱动头部菜单、输入区工具条、右键菜单和粘贴行为。

## 8. 数据与配置

### 8.1 配置

`config.json` 新增：

```jsonc
{
  "nwtCompat": {
    "enabled": false,
    "port": 2425,
    "ranges": ["10.211.55.0/24"],
    "manualPeers": ["10.211.55.3"],
    "scanOnStartup": false,
    "experimentalFile": false
  }
}
```

约束：

- `ranges` 与 `manualPeers` 总量上限建议 100。
- CIDR 展开单段主机数上限建议 `/22`，同茶话间 scan-ranges。
- `scanOnStartup` 默认关闭，避免一开机就向大网段打兼容探测。
- `experimentalFile` 默认关闭；只有 VM 端到端闭环后才允许在设置页出现。
- 所有配置仅本机保存，不通过茶话间协议同步。

### 8.2 存储

首版可以先不新增 SQLite 表，兼容联系人仅内存在线，消息进入现有 `messages` 表时用独立 `conv_id` 前缀表达兼容会话。

如果需要兼容联系人持久保留，建议新增独立表，避免污染 `peers`：

```sql
compat_peers(
  id TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  name TEXT NOT NULL,
  group_name TEXT NOT NULL,
  user_name TEXT NOT NULL,
  host_name TEXT NOT NULL,
  ip TEXT NOT NULL,
  port INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
)
```

本轮推荐：新增 `compat_peers`，让用户重启后仍能看到最近发现过的内网通联系人，但在线状态只存内存。

实验文件 offer 若进入实现，新增 `compat_file_offers`，避免复用茶话间 `transfers` 语义：

```sql
compat_file_offers(
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  offer_packet_no TEXT NOT NULL,
  message_text TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

## 9. UI 设计

### 9.1 设置页

在“网络连接”分组下新增“内网通兼容”小节：

- 开关：`启用内网通兼容`
- 端口：`互通端口`，默认 `2425`，旁注“修改后重启生效”
- 网段表：列为 `IP 段 / 在线 / 操作`
- 操作：刷新、删除，删除沿用二次确认
- 手动节点：输入单 IP，保存后可单独扫描
- 状态行：
  - `未启用`
  - `兼容端口已监听`
  - `端口被占用，兼容模式不可用`
  - `正在扫描 32 / 254`
  - `最近发现 3 个内网通节点`

文案要明确该功能只影响内网通 / 飞鸽兼容节点，不改变茶话间节点发现。

`experimentalFile` 在首版设置页不展示。完成文件 TCP 闭环后，可以在“高级”折叠区展示 `实验性兼容文件接收` 开关，并附短提示“只接收用户确认的兼容文件”。

### 9.2 联系人列表

通讯录中新增一级分组：

```text
内网通兼容
  内网通联系人
    P9FD  [内网通]
```

兼容联系人显示：

- 名称：优先 message 字段，其次 host，再其次 IP。
- 副文字：`内网通 · 10.211.55.3`。
- 视觉标志：名称右侧显示小型描边徽标 `内网通`；徽标用中性浅底 + 茶青描边，避免和在线点混淆。
- 在线状态：最近收到报文或扫描应答后在线；超过兼容离线窗口转离线。
- 离线态：条目灰显并显示 `离线` 副文字。

兼容联系人不展示茶话间资料页中的公司 / 部门 / 团队 / 头像编辑 / 备注同步能力。可以支持本地备注，备注只存在本机。

### 9.3 会话头部与资料框

兼容会话复用普通单聊消息列表，但头部能力降级：

- 标题旁显示 `内网通` 徽标。
- 副标题显示 `内网通兼容 · IP:端口 · 功能受限`。
- 右侧菜单只保留置顶、免打扰、清空本会话记录和查看兼容资料。
- 资料框展示昵称、登录用户、主机名、IP、端口、分组、编码来源、最近发现时间和兼容能力。
- 不展示组织资料、版本升级、窗口震动、PK、群聊、文件直发、自更新等入口。

### 9.4 输入区与动作隐藏

输入区由 `ConversationCapabilities` 驱动：

| 能力 | 茶话间单聊 | 内网通稳定首版 |
|---|---|---|
| 文本 | 显示 | 显示 |
| 历史搜索 | 显示 | 显示 |
| 表情 / 表情包 | 显示 | 隐藏 |
| PK | 显示 | 隐藏 |
| 窗口震动 | 显示 | 隐藏 |
| 截图 | 显示 | 隐藏 |
| 图片 | 显示 | 隐藏 |
| 文件 / 文件夹 | 显示 | 隐藏 |
| 文件直接发送 | 条件显示 | 隐藏 |
| 媒体撤回 | 条件显示 | 隐藏 |

兼容会话只显示文本输入框、历史搜索和发送按钮。空输入不可发送；粘贴图片 / 文件时只保留文本内容，若剪贴板没有文本则给轻量提示：

```text
内网通兼容会话暂不支持发送图片或文件
```

发送失败时气泡保留失败态，用户可修改后重发。对方离线或超时直接显示失败，不显示“上线后自动送达”。

### 9.5 兼容附件的后续 UI

实验阶段若开放文件 / 图片：

- 内网通附件统一渲染为“兼容文件”卡片，左侧使用普通文件图标，标题显示清洗后的文件名，副行显示 `来自内网通 · 大小`。
- `clipboard-image` 首版也作为兼容文件卡片显示；只有确认内网通与茶话间双方都能按图片语义闭环后，再考虑内联图片气泡。
- 操作只保留 `接收`、`另存为`、`拒绝`，不显示直接发送、撤回、转发、添加到表情、OCR、表格文字视图。
- 永不自动接收兼容附件。

## 10. 在线与可靠性

兼容节点没有茶话间心跳。首版采用轻量机制：

- 扫描或收到任何兼容报文时更新 `lastSeen` 并标在线。
- 每 60 秒对在线兼容节点单播一次 `BR_ENTRY` 探活。
- 连续 2 次探活无响应或 180 秒无任何报文，标离线。
- 文本发送只重试 UDP，不走茶话间 TCP 兜底。
- `SENDCHECK` 等待超时建议 3 秒，最多重发 2 次。
- 收到重复 `SENDMSG` 时按 `packetNo + ip + port + user + host` 做短期去重，但仍回 `RECVMSG`。

兼容消息不进入茶话间离线补发队列。原因是 IPMSG 兼容节点没有茶话间上线事件与持久身份，重启、IP 漂移、主机名变化都可能让补发投错对象。

## 11. 安全与边界

- 入站 UDP IPMSG 包最大长度建议 4096B，超过直接丢弃。
- 入站 TCP 文件控制包最大长度建议 4096B，文件流按用户确认的 offer 和大小上限接收。
- 每源 IP 做令牌桶限速，默认可复用 `UdpChannel` 的 30/s、burst 60 思路。
- 只接受 IPv4。
- 只对用户配置的兼容网段主动扫描；被动接收报文可以建临时联系人，但不自动扩展扫描范围。
- 兼容报文正文不写日志。
- 兼容附件文件名清洗后再展示 / 落盘，禁止路径穿越和绝对路径。
- 兼容附件不进入茶话间直接发送、自动接收、P2P 自更新或表情收藏流程。
- 兼容节点不能触发自更新、文件自动接收、群管理、窗口震动、PK 等现有能力。
- `BR_ENTRY` 不携带茶话间 nodeId；出站 user / host 使用本机系统用户名和主机名的安全截断版本，或设置页中用户昵称的兼容安全名。

## 12. 依赖策略

如采用 `iconv-lite`：

- 必须使用 `npm i -E iconv-lite@<version>` 精确锁版本。
- 新增前确认 `package.json engines` 或发布信息兼容 Node 16。
- 确认无 native 模块。
- 在最终提交中同步更新 `package.json` 版本号。

若后续发现不能新增依赖，需在设计中降级为 UTF-8 / ASCII 首版，并明确中文内网通名称显示不完整。该降级不建议作为正式方案。

## 13. 测试计划

### 13.1 单元测试

- `ipmsg-codec.test.ts`
  - 编码 `BR_ENTRY` / `BR_EXIT` / `SENDMSG` / `RECVMSG`
  - 解析普通 IPMSG 报文
  - 解析 `1@shiyeline` 变体
  - 解析 GBK 分组 `内网通联系人`
  - 解析重复 `ANSENTRY` fixture 并去重
  - 超长包、坏命令、缺字段拒绝
- `ipmsg-attachment.test.ts`
  - 解析普通文件附件
  - 解析 `IPMSG_FILE_CLIPBOARD` 图片附件
  - 解析多附件 `\a` 分隔
  - 文件名 `::` 转义与路径清洗
  - 非法 size / attr / extAttr 拒绝或降级
- `nwt-capabilities.test.ts`
  - 内网通联系人默认只开放文本与历史搜索
  - 文件 offer 只影响实验能力，不让工具条显示普通文件入口
  - PK / nudge / group / recall 恒为 false
- `nwt-messenger.test.ts`
  - `SENDCHECK` 收到 `RECVMSG` 标记成功
  - 超时重试后失败
  - 重复 `SENDMSG` 只入库一次但重复回执
- `nwt-discovery.test.ts`
  - 扫描 IP 列表并登记 `ANSENTRY`
  - 离线超时
  - `BR_EXIT` 标离线

### 13.2 回环集成测试

用两个本地 UDP socket 模拟：

- 兼容节点响应 `BR_ENTRY`。
- 茶话间兼容适配器发现节点。
- 茶话间向模拟节点发送文本并收到 `RECVMSG`。
- 模拟节点向茶话间发送文本并收到 `RECVMSG`。
- 模拟节点发送带 `FILEATTACHOPT` 的 offer，茶话间解析为兼容文件 offer，但 UI capabilities 不开放普通文件工具。

所有自动测试必须绑定 `127.0.0.1`，`broadcastTargets: []`，不得向真实局域网发包。

### 13.3 VM 手测

使用 Parallels Windows VM + 内网通：

1. 启动内网通，确认 `2425/UDP` 监听。
2. 茶话间开启兼容模式。
3. 添加 `10.211.55.3` 或对应 CIDR。
4. 扫描后出现 `P9FD` / `内网通联系人`，联系人带 `内网通` 徽标。
5. 茶话间发送中文文本，内网通收到。
6. 内网通发送中文文本，茶话间收到。
7. 兼容会话工具条只保留文本、历史搜索和发送。
8. 关闭内网通或发 `BR_EXIT` 后，茶话间标离线。
9. 占用本机 `2425/UDP` 后启动茶话间，兼容模式显示端口占用，主协议仍正常。
10. 发送标准 IPMSG 文件 offer，确认内网通 UI 展示，记录其是否发起 TCP `GETFILEDATA`。
11. 发送标准 IPMSG 剪贴板图片 offer，确认内网通 UI 是文件项还是内联图片。
12. 从内网通向茶话间主动发送文件 / 图片，确认茶话间 parser 能识别 offer。
13. 如内网通有“震动”按钮，单独抓包确认是否走 2425 或 901x；抓不到标准 IPMSG 命令时继续隐藏。

## 14. 分阶段交付

### 阶段 A：协议适配地基

- 新增 IPMSG codec、附件 parser、channel、发现和消息等待表。
- 完成单元测试与回环集成测试。
- 暂不接 UI，只提供 service 级测试入口。

### 阶段 B：设置、联系人和能力标志

- 设置页增加兼容开关、端口、IP 段表。
- 通讯录展示兼容联系人和 `内网通` 徽标。
- 主进程 IPC 增加扫描、列表、状态查询。
- renderer 引入 `ConversationCapabilities`，兼容会话隐藏 PK、震动、图片、文件等动作。

### 阶段 C：兼容会话与文本收发

- 兼容联系人可打开会话。
- 发送 / 接收文本落库并显示。
- 发送状态接入 `RECVMSG`。
- 完成 Parallels + 内网通文本实测。

### 阶段 D：实验文件 / 图片互通

- 基于附件 parser 展示兼容文件 offer。
- 完成 TCP `GETFILEDATA` 客户端 / 服务端闭环。
- 只在实验开关下开放兼容附件接收 / 发送。
- 图片先按 `clipboard-image` 文件卡处理，确认内联行为后再升级。

### 阶段 E：私有协议后续评估

- 仅在用户明确要求时，抓包分析 `901x` 私有通道。
- 远程协助、共享文件柜、公告、组织架构、震动等能力需要单独决议。

## 15. 待用户确认

以下产品取舍需要用户拍板后再实现：

1. 兼容模式是否默认关闭：本设计建议默认关闭。
2. 兼容联系人是否出现在主会话列表：本设计建议发过或收过消息后出现。
3. 首版是否允许接收内网通主动发来的陌生节点消息：本设计建议允许，但标为临时兼容联系人。
4. 文件 / 图片是否进入“实验开关”阶段：本设计建议先完成文本链路，再用 VM 把 TCP 拉取闭环后开放。
5. 是否投入内网通 `901x` 私有协议逆向：本设计建议等基础互通稳定后再决定，且默认不做远程协助类高风险能力。
6. **【第二轮复测新增】`SENDMSG` 链路当前不通，如何推进？**：第二轮复测发现内网通不回 `RECVMSG`、消息不进 UI，第一轮记录不复现。实现阶段 A 的阻塞项是“找到让内网通把茶话间节点加入可见联系人的可靠路径”。可选项：
   - (a) 在 VM 内网通 UI 中手动添加茶话间 IP 为联系人，再复测 `SENDMSG` 是否回执；
   - (b) 排查内网通是否有“组织/企业边界”配置，或是否需要特定协议交换（如 `GETINFO` 应答、共享密钥）才入联系人；
   - (c) 暂缓文本收发实现，首版只交付发现 + 兼容联系人展示 + 能力降级 UI，等后续版本再攻文本链路；
   - (d) 重新审视第一轮的 Computer Use 路径，确认是否是 UI 操作副作用导致的临时开通。
   本设计建议先按 (a) 在 VM 手动添加联系人复测，若仍不通再按 (c) 降级首版范围。

## 16. 变更记录

- 2026-08-10 决议 #285：新增英文当前设计与中英双向入口，明确保留决议 #199 的暂缓状态。兼容协议、模块、依赖、设置和界面均未实现，仓库版本 **0.51.0 → 0.51.1**。
