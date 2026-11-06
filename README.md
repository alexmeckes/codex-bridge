# codex-bridge

A Claude Code mod that gives Claude a `codex` tool: it hands a task to [OpenAI Codex](https://github.com/openai/codex) and returns Codex's reply. **Desktop Computer Use is temporarily disabled** while investigating macOS capture-resource exhaustion. Coding and command-line delegation remain available.

Each call starts `codex app-server`, runs one Codex turn over its JSON-RPC protocol (`bin/codex-turn.mjs`), and returns the final message, a `threadId` for continuing the same Codex thread, and a list of the steps Codex took. While Codex works, its current step shows in Claude Code's status line. On cancellation, the bridge requests a turn interrupt and waits for cleanup before closing its owned server.

## Requirements

- Claude Code with mod (hooks module) support
- The Codex CLI on `PATH`, signed in (`codex` 0.160 or later)
- Node.js on `PATH`

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

> Ask Codex to review the current diff and identify regressions.

The tool takes:

| Input | Meaning |
| --- | --- |
| `prompt` | The task for Codex (required). |
| `threadId` | Continue an earlier Codex thread. |
| `cwd` | Codex's working directory; defaults to the session's. |
| `model` | A Codex model id. New threads default to `gpt-6.1-terra`; a continued thread keeps its model unless you name one. |
| `approvals` | `decline` (default) or `accept`: how to answer Codex's approval asks, such as Computer Use's per-app access. |

New threads all go in one Codex project, **Claude Code**, created if it's missing. A renamed project stops matching, so the next thread creates a new one.

## Approvals

Codex can ask the client before commands or edits. The bridge cannot forward those asks to you one by one, so it answers them all one way per call: declined unless the tool is called with `approvals: "accept"`. That value appears in Claude Code's permission prompt for the tool call, and the tool tells Claude to use it only for actions you authorized. Codex's own auto-reviewer, if you have it on, still reviews each action first.

## Capture mitigation and shutdown

Every bridge server starts with Computer Use and both desktop-control plugins disabled by explicit command-line overrides. This also applies when resuming a thread. This is a temporary mitigation, not proof that the upstream graphics leak has been fixed.

Normal completion unsubscribes the thread and closes server input, then waits for exit. SIGINT, SIGTERM and SIGHUP first interrupt the active turn and wait for its completion event. If shutdown stalls, bounded termination targets only the child server owned by that invocation. It never kills shared capture helpers or unrelated Codex sessions. An uncatchable SIGKILL cannot run the bridge's cleanup handler.

Run the offline lifecycle tests (no model calls or screen capture):

```sh
node --test test/connection.test.mjs
```
