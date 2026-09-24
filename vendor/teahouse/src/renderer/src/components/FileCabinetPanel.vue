<script setup lang="ts">
import { tr } from '../utils/i18n'
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  SHARE_FAIL_TEXT,
  SHARE_UPLOAD_FAIL_TEXT,
  type ShareBrowseFailReason,
  type TransferView
} from '../../../shared/ipc'
import { SHARE_DIR_MAX_ENTRIES, type ShareEntry } from '../../../shared/protocol'
import { useChatStore } from '../stores/chat'
import { formatBytes } from '../utils/format'
import PantryIcon from './PantryIcon.vue'
import FileTypeIcon from './FileTypeIcon.vue'

// 对方的文件柜面板（ui-design §5 / 决议 #273，样式与手感按 #283 与文件柜窗口对齐）：
// 覆盖聊天右侧一整列，可边聊边浏览；要认真翻时用头部的「在文件柜里打开」换到左侧文件柜页签。
// 只做展示与请求编排，权限判定全部在对方本机（protocol §8.2）。

const props = defineProps<{ peerId: string; peerName: string }>()
const emit = defineEmits<{ close: [] }>()

interface Crumb {
  name: string
  path: string
}

const entries = ref<ShareEntry[]>([])
const path = ref('')
const perm = ref<'read' | 'write'>('read')
const snapshotId = ref('')
const total = ref(0)
const truncated = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
// 首屏失败（整页替换成错误态）与翻页失败（只在列表底部提示）必须分开，
// 否则滚动撞上对方 10 秒 5 次的列目录限流时，已经加载好的条目会被整片清掉（决议 #278）
const failReason = ref<ShareBrowseFailReason | null>(null)
const moreFailReason = ref<ShareBrowseFailReason | null>(null)
const picked = ref<Set<string>>(new Set())
const cursor = ref(-1)
const downloading = ref(false)
const downloadNote = ref('')
const transfer = ref<TransferView | null>(null)
const uploading = ref(false)
const dragActive = ref(false)
const chatStore = useChatStore()

const canUpload = computed(() => perm.value === 'write')
const uploadHint = computed(
  () => tr('文件会放进 TA 文件柜的「{0}」文件夹里', { 0: chatStore.selfNick || tr('你的名字') })
)

const crumbs = computed<Crumb[]>(() => {
  const list: Crumb[] = [{ name: tr('文件柜'), path: '' }]
  const segs = path.value ? path.value.split('/') : []
  let acc = ''
  for (const seg of segs) {
    acc = acc ? `${acc}/${seg}` : seg
    list.push({ name: seg, path: acc })
  }
  return list
})

const hasMore = computed(() => entries.value.length < total.value)
const failText = computed(() => (failReason.value ? tr(SHARE_FAIL_TEXT[failReason.value]) : ''))
const moreFailText = computed(() =>
  moreFailReason.value ? tr(SHARE_FAIL_TEXT[moreFailReason.value]) : ''
)
const pickedCount = computed(() => picked.value.size)
const allPagePicked = computed(
  () => entries.value.length > 0 && entries.value.every((e) => picked.value.has(e.name))
)
// 勾选只覆盖已经取回的条目，还有下一页时说「全选」会让人以为把 total 项都选上了
const pickAllLabel = computed(() => (hasMore.value ? tr('选择已加载') : tr('全选')))
const progressPercent = computed(() => {
  const t = transfer.value
  if (!t || t.totalSize <= 0) return 0
  return Math.min(100, Math.round((t.bytesDone / t.totalSize) * 100))
})

function childPath(name: string): string {
  return path.value ? `${path.value}/${name}` : name
}

async function load(target: string, keepPick = false): Promise<void> {
  loading.value = true
  failReason.value = null
  moreFailReason.value = null
  if (!keepPick) {
    picked.value = new Set()
    cursor.value = -1
  }
  const result = await window.pantry.browseShare(props.peerId, target, 0)
  loading.value = false
  if (!result.ok) {
    failReason.value = result.reason
    entries.value = []
    total.value = 0
    return
  }
  path.value = result.path
  perm.value = result.perm
  snapshotId.value = result.snapshotId
  entries.value = result.entries
  total.value = result.total
  truncated.value = result.truncated
}

// 滚到底继续取下一页；快照失效（gone）时静默从第 0 页重来，用户无感
async function loadMore(): Promise<void> {
  if (loadingMore.value || loading.value || !hasMore.value) return
  loadingMore.value = true
  moreFailReason.value = null
  const result = await window.pantry.browseShare(
    props.peerId,
    path.value,
    entries.value.length,
    snapshotId.value
  )
  loadingMore.value = false
  if (!result.ok) {
    if (result.reason === 'gone') {
      await load(path.value, true)
      return
    }
    // 已经取到的条目一律保留，失败只落在列表末尾
    moreFailReason.value = result.reason
    return
  }
  entries.value = [...entries.value, ...result.entries]
  total.value = result.total
  snapshotId.value = result.snapshotId
}

function onScroll(event: Event): void {
  // 上一页刚失败（多半是撞了限流）就停下等用户点重试，继续滚不再自动重发
  if (moreFailReason.value) return
  const el = event.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) void loadMore()
}

function goUp(): void {
  if (crumbs.value.length < 2) return
  void load(crumbs.value[crumbs.value.length - 2].path)
}

// 单击选中、双击进目录（决议 #283）：与文件柜窗口同一套手感，也才谈得上多选
function onRowClick(index: number, event: MouseEvent): void {
  const entry = entries.value[index]
  if (!entry) return
  if (event.shiftKey && cursor.value >= 0) {
    const [a, b] = cursor.value <= index ? [cursor.value, index] : [index, cursor.value]
    const next = new Set(picked.value)
    for (let i = a; i <= b; i += 1) next.add(entries.value[i].name)
    picked.value = next
    cursor.value = index
    return
  }
  if (event.ctrlKey || event.metaKey) {
    togglePick(entry.name)
    cursor.value = index
    return
  }
  picked.value = new Set([entry.name])
  cursor.value = index
}

function onRowOpen(index: number): void {
  const entry = entries.value[index]
  if (!entry) return
  if (entry.isDir) void load(childPath(entry.name))
  else void download(false, [childPath(entry.name)])
}

function togglePick(name: string): void {
  const next = new Set(picked.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  picked.value = next
}

function toggleAll(): void {
  picked.value = allPagePicked.value ? new Set() : new Set(entries.value.map((e) => e.name))
}

async function download(saveAs: boolean, only?: string[]): Promise<void> {
  const paths = only ?? [...picked.value].map((name) => childPath(name))
  if (paths.length === 0 || downloading.value) return
  downloading.value = true
  downloadNote.value = ''
  transfer.value = null
  const result = await window.pantry.downloadShare(props.peerId, paths, saveAs)
  downloading.value = false
  if (!result.ok) {
    downloadNote.value = tr(SHARE_FAIL_TEXT[result.reason])
    return
  }
  if (result.canceled) return
  if (!only) picked.value = new Set()
  downloadNote.value = tr('已开始下载')
}

// 上传永远落到对方共享根下以我命名的子目录，与当前浏览到哪一层无关（决议 #272）
async function upload(directory: boolean): Promise<void> {
  if (!canUpload.value || uploading.value) return
  uploading.value = true
  downloadNote.value = ''
  transfer.value = null
  const result = await window.pantry.uploadShare(props.peerId, undefined, directory)
  uploading.value = false
  if (!result.ok) {
    downloadNote.value = tr(SHARE_UPLOAD_FAIL_TEXT[result.reason])
    return
  }
  if (result.canceled) return
  downloadNote.value = tr('正在上传 {0} 个文件', { 0: result.fileCount })
}

async function onDrop(event: DragEvent): Promise<void> {
  dragActive.value = false
  if (!canUpload.value || uploading.value) return
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((f) => (f as File & { path?: string }).path ?? '')
    .filter((p) => p.length > 0)
  if (paths.length === 0) return
  uploading.value = true
  downloadNote.value = ''
  transfer.value = null
  const granted = await window.pantry.grantFilePaths(paths)
  const result = await window.pantry.uploadShare(props.peerId, granted)
  uploading.value = false
  if (!result.ok) {
    downloadNote.value = tr(SHARE_UPLOAD_FAIL_TEXT[result.reason])
    return
  }
  if (!result.canceled) downloadNote.value = tr('正在上传 {0} 个文件', { 0: result.fileCount })
}

function onDragOver(event: DragEvent): void {
  if (!canUpload.value) return
  event.preventDefault()
  dragActive.value = true
}

// 拖过面板内部的子元素时，根节点上也会收到 dragleave 并让高亮闪一下；
// 只有真正离开面板边界（relatedTarget 已不在面板内，或拖出窗口为 null）才熄灭
function onDragLeave(event: DragEvent): void {
  const next = event.relatedTarget as Node | null
  if (next && (event.currentTarget as HTMLElement).contains(next)) return
  dragActive.value = false
}

/** 换到大视图（决议 #283/#284）：带着当前对端切到文件柜页签，面板随即收起 */
function openInCabinet(): void {
  void window.pantry.openCabinet(props.peerId)
  emit('close')
}

// 文件柜传输不进聊天流，进度只在本面板就地显示（决议 #275）
const stopTransfer = window.pantry.onTransferUpdated((view) => {
  if (view.peerId !== props.peerId || !view.msgId.startsWith('share:')) return
  transfer.value = view
  const up = view.direction === 'out'
  if (view.status === 'done') downloadNote.value = up ? tr('上传完成') : tr('下载完成')
  else if (view.status === 'failed') downloadNote.value = up ? tr('上传失败，可重试') : tr('下载失败，可重试')
  else if (view.status === 'canceled') downloadNote.value = tr('已取消')
})

function revealDone(): void {
  if (transfer.value?.status === 'done') void window.pantry.revealTransfer(transfer.value.transferId)
}

function cancelDownload(): void {
  if (transfer.value) void window.pantry.cancelTransfer(transfer.value.transferId)
}

watch(
  () => props.peerId,
  () => {
    transfer.value = null
    downloadNote.value = ''
    void load('')
  },
  { immediate: true }
)

onUnmounted(() => stopTransfer())
</script>

<template>
  <aside
    class="panel"
    :class="{ 'drag-active': dragActive }"
    :aria-label="tr('对方的文件柜')"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <header class="panel-head">
      <span class="panel-title" :title="tr('{0} 的文件柜', { 0: peerName })">{{ tr('{0}的文件柜', { 0: peerName }) }}</span>
      <span v-if="!failReason" class="perm" :class="perm">{{ canUpload ? tr('可上传') : tr('只读') }}</span>
      <button class="icon-btn" :title="tr('在文件柜里打开')" @click="openInCabinet">
        <PantryIcon name="external" :size="14" />
      </button>
      <button class="icon-btn" :title="tr('关闭')" @click="emit('close')">
        <PantryIcon name="x" :size="14" />
      </button>
    </header>

    <div class="crumbs">
      <button class="icon-btn" :title="tr('返回上级')" :disabled="crumbs.length < 2 || loading" @click="goUp">
        <PantryIcon name="chevron-left" :size="14" />
      </button>
      <div class="crumb-track">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 0" class="crumb-sep">/</span>
          <button
            class="crumb"
            :class="{ current: i === crumbs.length - 1 }"
            :disabled="i === crumbs.length - 1"
            @click="load(c.path)"
          >
            {{ c.name }}
          </button>
        </template>
      </div>
      <button class="icon-btn" :title="tr('刷新')" :disabled="loading" @click="load(path)">
        <PantryIcon name="refresh" :size="14" />
      </button>
    </div>

    <div v-if="loading" class="hint">{{ tr('正在读取…') }}</div>
    <div v-else-if="failReason" class="hint error">
      <span>{{ failText }}</span>
      <button class="retry" @click="load(path)">{{ tr('重试') }}</button>
    </div>
    <div v-else-if="entries.length === 0" class="hint">{{ tr('这个文件夹是空的') }}</div>
    <template v-else>
      <div class="list-head">
        <label class="pick-all">
          <input type="checkbox" :checked="allPagePicked" @change="toggleAll" />
          <span>{{ pickAllLabel }}</span>
        </label>
        <span class="count">{{ tr('{0} 项', { 0: total }) }}</span>
      </div>
      <div class="list" @scroll="onScroll">
        <div
          v-for="(entry, index) in entries"
          :key="entry.name"
          class="row"
          :class="{ picked: picked.has(entry.name) }"
          @click="onRowClick(index, $event)"
          @dblclick="onRowOpen(index)"
        >
          <input
            class="row-pick"
            type="checkbox"
            :checked="picked.has(entry.name)"
            :aria-label="tr('勾选 {0}', { 0: entry.name })"
            @click.stop
            @change="togglePick(entry.name)"
          />
          <FileTypeIcon class="row-icon" :name="entry.name" :dir="entry.isDir" :size="20" />
          <span class="row-name" :title="entry.name">{{ entry.name }}</span>
          <span class="row-size">{{ entry.isDir ? '' : formatBytes(entry.size) }}</span>
        </div>
        <div v-if="loadingMore" class="hint small">{{ tr('正在加载更多…') }}</div>
        <div v-else-if="moreFailReason" class="hint small error inline">
          <span>{{ moreFailText }}</span>
          <button class="retry" @click="loadMore">{{ tr('重试') }}</button>
        </div>
        <div v-else-if="truncated" class="hint small">{{ tr('目录内容过多，仅显示前 {0} 项', { 0: SHARE_DIR_MAX_ENTRIES }) }}</div>
      </div>
    </template>

    <div v-if="transfer || downloadNote" class="progress-row">
      <div v-if="transfer && (transfer.status === 'accepted' || transfer.status === 'offering')" class="bar">
        <span class="bar-fill" :style="{ width: `${progressPercent}%` }"></span>
      </div>
      <span class="progress-text">{{ downloadNote || `${progressPercent}%` }}</span>
      <button
        v-if="transfer && (transfer.status === 'accepted' || transfer.status === 'offering')"
        class="link"
        @click="cancelDownload"
      >{{ tr('取消') }}</button>
      <button
        v-else-if="transfer?.status === 'done' && transfer.direction === 'in'"
        class="link"
        @click="revealDone"
      >{{ tr('打开位置') }}</button>
    </div>

    <footer class="panel-foot">
      <div class="foot-row">
        <span class="foot-sum">
          <template v-if="pickedCount > 0">{{ tr('已选') }}<b>{{ pickedCount }}</b>{{ tr('项') }}</template>
          <template v-else-if="!failReason">{{ tr('双击进文件夹') }}</template>
        </span>
        <div class="foot-actions">
          <template v-if="pickedCount > 0">
            <button class="ghost" :disabled="downloading" @click="download(true)">{{ tr('另存为') }}</button>
            <button class="primary" :disabled="downloading" @click="download(false)">{{ tr('下载（{0}）', { 0: pickedCount }) }}</button>
          </template>
          <template v-else-if="canUpload">
            <button class="ghost" :disabled="uploading" @click="upload(true)">{{ tr('上传文件夹') }}</button>
            <button class="primary" :disabled="uploading" @click="upload(false)">{{ tr('上传到 TA 的柜子') }}</button>
          </template>
        </div>
      </div>
      <p v-if="canUpload" class="foot-note">{{ uploadHint }}</p>
    </footer>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 320px;
  border-left: 1px solid var(--line);
  background: var(--bg-window);
  box-shadow: -10px 0 28px rgba(0, 0, 0, 0.12);
  z-index: 26;
  display: flex;
  flex-direction: column;
  /* 顶部 40px 让出沉浸式拖拽带（同群信息面板，决议 #67） */
  padding: 40px 0 0;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 8px 12px;
}

.panel-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 权限徽标从底栏上移到头部（决议 #283），底栏让位给选中摘要与按钮 */
.perm {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--line);
  color: var(--text-2);
}

.perm.write {
  background: var(--primary-weak);
  color: var(--primary);
}

.icon-btn {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--line);
  color: var(--primary);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px 8px;
  border-bottom: 1px solid var(--line);
}

.crumb-track {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  white-space: nowrap;
}

.crumb {
  flex-shrink: 0;
  border: none;
  background: transparent;
  padding: 2px 4px;
  font-size: 12px;
  color: var(--primary);
  cursor: pointer;
}

.crumb.current {
  color: var(--text-1);
  cursor: default;
}

.crumb-sep {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 12px;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-3);
}

.pick-all {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 6px;
}

/* 行高 36px（决议 #283）：与窗口版共用一套语义，面板窄一档更紧凑 */
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 6px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--surface-hover);
}

.row.picked {
  background: var(--surface-selected);
}

/* 未勾选时复选框只在 hover / 选中 / 聚焦时露出，平时让位给文件名 */
.row-pick {
  flex-shrink: 0;
  opacity: 0;
}

.row:hover .row-pick,
.row.picked .row-pick,
.row-pick:focus-visible {
  opacity: 1;
}

.row-icon {
  flex-shrink: 0;
}

.row-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-size {
  flex-shrink: 0;
  min-width: 58px;
  text-align: right;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.hint {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}

.hint.small {
  padding: 10px 12px;
}

.hint.error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  color: var(--text-2);
}

/* 翻页失败贴在列表末尾，横排更省纵向空间，也和上方条目区分开 */
.hint.inline {
  flex-direction: row;
  justify-content: center;
  gap: 8px;
}

.retry,
.link {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--text-2);
}

.bar {
  flex: 1;
  min-width: 0;
  height: 4px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  background: var(--primary);
  transition: width 160ms linear;
}

.progress-text {
  flex-shrink: 0;
}

.panel.drag-active {
  outline: 2px dashed var(--primary);
  outline-offset: -6px;
}

.panel-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
}

.foot-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.foot-sum {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
}

.foot-sum b {
  color: var(--text-1);
}

.foot-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
}

.foot-actions {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.primary,
.ghost {
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid transparent;
}

.primary {
  background: var(--primary);
  color: #fff;
}

.ghost {
  background: transparent;
  border-color: var(--line);
  color: var(--text-2);
}

.primary:disabled,
.ghost:disabled {
  opacity: 0.5;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill {
    transition: none;
  }
}
</style>
