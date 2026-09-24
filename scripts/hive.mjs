#!/usr/bin/env node
// Hive 本机运维入口（#48）：一条命令管理基础 Hive 环境。
//
//   pnpm run hive -- up       启动 hive.config.json 声明的全部节点，等 health 就绪才退出
//   pnpm run hive -- status   展示节点、端口与进程的实际状态
//   pnpm run hive -- doctor   检查 Node / 端口 / 数据目录 / 节点配置，给出可操作诊断
//   pnpm run hive -- down     优雅退出全部节点，不残留 Electron / Node 进程
//
// 退出码：0 = 成功；1 = 失败（含 GUI 启动失败、节点未就绪、down 有残留、doctor 有 FAIL）。
// 所有失败都带「→ 建议」一行，不静默。
import { DEFAULT_CONFIG_PATH, doctor, down, loadConfig, status, up } from './lib/hive-launcher.mjs'

const USAGE = `用法：pnpm run hive -- <命令> [选项]

命令：
  up        启动配置声明的全部节点；等每个节点 health 就绪后才成功退出
  status    展示节点、端口与进程的实际状态
  doctor    检查 Node、端口、数据目录与基础节点配置，对故障给出可操作诊断
  down      优雅退出全部节点，且不残留 Electron / Node 进程

选项：
  -c, --config <path>   配置文件（默认 ${DEFAULT_CONFIG_PATH}）
  -t, --timeout <ms>    up 等待就绪的总时长（默认 60000）
      --json            status 输出 JSON（供脚本消费）
  -h, --help            显示本帮助

配置：hive.config.json（模板见 hive.config.example.json）
`

function parseArgs(argv) {
  const opts = { command: null, config: DEFAULT_CONFIG_PATH, timeout: 60000, json: false, help: false }
  const rest = [...argv]
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg === '--json') opts.json = true
    else if (arg === '-c' || arg === '--config') {
      const value = rest.shift()
      if (!value) throw new Error(`${arg} 需要一个路径`)
      opts.config = value
    } else if (arg === '-t' || arg === '--timeout') {
      const value = Number(rest.shift())
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${arg} 需要一个正整数毫秒数`)
      opts.timeout = value
    } else if (arg.startsWith('-')) throw new Error(`未知选项 ${arg}`)
    else if (opts.command === null) opts.command = arg
    else throw new Error(`多余的参数 ${arg}`)
  }
  return opts
}

/** 统一失败渲染：错误原因 + 可操作建议，然后非零退出。 */
function die(err) {
  console.error(`\n错误：${err.message}`)
  if (err.hint) console.error(`\n建议：\n${err.hint}`)
  process.exit(1)
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    die(Object.assign(err, { hint: USAGE }))
  }

  if (opts.help || opts.command === null) {
    console.log(USAGE)
    process.exit(opts.command === null && !opts.help ? 1 : 0)
  }

  const known = ['up', 'down', 'status', 'doctor']
  if (!known.includes(opts.command)) {
    die(Object.assign(new Error(`未知命令 ${opts.command}`), { hint: USAGE }))
  }

  // down 要能在配置残缺时也尽量跑（否则现场卡住清不干净）：节点表可以空。
  const config = loadConfig(opts.config, { needNodes: opts.command !== 'down' })

  if (opts.command === 'up') {
    await up(config, { timeoutMs: opts.timeout })
    return
  }

  if (opts.command === 'down') {
    await down(config)
    return
  }

  if (opts.command === 'status') {
    const result = await status(config, { verbose: !opts.json })
    if (opts.json) {
      console.log(JSON.stringify({
        config: config.configPath,
        dataRoot: config.dataRoot,
        ready: result.ready,
        total: result.total,
        nodes: result.rows.map((row) => ({
          id: row.node.id,
          role: row.node.gui ? 'gui' : 'headless',
          pid: row.pid,
          alive: row.alive,
          ports: { udp: row.node.udp, tcp: row.node.tcp, api: row.apiPort },
          ready: row.probe.ok,
          reason: row.probe.ok ? '' : row.probe.reason,
          nodeId: row.record?.nodeId ?? null
        }))
      }, null, 2))
    }
    // status 是只读观测：有节点没就绪就非零退出，让脚本能拿它当门禁。
    process.exit(result.total > 0 && result.ready === result.total ? 0 : 1)
  }

  if (opts.command === 'doctor') {
    const { failed } = await doctor(config)
    if (failed.length > 0) {
      console.error(`\ndoctor 发现 ${failed.length} 项故障：${failed.map((f) => f.name).join('；')}`)
      process.exit(1)
    }
    console.log('\ndoctor 全部通过。')
  }
}

main().catch(die)
