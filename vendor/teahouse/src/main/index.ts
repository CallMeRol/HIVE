import { RangeScanScheduler } from './services/range-scan'
import { DiagnosticsService, diagnosticEnvironment } from './services/diagnostics'
import { setupDiagnosticsUi } from './services/diagnostics-ui'
import { isLanguage, setLanguage, tr } from '../i18n'
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  Notification,
  protocol,
  screen,
  shell,
  systemPreferences,
  type Tray
} from 'electron'
import { networkInterfaces } from 'node:os'
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { request } from 'node:http'
import { createSocket as createUdpSocket } from 'node:dgram'
import { basename, extname, join, resolve } from 'node:path'
import {
  DEFAULT_CAPTURE_SHORTCUT,
  DEFAULT_SHOWHIDE_SHORTCUT,
  IpcChannels,
  IpcEvents,
  type AvatarSourcePick,
  type AppInfo,
  type AppSettingsPatch,
  type ConversationSearchOptions,
  type CaptureFailureReason,
  type DataExportOptions,
  type DataImportResult,
  type ExportFormat,
  type ForwardTarget,
  type GroupPatch,
  type GroupView,
  type HivePendingState,
  type HivePendingResult,
  type HiveNetworkSnapshot,
  type PeerHiveView,
  type ImageOcrResult,
  type ImageOcrSource,
  type ImageSourceBytes,
  type MessageView,
  type NetState,
  type NudgeEvent,
  type NudgeResult,
  type PeerView,
  type ProfileSubmit,
  type ScanProgressView,
  type SettingsView,
  type ShareBrowseFailReason,
  type ShareBrowseResult,
  type ShareDownloadResult,
  type ShareGrantView,
  type ShareRecentUploadView,
  type ShareRootPickResult,
  type ShareUploadResult,
  type TableTextMeta,
  type TransferView,
  type UpdateAvailability
} from '../shared/ipc'
import {
  DEFAULT_TCP_PORT,
  DEFAULT_UDP_PORT,
  CAPS,
  DISCOVERY_PROBE_CAP,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  AVATAR_SOURCE_MAX_BYTES,
  GROUP_MAX_MEMBERS,
  LIMITS,
  MSG_TYPES,
  TABLE_TEXT_LIMIT_BYTES,
  SHARE_GET_AUTH_TTL,
  SHARE_GET_MAX_PATHS,
  SHARE_PATH_MAX,
  SHARE_PUT_MAX_BYTES,
  SHARE_REQ_TIMEOUT,
  isAvatarPresetValue,
  isShareMode,
  type Envelope,
  type SharePayload,
  type Platform,
  type RuntimeArch,
  type ScanRangeSummary,
  type UpdateReqPayload
} from '../shared/protocol'
import { isAvatarHash } from '../shared/protocol'
import { avatarHashFromUrl } from '../shared/avatar-url'
import { inspectImageMetadata } from '../shared/image-metadata'
import { DEFAULT_IMAGE_EXTENSION, IMAGE_FILE_EXTENSIONS } from '../shared/media'
import {
  addSharedScanRanges,
  loadAppState,
  saveAppSettings,
  saveProfile,
  saveProfileCaps,
  type AppState
} from './store/app-state'
import { refreshTrayLanguage, setupTray, stopTrayUnreadFlash, updateTrayUnread } from './windows/tray'
import { syncSettingsWindowLanguage, openSettingsWindow, syncSettingsWindowZoom } from './windows/settings-window'
import {
  closeCaptureWindow,
  openCaptureWindow,
  showCaptureWindow
} from './windows/capture-window'
import { planCaptureGeometry } from './windows/capture-geometry'
import {
  captureFailureNotice,
  hideWindowForCapture,
  isWaylandSession,
  mergeChromiumFeature
} from './windows/capture-support'
import { openImageViewerWindow } from './windows/image-viewer-window'
import { fitImageViewerContent } from './windows/image-viewer-sizing'
import { showWindowForeground } from './windows/foreground'
import {
  incomingNotificationOptions,
  notificationIconPath
} from './notifications'
import { StickerRepo } from './store/sticker-repo'
import { buildCidrHostPlan, ipInCidr, normalizeCidr, parseCidr } from './net/cidr'
import { TransferRepo } from './store/transfer-repo'
import { GroupRepo } from './store/group-repo'
import { FilesService } from './services/files'
import { GroupsService } from './services/groups'
// Hive（#53）：成员主人登记 + 移出/孤儿清理判权；纯函数 + 本机账本，不进上游 store。
import { MemberRegistry, type MemberRegistryFile } from './hive/member-registry'
import { authorizeMemberRemoval, type MemberRemovalPhase } from './hive/member-removal'
// Hive（#51）：派遣——成员摇入全新上下文成员（身份→invite→spawn→health 校验）。
import { DispatchService } from './hive/dispatch'
import { DispatchStore, reanchor, recomputeDepths, type DispatchRecord } from './hive/dispatch-store'
import { verifyHandover } from './hive/handover'
import { SessionLedger } from './services/session-ledger'
import { AbnormalExitWatcher, abnormalExitText } from './hive/abnormal-exit'
import { PendingService } from './hive/pending-service'
import {
  appendGoalGuardAudit,
  decideAction,
  httpJudge,
  type GoalGuardAuditEntry
} from './hive/goal-guard'
import { collectIntoPending, describeRoute, PENDING_AGGREGATE_PREFIX, routeMessage, type PendingGateDeps } from './hive/pending-gate'
import { ForwardService } from './services/forward'
import { PorterService } from './services/porter'
import { SearchService } from './services/search'
import { openDatabase, openMemoryDatabase, type AppDatabase } from './store/db'
import { PeersRepo } from './store/peers-repo'
import { ShareGrantsRepo } from './store/share-grants-repo'
import {
  evaluateShareRoot,
  ShareDownloadGate,
  shareDownloadDirName,
  ShareService
} from './services/share'
import { ConvRepo } from './store/conv-repo'
import { MsgRepo, msgRowToView } from './store/msg-repo'
import { QueueRepo } from './store/queue-repo'
import { DedupRepo } from './store/dedup-repo'
import { UdpChannel } from './net/udp'
import { PeerRegistry } from './net/peer-registry'
import { Discovery, type ManualPeer } from './net/discovery'
import { RangeSync } from './net/range-sync'
import { Messenger } from './net/messenger'
import { PeerClock } from './net/peer-clock'
import { makeEnvelope } from './net/codec'
import { AGENT_STATUS_CAP, AgentStatusService, burdenReportFromUsage, parseProducerSpec } from './services/agent-status'
import { ChatService } from './services/chat'
import { ImageOcrResultCache } from './services/image-ocr-cache'
import { ImagePreviewService } from './services/image-preview'
import { getImageViewerNavigation } from './services/image-navigation'
import { AvatarStore } from './services/avatar-store'
import { AvatarService } from './services/avatars'
import type { PeerRecord } from './net/peer-registry'
import { filterImagePickerPaths, IMAGE_PICKER_EXTENSIONS } from './util/image-picker'
import { isPathInsideAny, PathGrantStore } from './util/path-policy'
import { resolveDevRendererUrl } from './util/renderer-url'
import { canServeUpdates } from './util/release-format'
import { measureUploadPaths } from './util/upload-measure'
import { isWindows7 } from './util/windows-version'
import { RemoteViewWindows } from './windows/remote-view-window'
import type { ScreenPayload } from '../shared/protocol'
import { applyWindowZoom } from './util/window-zoom'
import {
  findLocalUpdatePackage,
  pickUpdateSource,
  shouldServeUpdateRequest,
  UpdateRequestGate
} from './services/updater'
import { createHiveLocalApi, type HiveLocalApi } from './local-api'
import { hiveMemberRemoveText, type HiveMemberRemoveDeny } from '../shared/hive-member'
import { HANGAR_OPEN_REASON, type HangarOpenResult, type HiveClearResult, type HiveReclaimResult } from '../shared/hive-hangar'
import { HIVE_CLAIM_TEXT, toClaimableView, type HiveClaimableState, type HiveClaimResult } from '../shared/hive-claimable'
import { Hangar, type ArchiveReason } from './hive/hangar'
import { closeHangarWindow, openHangarWindow } from './hive/hangar-window'
import { runRecovery } from './hive/recovery'
// #25：打包态 app.getAppPath() 指到 app.asar（文件），不能当子进程 cwd。
import { appCwdDir } from './hive/packaged-paths'
import { AcpRunner, readAgentEnv, startAcpRunner } from './acp'
import { AgentBridge } from './services/agent-bridge'
// #49：GUI 接入本机 agent（探测 + 起独立成员节点）
import {
  attachMember,
  forgetAttached,
  listAttached,
  resolveNodeExecutable,
  resolveRunnerDir,
  writeFullNodeConfig,
  type AttachDeps,
  type AttachResult
} from './hive/agent-attach'
import {
  findAdapterOnPath,
  findExecutable,
  probeRuntime,
  resolveAgentCommand,
  type ProbeDeps,
  type RuntimeKind,
  type RuntimeProbe
} from './hive/agent-probe'

// Win7（NT 6.1）终端为统一 VM 部署，虚拟显卡驱动不可靠；UOS/Debian 目标机多国产 GPU 或旧驱动，
// GPU 进程频报 ContextResult::kTransientFailure —— 两者默认软渲染（tech-design §9，决议 #55/#231）
const WINDOWS7 = isWindows7()
const SOFTWARE_RENDERING = WINDOWS7 || process.platform === 'linux'
if (SOFTWARE_RENDERING) {
  app.disableHardwareAcceleration()
}

// Electron 22 在 Wayland 上需要显式启用 PipeWire capturer 才能通过系统 portal 选屏。
// 这里只补能力，startCapture 仍会实际探测；Wayland 不再等同于“不可截图”。
const WAYLAND_SESSION = isWaylandSession()
if (WAYLAND_SESSION) {
  const features = mergeChromiumFeature(
    app.commandLine.getSwitchValue('enable-features'),
    'WebRTCPipeWireCapturer'
  )
  app.commandLine.appendSwitch('enable-features', features)
}

// 受管头像使用固定 authority + 哈希路径；提前登记为标准安全 scheme，确保 Chrome 108
// 在 Windows / Linux / macOS 上按同一规则解析后再交给受限文件协议处理器。
protocol.registerSchemesAsPrivileged([
  { scheme: 'pantry-avatar', privileges: { standard: true, secure: true } }
])

// 纯内网 IP 工具：全局禁用代理、强制直连（决议 #78）。不走系统/环境代理，
// 也不开放任何代理配置——代理对内网通信无意义，只会增加连接失败与信息泄漏面。
app.commandLine.appendSwitch('no-proxy-server')

// 运行时应用名固定为「Hive」（决议 #60 的 ASCII 约束在 Hive 品牌下天然满足）：
// productName 与运行时名一致，安装路径（/opt/Hive）与 userData 目录（Hive）都用
// 同一品牌名，系统通知标题也随之。setName 必须在任何 getPath('userData') 之前。
// 注意：userData 目录名随本行变化，升级会换目录（旧数据仍在原「茶话间」目录下）。
app.setName('Hive')
// Windows 通知/任务栏归属名（决议 #66）：不设则 Win10/11 的 toast 顶部显示默认
// "electron.app.Hive"；设为 appId，与 NSIS 安装的快捷方式 AUMID 一致，显示为「Hive」。
if (process.platform === 'win32') app.setAppUserModelId('com.pantry.app')

// headless：无主窗的本机 agent 节点（决定 ready 期不建窗、window-all-closed 不退出）。
// 真 headless 而非 show:false 降级的依据见 ADR-0002 Decision 2。
const HEADLESS = process.env['PANTRY_HEADLESS'] === '1'

// ---------- #49 接入用的小工具 ----------

/** TCP 端口是否被占（bind 失败即被占）。同步语义：接入是低频动作，不值得为它引入异步状态机。 */
function tcpPortTaken(port: number): boolean {
  const server = createNetServer()
  try {
    server.listen(port, '127.0.0.1')
    server.close()
    return false
  } catch {
    return true
  }
}

/** UDP 端口是否被占（同 tcpPortTaken 的口径）。 */
function udpPortTaken(port: number): boolean {
  const socket = createUdpSocket('udp4')
  try {
    socket.bind(port, '127.0.0.1')
    socket.close()
    return false
  } catch {
    return true
  }
}

/**
 * 探测一个刚起来的成员节点是否就绪：health 可用且报出 nodeId。
 * 只回 nodeId —— 身份校验（是不是我起的那个）由调用方拿预生成值比对。
 *
 * 用 `node:http` 而不是 `fetch`：Electron 22 主进程内嵌 Node 16.17，没有全局 fetch
 * （仓库根的 launcher/rig 跑 Node 22 才可以用 fetch，两处运行环境不同）。
 */
function fetchLocalHealth(apiPort: number): Promise<{ nodeId: string } | null> {
  return new Promise((resolvePromise) => {
    const req = request(
      { host: '127.0.0.1', port: apiPort, path: '/v1/health', method: 'GET', timeout: 2000 },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolvePromise(null)
          return
        }
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          raw += chunk
        })
        res.on('end', () => {
          try {
            const body = JSON.parse(raw) as { nodeId?: unknown }
            resolvePromise(
              typeof body.nodeId === 'string' && body.nodeId.length > 0 ? { nodeId: body.nodeId } : null
            )
          } catch {
            resolvePromise(null)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolvePromise(null))
    req.end()
  })
}

// 本机双实例联调：PANTRY_USER_DATA 隔离数据目录（同时绕开单实例锁），见 README「开发」
if (process.env['PANTRY_USER_DATA']) {
  app.setPath('userData', resolve(process.env['PANTRY_USER_DATA']))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  const diagnostics = new DiagnosticsService(join(app.getPath('userData'), 'logs'))
  void diagnostics.ready.then(() => diagnostics.record('app.start', { version: app.getVersion() }))
  process.on('uncaughtExceptionMonitor', error => diagnostics.fatal(error))
  app.on('web-contents-created', (_event, contents) => {
    // Electron 22 隔离世界收不到页面的 error/rejection；从 Chromium 异常通知只提取类型和行号。
    contents.on('console-message', (_event, level, message, line) => {
      if (level < 2) return
      const match = /^Uncaught (?:\(in promise\) )?(Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError)\b/.exec(message.slice(0, 100))
      if (match) diagnostics.record('renderer.error', { kind: 'error', windowId: contents.id, line }, { name: match[1] })
    })
    contents.on('render-process-gone', (_event, details) => diagnostics.record('process.exit', {
      process: 'renderer', reason: details.reason, exitCode: details.exitCode, windowId: contents.id
    }))
    contents.on('preload-error', (_event, _path, error) => diagnostics.record('renderer.error', { stage: 'prepare', windowId: contents.id }, error))
    contents.on('unresponsive', () => diagnostics.record('window.health', { status: 'unresponsive', windowId: contents.id }))
    contents.on('responsive', () => diagnostics.record('window.health', { status: 'responsive', windowId: contents.id }))
    contents.on('did-fail-load', (_event, code) => diagnostics.record('window.health', { stage: 'load', status: 'failed', exitCode: code, windowId: contents.id }))
  })
  app.on('child-process-gone', (_event, details) => diagnostics.record('process.exit', {
    process: details.type.toLowerCase(), reason: details.reason, exitCode: details.exitCode
  }))
  let databaseMode = 'unavailable'
  let tcpStatus = 'starting'
  let captureStatus = 'unknown'
  let mainWindow: BrowserWindow | null = null

  // ---- 网络栈（环境变量仅供本机联调覆盖；正式端口从设置读取，重启生效） ----
  const envUdpPort = parsePort(process.env['PANTRY_UDP_PORT'])
  const envTcpPort = parsePort(process.env['PANTRY_TCP_PORT'])
  let envApiPort = parsePort(process.env['PANTRY_LOCAL_API_PORT'], 0)
  let localApi: HiveLocalApi | null = null
  /** ACP runner + 群消息胶水（ADR-0004）：未配置 `PANTRY_AGENT_COMMAND` 时恒为 null。 */
  let agentRunner: AcpRunner | null = null
  let agentBridge: AgentBridge | null = null
  /** startNet 是异步的：local-api 先起、groups 后到，这里存住“到了再接线”的那一步。 */
  let onGroupsReady: ((service: GroupsService) => void) | null = null
  /** #53 成员主人登记表（本机账本）；userData 就绪后初始化。 */
  let memberRegistry: MemberRegistry | null = null
  /** #52 机库读取面 + 归档索引（artifacts root 下，本机账本）。 */
  let hangar: Hangar | null = null
  /** #51 派遣服务：账本随 userData 就绪，编排随 groups 就绪。 */
  let dispatchStore: DispatchStore | null = null
  let dispatchService: DispatchService | null = null
  /** #59 异常退群探测器：派遣子进程猝死 → 5s 内异常退群 + 任务转待领取。 */
  let abnormalExitWatcher: AbnormalExitWatcher | null = null
  /** #55 目标守卫：`HIVE_GOAL_GUARD_URL` 配置时启用；判定器不可用 fail-open。 */
  let goalGuardJudge: ReturnType<typeof httpJudge> | null = null
  let goalGuardAuditPath: string | null = null
  /** #50 pending 收集期 + 确认键 + 会话目标（Hive 侧独立账本）；`PANTRY_PENDING=1` 时启用。 */
  let pendingService: PendingService | null = null
  let udpPort = envUdpPort ?? DEFAULT_UDP_PORT
  let tcpPort = envTcpPort ?? DEFAULT_TCP_PORT
  const manualPeers: ManualPeer[] = (process.env['PANTRY_PEERS'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => {
      const [host, port] = item.split(':')
      return { host, port: Number(port) || DEFAULT_UDP_PORT }
    })

  const netState: NetState = { ok: false, udpPort, error: '' }
  const IMAGE_SOURCE_MAX_BYTES = 25 * 1024 * 1024
  const GLOBAL_SCAN_PROGRESS_PUSH_INTERVAL = 200
  const IMAGE_EXTS = new Set<string>(IMAGE_FILE_EXTENSIONS)
  const AVATAR_PICKER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp']
  const IMAGE_SEND_MAX_BYTES = 20 * 1024 * 1024
  const imageOcrCache = new ImageOcrResultCache()
  const rendererPathGrants = new PathGrantStore()
  const stickerImportPathGrants = new PathGrantStore()
  const updateRequestGate = new UpdateRequestGate()
  const shareDownloadGate = new ShareDownloadGate()
  /** 本机发出的 list / get 在等应答（决议 #275）：reqId → 决议函数，超时由发起方自行清理 */
  const sharePending = new Map<string, (payload: SharePayload | null) => void>()
  /** peerId → 正在等待的 get reqId，便于 offer 到货时提前收口 */
  const shareGetReq = new Map<string, string>()
  let discovery: Discovery | null = null
  let registry: PeerRegistry | null = null
  let messenger: Messenger | null = null
  const remarks = new Map<string, string>()
  let db: AppDatabase | null = null
  let peersRepo: PeersRepo | null = null
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let chat: ChatService | null = null
  let files: FilesService | null = null
  let groups: GroupsService | null = null
  let groupRepo: GroupRepo | null = null
  let avatars: AvatarService | null = null
  let forward: ForwardService | null = null
  let porter: PorterService | null = null
  let search: SearchService | null = null
  let msgRepoRef: MsgRepo | null = null
  let stickerRepo: StickerRepo | null = null
  let shareGrantsRepo: ShareGrantsRepo | null = null
  let share: ShareService | null = null
  let capturing = false
  let pruneTimer: ReturnType<typeof setInterval> | null = null
  let avatarPruneTimer: ReturnType<typeof setTimeout> | null = null
  let appState: AppState | null = null
  let rangeSync: RangeSync | null = null
  /** 跨机 agent 状态通道（#47 / ADR-0009）：发/收/自校验/TTL，内存态。 */
  let agentStatus: AgentStatusService | null = null
  const remoteView = new RemoteViewWindows(() => mainWindow, () => {
    if (!appState || !remoteView.service) return
    const caps = [...appState.profile.caps.filter(cap => cap !== CAPS.remoteView && cap !== CAPS.remoteShare), ...remoteView.capabilities()]
    if (!saveProfileCaps(appState, caps)) return
    discovery?.announceProfile()
  }, async () => {
    diagnostics.record('capture.state', { kind: 'screen', status: 'starting' })
    await diagnostics.flush()
  })
  let tray: Tray | null = null
  let isQuitting = false
  let nudgeShakeOrigin: [number, number] | null = null
  let nudgeShakeTimers: Array<ReturnType<typeof setTimeout>> = []
  let rangeScanner: RangeScanScheduler | null = null
  let globalScanSeq = 0
  let lastGlobalScanProgressPushAt = 0
  let globalScanProgress: ScanProgressView = {
    scanId: 0,
    status: 'idle',
    running: false,
    done: 0,
    total: 0,
    rangeCount: 0,
    startedAt: 0,
    finishedAt: 0
  }

  function parsePort(value: string | undefined, min = 1): number | null {
    if (!value) return null
    const n = Number(value)
    return Number.isInteger(n) && n >= min && n <= 65535 ? n : null
  }

  /**
   * #53 成员登记表初始化。**登记 = 成员主人是谁**，生产侧写入属 #49（人接入本机 agent）与
   * #51（成员派遣），本票只做读 + 授权 + 移出；它们落地前由 `PANTRY_MEMBER_REGISTRY` 播种
   * （路径或内联 JSON，与 `PANTRY_PEERS` 同属本机联调面）。
   *
   * 刻意**不**按「谁 invite 谁拥有」猜主人：底座看不到「agent 节点」与「人类节点」的区别，
   * 猜错会把别人的成员记成自己的，与「每个成员恰有一个主人」冲突。
   */
  function initMemberRegistry(dataDir: string): void {
    const raw = (process.env['PANTRY_MEMBER_REGISTRY'] ?? '').trim()
    let seedPath = join(dataDir, 'hive', 'members.json')
    let seed: unknown = null
    if (raw) {
      if (raw.startsWith('{')) {
        try {
          seed = JSON.parse(raw)
        } catch {
          console.error('[hive] PANTRY_MEMBER_REGISTRY 不是合法 JSON，按空表处理')
        }
      } else {
        seedPath = resolve(raw)
        try {
          seed = JSON.parse(readFileSync(seedPath, 'utf8'))
        } catch (err) {
          console.error('[hive] PANTRY_MEMBER_REGISTRY 读取失败：', err)
        }
      }
    }
    memberRegistry = new MemberRegistry({
      path: seedPath,
      auditPath: join(dataDir, 'hive', 'member-audit.jsonl')
    })
    if (seed) {
      const file = seed as MemberRegistryFile
      for (const record of Array.isArray(file.members) ? file.members : []) {
        memberRegistry.register({
          memberId: record.memberId,
          ownerId: record.ownerId,
          kind: record.kind,
          ...(record.groupId ? { groupId: record.groupId } : {}),
          ...(record.spawnedBy ? { spawnedBy: record.spawnedBy } : {})
        })
      }
    }
    const seeded = memberRegistry.list().length
    if (seeded > 0) console.log(`[hive] 成员登记表 ${seedPath}：${seeded} 条`)
  }

  /**
   * #51 派遣账本初始化（userData 就绪后调用）。持久化面：
   * `<userData>/hive/dispatch.json`（schemaVersion）——派遣关系、slot、待领取状态（AC6）。
   * 环境变量可调旋钮：`HIVE_MAX_DISPATCH_DEPTH`（默认 3）、`HIVE_DISPATCH_CONCURRENCY`（默认 5）。
   */
  function initDispatchStore(dataDir: string): void {
    dispatchStore = new DispatchStore({
      path: join(dataDir, 'hive', 'dispatch.json'),
      ...(process.env['HIVE_MAX_DISPATCH_DEPTH']
        ? { maxDepth: Number(process.env['HIVE_MAX_DISPATCH_DEPTH']) || undefined }
        : {}),
      ...(process.env['HIVE_DISPATCH_CONCURRENCY']
        ? { maxConcurrency: Number(process.env['HIVE_DISPATCH_CONCURRENCY']) || undefined }
        : {})
    })
    dispatchStore.ensureDir()
  }

  /**
   * #51 派遣编排装配（groups 就绪后调用）。spawn 用 Electron 真子进程：
   * dev = vendored electron 真二进制；打包 = resourcesPath 侧的可执行文件。
   * 派遣失败/待领取的 @主人 走群文本（Spec #41「群里可见」）。
   */
  function startDispatchService(service: GroupsService): void {
    if (!dispatchStore || !memberRegistry || !appState) return
    dispatchService = new DispatchService({
      selfId: appState.nodeId,
      // #56 递归派遣：派遣成员由父写入自己的代数（常驻节点不设 = 1）。
      selfDepth: Number(process.env['HIVE_DISPATCH_DEPTH']) || undefined,
      userDataRoot: () => app.getPath('userData'),
      groups: service,
      registry: memberRegistry,
      store: dispatchStore,
      spawnNode: ({ userDataDir, ports, peers, depth, handoffPath }) => {
        const exe = resolveDispatchExecutable()
        const { spawn } = require('node:child_process') as typeof import('node:child_process')
        const child = spawn(exe.exe, exe.args, {
          cwd: exe.cwd,
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            PANTRY_HEADLESS: '1',
            PANTRY_USER_DATA: userDataDir,
            PANTRY_UDP_PORT: String(ports.udp),
            PANTRY_TCP_PORT: String(ports.tcp),
            PANTRY_LOCAL_API_PORT: String(ports.api),
            // #56：新成员知道自己的代数，才能在自己的深度上继续派遣（达上限即不能再派）。
            HIVE_DISPATCH_DEPTH: String(depth),
            // #60：输入交接路径——子节点开工前复验（缺失/sha256 不匹配 = 拒绝接手）。
            ...(handoffPath ? { HIVE_HANDOFF_PATH: handoffPath } : {}),
            ...(peers.length > 0 ? { PANTRY_PEERS: peers.join(',') } : {})
          }
        })
        child.unref()
        return { pid: child.pid ?? 0, apiPort: ports.api }
      },
      killNode: (pid) => {
        // spawn 出去即 detached（自成进程组）：按组杀，覆盖 Electron Helpers。
        const { kill } = require('node:process') as typeof import('node:process')
        try {
          kill(-pid, 'SIGKILL')
        } catch {
          /* 组已不存在 */
        }
        try {
          kill(pid, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      },
      sendText: (groupId, text, mentions, replyTo) =>
        service.sendText(groupId, text, mentions ?? [], replyTo),
      emit: (type, data) => localApi?.emit(type, data),
      // #54：输入/输出交接的产物 sha256 校验（fail-closed：读不到 = 校验失败）。
      readArtifact: (path) => {
        try {
          return readFileSync(path)
        } catch {
          return null
        }
      },
      // #60：输入交接落盘到本机 artifacts/handoffs/，路径交给子节点复验。
      writeHandoff: (dispatchId, markdown) => {
        try {
          const dir = join(artifactsRoot(), 'handoffs')
          mkdirSync(dir, { recursive: true })
          const path = join(dir, `${dispatchId}.md`)
          writeFileSync(path, markdown, 'utf8')
          return path
        } catch (err) {
          console.error('[handoff] 落盘失败：', err)
          return null
        }
      },
      // #60：交接校验证据进本机机库（self 的会话账本 handover 行，机库可过滤/搜索）。
      emitHandoffEvidence: (evidence) => {
        try {
          const ledger = new SessionLedger(artifactsRoot(), appState?.nodeId ?? 'unknown', 'handoff-verify')
          ledger.append('handover', evidence)
        } catch (err) {
          console.error('[handoff] 证据落盘失败：', err)
        }
      },
      // #54 回收：机库归档 + quit（进程收干净 + 接入账本消条）。
      archiveMember: (memberId, reason) => archiveHangarSessions(memberId, reason),
      quitMember: (memberId) => {
        const attached = listAttached({ attachStatePath }).find((m) => m.memberId === memberId)
        if (attached) {
          try {
            const { kill } = require('node:process') as typeof import('node:process')
            kill(-attached.pid, 'SIGKILL')
          } catch {
            /* 进程组已不存在 */
          }
          try {
            process.kill(attached.pid, 'SIGKILL')
          } catch {
            /* 已退出 */
          }
        }
        if (forgetAttached(memberId, { attachStatePath })) {
          console.log(`[reclaim] 接入账本已清除 ${memberId}`)
        }
      },
      pollHealth: (apiPort, expectNodeId, timeoutMs) => pollDispatchHealth(apiPort, expectNodeId, timeoutMs),
      log: (line) => console.log(line)
    })
    dispatchService.setSelfUdp(udpPort)
    console.log('[dispatch] 派遣服务已启用（POST /v1/dispatch）')
    startAbnormalExitWatcher(service)
  }

  /**
   * #59 异常退群探测器装配：派遣子进程猝死 → 5 秒内异常退群 + 任务转待领取 + @原主人。
   *
   * 与「正常退群」是**两种消息**（AC2）：正常回收走 ADR-0006 的 `leave`（成员自己退群，
   * 群里落底座系统事件），这里走显式的 `⚠ 异常退群` 群文本 + 待领取 id + @主人。
   * 默认**不自动补派**：只落账与通知，补派由人经 GUI 显式发起（AC3）。
   */
  function startAbnormalExitWatcher(service: GroupsService): void {
    if (!dispatchStore) return
    abnormalExitWatcher?.stop()
    abnormalExitWatcher = new AbnormalExitWatcher({
      store: dispatchStore,
      onAbnormalExit: ({ dispatchId, memberId, reason, record }) => {
        handleAbnormalMemberExit(service, dispatchId, memberId, reason, record)
      },
      log: (line) => console.log(line)
    })
    abnormalExitWatcher.start()
    console.log(`[runner-watch] 异常退群探测已启用（每 ${1_000}ms 探活一次派遣成员 pid）`)
  }

  /**
   * 待领取任务变化的推送（#59）：GUI 面板据此刷新，不必轮询。
   * 不新造 SSE `type`（契约：type 批内冻结，只能新增不能改语义）——
   * 真状态变化已经由 `dispatch.event(claimable)` / `member.lifecycle(abnormal)` 表达，
   * 这里只负责 GUI 推送面。
   */
  function broadcastClaimable(): void {
    mainWindow?.webContents.send(IpcEvents.claimableUpdated)
  }

  /**
   * 一个派遣成员判死后的收口（AC1/AC2/AC4）：成员从成员表与派遣图**硬删除**、
   * 登记表撤条、机库归档、退群消息与 @主人、`member.lifecycle(abnormal)` + `dispatch.event(claimable)`。
   *
   * 顺序与 #53 的移出同源纪律：先让底座把它移出群（硬删除），再撤本机账本，最后广播。
   * 底座拒绝（比如本节点不是 admin）→ 显式留痕，不假装成员已消失。
   */
  function handleAbnormalMemberExit(
    service: GroupsService,
    dispatchId: string,
    memberId: string,
    reason: string,
    /** 结算前的派遣记录快照（结算后 memberIds 已摘除该成员，查不回来）。 */
    record: DispatchRecord | null
  ): void {
    const store = dispatchStore
    if (!store) return
    const task = store.listClaimable().find((t) => t.failedMemberId === memberId)
    const taskId = task?.dispatchId ?? dispatchId
    const goalOneLine = task?.goalOneLine ?? record?.goalOneLine ?? ''
    const dispatcherId = record?.dispatcherId ?? ''
    // 群以账本快照为准；快照缺失时退回本机登记表的 groupId（#53 的 dispatched 记录带 groupId）——
    // 少了这一步会在 record=null 时静默跳过硬删除与群消息（成员留在群里，AC1/AC4 双双不成立）。
    const groupId = record?.groupId ?? memberRegistry?.get(memberId)?.groupId ?? ''

    // 1) 群成员表硬删除（AC1「从活跃成员中消失」）：活着自 leave 无权限门，猝死只能由 admin remove。
    //    派遣时已 set-admin 给派遣者，这里以本节点身份执行 —— 本节点就是该成员的主人节点。
    if (groupId) {
      const before = service.get(groupId)
      if (before?.members.includes(memberId)) {
        const updated = service.updateGroup(groupId, { kind: 'remove', memberIds: [memberId] })
        if (!updated || updated.members.includes(memberId)) {
          // 与 #53 同源纪律：拒绝要留痕（不只是打日志），否则「成员还在群里但账本说它走了」无人可查。
          memberRegistry?.recordAudit({
            action: 'orphan_remove',
            result: 'backend_rejected',
            actorId: appState?.nodeId ?? '',
            targetId: memberId,
            groupId,
            code: 'backend_rejected',
            reason: `底座拒绝移出猝死成员：${reason}`
          })
          console.error(`[runner-watch] 底座拒绝移出猝死成员 ${memberId}（群 ${groupId}）—— 成员仍在成员表`)
        }
      }
    } else {
      // 没有群 = 无从硬删除。这是账本/登记表都已丢失的异常态：显式留痕，不假装收口完成。
      console.error(`[runner-watch] 猝死成员 ${memberId} 无群可退（账本快照与登记表都没有 groupId）`)
    }

    // 2) 网络图/挂靠：被回收者是派遣链的父时，子成员跳级挂靠最近活跃祖先（#56 AC4）。
    //    必须**先于**撤登记跑：reanchor 的兜底主人取自登记表的 ownerId，撤完就查不到了。
    reanchorDispatchedChildren(memberId)
    // 3) 本机登记表撤条（#53 同一纪律：不留幽灵；否则成员列表里还挂着一个死成员）。
    memberRegistry?.unregister(memberId)
    // 4) 机库归档（#52）：异常终结的实例会话进归档，数据仍可读可搜。
    archiveHangarSessions(memberId, 'abnormal')

    // 5) 群内可见的两条消息（AC2）：异常退群文案 @原主人；与正常退群的系统事件明确不同。
    const memberName = resolvePeerDisplayName(memberId) || memberId
    service.sendText(
      groupId,
      abnormalExitText({ memberName, reason, taskId, goalOneLine }),
      dispatcherId ? [dispatcherId] : []
    )

    // 6) 事件面：成员异常退群 + 派遣结算为待领取（契约冻结的 type / phase）。
    localApi?.emit('member.lifecycle', { memberId, phase: 'abnormal' })
    localApi?.emit('dispatch.event', {
      dispatcherId,
      memberIds: [memberId],
      goalOneLine,
      depth: record?.depth ?? 1,
      outcome: 'claimable'
    })
    broadcastClaimable()
    console.log(`[runner-watch] 异常退群收口完成：${memberId.slice(0, 6)}（${reason}）`)
  }

  /**
   * health 轮询（node:http；Electron 22 内嵌 Node 16 无全局 fetch）。
   * nodeId 必须等于预生成值，不等即失败（ADR-0006「身份注入校验」）；net.ok 才算就绪。
   */
  function pollDispatchHealth(
    apiPort: number,
    expectNodeId: string,
    timeoutMs: number
  ): Promise<{ ok: boolean; reason?: string }> {
    const { get } = require('node:http') as typeof import('node:http')
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs
      let last = ''
      const attempt = (): void => {
        const req = get({ host: '127.0.0.1', port: apiPort, path: '/v1/health', timeout: 2000 }, (res) => {
          let body = ''
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf8')
          })
          res.on('end', () => {
            try {
              const view = JSON.parse(body) as { nodeId?: string; net?: { ok?: boolean } }
              if (view.nodeId !== expectNodeId) {
                resolve({ ok: false, reason: `health 身份不匹配（期望 ${expectNodeId}，实得 ${view.nodeId}）` })
                return
              }
              if (view.net?.ok !== true) {
                last = 'health 到了但网络栈未就绪'
                retryOrTimeout()
                return
              }
              resolve({ ok: true })
            } catch {
              last = 'health 响应不是合法 JSON'
              retryOrTimeout()
            }
          })
        })
        req.on('error', (err) => {
          last = String((err as Error)?.message ?? err)
          retryOrTimeout()
        })
        req.on('timeout', () => {
          req.destroy()
          last = 'health 请求超时'
          retryOrTimeout()
        })
      }
      const retryOrTimeout = (): void => {
        if (Date.now() >= deadline) {
          resolve({ ok: false, reason: `health 校验超时（${timeoutMs}ms）：${last}` })
          return
        }
        setTimeout(attempt, 500).unref?.()
      }
      attempt()
    })
  }

  /** 派遣子进程的可执行文件：优先本 app（打包态），否则 vendored dev 产物。 */
  function resolveDispatchExecutable(): { exe: string; args: string[]; cwd: string } {
    // cwd 不能直接给 app.getAppPath()：打包态它指到 app.asar（**文件**），
    // spawn 会 ENOTDIR（#25 实测），子进程起不来。dev 态它是源码树目录，原样可用。
    const cwd = appCwdDir({ isPackaged: app.isPackaged, appPath: app.getAppPath() })
    if (app.isPackaged) {
      // 打包态：Electron 主程序自身以 PANTRY_HEADLESS=1 再入即成 headless 节点。
      return { exe: process.execPath, args: [], cwd }
    }
    const out = join(app.getAppPath(), 'out', 'main', 'index.js')
    return { exe: process.execPath, args: [out], cwd }
  }

  /**
   * #50 pending 服务初始化。开关：`PANTRY_PENDING=1`（默认关 = #46 直通行为，回归不受影响）。
   * 持久化 `<userData>/hive/pending.json`：pending 草稿 / 授权 / 目标状态都在这里，
   * 重启后由构造函数自动读回（AC6）。启动即挂 SSE `pending.updated`（契约表冻结事件）。
   */
  function initPendingService(dataDir: string): void {
    if (process.env['PANTRY_PENDING'] !== '1') return
    pendingService = new PendingService({
      path: join(dataDir, 'hive', 'pending.json'),
      log: (line) => console.log(line)
    })
    pendingService.on('pending.updated', (data: unknown) => {
      localApi?.emit('pending.updated', data)
      mainWindow?.webContents.send(IpcEvents.pendingUpdated, data)
    })
    console.log('[hive] pending 确认闸门已启用（PANTRY_PENDING=1）')
  }

  /**
   * #55 目标守卫初始化。开关：`HIVE_GOAL_GUARD_URL`（本机判定器地址）。
   * 未配置 = 守卫关闭，steering 行为与 #50 完全一致；配置了但判定器挂 = fail-open（AC5）。
   */
  function initGoalGuard(): void {
    const url = (process.env['HIVE_GOAL_GUARD_URL'] ?? '').trim()
    if (!url) {
      console.log('[goal-guard] 未配置 HIVE_GOAL_GUARD_URL：目标守卫关闭')
      return
    }
    goalGuardJudge = httpJudge(url)
    goalGuardAuditPath = join(app.getPath('userData'), 'hive', 'goal-guard-audit.jsonl')
    console.log(`[goal-guard] 目标守卫已启用（${url}）`)
  }

  /** #55 AC2：最近 N 条守卫判定（机库审计数据源；tail 读取，不加载全文件）。 */
  function recentGoalGuardAudits(limit = 50): unknown[] {
    if (!goalGuardAuditPath) return []
    try {
      const { statSync, readFileSync } = require('node:fs') as typeof import('node:fs')
      // 审计是 append-only jsonl：从文件尾读 256KB 足够覆盖 50 条，避免整文件加载。
      const size = statSync(goalGuardAuditPath).size
      const start = Math.max(0, size - 256 * 1024)
      const buf = readFileSync(goalGuardAuditPath)
      const text = (start > 0 ? buf.subarray(start).toString('utf8') : buf.toString('utf8'))
        .split('\n')
        .filter(Boolean)
      const lines = start > 0 ? text.slice(1) : text // 尾读可能切坏首行，丢掉
      return lines.slice(-limit).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }

  // ---------- #49 Agent 接入 ----------

  /** 接入账本路径（本机账本，绝不进上游 schema）。 */
  function attachStatePath(): string {
    return join(app.getPath('userData'), 'hive', 'agent-attach.json')
  }

  /**
   * runner 入口目录（见 `resolveRunnerDir` 的注释：裸 .mjs 不进构建入口图，
   * 且打包态必须落到 app.asar.unpacked/ —— 系统 node 读不穿 asar，#25）。
   *
   * 候选次序：`__dirname/acp`（构建产物 out/main/acp，打包态由 resolveRunnerDir 映射到
   * unpacked）→ app 目录下的 src 源码树（dev 直跑）。
   */
  function runnerDir(): string {
    const appRoot = appCwdDir({ isPackaged: app.isPackaged, appPath: app.getAppPath() })
    return resolveRunnerDir([join(__dirname, 'acp'), join(appRoot, 'src', 'main', 'acp')])
  }

  /**
   * 用**真进程**做一次 ACP 探测（#49 AC2）：起 runner、握手、拿模型与 permission 枚举。
   * 探测完立刻收掉，不留常驻进程 —— 真正的常驻 runner 由 `startAgentBridge` 起。
   */
  async function probeRuntimeWithRealRunner(input: {
    command: string
    args: string[]
    cwd: string
    node: string
  }): Promise<{ agentInfo?: { name: string; version: string }; configOptions: unknown[] }> {
    const runner = new AcpRunner({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      node: input.node,
      entryDir: runnerDir(),
      turnTimeoutMs: 60_000,
      // 必须给 log：runner 子进程的 stderr 是「握手为什么没成」的唯一线索，
      // 不接走的话现场只看到一个超时（实测踩到过）。
      log: (line) => console.error(`[probe-${input.command}] ${line}`)
    })
    try {
      await runner.start()
      const result = await runner.probe(60_000)
      return {
        ...(result.agentInfo ? { agentInfo: result.agentInfo } : {}),
        configOptions: result.configOptions
      }
    } finally {
      await runner.dispose().catch(() => undefined)
    }
  }

  /** GUI 接入面的投影（IPC 返回形状；渲染层不碰文件系统）。 */
  interface AttachView {
    runtime: RuntimeKind
    ready: boolean
    items: RuntimeProbe['items']
    adapterPath: string
    cliPath: string
    models: RuntimeProbe['models']
    permissions: RuntimeProbe['permissions']
    agentInfo?: { name: string; version: string }
  }

  function toAttachView(probe: RuntimeProbe): AttachView {
    return {
      runtime: probe.runtime,
      ready: probe.ready,
      items: probe.items,
      adapterPath: probe.adapterPath,
      cliPath: probe.cliPath,
      models: probe.models,
      permissions: probe.permissions,
      ...(probe.agentInfo ? { agentInfo: probe.agentInfo } : {})
    }
  }

  /** 探测全部 runtime（打开接入对话框时调）。失败不抛：探测本身就是「报事实」。 */
  async function probeRuntimes(): Promise<AttachView[]> {
    const deps: ProbeDeps = {
      probeRuntime: probeRuntimeWithRealRunner,
      log: (line) => console.log(line)
    }
    const out: AttachView[] = []
    for (const runtime of ['claude', 'codex'] as RuntimeKind[]) {
      try {
        out.push(toAttachView(await probeRuntime(runtime, deps)))
      } catch (err) {
        // 探测函数自身不该抛（它内部把失败转成 item）；真抛了也要变成可读的一项。
        out.push({
          runtime,
          ready: false,
          items: [
            {
              id: 'handshake',
              label: 'ACP 握手（拿模型与 permission 枚举）',
              ok: false,
              detail: String((err as Error)?.message ?? err),
              hint: '重试探测；若持续失败，看节点日志与 adapter 是否可独立运行'
            }
          ],
          adapterPath: '',
          cliPath: '',
          models: [],
          permissions: []
        })
      }
    }
    return out
  }

  /** 目标成员此刻是否可达（与 `health.peers` 同一判活口径）。 */
  function memberOnline(nodeId: string): boolean {
    return registry?.get(nodeId)?.online === true
  }

  /** 端口是否已被本机某个进程占用（接入前避让，别硬上）。 */
  function portTaken(port: number): boolean {
    if (port <= 0) return false
    try {
      // UDP 与 TCP 都试：底座同时开两种端口，任一被占都不该复用。
      return udpPortTaken(port) || tcpPortTaken(port)
    } catch {
      return false
    }
  }

  /**
   * 接入编排的依赖装配。每个成员一个**独立 Electron 节点进程**（CONTEXT「成员表一条 =
   * 一个独立 agent 进程」），不是在本进程里再塞一个 runner。
   */
  function buildAttachDeps(): AttachDeps {
    return {
      selfId: () => appState?.nodeId ?? '',
      attachStatePath,
      dataRoot: () => join(app.getPath('userData'), 'members-nodes'),
      // 必须是**真 Node**（≥22）。裸写 'node' 在 Electron 里会解析到它自己的二进制，
      // 于是 `node runner.mjs` 变成「用 Electron 跑一个脚本」→ runner 永不 ready，
      // 表现为握手超时（实测踩到）。所以这里显式在 PATH 上找真 node，找不到就交给
      // startAcpRunner 抛错（fail-closed，不静默降级）。
      nodeExe: () => process.env['PANTRY_AGENT_NODE'] || findExecutable('node') || 'node',
      adapterPath: (runtime, requested) => {
        // 探测结果优先（用户看到哪个 adapter 就用哪个）；其次现场手动指定的；最后按 runtime 找标准包。
        if (requested) {
          const resolved = resolveAgentCommand(requested, process.env)
          if (resolved) return resolved
        }
        const configured = (process.env['PANTRY_AGENT_COMMAND'] ?? '').trim()
        if (configured) return resolveAgentCommand(configured, process.env)
        return findAdapterOnPath(runtime)
      },
      writeNodeConfig: (input) => {
        writeFullNodeConfig(input)
      },
      spawnNode: ({ dataDir, peers, env }) => {
        const exe = resolveNodeExecutable({ isPackaged: app.isPackaged, execPath: process.execPath })
        const logPath = join(dataDir, 'node.log')
        const logFd = openSync(logPath, 'a')
        try {
          const child = spawn(exe.exe, exe.args, {
            // dev 下 app 目录就是 vendor/teahouse（`electron .` 的 cwd）；
            // 打包下 app.getAppPath() 是 app.asar 文件、不能当 cwd（#25），退到 Resources。
            cwd: appCwdDir({ isPackaged: app.isPackaged, appPath: app.getAppPath() }),
            detached: true,
            // 输出重定向到日志文件而不是管道：接入方是长命进程，管道会让日志文件
            // 无人读且句柄悬空（launcher 踩过同一个坑，见 docs/ops/launcher.md）。
            stdio: ['ignore', logFd, logFd],
            env: {
              ...process.env,
              ...env,
              ...(peers.length > 0 ? { PANTRY_PEERS: peers.join(',') } : {})
            }
          })
          child.unref()
          return { pid: child.pid ?? 0, logPath }
        } finally {
          closeSync(logFd)
        }
      },
      waitHealth: async ({ apiPort, timeoutMs }) => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          try {
            const res = await fetchLocalHealth(apiPort)
            if (res) return res
          } catch {
            /* 还没起来，继续等 */
          }
          if (Date.now() >= deadline) return null
          await new Promise((r) => setTimeout(r, 400))
        }
      },
      inviteToGroup: (groupId, memberId) =>
        groups?.updateGroup(groupId, { kind: 'invite', memberIds: [memberId] }) !== null,
      registerMember: ({ memberId, ownerId, kind, groupId }) => {
        memberRegistry?.register({
          memberId,
          ownerId,
          kind,
          ...(groupId ? { groupId } : {})
        })
      },
      unregisterMember: (memberId) => {
        memberRegistry?.unregister(memberId)
      },
      existingPorts: () => [
        { udp: udpPort, tcp: tcpPort, api: localApi?.port() ?? 0 },
        ...listAttached({ attachStatePath }).map((m) => ({ udp: m.udpPort, tcp: m.tcpPort, api: m.apiPort }))
      ],
      isPortTaken: portTaken,
      log: (line) => console.log(line)
    }
  }

  /** 接入一个成员（#49 AC1/AC3 的落地动作）。返回面永远是 AttachResult，不抛。 */
  async function attachAgentMember(input: unknown): Promise<AttachResult> {
    return attachMember(input, buildAttachDeps())
  }

  function initAgentAttach(): void {
    const attached = listAttached({ attachStatePath })
    if (attached.length > 0) {
      console.log(`[hive] 已接入成员：${attached.map((m) => `${m.nick}(${m.runtime})`).join(', ')}`)
    }
  }

  /**
   * #58 重启恢复唯一入口（契约「迁移规则 2」）：接入成员重新拉起、执行期中断派遣转待领取、
   * 幽灵 pending 清理。groups 就绪前跑（ledger 判活不依赖群），失败只留痕不崩——
   * 恢复是尽力而为的收口，不能反过来挡启动。
   */
  async function runStartupRecovery(): Promise<void> {
    try {
      await runRecovery({
        selfId: () => appState?.nodeId ?? '',
        attachStatePath,
        registry: memberRegistry,
        store: dispatchStore,
        pending: pendingService,
        respawn: ({ record }) =>
          // 按账本原样重放接入编排（attachMember 内部含端口避让与 health 校验）；
          // 账本里存的字段即上次接入的完整输入。
          attachMember(
            {
              runtime: (record as { runtime: string }).runtime,
              nick: (record as { nick: string }).nick,
              cwd: (record as { cwd: string }).cwd,
              model: (record as { model: string }).model,
              permissionMode: (record as { permissionMode: string }).permissionMode,
              // 拉群走底座既有 invite：账本里不含 groupId，重启后由主人在 GUI 里补拉即可
              // （不影响成员进程本身的恢复）。
              groupId: '',
              adapterPath: '',
              toolPermission: 'allow'
            },
            buildAttachDeps()
          ),
        log: (line) => console.log(line)
      })
    } catch (err) {
      console.error('[hive] 重启恢复失败（不挡启动）：', err)
    }
  }

  /**
   * #53 移出/孤儿清理的判权入口。返回 null 表示放行（继续走底座），否则是拒绝结果。
   * 拒绝与成功都留痕（Spec #41：权限判断 fail-closed 且记录原因）。
   */
  function authorizeHiveMemberRemove(
    groupId: string,
    targetId: string
  ): { code: HiveMemberRemoveDeny['code']; reason: string; stage: 'authorize' | 'apply' } | null {
    const hive = memberRegistry
    if (!hive || !appState) return null // 未启用成员管理时保持上游行为，不误伤
    const decision = authorizeMemberRemoval({
      actorId: appState.nodeId,
      targetId,
      groupId,
      targetOnline: memberOnline(targetId),
      group: groups?.get(groupId) ?? null,
      record: hive.get(targetId)
    })
    if (!decision.ok) {
      hive.recordAudit({
        action: memberOnline(targetId) ? 'remove' : 'orphan_remove',
        result: 'denied',
        actorId: appState.nodeId,
        targetId,
        groupId,
        ...(decision.code ? { code: decision.code } : {}),
        ...(decision.reason ? { reason: decision.reason } : {})
      })
      return {
        code: decision.code ?? 'unknown_target',
        reason: decision.reason ?? '',
        stage: 'authorize'
      }
    }
    pendingMemberRemoval = { groupId, targetId, phase: decision.phase ?? 'leave' }
    return null
  }

  /** 判权通过后由 `group:update` 的 remove 分支消费；见 `finishHiveMemberRemove`。 */
  let pendingMemberRemoval: { groupId: string; targetId: string; phase: MemberRemovalPhase } | null = null

  /**
   * 底座 `updateGroup` 已跑完，收口本次移出：确认目标**真的**从成员表消失，
   * 再发 `member.lifecycle`、撤登记、按需让被移出的本机成员退出进程。
   *
   * 必须回查：底座对「不在群里的目标」会过滤后返回 view 而不报错（假成功）。
   */
  function finishHiveMemberRemove(updated: GroupView | null): void {
    const pending = pendingMemberRemoval
    pendingMemberRemoval = null
    const hive = memberRegistry
    if (!pending || !hive || !appState) return
    const actorId = appState.nodeId
    const auditBase = {
      actorId,
      targetId: pending.targetId,
      groupId: pending.groupId
    } as const
    if (!updated || updated.members.includes(pending.targetId)) {
      // 判权通过、底座却没动：显式失败，不假装成功（不静默）。
      hive.recordAudit({
        action: pending.phase === 'leave' ? 'remove' : 'orphan_remove',
        result: 'backend_rejected',
        ...auditBase,
        code: 'backend_rejected',
        reason: hiveMemberRemoveText('backend_rejected')
      })
      return
    }
    hive.recordAudit({
      action: pending.phase === 'leave' ? 'remove' : 'orphan_remove',
      result: 'ok',
      ...auditBase,
      phase: pending.phase
    })
    hive.unregister(pending.targetId)
    // #52：移出即实例终结 → 该成员当前实例的会话整体进归档（CONTEXT「归档」：
    // 「随回收/移出终结的实例都进归档，数据仍在本机、可读可搜」）。
    archiveHangarSessions(
      pending.targetId,
      pending.phase === 'leave' ? 'remove' : 'orphan_removed'
    )
    // #49：成员被移出后，接入账本里那一条也要消掉 —— 否则它的端口会被永久避让，
    // 成员列表里也留着一个已经不存在的成员（幽灵条目）。
    if (forgetAttached(pending.targetId, { attachStatePath })) {
      console.log(`[hive] 接入账本已清除 ${pending.targetId}`)
    }
    // #59：正常终结必须回写派遣账本 —— 否则该成员进程一退出就会被猝死探活的下一拍
    // （≤1s）判成「异常退群」，群里冒出假消息 + 幽灵待领取任务（AC2 直接不成立）。
    settleDispatchedMember(pending.targetId)
    localApi?.emit('member.lifecycle', {
      memberId: pending.targetId,
      phase: pending.phase
    })
    reanchorDispatchedChildren(pending.targetId)
  }

  /**
   * 成员级正常终结的账本回写（#59）：从 `outcome=started` 的记录里摘掉这个成员，
   * 归还它的 slot，整批都终结则记录转 `settled`（不再参与猝死探活）。
   *
   * 调用点 = 一切「成员正常离开」的路径（#53 移出 / #54 回收 / 底座的正常退群）。
   * 不落待领取：正常终结意味着任务已交付（PRD ④「没有交接文档 = 没有结果」的正面情形）。
   */
  function settleDispatchedMember(memberId: string): void {
    const store = dispatchStore
    if (!store) return
    const record = store.recordForMember(memberId)
    if (!record) return
    if (store.markSettled({ dispatchId: record.dispatchId, memberId })) {
      localApi?.emit('dispatch.event', {
        dispatcherId: record.dispatcherId,
        memberIds: [memberId],
        goalOneLine: record.goalOneLine,
        depth: record.depth,
        outcome: 'settled'
      })
      console.log(`[dispatch] ${memberId.slice(0, 6)} 正常终结，派遣账本已结算（slot 归还）`)
    }
  }

  /**
   * #56 AC4：被回收/移出者是某条派遣链的父时，它的子成员跳级挂靠**最近活跃祖先**
   * （一路无祖先兜底主人 / 群中心），并把挂靠结果与新深度广播出去。
   *
   * 只在本地账本上有这个父的派遣记录时才动——常驻成员退群不影响任何派遣关系。
   */
  function reanchorDispatchedChildren(removedId: string): void {
    const store = dispatchStore
    if (!store || !appState) return
    const edges = store.edges()
    const children = edges.filter((e) => e.dispatcherId === removedId)
    if (children.length === 0) return
    // 活跃集 = 本机身份 + 所有登记成员里在线者（底座 presence 判活，与成员表同一口径）。
    const active = new Set<string>([appState.nodeId])
    for (const record of memberRegistry?.list() ?? []) {
      if (memberOnline(record.memberId)) active.add(record.memberId)
    }
    active.delete(removedId)
    const fallback = memberRegistry?.get(removedId)?.ownerId ?? appState.nodeId
    const reanchored = reanchor(edges, removedId, active, fallback)
    if (reanchored.length === 0) return
    for (const { memberId, to } of reanchored) {
      localApi?.emit('member.lifecycle', {
        memberId,
        phase: 'reanchor',
        // 挂靠后的新父（祖先或主人）；深度由活跃链重算，见 recomputeDepths。
        ...(to ? { reanchoredTo: to } : {}),
        depth: recomputeDepths(edges, active).get(memberId) ?? 1
      })
      console.log(`[hive] #56 派遣链重挂：${memberId.slice(0, 6)} 的父 ${removedId.slice(0, 6)} 已退群 → 挂 ${to.slice(0, 6)}`)
    }
  }


  /** local-api 装配（ADR-0002 Decision 4）：回环第二前台 + 唯一跨平台优雅退出通道。 */
  function startLocalApi(): void {
    localApi = createHiveLocalApi({
      nodeId: () => appState?.nodeId ?? '',
      nick: () => appState?.config.nick ?? '',
      setupDone: () => appState?.config.setupDone === true,
      requestPort: () => envApiPort ?? 0,
      udpPort: () => udpPort,
      tcpPort: () => tcpPort,
      token: () => process.env['PANTRY_LOCAL_API_TOKEN'] ?? '',
      agentEnabled: () => Boolean(process.env['PANTRY_AGENT_COMMAND']),
      agentStatus: () => ({
        cap: AGENT_STATUS_CAP,
        producer: process.env['PANTRY_AGENT_STATUS'] ? 'on' : 'off',
        ...(agentStatus?.snapshot() ?? { cached: 0, dropped: 0 })
      }),
      pendingState: () => (pendingService ? pendingStateView(pendingService) : null),
      // #59：待领取任务面（e2e 与演示现场经 health 直接观察「任务回了待领取」）。
      claimable: () => ({
        autoDispatch: false, // AC3 冻结口径：默认不自动补派，补派只能由人发起。
        tasks: (dispatchStore?.listClaimable() ?? []).map(toClaimableView)
      }),
      goalGuard: () => ({
        enabled: Boolean(goalGuardJudge),
        recentAudits: recentGoalGuardAudits()
      }),
      groupCount: () => groups?.list().length ?? 0,
      onlinePeerCount: () => registry?.onlineCount() ?? 0,
      netState: () => ({
        ok: netState.ok,
        ...(netState.error ? { error: netState.error } : {})
      }),
      // #52 机库面：四端点全部只读；写只经 archiveHangarSessions / clearHiveMember。
      hangar: {
        overview: () => {
          const h = hangar
          if (!h) return { schemaVersion: 0, nodeId: appState?.nodeId ?? '', members: [], totals: { activeSessions: 0, archivedSessions: 0 } }
          const members = h.overview(hangarDecorate).map((member) => {
            const archived = h.sessionIds(member.memberId)
              .map((id) => h.sessionSummary(member.memberId, id))
              .filter((s): s is NonNullable<typeof s> => s !== null && s.archive !== null)
              .sort((a, b) => b.endedAt - a.endedAt)
            return { ...member, archive: archived }
          })
          let activeSessions = 0
          let archivedSessions = 0
          for (const member of members) {
            activeSessions += member.sessions.length
            archivedSessions += member.archive.length
          }
          return {
            schemaVersion: 1,
            nodeId: appState?.nodeId ?? '',
            members,
            totals: { activeSessions, archivedSessions }
          }
        },
        timeline: (query) => {
          const h = hangar
          if (!h) return null
          // 成员目录不存在 = 本机根本没有这个成员的账本 → 显式 404（不假装空时间线）。
          if (!h.hasMember(query.memberId)) return null
          return h.search(query)
        },
        markdown: (memberId, sessionId) => hangar?.markdown(memberId, sessionId) ?? null,
        // clear 的命令面（AC4）：归档索引与账本必须同机，而成员实例可能是本机另一个
        // headless 节点进程 —— 只有那个进程能归档它自己的账本。故 actorId 由调用方声明，
        // 本节点用它对照自己的成员登记表判权（fail-closed，拒绝理由显式回传）。
        clear: (input) => clearHiveMember(input.memberId, input.actorId)
      },
      sendMessage: (input) =>
        groups?.sendText(input.groupId, input.text, input.mentions ?? [], input.replyTo) ?? null,
      dispatch: (input) =>
        dispatchService
          ? dispatchService.dispatch({
              groupId: input.groupId,
              dispatcherId: input.dispatcherId,
              goalOneLine: input.goalOneLine,
              dispatcherDepth: input.dispatcherDepth,
              count: input.count,
              ...(input.handoverMarkdown !== undefined
                ? { handoverMarkdown: input.handoverMarkdown }
                : {})
            })
          : Promise.resolve(null),
      // #54 回收：memberId + 输出交接文档；判权与编排都在 DispatchService.reclaim。
      reclaim: (input) =>
        dispatchService
          ? dispatchService.reclaim({
              actorId: input.actorId,
              memberId: input.memberId,
              handoverMarkdown: input.handoverMarkdown
            })
          : Promise.resolve(null),
      requestQuit: () => {
        isQuitting = true
        app.quit()
      }
    })
    if (groups) localApi.attachGroups(groups)
    else onGroupsReady = (service) => localApi?.attachGroups(service)
    void localApi
      .listen()
      .then(() => {
        if (HEADLESS) {
          // 验收抓手（#14 §2.3）：一行自检，现场与 smoke 都读它。
          console.log(
            `[headless] up nodeId=${appState?.nodeId ?? ''} udp=${udpPort} tcp=${tcpPort} api=${localApi?.port() ?? 0} agent=${process.env['PANTRY_AGENT_COMMAND'] ? 'on' : 'off'}`
          )
        }
      })
      .catch((err: unknown) => {
        console.error('[local-api] 启动失败：', err)
      })
  }

  /** 本机会话账本根（ADR-0008）：userData 下的 `artifacts/`，可用 env 覆盖。 */
  function artifactsRoot(): string {
    return process.env['PANTRY_ARTIFACTS_ROOT'] || join(app.getPath('userData'), 'artifacts')
  }

  /**
   * #49 AC5：把一次真实 usage 转成本机负担上报。
   * 转不动（载荷缺 used/size）就**不报** —— 由 30s TTL 表达「没数据」，不伪造档位。
   */
  function reportUsageAsBurden(usage: unknown): void {
    if (!agentStatus) return
    const report = burdenReportFromUsage(usage, { ts: Date.now() })
    if (!report) {
      console.log('[agent] usage 载荷不含可用的 used/size，本次不上报负担')
      return
    }
    agentStatus.setLocalReport(report)
  }

  /**
   * #52 机库：读账本 + 归档索引。`nick` / `burden` 在这里装饰（机库不认识 registry
   * 与状态通道，那是别的 owner 的面）。
   */
  function initHangar(): void {
    hangar = new Hangar({ artifactsRoot, log: (line) => console.log(line) })
    console.log(`[hangar] 账本根 ${artifactsRoot()}`)
  }

  /**
   * 机库总览的装饰面：昵称取本地备注 > 昵称 > memberId；负担取自 #47 的跨机状态缓存
   * （本机成员也走同一条通道，故本机与跨机口径一致）。
   */
  function hangarDecorate(memberId: string): {
    nick: string
    burden: {
      tag: string
      label: string
      color: string
      pct: number | null
      goal: string
      role: string
      lastActivity: number
    } | null
  } {
    const nick = resolvePeerDisplayName(memberId) || memberId
    const burden = agentStatus?.viewFor(memberId, agentStatus.sharedPeerIds())
    if (!burden) return { nick, burden: null }
    return {
      nick,
      burden: {
        tag: burden.tag,
        label: burden.label,
        color: burden.color,
        pct: burden.pct,
        goal: burden.goal,
        role: burden.role,
        lastActivity: burden.ts
      }
    }
  }

  /**
   * #52 机库的归档入口（供生命周期 owner 调用）：把某成员的活跃会话标为已归档。
   * clear 之外的终结（回收 #54 / 移出 #53 / 异常退群 #59）都从这条通道落账。
   */
  function archiveHangarSessions(memberId: string, reason: ArchiveReason): string[] {
    const archived = hangar?.archiveActiveSessions(memberId, reason) ?? []
    if (archived.length > 0) {
      localApi?.emit('member.lifecycle', {
        memberId,
        phase: 'archive',
        reason,
        sessions: archived
      })
    }
    return archived
  }

  /**
   * #52 AC4 clear：终结旧实例并归档，同一身份位置开新实例，目标由人重定。
   *
   * 本机 agent 成员要连带把 ACP runner 换成新实例（旧的会话上下文必须真丢，
   * 否则「clear」只是改了个号）；人的节点没有 runner，只换机库侧实例纪元。
   */
  function clearHiveMember(
    memberId: string,
    actorId?: string
  ): {
    ok: boolean
    archived: string[]
    epoch: number
    goalPending: boolean
    reason?: string
  } {
    const hive = hangar
    if (!hive || !appState) return { ok: false, archived: [], epoch: 0, goalPending: false, reason: '机库未装配' }
    const actor = actorId && actorId !== '' ? actorId : appState.nodeId
    // 权限与 #53 同源纪律：只有主人能 clear 自己的成员；本机自身永远可 clear。
    // 判权用**声明的 actorId**（可能是本机另一个节点进程的主人身份），对照本节点的登记表。
    const record = memberRegistry?.get(memberId)
    if (memberId !== actor && (!record || record.ownerId !== actor)) {
      memberRegistry?.recordAudit({
        action: 'remove',
        result: 'denied',
        actorId: actor,
        targetId: memberId,
        groupId: record?.groupId ?? '',
        code: 'not_member_owner',
        reason: hiveMemberRemoveText('not_member_owner')
      })
      return { ok: false, archived: [], epoch: 0, goalPending: false, reason: hiveMemberRemoveText('not_member_owner') }
    }
    const result = hive.clear(memberId, actor)
    // 本机自身被 clear：换掉 agent 实例（旧会话账本已归档，新实例从零开始）。
    if (memberId === appState.nodeId) restartLocalAgentInstance()
    return { ok: true, archived: result.archived, epoch: result.instance.epoch, goalPending: result.instance.goalPending }
  }

  /**
   * #54 回收（GUI IPC 与 local-api /v1/reclaim 共用）：编排全在 DispatchService.reclaim——
   * 输出交接校验（fail-closed）→ 群内结论 → 底座 remove → 撤登记 → 机库归档 → quit → 释放 slot。
   * 本节点只是把 deps 接上（判权数据来自成员登记表，进程/账本操作来自 agent-attach）。
   */
  async function reclaimHiveMember(
    memberId: string,
    handoverMarkdown: string
  ): Promise<HiveReclaimResult> {
    if (!dispatchService || !appState) {
      return { ok: false, reason: '派遣服务未启用（本节点未开派遣）' }
    }
    if (typeof handoverMarkdown !== 'string' || handoverMarkdown.trim() === '') {
      return { ok: false, reason: '缺少输出交接文档（回收必须带交接，fail-closed）' }
    }
    const outcome = await dispatchService.reclaim({
      actorId: appState.nodeId,
      memberId,
      handoverMarkdown
    })
    if (!outcome.ok) return { ok: false, reason: outcome.reason }
    return {
      ok: true,
      memberId: outcome.memberId,
      archivedSessions: outcome.archivedSessions,
      artifactCount: outcome.artifactCount
    }
  }

  /**
   * 本机 agent 实例重启（clear 的进程侧）：先收掉旧 runner/bridge，再按同一 env 起新实例。
   * 失败显式报错并降级为普通群成员（不静默）——与启动路径同一纪律。
   */
  function restartLocalAgentInstance(): void {
    const service = groups
    if (!service) return
    void (async () => {
      await agentBridge?.dispose().catch(() => undefined)
      agentBridge = null
      agentRunner = null
      console.log('[hive] clear：本机 agent 实例已回收，按同一配置起新实例')
      startAgentBridge(service)
    })()
  }

  /**
   * agent 链路装配（ADR-0004 / SPEC #41 第四阶段）：起 ACP runner，再把群消息接到 bridge。
   * 未配置 `PANTRY_AGENT_COMMAND` → 恒 null，节点仍是普通群成员（能收能被 @，只是不回复）。
   * 启动失败 → 显式报错并降级，**不静默**（SPEC #41"未配置时发出可观察诊断"）。
   * `PANTRY_PENDING=1` 时注入 #50 确认闸门：空闲 @ 进 pending，确认后聚合 prompt 恰好发送一次。
   */
  function startAgentBridge(service: GroupsService): void {
    const agent = readAgentEnv()
    if (!agent.command) {
      console.log('[agent] 未配置 PANTRY_AGENT_COMMAND：节点作为普通群成员运行（被 @ 不回复）')
      return
    }
    void startAcpRunner({
      entryDir: runnerDir(),
      agent,
      defaultCwd: app.getPath('userData'),
      log: (line) => console.error(line)
    })
      .then((runner) => {
        if (!runner) return
        agentRunner = runner
        // #50 闸门（可选）：PANTRY_PENDING 未开 = undefined，bridge 行为与 #46 完全一致。
        const pendingGate = pendingService
          ? buildPendingGate(service, () => Boolean(agentBridge?.status().running))
          : undefined
        // #60 接手闸（可选）：HIVE_HANDOFF_PATH 指向输入交接时，开工前复验（fail-closed）。
        const handoffPath = (process.env['HIVE_HANDOFF_PATH'] ?? '').trim()
        const handoffGate = handoffPath
          ? {
              check: (): { ok: true } | { ok: false; errors: string[] } => {
                let text: string
                try {
                  text = readFileSync(handoffPath, 'utf8')
                } catch {
                  return { ok: false, errors: [`交接文档缺失或不可读：${handoffPath}`] }
                }
                const verdict = verifyHandover(text, {
                  readArtifact: (p: string) => {
                    try {
                      return readFileSync(p)
                    } catch {
                      return null
                    }
                  }
                })
                if (!verdict.ok) return { ok: false, errors: verdict.errors }
                // 每次开工前都复验（不缓存成功）：交接被篡改后下一 turn 立即再拒；修复后重试即过。
                return { ok: true }
              }
            }
          : undefined
        agentBridge = new AgentBridge(
          {
            selfId: appState?.nodeId ?? '',
            onGroupMessage: (listener) => {
              service.on('message', listener)
            },
            sendText: (groupId, text, mentions, replyTo) =>
              service.sendText(groupId, text, mentions ?? [], replyTo),
            artifactsRoot,
            emitAcpUpdate: (data) => localApi?.emitAcpUpdate(data),
            // #49 AC5：真实 usage → 本机负担上报。只在没有确定性生产器时才接管 ——
            // 生产器是 #47 黑盒验收的可控输入，两者同时在场会让「谁说了算」变得不可解释。
            ...(process.env['PANTRY_AGENT_STATUS']
              ? {}
              : { emitUsage: (usage) => reportUsageAsBurden(usage) }),
            log: (line) => console.log(line)
          },
          {
            runner,
            ...(pendingGate ? { pendingGate } : {}),
            ...(handoffGate ? { handoffGate } : {})
          }
        )
        console.log(`[agent] bridge 已启用：command=${agent.command} cwd=${agent.cwd || app.getPath('userData')}`)
      })
      .catch((err: unknown) => {
        // 降级但不静默：节点继续当普通群成员，错误必须可见。
        console.error('[agent] ACP runner 启动失败，降级为普通群成员：', err)
      })
  }

  /**
   * #50 pending 闸门装配：路由 + 收集 + 取出已确认聚合 turn。
   * route=collect 的留言进 pending（不触发 turn）；steer（执行期）直通不进 pending；
   * 确认键通过后的聚合 prompt 以 `pending-aggregate:` 前缀由 takeTurn 交给 bridge 串行队列。
   */
  function buildPendingGate(
    service: GroupsService,
    isBridgeRunning: () => boolean
  ): {
    route(msg: MessageView): 'collect' | 'steer' | 'reject'
    onCollect(msg: MessageView): boolean
    takeTurn(msg: MessageView): string | null
    onSteer(msg: MessageView): Promise<void>
  } {
    const deps: PendingGateDeps = {
      service: pendingService!,
      selfMemberId: appState?.nodeId ?? '',
      ownerId: memberRegistry?.get(appState?.nodeId ?? '')?.ownerId,
      groupIdOf: (memberId) => {
        const draft = pendingService?.get(memberId)
        if (draft) return draft.groupId
        // 没有 pending 时从群列表找本机所在群（单成员节点取第一个即可，与 bridge 的 convId 解析同源）。
        const group = service.list().find((g) => g.amMember)
        return group?.groupId
      },
      hasFrozenGoal: (memberId, groupId) =>
        pendingService?.goal(memberId, groupId)?.state === 'frozen',
      isRunning: () => isBridgeRunning()
    }
    return {
      route: (msg) => {
        const decision = routeMessage(deps, msg)
        console.log(`[pending] route ${msg.id}: ${describeRoute(deps, decision)}`)
        return decision
      },
      onCollect: (msg) => collectIntoPending(deps, msg),
      takeTurn: (msg) => {
        // 确认键路径：bridge 收到的消息文本带 `pending-aggregate:` 前缀 = 已确认的聚合 turn。
        return msg.text.startsWith(PENDING_AGGREGATE_PREFIX)
          ? msg.text.slice(PENDING_AGGREGATE_PREFIX.length)
          : null
      },
      onSteer: (msg) => runGoalGuard(service, msg)
    }
  }

  /**
   * #55 目标守卫主链路：steering 消息（成员执行期收到的 @）先过守卫再放行。
   * 输入只有 {冻结目标, 请求原文}（AC1）；越界 → 恰好一次派遣（AC3）并 @派遣者；
   * 未判定/不可用 → fail-open 放行 + 群内警告（AC5）；在界 → 原样直通（原成员上下文零污染：
   * 越界正文不经原成员 turn，审计落本机 `hive/goal-guard-audit.jsonl`，AC4）。
   */
  async function runGoalGuard(service: GroupsService, msg: MessageView): Promise<void> {
    const judge = goalGuardJudge
    const groupId = msg.convId.startsWith('group:') ? msg.convId.slice('group:'.length) : msg.convId
    const memberId = appState?.nodeId ?? ''
    const goal = pendingService?.goal(memberId, groupId)
    const base: Omit<GoalGuardAuditEntry, 'ts'> = {
      memberId,
      groupId,
      input: { goal: goal?.text ?? '', request: msg.text },
      verdict: 'unavailable',
      confidence: 0,
      reason: goal?.state === 'frozen' ? '' : 'no_frozen_goal',
      action: goal?.state === 'frozen' ? 'guard_disabled' : 'no_goal'
    }
    if (!judge || !goal || goal.state !== 'frozen') {
      // 无守卫或无冻结目标：放行（不警告——后者是「守卫在而判不了」的情形）。
      appendGoalGuardAudit(join(app.getPath('userData'), 'hive', 'goal-guard-audit.jsonl'), base)

      return
    }
    const verdict = await judge({ goal: goal.text, request: msg.text })
    const action = decideAction(verdict)
    const dispatchId =
      action === 'dispatch' && dispatchService
        ? (
            await dispatchService.dispatch({
              groupId,
              dispatcherId: msg.senderId,
              goalOneLine: msg.text.slice(0, 2000),
              dispatcherDepth: (dispatchStore?.snapshot().dispatches.at(-1)?.depth ?? 0) || 1,
              count: 1
            })
          ).dispatchId
        : undefined
    appendGoalGuardAudit(join(app.getPath('userData'), 'hive', 'goal-guard-audit.jsonl'), {
      memberId,
      groupId,
      input: { goal: goal.text, request: msg.text },
      verdict: verdict?.verdict ?? 'unavailable',
      confidence: verdict?.confidence ?? 0,
      reason: verdict?.reason ?? 'judge_unavailable',
      action,
      ...(dispatchId ? { dispatchId } : {})
    })
    if (action === 'dispatch') {
      console.log(`[goal-guard] 越界 → 派遣（${dispatchId ?? 'dispatch_unavailable'}）`)
      // 越界正文不投原成员（AC4：账本证明未收到）；派遣失败时任务转待领取由 DispatchService 负责。
      if (!dispatchService) {
        service.sendText(groupId, '⚠ 目标守卫判定越界，但派遣服务未启用，请求未执行。', [msg.senderId])
      }
      return
    }
    if (action === 'deliver_warn') {
      // fail-open（AC5）：放行给原成员，但群内显式警告「未判定」。
      service.sendText(groupId, '⚠ 目标守卫未能判定本条请求（判定器不可用），已按未判定放行，请人工留意。', [msg.senderId])
    }
    // 直通：经 enqueueAggregate 把原文作为 steering turn 投回 bridge 串行队列
    // （不走群消息，不二次入 pending；与 #50 确认键同一条「恰好一次」通道）。
    if (!agentBridge?.enqueueAggregate(msg.text, groupId, msg.id)) {
      console.log('[goal-guard] 放行失败：bridge 未启用，请求未执行（不静默）')
    }
  }

  function parsePortValue(value: unknown): number | null {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
  }

  function parseImageDimension(value: unknown): number | null {
    const n = typeof value === 'number' ? value : NaN
    return Number.isFinite(n) && n > 0 && n <= 100000 ? Math.floor(n) : null
  }

  function parseTableTextMeta(value: unknown): TableTextMeta | undefined | null {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'object' || Array.isArray(value)) return null
    const raw = value as { tableText?: unknown; tableTextTruncated?: unknown }
    if (typeof raw.tableText !== 'string' || raw.tableText.length === 0) return null
    if (raw.tableTextTruncated !== undefined && typeof raw.tableTextTruncated !== 'boolean') {
      return null
    }
    const truncated = truncateUtf8Text(raw.tableText, TABLE_TEXT_LIMIT_BYTES)
    return {
      tableText: truncated.text,
      ...(raw.tableTextTruncated || truncated.truncated ? { tableTextTruncated: true } : {})
    }
  }

  function truncateUtf8Text(text: string, maxBytes: number): { text: string; truncated: boolean } {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
    let out = ''
    let used = 0
    for (const char of text) {
      const size = Buffer.byteLength(char, 'utf8')
      if (used + size > maxBytes) break
      out += char
      used += size
    }
    return { text: out, truncated: true }
  }

  /** Linux 窗口图标（决议 #58）：显式设置 _NET_WM_ICON，任务栏不依赖桌面环境的 desktop 关联 */
  function linuxWindowIcon(): { icon: string } | Record<string, never> {
    if (process.platform !== 'linux') return {}
    const icon = app.isPackaged
      ? join(process.resourcesPath, 'icons/pantry.png')
      : join(app.getAppPath(), 'build/icons/linux/256x256.png')
    return { icon }
  }

  function systemNotificationIcon(): string | undefined {
    const icon = notificationIconPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    })
    return icon && existsSync(icon) ? icon : undefined
  }

  function writeClipboardImage(bytes: ArrayBuffer): boolean {
    if (bytes.byteLength === 0 || bytes.byteLength > 30 * 1024 * 1024) return false
    const image = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return !clipboard.readImage().isEmpty()
  }

  function readClipboardImage(): ArrayBuffer | null {
    if (clipboard.readText().length > 0) return null
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const png = image.toPNG()
    if (png.byteLength === 0 || png.byteLength > 30 * 1024 * 1024) return null
    return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
  }

  // 文件默认保存目录：跨平台统一放「文档/hive」（决议 #159，品牌改 Hive 后同步改名）。
  // 不用「下载/Hive」——中文目录名在部分系统/命令行/跨平台工具链下编码兼容差，
  // 且收到的文件属长期归档、放文档更合语义。
  const defaultFileDir = (): string => join(app.getPath('documents'), 'hive')
  const imagesDir = (): string => join(app.getPath('userData'), 'data', 'images')
  const updatesDir = (): string => join(app.getPath('userData'), 'data', 'updates')
  const importedMediaDir = (): string => join(app.getPath('userData'), 'data', 'imported-media')
  const stickersDir = (): string => join(app.getPath('userData'), 'data', 'stickers')
  const imageThumbnailsDir = (): string => join(app.getPath('userData'), 'data', 'image-thumbnails')
  const avatarsDir = (): string => join(app.getPath('userData'), 'data', 'avatars')
  const dataRoot = (): string => join(app.getPath('userData'), 'data')
  const managedMediaRoots = (): string[] => [imagesDir(), importedMediaDir(), stickersDir()]
  const managedStickerRoots = (): string[] => [stickersDir(), importedMediaDir()]
  const imagePreview = new ImagePreviewService(imageThumbnailsDir())
  const avatarStore = new AvatarStore(avatarsDir())

  function broadcastAvatarReady(hash: string): void {
    if (!isAvatarHash(hash)) return
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcEvents.avatarReady, hash)
    }
  }

  function referencedAvatarHashes(): string[] {
    const hashes = new Set<string>()
    const selfHash = appState?.config.avatarHash
    if (isAvatarHash(selfHash)) hashes.add(selfHash)
    for (const record of registry?.values() ?? []) {
      if (isAvatarHash(record.profile.avatarHash)) hashes.add(record.profile.avatarHash)
    }
    for (const group of groupRepo?.list() ?? []) {
      if (isAvatarHash(group.avatarHash)) hashes.add(group.avatarHash)
    }
    return [...hashes]
  }

  function scheduleAvatarPrune(): void {
    if (avatarPruneTimer) clearTimeout(avatarPruneTimer)
    avatarPruneTimer = setTimeout(() => {
      avatarPruneTimer = null
      void avatarStore.prune(referencedAvatarHashes())
    }, 1_000)
    avatarPruneTimer.unref?.()
  }

  function avatarMime(
    format: 'png' | 'jpeg' | 'webp' | 'bmp'
  ): Extract<AvatarSourcePick, { ok: true }>['mime'] {
    if (format === 'jpeg') return 'image/jpeg'
    if (format === 'png') return 'image/png'
    if (format === 'bmp') return 'image/bmp'
    return 'image/webp'
  }

  async function stageOutgoingImagePath(sourcePath: string): Promise<string | null> {
    try {
      const ext = IMAGE_EXTS.has(extname(sourcePath).toLowerCase())
        ? extname(sourcePath).toLowerCase()
        : DEFAULT_IMAGE_EXTENSION
      const dir = join(imagesDir(), 'out')
      await mkdir(dir, { recursive: true })
      const staged = join(dir, `${randomUUID()}${ext}`)
      await copyFile(sourcePath, staged)
      return staged
    } catch {
      return null
    }
  }

  function parseImageSendTarget(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null
  }

  function parseImageSendName(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null
  }

  function parseImageSendBytes(value: unknown): ArrayBuffer | null {
    if (!(value instanceof ArrayBuffer) || value.byteLength === 0) return null
    return value.byteLength <= IMAGE_SEND_MAX_BYTES ? value : null
  }

  function parseImageOfferPath(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null
    return IMAGE_EXTS.has(extname(value).toLowerCase()) ? value : null
  }

  function outgoingImageExt(name: string): string {
    const ext = extname(name).toLowerCase()
    return IMAGE_EXTS.has(ext) ? ext : DEFAULT_IMAGE_EXTENSION
  }

  async function stageImageBytes(name: string, bytes: ArrayBuffer): Promise<string> {
    const dir = join(imagesDir(), 'out')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${randomUUID()}${outgoingImageExt(name)}`)
    await writeFile(path, Buffer.from(bytes))
    return path
  }

  type OfferImagePaths = (
    targetId: string,
    paths: string[],
    want: 'file' | 'image',
    tableTextMeta?: TableTextMeta
  ) => Promise<MessageView | null> | undefined

  async function handleImageBytes(
    target: unknown,
    nameValue: unknown,
    bytesValue: unknown,
    tableText: unknown,
    offer: OfferImagePaths
  ): Promise<MessageView | null> {
    const targetId = parseImageSendTarget(target)
    const name = parseImageSendName(nameValue)
    const bytes = parseImageSendBytes(bytesValue)
    if (!targetId || !name || !bytes) return null
    const tableTextMeta = parseTableTextMeta(tableText)
    if (tableTextMeta === null) return null
    const want = imagePreview.isInlineNamedBytes(name, bytes) ? 'image' : 'file'
    const path = await stageImageBytes(name, bytes)
    return (await offer(targetId, [path], want, want === 'image' ? tableTextMeta : undefined)) ?? null
  }

  async function handleImagePath(
    senderId: number,
    target: unknown,
    pathValue: unknown,
    offer: OfferImagePaths
  ): Promise<MessageView | null> {
    const targetId = parseImageSendTarget(target)
    const path = parseImageOfferPath(pathValue)
    if (!targetId || !path) return null
    if (!rendererPathGrants.consume(senderId, [path])) return null
    const staged = await stageOutgoingImagePath(path)
    if (!staged) return null
    const want = (await imagePreview.inspectInlinePath(staged)) ? 'image' : 'file'
    return (await offer(targetId, [staged], want)) ?? null
  }

  function managedTransferMediaView(transferId: string): TransferView | null {
    const view = files?.transferView(transferId)
    if (!view?.savedPath) return null
    // 接收方的图要下载完（done）才落盘存在；发送方的图自始在本地受管目录，
    // 传输未完成（offering/accepted）也应能即时预览——否则发图瞬间取图被拒 → broken（issue #3，决议 #165）。
    if (view.direction === 'in' && view.status !== 'done') return null
    const msg = msgRepoRef?.get(view.msgId)
    if (!msg || (msg.kind !== 'image' && msg.kind !== 'sticker')) return null
    if (!isPathInsideAny(view.savedPath, managedMediaRoots())) return null
    return view
  }

  async function managedInlineImageView(
    transferId: string
  ): Promise<{ view: TransferView; width: number; height: number; animated: boolean } | null> {
    const view = managedTransferMediaView(transferId)
    if (!view) return null
    const metadata = await imagePreview.inspectInlinePath(view.savedPath)
    if (!metadata) return null
    return {
      view,
      width: metadata.width,
      height: metadata.height,
      animated: metadata.animated
    }
  }

  async function readStickerSource(path: string): Promise<ImageSourceBytes | null> {
    try {
      const buf = await readFile(path)
      if (buf.length === 0 || buf.length > IMAGE_SOURCE_MAX_BYTES) return null
      const metadata = imagePreview.isInlineNamedBytes(path, buf)
      if (!metadata) return null
      return {
        bytes: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        ext: extname(path).toLowerCase() || '.png',
        width: metadata.width,
        height: metadata.height,
        animated: metadata.animated
      }
    } catch {
      return null
    }
  }

  function showMainWindow(options: { forceForeground?: boolean } = {}): void {
    if (!mainWindow) return
    showWindowForeground(mainWindow, options)
  }

  function clearNudgeShake(restore: boolean): void {
    for (const timer of nudgeShakeTimers) clearTimeout(timer)
    nudgeShakeTimers = []
    if (restore && nudgeShakeOrigin && mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.setPosition(nudgeShakeOrigin[0], nudgeShakeOrigin[1])
      } catch {
        // 窗口可能正在销毁或由系统接管位置；震动是提示，不影响主流程。
      }
    }
    nudgeShakeOrigin = null
  }

  function fallbackNudgeAttention(win: BrowserWindow): void {
    if (process.platform === 'darwin') app.dock?.bounce('informational')
    else win.flashFrame(true)
  }

  function shakeMainWindowForNudge(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    showMainWindow({ forceForeground: true })
    const win = mainWindow
    if (win.isMaximized() || win.isFullScreen()) {
      fallbackNudgeAttention(win)
      return
    }

    clearNudgeShake(true)
    const [originX, originY] = win.getPosition()
    nudgeShakeOrigin = [originX, originY]
    const offsets = [0, 12, -10, 8, -6, 4, -2, 0]
    nudgeShakeTimers = offsets.map((dx, index) => {
      const timer = setTimeout(() => {
        if (!mainWindow || win.isDestroyed()) {
          clearNudgeShake(false)
          return
        }
        try {
          win.setPosition(originX + dx, originY)
        } catch {
          clearNudgeShake(false)
          return
        }
        if (index === offsets.length - 1) {
          nudgeShakeTimers = []
          nudgeShakeOrigin = null
        }
      }, index * 45)
      timer.unref?.()
      return timer
    })
  }

  function mainWindowTitle(): string {
    const nick = appState?.config.setupDone ? appState.config.nick.trim() : ''
    return nick ? `${nick}-Hive` : tr('Hive')
  }

  function updateMainWindowTitle(): void {
    mainWindow?.setTitle(mainWindowTitle())
  }

  function currentLocalIpv4(): string {
    for (const list of Object.values(networkInterfaces())) {
      for (const addr of list ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address
      }
    }
    return '127.0.0.1'
  }

  function toggleMainWindow(): void {
    if (!mainWindow) return
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide()
      return
    }
    showMainWindow()
  }

  function syncMainWindowZoom(): void {
    applyWindowZoom(mainWindow?.webContents, settingsView().fontScale)
  }

  /**
   * 多窗口共享的事件（决议 #283）：文件柜窗口同样要节点在线状态与传输进度，
   * 否则它的同事列表与进度行只能靠轮询。未订阅的窗口收到即丢弃，成本可忽略。
   */
  function broadcastEvent(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, payload)
    }
  }

  function broadcastSettings(): SettingsView {
    const view = settingsView()
    syncMainWindowZoom()
    syncSettingsWindowZoom(view.fontScale)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IpcEvents.settingsUpdated, view)
    }
    return view
  }

  function normalizeShortcut(input: unknown): string | null {
    if (typeof input !== 'string') return null
    const value = input.trim()
    if (value.length > 64) return null
    // Electron accelerator 只需字母、数字、空格、+、-；空串表示禁用。
    return /^[A-Za-z0-9+\- ]*$/.test(value) ? value : null
  }

  function normalizeExportOptions(input: unknown): DataExportOptions | undefined {
    if (typeof input !== 'object' || input === null) return undefined
    const raw = input as Record<string, unknown>
    const out: DataExportOptions = {}
    if (typeof raw.convId === 'string' && raw.convId.length > 0 && raw.convId.length <= 128) {
      out.convId = raw.convId
    }
    if (typeof raw.fromTs === 'number' && Number.isFinite(raw.fromTs) && raw.fromTs >= 0) {
      out.fromTs = Math.floor(raw.fromTs)
    }
    if (typeof raw.toTs === 'number' && Number.isFinite(raw.toTs) && raw.toTs >= 0) {
      out.toTs = Math.floor(raw.toTs)
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  function normalizeConversationSearch(input: unknown): ConversationSearchOptions | null {
    if (typeof input !== 'object' || input === null) return null
    const raw = input as Record<string, unknown>
    if (typeof raw.convId !== 'string' || raw.convId.length === 0 || raw.convId.length > 128) {
      return null
    }
    if (typeof raw.query !== 'string' || raw.query.length > 128) return null
    const kind =
      raw.kind === 'image' || raw.kind === 'file' || raw.kind === 'all' ? raw.kind : 'all'
    const out: ConversationSearchOptions = {
      convId: raw.convId,
      query: raw.query,
      kind
    }
    if (typeof raw.fromTs === 'number' && Number.isFinite(raw.fromTs) && raw.fromTs >= 0) {
      out.fromTs = Math.floor(raw.fromTs)
    }
    if (typeof raw.toTs === 'number' && Number.isFinite(raw.toTs) && raw.toTs >= 0) {
      out.toTs = Math.floor(raw.toTs)
    }
    if (typeof raw.limit === 'number' && Number.isInteger(raw.limit)) {
      out.limit = Math.max(1, Math.min(raw.limit, 100))
    }
    return out
  }

  /** 全局快捷键注册结果（决议 #57）：随 SettingsView 回传，设置页据此提示"被系统占用" */
  const shortcutStatus = { capture: true, showHide: true }

  function tryRegisterShortcut(accelerator: string, handler: () => void, label: string): boolean {
    try {
      const ok = globalShortcut.register(accelerator, handler)
      if (!ok) console.warn(`[shortcut] ${label}快捷键注册失败（可能被系统占用）：`, accelerator)
      return ok
    } catch {
      // 非法 accelerator（手填旧配置/导入数据）不致命，按注册失败处理
      console.warn(`[shortcut] ${label}快捷键格式无效：`, accelerator)
      return false
    }
  }

  function registerGlobalShortcuts(): void {
    const cfg = appState?.config
    if (!cfg) return
    globalShortcut.unregisterAll()
    const captureShortcut = cfg.captureShortcut.trim()
    shortcutStatus.capture = captureShortcut
      ? tryRegisterShortcut(captureShortcut, () => void startCapture(), '截图')
      : true
    const showHideShortcut = cfg.showHideShortcut.trim()
    shortcutStatus.showHide = showHideShortcut
      ? tryRegisterShortcut(showHideShortcut, () => toggleMainWindow(), '显示/隐藏')
      : true
  }

  function applyAutoLaunch(enabled: boolean): void {
    if (process.env['PANTRY_SMOKE']) return
    if (!app.isPackaged) return
    try {
      if (process.platform === 'linux') {
        const dir = join(app.getPath('home'), '.config', 'autostart')
        const file = join(dir, 'pantry.desktop')
        if (!enabled) {
          rmSync(file, { force: true })
          return
        }
        mkdirSync(dir, { recursive: true })
        const content = [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Hive',
          `Exec="${process.execPath}"`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          ''
        ].join('\n')
        // 内容未变则跳过写入：此前每次启动无条件重写 autostart 文件，
        // UOS/部分桌面会检测到写入并弹"Hive 正在设置开机自启动"提示（决议 #79）
        const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
        if (existing !== content) writeFileSync(file, content)
        return
      }
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
    } catch (err) {
      console.warn('[system] 开机自启设置失败：', err)
    }
  }

  /**
   * #57 成员派遣面（成员表列 + 派遣网络图共用）：
   * 目标（冻结目标 > 负担上报 goal）· 派遣者（registry.spawnedBy）· 深度（派遣账本）·
   * 主人（registry.ownerId）· 群内权限（第一个共同群的底座角色）。
   * 任一面缺失都不阻塞：底座节点返回 undefined，UI 按普通成员渲染。
   */
  function hiveViewFor(nodeId: string): PeerHiveView | undefined {
    const registryRecord = memberRegistry?.get(nodeId)
    const burden = agentStatus?.viewFor(nodeId, agentStatus.sharedPeerIds())
    const goalRecord = pendingService?.allGoals().find((g) => g.memberId === nodeId && g.text)
    // 权限取「与本机共同的第一个群」里的底座角色；跨群成员以该群为准（演示面不展开多群歧义）。
    let role: 'owner' | 'admin' | 'member' = 'member'
    for (const meta of groupRepo?.list() ?? []) {
      if (!meta.members.includes(nodeId) || !meta.members.includes(appState?.nodeId ?? '')) continue
      role = meta.ownerId === nodeId ? 'owner' : meta.adminIds.includes(nodeId) ? 'admin' : 'member'
      break
    }
    // 深度 = 派遣账本里该成员所属 started 记录的 depth；常驻 = 1。
    const dispatchRecord = dispatchStore
      ?.snapshot()
      .dispatches.find((d) => d.outcome === 'started' && d.memberIds.includes(nodeId))
    const kind = registryRecord?.kind === 'dispatched' ? 'dispatched' : 'resident'
    const depth = dispatchRecord?.depth ?? 1
    const dispatcherId = registryRecord?.spawnedBy ?? ''
    const goal = goalRecord?.text ?? burden?.goal ?? ''
    if (!goal && kind === 'resident' && !registryRecord && role === 'member') return undefined
    return { goal, dispatcherId, depth, kind, ownerId: registryRecord?.ownerId ?? '', role }
  }

  function toPeerView(record: PeerRecord, shared?: Set<string>): PeerView {
    return {
      nodeId: record.profile.nodeId,
      nick: record.profile.nick,
      remark: remarks.get(record.profile.nodeId) ?? '',
      company: record.profile.company,
      dept: record.profile.dept,
      team: record.profile.team,
      avatar: record.profile.avatar,
      avatarHash: record.profile.avatarHash ?? '',
      host: record.profile.host,
      platform: record.profile.platform,
      ip: record.ip,
      online: record.online,
      lastSeen: record.lastSeen,
      ver: record.profile.ver,
      caps: Array.isArray(record.profile.caps) ? record.profile.caps : [],
      ...(agentStatus
        ? { burden: agentStatus.viewFor(record.profile.nodeId, shared ?? agentStatus.sharedPeerIds()) }
        : {}),
      ...(() => {
        const hive = hiveViewFor(record.profile.nodeId)
        return hive ? { hive } : {}
      })()
    }
  }

  function resolvePeerDisplayName(nodeId: string): string {
    const remark = remarks.get(nodeId)?.trim()
    if (remark) return remark
    return registry?.get(nodeId)?.profile.nick.trim() ?? ''
  }

  function peerViews(): PeerView[] {
    if (!registry) return []
    // 共享群集合整表算一次：同为 31 节点时逐行 listGroups() 会退化成 O(n×m)。
    const shared = agentStatus?.sharedPeerIds()
    return registry.list().map((record) => toPeerView(record, shared))
  }

  /** 局域网自更新（决议 #166）：在线节点里同平台、更高版本、可作源的最佳更新来源，无则 null。 */
  function currentUpdateSource(): ReturnType<typeof pickUpdateSource> {
    if (!appState || !registry) return null
    const self = { version: appState.profile.ver, platform: appState.profile.platform }
    const candidates = registry.values().map((r) => ({
      profile: r.profile,
      online: r.online,
      displayName: resolvePeerDisplayName(r.profile.nodeId)
    }))
    return pickUpdateSource(self, candidates)
  }

  /** 局域网自更新（决议 #166）：在线节点里同平台、更高版本、可作源的最佳更新来源，无则 null。 */
  function currentUpdateAvailability(): UpdateAvailability | null {
    if (!appState) return null
    const self = { version: appState.profile.ver, platform: appState.profile.platform }
    const src = currentUpdateSource()
    if (!src) return null
    return {
      nodeId: src.nodeId,
      fromName: src.fromName,
      version: src.version,
      currentVersion: self.version
    }
  }

  async function requestUpdatePackage(): Promise<boolean> {
    if (!appState || !messenger) return false
    const src = currentUpdateSource()
    if (!src) return false
    const arch = currentRuntimeArch()
    const token = updateRequestGate.begin({
      nodeId: src.nodeId,
      version: src.version,
      platform: src.platform,
      arch
    })
    try {
      const ok = await messenger.sendReliable(
        src.nodeId,
        makeEnvelope<UpdateReqPayload>(MSG_TYPES.update, appState.nodeId, {
          op: 'req',
          platform: appState.profile.platform,
          arch
        })
      )
      if (!ok) updateRequestGate.cancel(token)
      return ok
    } catch {
      updateRequestGate.cancel(token)
      return false
    }
  }

  function currentProtocolPlatform(): Platform {
    if (process.platform === 'win32') return 'win'
    if (process.platform === 'darwin') return 'mac'
    return 'linux'
  }

  function currentRuntimeArch(): RuntimeArch {
    if (process.arch === 'arm64') return 'arm64'
    if (process.arch === 'ia32') return 'ia32'
    return 'x64'
  }

  function updatePackagePath(version: string, platform: Platform, arch = currentRuntimeArch()): string | null {
    return findLocalUpdatePackage({
      dirs: [updatesDir(), join(app.getAppPath(), 'release')],
      version,
      platform,
      arch
    })
  }

  function canAdvertiseUpdateSource(): boolean {
    if (
      !canServeUpdates({
        platform: process.platform,
        isPackaged: app.isPackaged,
        env: process.env
      })
    ) {
      return false
    }
    return updatePackagePath(app.getVersion(), currentProtocolPlatform()) !== null
  }

  function handleUpdateRequest(env: Envelope<UpdateReqPayload>): void {
    if (!appState || !files || !registry) return
    const peer = registry.get(env.from)
    if (
      !shouldServeUpdateRequest(
        { version: appState.profile.ver, platform: appState.profile.platform },
        peer ?? null,
        env.payload.platform
      )
    ) {
      return
    }
    const packagePath = updatePackagePath(
      appState.profile.ver,
      appState.profile.platform,
      env.payload.arch ?? currentRuntimeArch()
    )
    if (!packagePath) return
    void files.offerUpdatePackage(env.from, packagePath)
  }

  /**
   * 共享文件柜控制面（§8.2）：应答对端的 list / get，并把 list-ok / deny 交回本机等待中的请求。
   * 权限、路径、限流全部由 ShareService 判定，这里只做转发与超时收口。
   */
  function handleShareCtl(env: Envelope<SharePayload>): void {
    const payload = env.payload
    if (payload.op === 'list-ok' || payload.op === 'deny') {
      const settle = sharePending.get(payload.reqId)
      if (settle) {
        sharePending.delete(payload.reqId)
        settle(payload)
      }
      return
    }
    if (!share || !messenger) return
    if (payload.op === 'list') {
      const reply = share.handleList(env.from, payload)
      void messenger.sendReliable(env.from, makeEnvelope(MSG_TYPES.share, selfNodeId(), reply))
      return
    }
    if (payload.op === 'get') {
      const result = share.handleGet(env.from, payload.paths)
      if (!result.ok) {
        void messenger.sendReliable(
          env.from,
          makeEnvelope(MSG_TYPES.share, selfNodeId(), {
            op: 'deny',
            reqId: payload.reqId,
            reason: result.reason
          } satisfies SharePayload)
        )
        return
      }
      // 日志只记条目数，不记文件名与目录内容（决议 #6/#276）
      console.log(`[share] 应答下载请求：${result.absPaths.length} 项`)
      void files?.offerSharePaths(env.from, result.absPaths)
    }
  }

  /** 对端 share-get offer 已到，提前结束对应的 get 等待 */
  function settleShareGet(peerId: string): void {
    const reqId = shareGetReq.get(peerId)
    if (!reqId) return
    shareGetReq.delete(peerId)
    const settle = sharePending.get(reqId)
    if (!settle) return
    sharePending.delete(reqId)
    settle(null)
  }

  /** 上传前先在本机量一遍：递归统计文件数与总字节，读不到返回 null。 */
  function selfNodeId(): string {
    return appState?.nodeId ?? ''
  }

  /** 发一条 share 请求并等应答；超时返回 null，由调用方给出可重试的提示。 */
  async function requestShare(
    peerId: string,
    payload: SharePayload
  ): Promise<SharePayload | null> {
    if (!messenger) return null
    const waiter = new Promise<SharePayload | null>((resolve) => {
      sharePending.set(payload.reqId, resolve)
      setTimeout(() => {
        if (sharePending.delete(payload.reqId)) resolve(null)
      }, SHARE_REQ_TIMEOUT).unref?.()
    })
    const sent = await messenger.sendReliable(
      peerId,
      makeEnvelope(MSG_TYPES.share, selfNodeId(), payload)
    )
    if (!sent) {
      sharePending.delete(payload.reqId)
      return null
    }
    return waiter
  }

  function scanRangeItems(): SettingsView['scanRangeItems'] {
    const c = appState?.config
    if (!c) return []
    const sources = c.scanRangeSources ?? {}
    const onlinePeers = registry ? registry.values().filter((p) => p.online) : []
    return c.scanRanges.map((cidr) => {
      const source = sources[cidr] ?? { source: 'self' as const, addedAt: Date.now() }
      return {
        cidr,
        source: source.source,
        sourceNodeId: source.sourceNodeId,
        sourceName: source.sourceName,
        addedAt: source.addedAt,
        lastAutoScanAt: source.lastAutoScanAt,
        nodeCount: onlinePeers.filter((p) => ipInCidr(p.ip, cidr)).length
      }
    })
  }

  function sharedScanRanges(): ScanRangeSummary[] {
    const c = appState?.config
    if (!c) return []
    const ignored = c.ignoredScanRanges ?? {}
    const sources = c.scanRangeSources ?? {}
    const now = Date.now()
    const seen = new Set<string>()
    const ranges: ScanRangeSummary[] = []
    for (const raw of c.scanRanges) {
      const cidr = normalizeCidr(raw)
      if (!cidr || ignored[cidr] || seen.has(cidr)) continue
      seen.add(cidr)
      ranges.push({ cidr, addedAt: sources[cidr]?.addedAt ?? now })
    }
    return ranges
  }

  function collectGlobalScanHosts(): { hosts: string[]; rangeCount: number } {
    const c = appState?.config
    if (!c) return { hosts: [], rangeCount: 0 }
    return buildCidrHostPlan(c.scanRanges)
  }

  function emitGlobalScanProgress(force = false): void {
    const now = Date.now()
    if (
      !force &&
      globalScanProgress.running &&
      now - lastGlobalScanProgressPushAt < GLOBAL_SCAN_PROGRESS_PUSH_INTERVAL
    ) {
      return
    }
    lastGlobalScanProgressPushAt = now
    mainWindow?.webContents.send(IpcEvents.netScanProgress, globalScanProgress)
  }

  function setGlobalScanProgress(patch: Partial<ScanProgressView>, force = false): ScanProgressView {
    globalScanProgress = { ...globalScanProgress, ...patch }
    emitGlobalScanProgress(force)
    return globalScanProgress
  }

  function startGlobalRangeScan(): ScanProgressView {
    if (globalScanProgress.running) return globalScanProgress
    if (!discovery || !appState) {
      globalScanSeq += 1
      return setGlobalScanProgress(
        {
          scanId: globalScanSeq,
          status: 'unavailable',
          running: false,
          done: 0,
          total: 0,
          rangeCount: 0,
          startedAt: Date.now(),
          finishedAt: Date.now()
        },
        true
      )
    }

    const { hosts, rangeCount } = collectGlobalScanHosts()
    globalScanSeq += 1
    const scanId = globalScanSeq
    const now = Date.now()
    setGlobalScanProgress(
      {
        scanId,
        status: hosts.length > 0 ? 'running' : 'empty',
        running: hosts.length > 0,
        done: 0,
        total: hosts.length,
        rangeCount,
        startedAt: now,
        finishedAt: hosts.length > 0 ? 0 : now
      },
      true
    )
    if (hosts.length === 0) return globalScanProgress

    discovery.scanHosts(hosts, udpPort, 8, {
      key: 'global',
      onProgress: (done) => setGlobalScanProgress({ done }),
      onComplete: () => setGlobalScanProgress({
        status: 'done', running: false, done: hosts.length, finishedAt: Date.now()
      }, true)
    })
    return globalScanProgress
  }

  function acceptSharedScanRanges(fromNodeId: string, ranges: ScanRangeSummary[]): void {
    const state = appState
    if (!state) return
    const sourceName = resolvePeerDisplayName(fromNodeId) || tr('同事')
    const accepted = addSharedScanRanges(state, ranges, {
      nodeId: fromNodeId,
      name: sourceName
    })
    if (accepted.length === 0) return
    rangeScanner?.sync()
    broadcastSettings()
  }

  async function startNet(): Promise<void> {
    let tcpReady = false
    const state = appState
    if (!state) return
    // 手动节点 = 环境变量（联调用）∪ 设置持久化（F-DISC-2 第一板斧）
    const allManual: ManualPeer[] = [
      ...manualPeers,
      ...state.config.manualPeers.map((item) => {
        const [host, port] = item.split(':')
        return { host, port: Number(port) || udpPort }
      })
    ]
    const udp = new UdpChannel({ port: udpPort, ...(process.env['PANTRY_SMOKE'] ? { bindAddress: '127.0.0.1', broadcastTargets: [] } : {}) })
    registry = new PeerRegistry(state.nodeId)
    // 时钟偏移矫正（决议 #65）：发现层观测各节点时钟差，chat/groups 显示时矫正到本机钟
    const peerClock = new PeerClock()
    // #53：孤儿清理要等「节点整体死亡」，自然口径是 presence 失联 90s。允许本机联调/验收整体
    // 压缩这套时序（三个参数同轴，单独压 offlineAfter 会让所有对端假离线）。
    const ms = (raw: string | undefined): number | null => {
      const n = Number(raw)
      return raw && Number.isInteger(n) && n > 0 && n <= 3_600_000 ? n : null
    }
    const offlineAfterMs = ms(process.env['PANTRY_OFFLINE_AFTER_MS'])
    const presenceIntervalMs = ms(process.env['PANTRY_PRESENCE_INTERVAL_MS'])
    const sweepIntervalMs = ms(process.env['PANTRY_SWEEP_INTERVAL_MS'])
    discovery = new Discovery({
      udp,
      registry,
      profile: state.profile,
      manualPeers: allManual,
      peerClock,
      ...(offlineAfterMs || presenceIntervalMs || sweepIntervalMs
        ? {
            timings: {
              ...(offlineAfterMs ? { offlineAfter: offlineAfterMs } : {}),
              ...(presenceIntervalMs ? { presenceInterval: presenceIntervalMs } : {}),
              ...(sweepIntervalMs ? { sweepInterval: sweepIntervalMs } : {})
            }
          }
        : {})
    })
    rangeSync = new RangeSync({
      udp,
      registry,
      selfId: state.nodeId,
      getRanges: sharedScanRanges,
      acceptRanges: acceptSharedScanRanges
    })

    // 存储层降级链：文件库 → 内存库（功能照常、不持久）→ 全不可用则只剩发现功能
    try {
      db = openDatabase(join(app.getPath('userData'), 'data', 'db', 'chat.db'))
      databaseMode = 'file'
      diagnostics.record('store.open', { status: 'ready', kind: 'file' })
    } catch (err) {
      diagnostics.record('store.open', { status: 'failed', kind: 'file' }, err)
      console.error('[store] 文件库打开失败，尝试内存库：', err)
      try {
        db = openMemoryDatabase()
        databaseMode = 'memory'
        diagnostics.record('store.open', { status: 'ready', kind: 'memory' })
      } catch (err2) {
        diagnostics.record('store.open', { status: 'failed', kind: 'memory' }, err2)
        console.error('[store] 内存库也不可用，本次会话仅发现功能：', err2)
      }
    }
    if (db) {
      peersRepo = new PeersRepo(db)
      groupRepo = new GroupRepo(db)
      registry.seed(peersRepo.loadAll()) // 历史联系人以离线态回灌（F-DISC-7）
      for (const [id, remark] of peersRepo.loadRemarks()) remarks.set(id, remark)

      messenger = new Messenger({
        udp,
        registry,
        selfId: state.nodeId,
        queue: new QueueRepo(db),
        dedup: new DedupRepo(db)
      })
      messenger.on('incoming', (env: Envelope, source?: { address: string }) => {
        if (env.type === MSG_TYPES.update) handleUpdateRequest(env as Envelope<UpdateReqPayload>)
        else if (env.type === MSG_TYPES.share) handleShareCtl(env as Envelope<SharePayload>)
        else if (env.type === MSG_TYPES.screen && source) remoteView.service?.receive(env.from, source.address, env.payload as ScreenPayload)
      })
      remoteView.attach({
        selfId: state.nodeId,
        peer: id => {
          const peer = registry?.get(id)
          return peer ? { ip: peer.ip, tcpPort: peer.profile.tcpPort, online: peer.online,
            name: resolvePeerDisplayName(id) || peer.profile.nick, caps: peer.profile.caps } : null
        },
        send: (id, payload, bestEffort, signal) => {
          const env = makeEnvelope(MSG_TYPES.screen, state.nodeId, payload)
          if (bestEffort) { messenger!.sendBestEffort(id, env); return Promise.resolve(true) }
          return messenger!.sendReliable(id, env, signal)
        }
      })
      const chatMessages = new MsgRepo(db)
      chatMessages.interruptScreenRecords()
      chat = new ChatService({
        selfId: state.nodeId,
        convRepo: new ConvRepo(db),
        msgRepo: chatMessages,
        groupRepo,
        messenger,
        peerClock,
        isOnline: (peerId) => registry?.get(peerId)?.online === true,
        probe: (peerId) => {
          discovery?.probeNode(peerId) // 打开会话 → 探活（F-DISC-8）
        },
        mediaRecall: {
          canRecall: (row) => files?.canRecallMessage(row.id) ?? false,
          applyLocalRecall: (row) => {
            files?.applyRecallMessage(row.id)
          },
          applyIncomingRecall: (row) => files?.applyRecallMessage(row.id) ?? false
        }
      })
      const onMessage = (msg: MessageView): void => {
        diagnostics.record('message.state', { id: msg.id, status: msg.status, kind: msg.kind })
        mainWindow?.webContents.send(IpcEvents.msgNew, msg)
        notifyIncoming(msg)
      }
      const onStatus = (ev: { id: string; status: string }): void => {
        diagnostics.record('message.state', { id: ev.id, status: ev.status })
        mainWindow?.webContents.send(IpcEvents.msgStatus, ev)
      }
      const onNudge = (ev: NudgeEvent): void => {
        mainWindow?.webContents.send(IpcEvents.nudgeReceived, ev)
        shakeMainWindowForNudge()
      }
      const onConvs = (convs: Array<{ unread: number }>): void => {
        mainWindow?.webContents.send(IpcEvents.convsUpdated, convs)
        const total = convs.reduce((sum, c) => sum + c.unread, 0)
        updateTrayUnread(tray, mainWindow, total)
      }
      chat.on('message', onMessage)
      chat.on('message-updated', (msg: MessageView) => mainWindow?.webContents.send(IpcEvents.msgUpdated, msg))
      remoteView.service!.on('history', (state, initial) => {
        diagnostics.record('screen.state', { sessionId: state.sessionId, peerId: state.peerId, host: state.peerIp,
          role: state.role, stage: state.phase, mode: state.mode, fps: state.targetFps, reason: state.reason, durationMs: state.durationMs })
        try { chat?.recordScreen(state, initial) }
        catch { console.error('[screen] 协助记录保存失败') }
      })
      chat.on('status', onStatus)
      chat.on('nudge', onNudge)
      chat.on('convs', onConvs)
      onConvs(chat.listConversations())

      files = new FilesService({
        diagnostic: diagnostics.record,
        openScreen: (socket, frame) => remoteView.service?.open(socket, frame) ?? null,
        selfId: state.nodeId,
        messenger,
        registry,
        convRepo: new ConvRepo(db),
        msgRepo: new MsgRepo(db),
        transferRepo: new TransferRepo(db),
        groupRepo,
        tcpPort,
        ...(process.env['PANTRY_SMOKE'] ? { bindAddress: '127.0.0.1' } : {}),
        getSaveDir: () =>
          appState?.config.fileDir || defaultFileDir(),
        getImagesDir: imagesDir,
        getUpdateDir: updatesDir,
        authorizeUpdateOffer: (peerId, name, totalSize) =>
          updateRequestGate.consume(peerId, name, totalSize),
        authorizeShareUpload: (peerId, totalSize) =>
          share?.handlePut(peerId, totalSize, resolvePeerDisplayName(peerId) || peerId) ?? null,
        authorizeShareDownload: (peerId) => {
          const dir = shareDownloadGate.consume(peerId)
          // 传输已开始即视为请求成功，立刻唤醒 share:download，不必干等超时
          if (dir !== null) settleShareGet(peerId)
          return dir
        },
        allowDirectFileSend: () => appState?.config.allowDirectFileSend !== false,
        peerDisplayName: resolvePeerDisplayName
      })
      files.on('message', onMessage)
      files.on('status', onStatus)
      files.on('convs', onConvs)
      files.on('transfer', (view) => broadcastEvent(IpcEvents.transferUpdated, view))
      try {
        await files.start() // TCP 数据端口
        tcpReady = true
        tcpStatus = 'ready'
        diagnostics.record('network.listen', { kind: 'tcp', port: tcpPort, status: 'ready' })
      } catch (err) {
        tcpStatus = 'failed'
        diagnostics.record('network.listen', { kind: 'tcp', port: tcpPort, status: 'failed' }, err)
        console.error('[files] TCP 端口监听失败，文件发送可用但无法被拉取：', err)
      }

      groups = new GroupsService({
        selfId: state.nodeId,
        messenger,
        convRepo: new ConvRepo(db),
        msgRepo: new MsgRepo(db),
        groupRepo,
        getSelfIp: currentLocalIpv4,
        peerClock,
        isOnline: (nodeId) => registry?.get(nodeId)?.online === true,
        resolveDisplayName: resolvePeerDisplayName
      })
      groups.on('message', onMessage)
      if (onGroupsReady) {
        onGroupsReady(groups)
        onGroupsReady = null
      }
      startAgentBridge(groups)
      startDispatchService(groups) // #51：派遣编排（Agent 经 POST /v1/dispatch 调用）
      groups.on('convs', onConvs)
      // Hive #53 AC2：本节点**被移出群**（不是自己 leaveGroup）→ 收工退出进程。
      // headless 节点就是一个成员进程，被移出即生命周期结束；GUI 节点是人的客户端，只离群不退 app。
      // 退出走既有 before-quit 链（补发队列落库、exit 广播），不另开第二套退出通道。
      groups.on('removed', (groupId: string, actorId: string) => {
        console.log(`[hive] 本节点已被移出群 ${groupId}（操作者 ${actorId}）`)
        if (!HEADLESS) return
        console.log('[hive] headless 成员节点被移出，退出进程')
        isQuitting = true
        // 此刻还在 UDP 收包回调里，同步进 before-quit 链会走不完；让出一轮事件循环再退。
        setImmediate(() => app.quit())
      })
      groups.on('group', (view) => {
        mainWindow?.webContents.send(IpcEvents.groupUpdated, view)
        void avatars?.ensureGroup(view.groupId)
        scheduleAvatarPrune()
        // 群成员变化会改变「同群 ∩ ag1」目标集：可见边界即时报废，不等下一个 registry 心跳。
        agentStatus?.recompute()
      })

      // 跨机 agent 状态通道（#47 / ADR-0009）：10s 节拍、30s TTL、只对同群 ag1 在线节点单播。
      agentStatus = new AgentStatusService({
        selfId: state.nodeId,
        envelopes: udp,
        peers: registry,
        groups,
        sender: messenger,
        onChanged: () => broadcastEvent(IpcEvents.peersUpdated, peerViews()),
        log: (line) => console.log(line)
      })
      const producer = parseProducerSpec(process.env['PANTRY_AGENT_STATUS'] ?? '', Date.now())
      agentStatus.setLocalReport(producer?.report ?? null, producer?.forMs ?? 0)
      agentStatus.start()
      localApi?.attachEventSource('burden.updated', agentStatus)

      avatars = new AvatarService({
        selfId: state.nodeId,
        messenger,
        registry,
        groupRepo,
        store: avatarStore,
        getSelfProfile: () => state.profile
      })
      avatars.on('ready', (hash: string) => broadcastAvatarReady(hash))
      avatars.ensureAll()
      scheduleAvatarPrune()

      forward = new ForwardService({
        msgRepo: new MsgRepo(db),
        chat,
        groups,
        files,
        canInlineImage: async (path) => Boolean(await imagePreview.inspectInlinePath(path))
      })
      porter = new PorterService(
        db,
        state.nodeId,
        state.config.nick,
        importedMediaDir(),
        [imagesDir(), stickersDir()],
        avatarsDir(),
        state.config.avatarHash
      )
      search = new SearchService(db, registry, (id) => remarks.get(id) ?? '')
      msgRepoRef = new MsgRepo(db)
      stickerRepo = new StickerRepo(db)
      shareGrantsRepo = new ShareGrantsRepo(db)
      share?.reload() // 库比 ShareService 晚就绪，此处回灌已保存的按人例外
      chat.prune() // 启动清理（过期队列/去重窗口），之后每小时一次
      pruneTimer = setInterval(() => chat?.prune(), 3_600_000)
      pruneTimer.unref?.()
    } else {
      tcpStatus = 'unavailable'
      diagnostics.record('network.listen', { kind: 'tcp', port: tcpPort, status: 'unavailable' })
    }

    // 注册表变化 → 节流 200ms 推给渲染层（tech-design §4 事件推送约定）
    let pushTimer: ReturnType<typeof setTimeout> | null = null
    registry.on('updated', () => {
      remoteView.service?.checkPeer()
      if (pushTimer) return
      pushTimer = setTimeout(() => {
        pushTimer = null
        broadcastEvent(IpcEvents.peersUpdated, peerViews())
        mainWindow?.webContents.send(IpcEvents.updateAvailable, currentUpdateAvailability())
        avatars?.ensureAll()
      }, 200)
      // 落库节流 1s：≤1000 行整表 upsert 在事务内毫秒级
      if (!persistTimer) {
        persistTimer = setTimeout(() => {
          persistTimer = null
          if (registry && peersRepo) peersRepo.upsertMany(registry.values())
        }, 1000)
      }
    })

    try {
      await udp.start()
      remoteView.setNetworkReady(tcpReady)
      discovery.start()
      rangeSync?.start()
      rangeScanner = new RangeScanScheduler({
        discovery, getState: () => appState, onlineCount: () => registry?.onlineCount() ?? 0,
        udpPort, onUpdated: broadcastSettings
      })
      rangeScanner.start()
      netState.ok = true
      diagnostics.record('network.listen', { kind: 'udp', port: udpPort, status: 'ready' })
    } catch (err) {
      // 端口被占等启动失败：进"离线模式"，窗口照常可用（tech-design §2）
      netState.ok = false
      diagnostics.record('network.listen', { kind: 'udp', port: udpPort, status: 'failed' }, err)
      netState.error = err instanceof Error ? err.message : String(err)
      console.error('[net] UDP 启动失败，进入离线模式：', netState.error)
    }
    mainWindow?.webContents.send(IpcEvents.netState, netState)
  }

  function reportCaptureFailure(
    reason: CaptureFailureReason,
    wasVisible: boolean,
    error?: unknown
  ): void {
    capturing = false
    captureStatus = reason
    diagnostics.record('capture.state', { status: 'failed', reason }, error)
    const notice = captureFailureNotice(reason, WAYLAND_SESSION)
    console.warn('[capture]', notice.message, error ?? '')

    const sendToMainWindow = (): boolean => {
      showMainWindow({ forceForeground: true })
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(IpcEvents.captureFailed, notice)
        return true
      }
      return false
    }

    // 原本可见时恢复主窗并走应用内提示；原本隐藏时尽量不打断用户，改用系统通知。
    if (wasVisible && sendToMainWindow()) return

    if (Notification.isSupported()) {
      try {
        const icon = systemNotificationIcon()
        new Notification({
          title: tr('Hive'),
          body: notice.message,
          ...(icon ? { icon } : {})
        }).show()
        return
      } catch (notificationError) {
        console.warn('[capture] 系统通知失败，改用主窗口提示：', notificationError)
      }
    }

    // 桌面环境不支持系统通知时显示主窗，保证全局快捷键失败也不会无声无息。
    sendToMainWindow()
  }

  /** 内置截图（F-CAP-1）：抓主屏 → 框选窗 → 剪贴板（可选直发当前会话） */
  async function startCapture(): Promise<void> {
    if (capturing) return
    capturing = true
    captureStatus = 'starting'
    diagnostics.record('capture.state', { status: 'starting' })
    await diagnostics.flush()
    const hide = appState?.config.hideOnCapture !== false
    const captureMainWindow = mainWindow
    const wasVisible = captureMainWindow?.isVisible() ?? false
    // Electron 22 在 ARM64 Wayland 枚举屏幕时可能触发原生 SIGSEGV，JS 无法捕获；保留系统截图粘贴退路。
    if (WAYLAND_SESSION && process.arch === 'arm64') {
      reportCaptureFailure('screen-unavailable', wasVisible)
      return
    }
    try {
      if (hide && wasVisible && captureMainWindow) {
        const hidden = await hideWindowForCapture(captureMainWindow)
        if (!hidden) {
          reportCaptureFailure('window-hide-failed', wasVisible)
          return
        }
      }
      const display = screen.getPrimaryDisplay()
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor)
        }
      })
      const source =
        sources.find((s) => s.display_id === String(display.id)) ?? sources[0] ?? null
      if (!source || source.thumbnail.isEmpty()) {
        reportCaptureFailure('screen-unavailable', wasVisible)
        return
      }
      captureStatus = 'ready'
      diagnostics.record('capture.state', { status: 'ready' })
      const sourceSize = source.thumbnail.getSize()
      const geometry = planCaptureGeometry(
        process.platform,
        display.bounds,
        display.workArea,
        sourceSize
      )
      const crop = geometry.imageCrop
      const needsCrop =
        crop.x !== 0 ||
        crop.y !== 0 ||
        crop.width !== sourceSize.width ||
        crop.height !== sourceSize.height
      const captureImage = needsCrop ? source.thumbnail.crop(crop) : source.thumbnail
      if (captureImage.isEmpty()) {
        reportCaptureFailure('image-empty', wasVisible)
        return
      }
      const png = captureImage.toPNG()
      if (png.byteLength === 0) {
        reportCaptureFailure('image-empty', wasVisible)
        return
      }
      const pngBytes = png.buffer.slice(
        png.byteOffset,
        png.byteOffset + png.byteLength
      ) as ArrayBuffer
      openCaptureWindow(geometry.windowBounds, pngBytes, () => {
        capturing = false
        if (wasVisible) showMainWindow({ forceForeground: true })
      })
    } catch (err) {
      reportCaptureFailure('unexpected', wasVisible, err)
    }
  }

  /** 新消息系统通知（F-SYS-2）：窗口聚焦时不打扰（应用内角标已可见）；点击直达会话 */
  function notifyIncoming(msg: MessageView): void {
    if (msg.isMine) return
    if (msg.kind === 'system') return
    if (appState && appState.config.notifications === false) return
    if (chat?.isMuted(msg.convId)) return
    if (mainWindow && mainWindow.isFocused() && mainWindow.isVisible()) return
    if (!Notification.isSupported()) return

    const senderNick = registry?.get(msg.senderId)?.profile.nick ?? tr('新成员')
    const hidePreview = appState?.config.showMessagePreview === false
    const groupName = msg.convId.startsWith('group:')
      ? groups?.get(msg.convId.slice(6))?.name
      : undefined
    const icon = systemNotificationIcon()
    // 群消息：标题=群名，正文=「发送人：内容」（微信式，决议 #66）；正文走系统通知安全文本（决议 #108）
    const options = incomingNotificationOptions({
      msg,
      senderNick,
      groupName,
      hidePreview,
      silent: appState?.config.sound === 'none'
    })
    const notification = new Notification({
      ...options,
      ...(icon ? { icon } : {})
    })
    notification.on('click', () => {
      showMainWindow()
      mainWindow?.webContents.send(IpcEvents.openConv, msg.convId)
    })
    notification.show()
    if (process.platform === 'win32') mainWindow?.flashFrame(true) // 任务栏闪烁提醒
  }

  function createMainWindow(): void {
    // dev 模式 mac Dock 显示茶杯图标（决议 #72）：打包版靠 .app 内嵌 icns，而 `npm run dev`
    // 跑未打包 Electron、Dock 是其默认图标；运行时 setIcon 仅补 dev，打包版不覆盖（icns 更精细）。
    if (process.platform === 'darwin' && !app.isPackaged) {
      try {
        app.dock?.setIcon(join(app.getAppPath(), 'build/icons/pantry-logo-icon.png'))
      } catch {
        // 图标缺失不致命
      }
    }

    mainWindow = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: mainWindowTitle(),
      // 沉浸式无标题栏（决议 #49）：mac 保留内嵌红绿灯；Win/Linux 渲染层自绘控制按钮。
      // Windows 不关 thickFrame，边缘缩放与 Aero Snap 保持系统行为；不使用透明窗口（Win7 软渲染安全）。
      // 红绿灯置于列表栏顶部留白（决议 #51）：56px 导航栏放不下三钮，不允许横跨分界线。
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 9, y: 7 } }
        : { frame: false }),
      ...linuxWindowIcon(),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    syncMainWindowZoom()
    mainWindow.webContents.on('did-finish-load', syncMainWindowZoom)

    // 最大化状态推送：渲染层自绘「最大化/还原」按钮据此切图标
    mainWindow.on('maximize', () =>
      mainWindow?.webContents.send(IpcEvents.winMaximizeChanged, true)
    )
    mainWindow.on('unmaximize', () =>
      mainWindow?.webContents.send(IpcEvents.winMaximizeChanged, false)
    )

    // 安全红线（README）：不放行任何窗口内导航与新窗口
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (
        input.type === 'keyDown' &&
        (input.meta || input.control) &&
        !input.alt &&
        input.key.toLowerCase() === 'v'
      ) {
        mainWindow?.webContents.send(IpcEvents.clipboardPasteImage)
      }
    })

    mainWindow.once('ready-to-show', () => mainWindow?.show())
    // 关窗 = 进托盘常驻（F-SYS-1）；托盘不可用的桌面环境降级为直接退出
    mainWindow.on('close', (event) => {
      if (isQuitting || !tray || appState?.config.closeToTray === false) return
      event.preventDefault()
      mainWindow?.hide()
    })
    mainWindow.on('focus', () => mainWindow?.flashFrame(false))
    mainWindow.on('closed', () => {
      clearNudgeShake(false)
      mainWindow = null
    })

    const rendererUrl = resolveDevRendererUrl(
      process.env['ELECTRON_RENDERER_URL'],
      '',
      app.isPackaged
    )
    if (rendererUrl) {
      void mainWindow.loadURL(rendererUrl)
    } else {
      void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  // ---- IPC（只做参数校验与转发，业务禁入此层 —— tech-design §3） ----
  setupDiagnosticsUi(diagnostics, async includePeers => {
    const environment = await diagnosticEnvironment(diagnostics)
    let permission = 'unknown'
    if (process.platform === 'darwin') {
      try { permission = systemPreferences.getMediaAccessStatus('screen') } catch { /* 旧系统仅标未知 */ }
    }
    return { ...environment, generatedAt: new Date().toISOString(), utcOffsetMinutes: -new Date().getTimezoneOffset(), app: { version: app.getVersion(), electron: process.versions.electron,
      node: process.versions.node, chrome: process.versions.chrome, windows7: WINDOWS7,
      softwareRendering: SOFTWARE_RENDERING },
      desktop: { names: environment.desktop ?? [], session: WAYLAND_SESSION ? 'wayland' : environment.session ?? 'native',
        screenPermission: permission, captureStatus, screenViewing: remoteView.availability().view,
        screenSharing: remoteView.availability().share, displays: screen.getAllDisplays().map(d => ({
          width: d.size.width, height: d.size.height, scale: d.scaleFactor
        })) },
      network: { udp: { port: udpPort, status: netState.ok ? 'ready' : netState.error ? 'failed' : 'starting' },
        tcp: { port: tcpPort, status: tcpStatus }, localAddress: diagnostics.alias(currentLocalIpv4()),
        knownPeers: registry?.values().length ?? 0,
        peers: includePeers ? (registry?.values() ?? []).slice(0, 1000).map(p => ({ peer: diagnostics.alias(p.profile.nodeId),
          address: diagnostics.alias(p.ip), tcpPort: p.profile.tcpPort, online: p.online,
          version: /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(p.profile.ver) ? p.profile.ver : 'unknown', platform: p.profile.platform })) : undefined },
      database: databaseMode, diagnostics: diagnostics.status() }
  })

  ipcMain.handle(IpcChannels.appInfo, (): AppInfo => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      windows7: WINDOWS7,
      softwareRendering: SOFTWARE_RENDERING,
      nodeId: appState?.nodeId ?? '',
      localIp: currentLocalIpv4()
    }
  })

  // 窗口控制（决议 #49）：按调用方 webContents 定位窗口，主窗/设置窗通用
  ipcMain.handle(IpcChannels.winMinimize, (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle(IpcChannels.winToggleMaximize, (event): boolean => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !win.isMaximizable()) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.handle(IpcChannels.winIsMaximized, (event): boolean => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  // 决议 #59：自绘关闭按钮唯一入口。主进程 close() 走标准流程触发 close 事件，
  // 主窗的"关闭进托盘"拦截才有机会执行；DOM window.close() 会 CloseImmediately 绕过。
  ipcMain.handle(IpcChannels.winClose, (event): void => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(IpcChannels.winHideMain, (event): void => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !mainWindow.isFocused()) return
    if (tray) mainWindow.hide()
    else mainWindow.minimize()
  })

  // Linux JS 拖拽（决议 #52）：CSS 拖拽区在 Linux 命中不可靠（UOS 实测吞点击），
  // 渲染层按住拖拽带时由主进程按光标位置跟随移窗；单鼠标场景同一时刻只有一个拖拽。
  let dragTimer: NodeJS.Timeout | null = null

  function stopWindowDrag(): void {
    if (dragTimer) clearInterval(dragTimer)
    dragTimer = null
  }

  ipcMain.handle(IpcChannels.winBeginDrag, (event): void => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isMaximized() || win.isFullScreen()) return
    stopWindowDrag()
    const cursor = screen.getCursorScreenPoint()
    const [winX, winY] = win.getPosition()
    const offsetX = cursor.x - winX
    const offsetY = cursor.y - winY
    dragTimer = setInterval(() => {
      if (win.isDestroyed()) {
        stopWindowDrag()
        return
      }
      const point = screen.getCursorScreenPoint()
      win.setPosition(point.x - offsetX, point.y - offsetY)
    }, 16)
  })

  ipcMain.handle(IpcChannels.winEndDrag, (): void => stopWindowDrag())

  ipcMain.handle(IpcChannels.appOpenUrl, async (_event, raw: unknown): Promise<boolean> => {
    if (typeof raw !== 'string' || raw.length > 2048) return false
    try {
      const url = new URL(raw)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
      await shell.openExternal(url.toString())
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IpcChannels.netState, (): NetState => netState)

  ipcMain.handle(IpcChannels.peersList, (): PeerView[] => peerViews())

  ipcMain.handle(IpcChannels.updateCheck, (): UpdateAvailability | null => currentUpdateAvailability())

  ipcMain.handle(IpcChannels.updateRequest, (): Promise<boolean> => requestUpdatePackage())

  ipcMain.handle(IpcChannels.peersProbe, (_event, nodeId: unknown): boolean => {
    if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 64) return false
    return discovery?.probeNode(nodeId) ?? false
  })

  ipcMain.handle(IpcChannels.convList, () => chat?.listConversations() ?? [])

  ipcMain.handle(IpcChannels.convOpen, (_event, peerId: unknown) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
    return chat?.openConversation(peerId) ?? null
  })

  ipcMain.handle(IpcChannels.convMarkRead, (_event, convId: unknown) => {
    if (typeof convId === 'string' && convId.length <= 128) chat?.markRead(convId)
  })

  ipcMain.handle(IpcChannels.convPin, (_event, convId: unknown, pinned: unknown) => {
    if (typeof convId === 'string' && convId.length <= 128 && typeof pinned === 'boolean') {
      chat?.setPinned(convId, pinned)
    }
  })

  ipcMain.handle(IpcChannels.convMute, (_event, convId: unknown, muted: unknown) => {
    if (typeof convId === 'string' && convId.length <= 128 && typeof muted === 'boolean') {
      chat?.setMuted(convId, muted)
    }
  })

  ipcMain.handle(IpcChannels.convRemove, (_event, convId: unknown) => {
    if (typeof convId === 'string' && convId.length <= 128) chat?.removeConversation(convId)
  })

  ipcMain.handle(IpcChannels.msgPage, (_event, convId: unknown, beforeSeq: unknown, limit: unknown) => {
    if (typeof convId !== 'string' || convId.length > 128 || !chat) return []
    const before = typeof beforeSeq === 'number' && Number.isInteger(beforeSeq) ? beforeSeq : null
    const lim = typeof limit === 'number' && limit >= 1 && limit <= 200 ? limit : 50
    return chat.pageMessages(convId, before, lim)
  })

  ipcMain.handle(IpcChannels.msgSend, (_event, peerId: unknown, text: unknown) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) return null
    return chat?.sendText(peerId, text) ?? null
  })

  ipcMain.handle(IpcChannels.msgResend, (_event, msgId: unknown): boolean => {
    if (typeof msgId !== 'string' || msgId.length === 0 || msgId.length > 64) return false
    return chat?.resend(msgId) ?? false
  })

  ipcMain.handle(IpcChannels.msgRecall, (_event, msgId: unknown): boolean => {
    if (typeof msgId !== 'string' || msgId.length === 0 || msgId.length > 64) return false
    return chat?.recall(msgId) ?? false
  })

  ipcMain.handle(IpcChannels.msgNudge, async (_event, peerId: unknown): Promise<NudgeResult> => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) {
      return { ok: false, reason: 'invalid' }
    }
    return chat?.sendNudge(peerId) ?? { ok: false, reason: 'invalid' }
  })

  ipcMain.handle(IpcChannels.msgPk, (_event, convId: unknown, game: unknown) => {
    if (typeof convId !== 'string' || convId.length === 0 || convId.length > 128) return null
    if (game !== 'dice' && game !== 'rps') return null
    if (convId.startsWith('single:')) return chat?.sendPk(convId.slice(7), game) ?? null
    if (convId.startsWith('group:')) return groups?.sendPk(convId.slice(6), game) ?? null
    return null
  })

  ipcMain.handle(IpcChannels.msgForward, async (_event, msgId: unknown, targets: unknown) => {
    if (typeof msgId !== 'string' || msgId.length === 0 || msgId.length > 64) {
      return { ok: 0, total: 0, messages: [] }
    }
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 50) {
      return { ok: 0, total: 0, messages: [] }
    }
    const clean: ForwardTarget[] = []
    for (const item of targets) {
      if (typeof item !== 'object' || item === null) continue
      const target = item as Record<string, unknown>
      if ((target.type !== 'single' && target.type !== 'group') || typeof target.id !== 'string') {
        continue
      }
      if (target.id.length === 0 || target.id.length > 64) continue
      clean.push({ type: target.type, id: target.id })
    }
    return forward?.forward(msgId, clean) ?? { ok: 0, total: clean.length, messages: [] }
  })

  function settingsView(): SettingsView {
    const c = appState?.config
    const fontScale = c && (c.fontScale === 110 || c.fontScale === 125) ? c.fontScale : 100
    const sound =
      c?.sound === 'drop' || c?.sound === 'wood' || c?.sound === 'ding' ? c.sound : 'none'
    return {
      nick: c?.nick ?? '',
      company: c?.company ?? '',
      dept: c?.dept ?? '',
      team: c?.team ?? '',
      host: appState?.profile.host ?? '',
      avatar: c?.avatar ?? -1,
      avatarHash: c?.avatarHash ?? '',
      setupDone: c?.setupDone ?? true,
      fileDir: c?.fileDir ?? '',
      defaultFileDir: defaultFileDir(),
      notifications: c?.notifications !== false,
      manualPeers: c?.manualPeers ?? [],
      scanRanges: c?.scanRanges ?? [],
      scanRangeItems: scanRangeItems(),
      udpPort: c?.udpPort ?? udpPort,
      tcpPort: c?.tcpPort ?? tcpPort,
      hideOnCapture: c?.hideOnCapture !== false,
      autoLaunch: c?.autoLaunch !== false,
      closeToTray: c?.closeToTray !== false,
      language: c?.language ?? 'zh-CN',
      theme: c?.theme === 'dark' ? 'dark' : 'light',
      fontScale,
      showMessagePreview: c?.showMessagePreview !== false,
      allowDirectFileSend: c?.allowDirectFileSend !== false,
      fileCabinet: {
        root: c?.fileCabinet?.root ?? '',
        mode: c?.fileCabinet?.mode ?? 'off',
        grantCount: share?.listGrants().length ?? 0
      },
      sound,
      sendKey: c?.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
      captureShortcut: c?.captureShortcut ?? DEFAULT_CAPTURE_SHORTCUT,
      showHideShortcut: c?.showHideShortcut ?? DEFAULT_SHOWHIDE_SHORTCUT,
      shortcutStatus: { ...shortcutStatus }
    }
  }

  function isValidSubmit(x: unknown): x is ProfileSubmit {
    if (typeof x !== 'object' || x === null) return false
    const s = x as Record<string, unknown>
    const str = (v: unknown, max: number, allowEmpty: boolean): boolean =>
      typeof v === 'string' && v.length <= max && (allowEmpty || v.trim().length > 0)
    return (
      str(s.nick, LIMITS.nick, false) &&
      str(s.company, LIMITS.company, true) &&
      str(s.dept, LIMITS.dept, true) &&
      str(s.team, LIMITS.team, true) &&
      isAvatarPresetValue(s.avatar) &&
      (s.avatarHash === undefined || s.avatarHash === '' || isAvatarHash(s.avatarHash)) &&
      typeof s.fileDir === 'string' &&
      s.fileDir.length <= 1024
    )
  }

  ipcMain.handle(IpcChannels.settingsGet, (): SettingsView => settingsView())

  ipcMain.handle(IpcChannels.settingsSaveProfile, async (_event, submit: unknown): Promise<SettingsView> => {
    if (appState && isValidSubmit(submit)) {
      // 新头像哈希必须在受管缓存中真实存在，否则全网节点会对取不到的头像反复空请求（决议 #248）；
      // 与当前值相同的哈希放行，避免头像文件意外缺失时阻塞无关资料保存。
      if (
        submit.avatarHash !== undefined &&
        submit.avatarHash !== '' &&
        submit.avatarHash !== appState.config.avatarHash &&
        !(await avatarStore.has(submit.avatarHash))
      ) {
        return settingsView()
      }
      saveProfile(appState, {
        nick: submit.nick.trim(),
        company: submit.company.trim(),
        dept: submit.dept.trim(),
        team: submit.team.trim(),
        avatar: submit.avatar,
        ...(submit.avatarHash !== undefined ? { avatarHash: submit.avatarHash } : {}),
        fileDir: submit.fileDir.trim()
      })
      if (db) {
        porter = new PorterService(
          db,
          appState.nodeId,
          appState.config.nick,
          importedMediaDir(),
          [imagesDir(), stickersDir()],
          avatarsDir(),
          appState.config.avatarHash
        )
      }
      discovery?.announceProfile() // 资料变更即时广播（F-DISC-7 的发送侧）
      updateMainWindowTitle()
      broadcastSettings()
    }
    return settingsView()
  })

  ipcMain.handle(
    IpcChannels.avatarPickSource,
    async (event): Promise<AvatarSourcePick | null> => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: tr('选择头像图片'),
            properties: ['openFile'],
            filters: [{ name: tr('图片'), extensions: AVATAR_PICKER_EXTENSIONS }]
          })
        : await dialog.showOpenDialog({
            title: tr('选择头像图片'),
            properties: ['openFile'],
            filters: [{ name: tr('图片'), extensions: AVATAR_PICKER_EXTENSIONS }]
          })
      if (result.canceled || result.filePaths.length === 0) return null
      const path = result.filePaths[0]
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size <= 0) return { ok: false, error: tr('无法读取这张图片') }
        if (info.size > AVATAR_SOURCE_MAX_BYTES) {
          return { ok: false, error: tr('头像图片不能超过 20 MiB') }
        }
        const data = await readFile(path)
        const metadata = inspectImageMetadata(data)
        if (!metadata || metadata.format === 'gif') {
          return { ok: false, error: tr('请选择 JPG、PNG、WebP 或 BMP 静态图片') }
        }
        if (metadata.animated) return { ok: false, error: tr('暂不支持动态头像') }
        if (
          metadata.width > AVATAR_MAX_DIMENSION ||
          metadata.height > AVATAR_MAX_DIMENSION
        ) {
          return { ok: false, error: tr('头像图片单边不能超过 8192 像素') }
        }
        const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        return {
          ok: true,
          bytes,
          mime: avatarMime(metadata.format),
          width: metadata.width,
          height: metadata.height
        }
      } catch {
        return { ok: false, error: tr('无法读取这张图片') }
      }
    }
  )

  ipcMain.handle(
    IpcChannels.profileSetAvatar,
    async (_event, input: unknown): Promise<SettingsView> => {
      if (!appState || typeof input !== 'object' || input === null) {
        throw new Error('invalid-avatar')
      }
      const choice = input as { kind?: unknown; avatar?: unknown; bytes?: unknown }
      let avatar = appState.config.avatar
      let avatarHash = ''
      if (choice.kind === 'preset') {
        if (!isAvatarPresetValue(choice.avatar)) {
          throw new Error('invalid-avatar')
        }
        avatar = choice.avatar
      } else if (choice.kind === 'custom') {
        if (!(choice.bytes instanceof ArrayBuffer) || choice.bytes.byteLength > AVATAR_MAX_BYTES) {
          throw new Error('invalid-avatar')
        }
        avatarHash = (await avatarStore.save(choice.bytes)) ?? ''
        if (!avatarHash) throw new Error('invalid-avatar')
      } else {
        throw new Error('invalid-avatar')
      }

      saveProfile(appState, {
        nick: appState.config.nick,
        company: appState.config.company,
        dept: appState.config.dept,
        team: appState.config.team,
        avatar,
        avatarHash,
        fileDir: appState.config.fileDir
      })
      if (db) {
        porter = new PorterService(
          db,
          appState.nodeId,
          appState.config.nick,
          importedMediaDir(),
          [imagesDir(), stickersDir()],
          avatarsDir(),
          appState.config.avatarHash
        )
      }
      discovery?.announceProfile()
      const view = broadcastSettings()
      if (avatarHash) broadcastAvatarReady(avatarHash)
      scheduleAvatarPrune()
      return view
    }
  )

  ipcMain.handle(IpcChannels.settingsPickDir, async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: tr('选择文件保存位置'),
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // ——— 我的文件柜（决议 #271/#276/#277）：ipc 层只做参数校验与转发，判定在 ShareService ———

  function shareGrantViews(): ShareGrantView[] {
    if (!share) return []
    return share.listGrants().map((g) => {
      const record = registry?.get(g.nodeId)
      return {
        nodeId: g.nodeId,
        name: resolvePeerDisplayName(g.nodeId) || g.nodeId.slice(0, 8),
        avatar: record?.profile.avatar ?? -1,
        avatarHash: record?.profile.avatarHash ?? '',
        online: record?.online === true,
        mode: g.mode
      }
    })
  }

  ipcMain.handle(
    IpcChannels.shareMySetRoot,
    async (event, clear: unknown): Promise<ShareRootPickResult> => {
      if (!appState) return { ok: false, reason: 'empty' }
      if (clear === true) {
        saveAppSettings(appState, {
          fileCabinet: { root: '', mode: appState.config.fileCabinet.mode }
        })
        return { ok: true, canceled: false, view: broadcastSettings() }
      }
      const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
      if (!owner) return { ok: true, canceled: true }
      const result = await dialog.showOpenDialog(owner, {
        title: tr('选择共享给同事的目录'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return { ok: true, canceled: true }
      const picked = result.filePaths[0]
      const check = evaluateShareRoot(picked, {
        home: app.getPath('home'),
        dataRoot: dataRoot()
      })
      if (!check.ok) return { ok: false, reason: check.reason }
      try {
        if (!statSync(check.path).isDirectory()) return { ok: false, reason: 'unreadable' }
        accessSync(check.path, fsConstants.R_OK)
      } catch {
        return { ok: false, reason: 'unreadable' }
      }
      saveAppSettings(appState, {
        fileCabinet: { root: check.path, mode: appState.config.fileCabinet.mode }
      })
      // 日志只记是否已设置，绝不记录共享根路径本身（决议 #6/#276）
      console.log('[share] 共享目录已设置')
      return { ok: true, canceled: false, view: broadcastSettings() }
    }
  )

  ipcMain.handle(IpcChannels.shareMySetMode, (_event, mode: unknown): SettingsView => {
    if (!appState || !isShareMode(mode)) return settingsView()
    saveAppSettings(appState, {
      fileCabinet: { root: appState.config.fileCabinet.root, mode }
    })
    return broadcastSettings()
  })

  ipcMain.handle(IpcChannels.shareMyReveal, (): boolean => {
    const root = appState?.config.fileCabinet.root ?? ''
    if (root.length === 0 || !existsSync(root)) return false
    shell.openPath(root).catch(() => undefined)
    return true
  })

  ipcMain.handle(IpcChannels.shareGrantList, (): ShareGrantView[] => shareGrantViews())

  ipcMain.handle(
    IpcChannels.shareGrantSet,
    (_event, nodeId: unknown, mode: unknown): ShareGrantView[] => {
      if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > LIMITS.id) {
        return shareGrantViews()
      }
      if (mode !== null && !isShareMode(mode)) return shareGrantViews()
      share?.setGrant(nodeId, mode)
      broadcastSettings() // grantCount 变了，设置页与主窗一起刷新
      return shareGrantViews()
    }
  )

  // ——— 对方的文件柜（决议 #273/#275）：浏览与下载 ———

  /** 入口前置条件：对端在线且声明 shr1，否则给出确定的原因而不是让用户干等超时 */
  function shareTargetIssue(peerId: unknown): ShareBrowseFailReason | null {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > LIMITS.id) {
      return 'offline'
    }
    const peer = registry?.get(peerId)
    if (!peer || !peer.online) return 'offline'
    if (!Array.isArray(peer.profile.caps) || !peer.profile.caps.includes(CAPS.fileCabinet)) {
      return 'unsupported'
    }
    return null
  }

  ipcMain.handle(
    IpcChannels.shareBrowse,
    async (
      _event,
      peerId: unknown,
      path: unknown,
      offset: unknown,
      snapshotId: unknown
    ): Promise<ShareBrowseResult> => {
      const issue = shareTargetIssue(peerId)
      if (issue) return { ok: false, reason: issue }
      if (typeof path !== 'string' || Buffer.byteLength(path, 'utf8') > SHARE_PATH_MAX) {
        return { ok: false, reason: 'not-found' }
      }
      const start = typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
      const reply = await requestShare(peerId as string, {
        op: 'list',
        reqId: randomUUID(),
        path,
        offset: start,
        ...(typeof snapshotId === 'string' && snapshotId.length > 0 && snapshotId.length <= LIMITS.id
          ? { snapshotId }
          : {})
      })
      if (!reply) return { ok: false, reason: 'timeout' }
      if (reply.op === 'deny') return { ok: false, reason: reply.reason }
      if (reply.op !== 'list-ok') return { ok: false, reason: 'timeout' }
      return {
        ok: true,
        path: reply.path,
        perm: reply.perm,
        snapshotId: reply.snapshotId,
        offset: reply.offset,
        total: reply.total,
        truncated: reply.truncated,
        entries: reply.entries
      }
    }
  )

  ipcMain.handle(
    IpcChannels.shareDownload,
    async (
      event,
      peerId: unknown,
      paths: unknown,
      saveAs: unknown
    ): Promise<ShareDownloadResult> => {
      const issue = shareTargetIssue(peerId)
      if (issue) return { ok: false, reason: issue }
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > SHARE_GET_MAX_PATHS) {
        return { ok: false, reason: 'not-found' }
      }
      const clean: string[] = []
      for (const raw of paths) {
        if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'not-found' }
        if (Buffer.byteLength(raw, 'utf8') > SHARE_PATH_MAX) return { ok: false, reason: 'not-found' }
        clean.push(raw)
      }
      const target = peerId as string

      let saveDir = join(
        appState?.config.fileDir || defaultFileDir(),
        shareDownloadDirName(resolvePeerDisplayName(target) || target)
      )
      if (saveAs === true) {
        const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
        if (!owner) return { ok: true, canceled: true }
        const picked = await dialog.showOpenDialog(owner, {
          title: tr('选择下载到哪个目录'),
          properties: ['openDirectory', 'createDirectory']
        })
        if (picked.canceled || picked.filePaths.length === 0) return { ok: true, canceled: true }
        saveDir = picked.filePaths[0]
      }

      // 先登记一次性授权再发请求：offer 可能在 sendReliable 的 ACK 之前就到（决议 #275）。
      // 句柄化后每次下载各管各的，连点两次不会互相顶掉落点（决议 #280）。
      const grant = shareDownloadGate.begin(target, saveDir, SHARE_GET_AUTH_TTL)
      const reqId = randomUUID()
      shareGetReq.set(target, reqId)
      const reply = await requestShare(target, { op: 'get', reqId, paths: clean })
      shareGetReq.delete(target)
      if (reply && reply.op === 'deny') {
        shareDownloadGate.cancel(grant)
        return { ok: false, reason: reply.reason }
      }
      // reply 为 null 有两种情况：传输已开始（授权被消费时提前唤醒）或对方没回应；
      // 本次授权还在说明确实没等到 offer。
      if (!reply && shareDownloadGate.isPending(grant)) {
        shareDownloadGate.cancel(grant)
        return { ok: false, reason: 'timeout' }
      }
      return { ok: true }
    }
  )

  ipcMain.handle(
    IpcChannels.shareUpload,
    async (
      event,
      peerId: unknown,
      localPaths: unknown,
      directory: unknown
    ): Promise<ShareUploadResult> => {
      const issue = shareTargetIssue(peerId)
      if (issue) return { ok: false, reason: issue === 'offline' ? 'offline' : 'unsupported' }
      const target = peerId as string

      let paths: string[]
      if (localPaths === null || localPaths === undefined) {
        const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
        if (!owner) return { ok: true, canceled: true }
        const picked = await dialog.showOpenDialog(owner, {
          title: directory === true ? tr('选择要上传的文件夹') : tr('选择要上传的文件'),
          properties: directory === true ? ['openDirectory'] : ['openFile', 'multiSelections']
        })
        if (picked.canceled || picked.filePaths.length === 0) return { ok: true, canceled: true }
        paths = picked.filePaths
      } else {
        // 拖拽进来的路径必须先经 file:grant-paths 授权，规则同普通文件发送
        if (!Array.isArray(localPaths) || localPaths.length === 0 || localPaths.length > 100) {
          return { ok: false, reason: 'unreadable' }
        }
        if (!localPaths.every((p) => typeof p === 'string' && p.length > 0 && p.length < 2048)) {
          return { ok: false, reason: 'unreadable' }
        }
        paths = localPaths as string[]
        if (!rendererPathGrants.consume(event.sender.id, paths)) {
          return { ok: false, reason: 'unreadable' }
        }
      }

      // 异步测算：整棵目录树的遍历不能占住主进程事件循环（决议 #278）
      const measured = await measureUploadPaths(paths)
      if (!measured) return { ok: false, reason: 'unreadable' }
      if (measured.totalSize > SHARE_PUT_MAX_BYTES) return { ok: false, reason: 'too-large' }
      const ok = await files?.offerSharePut(target, paths)
      if (!ok) return { ok: false, reason: 'rejected' }
      // 日志只记数量与字节数，不记文件名（决议 #6/#276）
      console.log(`[share] 上传已发起：${measured.fileCount} 项`)
      return { ok: true, fileCount: measured.fileCount }
    }
  )

  // 「最近有人放进来」（决议 #283）：只汇总已有传输记录，落盘目录经既有 file:reveal 打开
  ipcMain.handle(
    IpcChannels.shareRecentUploads,
    (_event, limit: unknown): ShareRecentUploadView[] => {
      const lim = typeof limit === 'number' && Number.isInteger(limit) ? limit : 10
      return (files?.listShareUploads(lim) ?? []).map((item) => {
        const record = registry?.get(item.peerId)
        return {
          transferId: item.transferId,
          nodeId: item.peerId,
          name: resolvePeerDisplayName(item.peerId) || item.peerId.slice(0, 8),
          avatar: record?.profile.avatar ?? -1,
          avatarHash: record?.profile.avatarHash ?? '',
          fileCount: item.fileCount,
          totalSize: item.totalSize,
          ts: item.ts
        }
      })
    }
  )

  ipcMain.handle(IpcChannels.filePick, async (event, directory: unknown): Promise<string[] | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: directory === true ? tr('选择要发送的文件夹') : tr('选择要发送的文件'),
      properties: directory === true ? ['openDirectory'] : ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    rendererPathGrants.grant(event.sender.id, result.filePaths)
    return result.filePaths
  })

  ipcMain.handle(IpcChannels.imgPick, async (event, purpose: unknown): Promise<string[] | null> => {
    if (!mainWindow) return null
    if (purpose !== undefined && purpose !== 'sticker') return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: purpose === 'sticker' ? tr('选择要导入的表情') : tr('选择要发送的图片'),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: tr('图片'), extensions: IMAGE_PICKER_EXTENSIONS }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const paths = filterImagePickerPaths(result.filePaths)
    if (paths.length === 0) return null
    const grants = purpose === 'sticker' ? stickerImportPathGrants : rendererPathGrants
    grants.grant(event.sender.id, paths)
    return paths
  })

  ipcMain.handle(IpcChannels.fileGrantPaths, (event, paths: unknown): string[] => {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) return []
    const cleanPaths = paths.filter(
      (p): p is string => typeof p === 'string' && p.length > 0 && p.length < 2048 && existsSync(p)
    )
    if (cleanPaths.length === 0) return []
    rendererPathGrants.grant(event.sender.id, cleanPaths)
    return cleanPaths
  })

  ipcMain.handle(IpcChannels.fileOffer, async (event, peerId: unknown, paths: unknown) => {
    if (typeof peerId !== 'string' || peerId.length === 0 || peerId.length > 64) return null
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) return null
    if (!paths.every((p) => typeof p === 'string' && p.length > 0 && p.length < 2048)) return null
    const cleanPaths = paths as string[]
    if (!rendererPathGrants.consume(event.sender.id, cleanPaths)) return null
    return (await files?.offerPaths(peerId, cleanPaths)) ?? null
  })

  ipcMain.handle(IpcChannels.fileDirect, async (_event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > 64) {
      return false
    }
    return (await files?.requestDirect(transferId)) ?? false
  })

  ipcMain.handle(IpcChannels.groupFileOffer, async (event, groupId: unknown, paths: unknown) => {
    if (typeof groupId !== 'string' || groupId.length === 0 || groupId.length > 64) return null
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) return null
    if (!paths.every((p) => typeof p === 'string' && p.length > 0 && p.length < 2048)) return null
    const cleanPaths = paths as string[]
    if (!rendererPathGrants.consume(event.sender.id, cleanPaths)) return null
    return (await files?.offerGroupPaths(groupId, cleanPaths)) ?? null
  })

  ipcMain.handle(IpcChannels.fileAccept, async (_event, transferId: unknown, saveAs: unknown) => {
    if (typeof transferId !== 'string' || transferId.length > 64 || !files) return false
    let dir: string | undefined
    if (saveAs === true && mainWindow) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: tr('保存到…'),
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return false
      dir = result.filePaths[0]
    }
    return files.accept(transferId, dir)
  })

  ipcMain.handle(IpcChannels.fileDecline, async (_event, transferId: unknown) => {
    if (typeof transferId === 'string' && transferId.length <= 64) await files?.decline(transferId)
  })

  ipcMain.handle(IpcChannels.fileCancel, async (_event, transferId: unknown) => {
    if (typeof transferId === 'string' && transferId.length <= 64) await files?.cancel(transferId)
  })

  ipcMain.handle(IpcChannels.fileReveal, (_event, transferId: unknown) => {
    if (typeof transferId !== 'string' || transferId.length > 64) return
    const view = files?.transferView(transferId)
    if (view?.savedPath) shell.showItemInFolder(view.savedPath)
  })

  ipcMain.handle(IpcChannels.transferGet, (_event, transferId: unknown) => {
    if (typeof transferId !== 'string' || transferId.length > 64) return null
    return files?.transferView(transferId) ?? null
  })

  ipcMain.handle(IpcChannels.transferList, (_event, limit: unknown) => {
    const lim = typeof limit === 'number' && Number.isInteger(limit) ? limit : 30
    return files?.listTransfers(lim) ?? []
  })

  ipcMain.handle(
    IpcChannels.dataExport,
    async (_event, format: unknown, options: unknown): Promise<string | null> => {
      if (format !== 'backup' && format !== 'html' && format !== 'txt') return null
      if (!mainWindow || !porter) return null
      const fmt = format as ExportFormat
      const exportOptions = normalizeExportOptions(options)
      const ext = fmt === 'backup' ? 'pantry-bak' : fmt
      const result = await dialog.showSaveDialog(mainWindow, {
        title: tr('导出聊天记录'),
        defaultPath: tr('Hive导出-{0}.{1}', { 0: new Date().toISOString().slice(0, 10), 1: ext }),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      })
      if (result.canceled || !result.filePath) return null
      try {
        porter.export(fmt, result.filePath, exportOptions)
        return result.filePath
      } catch (err) {
        console.warn('[porter] 导出失败：', err)
        return null
      }
    }
  )

  ipcMain.handle(IpcChannels.dataImport, async (): Promise<DataImportResult | null> => {
    if (!mainWindow || !porter) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: tr('导入聊天记录备份'),
      properties: ['openFile'],
      filters: [{ name: 'Hive Backup', extensions: ['pantry-bak', 'zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      const imported = porter.importBackup(result.filePaths[0])
      if (appState && imported.profileAvatarHash) {
        saveProfile(appState, {
          nick: appState.config.nick,
          company: appState.config.company,
          dept: appState.config.dept,
          team: appState.config.team,
          avatar: appState.config.avatar,
          avatarHash: imported.profileAvatarHash,
          fileDir: appState.config.fileDir
        })
        discovery?.announceProfile()
        broadcastSettings()
        if (db) {
          porter = new PorterService(
            db,
            appState.nodeId,
            appState.config.nick,
            importedMediaDir(),
            [imagesDir(), stickersDir()],
            avatarsDir(),
            appState.config.avatarHash
          )
        }
      }
      chat?.emit('convs', chat.listConversations())
      avatars?.ensureAll()
      for (const hash of referencedAvatarHashes()) broadcastAvatarReady(hash)
      scheduleAvatarPrune()
      return imported
    } catch (err) {
      console.warn('[porter] 导入失败：', err)
      return null
    }
  })

  ipcMain.handle(
    IpcChannels.imgSendBytes,
    async (_event, peerId: unknown, name: unknown, bytes: unknown, tableText: unknown) => {
      return handleImageBytes(peerId, name, bytes, tableText, (targetId, paths, want, tableTextMeta) =>
        files?.offerPaths(targetId, paths, want, tableTextMeta)
      )
    }
  )

  ipcMain.handle(
    IpcChannels.groupImgSendBytes,
    async (_event, groupId: unknown, name: unknown, bytes: unknown, tableText: unknown) => {
      return handleImageBytes(groupId, name, bytes, tableText, (targetId, paths, want, tableTextMeta) =>
        files?.offerGroupPaths(targetId, paths, want, tableTextMeta)
      )
    }
  )

  ipcMain.handle(IpcChannels.imgOfferPath, async (event, peerId: unknown, path: unknown) => {
    return handleImagePath(event.sender.id, peerId, path, (targetId, paths, want) =>
      files?.offerPaths(targetId, paths, want)
    )
  })

  ipcMain.handle(IpcChannels.groupImgOfferPath, async (event, groupId: unknown, path: unknown) => {
    return handleImagePath(event.sender.id, groupId, path, (targetId, paths, want) =>
      files?.offerGroupPaths(targetId, paths, want)
    )
  })

  ipcMain.handle(IpcChannels.settingsSaveApp, async (_event, patch: unknown): Promise<SettingsView> => {
    if (appState && typeof patch === 'object' && patch !== null) {
      const p = patch as Record<string, unknown>
      const clean: AppSettingsPatch = {}
      const previousScanRanges = new Set(appState.config.scanRanges)
      if (typeof p.notifications === 'boolean') clean.notifications = p.notifications
      if (Array.isArray(p.manualPeers)) {
        clean.manualPeers = p.manualPeers
          .filter((s): s is string => typeof s === 'string')
          .slice(0, 100)
      }
      if (Array.isArray(p.scanRanges)) {
        clean.scanRanges = [
          ...new Set(
            p.scanRanges
              .filter((s): s is string => typeof s === 'string')
              .map((s) => normalizeCidr(s))
              .filter((s): s is string => typeof s === 'string')
          )
        ]
          .slice(0, 20)
      }
      const nextUdpPort = parsePortValue(p.udpPort)
      if (nextUdpPort !== null) clean.udpPort = nextUdpPort
      const nextTcpPort = parsePortValue(p.tcpPort)
      if (nextTcpPort !== null) clean.tcpPort = nextTcpPort
      if (typeof p.hideOnCapture === 'boolean') clean.hideOnCapture = p.hideOnCapture
      if (typeof p.autoLaunch === 'boolean') clean.autoLaunch = p.autoLaunch
      if (typeof p.closeToTray === 'boolean') clean.closeToTray = p.closeToTray
      if (isLanguage(p.language)) clean.language = p.language
      if (p.theme === 'light' || p.theme === 'dark') clean.theme = p.theme
      if (p.fontScale === 100 || p.fontScale === 110 || p.fontScale === 125) {
        clean.fontScale = p.fontScale
      }
      if (typeof p.showMessagePreview === 'boolean') {
        clean.showMessagePreview = p.showMessagePreview
      }
      if (typeof p.allowDirectFileSend === 'boolean') {
        clean.allowDirectFileSend = p.allowDirectFileSend
      }
      if (p.sound === 'none' || p.sound === 'drop' || p.sound === 'wood' || p.sound === 'ding') {
        clean.sound = p.sound
      }
      if (p.sendKey === 'enter' || p.sendKey === 'ctrlEnter') clean.sendKey = p.sendKey
      const captureShortcut = normalizeShortcut(p.captureShortcut)
      if (captureShortcut !== null) clean.captureShortcut = captureShortcut
      const showHideShortcut = normalizeShortcut(p.showHideShortcut)
      if (showHideShortcut !== null) clean.showHideShortcut = showHideShortcut
      if (clean.language !== undefined && !await setLanguage(clean.language)) delete clean.language
      saveAppSettings(appState, clean)
      if (clean.language !== undefined) {
        refreshTrayLanguage(tray, mainWindow)
        syncSettingsWindowLanguage()
        mainWindow?.setTitle(mainWindowTitle())
      }
      if (clean.scanRanges !== undefined) {
        rangeScanner?.sync()
        if (clean.scanRanges.some((cidr) => !previousScanRanges.has(cidr))) {
          rangeSync?.scheduleShareSoon()
        }
      }
      if (clean.autoLaunch !== undefined) applyAutoLaunch(clean.autoLaunch)
      if (clean.captureShortcut !== undefined || clean.showHideShortcut !== undefined) {
        registerGlobalShortcuts()
      }
      return broadcastSettings()
    }
    return settingsView()
  })

  const ADDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/

  ipcMain.handle(IpcChannels.netAddPeer, (_event, addr: unknown): boolean => {
    if (typeof addr !== 'string' || !appState) return false
    const m = ADDR_RE.exec(addr.trim())
    if (!m) return false
    const host = m[1]
    const port = m[2] ? Number(m[2]) : udpPort
    if (port < 1 || port > 65535) return false
    const normalized = m[2] ? `${host}:${port}` : host
    if (!appState.config.manualPeers.includes(normalized)) {
      saveAppSettings(appState, {
        manualPeers: [...appState.config.manualPeers, normalized].slice(0, 100)
      })
    }
    discovery?.probe(host, port) // 立即探测，秒回 alive 即上列表
    return true
  })

  ipcMain.handle(IpcChannels.netScan, (_event, cidr: unknown): number => {
    if (typeof cidr !== 'string' || !discovery) return -1
    const normalized = normalizeCidr(cidr)
    if (!normalized) return -1
    const hosts = parseCidr(normalized)
    if (!hosts) return -1
    return discovery.scanHosts(hosts, udpPort, 8, { key: `manual:${normalized}` })
  })

  ipcMain.handle(IpcChannels.netScanAllRanges, (): ScanProgressView => startGlobalRangeScan())

  ipcMain.handle(IpcChannels.peersSetRemark, (_event, nodeId: unknown, remark: unknown) => {
    if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 64) return
    if (typeof remark !== 'string' || remark.length > 32) return
    const trimmed = remark.trim()
    peersRepo?.setRemark(nodeId, trimmed)
    if (trimmed) remarks.set(nodeId, trimmed)
    else remarks.delete(nodeId)
    broadcastEvent(IpcEvents.peersUpdated, peerViews())
  })

  ipcMain.handle(IpcChannels.uiOpenSettings, () => {
    openSettingsWindow(mainWindow, settingsView().fontScale)
  })

  // 文件柜（决议 #283，形态改为主窗页签见 #284）：把主窗切到文件柜页签，
  // 带 peerId 时直接定位到该同事的柜子。设置窗与托盘等非主窗调用方都走这里。
  ipcMain.handle(IpcChannels.uiOpenCabinet, (_event, peerId: unknown) => {
    const target =
      typeof peerId === 'string' && peerId.length > 0 && peerId.length <= LIMITS.id ? peerId : ''
    showMainWindow()
    mainWindow?.webContents.send(IpcEvents.cabinetFocusPeer, target)
  })

  // Hive #52：独立机库窗口（headless 恒拒绝，且给出显式原因，不静默什么都不做）。
  // #57：memberId 参数目前不改变窗口内容（机库页自行按 memberId 过滤），仅透传。
  ipcMain.handle(IpcChannels.hiveOpenHangar, (_event, memberId?: unknown): HangarOpenResult => {
    if (HEADLESS) return { ok: false, reason: HANGAR_OPEN_REASON.headless }
    const port = localApi?.port() ?? 0
    if (!port) return { ok: false, reason: HANGAR_OPEN_REASON.notReady }
    const opened = openHangarWindow(mainWindow, {
      headless: () => HEADLESS,
      apiPort: () => localApi?.port() ?? 0,
      token: () => process.env['PANTRY_LOCAL_API_TOKEN'] ?? ''
    })
    if (!opened) return { ok: false, reason: HANGAR_OPEN_REASON.notReady }
    const query =
      typeof memberId === 'string' && memberId.trim() ? `?memberId=${encodeURIComponent(memberId.trim())}` : ''
    return { ok: true, url: `http://127.0.0.1:${port}/v1/hangar${query}` }
  })

  // Hive #57：派遣网络图数据面（活跃成员 + 派遣关系 + 负担快照，渲染层星系图与成员表共用）。
  ipcMain.handle(IpcChannels.hiveNetwork, (): HiveNetworkSnapshot => {
    const state = dispatchStore?.snapshot()
    return {
      maxDepth: state?.maxDepth ?? 3,
      maxConcurrency: state?.maxConcurrency ?? 5,
      nodes: peerViews().map((peer) => ({
        nodeId: peer.nodeId,
        name: resolvePeerDisplayName(peer.nodeId) || peer.nick,
        online: peer.online,
        ...(peer.burden ? { burden: peer.burden } : {}),
        ...(peer.hive ? { hive: peer.hive } : {})
      }))
    }
  })

  // Hive #52 AC4：clear —— 旧实例归档、同位置新实例、目标由人重定。
  ipcMain.handle(IpcChannels.hiveClear, (_event, memberId: unknown): HiveClearResult => {
    const target = typeof memberId === 'string' ? memberId.trim() : ''
    if (target === '' || target.length > LIMITS.id) {
      return { ok: false, archived: [], epoch: 0, goalPending: false, reason: '成员 id 无效' }
    }
    // GUI 发起：actor = 本机身份（主人）。跨机成员的路由归生命周期 owner（#51/#59），
    // 本票只保证「账本所在节点」的 clear 语义正确；不是本机账本时显式拒绝，不假装成功。
    const result = clearHiveMember(target, appState?.nodeId)
    if (result.ok) {
      localApi?.emit('member.lifecycle', {
        memberId: target,
        phase: 'archive',
        reason: 'clear',
        epoch: result.epoch,
        sessions: result.archived
      })
    }
    return result
  })

  // Hive #54：回收派遣成员——输出交接校验通过才放行（fail-closed），之后 leave +
  // 硬删（成员表 + 登记表）+ 机库归档（reclaim）+ quit + 释放 slot。
  ipcMain.handle(
    IpcChannels.hiveReclaim,
    (_event, memberId: unknown, handoverMarkdown: unknown): Promise<HiveReclaimResult> => {
      const target = typeof memberId === 'string' ? memberId.trim() : ''
      if (target === '' || target.length > LIMITS.id) {
        return Promise.resolve({ ok: false, reason: '成员 id 无效' })
      }
      if (typeof handoverMarkdown !== 'string') {
        return Promise.resolve({ ok: false, reason: '交接文档必须是 Markdown 文本' })
      }
      return reclaimHiveMember(target, handoverMarkdown)
    }
  )

  // ---- Hive #59：待领取任务查询 + 人工补派 ----
  // 判权（谁能补派）在 DispatchService.claimAndDispatch；这里只做输入形状校验与转发。

  ipcMain.handle(IpcChannels.hiveClaimableList, (): HiveClaimableState => {
    const store = dispatchStore
    if (!store) return { selfId: appState?.nodeId ?? '', tasks: [] }
    return {
      selfId: appState?.nodeId ?? '',
      tasks: store.listClaimable().map(toClaimableView)
    }
  })

  ipcMain.handle(IpcChannels.hiveClaimNow, async (_event, dispatchId: unknown): Promise<HiveClaimResult> => {
    const id = typeof dispatchId === 'string' ? dispatchId.trim() : ''
    if (id === '' || id.length > LIMITS.id * 2) {
      return { ok: false, reason: '任务 id 无效' }
    }
    const svc = dispatchService
    if (!svc) return { ok: false, reason: '派遣服务未启用' }
    // actor = 本机身份：只有任务原主人才有权补派（AC3）。
    const outcome = await svc.claimAndDispatch({ dispatchId: id, actorId: appState?.nodeId ?? '' })
    broadcastClaimable() // 无论成败，待领取面都可能变了（成功=少一条；失败=换了条）
    if (outcome.outcome === 'rejected') {
      return { ok: false, reason: outcome.reason ?? HIVE_CLAIM_TEXT.gone }
    }
    if (outcome.outcome === 'claimable') {
      // 补派这一轮也没摇起来：任务已重新落一条新的待领取，显式报告不假装成功。
      return {
        ok: false,
        reason: `补派失败，任务仍是待领取：${outcome.task?.reason ?? outcome.reason ?? '未知原因'}`
      }
    }
    return { ok: true, dispatchId: outcome.dispatchId, memberIds: outcome.memberIds ?? [] }
  })

  ipcMain.handle(IpcChannels.imgOpenViewer, async (_event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length > 64) return false
    const media = await managedInlineImageView(transferId)
    if (!media) return false
    openImageViewerWindow(transferId, media.view.name)
    return true
  })

  ipcMain.handle(IpcChannels.imgViewerNavigation, async (event, transferId: unknown) => {
    if (typeof transferId !== 'string' || !transferId || transferId.length > 64) return null
    if (!event.sender.getURL().includes('#/image-viewer?') || !msgRepoRef) return null
    return getImageViewerNavigation(transferId, msgRepoRef, async (id) => {
      const media = await managedInlineImageView(id)
      return media ? { msgId: media.view.msgId, name: media.view.name } : null
    })
  })

  ipcMain.handle(IpcChannels.imgFitViewerWindow, (event, width: unknown, height: unknown): number => {
    const viewerWindow = BrowserWindow.fromWebContents(event.sender)
    if (!viewerWindow || viewerWindow === mainWindow) return 1
    if (!event.sender.getURL().includes('#/image-viewer?')) return 1
    const imageWidth = parseImageDimension(width)
    const imageHeight = parseImageDimension(height)
    if (!imageWidth || !imageHeight) return 1

    const display = screen.getDisplayMatching(viewerWindow.getBounds())
    const fit = fitImageViewerContent({
      imageWidth,
      imageHeight,
      workAreaWidth: display.workAreaSize.width,
      workAreaHeight: display.workAreaSize.height
    })

    if (viewerWindow.isMaximized()) viewerWindow.unmaximize()
    viewerWindow.setContentSize(fit.contentWidth, fit.contentHeight)
    viewerWindow.center()
    return fit.scale
  })

  ipcMain.handle(IpcChannels.imgOcrSource, async (event, transferId: unknown): Promise<ImageOcrSource | null> => {
    if (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > 64) return null
    if (!event.sender.getURL().includes('#/image-viewer?')) return null
    const media = await managedInlineImageView(transferId)
    if (!media) return null
    const { view } = media
    if (view.totalSize <= 0 || view.totalSize > IMAGE_SOURCE_MAX_BYTES) return null
    try {
      const buf = await readFile(view.savedPath)
      if (buf.length === 0 || buf.length > IMAGE_SOURCE_MAX_BYTES) return null
      if (!imagePreview.isInlineNamedBytes(view.savedPath, buf)) return null
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      return { name: view.name, size: buf.length, bytes }
    } catch {
      return null
    }
  })

  ipcMain.handle(IpcChannels.imgOcrResultGet, (event, transferId: unknown, cacheKey: unknown): ImageOcrResult | null => {
    if (typeof transferId !== 'string' || typeof cacheKey !== 'string') return null
    if (!event.sender.getURL().includes('#/image-viewer?')) return null
    if (!managedTransferMediaView(transferId)) return null
    return imageOcrCache.get(transferId, cacheKey)
  })

  ipcMain.handle(
    IpcChannels.imgOcrResultSet,
    (event, transferId: unknown, cacheKey: unknown, result: unknown): boolean => {
      if (typeof transferId !== 'string' || typeof cacheKey !== 'string') return false
      if (!event.sender.getURL().includes('#/image-viewer?')) return false
      const view = files?.transferView(transferId)
      if (!view?.savedPath || view.status !== 'done') return false
      return imageOcrCache.set(transferId, cacheKey, result)
    }
  )

  ipcMain.handle(
    IpcChannels.groupCreate,
    (
      _event,
      name: unknown,
      memberIds: unknown,
      adminPassword: unknown,
      adminHint: unknown
    ) => {
      if (typeof name !== 'string' || name.length > 32) return null
      if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > GROUP_MAX_MEMBERS) {
        return null
      }
      if (!memberIds.every((m) => typeof m === 'string' && m.length > 0 && m.length <= 64)) {
        return null
      }
      const secret = typeof adminPassword === 'string' && adminPassword.length <= 64 ? adminPassword : ''
      const hint = typeof adminHint === 'string' && adminHint.length <= 40 ? adminHint : ''
      return groups?.createGroup(name, memberIds as string[], secret, hint) ?? null
    }
  )

  ipcMain.handle(IpcChannels.groupUpdate, (_event, groupId: unknown, patch: unknown) => {
    if (typeof groupId !== 'string' || groupId.length > 64) return null
    if (typeof patch !== 'object' || patch === null) return null
    const p = patch as Record<string, unknown>
    const password = (): string | undefined =>
      p.adminPassword === undefined
        ? undefined
        : typeof p.adminPassword === 'string' && p.adminPassword.length <= 64
          ? p.adminPassword
          : undefined
    const ids = (value: unknown): string[] | null =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= GROUP_MAX_MEMBERS &&
      value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
        ? (value as string[])
        : null
    const hasOnly = (keys: string[]): boolean => Object.keys(p).every((key) => keys.includes(key))
    let clean: GroupPatch
    if (
      p.kind === 'rename' &&
      hasOnly(['kind', 'name', 'adminPassword']) &&
      typeof p.name === 'string' &&
      p.name.length <= 32
    ) {
      const adminPassword = password()
      if (p.adminPassword !== undefined && adminPassword === undefined) return null
      clean = { kind: 'rename', name: p.name, ...(adminPassword ? { adminPassword } : {}) }
    } else if (p.kind === 'invite' && hasOnly(['kind', 'memberIds'])) {
      const memberIds = ids(p.memberIds)
      if (!memberIds) return null
      clean = { kind: 'invite', memberIds }
    } else if (p.kind === 'remove' && hasOnly(['kind', 'memberIds', 'adminPassword'])) {
      const memberIds = ids(p.memberIds)
      const adminPassword = password()
      if (!memberIds || (p.adminPassword !== undefined && adminPassword === undefined)) return null
      // #53：成员主人判定是底座群管理权之前的第一道闸门；拒绝带明确 code 回渲染层。
      const denied = authorizeHiveMemberRemove(groupId, memberIds[0])
      if (denied) {
        return { hiveDenied: true, ...denied } satisfies HiveMemberRemoveDeny
      }
      clean = { kind: 'remove', memberIds, ...(adminPassword ? { adminPassword } : {}) }
    } else if (
      p.kind === 'set-avatar' &&
      hasOnly(['kind', 'avatarHash', 'adminPassword']) &&
      (p.avatarHash === '' || isAvatarHash(p.avatarHash))
    ) {
      const adminPassword = password()
      if (p.adminPassword !== undefined && adminPassword === undefined) return null
      clean = {
        kind: 'set-avatar',
        avatarHash: p.avatarHash,
        ...(adminPassword ? { adminPassword } : {})
      }
    } else if (
      p.kind === 'set-admin' &&
      hasOnly(['kind', 'memberId', 'enabled']) &&
      typeof p.memberId === 'string' &&
      p.memberId.length > 0 &&
      p.memberId.length <= 64 &&
      typeof p.enabled === 'boolean'
    ) {
      clean = { kind: 'set-admin', memberId: p.memberId, enabled: p.enabled }
    } else if (
      p.kind === 'set-description' &&
      hasOnly(['kind', 'description', 'adminPassword']) &&
      typeof p.description === 'string' &&
      p.description.length <= LIMITS.groupDescription
    ) {
      const adminPassword = password()
      if (p.adminPassword !== undefined && adminPassword === undefined) return null
      clean = { kind: 'set-description', description: p.description, ...(adminPassword ? { adminPassword } : {}) }
    } else if (
      p.kind === 'set-announce' &&
      hasOnly(['kind', 'announce', 'adminPassword']) &&
      typeof p.announce === 'string' &&
      p.announce.length <= LIMITS.groupAnnounce
    ) {
      const adminPassword = password()
      if (p.adminPassword !== undefined && adminPassword === undefined) return null
      clean = { kind: 'set-announce', announce: p.announce, ...(adminPassword ? { adminPassword } : {}) }
    } else {
      return null
    }
    const updated = groups?.updateGroup(groupId, clean) ?? null
    if (clean.kind === 'remove') finishHiveMemberRemove(updated)
    return updated
  })

  ipcMain.handle(
    IpcChannels.groupSetAvatar,
    async (
      _event,
      groupId: unknown,
      bytes: unknown,
      adminPassword: unknown
    ) => {
      if (typeof groupId !== 'string' || groupId.length === 0 || groupId.length > LIMITS.id) {
        return null
      }
      if (
        adminPassword !== undefined &&
        (typeof adminPassword !== 'string' || adminPassword.length > LIMITS.groupAdminPassword)
      ) {
        return null
      }
      let avatarHash = ''
      if (bytes !== null) {
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > AVATAR_MAX_BYTES) return null
        avatarHash = (await avatarStore.save(bytes)) ?? ''
        if (!avatarHash) return null
      }
      const updated = groups?.updateGroup(groupId, {
        kind: 'set-avatar',
        avatarHash,
        ...(typeof adminPassword === 'string' && adminPassword
          ? { adminPassword }
          : {})
      }) ?? null
      if (updated && avatarHash) broadcastAvatarReady(avatarHash)
      scheduleAvatarPrune()
      return updated
    }
  )

  ipcMain.handle(IpcChannels.groupLeave, (_event, groupId: unknown) => {
    if (typeof groupId === 'string' && groupId.length <= 64) groups?.leaveGroup(groupId)
  })

  ipcMain.handle(IpcChannels.groupGet, (_event, groupId: unknown) => {
    if (typeof groupId !== 'string' || groupId.length > 64) return null
    return groups?.get(groupId) ?? null
  })

  ipcMain.handle(IpcChannels.groupList, () => groups?.list() ?? [])

  ipcMain.handle(IpcChannels.groupSend, (_event, groupId: unknown, text: unknown, mentions: unknown, replyTo: unknown) => {
    if (typeof groupId !== 'string' || groupId.length > 64) return null
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) return null
    const cleanMentions =
      Array.isArray(mentions) && mentions.every((m) => typeof m === 'string' && m.length <= 64)
        ? (mentions as string[]).slice(0, GROUP_MAX_MEMBERS)
        : []
    // IPC 只允许携带源消息 ID；senderName/text 由主进程在当前群会话内查询生成
    const replyMeta: string | undefined =
        replyTo && typeof replyTo === 'string' && replyTo.length > 0 && replyTo.length <= LIMITS.id
        ? replyTo
        : undefined
    return groups?.sendText(groupId, text, cleanMentions, replyMeta) ?? null
  })

  // ---- Hive #50：pending 查询 / 确认键 / 丢弃 / 放权 / 冻结目标 ----
  // 权限判定全部在 PendingService（fail-closed + 留痕）；这里只做输入形状校验与转发。

  ipcMain.handle(IpcChannels.hivePendingState, (): HivePendingState | null => {
    const svc = pendingService
    if (!svc) return null
    return pendingStateView(svc)
  })

  /** #50 状态查询投影（pendings + 全量 goals；渲染层药丸与目标徽标共用一次读取）。 */
  function pendingStateView(svc: PendingService): HivePendingState {
    return {
      pendings: svc.list().map((p) => ({
        memberId: p.memberId,
        groupId: p.groupId,
        entries: p.entries.map((e) => ({ senderId: e.senderId, text: e.text, ts: e.ts })),
        createdAt: p.createdAt
      })),
      goals: svc.allGoals(),
      confirmGrants: svc.grants(),
      selfId: appState?.nodeId ?? ''
    }
  }

  ipcMain.handle(
    IpcChannels.hivePendingConfirm,
    (_event, memberId: unknown, goalText: unknown): HivePendingResult => {
      const svc = pendingService
      if (!svc || typeof memberId !== 'string' || memberId.length === 0 || memberId.length > 64) {
        return { ok: false, code: 'invalid_input', reason: 'pending 未启用或参数非法' }
      }
      const draft = svc.get(memberId)
      const outcome = svc.confirm({
        actorId: appState?.nodeId ?? '',
        memberId,
        ownerId: memberRegistry?.get(memberId)?.ownerId,
        group: groups?.get(draft?.groupId ?? '') ?? null,
        ...(typeof goalText === 'string' && goalText.trim() ? { goalText } : {})
      })
      if (!outcome.ok) return { ok: false, code: outcome.code, reason: outcome.reason }
      // 确认 = 恰好发送一次聚合 prompt（走 bridge 串行队列；未启用 runner = 显式失败不静默）。
      const groupId = draft?.groupId ?? ''
      if (!agentBridge?.enqueueAggregate(outcome.prompt ?? '', groupId)) {
        return { ok: false, code: 'agent_disabled', reason: 'agent 未启用，聚合 prompt 未发送' }
      }
      return { ok: true }
    }
  )

  ipcMain.handle(IpcChannels.hivePendingDrop, (_event, memberId: unknown): HivePendingResult => {
    const svc = pendingService
    if (!svc || typeof memberId !== 'string' || memberId.length === 0 || memberId.length > 64) {
      return { ok: false, code: 'invalid_input', reason: 'pending 未启用或参数非法' }
    }
    const draft = svc.get(memberId)
    if (!draft) return { ok: false, code: 'no_pending', reason: '该成员没有 pending' }
    const ownerId = memberRegistry?.get(memberId)?.ownerId
    // 丢弃也是主人权限（出口仅主人确认或主人丢弃，#30）。
    if (!ownerId || ownerId !== appState?.nodeId) {
      return { ok: false, code: 'not_owner', reason: '只有成员主人可以丢弃 pending' }
    }
    svc.drop(memberId, appState?.nodeId ?? '', draft.groupId)
    return { ok: true }
  })

  ipcMain.handle(
    IpcChannels.hivePendingGrant,
    (_event, targetId: unknown, grant: unknown): HivePendingResult => {
      const svc = pendingService
      if (
        !svc ||
        typeof targetId !== 'string' ||
        targetId.length === 0 ||
        targetId.length > 64 ||
        typeof grant !== 'boolean'
      ) {
        return { ok: false, code: 'invalid_input', reason: 'pending 未启用或参数非法' }
      }
      const group = groups?.list().find((g) => g.amMember) ?? null
      const outcome = svc.grant({
        actorId: appState?.nodeId ?? '',
        targetId,
        ownerId: memberRegistry?.get(appState?.nodeId ?? '')?.ownerId,
        group: group ? { members: group.members } : null,
        grant,
        groupId: group?.groupId ?? ''
      })
      return outcome.ok ? { ok: true } : { ok: false, code: outcome.code, reason: outcome.reason }
    }
  )

  ipcMain.handle(
    IpcChannels.hiveGoalFreeze,
    (_event, memberId: unknown, groupId: unknown, text: unknown): HivePendingResult => {
      const svc = pendingService
      if (
        !svc ||
        typeof memberId !== 'string' ||
        memberId.length === 0 ||
        memberId.length > 64 ||
        typeof groupId !== 'string' ||
        groupId.length === 0 ||
        groupId.length > 64 ||
        typeof text !== 'string' ||
        text.trim() === ''
      ) {
        return { ok: false, code: 'invalid_input', reason: 'pending 未启用或参数非法' }
      }
      const outcome = svc.freezeGoal({
        actorId: appState?.nodeId ?? '',
        memberId,
        ownerId: memberRegistry?.get(memberId)?.ownerId,
        groupId,
        text
      })
      return outcome.ok ? { ok: true } : { ok: false, code: outcome.code, reason: outcome.reason }
    }
  )


  // ——— #49 Agent 接入（ipc 层只做转发与参数守卫，判定在 hive/agent-*） ———

  ipcMain.handle(IpcChannels.agentProbe, () => probeRuntimes())

  ipcMain.handle(IpcChannels.agentAttach, async (_event, request: unknown) => {
    // 参数校验在 attachMember 内（fail-closed 并给可操作建议），这里只保证形状是对象。
    if (typeof request !== 'object' || request === null) {
      return {
        ok: false,
        memberId: '',
        nodeId: '',
        dataDir: '',
        apiPort: 0,
        udpPort: 0,
        tcpPort: 0,
        runtime: 'claude',
        adapterPath: '',
        model: '',
        permissionMode: '',
        hint: '这是界面内部错误，请重开接入对话框',
        error: '接入参数不是对象'
      } satisfies AttachResult
    }
    return attachAgentMember(request)
  })

  ipcMain.handle(IpcChannels.agentAttachList, () =>
    listAttached({ attachStatePath }).map((m) => ({
      memberId: m.memberId,
      runtime: m.runtime,
      nick: m.nick,
      cwd: m.cwd,
      model: m.model,
      permissionMode: m.permissionMode,
      dataDir: m.dataDir,
      udpPort: m.udpPort,
      tcpPort: m.tcpPort,
      apiPort: m.apiPort,
      pid: m.pid,
      attachedAt: m.attachedAt
    }))
  )

  ipcMain.handle(IpcChannels.captureStart, () => startCapture())

  ipcMain.handle(IpcChannels.captureReady, (event) => {
    showCaptureWindow(event.sender)
  })

  ipcMain.handle(IpcChannels.captureDone, (_event, bytes: unknown, send: unknown) => {
    closeCaptureWindow()
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return
    if (bytes.byteLength > 30 * 1024 * 1024) return
    if (!writeClipboardImage(bytes)) return // 始终进剪贴板（随处可贴）
    if (send === true && mainWindow) {
      showMainWindow({ forceForeground: true })
      mainWindow.webContents.send(IpcEvents.captured, bytes)
    }
  })

  ipcMain.handle(IpcChannels.clipboardWriteImage, (_event, bytes: unknown) => {
    if (!(bytes instanceof ArrayBuffer)) return false
    return writeClipboardImage(bytes)
  })

  ipcMain.handle(IpcChannels.clipboardReadImage, () => readClipboardImage())

  ipcMain.handle(IpcChannels.stickerFetchSource, async (_event, transferId: unknown) => {
    if (typeof transferId !== 'string' || transferId.length > 64) return null
    const media = await managedInlineImageView(transferId)
    if (!media) return null
    return readStickerSource(media.view.savedPath)
  })

  ipcMain.handle(IpcChannels.stickerImportSource, async (event, pathValue: unknown) => {
    if (typeof pathValue !== 'string') return null
    const path = filterImagePickerPaths([pathValue])[0]
    if (!path || !stickerImportPathGrants.consume(event.sender.id, [path])) return null
    return readStickerSource(path)
  })

  ipcMain.handle(IpcChannels.imgThumbnailHas, async (_event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > 64) {
      return false
    }
    if (!(await managedInlineImageView(transferId))) return false
    return imagePreview.hasThumbnail(transferId)
  })

  ipcMain.handle(
    IpcChannels.imgThumbnailCache,
    async (_event, transferId: unknown, bytes: unknown): Promise<boolean> => {
      if (typeof transferId !== 'string' || transferId.length === 0 || transferId.length > 64) {
        return false
      }
      if (!(bytes instanceof ArrayBuffer)) return false
      const media = await managedInlineImageView(transferId)
      if (!media || media.animated) return false
      return imagePreview.cacheThumbnail(transferId, bytes)
    }
  )

  ipcMain.handle(
    IpcChannels.stickerAdd,
    (_event, bytes: unknown, ext: unknown, w: unknown, h: unknown) => {
      if (!stickerRepo) return null
      if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0) return null
      if (bytes.byteLength > 2 * 1024 * 1024) return null // GIF ≤2MB / 静图压缩后远小于此
      if (ext !== '.webp' && ext !== '.gif' && ext !== '.png') return null
      const width = typeof w === 'number' && w > 0 ? Math.round(w) : 0
      const height = typeof h === 'number' && h > 0 ? Math.round(h) : 0
      const id = randomUUID()
      mkdirSync(stickersDir(), { recursive: true })
      const path = join(stickersDir(), `${id}${ext}`)
      writeFileSync(path, Buffer.from(bytes))
      stickerRepo.insert(id, path, width, height, ext === '.gif')
      return { id, w: width, h: height, animated: ext === '.gif' }
    }
  )

  ipcMain.handle(IpcChannels.stickerList, () =>
    (stickerRepo?.list() ?? []).map((r) => ({
      id: r.id,
      w: r.w,
      h: r.h,
      animated: r.animated !== 0
    }))
  )

  ipcMain.handle(IpcChannels.stickerRemove, (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length > 64 || !stickerRepo) return
    const path = stickerRepo.remove(id)
    if (path && isPathInsideAny(path, managedStickerRoots())) rmSync(path, { force: true })
  })

  ipcMain.handle(IpcChannels.stickerReorder, (_event, ids: unknown) => {
    if (!stickerRepo || !Array.isArray(ids)) return []
    const clean = ids.filter((id): id is string => typeof id === 'string' && id.length <= 64)
    stickerRepo.reorder(clean)
    return stickerRepo.list().map((r) => ({
      id: r.id,
      w: r.w,
      h: r.h,
      animated: r.animated !== 0
    }))
  })

  ipcMain.handle(IpcChannels.stickerSend, async (_event, targetId: unknown, id: unknown, isGroup: unknown) => {
    if (typeof targetId !== 'string' || targetId.length === 0 || targetId.length > 64) return null
    if (typeof id !== 'string' || id.length > 64 || !stickerRepo) return null
    if (typeof isGroup !== 'boolean') return null
    const row = stickerRepo.get(id)
    if (!row) return null
    if (!isPathInsideAny(row.path, managedStickerRoots())) return null
    return (
      (await (isGroup
        ? files?.offerGroupPaths(targetId, [row.path], 'sticker')
        : files?.offerPaths(targetId, [row.path], 'sticker'))) ?? null
    )
  })

  ipcMain.handle(IpcChannels.searchQuery, (_event, query: unknown) => {
    if (typeof query !== 'string' || query.length > 64 || !search) {
      return { peers: [], messageGroups: [], files: [] }
    }
    return search.query(query)
  })

  ipcMain.handle(IpcChannels.msgSearch, (_event, options: unknown) => {
    const clean = normalizeConversationSearch(options)
    if (!clean || !search) return []
    return search.conversation(clean)
  })

  ipcMain.handle(IpcChannels.msgContext, (_event, convId: unknown, seq: unknown) => {
    if (typeof convId !== 'string' || convId.length > 128 || !msgRepoRef) return []
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return []
    return msgRepoRef.around(convId, seq, 25).map(msgRowToView)
  })

  ipcMain.handle(IpcChannels.msgGet, (_event, msgId: unknown) => {
    if (typeof msgId !== 'string' || msgId.length === 0 || msgId.length > LIMITS.id || !msgRepoRef) return null
    const row = msgRepoRef.get(msgId)
    if (!row) return null
    return msgRowToView(row)
  })

  ipcMain.handle(IpcChannels.imgSaveAs, async (event, transferId: unknown): Promise<boolean> => {
    if (typeof transferId !== 'string' || transferId.length > 64) return false
    const view = managedTransferMediaView(transferId)
    if (!view) return false
    const owner = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined
    const options = {
      title: tr('图片另存为'),
      defaultPath: basename(view.savedPath)
    }
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    try {
      await copyFile(view.savedPath, result.filePath)
      return true
    } catch (err) {
      console.warn('[files] 图片另存失败：', err)
      return false
    }
  })

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    remoteView.start()
    void imagePreview.prune()
    const updateCaps = canAdvertiseUpdateSource() ? [CAPS.updateSource] : []
    appState = loadAppState(app.getPath('userData'), app.getVersion(), tcpPort, udpPort, [
      DISCOVERY_PROBE_CAP,
      CAPS.mediaRecall,
      CAPS.fileDirect,
      CAPS.tableText,
      CAPS.transferWait,
      CAPS.groupRoles,
      CAPS.avatarImages,
      CAPS.fileCabinet,
      // #49：带 agent 的节点（= 接入进来的成员）必须声明 ag1，否则它的负担行在别人的
      // 成员表里**根本不 eligible**，真实 usage 上报了也画不出环。两条来源各自独立成立。
      ...(process.env['PANTRY_AGENT_STATUS'] || process.env['PANTRY_AGENT_COMMAND']
        ? [AGENT_STATUS_CAP]
        : []),
      ...updateCaps
    ], app.getPreferredSystemLanguages()[0] || app.getLocale())
    initMemberRegistry(app.getPath('userData')) // #53：成员主人登记表（本机账本）
    initHangar() // #52：机库读取面 + 归档索引（账本根在 artifacts root）
    initDispatchStore(app.getPath('userData')) // #51：派遣账本（派遣关系/slot/待领取）
    initPendingService(app.getPath('userData')) // #50：pending/授权/目标（PANTRY_PENDING=1 时启用）
    initGoalGuard() // #55：目标守卫（HIVE_GOAL_GUARD_URL 配置时启用）
    initAgentAttach() // #49：本机接入账本（谁是怎么接进来的）+ GUI 接入面
    void runStartupRecovery() // #58：重启恢复唯一入口（接入重拉 / 中断派遣转待领取 / 幽灵 pending 清理）
    await setLanguage(appState.config.language)
    udpPort = envUdpPort ?? appState.config.udpPort
    tcpPort = envTcpPort ?? appState.config.tcpPort
    netState.udpPort = udpPort
    appState.profile.tcpPort = tcpPort
    applyAutoLaunch(appState.config.autoLaunch)
    // 文件柜权限判定只依赖本机配置，库不可用时例外退化为内存态（决议 #271/#277）
    share = new ShareService({
      getRoot: () => appState?.config.fileCabinet.root ?? '',
      getDefaultMode: () => appState?.config.fileCabinet.mode ?? 'off',
      getGrants: () => shareGrantsRepo
    })

    // pantry-img://<transferId> —— 渲染层取图的唯一通道（绕开 file:// 的 CSP/安全限制，
    // 且只放行 transfers 表里登记过的路径，不开任意文件读取口子）
    protocol.registerFileProtocol('pantry-img', (request, callback) => {
      try {
        const transferId = new URL(request.url).hostname
        void managedInlineImageView(transferId)
          .then((media) => {
            callback(media ? { path: media.view.savedPath } : { error: -6 })
          })
          .catch(() => callback({ error: -6 }))
        return
      } catch {
        // fallthrough
      }
      callback({ error: -6 }) // net::ERR_FILE_NOT_FOUND
    })

    // pantry-thumb://<transferId> —— 仅服务可重建的受限派生缩略图；未命中安全回退原图。
    protocol.registerFileProtocol('pantry-thumb', (request, callback) => {
      try {
        const transferId = new URL(request.url).hostname
        void managedInlineImageView(transferId)
          .then(async (media) => {
            if (!media) {
              callback({ error: -6 })
              return
            }
            const path = await imagePreview.resolvePreviewPath(transferId, media.view.savedPath)
            callback(path ? { path } : { error: -6 })
          })
          .catch(() => callback({ error: -6 }))
        return
      } catch {
        // fallthrough
      }
      callback({ error: -6 })
    })

    // pantry-sticker://<id> —— 同理，只放行表情库登记过的路径
    protocol.registerFileProtocol('pantry-sticker', (request, callback) => {
      try {
        const id = new URL(request.url).hostname
        const row = stickerRepo?.get(id)
        if (row && isPathInsideAny(row.path, managedStickerRoots())) {
          callback({ path: row.path })
          return
        }
      } catch {
        // fallthrough
      }
      callback({ error: -6 })
    })

    // pantry-avatar://asset/<sha256> —— 只映射受管目录中的已校验 WebP，不暴露任意本地路径。
    protocol.registerFileProtocol('pantry-avatar', (request, callback) => {
      try {
        const hash = avatarHashFromUrl(request.url)
        if (!hash) {
          callback({ error: -6 })
          return
        }
        void avatarStore
          .resolvePath(hash)
          .then((path) => callback(path ? { path } : { error: -6 }))
          .catch(() => callback({ error: -6 }))
        return
      } catch {
        // fallthrough
      }
      callback({ error: -6 })
    })

    if (!HEADLESS) createMainWindow()
    if (!HEADLESS) {
      tray = setupTray({
        showWindow: showMainWindow,
        quit: () => {
          isQuitting = true
          app.quit()
        }
      })
    }
    void startNet()
    if (!HEADLESS) registerGlobalShortcuts()
    startLocalApi()

    // 冒烟模式：窗口能起、1.5s 后干净退出即算通过（tech-design §10 的 CI 烟测同款）
    if (process.env['PANTRY_SMOKE']) {
      setTimeout(() => {
        isQuitting = true
        app.quit()
      }, 1500)
    }
  })

  app.on('activate', () => {
    if (!HEADLESS) showMainWindow() // macOS 点 Dock 唤起
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())

  let diagnosticQuit = false
  let diagnosticClosing = false
  app.on('before-quit', event => {
    if (diagnosticQuit) return
    event.preventDefault()
    if (diagnosticClosing) return
    diagnosticClosing = true
    remoteView.close()
    isQuitting = true
    stopTrayUnreadFlash(tray)
    rangeSync?.stop()
    rangeSync = null
    rangeScanner?.stop()
    rangeScanner = null
    if (globalScanProgress.running) {
      globalScanProgress = {
        ...globalScanProgress,
        status: 'idle',
        running: false,
        finishedAt: Date.now()
      }
    }
    agentStatus?.stop()
    agentStatus = null
    closeHangarWindow() // #52：机库窗口随进程退出（它只是个 local-api 视图）
    discovery?.stop() // 广播 + 单播 exit，让对端立刻变灰而不是等 90s 超时
    discovery = null
    if (pruneTimer) clearInterval(pruneTimer)
    if (persistTimer) clearTimeout(persistTimer)
    if (avatarPruneTimer) clearTimeout(avatarPruneTimer)
    void files?.stop()
    try {
      if (registry && peersRepo) peersRepo.upsertMany(registry.values()) // 离场前最后一次落库
      db?.close()
    } catch (err) {
      console.error('[store] 退出落库失败：', err)
    }
    db = null
    // local-api / agent bridge 与 diagnostics 共用一个既有的 2s 预算（#14 H7 要求不延长）；预算用尽即放行。
    const localApiStopped = (localApi?.stop() ?? Promise.resolve()).catch(() => undefined)
    // bridge.dispose() 会回收 runner 子进程（shutdown → SIGTERM → SIGKILL），防孤儿进程。
    const agentStopped = (agentBridge?.dispose() ?? agentRunner?.dispose() ?? Promise.resolve()).catch(
      () => undefined
    )
    let timer: ReturnType<typeof setTimeout>
    void Promise.race([
      Promise.all([diagnostics.close(), localApiStopped, agentStopped]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 2000) })
    ])
      .finally(() => { clearTimeout(timer); diagnosticQuit = true; app.quit() })
  })

  // 所有窗口都关闭时退出；主窗关闭到托盘由 createMainWindow 的 close 事件拦截。
  // headless 无窗，这一行是唯一的“防自杀”闸门（ADR-0002 Decision 1 H5）。
  app.on('window-all-closed', () => {
    if (!HEADLESS) app.quit()
  })
}
