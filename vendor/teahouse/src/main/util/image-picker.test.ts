import { describe, expect, it } from 'vitest'
import { filterImagePickerPaths, IMAGE_PICKER_EXTENSIONS } from './image-picker'

describe('发送图片文件选择器', () => {
  it('对话框只声明六种支持扩展名', () => {
    expect(IMAGE_PICKER_EXTENSIONS).toEqual(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
  })

  it('主进程复核返回路径并兼容大写扩展名', () => {
    expect(
      filterImagePickerPaths([
        '/tmp/a.png',
        '/tmp/b.JPG',
        '/tmp/c.webp',
        '/tmp/readme.txt',
        '/tmp/archive.zip',
        '/tmp/no-extension'
      ])
    ).toEqual(['/tmp/a.png', '/tmp/b.JPG', '/tmp/c.webp'])
  })

  it('拒绝空路径和超长路径', () => {
    expect(filterImagePickerPaths(['', `${'/'.repeat(2048)}a.png`])).toEqual([])
  })
})
