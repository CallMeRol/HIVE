import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { AGENT_RADIUS, SPAWN_MS, useAgentGraph } from '../store/useAgentGraph'
import { createLinkMaterial } from './AgentMaterial'
import { spawnScale } from './AgentNode'
import { nodePositions, visualOffsets } from '../lib/positions'
import { createTaperedTubeGeometry } from '../lib/tubeGeometry'
import { clamp01, smoothstep } from '../lib/util'

/**
 * The liquid neck of an in-progress spawn: Stages 2–4 of the split.
 * A soft, narrowing bridge that leaves the parent surface and reaches the
 * budding child. The contact tips are softly plugged and the waist pinches so
 * the bridge reads as surface tension instead of a rigid inserted tube.
 */
export function SpawnNeck({ childId }: { childId: string }) {
  const meshRef = useRef<THREE.Mesh>(null!)
  const material = useMemo(() => createLinkMaterial(), [])
  const geomRef = useRef<THREE.BufferGeometry | null>(null)

  useEffect(
    () => () => {
      material.dispose()
      geomRef.current?.dispose()
    },
    [material],
  )

  useFrame((state) => {
    const g = useAgentGraph.getState()
    const fx = g.activeSpawns[childId]
    const mesh = meshRef.current
    if (!fx) {
      mesh.visible = false
      return
    }
    const q = (performance.now() - fx.at) / SPAWN_MS
    // the neck exists through the bud and the breakaway, then dissolves as the
    // droplet lets go — this is what makes the separation read as slow
    if (q < 0.06 || q > 0.7) {
      mesh.visible = false
      return
    }
    const A = nodePositions.get(fx.parentId)
    const B = nodePositions.get(childId)
    const parent = g.agents[fx.parentId]
    const child = g.agents[childId]
    if (!A || !B || !parent || !child) {
      mesh.visible = false
      return
    }
    mesh.visible = true

    const dir = new THREE.Vector3(fx.dir[0], fx.dir[1], fx.dir[2])
    // start just OUTSIDE the parent surface, end outside the bud surface
    const start = A.clone().addScaledVector(dir, AGENT_RADIUS * parent.weight * 1.0)
    const childR = AGENT_RADIUS * child.weight * spawnScale(clamp01(q))
    const end = B.clone().addScaledVector(dir, -childR * 0.6)
    const offsetA = visualOffsets.get(fx.parentId)
    const offsetB = visualOffsets.get(childId)
    if (offsetA) start.add(offsetA)
    if (offsetB) end.add(offsetB)
    if (start.distanceToSquared(end) < 1e-4) {
      mesh.visible = false
      return
    }

    // Surface tension makes a soft hourglass: it fattens just outside both
    // somas, pinches in the middle, then slowly dissolves as the child lets go.
    const neckR = 0.15 * (1 - q * 0.55)
    const taper = (t: number) => {
      const d = Math.min(t, 1 - t)
      const root = Math.exp(-Math.pow(d / 0.16, 2))
      const plug = 0.42 + 0.58 * Math.min(1, d / 0.08)
      return (0.28 + 0.92 * root) * plug * (1 - q * 0.24)
    }
    const curve = new THREE.CatmullRomCurve3([start, end], false, 'catmullrom', 0.5)
    const geom = createTaperedTubeGeometry(curve, {
      // short bridge — 12 spans is plenty, and spawns now overlap far more
      // often because the timeline is twice as long
      tubularSegments: 12,
      radialSegments: 10,
      radius: Math.max(neckR, 0.02),
      taper,
    })
    geomRef.current?.dispose()
    geomRef.current = geom
    mesh.geometry = geom

    const u = material.uniforms
    u.uTime.value = state.clock.elapsedTime % 600
    u.uFlow.value = 0.55
    u.uAlpha.value = (1 - smoothstep(0.52, 0.7, q)) * 0.98
    u.uDim.value = 0
    u.uPulsePos.value = clamp01(q * 1.6)
    u.uPulseStrength.value = 0.7 * (1 - smoothstep(0.42, 0.7, q))
  })

  return <mesh ref={meshRef} material={material} raycast={() => null} />
}
