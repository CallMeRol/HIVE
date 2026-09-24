import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../components/ChatPane.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

const iconSource = readFileSync(
  new URL('../components/PantryIcon.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

describe('表格粘贴不再自动发送（Issue #19 / 决议 #270）', () => {
  it('粘贴命中表格只做准备，不直接发图片', () => {
    expect(source).toContain('await prepareTablePaste(data, tableText)')
    expect(source).not.toContain('await sendTablePaste(data')
    // 发图片只能由提示条按钮触发
    expect(source).toContain('async function sendTablePasteImage()')
    expect(source).toContain('@click="sendTablePasteImage"')
  })

  it('准备阶段在事件内取走剪贴板图片并把原文插入草稿', () => {
    expect(source).toContain('const imageItem = await readClipboardImageItem(data)')
    expect(source).toContain('const start = insertTextAtCursor(rawText)')
    expect(source).toContain('oversize: overLimit.value')
  })

  it('提示条按草稿改动、会话切换与卸载收起，超限时不自动消失', () => {
    expect(source).toContain('tablePasteHintIntact(draft.value, tablePasteHint.value)')
    expect(source).toContain('tablePasteHintTimer = overLimit.value\n    ? null')
    expect(source).toContain('TABLE_PASTE_HINT_MS')
    // 会话切换 watcher 与 onUnmounted 各清理一次，加上两处调用点
    expect(source.match(/clearTablePasteHint\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
  })

  it('提示条给出忽略入口并在对方离线时禁用发图片', () => {
    expect(source).toContain('class="table-paste-hint"')
    expect(source).toContain('aria-live="polite"')
    expect(source).toContain(":aria-label=\"tr('忽略')\"")
    expect(source).toContain('@click="clearTablePasteHint"')
    expect(source).toContain(':disabled="!canSendMedia"')
    expect(source).toContain("<PantryIcon name=\"table\" :size=\"16\" />")
  })

  it('图标库提供 table 图标', () => {
    expect(iconSource).toContain("name === 'table'")
  })
})
