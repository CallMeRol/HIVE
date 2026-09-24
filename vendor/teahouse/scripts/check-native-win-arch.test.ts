import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { checkNativeWinArch, readPeMachine } = require('./check-native-win-arch.cjs') as {
  checkNativeWinArch: (filePath: string, expectedArch: 'x64' | 'ia32') => void
  readPeMachine: (filePath: string) => number
}

const tempDirs: string[] = []

function writePe(machine: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'pantry-pe-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'better_sqlite3.node')
  const data = Buffer.alloc(128)
  data.write('MZ', 0, 'ascii')
  data.writeUInt32LE(64, 0x3c)
  data.write('PE\0\0', 64, 'ascii')
  data.writeUInt16LE(machine, 68)
  writeFileSync(filePath, data)
  return filePath
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Windows native 模块架构校验', () => {
  it('识别并接受 ia32 PE machine', () => {
    const filePath = writePe(0x014c)
    expect(readPeMachine(filePath)).toBe(0x014c)
    expect(() => checkNativeWinArch(filePath, 'ia32')).not.toThrow()
  })

  it('拒绝把 x64 native 模块装入 ia32 包', () => {
    const filePath = writePe(0x8664)
    expect(() => checkNativeWinArch(filePath, 'ia32')).toThrow(/架构不匹配/)
  })
})
