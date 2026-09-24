import { create } from 'zustand'
import * as THREE from 'three'
import type {
  AgentEdge,
  AgentNode,
  AgentStatus,
  Birth,
  Semantic,
  TimelineEvent,
} from '../types'
import { ROLE_PRESETS, semanticToWorld, spreadSemantic } from '../lib/semanticSpace'
import { clamp, nextEventId, pick, randRange } from '../lib/util'

/**
 * Spawn duration. Deliberately long: a delegation that snaps into place reads
 * as a UI transition, not as matter moving. The phase map in `spawnPos` splits
 * it into swell → slow breakaway → accelerate → soft arrival.
 */
export const SPAWN_MS = 7000
export const MERGE_MS = 900
export const ABSORB_MS = 900

export interface SpawnFx {
  parentId: string
  at: number
  dir: [number, number, number]
}

export interface AddAgentInput {
  parentId?: string
  presetIndex?: number
  semantic?: Semantic
  weight?: number
  status?: AgentStatus
  ephemeral?: boolean
}

interface GraphState {
  agents: Record<string, Agent>
  edges: Record<string, AgentEdge>
  events: TimelineEvent[]
  /** childId → active spawn fx (drives parent bulge + neck rendering). */
  activeSpawns: Record<string, SpawnFx>

  selectedId: string | null
  hoveredId: string | null
  /** First-order neighbourhood of the selection (everything else dims). */
  focusNeighbors: Set<string> | null
  /** Ancestor/descendant closure when "show lineage" filter is on. */
  lineageFilter: Set<string> | null

  simRunning: boolean
  targetAgents: number

  seq: number

  bootstrap(): void
  repairTopology(): void
  addAgent(input: AddAgentInput): string
  settleSpawn(childId: string): void
  setStatus(id: string, status: AgentStatus): void
  setContextWindowPct(id: string, pct: number | null): void
  beginReturn(id: string): void
  absorb(parentId: string): void
  startMerge(id: string): void
  removeAgent(id: string): void

  select(id: string | null): void
  hover(id: string | null): void
  toggleLineage(id: string): void
  clearLineage(): void

  setSim(running: boolean): void
  requestTarget(n: number): void
  stressBurst(n: number): void
  simTick(): void
  spawnRandomChild(): string | null
  trafficTick(): void
  reset(): void
  pushEvent(e: Omit<TimelineEvent, 'id' | 'at'>): void
}

export const useAgentGraph = create<GraphState>()((set, get) => ({
  agents: {},
  edges: {},
  events: [],
  activeSpawns: {},

  selectedId: null,
  hoveredId: null,
  focusNeighbors: null,
  lineageFilter: null,

  simRunning: true,
  targetAgents: 14,

  seq: 1,

  pushEvent(e) {
    const ev: TimelineEvent = { id: nextEventId(), at: Date.now(), ...e }
    set((s) => ({ events: [ev, ...s.events].slice(0, 90) }))
  },

  bootstrap() {
    if (Object.keys(get().agents).length > 0) return
    const rootId = get().addAgent({ presetIndex: 0, status: 'running' })
    const root = get().agents[rootId]
    get().pushEvent({
      kind: 'info',
      agentId: rootId,
      text: `${rootId} · ${root.role} online — mission assigned`,
    })
    window.setTimeout(() => void trySpawnChild(), 600)
    window.setTimeout(() => void trySpawnChild(), 1400)
  },

  repairTopology() {
    const s = get()
    const edges: Record<string, AgentEdge> = { ...s.edges }
    let changed = false
    for (const [edgeId, edge] of Object.entries(edges)) {
      if (
        (edge.type === 'collaboration' || edge.type === 'context') &&
        isLineageRelated(edge.source, edge.target, s.agents)
      ) {
        delete edges[edgeId]
        changed = true
      }
    }
    if (changed) set({ edges })
  },

  addAgent(input) {
    const s = get()
    const id = `A-${String(s.seq).padStart(3, '0')}`
    const preset = input.presetIndex != null
      ? ROLE_PRESETS[input.presetIndex]
      : pick(ROLE_PRESETS.slice(1))

    // spread placement: same semantic region, but keeping distance from
    // everything already in the tissue — negative space is the aesthetic
    const semantic = input.semantic
      ? spreadSemantic(input.semantic, Object.values(s.agents).map((a) => a.semantic))
      : spreadSemantic(
          preset.semantic,
          Object.values(s.agents).map((a) => a.semantic),
        )
    const weight = clamp(
      input.weight ?? randRange(preset.weight[0], preset.weight[1]),
      0.85,
      1.3,
    )

    // The standalone demo cycles through PRD load bands until a real runtime
    // supplies context-window occupancy for each agent.
    const demoWindowPct: Array<number | null> = [null, 5, 12, 24, 43]
    const agent: Agent = {
      id,
      name: preset.name,
      role: preset.role,
      semantic,
      weight,
      status: input.status ?? 'spawning',
      contextWindowPct: demoWindowPct[(s.seq - 1) % demoWindowPct.length],
      childIds: [],
      task: pick(preset.tasks),
      traffic: randRange(4, 18),
      createdAt: Date.now(),
      ephemeral: input.ephemeral ?? Math.random() < preset.ephemeralChance,
    }

    const agents: Record<string, Agent> = { ...s.agents, [id]: agent }
    let edges: Record<string, AgentEdge> = { ...s.edges }
    const activeSpawns: Record<string, SpawnFx> = { ...s.activeSpawns }

    const parent = input.parentId ? s.agents[input.parentId] : undefined
    if (parent) {
      agent.parentId = parent.id
      agent.parentPulseAt = undefined
      agents[parent.id] = {
        ...parent,
        childIds: [...parent.childIds, id],
      }

      // Birth geometry: bud direction biased toward the child's semantic
      // target but always leaving the parent surface at a natural angle.
      const parentWorld = semanticToWorld(parent.semantic).clone()
      const targetWorld = semanticToWorld(semantic).clone()
      const dir = targetWorld.sub(parentWorld)
      if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0)
      dir.normalize()
      dir.addScaledVector(randomUnit(), 0.55).normalize()

      const now = performance.now()
      const surface = parentWorld
        .clone()
        .addScaledVector(dir, AGENT_RADIUS * parent.weight)
      const detach = parentWorld
        .clone()
        .addScaledVector(dir, AGENT_RADIUS * parent.weight + 1.25)

      const birth: Birth = {
        parentId: parent.id,
        at: now,
        dir: [dir.x, dir.y, dir.z],
        surface: [surface.x, surface.y, surface.z],
        detach: [detach.x, detach.y, detach.z],
      }
      agent.birth = birth
      activeSpawns[id] = { parentId: parent.id, at: now, dir: birth.dir }

      const edgeId = `${parent.id}->${id}`
      edges[edgeId] = {
        id: edgeId,
        source: parent.id,
        target: id,
        type: 'spawn',
        traffic: 0,
        hidden: true, // revealed once the bud detaches
      }
    }

    // Lateral collaboration synapses — the tissue must not be a tree.
    //
    // Picked from SPATIAL neighbours, not at random. With straight links, a
    // random long edge is a chord cutting through the interior and the whole
    // thing reads as a tangle. Connecting nearby somas keeps every segment
    // short and near the shell surface, so the straight edges trace the
    // polyhedron inscribed in the sphere — that is what makes it read as a ball.
    if (parent && Object.keys(agents).length > 4) {
      const selfWorld = semanticToWorld(agent.semantic)
      const others = Object.values(agents)
        .filter(
          (a) =>
            a.id !== id &&
            a.id !== parent.id &&
            !isLineageRelated(a.id, id, agents) &&
            a.status !== 'spawning' &&
            !a.mergeAt,
        )
        .map((a) => ({
          a,
          d: semanticToWorld(a.semantic).distanceTo(selfWorld),
        }))
        .sort((p, q) => p.d - q.d)

      // Two lateral links per soma. One is enough to break the tree, but the
      // shell only reads as a surface once its edges start to close into
      // rings — a single link per node leaves it a scattering of chords.
      const used = new Set<string>()
      const wanted = others.length > 8 ? 2 : 1
      for (let n = 0; n < wanted; n++) {
        const pool = others.filter(
          (o) => !used.has(o.a.id) && !edges[`${o.a.id}->${id}`],
        )
        if (!pool.length) break
        // Prefer the nearest handful, but not deterministically the closest —
        // a rigid nearest-neighbour graph looks mechanical.
        const k = Math.max(1, Math.min(pool.length, Math.ceil(pool.length * 0.3)))
        const head = pool.slice(0, k)
        // weight by 1/d so closer somas are more likely, with a floor to keep
        // the far end of the pool reachable
        let total = 0
        const weights = head.map((o) => {
          const w = 1 / Math.max(o.d, 0.5)
          total += w
          return w
        })
        let roll = Math.random() * total
        let chosen = head[0]
        for (let i = 0; i < head.length; i++) {
          roll -= weights[i]
          if (roll <= 0) {
            chosen = head[i]
            break
          }
        }
        if (!chosen) break
        used.add(chosen.a.id)
        const edgeId = `${id}->${chosen.a.id}`
        if (!edges[edgeId]) {
          edges[edgeId] = {
            id: edgeId,
            source: id,
            target: chosen.a.id,
            type: 'collaboration',
            traffic: randRange(0, 10),
          }
        }
      }
    }

    // A topology repair also removes illegal lateral edges that may have been
    // created before the lineage rule existed or before a deeper child was
    // attached. Parent/child spawn edges are intentionally preserved.
    for (const [edgeId, edge] of Object.entries(edges)) {
      if (
        (edge.type === 'collaboration' || edge.type === 'context') &&
        isLineageRelated(edge.source, edge.target, agents)
      ) {
        delete edges[edgeId]
      }
    }

    set({ agents, edges, activeSpawns, seq: s.seq + 1 })
    get().pushEvent({
      kind: 'spawn',
      agentId: id,
      text: parent
        ? `${id} · ${agent.role} budded from ${parent.id}`
        : `${id} · ${agent.role} materialized`,
    })

    // Ephemeral lifecycle: run → return → merge back.
    if (agent.ephemeral && agent.status === 'spawning') {
      const ttl = randRange(6000, 11000)
      window.setTimeout(() => {
        const a = get().agents[id]
        if (a && a.status !== 'spawning' && !a.mergeAt) get().beginReturn(id)
      }, ttl)
    }
    return id
  },

  settleSpawn(childId) {
    const s = get()
    const child = s.agents[childId]
    if (!child || !child.birth) return
    const agents: Record<string, Agent> = { ...s.agents }
    agents[childId] = {
      ...child,
      birth: undefined,
      status: Math.random() < 0.6 ? 'running' : 'thinking',
    }
    const edges: Record<string, AgentEdge> = { ...s.edges }
    const edgeId = `${child.parentId}->${childId}`
    if (edges[edgeId]) edges[edgeId] = { ...edges[edgeId], hidden: false }
    const activeSpawns = { ...s.activeSpawns }
    delete activeSpawns[childId]
    set({ agents, edges, activeSpawns })
  },

  setStatus(id, status) {
    const s = get()
    const a = s.agents[id]
    if (!a || a.status === status) return
    set({ agents: { ...s.agents, [id]: { ...a, status } } })
    if (status === 'error') {
      get().pushEvent({ kind: 'error', agentId: id, text: `${id} fault — retrying` })
      window.setTimeout(() => {
        const cur = get().agents[id]
        if (cur && cur.status === 'error') get().setStatus(id, 'running')
      }, 2600)
    }
  },

  setContextWindowPct(id, pct) {
    const s = get()
    const agent = s.agents[id]
    if (!agent) return
    const contextWindowPct = pct == null || !Number.isFinite(pct) ? null : clamp(pct, 0, 100)
    if (agent.contextWindowPct === contextWindowPct) return
    set({ agents: { ...s.agents, [id]: { ...agent, contextWindowPct } } })
  },

  beginReturn(id) {
    const s = get()
    const a = s.agents[id]
    if (!a || a.status === 'spawning' || a.mergeAt) return
    const now = performance.now()
    const agents = { ...s.agents, [id]: { ...a, status: 'returning' as AgentStatus } }
    const edges = { ...s.edges }
    for (const e of Object.values(edges)) {
      if (e.source === id || e.target === id) {
        edges[e.id] = { ...e, fx: { type: 'return', at: now } }
      }
    }
    set({ agents, edges })
    get().pushEvent({
      kind: 'return',
      agentId: id,
      text: `${id} streaming result → ${a.parentId ?? 'root'}`,
    })

    window.setTimeout(() => {
      const cur = get().agents[id]
      if (!cur) return
      if (cur.parentId) get().absorb(cur.parentId)
      if (cur.ephemeral && Math.random() < 0.75) {
        get().startMerge(id)
      } else {
        get().setStatus(id, 'idle')
        get().pushEvent({ kind: 'return', agentId: id, text: `${id} retained · idle` })
      }
    }, 950)
  },

  absorb(parentId) {
    const s = get()
    const p = s.agents[parentId]
    if (!p) return
    set({
      agents: { ...s.agents, [parentId]: { ...p, parentPulseAt: performance.now() } },
    })
  },

  startMerge(id) {
    const s = get()
    const a = s.agents[id]
    if (!a || a.mergeAt) return
    const now = performance.now()
    const agents = { ...s.agents, [id]: { ...a, mergeAt: now, status: 'returning' as AgentStatus } }
    const edges = { ...s.edges }
    for (const e of Object.values(edges)) {
      if (e.source === id || e.target === id) {
        edges[e.id] = { ...e, fx: { type: 'merge', at: now } }
      }
    }
    set({ agents, edges })
  },

  removeAgent(id) {
    const s = get()
    if (!s.agents[id]) return
    const agents = { ...s.agents }
    const a = agents[id]
    delete agents[id]
    if (a.parentId && agents[a.parentId]) {
      const p = agents[a.parentId]
      agents[a.parentId] = {
        ...p,
        childIds: p.childIds.filter((c) => c !== id),
      }
    }
    const edges: Record<string, AgentEdge> = {}
    for (const e of Object.values(s.edges)) {
      if (e.source !== id && e.target !== id) edges[e.id] = e
    }
    const activeSpawns = { ...s.activeSpawns }
    delete activeSpawns[id]
    set({
      agents,
      edges,
      activeSpawns,
      selectedId: s.selectedId === id ? null : s.selectedId,
      focusNeighbors:
        s.selectedId === id
          ? null
          : s.focusNeighbors
            ? new Set([...s.focusNeighbors].filter((x) => x !== id))
            : null,
    })
    get().pushEvent({
      kind: 'merge',
      agentId: id,
      text: `${id} · ${a.role} merged back into ${a.parentId ?? 'network'}`,
    })
  },

  select(id) {
    if (!id) {
      set({ selectedId: null, focusNeighbors: null })
      return
    }
    const s = get()
    const neighbors = new Set<string>([id])
    for (const e of Object.values(s.edges)) {
      if (e.source === id) neighbors.add(e.target)
      if (e.target === id) neighbors.add(e.source)
    }
    set({ selectedId: id, focusNeighbors: neighbors, hoveredId: s.hoveredId })
  },

  hover(id) {
    set({ hoveredId: id })
  },

  toggleLineage(id) {
    const s = get()
    if (s.lineageFilter && s.selectedId === id) {
      set({ lineageFilter: null })
      return
    }
    const closure = new Set<string>([id])
    // ancestors
    let cur = s.agents[id]
    while (cur?.parentId && s.agents[cur.parentId]) {
      closure.add(cur.parentId)
      cur = s.agents[cur.parentId]
    }
    // descendants
    const stack = [id]
    while (stack.length) {
      const n = stack.pop()!
      for (const a of Object.values(s.agents)) {
        if (a.parentId === n && !closure.has(a.id)) {
          closure.add(a.id)
          stack.push(a.id)
        }
      }
    }
    set({ lineageFilter: closure, selectedId: id })
  },

  clearLineage() {
    set({ lineageFilter: null })
  },

  setSim(running) {
    set({ simRunning: running })
  },

  requestTarget(n) {
    set({ targetAgents: n })
  },

  stressBurst(n) {
    set({ targetAgents: n, simRunning: true })
    const step = () => {
      const s = get()
      if (Object.keys(s.agents).length >= n) return
      s.spawnRandomChild()
      window.setTimeout(step, 130)
    }
    step()
  },

  spawnRandomChild() {
    const s = get()
    const candidates = Object.values(s.agents).filter(
      (a) =>
        a.status === 'running' ||
        a.status === 'thinking' ||
        a.status === 'idle',
    )
    if (!candidates.length) return null
    const parent = pick(candidates)
    // Abstract agents tend to spawn concrete workers; concrete ones rarely
    // spawn strategy. This is what keeps the tissue from becoming a tree.
    const presetIndex = pick(
      ROLE_PRESETS.map((_, i) => i).filter((i) => {
        const r = ROLE_PRESETS[i]
        if (r.role === 'Orchestrator') return false
        return parent.semantic.y > 0.4 ? r.semantic.y < 0.7 : true
      }),
    )
    return get().addAgent({ parentId: parent.id, presetIndex })
  },

  simTick() {
    const s = get()
    const agents = Object.values(s.agents)
    if (agents.length < s.targetAgents && Math.random() < 0.8) {
      get().spawnRandomChild()
      return
    }
    const active = agents.filter((a) => a.status !== 'spawning' && !a.mergeAt)
    if (!active.length) return
    const a = pick(active)
    const r = Math.random()
    if (r < 0.3 && a.status === 'running') {
      get().setStatus(a.id, 'thinking')
    } else if (r < 0.55 && a.status === 'thinking') {
      get().setStatus(a.id, 'running')
    } else if (r < 0.66 && a.status === 'running' && a.childIds.length) {
      get().beginReturn(a.id)
    } else if (r < 0.72 && a.status !== 'error' && Math.random() < 0.35) {
      get().setStatus(a.id, 'error')
    } else if (a.status === 'idle' && Math.random() < 0.7) {
      get().setStatus(a.id, 'running')
      get().pushEvent({ kind: 'status', agentId: a.id, text: `${a.id} resumed · ${a.task ?? ''}` })
    }
  },

  trafficTick() {
    const s = get()
    let changed = false
    const agents: Record<string, Agent> = {}
    for (const [id, a] of Object.entries(s.agents)) {
      if (a.status === 'running' || a.status === 'thinking' || a.status === 'returning') {
        agents[id] = {
          ...a,
          traffic: clamp(a.traffic + (Math.random() - 0.45) * 9, 1.5, 56),
        }
        changed = true
      }
    }
    if (!changed) return
    const merged = { ...s.agents, ...agents }
    const edges: Record<string, AgentEdge> = {}
    for (const [id, e] of Object.entries(s.edges)) {
      const sa = merged[e.source]
      const sb = merged[e.target]
      const flow =
        sa && sb && (isActive(sa.status) || isActive(sb.status))
          ? (sa.traffic + sb.traffic) / 2
          : 0
      edges[id] = { ...e, traffic: e.traffic * 0.4 + flow * 0.6 }
    }
    set({
      agents: merged,
      edges,
    })
  },

  reset() {
    set({
      agents: {},
      edges: {},
      events: [],
      activeSpawns: {},
      selectedId: null,
      hoveredId: null,
      focusNeighbors: null,
      lineageFilter: null,
      targetAgents: 14,
    })
    get().bootstrap()
  },
}))

export type Agent = AgentNode

/**
 * Soma radius. Small on purpose: in a neural tissue the processes dominate
 * the frame, not the cell bodies.
 */
export const AGENT_RADIUS = 0.34

const _ru = new THREE.Vector3()
function randomUnit(): THREE.Vector3 {
  _ru.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1)
  if (_ru.lengthSq() < 1e-4) _ru.set(1, 0, 0)
  return _ru.normalize()
}

export function isActive(s: AgentStatus | undefined): boolean {
  return s === 'running' || s === 'thinking' || s === 'returning'
}

/**
 * Collaboration/context edges are lateral tissue, not a second hierarchy.
 * Treat any ancestor/descendant pair as lineage-related in either direction,
 * so a third-generation worker cannot acquire a direct lateral edge back to
 * the root or to any other ancestor.
 */
function isLineageRelated(
  firstId: string,
  secondId: string,
  agents: Record<string, Agent>,
): boolean {
  const reaches = (startId: string, targetId: string) => {
    let current = agents[startId]
    while (current?.parentId) {
      if (current.parentId === targetId) return true
      current = agents[current.parentId]
    }
    return false
  }
  return reaches(firstId, secondId) || reaches(secondId, firstId)
}

function trySpawnChild() {
  const g = useAgentGraph.getState()
  if (Object.keys(g.agents).length > 0) g.spawnRandomChild()
}
