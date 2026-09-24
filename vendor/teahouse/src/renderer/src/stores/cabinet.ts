import { computed } from 'vue'
import { tr, language } from '../utils/i18n'
import { defineStore } from 'pinia'
import {
  SHARE_FAIL_TEXT,
  SHARE_ROOT_REJECT_TEXT,
  SHARE_UPLOAD_FAIL_TEXT,
  type PeerView,
  type SettingsView,
  type ShareBrowseFailReason,
  type ShareGrantView,
  type ShareRecentUploadView,
  type TransferView
} from '../../../shared/ipc'
import { CAPS, type ShareEntry, type ShareMode } from '../../../shared/protocol'
import { usePeersStore } from './peers'

// 文件柜（ui-design §8.2 / 决议 #283，改为主窗第三个页签见决议 #284）：
// 列表栏（CabinetList）与内容区（CabinetPane）分处三栏的两格，状态集中在本 store。
// 只做展示与请求编排，权限判定全部在对方本机（protocol §8.2）。

export type CabinetTarget = { kind: 'mine' } | { kind: 'peer'; peerId: string }
export type CabinetViewMode = 'list' | 'grid'

const VIEW_MODE_KEY = 'pantry.cabinet.viewMode'

export const SHARE_MODE_OPTIONS = computed<Array<{ label: string; value: ShareMode }>>(() => ([
  { label: tr('不共享'), value: 'off' },
  { label: tr('只读'), value: 'read' },
  { label: tr('可读可传'), value: 'write' }
]))

export function cabinetPeerName(p: PeerView): string {
  return p.remark || p.nick || p.nodeId.slice(0, 8)
}

interface CabinetState {
  initialized: boolean
  settings: SettingsView | null
  grants: ShareGrantView[]
  recentUploads: ShareRecentUploadView[]
  shareRootError: string
  target: CabinetTarget
  entries: ShareEntry[]
  path: string
  perm: 'read' | 'write'
  snapshotId: string
  total: number
  truncated: boolean
  loading: boolean
  loadingMore: boolean
  failReason: ShareBrowseFailReason | null
  moreFailReason: ShareBrowseFailReason | null
  picked: Set<string>
  cursor: number
  viewMode: CabinetViewMode
  downloading: boolean
  uploading: boolean
  note: string
  transfer: TransferView | null
  toast: string
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export const useCabinetStore = defineStore('cabinet', {
  state: (): CabinetState => ({
    initialized: false,
    settings: null,
    grants: [],
    recentUploads: [],
    shareRootError: '',
    target: { kind: 'mine' },
    entries: [],
    path: '',
    perm: 'read',
    snapshotId: '',
    total: 0,
    truncated: false,
    loading: false,
    loadingMore: false,
    failReason: null,
    moreFailReason: null,
    picked: new Set<string>(),
    cursor: -1,
    viewMode: 'list',
    downloading: false,
    uploading: false,
    note: '',
    transfer: null,
    toast: ''
  }),

  getters: {
    shareRoot: (state) => state.settings?.fileCabinet.root ?? '',
    shareMode: (state): ShareMode => state.settings?.fileCabinet.mode ?? 'off',
    selfName: (state) => state.settings?.nick.trim() || tr('你的名字'),

    shareModeHint(): string {
      if (!this.shareRoot) return tr('先选择共享目录，权限才会生效。')
      if (this.shareMode === 'write') {
        return tr('同事可以浏览、下载，也能往你的文件柜放新文件；他们不能删除、改名或覆盖你已有的文件。')
      }
      if (this.shareMode === 'read') return tr('同事可以浏览和下载，不能往里放东西。')
      return tr('默认谁都看不到；可以在下面单独给某位同事开放。')
    },

    /** 同事列表：只收声明 shr1 的联系人，在线在前、离线灰显在后（决议 #17/#283） */
    cabinetPeers(): PeerView[] {
      return usePeersStore()
        .peers.filter((p) => Array.isArray(p.caps) && p.caps.includes(CAPS.fileCabinet))
        .sort((a, b) => {
          if (a.online !== b.online) return a.online ? -1 : 1
          return cabinetPeerName(a).localeCompare(cabinetPeerName(b), language.value)
        })
    },

    /** 例外候选：所有还没设过例外的联系人（不限于支持文件柜的） */
    grantCandidates(): Array<{ label: string; value: string }> {
      return usePeersStore()
        .peers.filter((p) => !this.grants.some((g) => g.nodeId === p.nodeId))
        .map((p) => ({
          label: `${cabinetPeerName(p)}${p.online ? '' : tr('（离线）')}`,
          value: p.nodeId
        }))
    },

    activePeer(state): PeerView | null {
      if (state.target.kind !== 'peer') return null
      return usePeersStore().byId(state.target.peerId) ?? null
    },

    canUpload: (state) => state.perm === 'write',
    hasMore: (state) => state.entries.length < state.total,
    failText: (state) => (state.failReason ? tr(SHARE_FAIL_TEXT[state.failReason]) : ''),
    moreFailText: (state) => (state.moreFailReason ? tr(SHARE_FAIL_TEXT[state.moreFailReason]) : ''),
    pickedCount: (state) => state.picked.size,
    pickedSize: (state) =>
      state.entries
        .filter((e) => state.picked.has(e.name) && !e.isDir)
        .reduce((sum, e) => sum + e.size, 0),
    allLoadedPicked: (state) =>
      state.entries.length > 0 && state.entries.every((e) => state.picked.has(e.name)),
    // 勾选只覆盖已取回的条目，还有下一页时说「全选」会让人以为把 total 项都选上了（决议 #281）
    pickAllLabel(): string {
      return this.hasMore ? tr('选择已加载') : tr('全选')
    },
    crumbs: (state) => {
      const list = [{ name: tr('文件柜'), path: '' }]
      let acc = ''
      for (const seg of state.path ? state.path.split('/') : []) {
        acc = acc ? `${acc}/${seg}` : seg
        list.push({ name: seg, path: acc })
      }
      return list
    },
    progressPercent: (state) => {
      const t = state.transfer
      if (!t || t.totalSize <= 0) return 0
      return Math.min(100, Math.round((t.bytesDone / t.totalSize) * 100))
    },
    transferActive: (state) =>
      state.transfer?.status === 'accepted' || state.transfer?.status === 'offering'
  },

  actions: {
    async init(): Promise<void> {
      if (this.initialized) return
      this.initialized = true
      await usePeersStore().init()
      this.settings = await window.pantry.getSettings()
      window.pantry.onSettingsUpdated((view) => {
        this.settings = view
      })
      try {
        const saved = localStorage.getItem(VIEW_MODE_KEY)
        if (saved === 'grid' || saved === 'list') this.viewMode = saved
      } catch {
        // 读不到就用默认列表视图
      }
      // 文件柜传输不进聊天流，进度只在文件柜里就地显示（决议 #275）
      window.pantry.onTransferUpdated((view) => {
        if (!view.msgId.startsWith('share:')) return
        // 别人往我柜子里放完东西：正看着「我的文件柜」时顺手刷新汇总列表（决议 #283）
        if (this.target.kind === 'mine') {
          if (view.direction === 'in' && view.status === 'done') void this.loadRecentUploads()
          return
        }
        if (view.peerId !== this.target.peerId) return
        this.transfer = view
        const up = view.direction === 'out'
        if (view.status === 'done') this.note = up ? tr('上传完成') : tr('下载完成')
        else if (view.status === 'failed') this.note = up ? tr('上传失败，可重试') : tr('下载失败，可重试')
        else if (view.status === 'canceled') this.note = tr('已取消')
      })
      await Promise.all([this.loadGrants(), this.loadRecentUploads()])
    },

    flashToast(text: string): void {
      this.toast = text
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => (this.toast = ''), 1800)
    },

    childPath(name: string): string {
      return this.path ? `${this.path}/${name}` : name
    },

    // ——— 目标切换 ———

    selectMine(): void {
      this.target = { kind: 'mine' }
      this.resetBrowse()
      void this.loadRecentUploads()
    },

    selectPeer(peerId: string): void {
      if (this.target.kind === 'peer' && this.target.peerId === peerId) return
      this.target = { kind: 'peer', peerId }
      this.resetBrowse()
      void this.load('')
    },

    resetBrowse(): void {
      this.transfer = null
      this.note = ''
      this.entries = []
      this.total = 0
      this.truncated = false
      this.path = ''
      this.picked = new Set()
      this.cursor = -1
      this.failReason = null
      this.moreFailReason = null
    },

    // ——— 浏览 ———

    async load(next: string, keepPick = false): Promise<void> {
      if (this.target.kind !== 'peer') return
      const peerId = this.target.peerId
      this.loading = true
      this.failReason = null
      this.moreFailReason = null
      if (!keepPick) {
        this.picked = new Set()
        this.cursor = -1
      }
      const result = await window.pantry.browseShare(peerId, next, 0)
      // 请求期间用户可能已经切到别人，迟到的结果直接丢弃
      if (this.target.kind !== 'peer' || this.target.peerId !== peerId) return
      this.loading = false
      if (!result.ok) {
        this.failReason = result.reason
        this.entries = []
        this.total = 0
        return
      }
      this.path = result.path
      this.perm = result.perm
      this.snapshotId = result.snapshotId
      this.entries = result.entries
      this.total = result.total
      this.truncated = result.truncated
    },

    // 滚到底继续取下一页；快照失效（gone）时静默从第 0 页重来，用户无感
    async loadMore(): Promise<void> {
      if (this.target.kind !== 'peer' || this.loadingMore || this.loading || !this.hasMore) return
      const peerId = this.target.peerId
      this.loadingMore = true
      this.moreFailReason = null
      const result = await window.pantry.browseShare(
        peerId,
        this.path,
        this.entries.length,
        this.snapshotId
      )
      if (this.target.kind !== 'peer' || this.target.peerId !== peerId) return
      this.loadingMore = false
      if (!result.ok) {
        if (result.reason === 'gone') {
          await this.load(this.path, true)
          return
        }
        // 已取到的条目一律保留，失败只落在列表末尾（决议 #278）
        this.moreFailReason = result.reason
        return
      }
      this.entries = [...this.entries, ...result.entries]
      this.total = result.total
      this.snapshotId = result.snapshotId
    },

    goUp(): void {
      if (this.crumbs.length < 2) return
      void this.load(this.crumbs[this.crumbs.length - 2].path)
    },

    // ——— 选中与打开（文件管理器口径，决议 #283）———

    clickRow(index: number, modifiers: { shift: boolean; mod: boolean }): void {
      const entry = this.entries[index]
      if (!entry) return
      if (modifiers.shift && this.cursor >= 0) {
        this.pickRange(this.cursor, index)
        return
      }
      if (modifiers.mod) {
        this.togglePick(entry.name)
        this.cursor = index
        return
      }
      this.picked = new Set([entry.name])
      this.cursor = index
    },

    openRow(index: number): void {
      const entry = this.entries[index]
      if (!entry) return
      if (entry.isDir) void this.load(this.childPath(entry.name))
      else void this.download(false, [this.childPath(entry.name)])
    },

    togglePick(name: string): void {
      const next = new Set(this.picked)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      this.picked = next
    },

    pickRange(from: number, to: number): void {
      const [a, b] = from <= to ? [from, to] : [to, from]
      const next = new Set(this.picked)
      for (let i = a; i <= b; i += 1) {
        const entry = this.entries[i]
        if (entry) next.add(entry.name)
      }
      this.picked = next
      this.cursor = to
    },

    toggleAll(): void {
      this.picked = this.allLoadedPicked ? new Set() : new Set(this.entries.map((e) => e.name))
    },

    moveCursor(delta: number, extend: boolean): void {
      if (this.entries.length === 0) return
      const from = this.cursor < 0 ? (delta > 0 ? -1 : 0) : this.cursor
      const next = Math.max(0, Math.min(this.entries.length - 1, from + delta))
      if (extend && this.cursor >= 0) this.pickRange(this.cursor, next)
      else {
        this.picked = new Set([this.entries[next].name])
        this.cursor = next
      }
    },

    // ——— 下载与上传 ———

    async download(saveAs: boolean, only?: string[]): Promise<void> {
      if (this.target.kind !== 'peer') return
      const paths = only ?? [...this.picked].map((name) => this.childPath(name))
      if (paths.length === 0 || this.downloading) return
      this.downloading = true
      this.note = ''
      this.transfer = null
      const result = await window.pantry.downloadShare(this.target.peerId, paths, saveAs)
      this.downloading = false
      if (!result.ok) {
        this.note = tr(SHARE_FAIL_TEXT[result.reason])
        return
      }
      if (result.canceled) return
      if (!only) this.picked = new Set()
      this.note = tr('已开始下载')
    },

    // 上传永远落到对方共享根下以我命名的子目录，与当前浏览到哪一层无关（决议 #272）
    async upload(directory: boolean): Promise<void> {
      if (this.target.kind !== 'peer' || !this.canUpload || this.uploading) return
      this.uploading = true
      this.note = ''
      this.transfer = null
      const result = await window.pantry.uploadShare(this.target.peerId, undefined, directory)
      this.uploading = false
      if (!result.ok) {
        this.note = tr(SHARE_UPLOAD_FAIL_TEXT[result.reason])
        return
      }
      if (!result.canceled) this.note = tr('正在上传 {0} 个文件', { 0: result.fileCount })
    },

    async uploadDropped(localPaths: string[]): Promise<void> {
      if (this.target.kind !== 'peer' || !this.canUpload || this.uploading) return
      if (localPaths.length === 0) return
      this.uploading = true
      this.note = ''
      this.transfer = null
      const granted = await window.pantry.grantFilePaths(localPaths)
      const result = await window.pantry.uploadShare(this.target.peerId, granted)
      this.uploading = false
      if (!result.ok) {
        this.note = tr(SHARE_UPLOAD_FAIL_TEXT[result.reason])
        return
      }
      if (!result.canceled) this.note = tr('正在上传 {0} 个文件', { 0: result.fileCount })
    },

    cancelTransfer(): void {
      if (this.transfer) void window.pantry.cancelTransfer(this.transfer.transferId)
    },

    revealTransfer(): void {
      if (this.transfer) void window.pantry.revealTransfer(this.transfer.transferId)
    },

    /** 点「最近有人放进来」的一条：打开对方在我柜子里的落盘目录（复用既有 file:reveal） */
    revealUpload(transferId: string): void {
      void window.pantry.revealTransfer(transferId)
    },

    setViewMode(mode: CabinetViewMode): void {
      this.viewMode = mode
      try {
        localStorage.setItem(VIEW_MODE_KEY, mode)
      } catch {
        // 隐私模式等写不进去不影响使用
      }
    },

    // ——— 我的文件柜 ———

    async loadGrants(): Promise<void> {
      this.grants = await window.pantry.listShareGrants()
    },

    async loadRecentUploads(): Promise<void> {
      this.recentUploads = await window.pantry.listRecentShareUploads(10)
    },

    async pickShareRoot(): Promise<void> {
      this.shareRootError = ''
      const result = await window.pantry.setShareRoot()
      if (!result.ok) {
        this.shareRootError = tr(SHARE_ROOT_REJECT_TEXT[result.reason])
        return
      }
      if (result.canceled) return
      this.settings = result.view
      this.flashToast(tr('共享目录已设置'))
    },

    async clearShareRoot(): Promise<void> {
      this.shareRootError = ''
      const result = await window.pantry.setShareRoot(true)
      if (result.ok && !result.canceled) {
        this.settings = result.view
        this.flashToast(tr('已停止共享'))
      }
    },

    revealShareRoot(): void {
      void window.pantry.revealShareRoot()
    },

    async changeShareMode(mode: ShareMode): Promise<void> {
      if (mode === this.shareMode) return
      this.settings = await window.pantry.setShareMode(mode)
      this.flashToast(tr('设置已保存'))
    },

    // 新例外默认给"只读"：加例外多半是为了对某人开一条缝，写权限再手动往上调
    async addGrant(nodeId: string): Promise<void> {
      this.grants = await window.pantry.setShareGrant(nodeId, 'read')
      this.flashToast(tr('已添加例外'))
    },

    async changeGrant(nodeId: string, mode: ShareMode): Promise<void> {
      this.grants = await window.pantry.setShareGrant(nodeId, mode)
      this.flashToast(tr('设置已保存'))
    },

    async removeGrant(nodeId: string): Promise<void> {
      this.grants = await window.pantry.setShareGrant(nodeId, null)
      this.flashToast(tr('已恢复跟随默认'))
    }
  }
})
