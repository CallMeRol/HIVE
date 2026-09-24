import { extname } from 'node:path'
import { IMAGE_FILE_EXTENSIONS } from '../../shared/media'

/** Electron 文件对话框的 extensions 不带点号。 */
export const IMAGE_PICKER_EXTENSIONS = IMAGE_FILE_EXTENSIONS.map((extension) => extension.slice(1))

/**
 * 系统对话框过滤器只改善可见范围，返回主进程后仍需白名单复核再签发路径授权。
 */
export function filterImagePickerPaths(paths: string[]): string[] {
  const allowed = new Set<string>(IMAGE_FILE_EXTENSIONS)
  return paths.filter(
    (path) =>
      path.length > 0 && path.length < 2048 && allowed.has(extname(path).toLowerCase())
  )
}
