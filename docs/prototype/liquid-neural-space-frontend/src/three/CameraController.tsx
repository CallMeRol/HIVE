import { useEffect, useRef } from 'react'
import type { ComponentRef, RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import { useAgentGraph } from '../store/useAgentGraph'
import { nodePositions, tissueTransform, visualOffsets } from '../lib/positions'

// three-stdlib OrbitControls rotates at roughly 6°/s when autoRotateSpeed=1.
// 4°/s keeps the reference site's slow presentation pace.
const AUTO_ORBIT_SPEED = 4 / 6

/**
 * Orbit / pan / zoom with hard limits and damping.
 * On selection the target eases toward the agent and the camera performs a
 * small respectful dolly-in — enough to feel like focus, not a cut.
 */
export function CameraController() {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null)
  const selectedId = useAgentGraph((s) => s.selectedId)
  const focusPull = useRef(1)
  const origin = useRef(new THREE.Vector3(0, 0.4, 0))
  const offset = useRef(new THREE.Vector3())
  const focusCenter = useRef(new THREE.Vector3())
  const hasInitialFrame = useRef(false)
  const lastAutoFitAt = useRef(-1)
  const lastAutoFitCount = useRef(0)
  const userInteracting = useRef(false)
  const idleOrbitK = useRef(0)

  const onControlStart = () => {
    userInteracting.current = true
  }
  const onControlEnd = () => {
    userInteracting.current = false
  }

  useEffect(() => {
    focusPull.current = selectedId ? 0.86 : 1
  }, [selectedId])

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.05)
    const controls = controlsRef.current
    if (!controls) return
    const g = useAgentGraph.getState()

    const canAutoRotate =
      !g.selectedId &&
      !g.lineageFilter &&
      !userInteracting.current
    idleOrbitK.current = THREE.MathUtils.damp(
      idleOrbitK.current,
      canAutoRotate ? 1 : 0,
      canAutoRotate ? 2.2 : 12,
      dt,
    )
    controls.autoRotate = false

    // Let the first few somas publish their semantic positions, then fit the
    // camera to their actual bounds. The minimum radius preserves breathing
    // room during the bootstrap burst; later growth stays inside the generous
    // maxDistance instead of causing camera churn.
    if (!hasInitialFrame.current && nodePositions.size >= 4) {
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity
      for (const p of nodePositions.values()) {
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        minZ = Math.min(minZ, p.z)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
        maxZ = Math.max(maxZ, p.z)
      }
      const boundsCenter = focusCenter.current.set(
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5,
      )
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ)
      const radius = Math.max(8.5, span * 0.62)
      const fov = THREE.MathUtils.degToRad(44)
      const distance = THREE.MathUtils.clamp(radius / Math.tan(fov * 0.5) * 1.08, 14, 32)
      const viewDirection = offset.current.copy(state.camera.position).sub(boundsCenter).normalize()
      state.camera.position.copy(boundsCenter).add(viewDirection.multiplyScalar(distance))
      controls.target.copy(boundsCenter)
      origin.current.copy(boundsCenter)
      lastAutoFitCount.current = nodePositions.size
      hasInitialFrame.current = true
    }

    // As the simulation grows, only expand the view; never pull the camera
    // inward or re-center it behind the user's back. This keeps a 50-agent
    // tissue inside the frame without fighting OrbitControls.
    if (!g.selectedId && hasInitialFrame.current && state.clock.elapsedTime - lastAutoFitAt.current > 0.65) {
      lastAutoFitAt.current = state.clock.elapsedTime
      let minX = Infinity
      let minY = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let maxZ = -Infinity
      for (const p of nodePositions.values()) {
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        minZ = Math.min(minZ, p.z)
        maxX = Math.max(maxX, p.x)
        maxY = Math.max(maxY, p.y)
        maxZ = Math.max(maxZ, p.z)
      }
      const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ)
      const radius = Math.max(8.5, span * 0.62)
      const fov = THREE.MathUtils.degToRad(44)
      const desiredDistance = THREE.MathUtils.clamp(radius / Math.tan(fov * 0.5) * 1.08, 14, 32)
      const currentOffset = offset.current.copy(state.camera.position).sub(controls.target)
      const currentDistance = currentOffset.length()
      if (nodePositions.size !== lastAutoFitCount.current) {
        const boundsCenter = focusCenter.current.set(
          (minX + maxX) * 0.5,
          (minY + maxY) * 0.5,
          (minZ + maxZ) * 0.5,
        )
        origin.current.lerp(boundsCenter, 0.24)
        controls.target.lerp(origin.current, 1 - Math.exp(-1.5 * dt))
        lastAutoFitCount.current = nodePositions.size
      }
      if (desiredDistance > currentDistance * 1.08) {
        currentOffset.setLength(THREE.MathUtils.damp(currentDistance, desiredDistance, 2.2, dt))
        state.camera.position.copy(controls.target).add(currentOffset)
      }
    }

    if (g.selectedId) {
      const p = nodePositions.get(g.selectedId)
      if (p) {
        const center = focusCenter.current.copy(p)
        const visualOffset = visualOffsets.get(g.selectedId)
        if (visualOffset) center.add(visualOffset)
        center.multiplyScalar(tissueTransform.scale).add(tissueTransform.position)
        // Focus the soma itself. Neighbours remain visible as context, but
        // they must not pull the clicked Agent away from screen center.
        controls.target.lerp(center, 1 - Math.exp(-4.5 * dt))
      }
    } else {
      const visualOrigin = focusCenter.current
        .copy(origin.current)
        .multiplyScalar(tissueTransform.scale)
        .add(tissueTransform.position)
      controls.target.lerp(visualOrigin, 1 - Math.exp(-0.35 * dt))
    }

    // one-shot gentle dolly on selection, relaxing back immediately after
    const cameraOffset = offset.current.copy(state.camera.position).sub(controls.target)
    const len = cameraOffset.length()
    const desired = len * focusPull.current
    if (g.selectedId) focusPull.current = THREE.MathUtils.damp(focusPull.current, 1, 1.4, dt)
    cameraOffset.setLength(THREE.MathUtils.damp(len, desired, 6, dt))
    state.camera.position.copy(controls.target).add(cameraOffset)

  })

  return (
    <>
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.065}
        autoRotate={false}
        minDistance={2.2}
        maxDistance={72}
        minPolarAngle={Math.PI * 0.08}
        maxPolarAngle={Math.PI * 0.92}
        rotateSpeed={0.74}
        zoomSpeed={0.82}
        panSpeed={0.8}
        onStart={onControlStart}
        onEnd={onControlEnd}
      />
      <IdleOrbit controlsRef={controlsRef} powerRef={idleOrbitK} />
    </>
  )
}

/** Runs after OrbitControls' own frame update so the idle orbit cannot be
 * overwritten by its internal spherical-state reconciliation. */
function IdleOrbit({
  controlsRef,
  powerRef,
}: {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>
  powerRef: RefObject<number>
}) {
  useFrame(() => {
    const controls = controlsRef.current
    const power = powerRef.current
    if (!controls) return

    const orbit = controls as unknown as {
      autoRotate: boolean
      autoRotateSpeed: number
      update: () => void
    }
    orbit.autoRotate = power > 0.001
    orbit.autoRotateSpeed = AUTO_ORBIT_SPEED * power
    orbit.update()
  })
  return null
}
