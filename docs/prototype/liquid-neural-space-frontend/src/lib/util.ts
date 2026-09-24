// ─── Small shared math / random helpers ──────────────────────────────────────

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t)
export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
export const easeInCubic = (t: number) => t * t * t
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

/**
 * Heavy-body ease: zero velocity at both ends, but asymmetric — the velocity
 * peak sits at 44% of the trip, so the body accelerates briefly and then
 * decelerates over a long tail. This is what makes motion read as mass.
 *
 *   f(x) = x^p / (x^p + (1-x)^q)   with p < q
 *
 * C-infinity smooth (no velocity discontinuity at the seam), f(0)=0, f(1)=1,
 * f'(0)=f'(1)=0. At 80% of the time the body has covered ~97.6% of the
 * distance — the final approach is a slow creep, which is exactly the "settles
 * into place" feel.
 */
const MASS_P = 2.2
const MASS_Q = 2.6
export const easeMass = (t: number) => {
  const x = clamp01(t)
  const a = Math.pow(x, MASS_P)
  const b = Math.pow(1 - x, MASS_Q)
  return a / (a + b)
}
export const smoothstep = (a: number, b: number, t: number) => {
  const x = clamp01((t - a) / (b - a))
  return x * x * (3 - 2 * x)
}

/**
 * A restrained double-beat envelope used for ambient life, never for packet
 * position. The first contraction is crisp, the rebound is softer, followed
 * by a longer diastolic gap. Phase offsets are deliberately small so the
 * tissue feels coherent without becoming a synchronized clock.
 */
let cachedHeartbeatTime = -1
let cachedHeartbeatValue = 0

export function heartbeatPulse(time: number, phase = 0): number {
  if (phase === 0 && time === cachedHeartbeatTime) return cachedHeartbeatValue
  const cycle = ((time * 0.62 + phase) % 1 + 1) % 1
  const systole = Math.exp(-Math.pow((cycle - 0.1) / 0.05, 2))
  const rebound = 0.64 * Math.exp(-Math.pow((cycle - 0.23) / 0.095, 2))
  const value = clamp01(systole + rebound)
  if (phase === 0) {
    cachedHeartbeatTime = time
    cachedHeartbeatValue = value
  }
  return value
}

export function randRange(min: number, max: number) {
  return min + Math.random() * (max - min)
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** Deterministic string hash → [0,1). Used for per-edge stable randomness. */
export function hash01(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

let eventSeq = 0
export function nextEventId() {
  return `ev-${Date.now().toString(36)}-${(eventSeq++).toString(36)}`
}

export function fmtTime(ms: number) {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
