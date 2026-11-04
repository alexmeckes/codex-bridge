#!/usr/bin/env node
// Runs one Codex turn through `codex app-server` (JSON-RPC over stdio).
// stdin: {"prompt", "threadId"?, "cwd"?, "model"? (default gpt-6.1-terra), "approvals"?: "decline" | "accept"}
// stdout: JSON lines — {"type":"progress","text"} while working, then {"type":"done",...}.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const req = JSON.parse(await new Promise(r => { let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => r(s)) }))
const out = o => process.stdout.write(JSON.stringify(o) + '\n')
const PROJECT = 'Claude Code'
const debug = process.env.CODEX_BRIDGE_DEBUG === '1'

const server = spawn(process.env.CODEX_BIN || 'codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] })
server.on('exit', code => { out({ type: 'done', status: 'failed', error: `codex app-server exited (${code})` }); process.exit(1) })

let nextId = 1
const pending = new Map()
const send = msg => server.stdin.write(JSON.stringify(msg) + '\n')
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  send({ id, method, params })
})

let threadId, agentText = '', turnDone
const finished = new Promise(r => (turnDone = r))
const accept = req.approvals === 'accept'

function answerServerRequest({ id, method, params }) {
  out({ type: 'progress', text: `approval ${accept ? 'granted' : 'declined'}: ${params?.message ?? params?.command ?? method}` })
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return send({ id, result: { decision: accept ? 'accept' : 'decline' } })
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return send({ id, result: { decision: accept ? 'approved' : 'denied' } })
    case 'mcpServer/elicitation/request':
      return send({ id, result: { action: accept ? 'accept' : 'decline', content: accept ? {} : null, _meta: null } })
    default:
      return send({ id, error: { code: -32601, message: `${method} is not supported by this client` } })
  }
}

function describe(item) {
  switch (item.type) {
    case 'commandExecution': return `$ ${item.command}`
    case 'mcpToolCall': return `tool ${item.server}.${item.tool}`
    case 'dynamicToolCall': return `tool ${item.tool}`
    case 'fileChange': return `edit ${item.changes.map(c => c.path).join(', ')}`
    case 'webSearch': return `search ${item.query}`
    case 'agentMessage': return item.text ? `codex: ${item.text.slice(0, 200)}` : undefined
    default: return undefined
  }
}

createInterface({ input: server.stdout }).on('line', line => {
  if (!line.trim()) return
  const msg = JSON.parse(line)
  if (debug) process.stderr.write(line + '\n')
  if (msg.id !== undefined && msg.method) return answerServerRequest(msg)
  if (msg.id !== undefined) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  }
  const { method, params } = msg
  if (params?.threadId && threadId && params.threadId !== threadId) return
  if (method === 'item/started') { const t = describe(params.item); if (t) out({ type: 'progress', text: t }) }
  if (method === 'item/completed' && params.item.type === 'agentMessage') agentText = params.item.text
  if (method === 'turn/completed') turnDone(params.turn)
  if (method === 'error') out({ type: 'progress', text: `error: ${params.error?.message ?? JSON.stringify(params)}` })
})

// Every new thread lands in one project, found by name and created if it's missing.
async function projectId() {
  let cursor = null
  do {
    const page = await call('project/list', { cursor, limit: 200 })
    const found = page.data.find(p => p.name === PROJECT)
    if (found) return found.id
    cursor = page.nextCursor
  } while (cursor)
  const { project } = await call('project/create', { name: PROJECT, roots: [], idempotencyKey: randomUUID() })
  return project.id
}

try {
  await call('initialize', { clientInfo: { name: 'claude-codex-bridge', title: 'Claude Code', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
  send({ method: 'initialized' })
  const cwd = req.cwd ?? process.cwd()
  let started
  if (req.threadId) {
    // A resumed thread keeps its own model and project unless a model is named.
    started = await call('thread/resume', { threadId: req.threadId, cwd, ...(req.model && { model: req.model }) })
  } else {
    started = await call('thread/start', { cwd, model: req.model ?? 'gpt-6.1-terra', projectId: await projectId() })
  }
  threadId = started.thread.id
  out({ type: 'progress', text: `thread ${threadId} on ${started.model}` })
  await call('turn/start', { threadId, input: [{ type: 'text', text: req.prompt, text_elements: [] }] })
  const turn = await finished
  out({ type: 'done', threadId, status: turn.status, message: agentText, error: turn.error?.message })
} catch (err) {
  out({ type: 'done', threadId, status: 'failed', error: String(err.message ?? err) })
}
server.removeAllListeners('exit')
server.kill()
process.exit(0)
