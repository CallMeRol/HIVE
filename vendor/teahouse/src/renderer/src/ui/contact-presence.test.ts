import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../components/PeerList.vue', import.meta.url), 'utf8')

describe('通讯录联系人在线状态', () => {
  it('只用绿灰状态点与灰显表达状态，不重复显示离线文字（决议 #252）', () => {
    // #47 起：有负担面（同群 ∩ ag1）的对端画五档环，其余仍走这条绿/灰点分支。
    // 断言改为「该分支仍然存在」而不是钉死整行字面量——新增的 v-else 不改变 #252 的意图。
    // #57：状态点移到头像右下角（sprite 契约 A1），绿/灰底座分支仍在。
    expect(source).toContain('class="dot burden-dot" :class="row.peer!.online ? \'on\' : \'off\'"')
    expect(source).toContain(':class="{ dim: !row.peer!.online }"')
    expect(source).not.toContain('class="offline-tag"')
    expect(source).not.toContain('· 离线')
  })
})
