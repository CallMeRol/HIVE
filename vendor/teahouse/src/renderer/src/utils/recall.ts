import { tr } from './i18n'
export function recallRemainingMs(nowTs: number, msgTs: number, windowMs: number): number {
  return Math.max(0, windowMs - (nowTs - msgTs))
}

export function formatRecallMenuMeta(remainingMs: number, disabledReason = ''): string {
  if (disabledReason) return disabledReason
  if (remainingMs <= 0) return tr('超时')
  const totalSec = Math.ceil(remainingMs / 1000)
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0')
  const ss = String(totalSec % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function isRecallMenuUrgent(remainingMs: number, disabledReason = ''): boolean {
  return disabledReason === '' && remainingMs > 0 && remainingMs <= 10_000
}

export function canRecallAt(
  nowTs: number,
  msgTs: number,
  windowMs: number,
  disabledReason = ''
): boolean {
  return disabledReason === '' && nowTs - msgTs <= windowMs
}
