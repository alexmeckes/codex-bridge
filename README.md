# codex-bridge

A Claude Code mod that gives Claude a `codex` tool: it hands a task to [OpenAI Codex](https://github.com/openai/codex) and returns Codex's reply. That includes **Codex Computer Use**, so Claude can ask Codex to see and operate native macOS apps.

Each call starts `codex app-server`, runs one Codex turn over its JSON-RPC protocol (`bin/codex-turn.mjs`), and returns the final message, a `threadId` for continuing the same Codex thread, and a list of the steps Codex took. While Codex works, its current step shows in Claude Code's status line; Esc stops it.

## Requirements

- Claude Code with mod (hooks module) support
- The Codex CLI on `PATH`, signed in (`codex` 0.160 or later)
- Node.js on `PATH`
- For Computer Use: macOS with the Codex Computer Use plugin enabled in Codex

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install codex-bridge --marketplace alexmeckes/codex-bridge
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```bash
claude plugin install codex-bridge --marketplace alexmeckes/codex-bridge
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `alexmeckes/codex-bridge`, then **Add plugin**.

## Use

Ask Claude for something Codex should do, for example:

> Use Codex Computer Use to open Calculator, compute 12 × 34, and tell me the result.

The tool takes:

| Input | Meaning |
| --- | --- |
| `prompt` | The task for Codex (required). |
| `threadId` | Continue an earlier Codex thread. |
| `cwd` | Codex's working directory; defaults to the session's. |
| `approvals` | `decline` (default) or `accept`: how to answer Codex's approval asks, such as Computer Use's per-app access. |

## Approvals

Codex asks the client before Computer Use touches an app, and sometimes before commands or edits. The bridge cannot forward those asks to you one by one, so it answers them all one way per call: declined unless the tool is called with `approvals: "accept"`. That value appears in Claude Code's permission prompt for the tool call, and the tool tells Claude to use it only when you asked Codex to act on your computer. Codex's own auto-reviewer, if you have it on, still reviews each action first.
