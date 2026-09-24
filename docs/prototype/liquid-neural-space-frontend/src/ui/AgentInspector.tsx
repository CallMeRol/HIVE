import type { Semantic } from '../types'
import { useAgentGraph } from '../store/useAgentGraph'
import type { Agent } from '../store/useAgentGraph'
import { interfaceAudio } from '../lib/audio'
import { loadTier, LOAD_VISUALS } from '../lib/loadState'

/** One semantic axis — a restrained slider-like readout, no 3D axes anywhere. */
function SemanticAxis({
  axis,
  low,
  high,
  value,
}: {
  axis: string
  low: string
  high: string
  value: number
}) {
  const t = (value + 1) / 2
  return (
    <div className="semax">
      <div className="semax-labels">
        <span className="semax-axis">{axis}</span>
        <span>{low}</span>
        <span>{high}</span>
        <span className="semax-value mono">{value >= 0 ? '+' : ''}{value.toFixed(2)}</span>
      </div>
      <div className="semax-track">
        <div className="semax-line" />
        <div className="semax-marker" style={{ left: `${t * 100}%` }} />
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="insp-row">
      <span className="insp-label">{label}</span>
      <span className="insp-value">{children}</span>
    </div>
  )
}

/** Deterministic fake context stats per agent (cosmetic, stable per id). */
function contextStats(id: string) {
  let h = 7
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return { files: 1 + (h % 14), sources: (h >> 3) % 32 }
}

export function AgentInspector() {
  const selectedId = useAgentGraph((s) => s.selectedId)
  const agent = useAgentGraph((s) => (s.selectedId ? s.agents[s.selectedId] : undefined))
  const agents = useAgentGraph((s) => s.agents)
  const edges = useAgentGraph((s) => s.edges)
  const lineageOn = useAgentGraph((s) => !!s.lineageFilter)
  const toggleLineage = useAgentGraph((s) => s.toggleLineage)
  const clearLineage = useAgentGraph((s) => s.clearLineage)
  const select = useAgentGraph((s) => s.select)
  const setContextWindowPct = useAgentGraph((s) => s.setContextWindowPct)

  if (!selectedId || !agent) {
    return (
      <aside className="inspector inspector-empty">
        <div className="inspector-placeholder">
          <div className="inspector-glyph" />
          <p>SELECT AN AGENT</p>
          <p className="dim">
            Click a liquid body to inspect its semantic position, weight and
            context. First-degree synapses will light up.
          </p>
        </div>
      </aside>
    )
  }

  const connections = Object.values(edges).filter(
    (e) => e.source === agent.id || e.target === agent.id,
  ).length
  const ctx = contextStats(agent.id)
  const tier = loadTier(agent.status, agent.contextWindowPct)
  const loadVisual = LOAD_VISUALS[tier]
  const semantic: Semantic = agent.semantic
  const neighbourIds = Array.from(
    new Set(
      Object.values(edges)
        .filter((e) => e.source === agent.id || e.target === agent.id)
        .map((e) => (e.source === agent.id ? e.target : e.source)),
    ),
  )
  const neighbours = neighbourIds
    .map((id) => agents[id])
    .filter((a): a is Agent => Boolean(a))

  return (
    <aside className="inspector">
      <div className="insp-head">
        <div className="insp-id">{agent.id}</div>
        <div className="insp-role">{agent.role}</div>
        <div className={`insp-status st-${agent.status}`}>
          <span className="dot dot-live" />
          {agent.status.toUpperCase()}
        </div>
      </div>

      <section className="insp-section">
        <h4>SEMANTIC POSITION</h4>
        <SemanticAxis axis="X" low="Perception" high="Action" value={semantic.x} />
        <SemanticAxis axis="Y" low="Concrete" high="Abstract" value={semantic.y} />
        <SemanticAxis axis="Z" low="Local" high="Global" value={semantic.z} />
      </section>

      <section className="insp-section">
        <h4>CONTEXT WINDOW LOAD</h4>
        <div className="load-readout">
          <span className="load-light" style={{ backgroundColor: loadVisual.hex, boxShadow: `0 0 12px ${loadVisual.hex}` }} />
          <strong style={{ color: loadVisual.hex }}>{loadVisual.label}</strong>
          <span className="mono">{agent.contextWindowPct == null ? '—' : `${agent.contextWindowPct.toFixed(0)}%`}</span>
        </div>
        <input
          className="load-slider"
          type="range"
          min="0"
          max="60"
          value={agent.contextWindowPct ?? 0}
          aria-label={`${agent.id} context window occupancy`}
          onChange={(event) => setContextWindowPct(agent.id, Number(event.target.value))}
        />
        <p className="load-hint">演示负担数据 · 调整后神经元的状态光同步变化</p>
      </section>

      <section className="insp-section">
        <h4>PROPERTIES</h4>
        <Row label="Weight">
          <span className="mono">{agent.weight.toFixed(2)}</span>
        </Row>
        <Row label="Traffic">
          <span className="mono">{agent.traffic.toFixed(1)} tok/s</span>
        </Row>
        <Row label="Parent">
          {agent.parentId ?? <span className="dim">— none —</span>}
        </Row>
        <Row label="Children">{agent.childIds.length}</Row>
        <Row label="Connections">{connections}</Row>
        <Row label="Ephemeral">{agent.ephemeral ? 'yes' : 'no'}</Row>
      </section>

      <section className="insp-section">
        <h4>CURRENT TASK</h4>
        <p className="insp-task">{agent.task ?? 'awaiting assignment'}</p>
      </section>

      <section className="insp-section">
        <h4>ADJACENT AGENTS</h4>
        <div className="neighbour-list">
          {neighbours.length === 0 && <span className="dim">no active neighbours</span>}
          {neighbours.slice(0, 6).map((neighbour) => (
            <button
              className="neighbour-row"
              key={neighbour.id}
              onClick={() => {
                interfaceAudio.unlock()
                interfaceAudio.playSelect()
                select(neighbour.id)
              }}
              title={`Focus ${neighbour.id}`}
            >
              <span className="neighbour-id mono">{neighbour.id}</span>
              <span className="neighbour-role">{neighbour.role}</span>
              <span className={`neighbour-status st-${neighbour.status}`} />
            </button>
          ))}
        </div>
      </section>

      <section className="insp-section">
        <h4>CONTEXT</h4>
        <Row label="Files">
          <span className="mono">{ctx.files} bound</span>
        </Row>
        <Row label="Sources">
          <span className="mono">{ctx.sources} indexed</span>
        </Row>
      </section>

      <div className="insp-actions">
        <button
          className={`btn ${lineageOn ? 'btn-live' : ''}`}
          onClick={() => toggleLineage(agent.id)}
        >
          {lineageOn ? 'LINEAGE: ON' : 'SHOW LINEAGE'}
        </button>
        {lineageOn && (
          <button className="btn" onClick={() => clearLineage()}>
            CLEAR FILTER
          </button>
        )}
      </div>
    </aside>
  )
}
