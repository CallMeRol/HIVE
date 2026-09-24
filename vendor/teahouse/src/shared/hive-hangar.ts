// Hive 机库命令面的返回形状（#52）。放 shared 是因为主进程与 preload 要讲同一套词。
//
// 通道复用两个新开的 GUI IPC（`hive:open-hangar` / `hive:clear`）：
// 机库**读**面走 local-api（`GET /v1/hangar*`，headless 与 GUI 同源），
// 命令面（打开窗口 / clear）走 renderer IPC —— 与 #53 的判权动作同一纪律：
// 「带权限语义的动作走 renderer IPC，不做成 local-api 第五个端点」。
export interface HangarOpenResult {
  ok: boolean
  /** 已打开的机库窗口的 local-api 地址（供 GUI 提示/排障）。 */
  url?: string
  /** headless 或 local-api 未就绪时的显式原因。 */
  reason?: string
}

export interface HiveClearResult {
  ok: boolean
  /** 被归档的旧实例会话（clear 的可见结果）。 */
  archived: string[]
  /** 新实例纪元（从 1 起，每次 clear 递增）。 */
  epoch: number
  /** 目标是否待人重定——clear 后恒为 true。 */
  goalPending: boolean
  reason?: string
}

export const HANGAR_OPEN_REASON = {
  headless: 'headless 节点不创建机库窗口（ADR-0002）',
  notReady: 'local-api 尚未就绪，请稍后重试'
} as const

export const HIVE_CLEAR_TEXT = {
  notOwner: '只有该成员的主人可以 clear',
  unavailable: '机库未装配，无法 clear'
} as const

/** #54 回收命令面的返回形状（renderer 与 preload 共用）。 */
export interface HiveReclaimResult {
  ok: boolean
  /** 回收完成的成员 id（ok=true 时回填）。 */
  memberId?: string
  /** 随回收归档进机库的会话（AC5：仍可读可搜）。 */
  archivedSessions?: string[]
  /** 通过复验的产物数。 */
  artifactCount?: number
  /** fail-closed 拒绝原因（判权 / 交接校验 / 底座移出失败）。 */
  reason?: string
}
