import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = process.env.BRIDGE_SCRIPT || resolve('bin/codex-turn.mjs')
function launch(t, scenario, binary = resolve('test/fixtures/mock-codex.mjs')) {
 const dir = mkdtempSync(join(tmpdir(), 'bridge-lifecycle-'))
 t.after(() => rmSync(dir, { recursive: true, force: true }))
 const log = join(dir, 'events.jsonl')
 const child = spawn(process.execPath, [script], { env: { ...process.env, CODEX_BIN: binary, BRIDGE_TEST_LOG: log, BRIDGE_TEST_SCENARIO: scenario }, stdio: ['pipe','pipe','pipe'] })
 let stdout = '', stderr = ''
 child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b })
 child.stdin.end(JSON.stringify({ prompt: 'offline lifecycle test' }))
 const events = () => { try { return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) } catch { return [] } }
 const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })))
 t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
 async function done() {
  let timer
  const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Bridge did not exit')), 12000) })]).finally(() => clearTimeout(timer))
  const server = events().find(e => e.event === 'spawn')
  if (server) assert.throws(() => process.kill(server.pid, 0), { code: 'ESRCH' }, 'owned server must be gone')
  assert.equal(stderr, '')
  const output = stdout.trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(output.filter(e => e.type === 'done').length, 1, 'exactly one final result')
  return { ...result, result: output.find(e => e.type === 'done'), events: events() }
 }
 async function until(method) {
  for (let i=0;i<200;i++) { if (events().some(e => e.method === method)) return; await new Promise(r => setTimeout(r, 10)) }
  throw Error(`Missing ${method}`)
 }
 return { child, done, until }
}

test('completion disables capture, unsubscribes and waits for server EOF exit', async t => {
 const b = launch(t, 'complete'), { code, result, events } = await b.done()
 assert.equal(code, 0); assert.equal(result.status, 'completed'); assert.equal(result.message, 'OK')
 const args = events[0].args
 assert.deepEqual(args.slice(0,2), ['--disable','computer_use'])
 assert.ok(args.includes('plugins."computer-use@openai-bundled".enabled=false'))
 assert.ok(args.includes('plugins."unified-computer-use@openai-bundled".enabled=false'))
 assert.ok(events.some(e => e.method === 'thread/unsubscribe'))
 assert.equal(events.at(-1).event, 'eof')
 assert.ok(!events.some(e => e.event === 'signal'))
})
for (const signal of ['SIGINT','SIGTERM','SIGHUP']) test(`${signal} interrupts the owned turn before disconnecting`, async t => {
 const b = launch(t, 'active'); await b.until('turn/start'); b.child.kill(signal)
 const { code, result, events } = await b.done()
 assert.equal(code,1); assert.equal(result.status,'interrupted')
 const methods = events.filter(e => e.method).map(e => e.method)
 assert.ok(methods.indexOf('turn/interrupt') < methods.indexOf('thread/unsubscribe'))
 assert.ok(methods.includes('turn/interrupt')); assert.equal(events.at(-1).event,'eof')
 assert.ok(events.findIndex(e => e.event === 'turn-end') < events.findIndex(e => e.method === 'thread/unsubscribe'))
})
test('cancellation during turn startup waits for its ID and interrupts it', async t => {
 const b = launch(t,'slow-start'); await b.until('turn/start'); b.child.kill('SIGTERM')
 const { result, events } = await b.done()
 assert.equal(result.status,'interrupted'); assert.ok(events.some(e => e.method === 'turn/interrupt'))
})
for (const scenario of ['malformed','crash']) test(`${scenario} server produces one failure and leaves no child`, async t => {
 const { code, result } = await launch(t,scenario).done()
 assert.equal(code,1); assert.equal(result.status,'failed')
})
test('missing executable returns a controlled failure', async t => {
 const { code, result } = await launch(t,'complete','/nonexistent/orbit-codex-test').done()
 assert.equal(code,1); assert.equal(result.status,'failed'); assert.match(result.error,/ENOENT/)
})
for (const scenario of ['no-eof','stuck']) test(`${scenario}: bounded fallback reaps only the owned server`, async t => {
 const { code, events } = await launch(t,scenario).done()
 assert.equal(code,0)
 assert.ok(events.some(e => e.event === 'signal' && e.signal === 'SIGTERM'))
})
