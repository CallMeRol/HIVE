import { describe, expect, it } from 'vitest'
import type { PeerView } from '../../../shared/ipc'
import {
  filterGroupMemberCandidates,
  normalizeGroupMemberSelection,
  toggleGroupMemberSelection
} from './group-member-picker'

function peer(nodeId: string, overrides: Partial<PeerView> = {}): PeerView {
  return {
    nodeId,
    nick: `昵称-${nodeId}`,
    remark: '',
    company: '',
    dept: '',
    team: '',
    host: `${nodeId}.local`,
    avatar: 0,
    avatarHash: '',
    platform: 'mac',
    ip: '192.168.1.10',
    online: true,
    lastSeen: 1,
    ver: '0.41.0',
    caps: [],
    ...overrides
  }
}

describe('群成员共享选择器', () => {
  const peers = [
    peer('node-a', {
      nick: '小明',
      remark: '产品明哥',
      company: '茶话科技',
      dept: '产品部',
      team: '增长组',
      ip: '10.0.0.21',
      host: 'ming-mac'
    }),
    peer('node-b', {
      nick: '小华',
      remark: '设计华姐',
      company: '点心工作室',
      dept: '设计部',
      team: '体验组',
      ip: '10.0.0.22',
      host: 'hua-pc',
      online: false
    })
  ]

  it.each([
    ['产品明哥', 'node-a'],
    ['小明', 'node-a'],
    ['茶话科技', 'node-a'],
    ['产品部', 'node-a'],
    ['增长组', 'node-a'],
    ['10.0.0.21', 'node-a'],
    ['ming-mac', 'node-a'],
    ['设计华姐', 'node-b']
  ])('按备注、昵称、组织、IP 或主机名搜索：%s', (query, nodeId) => {
    const rows = filterGroupMemberCandidates(peers, new Set(), query)
    expect(rows.map((row) => row.peer.nodeId)).toEqual([nodeId])
  })

  it('隐藏已有群成员，同时保留组织路径和离线候选', () => {
    const rows = filterGroupMemberCandidates(peers, new Set(['node-a']), '')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      peer: { nodeId: 'node-b', online: false },
      organization: '点心工作室 · 设计部 · 体验组'
    })
  })

  it('跨搜索结果保留多选，支持取消并遵守剩余人数上限', () => {
    let selectedIds = toggleGroupMemberSelection([], 'node-a', 2)
    expect(filterGroupMemberCandidates(peers, new Set(), '设计').map((row) => row.peer.nodeId)).toEqual([
      'node-b'
    ])

    selectedIds = toggleGroupMemberSelection(selectedIds, 'node-b', 2)
    expect(selectedIds).toEqual(['node-a', 'node-b'])
    expect(toggleGroupMemberSelection(selectedIds, 'node-c', 2)).toEqual(selectedIds)
    expect(toggleGroupMemberSelection(selectedIds, 'node-a', 2)).toEqual(['node-b'])
  })

  it('群成员或剩余名额变化时清理选择', () => {
    expect(
      normalizeGroupMemberSelection(
        ['node-a', 'node-b', 'node-a', 'node-c'],
        new Set(['node-b']),
        2
      )
    ).toEqual(['node-a', 'node-c'])
    expect(normalizeGroupMemberSelection(['node-a'], new Set(), 0)).toEqual([])
  })
})
