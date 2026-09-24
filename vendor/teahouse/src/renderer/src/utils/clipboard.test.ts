import { afterEach, describe, expect, it } from 'vitest'
import {
  NATIVE_IMAGE_FALLBACK_SUPPRESS_MS,
  readClipboardTableText,
  hasClipboardText,
  imageMimeFromExt,
  shouldScheduleIpcClipboardImageFallback,
  shouldSuppressNativeImageFallback
} from './clipboard'
import { TABLE_TEXT_LIMIT_BYTES } from '../../../shared/protocol'

const nativeDomParser = globalThis.DOMParser

afterEach(() => {
  globalThis.DOMParser = nativeDomParser
})

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

/**
 * 极简 HTML 解析替身：足够支撑「唯一 table + 表外无实质文字」的判定（决议 #270），
 * 不引入 jsdom 依赖。
 */
function installTinyTableParser(): void {
  globalThis.DOMParser = class {
    parseFromString(html: string): Document {
      const tables = Array.from(html.matchAll(/<table[\s\S]*?>([\s\S]*?)<\/table>/gi)).map(
        (tableMatch) => {
          const rows = Array.from(tableMatch[1].matchAll(/<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi)).map(
            (rowMatch) => {
              const cells = Array.from(
                rowMatch[1].matchAll(/<t[hd][\s\S]*?>([\s\S]*?)<\/t[hd]>/gi)
              ).map((cellMatch) => ({ textContent: stripTags(cellMatch[1]) }))
              return { querySelectorAll: () => cells }
            }
          )
          return {
            textContent: stripTags(tableMatch[0]),
            querySelectorAll: () => rows
          }
        }
      )
      return {
        body: { textContent: stripTags(html) },
        querySelectorAll: () => tables
      } as unknown as Document
    }
  } as typeof DOMParser
}

describe('clipboard helpers', () => {
  it('优先保留带文本的 emoji / 富文本粘贴', () => {
    expect(hasClipboardText({ getData: (type) => (type === 'text/plain' ? '😀' : '') })).toBe(true)
  })

  it('允许无文本截图继续走图片粘贴', () => {
    expect(hasClipboardText({ getData: () => '' })).toBe(false)
  })

  it('按源文件扩展名生成图片 MIME', () => {
    expect(imageMimeFromExt('.jpg')).toBe('image/jpeg')
    expect(imageMimeFromExt('.webp')).toBe('image/webp')
    expect(imageMimeFromExt('.gif')).toBe('image/gif')
    expect(imageMimeFromExt('.bin')).toBe('image/png')
  })

  it('浏览器 paste 已消费时短时间内抑制原生图片兜底', () => {
    expect(shouldSuppressNativeImageFallback(1_000, 1_000)).toBe(true)
    expect(shouldSuppressNativeImageFallback(1_000, 1_000 + NATIVE_IMAGE_FALLBACK_SUPPRESS_MS - 1)).toBe(true)
    expect(shouldSuppressNativeImageFallback(1_000, 1_000 + NATIVE_IMAGE_FALLBACK_SUPPRESS_MS)).toBe(false)
    expect(shouldSuppressNativeImageFallback(0, 1_000)).toBe(false)
  })

  it('input/textarea 有焦点时不调度 IPC 图片兜底（决议 #207）', () => {
    expect(shouldScheduleIpcClipboardImageFallback({ tagName: 'INPUT' })).toBe(false)
    expect(shouldScheduleIpcClipboardImageFallback({ tagName: 'input' })).toBe(false)
    expect(shouldScheduleIpcClipboardImageFallback({ tagName: 'TEXTAREA' })).toBe(false)
    expect(shouldScheduleIpcClipboardImageFallback({ tagName: 'DIV' })).toBe(true)
    expect(shouldScheduleIpcClipboardImageFallback(null)).toBe(true)
  })

  it('识别 HTML table 或多行 TSV 为表格粘贴', () => {
    installTinyTableParser()
    expect(
      readClipboardTableText({
        getData: (type) => {
          if (type === 'text/html') return '<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>'
          if (type === 'text/plain') return '网页复制的普通文本'
          return ''
        }
      })
    ).toEqual({ tableText: 'A\tB\n1\t2', tableTextTruncated: false })

    expect(
      readClipboardTableText({
        getData: (type) => (type === 'text/plain' ? 'A\tB\n1\t2' : '')
      })
    ).toEqual({ tableText: 'A\tB\n1\t2', tableTextTruncated: false })
  })

  it('随手打的制表符文本不再当表格（Issue #19 / 决议 #270）', () => {
    // issue 原文：第一行两列、第二行三列，列数对不上就不是表格
    expect(
      readClipboardTableText({
        getData: (type) => (type === 'text/plain' ? '123\t2656\n415456\t5454\t' : '')
      })
    ).toBeNull()
  })

  it('Tab 缩进的代码与单行文本都不当表格（决议 #270）', () => {
    // 首列全空 = 缩进，不是表格
    expect(
      readClipboardTableText({
        getData: (type) => (type === 'text/plain' ? '\tconst a = 1\n\treturn a' : '')
      })
    ).toBeNull()
    // 缩进深度不同 → 列数也对不上
    expect(
      readClipboardTableText({
        getData: (type) => (type === 'text/plain' ? '\tif (a) {\n\t\treturn a\n\t}' : '')
      })
    ).toBeNull()
    // 只有一行，凑不成表
    expect(
      readClipboardTableText({
        getData: (type) => (type === 'text/plain' ? 'A\tB' : '')
      })
    ).toBeNull()
  })

  it('HTML 片段里有正文或多张表时不当表格（决议 #270）', () => {
    installTinyTableParser()
    // 表外还有正文：整块转图片会丢正文，交回普通文本粘贴
    expect(
      readClipboardTableText({
        getData: (type) => {
          if (type === 'text/html') return '<p>说明文字</p><table><tr><td>A</td><td>B</td></tr></table>'
          if (type === 'text/plain') return '说明文字\nA\tB'
          return ''
        }
      })
    ).toBeNull()
    // 多张表：取第一张会让图片与文字视图对不上
    expect(
      readClipboardTableText({
        getData: (type) => {
          if (type === 'text/html')
            return '<table><tr><td>A</td></tr></table><table><tr><td>B</td></tr></table>'
          if (type === 'text/plain') return 'A\nB'
          return ''
        }
      })
    ).toBeNull()
  })

  it('DOMParser 不可用时退回纯文本口径（决议 #270）', () => {
    globalThis.DOMParser = undefined as unknown as typeof DOMParser
    expect(
      readClipboardTableText({
        getData: (type) => {
          if (type === 'text/html') return '<table><tr><td>A</td><td>B</td></tr></table>'
          if (type === 'text/plain') return 'A\tB\n1\t2'
          return ''
        }
      })
    ).toEqual({ tableText: 'A\tB\n1\t2', tableTextTruncated: false })
  })

  it('普通富文本 emoji 不按表格粘贴处理', () => {
    expect(
      readClipboardTableText({
        getData: (type) => {
          if (type === 'text/html') return '<span>😀</span>'
          if (type === 'text/plain') return '😀'
          return ''
        }
      })
    ).toBeNull()
  })

  it('表格文字按 UTF-8 字节安全截断并标记', () => {
    const source = Array.from({ length: TABLE_TEXT_LIMIT_BYTES }, () => '表\t格').join('\n')
    const result = readClipboardTableText({
      getData: (type) => {
        if (type === 'text/plain') return source
        return ''
      }
    })

    expect(result?.tableTextTruncated).toBe(true)
    expect(new TextEncoder().encode(result?.tableText ?? '').byteLength).toBeLessThanOrEqual(
      TABLE_TEXT_LIMIT_BYTES
    )
    expect(result?.tableText.endsWith('�')).toBe(false)
  })
})
