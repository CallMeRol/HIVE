import { parentPort, workerData } from 'node:worker_threads'
import { writeDiagnosticBundle, type DiagnosticBundleJob } from './diagnostics'

void writeDiagnosticBundle(workerData as DiagnosticBundleJob)
  .then(() => parentPort?.postMessage({ ok: true }))
  .catch(() => parentPort?.postMessage({ ok: false }))
