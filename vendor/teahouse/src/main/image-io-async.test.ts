import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(start: string, end: string): string {
  const from = mainSource.indexOf(start)
  const to = mainSource.indexOf(end, from + start.length)
  expect(from, `缺少起始标记 ${start}`).toBeGreaterThanOrEqual(0)
  expect(to, `缺少结束标记 ${end}`).toBeGreaterThan(from)
  return mainSource.slice(from, to)
}

describe('主进程图片大文件 I/O', () => {
  it('图片暂存使用异步文件 API', () => {
    const staging = sourceBetween('async function stageOutgoingImagePath', 'type OfferImagePaths')

    expect(mainSource).toContain("from 'node:fs/promises'")
    expect(staging).toContain('await mkdir(')
    expect(staging).toContain('await copyFile(')
    expect(staging).toContain('await writeFile(')
    expect(staging).not.toContain('copyFileSync(')
  })

  it('OCR 图源读取与图片另存使用异步文件 API', () => {
    const ocrSource = sourceBetween('IpcChannels.imgOcrSource', 'IpcChannels.imgOcrResultGet')
    const saveAs = sourceBetween('IpcChannels.imgSaveAs', "app.on('second-instance'")

    expect(ocrSource).toContain('await readFile(')
    expect(ocrSource).not.toContain('readFileSync(')
    expect(saveAs).toContain('await copyFile(')
    expect(saveAs).not.toContain('copyFileSync(')
  })
})
