import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(new URL('../components/GroupPanel.vue', import.meta.url), 'utf8')
const inviteDialogSource = readFileSync(
  new URL('../components/GroupInviteDialog.vue', import.meta.url),
  'utf8'
)

describe('群成员面板角色与开放邀请', () => {
  it('展示群主和管理员徽标，并提供群主任免入口', () => {
    expect(panelSource).toContain("class=\"role-badge owner\">{{ tr('群主') }}</span>")
    expect(panelSource).toContain("class=\"role-badge\">{{ tr('管理员') }}</span>")
    expect(panelSource).toContain('canSetGroupAdmin(group, id)')
    expect(panelSource).toContain('name="shield"')
    expect(panelSource).toContain("kind: 'set-admin'")
  })

  it('所有在群成员均可看到添加成员入口，并通过弹窗使用独立邀请操作', () => {
    expect(panelSource).toContain('<template v-if="group.amMember">')
    expect(panelSource).toContain('<GroupInviteDialog')
    expect(inviteDialogSource).toContain("kind: 'invite'")
    expect(panelSource).toContain('所有成员均可邀请联系人加入群聊')
  })

  it('群内存在未声明 gr1 的成员时展示升级提示', () => {
    expect(panelSource).toContain('CAPS.groupRoles')
    expect(panelSource).toContain('群内有旧版本成员，角色或邀请可能无法完整同步，请提醒升级')
  })
})
