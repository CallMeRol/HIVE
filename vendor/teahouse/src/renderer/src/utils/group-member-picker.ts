import type { PeerView } from '../../../shared/ipc'

export interface GroupMemberCandidate {
  peer: PeerView
  organization: string
}

export function filterGroupMemberCandidates(
  peers: PeerView[],
  excludedIds: ReadonlySet<string>,
  query: string
): GroupMemberCandidate[] {
  const keyword = query.trim().toLowerCase()
  return peers
    .filter((peer) => !excludedIds.has(peer.nodeId))
    .filter((peer) => !keyword || memberSearchText(peer).includes(keyword))
    .map((peer) => ({
      peer,
      organization: [peer.company, peer.dept, peer.team].filter(Boolean).join(' · ')
    }))
}

export function toggleGroupMemberSelection(
  selectedIds: string[],
  nodeId: string,
  maxPick: number
): string[] {
  if (selectedIds.includes(nodeId)) return selectedIds.filter((id) => id !== nodeId)
  if (selectedIds.length >= maxPick) return [...selectedIds]
  return [...selectedIds, nodeId]
}

export function normalizeGroupMemberSelection(
  selectedIds: string[],
  excludedIds: ReadonlySet<string>,
  maxPick: number
): string[] {
  return [...new Set(selectedIds)]
    .filter((id) => !excludedIds.has(id))
    .slice(0, Math.max(0, maxPick))
}

function memberSearchText(peer: PeerView): string {
  return [
    peer.remark,
    peer.nick,
    peer.company,
    peer.dept,
    peer.team,
    peer.ip,
    peer.host
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}
