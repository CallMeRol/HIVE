import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getLanguage, initialLanguage, isLanguage, setLanguage, tr } from './index'
import english from './en'
import { parseScreenRecord } from '../shared/remote-view'
import { screenDuration, messageText, parseSystemMessage, systemMessage } from './messages'
import { loadAppState, saveAppSettings } from '../main/store/app-state'
import { incomingNotificationOptions } from '../main/notifications'
import { messagePreview } from '../main/store/msg-repo'
import { SYSTEM_MESSAGE_TEMPLATES, type Language } from '../shared/i18n'
import type { MessageView } from '../shared/ipc'

afterEach(async () => { await setLanguage('zh-CN') })

describe('离线语言与持久设置', () => {
  it('新安装识别系统语言；已有配置缺失或非法语言保留中文', () => {
    for (const system of ['zh-CN', 'zh-TW', 'zh_HK', 'ZH']) {
      expect(initialLanguage(false, undefined, system)).toBe('zh-CN')
    }
    expect(initialLanguage(false, undefined, 'de-DE')).toBe('en')
    expect(initialLanguage(true, undefined, 'en-US')).toBe('zh-CN')
    expect(initialLanguage(true, 'fr', 'en-US')).toBe('zh-CN')
    expect(initialLanguage(true, 'en', 'zh-CN')).toBe('en')
    expect(isLanguage('__proto__')).toBe(false)
  })

  it('翻译只替换模板参数，未知键回退；快速切换以最后一次为准', async () => {
    await setLanguage('en')
    expect(tr('设置')).toBe('Settings')
    expect(tr('来自 {0}', { 0: '张三{0}$&' })).toBe('From 张三{0}$&')
    expect(tr('尚未翻译')).toBe('尚未翻译')
    await Promise.all([setLanguage('en'), setLanguage('zh-CN')])
    expect(getLanguage()).toBe('zh-CN')
    expect(tr('设置')).toBe('设置')
  })

  it('真实配置保存重开保留语言，升级不改变身份与旧偏好', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teahouse-language-'))
    try {
      const fresh = loadAppState(dir, '0.57.0', undefined, undefined, [], 'en-US')
      expect(fresh.config.language).toBe('en')
      const old = JSON.parse(readFileSync(fresh.configPath, 'utf8'))
      delete old.language
      old.nick = '保持中文名字'
      writeFileSync(fresh.configPath, JSON.stringify(old))
      const upgraded = loadAppState(dir, '0.57.0', undefined, undefined, [], 'en-US')
      expect(upgraded.config.language).toBe('zh-CN')
      expect(upgraded.nodeId).toBe(fresh.nodeId)
      saveAppSettings(upgraded, { language: 'en' })
      saveAppSettings(upgraded, { language: 'invalid' as Language })
      const reopened = loadAppState(dir, '0.57.0', undefined, undefined, [], 'zh-CN')
      expect(reopened.config.language).toBe('en')
      expect(reopened.config.nick).toBe('保持中文名字')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('所有英文模板保持相同参数，系统模板全部有译文', () => {
    const params = (text: string): string[] => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
    for (const [source, translated] of Object.entries(english)) {
      expect(translated.trim(), source).not.toBe('')
      expect(params(translated), source).toEqual(params(source))
    }
    for (const template of Object.values(SYSTEM_MESSAGE_TEMPLATES)) expect(english[template], template).toBeTruthy()
  })
})

describe('用户内容和系统提示边界', () => {
  it('新提示双语切换，用户名字与历史消息逐字保留', async () => {
    const data = systemMessage('group.renamed', {
      actor: { name: '你' }, before: '设置', after: '聊天{actor}'
    })
    const preview = messagePreview({ kind: 'system', content: data.content, file_ref: data.fileRef })
    expect(preview.fileRef).toBeUndefined()
    expect(messageText(preview)).toBe('你把群名「设置」改成了「聊天{actor}」')
    await setLanguage('en')
    expect(messageText(preview)).toBe('你 renamed the group from “设置” to “聊天{actor}”')
    expect(messageText({ kind: 'system', text: '你撤回了一条消息' })).toBe('你撤回了一条消息')
    expect(messageText({ kind: 'text', text: '[图片]' })).toBe('[图片]')
    expect(messageText({ kind: 'image', text: '[图片]' })).toBe('[Image]')
    const self = systemMessage('group.left', { actor: { name: '', role: 'self' } })
    expect(messageText(messagePreview({ kind: 'system', content: self.content, file_ref: self.fileRef }))).toBe('You left the group')
    expect(self.content).toBe('你退出了群聊')
    const file = { transferId: 't', name: '设置.txt', size: 1, count: 1, dir: false }
    const upload = systemMessage('share.uploaded', { actor: '陈同事', count: 1 }, file)
    const uploaded = messagePreview({ kind: 'system', content: upload.content, file_ref: upload.fileRef })
    expect(uploaded.fileRef?.transferId).toBe('t')
    expect(uploaded.fileRef?.name).toBe(file.name)
    expect(messageText(uploaded)).toContain('陈同事 uploaded')
  })

  it('元数据使用白名单，损坏或未来格式安全回退', () => {
    const valid = systemMessage('nudge.sent')
    expect(parseSystemMessage(valid.fileRef)?.key).toBe('nudge.sent')
    for (const raw of ['{', 'null', '{}', JSON.stringify({ system: { v: 2, key: 'nudge.sent', params: {} } }),
      JSON.stringify({ system: { v: 1, key: '__proto__', params: {} } }),
      JSON.stringify({ system: { v: 1, key: 'group.left', params: {} } }),
      JSON.stringify({ system: { v: 1, key: 'group.left', params: { actor: { name: [], role: 'self' } } } })]) {
      expect(parseSystemMessage(raw), raw).toBeUndefined()
    }
  })

  it('通知语言随设置变化，正文保持原文且隐藏预览仍有效', async () => {
    const msg: MessageView = { id: 'm', convId: 'single:p', senderId: 'p', isMine: false,
      kind: 'text', text: '设置', ts: 1, seq: 1, status: 'sent' }
    await setLanguage('en')
    const input = { msg, senderNick: '张三', hidePreview: false, silent: true }
    expect(incomingNotificationOptions(input).body).toBe('设置')
    expect(incomingNotificationOptions({ ...input, hidePreview: true }).body).toBe('New message received')
    expect(incomingNotificationOptions({ ...input, msg: { ...msg, kind: 'image' } }).body).toBe('[Image]')
  })
})


it('屏幕记录按本机角色与当前语言展示；损坏元数据回退文本', async () => {
  const screen = { v: 1, role: 'sharer', phase: 'ended', requestedAt: 1000, endedAt: 2000, reason: 'declined' }
  const view = messagePreview({ kind: 'system', content: '回退文本', file_ref: JSON.stringify({ screen }) })
  await setLanguage('zh-CN')
  expect(messageText(view)).toBe('你已拒绝查看请求')
  await setLanguage('en')
  expect(messageText(view)).toBe('You declined the viewing request')
  expect(screenDuration(0)).toBe('00:00')
  expect(screenDuration(3661250)).toBe('1:01:01')
  for (const invalid of [null, { ...screen, v: 2 }, { ...screen, role: 'other' }, { ...screen, reason: '__proto__' },
    { ...screen, requestedAt: -1 }, { ...screen, startedAt: 3000, durationMs: -1 }, { ...screen, phase: 'active' },
    { ...screen, endedAt: undefined }]) {
    const raw = JSON.stringify({ screen: invalid })
    expect(parseScreenRecord(raw)).toBeUndefined()
    expect(messageText(messagePreview({ kind: 'system', content: '回退文本', file_ref: raw }))).toBe('回退文本')
  }
  await setLanguage('zh-CN')
})
