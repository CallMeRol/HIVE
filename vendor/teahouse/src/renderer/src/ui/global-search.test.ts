import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../components/SearchPanel.vue', import.meta.url), 'utf8')

describe('全局联系人搜索结果', () => {
  it('展示完整头像并按备注优先显示名称（决议 #250）', () => {
    expect(source).toContain("import AvatarMark from './AvatarMark.vue'")
    expect(source).toContain('<AvatarMark')
    expect(source).toContain(':avatar="p.avatar"')
    expect(source).toContain(':avatar-hash="p.avatarHash"')
    expect(source).toContain(':offline="!p.online"')
    expect(source).toContain('return peer.remark || peer.nick')
    expect(source).toContain('{{ peerName(p) }}')
    expect(source).toContain('class="search-avatar"')
  })
})
