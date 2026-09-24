import { defineStore } from 'pinia'
import type { HiveClaimableState, HiveClaimResult } from '../../../shared/ipc'

// Hive #59 待领取任务（runner 猝死 / 派遣失败 / 重启中断留下的）。
// 数据源 = 主进程派遣账本的只读投影；补派命令回主进程判权（仅原主人可补）。
// 未启用派遣账本时 tasks 恒空 —— 面板整体不渲染（不是错误态）。
export const useClaimableStore = defineStore('hive-claimable', {
  state: () => ({
    state: null as HiveClaimableState | null,
    initialized: false
  }),
  getters: {
    /** 某群的待领取任务（面板按群展示）。 */
    tasksOf: (state) => {
      return (groupId: string) => state.state?.tasks.filter((t) => t.groupId === groupId) ?? []
    },
    /** 自本机视角，这条任务是否归我（归我才有补派按钮）。 */
    isMine: (state) => {
      return (dispatcherId: string) => dispatcherId === (state.state?.selfId ?? '')
    }
  },
  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      await this.refresh()
      // 猝死是异步发生的（探测节拍发现）：不订阅就只能等下次手动刷新。
      window.pantry.onClaimableUpdated(() => {
        void this.refresh()
      })
    },
    async refresh(): Promise<void> {
      this.state = await window.pantry.listClaimable()
    },
    async claim(dispatchId: string): Promise<HiveClaimResult> {
      const result = await window.pantry.claimNow(dispatchId)
      await this.refresh()
      return result
    }
  }
})
