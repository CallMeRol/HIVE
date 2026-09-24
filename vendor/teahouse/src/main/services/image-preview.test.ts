import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImagePreviewService } from './image-preview'

const roots: string[] = []

function putAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  putAscii(bytes, 12, 'IHDR')
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes[24] = 8
  bytes[25] = 6
  return bytes
}

function webp(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(30)
  putAscii(bytes, 0, 'RIFF')
  putAscii(bytes, 8, 'WEBP')
  putAscii(bytes, 12, 'VP8X')
  const view = new DataView(bytes.buffer)
  view.setUint32(4, 22, true)
  view.setUint32(16, 10, true)
  bytes[20] = animated ? 0x02 : 0
  let w = width - 1
  let h = height - 1
  for (let i = 0; i < 3; i++) {
    bytes[24 + i] = w & 0xff
    bytes[27 + i] = h & 0xff
    w >>= 8
    h >>= 8
  }
  return bytes
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function cachedPath(root: string, transferId: string): string {
  const key = createHash('sha256').update(transferId).digest('hex')
  return join(root, `${key}.webp`)
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teahouse-image-preview-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('图片预览与派生缓存', () => {
  it('按真实格式、扩展名和像素门禁分类本地图片', async () => {
    const root = await tempRoot()
    const service = new ImagePreviewService(join(root, 'thumbs'))
    const valid = join(root, 'valid.png')
    const spoofed = join(root, 'spoofed.jpg')
    const oversized = join(root, 'oversized.png')
    await writeFile(valid, png(1920, 1080))
    await writeFile(spoofed, png(1920, 1080))
    await writeFile(oversized, png(8193, 100))

    expect(await service.inspectInlinePath(valid)).toMatchObject({ width: 1920, height: 1080 })
    expect(await service.inspectInlinePath(spoofed)).toBeNull()
    expect(await service.inspectInlinePath(oversized)).toBeNull()
  })

  it('只接受最长边不超过 320px、1MiB 内的静态 WebP，并使用哈希文件名', async () => {
    const root = await tempRoot()
    const thumbs = join(root, 'thumbs')
    const service = new ImagePreviewService(thumbs)

    expect(await service.cacheThumbnail('transfer-a', exactBuffer(webp(320, 180)))).toBe(true)
    expect(await service.cacheThumbnail('transfer-b', exactBuffer(webp(321, 180)))).toBe(false)
    expect(await service.cacheThumbnail('transfer-c', exactBuffer(webp(320, 180, true)))).toBe(false)
    expect(await service.cacheThumbnail('transfer-d', new ArrayBuffer(1024 * 1024 + 1))).toBe(false)
    expect(await service.hasThumbnail('transfer-a')).toBe(true)
    expect(await readdir(thumbs)).toEqual([
      `${createHash('sha256').update('transfer-a').digest('hex')}.webp`
    ])
  })

  it('超过预算时按最近访问时间删除旧缩略图', async () => {
    const root = await tempRoot()
    const thumbs = join(root, 'thumbs')
    const service = new ImagePreviewService(thumbs, { maxCacheBytes: 60, touchIntervalMs: 0 })
    const bytes = exactBuffer(webp(320, 180))
    await service.cacheThumbnail('a', bytes)
    await service.cacheThumbnail('b', bytes)
    const aPath = cachedPath(thumbs, 'a')
    const bPath = cachedPath(thumbs, 'b')
    await utimes(aPath, new Date(1000), new Date(1000))
    await utimes(bPath, new Date(2000), new Date(2000))
    await service.hasThumbnail('a')
    await service.cacheThumbnail('c', bytes)

    await expect(stat(aPath)).resolves.toBeDefined()
    await expect(stat(bPath)).rejects.toThrow()
    await expect(stat(cachedPath(thumbs, 'c'))).resolves.toBeDefined()
  })
})
