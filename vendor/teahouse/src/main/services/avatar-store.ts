import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AVATAR_MAX_BYTES,
  AVATAR_OUTPUT_SIZE,
  isAvatarHash
} from '../../shared/protocol'
import { inspectImageMetadata } from '../../shared/image-metadata'

/** 头像文件的内容约束；网络、IPC、备份导入共用。 */
export function isValidAvatarBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) return false
  const metadata = inspectImageMetadata(bytes)
  return Boolean(
    metadata &&
      metadata.format === 'webp' &&
      !metadata.animated &&
      metadata.width === AVATAR_OUTPUT_SIZE &&
      metadata.height === AVATAR_OUTPUT_SIZE
  )
}

export function avatarHashOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `.tmp` 早于该时长才视为陈旧残留可清理；更新的可能是并发原子写入的中间文件（决议 #248）。 */
const TMP_STALE_MS = 60_000

/** 内容寻址的受管头像目录；不接受路径、文件名或远端声明作为读写目标。 */
export class AvatarStore {
  /** 已通过完整校验且在磁盘存在的哈希；目录内文件只由本类删除，prune / 覆写时同步失效。 */
  private readonly verified = new Set<string>()

  constructor(private readonly rootDir: string) {}

  async save(input: ArrayBuffer | Uint8Array): Promise<string | null> {
    const bytes = toBytes(input)
    if (!isValidAvatarBytes(bytes)) return null
    const hash = avatarHashOf(bytes)
    return (await this.writeKnownHash(hash, bytes)) ? hash : null
  }

  async import(hash: string, input: ArrayBuffer | Uint8Array): Promise<boolean> {
    const bytes = toBytes(input)
    if (!isAvatarHash(hash) || !isValidAvatarBytes(bytes) || avatarHashOf(bytes) !== hash) {
      return false
    }
    return this.writeKnownHash(hash, bytes)
  }

  async has(hash: string): Promise<boolean> {
    if (!isAvatarHash(hash)) return false
    if (this.verified.has(hash)) return true
    return (await this.read(hash)) !== null
  }

  async read(hash: string): Promise<Buffer | null> {
    if (!isAvatarHash(hash)) return null
    try {
      const bytes = await readFile(this.pathFor(hash))
      if (!isValidAvatarBytes(bytes) || avatarHashOf(bytes) !== hash) {
        this.verified.delete(hash)
        return null
      }
      this.verified.add(hash)
      return bytes
    } catch {
      this.verified.delete(hash)
      return null
    }
  }

  async resolvePath(hash: string): Promise<string | null> {
    return (await this.has(hash)) ? this.pathFor(hash) : null
  }

  async prune(referencedHashes: Iterable<string>): Promise<void> {
    const keep = new Set([...referencedHashes].filter(isAvatarHash))
    let names: string[]
    try {
      names = await readdir(this.rootDir)
    } catch {
      return
    }
    const now = Date.now()
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.webp$/.exec(name)
      if (match && keep.has(match[1])) continue
      if (match) {
        this.verified.delete(match[1])
        await unlink(join(this.rootDir, name)).catch(() => undefined)
      } else if (name.endsWith('.tmp')) {
        const info = await stat(join(this.rootDir, name)).catch(() => null)
        if (info && now - info.mtimeMs >= TMP_STALE_MS) {
          await unlink(join(this.rootDir, name)).catch(() => undefined)
        }
      }
    }
  }

  private pathFor(hash: string): string {
    return join(this.rootDir, `${hash}.webp`)
  }

  private async writeKnownHash(hash: string, bytes: Uint8Array): Promise<boolean> {
    await mkdir(this.rootDir, { recursive: true })
    if (await this.has(hash)) return true
    const target = this.pathFor(hash)
    await unlink(target).catch(() => undefined)
    const temporary = join(this.rootDir, `${hash}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, bytes, { flag: 'wx' })
      await rename(temporary, target)
      this.verified.add(hash)
      return true
    } catch {
      await unlink(temporary).catch(() => undefined)
      return this.has(hash)
    }
  }
}

function toBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input)
}
