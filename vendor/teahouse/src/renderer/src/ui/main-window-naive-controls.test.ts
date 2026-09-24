import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const groupCreatorSource = readFileSync(
  new URL('../components/GroupCreator.vue', import.meta.url),
  'utf8'
)
const memberPickerSource = readFileSync(
  new URL('../components/GroupMemberPicker.vue', import.meta.url),
  'utf8'
)
const profileCardSource = readFileSync(
  new URL('../components/ProfileCard.vue', import.meta.url),
  'utf8'
)

describe('主窗口 Naive UI 标准控件复用', () => {
  it('讨论组普通输入与页脚操作复用现有 Input 和 Button', () => {
    expect(groupCreatorSource).toMatch(/import \{ NButton, NInput \} from 'naive-ui'/)
    expect(groupCreatorSource.match(/<NInput\b/g)).toHaveLength(4)
    expect(memberPickerSource).toMatch(/import \{ NInput \} from 'naive-ui'/)
    expect(memberPickerSource.match(/<NInput\b/g)).toHaveLength(1)
    expect(groupCreatorSource.match(/<NButton\b/g)).toHaveLength(3)
    expect(memberPickerSource).toContain('v-model:value="query"')
    expect(groupCreatorSource).toContain('v-model:value="name"')
    expect(groupCreatorSource).toContain('v-model:value="adminPassword"')
    expect(groupCreatorSource).toContain('v-model:value="adminPasswordConfirm"')
    expect(groupCreatorSource).toContain('v-model:value="adminHint"')
    expect(groupCreatorSource).toContain(':loading="creating"')
  })

  it('讨论组密集成员选择与已选标签保持原生轻量节点', () => {
    expect(groupCreatorSource).toContain('<GroupMemberPicker')
    expect(memberPickerSource.match(/<input\b/g)).toHaveLength(1)
    expect(memberPickerSource).toMatch(/<input[\s\S]*?type="checkbox"/)
    expect(memberPickerSource.match(/<button\b/g)).toHaveLength(1)
    expect(memberPickerSource).toMatch(/<button[\s\S]*?class="chip"/)
    expect(memberPickerSource).not.toContain('NCheckbox')
  })

  it('讨论组成员姓名与组织路径使用紧凑单行布局', () => {
    expect(memberPickerSource).toContain('v-for="{ peer: p, organization } in filteredRows"')
    expect(memberPickerSource).toContain('v-if="organization"')
    expect(memberPickerSource).toContain(':title="organization"')
    const pickRule = memberPickerSource.match(/\.pick \{([^}]*)\}/)?.[1] ?? ''
    const personRule = memberPickerSource.match(/\.person \{([^}]*)\}/)?.[1] ?? ''
    expect(pickRule).toContain('min-height: 34px')
    expect(personRule).toContain('align-items: baseline')
    expect(personRule).not.toContain('flex-direction: column')
  })

  it('联系人备注与资料页操作复用现有 Input 和 Button', () => {
    expect(profileCardSource).toMatch(/import \{ NButton, NInput \} from 'naive-ui'/)
    expect(profileCardSource.match(/<NInput\b/g)).toHaveLength(1)
    expect(profileCardSource.match(/<NButton\b/g)).toHaveLength(2)
    expect(profileCardSource).toContain('v-model:value="remark"')
    expect(profileCardSource).toContain("id: 'peer-remark'")
    expect(profileCardSource).toContain('@keydown.enter.prevent="saveRemark"')
    expect(profileCardSource).toContain(':loading="saving"')
    expect(profileCardSource).not.toMatch(/<(?:input|button)\b/)
  })

  it('两个子组件继续继承主窗口无布局 Provider', () => {
    expect(appSource).toMatch(/<NConfigProvider\s+abstract\b/)
    expect(groupCreatorSource).not.toContain('NConfigProvider')
    expect(memberPickerSource).not.toContain('NConfigProvider')
    expect(profileCardSource).not.toContain('NConfigProvider')
  })
})
