import { createRoot } from 'react-dom/client'
import App from './App'
import { useAgentGraph } from './store/useAgentGraph'
import { nodePositions } from './lib/positions'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(<App />)

const hooks = window as unknown as Record<string, unknown>
hooks.__linsSelect = (id: string | null) => useAgentGraph.getState().select(id)
hooks.__linsSpawn = () => useAgentGraph.getState().spawnRandomChild()
hooks.__linsReset = () => useAgentGraph.getState().reset()
hooks.__linsState = () => useAgentGraph.getState()
hooks.__linsLoad = (id: string, pct: number | null) => useAgentGraph.getState().setContextWindowPct(id, pct)
hooks.__linsPos = (id: string) => {
  const position = nodePositions.get(id)
  return position ? [position.x, position.y, position.z] : null
}
