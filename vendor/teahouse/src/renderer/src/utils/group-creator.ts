/** Electron IPC 不能克隆 Vue 的响应式 Proxy；跨 preload 前固定复制为普通数组。 */
export function snapshotGroupMemberIds(ids: readonly string[]): string[] {
  return [...ids]
}

/** 遮罩关闭只接受从遮罩自身开始的完整点击，提交期间始终锁定。 */
export function shouldCloseGroupCreatorFromMask(
  pointerStartedOnMask: boolean,
  creating: boolean
): boolean {
  return pointerStartedOnMask && !creating
}
