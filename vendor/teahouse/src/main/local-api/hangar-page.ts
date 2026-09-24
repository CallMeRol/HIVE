// 机库页面（#52）——由 local-api 承载的**单页静态机库**（Spec #41：「机库由同一
// loopback local-api 页面承载，并可在 GUI 模式中由独立 BrowserWindow 打开」）。
//
// 为什么不是 Vue 组件：机库要能被 headless 节点开出来（GUI 与 headless 都挂同一个
// local-api），而 headless 不建任何窗口。自包含的 HTML + 原生 fetch 让
// `GET /v1/hangar` 在两种节点上都可读，CI 也能直接抓它做断言。
//
// 纪律：页面**只渲染** `/v1/hangar/*` 返回的原始数据，不做总结、不做折叠
// （ADR-0008：「不加工、不总结、不折叠原始过程」）。
export const HANGAR_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Hive 机库</title>
<style>
  /* Hive 视觉规范（docs/design-drafts/HIVE-VISUAL-SPEC.md）：底 #0a0e17 + 强调红 #e94560，
     次文字 #9aa7b5，数字等宽。不用 teahouse 绿。 */
  :root { color-scheme: dark; --bg: #0a0e17; --line: rgba(230,237,243,.10); --text: #e6edf3; --dim: #9aa7b5;
    --accent: #e94560; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.6 system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    padding: 10px 14px; background: var(--bg); border-bottom: 1px solid var(--line); }
  h1 { margin: 0; font-size: 15px; letter-spacing: .06em; }
  input[type=search], select { min-height: 30px; padding: 4px 8px; background: #111826; color: var(--text);
    border: 1px solid var(--line); border-radius: 4px; font: inherit; }
  input[type=search] { flex: 1; min-width: 180px; }
  .tag { color: var(--dim); font-size: 12px; }
  main { padding: 12px 14px 60px; }
  .zone { margin-bottom: 22px; }
  .zone > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .12em; color: var(--dim);
    margin: 0 0 8px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  .member { border: 1px solid var(--line); border-radius: 6px; margin-bottom: 10px; overflow: hidden; }
  .member > .head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; padding: 8px 10px;
    cursor: pointer; background: #0d1320; }
  .member > .head:hover { background: #121a2b; }
  .name { font-weight: 600; }
  .burden { padding: 1px 7px; border: 1px solid currentColor; border-radius: 999px; font-size: 11px; }
  .goal { color: var(--dim); }
  .goal.pending { color: var(--accent); }
  .sessions { padding: 0 10px 10px; }
  .session { border-top: 1px solid var(--line); padding: 8px 0; }
  .session > .head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; cursor: pointer; }
  .sid { font-family: var(--mono); font-size: 12px; color: var(--dim); }
  .turn { border-left: 2px solid var(--line); margin: 8px 0 0 4px; padding-left: 10px; }
  .turn > .head { font-family: var(--mono); font-size: 12px; color: var(--dim); cursor: pointer; }
  .entry { border-left: 2px solid #223; margin: 6px 0 0 6px; padding-left: 8px; }
  .entry > .head { font-family: var(--mono); font-size: 11px; color: var(--dim); }
  .kind { color: var(--accent); }
  pre { margin: 4px 0 0; padding: 6px 8px; background: #0d1320; border: 1px solid var(--line);
    border-radius: 4px; overflow: auto; max-height: 340px; white-space: pre-wrap; word-break: break-word;
    font-family: var(--mono); font-size: 12px; }
  .empty { color: var(--dim); font-style: italic; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  label.chip { display: inline-flex; gap: 4px; align-items: center; padding: 2px 8px; font-size: 12px;
    border: 1px solid var(--line); border-radius: 999px; cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>机库 · Hangar</h1>
  <span class="tag" id="meta">加载中…</span>
  <input type="search" id="q" placeholder="全文搜索原始过程（不加工、不总结）" />
  <div class="filters" id="filters"></div>
</header>
<main id="app"></main>
<script>
const $ = (id) => document.getElementById(id)
let state = { data: null, kinds: [], q: '', zones: { active: true, archived: true } }

async function api(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(path + ' → ' + res.status)
  return res.json()
}

function el(tag, cls, text) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

async function load() {
  state.data = await api('/v1/hangar')
  const kinds = new Set()
  for (const member of state.data.members) {
    for (const session of member.sessions) for (const kind of Object.keys(session.kinds)) kinds.add(kind)
    for (const session of member.archive) for (const kind of Object.keys(session.kinds)) kinds.add(kind)
  }
  state.kinds = [...kinds].sort()
  $('meta').textContent =
    'nodeId=' + state.data.nodeId + ' · 活跃 ' + state.data.totals.activeSessions +
    ' / 归档 ' + state.data.totals.archivedSessions + ' 会话 · 无 TTL'
  renderFilters()
  render()
}

function renderFilters() {
  const box = $('filters')
  box.replaceChildren()
  for (const kind of state.kinds) {
    const label = el('label', 'chip')
    const box2 = document.createElement('input')
    box2.type = 'checkbox'
    box2.checked = true
    box2.addEventListener('change', () => {
      if (box2.checked) state.selected.add(kind)
      else state.selected.delete(kind)
      render()
    })
    state.selected = state.selected ?? new Set(state.kinds)
    label.append(box2, document.createTextNode(kind))
    box.append(label)
  }
}

function matchesKinds(session) {
  if (!state.selected || state.selected.size === 0) return false
  return Object.keys(session).some((kind) => state.selected.has(kind))
}

function render() {
  const app = $('app')
  app.replaceChildren()
  if (!state.data || state.data.members.length === 0) {
    app.append(el('p', 'empty', '本机还没有任何成员过程账本（成员被 @ 后才有会话）。'))
    return
  }
  for (const zone of ['active', 'archived']) {
    const section = el('section', 'zone')
    section.append(el('h2', null, zone === 'active' ? '活跃' : '归档'))
    let count = 0
    for (const member of state.data.members) {
      const sessions = member[zone]
      if (!sessions.length) continue
      count += 1
      section.append(renderMember(member, zone, sessions))
    }
    if (count === 0) section.append(el('p', 'empty', zone === 'active' ? '无活跃会话' : '无归档会话'))
    app.append(section)
  }
}

function renderMember(member, zone, sessions) {
  const box = el('div', 'member')
  const head = el('div', 'head')
  head.append(el('span', 'name', member.nick || member.memberId))
  head.append(el('span', 'sid', member.memberId))
  if (member.burden) {
    const b = el('span', 'burden', member.burden.label + (member.burden.pct === null ? '' : ' ' + member.burden.pct + '%'))
    b.style.color = member.burden.color
    head.append(b)
  }
  const goal = el('span', 'goal' + (member.instance.goalPending ? ' pending' : ''),
    member.instance.goal ? '目标：' + member.instance.goal.text
      : (member.instance.goalPending ? '目标待重定（clear 后由人重定）' : '目标未定'))
  head.append(goal)
  head.append(el('span', 'goal', '深度：—'))
  head.append(el('span', 'goal', '实例 epoch=' + member.instance.epoch))
  box.append(head)

  const list = el('div', 'sessions')
  for (const session of sessions) {
    list.append(renderSession(member, session, zone))
  }
  box.append(list)
  return box
}

function renderSession(member, session, zone) {
  const box = el('div', 'session')
  const head = el('div', 'head')
  head.append(el('span', 'sid', session.sessionId))
  head.append(el('span', 'tag', session.turns + ' turn · ' + session.lines + ' 行'))
  head.append(el('span', 'tag', '结束原因：' + (session.stopReason ?? '未结算')))
  if (session.archive) head.append(el('span', 'tag', '归档：' + session.archive.reason))
  box.append(head)
  const body = el('div')
  box.append(body)
  head.addEventListener('click', () => {
    if (body.dataset.loaded === '1') { body.replaceChildren(); body.dataset.loaded = '0'; return }
    void loadTimeline(member.memberId, session.sessionId, body)
  })
  if (zone === 'archived') void loadTimeline(member.memberId, session.sessionId, body)
  return box
}

async function loadTimeline(memberId, sessionId, body) {
  body.dataset.loaded = '1'
  const params = new URLSearchParams()
  if (state.selected && state.selected.size > 0 && state.selected.size < state.kinds.length) {
    params.set('kinds', [...state.selected].join(','))
  }
  if (state.q) params.set('q', state.q)
  const url = '/v1/hangar/timeline?memberId=' + encodeURIComponent(memberId) +
    '&sessionId=' + encodeURIComponent(sessionId) + (params.toString() ? '&' + params.toString() : '')
  const data = await api(url)
  body.replaceChildren()
  const turns = groupByTurn(data.entries)
  for (const turn of turns) {
    const box = el('div', 'turn')
    box.append(el('div', 'head', turn.label))
    for (const entry of turn.entries) {
      const item = el('div', 'entry')
      item.append(el('div', 'head', new Date(entry.ts).toISOString() + ' · ' + entry.kind))
      const pre = el('pre', null, JSON.stringify(entry.data, null, 2))
      item.append(pre)
      box.append(item)
    }
    body.append(box)
  }
  if (data.entries.length === 0) body.append(el('p', 'empty', '（无匹配条目）'))
}

function groupByTurn(entries) {
  const turns = []
  let current = { label: 'turn 之前的入向/出向', entries: [] }
  for (const entry of entries) {
    if (entry.kind === 'turn') {
      const id = entry.data && entry.data.sessionId ? entry.data.sessionId : ''
      turns.push(current)
      current = { label: 'turn · ' + (id || '(未命名)') + ' · ' + new Date(entry.ts).toISOString(), entries: [entry] }
    } else {
      current.entries.push(entry)
    }
  }
  turns.push(current)
  return turns.filter((turn) => turn.entries.length > 0)
}

$('q').addEventListener('input', (event) => {
  state.q = event.target.value.trim()
  clearTimeout(window.__t)
  window.__t = setTimeout(() => { for (const body of document.querySelectorAll('.sessions > div > div[data-loaded="1"]')) body.dataset.loaded = '0' }, 200)
})
$('q').addEventListener('change', () => void load())

void load().catch((err) => { $('meta').textContent = '加载失败：' + err.message })
</script>
</body>
</html>
`
