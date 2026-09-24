// 交接文档校验的最小冒烟（#54）：只钉契约主干——缺节拒、sha256 不匹配拒、齐全放行。
// 黑客松速度模式：不追覆盖率，非关键断言不留。
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { parseHandoverDoc, verifyHandover, handoverRejectText } from './handover'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

const artifact = (path: string, content: string): string =>
  `产物：\`m1:${path}\` · sha256 \`${sha(content)}\` · 复跑：\`cat ${path}\``

const doc = (artLine: string, refLine: string): string => `# 交接：目标

- 派遣者：m1
- 会话：s1

## 当前目标

目标一句话

## 已完成

- 做了事
  - ${artLine}

## 关键决策

- 决策 — 依据：/x

## 产物引用

- ${refLine}

## 未决问题

- 无

## 下一步

- 无

## suggested skills

- \`research\` — 需要
`

const goodContent = 'result-data\n'
const goodDoc = doc(
  artifact('/tmp/a.txt', goodContent),
  artifact('/tmp/a.txt', goodContent)
)

describe('parseHandoverDoc', () => {
  it('抽出 7 节与头部元数据', () => {
    const parsed = parseHandoverDoc(goodDoc)
    expect(parsed.missing).toEqual([])
    expect(parsed.header['派遣者']).toBe('m1')
    expect(parsed.sections['当前目标']).toContain('目标一句话')
  })

  it('缺节列进 missing（容忍不崩）', () => {
    const parsed = parseHandoverDoc('# 交接\n\n## 当前目标\n\nx\n')
    expect(parsed.missing.length).toBe(6)
  })
})

describe('verifyHandover', () => {
  const deps = (files: Record<string, string> = { '/tmp/a.txt': goodContent }) => ({
    readArtifact: (path: string) => (path in files ? Buffer.from(files[path]) : null)
  })

  it('齐全且 sha256 一致 → ok', () => {
    const verdict = verifyHandover(goodDoc, deps())
    expect(verdict.ok).toBe(true)
    expect(verdict.errors).toEqual([])
    // 「已完成」内嵌 + 「产物引用」索引各一条（RULES §2：以内嵌为准）。
    expect(verdict.artifacts).toHaveLength(2)
    expect(verdict.artifacts[0]).toEqual({
      machine: 'm1',
      path: '/tmp/a.txt',
      sha256: sha(goodContent),
      rerun: 'cat /tmp/a.txt'
    })
  })

  it('缺节 → 拒绝（fail-closed）', () => {
    const bad = goodDoc.replace(/^## 未决问题[\s\S]*?(?=^## )/m, '')
    const verdict = verifyHandover(bad, deps())
    expect(verdict.ok).toBe(false)
    expect(verdict.errors.join()).toContain('未决问题')
  })

  it('sha256 不匹配 → 拒绝', () => {
    const verdict = verifyHandover(goodDoc, deps({ '/tmp/a.txt': 'tampered\n' }))
    expect(verdict.ok).toBe(false)
    expect(verdict.errors.join()).toContain('sha256 不匹配')
  })

  it('产物不可读 → 拒绝', () => {
    const verdict = verifyHandover(goodDoc, deps({}))
    expect(verdict.ok).toBe(false)
    expect(verdict.errors.join()).toContain('产物不可读')
  })

  it('已完成条目缺三件套 → 拒绝（防幻觉）', () => {
    const bad = goodDoc.replace(/^  - 产物：.*$/m, '')
    const verdict = verifyHandover(bad, deps())
    expect(verdict.ok).toBe(false)
    expect(verdict.errors.join()).toContain('没有任何产物三件套')
  })
})

describe('handoverRejectText (#60)', () => {
  it('含拒绝原因、零实质输出与重发要求', () => {
    const text = handoverRejectText('sha256 不匹配：/tmp/a.txt')
    expect(text).toContain('拒绝接手')
    expect(text).toContain('sha256 不匹配')
    expect(text).toContain('零实质输出')
    expect(text).toContain('重发')
    expect(text).not.toContain('产物：') // 不泄露交接正文
  })
})
