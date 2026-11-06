import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// Keep bridge calls out of the macOS capture path until the upstream stream
// lifecycle issue is resolved. CLI overrides also protect resumed threads.
export const serverArgs = [
  '--disable', 'computer_use',
  '-c', 'plugins."computer-use@openai-bundled".enabled=false',
  '-c', 'plugins."unified-computer-use@openai-bundled".enabled=false',
  'app-server',
]

const wait = (promise, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), ms)
  promise.then(() => { clearTimeout(timer); resolve(true) }, () => { clearTimeout(timer); resolve(true) })
})

export function connect({ onRequest, onNotification, progress, debug = false }) {
  const server = spawn(process.env.CODEX_BIN || 'codex', serverArgs, { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let nextId = 1, threadId, turnId, turnCompleted = false, stopping = false, exited = false
  let resolveExit, resolveTurn, rejectFailure, rejectCancel
  const exit = new Promise(r => { resolveExit = r })
  const turnEnd = new Promise(r => { resolveTurn = r })
  const failure = new Promise((_, r) => { rejectFailure = r })
  const cancelled = new Promise((_, r) => { rejectCancel = r })
  // Handlers can run before run() attaches its race.
  failure.catch(() => {}); cancelled.catch(() => {})
  const fail = error => {
    rejectFailure(error)
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error) }
    pending.clear()
  }
  const send = msg => {
    if (exited || server.stdin.destroyed || server.stdin.writableEnded) throw Error('Codex server connection is closed')
    server.stdin.write(JSON.stringify(msg) + '\n', error => { if (error) fail(error) })
  }
  const call = (method, params, timeout = 30000) => {
    if (stopping && !['turn/interrupt', 'thread/unsubscribe'].includes(method)) return Promise.reject(Error('Codex bridge is stopping'))
    let entry
    const promise = new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Codex request timed out: ${method}`)) }, timeout)
    entry = { resolve, reject, timer, method }
    pending.set(id, entry)
    try { send({ id, method, params }) } catch (error) { pending.delete(id); clearTimeout(timer); reject(error) }
    })
    entry.promise = promise
    return promise
  }
  server.once('error', error => { exited = true; resolveExit(); fail(error) })
  server.once('exit', (code, signal) => {
    exited = true; resolveExit()
    fail(Error(`Codex server exited (${signal || code})`))
  })
  server.stdin.on('error', fail)
  server.stdout.on('error', fail)
  const lines = createInterface({ input: server.stdout })
  lines.on('line', line => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line)
      if (debug) process.stderr.write(line + '\n')
      if (msg.id !== undefined && msg.method) {
        if (stopping) return send({ id: msg.id, error: { code: -32000, message: 'Bridge is stopping' } })
        return onRequest(msg)
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (!p) return
        pending.delete(msg.id); clearTimeout(p.timer)
        if (msg.error) return p.reject(Error(msg.error.message))
        if (p.method === 'thread/start' || p.method === 'thread/resume') threadId = msg.result?.thread?.id
        if (p.method === 'turn/start') turnId = msg.result?.turn?.id ?? turnId
        return p.resolve(msg.result)
      }
      if (msg.method === 'turn/started' && msg.params?.threadId === threadId) turnId = msg.params.turn.id
      if (msg.method === 'turn/completed' && msg.params?.threadId === threadId) {
        turnCompleted = true; resolveTurn()
      }
      onNotification(msg)
    } catch (error) { fail(error) }
  })
  lines.once('close', () => { if (!stopping) fail(Error('Codex server closed its output')) })
  const abort = signal => {
    const error = Error(`Codex bridge interrupted (${signal})`)
    error.code = 'BRIDGE_INTERRUPTED'
    rejectCancel(error)
  }
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => abort(signal)]))
  for (const [signal, handler] of handlers) process.on(signal, handler)
  const outputError = error => { if (error.code === 'EPIPE') abort('caller disconnected'); else fail(error) }
  process.stdout.on('error', outputError)

  async function shutdown() {
    stopping = true
    try {
      // Cancellation can arrive while start/resume is still returning an ID.
      // Let those replies identify the owned turn, but block any further work.
      await wait(Promise.allSettled([...pending.values()].filter(p => ['thread/start', 'thread/resume', 'turn/start'].includes(p.method)).map(p => p.promise)), 3000)
      if (!exited && threadId && turnId && !turnCompleted) {
        try {
          await call('turn/interrupt', { threadId, turnId }, 3000)
          await wait(turnEnd, 5000)
        } catch (error) { progress(`cleanup: ${error.message}`) }
      }
      if (!exited && threadId) {
        try { await call('thread/unsubscribe', { threadId }, 3000) }
        catch (error) { progress(`cleanup: ${error.message}`) }
      }
      if (!server.stdin.destroyed) server.stdin.end()
      if (!exited && !await wait(exit, 3000)) {
        server.kill('SIGTERM')
        if (!await wait(exit, 3000)) {
          // Only this owned server, never the shared capture service or other jobs.
          server.kill('SIGKILL')
          if (!await wait(exit, 1000)) throw Error('Codex server did not exit after cleanup')
        }
      }
    } finally {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler)
      // Retain the stdout error handler until process exit: the caller may have
      // disconnected while the final result is being flushed.
      lines.close()
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Codex connection closed')) }
      pending.clear()
    }
  }
  return {
    call, send,
    async run(work) {
      try { return await Promise.race([work(), failure, cancelled]) }
      finally { await shutdown() }
    },
  }
}
