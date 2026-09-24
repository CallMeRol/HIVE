import type { FileRefView, ForwardResult, ForwardTarget, MessageView, TableTextMeta } from '../../shared/ipc'
import type { FilesService } from './files'
import type { GroupsService } from './groups'
import type { ChatService } from './chat'
import type { MsgRepo, MsgRow } from '../store/msg-repo'

export interface ForwardDeps {
  msgRepo: MsgRepo
  chat: ChatService
  groups: GroupsService
  files: FilesService
  canInlineImage?: (path: string) => Promise<boolean>
}

// 转发编排：复用文本/群聊/文件服务，不新增线上协议。
export class ForwardService {
  constructor(private readonly deps: ForwardDeps) {}

  async forward(msgId: string, targets: ForwardTarget[]): Promise<ForwardResult> {
    const row = this.deps.msgRepo.get(msgId)
    const cleanTargets = this.normalizeTargets(targets)
    if (!row || !this.canForward(row)) return { ok: 0, total: cleanTargets.length, messages: [] }

    const messages: MessageView[] = []
    for (const target of cleanTargets) {
      const view = await this.forwardOne(row, target)
      if (view) messages.push(view)
    }
    return { ok: messages.length, total: cleanTargets.length, messages }
  }

  private normalizeTargets(targets: ForwardTarget[]): ForwardTarget[] {
    const seen = new Set<string>()
    const out: ForwardTarget[] = []
    for (const target of targets) {
      if ((target.type !== 'single' && target.type !== 'group') || !target.id) continue
      if (target.id.length > 64) continue
      const key = `${target.type}:${target.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(target)
      if (out.length >= 50) break
    }
    return out
  }

  private canForward(row: MsgRow): boolean {
    if (row.status === 'recalled') return false
    return row.kind === 'text' || row.kind === 'file' || row.kind === 'image' || row.kind === 'sticker'
  }

  private async forwardOne(row: MsgRow, target: ForwardTarget): Promise<MessageView | null> {
    if (row.kind === 'text') {
      return target.type === 'group'
        ? this.deps.groups.sendText(target.id, row.content)
        : this.deps.chat.sendText(target.id, row.content)
    }
    const ref = this.parseFileRef(row.file_ref)
    if (!ref) return null
    const transfer = this.deps.files.transferView(ref.transferId)
    if (!transfer?.savedPath) return null
    const purpose = await this.forwardPurpose(row.kind, transfer.savedPath)
    const tableText = purpose === 'image' ? this.tableTextForForward(row.kind, ref) : undefined
    return target.type === 'group'
      ? this.deps.files.offerGroupPaths(target.id, [transfer.savedPath], purpose, tableText)
      : this.deps.files.offerPaths(target.id, [transfer.savedPath], purpose, tableText)
  }

  private async forwardPurpose(kind: string, path: string): Promise<'file' | 'image' | 'sticker'> {
    if (kind === 'sticker') return 'sticker'
    if (kind !== 'image') return 'file'
    if (!this.deps.canInlineImage) return 'image'
    try {
      return (await this.deps.canInlineImage(path)) ? 'image' : 'file'
    } catch {
      return 'file'
    }
  }

  private tableTextForForward(kind: string, ref: FileRefView): TableTextMeta | undefined {
    if (kind !== 'image' || !ref.tableText) return undefined
    return {
      tableText: ref.tableText,
      ...(ref.tableTextTruncated ? { tableTextTruncated: true } : {})
    }
  }

  private parseFileRef(raw: string | null): FileRefView | null {
    if (!raw) return null
    try {
      const ref = JSON.parse(raw) as FileRefView
      return typeof ref.transferId === 'string' && ref.transferId ? ref : null
    } catch {
      return null
    }
  }
}
