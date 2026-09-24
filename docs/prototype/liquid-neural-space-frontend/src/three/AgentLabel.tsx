import { Html } from '@react-three/drei'
import { useAgentGraph } from '../store/useAgentGraph'

/**
 * Labels are rationed hard. Only:
 *   hovered · selected
 * Everything else stays anonymous — with a few dozen agents on screen, always-on
 * names turn the tissue into a wall of text.
 */
export function AgentLabel({ id }: { id: string }) {
  const agent = useAgentGraph((s) => s.agents[id])
  const hovered = useAgentGraph((s) => s.hoveredId === id)
  const selected = useAgentGraph((s) => s.selectedId === id)

  if (!agent) return null
  if (!hovered && !selected) return null

  return (
    <Html
      position={[0, 0.95, 0]}
      center
      style={{ pointerEvents: 'none', userSelect: 'none' }}
      zIndexRange={[30, 0]}
    >
      <div
        className={[
          'agent-label',
          `st-${agent.status}`,
          selected ? 'is-selected' : '',
          hovered ? 'is-hovered' : '',
        ].join(' ')}
      >
        <span className="agent-label-id">{agent.id}</span>
        <span className="agent-label-role">{agent.role}</span>
      </div>
    </Html>
  )
}
