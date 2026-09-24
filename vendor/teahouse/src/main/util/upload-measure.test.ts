import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measureUploadPaths } from './upload-measure'

describe('文件柜上传体量测算（决议 #278）', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pantry-measure-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('统计单个文件', async () => {
    const file = join(root, 'a.txt')
    writeFileSync(file, 'hello') // 5 字节
    expect(await measureUploadPaths([file])).toEqual({ fileCount: 1, totalSize: 5 })
  })

  it('递归统计整棵目录树', async () => {
    mkdirSync(join(root, '设计稿', '2026'), { recursive: true })
    writeFileSync(join(root, '设计稿', 'a.txt'), 'aa')
    writeFileSync(join(root, '设计稿', '2026', 'b.txt'), 'bbb')
    writeFileSync(join(root, '设计稿', '2026', 'c.txt'), 'c')
    expect(await measureUploadPaths([join(root, '设计稿')])).toEqual({
      fileCount: 3,
      totalSize: 6
    })
  })

  it('多个入口路径累加', async () => {
    writeFileSync(join(root, 'a.txt'), 'a')
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'b.txt'), 'bb')
    expect(await measureUploadPaths([join(root, 'a.txt'), join(root, 'dir')])).toEqual({
      fileCount: 2,
      totalSize: 3
    })
  })

  it('空目录没有可传内容，返回 null', async () => {
    mkdirSync(join(root, 'empty'))
    expect(await measureUploadPaths([join(root, 'empty')])).toBeNull()
  })

  it('任意一条读不到就整体返回 null', async () => {
    writeFileSync(join(root, 'a.txt'), 'a')
    expect(await measureUploadPaths([join(root, 'a.txt'), join(root, '不存在')])).toBeNull()
  })

  it('空入口返回 null', async () => {
    expect(await measureUploadPaths([])).toBeNull()
  })

  it('超过批大小的目录也统计完整', async () => {
    // BATCH = 64，跨批推进的分支必须覆盖到
    const many = join(root, 'many')
    mkdirSync(many)
    for (let i = 0; i < 200; i++) writeFileSync(join(many, `f${i}.bin`), 'x')
    expect(await measureUploadPaths([many])).toEqual({ fileCount: 200, totalSize: 200 })
  })

  it('深度超过 32 层判失败，不无限递归', async () => {
    let deep = root
    for (let i = 0; i < 40; i++) deep = join(deep, `d${i}`)
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'x.txt'), 'x')
    expect(await measureUploadPaths([root])).toBeNull()
  })
})
