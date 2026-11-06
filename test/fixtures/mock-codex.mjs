#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const log = data => appendFileSync(process.env.BRIDGE_TEST_LOG, JSON.stringify(data) + '\n')
const send = data => process.stdout.write(JSON.stringify(data) + '\n')
const scenario = process.env.BRIDGE_TEST_SCENARIO
log({ event: 'spawn', pid: process.pid, args: process.argv.slice(2) })
process.on('SIGTERM', () => { log({ event: 'signal', signal: 'SIGTERM' }); if (scenario !== 'stuck') process.exit(0) })
createInterface({ input: process.stdin }).on('line', line => {
 const req = JSON.parse(line)
 log({ event: 'request', method: req.method })
 if (req.id === undefined) return
 const reply = result => send({ id: req.id, result })
 if (req.method === 'initialize') {
  if (scenario === 'malformed') return process.stdout.write('invalid json\n')
  if (scenario === 'crash') return process.exit(3)
  return reply({})
 }
 if (req.method === 'project/list') return reply({ data: [{ id: 'project1', name: 'Claude Code' }], nextCursor: null })
 if (['thread/start','thread/resume'].includes(req.method)) return reply({ thread: { id: 'thread1' }, model: 'test' })
 if (req.method === 'turn/start') {
  const start = () => {
   send({ method: 'turn/started', params: { threadId: 'thread1', turn: { id: 'turn1' } } })
   reply({ turn: { id: 'turn1' } })
   if (['complete','no-eof','stuck'].includes(scenario)) {
    send({ method: 'item/completed', params: { threadId: 'thread1', item: { type: 'agentMessage', text: 'OK' } } })
    send({ method: 'turn/completed', params: { threadId: 'thread1', turn: { id: 'turn1', status: 'completed' } } })
   }
  }
  if (scenario === 'slow-start') return setTimeout(start, 200)
  return start()
 }
 if (req.method === 'turn/interrupt') {
  reply({})
  log({ event: 'interrupt-complete' })
  return setTimeout(() => { log({ event: 'turn-end' }); send({ method: 'turn/completed', params: { threadId: 'thread1', turn: { id: 'turn1', status: 'interrupted' } } }) }, 60)
 }
 if (req.method === 'thread/unsubscribe') return reply({ status: 'unsubscribed' })
 reply({})
}).on('close', () => { log({ event: 'eof' }); if (['no-eof','stuck'].includes(scenario)) setInterval(() => {}, 1000); else process.exit(0) })
