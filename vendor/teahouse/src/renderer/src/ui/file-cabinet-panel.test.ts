import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(
  new URL('../components/FileCabinetPanel.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

const chatSource = readFileSync(
  new URL('../components/ChatPane.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

describe('文件柜翻页失败不清空列表（决议 #278）', () => {
  it('首屏失败与翻页失败用两个独立状态', () => {
    expect(panelSource).toContain('const failReason = ref<ShareBrowseFailReason | null>(null)')
    expect(panelSource).toContain('const moreFailReason = ref<ShareBrowseFailReason | null>(null)')
  })

  it('loadMore 失败只写 moreFailReason，绝不碰整页错误态', () => {
    const body = panelSource.slice(
      panelSource.indexOf('async function loadMore()'),
      panelSource.indexOf('function onScroll(')
    )
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('moreFailReason.value = result.reason')
    // 整页错误态只属于首屏 load()，翻页写它就会把已加载条目整片替换掉
    expect(body).not.toContain('failReason.value = result.reason')
    // 快照失效仍按原样静默重来
    expect(body).toContain("if (result.reason === 'gone')")
  })

  it('翻页失败后停止自动续拉，交给用户点重试', () => {
    const body = panelSource.slice(
      panelSource.indexOf('function onScroll('),
      panelSource.indexOf('function goUp(')
    )
    expect(body).toContain('if (moreFailReason.value) return')
  })

  it('失败提示挂在列表末尾并带重试按钮', () => {
    expect(panelSource).toMatch(
      /v-else-if="moreFailReason"[\s\S]{0,200}\{\{ moreFailText \}\}[\s\S]{0,200}@click="loadMore"/
    )
  })

  it('重新载入目录会清掉翻页失败提示', () => {
    const body = panelSource.slice(
      panelSource.indexOf('async function load('),
      panelSource.indexOf('async function loadMore()')
    )
    expect(body).toContain('moreFailReason.value = null')
  })
})

describe('切换会话重置文件柜面板（决议 #278）', () => {
  it('会话切换的 watch 里与群成员面板一起收起', () => {
    const watchBody = chatSource.slice(
      chatSource.indexOf('  () => chatStore.activeConv?.peerId,'),
      chatSource.indexOf('{ immediate: true }')
    )
    expect(watchBody.length).toBeGreaterThan(0)
    expect(watchBody).toContain('showMembers.value = false')
    expect(watchBody).toContain('showCabinet.value = false')
  })
})

describe('文件柜面板细节一致性（决议 #281）', () => {
  it('体积走统一的 formatBytes，不再自带一份实现', () => {
    expect(panelSource).toContain("import { formatBytes } from '../utils/format'")
    expect(panelSource).toContain('formatBytes(entry.size)')
    expect(panelSource).not.toContain('function formatSize(')
  })

  it('截断提示用常量插值，改常量文案不会说谎', () => {
    expect(panelSource).toContain('import { SHARE_DIR_MAX_ENTRIES')
    expect(panelSource).toContain("tr('目录内容过多，仅显示前 {0} 项', { 0: SHARE_DIR_MAX_ENTRIES })")
    expect(panelSource).not.toContain('仅显示前 5000 项')
  })

  it('还有下一页时不说「全选」，避免让人以为选中了 total 项', () => {
    expect(panelSource).toContain(
      "const pickAllLabel = computed(() => (hasMore.value ? tr('选择已加载') : tr('全选')))"
    )
    expect(panelSource).toContain('{{ pickAllLabel }}')
  })

  it('长文件名截断后可用原生提示看到全称', () => {
    expect(panelSource).toContain('class="row-name" :title="entry.name"')
  })

  it('拖拽高亮只在真正离开面板时熄灭', () => {
    expect(panelSource).toContain('@dragleave="onDragLeave"')
    expect(panelSource).toContain('function onDragLeave(')
    expect(panelSource).toContain('.contains(next)) return')
  })
})

describe('面板与文件柜页签对齐（决议 #283/#284）', () => {
  it('头部有权限徽标与「在文件柜里打开」，后者带上当前对端', () => {
    expect(panelSource).toContain(":title=\"tr('在文件柜里打开')\"")
    expect(panelSource).toContain('window.pantry.openCabinet(props.peerId)')
    // 徽标上移到头部后，底栏留给选中摘要与按钮
    expect(panelSource).toMatch(/class="panel-head"[\s\S]{0,400}class="perm"/)
  })

  it('单击选中、双击才进目录，支持 Ctrl / Shift 多选', () => {
    expect(panelSource).toContain('@click="onRowClick(index, $event)"')
    expect(panelSource).toContain('@dblclick="onRowOpen(index)"')
    expect(panelSource).toContain('event.ctrlKey || event.metaKey')
    expect(panelSource).toContain('event.shiftKey && cursor.value >= 0')
    // 目录不再"单击即跳走"
    expect(panelSource).not.toContain('@click="open(entry)"')
  })

  it('行高收到 36px 且不再挤修改时间列', () => {
    expect(panelSource).toMatch(/\.row \{[\s\S]{0,200}height: 36px;/)
    expect(panelSource).not.toContain('class="row-time"')
  })

  it('导航栏入口切页签而不是开新窗口（决议 #284）', () => {
    const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
    expect(appSource).toContain("data-label=\"tr('文件柜')\"")
    expect(appSource).toContain('name="cabinet"')
    // 文件柜是主窗第三个页签：列表栏与内容区各占一格，不再有独立窗口
    expect(appSource).toContain("type Tab = 'chat' | 'contacts' | 'cabinet'")
    expect(appSource).toContain("tab.value = 'cabinet'")
    expect(appSource).toContain('<CabinetList v-else-if="tab === \'cabinet\'" />')
    expect(appSource).toContain('<CabinetPane v-if="tab === \'cabinet\'" />')
    // 设置窗等非主窗调用方仍走 IPC，由主进程把主窗切过去
    expect(appSource).toContain('window.pantry.onCabinetFocusPeer')
  })

  it('文件柜不再有独立窗口与第五个渲染入口', () => {
    const entrySource = readFileSync(new URL('../renderer-entry.ts', import.meta.url), 'utf8')
    expect(entrySource).not.toContain('CabinetApp')
    expect(entrySource).not.toContain("'#/cabinet'")
  })
})
