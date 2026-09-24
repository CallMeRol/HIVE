<script setup lang="ts">
// Hive #57：星系派遣网络图（sprite-and-network-contract §B 定案的 variant A）。
// 常驻成员 = 深度 1 内环；派遣成员按深度成环向外；名字恒显；节点槽 64px 放五档 GIF
// （资产 docs/UI-draft/state → assets/hive/state，128 原生 0.5×）；常驻实线描边 /
// 派遣虚线描边；连线指向派遣者；父退出后子挂最近活跃祖先（账本已重写时按 dispatcherId
// 找不到 → 挂群中心 = 本机）；回收即账本硬删 → 节点直接消失。点击节点开机库。
import { computed, onMounted, ref } from 'vue'
import { tr } from '../utils/i18n'
import type { HiveNetworkNode, HiveNetworkSnapshot } from '../../../shared/ipc'

const emit = defineEmits<{ open: [nodeId: string] }>()

const snapshot = ref<HiveNetworkSnapshot | null>(null)
const selected = ref<string>('')

/** 五档 GIF（sprite 契约 A4：文件名沿用美术原名）。 */
const GIF_BY_TAG: Record<string, string> = {
  idle: new URL('../assets/hive/state/sleep.gif', import.meta.url).href,
  easy: new URL('../assets/hive/state/ease.gif', import.meta.url).href,
  busy: new URL('../assets/hive/state/tired.gif', import.meta.url).href,
  overload: new URL('../assets/hive/state/super_tired.gif', import.meta.url).href,
  'about-to-blow': new URL('../assets/hive/state/ran_out.gif', import.meta.url).href
}

async function refresh(): Promise<void> {
  snapshot.value = await window.pantry.getHiveNetwork()
}

onMounted(() => {
  void refresh()
})

const nodes = computed<HiveNetworkNode[]>(() => snapshot.value?.nodes ?? [])

/** 深度 → 半径：常驻(1) 内环 r=86，向外每环 +88（契约 §B 布局）。 */
const RING0_R = 86
const RING_STEP = 88
const CENTER = 340

function ringR(depth: number): number {
  return RING0_R + Math.max(0, depth - 1) * RING_STEP
}

interface PlacedNode {
  node: HiveNetworkNode
  x: number
  y: number
}

/** 按深度成环、环内按角度均布；同深度成员围绕其派遣者聚集（子角随父角偏移）。 */
const placed = computed<PlacedNode[]>(() => {
  const list = nodes.value
  const byId = new Map(list.map((n) => [n.nodeId, n]))
  // 活跃挂靠父：dispatcherId 已消失 → 挂中心（群中心兜底，#31 跳级挂靠的图上投影）。
  const parentOf = (n: HiveNetworkNode): string | null => {
    const pid = n.hive?.dispatcherId
    if (!pid) return null
    return byId.has(pid) ? pid : null
  }
  const roots = list.filter((n) => parentOf(n) === null)
  const angleOf = new Map<string, number>()
  roots.forEach((n, i) => {
    angleOf.set(n.nodeId, (2 * Math.PI * i) / Math.max(1, roots.length))
  })
  // BFS：孩子的角 = 父角 ± 少量扇形展开。
  let frontier = [...roots]
  while (frontier.length) {
    const next: HiveNetworkNode[] = []
    for (const parent of frontier) {
      const kids = list.filter((n) => parentOf(n)?.length && parentOf(n) === parent.nodeId)
      kids.forEach((kid, i) => {
        const spread = Math.PI / 6
        const offset = kids.length === 1 ? 0 : (i - (kids.length - 1) / 2) * spread
        angleOf.set(kid.nodeId, (angleOf.get(parent.nodeId) ?? 0) + offset)
        next.push(kid)
      })
    }
    frontier = next
  }
  return list.map((node) => {
    const angle = angleOf.get(node.nodeId) ?? 0
    const r = ringR(node.hive?.depth ?? 1)
    return {
      node,
      x: CENTER + r * Math.cos(angle),
      y: CENTER + r * Math.sin(angle)
    }
  })
})

const byId = computed(() => new Map(nodes.value.map((n) => [n.nodeId, n])))

/** 边：子 → 派遣者（活跃挂靠父，消失则不画 = 图只表达活跃协作关系）。 */
const edges = computed(() => {
  const out: Array<{ from: PlacedNode; to: PlacedNode }> = []
  const placedById = new Map(placed.value.map((p) => [p.node.nodeId, p]))
  for (const p of placed.value) {
    const pid = p.node.hive?.dispatcherId
    if (!pid) continue
    const parent = placedById.get(pid)
    if (parent) out.push({ from: p, to: parent })
  }
  return out
})

/** 点击高亮该节点到根的整条活跃派遣链（契约 §B 点击）。 */
const chain = computed<Set<string>>(() => {
  const set = new Set<string>()
  if (!selected.value) return set
  let cur: string | undefined = selected.value
  const parentOf = (id: string): string | undefined =>
    byId.value.get(id)?.hive?.dispatcherId && byId.value.has(byId.value.get(id)!.hive!.dispatcherId)
      ? byId.value.get(id)!.hive!.dispatcherId
      : undefined
  for (let guard = 0; cur && guard < 16; guard += 1) {
    set.add(cur)
    cur = parentOf(cur)
  }
  return set
})

function inChain(nodeId: string): boolean {
  return chain.value.size === 0 || chain.value.has(nodeId)
}

function onSelect(node: HiveNetworkNode): void {
  if (selected.value === node.nodeId) selected.value = ''
  else {
    selected.value = node.nodeId
    emit('open', node.nodeId)
  }
}

function spriteOf(node: HiveNetworkNode): string {
  return GIF_BY_TAG[node.burden?.tag ?? 'idle'] ?? GIF_BY_TAG['idle']
}

function tipOf(node: HiveNetworkNode): string {
  const parts = [
    node.name,
    node.hive?.kind === 'dispatched' ? tr('派遣成员') : tr('常驻成员'),
    node.burden ? node.burden.title : '',
    node.hive?.goal ? `${tr('目标')}：${node.hive.goal}` : '',
    node.hive?.dispatcherId ? `${tr('派遣者')} ${node.hive.dispatcherId.slice(0, 8)}` : '',
    `${tr('深度')} ${node.hive?.depth ?? 1}`
  ]
  return parts.filter(Boolean).join(' · ')
}
</script>

<template>
  <div class="network-pane">
    <div class="pane-head">
      <span class="pane-title">{{ tr('派遣网络图') }}</span>
      <span class="pane-meta">
        {{ tr('深度上限') }} {{ snapshot?.maxDepth ?? '—' }} · {{ tr('并发上限') }}
        {{ snapshot?.maxConcurrency ?? '—' }} · {{ tr('节点') }} {{ nodes.length }}
      </span>
      <button type="button" class="refresh" @click="refresh">{{ tr('刷新') }}</button>
    </div>
    <div v-if="nodes.length === 0" class="empty">{{ tr('本机还没有任何成员。') }}</div>
    <div v-else class="stage">
      <svg class="net" viewBox="0 0 680 680" role="img" :aria-label="tr('派遣网络图')">
        <!-- 环参考线 -->
        <circle class="ring" :cx="CENTER" :cy="CENTER" :r="RING0_R" />
        <circle class="ring" :cx="CENTER" :cy="CENTER" :r="RING0_R + RING_STEP" />
        <circle class="ring" :cx="CENTER" :cy="CENTER" :r="RING0_R + RING_STEP * 2" />
        <!-- 群中心 = 本机 -->
        <circle :cx="CENTER" :cy="CENTER" r="5" class="self-core" />
        <!-- 派遣连线：子 → 派遣者 -->
        <line
          v-for="edge in edges"
          :key="`e-${edge.from.node.nodeId}`"
          class="edge"
          :class="{ active: selected === edge.from.node.nodeId }"
          :x1="edge.from.x"
          :y1="edge.from.y"
          :x2="edge.to.x"
          :y2="edge.to.y"
        />
        <g
          v-for="p in placed"
          :key="p.node.nodeId"
          class="node"
          :class="{ dim: !inChain(p.node.nodeId) }"
          :transform="`translate(${p.x - 32}, ${p.y - 32})`"
          role="button"
          :aria-label="tipOf(p.node)"
          @click="onSelect(p.node)"
        >
          <rect
            class="slot"
            :class="p.node.hive?.kind === 'dispatched' ? 'dispatched' : 'resident'"
            width="64"
            height="64"
            rx="4"
          />
          <image :href="spriteOf(p.node)" x="0" y="0" width="64" height="64" />
          <text class="nm" :x="32" :y="78" text-anchor="middle">{{ p.node.name.slice(0, 12) }}</text>
        </g>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.network-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding-bottom: 8px;
}
.pane-head {
  height: 38px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.pane-title {
  color: var(--text-1);
}
.pane-meta {
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.refresh {
  margin-left: auto;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-2);
  border-radius: 6px;
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
}
.refresh:hover {
  background: var(--surface-hover);
}
.empty {
  color: var(--text-2);
  font-size: 13px;
  text-align: center;
  margin-top: 24px;
}
.stage {
  flex: 1;
  min-height: 0;
  padding: 0 8px 10px;
}
.net {
  width: 100%;
  height: 100%;
  background: var(--bg-list);
  border: 1px solid var(--line);
  border-radius: 10px;
}
.ring {
  fill: none;
  stroke: var(--line);
  stroke-dasharray: 2 6;
}
.self-core {
  fill: var(--primary);
}
.edge {
  stroke: var(--text-3);
  stroke-width: 1.6;
  opacity: 0.55;
}
.edge.active {
  stroke: #58a6ff;
  stroke-width: 2.6;
  opacity: 1;
}
.node {
  cursor: pointer;
}
.node.dim {
  opacity: 0.32;
}
.slot {
  fill: rgba(10, 14, 23, 0.55);
  stroke-width: 1.6;
}
.slot.resident {
  stroke: var(--text-2);
}
.slot.dispatched {
  stroke: var(--text-2);
  stroke-dasharray: 3 3;
}
.nm {
  fill: var(--text-2);
  font-size: 10px;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  /* GIF 无法停帧（Chromium 108 无播放控制 API）；压暗整体动画节点作为让步 */
  .node image {
    opacity: 0.6;
  }
}
</style>
