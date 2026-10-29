import { expect, test } from 'claude-code/testing'

const lines = (...objs: object[]) => objs.map(o => JSON.stringify(o)).join('\n') + '\n'

test('the codex tool returns the bridge reply and thread id', async ($, on) => {
  let spawned: { argv: readonly string[]; input?: string } | undefined
  on('tool.register', (_, e) => ({ value: { tool: `mcp__codex-bridge__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('process.spawn', async function* (_, e) {
    spawned = e
    // Split mid-line to check the bridge output is re-assembled into lines.
    const text = lines(
      { type: 'progress', text: 'tool cua_repl.js' },
      { type: 'done', threadId: 't-1', status: 'completed', message: 'The Calculator shows 408.' },
    )
    yield { stream: 'stdout' as const, text: text.slice(0, 20) }
    yield { stream: 'stdout' as const, text: text.slice(20) }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ran = await $.tool.call({ tool: 'mcp__codex-bridge__codex', prompt: 'compute', cwd: '/proj', approvals: 'accept' })

  expect(spawned?.argv[1]).toMatch(/bin\/codex-turn\.mjs$/)
  expect(JSON.parse(spawned?.input ?? '{}')).toEqual({ prompt: 'compute', cwd: '/proj', approvals: 'accept' })
  expect(String(ran.result)).toContain('The Calculator shows 408.')
  expect(String(ran.result)).toContain('[codex threadId: t-1]')
  expect(String(ran.result)).toContain('- tool cua_repl.js')
})

test('a failed Codex turn is reported as an error', async ($, on) => {
  on('tool.register', (_, e) => ({ value: { tool: `mcp__codex-bridge__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: lines({ type: 'done', status: 'failed', error: 'not logged in' }) }
    return { value: { code: 0, signal: null } }
  })

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  const ran = await $.tool.call({ tool: 'mcp__codex-bridge__codex', prompt: 'x', cwd: '/proj' })
  expect(ran.deny).toContain('failed: not logged in')
})
