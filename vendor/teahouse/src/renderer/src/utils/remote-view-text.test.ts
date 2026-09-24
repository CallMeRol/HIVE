import { afterEach, expect, it } from 'vitest'
import { setLanguage } from '../../../i18n'
import type { ScreenRecord } from '../../../shared/remote-view'
import { screenStatusText } from './remote-view-text'

afterEach(async () => { await setLanguage('zh-CN') })

it('紧凑状态区分双方拒绝、取消与结束，并支持切换语言', async () => {
  const record: ScreenRecord = { v: 1, role: 'sharer', phase: 'ended', requestedAt: 1000, endedAt: 2000, reason: 'declined' }
  expect(screenStatusText(record)).toBe('你已拒绝')
  expect(screenStatusText({ ...record, role: 'viewer' })).toBe('对方拒绝')
  expect(screenStatusText({ ...record, reason: 'user', startedAt: 1500 })).toBe('已结束')
  expect(screenStatusText({ ...record, reason: 'canceled' })).toBe('已取消')
  expect(screenStatusText({ ...record, reason: 'interrupted', endedAt: undefined })).toBe('已中断')
  await setLanguage('en')
  expect(screenStatusText(record)).toBe('You declined')
  expect(screenStatusText({ ...record, phase: 'requesting' })).toBe('Pending')
  expect(screenStatusText({ ...record, phase: 'active', startedAt: 1500 })).toBe('In progress')
})
