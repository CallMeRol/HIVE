import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dialogSource = readFileSync(
  new URL('../components/GroupInviteDialog.vue', import.meta.url),
  'utf8'
)
const pickerSource = readFileSync(
  new URL('../components/GroupMemberPicker.vue', import.meta.url),
  'utf8'
)
const panelSource = readFileSync(new URL('../components/GroupPanel.vue', import.meta.url), 'utf8')

describe('群成员批量邀请弹窗（决议 #242）', () => {
  it('挂到全局 body 层并声明模态语义', () => {
    expect(dialogSource).toContain('<Teleport to="body">')
    expect(dialogSource).toContain('role="dialog"')
    expect(dialogSource).toContain('aria-modal="true"')
    expect(dialogSource).toContain('aria-labelledby="group-invite-dialog-title"')
    expect(dialogSource).toContain('z-index: 1200')
  })

  it('支持遮罩、Esc、初始搜索焦点和关闭后焦点恢复', () => {
    expect(dialogSource).toContain('@mousedown.self="requestClose"')
    expect(dialogSource).toContain("event.key !== 'Escape' || inviting.value")
    expect(dialogSource).toContain("window.addEventListener('keydown', onWindowKeydown)")
    expect(dialogSource).toContain("window.removeEventListener('keydown', onWindowKeydown)")
    expect(dialogSource).toContain('pickerRef.value.focusSearch()')
    expect(dialogSource).toContain('previousFocus?.isConnected')
    expect(dialogSource).toContain('previousFocus.focus()')
  })

  it('复用选择器，隐藏已有成员并按剩余人数限制选择', () => {
    expect(dialogSource).toContain(':excluded-ids="group.members"')
    expect(dialogSource).toContain(':max-pick="remaining"')
    expect(pickerSource).toContain('filterGroupMemberCandidates')
    expect(pickerSource).toContain('type="checkbox"')
    expect(pickerSource).toContain('class="chip"')
    expect(pickerSource).toContain('v-for="peer in selectedPeers"')
    expect(pickerSource).not.toContain('selectedPeers.slice')
    expect(pickerSource).toContain("class=\"off-tag\">{{ tr('离线') }}")
    expect(pickerSource).toContain(':disabled="atPickCap && !selectedIds.includes(p.nodeId)"')
  })

  it('一次提交全部成员，失败时保留选择并展示行内提示', () => {
    expect(dialogSource).toContain("kind: 'invite'")
    expect(dialogSource).toContain('memberIds: [...selectedIds.value]')
    expect(dialogSource).toContain("error.value = tr('添加失败，请稍后重试')")
    expect(dialogSource).not.toContain('selectedIds.value = []')
    expect(dialogSource).toContain('aria-live="polite"')
  })

  it('提交期间禁止重复确认和关闭，并尊重减少动态效果设置', () => {
    expect(dialogSource).toContain('if (!inviting.value) emit(\'close\')')
    expect(dialogSource).toContain(':disabled="!canInvite"')
    expect(dialogSource).toContain(':disabled="inviting"')
    expect(dialogSource).toContain(':loading="inviting"')
    expect(dialogSource).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('成员面板按钮只打开弹窗，满员时保持禁用', () => {
    expect(panelSource).toContain('@click="showInviteDialog = true"')
    expect(panelSource).toContain(':disabled="adminBusy || atMemberCap"')
    expect(panelSource).toContain('<GroupInviteDialog')
    expect(panelSource).not.toContain('class="addlist"')
  })
})
