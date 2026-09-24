import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_DIR = dirname(fileURLToPath(import.meta.url))

/** runner.mjs / fake-acp-agent.mjs 是运行时 spawn 的静态脚本（非 bundle 入口），
 * electron-vite 不复制它们；构建后拷到 out/main/acp/（打包 files: out/** 自然带上，#50）。 */
function copyAcpScripts(): void {
  mkdirSync(join(CONFIG_DIR, 'out/main/acp'), { recursive: true })
  for (const f of ['runner.mjs', 'fake-acp-agent.mjs']) {
    copyFileSync(join(CONFIG_DIR, 'src/main/acp', f), join(CONFIG_DIR, 'out/main/acp', f))
  }
}

// 红线（README）：渲染层基线 Chrome 108，主进程/preload 基线 Node 16.17 —— Electron 22 焊死。
// 构建目标写死在这里，越线语法在编译期直接失败。
// externalizeDepsPlugin：依赖（尤其 native 的 better-sqlite3）不打进 bundle，运行时从 node_modules 加载。
export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      // runner.mjs 与 fake-acp-agent.mjs 是运行时 spawn 的静态脚本（非 bundle 入口），
      // electron-vite 不复制它们；构建后拷到 out/main/acp/（打包 files: out/** 自然带上，#50）。
      {
        name: 'hive-copy-acp-scripts',
        closeBundle() {
          copyAcpScripts()
        }
      }
    ],
    build: { target: 'node16' }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { target: 'node16' }
  },
  renderer: {
    build: { target: 'chrome108', manifest: true, minify: 'esbuild' },
    plugins: [
      vue(),
      {
        // onnxruntime-web 的 bundle 版用 new URL 触发 vite 又复制一份 ~11MB 的 wasm 到 assets/，
        // 但运行时我们用 env.wasm.wasmPaths 指向 public/ocr/ 那份（file:// 下最可靠，同 tesseract 机制），
        // assets/ 这份纯冗余，打包时删掉省体积。
        name: 'pantry-drop-bundled-ort-wasm',
        generateBundle(_options, bundle) {
          for (const fileName of Object.keys(bundle)) {
            if (/ort-wasm.*\.wasm$/.test(fileName)) delete bundle[fileName]
          }
        }
      }
    ]
  }
})
