/**
 * Small local interface sound layer. Audio is deliberately opt-in after the
 * first user gesture because browsers block autoplay with sound by default.
 * The source files are local copies used under the source site's free-use
 * terms; attribution is recorded in README.md.
 */
class InterfaceAudio {
  private heartbeat: HTMLAudioElement | null = null
  private select: HTMLAudioElement | null = null
  private unlocked = false
  private enabled = true

  constructor() {
    if (typeof Audio === 'undefined') return
    this.heartbeat = new Audio('/audio/heartbeat-pulse.mp3')
    this.heartbeat.preload = 'auto'
    this.heartbeat.volume = 0.84
    this.select = new Audio('/audio/agent-select.mp3')
    this.select.preload = 'auto'
    this.select.volume = 0.16
  }

  isEnabled() {
    return this.enabled
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    if (!enabled) {
      this.heartbeat?.pause()
      this.select?.pause()
    }
  }

  unlock() {
    this.unlocked = true
  }

  playHeartbeat() {
    this.play(this.heartbeat)
  }

  playSelect() {
    this.play(this.select)
  }

  private play(audio: HTMLAudioElement | null) {
    if (!audio || !this.enabled || !this.unlocked) return
    audio.currentTime = 0
    void audio.play().catch(() => undefined)
  }
}

export const interfaceAudio = new InterfaceAudio()
