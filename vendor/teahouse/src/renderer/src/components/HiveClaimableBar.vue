<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { tr } from '../utils/i18n'
import { usePeersStore } from '../stores/peers'
import { useClaimableStore } from '../stores/hive-claimable'

// Hive #59 群内待领取任务条：runner 猝死 / 派遣失败留下的任务 + 人工补派按钮。
//
// 与「正常退群」在视觉上明确不同（AC2）：正常退群是消息流里一条系统事件，本组件是
// 常驻的状态条 + 醒目红边；异常退群另有 `⚠ 异常退群` 群文本（见 abnormal-exit.ts）。
// AC3 的「默认不自动补派」在这里是一条**需要人按**的按钮，而不是自动重试。
const props = defineProps<{ groupId: string }>()

const peersStore = usePeersStore()
const claimableStore = useClaimableStore()

const feedback = ref('')
const claiming = ref('')

onMounted(() => {
  void claimableStore.init()
})

const tasks = computed(() => claimableStore.tasksOf(props.groupId))

const memberName = (id: string): string => peersStore.nameOf(id)

async function onClaim(dispatchId: string): Promise<void> {
  claiming.value = dispatchId
  feedback.value = ''
  const result = await claimableStore.claim(dispatchId)
  feedback.value = result.ok
    ? tr('补派成功，已摇入 {0}', { 0: (result.memberIds ?? []).length || 1 })
    : (result.reason ?? tr('补派被拒'))
  claiming.value = ''
}
</script>

<template>
  <div v-if="tasks.length > 0" class="claim-bar" data-testid="claimable-bar">
    <div v-for="task in tasks" :key="task.dispatchId" class="claim-row" data-testid="claimable-task">
      <span class="claim-icon" aria-hidden="true">⚠</span>
      <span class="claim-main">
        <span class="claim-title">{{ tr('待领取任务') }}</span>
        <span class="claim-goal">{{ task.goalOneLine }}</span>
        <span class="claim-meta">
          {{ tr('原主人') }} {{ memberName(task.dispatcherId) }} · {{ task.reason }}
        </span>
      </span>
      <button
        v-if="claimableStore.isMine(task.dispatcherId)"
        type="button"
        class="claim-btn"
        :disabled="claiming === task.dispatchId"
        data-testid="claim-now"
        @click="onClaim(task.dispatchId)"
      >{{ claiming === task.dispatchId ? tr('补派中…') : tr('补派') }}</button>
      <span v-else class="claim-readonly">{{ tr('等待原主人补派') }}</span>
    </div>
    <span v-if="feedback" class="claim-feedback" role="status">{{ feedback }}</span>
  </div>
</template>

<style scoped>
/* Hive 品牌：深蓝底 + 红强调（tokens.css 的 --primary 已是 #e94560）。
   待领取是异常态，故用红边（--danger 若有则复用，否则用 --primary 的红）。 */
.claim-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--primary-weak);
}
.claim-row {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--primary);
  border-radius: 8px;
  padding: 6px 10px;
  background: var(--bg-list);
}
.claim-icon {
  color: var(--primary);
  font-size: 14px;
  flex-shrink: 0;
}
.claim-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.claim-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary);
}
.claim-goal {
  font-size: 12px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.claim-meta {
  font-size: 11px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.claim-btn {
  flex-shrink: 0;
  border: 1px solid var(--primary);
  background: var(--primary);
  color: #fff;
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12px;
  cursor: pointer;
}
.claim-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.claim-readonly {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-2);
}
.claim-feedback {
  font-size: 11px;
  color: var(--text-2);
}
</style>
