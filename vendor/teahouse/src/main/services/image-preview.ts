import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  imageExtensionMatchesMetadata,
  inspectImageMetadata,
  isInlineImageMetadata,
  type ImageMetadata
} from '../../shared/image-metadata'
import {
  IMAGE_THUMBNAIL_CACHE_MAX_BYTES,
  IMAGE_THUMBNAIL_MAX_BYTES,
  IMAGE_THUMBNAIL_MAX_EDGE
} from '../../shared/media'

const IMAGE_HEADER_MAX_BYTES = 2 * 1024 * 1024
const METADATA_CACHE_MAX_ENTRIES = 512
const THUMBNAIL_TOUCH_INTERVAL_MS = 60 * 60 * 1000

interface MetadataCacheEntry {
  size: number
  mtimeMs: number
  metadata: ImageMetadata | null
}

interface ThumbnailEntry {
  path: string
  size: number
  mtimeMs: number
}

export interface ImagePreviewOptions {
  maxCacheBytes?: number
  touchIntervalMs?: number
}

export class ImagePreviewService {
  private readonly metadataCache = new Map<string, MetadataCacheEntry>()
  private readonly touchedAt = new Map<string, number>()
  private readonly maxCacheBytes: number
  private readonly touchIntervalMs: number
  private pruneRunning: Promise<void> | null = null
  private pruneRequested = false

  constructor(
    private readonly thumbnailDir: string,
    options: ImagePreviewOptions = {}
  ) {
    this.maxCacheBytes = options.maxCacheBytes ?? IMAGE_THUMBNAIL_CACHE_MAX_BYTES
    this.touchIntervalMs = options.touchIntervalMs ?? THUMBNAIL_TOUCH_INTERVAL_MS
  }

  inspectBytes(bytes: ArrayBuffer | Uint8Array): ImageMetadata | null {
    return inspectImageMetadata(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  }

  async inspectPath(path: string): Promise<ImageMetadata | null> {
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size <= 0) return null
      const cached = this.metadataCache.get(path)
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
        this.metadataCache.delete(path)
        this.metadataCache.set(path, cached)
        return cached.metadata
      }

      const length = Math.min(info.size, IMAGE_HEADER_MAX_BYTES)
      const bytes = new Uint8Array(length)
      const file = await open(path, 'r')
      try {
        const { bytesRead } = await file.read(bytes, 0, length, 0)
        const metadata = inspectImageMetadata(bytes.subarray(0, bytesRead))
        this.rememberMetadata(path, {
          size: info.size,
          mtimeMs: info.mtimeMs,
          metadata
        })
        return metadata
      } finally {
        await file.close()
      }
    } catch {
      return null
    }
  }

  async inspectInlinePath(path: string): Promise<ImageMetadata | null> {
    const metadata = await this.inspectPath(path)
    if (!metadata || !isInlineImageMetadata(metadata)) return null
    return imageExtensionMatchesMetadata(extname(path), metadata) ? metadata : null
  }

  isInlineNamedBytes(name: string, bytes: ArrayBuffer | Uint8Array): ImageMetadata | null {
    const metadata = this.inspectBytes(bytes)
    if (!metadata || !isInlineImageMetadata(metadata)) return null
    return imageExtensionMatchesMetadata(extname(name), metadata) ? metadata : null
  }

  async hasThumbnail(transferId: string): Promise<boolean> {
    const path = this.thumbnailPath(transferId)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size <= 0 || info.size > IMAGE_THUMBNAIL_MAX_BYTES) return false
      await this.touch(path)
      return true
    } catch {
      return false
    }
  }

  async resolvePreviewPath(transferId: string, originalPath: string): Promise<string | null> {
    if (!(await this.inspectInlinePath(originalPath))) return null
    return (await this.hasThumbnail(transferId)) ? this.thumbnailPath(transferId) : originalPath
  }

  async cacheThumbnail(transferId: string, bytes: ArrayBuffer): Promise<boolean> {
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_THUMBNAIL_MAX_BYTES) return false
    const metadata = this.inspectBytes(bytes)
    if (
      !metadata ||
      metadata.format !== 'webp' ||
      metadata.animated ||
      metadata.width > IMAGE_THUMBNAIL_MAX_EDGE ||
      metadata.height > IMAGE_THUMBNAIL_MAX_EDGE
    ) {
      return false
    }

    await mkdir(this.thumbnailDir, { recursive: true })
    const target = this.thumbnailPath(transferId)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, new Uint8Array(bytes), { flag: 'wx' })
      await rename(temporary, target)
    } catch {
      await unlink(temporary).catch(() => undefined)
      if (!(await this.hasThumbnail(transferId))) return false
    }
    await this.prune()
    return this.hasThumbnail(transferId)
  }

  async prune(): Promise<void> {
    this.pruneRequested = true
    if (this.pruneRunning) return this.pruneRunning
    this.pruneRunning = (async () => {
      while (this.pruneRequested) {
        this.pruneRequested = false
        await this.pruneNow()
      }
    })().finally(() => {
      this.pruneRunning = null
    })
    return this.pruneRunning
  }

  private async pruneNow(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.thumbnailDir)
    } catch {
      return
    }
    const entries: ThumbnailEntry[] = []
    for (const name of names) {
      const path = join(this.thumbnailDir, name)
      if (!name.endsWith('.webp')) {
        if (name.endsWith('.tmp')) await unlink(path).catch(() => undefined)
        continue
      }
      try {
        const info = await stat(path)
        if (info.isFile()) entries.push({ path, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // 文件可能在扫描期间被并发清理。
      }
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of entries) {
      if (total <= this.maxCacheBytes) break
      try {
        await unlink(entry.path)
        total -= entry.size
        this.touchedAt.delete(entry.path)
      } catch {
        // 单个文件清理失败不阻断其余缓存收口。
      }
    }
  }

  private thumbnailPath(transferId: string): string {
    const key = createHash('sha256').update(transferId).digest('hex')
    return join(this.thumbnailDir, `${key}.webp`)
  }

  private rememberMetadata(path: string, entry: MetadataCacheEntry): void {
    this.metadataCache.delete(path)
    this.metadataCache.set(path, entry)
    while (this.metadataCache.size > METADATA_CACHE_MAX_ENTRIES) {
      const oldest = this.metadataCache.keys().next().value
      if (typeof oldest !== 'string') break
      this.metadataCache.delete(oldest)
    }
  }

  private async touch(path: string): Promise<void> {
    const now = Date.now()
    const last = this.touchedAt.get(path) ?? 0
    if (now - last < this.touchIntervalMs) return
    this.touchedAt.set(path, now)
    const date = new Date(now)
    await utimes(path, date, date).catch(() => undefined)
  }
}
