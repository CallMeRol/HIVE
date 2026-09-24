# 第二批渲染性能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将四类 renderer 窗口按需拆包，把 OCR renderer 缓存收敛为有界 LRU，并用 manifest 门禁阻止拆包回退。

**Architecture:** 保留单 HTML 与现有 hash URL，新增纯入口解析器并用动态 `import()` 加载唯一根组件。OCR 使用通用的有界 LRU 和失败可重试异步值；Vite manifest 由无依赖 Node 脚本校验动态入口、独立文件和公共启动闭包预算。

**Tech Stack:** Electron 22.3.27、Node 16.17、Chrome 108、Vue 3、Pinia、Vite 5、Vitest 2、TypeScript strict、Node ESM 脚本。

## Global Constraints

- `electron` 必须精确保持 `22.3.27`，不新增或升级依赖，不运行 `npm update`。
- main / preload 构建目标保持 `node16`，renderer 保持 `chrome108`。
- renderer 不 import Electron / Node 运行时模块，全部能力继续经 `window.pantry`。
- 继续使用单一 `index.html`、本地 hash 与本地静态资源，不新增远程请求。
- OCR 模型、wasm 路径、识别参数和主进程 128 项缓存容量保持原样。
- 实现批次只创建一个 `perf:` 提交；每项在提交前独立执行 RED → GREEN。
- 版本最终统一从 `0.33.0` 升到 `0.33.1`，package 与 lockfile 三处版本必须一致。

---

### Task 1: 决议 #210 与技术边界先行落档

**Files:**
- Modify: `docs/requirements.md`
- Modify: `docs/tech-design.md`
- Modify: `docs/handoff.md`

**Interfaces:**
- Consumes: 已批准规格 `docs/superpowers/specs/2026-07-10-renderer-performance-batch-design.md`。
- Produces: 决议 #210、tech-design v1.10、handoff v0.33.1 批次说明，供后续代码遵循。

- [ ] **Step 1: 在 requirements 决议表追加 #210**

追加完整决议：

```markdown
| 210 | 用户确认继续第二批优化，优先收敛渲染启动成本与 OCR 内存边界 | 保留单 HTML / hash 路由，四个根组件改为动态入口；renderer OCR 结果缓存限制 16 项 LRU，OCR 引擎初始化失败允许重试；启用 Vite manifest 并在 build 后校验四个动态入口、独立文件与 200 KiB 公共启动闭包。消息虚拟列表继续暂缓。版本 0.33.0 → **0.33.1**（性能优化，patch +1）。 |
```

requirements 变更记录追加 v1.89，明确协议与用户交互不变。

- [ ] **Step 2: 更新 tech-design 与 handoff**

tech-design 说明：

```markdown
- renderer 单 HTML 入口只静态加载 Vue / Pinia / tokens / 路由解析器，App、SettingsApp、CaptureApp、ImageViewerApp 均走动态 import；build manifest 门禁锁定四个动态 entry 与 200 KiB 公共启动闭包。
- OCR renderer 使用 16 项 LRU，主进程仍保留 128 项 LRU；PaddleOcrService 初始化 Promise 失败后清空，允许下一次重试。
```

handoff 当前版本先描述目标 v0.33.1 与决议 #210，最终验证数据在 Task 5 回填。

- [ ] **Step 3: 校验文档差异**

Run:

```bash
git diff --check -- docs/requirements.md docs/tech-design.md docs/handoff.md
rg -n "决议 #210|\| 210 \||v1\.89|v1\.10" docs/requirements.md docs/tech-design.md docs/handoff.md
```

Expected: diff check 退出 0，四个关键标记均可定位。

---

### Task 2: OCR 有界 LRU 与失败可重试异步值

**Files:**
- Create: `src/renderer/src/utils/bounded-cache.ts`
- Create: `src/renderer/src/utils/bounded-cache.test.ts`
- Modify: `src/renderer/src/utils/ocr.ts`
- Test: `src/renderer/src/utils/ocr.test.ts`

**Interfaces:**
- Consumes: 原有 `OcrResult`、`createService()` 与 `recognizeImageText()`。
- Produces: `BoundedLruCache<K, V>`、`RetryableAsyncValue<T>`；OCR 结果容量 16，服务初始化失败可重试。

- [ ] **Step 1: 写缓存工具失败测试**

创建测试，至少包含：

```ts
import { describe, expect, it, vi } from 'vitest'
import { BoundedLruCache, RetryableAsyncValue } from './bounded-cache'

describe('BoundedLruCache', () => {
  it('超出容量时淘汰最久未访问项', () => {
    const cache = new BoundedLruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    cache.set('c', 3)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(1)
    expect(cache.get('c')).toBe(3)
    expect(cache.size).toBe(2)
  })

  it('覆盖已有项后把它提升为最新', () => {
    const cache = new BoundedLruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 10)
    cache.set('c', 3)
    expect(cache.get('a')).toBe(10)
    expect(cache.get('b')).toBeUndefined()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('拒绝非法容量 %s', (capacity) => {
    expect(() => new BoundedLruCache(capacity)).toThrow('缓存容量必须为正安全整数')
  })
})

describe('RetryableAsyncValue', () => {
  it('并发调用共享一次初始化，成功后继续复用', async () => {
    const value = new RetryableAsyncValue<number>()
    const factory = vi.fn(async () => 42)
    await expect(Promise.all([value.get(factory), value.get(factory)])).resolves.toEqual([42, 42])
    await expect(value.get(factory)).resolves.toBe(42)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('失败后清除 Promise，下一次重新初始化', async () => {
    const value = new RetryableAsyncValue<number>()
    const factory = vi.fn()
      .mockRejectedValueOnce(new Error('broken'))
      .mockResolvedValueOnce(7)
    await expect(value.get(factory)).rejects.toThrow('broken')
    await expect(value.get(factory)).resolves.toBe(7)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run src/renderer/src/utils/bounded-cache.test.ts
```

Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现缓存工具**

创建：

```ts
export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, V>()

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('缓存容量必须为正安全整数')
    }
  }

  get size(): number {
    return this.entries.size
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as K | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}

export class RetryableAsyncValue<T> {
  private pending: Promise<T> | null = null

  get(factory: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending
    const attempt = factory()
    const guarded = attempt.catch((error: unknown) => {
      this.pending = null
      throw error
    })
    this.pending = guarded
    return guarded
  }
}
```

- [ ] **Step 4: 接入 OCR**

在 `ocr.ts`：

```ts
import { BoundedLruCache, RetryableAsyncValue } from './bounded-cache'

const resultCache = new BoundedLruCache<string, OcrResult>(16)
const serviceCache = new RetryableAsyncValue<PaddleOcrService>()

export function getCachedOcrResult(cacheKey: string): OcrResult | null {
  return resultCache.get(cacheKey) ?? null
}

async function getService(): Promise<PaddleOcrService> {
  return serviceCache.get(createService)
}
```

删除原 `Map` 与 `servicePromise`。`recognizeImageText` 的缓存命中和 `resultCache.set` 调用签名保持。

- [ ] **Step 5: 运行专项测试确认 GREEN**

Run:

```bash
npx vitest run src/renderer/src/utils/bounded-cache.test.ts src/renderer/src/utils/ocr.test.ts
npm run typecheck:web
```

Expected: 两个测试文件通过，renderer 类型检查退出 0。

---

### Task 3: 四窗口动态根组件入口

**Files:**
- Create: `src/renderer/src/renderer-entry.ts`
- Create: `src/renderer/src/renderer-entry.test.ts`
- Modify: `src/renderer/src/main.ts`

**Interfaces:**
- Consumes: 四个现有 Vue 根组件和现有 hash。
- Produces: `RendererEntry`、`resolveRendererEntry(hash)`、`loadRendererRoot(entry)`；main.ts 只加载一个根组件。

- [ ] **Step 1: 写入口解析失败测试**

创建：

```ts
import { describe, expect, it } from 'vitest'
import { resolveRendererEntry } from './renderer-entry'

describe('resolveRendererEntry', () => {
  it.each([
    ['', 'main'],
    ['#/chat', 'main'],
    ['#/settings', 'settings'],
    ['#/capture', 'capture'],
    ['#/image-viewer', 'image-viewer'],
    ['#/image-viewer?transferId=t1', 'image-viewer']
  ] as const)('%s → %s', (hash, expected) => {
    expect(resolveRendererEntry(hash)).toBe(expected)
  })
})
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run src/renderer/src/renderer-entry.test.ts
```

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现入口解析与动态 loader**

创建：

```ts
import type { Component } from 'vue'

export type RendererEntry = 'main' | 'settings' | 'capture' | 'image-viewer'

export function resolveRendererEntry(hash: string): RendererEntry {
  if (hash.startsWith('#/settings')) return 'settings'
  if (hash.startsWith('#/capture')) return 'capture'
  if (hash.startsWith('#/image-viewer')) return 'image-viewer'
  return 'main'
}

export async function loadRendererRoot(entry: RendererEntry): Promise<Component> {
  switch (entry) {
    case 'settings':
      return (await import('./SettingsApp.vue')).default
    case 'capture':
      return (await import('./CaptureApp.vue')).default
    case 'image-viewer':
      return (await import('./ImageViewerApp.vue')).default
    default:
      return (await import('./App.vue')).default
  }
}
```

- [ ] **Step 4: 精简 main.ts**

改为：

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { loadRendererRoot, resolveRendererEntry } from './renderer-entry'
import './styles/tokens.css'

async function bootstrap(): Promise<void> {
  const root = await loadRendererRoot(resolveRendererEntry(location.hash))
  createApp(root).use(createPinia()).mount('#app')
}

void bootstrap().catch(() => {
  console.error('[renderer] 窗口入口加载失败')
})
```

- [ ] **Step 5: 运行专项测试确认 GREEN**

Run:

```bash
npx vitest run src/renderer/src/renderer-entry.test.ts
npm run typecheck:web
```

Expected: 入口测试与 renderer 类型检查通过。

---

### Task 4: Manifest 拆包检查器与 build 门禁

**Files:**
- Create: `scripts/check-renderer-bundles.mjs`
- Create: `scripts/check-renderer-bundles.test.mjs`
- Modify: `electron.vite.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `out/renderer/.vite/manifest.json` 与 manifest 引用的 JS 文件。
- Produces: `checkRendererBundles({ outDir, maxBootstrapBytes }) -> { errors, bootstrapBytes }`；npm script `check:renderer-bundles`。

- [ ] **Step 1: 写 checker fixture 失败测试**

测试用 `mkdtempSync` 构造 manifest 和空 JS，覆盖：

```js
const validManifest = {
  'src/renderer/index.html': {
    file: 'assets/index.js',
    src: 'src/renderer/index.html',
    isEntry: true,
    imports: ['_vendor.js'],
    dynamicImports: [
      'src/renderer/src/App.vue',
      'src/renderer/src/SettingsApp.vue',
      'src/renderer/src/CaptureApp.vue',
      'src/renderer/src/ImageViewerApp.vue'
    ]
  },
  '_vendor.js': { file: 'assets/vendor.js' },
  'src/renderer/src/App.vue': { file: 'assets/App.js', src: 'src/renderer/src/App.vue', isDynamicEntry: true },
  'src/renderer/src/SettingsApp.vue': { file: 'assets/SettingsApp.js', src: 'src/renderer/src/SettingsApp.vue', isDynamicEntry: true },
  'src/renderer/src/CaptureApp.vue': { file: 'assets/CaptureApp.js', src: 'src/renderer/src/CaptureApp.vue', isDynamicEntry: true },
  'src/renderer/src/ImageViewerApp.vue': { file: 'assets/ImageViewerApp.js', src: 'src/renderer/src/ImageViewerApp.vue', isDynamicEntry: true }
}
```

断言：合法 fixture `errors=[]`；删除 Capture entry 报缺失；让两个 root 共用同一 file 报重复；从启动 entry 的 `dynamicImports` 删除 App key 报不可达；把 entry + vendor 写到超过预算时报超限；删除 vendor.js 报引用文件缺失；删除 manifest 文件时报读取失败。

- [ ] **Step 2: 运行测试确认 RED**

Run:

```bash
npx vitest run scripts/check-renderer-bundles.test.mjs
```

Expected: FAIL，checker 模块不存在。

- [ ] **Step 3: 实现 checker**

实现以下结构，所有错误聚合为中文数组：

```js
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_ROOTS = ['App.vue', 'SettingsApp.vue', 'CaptureApp.vue', 'ImageViewerApp.vue']

export function checkRendererBundles({ outDir = resolve('out/renderer'), maxBootstrapBytes = 204800 } = {}) {
  const errors = []
  let manifest
  try {
    manifest = JSON.parse(readFileSync(resolve(outDir, '.vite/manifest.json'), 'utf8'))
  } catch (error) {
    return { errors: [`无法读取 renderer manifest：${error instanceof Error ? error.message : String(error)}`], bootstrapBytes: 0 }
  }

  const records = Object.entries(manifest)
  const entries = records.filter(([, item]) => item && item.isEntry === true)
  if (entries.length !== 1) errors.push(`renderer 启动 entry 数量应为 1，实际 ${entries.length}`)

  const rootFiles = []
  const rootKeys = []
  for (const root of REQUIRED_ROOTS) {
    const matches = records.filter(([key, item]) => {
      const source = typeof item?.src === 'string' ? item.src : key
      return source === root || source.endsWith(`/${root}`)
    })
    if (matches.length !== 1 || matches[0][1]?.isDynamicEntry !== true) {
      errors.push(`${root} 未形成唯一动态 entry`)
      continue
    }
    const file = matches[0][1].file
    if (typeof file !== 'string') errors.push(`${root} 缺少产物文件`)
    else {
      rootFiles.push(file)
      rootKeys.push(matches[0][0])
    }
  }
  if (new Set(rootFiles).size !== rootFiles.length) errors.push('四个 renderer 根组件必须使用不同 JS 文件')

  if (entries.length === 1) {
    const reachable = new Set(entries[0][1].dynamicImports ?? [])
    for (const key of rootKeys) {
      if (!reachable.has(key)) errors.push(`动态入口未由启动 entry 引用：${key}`)
    }
  }

  let bootstrapBytes = 0
  if (entries.length === 1) {
    const visited = new Set()
    const visit = (key) => {
      if (visited.has(key)) return
      visited.add(key)
      const item = manifest[key]
      if (!item || typeof item.file !== 'string') {
        errors.push(`manifest 静态依赖缺失：${key}`)
        return
      }
      try {
        bootstrapBytes += statSync(resolve(outDir, item.file)).size
      } catch {
        errors.push(`renderer 产物文件不存在：${item.file}`)
      }
      for (const imported of item.imports ?? []) visit(imported)
    }
    visit(entries[0][0])
  }
  if (bootstrapBytes > maxBootstrapBytes) {
    errors.push(`renderer 公共启动 JS ${bootstrapBytes} B 超过预算 ${maxBootstrapBytes} B`)
  }
  return { errors, bootstrapBytes }
}
```

补 CLI main guard：默认检查 `out/renderer`，打印通过体积；有 errors 时逐条 `console.error` 并设置 `process.exitCode=1`。

- [ ] **Step 4: 接入 manifest 与 npm build**

`electron.vite.config.ts`：

```ts
renderer: {
  build: { target: 'chrome108', manifest: true, minify: 'esbuild' },
  // plugins 保持
}
```

`package.json` scripts：

```json
"build": "node scripts/prepare-ocr-assets.mjs && electron-vite build && npm run check:renderer-bundles",
"check:renderer-bundles": "node scripts/check-renderer-bundles.mjs"
```

- [ ] **Step 5: 运行专项测试与真实构建确认 GREEN**

Run:

```bash
npx vitest run scripts/check-renderer-bundles.test.mjs
npm run build
npm run check:renderer-bundles
```

Expected: fixture 测试通过；真实 build 输出四个根组件动态 chunk；checker 输出公共启动 JS 字节数且小于等于 204800。

---

### Task 5: 版本、全量验证与单批次提交

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/requirements.md`
- Modify: `docs/tech-design.md`
- Modify: `docs/handoff.md`
- Add: 本计划文件（强制加入，因 `docs/` 被 `.gitignore` 忽略）

**Interfaces:**
- Consumes: Tasks 1–4 全部实现与测试。
- Produces: v0.33.1 一致版本、验收记录、一个实现提交。

- [ ] **Step 1: 同步版本到 0.33.1**

用 `apply_patch` 修改：

```json
package.json.version = "0.33.1"
package-lock.json.version = "0.33.1"
package-lock.json.packages[""].version = "0.33.1"
```

不得运行 `npm update`。

- [ ] **Step 2: 回填文档验收数据**

handoff 写入真实专项测试数量、公共启动闭包字节数、`npm test` 数量与五连结果。requirements / tech-design 的 #210 版本记录保持 0.33.1。

- [ ] **Step 3: 运行专项全集**

Run:

```bash
npx vitest run \
  src/renderer/src/utils/bounded-cache.test.ts \
  src/renderer/src/utils/ocr.test.ts \
  src/renderer/src/renderer-entry.test.ts \
  scripts/check-renderer-bundles.test.mjs
npm run check:version
npm run check:renderer-bundles
```

Expected: 四个测试文件全过；两个门禁输出 0.33.1 和公共启动闭包体积。

- [ ] **Step 4: 运行项目五连验证**

Run:

```bash
npm test
npm run test:db
npm run typecheck
npm run build
npm run smoke
```

Expected: 全部退出 0；数据库自测显示 Electron Node 16.17.1 / ABI 110；smoke 干净退出。

- [ ] **Step 5: 最终差异审查**

Run:

```bash
git diff --check
npm run check:version
git status --short
git diff --stat
rg -n '"electron": "22\.3\.27"|target: .node16.|target: .chrome108.' package.json electron.vite.config.ts
rg -n "https?://" out/renderer --glob '*.js' --glob '*.html'
```

Expected: 无空白错误；Electron 与构建目标未漂移；renderer 产物没有项目新增的远程资源加载。第三方 bundle 中的协议字符串若出现，只确认没有被应用代码调用。

- [ ] **Step 6: 创建一个实现提交**

```bash
git add -A
git add -f docs/superpowers/plans/2026-07-10-renderer-performance-batch.md
git diff --cached --check
git commit -m "perf: 完成第二批渲染性能优化（决议 #210）"
git status --short
```

Expected: 一个实现提交包含动态入口、缓存工具、manifest 门禁、测试、文档与 v0.33.1；工作树干净。
