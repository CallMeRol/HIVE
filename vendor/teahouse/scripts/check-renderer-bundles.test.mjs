import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRendererBundles } from './check-renderer-bundles.mjs'

const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createFixture(transform = (manifest) => manifest) {
  const outDir = mkdtempSync(join(tmpdir(), 'pantry-renderer-bundles-'))
  roots.push(outDir)
  const manifest = transform({
    'src/main.ts': {
      file: 'assets/bootstrap.js',
      src: 'src/main.ts',
      isEntry: true,
      imports: ['_vendor.js'],
      dynamicImports: [
        'src/App.vue',
        'src/SettingsApp.vue',
        'src/CaptureApp.vue',
        'src/ImageViewerApp.vue',
        'src/RemoteViewApp.vue'
      ]
    },
    '_vendor.js': { file: 'assets/vendor.js' },
    'src/App.vue': {
      file: 'assets/App.js',
      src: 'src/App.vue',
      isDynamicEntry: true,
      imports: ['_shared.js'],
      css: ['assets/App.css']
    },
    'src/SettingsApp.vue': {
      file: 'assets/SettingsApp.js',
      src: 'src/SettingsApp.vue',
      isDynamicEntry: true,
      imports: ['_shared.js']
    },
    'src/CaptureApp.vue': {
      file: 'assets/CaptureApp.js',
      src: 'src/CaptureApp.vue',
      isDynamicEntry: true
    },
    'src/ImageViewerApp.vue': {
      file: 'assets/ImageViewerApp.js',
      src: 'src/ImageViewerApp.vue',
      isDynamicEntry: true
    },
    'src/RemoteViewApp.vue': {
      file: 'assets/RemoteViewApp.js', src: 'src/RemoteViewApp.vue', isDynamicEntry: true
    },
    '_shared.js': { file: 'assets/shared.js', css: ['assets/shared.css'] }
  })

  mkdirSync(join(outDir, '.vite'), { recursive: true })
  mkdirSync(join(outDir, 'assets'), { recursive: true })
  writeFileSync(join(outDir, '.vite', 'manifest.json'), JSON.stringify(manifest))
  for (const item of Object.values(manifest)) {
    if (item.file) writeFileSync(join(outDir, item.file), 'x'.repeat(item.file.includes('vendor') ? 80 : 20))
    for (const css of item.css ?? []) writeFileSync(join(outDir, css), 'x'.repeat(css.includes('shared') ? 7 : 5))
  }
  return { outDir, manifest }
}

describe('checkRendererBundles', () => {
  it('五个动态入口独立可达且公共启动闭包未超限时通过', () => {
    const { outDir } = createFixture()

    expect(checkRendererBundles({ outDir, maxBootstrapBytes: 200 })).toEqual({
      errors: [],
      bootstrapBytes: 100,
      roots: {
        'App.vue': { js: 140, css: 12 },
        'SettingsApp.vue': { js: 140, css: 7 },
        'CaptureApp.vue': { js: 120, css: 0 },
        'ImageViewerApp.vue': { js: 120, css: 0 },
        'RemoteViewApp.vue': { js: 120, css: 0 }
      }
    })
  })

  it('报告缺失的根组件动态入口', () => {
    const { outDir } = createFixture((manifest) => {
      delete manifest['src/CaptureApp.vue']
      return manifest
    })

    expect(checkRendererBundles({ outDir, maxBootstrapBytes: 200 }).errors.join('\n'))
      .toContain('CaptureApp.vue')
  })

  it('报告多个根组件复用同一输出文件', () => {
    const { outDir } = createFixture((manifest) => {
      manifest['src/CaptureApp.vue'].file = 'assets/SettingsApp.js'
      return manifest
    })

    expect(checkRendererBundles({ outDir, maxBootstrapBytes: 200 }).errors.join('\n'))
      .toContain('输出文件必须互异')
  })

  it('报告从公共入口不可达的动态根组件', () => {
    const { outDir } = createFixture((manifest) => {
      manifest['src/main.ts'].dynamicImports = manifest['src/main.ts'].dynamicImports
        .filter((key) => !key.endsWith('ImageViewerApp.vue'))
      return manifest
    })

    expect(checkRendererBundles({ outDir, maxBootstrapBytes: 200 }).errors.join('\n'))
      .toContain('ImageViewerApp.vue 动态入口从公共入口不可达')
  })

  it('报告公共启动静态依赖闭包超过预算', () => {
    const { outDir } = createFixture()

    const result = checkRendererBundles({ outDir, maxBootstrapBytes: 99 })
    expect(result.bootstrapBytes).toBe(100)
    expect(result.errors.join('\n')).toContain('超过 99 字节预算')
  })

  it('按窗口统计完整静态闭包并对共享依赖去重', () => {
    const { outDir } = createFixture()

    const result = checkRendererBundles({ outDir })
    expect(result.roots['App.vue']).toEqual({ js: 140, css: 12 })
  })

  it('报告窗口完整静态 JS 与 CSS 闭包超过预算', () => {
    const { outDir } = createFixture()

    const result = checkRendererBundles({
      outDir,
      rootBudgets: { 'App.vue': { js: 139, css: 11 } }
    })
    expect(result.errors.join('\n')).toContain('App.vue 完整静态 JS 闭包 140 字节，超过 139 字节预算')
    expect(result.errors.join('\n')).toContain('App.vue 完整静态 CSS 闭包 12 字节，超过 11 字节预算')
  })

  it('报告静态依赖闭包中的缺失文件', () => {
    const { outDir } = createFixture()
    rmSync(join(outDir, 'assets/vendor.js'))

    expect(checkRendererBundles({ outDir, maxBootstrapBytes: 200 }).errors.join('\n'))
      .toContain('assets/vendor.js 不存在')
  })

  it('报告 manifest 缺失', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pantry-renderer-bundles-missing-'))
    roots.push(outDir)

    expect(checkRendererBundles({ outDir }).errors.join('\n')).toContain('manifest.json 不存在')
  })
})
