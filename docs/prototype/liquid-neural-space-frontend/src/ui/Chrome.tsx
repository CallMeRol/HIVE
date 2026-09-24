import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentGraph } from '../store/useAgentGraph'
import { fmtTime } from '../lib/util'
import { interfaceAudio } from '../lib/audio'

function useFps() {
  const [fps, setFps] = useState(60)
  useEffect(() => {
    let frames = 0
    let last = performance.now()
    let raf = 0
    const loop = () => {
      frames++
      const now = performance.now()
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return fps
}

export function TopBar() {
  const agents = useAgentGraph((s) => Object.keys(s.agents).length)
  const edges = useAgentGraph((s) => Object.keys(s.edges).length)
  const simRunning = useAgentGraph((s) => s.simRunning)
  const setSim = useAgentGraph((s) => s.setSim)
  const requestTarget = useAgentGraph((s) => s.requestTarget)
  const stressBurst = useAgentGraph((s) => s.stressBurst)
  const reset = useAgentGraph((s) => s.reset)
  const fps = useFps()
  const [soundEnabled, setSoundEnabled] = useState(interfaceAudio.isEnabled())

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden />
        <span className="brand-name">LIQUID NEURAL SPACE</span>
        <span className="brand-tag">v0.3 · semantic work space</span>
      </div>

      <div className="topbar-stats">
        <div className="stat">
          <span className="stat-value">{agents}</span>
          <span className="stat-label">agents</span>
        </div>
        <div className="stat">
          <span className="stat-value">{edges}</span>
          <span className="stat-label">synapses</span>
        </div>
        <div className="stat">
          <span className={`stat-value ${fps < 45 ? 'warn' : ''}`}>{fps}</span>
          <span className="stat-label">fps</span>
        </div>
      </div>

      <div className="topbar-actions">
        <button
          className={`btn ${soundEnabled ? 'btn-live' : ''}`}
          title="Toggle interface sounds"
          onClick={() => {
            const next = !soundEnabled
            interfaceAudio.unlock()
            interfaceAudio.setEnabled(next)
            setSoundEnabled(next)
          }}
        >
          <span className={`dot ${soundEnabled ? 'dot-live' : ''}`} />
          {soundEnabled ? 'SOUND ON' : 'SOUND OFF'}
        </button>
        <button
          className={`btn ${simRunning ? 'btn-live' : ''}`}
          onClick={() => setSim(!simRunning)}
        >
          <span className={`dot ${simRunning ? 'dot-live' : ''}`} />
          {simRunning ? 'LIVE SIM' : 'PAUSED'}
        </button>
        <button
          className="btn"
          title="Grow the tissue to 50 agents"
          onClick={() => {
            requestTarget(50)
            stressBurst(50)
          }}
        >
          STRESS ×50
        </button>
        <button className="btn" onClick={() => reset()}>
          RESET
        </button>
      </div>
    </header>
  )
}

/** Small, non-blocking focus context. The canvas remains the primary surface. */
export function FocusHud() {
  const { selectedId, role, neighbourCount, lineageOn } = useAgentGraph(
    useShallow((s) => {
      const agent = s.selectedId ? s.agents[s.selectedId] : undefined
      return {
        selectedId: s.selectedId,
        role: agent?.role ?? '',
        neighbourCount: Math.max(0, (s.focusNeighbors?.size ?? 1) - 1),
        lineageOn: !!s.lineageFilter,
      }
    }),
  )
  const select = useAgentGraph((s) => s.select)

  if (!selectedId) return null

  return (
    <div className="focus-hud" role="status" aria-live="polite">
      <div className="focus-hud-copy">
        <span className="focus-kicker">FOCUS</span>
        <span className="focus-agent mono">{selectedId}</span>
        <span className="focus-role">{role}</span>
        <span className="focus-meta">
          {lineageOn ? 'lineage filter' : `${neighbourCount} adjacent`}
        </span>
      </div>
      <button className="btn focus-clear" onClick={() => select(null)}>
        ESC · CLEAR
      </button>
    </div>
  )
}

export function EventTimeline() {
  const events = useAgentGraph((s) => s.events)

  return (
    <footer className="timeline">
      <div className="timeline-head">
        <span>ACTIVITY</span>
        <span className="timeline-hint">spawn · return · merge · fault</span>
      </div>
      <div className="timeline-scroll">
        {events.length === 0 && <div className="timeline-empty">awaiting first division…</div>}
        {events.map((ev) => (
          <div key={ev.id} className={`event ev-${ev.kind}`}>
            <span className="event-time">{fmtTime(ev.at)}</span>
            <span className="event-kind">{ev.kind.toUpperCase()}</span>
            <span className="event-text">{ev.text}</span>
          </div>
        ))}
      </div>
    </footer>
  )
}

export function NavRail() {
  return (
    <nav className="navrail">
      <button className="navitem active" title="Liquid Space">
        <span className="navglyph nav-space" />
        <span className="navname">SPACE</span>
      </button>
      <button className="navitem" title="Missions" disabled>
        <span className="navglyph nav-missions" />
        <span className="navname">TASKS</span>
      </button>
      <button className="navitem" title="Memory" disabled>
        <span className="navglyph nav-memory" />
        <span className="navname">MEMORY</span>
      </button>
      <div className="navspacer" />
      <button className="navitem" title="Settings" disabled>
        <span className="navglyph nav-settings" />
        <span className="navname">SYS</span>
      </button>
    </nav>
  )
}
