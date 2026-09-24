import { IMAGE_INLINE_MAX_EDGE, IMAGE_INLINE_MAX_PIXELS } from './media'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp'

export interface ImageMetadata {
  format: ImageFormat
  width: number
  height: number
  animated: boolean
}

const JPEG_START_OF_FRAME = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf
])

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.length) return ''
  let result = ''
  for (let i = offset; i < offset + length; i++) result += String.fromCharCode(bytes[i])
  return result
}

function uint16be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) return 0
  return bytes[offset] * 0x100 + bytes[offset + 1]
}

function uint16le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) return 0
  return bytes[offset] + bytes[offset + 1] * 0x100
}

function uint24le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 3 > bytes.length) return 0
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000
}

function uint32be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) return 0
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  )
}

function uint32le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) return 0
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  )
}

function valid(format: ImageFormat, width: number, height: number, animated = false): ImageMetadata | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null
  }
  return { format, width, height, animated }
}

function inspectPng(bytes: Uint8Array): ImageMetadata | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return null
  if (uint32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') return null
  const bitDepth = bytes[24]
  const colorType = bytes[25]
  const validDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16]
  }
  if (
    !validDepths[colorType]?.includes(bitDepth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    (bytes[28] !== 0 && bytes[28] !== 1)
  ) {
    return null
  }

  let animated = false
  let offset = 33
  while (offset + 12 <= bytes.length) {
    const length = uint32be(bytes, offset)
    const type = ascii(bytes, offset + 4, 4)
    const next = offset + 12 + length
    if (!Number.isSafeInteger(next) || next > bytes.length) break
    if (type === 'acTL') {
      animated = true
      break
    }
    if (type === 'IDAT' || type === 'IEND') break
    offset = next
  }
  return valid('png', uint32be(bytes, 16), uint32be(bytes, 20), animated)
}

function inspectGif(bytes: Uint8Array): ImageMetadata | null {
  const version = ascii(bytes, 0, 6)
  if (bytes.length < 13 || (version !== 'GIF87a' && version !== 'GIF89a')) return null
  // GIF 是否真正多帧需要扫描完整文件；展示链统一保留 GIF 原图，按动画处理最安全。
  return valid('gif', uint16le(bytes, 6), uint16le(bytes, 8), true)
}

function inspectBmp(bytes: Uint8Array): ImageMetadata | null {
  if (bytes.length < 26 || ascii(bytes, 0, 2) !== 'BM') return null
  const dibSize = uint32le(bytes, 14)
  const pixelOffset = uint32le(bytes, 10)
  if (dibSize === 12) {
    if (pixelOffset < 26 || uint16le(bytes, 22) !== 1) return null
    return valid('bmp', uint16le(bytes, 18), uint16le(bytes, 20))
  }
  if (dibSize < 40 || bytes.length < 30 || pixelOffset < 14 + dibSize) return null
  const width = uint32le(bytes, 18) | 0
  const signedHeight = uint32le(bytes, 22) | 0
  const bitsPerPixel = uint16le(bytes, 28)
  if (width <= 0 || signedHeight === 0 || uint16le(bytes, 26) !== 1) return null
  if (![1, 4, 8, 16, 24, 32].includes(bitsPerPixel)) return null
  return valid('bmp', width, Math.abs(signedHeight))
}

function inspectJpeg(bytes: Uint8Array): ImageMetadata | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset++
    while (offset < bytes.length && bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) return null
    const marker = bytes[offset++]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return null
    const length = uint16be(bytes, offset)
    if (length < 2 || offset + length > bytes.length) return null
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 7) return null
      return valid('jpeg', uint16be(bytes, offset + 5), uint16be(bytes, offset + 3))
    }
    offset += length
  }
  return null
}

function inspectWebp(bytes: Uint8Array): ImageMetadata | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return null
  }
  if (uint32le(bytes, 4) < 22) return null
  const chunk = ascii(bytes, 12, 4)
  if (chunk === 'VP8X') {
    if (uint32le(bytes, 16) < 10) return null
    const flags = bytes[20]
    return valid(
      'webp',
      uint24le(bytes, 24) + 1,
      uint24le(bytes, 27) + 1,
      (flags & 0x02) !== 0
    )
  }
  if (chunk === 'VP8L') {
    if (uint32le(bytes, 16) < 5 || bytes[20] !== 0x2f || bytes.length < 25) return null
    const b0 = bytes[21]
    const b1 = bytes[22]
    const b2 = bytes[23]
    const b3 = bytes[24]
    return valid(
      'webp',
      1 + b0 + ((b1 & 0x3f) << 8),
      1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10)
    )
  }
  if (chunk === 'VP8 ') {
    if (
      uint32le(bytes, 16) < 10 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    ) {
      return null
    }
    return valid('webp', uint16le(bytes, 26) & 0x3fff, uint16le(bytes, 28) & 0x3fff)
  }
  return null
}

export function inspectImageMetadata(bytes: Uint8Array): ImageMetadata | null {
  return (
    inspectPng(bytes) ??
    inspectJpeg(bytes) ??
    inspectGif(bytes) ??
    inspectWebp(bytes) ??
    inspectBmp(bytes)
  )
}

export function isInlineImageMetadata(metadata: ImageMetadata | null): metadata is ImageMetadata {
  if (!metadata) return false
  return (
    metadata.width <= IMAGE_INLINE_MAX_EDGE &&
    metadata.height <= IMAGE_INLINE_MAX_EDGE &&
    metadata.width * metadata.height <= IMAGE_INLINE_MAX_PIXELS
  )
}

export function imageExtensionMatchesMetadata(extension: string, metadata: ImageMetadata): boolean {
  const normalized = extension.trim().toLowerCase()
  if (metadata.format === 'jpeg') return normalized === '.jpg' || normalized === '.jpeg'
  return normalized === `.${metadata.format}`
}
