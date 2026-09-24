import { useRef, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { useFrame } from '@react-three/fiber'
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'
import { useShallow } from 'zustand/react/shallow'
import { useAgentGraph } from '../store/useAgentGraph'
import { heartbeatPulse } from '../lib/util'
import { interfaceAudio } from '../lib/audio'
import { tissueTransform } from '../lib/positions'
import { AgentLink } from './AgentLink'
import { AgentNode } from './AgentNode'
import { CameraController } from './CameraController'
import { SpawnNeck } from './SpawnEffect'
import { SceneDust } from './SceneDust'

const REDUCED_MOTION =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * A shared visual shell for the tissue. It translates and breathes as one
 * organism, while semantic node positions remain untouched in the registry.
 * The small pointer parallax gives the scene the suspended, tactile response
 * of the reference experience without turning the camera into an auto-tour.
 */
function TissueMotion({ children }: { children: ReactNode }) {
  const groupRef = useRef<THREE.Group>(null!)
  const target = useRef(new THREE.Vector3())
  const lastBeat = useRef(0)

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const group = groupRef.current
    if (!group) return

    if (REDUCED_MOTION) {
      group.position.set(0, 0, 0)
      group.scale.setScalar(1)
      tissueTransform.position.set(0, 0, 0)
      tissueTransform.scale = 1
      lastBeat.current = 0
      return
    }

    const t = state.clock.elapsedTime
    const beat = heartbeatPulse(t)
    if (beat > 0.52 && lastBeat.current <= 0.52) interfaceAudio.playHeartbeat()
    lastBeat.current = beat
    const pointer = state.pointer
    target.current.set(
      Math.sin(t * 0.11) * 0.075 + pointer.x * 0.045,
      Math.sin(t * 0.08 + 1.2) * 0.052 + pointer.y * 0.03,
      Math.cos(t * 0.095 + 0.4) * 0.04,
    )
    group.position.lerp(target.current, 1 - Math.exp(-1.65 * dt))

    const beatScale = 1 + beat * 0.02
    const scale = THREE.MathUtils.damp(group.scale.x, beatScale, 4.2, dt)
    group.scale.setScalar(scale)
    tissueTransform.position.copy(group.position)
    tissueTransform.scale = scale
  })

  return <group ref={groupRef}>{children}</group>
}

/**
 * The hero surface: ≥70% of the product viewport.
 * Near-black space, exp fog, the liquid neural tissue as the only subject.
 */
export function NeuralCanvas() {
  const agentIds = useAgentGraph(useShallow((s) => Object.keys(s.agents)))
  const edgeIds = useAgentGraph(useShallow((s) => Object.keys(s.edges)))
  const spawnChildIds = useAgentGraph(useShallow((s) => Object.keys(s.activeSpawns)))
  const select = useAgentGraph((s) => s.select)
  // debug switches: ?nolinks=1 hides synapses, ?nocore=1 hides inner cores
  const debug = new URLSearchParams(window.location.search)
  const showLinks = debug.get('nolinks') !== '1'
  const showNecks = debug.get('nonecks') !== '1'

  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [17, 10.5, 19], fov: 44, near: 0.1, far: 260 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerMissed={(event) => {
        if (event.button === 0) select(null)
      }}
    >
      <color attach="background" args={['#050608']} />
      <fogExp2 attach="fog" args={['#050608', 0.025]} />

      <SceneDust />

      <TissueMotion>
        {showLinks && edgeIds.map((id) => (
          <AgentLink key={`e-${id}`} edgeId={id} />
        ))}
        {agentIds.map((id) => (
          <AgentNode key={`a-${id}`} id={id} />
        ))}
        {showNecks && spawnChildIds.map((id) => (
          <SpawnNeck key={`n-${id}`} childId={id} />
        ))}
      </TissueMotion>

      <CameraController />

      <EffectComposer multisampling={0}>
        <Bloom
          intensity={0.56}
          luminanceThreshold={0.46}
          luminanceSmoothing={0.28}
          mipmapBlur
          radius={0.66}
        />
        <Vignette darkness={0.5} offset={0.22} />
      </EffectComposer>
    </Canvas>
  )
}
