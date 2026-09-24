import { useEffect } from 'react'
import { NeuralCanvas } from './three/NeuralCanvas'
import { AgentInspector } from './ui/AgentInspector'
import { EventTimeline, FocusHud, NavRail, TopBar } from './ui/Chrome'
import { useAgentGraph } from './store/useAgentGraph'
import { interfaceAudio } from './lib/audio'
import { LOAD_VISUALS } from './lib/loadState'

/**
 * Liquid Neural Space — a 3D work space for a multi-agent system.
 *
 * Layout contract:
 *   top bar · left nav · (≥70%) central 3D canvas · right inspector
 *   bottom activity timeline.
 */
export default function App() {
  useEffect(() => {
    const g = useAgentGraph.getState()
    g.bootstrap()
    g.repairTopology()

    let alive = true
    const simLoop = () => {
      if (!alive) return
      const s = useAgentGraph.getState()
      if (s.simRunning) s.simTick()
      window.setTimeout(simLoop, 1400 + Math.random() * 1900)
    }
    const simTimer = window.setTimeout(simLoop, 1800)

    const trafficTimer = window.setInterval(() => {
      useAgentGraph.getState().trafficTick()
    }, 700)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') useAgentGraph.getState().select(null)
    }
    const unlockAudio = () => interfaceAudio.unlock()
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', unlockAudio, { once: true })

    return () => {
      alive = false
      window.clearTimeout(simTimer)
      window.clearInterval(trafficTimer)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', unlockAudio)
    }
  }, [])

  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <NavRail />
        <div className="stage">
          <NeuralCanvas />
          <FocusHud />
          <div className="stage-hud">
            <span className="hud-chip">SEMANTIC WORK SPACE</span>
            <span className="hud-dim">X perception↔action · Y concrete↔abstract · Z local↔global</span>
            <div className="load-legend" aria-label="Agent load colors">
              {(['idle', 'ease', 'busy', 'overload', 'critical'] as const).map((tier) => (
                <span key={tier}><i style={{ backgroundColor: LOAD_VISUALS[tier].hex, boxShadow: `0 0 7px ${LOAD_VISUALS[tier].hex}` }} />{LOAD_VISUALS[tier].label}</span>
              ))}
            </div>
          </div>
        </div>
        <AgentInspector />
      </div>
      <EventTimeline />
    </div>
  )
}
