import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `缺少样式规则 ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('私聊头部资料入口 hover', () => {
  it('只高亮昵称，不显示宽区域背景或按压缩放', () => {
    expect(source).not.toMatch(/\.title-button:hover\s*\{/)
    expect(source).not.toMatch(/\.title-button:active\s*\{/)
    expect(ruleBody('.title-button')).not.toContain('box-shadow')
    expect(ruleBody('.title-button')).not.toContain('transition:')
    expect(source).toMatch(
      /\.title-button:hover \.title,\s*\.title-button\.active \.title\s*\{\s*color: var\(--primary\);\s*\}/
    )
  })

  it('昵称颜色过渡支持减少动态效果', () => {
    expect(source).toMatch(/\n\.title-button \.title\s*\{\s*transition: color 150ms ease;\s*\}/)
    expect(source).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.title-button \.title,[\s\S]*?transition: none;/
    )
  })

  it('保留键盘焦点轮廓', () => {
    expect(ruleBody('.title-button:focus-visible')).toContain('outline: 1px solid var(--primary)')
  })
})
