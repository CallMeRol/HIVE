import { describe, expect, it } from 'vitest'
import { isWindows7 } from './windows-version'

describe('Windows 版本判定', () => {
  it('仅识别 Windows NT 6.1', () => {
    expect(isWindows7('win32', '6.1.7601')).toBe(true)
    expect(isWindows7('win32', '6.1')).toBe(true)
    expect(isWindows7('win32', '6.2.9200')).toBe(false)
    expect(isWindows7('win32', '10.0.22631')).toBe(false)
    expect(isWindows7('win32', '6.10.0')).toBe(false)
    expect(isWindows7('linux', '6.1.0')).toBe(false)
    expect(isWindows7('darwin', '23.0.0')).toBe(false)
  })
})
