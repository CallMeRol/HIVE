import type DatabaseT from 'better-sqlite3'
import { isShareMode, type ShareMode } from '../../shared/protocol'

// 共享文件柜按联系人例外（决议 #271/#277）。
// 只存与默认档不同的例外行：恢复"跟随默认"即删行，读取时缺行 = 跟随默认档。
// 共享根路径与默认档在 config.json（app-state），不进本表。

interface GrantRow {
  node_id: string
  mode: string
  updated_ts: number
}

export interface ShareGrantRecord {
  nodeId: string
  mode: ShareMode
  updatedTs: number
}

export class ShareGrantsRepo {
  private readonly upsertStmt: DatabaseT.Statement
  private readonly deleteStmt: DatabaseT.Statement
  private readonly selectAllStmt: DatabaseT.Statement

  constructor(db: DatabaseT.Database) {
    this.upsertStmt = db.prepare(`
      INSERT INTO share_grants (node_id, mode, updated_ts)
      VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET mode = excluded.mode, updated_ts = excluded.updated_ts
    `)
    this.deleteStmt = db.prepare('DELETE FROM share_grants WHERE node_id = ?')
    this.selectAllStmt = db.prepare('SELECT * FROM share_grants ORDER BY updated_ts DESC')
  }

  /** 写入例外；传 null 表示恢复"跟随默认档"（删行）。 */
  set(nodeId: string, mode: ShareMode | null, at = Date.now()): void {
    if (mode === null) this.deleteStmt.run(nodeId)
    else this.upsertStmt.run(nodeId, mode, at)
  }

  /** 全量载入为 nodeId → 例外档；损坏行按"无例外"忽略，不致命。 */
  loadAll(): Map<string, ShareMode> {
    const rows = this.selectAllStmt.all() as GrantRow[]
    const map = new Map<string, ShareMode>()
    for (const row of rows) {
      if (isShareMode(row.mode)) map.set(row.node_id, row.mode)
    }
    return map
  }

  list(): ShareGrantRecord[] {
    const rows = this.selectAllStmt.all() as GrantRow[]
    return rows
      .filter((row) => isShareMode(row.mode))
      .map((row) => ({
        nodeId: row.node_id,
        mode: row.mode as ShareMode,
        updatedTs: row.updated_ts
      }))
  }
}
