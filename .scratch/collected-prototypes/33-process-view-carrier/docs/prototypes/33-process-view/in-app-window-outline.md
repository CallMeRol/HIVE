# 候选 (b)：应用内新窗口 —— `index.ts` 补丁轮廓

> 轮廓级，≤30 行伪代码；不含真实实现。配合 `local-api-static.html`（同页套壳）。

```ts
// src/main/process-window.ts（新文件，新目录或并入 src/main/windows/）
import { BrowserWindow } from 'electron'
import { join } from 'path'

let processWindow: BrowserWindow | null = null

export function createProcessWindow(port: number): void {
  if (processWindow) { processWindow.focus(); return }
  processWindow = new BrowserWindow({
    width: 1100, height: 720,
    title: '过程台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false
    }
  })
  // 直接 load 本机 local-api 页面；未来可换 loadFile(打包后的 local-api 静态产物)
  void processWindow.loadURL(`http://127.0.0.1:${port}/process-view`)
  processWindow.on('closed', () => { processWindow = null })
}
```

## `index.ts` 补丁点（1 处 hunk）

```ts
// 在装配段（如 ipcMain.handle 注册区）新增：
ipcMain.handle('open-process-view', () => {
  if (process.env.PANTRY_HEADLESS) return        // headless 短路：不建任何窗口
  createProcessWindow(localApiPort)               // localApiPort 由 local-api 服务启动时回传
})
```

## 卡 2（`window-all-closed → app.quit()`）处理

- 卡 2 只咬「headless 不建主窗」的情形；过程窗在 headless 分支根本不创建（`PANTRY_HEADLESS` 短路）。
- 非 headless 时主窗常开，`window-all-closed` 不因过程窗触发；关过程窗只触发其自身 `closed` 置空引用。

## 与 #22 白名单记账

- 改动上游文件：仅 `index.ts`（1 hunk：注册 IPC handler + import 1 行）。
- 新增文件：`src/main/process-window.ts`（或 `src/main/windows/process.ts`，视目录约定）+ local-api 页面/服务（本就在 #14 计划内）。
- 上游 renderer / net / store 零改动。
