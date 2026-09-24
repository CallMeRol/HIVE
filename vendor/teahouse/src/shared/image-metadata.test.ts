import { describe, expect, it } from 'vitest'
import {
  imageExtensionMatchesMetadata,
  inspectImageMetadata,
  isInlineImageMetadata,
  type ImageMetadata
} from './image-metadata'

function putAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
}

function png(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(animated ? 53 : 33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  putAscii(bytes, 12, 'IHDR')
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes[24] = 8
  bytes[25] = 6
  if (animated) {
    view.setUint32(33, 8)
    putAscii(bytes, 37, 'acTL')
  }
  return bytes
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00
  ])
}

function gif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13)
  putAscii(bytes, 0, 'GIF89a')
  const view = new DataView(bytes.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
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

function bmp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  putAscii(bytes, 0, 'BM')
  const view = new DataView(bytes.buffer)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  return bytes
}

describe('图片文件头元数据', () => {
  it.each([
    ['PNG', png(1920, 1080), { format: 'png', width: 1920, height: 1080, animated: false }],
    ['APNG', png(640, 480, true), { format: 'png', width: 640, height: 480, animated: true }],
    ['JPEG', jpeg(4032, 3024), { format: 'jpeg', width: 4032, height: 3024, animated: false }],
    ['GIF', gif(640, 480), { format: 'gif', width: 640, height: 480, animated: true }],
    ['WebP', webp(1200, 900, true), { format: 'webp', width: 1200, height: 900, animated: true }],
    ['BMP', bmp(800, 600), { format: 'bmp', width: 800, height: 600, animated: false }]
  ])('解析 %s 真实格式与尺寸', (_label, bytes, expected) => {
    expect(inspectImageMetadata(bytes)).toEqual(expected)
  })

  it('拒绝损坏头部和扩展名伪装', () => {
    expect(inspectImageMetadata(Uint8Array.from([1, 2, 3]))).toBeNull()
    const metadata = inspectImageMetadata(png(320, 200))
    expect(metadata).not.toBeNull()
    expect(imageExtensionMatchesMetadata('.png', metadata!)).toBe(true)
    expect(imageExtensionMatchesMetadata('.jpg', metadata!)).toBe(false)
  })

  it('锁定 8192px 单边与 3200 万总像素门禁', () => {
    const metadata = (width: number, height: number): ImageMetadata => ({
      format: 'png',
      width,
      height,
      animated: false
    })
    expect(isInlineImageMetadata(metadata(8000, 4000))).toBe(true)
    expect(isInlineImageMetadata(metadata(8001, 4000))).toBe(false)
    expect(isInlineImageMetadata(metadata(8192, 3906))).toBe(true)
    expect(isInlineImageMetadata(metadata(8193, 100))).toBe(false)
  })
})
