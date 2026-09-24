import type DatabaseT from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { Profile } from '../../shared/protocol'
import { PeerRegistry } from '../net/peer-registry'
import { SearchService } from './search'

function emptyDb(): DatabaseT.Database {
  return {
    prepare: () => ({
      all: () => [],
      get: () => undefined
    })
  } as unknown as DatabaseT.Database
}

function profile(nodeId: string, nick: string, overrides: Partial<Profile> = {}): Profile {
  return {
    nodeId,
    nick,
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    profileRev: 1,
    host: 'lujuntiandeMacBook-Air.local',
    platform: 'mac',
    tcpPort: 18888,
    ver: '0.44.1-test',
    caps: [],
    ...overrides
  }
}

describe('SearchService 全局联系人搜索', () => {
  it('忽略共享主机名，并保留昵称、备注、组织与 IP 匹配', () => {
    const registry = new PeerRegistry('node-self')
    registry.touch('node-nick', '127.0.0.1', 10001, profile('node-nick', 'juntian1'))
    registry.touch(
      'node-org',
      '127.0.0.2',
      10002,
      profile('node-org', '组织成员', { company: 'Juntian 工作室' })
    )
    registry.touch(
      'node-remark',
      '127.0.0.3',
      10003,
      profile('node-remark', '备注成员', {
        avatar: 61,
        avatarHash: 'a'.repeat(64)
      })
    )
    registry.touch('node-host-only', '127.0.0.4', 10004, profile('node-host-only', 'test1'))
    const remarks = new Map([['node-remark', 'juntian 备注']])
    const search = new SearchService(emptyDb(), registry, (nodeId) => remarks.get(nodeId) ?? '')

    const ids = search.query('juntian').peers.map((peer) => peer.nodeId)
    expect(ids).toHaveLength(3)
    expect(ids).toEqual(expect.arrayContaining(['node-nick', 'node-org', 'node-remark']))
    expect(ids).not.toContain('node-host-only')
    expect(search.query('127.0.0.4').peers.map((peer) => peer.nodeId)).toEqual(['node-host-only'])
    expect(search.query('juntian 备注').peers[0]).toMatchObject({
      nodeId: 'node-remark',
      remark: 'juntian 备注',
      avatar: 61,
      avatarHash: 'a'.repeat(64)
    })
  })
})

describe('SearchService 会话内搜索', () => {
  it('相同 SQL 形状复用 prepared statement', () => {
    let conversationPrepareCount = 0
    const db = {
      prepare(sql: string) {
        if (sql.includes('conv_id = @convId')) conversationPrepareCount += 1
        return {
          all: () => [],
          get: () => undefined
        }
      }
    } as unknown as DatabaseT.Database
    const search = new SearchService(db, new PeerRegistry('node-self'))

    search.conversation({ convId: 'single:node-bob', query: '会议', kind: 'all' })
    search.conversation({ convId: 'single:node-bob', query: '项目', kind: 'all' })

    expect(conversationPrepareCount).toBe(1)
  })
})
