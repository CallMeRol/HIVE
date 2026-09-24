// ─── Core data structures for Liquid Neural Space ────────────────────────────

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'running'
  | 'spawning'
  | 'returning'
  | 'error'

/**
 * Semantic position in the abstract work space.
 *  x: perception (-1) → action (+1)
 *  y: concrete  (-1) → abstract (+1)
 *  z: local     (-1) → global  (+1)
 *
 * IMPORTANT: hierarchy (parent/child) is NEVER encoded here.
 * Position only describes the nature of the agent's work.
 */
export interface Semantic {
  x: number
  y: number
  z: number
}

/** Spawn animation payload attached to a freshly budded agent. */
export interface Birth {
  parentId: string
  at: number
  /** Unit direction of budding, from parent center outward. */
  dir: [number, number, number]
  /** World position on the parent surface where the bud appears. */
  surface: [number, number, number]
  /** World position where the bud detaches before semantic travel. */
  detach: [number, number, number]
}

export interface AgentNode {
  id: string
  name: string
  role: string

  semantic: Semantic
  /** 0.85 … 1.30 — importance / compute weight ONLY. Never hierarchy. */
  weight: number

  status: AgentStatus
  /** Current context-window occupancy. Null means unavailable; it renders as idle blue. */
  contextWindowPct: number | null

  parentId?: string
  childIds: string[]

  task?: string
  /** tokens/s — cosmetic for the demo simulation. */
  traffic: number
  createdAt: number

  /** Ephemeral agents merge back into their parent after returning. */
  ephemeral?: boolean

  /** Active spawn animation (bud → detach → semantic travel). */
  birth?: Birth
  /** Active merge-back animation start timestamp. */
  mergeAt?: number
  /** Last time this agent absorbed a returned result (fresnel pulse). */
  parentPulseAt?: number
}

export type EdgeType = 'spawn' | 'collaboration' | 'context' | 'return'

export interface AgentEdge {
  id: string
  source: string
  target: string
  type: EdgeType
  traffic: number
  /** Hidden until the child finishes detaching from its parent. */
  hidden?: boolean
  /** Transient highlight pulse travelling along the tube. */
  fx?: { type: 'return' | 'merge'; at: number }
}

export type EventKind = 'spawn' | 'status' | 'return' | 'merge' | 'error' | 'info'

export interface TimelineEvent {
  id: string
  at: number
  kind: EventKind
  agentId?: string
  text: string
}
