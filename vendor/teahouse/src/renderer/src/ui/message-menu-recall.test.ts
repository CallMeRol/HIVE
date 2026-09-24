import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPaneSource = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')
const imageBubbleSource = readFileSync(
  new URL('../components/ImageBubble.vue', import.meta.url),
  'utf8'
)

function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `缺少样式规则 ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('消息右键菜单撤回项', () => {
  it.each([
    ['文字 / 文件 / PK', chatPaneSource, '.msg-menu button', '{{ recallButtonMeta }}'],
    ['图片 / 表情', imageBubbleSource, '.ctx button', '{{ recallMeta }}']
  ])('%s 菜单把操作名与倒计时拆成同一行的左右两列', (_, source, selector, meta) => {
    expect(source).toContain('class="danger recall-action"')
    expect(source).toContain("<span>{{ tr('撤回') }}</span>")
    expect(source).toContain('class="recall-action-meta"')
    expect(source).toContain(meta)

    const buttonRule = ruleBody(source, selector)
    expect(buttonRule).toContain('display: flex')
    expect(buttonRule).toContain('justify-content: space-between')
    expect(buttonRule).toContain('min-height: 32px')
    expect(buttonRule).toContain('white-space: nowrap')
  })

  it('弱化常规倒计时并用等宽数字稳定宽度', () => {
    for (const source of [chatPaneSource, imageBubbleSource]) {
      const metaRule = ruleBody(source, '.recall-action-meta')
      expect(metaRule).toContain('color: var(--text-3)')
      expect(metaRule).toContain('font-size: 11px')
      expect(metaRule).toContain('font-variant-numeric: tabular-nums')
      expect(ruleBody(source, '.recall-action-meta.is-urgent')).toContain('color: var(--danger)')
    }
  })

  it('定位测量宽度与菜单盒模型保持一致', () => {
    expect(chatPaneSource).toContain('const MSG_MENU_WIDTH = 128')
    expect(imageBubbleSource).toContain('const MENU_WIDTH = 128')
    expect(ruleBody(chatPaneSource, '.msg-menu')).toContain('box-sizing: border-box')
    expect(ruleBody(imageBubbleSource, '.ctx')).toContain('box-sizing: border-box')
  })
})
