import { describe, expect, it } from 'vitest'

import { DEFAULT_IMAGE_EXTENSION, IMAGE_FILE_EXTENSIONS } from './media'

describe('media shared constants', () => {
  it('统一图片后缀白名单和默认回退后缀', () => {
    expect(IMAGE_FILE_EXTENSIONS).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
    expect(new Set(IMAGE_FILE_EXTENSIONS).size).toBe(IMAGE_FILE_EXTENSIONS.length)
    expect(DEFAULT_IMAGE_EXTENSION).toBe('.png')
  })
})
