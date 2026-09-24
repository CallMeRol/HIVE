import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
) as {
  license?: string
  build?: {
    extraResources?: Array<{ from?: string; to?: string }>
    mac?: { extraResources?: Array<{ from?: string; to?: string }> }
  }
}
const licenseText = readFileSync(new URL('../../../../LICENSE', import.meta.url), 'utf8')
const readmeText = readFileSync(new URL('../../../../README.md', import.meta.url), 'utf8')

describe('项目主许可元数据', () => {
  it('统一声明 GPL-3.0-only', () => {
    expect(packageJson.license).toBe('GPL-3.0-only')
    expect(licenseText).toContain('GNU GENERAL PUBLIC LICENSE')
    expect(licenseText).toContain('Version 3, 29 June 2007')
    expect(readmeText).toContain('GPL-3.0-only')
  })

  it('安装包资源目录携带根许可证', () => {
    expect(packageJson.build?.extraResources).toContainEqual({
      from: 'LICENSE',
      to: 'LICENSE'
    })
    expect(packageJson.build?.mac?.extraResources).not.toContainEqual({
      from: 'LICENSE',
      to: 'LICENSE'
    })
  })
})
