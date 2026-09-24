import * as THREE from 'three'
import type { AgentStatus } from '../types'

export type LoadTier = 'idle' | 'ease' | 'busy' | 'overload' | 'critical'

export const LOAD_VISUALS: Record<LoadTier, { label: string; color: THREE.Color; hex: string; period: number }> = {
  idle: { label: '空闲', color: new THREE.Color('#58a6ff'), hex: '#58a6ff', period: 1.5 },
  ease: { label: '轻松', color: new THREE.Color('#3fb950'), hex: '#3fb950', period: 1.0 },
  busy: { label: '有点忙', color: new THREE.Color('#d29922'), hex: '#d29922', period: 1.5 },
  overload: { label: '过载', color: new THREE.Color('#f0883e'), hex: '#f0883e', period: 1.5 },
  critical: { label: '快炸了', color: new THREE.Color('#f85149'), hex: '#f85149', period: 2.0 },
}

/** The workload tier is independent of online/offline and return lifecycle. */
export function loadTier(status: AgentStatus, windowPct: number | null): LoadTier {
  if (status === 'idle' || windowPct == null || !Number.isFinite(windowPct)) return 'idle'
  if (windowPct >= 40) return 'critical'
  if (windowPct >= 20) return 'overload'
  if (windowPct >= 10) return 'busy'
  return 'ease'
}
