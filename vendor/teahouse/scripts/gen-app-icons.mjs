// 生成全套应用图标（决议 #64/#226，Hive 品牌母版）：以 1024x1024 RGBA 品牌位图母版为唯一彩色源，
// 再出 Windows .ico（BMP 格式，兼容 Win7）、macOS .icns，并链式重生成 Linux 多尺寸
// hicolor 图标与窗口图标。改 logo：替换母版后运行 `node scripts/gen-app-icons.mjs`。
// 依赖：开发依赖 png2icons（纯 JS，零 native）；Linux 尺寸生成复用系统 sips。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import png2icons from 'png2icons'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'build/icons')
const master = join(dir, 'pantry-logo-icon-master.png')
const png = join(dir, 'pantry-logo-icon.png')
const rendererPng = join(root, 'src/renderer/src/assets/brand/hive-app-icon.png')

// 母版必须自带 alpha，防止打包后出现生图底色或非方形拉伸。
const input = readFileSync(master)
const signature = input.subarray(0, 8).toString('hex')
const width = input.readUInt32BE(16)
const height = input.readUInt32BE(20)
const bitDepth = input[24]
const colorType = input[25]
if (signature !== '89504e470d0a1a0a' || width !== 1024 || height !== 1024 || bitDepth !== 8 || colorType !== 6) {
  throw new Error(
    `图标母版必须是 1024x1024、8-bit RGBA PNG，当前为 ${width}x${height} bitDepth=${bitDepth} colorType=${colorType}`
  )
}
writeFileSync(png, input)

// Win7 对 PNG 压缩的 ico 大图支持不稳，用 BMP（usePNG=false）
writeFileSync(join(dir, 'pantry-logo-icon.ico'), png2icons.createICO(input, png2icons.BICUBIC, 0, false))
writeFileSync(join(dir, 'pantry-logo-icon.icns'), png2icons.createICNS(input, png2icons.BICUBIC, 0))
console.log('已生成 pantry-logo-icon.png(1024) / .ico / .icns')

// renderer 最大展示位为 92px；256px 保留高 DPI 余量，同时避免每个窗口解码 512px 位图。
execFileSync('sips', ['-z', '256', '256', master, '--out', rendererPng], { stdio: 'pipe' })
console.log('已生成 renderer 品牌图 hive-app-icon.png(256)')

// Linux 多尺寸 hicolor + 窗口图标（复用既有脚本，源就是上面这张 png）
execFileSync('node', [join(root, 'scripts/gen-linux-icons.mjs')], { stdio: 'inherit' })
