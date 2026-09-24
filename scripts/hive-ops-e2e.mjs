#!/usr/bin/env node
// Hive #48 黑盒验收：一条命令管理基础 Hive 环境（up / status / doctor / down）。
//   node scripts/hive-ops-e2e.mjs
//   node scripts/hive-ops-e2e.mjs --app <X.app>   # 用打包 .app 跑同一套
//
// 五条 AC 逐条钉成断言：
//   AC1 up 等全部节点 health 就绪后才成功退出
//   AC2 status 展示节点、端口和进程实际状态
//   AC3 doctor 检查 Node / 端口 / 数据目录 / 基础节点配置，故障给出可操作诊断
//   AC4 down 优雅退出全部节点且不残留 Electron / Node 进程
//   AC5 命令失败返回非零状态，GUI 启动失败时也有可操作说明
//
// 手法：全程只经 `scripts/hive.mjs` 这个真 CLI（子进程 + 退出码 + stdout），
// 不 import launcher 内部函数 —— 验的是「用户敲的那条命令」而不是实现。
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createChecker } from './lib/hive-rig.mjs'
import { portOwners, sleep } from './lib/hive-proc.mjs'

const execFileAsync = promisify(execFile)
const argv = process.argv.slice(2)
const appPathRaw = argv.includes('--app') ? argv[argv.indexOf('--app') + 1] : null
const appPath = appPathRaw ? resolve(process.cwd(), appPathRaw) : null
const keep = argv.includes('--keep')
const REPO = resolve(import.meta.dirname, '..')

const checker = createChecker()
const { check } = checker

// 与 #44/#45 的 rig 端口错开，避免两条验收并行时互相踩。
const PORTS = { gui: 18678, memberA: 18778, memberB: 18878 }

let root = null
let configPath = null
let upRan = false

function writeConfig(nodes, extra = {}) {
  const config = { dataRoot: join(root, 'data'), app: appPath, nodes, ...extra }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

/** 跑 CLI，返回 { code, stdout, stderr, all }。永不抛（非零退出是要断言的事实）。 */
async function hive(args, { timeout = 180000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(REPO, 'scripts', 'hive.mjs'), ...args], {
      cwd: REPO,
      timeout,
      maxBuffer: 16 * 1024 * 1024
    })
    return { code: 0, stdout, stderr, all: `${stdout}${stderr}` }
  } catch (err) {
    const stdout = err.stdout ?? ''
    const stderr = err.stderr ?? ''
    return { code: err.code ?? -1, stdout, stderr, all: `${stdout}${stderr}`, error: err }
  }
}

async function healthOf(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(2000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** 从 up 的输出里抠出各节点实际 api 端口（api:0 时只有运行时才知道）。 */
function apiPortsFromUp(stdout) {
  const ports = {}
  for (const line of stdout.split('\n')) {
    const m = /✓ (\S+) 就绪 nodeId=\S+ api=(\d+)/.exec(line)
    if (m) ports[m[1]] = Number(m[2])
  }
  return ports
}

function portsFreeOf(list) {
  return list.filter((p) => portOwners(p).length > 0)
}

async function main() {
  root = mkdtempSync(join(tmpdir(), 'hive-ops-e2e-'))
  configPath = join(root, 'hive.config.json')
  const dataRoot = join(root, 'data')
  const dataDirs = Object.fromEntries(Object.keys(PORTS).map((id) => [id, join(dataRoot, id)]))

  console.log(`临时环境：${root}`)
  console.log(`可执行文件：${appPath ?? `${REPO}/vendor/teahouse/out（dev 构建产物）`}`)

  // 预检：本套端口必须空闲，否则断言会读到上一轮残留节点的 health。
  const busy = portsFreeOf(Object.values(PORTS))
  check('AC1 预检：验收端口空闲', busy.length === 0, busy.length ? `被占用：${busy.join(', ')}` : '')
  if (busy.length > 0) throw new Error('端口被占用，先清掉残留节点')

  const nodes = [
    { id: 'gui', gui: true, nick: 'Hive Ops GUI', udp: PORTS.gui, tcp: PORTS.gui + 1 },
    { id: 'memberA', nick: '成员 A', udp: PORTS.memberA, tcp: PORTS.memberA + 1 },
    { id: 'memberB', nick: '成员 B', udp: PORTS.memberB, tcp: PORTS.memberB + 1 }
  ]
  writeConfig(nodes)

  // ---------- AC3：doctor 先跑一遍（干净环境应当全绿） ----------
  const doctorClean = await hive(['-c', configPath, 'doctor'])
  check('AC3 干净环境 doctor 退出码 0', doctorClean.code === 0, `exit=${doctorClean.code}`)
  check('AC3 doctor 检查 Node 版本', /Node 运行时/.test(doctorClean.all))
  check('AC3 doctor 检查端口可用性', /端口可用：gui\.udp/.test(doctorClean.all))
  check('AC3 doctor 检查数据目录可写', /数据目录可写：gui/.test(doctorClean.all))
  check('AC3 doctor 检查基础节点配置', /配置至少有一个 GUI 节点/.test(doctorClean.all))
  check(
    'AC3 doctor 划出范围外项（不假装全绿）',
    /本轮范围外/.test(doctorClean.all) && /PANTRY_AGENT_COMMAND/.test(doctorClean.all)
  )

  // ---------- AC1：up 等全部节点就绪后才成功退出 ----------
  const upStarted = Date.now()
  const upRes = await hive(['-c', configPath, 'up', '--timeout', '90000'])
  const upElapsed = Date.now() - upStarted
  check('AC1 up 成功退出（exit 0）', upRes.code === 0, `exit=${upRes.code} elapsed=${upElapsed}ms`)
  if (upRes.code !== 0) {
    console.error(upRes.all)
    throw new Error('up 失败，后续断言无意义')
  }
  upRan = true

  const apiPorts = apiPortsFromUp(upRes.stdout)
  check(
    'AC1 up 为每个节点打印就绪行（含实际 api 端口）',
    Object.keys(apiPorts).length === nodes.length,
    JSON.stringify(apiPorts)
  )

  // 核心断言：up **返回的那一刻** 每个节点的 health 立刻可用 —— 这才叫「等就绪才退出」。
  const readyAtExit = []
  for (const [id, port] of Object.entries(apiPorts)) {
    try {
      const view = await healthOf(port)
      readyAtExit.push({ id, ok: view.net?.ok === true && view.nodeId?.length > 0, view })
    } catch (err) {
      readyAtExit.push({ id, ok: false, err: String(err.message ?? err) })
    }
  }
  check(
    'AC1 up 返回瞬间全部节点 health 已就绪（无需再等）',
    readyAtExit.every((r) => r.ok),
    JSON.stringify(readyAtExit.map((r) => ({ id: r.id, ok: r.ok, err: r.err })))
  )
  check(
    'AC1 就绪节点的 nodeId 两两不同（userData 隔离生效）',
    new Set(readyAtExit.map((r) => r.view?.nodeId)).size === nodes.length,
    JSON.stringify(readyAtExit.map((r) => r.view?.nodeId))
  )
  check(
    'AC1 health 报出的端口与配置一致',
    readyAtExit.every((r) => r.view?.ports?.udp === PORTS[r.id] && r.view?.ports?.tcp === PORTS[r.id] + 1),
    JSON.stringify(readyAtExit.map((r) => r.view?.ports))
  )

  // 节点身份/数据目录：每个节点在自己的 PANTRY_USER_DATA 下建了 identity.json
  check(
    'AC1 每节点在独立数据目录里落了 identity.json',
    Object.values(dataDirs).every((dir) => existsSync(join(dir, 'identity.json')))
  )
  // 残缺 config 会让节点 health 可用但发现不到对端（#44 landmine 1）—— up 的就绪判定必须挡住它。
  check(
    'AC1 就绪判定含 net.ok（挡住残缺 config 的静默发现失败）',
    readyAtExit.every((r) => r.view?.net?.ok === true),
    JSON.stringify(readyAtExit.map((r) => r.view?.net))
  )

  // ---------- AC2：status 展示节点、端口与进程实际状态 ----------
  const statusRes = await hive(['-c', configPath, 'status'])
  check('AC2 status 退出码 0（全部就绪）', statusRes.code === 0, `exit=${statusRes.code}`)
  check('AC2 status 列出全部节点', nodes.every((n) => statusRes.all.includes(n.id)))
  check('AC2 status 打印角色（GUI/headless）', /GUI/.test(statusRes.all) && /headless/.test(statusRes.all))
  check('AC2 status 打印进程 pid 与运行态', /运行中/.test(statusRes.all) && /\d+ 运行中/.test(statusRes.all))
  check(
    'AC2 status 打印端口 udp/tcp/api',
    nodes.every((n) => statusRes.all.includes(`${n.udp}/${n.udp + 1}/`)),
    ''
  )
  check('AC2 status 报就绪数与 nodeId', /3\/3 就绪/.test(statusRes.all) && /nodeId=/.test(statusRes.all))

  const statusJson = await hive(['-c', configPath, 'status', '--json'])
  let parsed = null
  try {
    parsed = JSON.parse(statusJson.stdout)
  } catch {
    /* 断言会失败 */
  }
  check(
    'AC2 status --json 可被脚本消费',
    parsed?.total === 3 && parsed?.ready === 3 && parsed.nodes.every((n) => n.alive === true && n.pid > 0),
    JSON.stringify(parsed?.nodes?.map((n) => ({ id: n.id, pid: n.pid, alive: n.alive, ready: n.ready })))
  )

  // status 要报「实际」状态：杀掉一个节点后，它必须改口，而不是继续报就绪。
  const victim = parsed?.nodes?.find((n) => n.id === 'memberB')
  if (victim?.pid) {
    execFileSync('kill', ['-9', String(victim.pid)])
    await sleep(800)
    const statusAfterKill = await hive(['-c', configPath, 'status'])
    check(
      'AC2 节点被杀后 status 改报异常并非零退出',
      statusAfterKill.code !== 0 && /异常|已退出/.test(statusAfterKill.all),
      `exit=${statusAfterKill.code}`
    )
    check(
      'AC2 status 对失联节点给出可操作线索（数据目录/端口归属）',
      /数据目录：|端口被 pid/.test(statusAfterKill.all),
      ''
    )
  }

  // ---------- AC4：down 优雅退出全部节点且无残留 ----------
  const downRes = await hive(['-c', configPath, 'down'])
  check('AC4 down 退出码 0', downRes.code === 0, `exit=${downRes.code}`)
  check('AC4 down 对每个存活节点走了优雅退出通道', /已发优雅退出请求/.test(downRes.all))
  check('AC4 down 报告无残留', /无残留/.test(downRes.all))

  // 进程侧证明：没有 Electron / Node 残留，端口全空。
  const leftoverPids = []
  for (const [id, port] of Object.entries(apiPorts)) {
    const owners = portOwners(port)
    if (owners.length > 0) leftoverPids.push(`${id}.api=${port}(pid ${owners[0].pid})`)
  }
  const stillBound = [
    ...portsFreeOf([PORTS.gui, PORTS.gui + 1, PORTS.memberA, PORTS.memberA + 1, PORTS.memberB, PORTS.memberB + 1])
  ]
  check('AC4 down 后所有节点端口已释放', leftoverPids.length === 0 && stillBound.length === 0, JSON.stringify({ leftoverPids, stillBound }))
  const electronLeft = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => /Hive|electron/i.test(line) && line.includes(dataRoot))
  check('AC4 down 后无残留 Electron/Node 进程（按数据目录认领）', electronLeft.length === 0, electronLeft.join(' | '))

  const stateFile = join(dataRoot, 'launcher-state.json')
  check('AC4 down 清掉状态文件', !existsSync(stateFile))

  // down 幂等：再跑一次不应报错。
  const downAgain = await hive(['-c', configPath, 'down'])
  check('AC4 down 可重复执行（幂等）', downAgain.code === 0, `exit=${downAgain.code}`)

  // ---------- AC3 续：doctor 对故障给出可操作诊断 ----------
  // 故障 1：端口被占（占位进程占住 gui.udp 与 gui.tcp）。
  const squatter = execFile(
    process.execPath,
    [
      '-e',
      `require('node:dgram').createSocket('udp4').bind(${PORTS.gui},'127.0.0.1');
       require('node:net').createServer().listen(${PORTS.gui + 1},'127.0.0.1');`
    ],
    { stdio: 'ignore' }
  )
  await sleep(900)
  const doctorBusy = await hive(['-c', configPath, 'doctor'])
  check('AC3 端口被占时 doctor 非零退出', doctorBusy.code !== 0, `exit=${doctorBusy.code}`)
  check(
    'AC3 doctor 报出占用者 pid 并给处置建议',
    /被 pid \d+/.test(doctorBusy.all) && /lsof -nP/.test(doctorBusy.all),
    ''
  )
  squatter.kill('SIGKILL')
  await sleep(500)

  // 故障 2：app 路径不存在（GUI 起不来）→ 非零退出 + 可操作说明。
  writeConfig(nodes, { app: join(root, 'nope', 'Missing.app') })
  const badApp = await hive(['-c', configPath, 'doctor'])
  check('AC5 app 路径不存在时 doctor 非零退出', badApp.code !== 0, `exit=${badApp.code}`)
  check(
    'AC5 诊断给出可操作说明（doctor 的 → 提示指回配置/构建）',
    /可执行文件就位/.test(badApp.all) &&
      /→ .*(hive\.config\.json|pnpm run build)/.test(badApp.all) &&
      /doctor 发现 \d+ 项故障/.test(badApp.all),
    ''
  )

  const upBadApp = await hive(['-c', configPath, 'up', '--timeout', '15000'])
  check('AC5 GUI 起不来时 up 非零退出', upBadApp.code !== 0, `exit=${upBadApp.code}`)
  check(
    'AC5 up 失败时给出可操作说明',
    /错误：/.test(upBadApp.all) && /建议：/.test(upBadApp.all),
    ''
  )

  // 故障 3：配置本身非法（端口冲突）→ 配置校验挡在最前面。
  writeConfig([{ id: 'a', udp: 19978, tcp: 19979 }, { id: 'b', udp: 19978, tcp: 19980 }], { app: null })
  const badConfig = await hive(['-c', configPath, 'up'])
  check('AC5 配置端口冲突时非零退出', badConfig.code !== 0, `exit=${badConfig.code}`)
  check('AC5 端口冲突诊断点名两个节点', /端口冲突/.test(badConfig.all) && /a\.udp/.test(badConfig.all) && /b/.test(badConfig.all))

  // 故障 4：未知命令 / 配置文件缺失 → 非零。
  const badCmd = await hive(['-c', configPath, 'frobnicate'])
  check('AC5 未知命令非零退出并给用法', badCmd.code !== 0 && /用法：/.test(badCmd.all), `exit=${badCmd.code}`)
  const noConfig = await hive(['-c', join(root, 'absent.json'), 'status'])
  check(
    'AC5 配置文件缺失非零退出并给出补救命令',
    noConfig.code !== 0 && /cp hive\.config\.example\.json/.test(noConfig.all),
    `exit=${noConfig.code}`
  )

  // ---------- AC1 续：up 失败必须回滚，不留半拉环境 ----------
  // 一个节点好、一个节点坏。坏法必须是**通过端口预检、死在启动期**的：
  // 把 memberB 的数据目录路径提前做成一个普通文件，mkdirSync 就会 ENOTDIR。
  // （端口冲突那一类会被配置/预检挡在前面，验不到回滚路径。）
  rmSync(join(dataRoot, 'memberB'), { recursive: true, force: true })
  writeFileSync(join(dataRoot, 'memberB'), 'not a directory\n')
  writeConfig(
    [
      { id: 'gui', gui: true, nick: 'GUI', udp: PORTS.gui, tcp: PORTS.gui + 1 },
      { id: 'memberB', nick: 'B', udp: PORTS.memberB, tcp: PORTS.memberB + 1 }
    ],
    { app: null }
  )
  const partial = await hive(['-c', configPath, 'up', '--timeout', '20000'])
  check('AC1 有节点起不来时 up 非零退出', partial.code !== 0, `exit=${partial.code}`)
  check(
    'AC1 up 失败时回滚已启动节点',
    /回滚全部已启动节点|回滚/.test(partial.all) && /memberB/.test(partial.all),
    ''
  )
  const partialPorts = portsFreeOf([PORTS.gui, PORTS.gui + 1])
  check('AC1 回滚后没有半拉环境残留', partialPorts.length === 0, JSON.stringify(partialPorts))
  rmSync(join(dataRoot, 'memberB'), { force: true })

  // 清理：确保没有遗留状态文件让后续跑误判。
  rmSync(join(dataRoot, 'launcher-state.json'), { force: true })
}

main()
  .then(() => {
    console.log(`\n${checker.summary()}`)
    if (keep) console.log(`临时环境保留在 ${root}`)
    else if (root) rmSync(root, { recursive: true, force: true })
    process.exit(checker.failures === 0 ? 0 : 1)
  })
  .catch(async (err) => {
    console.error(`\nOPS E2E ERROR: ${err?.stack ?? err}`)
    // 兜底收尾：别把演示机留在半拉状态。
    if (upRan) await hive(['-c', configPath, 'down']).catch(() => undefined)
    if (root && !keep) rmSync(root, { recursive: true, force: true })
    process.exit(1)
  })
