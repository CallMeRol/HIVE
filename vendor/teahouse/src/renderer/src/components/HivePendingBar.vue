<script setup lang="ts">
import { computed, ref } from 'vue'
import { tr } from '../utils/i18n'
import { usePeersStore } from '../stores/peers'
import { usePendingStore } from '../stores/hive-pending'

// Hive #50 群内状态条：pending 收集期药丸（⏳ 收集期：目标 + 已 N 条 + 等待确认）
// 与会话目标徽标（目标未定 / 已冻结）。数据源 = main 进程 PendingService 投影。
const props = defineProps<{ groupId: string; ownerId: string }>()

const peersStore = usePeersStore()
const pendingStore = usePendingStore()

const feedback = ref('')
const goalDraft = ref('')
const editingGoal = ref(false)

const pending = computed(() =>
  pendingStore.state?.pendings.find((p) => p.groupId === props.groupId) ?? null
)
const goal = computed(() =>
  pendingStore.state?.goals.find((g) => g.groupId === props.groupId) ?? null
)
const isOwner = computed(() => props.ownerId === (pendingStore.state?.selfId ?? ''))
const granted = computed(() =>
  (pendingStore.state?.confirmGrants ?? []).includes(pendingStore.state?.selfId ?? '')
)
const canConfirm = computed(() => isOwner.value || granted.value)

const memberName = (id: string): string => peersStore.nameOf(id)

async function onConfirm(): Promise<void> {
  if (!pending.value) return
  const result = await pendingStore.confirm(pending.value.memberId, editingGoal.value ? goalDraft.value : undefined)
  feedback.value = result.ok ? tr('已确认开工') : (result.reason ?? tr('确认被拒'))
  editingGoal.value = false
  goalDraft.value = ''
}

async function onDrop(): Promise<void> {
  if (!pending.value) return
  const result = await pendingStore.drop(pending.value.memberId)
  feedback.value = result.ok ? tr('已丢弃收集期') : (result.reason ?? tr('丢弃被拒'))
}

async function onGrant(): Promise<void> {
  if (!pending.value || !isOwner.value) return
  const others = pending.value.entries.map((e) => e.senderId).filter((id) => id !== pendingStore.state?.selfId)
  const target = others[0]
  if (!target) {
    feedback.value = tr('没有可放权的成员')
    return
  }
  const result = await pendingStore.grant(target, true)
  feedback.value = result.ok ? tr('已放权给 {0}', { 0: memberName(target) }) : (result.reason ?? tr('放权被拒'))
}

async function onFreeze(): Promise<void> {
  if (!pending.value || !goalDraft.value.trim()) {
    feedback.value = tr('先填写目标')
    return
  }
  const result = await pendingStore.freezeGoal(pending.value.memberId, props.groupId, goalDraft.value.trim())
  feedback.value = result.ok ? tr('目标已冻结') : (result.reason ?? tr('冻结被拒'))
  editingGoal.value = false
  goalDraft.value = ''
}
</script>

<template>
  <div v-if="pendingStore.state && (pending || goal)" class="pending-bar">
    <!-- 收集期药丸（A5）：⏳ 收集期：目标 + 已 N 条 + 等待确认 -->
    <div v-if="pending" class="pill" data-testid="pending-pill">
      <span class="pill-icon">⏳</span>
      <span class="pill-text">
        {{ tr('收集期') }} · {{ tr('已 {0} 条', { 0: pending.entries.length }) }}
        <template v-if="goal?.state === 'frozen'"> · {{ goal.text }}</template>
        <template v-else> · {{ tr('目标未定') }}</template>
      </span>
      <span class="pill-wait">{{ tr('等待确认') }}</span>
      <span v-if="canConfirm" class="pill-actions">
        <button type="button" class="pill-btn primary" @click="onConfirm">{{ tr('确认开工') }}</button>
        <button v-if="isOwner" type="button" class="pill-btn" @click="onDrop">{{ tr('丢弃') }}</button>
        <button v-if="isOwner" type="button" class="pill-btn" @click="onGrant">{{ tr('放权') }}</button>
        <button
          v-if="isOwner && goal?.state !== 'frozen'"
          type="button"
          class="pill-btn"
          @click="editingGoal = !editingGoal"
        >{{ tr('定目标') }}</button>
      </span>
    </div>
    <!-- 目标状态徽标：目标未定 / 已冻结（PRD ②） -->
    <div v-else-if="goal" class="pill goal" data-testid="goal-badge">
      <span class="pill-text">
        <template v-if="goal.state === 'frozen'">🎯 {{ tr('目标已冻结') }}：{{ goal.text }}</template>
        <template v-else>🎯 {{ tr('目标未定') }}</template>
      </span>
    </div>
    <!-- 主人修订目标（冻结前） -->
    <div v-if="editingGoal && pending && isOwner" class="goal-edit">
      <input
        v-model="goalDraft"
        class="goal-input"
        maxlength="500"
        :placeholder="tr('输入会话目标，确认时冻结')"
        @keydown.enter="onFreeze"
      />
      <button type="button" class="pill-btn primary" @click="onFreeze">{{ tr('冻结目标') }}</button>
    </div>
    <span v-if="feedback" class="feedback" role="status">{{ feedback }}</span>
  </div>
</template>

<style scoped>
.pending-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 12px;
  flex-wrap: wrap;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-hover);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 10px;
  color: var(--text-1);
}
.pill.goal {
  border-style: dashed;
  color: var(--text-2);
}
.pill-icon {
  font-size: 12px;
}
.pill-wait {
  color: var(--text-2);
}
.pill-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: 4px;
}
.pill-btn {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-1);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}
.pill-btn.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.pill-btn:hover {
  filter: brightness(1.08);
}
.goal-edit {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.goal-input {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 12px;
  background: var(--bg-list);
  color: var(--text-1);
  min-width: 220px;
}
.feedback {
  color: var(--text-2);
}
</style>
