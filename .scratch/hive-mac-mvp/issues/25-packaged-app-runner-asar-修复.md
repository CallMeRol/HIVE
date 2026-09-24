# 25: [打包] 修复 packaged APP 无法执行 asar 内的 ACP runner

GitHub: （本地新建，无对应 GitHub 号）

Status: resolved
Implementation: d750f69
Blocked by:
- 21（GitHub #62 发布验收——本票为其发现缺口的修复票）

## 背景

`#62` 发布验收期间实测确证：**packaged `Hive.app` 无法执行 ACP runner**，导致 AC1「最终 APP 内嵌 runner、ACP SDK、Adapter」与 AC2「接入 Claude Code / Codex 并完成真 turn」**实际不成立**。

## 根因（已实测确证，非推测）

1. **`electron-builder` 未配置 `asarUnpack`**：`Hive.app/Contents/Resources/app.asar.unpacked/` 下**只有 `better-sqlite3`**（原生模块），`src/main/acp/runner.mjs`、`fake-acp-agent.mjs` **全部被封在 `app.asar` 内**。
2. **`node` 子进程无法穿透 asar**：AC6/ADR-0004 要求 runner 跑在**系统 Node.js ≥22 子进程**里（隔离 Electron 22 的旧 Node），而 node 无法读取 asar 内的文件路径 → spawn 必然失败。
3. **`app.getAppPath()` 在打包态返回 `app.asar`（是文件不是目录）**：以它为 cwd 或路径基准的地方全部失效。

## What to build

让 packaged APP 能正常拉起 ACP runner 子进程，使 AC1/AC2 在打包态成立。

## Acceptance criteria

- [ ] `Hive.app/Contents/Resources/app.asar.unpacked/` 下存在 ACP runner 相关文件（`runner.mjs`、`fake-acp-agent.mjs` 及其依赖）
- [ ] packaged APP 中 spawn runner 子进程成功（用系统 node，非 Electron 内建）
- [ ] `app.getAppPath()` 的路径解析在打包态与开发态都正确（asar 内 vs 解包目录）
- [ ] packaged APP 中 fake ACP peer 能完成一次 turn（黑盒可验证，不依赖真实 LLM）
- [ ] `pnpm run check:vendor` 0 violations；改动的上游文件（如 `package.json` / `electron-builder.yml`）已记账进 `vendor/.hive/patch-allowlist.txt` 与 `provenance.json`
- [ ] 不破坏开发态行为（`pnpm run e2e` 等既有脚本仍通过）

## 关键上下文

- **打包配置**：`vendor/teahouse/package.json` 的 `build` 段 / `electron-builder.yml`（`appId: com.pantry.app`、`productName: Teahouse`）
- **runner 位置**：`vendor/teahouse/src/main/acp/runner.mjs`（350 行）、`fake-acp-agent.mjs`（152 行）
- **#52 参考**：`copy-acp-runtime.mjs`（#52 新增，42 行）已处理部分 runner 依赖的拷贝，可参考
- **打包产物**：`vendor/teahouse/release/mac-arm64/Hive.app`
- **验证工具**：`scripts/hive-snapshot.mjs`（CDP 截图）、`scripts/acp-smoke.mjs`、`scripts/hive-attach-e2e.mjs`（接入 e2e，可 `--app` 指定打包产物）
- **已知非缺陷**：renderer 体积门超限（JS 828847/821248、CSS 120037/118784）是预存问题，**不挡构建产物**，本票不要动它
- **环境约束**：严禁 `pnpm install` / `npm install`；所有 pnpm 命令在仓库根执行；typecheck 用 `vendor/teahouse/node_modules/.bin/tsc|vue-tsc --noEmit -p <cfg> --composite false`

## Status

resolved

## 合并与验证

- **merge commit**：`d750f69`（`Merge branch 'impl/issue-asar'`，普通合并未 squash，无冲突）
- **summary commit**：`613b836`（空提交，中文 Conventional Commit）
- **被合并提交**：`728101b`（impl/issue-asar，9 文件 +322）

### 验证命令与结果（均实跑）

| 命令 | 结果 |
| --- | --- |
| `pnpm run check:vendor` | patch surface OK — 503 baseline files, 0 violations |
| `pnpm run test:guard` | 21/21 pass, 0 fail |
| `vendor/teahouse/node_modules/.bin/tsc --noEmit -p tsconfig.node.json --composite false` | exit 0，0 错 |
| `vendor/teahouse/node_modules/.bin/vue-tsc --noEmit -p tsconfig.web.json --composite false` | exit 0，0 错 |
| `vendor/teahouse/node_modules/.bin/vitest run` | 135 文件 / 916 测试全通过（含本票新增 `packaged-paths.test.ts`） |
| 重建打包产物后 `node scripts/hive-asar-e2e.mjs --app vendor/teahouse/release/mac-arm64/Hive.app` | **E2E OK（15/15）** |
| `pnpm run e2e`（开发态，补原提交遗留的 AC6） | **E2E OK（30/30）** |
| `node scripts/check-renderer-bundles.mjs`（在 vendor/teahouse 内） | JS 830841/821248、CSS 121233/118784 超预算（**预存问题**，未抬预算） |

### 打包产物重建（验证所必需）

验证时现场 `vendor/teahouse/release/mac-arm64/Hive.app` 是 #62 时期的**旧产物**（`app.asar.unpacked/` 下只有 `node_modules`，无 `out/`），早于本票的 `asarUnpack` 配置，故先重建再验：

1. `cd vendor/teahouse && node scripts/prepare-ocr-assets.mjs && ./node_modules/.bin/electron-vite build && node scripts/copy-acp-runtime.mjs`
2. `cd vendor/teahouse && ELECTRON_OVERRIDE_DIST_PATH="$PWD/node_modules/electron/dist" ./node_modules/.bin/electron-builder --mac --arm64 --dir --publish never -c.mac.identity=null`

重建后 `app.asar.unpacked/` 同时含 `out/main/acp/{runner.mjs,fake-acp-agent.mjs}` 与 `node_modules/{@agentclientprotocol,better-sqlite3,zod}`，黑盒 rig 15 项断言全 PASS，含「packaged APP 中 fake ACP peer 完成一次 turn」。

### AC 覆盖

- AC1/AC2/AC3/AC4：由 `scripts/hive-asar-e2e.mjs` 在黑盒上覆盖，全 PASS
- AC5（ledger 记账）：`check:vendor` 0 违规；`patch-allowlist.txt` +10 行、`provenance.json` 增 `#25` 条目，且 `ticket` 行追加 `/ #25`（只追加，未压行）
- AC6（不破坏开发态）：原提交标注未跑，本次已补跑 `pnpm run e2e` 30/30 通过

### 未完成项 / 待核实

- renderer 体积门超限（JS/CSS）为**预存问题**，本票未动，亦未抬预算。
- `scripts/hive-asar-e2e.mjs` 的默认 `--app` 是 `release/mac-arm64/Hive.app`（相对仓库根），而产物实际在 `vendor/teahouse/release/...`；直接裸跑会报「找不到可执行文件」。根 `package.json` 已提供正确入口 `pnpm run e2e:asar:app`（与仓库内其它 e2e 的既有约定一致，非本票引入的缺陷），本次验证即走该路径。
- 本次验证期间在 `vendor/teahouse/out`、`vendor/teahouse/release` 生成的重建产物均被 gitignore 覆盖，未进入任何提交。
