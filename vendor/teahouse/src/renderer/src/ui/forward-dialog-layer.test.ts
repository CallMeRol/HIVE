import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../components/ForwardDialog.vue', import.meta.url), 'utf8')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `缺少样式规则 ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('消息转发弹窗全局层级', () => {
  it('通过 Teleport 脱离聊天区局部层叠上下文', () => {
    expect(source).toContain('<Teleport to="body">')
    expect(ruleBody('.mask')).toContain('position: fixed')
    expect(ruleBody('.mask')).toContain('inset: 0')
    expect(ruleBody('.mask')).toContain('z-index: 1200')
  })

  it('具备模态语义、初始焦点和 Esc 退出', () => {
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain('ref="dialogRef"')
    expect(source).toContain("event.key !== 'Escape'")
    expect(source).toContain("window.addEventListener('keydown', onWindowKeydown)")
    expect(source).toContain("window.removeEventListener('keydown', onWindowKeydown)")
  })

  it('进场动画只使用合成属性并支持减少动态效果', () => {
    const reducedMotion = source.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/
    )?.[0] ?? ''
    expect(source).toContain('@keyframes forward-dialog-in')
    expect(reducedMotion).toContain('animation: none')
    expect(reducedMotion).not.toContain('transition')
  })
})
