# Windows 端 · teahouse 离线 bundle 安装指南（第 1 步分支）

> 来源：Mac 侧响应 Windows 第 1 步 handoff（C:\teahouse 不存在）。
> bundle 内容：teahouse 源码（f6607ff，Mac 上已 `npm install` + `npm run build` 验证过）+ 离线 npm cache（109 MB，Windows 用 `npm ci --offline` 重建 node_modules）。

---

## 安装步骤（PowerShell，普通窗口即可，不用管理员）

```powershell
# 1. 解压 bundle（假设 zip 在 Downloads）
cd $env:USERPROFILE\Downloads
Expand-Archive .\teahouse-hotspot-bundle.zip -DestinationPath C:\
# 解压后应该是 C:\teahouse-src 和 C:\teahouse-win-cache

# 2. 改名
Move-Item C:\teahouse-src C:\teahouse

# 3. 离线重建 node_modules（约 2-3 分钟）
cd C:\teahouse
npm ci --offline --cache C:\teahouse-win-cache --no-audit --no-fund

# 4. 验证 better-sqlite3 编译成功
node -e "require('better-sqlite3')('test.db'); console.log('SQLITE_OK')"
# 期望输出：SQLITE_OK（会生成 test.db，可删）

# 5. 验证 electron-vite 在
Test-Path C:\teahouse\node_modules\.bin\electron-vite.cmd
# 期望：True

# 6. 验证文档里的两个 Test-Path
Test-Path C:\teahouse\src\main\net\discovery.ts
Test-Path C:\teahouse\node_modules\.bin\electron-vite.cmd
# 期望：True / True
```

**注意**：
- `npm ci --offline` 会**先删 node_modules 再装**，所以 C:\teahouse 里原本的 node_modules（Mac 版）会被清掉，换成 Windows 版。这是对的。
- 如果 `npm ci --offline` 报 `EAI_AGAIN` 或 `ENOTFOUND`，说明它想联网——检查是不是漏了 `--offline` flag。
- 如果 better-sqlite3 编译失败（`node-gyp` 报错），把完整错误原文写进 handoff 发回 Mac。

**handoff 附带诊断**（如果第 3 步失败）：
```powershell
node -v; npm -v; Get-ChildItem C:\teahouse-win-cache\_cacache\content-v2 | Measure-Object | Select-Object Count
```
