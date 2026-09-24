// #28 单测：attach 编排的拉群时机与回滚（黑盒注入式 deps，先例：#49 attach 校验单测）。
//
// 锁死的行为：
//   1. spawn 前零 invite（memberId 形态的 invite 是幽灵制造者，见 issue #28 机制链）；
//   2. waitHealth 成功后恰一次 invite，且参数是 health 返回的 **nodeId**；
//   3. invite 失败 = 接入失败：撤登记 + 终止子进程，不落接入账本（全有或全无）；
//   4. groupId 为空时不 invite（只接入不进群）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  attachMember,
  parseAttachState,
  type AttachDeps
} from './agent-attach'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hive-attach-invite-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 打桩 deps：真实文件账本 + 记录式 invite/register/unregister/kill，其余全绿。 */
function makeDeps(dir: string, overrides: Partial<AttachDeps> = {}): {
  deps: AttachDeps
  invites: Array<{ groupId: string; memberId: string }>
  registered: string[]
  unregistered: string[]
  killed: number[]
} {
  const invites: Array<{ groupId: string; memberId: string }> = []
  const registered: string[] = []
  const unregistered: string[] = []
  const killed: number[] = []
  // adapter 校验是 existsSync 的：stub 得给一个真实存在的文件。
  const adapterFile = join(dir, 'adapter.js')
  writeFileSync(adapterFile, '', 'utf8')
  const deps: AttachDeps = {
    selfId: () => 'owner-node',
    attachStatePath: () => join(dir, 'agent-attach.json'),
    dataRoot: () => join(dir, 'nodes'),
    nodeExe: () => '/bin/echo',
    adapterPath: () => adapterFile,
    writeNodeConfig: () => {},
    spawnNode: () => ({ pid: 4321, logPath: join(dir, 'node.log') }),
    waitHealth: async () => ({ nodeId: 'health-reported-node-id' }),
    inviteToGroup: (groupId, memberId) => {
      invites.push({ groupId, memberId })
      return true
    },
    registerMember: ({ memberId }) => {
      registered.push(memberId)
    },
    unregisterMember: (memberId) => {
      unregistered.push(memberId)
    },
    killMember: (pid) => {
      killed.push(pid)
    },
    existingPorts: () => [],
    log: () => {},
    now: () => 1_700_000_000_000,
    ...overrides
  }
  return { deps, invites, registered, unregistered, killed }
}

const baseRequest = {
  runtime: 'claude',
  nick: '成员',
  cwd: tmpdir(),
  model: '',
  permissionMode: '',
  groupId: 'group-a',
  adapterPath: '',
  toolPermission: ''
}

describe('attachMember 的拉群时机（#28）', () => {
  it('spawn 前零 invite；health 成功后恰一次且参数是 waitHealth 报的 nodeId', async () => {
    const dir = tempDir()
    const calls: string[] = []
    const { deps, invites } = makeDeps(dir, {
      spawnNode: () => {
        calls.push('spawn')
        return { pid: 111, logPath: join(dir, 'n.log') }
      },
      waitHealth: async () => {
        calls.push('health')
        return { nodeId: 'health-reported-node-id' }
      },
      inviteToGroup: (groupId, memberId) => {
        calls.push(`invite:${groupId}:${memberId}`)
        invites.push({ groupId, memberId })
        return true
      }
    })

    const result = await attachMember({ ...baseRequest, adapterPath: undefined }, deps)

    expect(result.ok).toBe(true)
    // 顺序纪律：invite 只能发生在 health 之后（此刻才有 nodeId）；spawn 先于两者。
    expect(calls).toEqual(['spawn', 'health', 'invite:group-a:health-reported-node-id'])
    expect(invites).toEqual([{ groupId: 'group-a', memberId: 'health-reported-node-id' }])
    // invite 的参数绝不能是 memberId 形态（`<runtime>-<ts>-<port>`）。
    expect(invites[0]?.memberId).not.toMatch(/^(claude|codex)-\d+-\d+$/)
    // 成功后账本确实落了这条接入。
    const ledger = parseAttachState(JSON.parse(readFileSync(join(dir, 'agent-attach.json'), 'utf8')))
    expect(ledger.members).toHaveLength(1)
    expect(ledger.members[0]?.memberId).toBe(result.memberId)
  })

  it('groupId 为空时不 invite（只接入不进群）', async () => {
    const dir = tempDir()
    const { deps, invites } = makeDeps(dir)
    const result = await attachMember({ ...baseRequest, groupId: '' }, deps)
    expect(result.ok).toBe(true)
    expect(invites).toEqual([])
  })

  it('invite 失败 = 接入失败：撤登记 + 终止子进程，账本不落条', async () => {
    const dir = tempDir()
    const { deps, unregistered, killed } = makeDeps(dir, {
      inviteToGroup: () => false
    })

    const result = await attachMember(baseRequest, deps)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('group-a')
    expect(result.hint.trim().length).toBeGreaterThan(0)
    expect(unregistered).toHaveLength(1)
    // 节点已起，必须收掉 —— 不留「起着但没进群」的半拉成员。
    expect(killed).toEqual([4321])
    // 全有或全无：账本绝不记一条没进群的成员（失败路径不写文件）。
    expect(existsSync(join(dir, 'agent-attach.json'))).toBe(false)
  })
})
