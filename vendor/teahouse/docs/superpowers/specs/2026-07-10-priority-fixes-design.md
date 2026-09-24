# 优先修复批次设计

| 项 | 内容 |
|---|---|
| 日期 | 2026-07-10 |
| 基线 | main @ `8ca4dbe` / v0.32.24 |
| 目标版本 | v0.32.25 |
| 交付方式 | 七项修复合并为一个代码提交；每项独立红绿测试与专项验证 |

## 1. 目标与范围

本批次处理 2026-07-10 全库审查确认的七个优先问题：

1. TCP 控制帧字段缺少完整白名单校验，畸形 `finish.transferId` 可把异常带入数据库调用；
2. `purpose:"update"` offer 未关联用户发起的更新请求，且缺少包型与大小约束；
3. `package.json`、`package-lock.json` 与发布 tag 缺少版本一致性校验；
4. 文件服务缺少全局并发、连接数量和空闲时间资源预算；
5. 会话打开、搜索跳转与回到最新之间存在异步响应覆盖竞态；
6. 截图选区贴近屏幕底部时，操作栏会移出视口；
7. 截图窗口缺少 `will-navigate` 拦截。

本批次不处理审查报告中的虚拟列表、渲染入口拆包、OCR 缓存、可访问性、日志体系、巨型文件拆分与文档存量漂移；这些保留为后续优化项。

## 2. 交付与版本策略

- 需求决议使用一个批次决议 **#208**，记录七项修复的共同交付边界。
- 线上协议格式不增加字段、不改变正常时序；只收紧 TCP 控制帧与更新 offer 的入站接受条件。
- `package.json` 与 `package-lock.json` 同步从 `0.32.24` 升到 `0.32.25`。
- 七项实现、测试、文档与版本变更合并为一个 `fix:` 中文提交。
- 每项在进入下一项前完成独立的 RED → GREEN 专项测试；最终统一跑仓库五连验证。

## 3. TCP 控制帧安全边界

### 3.1 校验位置

`FrameReader` 继续负责长度前缀、JSON 与裸流切换，同时在 JSON 解析后按帧型完成字段白名单校验。输出给 `TransferServer` / `pullTransfer` 的值必须已经是合法 `TcpFrame`。

合法约束：

- `pull`：`from`、`transferId`、`fileId` 为非空且不超过协议 ID 上限的字符串；`offset` 为非负安全整数；
- `finish`：`transferId` 为合法 ID；
- `pull-ok`：`fileId` 为合法 ID，`len` 为非负安全整数；
- `done`：`fileId` 为合法 ID，`sha256` 为 64 位小写十六进制；
- `err`：`reason` 为长度受限的非空字符串；
- `msg`：内层 envelope 继续复用 `decodeTcpEnvelopeObject`；
- `msg-ack`：`ackFor` 为合法 ID；
- 未知帧型和多余/错误类型字段均作为 `bad-frame-shape` 关闭连接。

### 3.2 异常收口

`FrameReader` 首次报错后进入终止态、清空缓冲区并忽略后续输入，避免同一坏帧重复触发错误。socket 的 `data` 入口增加最后一道同步异常收口，任何未预期异常只销毁当前连接，不传播到主进程事件循环。

### 3.3 测试

- `frame.test.ts` 覆盖每种合法帧、对象型 `finish.transferId`、非法 hash、未知帧型和报错后继续 feed；
- `transfer.test.ts` 通过真实 127.0.0.1 连接发送畸形 finish，确认服务仍能接受后续合法连接。

## 4. 更新包请求关联与 512 MiB 上限

### 4.1 请求门

`services/updater.ts` 增加内存级更新请求门，保存：来源 nodeId、来源版本、本机平台、本机架构、过期时间。用户点击请求时先登记，可靠控制报文发送失败则撤销；新请求覆盖旧请求。

请求门有效期为 **2 分钟**，只约束 offer 到达时间。合法 offer 被消费后立即清除，后续重复 offer 拒绝。

### 4.2 接受条件

`FilesService` 通过依赖注入的授权回调检查更新 offer。以下条件全部满足才登记隐藏 transfer 并自动 accept：

- `peerId` 等于当前请求来源；
- offer 为单文件、非目录、非群聊；
- `rootName`、清单相对路径和文件名一致；
- 文件名匹配请求版本、平台和架构的项目标准安装包命名；
- 总大小为 `1..536870912` 字节，即最大 **512 MiB**；
- 请求仍在 2 分钟有效期内。

拒绝条件走现有 decline 控制报文，不进入聊天、不写更新临时文件。SHA-256 校验、传输临时目录和现有用户确认入口保持原行为。

### 4.3 协议与测试

- `docs/protocol.md` 先登记更新 offer 上限与请求关联规则；
- `shared/protocol.ts` 增加 `UPDATE_PACKAGE_MAX_BYTES` 单一常量；
- `codec.ts` 在入站阶段拒绝超过上限的 update offer；
- `updater.test.ts` 覆盖登记、超时、来源/版本/平台/架构/包名匹配与单次消费；
- `files.test.ts` 覆盖未请求、错误来源、超限和合法请求后的自动 accept。

## 5. 发布版本一致性

新增无依赖 Node 脚本 `scripts/check-version-consistency.mjs`：

- 始终校验 `package.json.version === package-lock.json.version === package-lock.json.packages[""].version`；
- tag 构建时校验 `GITHUB_REF_NAME === "v" + packageVersion`；
- 普通 branch / 本地运行只校验 package 与 lock；
- 输出简短中文错误并以非零退出码阻断。

脚本加入 `npm run check:version`，Release workflow 的四个平台 job 在安装依赖前调用；release job 上传前再次校验 tag 与实际产物文件名均含该版本。测试通过临时 fixture 目录分别覆盖一致、lock 漂移和 tag 漂移。

## 6. 文件传输资源预算

### 6.1 数据流并发

`TransferServer` 全局最多同时执行 **3 个文件读流**。其余合法 pull 在连接内排队，等前序文件流结束后按 FIFO 启动；排队期间不提前返回错误，保证群聊多收件人能够等待而非立即失败。同一连接仍保持单文件串行。

### 6.2 连接预算

- 最大活跃 TCP 连接数：**256**，覆盖 200 人讨论组的合法同时拉取和少量 TCP 控制消息；
- 新连接握手空闲超时：**15 秒**；
- 文件传输活动期间空闲超时：**60 秒**，每次收到帧、发送或接收数据时刷新；
- 超限连接直接关闭，已开始的传输不受影响；
- socket 关闭时移除其排队 pull、销毁读流并释放并发槽。

### 6.3 测试

`transfer.test.ts` 使用可控读流证明第四个 pull 在前三个完成前不会启动、槽位释放后会继续；另覆盖空闲连接关闭、连接关闭释放队列和现有多文件/背压行为。

## 7. 会话导航竞态

chat store 增加共享导航代次。`openPeer`、`openConv`、`jumpToMessage`、`backToLatest` 每次用户导航先取得新代次；每个 `await` 返回后核对代次，旧响应只允许把自身查询结果丢弃，不再改 activeConv、消息窗口、viewingHistory、highlight 或滚动意图。

单聊 `openConv` 复用同一次代次进入 `openPeer`，避免内部调用重复抢号。通知、托盘、震动和搜索入口继续复用现有方法。测试使用手动控制 Promise 的完成顺序，覆盖 A→B 后 A 晚返回、搜索跳转被新会话覆盖、回到最新被新导航覆盖。

## 8. 截图工具栏视口约束

提取纯函数计算截图操作栏位置，输入选区矩形、视口宽高和工具栏宽高：

- 下方空间足够时放在选区下方；
- 下方不足且上方足够时放在选区上方；
- 上下均不足时夹到视口内；
- 水平方向始终留 8px 边距；
- 工具栏挂载后测量真实尺寸，窗口 resize 或选区变化时重新计算。

新增纯函数测试覆盖贴底、贴右、小视口和普通下置场景；截图交互、标注和按钮文案保持不变。

## 9. 截图窗口导航拦截

`capture-window.ts` 与主窗、设置窗、图片窗保持同一安全基线：`setWindowOpenHandler` deny，`will-navigate` 全部 `preventDefault()`。窗口工厂测试通过 Electron mock 验证两个 handler 均注册，现有 sandbox / contextIsolation / nodeIntegration 配置保持不变。

## 10. 验证与验收

每项专项测试依次执行并记录 RED/GREEN：

1. `frame.test.ts` + `transfer.test.ts`；
2. `codec.test.ts` + `updater.test.ts` + `files.test.ts`；
3. 版本脚本专项测试与本地 `npm run check:version`；
4. `transfer.test.ts` 并发/超时用例；
5. `stores/chat.test.ts`；
6. 截图位置纯函数测试；
7. 截图窗口安全配置测试。

最终必须通过：

```bash
npm test
npm run test:db
npm run typecheck
npm run build
npm run smoke
```

同时确认工作树仅包含本批次文件、Electron 仍精确锁 `22.3.27`、构建目标仍为 `node16` / `chrome108`、网络测试继续绑定 `127.0.0.1` 且 `broadcastTargets: []`。
