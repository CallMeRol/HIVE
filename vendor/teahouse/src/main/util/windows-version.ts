import { release } from 'node:os'

/** Windows NT 6.1 同时覆盖 Windows 7 与 Windows Server 2008 R2。 */
export function isWindows7(
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release()
): boolean {
  return platform === 'win32' && /^6\.1(?:\.|$)/.test(osRelease)
}
