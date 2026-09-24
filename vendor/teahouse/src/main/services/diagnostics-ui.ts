/// <reference types="electron-vite/node" />
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import createWorker from './diagnostics-worker?nodeWorker'
import { IpcChannels, type DiagnosticExportResult } from '../../shared/ipc'
import { tr } from '../../i18n'
import { diagnosticSummary, type DiagnosticBundleJob, type DiagnosticsService } from './diagnostics'

async function runWorker(job: DiagnosticBundleJob): Promise<void> {
  const worker = createWorker({ workerData: job })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 30_000)
      const finish = (error?: Error): void => { clearTimeout(timer); error ? reject(error) : resolve() }
      worker.once('message', (result) => finish(result?.ok === true ? undefined : new Error('export-failed')))
      worker.once('error', () => finish(new Error('worker-failed')))
      worker.once('exit', () => finish(new Error('worker-exited')))
    })
  } finally {
    await worker.terminate()
    await rm(job.temporary, { force: true }).catch(() => undefined)
  }
}

export function setupDiagnosticsUi(log: DiagnosticsService, snapshot: (includePeers: boolean) => Promise<Record<string, unknown>>): void {
  let busy = false
  const settingsWindow = (sender: Electron.WebContents): BrowserWindow | null => {
    if (sender.isDestroyed()) return null
    try { if (new URL(sender.getURL()).hash !== '#/settings') return null } catch { return null }
    return BrowserWindow.fromWebContents(sender)
  }
  const exportBundle = async (parent: BrowserWindow, includeNetwork: boolean): Promise<DiagnosticExportResult> => {
    if (busy) return { status: 'busy' }
    busy = true
    try {
      const pick = await dialog.showSaveDialog(parent, { title: tr('导出诊断包'),
        defaultPath: join(app.getPath('documents'), `Hive-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`),
        filters: [{ name: 'ZIP', extensions: ['zip'] }] })
      if (pick.canceled || !pick.filePath) return { status: 'canceled' }
      const target = /\.zip$/i.test(pick.filePath) ? pick.filePath : `${pick.filePath}.zip`
      await log.exportBundle(target, await snapshot(true), includeNetwork, runWorker)
      return { status: 'saved', name: basename(target) }
    } catch { return { status: 'failed' } }
    finally { busy = false }
  }
  const copyEnvironment = async (): Promise<boolean> => {
    try { clipboard.writeText(diagnosticSummary(await snapshot(false))); return true }
    catch { return false }
  }
  const revealExport = (): boolean => {
    const path = log.exportedPath()
    if (!path) return false
    try { shell.showItemInFolder(path); return true } catch { return false }
  }
  ipcMain.handle(IpcChannels.diagnosticsExport, (event, includeNetwork: unknown) => {
    const parent = settingsWindow(event.sender)
    return parent && typeof includeNetwork === 'boolean' ? exportBundle(parent, includeNetwork) : { status: 'failed' }
  })
  ipcMain.handle(IpcChannels.diagnosticsCopy, event => settingsWindow(event.sender) ? copyEnvironment() : false)
  ipcMain.handle(IpcChannels.diagnosticsReveal, event => Boolean(settingsWindow(event.sender)) && revealExport())
  // 页面只上报类型和代码位置；不传错误正文、堆栈字符串、URL 或任何业务对象。
  const rates = new Map<number, number>()
  ipcMain.on(IpcChannels.diagnosticsError, (event, kind: unknown, name: unknown, line: unknown, column: unknown) => {
    const id = event.sender.id
    if (Date.now() - (rates.get(id) ?? 0) < 1000) return
    if (!['error', 'rejection', 'vue', 'bootstrap'].includes(String(kind))) return
    if (!rates.has(id)) event.sender.once('destroyed', () => rates.delete(id))
    rates.set(id, Date.now())
    log.record('renderer.error', { kind, windowId: id, line, column }, { name })
  })
}
