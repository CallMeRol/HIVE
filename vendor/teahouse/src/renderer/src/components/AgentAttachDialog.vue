<script setup lang="ts">
// 接入对话框（#49 AC1/AC2）：选 runtime / 成员名称 / 工作目录 / 模型 / permission 策略，
// 并把探测结果（含失败原因与可操作建议）如实摆出来。
//
// 两条呈现纪律：
//   - 模型与 permission 选项**来自探测**（adapter 自报），不在这里写死清单；
//   - 探测失败不隐藏、不改写成「默认值」：直接把 hint 显示给用户。
import { tr } from '../utils/i18n'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import type { AttachRuntime, AttachRuntimeProbe } from '../../../shared/ipc'
import { isPlainEscape } from '../utils/escape'

// 群列表由父组件传入而不是这里读 store：这个组件是**懒加载**的，把 store 依赖
// 留在它这一侧会让 async chunk 与主闭包共享模块，Rollup 会把 App.vue 的 facade
// 并进匿名共享块，`check-renderer-bundles.mjs` 的四入口契约随之失效。
const props = defineProps<{
  groupId?: string
  /** 可选群列表（父组件给），空 = 不显示「拉进讨论组」一栏。 */
  groupOptions?: Array<{ label: string; value: string }>
}>()
const emit = defineEmits<{ close: []; attached: [memberId: string] }>()

const probes = ref<AttachRuntimeProbe[]>([])
const probing = ref(false)
const probeError = ref('')
const runtime = ref<AttachRuntime>('claude')
const nick = ref('')
const cwd = ref('')
const model = ref('')
const permissionMode = ref('')
const groupId = ref(props.groupId ?? '')
const attaching = ref(false)
const attachError = ref('')
const attachHint = ref('')
let maskPointerStartedOnMask = false

const currentProbe = computed(() => probes.value.find((p) => p.runtime === runtime.value) ?? null)
const ready = computed(() => currentProbe.value?.ready === true)

const runtimeOptions = computed(() =>
  probes.value.map((p) => ({
    label: p.ready ? tr('{0}（可接入）', { 0: p.runtime }) : tr('{0}（不可接入）', { 0: p.runtime }),
    value: p.runtime
  }))
)

const modelOptions = computed(() => [
  { label: tr('跟随 adapter 默认'), value: '' },
  ...(currentProbe.value?.models ?? []).map((m) => ({
    label: m.name || m.value,
    value: m.value
  }))
])

const permissionOptions = computed(() => [
  { label: tr('跟随 adapter 默认'), value: '' },
  ...(currentProbe.value?.permissions ?? []).map((p) => ({
    label: p.name || p.value,
    value: p.value
  }))
])

const groupOptions = computed(() => props.groupOptions ?? [])

/** 选定 runtime 换了以后，模型与 permission 必须跟着清 —— 上一家 adapter 的值对这家无意义。 */
watch(runtime, () => {
  model.value = ''
  permissionMode.value = ''
  attachError.value = ''
  attachHint.value = ''
})

async function runProbe(): Promise<void> {
  probing.value = true
  probeError.value = ''
  try {
    probes.value = await window.pantry.probeAttachTargets()
  } catch (err) {
    probeError.value = String((err as Error)?.message ?? err)
  } finally {
    probing.value = false
  }
}

async function pickCwd(): Promise<void> {
  const picked = await window.pantry.pickDirectory()
  if (picked) cwd.value = picked
}

async function attach(): Promise<void> {
  if (attaching.value) return
  attaching.value = true
  attachError.value = ''
  attachHint.value = ''
  try {
    const result = await window.pantry.attachAgent({
      runtime: runtime.value,
      nick: nick.value,
      cwd: cwd.value,
      model: model.value,
      permissionMode: permissionMode.value,
      groupId: groupId.value,
      // 用探测到的那一个 adapter，而不是让主进程按 runtime 再猜一次。
      adapterPath: currentProbe.value?.adapterPath ?? ''
    })
    if (result.ok) {
      emit('attached', result.memberId)
      emit('close')
      return
    }
    attachError.value = result.error
    attachHint.value = result.hint
  } catch (err) {
    attachError.value = String((err as Error)?.message ?? err)
  } finally {
    attaching.value = false
  }
}

function rememberMaskPointerDown(event: PointerEvent): void {
  maskPointerStartedOnMask = event.target === event.currentTarget
}

function requestMaskClose(): void {
  if (maskPointerStartedOnMask && !attaching.value) emit('close')
  maskPointerStartedOnMask = false
}

function onEscape(event: KeyboardEvent): void {
  if (!isPlainEscape(event) || attaching.value) return
  event.preventDefault()
  emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', onEscape)
  void runProbe()
})
onUnmounted(() => document.removeEventListener('keydown', onEscape))
</script>

<template>
  <div class="mask" @pointerdown="rememberMaskPointerDown" @click.self="requestMaskClose">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="tr('接入本机 Agent')">
      <header class="head">
        <h3>{{ tr('接入本机 Agent') }}</h3>
        <span v-if="probing" class="probing">{{ tr('正在探测…') }}</span>
      </header>

      <section class="page">
        <div class="field">
          <label for="attach-runtime">{{ tr('Runtime') }}</label>
          <NSelect
            v-model:value="runtime"
            class="form-input"
            :options="runtimeOptions"
            :disabled="probing"
          />
        </div>

        <!-- 探测结果：成功项折叠成一行，失败项把 hint 原样摆出来（AC2） -->
        <div v-if="probeError" class="probe-error">{{ probeError }}</div>
        <ul v-else-if="currentProbe" class="probe-list">
          <li v-for="entry in currentProbe.items" :key="entry.id" :class="{ bad: !entry.ok }">
            <span class="mark">{{ entry.ok ? '✓' : '✗' }}</span>
            <span class="label">{{ entry.label }}</span>
            <span class="detail">{{ entry.detail }}</span>
            <span v-if="!entry.ok && entry.hint" class="hint">{{ entry.hint }}</span>
          </li>
        </ul>
        <NButton class="probe-again" size="small" :disabled="probing" @click="runProbe">
          {{ tr('重新探测') }}
        </NButton>

        <div class="field">
          <label for="attach-nick">{{ tr('成员名称') }}</label>
          <NInput
            v-model:value="nick"
            class="form-input"
            maxlength="32"
            :placeholder="tr('例如：Claude 助手')"
            :input-props="{ id: 'attach-nick' }"
          />
        </div>

        <div class="field">
          <label for="attach-cwd">{{ tr('工作目录') }}</label>
          <div class="dir-row">
            <NInput
              v-model:value="cwd"
              class="form-input"
              :placeholder="tr('agent 的工作区与权限沙箱边界')"
              :input-props="{ id: 'attach-cwd' }"
            />
            <NButton size="small" @click="pickCwd">{{ tr('选择目录') }}</NButton>
          </div>
        </div>

        <div class="field">
          <label for="attach-model">{{ tr('模型') }}</label>
          <NSelect v-model:value="model" class="form-input" :options="modelOptions" />
          <p v-if="currentProbe && currentProbe.models.length === 0" class="empty-tip">
            {{ tr('该 adapter 未声明可选模型，将跟随它自己的默认值') }}
          </p>
        </div>

        <div class="field">
          <label for="attach-permission">{{ tr('Permission 策略') }}</label>
          <NSelect
            v-model:value="permissionMode"
            class="form-input"
            :options="permissionOptions"
          />
          <p class="empty-tip">
            {{ tr('这是 agent 自己工具的放行档位；群里人发起的开工审批走确认键，是另一条路径。') }}
          </p>
        </div>

        <div v-if="groupOptions.length > 0" class="field">
          <label for="attach-group">{{ tr('拉进讨论组') }}</label>
          <NSelect
            v-model:value="groupId"
            class="form-input"
            clearable
            :options="groupOptions"
            :placeholder="tr('留空则只接入、暂不进群')"
          />
        </div>

        <div v-if="attachError" class="attach-error" aria-live="polite">
          <p>{{ attachError }}</p>
          <p v-if="attachHint" class="hint">{{ attachHint }}</p>
        </div>
      </section>

      <footer class="foot">
        <NButton size="small" :disabled="attaching" @click="emit('close')">{{ tr('取消') }}</NButton>
        <NButton
          type="primary"
          size="small"
          :loading="attaching"
          :disabled="attaching || !ready || !nick.trim() || !cwd"
          @click="attach"
        >
          {{ tr('接入') }}
        </NButton>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.dialog {
  width: min(560px, 92vw);
  max-height: 86vh;
  overflow: auto;
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-float);
  padding: 18px 20px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
}
.head h3 {
  margin: 0;
  font-size: 15px;
  color: var(--text-1);
}
.probing {
  font-size: 12px;
  color: var(--text-3);
}
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.field label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-2);
}
.dir-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.probe-list {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
}
.probe-list li {
  display: grid;
  grid-template-columns: 18px auto 1fr;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--text-2);
}
.probe-list li:last-child {
  border-bottom: none;
}
.probe-list li.bad {
  color: var(--danger);
}
.probe-list .detail {
  color: var(--text-3);
  grid-column: 3;
}
.probe-list .hint {
  grid-column: 3;
  color: var(--text-2);
  margin-top: 2px;
}
.probe-again {
  align-self: flex-start;
}
.probe-error,
.attach-error {
  font-size: 12px;
  color: var(--danger);
}
.attach-error .hint {
  color: var(--text-2);
  margin: 4px 0 0;
}
.empty-tip {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-3);
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}
@media (prefers-reduced-motion: reduce) {
  .dialog {
    transition: none;
  }
}
</style>
