// 把 `src/main/acp/` 的**裸 .mjs** 复制到构建产物 `out/main/acp/`（#52 补 #46 的缺口）。
//
// 为什么需要这一步：runner.mjs / fake-acp-agent.mjs 是**面向系统 node ≥22 的可执行脚本**，
// 不是要被 electron-vite 编译的 TS 源码 —— 它们必须保持 .mjs 原样（在 Electron 22 的
// Node 16.17 主进程里既不能 import 也不能执行）。electron-vite 只处理 .ts，所以这两个
// 文件既不会被编译、也不会被复制，导致 `AcpRunner.start()` 在**任何真节点**上都报
// 「找不到 runner 入口：out/main/acp/runner.mjs」—— #46 的 40 项断言全在 scripts/acp-smoke.mjs
// 里直接跑源码，从未经过真实节点，因此这个缺口当时没被任何断言覆盖（已实测复现）。
//
// 纪律：本脚本只做复制，不改写内容；源与目标是同一份字节。
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src', 'main', 'acp')
const dest = join(root, 'out', 'main', 'acp')
// 打包产物在 out/ 之下（electron-builder 的 files 白名单是 `out/**`），
// 所以这一步同时覆盖 dev、build 与打包三条路径。
const RUNTIME_FILES = ['runner.mjs', 'fake-acp-agent.mjs']

if (!existsSync(src)) {
  console.error(`[copy-acp-runtime] 源目录不存在：${src}`)
  process.exit(1)
}
mkdirSync(dest, { recursive: true })

let copied = 0
for (const name of RUNTIME_FILES) {
  const from = join(src, name)
  if (!existsSync(from)) {
    // 缺文件是显式失败：静默跳过会让「找不到 runner 入口」在运行时才暴露。
    console.error(`[copy-acp-runtime] 缺少运行时文件：${from}`)
    process.exit(1)
  }
  cpSync(from, join(dest, name))
  copied += 1
}
// 产物目录里不该混入源树里的 .ts（它们已被编译进 index.js）。
const strays = readdirSync(dest).filter((name) => name.endsWith('.ts'))
if (strays.length > 0) console.warn(`[copy-acp-runtime] 产物目录含 .ts（应为编译产物，请检查）：${strays.join(', ')}`)
console.log(`[copy-acp-runtime] ${copied} 个运行时文件 → ${dest}`)
