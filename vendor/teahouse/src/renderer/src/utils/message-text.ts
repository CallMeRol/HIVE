import type { MessagePreview, PkRefView } from '../../../shared/ipc'
import { messageText as formatMessage, pkResultText as formatPk } from '../../../i18n/messages'
import { tr } from './i18n'

export function messageText(message: MessagePreview): string {
  return formatMessage(message, tr)
}

export function pkResultText(ref: PkRefView): string {
  return formatPk(ref, tr)
}
