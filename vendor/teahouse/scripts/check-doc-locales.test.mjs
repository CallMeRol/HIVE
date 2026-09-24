import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyDocumentationLocales } from './check-doc-locales.mjs'

const temporaryDirectories = []

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'pantry-doc-locales-'))
  temporaryDirectories.push(root)
  mkdirSync(join(root, 'docs', 'en'), { recursive: true })
  return root
}

function lines(text) {
  return `${text}\n${Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')}`
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
  }
})

describe('文档多语言校验', () => {
  it('接受双向入口与有效本地链接', () => {
    const root = createFixture()
    writeFileSync(join(root, 'docs', 'source.md'), lines('[English](en/source.md)'))
    writeFileSync(join(root, 'docs', 'en', 'source.md'), lines('[简体中文](../source.md)\n[Index](README.md)'))
    writeFileSync(join(root, 'docs', 'en', 'README.md'), lines('# Index'))

    expect(verifyDocumentationLocales(root, [['docs/source.md', 'docs/en/source.md']])).toEqual([])
  })

  it('报告缺失文档、单向入口与无效链接', () => {
    const root = createFixture()
    writeFileSync(join(root, 'docs', 'source.md'), '# source')
    writeFileSync(join(root, 'docs', 'en', 'source.md'), lines('[Missing](missing.md)'))

    expect(verifyDocumentationLocales(root, [
      ['docs/source.md', 'docs/en/source.md'],
      ['docs/absent.md', 'docs/en/absent.md']
    ])).toEqual(expect.arrayContaining([
      'docs/source.md 缺少英文入口 en/source.md',
      'docs/en/source.md 缺少中文入口 ../source.md',
      'docs/en/source.md 含无效本地链接：missing.md',
      '缺少中文文档：docs/absent.md',
      '缺少英文文档：docs/en/absent.md'
    ]))
  })
})
