# #62 发布验收报告 · Mac Product Complete（黑盒）

> 执行日期 2026-09-24 · 主干 `main` @ `989baaf` · 本机 macOS 15.6.1 / M4 / arm64
> 本票只做**黑盒发布验收**（AC7），未首次补实现。产物：`vendor/teahouse/release/mac-arm64/Hive.app`

## 结论速览

| AC | 判定 | 一句话 |
|---|---|---|
| AC1 内嵌依赖 | **部分通过** | runner / ACP SDK / fake peer / 视觉 / Markdown 已内嵌；**Claude、Codex adapters 未内嵌** |
| AC2 干净目录起跑 | **未通过** | 身份 / 多群 / 打包态重启通过；**打包态接入 spawn 全挂**（ENOTDIR）+ codex adapter 缺位 |
| AC3 全链路 | **未通过** | pending 跨机链路 dev 与打包**一致失败**；其余环节（派遣 / 交接 / 回收 / 重启 / 机库）dev 通过 |
| AC4 三故障剧本 | **通过** | runner 猝死 / 守卫不可用 / 交接损坏 19 项断言全过（打包态） |
| AC5 边界验证 | **通过** | 签名 / 架构 / 动态依赖 / LaunchServices / quarantine / 无残留 |
| AC6 构件留本机 | **通过** | 源码 / vendor / 锁 / 脚本 / 账本 / 许可齐；无独立测试报告目录 |
| AC7 不首次补实现 | **遵守** | 全程只读核验 + 打包，未改任何产品源码 |

## 打包与产物

```sh
# 1. 构建（check:renderer-bundles 预存红，不挡产物）
$ cd vendor/teahouse && npm run build
[copy-acp-runtime] 2 个运行时文件 → .../out/main/acp
[renderer-bundles] App.vue 完整静态 JS 闭包 830841 字节，超过 821248 字节预算   ← 预存问题（已知事实）
[renderer-bundles] App.vue 完整静态 CSS 闭包 121233 字节，超过 118784 字节预算

# 2. 打包 + ad-hoc 签名
$ ELECTRON_OVERRIDE_DIST_PATH="$PWD/node_modules/electron/dist" \
    ./node_modules/.bin/electron-builder --mac --arm64 --dir --publish never -c.mac.identity=null
$ cd release/mac-arm64 && codesign --force --deep --sign - Hive.app
Hive.app: replacing existing signature
```

产物 42 MB `app.asar` + `app.asar.unpacked`（better_sqlite3.node）。

## AC1 · 内嵌依赖（部分通过）

| 必须内嵌项 | 证据 | 判定 |
|---|---|---|
| runner（ACP runner） | `asar list` → `/out/main/acp/runner.mjs`、`fake-acp-agent.mjs` | ✅ |
| fake peer | 同上 `fake-acp-agent.mjs` | ✅ |
| ACP SDK | `/node_modules/@agentclientprotocol/sdk/dist/acp.js` | ✅ |
| 视觉资源 | 五档精灵 GIF ×5（`sleep/ease/tired/super_tired/ran_out`）+ `hive-app-icon-*.png` + `Resources/icons/pantry.png` | ✅ |
| Markdown 依赖 | `/node_modules/markdown-it`、`dompurify`（含传递依赖 `linkify-it`/`mdurl`/`uc.micro`/`punycode.js`） | ✅ |
| **Claude adapter** | `grep claude-agent-acp app.asar` → **空** | ❌ **未内嵌** |
| **Codex adapter** | `grep codex-acp app.asar` → **空** | ❌ **未内嵌** |

打包版实跑截图确认品牌落地（`docs/demo/snapshots/hive-packaged-verify.png`）：
CDP 读回 token `{"theme":"dark","primary":"#e94560","bgWindow":"#0a0e17"}`，观感与
`HIVE-VISUAL-SPEC.md` 一致。

## AC2 · 干净数据目录从 Finder 起跑（未通过）

```sh
$ node scripts/hive-e2e.mjs --app vendor/teahouse/release/mac-arm64/Hive.app
E2E OK（30 项断言）        # 身份初始化 / 建群 / 双向收发 / 优雅退出无残留 / 重启恢复

$ node scripts/hive-multigroup-e2e.mjs --app .../Hive.app
E2E OK（57 项断言）        # 多群创建切换、群间不串流、重启恢复、真界面建群
```

失败项：

```sh
$ node scripts/hive-attach-e2e.mjs
18/21 通过，3 项失败
FAIL  AC3 claude 接入成功 — 成员节点未在 30s 内就绪（apiPort=17980）
FAIL  AC3 codex 探测就绪 — adapter:PATH 上没有 codex-acp
FAIL  AC1 已接入成员可被列出 — []
```

claude 接入节点 `node.log` 实读：

```
[local-api] 启动失败： Error: listen EADDRINUSE: address already in use 127.0.0.1:17980
```

**打包态阻断根因（本票新发现，两条）**：

1. **`cwd: app.getAppPath()` 在打包态指向 `app.asar`（文件，非目录）** →
   `vendor/teahouse/src/main/index.ts:847`（`resolveDispatchExecutable`）、`:1064`（接入 spawnNode）
   返回的 cwd 使 `spawn` 直接 `ENOTDIR`。判别实验：

   ```sh
   $ node -e "spawnSync('/bin/echo',['hi'],{cwd:'.../Resources/app.asar'})"
   ENOTDIR: spawnSync /bin/echo ENOTDIR      # asar 是文件
   ```

2. **runner 入口解析落在 asar 内** → `session.ts:128` 拼出的路径
   `.../app.asar/out/main/acp/runner.mjs` 对系统 node 子进程不可读，实报：

   ```
   Error: Cannot find module '.../Hive.app/Contents/Resources/app.asar/out/main/acp/runner.mjs'
   ```

两条叠加 = 打包版的**派遣**与**接入**（起独立 agent 节点）在真机上不可用。dev 构建
（`out/`）不受影响，故 #51/#52/#53/#56 的 dev 断言一直是绿的，缺口只在打包态暴露。

## AC3 · 全链路（未通过）

| 环节 | 打包态 | dev | 证据 |
|---|---|---|---|
| 多群创建/切换 | ✅ 57 项 | — | `hive-multigroup-e2e.mjs --app` |
| pending 收集期 | ✅ AC1 项 | ✅ | 两节点真拓扑 |
| **确认键 / 目标冻结 / 聚合 turn / steering** | ❌ | ❌ | **dev 与打包一致失败 → 非打包问题** |
| 派遣 | ❌ `ENOTDIR` | ✅ 10 PASS | 见 AC2 根因 |
| 机库 | ❌ runner 不可读 | ✅ 48 PASS | 见 AC2 根因② |
| 交接 / 回收 / 重启恢复 | ✅ 19 项 | — | `hive-recovery-e2e.mjs --app` |
| 成员移出 | — | ✅ 27 项 | `hive-member-e2e.mjs` |
| 运维 up/status/doctor/down | — | ✅ 43 项 | `hive-ops-e2e.mjs` |
| 状态通道 | — | ✅ 28 项 | `hive-status-e2e.mjs` |
| ACP 冒烟 | — | ✅ 40 项 | `acp-smoke.mjs` |

pending 失败详情（稳定复现，dev 连跑两次同结果 12 PASS / 9 FAIL）：

```sh
$ node scripts/hive-pending-e2e.mjs
FAIL  AC4 SSE pending.updated 药丸事件 — 未收到
FAIL  AC4 GUI 可读 pending 状态（药丸数据源） — []
FAIL  AC3 主人确认成功 — {"ok":false,"code":"unknown_group","reason":"群不存在或本机不认识该群"}
FAIL  AC3 会话目标冻结（带 frozenBy） — null
FAIL  AC5 执行期 steering 直通触发 turn — 0 条正式消息
FAIL  AC6 重启后会话目标恢复 — null
```

**根因（已定位）**：pending 归**成员节点本机**（`pending-gate.ts`：`selfMemberId` = 本进程），
而确认键在**主人 GUI**（A 进程）。`hivePendingConfirm` 在 A 上执行 `svc.get(memberId)`，
A 的 `pendingService` 里没有 B 的草稿 → `draft?.groupId ?? ''` 为空 → `groups.get('')` 为 null
→ 报 `unknown_group`。**pending 面缺跨机通道**（`pending.updated` 只进本机 SSE/renderer，
无跨节点广播）。#50 的 commit 信息已如实记录该缺口。

## AC4 · 三故障剧本（通过）

```sh
$ node scripts/hive-recovery-e2e.mjs --app .../Hive.app
全部通过（19 项断言）
```

- ① **runner 猝死**：`AC2 中断派遣未被标记成功 outcome=failed`、
  `reason=主进程重启导致执行中断（恢复不造假：不伪装活跃，不自动补派）`、
  `AC2 不重复派遣 dispatches=1`、`AC2 slot 已归还 slots=[]`、
  `AC3 中断派遣已转待领取且可被接手 status=claimable`
- ② **守卫不可用**：`AC1 进程仍正常启动`、`AC1 不产生伪造的「已判定」记录`、
  `AC3 降级警告 undetermined 留痕跨重启保留`、`AC3 警告留痕保留判定输入（可审计）`
- ③ **交接损坏**：`AC1 已注入（账本 0000…≠实际 a892fbe2dcbc…）`、
  `AC2 损坏交接未被标记为已复验通过 verified=false`
- `AC4 退出后无残留 Electron / Node 进程 — 残留 pid=[]`

## AC5 · 边界验证（通过）

```sh
$ codesign --verify --deep --strict --verbose=2 Hive.app
Hive.app: valid on disk
Hive.app: satisfies its Designated Requirement

$ codesign -dvv Hive.app
Identifier=com.pantry.app · Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 flags=0x2(adhoc) · Signature=adhoc · TeamIdentifier=not set

$ lipo -info Contents/MacOS/Hive
Non-fat file: architecture: arm64

$ otool -L Contents/MacOS/Hive
@rpath/Electron Framework.framework/Electron Framework
/usr/lib/libSystem.B.dylib          ← 无仓库外第三方 dylib（全部 @rpath 或系统）
$ otool -L app.asar.unpacked/.../better_sqlite3.node
/usr/lib/libc++.1.dylib · /usr/lib/libSystem.B.dylib
```

| 项 | 结果 |
|---|---|
| ad-hoc 签名 | ✅ `flags=0x2(adhoc)`，`--deep --strict` 校验通过 |
| 架构 | ✅ arm64 thin（与打包目标一致） |
| 动态依赖 | ✅ 无 repo 外/无绝对路径第三方库 |
| LaunchServices | ✅ `lsregister -dump` 有 `com.pantry.app` 记录，`displayName = Hive`；本次产物注册后查得 2 处命中 |
| quarantine 边界 | ✅ `xattr -l Hive.app` 仅 `com.apple.provenance`，**无** `com.apple.quarantine`（本机自建产物不经下载隔离，符合预期） |
| 退出后无残留 | ✅ 四个 rig 均断言 `残留 pid=[]`（含 Electron Helpers） |
| Info.plist | ✅ `CFBundleDisplayName=Hive`、`CFBundleName=Hive`、`CFBundleExecutable=Hive`（#44 半改名问题已修） |

## AC6 · 构件留本机（通过）

| 项 | 位置 / 结果 |
|---|---|
| 源码 | `vendor/teahouse/src`（503 baseline + Hive 新增命名空间） |
| vendor | `vendor/teahouse/`（v0.60.2 snapshot）+ 账本 `vendor/.hive/{provenance.json,baseline.sha256,patch-allowlist.txt}` |
| 依赖锁 | `vendor/teahouse/package-lock.json`（276 KB）+ `pnpm-lock.yaml` |
| 构建测试脚本 | `scripts/*.mjs` 17 个 + `scripts/lib/` 4 个 |
| 配置 | `hive.config.example.json`、`.githooks/`、`.github/workflows/ci.yml` |
| 许可 | `vendor/teahouse/LICENSE`（GPL-3.0-only）✅；**仓库根无 `LICENSE`**（Hive 自有部分无独立许可文件） |
| 测试报告 | 本文件；**无独立测试报告目录**（往期报告散在 `.agents/notes/`） |
| 已知限制 | 见下文「未验证 / 缺口」 |

验证命令：

```sh
$ pnpm run check:vendor
patch surface OK — 503 baseline files, 0 violations

$ cd vendor/teahouse && node_modules/.bin/tsc --noEmit -p tsconfig.node.json --composite false
TSC_EXIT=0
$ node_modules/.bin/vue-tsc --noEmit -p tsconfig.web.json --composite false
VUE_TSC_EXIT=0

$ pnpm run test      # 从仓库根
Test Files  134 passed (134)
Tests       908 passed (908)
```

## 未验证 / 缺口清单

| # | 缺口 | 阻塞点 | 应退回 |
|---|---|---|---|
| 1 | **打包态 spawn 全挂**（`cwd = app.asar` → `ENOTDIR`） | `index.ts:847/1064` 用 `app.getAppPath()` 当 cwd；打包态该值是 asar 文件 | **#62 自身 AC1/AC2 范围**，但 AC7 禁止验收票补实现 → 需**新开实现票** |
| 2 | **打包态 runner 入口在 asar 内**，系统 node 不可读 | `session.ts:128` 未走 `app.asar.unpacked` | 同上 |
| 3 | Claude / Codex adapter 未内嵌 | 与 #49 笔记「打包内嵌 adapter 属 #62」一致，但实现未落地 | 同上（新开实现票） |
| 4 | **pending 无跨机通道** → 确认键不可用 | 需新增 pending 跨节点广播（或把确认键下沉到成员节点） | **#50**（实现票） |
| 5 | **Codex 真 turn 未验证** | 本机 PATH 无 `codex-acp`；`/tmp/acp-sdk-probe` 下那份仅供 rig 用，非发布路径 | **#49**（实现票）+ 新开内嵌票 |
| 6 | **Claude 真 turn 未验证** | 接入 spawn 被缺口 #1 阻断；探测器静态项全过 | **#49** |
| 7 | `check-renderer-bundles` 红（JS 830841/821248、CSS 121233/118784） | **预存问题**，且该门跑在 `out/` 产出之后，不挡产物 | 跟随 #57/#62 预算上调票（#53 笔记已建议） |
| 8 | #51 rig 端口硬编码漏 depth 偏移 10000 | 测试脚本 bug（`mPort = 17878+100+2`，实为 `27980`）；产品侧 `portsForSlot` 正确 | **#51**（rig 修正，非产品缺陷） |
| 9 | 交接 / 回收 / 单次越界在打包态未单独复验 | 时间盒内未跑；#61 rig 已覆盖交接损坏面 | 补跑即可，非实现缺失 |

## 环境噪声（非产品缺陷，如实记录）

本机累计残留的探索进程污染过端口，导致若干轮失败需重跑。已核实并清理：

- `hive.impl-issue-56`（**目录已删除**）泄漏 2 个 Electron，占 28279/28280/28379/28380（深度 2 端口带）→ `#56` rig 预检响亮拒绝（符合其注释设计）
- `hive-dispatch-e2e-fG72hg` 泄漏派遣子进程、`hive-e2e-wWkXP6`/`2p9qLa` 泄漏接入节点，占 17978–17980 → 引发 `EADDRINUSE` 级联

清理后重跑结果已并入上表。**#51 的 `health 身份不匹配` 与 #56 的 `ENOTDIR` 是两个不同问题**：
前者是 rig 端口 bug（缺口 #8），后者是真实产品缺陷（缺口 #1）。

## 判定

**Mac Product Complete 未达成。** 干净目录起跑（AC2）与全链路（AC3）在打包态不通过，
其中缺口 #1/#2/#3 是**打包态专有**且直接命中原生 AC1 的「内嵌 runner / adapters」要求；
缺口 #4 是 pending 跨机语义缺失。

按 AC7「任何缺失退回对应实现票」，建议：
**新开一张打包内嵌实现票**（承接缺口 #1/#2/#3，含 `app.getAppPath()` → unpacked 路径修正 +
adapters 随包内嵌），并**重开 #50**（pending 跨机通道）。二者落地后本票方可复核 AC2/AC3。

AC4（三故障剧本）与 AC5（签名/架构/依赖/LS/quarantine/无残留）已实质通过，可作为发布边界基线。
