# 三机 LLM 拓扑与模型锁定三层归属

- **Status**: accepted
- **源 issue**: [toRolex/hive#27](https://github.com/toRolex/hive/issues/27)（凭据/能力集证据：[#21](https://github.com/toRolex/hive/issues/21)）

演示用 1 Mac + 2 Windows 拓扑定为：两台 Windows 零中转、零环境变量，直连 Mac 的 `MAC_IP:2317`；模型锁定分三层归属——启动脚本探测+锁定（默认）、主人仪表盘运行时 override（主人）、配置文件写死活模型（兜底）。可用性探测放在中转层（`/v1/models` + `max_tokens≤8` 并发）；断网时 LLM 必灭，兜底 = `scripts/fake-acp-agent.mjs` + 预录/预置产物，不编造本地模型。

操作步骤、每机清单与验收清单归 [`docs/handoff/coldstart-3machine/RUNBOOK.md`](../handoff/coldstart-3machine/RUNBOOK.md)，本 ADR 只记决策与理由，不复制操作步骤。

## Context

- 中转层本身依赖 Mac 上的两个本机代理进程和一份包含上游凭据的本机配置；上游还存在一个 Tailscale 单点，实测发生过 504/timeout。具体内部地址、进程名和凭据路径不进入仓库；产品公开监听端口仍由本 ADR 与 RUNBOOK 记录。
- 实测：`/v1/models` 监听 `*:2317`，LAN 地址访问 200 / 24 个模型 → 跨机直连可行。
- 默认模型坏是常态：codex 默认 `gpt-5.6-luna` 在死桶（每 turn 卡 30s 后失败）；claude 默认别名桶指向 429 冷却 ~46h 的 `gemini-3.8-flash`。`session/set_config_option` 是绕开坏默认模型的唯一非侵入手段（#21 实测）。
- ACP 层枚举的是「本机配置声明的模型」而非「此刻活着的模型」：claude 侧是别名、映射在 `~/.claude/settings.json`；codex 侧来自 `~/.codex/config.toml` 的 catalog → 探测必须在中转层做，锁定才在 ACP 层做。
- `/v1/models` 只列名不证活（列表 200 但其中 5 个全灭）→ 探活 = `max_tokens≤8` 的真实请求，活模型 <1s、死模型等超时，必须并发且 `-m 6`。
- 断网后本机 `ollama` 不存在、`llama-server` 在但 `*.gguf` 权重 0 个 → 没有离线 LLM 替代。

## Considered Options

1. **（选定）两台 Windows 直连 `MAC_IP:2317`，零中转零 env。** 证据：直连实测 200；复刻中转 = 复制同一份密钥 + 两个进程 + 26 KB 配置，收益 0、失败面 ×2；且本地中转也解决不了 Tailscale 上游单点——换谁跑中转，上游还是它。成本仅两个纯文本配置文件，可离线记事本写好带过去。
2. **每机复刻中转——否决。** 密钥×2、失败面×2，上游单点复刻也解决不了（见上）。
3. **只设环境变量（`set ANTHROPIC_BASE_URL` 等）——否决。** 实测 `~/.claude/settings.json` 的 `env` 覆盖进程环境变量：进程 env 指到死端口、settings.json 指 2317，实际仍打 2317 → 必须写 settings.json。
4. **不锁模型——否决。** codex 默认死桶每 turn 卡 30s；claude 默认桶 46h 冷却，演示必挂。
5. **本地模型兜底——否决。** 无权重、下权重本身要网；「切本地模型」是编造。唯一诚实 Plan B = `fake-acp-agent`（#14 的 A6）+ 预录/预置产物。

## Decision

- 拓扑：两台 Windows 零中转、零环境变量，只写两个配置文件（`~/.claude/settings.json`、`~/.codex/*`），`base_url=http://MAC_IP:2317`；token 共用同一 `RELAY_TOKEN`；不设 `OPENAI_API_KEY`。
- 模型锁定三层归属：
  1. **默认动作 = 启动脚本**：bridge 在 `session/new` 后按探测结果 `set_config_option`（默认模型坏是常态；脚本本为 #13 一键启动而写，边际成本≈0）。
  2. **运行时 override = 主人仪表盘**：`local-api` 加 probe+lock 端点，演示中模型死掉时重锁——主人在演示进行中唯一可操作的界面。
  3. **兜底 = 配置文件**：演示前把两 adapter 默认值写成活模型（codex `model="deepseek-v4.1-flash"`；claude 默认别名→活模型），零代码现场路径。
- 探活在中转层：`/v1/models` + `max_tokens≤8` 并发扫，24 模型全扫 ≤10s；锁定动作在 ACP 层。
- 断网 LLM 必灭：兜底 = `scripts/fake-acp-agent.mjs` + 预录/预置产物，不编造本地模型。

## Consequences

- 直连代价必须进现场清单：Mac 开机且不休眠（`caffeinate -dimsu`）、`MAC_IP` 固定（DHCP 保留），否则两台 Windows 配置漂移。
- 每次冷启动必须跑一键验证区分「中转挂了」与「外网断了」（`/v1/models` 断网后仍绿）——具体命令与降级阶梯见 RUNBOOK，不在本 ADR 复制。
- 「启动脚本 / 仪表盘」两层归属是 driver 推荐、主人一句话可否决，否决只改归属不改拓扑与断网兜底。
- Windows 真机零验证已 graduate 至 #32；本 ADR 的拓扑结论不依赖该验证（LAN 直连已在 Mac 侧实测）。
