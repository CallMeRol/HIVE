import { defineStore } from 'pinia'
import type { HivePendingState, HivePendingResult } from '../../../shared/ipc'

// Hive #50 pending 收集期 + 确认键 + 会话目标（主进程 PendingService 的只读投影）。
// 未启用 pending 闸门（PANTRY_PENDING≠1）时 state = null，组件整体不渲染。
export const usePendingStore = defineStore('hive-pending', {
  state: () => ({
    state: null as HivePendingState | null,
    initialized: false
  }),
  getters: {
    /** 某成员是否在收集期（药丸显隐）。 */
    pendingOf: (state) => {
      return (memberId: string) => state.state?.pendings.find((p) => p.memberId === memberId) ?? null
    },
    /** 某成员在某群的目标状态（unset=未定 / frozen=已冻结）。 */
    goalOf: (state) => {
      return (memberId: string, groupId: string) =>
        state.state?.goals.find((g) => g.memberId === memberId && g.groupId === groupId) ?? null
    },
    canConfirm: (state) => {
      const selfId = state.state?.selfId ?? ''
      const grants = state.state?.confirmGrants ?? []
      return (ownerId: string) => ownerId === selfId || grants.includes(selfId)
    }
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      this.state = await window.pantry.getPendingState()
      if (!this.state) return
      window.pantry.onPendingUpdated(() => {
        void this.refresh()
      })
    },
    async refresh(): Promise<void> {
      this.state = await window.pantry.getPendingState()
    },
    async confirm(memberId: string, goalText?: string): Promise<HivePendingResult> {
      const result = await window.pantry.confirmPending(memberId, goalText)
      await this.refresh()
      return result
    },
    async drop(memberId: string): Promise<HivePendingResult> {
      const result = await window.pantry.dropPending(memberId)
      await this.refresh()
      return result
    },
    async grant(targetId: string, grant: boolean): Promise<HivePendingResult> {
      const result = await window.pantry.grantConfirm(targetId, grant)
      await this.refresh()
      return result
    },
    async freezeGoal(memberId: string, groupId: string, text: string): Promise<HivePendingResult> {
      const result = await window.pantry.freezeGoal(memberId, groupId, text)
      await this.refresh()
      return result
    }
  }
})
