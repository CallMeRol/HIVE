# 本机运维 launcher（#48）

一套声明式配置 + 四条命令，管本机 Hive 环境：起、查、体检、停。
入口 `pnpm run hive -- <命令>`，实现在 `scripts/hive.mjs` + `scripts/lib/hive-launcher.mjs`。

```sh
pnpm run setup && pnpm run build     # 首次：vendor 依赖 + dev 构建产物
cp hive.config.example.json hive.config.json
pnpm run hive -- up                  # 等全部节点 health 就绪才返回
pnpm run hive -- status              # 节点 / 端口 / 进程实际状态
pnpm run hive -- doctor              # 体检 + 可操作诊断
pnpm run hive -- down                # 优雅退出，无残留
```

退出码一律 0 = 成功 / 1 = 失败。失败输出带 `错误：…` + `建议：…` 两段，不静默。

## 配置（hive.config.json）

```jsonc
{
  "dataRoot": "~/Library/Application Support/Hive",  // 缺省即此；每节点取其下子目录
  "app": null,                                       // null = dev 构建产物；或 .app 路径
  "nodes": [
    { "id": "gui", "gui": true,  "nick": "Hive 主控" },      // udp 17878 / tcp 17879 / api 17880
    { "id": "member-a", "nick": "成员 A" },                  // 自动 +100 递增，逐节点独立
    { "id": "member-b", "nick": "成员 B" }
  ]
}
```

| 字段 | 缺省 | 说明 |
|---|---|---|
| `dataRoot` | `~/Library/Application Support/Hive`（macOS） | 每节点在 `<dataRoot>/<id>/` 得到独立 `PANTRY_USER_DATA` |
| `app` | `null` = dev `out/` | 填 `.app` 目录路径则用打包产物 |
| `nodes[].id` | 必填 | 唯一；决定数据目录与状态文件里的 key |
| `nodes[].gui` | `false` | `true` = 有主窗（`PANTRY_HEADLESS` 不设） |
| `nodes[].udp` / `tcp` / `api` | 按序号递增 | `api: 0` = 系统分配临时端口（值只从节点日志读回） |
| `nodes[].nick` | `Hive <id>` | 写入该节点 config.json 的昵称 |
| `nodes[].cdp` | 无 | CDP 调试口，只给 e2e 用；与 `gui: true` 互斥 |

**端口必须两两不同**（配置加载期即校验，冲突直接报出两个节点名）。

## 配置预置必须写完整字段集

launcher 会为每个节点写 `config.json`。**这是有意的强约束**：写残缺 config（只填一两个字段）
会让 packaged 节点 `net.ok=true`、`peers=0`、**零报错**，怎么等都发现不到对端 —— #44 实测踩到并
记在 `docs/local-api.md`。全字段集收敛在 `scripts/lib/hive-node-config.mjs` 一处，
任何消费方都不许自己拼半份。

## 四条命令的语义

### up

1. 解析可执行文件（dev 走 `require('electron')` 拿**真二进制**，不走 `.bin/electron` wrapper ——
   那个 wrapper 会 spawn 真 Electron，拿它的 pid 当节点 pid 会错位）+ 校验配置
2. **端口预检**：任一声明端口被占即停。不预检的话，`waitHealth` 会读到上一个残留节点的 health 而假通过
3. 逐个起节点（`detached` 自成进程组），**每起一个就落盘一次状态**
4. 逐个等就绪，**全有或全无**：任一节点未就绪就地回滚已起的全部，再非零退出

**就绪的定义**（不只「HTTP 起来了」）：`GET /v1/health` 可用 **且** 报出的 `nodeId` 属于本节点
**且** udp/tcp 端口与配置吻合 **且** `net.ok === true`。最后一条专门挡住上面那个残缺 config 的静默失败。

`api: 0` 时端口从节点日志 `[local-api] 监听 127.0.0.1:<port>` 读回并落状态。

### status

只报**观测事实**：进程 pid 是否活着、端口谁在听、health 怎么说。不推断「应该怎样」。

- 节点被杀（状态文件还记着它）→ 显式报「进程已不在，但状态文件仍记着它」，并给数据目录/日志路径/处置命令
- 有节点未就绪 → **非零退出**（可当门禁脚本用）
- `--json` 输出给脚本消费

### doctor

锚定 issue #48 的四项，每项失败带 `→` 一行可操作建议：

| 检查 | 失败时的建议方向 |
|---|---|
| Node 运行时 ≥ 22 | `nvm install 22`；vendor 依赖与 e2e 都锚在这一档 |
| 可执行文件就位（dev `out/` 或 `.app` 结构 + codesign 可读） | 指回 `app` 配置或 `pnpm run build`；签名失败给 `codesign --force --deep --sign -` |
| 数据目录可写（逐节点真实写探针） | 改 `dataRoot` 或修权限 |
| 基础节点配置（至少一个 GUI、端口可用性） | 端口分「本环境节点占的」（正常）与「被别人占的」（要给 `lsof` 定位） |
| 状态文件与进程实况一致 | 跑 `down` 清陈旧记录 |

**明确划出范围外**：adapter 文件与 ACP initialize、模型探活、时钟偏差、局域网站点可达——这些属
#49+ 的交付物，这里显式打印「本轮范围外」而**不做假检查**。全绿 ≠ 现场就绪。

### down

**先 quit 后 kill**（`docs/local-api.md` 的硬要求）：Windows 无 SIGTERM，`kill()` 走 TerminateProcess
时 `before-quit` 链不执行，对端要等 90s 才判离线。故流程是
`POST /v1/lifecycle/quit` → 给 3s 优雅窗口 → 整组 SIGTERM → 整组 SIGKILL → 按端口补收。

收尾判定按**端口是否真的空出来**，不是「组长 pid 还在不在」：detached 组长退出后真正的 Electron
进程会 reparent 到 launchd，按进程树递归什么都找不到（见 `hive-proc.groupAlive` 注释）。
有残留则非零退出并点名节点与端口。

## 与 e2e rig 的关系

`scripts/lib/hive-rig.mjs`（#44/#45 的黑盒 rig）与 launcher 共用两个工具层，不复制实现：

- `scripts/lib/hive-proc.mjs` —— 进程树/进程组、端口归属、kill
- `scripts/lib/hive-node-config.mjs` —— 完整字段集的 config.json 预置

两条 rig 各留自己的拓扑与断言，不抽通用 `up` 编排（那是本 ticket 的交付物）。

## 本机可重复验收

```sh
pnpm run e2e:ops                      # #48：43 项断言（dev out/）
node scripts/hive-ops-e2e.mjs --app vendor/teahouse/release/mac-arm64/Teahouse.app   # 打包产物
```

全程只经 `scripts/hive.mjs` 真 CLI（子进程 + 退出码 + stdout），不 import launcher 内部函数——
验的是「用户敲的那条命令」。覆盖五条 AC，含故障注入：端口被占、app 路径不存在、配置端口冲突、
未知命令、配置文件缺失、节点起不来时的回滚。判据 = 退出码 0/非 0。

## 现场排错入口

| 现象 | 先看 |
|---|---|
| `up` 失败回滚 | `up` 输出里每个失败节点会带节点日志尾巴；完整日志在 `<dataRoot>/<id>/node.log` |
| 节点在、但收不到对端 | `doctor` 的端口段 + `status` 的 `peers=`；`peers=0` 且 `net.ok=true` = 残缺 config 的静默失败 |
| `down` 报残留 | 输出点名节点与端口；`lsof -nP -iTCP:<端口>` 找占用者，再看 `node.log` |
| GUI 起不来 | `doctor` 的可执行文件与 codesign 两项 |
