# Spike: isolating agent runs from the user's Claude Code config

Date: 2026-11-06 · CLI: Claude Code 2.1.319 · Context: phase-1 hardening item H1

## Question
Can every agent run (including `jira-browser`, which needs `--chrome`) be started with
`--strict-mcp-config --setting-sources ""` so it ignores the user's own MCP servers,
plugins, hooks and permission rules — without losing the claude-in-chrome tools or the
subscription login?

## Evidence (two real 1-turn runs, started from a scratch directory, prompt "Reply with exactly: OK", browser never asked to navigate)

| Run | Flags | Result |
|---|---|---|
| 1 | `--chrome --strict-mcp-config` + the normal sandbox flags | init event listed `mcp_servers=[claude-in-chrome, connected, source: dynamic]`; chrome read tools present, denied tools absent; result `OK` |
| 2 | run 1 + `--setting-sources ""` | result `OK`, `apiKeySource: none` (subscription login used); user plugins absent, only built-in plugins listed; chrome tools still present |

`claude --help` on 2.1.319 lists both `--strict-mcp-config` and `--setting-sources`.

## Decision
`ISOLATION_ARGS = ["--strict-mcp-config", "--setting-sources", ""]` is passed to every role
(refine, drift check, propose-solutions, jira-browser). Because user settings are no longer
read, the user's model choice is ignored; an optional Mac-only `executor.model` setting
(passed as `--model`) restores it explicitly.

## Not yet verified
- A real discovery/fetch against JIRA with these flags and with the detached (own process
  group) spawn used by the server — covered by the phase-1 exit checklist
  (`docs/spikes/phase1-exit.md`). If discovery reports missing chrome tools or a login
  problem, re-test run 1/run 2 from the server's spawn path first.
