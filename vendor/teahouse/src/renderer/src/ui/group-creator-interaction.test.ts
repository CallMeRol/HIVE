import { readFileSync } from 'node:fs'
import { isProxy, reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  shouldCloseGroupCreatorFromMask,
  snapshotGroupMemberIds
} from '../utils/group-creator'

const source = readFileSync(
  new URL('../components/GroupCreator.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

describe('建群提交与关闭交互', () => {
  it('把 Vue 响应式成员列表复制为可供 IPC 克隆的普通数组', () => {
    const selected = reactive(['node-a', 'node-b'])
    const snapshot = snapshotGroupMemberIds(selected)

    expect(isProxy(selected)).toBe(true)
    expect(isProxy(snapshot)).toBe(false)
    expect(snapshot).toEqual(['node-a', 'node-b'])
    expect(snapshot).not.toBe(selected)

    selected.push('node-c')
    expect(snapshot).toEqual(['node-a', 'node-b'])
  })

  it('仅在指针从遮罩开始且未提交时允许关闭', () => {
    expect(shouldCloseGroupCreatorFromMask(true, false)).toBe(true)
    expect(shouldCloseGroupCreatorFromMask(false, false)).toBe(false)
    expect(shouldCloseGroupCreatorFromMask(true, true)).toBe(false)
    expect(shouldCloseGroupCreatorFromMask(false, true)).toBe(false)
  })

  it('组件接线保证异常恢复、行内错误和遮罩手势门禁', () => {
    expect(source).toContain('snapshotGroupMemberIds(pickedIds.value)')
    expect(source).toContain('} catch {')
    expect(source).toContain('} finally {\n    creating.value = false')
    expect(source).toContain('aria-live="polite"')
    expect(source).toContain('@pointerdown="rememberMaskPointerDown"')
    expect(source).toContain('@click.self="requestMaskClose"')
    expect(source).not.toContain('@click.self="emit(\'close\')"')
    expect(source).toContain(':disabled="creating"')
  })
})
