# Phase 4b exit validation (JIRA API mode, Anthropic API key, manual)

Phase 4b is done when JIRA can be read and written through Jira Cloud's REST API with an API token, agents can run the same Claude Code CLI authenticated with an Anthropic API key, both credentials are entered in Settings on this computer only and never come back out, and the browser and subscription modes are unchanged. The automated part runs against fake mode: no JIRA, no Claude, no GitHub. The checks below run against **a test JIRA site and a test API key**, by hand. Fill in every result slot and commit the file.

Before you commit: never write a real company hostname, names, emails, tokens or keys in this file. Use `https://<your-jira>.atlassian.net`, `TEST-1`, `you@example.com` and `example-org` in anything you write down, and blur screenshots.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Automated results (fake mode, no JIRA, no Claude, no GitHub)

Filled in at the end of Task 8 and updated after the final fix pass (branch `feat/phase-4`):

| Suite | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | shared 34, web 132, server 1160: 1326 passed, 0 failed |
| Type check | `pnpm typecheck` | clean |
| e2e phases 1–4a | the eight earlier Playwright projects | 1, 2, 3, 3, 2, 1, 2, 2 passed |
| e2e phase 4b, desktop 1440 | `playwright test --project=desktop-phase4b` | 1 passed |
| e2e phase 4b, phone 390x844 | `playwright test --project=mobile-phase4b` | 2 passed (`scrollWidth === 390`, new touch targets ≥ 44px) |
| All of `pnpm e2e` | ten Playwright runs, fresh servers and scratch dir each | 19 passed, about 2.3 minutes; ports 4317 and 5173 free afterwards |

What the phase-4b e2e covers. On desktop, Settings switches JIRA to the API mode and the executor to the API key. The JIRA email (`you@example.com`) and an obviously fake token, then a fake Anthropic key, are typed into text boxes (autocomplete off, never prefilled, the token and the key masked with `-webkit-text-security`, no `type=password` box on the page so Chrome offers no password saving; F4B-5 M-3) and show "Set · updated just now". Neither value appears in `GET /api/config`, `/api/credentials`, `/api/status`, `/api/audit`, the page's HTML, its inputs, its storage or its URL. Discovery then goes through the real REST client against fake mode's fake Jira Cloud `fetch` (`dev/fake-jira-api.ts`). FAKE-1 goes to `dev_done` with JIRA status sync on, and one confirmed In Progress write gives exactly one `POST /rest/api/3/issue/FAKE-1/transitions`, verified by the read-back. At 390x844, the executor and JIRA sections are checked twice. On this computer, the credential boxes fit and the API-key-with-browser combination is refused. On a paired phone, both switches are disabled; the three credential fields show "Set on this computer" with no box, no button and no email hint; and the comparison tables are one card per row. `scrollWidth === 390` and every new touch target is at least 44px. Unit tests cover the same models and the mode-aware JIRA wording (M5).

Not covered automatically (hence the checks below): a real Jira Cloud site, a real Anthropic API key, the real `claude` CLI's handling of `apiKeyHelper`, and Claude Code's own file-tool behaviour.

## Prerequisites

- [ ] Node 26, pnpm, git, `pnpm install` done; Claude Code installed.
- [ ] A fresh data dir: `SLACKOFF_HOME=$(mktemp -d) pnpm dev:server` and `pnpm dev:web`, then open http://127.0.0.1:5173. **Start the server from a shell without secrets in its environment** (no `GH_TOKEN`, no `ANTHROPIC_*`).
- [ ] A **test** Jira Cloud site (or a test project you may write to) with a test ticket `TEST-1` that has an image attachment, an inline image in its description and more than one comment, and more than 100 open tickets assigned to you (or `discoverLimit` lowered, to force more than one page). An API token for that account from your Atlassian account settings.
- [ ] A **test** Anthropic API key with a small budget.

## 0. The task 1 values not yet checked

Fill in `docs/spikes/2026-11-api-modes.md`: each row marked "not verified → exit check" (`API_AUTH_EVIDENCE`, `API_CHROME`, `API_KEY_DELIVERY`, `API_AUTH_ERROR`, `JIRA_SEARCH_SHAPE`, `JIRA_ATTACHMENT_REDIRECT`, `JIRA_COMMENT_ADF`) gets the observed value and the date. If one differs from the default, say which task's code it affects.

Result: ____ / Date: ____ / Notes: ____

## 1. JIRA API mode: discovery and a ticket read

Settings → JIRA → "JIRA API — email and API token", enter the email and token, Save settings.

- [ ] Fetch new tickets: more than one result page is read (the Tickets list shows every open ticket up to the limit, or "Showing X of Y" when the limit is lower), and no `jira-browser` run appears.
- [ ] Refine `TEST-1`: the snapshot shows the title, the description as text, every comment in order and the image attachment **visible**; the inline image is listed as an inline image.

Result: ____ / Date: ____ / Notes: ____

## 2. JIRA API mode writes (test tickets only)

- [ ] Turn on JIRA status sync, develop a test ticket and confirm its In Progress write: it moves in JIRA, and the read-back shows "Moved to In Progress in JIRA".
- [ ] The same write again when the ticket already shows the target: "Already In Progress in JIRA — nothing to change", nothing sent.
- [ ] A target status name that does not exist in the workflow (set In-progress status to `No Such Status`): `transition_unavailable` ("JIRA offers no transition to …"), no similar status is picked.
- [ ] Send a multi-line requirement-unclear comment: it appears in JIRA exactly as typed (line breaks kept), once.

Result: ____ / Date: ____ / Notes: ____

## 3. A wrong token

- [ ] Replace the token with a wrong one (fake, 16+ characters) and fetch: the banner says "The JIRA API token was rejected — update it in Settings → JIRA" (or, for a write, "JIRA rejected the API token — update it in Settings → JIRA").
- [ ] `grep -r <the wrong token> $SLACKOFF_HOME` finds it only in `credentials.json`; the server's console output and the audit log do not contain it.

Result: ____ / Date: ____ / Notes: ____

## 4. Anthropic API key

Settings → Executor → "Anthropic API key", enter the test key, Save settings (JIRA must be in the API mode).

- [ ] Take a test ticket from refining to proposed solutions. In `slackoff.db`, `SELECT role, executor, cost_usd FROM agent_run` shows `claude-api` and a cost for each run.
- [ ] Your `~/.claude` is untouched (modification times unchanged); `$SLACKOFF_HOME/claude-api-config` exists with mode 700.

Result: ____ / Date: ____ / Notes: ____

## 5. credentials.json permissions

- [ ] `ls -l $SLACKOFF_HOME/credentials.json` shows `-rw-------` and your user.
- [ ] `chmod 644` it and reload Settings: the credentials report "credentials.json must be a regular file with mode 600 owned by you" (or the API modes fail with it); `chmod 600` restores it.

Result: ____ / Date: ____ / Notes: ____

## 6. The phone never sees a value

- [ ] On a paired phone, Settings → Executor and JIRA: both switches are read-only; each credential says "Set on this computer" or "Not set"; no box, no Replace / Remove, no email hint. View the page source on the phone (or the phone's `GET /api/credentials`): no token, key or email.

Result: ____ / Date: ____ / Notes: ____

## 7. Claude Code's own file tools (rulings 4B-6, 4B-7)

Slack Off's file-tool guard refuses any path with `..`, a leading `~` or braces, and follows symlinks before allowing a path. Record what Claude Code itself does, in a development run on a throwaway repository:

- [ ] Read / Edit / Write with a path containing `..`, starting with `~`, and a Glob with braces: what does Claude Code resolve them to (the guard refuses all of them; note whether a refusal is visible in the run log)?
- [ ] Grep and Glob over a directory that contains a symlink pointing outside it: do they follow the link? (Ruling F4B-1: the guard now walks the searched tree without following links, at most 50k entries, and refuses the call if any link in it resolves outside the run's roots, so the expected result is a refusal "the searched folder holds a symbolic link that leads outside the directories of this run". Record whether Claude Code would have followed the link; the README residual on the file-tool guard stays until this is answered.)

Conclusion (write it here): ____

Result: ____ / Date: ____ / Notes: ____

## 8. E1: the `apiKeyHelper` runs outside the sandbox (ruling 4B-12)

- [ ] In API-key mode, run a development step. Expected: the run authenticates. That shows the real CLI ran the `apiKeyHelper` **without** going through `CLAUDE_CODE_SHELL_PREFIX`, since the helper reads `credentials.json`, which no sandbox can read. If the CLI did run it through the prefix, the run fails with "The Anthropic API key was rejected — update it in Settings". Record which.
- [ ] Also confirm the CLI honours `apiKeyHelper` with `--setting-sources ""` at all: the stream-json `init` event's `apiKeySource` must be exactly `"apiKeyHelper"` (`API_KEY_SOURCE_HELPER` in `executor/claude-api.ts`, ruling F4B-3). Slack Off stops and fails every API-key run whose `init` reports another value or none ("Stopped: this run was not authenticated with your Anthropic API key (Claude Code reported apiKeySource …)"). If the real CLI reports a different value for the helper, every API run fails visibly: record the value and update the constant.
- [ ] Run one acceptance step in API-key mode with `acceptance.claudeConfigDir` holding a subscription login: expected `apiKeySource` `"apiKeyHelper"` (the helper wins), never `"none"`. If it reports the login, the run is stopped — record it.

Result: ____ / Date: ____ / Notes: ____

## 9. E2: the key is not copied into child environments (ruling 4B-12)

- [ ] In the development sandbox and in the acceptance sandbox, have a command print `env` and run task 6's procargs probe (the `KERN_PROCARGS2` reader built in `claude-api.test.ts`) against the `claude` process and its children — the shell-prefix wrapper (the `/bin/sh` that runs the platform's `CLAUDE_CODE_SHELL_PREFIX` script around every Bash command), the Bash commands themselves, hooks and MCP servers: the test key appears in none of them. If it does appear anywhere, write it in the README's residual risks.

Result: ____ / Date: ____ / Notes: ____
