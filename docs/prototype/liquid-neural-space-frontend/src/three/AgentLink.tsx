import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { AGENT_RADIUS, isActive, useAgentGraph } from '../store/useAgentGraph'
import { createLinkMaterial } from './AgentMaterial'
import { linkHandles, nodePositions, visualOffsets } from '../lib/positions'
import {
  createTaperedTubeGeometry,
  makeSynapseCurve,
  synapseTaper,
  withBouton,
  withVaricosity,
} from '../lib/tubeGeometry'
import { clamp01, easeMass, heartbeatPulse } from '../lib/util'
import { loadTier, LOAD_VISUALS } from '../lib/loadState'

/**
 * A liquid synapse between two agents:
 * TubeGeometry over a straight segment, fat near both somas, thinner in the
 * middle, with viscous flow and travelling traffic packets.
 *
 * Packets ride the segment only while the edge is metabolically active.
 */

const MAX_PULSES_PER_EDGE = 2

/**
 * Fraction of a packet's cycle spent in motion; the rest is a rest gap.
 * A packet that is always on the wire has nowhere to come from — the gap is
 * what makes its arrival read as a discrete delivery.
 */
const PULSE_TRAVEL = 0.68

const REDUCED_MOTION =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** The tube's radius profile. Shared with the packet sizing below. */
// A longer, softer terminal bouton makes the straight process grow out of the
// soma instead of looking like a wire pushed into it. The center shaft stays
// thin; only the last ~18% of the segment receives the rounded root swelling.
const LINK_TAPER = withBouton(withVaricosity(synapseTaper, 0.14), 1.6, 0.2)

function packetMaterial(opacity: number) {
  return new THREE.MeshBasicMaterial({
    color: '#58a6ff', transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthTest: true, depthWrite: false,
  })
}

const _up = new THREE.Vector3(0, 1, 0)
const _tangent = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _mid = new THREE.Vector3()

export function AgentLink({ edgeId }: { edgeId: string }) {
  const meshRef = useRef<THREE.Mesh>(null!)
  const pulseRefs = useRef<(THREE.Mesh | null)[]>([])
  const tailRefs = useRef<(THREE.Mesh | null)[]>([])
  const material = useMemo(() => createLinkMaterial(), [])
  // Each moving packet needs its own color because packets on the same edge
  // can be at different points of the A→B gradient simultaneously.
  const pulseMaterials = useMemo(() => Array.from({ length: MAX_PULSES_PER_EDGE }, () => packetMaterial(0.96)), [])
  const tailMaterials = useMemo(() => Array.from({ length: MAX_PULSES_PER_EDGE }, () => packetMaterial(0.48)), [])
  const geometryRef = useRef<THREE.BufferGeometry | null>(null)
  const lastA = useRef(new THREE.Vector3(1e9, 0, 0))
  const lastB = useRef(new THREE.Vector3(1e9, 0, 0))
  const curveRef = useRef<THREE.CatmullRomCurve3 | null>(null)
  const dimK = useRef(0)
  const focusK = useRef(1)
  const flowK = useRef(0)
  const lastBand = useRef(-1)
  /** Per-packet cycle position. Advanced by dt, never derived from the clock. */
  const pulseCycle = useRef<number[]>([])
  const lastBeat = useRef(0)

  useEffect(
    () => () => {
      material.dispose()
      pulseMaterials.forEach((packet) => packet.dispose())
      tailMaterials.forEach((packet) => packet.dispose())
      geometryRef.current?.dispose()
      linkHandles.delete(edgeId)
    },
    [edgeId, material, pulseMaterials, tailMaterials],
  )

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const g = useAgentGraph.getState()
    const edge = g.edges[edgeId]
    const mesh = meshRef.current
    if (!edge || !mesh) return

    const A = nodePositions.get(edge.source)
    const B = nodePositions.get(edge.target)
    const sourceAgent = g.agents[edge.source]
    const targetAgent = g.agents[edge.target]
    if (!A || !B || !sourceAgent || !targetAgent || edge.hidden) {
      mesh.visible = false
      curveRef.current = null
      const handle = linkHandles.get(edgeId)
      if (handle) handle.active = false
      return
    }
    mesh.visible = true

    // Soma radii and the visible gap between them. Two agents whose bodies
    // already touch have no space to bridge — drawing a tube there produces a
    // self-intersecting "bowtie". Trim proportionally so a gap always remains.
    const rA = sourceAgent.weight * AGENT_RADIUS
    const rB = targetAgent.weight * AGENT_RADIUS
    const dist = A.distanceTo(B)
    if (dist < (rA + rB) * 0.92) {
      mesh.visible = false
      curveRef.current = null
      const h = linkHandles.get(edgeId)
      if (h) h.active = false
      return
    }

    const gap = Math.max(0.18, dist * 0.12)
    let ra = rA * 0.82
    let rb = rB * 0.82
    const maxSum = Math.max(dist - gap, 0.001)
    if (ra + rb > maxSum) {
      const k = maxSum / (ra + rb)
      ra *= k
      rb *= k
    }
    const trimA = ra * 0.64
    const trimB = rb * 0.64

    // Rebuild the tube when an endpoint moved (spawn travel, merge drift) or
    // when the traffic band changes. Static edges cost nothing per frame.
    // Traffic quantised into 4 bands so a busy tissue does not rebuild
    // geometry every frame.
    const trafficBand = Math.min(3, Math.floor(Math.min(edge.traffic, 40) / 13))
    const u = material.uniforms
    const colorBlend = 1 - Math.exp(-5 * dt)
    u.uColorA.value.lerp(LOAD_VISUALS[loadTier(sourceAgent.status, sourceAgent.contextWindowPct)].color, colorBlend)
    u.uColorB.value.lerp(LOAD_VISUALS[loadTier(targetAgent.status, targetAgent.contextWindowPct)].color, colorBlend)
    const offsetA = visualOffsets.get(edge.source)
    const offsetB = visualOffsets.get(edge.target)
    u.uOffsetA.value.copy(offsetA ?? _mid.set(0, 0, 0))
    u.uOffsetB.value.copy(offsetB ?? _mid.set(0, 0, 0))
    const moved =
      A.distanceToSquared(lastA.current) > 4e-6 ||
      B.distanceToSquared(lastB.current) > 4e-6
    if (moved || trafficBand !== lastBand.current) {
      lastA.current.copy(A)
      lastB.current.copy(B)
      lastBand.current = trafficBand
      // Let the terminal bouton burrow into each soma. The opaque soma then
      // hides the flat first ring, while the rounded profile emerges through
      // the membrane and reads as grown tissue rather than an inserted rod.
      const curve = makeSynapseCurve(A, B, edgeId, trimA, trimB)
      curveRef.current = curve
      // Liquid strands are never uniform: carrying traffic thickens a process.
      const geom = createTaperedTubeGeometry(curve, {
        // 12 radial segments: at 8 the cross-section faceting is visible as a
        // flat plate as soon as the camera gets close to a process
        tubularSegments: 32,
        radialSegments: 12,
        radius: 0.04 + trafficBand * 0.009,
        taper: LINK_TAPER,
      })
      geometryRef.current?.dispose()
      geometryRef.current = geom
      mesh.geometry = geom
      let handle = linkHandles.get(edgeId)
      if (!handle) {
        handle = { curve: null, active: false }
        linkHandles.set(edgeId, handle)
      }
      handle.curve = curve
      // the flow phase is measured in world units, so the shader needs to know
      // how long this process actually is — and how fat, since the surface
      // creep amplitude is a fraction of the tube radius
      u.uSpan.value = Math.max(dist - trimA - trimB, 0.25)
      u.uTubeR.value = 0.04 + trafficBand * 0.009
    }

    const active = isActive(sourceAgent.status) || isActive(targetAgent.status)
    let handle = linkHandles.get(edgeId)
    if (!handle) {
      handle = { curve: curveRef.current, active }
      linkHandles.set(edgeId, handle)
    }
    handle.active = active

    const beat = REDUCED_MOTION ? 0 : heartbeatPulse(state.clock.elapsedTime)
    const beatRelease = beat > 0.52 && lastBeat.current <= 0.52
    lastBeat.current = beat
    u.uTime.value = REDUCED_MOTION ? 0 : state.clock.elapsedTime % 600
    u.uBeat.value = beat
    flowK.current = THREE.MathUtils.damp(
      flowK.current,
      active ? 0.42 + Math.min(edge.traffic, 50) / 50 * 0.78 : 0.018,
      4,
      dt,
    )
    u.uFlow.value = flowK.current

    // return / merge pulse band
    let pulsePos = -1
    let pulseStr = 0
    if (edge.fx) {
      const dur = edge.fx.type === 'merge' ? 850 : 950
      const q = (performance.now() - edge.fx.at) / dur
      if (q >= 0 && q < 1) {
        const w = Math.sin(Math.PI * clamp01(q))
        pulsePos = 1 - q // flows child → parent (target → source)
        pulseStr = w * (edge.fx.type === 'merge' ? 1.7 : 1.15)
      }
    }
    u.uPulsePos.value = pulsePos
    u.uPulseStrength.value = pulseStr

    // Focus hierarchy: direct routes stay legible, neighbour-to-neighbour
    // routes remain as context, and the rest of the tissue recedes smoothly.
    let focusTarget = 1
    if (g.lineageFilter) {
      focusTarget =
        g.lineageFilter.has(edge.source) && g.lineageFilter.has(edge.target) ? 1 : 0.08
    } else if (g.selectedId) {
      const direct = edge.source === g.selectedId || edge.target === g.selectedId
      const inNeighbourhood =
        !!g.focusNeighbors?.has(edge.source) && !!g.focusNeighbors?.has(edge.target)
      focusTarget = direct ? 1 : inNeighbourhood ? 0.62 : 0.08
    }
    focusK.current = THREE.MathUtils.damp(focusK.current, focusTarget, 8, dt)
    dimK.current = THREE.MathUtils.damp(dimK.current, 1 - focusTarget, 8, dt)
    u.uDim.value = dimK.current
    // Visual hierarchy: pathways carrying traffic glow, resting ones recede.
    // A uniformly lit mesh reads as a static diagram; a selective one reads
    // as living tissue.
    const activity = Math.min(1, flowK.current / 0.9)
    const cameraDistance = _mid.copy(A).add(B).multiplyScalar(0.5).distanceTo(state.camera.position)
    const lodAlpha = THREE.MathUtils.clamp(
      1 - Math.max(cameraDistance - 16, 0) / 32 * 0.75,
      0.2,
      1,
    )
    u.uAlpha.value =
      (edge.type === 'spawn' ? 0.78 : 0.46) * focusK.current * (0.16 + 0.45 * activity) * lodAlpha * (1 + beat * 0.24)

    // ── traffic packets ──
    // Three things make this read as FLOW instead of a bead sliding on a wire:
    //
    //  1. The packet is sized from the LOCAL tube radius. A fixed-size capsule
    //     sits inside the tube (radius 0.04–0.067 plus the bouton flares at the
    //     ends) and is depth-occluded by it — so it flickers in and out of
    //     existence as it travels. Scaling past the tube wall makes it a real
    //     bulge of light riding the process.
    //  2. It is never teleported. The cycle advances by dt, so a traffic change
    //     or an edge rebuild cannot make the packet jump position.
    //  3. It emerges from the source soma and is absorbed by the target. The
    //     scale envelope IS the fade, so the shared material stays untouched.
    const curve = curveRef.current
    const showPulses = !REDUCED_MOTION && active && curve && focusK.current > 0.4 && lodAlpha > 0.46
    const cycles = pulseCycle.current
    if (cycles.length !== MAX_PULSES_PER_EDGE) {
      cycles.length = 0
      // Start in the hidden waiting segment. The next shared heartbeat emits
      // the packets together, so the tissue breath and information wave share
      // one rhythm from the first visible delivery.
      for (let i = 0; i < MAX_PULSES_PER_EDGE; i++) cycles.push(PULSE_TRAVEL)
    }
    // constant LINEAR speed, so short and long processes flow alike — a
    // normalised parameter makes long edges sprint and short ones crawl
    const linearV = 0.9 + (Math.min(edge.traffic, 50) / 50) * 1.2
    // travel the trimmed span in spanLen/linearV seconds, so the cycle rate is
    // PULSE_TRAVEL * linearV / spanLen (not the inverse — that would make the
    // packet's speed independent of linearV, i.e. traffic would not read)
    const cycleRate = (PULSE_TRAVEL * linearV) / Math.max(dist - trimA - trimB, 0.25)
    const tubeR = 0.04 + trafficBand * 0.009
    for (let i = 0; i < MAX_PULSES_PER_EDGE; i++) {
      const p = pulseRefs.current[i]
      const tail = tailRefs.current[i]
      if (!p) continue
      if (!showPulses) {
        p.visible = false
        if (tail) tail.visible = false
        continue
      }
      let c = cycles[i]
      if (c >= PULSE_TRAVEL) {
        if (beatRelease) {
          // The packet was invisible in the waiting segment, so releasing it
          // at the source is not a visible teleport. Once released, its
          // position advances only through dt below.
          c = i === 0 ? 0.001 : 0.12
        } else {
          // Rest between heartbeat-driven deliveries.
          cycles[i] = PULSE_TRAVEL
          p.visible = false
          if (tail) tail.visible = false
          continue
        }
      } else {
        c += dt * cycleRate
        if (c >= PULSE_TRAVEL) {
          cycles[i] = PULSE_TRAVEL
          p.visible = false
          if (tail) tail.visible = false
          continue
        }
      }
      cycles[i] = c
      if (c >= PULSE_TRAVEL) {
        p.visible = false
        if (tail) tail.visible = false
        continue
      }
      const u = c / PULSE_TRAVEL
      // pulled out of the source, decelerating into the target — but blended
      // with linear so it never reads as a stalled object
      const ue = 0.45 * u + 0.55 * easeMass(u)
      pulseMaterials[i].color.copy(material.uniforms.uColorA.value).lerp(material.uniforms.uColorB.value, THREE.MathUtils.smoothstep(ue, 0.08, 0.92))
      curve.getPointAt(ue, p.position)
      if (offsetA) p.position.addScaledVector(offsetA, 1 - ue)
      if (offsetB) p.position.addScaledVector(offsetB, ue)
      curve.getTangentAt(ue, _tangent)
      _quat.setFromUnitVectors(_up, _tangent.normalize())
      p.quaternion.copy(_quat)

      const env = Math.sqrt(Math.sin(Math.PI * u)) * (1 + beat * 0.2) // emerge → absorb
      const localR = tubeR * LINK_TAPER(ue)
      // 1.7x the local tube radius: enough to bulge clear of the wall (so the
      // packet is never swallowed) without competing with the somas for
      // attention — at 2.1x a busy tissue became a field of bright dots
      const r = Math.max(localR * 1.7, 0.055) * env
      // squash & stretch along the direction of travel: a packet in motion is
      // longer than it is wide, which is what separates "flowing" from "rigid"
      const sp = 1 + 0.55 * Math.min(1, linearV / 2.1)
      const lat = 1 / Math.sqrt(sp)
      p.scale.set(r * lat, r * sp, r * lat)
      p.visible = true

      // Trailing packet behind the head, fainter and shorter — the comet tail
      // is what makes the motion read as continuous flow instead of a dot.
      if (tail) {
        const uTail = Math.max(0, ue - 0.055)
        tailMaterials[i].color.copy(material.uniforms.uColorA.value).lerp(material.uniforms.uColorB.value, THREE.MathUtils.smoothstep(uTail, 0.08, 0.92))
        curve.getPointAt(uTail, tail.position)
        if (offsetA) tail.position.addScaledVector(offsetA, 1 - uTail)
        if (offsetB) tail.position.addScaledVector(offsetB, uTail)
        curve.getTangentAt(uTail, _tangent)
        _quat.setFromUnitVectors(_up, _tangent.normalize())
        tail.quaternion.copy(_quat)
        const envT = Math.sqrt(Math.sin(Math.PI * u)) * 0.45
        const rT = Math.max(tubeR * LINK_TAPER(uTail) * 1.2, 0.04) * envT
        tail.scale.set(rT * lat, rT * sp * 1.5, rT * lat)
        tail.visible = true
      }
    }
  })

  return (
    <>
      <mesh ref={meshRef} material={material} raycast={() => null} />
      {Array.from({ length: MAX_PULSES_PER_EDGE }, (_, i) => (
        <mesh
          key={i}
          ref={(m) => {
            pulseRefs.current[i] = m
          }}
          material={pulseMaterials[i]}
          visible={false}
          raycast={() => null}
        >
          <capsuleGeometry args={[1, 2, 6, 12]} />
        </mesh>
      ))}
      {Array.from({ length: MAX_PULSES_PER_EDGE }, (_, i) => (
        <mesh
          key={`tail-${i}`}
          ref={(m) => {
            tailRefs.current[i] = m
          }}
          material={tailMaterials[i]}
          visible={false}
          raycast={() => null}
        >
          <capsuleGeometry args={[1, 2, 6, 12]} />
        </mesh>
      ))}
    </>
  )
}
