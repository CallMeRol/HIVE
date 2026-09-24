// 在隔离配置中启动真实 Electron 应用，验证四窗口语言同步；所有套接字限制在回环。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(repo, '.i18n-selftest-'))
  const fixture = path.join(directory, 'fixture.cjs')
  require('esbuild').buildSync({
    stdin: { contents: [
      'src/main/store/app-state.ts', 'src/main/store/db.ts', 'src/main/store/msg-repo.ts',
      'src/main/store/conv-repo.ts', 'src/main/store/peers-repo.ts', 'src/i18n/messages.ts'
    ].map(file => `export * from ${JSON.stringify(path.join(repo, file))}`).join('\n'), resolveDir: repo },
    bundle: true, platform: 'node', target: 'node16', external: ['better-sqlite3'], outfile: fixture, logLevel: 'silent'
  })
  try {
    for (const stage of ['fresh', 'main', 'legacy']) {
      const result = spawnSync(require('electron'), [__filename, '--child', stage, directory], {
        cwd: repo, encoding: 'utf8', timeout: 90000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_RENDERER_URL: '', PANTRY_PEERS: '' }
      })
      process.stdout.write(result.stdout || '')
      process.stderr.write(result.stderr || '')
      if (result.status !== 0) throw new Error(`${stage} 自测失败 (${result.status}): ${result.error || ''}`)
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
} else {
  void run().catch(error => { console.error(error); require('electron').app.exit(1) })
}

async function run() {
  const { app, BrowserWindow, globalShortcut, nativeImage } = require('electron')
  const stage = process.argv[3]
  const directory = process.argv[4]
  const fixture = require(path.join(directory, 'fixture.cjs'))
  const dataDir = path.join(directory, stage === 'fresh' ? 'fresh' : 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.env.PANTRY_USER_DATA = dataDir
  process.env.PANTRY_SMOKE = '1'
  process.env.PANTRY_UDP_PORT = String(await freePort('udp'))
  process.env.PANTRY_TCP_PORT = String(await freePort('tcp'))
  // 自测运行脚本时仍按项目的资源根和版本解析。
  app.getAppPath = () => repo
  app.getVersion = () => require(path.join(repo, 'package.json')).version
  app.getLocale = () => 'en-US'
  app.getPreferredSystemLanguages = () => ['en-US']
  globalShortcut.register = () => false
  let finished = false
  const quit = app.quit.bind(app)
  app.quit = () => { if (finished) quit() } // 保留应用运行，测试完成后再执行正常退出清理。
  setTimeout(() => { console.error('语言自测超时'); app.exit(1) }, 60000).unref()

  if (stage === 'main') {
    const state = fixture.loadAppState(dataDir, '0.57.0', undefined, undefined, [], 'en-US')
    fixture.saveProfile(state, { nick: 'Test User', company: '', dept: '', team: '', avatar: -1, fileDir: '' })
    const db = fixture.openDatabase(path.join(dataDir, 'data/db/chat.db'))
    new fixture.PeersRepo(db).upsertMany([{ profile: {
      nodeId: 'locale-peer', nick: '陈同事', company: '工程组', dept: '', team: '', avatar: -1,
      host: 'test-peer', platform: 'linux', tcpPort: 47899, profileRev: 1, caps: [], ver: '0.57.0'
    }, ip: '127.0.0.1', udpPort: 47898, lastSeen: Date.now(), online: false }])
    const convs = new fixture.ConvRepo(db), messages = new fixture.MsgRepo(db)
    const convId = convs.ensureSingle('locale-peer')
    for (const [i, message] of [
      { kind: 'text', content: '设置、聊天、[图片]，均为用户原文。' },
      { kind: 'system', content: '对方撤回了一条消息' },
      { kind: 'system', ...fixture.systemMessage('nudge.received') }
    ].entries()) {
      messages.insert({ id: `locale-${i}`, convId, senderId: 'locale-peer', isMine: false,
        ts: Date.now() + i, status: 'sent', ...message })
    }
    convs.bump(convId, Date.now())
    db.close()
  } else if (stage === 'legacy') {
    const configPath = path.join(dataDir, 'config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.equal(config.language, 'en', '上次选择已持久保存')
    delete config.language
    fs.writeFileSync(configPath, JSON.stringify(config))
  }

  // 若测试意外恢复了真实网卡绑定或局域网发包，立即失败。
  const dgram = require('node:dgram'), originalSocket = dgram.createSocket
  dgram.createSocket = function (...args) {
    const socket = originalSocket.apply(this, args)
    const bind = socket.bind, send = socket.send
    socket.bind = function (port, address, ...rest) {
      assert.equal(address, '127.0.0.1', 'UDP 仅绑定回环')
      return bind.call(this, port, address, ...rest)
    }
    socket.send = function (...params) {
      const address = params.find(value => typeof value === 'string')
      assert.equal(address, '127.0.0.1', 'UDP 仅发送到回环')
      return send.apply(this, params)
    }
    return socket
  }
  const net = require('node:net'), originalListen = net.Server.prototype.listen
  net.Server.prototype.listen = function (port, address, ...rest) {
    assert.equal(address, '127.0.0.1', 'TCP 仅绑定回环')
    return originalListen.call(this, port, address, ...rest)
  }
  const errors = []
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', (_event, _level, message) => {
      if (/Uncaught|Unhandled|TypeError|ReferenceError|\[Vue warn\]/.test(message)) errors.push(message)
    })
  })
  require(path.join(repo, 'out/main/index.js'))
  await app.whenReady()
  const main = await waitWindow(() => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('#/')))
  await waitFor(main, "document.querySelector('.shell') !== null")
  const expected = stage === 'legacy' ? 'zh-CN' : 'en'
  await waitFor(main, `document.documentElement.lang === ${JSON.stringify(expected)}`)

  if (stage === 'fresh') {
    await waitFor(main, "document.body.innerText.includes('What should we call you?')")
    await main.webContents.executeJavaScript(`
      const field = document.querySelector('.card input');
      field.value = '保留输入'; field.dispatchEvent(new Event('input', { bubbles: true }));
      const selector = document.querySelector('.language-choice select');
      selector.value = 'zh-CN'; selector.dispatchEvent(new Event('change', { bubbles: true }));
    `)
    await waitFor(main, "document.body.innerText.includes('怎么称呼你？')")
    assert.equal(await main.webContents.executeJavaScript("document.querySelector('.card input').value"), '保留输入')
    console.log('[i18n-ui] 新安装英文默认、向导即时切换与输入保留通过')
  } else if (stage === 'legacy') {
    await waitFor(main, "document.body.innerText.includes('最近会话')")
    assert.equal((await main.webContents.executeJavaScript('window.pantry.getSettings()')).language, 'zh-CN')
    console.log('[i18n-ui] 旧配置升级保留中文通过')
  } else {
    await waitFor(main, "document.querySelector('.conv') !== null")
    await main.webContents.executeJavaScript("document.querySelector('.conv').click()")
    await waitFor(main, "[...document.querySelectorAll('.system-line')].some(e => e.textContent.includes('Your contact sent a nudge'))")
    assert.equal(await main.webContents.executeJavaScript("document.querySelectorAll('.system-action').length"), 0)
    const content = await main.webContents.executeJavaScript('document.body.innerText')
    assert.ok(content.includes('对方撤回了一条消息') && content.includes('设置、聊天、[图片]，均为用户原文。'))
    await main.webContents.executeJavaScript(`
      window.localeDraft = document.querySelector('.input-area textarea');
      window.localeDraft.value = 'Draft 草稿';
      window.localeDraft.dispatchEvent(new Event('input', { bubbles: true }));
      window.pantry.openSettings();
    `)
    const settings = await waitWindow(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('#/settings')))
    await clickText(settings, '.nav button', 'General')
    await waitFor(settings, "document.querySelector('.language-select') !== null")
    const extra = []
    for (const hash of ['/capture', '/image-viewer?transferId=missing']) {
      const win = new BrowserWindow({ width: 800, height: 500, show: false, webPreferences: {
        preload: path.join(repo, 'out/preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false
      } })
      await win.loadFile(path.join(repo, 'out/renderer/index.html'), { hash })
      await waitFor(win, "document.documentElement.lang === 'en'")
      extra.push(win)
    }
    const windows = [main, settings, ...extra]
    const capture = extra[0]
    const png = nativeImage.createFromBitmap(Buffer.alloc(800 * 500 * 4, 255), { width: 800, height: 500 }).toPNG()
    capture.webContents.send('capture:init', png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength))
    await waitFor(capture, "document.querySelector('.desktop')?.complete")
    await capture.webContents.executeJavaScript(`
      const stage = document.querySelector('.desktop').parentElement;
      stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 80 }));
      stage.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 600, clientY: 330 }));
    `)
    await waitFor(capture, "document.querySelector('.bar') !== null")
    const selected = await capture.webContents.executeJavaScript("document.querySelector('.sel').getAttribute('style')")
    for (const win of windows) await win.webContents.executeJavaScript('window.localeRoot = document.querySelector("#app").firstElementChild; void 0')
    await settings.webContents.executeJavaScript("document.querySelector('.language-select .n-base-selection').click()")
    await clickText(settings, '.n-base-select-option', '简体中文')
    for (const win of windows) await waitFor(win, "document.documentElement.lang === 'zh-CN'")
    await waitFor(main, "[...document.querySelectorAll('.system-line')].some(e => e.textContent.includes('对方发来一次窗口震动'))")
    await waitFor(capture, "document.querySelector('.bar button').getAttribute('aria-label') === '重新框选'")
    await waitFor(extra[1], "document.body.innerText.includes('图片不可用')")
    assert.equal(await main.webContents.executeJavaScript("window.localeDraft === document.querySelector('.input-area textarea') && window.localeDraft.value === 'Draft 草稿'"), true)
    for (const win of windows) assert.equal(await win.webContents.executeJavaScript('window.localeRoot === document.querySelector("#app").firstElementChild'), true)
    await settings.webContents.executeJavaScript("document.querySelector('.language-select .n-base-selection').click()")
    await clickText(settings, '.n-base-select-option', 'English')
    for (const win of windows) await waitFor(win, "document.documentElement.lang === 'en'")
    await waitFor(capture, "document.querySelector('.bar button').getAttribute('aria-label') === 'Select again'")
    assert.equal(await capture.webContents.executeJavaScript("document.querySelector('.sel').getAttribute('style')"), selected)
    await waitFor(settings, "[...document.querySelectorAll('.nav button')].some(e => e.textContent.trim() === 'Notifications')")
    assert.equal((await main.webContents.executeJavaScript('window.pantry.getSettings()')).language, 'en')
    await main.webContents.executeJavaScript("window.pantry.saveAppSettings({ language: 'invalid' })")
    assert.equal((await main.webContents.executeJavaScript('window.pantry.getSettings()')).language, 'en')
    const qa = process.env.TEAHOUSE_I18N_QA_DIR
    if (qa) {
      fs.mkdirSync(qa, { recursive: true })
      await delay(2200)
      for (const [i, win] of windows.entries()) fs.writeFileSync(path.join(qa, `window-${i}-en.png`), (await win.webContents.capturePage()).toPNG())
      for (const label of ['Profile', 'Notifications', 'Chats & files', 'Network', 'Shortcuts', 'About']) {
        await clickText(settings, '.nav button', label)
        await delay(250)
        fs.writeFileSync(path.join(qa, `settings-${label.replace(/[^a-z]/gi, '-')}-en.png`), (await settings.webContents.capturePage()).toPNG())
      }
    }
    for (const win of windows) {
      assert.equal(await win.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth + 1'), true, '窗口无横向溢出')
    }
    console.log('[i18n-ui] 四窗口双向切换、原文/草稿/根节点保留、持久保存与非法输入拒绝通过')
  }
  assert.deepEqual(errors, [], '无渲染异常')
  finished = true
  app.quit()
}

async function freePort(kind) {
  if (kind === 'udp') {
    const socket = require('node:dgram').createSocket('udp4')
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    return port
  }
  const server = require('node:net').createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function waitWindow(get) {
  for (let i = 0; i < 200; i++) { const win = get(); if (win) return win; await delay(50) }
  throw new Error('未创建预期窗口')
}
async function waitFor(win, expression) {
  for (let i = 0; i < 200; i++) {
    if (!win.isDestroyed() && await win.webContents.executeJavaScript(expression).catch(() => false)) return
    await delay(50)
  }
  throw new Error('未达到界面状态：' + expression)
}
async function clickText(win, selector, label) {
  const expression = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(label)})`
  await waitFor(win, `!!(${expression})`)
  await win.webContents.executeJavaScript(`(${expression}).click()`)
}
