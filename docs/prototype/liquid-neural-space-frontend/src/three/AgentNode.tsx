import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  ABSORB_MS,
  AGENT_RADIUS,
  MERGE_MS,
  SPAWN_MS,
  useAgentGraph,
} from '../store/useAgentGraph'
import type { Agent } from '../store/useAgentGraph'
import type { AgentStatus, Birth } from '../types'
import { createAgentMaterial, createCoreMaterial, createStatusHaloMaterial } from './AgentMaterial'
import { loadTier, LOAD_VISUALS } from '../lib/loadState'
import { semanticToWorld } from '../lib/semanticSpace'
import { nodePositions, visualOffsets } from '../lib/positions'
import {
  clamp01,
  easeInCubic,
  easeInOutCubic,
  easeMass,
  easeOutCubic,
  hash01,
  heartbeatPulse,
} from '../lib/util'
import { AgentLabel } from './AgentLabel'
import { interfaceAudio } from '../lib/audio'

/**
 * One Agent = one independent liquid sphere. Never a metaball in a shared
 * field — the mesh must stay individual, pickable and cheap.
 */

const STATUS_BREATH: Record<AgentStatus, number> = {
  idle: 0.12,
  thinking: 0.3,
  running: 0.45,
  spawning: 0.85,
  returning: 0.5,
  error: 0.2,
}
const STATUS_CORE: Record<AgentStatus, number> = {
  idle: 0.08,
  thinking: 0.68,
  running: 0.32,
  spawning: 0.82,
  returning: 1.0,
  error: 0.36,
}
const STATUS_ACTIVITY: Record<AgentStatus, number> = {
  idle: 0.14,
  thinking: 0.58,
  running: 0.78,
  spawning: 1,
  returning: 0.9,
  error: 0.35,
}

const REDUCED_MOTION =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
const embedParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
const LIGHT_EMBED = embedParams?.get('embed') === '1' && embedParams.get('theme') === 'light'

// scratch vectors — zero allocation per frame
const _target = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _surface = new THREE.Vector3()
const _detach = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _driftTarget = new THREE.Vector3()

export const AGENT_NODE_DEBUG = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.search : '',
)
const SHOW_CORE = AGENT_NODE_DEBUG.get('nocore') !== '1'

/**
 * Spawn phase map (fractions of SPAWN_MS). The timeline IS the animation:
 *
 *   0.00–0.25  SWELL / BUD     bud grows on the parent surface, parent bulges
 *   0.25–0.50  BREAKAWAY       surface → detach, slow at BOTH ends — the
 *                              droplet is still held by surface tension
 *   0.50–0.96  TRAVEL          detach → own semantic coordinate, heavy-body
 *                              ease: slow release, build speed, long soft
 *                              arrival. The longest phase — dispatching a
 *                              sub-agent should feel like moving matter.
 *   0.96–1.00  SETTLE          full size, at rest
 */
const PH_BUD = 0.25
const PH_DETACH = 0.5
const PH_TRAVEL_END = 0.96

export function spawnScale(p: number): number {
  if (p < PH_BUD) return 0.001 + 0.42 * easeOutCubic(p / PH_BUD)
  if (p < PH_DETACH) {
    return 0.42 + 0.43 * easeInOutCubic((p - PH_BUD) / (PH_DETACH - PH_BUD))
  }
  if (p < PH_TRAVEL_END) {
    return 0.85 + 0.15 * easeOutCubic((p - PH_DETACH) / (PH_TRAVEL_END - PH_DETACH))
  }
  return 1
}

function spawnPos(p: number, birth: Birth, target: THREE.Vector3, out: THREE.Vector3) {
  _surface.set(birth.surface[0], birth.surface[1], birth.surface[2])
  _detach.set(birth.detach[0], birth.detach[1], birth.detach[2])
  // bud grows in place on the parent's surface
  if (p < PH_BUD) return out.copy(_surface)
  // breakaway: easeInOutCubic starts and ends at zero velocity, so the droplet
  // creeps off the parent and is barely moving when it lets go
  if (p < PH_DETACH) {
    return out
      .copy(_surface)
      .lerp(_detach, easeInOutCubic((p - PH_BUD) / (PH_DETACH - PH_BUD)))
  }
  // travel: accelerates out of the release, then decelerates over a long tail
  return out
    .copy(_detach)
    .lerp(target, easeMass((p - PH_DETACH) / (PH_TRAVEL_END - PH_DETACH)))
}

function isDimmed(
  s: {
    lineageFilter: Set<string> | null
    selectedId: string | null
    focusNeighbors: Set<string> | null
  },
  id: string,
): boolean {
  if (s.lineageFilter) return !s.lineageFilter.has(id)
  if (!s.selectedId || !s.focusNeighbors) return false
  return id !== s.selectedId && !s.focusNeighbors.has(id)
}

export function AgentNode({ id }: { id: string }) {
  const agent = useAgentGraph((s) => s.agents[id])
  const hovered = useAgentGraph((s) => s.hoveredId === id)
  const selected = useAgentGraph((s) => s.selectedId === id)
  const dimmed = useAgentGraph((s) => isDimmed(s, id))
  const select = useAgentGraph((s) => s.select)
  const hover = useAgentGraph((s) => s.hover)

  const groupRef = useRef<THREE.Group>(null!)
  const coreRef = useRef<THREE.Mesh>(null!)
  const material = useMemo(() => createAgentMaterial(LIGHT_EMBED), [])
  const coreMaterial = useMemo(() => createCoreMaterial(), [])
  const haloMaterial = useMemo(() => createStatusHaloMaterial(), [])
  const driftSeed = useMemo(() => hash01(id), [id])
  const hoverK = useRef(0)
  const selectK = useRef(0)
  const dimK = useRef(0)
  const curScale = useRef(1)
  const settled = useRef(false)
  const visualDrift = useRef(new THREE.Vector3())

  useEffect(
    () => () => {
      material.dispose()
      coreMaterial.dispose()
      haloMaterial.dispose()
      nodePositions.delete(id)
      visualOffsets.delete(id)
    },
    [id, material, coreMaterial, haloMaterial],
  )

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const g = useAgentGraph.getState()
    const a: Agent | undefined = g.agents[id]
    if (!a) return
    const now = performance.now()
    const beat = REDUCED_MOTION ? 0 : heartbeatPulse(state.clock.elapsedTime)

    semanticToWorld(a.semantic, _target)
    let pos = _pos.copy(_target)
    let baseScale = a.weight
    let coreI = STATUS_CORE[a.status]
    const breathe = STATUS_BREATH[a.status]
    const activity = STATUS_ACTIVITY[a.status]

    // ── Stage 1–5: birth (bud → detach → semantic travel) ──
    if (a.birth) {
      const p = clamp01((now - a.birth.at) / SPAWN_MS)
      pos = spawnPos(p, a.birth, _target, _pos)
      baseScale = a.weight * spawnScale(p)
      coreI = Math.max(coreI, 0.8)
      if (p >= 1 && !settled.current) {
        settled.current = true
        g.settleSpawn(id)
      }
    } else if (a.mergeAt) {
      // merge-back: shrink + drift into the parent while matter flows home
      const q = clamp01((now - a.mergeAt) / MERGE_MS)
      const parentPos = a.parentId ? nodePositions.get(a.parentId) : undefined
      if (parentPos) pos.lerp(parentPos, easeInCubic(q) * 0.5)
      baseScale *= 1 - easeInCubic(q)
      coreI = 1
      if (q >= 1) {
        g.removeAgent(id)
        return
      }
    } else {
      settled.current = false
    }

    // absorbed-result pulse: brief swell + fresnel/core flash
    if (a.parentPulseAt) {
      const q = (now - a.parentPulseAt) / ABSORB_MS
      if (q >= 0 && q < 1) {
        const w = Math.sin(Math.PI * q)
        baseScale *= 1 + 0.09 * w
        coreI = Math.max(coreI, w)
      }
    }

    // ── publish position for links / necks / camera ──
    // Copy into the agent's own stored vector — never publish the shared
    // scratch, or every link endpoint aliases into a degenerate point.
    let stored = nodePositions.get(id)
    if (!stored) {
      stored = pos.clone()
      nodePositions.set(id, stored)
    } else {
      stored.copy(pos)
    }
    // Visual life layer: the semantic position above remains the anchor used
    // by the regression checks. This offset is deliberately small and
    // critically damped, so the tissue feels suspended without losing its
    // semantic geography.
    const driftMotion = REDUCED_MOTION ? 0 : a.birth || a.mergeAt ? 0.24 : 1
    const driftTime = state.clock.elapsedTime
    _driftTarget.set(
      Math.sin(driftTime * 0.17 + driftSeed * 6.283) * 0.105 +
        Math.sin(driftTime * 0.071 + driftSeed * 11.7) * 0.035,
      Math.sin(driftTime * 0.13 + driftSeed * 8.4) * 0.085 +
        Math.cos(driftTime * 0.061 + driftSeed * 4.1) * 0.028,
      Math.cos(driftTime * 0.15 + driftSeed * 5.2) * 0.095 +
        Math.sin(driftTime * 0.083 + driftSeed * 9.2) * 0.03,
    ).multiplyScalar(driftMotion * (0.78 + activity * 0.22))
    visualDrift.current.lerp(_driftTarget, 1 - Math.exp(-1.35 * dt))
    let offset = visualOffsets.get(id)
    if (!offset) {
      offset = visualDrift.current.clone()
      visualOffsets.set(id, offset)
    } else {
      offset.copy(visualDrift.current)
    }

    const group = groupRef.current
    group.position.copy(pos).add(visualDrift.current)

    hoverK.current = THREE.MathUtils.damp(hoverK.current, hovered ? 1 : 0, 10, dt)
    selectK.current = THREE.MathUtils.damp(selectK.current, selected ? 1 : 0, 10, dt)
    dimK.current = THREE.MathUtils.damp(dimK.current, dimmed ? 1 : 0, 8, dt)

    // Status light belongs to this agent alone. Runtime activity is a separate
    // axis; the PRD tier comes from context-window occupancy (or unavailable data).
    const visual = LOAD_VISUALS[loadTier(a.status, a.contextWindowPct)]
    const pulse = REDUCED_MOTION ? 0.5 : 0.5 + 0.5 * Math.sin((state.clock.elapsedTime * Math.PI * 2) / visual.period)
    const colorBlend = 1 - Math.exp(-5 * dt)
    material.uniforms.uStatusColor.value.lerp(visual.color, colorBlend)
    material.uniforms.uStatusGlow.value = THREE.MathUtils.damp(
      material.uniforms.uStatusGlow.value, 0.65 + pulse * 0.35, 5, dt,
    )
    coreMaterial.uniforms.uColor.value.lerp(visual.color, colorBlend)
    haloMaterial.color.lerp(visual.color, colorBlend)
    haloMaterial.opacity = (0.35 + pulse * 0.22) * (1 - dimK.current * 0.86)

    const targetScale = baseScale * (
      1 +
        0.05 * hoverK.current +
        0.06 * selectK.current +
        beat * (0.025 + 0.055 * activity)
    )
    curScale.current = THREE.MathUtils.damp(curScale.current, targetScale, 7, dt)
    group.scale.setScalar(AGENT_RADIUS * curScale.current)

    // ── material state ──
    const u = material.uniforms
    u.uTime.value = REDUCED_MOTION ? 0 : state.clock.elapsedTime % 600 // wrapped: keep trig args precise in long sessions
    u.uBeat.value = beat
    u.uBreath.value = breathe
    u.uActivity.value = Math.min(1, activity + selectK.current * 0.16) * (1 - dimK.current * 0.35)
    u.uCorePulse.value = Math.min(1, coreI + selectK.current * 0.2)
    u.uHover.value = hoverK.current
    u.uSelect.value = selectK.current
    u.uDim.value = dimK.current
    u.uError.value = a.status === 'error' ? 1 : 0

    // parent bulge toward the bud while spawning
    let bulge = 0
    let bulgeDir: [number, number, number] | null = null
    for (const fx of Object.values(g.activeSpawns)) {
      if (fx.parentId !== id) continue
      const q = (now - fx.at) / SPAWN_MS
      if (q >= 0 && q < PH_BUD) {
        const w = Math.sin((Math.PI * q) / PH_BUD)
        if (w > bulge) {
          bulge = w
          bulgeDir = fx.dir
        }
      }
    }
    u.uBulge.value = THREE.MathUtils.damp(u.uBulge.value, bulge * 0.7, 10, dt)
    if (bulgeDir) u.uBulgeDir.value.set(bulgeDir[0], bulgeDir[1], bulgeDir[2])

    // ── surface tension: reach toward the nearest soma ──
    // The strongest liquid cue there is. Meshes stay independent (own
    // geometry, own material, still pickable) — only the surface deforms,
    // and the bulge is capped below half the gap so bodies never fuse.
    const myR = AGENT_RADIUS * a.weight
    let neck = 0
    let neckX = 0
    let neckY = 0
    let neckZ = 0
    let nearestGap = Infinity
    for (const [otherId, otherPos] of nodePositions) {
      if (otherId === id) continue
      const other = g.agents[otherId]
      if (!other) continue
      const dx = otherPos.x - pos.x
      const dy = otherPos.y - pos.y
      const dz = otherPos.z - pos.z
      const d2 = dx * dx + dy * dy + dz * dz
      const gap = Math.sqrt(d2) - (myR + AGENT_RADIUS * other.weight)
      if (gap < nearestGap) {
        nearestGap = gap
        const inv = 1 / Math.max(Math.sqrt(d2), 1e-5)
        neckX = dx * inv
        neckY = dy * inv
        neckZ = dz * inv
      }
    }
    const NECK_RANGE = 1.1
    if (nearestGap > 0 && nearestGap < NECK_RANGE) {
      const t = 1 - nearestGap / NECK_RANGE
      neck = Math.min(t * 0.85, nearestGap / AGENT_RADIUS)
    }
    const nu = material.uniforms
    nu.uNeck.value = THREE.MathUtils.damp(nu.uNeck.value, neck, 6, dt)
    if (neck > 0.001) nu.uNeckDir.value.set(neckX, neckY, neckZ)

    const core = coreRef.current
    if (core) {
      core.visible = coreI > 0.03
      if (core.visible) {
        const cu = coreMaterial.uniforms
        cu.uTime.value = REDUCED_MOTION ? 0 : state.clock.elapsedTime % 600
        cu.uIntensity.value = (
          Math.min(1, coreI + selectK.current * 0.2) +
          beat * (0.07 + 0.16 * activity)
        ) * (1 - dimK.current * 0.82)
      }
    }
  })

  if (!agent) return null

  return (
    <group ref={groupRef}>
      <sprite material={haloMaterial} scale={[3.2, 3.2, 1]} raycast={() => null} />
      <mesh
        material={material}
        onPointerOver={(e) => {
          e.stopPropagation()
          hover(id)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          hover(null)
          document.body.style.cursor = 'auto'
        }}
        onClick={(e) => {
          e.stopPropagation()
          interfaceAudio.unlock()
          interfaceAudio.playSelect()
          select(id)
        }}
      >
        <sphereGeometry args={[1, 48, 32]} />
      </mesh>
      {SHOW_CORE && (
        <mesh ref={coreRef} material={coreMaterial} scale={0.55} raycast={() => null}>
          <sphereGeometry args={[1, 24, 16]} />
        </mesh>
      )}
      <AgentLabel id={id} />
    </group>
  )
}
