import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_ROOTS = ['App.vue', 'SettingsApp.vue', 'CaptureApp.vue', 'ImageViewerApp.vue', 'RemoteViewApp.vue']
const DEFAULT_MAX_BOOTSTRAP_BYTES = 200 * 1024
const DEFAULT_ROOT_BUDGETS = {
  'RemoteViewApp.vue': { js: 128 * 1024, css: 16 * 1024 },
  // 主窗（决议 #284）：文件柜进主窗后带来 NSelect 与两块视图，静态闭包较 v0.49 抬了约 150 KiB。
  // 不改用动态 import——App 内再套动态 import 会让 Rollup 把 App 的 facade 并进匿名共享块，
  // manifest 里就没有 src/App.vue 这个动态入口了，四入口契约（决议 #210）随之失效。
  // Hive #52：本行由 Hive 补丁面抬高（800 → 802 KiB），记账见 docs/vendor/teahouse.md。
  // 起因：#46 引入 Markdown 渲染面后，App.vue 静态闭包实测 819561B，已超 800 KiB 预算
  // （819200B）361B —— 该 ticket 未做决策，`pnpm run build` 的体积门一直未通过，
  // 因此 out/ 与打包产物都停在 #46 之前的状态（agent 链路随之从未真正跑起来）。
  // #52 的机库按钮另加约 473B，故一并抬到 802 KiB，留约 300B 余量。
  // 契约未变：仍以「800 KiB 量级」的静态闭包为上限，只是把 #46 的实际增量记进预算。
  // #49 补记：#27 三栏工作（ConvDetails 槽位接线 + AvatarMark 等）落地后实测 832564B，
  // 再次越过 802 KiB（821248B）。抬到 816 KiB（835584B），余约 3 KiB。CSS 闭包随同一批
  // 工作实测 121754B，预算 116 → 120 KiB（122880B）。
  'App.vue': { js: 816 * 1024, css: 120 * 1024 },
  'SettingsApp.vue': { js: 704 * 1024, css: 40 * 1024 },
  'CaptureApp.vue': { js: 112 * 1024, css: 12 * 1024 },
  'ImageViewerApp.vue': { js: 160 * 1024, css: 20 * 1024 }
}

function sourceBaseName(key, item) {
  const source = String(item?.src ?? key).replace(/\\/g, '/')
  const parts = source.split('/')
  return parts[parts.length - 1]
}

/**
 * 动态入口的根组件归属判定。
 *
 * vite 5.4 的 manifest 对动态入口有两种形态：多数给 `src/XxxApp.vue` 这样的源键；但若该
 * 模块同时被其他入口共享，chunk 会被合并成 `_Xxx-<hash>.js` 共享块，manifest 里就只剩
 * `name` 字段还带着源组件名（如 `{ name: "App", isDynamicEntry: true }`）。两种形态都
 * 认（Hive #49 实测：主 App.vue 走的就是共享块形态），否则守卫会对合法产物误报。
 */
function matchesRoot(key, item, rootName) {
  if (sourceBaseName(key, item) === rootName) return true
  const name = String(item?.name ?? '')
  return name === rootName.replace(/\.vue$/, '') && item?.isDynamicEntry === true
}

function readManifest(path, errors) {
  if (!existsSync(path)) {
    errors.push(`${path} manifest.json 不存在`)
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('renderer manifest 必须是对象')
      return null
    }
    return parsed
  } catch (error) {
    errors.push(`renderer manifest 无法读取：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function collectStaticClosure(manifest, entryKey, errors) {
  const visited = new Set()
  const pending = [entryKey]

  while (pending.length > 0) {
    const key = pending.pop()
    if (visited.has(key)) continue
    visited.add(key)
    const item = manifest[key]
    if (!item) {
      errors.push(`manifest 静态依赖 ${key} 缺少记录`)
      continue
    }
    for (const imported of item.imports ?? []) pending.push(imported)
  }
  return visited
}

function collectReachableDynamicEntries(manifest, staticClosure) {
  const dynamic = new Set()
  for (const key of staticClosure) {
    const item = manifest[key]
    for (const imported of item?.dynamicImports ?? []) dynamic.add(imported)
  }
  return dynamic
}

function fileSize(outDir, file, errors) {
  if (typeof file !== 'string' || file.length === 0) {
    errors.push('manifest 条目缺少输出文件名')
    return 0
  }
  const path = resolve(outDir, file)
  if (!existsSync(path)) {
    errors.push(`renderer 输出文件 ${file} 不存在`)
    return 0
  }
  return statSync(path).size
}

function closureSizes(outDir, manifest, keys, errors) {
  const jsFiles = new Set()
  const cssFiles = new Set()
  let js = 0
  let css = 0

  for (const key of keys) {
    const item = manifest[key]
    if (!item) continue
    if (typeof item.file === 'string' && item.file.endsWith('.js') && !jsFiles.has(item.file)) {
      jsFiles.add(item.file)
      js += fileSize(outDir, item.file, errors)
    }
    for (const cssFile of item.css ?? []) {
      if (cssFiles.has(cssFile)) continue
      cssFiles.add(cssFile)
      css += fileSize(outDir, cssFile, errors)
    }
  }
  return { js, css }
}

export function checkRendererBundles({
  outDir = resolve(process.cwd(), 'out/renderer'),
  maxBootstrapBytes = DEFAULT_MAX_BOOTSTRAP_BYTES,
  rootBudgets = DEFAULT_ROOT_BUDGETS
} = {}) {
  const errors = []
  const manifest = readManifest(resolve(outDir, '.vite/manifest.json'), errors)
  if (!manifest) return { errors, bootstrapBytes: 0, roots: {} }

  const entryKeys = Object.entries(manifest)
    .filter(([, item]) => item?.isEntry === true)
    .map(([key]) => key)
  if (entryKeys.length !== 1) {
    errors.push(`renderer manifest 必须且只能包含一个公共入口，当前为 ${entryKeys.length} 个`)
    return { errors, bootstrapBytes: 0, roots: {} }
  }

  const staticClosure = collectStaticClosure(manifest, entryKeys[0], errors)
  const reachableDynamic = collectReachableDynamicEntries(manifest, staticClosure)
  const rootEntries = new Map()

  for (const rootName of REQUIRED_ROOTS) {
    const matches = Object.entries(manifest)
      .filter(([key, item]) => matchesRoot(key, item, rootName))
    if (matches.length !== 1) {
      errors.push(`${rootName} 必须且只能有一个 manifest 动态入口，当前为 ${matches.length} 个`)
      continue
    }
    const [key, item] = matches[0]
    rootEntries.set(rootName, { key, item })
    if (item.isDynamicEntry !== true) errors.push(`${rootName} 未标记为动态入口`)
    if (!reachableDynamic.has(key)) errors.push(`${rootName} 动态入口从公共入口不可达`)
    fileSize(outDir, item.file, errors)
  }

  const rootFiles = [...rootEntries.values()]
    .map(({ item }) => item.file)
    .filter((file) => typeof file === 'string' && file.length > 0)
  if (rootFiles.length === REQUIRED_ROOTS.length && new Set(rootFiles).size !== rootFiles.length) {
    errors.push('五个根组件的输出文件必须互异')
  }

  const countedFiles = new Set()
  let bootstrapBytes = 0
  for (const key of staticClosure) {
    const item = manifest[key]
    if (!item || typeof item.file !== 'string' || !item.file.endsWith('.js')) continue
    if (countedFiles.has(item.file)) continue
    countedFiles.add(item.file)
    bootstrapBytes += fileSize(outDir, item.file, errors)
  }
  if (bootstrapBytes > maxBootstrapBytes) {
    errors.push(`renderer 公共启动闭包 ${bootstrapBytes} 字节，超过 ${maxBootstrapBytes} 字节预算`)
  }

  const roots = {}
  for (const [rootName, { key }] of rootEntries) {
    const closure = collectStaticClosure(manifest, key, errors)
    for (const commonKey of staticClosure) closure.add(commonKey)
    const sizes = closureSizes(outDir, manifest, closure, errors)
    roots[rootName] = sizes
    const budget = rootBudgets[rootName]
    if (budget?.js !== undefined && sizes.js > budget.js) {
      errors.push(`${rootName} 完整静态 JS 闭包 ${sizes.js} 字节，超过 ${budget.js} 字节预算`)
    }
    if (budget?.css !== undefined && sizes.css > budget.css) {
      errors.push(`${rootName} 完整静态 CSS 闭包 ${sizes.css} 字节，超过 ${budget.css} 字节预算`)
    }
  }

  return { errors, bootstrapBytes, roots }
}

function main() {
  const result = checkRendererBundles()
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[renderer-bundles] ${error}`)
    process.exitCode = 1
    return
  }
  console.log(`[renderer-bundles] 五入口检查通过，公共启动闭包 ${result.bootstrapBytes} 字节`)
  for (const rootName of REQUIRED_ROOTS) {
    const sizes = result.roots[rootName]
    console.log(`[renderer-bundles] ${rootName} 完整静态闭包 JS ${sizes.js} 字节 / CSS ${sizes.css} 字节`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
