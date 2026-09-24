import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// 文件柜上传前的体量测算（决议 #272/#278）。
// 零 Electron 依赖，vitest 可直接调用。

/** 目录递归上限：与 files.ts 的出站准备同口径，防软链成环与病态深度 */
const MAX_DEPTH = 32

/**
 * 每批并发的条目数。批内并发让 libuv 线程池跑满、速度接近同步遍历，
 * 批与批之间的 await 又保证事件循环能处理别的活。
 */
const BATCH = 64

export interface UploadMeasure {
  fileCount: number
  totalSize: number
}

/**
 * 统计选中路径下的文件数与总字节数；有任何条目读不到就整体返回 null
 * （宁可让用户重选，也不要传一半才发现缺文件）。
 *
 * **必须是异步的**：它遍历用户选中的整棵目录树，同步版在几万文件的
 * 文件夹上会占满主进程事件循环，把聊天、传输进度和托盘一起卡住
 * （决议 #278，沿用决议 #231 的异步化口径）。
 */
export async function measureUploadPaths(paths: string[]): Promise<UploadMeasure | null> {
  let fileCount = 0
  let totalSize = 0
  let pending = paths.map((path) => ({ path, depth: 0 }))

  while (pending.length > 0) {
    const batch = pending.splice(0, BATCH)
    const children: typeof pending = []
    const measured = await Promise.all(
      batch.map(async (item) => {
        if (item.depth > MAX_DEPTH) return null
        try {
          const st = await stat(item.path)
          if (st.isDirectory()) {
            for (const name of await readdir(item.path)) {
              children.push({ path: join(item.path, name), depth: item.depth + 1 })
            }
            return { files: 0, bytes: 0 }
          }
          // 设备文件、FIFO 等非常规条目跳过，不计入也不算失败
          return st.isFile() ? { files: 1, bytes: st.size } : { files: 0, bytes: 0 }
        } catch {
          return null
        }
      })
    )
    for (const one of measured) {
      if (!one) return null
      fileCount += one.files
      totalSize += one.bytes
    }
    pending = pending.concat(children)
  }

  return fileCount > 0 ? { fileCount, totalSize } : null
}
