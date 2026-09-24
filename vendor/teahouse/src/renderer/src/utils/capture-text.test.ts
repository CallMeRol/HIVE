import { describe, expect, it } from 'vitest'
import {
  CAPTURE_TEXT_MAX_LENGTH,
  normalizeCaptureText,
  placeCaptureTextEditor,
  shouldCommitCaptureText
} from './capture-text'

describe('截图文字输入', () => {
  it('输入框靠近右下角时夹在视口安全边距内', () => {
    expect(
      placeCaptureTextEditor(
        { x: 1180, y: 780 },
        { width: 260, height: 34 },
        { width: 1200, height: 800 }
      )
    ).toEqual({ x: 932, y: 758 })
  })

  it('输入框靠近左上角时保留安全边距', () => {
    expect(
      placeCaptureTextEditor(
        { x: 1, y: 2 },
        { width: 260, height: 34 },
        { width: 1200, height: 800 }
      )
    ).toEqual({ x: 8, y: 8 })
  })

  it('普通 Enter 提交，composition 与 keyCode 229 不提交', () => {
    expect(
      shouldCommitCaptureText({ key: 'Enter', isComposing: false, keyCode: 13 }, false)
    ).toBe(true)
    expect(
      shouldCommitCaptureText({ key: 'Enter', isComposing: true, keyCode: 229 }, true)
    ).toBe(false)
    expect(
      shouldCommitCaptureText({ key: 'Enter', isComposing: false, keyCode: 229 }, false)
    ).toBe(false)
  })

  it('去掉两端空白并限制为 80 个 UTF-16 code unit', () => {
    const longText = `  ${'字'.repeat(CAPTURE_TEXT_MAX_LENGTH + 5)}  `
    expect(normalizeCaptureText(longText)).toBe('字'.repeat(CAPTURE_TEXT_MAX_LENGTH))
    expect(normalizeCaptureText('   ')).toBe('')
  })
})
