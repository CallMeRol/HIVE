import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

/**
 * Near-black infinite space. No city, no grid floor, no starfield —
 * only faint dust for depth, heavy fog, and the tissue itself.
 */
export function SceneDust({ count = 650 }: { count?: number }) {
  const ref = useRef<THREE.Points>(null!)

  const { geometry, material } = useMemo(() => {
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      // shell distribution so dust never occludes the core of the tissue
      const r = 16 + Math.random() * 34
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.cos(phi) * 0.6
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    // Round soft sprite. Raw gl.POINTS are squares, and a dust particle near
    // the camera would otherwise show up as a hard-edged grey box.
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2,
    )
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.35, 'rgba(255,255,255,0.55)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    const sprite = new THREE.CanvasTexture(canvas)
    sprite.colorSpace = THREE.SRGBColorSpace

    const material = new THREE.PointsMaterial({
      color: '#6b3038',
      size: 0.06,
      sizeAttenuation: true,
      map: sprite,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    return { geometry, material }
  }, [count])

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y = state.clock.elapsedTime * 0.004
      ref.current.rotation.z = Math.sin(state.clock.elapsedTime * 0.05) * 0.01
    }
  })

  return <points ref={ref} geometry={geometry} material={material} raycast={() => null} />
}
