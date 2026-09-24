import * as THREE from 'three'
import type { Semantic } from '../types'
import { clamp } from './util'

/**
 * Semantic space → world space mapping.
 *
 * The DIRECTION from the origin still encodes the semantic coordinates
 * (up = abstract, +X = action, +Z = global) — hierarchy never enters this
 * function. What is shaped is the RADIUS: the semantic cube is bent into a
 * spherical shell, so the tissue closes into a ball instead of an elongated
 * blob. Agents that are semantically close share a direction and separate
 * angularly; agents that are more extreme sit slightly further out.
 */
/**
 * Axis weights. All three are EQUAL on purpose: the archetypes are spread
 * almost evenly across the three semantic axes (mean |x|=0.46, |y|=0.45,
 * |z|=0.42), so an unequal scale skews the direction distribution — x/z get
 * amplified over y and the tissue reads as a flattened ellipsoid. Equal
 * weights keep the soma cloud isotropic, which is what lets straight links
 * form a sphere. It is also the honest mapping: no axis is "more important".
 */
export const SEMANTIC_SCALE = { x: 8, y: 8, z: 8 } as const

/** Radius range of the shell, in world units. */
export const SHELL_INNER = 5.4
export const SHELL_OUTER = 9.2

/** |SEMANTIC_SCALE| — the magnitude of the most extreme semantic corner. */
const CUBE_DIAG = Math.sqrt(
  SEMANTIC_SCALE.x ** 2 + SEMANTIC_SCALE.y ** 2 + SEMANTIC_SCALE.z ** 2,
)

const _v = new THREE.Vector3()
export function semanticToWorld(s: Semantic, out?: THREE.Vector3): THREE.Vector3 {
  const v = out ?? _v
  const bx = s.x * SEMANTIC_SCALE.x
  const by = s.y * SEMANTIC_SCALE.y
  const bz = s.z * SEMANTIC_SCALE.z
  const len = Math.sqrt(bx * bx + by * by + bz * bz)
  if (len < 1e-4) {
    // exactly semantic-neutral: park it on the shell, straight up
    return v.set(0, SHELL_INNER, 0)
  }
  // how extreme the agent is, 0..1 → inner..outer shell
  const mag = Math.min(1, len / CUBE_DIAG)
  const r = SHELL_INNER + (SHELL_OUTER - SHELL_INNER) * mag
  const k = r / len
  return v.set(bx * k, by * k, bz * k)
}

export interface RolePreset {
  role: string
  name: string
  semantic: Semantic
  tasks: string[]
  weight: [number, number]
  ephemeralChance: number
}

/**
 * Archetypal agents, each anchored to a region of semantic work space.
 * A Strategy agent sits high on Y (abstract) regardless of who spawned it;
 * an Execute agent sits far on +X regardless of depth in the org graph.
 *
 * Y and Z are deliberately DECOUPLED. An earlier revision had every archetype
 * with y and z sharing a sign (abstract⇒global, concrete⇒local), which packed
 * the whole cloud into one diagonal band: the "concrete + global" octant was
 * empty, and no amount of link shaping could make that read as a sphere.
 * The four quadrants are now all populated — which is also the truer claim,
 * since deploying a service (concrete, global) and sequencing a sprint
 * (abstract, local) are both perfectly ordinary.
 */
export const ROLE_PRESETS: RolePreset[] = [
  {
    role: 'Orchestrator',
    name: 'Mission Control',
    semantic: { x: 0.62, y: 0.69, z: 0.37 },
    tasks: ['Decompose objective', 'Coordinate sub-agents', 'Final synthesis'],
    weight: [1.14, 1.3],
    ephemeralChance: 0,
  },
  {
    role: 'Strategy',
    name: 'Strategy Agent',
    semantic: { x: -0.41, y: 0.89, z: 0.22 },
    tasks: ['Evaluate approaches', 'Trade-off analysis', 'Roadmap sketch'],
    weight: [1.02, 1.18],
    ephemeralChance: 0.2,
  },
  {
    role: 'Research',
    name: 'Research Agent',
    semantic: { x: -0.84, y: 0.11, z: 0.54 },
    tasks: ['Gather sources', 'Cross-check claims', 'Summarize findings'],
    weight: [0.95, 1.12],
    ephemeralChance: 0.35,
  },
  {
    role: 'Search',
    name: 'Search Agent',
    semantic: { x: -0.87, y: -0.46, z: -0.19 },
    tasks: ['Query corpora', 'Rank candidates', 'Filter noise'],
    weight: [0.85, 1.0],
    ephemeralChance: 0.6,
  },
  {
    role: 'Extract',
    name: 'Extract Agent',
    semantic: { x: -0.2, y: -0.97, z: -0.15 },
    tasks: ['Parse document', 'Pull structured fields', 'Normalize values'],
    weight: [0.85, 0.98],
    ephemeralChance: 0.7,
  },
  {
    role: 'Analyze',
    name: 'Analysis Agent',
    semantic: { x: -0.49, y: 0.63, z: -0.6 },
    tasks: ['Analyze competitor interfaces', 'Pattern detection', 'Statistical pass'],
    weight: [0.95, 1.15],
    ephemeralChance: 0.3,
  },
  {
    role: 'Plan',
    name: 'Planning Agent',
    semantic: { x: 0.48, y: 0.63, z: -0.61 },
    tasks: ['Sequence work packages', 'Estimate effort', 'Assign resources'],
    weight: [0.95, 1.1],
    ephemeralChance: 0.3,
  },
  {
    role: 'Code',
    name: 'Code Agent',
    semantic: { x: 0.9, y: -0.27, z: -0.34 },
    tasks: ['Implement module', 'Write tests', 'Refactor pass'],
    weight: [0.9, 1.1],
    ephemeralChance: 0.4,
  },
  {
    role: 'Execute',
    name: 'Execution Agent',
    semantic: { x: 0.77, y: -0.37, z: 0.52 },
    tasks: ['Run pipeline', 'Deploy build', 'Operate service'],
    weight: [0.88, 1.05],
    ephemeralChance: 0.45,
  },
  {
    role: 'Write',
    name: 'Writing Agent',
    semantic: { x: 0.34, y: -0.62, z: -0.7 },
    tasks: ['Draft report', 'Edit for tone', 'Publish summary'],
    weight: [0.85, 1.0],
    ephemeralChance: 0.5,
  },
  {
    role: 'Synthesize',
    name: 'Synthesis Agent',
    semantic: { x: -0.11, y: 0.38, z: 0.92 },
    tasks: ['Merge findings', 'Build model', 'Decision memo'],
    weight: [1.0, 1.2],
    ephemeralChance: 0.25,
  },
  {
    role: 'Memory',
    name: 'Memory Agent',
    semantic: { x: -0.11, y: -0.56, z: 0.82 },
    tasks: ['Index context', 'Recall episodes', 'Compact history'],
    weight: [0.85, 1.0],
    ephemeralChance: 0.1,
  },
  {
    role: 'Vision',
    name: 'Vision Agent',
    semantic: { x: -0.53, y: -0.19, z: -0.82 },
    tasks: ['Parse screenshot', 'Read diagram', 'Inspect layout'],
    weight: [0.85, 1.02],
    ephemeralChance: 0.55,
  },
]

/** Jitter a semantic anchor so siblings of the same role never stack. */
export function jitterSemantic(s: Semantic, amt = 0.3): Semantic {
  return {
    x: clamp(s.x + (Math.random() * 2 - 1) * amt, -1, 1),
    y: clamp(s.y + (Math.random() * 2 - 1) * amt, -1, 1),
    z: clamp(s.z + (Math.random() * 2 - 1) * amt, -1, 1),
  }
}

/**
 * Best-candidate placement: sample a few jittered positions inside the role's
 * semantic region and keep the one furthest from every existing agent.
 *
 * Semantics are preserved (the candidate always stays in the archetype's
 * neighbourhood) while the tissue keeps its negative space instead of
 * collapsing into a clump.
 */
/**
 * Best-candidate placement with an EXPANDING search radius.
 *
 * Semantics are preserved: the candidate always stays centred on the
 * archetype's semantic anchor, so a Strategy agent is still abstract. But when
 * a role is already crowded, the jitter widens ring by ring until the new soma
 * finds real clearance.
 *
 * This is what keeps the shell evenly covered. A fixed jitter makes every
 * agent of a role pile into the same patch of the sphere, and the tissue reads
 * as a lumpy egg rather than a ball.
 */
export function spreadSemantic(
  base: Semantic,
  existing: readonly Semantic[],
  amt = 0.3,
  tries = 12,
): Semantic {
  if (existing.length === 0) return jitterSemantic(base, amt)
  // distance is measured in WORLD space — the mapping bends the cube into a
  // shell, so a linear scale on the semantic coords would be misleading
  const existingWorld = existing.map((e) => semanticToWorld(e).clone())

  let best = jitterSemantic(base, amt)
  let bestScore = -Infinity
  // expand the search ring until the candidate is genuinely clear
  for (let ring = 0; ring < 4; ring++) {
    const radius = amt * (1 + ring * 0.75)
    for (let i = 0; i < tries; i++) {
      const cand = jitterSemantic(base, radius)
      const cw = semanticToWorld(cand)
      let minD = Infinity
      for (const e of existingWorld) {
        const d = cw.distanceTo(e)
        if (d < minD) minD = d
      }
      if (minD > bestScore) {
        bestScore = minD
        best = cand
      }
    }
    // enough clearance for a soma plus its processes — stop expanding
    if (bestScore > 1.6) break
  }
  return best
}
