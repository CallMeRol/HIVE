// 节点数据目录预置（rig 与 launcher 共用，#44 #45 #48）。
//
// 唯一致命点：**必须写完整字段集**。只写一两个字段的残缺 config.json 会让 packaged
// 节点静默发现不到任何对端（net.ok=true、peers=0、零报错）——已实测复现，#44 记在
// docs/local-api.md「已确认的两个 landmine」第 1 条。故这里把 ConfigFile 的全字段
// 列成一处常量，任何消费方都不许自己拼半份。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 与 upstream `src/main/store/app-state.ts` 的 ConfigFile 逐字段对齐。 */
export function defaultConfig({
  nick,
  udp = 17878,
  tcp = 17879,
  autoLaunch = false,
  closeToTray = false,
  manualPeers = []
}) {
  return {
    nick,
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    avatarHash: '',
    profileRev: 1,
    setupDone: false,
    fileDir: '',
    notifications: true,
    manualPeers,
    scanRanges: [],
    scanRangeSources: {},
    ignoredScanRanges: {},
    udpPort: udp,
    tcpPort: tcp,
    hideOnCapture: true,
    autoLaunch,
    closeToTray,
    language: 'zh-CN',
    theme: 'light',
    fontScale: 100,
    showMessagePreview: true,
    allowDirectFileSend: true,
    fileCabinet: { root: '', mode: 'off' },
    sound: 'none',
    sendKey: 'enter',
    captureShortcut: 'CommandOrControl+Alt+A',
    showHideShortcut: 'CommandOrControl+Alt+P'
  }
}

export function configPathFor(dataDir) {
  return join(dataDir, 'config.json')
}

/**
 * 写 config.json。打包版会真的跑开机自启设置（applyAutoLaunch 只在 packaged 生效），
 * 默认预置一条「关掉」的 config，避免验收/演示过程改到这台机器的登录项。
 */
export function writeNodeConfig({ dataDir, nick, udp, tcp, autoLaunch = false, closeToTray = false }) {
  mkdirSync(dataDir, { recursive: true })
  const config = defaultConfig({ nick, udp, tcp, autoLaunch, closeToTray })
  const path = configPathFor(dataDir)
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return path
}
