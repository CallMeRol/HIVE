import { tr } from './i18n'
/**
 * 表格粘贴提示条的纯逻辑（决议 #270）。
 * 粘贴识别出表格后不再直接发图片，只把原文插入草稿并给出「发送为图片」入口，
 * 误判的代价从「消息已经发出去了」降到「多了一条可忽略的提示」。
 */

/** 提示条自动消失时长；草稿超上限时不挂这个定时器 */
export const TABLE_PASTE_HINT_MS = 5000

export interface TablePasteHint {
  /** 插入草稿的起点（UTF-16 偏移） */
  start: number
  /** 本次插入的原文，用于从草稿里摘回这一段 */
  text: string
  /** 插入后的完整草稿快照，用于判断用户是否已改动 */
  draft: string
  /** 草稿已超过单条文本上限，只能按图片发送 */
  oversize: boolean
}

export function tablePasteHintText(oversize: boolean): string {
  return oversize ? tr('表格过大，只能按图片发送') : tr('检测到表格')
}

/** 草稿仍是插入后的原样才保留提示条：用户一动内容，捕获的表格就过期了 */
export function tablePasteHintIntact(draft: string, hint: TablePasteHint): boolean {
  return draft === hint.draft
}

/** 改发图片时把刚插入的那段从草稿里摘掉，草稿里原有的其它内容保留 */
export function draftWithoutTablePaste(hint: TablePasteHint): string {
  return hint.draft.slice(0, hint.start) + hint.draft.slice(hint.start + hint.text.length)
}
