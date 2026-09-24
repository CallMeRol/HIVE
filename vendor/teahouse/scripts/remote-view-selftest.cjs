// 真实 Electron 22 + 应用 IPC + 回环协议；采集源替换为本地合成页面，绝不采集用户桌面。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const duration = Number(process.env.PANTRY_SCREEN_TEST_MS) || 6000

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(repo, '.remote-selftest-'))
  require('esbuild').buildSync({
    stdin: { contents: ['src/main/store/app-state.ts', 'src/main/store/db.ts', 'src/main/store/conv-repo.ts',
      'src/main/store/peers-repo.ts', 'src/main/net/udp.ts', 'src/main/net/peer-registry.ts',
      'src/main/net/discovery.ts', 'src/main/net/messenger.ts', 'src/main/net/codec.ts',
      'src/main/net/transfer.ts', 'src/main/services/remote-view.ts', 'src/shared/protocol.ts']
      .map(file => `export * from ${JSON.stringify(path.join(repo, file))}`).join('\n'), resolveDir: repo },
    bundle: true, platform: 'node', target: 'node16', external: ['better-sqlite3'],
    outfile: path.join(directory, 'fixture.cjs'), logLevel: 'silent'
  })
  try {
    const result = spawnSync(require('electron'), [__filename, directory], { cwd: repo, stdio: 'inherit',
      timeout: duration + 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PANTRY_PEERS: '' } })
    assert.equal(result.status, 0, `Electron 自测失败：${result.error || result.signal || result.status}`)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
} else void run().catch(error => { console.error(error); require('electron').app.exit(1) })

async function until(check, label, timeout = 12000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(50) }
  throw new Error(`等待超时：${label}`)
}
async function freePort(type) {
  if (type === 'udp') return new Promise(resolve => {
    const socket = require('node:dgram').createSocket('udp4')
    socket.bind(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) })
  })
  return new Promise(resolve => {
    const server = require('node:net').createServer()
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
  })
}
async function run() {
  const { app, BrowserWindow, desktopCapturer, session, systemPreferences, globalShortcut, powerMonitor, screen } = require('electron')
  if (process.env.PANTRY_SCREEN_SOFTWARE) app.disableHardwareAcceleration()
  const directory = process.argv[2], fixture = require(path.join(directory, 'fixture.cjs'))
  const data = path.join(directory, 'data')
  const ports = await Promise.all(['udp', 'tcp', 'udp', 'tcp'].map(freePort))
  const [appUdp, appTcp, peerUdp, peerTcp] = ports
  process.env.PANTRY_USER_DATA = data
  process.env.PANTRY_SMOKE = '1'
  process.env.PANTRY_UDP_PORT = String(appUdp)
  process.env.PANTRY_TCP_PORT = String(appTcp)
  app.getAppPath = () => repo
  app.getVersion = () => require(path.join(repo, 'package.json')).version
  app.getPreferredSystemLanguages = () => ['zh-CN']
  globalShortcut.register = () => false
  async function shot(win, name) {
    if (!process.env.PANTRY_REMOTE_TEST_ARTIFACTS) return
    fs.mkdirSync(process.env.PANTRY_REMOTE_TEST_ARTIFACTS, { recursive: true })
    await pause(80)
    fs.writeFileSync(path.join(process.env.PANTRY_REMOTE_TEST_ARTIFACTS, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  function metrics(win) {
    const metric = app.getAppMetrics().find(item => item.pid === win.webContents.getOSProcessId())
    return metric ? { cpu: metric.cpu.percentCPUUsage, memoryKB: metric.memory.workingSetSize } : null
  }
  async function visibleActions(win, selector) {
    assert.equal(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).every(e => {
      const r = e.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    })`), true, '操作按钮须完整可见')
  }
  let finished = false
  const quit = app.quit.bind(app)
  app.quit = () => { if (finished) quit() }
  const appState = fixture.loadAppState(data, app.getVersion(), appTcp, appUdp, [], 'zh-CN')
  fixture.saveProfile(appState, { nick: '本机测试', company: '', dept: '', team: '', avatar: -1, fileDir: '' })
  const peerId = 'screen-test-peer'
  const profile = { nodeId: peerId, nick: '协助测试同事', company: '', dept: '', team: '', avatar: -1,
    host: 'loopback', platform: 'mac', tcpPort: peerTcp, profileRev: 1, ver: app.getVersion(), caps: ['rv1', 'rvs1'] }
  const db = fixture.openDatabase(path.join(data, 'data/db/chat.db'))
  new fixture.PeersRepo(db).upsertMany([{ profile, ip: '127.0.0.1', udpPort: peerUdp, lastSeen: Date.now(), online: false }])
  new fixture.ConvRepo(db).ensureSingle(peerId)
  db.close()

  // 双重约束，任何意外真实局域网/公网绑定与发送都直接失败。
  const dgram = require('node:dgram'), createSocket = dgram.createSocket
  dgram.createSocket = function (...args) {
    const socket = createSocket.apply(this, args), bind = socket.bind, send = socket.send
    socket.bind = function (port, address, ...rest) { assert.equal(address, '127.0.0.1'); return bind.call(this, port, address, ...rest) }
    socket.send = function (...params) { assert.equal(params.find(value => typeof value === 'string'), '127.0.0.1'); return send.apply(this, params) }
    return socket
  }
  const net = require('node:net'), listen = net.Server.prototype.listen, connect = net.createConnection
  net.Server.prototype.listen = function (port, address, ...rest) { assert.equal(address, '127.0.0.1'); return listen.call(this, port, address, ...rest) }
  net.createConnection = function (options, ...rest) { assert.equal(options.host, '127.0.0.1'); return connect.call(this, options, ...rest) }
  const errors = []
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', (_event, _level, message) => {
      if (/Uncaught|Unhandled|TypeError|ReferenceError|\[Vue warn\]|Refused to/.test(message)) errors.push(message)
    })
  })
  require(path.join(repo, 'out/main/index.js'))
  await app.whenReady()
  const main = await until(() => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('#/')), '主窗')
  await until(() => main.webContents.executeJavaScript('!!document.querySelector(".shell")'), '主窗加载')
  const source = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const html = path.join(directory, 'source.html')
  fs.writeFileSync(html, '<!doctype html><meta charset="UTF-8"><style>body{font:24px sans-serif;background:#f5f8f6;color:#17211c;padding:35px}table{border-collapse:collapse;width:90%;margin-top:35px}td,th{border:1px solid #bbc8c0;padding:18px}h1{color:#3d8b6b}</style><h1>屏幕协助 · 本地测试页面</h1><p>报错信息：文件未找到，请检查路径后重试。</p><table><tr><th>项目</th><th>状态</th><th>备注</th></tr><tr><td>中文表格可读性</td><td>正常</td><td>只查看画面</td></tr><tr><td>采集 → 编码 → TCP → 解码</td><td>回环验证</td><td>不操作用户桌面</td></tr></table><p id="clock"></p><script>setInterval(()=>clock.textContent="测试时钟 "+new Date().toISOString(),100)</script>')
  await source.loadFile(html)

  // 用合成页面替代系统屏幕枚举；生产的一次性选屏/窗口/角色授权判断照常执行。
  desktopCapturer.getSources = async () => {
    const thumbnail = (await source.webContents.capturePage()).resize({ width: 240 })
    return Array.from({length: 6}, (_, i) => ({ id: 'screen:test:' + i, name: i ? '扩展屏幕 ' + i : '本地合成测试屏幕', display_id: 'test', thumbnail, appIcon: null }))
  }
  const media = session.fromPartition('remote-view')
  if (process.env.PANTRY_SCREEN_DEBUG) {
    const check = media.setPermissionCheckHandler.bind(media), requestPermission = media.setPermissionRequestHandler.bind(media)
    media.setPermissionCheckHandler = handler => check((contents, permission, origin, details) => {
      const allowed = handler(contents, permission, origin, details)
      console.log('[remote-debug] check', permission, details.mediaType, allowed)
      return allowed
    })
    media.setPermissionRequestHandler = handler => requestPermission((contents, permission, callback, details) => {
      handler(contents, permission, allowed => { console.log('[remote-debug] request', permission, details.mediaTypes, allowed); callback(allowed) }, details)
    })
  }
  const displayHandler = media.setDisplayMediaRequestHandler.bind(media)
  media.setDisplayMediaRequestHandler = handler => displayHandler((request, callback) => handler(request, streams => {
    if (process.env.PANTRY_SCREEN_DEBUG) console.log('[remote-debug] display', request.userGesture, Boolean(streams.video))
    callback(streams.video ? { video: source.webContents.mainFrame } : {})
  }))
  const mediaStatus = systemPreferences.getMediaAccessStatus.bind(systemPreferences)
  systemPreferences.getMediaAccessStatus = kind => kind === 'screen' ? 'granted' : mediaStatus(kind)

  const udp = new fixture.UdpChannel({ port: peerUdp, bindAddress: '127.0.0.1', broadcastTargets: [] })
  const registry = new fixture.PeerRegistry(peerId)
  const discovery = new fixture.Discovery({ udp, registry, profile, manualPeers: [{ host: '127.0.0.1', port: appUdp }], timings: { entryReplyJitterBase: 10, entryReplyJitterMax: 10 } })
  const seen = new Set()
  const messenger = new fixture.Messenger({ udp, registry, selfId: peerId,
    queue: { enqueue() { throw Error('屏幕不得进入离线队列') }, listByPeer() { return [] }, remove() {}, prune() { return [] } },
    dedup: { has: id => seen.has(id), add: id => seen.add(id), prune() {} } })
  let sampled = 0, displayed = 0, autoAccept = !process.env.PANTRY_SCREEN_BITMAP_FALLBACK, lastSize = null, slowSample = false, lastFrame = null
  const peer = new fixture.RemoteViewService({ selfId: peerId, peer: id => {
    const p = registry.get(id)
    return p ? { ip: p.ip, online: p.online, tcpPort: p.profile.tcpPort, name: p.profile.nick, caps: p.profile.caps } : null
  }, available: () => ({ view: true, share: true, reason: '' }),
  send: (id, payload, best, signal) => { const env = fixture.makeEnvelope('screen', peerId, payload)
    if (best) { messenger.sendBestEffort(id, env); return Promise.resolve(true) }
    return messenger.sendReliable(id, env, signal)
  }, sample: async () => {
    sampled++
    if (slowSample) await pause(2800)
    return (await source.webContents.capturePage()).resize({ width: 1280, height: 720 }).toJPEG(60)
  },
  display: async (_id, _seq, bytes, width, height) => {
    assert.equal(require('electron').nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty(), false)
    displayed++; lastSize = { width, height }; lastFrame = bytes
  } })
  messenger.on('incoming', (env, info) => { if (env.type === 'screen') peer.receive(env.from, info.address, env.payload) })
  peer.on('state', state => { if (autoAccept && state.phase === 'awaiting-consent') setImmediate(() => { peer.respond(state.sessionId, true); peer.captureReady(state.sessionId) }) })
  const server = new fixture.TransferServer(peerTcp, { resolve: () => null,
    receiveMessage: (env, ip) => messenger.acceptTcpEnvelope(env, ip), openScreen: (socket, open) => peer.open(socket, open) }, '127.0.0.1')
  await server.start(); await udp.start(); discovery.start()
  await until(async () => (await main.webContents.executeJavaScript('window.pantry.getPeers()')).some(p => p.nodeId === peerId && p.online), '发现回环同事')
  const availability = await main.webContents.executeJavaScript('window.pantry.getScreenAvailability()')
  assert.equal(availability.view, true, JSON.stringify(availability))
  await main.webContents.executeJavaScript('document.querySelector(".conv").click()')
  await until(() => main.webContents.executeJavaScript('!!document.querySelector("button[aria-label=查看屏幕]")'), '私聊查看入口')
  const requestedPeer = () => main.webContents.executeJavaScript('document.querySelector("button[aria-label=查看屏幕]").focus(); document.querySelector("button[aria-label=查看屏幕]").click()')
  const screenRecords = () => main.webContents.executeJavaScript(`window.pantry.pageMessages(${JSON.stringify('single:' + peerId)}, null, 50).then(rows => rows.filter(row => row.screenRef))`)
  async function assertCardAlignment(count) {
    const records = await screenRecords()
    assert.equal(records.length, count, '每次请求只保留一条数据库记录')
    assert.equal(await main.webContents.executeJavaScript('document.querySelectorAll(".screen-card").length'), count, '开始结束不追加聊天卡片')
    assert.equal(await main.webContents.executeJavaScript('!!document.querySelector(".screen-status")'), false, '正常会话不重复显示顶部状态条')
    for (const record of records) {
      assert.equal(record.isMine, record.screenRef.role === 'viewer', '按请求发起方保存方向')
      const bounds = await main.webContents.executeJavaScript(`(() => {
        const row = document.getElementById(${JSON.stringify('msg-' + record.id)});
        const card = row?.querySelector('.screen-card');
        if (!card) return null;
        const r = row.getBoundingClientRect(), c = card.getBoundingClientRect();
        return { left: c.left - r.left, right: r.right - c.right, width: c.width, height: c.height, rowWidth: r.width,
          overflow: card.scrollWidth > card.clientWidth, status: !!row.querySelector('.status'), details: card.title };
      })()`)
      assert.ok(bounds, '卡片进入普通消息行')
      assert.ok(Math.abs(record.isMine ? bounds.right : bounds.left) < 1, '自己发起靠右，对方发起靠左')
      assert.ok(bounds.width > 0 && bounds.width <= Math.min(260, bounds.rowWidth * .68) + 1, '紧凑卡片宽度不超过 260px')
      assert.ok(bounds.height <= 84 && !bounds.overflow, '常见状态卡片保持两行，较长翻译允许换行且不溢出')
      assert.ok(bounds.details.includes('：'), '完整起止时间保留在原生悬停详情')
      assert.equal(bounds.status, false, '协助记录不显示消息送达勾选')
    }
  }
  const acceptOnRequest = autoAccept
  autoAccept = false
  await requestedPeer()
  await until(() => main.webContents.executeJavaScript('!!document.querySelector("dialog[open]")'), '发起说明与二次确认')
  assert.equal(peer.getState(), null, '确认前不能给对方发请求')
  assert.equal((await screenRecords()).length, 0, '确认前不生成卡片')
  assert.equal(BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('#/remote-view')), false)
  assert.equal(await main.webContents.executeJavaScript('document.activeElement.textContent.trim()'), '取消', '默认焦点在取消')
  assert.equal(await main.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('dialog'), rect = dialog.getBoundingClientRect();
    return Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 2 && Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < 2
      && getComputedStyle(dialog, '::backdrop').backgroundColor !== 'rgba(0, 0, 0, 0)';
  })()`), true, 'Chrome 108 确认框居中且遮罩可见')
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await until(() => main.webContents.executeJavaScript('document.activeElement === document.querySelector("dialog .primary")'), 'Tab 到确认')
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await until(() => main.webContents.executeJavaScript('document.activeElement === document.querySelector("dialog button")'), 'Tab 焦点留在确认框')
  await shot(main, '00-confirm')
  await main.webContents.executeJavaScript("window.pantry.saveAppSettings({language:'en',theme:'dark'})")
  await until(() => main.webContents.executeJavaScript('document.querySelector("dialog .primary").textContent.trim() === "Send request"'), '英文确认框')
  await visibleActions(main, 'dialog button')
  await shot(main, '00-confirm-dark')
  await main.webContents.executeJavaScript("window.pantry.saveAppSettings({language:'zh-CN',theme:'light'})")
  await until(() => main.webContents.executeJavaScript('document.querySelector("dialog .primary").textContent.trim() === "发送请求"'), '确认框恢复中文')
  await main.webContents.executeJavaScript('document.querySelector("dialog button").click()')
  await until(() => main.webContents.executeJavaScript('!document.querySelector("dialog")'), '取消说明')
  assert.equal(peer.getState(), null)
  assert.equal(main.isVisible(), true, '取消仅关闭弹窗，主窗保持显示')
  await requestedPeer()
  await until(() => main.webContents.executeJavaScript('!!document.querySelector("dialog[open]")'), '重新确认')
  main.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  main.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await until(() => main.webContents.executeJavaScript('!document.querySelector("dialog")'), 'Esc 取消确认')
  assert.equal(peer.getState(), null)
  assert.equal(main.isVisible(), true, '取消仅关闭弹窗，主窗保持显示')
  await requestedPeer()
  await until(() => main.webContents.executeJavaScript('!!document.querySelector("dialog[open]")'), '确认后发送')
  await main.webContents.executeJavaScript('document.querySelector("dialog .primary").click(); document.querySelector("dialog .primary").click()')
  await until(() => peer.getState()?.phase === 'awaiting-consent', '对方只收到一次请求')
  await until(() => main.webContents.executeJavaScript('document.querySelector(".screen-card")?.innerText.includes("等待同意")'), '等待状态进入聊天')
  const requestId = (await screenRecords())[0].id
  await main.webContents.executeJavaScript('void (window.__requestCard = document.querySelector(".screen-card"))')
  await assertCardAlignment(1)
  await shot(main, '01-request-card')
  autoAccept = acceptOnRequest
  const viewer = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('#/remote-view')), '查看窗口')
  if (process.env.PANTRY_SCREEN_BITMAP_FALLBACK) {
    await until(() => viewer.webContents.executeJavaScript('!!document.querySelector(".viewport")'), '回退验证窗口')
    await viewer.webContents.executeJavaScript(`(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) { return type === 'bitmaprenderer' ? null : original.call(this, type, ...args); };
    })()`)
    peer.respond(peer.getState().sessionId, true); peer.captureReady(peer.getState().sessionId)
  }
  if (!process.env.PANTRY_SCREEN_BITMAP_FALLBACK) {
    peer.respond(peer.getState().sessionId, true); peer.captureReady(peer.getState().sessionId)
  }
  await until(() => !viewer.isDestroyed() && viewer.webContents.executeJavaScript('!!document.querySelector(".picture canvas")'), '第一帧解码')
  await until(() => main.webContents.executeJavaScript('document.querySelector(".screen-card")?.innerText.includes("协助中")'), '同一张卡片更新为协助中')
  await assertCardAlignment(1)
  assert.equal((await screenRecords())[0].id, requestId)
  assert.equal(await main.webContents.executeJavaScript('window.__requestCard === document.querySelector(".screen-card")'), true, '开始共享保留原卡片节点')
  await shot(main, '01-chat')
  await shot(viewer, '02-viewer')
  assert.equal(await main.webContents.executeJavaScript('window.pantry.getScreenSources("bad")').then(value => value.length), 0)
  const state = await main.webContents.executeJavaScript('window.pantry.getScreenState()')
  assert.equal(await main.webContents.executeJavaScript(`window.pantry.setScreenMode(${JSON.stringify(state.sessionId)},'economy')`), false, '主窗不可冒充查看窗口')
  for (const mode of ['economy', 'standard', 'smooth', 'auto']) {
    await viewer.webContents.executeJavaScript(`(() => { const select = document.querySelector('select'); select.value=${JSON.stringify(mode)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
    await until(async () => (await viewer.webContents.executeJavaScript('window.pantry.getScreenState()')).mode === mode, mode)
    assert.equal((await viewer.webContents.executeJavaScript('window.pantry.getScreenState()')).sessionId, state.sessionId)
  }
  const chat = await main.webContents.executeJavaScript(`window.pantry.sendText(${JSON.stringify(peerId)}, '屏幕共享期间聊天回归')`)
  assert.ok(chat)
  viewer.minimize(); await pause(350); viewer.restore()
  slowSample = true
  await until(() => viewer.webContents.executeJavaScript('!!document.querySelector(".stale")'), '慢帧提示')
  slowSample = false
  await until(() => viewer.webContents.executeJavaScript('!document.querySelector(".stale")'), '画面恢复')
  await main.webContents.executeJavaScript("window.pantry.saveAppSettings({language:'en',theme:'dark'})")
  await until(() => viewer.webContents.executeJavaScript('document.body.innerText.includes("Smoothness") && document.title === "Screen assistance" && document.documentElement.dataset.theme === "dark"'), '英文与深色即时同步')
  await shot(viewer, '03-dark')
  viewer.setSize(480, 360)
  assert.equal(await viewer.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true, '最小窗口无横向溢出')
  await pause(100)
  await visibleActions(viewer, 'button, select')
  await shot(viewer, '04-small')
  await viewer.webContents.executeJavaScript('document.querySelectorAll(".controls button")[1].click()')
  assert.equal(await viewer.webContents.executeJavaScript('document.querySelector(".viewport").classList.contains("fit")'), false)
  await viewer.webContents.executeJavaScript('document.querySelectorAll(".controls button")[0].click()')
  viewer.setSize(1100, 760)
  await main.webContents.executeJavaScript("window.pantry.saveAppSettings({language:'zh-CN',theme:'light'})")
  await viewer.webContents.executeJavaScript(`(() => { const select = document.querySelector('select'); select.value='smooth'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await pause(1000)
  metrics(viewer)
  const startSamples = sampled, at = Date.now()
  await pause(duration)
  const actualFps = (sampled - startSamples) * 1000 / (Date.now() - at)
  assert.ok(actualFps > 2 && actualFps <= 10.5, `实际帧率 ${actualFps}`)
  if (process.env.PANTRY_REMOTE_TEST_ARTIFACTS) {
    fs.mkdirSync(process.env.PANTRY_REMOTE_TEST_ARTIFACTS, { recursive: true })
    fs.writeFileSync(path.join(process.env.PANTRY_REMOTE_TEST_ARTIFACTS, 'viewer.png'), (await viewer.webContents.capturePage()).toPNG())
  }
  console.log('[review-viewer-metrics]', JSON.stringify(metrics(viewer)))
  assert.equal(await viewer.webContents.executeJavaScript(`!!document.querySelector('.picture canvas').getContext(${process.env.PANTRY_SCREEN_BITMAP_FALLBACK ? '"2d"' : '"bitmaprenderer"'})`), true, '验证实际显示上下文')
  viewer.close()
  await until(() => peer.getState()?.phase === 'ended', '关窗停止')
  console.log(`[remote-view] 查看、四档切换、窗口权限、聊天共存通过；${Date.now() - at}ms / ${actualFps.toFixed(2)} fps`)

  const endedCard = (await screenRecords())[0]
  assert.equal(endedCard.id, requestId, '结束沿用请求记录 ID')
  assert.equal(endedCard.screenRef.phase, 'ended')
  assert.ok(endedCard.screenRef.startedAt >= endedCard.screenRef.requestedAt)
  assert.ok(endedCard.screenRef.durationMs >= duration && endedCard.screenRef.endedAt > endedCard.screenRef.startedAt)
  await until(() => main.webContents.executeJavaScript('document.querySelector(".screen-card")?.innerText.includes("时长")'), '结束卡片原位更新')
  await assertCardAlignment(1)
  assert.equal(await main.webContents.executeJavaScript('window.__requestCard === document.querySelector(".screen-card")'), true, '结束保留原卡片节点')
  console.log('[screen-card]', await main.webContents.executeJavaScript('JSON.stringify(document.querySelector(".screen-card").getBoundingClientRect().toJSON())'))
  await shot(main, '04-completed-card')
  await main.webContents.executeJavaScript("window.pantry.saveAppSettings({language:'en',theme:'dark'})")
  await until(() => main.webContents.executeJavaScript('document.querySelector(".screen-card")?.innerText.includes("Duration")'), '历史卡片切换英文')
  await assertCardAlignment(1)
  await shot(main, '04-completed-dark')
  await main.webContents.executeJavaScript("window.pantry.saveAppSettings({language:'zh-CN',theme:'light'})")
  autoAccept = false
  const inviteSentAt = Date.now()
  assert.deepEqual(peer.request(appState.nodeId), { ok: true })
  const sharer = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('#/remote-view')), '共享确认窗口')
  await until(() => sharer.webContents.executeJavaScript('document.body.innerText.includes("选择屏幕")'), '确认界面')
  await assertCardAlignment(2)
  await shot(sharer, '05-consent')
  await visibleActions(sharer, 'button')
  assert.equal(displayed, 0, '未同意不发送画面')
  assert.equal(await sharer.webContents.executeJavaScript('navigator.mediaDevices.getDisplayMedia({video:true}).then(()=>false,()=>true)', true), true, '未授权不能采集')
  await sharer.webContents.executeJavaScript('document.querySelector(".actions .primary").click()', true)
  await until(() => sharer.webContents.executeJavaScript('!!document.querySelector("input[type=radio]")'), '枚举合成屏幕')
  sharer.setSize(480, 360)
  await pause(100)
  await visibleActions(sharer, '.actions button')
  await shot(sharer, '06-picker-small')
  sharer.setSize(560, 480)
  await shot(sharer, '06-picker')
  await sharer.webContents.executeJavaScript('document.querySelector("input[type=radio]").click()')
  await until(() => sharer.webContents.executeJavaScript('!document.querySelector(".actions .primary").disabled'), '选屏生效')
  await sharer.webContents.executeJavaScript(`(() => {
    const acquire = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    window.__screenAcquires = 0;
    navigator.mediaDevices.getDisplayMedia = async (...args) => { window.__screenAcquires++; const stream = await acquire(...args); window.__screenTestStream = stream; return stream; };
  })()`)
  await sharer.webContents.executeJavaScript('document.querySelector(".actions .primary").click()', true)
  await until(async () => {
    if (peer.getState()?.phase === 'ended') throw new Error('采集失败：' + JSON.stringify({ state: peer.getState(), errors }))
    return displayed >= 5
  }, '实际媒体流、Canvas 编码、IPC 和 TCP', 18000)
  assert.equal(sharer.isAlwaysOnTop(), true)
  await assertCardAlignment(2)
  assert.ok(lastSize.width <= 1600 && lastSize.height <= 1600)
  assert.deepEqual(sharer.getSize(), [320, 56], '同一窗口收为贴边条')
  const area = screen.getDisplayMatching(sharer.getBounds()).workArea
  assert.equal(sharer.getBounds().x + sharer.getBounds().width, area.x + area.width)
  assert.equal(sharer.getBounds().y, area.y)
  assert.equal(sharer.isResizable(), false)
  screen.emit('display-metrics-changed', {}, screen.getDisplayMatching(sharer.getBounds()), ['workArea'])
  assert.equal(sharer.getBounds().y, area.y)
  await visibleActions(sharer, 'button')
  await shot(sharer, '07-sharing')
  await main.webContents.executeJavaScript("window.pantry.saveAppSettings({language:'en',theme:'dark'})")
  await pause(100)
  await visibleActions(sharer, 'button')
  await shot(sharer, '08-sharing-dark')
  assert.equal(await sharer.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true)
  await main.webContents.executeJavaScript("window.pantry.saveAppSettings({language:'zh-CN',theme:'light'})")
  for (const mode of ['smooth', 'standard', 'economy', 'smooth']) {
    peer.setMode(peer.getState().sessionId, mode)
    const fps = mode === 'economy' ? 3 : mode === 'standard' ? 5 : 10
    await until(() => sharer.webContents.executeJavaScript('window.__screenTestStream.getVideoTracks()[0].getSettings().frameRate').then(value => Math.abs(value - fps) < .1), '底层采集档位 ' + mode)
    metrics(sharer)
    const begin = displayed, time = Date.now()
    await pause(process.env.PANTRY_SCREEN_PROFILE ? 10000 : 1200)
    console.log('[review-sharer-metrics]', JSON.stringify({ mode, fps: (displayed - begin) * 1000 / (Date.now() - time), ...metrics(sharer) }))
  }
  assert.equal(await sharer.webContents.executeJavaScript('window.__screenAcquires'), 1, '换档不得重新采集或重新授权')
  source.setContentSize(2560, 1440)
  await source.webContents.executeJavaScript("document.body.style.fontSize = '14px'")
  const beforeResize = displayed
  await until(() => displayed >= beforeResize + 5, '高分辨率源的新画面')
  const captureSize = await sharer.webContents.executeJavaScript('window.__screenTestStream.getVideoTracks()[0].getSettings()')
  assert.ok(captureSize.width <= 1600 && captureSize.height <= 1600, '高分辨率源在媒体输出端受限')
  console.log('[review-capture-size]', JSON.stringify({source: source.getContentSize(), delivered: captureSize}))
  if (process.env.PANTRY_REMOTE_TEST_ARTIFACTS) fs.writeFileSync(path.join(process.env.PANTRY_REMOTE_TEST_ARTIFACTS, 'actual-capture.jpg'), lastFrame)
  // 输入法取消候选不能误结束共享；真正的 Esc 仍由现有流程测试。
  await sharer.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',keyCode:229,bubbles:true}))")
  assert.equal(sharer.isDestroyed(), false)
  // 动态约束被桌面拒绝时，保留已授权的流继续按需编码。
  await sharer.webContents.executeJavaScript("void (window.__screenTestStream.getVideoTracks()[0].applyConstraints = () => Promise.reject(new Error('测试不支持动态约束')))")
  const beforeFallback = displayed
  peer.setMode(peer.getState().sessionId, 'economy')
  await until(() => displayed >= beforeFallback + 8, '动态约束失败保留可用采集')
  powerMonitor.emit('lock-screen')
  await until(() => sharer.isDestroyed() && peer.getState()?.phase === 'ended', '锁屏销毁采集宿主')
  const stopped = displayed; await pause(300); assert.equal(displayed, stopped)
  powerMonitor.emit('unlock-screen')
  assert.equal(peer.getState()?.phase, 'ended', '解锁不恢复会话')
  await pause(Math.max(0, 20030 - (Date.now() - inviteSentAt)))
  assert.deepEqual(peer.request(appState.nodeId), { ok: true })
  const declined = await until(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('#/remote-view')), '拒绝测试邀请')
  await until(() => declined.webContents.executeJavaScript('!!document.querySelector(".actions button")'), '拒绝按钮')
  await declined.webContents.executeJavaScript('document.querySelector(".actions button").click()')
  await until(() => peer.getState()?.reason === 'declined' && declined.isDestroyed(), '拒绝结束本次请求')
  await until(() => main.webContents.executeJavaScript('[...document.querySelectorAll(".screen-card")].some(card => card.innerText.includes("你已拒绝"))'), '拒绝进入聊天记录')
  const declinedCard = (await screenRecords()).find(row => row.screenRef.reason === 'declined')
  assert.equal(declinedCard.screenRef.role, 'sharer')
  assert.equal(declinedCard.screenRef.startedAt, undefined)
  assert.equal(declinedCard.screenRef.durationMs, undefined, '拒绝请求不计协助时长')
  await assertCardAlignment(3)
  await shot(main, '09-history')
  main.webContents.reload()
  await until(() => main.webContents.executeJavaScript('!!document.querySelector(".conv")'), '历史重载')
  await main.webContents.executeJavaScript('document.querySelector(".conv").click()')
  await until(() => main.webContents.executeJavaScript('document.querySelectorAll(".screen-card").length === 3'), '恢复全部协助记录')
  await assertCardAlignment(3)
  assert.deepEqual(errors, [])
  discovery.stop(); await udp.stop(); await server.stop()
  source.destroy()
  console.log('[remote-view] 逐次同意、合成屏幕实际采集与编码、置顶停止入口、锁屏清理通过；不代表物理屏幕权限或 Win7/UOS 验收')
  finished = true; app.quit()
}
