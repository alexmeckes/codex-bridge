import type { Register } from 'claude-code'

const TOOL = 'mcp__codex-bridge__codex'

type BridgeLine =
  | { type: 'progress'; text: string }
  | { type: 'done'; threadId?: string; status: string; message?: string; error?: string }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'codex',
      isDeferred: false,
      description:
        'Delegate a task to OpenAI Codex (runs one Codex turn via `codex app-server` and returns its final reply). ' +
        'Codex has Computer Use: it can see and operate native macOS apps (click, type, read the screen). ' +
        'For a desktop GUI task, say so plainly in the prompt, e.g. "Use Computer Use to ...". ' +
        'Computer Use asks for access to each app; those asks are declined unless approvals is "accept", ' +
        'so pass "accept" only when the user asked for Codex to act on their computer. ' +
        'Pass threadId from a previous result to continue the same Codex conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The task for Codex, self-contained.' },
          threadId: { type: 'string', description: 'Continue this Codex thread instead of starting a new one.' },
          cwd: { type: 'string', description: "Codex's working directory; defaults to this session's." },
          approvals: {
            type: 'string',
            enum: ['decline', 'accept'],
            description: 'How to answer Codex approval asks (app access, commands, edits). Default decline.',
          },
        },
        required: ['prompt'],
      },
    })
    return started
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const { prompt, threadId, cwd, approvals } = e as unknown as {
      prompt: string
      threadId?: string
      cwd?: string
      approvals?: string
    }
    const request = { prompt, threadId, cwd: cwd ?? (await $.session.root()), approvals }
    const log: string[] = []
    let done: Extract<BridgeLine, { type: 'done' }> | undefined
    let buffer = ''

    $.ui.status('codex: starting')
    const child = $.process.spawn({
      argv: ['node', `${$.plugin.root}/bin/codex-turn.mjs`],
      input: JSON.stringify(request),
    })
    try {
      for await (const { stream, text } of child) {
        if (stream === 'stderr') continue
        buffer += text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          if (!raw.trim()) continue
          const line = JSON.parse(raw) as BridgeLine
          if (line.type === 'progress') {
            log.push(line.text)
            $.ui.status(`codex: ${line.text.slice(0, 60)}`)
          } else done = line
        }
      }
    } finally {
      $.ui.status(undefined)
    }

    const steps = log.length ? `\n\nCodex steps:\n${log.slice(-30).map(l => `- ${l}`).join('\n')}` : ''
    if (!done || done.status !== 'completed') {
      return { deny: `Codex turn ${done?.status ?? 'ended without a result'}${done?.error ? `: ${done.error}` : ''}${steps}` }
    }
    return { result: `${done.message ?? ''}\n\n[codex threadId: ${done.threadId}]${steps}` }
  }).catch(($, e, next) => ({ deny: `${$.plugin.name}: the Codex bridge failed to run.` }))
}
