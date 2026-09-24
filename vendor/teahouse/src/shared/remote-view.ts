import { SCREEN_END_REASONS, SCREEN_REJECT_REASONS, type ScreenEndReason, type ScreenRejectReason } from './protocol'

export type ScreenMode = 'auto' | 'economy' | 'standard' | 'smooth'
export type ScreenPhase = 'requesting' | 'awaiting-consent' | 'preparing' | 'connecting' | 'active' | 'ended'
export type ScreenReason = ScreenEndReason | ScreenRejectReason
export interface ScreenState {
  revision: number
  sessionId: string
  peerId: string
  peerName: string
  peerIp: string
  role: 'viewer' | 'sharer'
  phase: ScreenPhase
  mode: ScreenMode
  targetFps: number
  reason?: ScreenReason
  requestedAt: number
  startedAt?: number
  endedAt?: number
  durationMs?: number
}
/** 仅本地聊天元数据，不含画面、来源或凭据；异常退出不能补造结束时间。 */
export interface ScreenRecord extends Pick<ScreenState, 'role' | 'phase' | 'requestedAt' | 'startedAt' | 'endedAt' | 'durationMs'> {
  v: 1
  reason?: ScreenReason | 'interrupted'
}

export function parseScreenRecord(raw: string | null | undefined): ScreenRecord | undefined {
  if (!raw || raw.length > 4096) return undefined
  try {
    const s = (JSON.parse(raw) as { screen?: ScreenRecord }).screen
    const time = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) > 0 && Number(n) <= 8640000000000000
    if (!s || s.v !== 1 || !['viewer', 'sharer'].includes(s.role) ||
      !['requesting', 'awaiting-consent', 'preparing', 'connecting', 'active', 'ended'].includes(s.phase) ||
      !time(s.requestedAt) || (s.startedAt !== undefined && !time(s.startedAt)) ||
      (s.endedAt !== undefined && !time(s.endedAt)) ||
      (s.durationMs !== undefined && (!Number.isSafeInteger(s.durationMs) || s.durationMs < 0 || s.startedAt === undefined)) ||
      (s.reason !== undefined && ![...SCREEN_END_REASONS, ...SCREEN_REJECT_REASONS, 'interrupted'].includes(s.reason)) ||
      (s.phase === 'active' && s.startedAt === undefined) ||
      (s.phase === 'ended' && s.reason !== 'interrupted' && s.endedAt === undefined)) return undefined
    return s
  } catch { return undefined }
}
export interface ScreenAvailability { view: boolean; share: boolean; reason: string }
export interface ScreenSource { id: string; name: string; thumbnail: string }
export interface ScreenImage { sessionId: string; seq: number; width: number; height: number; bytes: ArrayBuffer }
export interface ScreenSample { sessionId: string; seq: number }
export interface ScreenRequestResult { ok: boolean; reason?: 'busy' | 'offline' | 'unsupported' | 'rate-limited' }

export function isScreenMode(value: unknown): value is ScreenMode {
  return value === 'auto' || value === 'economy' || value === 'standard' || value === 'smooth'
}
