// 打包态路径解析的单测（#25）：两条映射都必须在**打包路径**与**开发路径**上同时成立。
import { describe, expect, it } from 'vitest'
import { ASAR_FILE, appCwdDir, isInsideAsar, unpackedPath } from './packaged-paths'

const PACKAGED_RESOURCES = '/Applications/Hive.app/Contents/Resources'
const ASAR = `${PACKAGED_RESOURCES}/${ASAR_FILE}`

describe('isInsideAsar', () => {
  it('asar 内的路径识别为真', () => {
    expect(isInsideAsar(`${ASAR}/out/main/acp/runner.mjs`)).toBe(true)
  })

  it('解包目录不算「asar 内」', () => {
    expect(isInsideAsar(`${ASAR}.unpacked/out/main/acp/runner.mjs`)).toBe(false)
  })

  it('开发态源码树不算 asar 内', () => {
    expect(isInsideAsar('/repo/vendor/teahouse/out/main/acp/runner.mjs')).toBe(false)
    expect(isInsideAsar('/repo/vendor/teahouse/app.asarfoo/x.mjs')).toBe(false)
  })
})

describe('unpackedPath', () => {
  it('asar 内路径映射到 app.asar.unpacked/', () => {
    expect(unpackedPath(`${ASAR}/out/main/acp/runner.mjs`)).toBe(
      `${ASAR}.unpacked/out/main/acp/runner.mjs`
    )
  })

  it('已是解包路径时原样返回（不迭加成 .unpacked.unpacked）', () => {
    const already = `${ASAR}.unpacked/out/main/acp/runner.mjs`
    expect(unpackedPath(already)).toBe(already)
  })

  it('非 asar 路径原样返回', () => {
    expect(unpackedPath('/usr/local/bin/node')).toBe('/usr/local/bin/node')
    expect(unpackedPath('/repo/vendor/teahouse/src/main/acp/runner.mjs')).toBe(
      '/repo/vendor/teahouse/src/main/acp/runner.mjs'
    )
  })
})

describe('appCwdDir', () => {
  it('打包态返回 .app 的 Resources 目录（asar 是文件，不能当 cwd）', () => {
    expect(appCwdDir({ isPackaged: true, appPath: ASAR })).toBe(PACKAGED_RESOURCES)
  })

  it('开发态返回源码树目录本身', () => {
    expect(appCwdDir({ isPackaged: false, appPath: '/repo/vendor/teahouse' })).toBe(
      '/repo/vendor/teahouse'
    )
  })
})
