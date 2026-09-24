# Priority Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复七个已确认的高优先级正确性、安全、发布、资源与交互问题，并以 v0.32.25 单一代码提交交付。

**Architecture:** 保持线上报文字段与正常时序不变，在最靠近不可信输入和异步状态写入的位置增加确定性闸门。TCP 资源预算由 `TransferServer` 统一执行，更新请求授权由 `UpdateRequestGate` 持有，renderer 的竞态和截图定位分别用单调代次与纯函数收口。

**Tech Stack:** Electron 22.3.27、Node 16.17、Chrome 108、TypeScript strict、Vue 3、Pinia、Vitest、Node ESM 脚本、GitHub Actions。

## Global Constraints

- `electron` 与 `build.electronVersion` 必须精确保持 `22.3.27`。
- main/preload 目标保持 `node16`，renderer 目标保持 `chrome108`。
- 不新增依赖，不使用全局 `fetch`、`structuredClone` 或 Chrome 108 之后的 Web API。
- 网络测试只绑定 `127.0.0.1`，不发送真实广播。
- 所有网络入站值先白名单校验，再进入数据库、文件系统或业务服务。
- 文档、注释、测试名、UI 文案、commit message 使用简体中文。
- 七项修复合并为一个代码提交；中间任务不提交。
- `package.json` 与 `package-lock.json` 只在最终任务统一升到 `0.32.25`。

---

### Task 1: 决议 #208 与四份事实来源文档

**Files:**
- Modify: `docs/requirements.md`
- Modify: `docs/protocol.md`
- Modify: `docs/tech-design.md`
- Modify: `docs/ui-design.md`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-10-priority-fixes-design.md`
- Produces: 决议 #208、`UPDATE_PACKAGE_MAX_BYTES=512 MiB`、TCP 资源预算、导航代次和截图工具栏定位的规范文本。

- [ ] **Step 1: 在 requirements 现行章节登记用户行为和决议**

在 F-CAP-1、F-FILE-1、F-SYS-5 的现行描述中分别加入：截图工具栏始终留在视口、TCP 同时读流最多 3、更新包必须关联两分钟内的用户请求且最大 512 MiB。决议表新增完整一行：

```markdown
| 208 | 全库审查确认七个优先缺口，用户要求合并修复并逐项独立测试 | 采用单批次修复：TCP 帧逐型白名单与异常收口；更新 offer 绑定 2 分钟内用户请求并限制 512 MiB；package/lock/tag/产物版本一致性门禁；TCP 最多 3 个并发读流、256 连接、15s 握手与 60s 活动空闲超时；会话导航单调代次；截图工具栏视口翻转；截图窗补 will-navigate。线上字段不变。版本 0.32.24 → **0.32.25**。 |
```

变更记录追加 `2026-07-10 v1.87 决议 #208`，内容与表格一致。

- [ ] **Step 2: 先更新 protocol 再改任何协议代码**

在 §8 TCP 帧格式与校验段写明逐型字段白名单、错误连接关闭、最多 3 个并发文件读流、256 个连接、15s 首帧超时、60s 活动空闲超时；在 §8.1 写明 update offer 必须匹配 2 分钟内的请求来源/版本/平台/架构/标准包名且最大 512 MiB。常量表加入：

```markdown
| UPDATE_PACKAGE_MAX_BYTES | 512 MiB | 更新包入站硬上限（决议 #208） |
| TCP_MAX_CONCURRENT_STREAMS | 3 | 全局同时供流文件数 |
| TCP_MAX_CONNECTIONS | 256 | 覆盖 200 人讨论组与控制短连接 |
```

变更记录追加 `2026-07-10 v0.40 决议 #208`。

- [ ] **Step 3: 更新技术与 UI 事实来源**

`tech-design.md` 记录 `UpdateRequestGate`、`TransferServer` FIFO 槽位、chat store 导航代次、截图窗口导航拦截和 CI 版本门禁；变更记录追加 `v1.09`。`ui-design.md` 的截图交互写明工具栏下方不足时翻到上方、四边保留 8px；变更记录追加 `v1.20`。

- [ ] **Step 4: 校验文档编号和关键值**

Run:

```bash
rg -n "决议 #208|512 MiB|TCP_MAX_CONCURRENT_STREAMS|导航代次|工具栏" docs/{requirements,protocol,tech-design,ui-design}.md
git diff --check
```

Expected: 四份文档均命中 #208；只出现 512 MiB、并发 3、连接 256、15s/60s；`git diff --check` 退出 0。

---

### Task 2: TCP 控制帧逐型白名单与异常终止态

**Files:**
- Modify: `src/main/net/frame.ts`
- Modify: `src/main/net/frame.test.ts`
- Modify: `src/main/net/transfer.ts`
- Modify: `src/main/net/transfer.test.ts`

**Interfaces:**
- Consumes: `LIMITS.id`, `LIMITS.from`, `decodeTcpEnvelopeObject(raw)`。
- Produces: `decodeTcpFrameObject(raw: unknown): TcpFrame | null`；`FrameReader` 报错后永久停止处理。

- [ ] **Step 1: 写失败的逐型校验与终止态测试**

在 `frame.test.ts` 把合法 hash 改为 64 位十六进制，新增以下断言：

```typescript
it('拒绝字段类型错误与未知 TCP 帧，报错后不再重复处理', () => {
  const frames: string[] = []
  const errors: string[] = []
  const reader = new FrameReader(
    (frame) => frames.push(frame.type),
    () => undefined,
    (reason) => errors.push(reason)
  )
  const malformed = Buffer.from(JSON.stringify({ type: 'finish', transferId: {} }))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(malformed.length)
  reader.feed(Buffer.concat([head, malformed]))
  reader.feed(encodeFrame({ type: 'finish', transferId: 'valid-id' }))
  expect(frames).toEqual([])
  expect(errors).toEqual(['bad-frame-shape'])
})
```

再用表驱动覆盖非法 `pull.offset`、非法 `done.sha256`、未知 `type`、多余字段。

- [ ] **Step 2: 运行 RED**

Run: `npx vitest run src/main/net/frame.test.ts`

Expected: FAIL；对象型 transferId 仍进入 `onFrame`，终止态或严格字段用例不满足。

- [ ] **Step 3: 实现最小逐型解码器**

在 `frame.ts` 增加严格 helper：

```typescript
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

function id(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function nonNegativeSafeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

export function decodeTcpFrameObject(raw: unknown): TcpFrame | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (value.type === 'pull') {
    return exactKeys(value, ['type', 'from', 'transferId', 'fileId', 'offset']) &&
      id(value.from, LIMITS.from) && id(value.transferId, LIMITS.id) &&
      id(value.fileId, LIMITS.id) && nonNegativeSafeInt(value.offset)
      ? value as unknown as TcpFrame : null
  }
  if (value.type === 'finish') {
    return exactKeys(value, ['type', 'transferId']) && id(value.transferId, LIMITS.id)
      ? value as unknown as TcpFrame : null
  }
  if (value.type === 'pull-ok') {
    return exactKeys(value, ['type', 'fileId', 'len']) && id(value.fileId, LIMITS.id) &&
      nonNegativeSafeInt(value.len) ? value as unknown as TcpFrame : null
  }
  if (value.type === 'done') {
    return exactKeys(value, ['type', 'fileId', 'sha256']) && id(value.fileId, LIMITS.id) &&
      typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
      ? value as unknown as TcpFrame : null
  }
  if (value.type === 'err') {
    return exactKeys(value, ['type', 'reason']) && id(value.reason, 128)
      ? value as unknown as TcpFrame : null
  }
  if (value.type === 'msg') {
    if (!exactKeys(value, ['type', 'envelope'])) return null
    const decoded = decodeTcpEnvelopeObject(value.envelope)
    return decoded.ok && decoded.known ? { type: 'msg', envelope: decoded.env } : null
  }
  if (value.type === 'msg-ack') {
    return exactKeys(value, ['type', 'ackFor']) && id(value.ackFor, LIMITS.id)
      ? value as unknown as TcpFrame : null
  }
  return null
}
```

`FrameReader` 增加 `failed`，所有错误统一走：

```typescript
private fail(reason: string): void {
  if (this.failed) return
  this.failed = true
  this.buf = Buffer.alloc(0)
  this.rawLeft = 0
  this.onError(reason)
}
```

JSON parse 后调用 `decodeTcpFrameObject`；null 走 `fail('bad-frame-shape')`。

- [ ] **Step 4: 给 TransferServer data 入口加同步异常收口**

```typescript
socket.on('data', (chunk) => {
  try {
    reader.feed(chunk)
  } catch {
    socket.destroy()
  }
})
```

在 `transfer.test.ts` 用真实 127.0.0.1 连接发送对象型 finish，等待连接关闭，再用新连接拉取合法小文件，证明服务进程仍工作。

- [ ] **Step 5: 运行 GREEN**

Run: `npx vitest run src/main/net/frame.test.ts src/main/net/transfer.test.ts`

Expected: 两个测试文件全部通过；畸形帧只关闭当前连接，合法回环仍完成 SHA-256 校验。

---

### Task 3: 更新请求门、包名匹配与 512 MiB 入站上限

**Files:**
- Modify: `src/shared/protocol.ts`
- Modify: `src/main/net/codec.ts`
- Modify: `src/main/net/codec.test.ts`
- Modify: `src/main/services/updater.ts`
- Modify: `src/main/services/updater.test.ts`
- Modify: `src/main/services/files.ts`
- Modify: `src/main/services/files.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces: `UPDATE_PACKAGE_MAX_BYTES = 512 * 1024 * 1024`。
- Produces: `matchesUpdatePackageName(name, version, platform, arch): boolean`。
- Produces: `UpdateRequestGate.begin(...) => number`, `cancel(token)`, `consume(peerId, name, size, now?) => boolean`。
- Produces: `FilesDeps.authorizeUpdateOffer?: (peerId, name, totalSize) => boolean`。

- [ ] **Step 1: 写 codec 超限 RED 测试**

在既有 update offer 用例旁新增 `totalSize = UPDATE_PACKAGE_MAX_BYTES + 1` 且清单 size 同值，断言 `decode(encode(env)).ok === false`。

Run: `npx vitest run src/main/net/codec.test.ts`

Expected: FAIL；当前 codec 接受超限 update offer。

- [ ] **Step 2: 先加 shared 常量，再让 codec 通过**

```typescript
export const UPDATE_PACKAGE_MAX_BYTES = 512 * 1024 * 1024
```

`codec.ts` 的 update 条件加入 `o.totalSize! > UPDATE_PACKAGE_MAX_BYTES` 拒绝。运行同一命令，Expected: PASS。

- [ ] **Step 3: 写 UpdateRequestGate RED 测试**

在 `updater.test.ts` 使用假时钟值覆盖：Linux x64 标准 deb 成功且只消费一次；错误 peer/version/arch/扩展名失败；`expiresAt` 后失败；Windows portable 失败、setup 成功。

```typescript
const gate = new UpdateRequestGate(120_000)
const token = gate.begin({ nodeId: 'source', version: '0.32.25', platform: 'linux', arch: 'x64' }, 1_000)
expect(gate.consume('source', 'Teahouse-0.32.25-linux-amd64.deb', 1024, 2_000)).toBe(true)
expect(gate.consume('source', 'Teahouse-0.32.25-linux-amd64.deb', 1024, 2_001)).toBe(false)
gate.cancel(token)
```

Run: `npx vitest run src/main/services/updater.test.ts`

Expected: FAIL；类和精确包名 helper 尚不存在。

- [ ] **Step 4: 实现 UpdateRequestGate 和统一包名 helper**

```typescript
export interface PendingUpdateRequest {
  nodeId: string
  version: string
  platform: Platform
  arch: RuntimeArch
}

export function matchesUpdatePackageName(name: string, version: string, platform: Platform, arch: RuntimeArch): boolean {
  const lower = name.toLowerCase()
  if (platform === 'win') return lower === `teahouse-${version.toLowerCase()}-win-${arch}-setup.exe`
  if (platform === 'linux') {
    const debArch = arch === 'x64' ? 'amd64' : 'arm64'
    return lower === `teahouse-${version.toLowerCase()}-linux-${debArch}.deb`
  }
  return false
}

export class UpdateRequestGate {
  private sequence = 0
  private pending: (PendingUpdateRequest & { token: number; expiresAt: number }) | null = null

  constructor(private readonly ttlMs = 120_000) {}

  begin(request: PendingUpdateRequest, now = Date.now()): number {
    const token = ++this.sequence
    this.pending = { ...request, token, expiresAt: now + this.ttlMs }
    return token
  }

  cancel(token: number): void {
    if (this.pending?.token === token) this.pending = null
  }

  consume(peerId: string, name: string, size: number, now = Date.now()): boolean {
    const pending = this.pending
    if (!pending || now > pending.expiresAt) {
      this.pending = null
      return false
    }
    if (peerId !== pending.nodeId || size <= 0 || size > UPDATE_PACKAGE_MAX_BYTES) return false
    if (!matchesUpdatePackageName(name, pending.version, pending.platform, pending.arch)) return false
    this.pending = null
    return true
  }
}
```

`UpdateRequestGate` 保存 `{ token, request, expiresAt }`；`begin` 递增 token；`cancel` 只取消同 token；`consume` 先检查时间、peer、大小和 `matchesUpdatePackageName`，成功后清空 pending。`findLocalUpdatePackage` 也复用该 helper，防止落盘污染包靠模糊文件名成为更新源。

- [ ] **Step 5: 写 FilesService 未授权 offer RED 测试**

扩展测试构造器注入 `authorizeUpdateOffer: vi.fn(() => false)`，投递合法 update offer 后断言：transferRepo 无记录、发送 decline、更新目录无文件。再写返回 true 的控制用例，保留现有自动 accept 行为。

Run: `npx vitest run src/main/services/files.test.ts`

Expected: FAIL；未授权 offer 仍插 transfer 并调用 accept。

- [ ] **Step 6: 在 FilesService 最靠近落盘处消费授权**

`FilesDeps` 增加回调；`onUpdateOffer` 在 insert 前检查：

```typescript
const validShape =
  !asm.groupId && asm.fileCount === 1 && plans.length === 1 && !!plan && !plan.isDir &&
  !plan.relPath.includes('/') && plan.relPath === asm.rootName && trustedTotalSize > 0 &&
  trustedTotalSize <= UPDATE_PACKAGE_MAX_BYTES
const authorized = validShape && this.deps.authorizeUpdateOffer?.(peerId, asm.rootName, trustedTotalSize) === true
if (!authorized) {
  void this.declineUnknown(peerId, offer.transferId)
  return
}
```

- [ ] **Step 7: 在 main 记录与撤销请求**

创建单例 `const updateRequestGate = new UpdateRequestGate()`。`requestUpdatePackage` 在 sendReliable 前 `begin`，发送失败 `cancel(token)`；构造 `FilesService` 时注入：

```typescript
authorizeUpdateOffer: (peerId, name, totalSize) =>
  updateRequestGate.consume(peerId, name, totalSize)
```

- [ ] **Step 8: 运行更新专项 GREEN**

Run:

```bash
npx vitest run src/main/net/codec.test.ts src/main/services/updater.test.ts src/main/services/files.test.ts
npm run typecheck:node
```

Expected: 三个测试文件与 Node 类型检查全部通过。

---

### Task 4: package / lock / tag / artifact 版本门禁

**Files:**
- Create: `scripts/check-version-consistency.mjs`
- Create: `scripts/check-version-consistency.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Produces: `checkVersionConsistency({ rootDir, tagName?, artifactsDir? }): { version: string }`。
- Produces: `npm run check:version`。

- [ ] **Step 1: 写脚本 RED 测试**

使用 `mkdtempSync` 创建 fixture，分别写 package/lock：一致返回版本；lock 根版本漂移抛错；tag 漂移抛错；artifacts 中 `Teahouse-0.32.24-*` 与 package `0.32.25` 时抛错。

Run: `npx vitest run scripts/check-version-consistency.test.mjs`

Expected: FAIL；检查脚本尚不存在。

- [ ] **Step 2: 实现无依赖 ESM 检查脚本**

脚本使用 `readFileSync`、`readdirSync(dir, { withFileTypes: true })` 和手写递归目录遍历兼容 Node 16；不得使用 Node 18 才新增的 API。核心检查：

```javascript
if (pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) {
  throw new Error(`版本不一致：package=${pkg.version} lock=${lock.version} lockRoot=${lock.packages?.['']?.version}`)
}
if (tagName && tagName !== `v${pkg.version}`) {
  throw new Error(`tag 与 package 版本不一致：tag=${tagName} package=${pkg.version}`)
}
for (const name of artifactNames) {
  if (name.startsWith('Teahouse-') && !name.startsWith(`Teahouse-${pkg.version}-`)) {
    throw new Error(`产物版本不一致：${name}`)
  }
}
```

CLI 默认读取 `process.cwd()`；tag 取 `GITHUB_REF_TYPE === 'tag'` 时的 `GITHUB_REF_NAME`；支持 `--artifacts <dir>`。

- [ ] **Step 3: 接入 npm 与 CI**

`package.json` 新增：

```json
"check:version": "node scripts/check-version-consistency.mjs"
```

四个平台 job 均在 checkout 后、`npm ci` 前运行 `node scripts/check-version-consistency.mjs`。release job 下载 artifacts 后运行：

```bash
node scripts/check-version-consistency.mjs --artifacts artifacts
```

- [ ] **Step 4: 先证明当前漂移，再同步 lock 到当前版本并运行 GREEN**

Run:

```bash
npx vitest run scripts/check-version-consistency.test.mjs
npm run check:version
```

Expected: 专项测试通过；首次 `npm run check:version` 以非零退出并明确报告 package `0.32.24` / lock `0.31.3` 漂移。随后用 `apply_patch` 把 lock 顶层与 `packages[""]` 临时同步到当前 `0.32.24`，重跑 `npm run check:version`，Expected: 退出 0。Task 9 再把 package 与 lock 一起升到 `0.32.25`。

---

### Task 5: TransferServer 并发槽、连接上限与超时

**Files:**
- Modify: `src/main/net/transfer.ts`
- Modify: `src/main/net/transfer.test.ts`

**Interfaces:**
- Produces: `TransferServerLimits`，默认 `maxConcurrentStreams=3`、`maxConnections=256`、`handshakeTimeoutMs=15_000`、`idleTimeoutMs=60_000`。
- Preserves: 现有构造参数顺序；limits 作为第五个可选参数。

- [ ] **Step 1: 写并发与超时 RED 测试**

给测试 helper 增加 limits 参数。用四条真实回环 socket 和可控 `Readable` 发四个合法 pull，断言前三个触发 `openReadStream`，第四个等待；结束第一个流后第四个启动。另以 `handshakeTimeoutMs: 30` 打开不发帧连接，断言连接自动 close；以 `maxConnections: 1` 断言第二条连接被关闭。

Run: `npx vitest run src/main/net/transfer.test.ts`

Expected: FAIL；当前四个读流同时启动，空连接保持，连接数无限制。

- [ ] **Step 2: 添加 class 级 FIFO 调度器**

```typescript
export interface TransferServerLimits {
  maxConcurrentStreams?: number
  maxConnections?: number
  handshakeTimeoutMs?: number
  idleTimeoutMs?: number
}

interface PendingPull {
  socket: Socket
  start: () => void
}
```

`TransferServer` 持有 `activeStreamSlots` 与 `pendingPulls`。`enqueuePull` 在有槽时立即启动，否则 FIFO 入队并暂停该 socket 的超时；`releaseStreamSlot` 只释放一次并跳过已销毁 socket；`removePendingPulls` 在 close 时移除该 socket 的任务。

- [ ] **Step 3: 把单连接供流接到调度器**

收到合法 pull 后立即设 `busy=true`，排队 start closure；closure 再 resolve file，成功后启动读流并设 60s timeout。`done` 写出、读流 error 或 socket close 都通过幂等 `releaseHeldSlot()` 释放槽。排队期间 `socket.setTimeout(0)`，只有已经通过 lookup 的合法 pull 可进入等待队列。

- [ ] **Step 4: 添加连接预算与握手超时**

createServer 回调先检查 sockets.size；达到 256 时销毁新连接。serve 初始 `socket.setTimeout(handshakeTimeoutMs, () => socket.destroy())`；首个合法 frame 后切换到 idle timeout，排队 pull 例外按 Step 3 暂停。

- [ ] **Step 5: 运行 GREEN 与既有背压回归**

Run: `npx vitest run src/main/net/transfer.test.ts`

Expected: 并发、握手、连接上限、断点续传、多文件背压和确定性死锁用例全部通过。

---

### Task 6: chat store 导航代次

**Files:**
- Modify: `src/renderer/src/stores/chat.ts`
- Modify: `src/renderer/src/stores/chat.test.ts`

**Interfaces:**
- Produces: module-level `navigationRun`；`openPeer` 可接收内部 run 参数供 `openConv` 复用。
- Preserves: 所有现有公开调用方式与滚动模式。

- [ ] **Step 1: 写延迟 Promise RED 测试**

在测试中增加：

```typescript
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
```

构造 A、B 两个 `openConversation` deferred：先调用 A，再调用 B；先完成 B 的 conversation/page，再完成 A；最终断言 `activeConvId === 'single:b'`、滚动代次只由 B 推进。另覆盖旧搜索 context 和旧 backToLatest 结果被丢弃。

Run: `npx vitest run src/renderer/src/stores/chat.test.ts`

Expected: FAIL；A 的迟到响应覆盖 B 或触发错误滚动。

- [ ] **Step 2: 给四种导航统一分配 run**

模块顶层增加 `let navigationRun = 0`。`openPeer(peer, options, run = ++navigationRun)` 在每个 await 后检查；`openConv` 先 `const run = ++navigationRun`，单聊把同一 run 传给 `openPeer`；`jumpToMessage`、`backToLatest` 各自抢新 run，并在 await 后检查 `run === navigationRun`。`backToLatest` 还必须检查捕获的 convId 仍等于 activeConvId。

- [ ] **Step 3: 运行 GREEN**

Run: `npx vitest run src/renderer/src/stores/chat.test.ts`

Expected: 既有消息缓存/滚动测试和三条新竞态测试全部通过。

---

### Task 7: 截图操作栏视口定位

**Files:**
- Create: `src/renderer/src/utils/capture-toolbar.ts`
- Create: `src/renderer/src/utils/capture-toolbar.test.ts`
- Modify: `src/renderer/src/CaptureApp.vue`

**Interfaces:**
- Produces: `computeCaptureToolbarPosition(selection, viewport, toolbar, margin=8, gap=8): { left: number; top: number }`。

- [ ] **Step 1: 写纯函数 RED 测试**

覆盖普通下置、贴底翻到上方、贴右夹住、小视口上下都放不下四种输入。所有结果必须满足 `left >= 8`、`top >= 8`，尺寸小于视口时右/下边缘不超过 `viewport - 8`。

Run: `npx vitest run src/renderer/src/utils/capture-toolbar.test.ts`

Expected: FAIL；工具函数尚不存在。

- [ ] **Step 2: 实现定位纯函数**

```typescript
export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface CaptureSize { width: number; height: number }
export interface CapturePoint { left: number; top: number }

export function computeCaptureToolbarPosition(
  selection: CaptureRect,
  viewport: CaptureSize,
  toolbar: CaptureSize,
  margin = 8,
  gap = 8
): CapturePoint {
  const maxLeft = Math.max(margin, viewport.width - toolbar.width - margin)
  const preferredLeft = Math.min(selection.x, selection.x + selection.width - toolbar.width)
  const left = Math.min(maxLeft, Math.max(margin, preferredLeft))
  const below = selection.y + selection.height + gap
  const above = selection.y - gap - toolbar.height
  const maxTop = Math.max(margin, viewport.height - toolbar.height - margin)
  const top = below + toolbar.height <= viewport.height - margin
    ? below
    : above >= margin
      ? above
      : Math.min(maxTop, Math.max(margin, below))
  return { left, top }
}
```

- [ ] **Step 3: 接入 CaptureApp 实测尺寸**

导入 `computed`、`nextTick` 和纯函数；增加 `barEl`、默认 `{width:560,height:40}`、viewport ref。鼠标抬起后 nextTick 读取 `getBoundingClientRect()`；window resize 更新 viewport 并在卸载时移除 listener。模板 `.bar` 增加 `ref="barEl"`，style 改用 computed `left/top`。

- [ ] **Step 4: 运行 GREEN 与 web 类型检查**

Run:

```bash
npx vitest run src/renderer/src/utils/capture-toolbar.test.ts
npm run typecheck:web
```

Expected: 定位测试和 renderer 类型检查通过。

---

### Task 8: 截图窗口 will-navigate 安全基线

**Files:**
- Create: `src/main/windows/capture-window.test.ts`
- Modify: `src/main/windows/capture-window.ts`

**Interfaces:**
- Preserves: `openCaptureWindow` / `closeCaptureWindow` API。
- Produces: capture webContents 同时注册 window-open deny 与 will-navigate preventDefault。

- [ ] **Step 1: 写 Electron mock RED 测试**

mock `app.isPackaged=true` 和 BrowserWindow；fake webContents 保存 `setWindowOpenHandler` 与 `on` 注册的回调。调用 `openCaptureWindow` 后断言两个安全 handler 存在，调用 will-navigate listener 后 `preventDefault` 被调用。

Run: `npx vitest run src/main/windows/capture-window.test.ts`

Expected: FAIL；will-navigate listener 不存在。

- [ ] **Step 2: 加一行生产修复**

在 `setWindowOpenHandler` 后加入：

```typescript
win.webContents.on('will-navigate', (event) => event.preventDefault())
```

- [ ] **Step 3: 运行 GREEN**

Run: `npx vitest run src/main/windows/capture-window.test.ts`

Expected: 安全 handler 测试通过。

---

### Task 9: 统一版本、全量验证、最终差异审查与单一提交

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Add all files from Tasks 1-8

**Interfaces:**
- Produces: repository version `0.32.25` everywhere。
- Produces: one implementation commit `fix: 修复优先级安全与稳定性问题（决议 #208）`。

- [ ] **Step 1: 同步版本**

使用 `apply_patch` 把 `package.json.version`、`package-lock.json.version`、`package-lock.json.packages[""].version` 同步改成 `0.32.25`，不运行 `npm update`。

- [ ] **Step 2: 先跑全部专项测试**

Run:

```bash
npx vitest run \
  src/main/net/frame.test.ts \
  src/main/net/transfer.test.ts \
  src/main/net/codec.test.ts \
  src/main/services/updater.test.ts \
  src/main/services/files.test.ts \
  scripts/check-version-consistency.test.mjs \
  src/renderer/src/stores/chat.test.ts \
  src/renderer/src/utils/capture-toolbar.test.ts \
  src/main/windows/capture-window.test.ts
npm run check:version
```

Expected: 九个专项测试文件全部通过，版本检查输出 `0.32.25` 并退出 0。

- [ ] **Step 3: 跑仓库五连验证**

Run:

```bash
npm test
npm run test:db
npm run typecheck
npm run build
npm run smoke
```

Expected: 所有命令退出 0；DB 自测在 Electron Node 16.17 / ABI 110 下 PASS；smoke 干净退出。

- [ ] **Step 4: 安全闭环与绕过复核**

Run:

```bash
git diff --check
rg -n '"electron": "22\.3\.27"|"electronVersion": "22\.3\.27"' package.json
rg -n "target: 'node16'|target: 'chrome108'" electron.vite.config.ts
git diff --stat
git status --short
```

人工逐条确认：对象型 finish 到不了 FilesService；无 pending update 不落 transfer；超过 512 MiB 在 codec 拒绝；第四个流等待；旧导航响应不写状态；截图工具栏不越界；capture will-navigate 生效；没有无关文件。

- [ ] **Step 5: 创建用户要求的单一代码提交**

```bash
git add .github/workflows/release.yml package.json package-lock.json scripts \
  docs/requirements.md docs/protocol.md docs/tech-design.md docs/ui-design.md \
  src/main src/renderer/src src/shared \
  docs/superpowers/plans/2026-07-10-priority-fixes.md
git commit -m "fix: 修复优先级安全与稳定性问题（决议 #208）"
```

Expected: 一个实现提交包含七项修复、独立测试、决议与 v0.32.25；先前规格提交 `68ce7e2` 保持独立。
