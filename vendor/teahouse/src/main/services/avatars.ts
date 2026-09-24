import { EventEmitter } from 'node:events'
import {
  CAPS,
  MSG_TYPES,
  isAvatarHash,
  type AvatarPayload,
  type Envelope,
  type GroupPayload,
  type Profile
} from '../../shared/protocol'
import { makeEnvelope } from '../net/codec'
import type { Messenger } from '../net/messenger'
import type { PeerRegistry } from '../net/peer-registry'
import type { GroupRepo } from '../store/group-repo'
import { AvatarStore } from './avatar-store'

const AVATAR_REQUEST_TIMEOUT = 10_000

export interface AvatarServiceDeps {
  selfId: string
  messenger: Messenger
  registry: PeerRegistry
  groupRepo: GroupRepo
  store: AvatarStore
  getSelfProfile: () => Profile
}

/** 同一哈希的在途请求：只认当前源的应答，miss 故障转移时不重复打已试过的源（决议 #249）。 */
interface PendingRequest {
  timer: ReturnType<typeof setTimeout>
  source: string
  groupId?: string
  tried: Set<string>
}

/** 自定义头像按需获取与授权服务；图片正文只记录哈希、字节数等元数据。 */
export class AvatarService extends EventEmitter {
  private readonly pending = new Map<string, PendingRequest>()

  constructor(private readonly deps: AvatarServiceDeps) {
    super()
    deps.messenger.on('incoming', (env: Envelope) => {
      if (env.type === MSG_TYPES.avatar) void this.handle(env as Envelope<AvatarPayload>)
      if (env.type === MSG_TYPES.group) {
        const payload = env.payload as GroupPayload
        if (payload.op === 'info') {
          queueMicrotask(() => void this.ensureGroup(payload.group.groupId, env.from))
        }
      }
    })
    deps.registry.on('online', (nodeId: string) => {
      void this.ensurePeer(nodeId)
      for (const group of deps.groupRepo.list()) {
        if (group.members.includes(nodeId)) void this.ensureGroup(group.groupId, nodeId)
      }
    })
  }

  ensureAll(): void {
    for (const record of this.deps.registry.values()) void this.ensurePeer(record.profile.nodeId)
    for (const group of this.deps.groupRepo.list()) void this.ensureGroup(group.groupId)
  }

  async ensurePeer(nodeId: string): Promise<void> {
    const record = this.deps.registry.get(nodeId)
    const hash = record?.profile.avatarHash
    if (
      !record?.online ||
      !isAvatarHash(hash) ||
      !record.profile.caps.includes(CAPS.avatarImages) ||
      (await this.deps.store.has(hash))
    ) {
      return
    }
    const entry = this.begin(hash)
    if (!entry) return
    entry.source = nodeId
    entry.tried.add(nodeId)
    const ok = await this.deps.messenger.sendReliable(
      nodeId,
      makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, this.deps.selfId, { op: 'get', hash })
    )
    if (!ok) this.finish(hash)
  }

  async ensureGroup(groupId: string, preferredSource?: string): Promise<void> {
    const group = this.deps.groupRepo.get(groupId)
    const hash = group?.avatarHash
    if (
      !group ||
      !group.members.includes(this.deps.selfId) ||
      !isAvatarHash(hash) ||
      (await this.deps.store.has(hash))
    ) {
      return
    }
    const entry = this.begin(hash, groupId)
    if (!entry) return
    await this.requestFromGroupSources(hash, entry, preferredSource)
  }

  /** 逐个尝试未试过的在线群成员源：某源 ACK 后等它的 data / miss，全部无着落则结束本轮。 */
  private async requestFromGroupSources(
    hash: string,
    entry: PendingRequest,
    preferredSource?: string
  ): Promise<void> {
    const group = entry.groupId ? this.deps.groupRepo.get(entry.groupId) : undefined
    if (!group || group.avatarHash !== hash || !group.members.includes(this.deps.selfId)) {
      this.finish(hash)
      return
    }

    const sources = group.members
      .filter((id) => id !== this.deps.selfId && !entry.tried.has(id))
      .filter((id) => {
        const peer = this.deps.registry.get(id)
        return peer?.online && peer.profile.caps.includes(CAPS.avatarImages)
      })
      .sort((a, b) => Number(b === preferredSource) - Number(a === preferredSource))

    for (const source of sources) {
      if (this.pending.get(hash) !== entry) return // 超时或已完成，别再发
      entry.tried.add(source)
      entry.source = source
      this.rearm(hash, entry)
      const ok = await this.deps.messenger.sendReliable(
        source,
        makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, this.deps.selfId, {
          op: 'get',
          hash,
          groupId: group.groupId
        })
      )
      if (ok) return
    }
    // 一个源都没发出去（无在线成员）→ 立即结束，成员上线可即时重试；
    // 发过但全部无着落 → 保留登记项当冷却，重试频率仍以超时为上限（决议 #249）。
    if (this.pending.get(hash) === entry && entry.tried.size === 0) this.finish(hash)
  }

  private begin(hash: string, groupId?: string): PendingRequest | null {
    if (this.pending.has(hash)) return null
    const entry: PendingRequest = {
      timer: setTimeout(() => this.finish(hash), AVATAR_REQUEST_TIMEOUT),
      source: '',
      groupId,
      tried: new Set()
    }
    entry.timer.unref?.()
    this.pending.set(hash, entry)
    return entry
  }

  private rearm(hash: string, entry: PendingRequest): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.finish(hash), AVATAR_REQUEST_TIMEOUT)
    entry.timer.unref?.()
  }

  private finish(hash: string): void {
    const entry = this.pending.get(hash)
    if (entry) clearTimeout(entry.timer)
    this.pending.delete(hash)
  }

  private async handle(env: Envelope<AvatarPayload>): Promise<void> {
    const payload = env.payload
    if (payload.op === 'get') {
      await this.serve(env.from, payload)
      return
    }
    if (payload.op === 'miss') {
      this.onMiss(env.from, payload)
      return
    }
    await this.accept(env.from, payload)
  }

  private async serve(peerId: string, payload: Extract<AvatarPayload, { op: 'get' }>): Promise<void> {
    const requester = this.deps.registry.get(peerId)
    if (!requester?.online || !requester.profile.caps.includes(CAPS.avatarImages)) return

    if (payload.groupId) {
      const group = this.deps.groupRepo.get(payload.groupId)
      if (!group || !group.members.includes(this.deps.selfId) || !group.members.includes(peerId)) {
        return // 成员/权限不符保持沉默，与旧行为一致
      }
      if (group.avatarHash !== payload.hash) {
        this.replyMiss(peerId, payload)
        return
      }
    } else if (this.deps.getSelfProfile().avatarHash !== payload.hash) {
      this.replyMiss(peerId, payload)
      return
    }

    const bytes = await this.deps.store.read(payload.hash)
    if (!bytes) {
      this.replyMiss(peerId, payload)
      return
    }
    await this.deps.messenger.sendReliable(
      peerId,
      makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, this.deps.selfId, {
        op: 'data',
        hash: payload.hash,
        bytesBase64: bytes.toString('base64'),
        ...(payload.groupId ? { groupId: payload.groupId } : {})
      })
    )
  }

  /** miss 是尽力而为提示：必须走一次性单发，旧端整包忽略不回 ACK，可靠发送会误判离线（决议 #249）。 */
  private replyMiss(peerId: string, payload: { hash: string; groupId?: string }): void {
    this.deps.messenger.sendBestEffort(
      peerId,
      makeEnvelope<AvatarPayload>(MSG_TYPES.avatar, this.deps.selfId, {
        op: 'miss',
        hash: payload.hash,
        ...(payload.groupId ? { groupId: payload.groupId } : {})
      })
    )
  }

  /** 当前请求源明确答复无文件：群头像立即改试下一个成员源；
   *  用户头像只有资料所属节点一个源，保留登记项当冷却，避免每次注册表变化都空请求。 */
  private onMiss(peerId: string, payload: Extract<AvatarPayload, { op: 'miss' }>): void {
    const entry = this.pending.get(payload.hash)
    if (!entry || entry.source !== peerId) return
    if (entry.groupId) {
      void this.requestFromGroupSources(payload.hash, entry)
    }
  }

  private async accept(peerId: string, payload: Extract<AvatarPayload, { op: 'data' }>): Promise<void> {
    if (payload.groupId) {
      const group = this.deps.groupRepo.get(payload.groupId)
      if (
        !group ||
        !group.members.includes(this.deps.selfId) ||
        !group.members.includes(peerId) ||
        group.avatarHash !== payload.hash
      ) {
        return
      }
    } else {
      const source = this.deps.registry.get(peerId)
      if (source?.profile.avatarHash !== payload.hash) return
    }

    const bytes = Buffer.from(payload.bytesBase64, 'base64')
    if (!(await this.deps.store.import(payload.hash, bytes))) return
    this.finish(payload.hash)
    this.emit('ready', payload.hash)
  }
}
