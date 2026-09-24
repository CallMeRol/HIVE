# 第二批渲染性能优化设计

| 项 | 内容 |
|---|---|
| 日期 | 2026-07-10 |
| 基线 | main @ `609d199` / v0.33.0 |
| 目标版本 | v0.33.1 |
| 交付方式 | 一个批次实现提交；三项分别执行红绿测试，最终跑五连验证 |

## 1. 目标与范围

第二批聚焦渲染进程启动成本与 OCR 内存边界，处理三项相互关联的优化：

1. 主窗、设置窗、截图窗、图片查看窗目前由 `main.ts` 静态导入，任一窗口启动都会解析全部根组件；
2. renderer OCR 结果缓存使用无上限 `Map`，同一图片查看进程连续打开大量图片时会持续保留识别结果；
3. 构建链缺少自动检查，后续静态 import 回流时无法及时发现窗口拆包失效。

本批明确暂缓：

- 消息列表虚拟滚动：当前活动消息已在贴底场景裁剪到 300 条，缺少继续引入虚拟滚动复杂度的真实性能证据；
- 全库可访问性、日志体系、巨型文件拆分与存量文档清理：这些属于第三批质量治理，避免与构建拓扑改动混在同一增量；
- OCR 模型、阈值、识别流程和主进程缓存容量：现有模型服务与 128 项主进程 LRU 保持原样。

## 2. 方案选择

采用“单 HTML + hash 路由 + 动态根组件”的方案。

曾评估的替代路径：

- 多 HTML 入口：隔离最彻底，但会同时改动 `loadFile` / 开发 URL / CSP / 窗口工厂，回归面过大；
- Rollup `manualChunks`：可以改变产物文件分布，静态 import 仍会让窗口启动时加载全部根组件，无法解决当前问题；
- 动态根组件：保留现有 URL、hash、preload 与窗口安全配置，只调整渲染启动模块，风险与收益最匹配。

## 3. 渲染入口按窗口动态加载

### 3.1 路由边界

新增轻量入口解析模块，提供两个职责清晰的接口：

- `resolveRendererEntry(hash)`：纯函数，把 hash 映射为 `main | settings | capture | image-viewer`；未知 hash 回退 `main`；
- `loadRendererRoot(entry)`：按 entry 执行对应 Vue 根组件的动态 `import()`。

`main.ts` 只静态导入 Vue、Pinia、tokens 与入口解析模块，随后异步加载一个根组件并挂载。四个现有 hash 保持：

- 主窗：默认 / 其他 hash；
- 设置窗：`#/settings`；
- 截图窗：`#/capture`；
- 图片查看窗：`#/image-viewer`，查询参数继续跟在 hash 后。

### 3.2 兼容与错误边界

- `contextIsolation`、`sandbox`、`nodeIntegration`、CSP、preload 和窗口导航拦截均不改；
- 继续使用同一份 `index.html` 与本地 `file://` 产物，不新增网络请求；
- 动态 chunk 加载失败时停止挂载并记录固定错误摘要，日志不得包含 URL 查询参数或本地路径；
- build 门禁确保正式产物中的四个动态入口完整存在，降低运行时缺 chunk 的概率。

## 4. OCR renderer 缓存收敛

### 4.1 有界 LRU

新增零依赖缓存工具 `BoundedLruCache<K, V>`：

- 容量必须为正安全整数；
- `get` 命中后把条目提升为最新；
- `set` 覆盖时更新新旧顺序；
- 超出容量时淘汰最久未访问项；
- 提供只读 `size`，测试不依赖内部 `Map`。

`ocr.ts` 的 renderer 结果缓存改用容量 **16** 的 LRU。16 项足以覆盖同一看图会话的近期图片，同时把极端 OCR 结果驻留内存限制在固定数量。renderer 淘汰后仍会通过现有 IPC 命中主进程 128 项缓存，无需重新识别。

### 4.2 可重试异步单例

新增 `RetryableAsyncValue<T>`：

- 并发调用共享同一次进行中的 Promise；
- 成功后继续复用结果；
- 初始化失败后清除失败 Promise，下一次用户重试会重新创建；
- 失败继续向调用方抛出，由现有 OCR UI 显示“识别失败”。

`PaddleOcrService` 的初始化改由该工具管理，模型、wasm 路径、单线程设置和识别参数保持原样。

## 5. 构建拆包回归门禁

### 5.1 Manifest

renderer 生产构建启用 Vite manifest 并显式使用 esbuild 压缩，正式路径固定为：

`out/renderer/.vite/manifest.json`

新增无依赖 Node 脚本 `scripts/check-renderer-bundles.mjs`，读取 manifest 与实际 JS 文件，执行：

1. 找到唯一 renderer 启动 entry；
2. 确认 `App.vue`、`SettingsApp.vue`、`CaptureApp.vue`、`ImageViewerApp.vue` 均为动态 entry；
3. 确认四个根组件对应四个不同 JS 文件；
4. 递归统计启动 entry 的静态 JS 依赖闭包，限制为 **204800 字节（200 KiB）**；
5. manifest 引用的文件缺失、结构错误或预算超限时输出中文错误并非零退出。

预算只计算启动 entry 与其静态 `imports`，不把用户实际选择的根组件动态 chunk、CSS、图片、字体、OCR 模型与 wasm 计入。

### 5.2 构建接入

新增 `npm run check:renderer-bundles`，并把 `npm run build` 调整为：

1. 准备 OCR 资源；
2. 执行 electron-vite 三端构建；
3. 校验 renderer manifest、拆包关系与启动预算。

CI、smoke 与各平台 dist 已复用 `npm run build`，无需在 workflow 重复增加步骤。

## 6. 测试策略

三项独立执行 RED → GREEN：

1. 入口解析测试：四类 hash、图片查询参数与未知 hash 回退；
2. 缓存工具测试：LRU 淘汰、命中提升、覆盖顺序、容量校验；异步值测试并发去重、成功复用、失败后重试；
3. bundle checker fixture 测试：合法 manifest、缺动态入口、重复文件、静态闭包超限、manifest 文件缺失。

构建验收额外记录拆包前后产物：当前单体 renderer JS 为约 812 KiB；优化后要求四个根组件均形成动态 entry，公共启动闭包不超过 200 KiB。主窗完整功能 chunk 不设武断预算，本批只锁定窗口隔离与公共启动成本。

## 7. 文档、版本与提交

- requirements 新增决议 **#210**；
- tech-design 与 handoff 记录渲染入口拓扑、OCR 缓存边界与构建门禁；
- 版本按性能优化递增 patch：`0.33.0 → 0.33.1`；
- 设计规格独立提交；实现、测试、文档与版本变更合并为一个 `perf:` 中文提交；
- 不新增依赖，Electron 继续精确锁 `22.3.27`，构建目标继续为 `node16` / `chrome108`。

## 8. 最终验收

完成专项测试后统一执行：

```bash
npm run check:version
npm run check:renderer-bundles
npm test
npm run test:db
npm run typecheck
npm run build
npm run smoke
```

同时检查工作树仅含本批文件，构建产物没有远程 URL，OCR 模型仍从本地 `ocr/` 加载，四类窗口现有 hash 与行为保持一致。
