import { isAvatarHash } from './protocol'

const AVATAR_SCHEME = 'pantry-avatar:'
const AVATAR_HOST = 'asset'

/**
 * 受管头像只把短常量放在主机名中，64 位 SHA-256 放到路径。
 * Chromium 会按主机规则预解析 `scheme://host`，哈希直接作 host 时可能在协议处理前失败。
 */
export function avatarImageUrl(hash: string, version = 0): string {
  if (!isAvatarHash(hash)) return ''
  const safeVersion = Number.isSafeInteger(version) && version >= 0 ? version : 0
  return `${AVATAR_SCHEME}//${AVATAR_HOST}/${hash}?v=${safeVersion}`
}

/** 主进程自定义协议入口的严格反向解析；只接受固定 host 与单段合法哈希路径。 */
export function avatarHashFromUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (
      url.protocol !== AVATAR_SCHEME ||
      url.hostname !== AVATAR_HOST ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null
    }
    const match = /^\/([a-f0-9]{64})$/.exec(url.pathname)
    return match && isAvatarHash(match[1]) ? match[1] : null
  } catch {
    return null
  }
}
