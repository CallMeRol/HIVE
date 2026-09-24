// Hive 成员登记表（#53）：**本节点拥有的成员** → 主人 / 类别 / 所属群。
//
// 边界（docs/contracts/parallel-development.md 状态所有者表）：
// - 全局成员表（谁在群里）归 vendored teahouse store，本模块只读它；
// - 本文件只记「本机视角下我拥有哪些成员」，是 #53 的判权依据，也是 #51 派遣账本的落点。
//   #53 只做**读 + 授权 + 移出 + 清理**；生产侧写入（派遣/接入）由 #51 / #49 调 register()。
// - 本机账本，绝不进上游 schema（ADR-0003 迁移规则 4）。
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJson } from '../util/atomic-write'

/** 迁移规则：Hive 侧持久化结构一律带 schemaVersion（整数，起 1）。 */
export const MEMBER_REGISTRY_SCHEMA_VERSION = 1

/** 常驻成员 = 主人拉进群、长期在线；派遣成员 = 成员为一个任务摇进来、完成即回收。 */
export type MemberKind = 'resident' | 'dispatched'

export interface MemberRecord {
  memberId: string
  /** 该成员的**主人**（人），不是群主/管理员。每个成员恰有一个主人 —— 成员级属性，不随群变。 */
  ownerId: string
  kind: MemberKind
  /** kind=dispatched 时的派遣者（ADR-0006：派遣者的 admin 只作用于自己派出的成员）。 */
  spawnedBy?: string
  /**
   * 仅 kind=dispatched 有意义：该成员被派进哪个群。
   * 常驻成员的主人关系是成员级的、与群无关，故不记 groupId —— 同一个成员被拉进第二个群时，
   * 主人不会变，记 groupId 反而会制造「跨群误删」判定（AC4）。
   */
  groupId?: string
  registeredAt: number
}

export interface MemberRegistryFile {
  schemaVersion: number
  members: MemberRecord[]
}

export interface MemberAuditEntry {
  ts: number
  /** 移出（主人路径）或孤儿清理（授权 admin 路径）。 */
  action: 'remove' | 'orphan_remove'
  result: 'ok' | 'denied' | 'backend_rejected'
  actorId: string
  targetId: string
  groupId: string
  /** 拒绝码（result=denied 时）；见 member-removal.ts。 */
  code?: string
  reason?: string
  phase?: 'leave' | 'orphan_removed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeMember(raw: unknown): MemberRecord | null {
  if (!isRecord(raw)) return null
  const memberId = typeof raw.memberId === 'string' ? raw.memberId.trim() : ''
  const ownerId = typeof raw.ownerId === 'string' ? raw.ownerId.trim() : ''
  if (!memberId || !ownerId) return null
  const spawnedBy = typeof raw.spawnedBy === 'string' ? raw.spawnedBy.trim() : ''
  const groupId = typeof raw.groupId === 'string' ? raw.groupId.trim() : ''
  return {
    memberId,
    ownerId,
    kind: raw.kind === 'dispatched' ? 'dispatched' : 'resident',
    ...(spawnedBy ? { spawnedBy } : {}),
    ...(groupId ? { groupId } : {}),
    registeredAt: typeof raw.registeredAt === 'number' ? raw.registeredAt : 0
  }
}

/** 容错解析：坏行丢弃而不是让整张表失效（本机账本，宁可少一条也不能崩）。 */
export function parseMemberRegistry(raw: unknown): MemberRegistryFile {
  const members: MemberRecord[] = []
  const list = isRecord(raw) && Array.isArray(raw.members) ? raw.members : []
  for (const item of list) {
    const member = normalizeMember(item)
    if (member) members.push(member)
  }
  return { schemaVersion: MEMBER_REGISTRY_SCHEMA_VERSION, members }
}

/**
 * 只有 `ownerId === selfId` 的条目才是「本机管理的成员」（决定本机能否移出）；
 * 其余条目是**只读的主目录**——本机知道某成员归别人所有，好把「不是你的成员」和
 * 「查不到这个人」区分成两种拒绝原因。全量目录由 #51/#58 的同步路径补齐，
 * 本票只消费它的判权语义。
 */
export function ownedBy(file: MemberRegistryFile, selfId: string): MemberRecord[] {
  return file.members.filter((m) => m.ownerId === selfId)
}

export function registerMember(
  file: MemberRegistryFile,
  record: Omit<MemberRecord, 'registeredAt'> & { registeredAt?: number }
): MemberRegistryFile {
  const next = normalizeMember({ ...record, registeredAt: record.registeredAt ?? 0 })
  if (!next) return file
  const members = file.members.filter((m) => m.memberId !== next.memberId)
  members.push(next)
  return { schemaVersion: MEMBER_REGISTRY_SCHEMA_VERSION, members }
}

export function unregisterMember(file: MemberRegistryFile, memberId: string): MemberRegistryFile {
  return {
    schemaVersion: MEMBER_REGISTRY_SCHEMA_VERSION,
    members: file.members.filter((m) => m.memberId !== memberId)
  }
}

export interface MemberRegistryOptions {
  /** 登记表文件绝对路径（userData 下）。 */
  path: string
  /** 拒绝留痕 append-only JSONL；每行自带 schemaVersion（迁移规则 6）。 */
  auditPath: string
  now?: () => number
}

/**
 * 本机成员登记表。启动时读一次（`PANTRY_MEMBER_REGISTRY` 播种 = 生产侧写入的替身，
 * #51 落地后改走 register()），之后由 register/unregister 维护。
 */
export class MemberRegistry {
  private file: MemberRegistryFile
  private readonly path: string
  private readonly auditPath: string
  private readonly now: () => number
  /** 上次读到文件的 mtimeMs：外部（#49/#51 的写入路径）改动后要能被吸进来。 */
  private seenMtimeMs = 0

  constructor(options: MemberRegistryOptions) {
    this.path = options.path
    this.auditPath = options.auditPath
    this.now = options.now ?? (() => Date.now())
    this.file = parseMemberRegistry(this.readSeed())
    this.seenMtimeMs = this.statMtime()
  }

  private statMtime(): number {
    try {
      return statSync(this.path).mtimeMs
    } catch {
      return 0
    }
  }

  private readSeed(): unknown {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return null
    }
  }

  /**
   * 判权前吸一次磁盘：登记表可能被本进程 register() 写，也可能被外部写入路径（#49 接入、
   * #51 派遣）改；不重读会让「刚拉进来的成员」在授权时查不到登记而被误拒。
   */
  private reload(): void {
    const mtime = this.statMtime()
    if (mtime === 0 || mtime === this.seenMtimeMs) return
    this.seenMtimeMs = mtime
    const external = parseMemberRegistry(this.readSeed())
    // 外部文件为准：本进程自己刚写的也在磁盘上，不会丢。
    this.file = external
  }

  private flush(): void {
    try {
      atomicWriteJson(this.path, this.file)
      this.seenMtimeMs = this.statMtime()
    } catch (err) {
      console.error('[hive] 成员登记表落盘失败：', err)
    }
  }

  list(): MemberRecord[] {
    this.reload()
    return this.file.members.map((m) => ({ ...m }))
  }

  get(memberId: string): MemberRecord | undefined {
    this.reload()
    const hit = this.file.members.find((m) => m.memberId === memberId)
    return hit ? { ...hit } : undefined
  }

  register(record: Omit<MemberRecord, 'registeredAt'> & { registeredAt?: number }): MemberRecord | null {
    this.file = registerMember(this.file, { ...record, registeredAt: record.registeredAt ?? this.now() })
    this.flush() // 同 memberId 覆盖写时长度不变，因此无条件落盘。
    return this.get(record.memberId) ?? null
  }

  unregister(memberId: string): boolean {
    const before = this.file.members.length
    this.file = unregisterMember(this.file, memberId)
    const removed = this.file.members.length !== before
    if (removed) this.flush()
    return removed
  }

  /** 拒绝与成功都留痕（Spec #41：权限判断始终 fail-closed 并记录拒绝原因）。 */
  recordAudit(entry: Omit<MemberAuditEntry, 'ts'>): void {
    const line = JSON.stringify({ v: MEMBER_REGISTRY_SCHEMA_VERSION, ts: this.now(), ...entry })
    try {
      mkdirSync(dirname(this.auditPath), { recursive: true })
      appendFileSync(this.auditPath, `${line}\n`, 'utf8')
    } catch (err) {
      console.error('[hive] 成员操作留痕失败：', err)
    }
  }
}
