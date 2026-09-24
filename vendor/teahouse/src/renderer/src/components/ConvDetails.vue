<script setup lang="ts">
import { computed, watch } from 'vue'
import { tr } from '../utils/i18n'
import { BURDEN_TAGS } from '../../../shared/ipc'
import type { PeerView } from '../../../shared/ipc'
import { useChatStore } from '../stores/chat'
import { useGroupsStore } from '../stores/groups'
import { usePeersStore } from '../stores/peers'
import AvatarMark from './AvatarMark.vue'
import GroupAvatar from './GroupAvatar.vue'

// Hive #27 右栏详情面板（C 面，App.vue defineAsyncComponent 懒加载，不进静态闭包）。
// 数据全部内部自取 store（chat/groups/peers），不从 App 层穿透成员数组；
// burden 色相/文案由主进程透传（PeerBurdenView），渲染层零中文字面量、不建色表。
const props = defineProps<{ convId: string; isGroup: boolean }>()

const chatStore = useChatStore()
const groupsStore = useGroupsStore()
const peersStore = usePeersStore()

// convId 约定：'group:<groupId>' / 'single:<nodeId>'（与 ChatPane 同一口径）。
const groupId = computed(() =>
  props.isGroup && props.convId.startsWith('group:') ? props.convId.slice('group:'.length) : ''
)
const peerId = computed(() =>
  !props.isGroup && props.convId.startsWith('single:') ? props.convId.slice('single:'.length) : ''
)

const group = computed(() => (groupId.value ? (groupsStore.byId[groupId.value] ?? null) : null))
const peer = computed(() => (peerId.value ? (peersStore.byId(peerId.value) ?? null) : null))

// 群详情可能未经 ChatPane 打开就直达（通知/托盘）：确保 GroupView 已拉取。
watch(
  groupId,
  (id) => {
    if (id) void groupsStore.ensure(id)
  },
  { immediate: true }
)

/** 统一显示名：备注优先于昵称；自己显示「昵称（我）」（决议 #83）。 */
function displayName(id: string, p: PeerView | undefined): string {
  if (id === chatStore.selfId) {
    return chatStore.selfNick ? tr('{0}（我）', { 0: chatStore.selfNick }) : tr('我')
  }
  return p ? p.remark || p.nick : peersStore.nameOf(id)
}

function avatarOf(id: string, p: PeerView | undefined): number {
  if (id === chatStore.selfId) return chatStore.selfAvatar
  return p?.avatar ?? -1
}

function avatarHashOf(id: string, p: PeerView | undefined): string {
  if (id === chatStore.selfId) return chatStore.selfAvatarHash
  return p?.avatarHash ?? ''
}

interface MemberRow {
  id: string
  peer: PeerView | undefined
  name: string
  avatar: number
  avatarHash: string
  /** burden.eligible = 五档点（色相/悬浮走主进程透传）；否则底座绿/灰 presence。 */
  burdened: boolean
  online: boolean
}

const memberRows = computed<MemberRow[]>(() => {
  const g = group.value
  if (!g) return []
  return g.members.map((id) => {
    const p = id === chatStore.selfId ? undefined : peersStore.byId(id)
    return {
      id,
      peer: p,
      name: displayName(id, p),
      avatar: avatarOf(id, p),
      avatarHash: avatarHashOf(id, p),
      burdened: Boolean(p?.burden?.eligible),
      // 自己恒在线；对端缺数据按离线渲染（不猜）。
      online: id === chatStore.selfId ? true : (p?.online ?? false)
    }
  })
})

/** Active agents：有负担面的成员，按五档顺序（idle → about-to-blow）排序。 */
const activeAgents = computed<MemberRow[]>(() => {
  const order = new Map(BURDEN_TAGS.map((tag, i) => [tag, i]))
  return memberRows.value
    .filter((row) => row.burdened)
    .sort(
      (a, b) =>
        (order.get(a.peer!.burden!.tag) ?? BURDEN_TAGS.length) -
        (order.get(b.peer!.burden!.tag) ?? BURDEN_TAGS.length)
    )
})

function orgPath(p: PeerView): string {
  return [p.company, p.dept, p.team].filter(Boolean).join(' / ') || tr('未分组')
}
</script>

<template>
  <div class="conv-details">
    <!-- 会话信息：群聊 = GroupView；单聊 = 对端 PeerView -->
    <section class="sect info">
      <template v-if="isGroup">
        <div v-if="group" class="info-head">
          <GroupAvatar class="info-avatar" :avatar-hash="group.avatarHash" :icon-size="22" />
          <div class="info-main">
            <strong class="info-name">{{ group.name || tr('讨论组') }}</strong>
            <span class="info-sub">{{ tr('{0} 人', { 0: group.members.length }) }}</span>
          </div>
        </div>
        <p v-if="group?.description" class="info-desc">{{ group.description }}</p>
      </template>
      <template v-else-if="peer">
        <div class="info-head">
          <AvatarMark
            class="info-avatar"
            :avatar="peer.avatar"
            :avatar-hash="peer.avatarHash"
            :name="peer.remark || peer.nick"
            :offline="!peer.online"
          />
          <div class="info-main">
            <strong class="info-name">{{ peer.remark || peer.nick }}</strong>
            <small v-if="peer.remark" class="info-sub">{{ tr('昵称：{0}', { 0: peer.nick }) }}</small>
          </div>
        </div>
        <dl class="kv">
          <div class="kv-row">
            <dt>{{ tr('组织') }}</dt>
            <dd>{{ orgPath(peer) }}</dd>
          </div>
          <div class="kv-row">
            <dt>IP</dt>
            <dd>{{ peer.ip || tr('未知') }}</dd>
          </div>
        </dl>
      </template>
    </section>

    <!-- Members（仅群聊）：头像右下角五档点 / 底座绿灰点（sprite 契约 A1，不放 GIF） -->
    <section v-if="isGroup && group" class="sect">
      <h3 class="sect-title">{{ tr('成员') }}</h3>
      <ul class="members">
        <li v-for="row in memberRows" :key="row.id" class="member-row">
          <span class="avatar-wrap">
            <AvatarMark
              class="member-avatar"
              :avatar="row.avatar"
              :avatar-hash="row.avatarHash"
              :name="row.name"
              :offline="!row.online"
            />
            <span
              v-if="row.burdened"
              class="dot burden-dot"
              :style="{ background: row.peer!.burden!.color }"
              :title="row.peer!.burden!.title"
            ></span>
            <span v-else class="dot burden-dot" :class="row.online ? 'on' : 'off'"></span>
          </span>
          <span class="member-name" :class="{ dim: !row.online }">{{ row.name }}</span>
        </li>
      </ul>
    </section>

    <!-- Active agents（仅群聊）：无 eligible 成员时整节隐藏 -->
    <section v-if="isGroup && activeAgents.length > 0" class="sect">
      <h3 class="sect-title">{{ tr('活跃 agent') }}</h3>
      <ul class="members">
        <li v-for="row in activeAgents" :key="row.id" class="member-row">
          <span class="agent-dot" :style="{ background: row.peer!.burden!.color }" :title="row.peer!.burden!.title"></span>
          <span class="member-name">{{ row.name }}</span>
          <span class="agent-label">{{ row.peer!.burden!.label }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/* 容器 320px 宽由 App.vue 的 .details 给；本组件只负责自身纵向滚动。 */
.conv-details {
  height: 100%;
  overflow-y: auto;
  padding: 10px 8px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.sect-title {
  margin: 0 0 6px;
  padding: 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.01em;
}
.info-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 6px;
}
.info-avatar {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  font-size: 16px;
}
.info-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.info-name {
  color: var(--text-1);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.info-sub {
  font-size: 11px;
  color: var(--text-2);
}
.info-desc {
  margin: 8px 6px 0;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
  word-break: break-word;
}
.kv {
  margin: 10px 6px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.kv-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}
.kv-row dt {
  color: var(--text-3);
  flex-shrink: 0;
}
.kv-row dd {
  margin: 0;
  color: var(--text-1);
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.members {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 2px 6px;
  border-radius: 8px;
}
.member-row:hover {
  background: var(--surface-hover);
}
.avatar-wrap {
  position: relative;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
}
.member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--primary);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 12px;
  flex-shrink: 0;
}
/* 五档状态点：头像右下角（sprite 契约 A1），样式仿 PeerList 的 .burden-dot */
.burden-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  border: 2px solid var(--bg-list);
  z-index: 1;
}
.member-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-1);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.member-name.dim {
  color: var(--text-2);
}
.agent-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-sizing: content-box;
}
.agent-label {
  font-size: 11px;
  color: var(--text-2);
  flex-shrink: 0;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-sizing: content-box;
}
.dot.on {
  background: var(--online);
}
.dot.off {
  background: var(--offline);
}
/* 五档负担点：色相走内联 style（A2 固定 hex 由主进程透传），尺寸与位置同底座绿/灰点。 */
</style>
