import { defineStore } from 'pinia'

/** 头像文件到达后递增局部版本，让已失败的 pantry-avatar URL 重新加载。 */
export const useAvatarsStore = defineStore('avatars', {
  state: () => ({
    versions: {} as Record<string, number>,
    initialized: false
  }),
  getters: {
    versionOf: (state) => (hash: string): number => state.versions[hash] ?? 0
  },
  actions: {
    init(): void {
      if (this.initialized) return
      this.initialized = true
      window.pantry.onAvatarReady((hash) => {
        this.versions[hash] = (this.versions[hash] ?? 0) + 1
      })
    }
  }
})
