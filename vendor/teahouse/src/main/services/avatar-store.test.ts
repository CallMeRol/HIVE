import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AVATAR_MAX_BYTES } from '../../shared/protocol'
import { AvatarStore, avatarHashOf, isValidAvatarBytes } from './avatar-store'

function putAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
}

function putU16le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >> 8) & 0xff
}

function putU32le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >> 8) & 0xff
  bytes[offset + 2] = (value >> 16) & 0xff
  bytes[offset + 3] = (value >> 24) & 0xff
}

function avatarWebp(width = 192, height = 192): Uint8Array {
  const bytes = new Uint8Array(30)
  putAscii(bytes, 0, 'RIFF')
  putU32le(bytes, 4, 22)
  putAscii(bytes, 8, 'WEBP')
  putAscii(bytes, 12, 'VP8 ')
  putU32le(bytes, 16, 10)
  bytes[23] = 0x9d
  bytes[24] = 0x01
  bytes[25] = 0x2a
  putU16le(bytes, 26, width)
  putU16le(bytes, 28, height)
  return bytes
}

describe('AvatarStore', () => {
  it('只接受 192×192 静态 WebP 与 32 KiB 大小门禁', () => {
    expect(isValidAvatarBytes(avatarWebp())).toBe(true)
    expect(isValidAvatarBytes(avatarWebp(191, 192))).toBe(false)
    expect(isValidAvatarBytes(new Uint8Array([1, 2, 3]))).toBe(false)
    expect(isValidAvatarBytes(new Uint8Array(AVATAR_MAX_BYTES + 1))).toBe(false)
  })

  it('按内容哈希保存、校验导入并清理无引用文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pantry-avatar-'))
    try {
      const store = new AvatarStore(root)
      const first = avatarWebp()
      const second = avatarWebp(192, 192)
      second[22] = 1
      const firstHash = avatarHashOf(first)
      const secondHash = avatarHashOf(second)

      expect(await store.save(first)).toBe(firstHash)
      expect(await store.import('f'.repeat(64), first)).toBe(false)
      expect(await store.import(secondHash, second)).toBe(true)
      expect(await store.has(firstHash)).toBe(true)
      expect(await readFile(join(root, `${firstHash}.webp`))).toEqual(Buffer.from(first))

      // 新鲜 .tmp 可能是并发原子写入的中间文件，prune 不得删除；陈旧 .tmp 才清理（决议 #248）
      await writeFile(join(root, 'fresh.tmp'), 'temp')
      const stale = join(root, 'stale.tmp')
      await writeFile(stale, 'temp')
      const past = new Date(Date.now() - 120_000)
      await utimes(stale, past, past)
      await store.prune([firstHash])
      expect((await readdir(root)).sort()).toEqual(['fresh.tmp', `${firstHash}.webp`].sort())

      // 被 prune 删除的哈希不得残留在已验证缓存中
      await store.prune([])
      expect(await store.has(firstHash)).toBe(false)
      expect(await store.read(firstHash)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
