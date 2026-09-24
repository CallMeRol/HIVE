import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function readPngHeader(path: URL): { width: number; height: number; bitDepth: number; colorType: number } {
  const png = readFileSync(path)
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25]
  }
}

const componentText = readFileSync(new URL('../components/PantryBrandLogo.vue', import.meta.url), 'utf8')
const appScriptText = readFileSync(new URL('../../../../scripts/gen-app-icons.mjs', import.meta.url), 'utf8')
const trayScriptText = readFileSync(new URL('../../../../scripts/gen-tray-icon.mjs', import.meta.url), 'utf8')
const readmeText = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8')

describe('品牌位图图标链路', () => {
  it('应用母版与渲染层资源均为方形 RGBA PNG', () => {
    expect(readPngHeader(new URL('../../../../build/icons/pantry-logo-icon-master.png', import.meta.url))).toEqual({
      width: 1024,
      height: 1024,
      bitDepth: 8,
      colorType: 6
    })
    expect(readPngHeader(new URL('../assets/brand/hive-app-icon.png', import.meta.url))).toEqual({
      width: 256,
      height: 256,
      bitDepth: 8,
      colorType: 6
    })
  })

  it('界面彩色品牌位和 README 统一使用新位图', () => {
    expect(componentText).toContain("hive-app-icon.png?url")
    expect(componentText).not.toContain('pantry-mark.svg?url')
    // mono 变体也统一走 Hive 位图，不再引用上游绿色轮廓 SVG
    expect(componentText).not.toContain('icon-macos-menubar-outline.svg')
    expect(readmeText).toContain('build/icons/pantry-logo-icon.png')
    expect(readmeText).not.toContain('build/icons/pantry-logo-icon.svg')
  })

  it('平台图标与彩色托盘都从位图母版生成', () => {
    expect(appScriptText).toContain("pantry-logo-icon-master.png")
    expect(appScriptText).toContain("hive-app-icon.png")
    expect(appScriptText).toContain("['-z', '256', '256'")
    expect(appScriptText).not.toContain("pantry-logo-icon.svg')")
    expect(trayScriptText).toContain("pantry-logo-icon.png")
    // 单色托盘源改为 Hive 位图派生，不再依赖上游绿色剪影 SVG
    expect(trayScriptText).toContain("hive-tray-mono.png")
    expect(trayScriptText).not.toContain("pantry-logo-mono.svg")
    expect(trayScriptText).not.toContain("pantry-logo-menu.svg")
  })
})
