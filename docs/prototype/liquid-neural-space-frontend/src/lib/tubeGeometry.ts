import * as THREE from 'three'

/**
 * Liquid synapse geometry toolkit.
 *
 * - createTaperedTubeGeometry: a TubeGeometry variant whose radius varies
 *   along the curve — fat near both somas, thinner in the synaptic middle.
 * - makeSynapseCurve: a STRAIGHT segment between two agents. The nodes sit on
 *   a spherical shell, so straight chords form a geodesic ball.
 */

export interface TaperedTubeOptions {
  tubularSegments?: number
  radialSegments?: number
  radius?: number
  /** Radius multiplier at parametric position t ∈ [0,1]. */
  taper?: (t: number) => number
}

export function createTaperedTubeGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  opts: TaperedTubeOptions = {},
): THREE.BufferGeometry {
  const tubularSegments = opts.tubularSegments ?? 36
  const radialSegments = opts.radialSegments ?? 10
  const radius = opts.radius ?? 0.075
  const taper = opts.taper

  const frames = curve.computeFrenetFrames(tubularSegments, false)

  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  const P = new THREE.Vector3()
  const N = new THREE.Vector3()

  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments
    curve.getPointAt(t, P)
    const r = radius * (taper ? taper(t) : 1)
    const normal = frames.normals[i]
    const binormal = frames.binormals[i]

    for (let j = 0; j <= radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2
      const sin = Math.sin(v)
      const cos = -Math.cos(v)

      N.set(
        cos * normal.x + sin * binormal.x,
        cos * normal.y + sin * binormal.y,
        cos * normal.z + sin * binormal.z,
      ).normalize()

      positions.push(P.x + r * N.x, P.y + r * N.y, P.z + r * N.z)
      normals.push(N.x, N.y, N.z)
      uvs.push(t, j / radialSegments) // u along the tube — used by flow shader
    }
  }

  // Same winding pattern as three.js TubeGeometry (front faces outward).
  for (let j = 1; j <= tubularSegments; j++) {
    for (let i = 1; i <= radialSegments; i++) {
      const a = (radialSegments + 1) * (j - 1) + (i - 1)
      const b = (radialSegments + 1) * j + (i - 1)
      const c = (radialSegments + 1) * j + i
      const d = (radialSegments + 1) * (j - 1) + i
      indices.push(a, b, d)
      indices.push(b, c, d)
    }
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geom.setIndex(indices)
  return geom
}

/**
 * Axon-like profile: a thin shaft that flares into a terminal bouton at each
 * end. Uniform-thickness tubes read as blood vessels; this reads as a process.
 */
export function synapseTaper(t: number): number {
  const mid = Math.abs(2 * t - 1) // 0 in the middle, 1 at the ends
  return 0.3 + 0.7 * Math.pow(mid, 1.8)
}

/**
 * Terminal bouton — a local swelling just inside each end, where the process
 * meets a soma. The very tip remains a soft rounded plug rather than collapsing
 * to a needle, so the process grows out of the membrane instead of looking
 * directly inserted into it.
 */
export function withBouton(
  base: (t: number) => number,
  flare = 0.5,
  span = 0.09,
): (t: number) => number {
  return (t) => {
    const d = Math.min(t, 1 - t)
    const bump = d < span ? Math.sin((d / span) * Math.PI) : 0
    const tip = d < span * 0.45 ? d / (span * 0.45) : 1
    return base(t) * (1 + flare * bump) * (0.48 + 0.52 * tip)
  }
}

/**
 * Axonal varicosities — the gentle beading of a real process. Very subtle:
 * enough to break the "extruded hose" silhouette, not enough to look striped.
 */
export function withVaricosity(
  base: (t: number) => number,
  amount = 0.14,
): (t: number) => number {
  return (t) =>
    base(t) *
    (1 + amount * Math.sin(t * 19.0) + amount * 0.5 * Math.sin(t * 43.0 + 1.7))
}

/**
 * Multiply a radius profile so the tube thins right at its tips.
 * Prevents a fat grazing "collar" from rendering over the soma surface.
 */
export function withEndThin(
  base: (t: number) => number,
  thin = 0.3,
  span = 0.1,
): (t: number) => number {
  return (t) => {
    const d = Math.min(t, 1 - t)
    const k = thin + (1 - thin) * Math.min(1, d / span)
    return base(t) * k
  }
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _dir = new THREE.Vector3()

/**
 * STRAIGHT synapse line between two world positions.
 *
 * The nodes already sit on a spherical shell, so straight chords read as the
 * edges of a polyhedron inscribed in that sphere — a clean geodesic ball. Any
 * lateral bend or outward bow fights that read: bowed processes bulge outside
 * the soma cloud and turn the ball into a ball of yarn.
 *
 * `trimStart` / `trimEnd` pull the endpoints back along the axis so the tube
 * STOPS at the soma surface instead of piercing it — no grazing collar.
 *
 * Returned as a CatmullRomCurve3 whose control points are collinear, so it is
 * geometrically a straight segment while keeping the curve API the tube
 * builder and the traffic pulses rely on.
 */
export function makeSynapseCurve(
  from: THREE.Vector3,
  to: THREE.Vector3,
  _seed?: string,
  trimStart = 0,
  trimEnd = 0,
): THREE.CatmullRomCurve3 {
  _dir.subVectors(to, from)
  if (_dir.lengthSq() < 1e-9) _dir.set(1, 0, 0)
  _dir.normalize()

  _a.copy(from).addScaledVector(_dir, trimStart)
  _b.copy(to).addScaledVector(_dir, -trimEnd)
  if (_a.distanceToSquared(_b) < 1e-6) {
    _b.copy(_a).addScaledVector(_dir, 0.001)
  }

  const len = _a.distanceTo(_b)
  const start = _a.clone()
  const end = _b.clone()
  // collinear control points → an exactly straight segment
  const c1 = start.clone().addScaledVector(_dir, len * 0.3)
  const c2 = start.clone().addScaledVector(_dir, len * 0.7)

  return new THREE.CatmullRomCurve3([start, c1, c2, end], false, 'catmullrom', 0.5)
}
