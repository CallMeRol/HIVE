import { describe, expect, it } from 'vitest'
import { avatarHashFromUrl, avatarImageUrl } from './avatar-url'

describe('受管头像 URL', () => {
  const hash = 'a'.repeat(64)

  it('使用固定短主机名和单段哈希路径往返', () => {
    const url = avatarImageUrl(hash, 3)
    expect(url).toBe(`pantry-avatar://asset/${hash}?v=3`)
    expect(new URL(url).hostname).toBe('asset')
    expect(avatarHashFromUrl(url)).toBe(hash)
  })

  it('拒绝旧的 64 字符主机名及路径逃逸和非法哈希', () => {
    expect(avatarHashFromUrl(`pantry-avatar://${hash}`)).toBeNull()
    expect(avatarHashFromUrl(`pantry-avatar://asset/${hash}/extra`)).toBeNull()
    expect(avatarHashFromUrl('pantry-avatar://asset/../secret')).toBeNull()
    expect(avatarHashFromUrl(`pantry-img://asset/${hash}`)).toBeNull()
    expect(avatarImageUrl('invalid')).toBe('')
  })
})
