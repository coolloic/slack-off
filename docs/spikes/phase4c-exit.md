# Phase 4c exit validation (Cost & quota, usage pause, run tracing; manual)

Phase 4c is done when the Cost & quota page shows every agent run by ticket, role and day (an API-equivalent estimate on the subscription, cost with the API key), thresholds and a manual pause stop new agent runs with a clear reason and a Retry after the resume, the CLI's own usage-limit message pauses usage (best effort), and run tracing exports exactly the runs you confirm, metadata only unless you turn content on. The automated part runs in fake mode: no JIRA, no Claude, no tracing service. The checks below run **against a real `claude`, a test Anthropic API key and a test tracing project**, by hand. Fill in every result slot and commit the file.

Before you commit: never write a real company hostname, names, emails, tokens, keys or tracing-project keys in this file. Use `https://your-company.atlassian.net`, `TEST-1`, `example-org` and `https://otel.example.com/v1/traces` in anything you write down, and blur screenshots.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Automated results (fake mode, no JIRA, no Claude, no tracing service)

Filled in at the end of task 6 and updated by the final fix pass (ruling F4C-1; branch `feat/phase-4`):

| Suite | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | shared 34, web 153, server 1227: 1414 passed, 0 failed |
| Type check | `pnpm typecheck` | clean |
| e2e phases 1–4b | the ten earlier Playwright projects | 1, 2, 3, 3, 2, 1, 2, 2, 1, 2 passed |
| e2e phase 4c, desktop 1440 | `playwright test --project=desktop-phase4c` | 7 passed |
| e2e phase 4c, phone 390x844 | `playwright test --project=mobile-phase4c` | 5 passed (`scrollWidth === 390`, touch targets ≥ 44px) |

Task 6 ran the e2e in a scratch copy on ports 4327/5183 (a Slack Off held 4317). The final fix pass ran `pnpm e2e` on the real ports 4317/5173: all twelve projects passed (1, 2, 3, 3, 2, 1, 2, 2, 1, 2, 7, 5).

What the phase-4c e2e covers. Fake runs carry synthetic tokens and cost. On desktop: Cost & quota with FAKE-1's runs by ticket, role and day; a manual pause (banner, FAKE-2 blocked "Paused: … — resume in Cost & quota, then Retry", under Needs me), resume, Retry; FAKE-2's first propose then reports the CLI's usage limit (fake switch), which pauses usage with "the CLI reported its usage limit"; resume and Retry go through; thresholds (warn banner, then a threshold pause before FAKE-3's next run). Run tracing: the warning, endpoint validation, the content switch's red warning, auth headers saved and never shown again, then "Export N runs to 127.0.0.1:<port>" confirmed once: a receiver started by the test gets one request with `Content-Type: application/json`, the header, N spans and none of the fake tickets' description text; the audit log has `telemetry_exported` and never the header. At 390x844 the same pages fit (`scrollWidth === 390`), the pause, resume and export confirmations live in the sticky bar with their "This will:" text, and on a paired phone with the API key Resume of a manual pause is enabled while Resume of a threshold pause is disabled and says to resume on this computer. A confirmation opened before new runs finished is refused ("preview again") and nothing is sent; the fresh preview sends them all (F4C-1 M-1).

Not covered automatically (hence the checks below): the real CLI's numbers and wording, a real API-key run's cost, and a real tracing service.

## Prerequisites

- [ ] Node 26, pnpm, git, `pnpm install` done; Claude Code installed and logged in (subscription). — needs author: confirm `claude` is installed and logged in (subscription); the rest checked 2026-11-16: Node v26.13.0, pnpm 12.6.0, git 2.39.5, `pnpm install --frozen-lockfile` OK, `claude --version` 2.1.325.
- [x] A fresh data dir: `SLACKOFF_HOME=$(mktemp -d) pnpm dev:server` and `pnpm dev:web`, then open http://127.0.0.1:5173. Start the server from a shell without secrets in its environment. — verified 2026-11-16: fresh `mktemp -d` SLACKOFF_HOME; `pnpm dev:server` and `pnpm dev:web` started under `env -i` (HOME, PATH, TMPDIR only: no `GH_TOKEN`, no `ANTHROPIC_*`); `/api/status` 200 through :5173.
- [ ] A test JIRA project you may refine tickets from (browser or API mode, phase 4b). — needs author: a test JIRA project (browser or API mode).
- [ ] A **test** Anthropic API key with a small budget (for check 3). — needs author: a test Anthropic API key with a small budget.
- [ ] A **test project** in Langfuse or LangSmith (or your own collector) and its OTLP endpoint and auth header, for checks 5 and 6. Never a production project. — needs author: a test Langfuse/LangSmith project (or own collector) with its OTLP endpoint and auth header.

## 0. The panel matches the CLI's own numbers (subscription)

Refine and propose two or three test tickets with the subscription. Open Cost & quota (window "5 h"). For each run, compare with the `result` event in `$SLACKOFF_HOME/runs/<run id>.jsonl` (`total_cost_usd`, `usage.input_tokens`, `usage.output_tokens`, the cache fields).

- [ ] The runs, tokens and "API-equivalent estimate" on the page equal the sums of the `result` events. — needs author: refine/propose 2–3 test tickets with the subscription; compare Cost & quota with the `result` events.
- [ ] By ticket, by role and by day add up to the totals. — needs author: same real runs: check the breakdowns sum to the totals.
- [x] The page says "API-equivalent estimate", not "Cost", and Settings → Budget shows no USD field. — verified 2026-11-16: fresh home, subscription, headless Chromium: Cost & quota shows "API-EQUIVALENT ESTIMATE", no "Cost" figure; Settings → Budget has "Most runs" and no "Most USD" field.

Result: ____ / Notes: ____

## 1. Threshold pause and resume

Settings → Budget: turn thresholds on, window 5 h, "Most runs" = the runs already in the window + 1.

- [ ] Below the limit at 80% or more: the banner warns ("Usage at N% of your 5-hour budget"); nothing pauses. — needs author: real runs with thresholds on (fake-mode e2e `desktop-phase4c` covers the banner).
- [ ] Refine a ticket so the limit is reached, then refine another: the second does not start; it is Blocked with "Paused: runs reached …/… in the last 5h — resume in Cost & quota, then Retry", it appears under Needs me, and the banner links to Cost & quota. — needs author: real runs: reach the limit and check the second ticket is Blocked with the Paused wording.
- [ ] A run already going when the limit was reached finished normally (soft limit). — needs author: real run in flight while the limit is reached; it should finish.
- [ ] Restart Slack Off: still paused. — needs author: restart while threshold-paused; still paused.
- [ ] Raise the limit, Resume: the banner goes; the ticket stays Blocked with "Resumed: retry to continue"; Retry runs it. — needs author: raise the limit, Resume, Retry the blocked ticket.
- [ ] The audit log has `usage_paused` (threshold), `budget_changed` with who changed it, and `usage_resumed`. — needs author: after the above, check the audit log for `usage_paused`, `budget_changed`, `usage_resumed`.

Result: ____ / Notes: ____

## 2. The real CLI's usage-limit wording (C-4)

Slack Off pauses automatically when the first line of a failed run's result text matches `USAGE_LIMIT_RE` (`packages/server/src/executor/types.ts`). This is best effort: the wording is the CLI's, not an interface.

- [ ] If you reach your subscription's usage limit naturally during the checks (do not burn quota on purpose), copy the first line of the `result` event's text from `$SLACKOFF_HOME/runs/<run id>.jsonl` here (no account details): ____ — needs author: only if the usage limit is reached naturally; copy the first line of the `result` text (else write "not checked").
- [ ] Slack Off paused with "the CLI reported its usage limit" and blocked the ticket with that wording. — needs author: same natural usage-limit event; check the pause and Blocked wording.

If it could not be triggered naturally, write "not checked" and the date: ____. If the wording did not match, note it; the fix is a change to `USAGE_LIMIT_RE` and its negative tests.

Result: ____ / Notes: ____

## 3. A real API-key run's cost

Switch to the API key (Settings → Executor and JIRA API mode, phase 4b) with the test key. Refine one test ticket.

- [ ] Cost & quota now says "Cost" (not an estimate), and the run's cost equals `total_cost_usd` of its `result` event. — needs author: API-key refine of a test ticket; cost equals `total_cost_usd`.
- [ ] The cost roughly matches the Anthropic Console's usage for the test key for that period (allow for the console's delay). — needs author: compare with the Anthropic Console for the test key.
- [ ] Settings → Budget shows "Most USD"; set it just above the window's cost, refine another ticket so it is exceeded, refine a third: it pauses before starting. — needs author: API-key mode: set Most USD just above the window's cost and check the pause.
- [ ] From a paired phone: Pause works, and Resume of that manual pause works too (F4C-1 M-4). With the threshold pause from the step above, Resume is disabled with "With the API key (real money), a threshold pause is resumed on the computer running Slack Off"; raising "Most USD" or concurrency from the phone is refused. All of these work on this computer. — needs author: API-key mode on a paired phone: Pause / Resume of a manual pause, threshold Resume disabled, raises refused.
- [ ] A billed failed run (for example `claude` stopped by its turn limit) shows its cost in Cost & quota; a timed-out run shows none (F4C-1 I-1). — needs author: API-key mode: a billed failed run shows cost, a timed-out one none.
- [ ] Switch back to the subscription afterwards and remove the test key (Settings → Executor → Remove) if you do not keep it. — needs author: switch back and remove the test key.

Result: ____ / Notes: ____

## 4. Settings → Run tracing stays local and off by default

- [x] A fresh data dir: no export card on Cost & quota; Settings → Run tracing shows the warning "Exporting sends ticket keys and run details (and, if you turn it on, ticket content and code) to this service. Off by default. Each export is confirmed." — verified 2026-11-16: fresh home, headless Chromium: Cost & quota shows no Run tracing / export card; Settings → Run tracing shows the exact warning text.
- [x] `http://` to a host other than 127.0.0.1 / localhost / [::1], an address with a user name, query or fragment, and `http://127.0.0.1:4317/...` are refused. — verified 2026-11-16: `PUT /api/config` returned 400 for `http://otel.example.com/…`, `https://user@…`, `…?x=1`, `…#f` and `http://127.0.0.1:4317/…` ("must not be Slack Off's own port"); control `http://127.0.0.1:4318/v1/traces` returned 200; config restored.
- [ ] From a paired phone the section is read-only and the headers show "Set on this computer" / "Not set" only. — needs author: check Settings → Run tracing on your paired phone.

Result: ____ / Notes: ____

## 5. A real export to a Langfuse or LangSmith test project (metadata only)

Set the test project's OTLP traces endpoint (`https://…/v1/traces`) and its auth header in Settings → Run tracing; leave "Include prompts and agent output" off.

- [ ] Cost & quota shows "Export N runs to <host>"; the confirmation names the runs, the fields and the host; confirm once. — needs author: export real runs to the test tracing project.
- [ ] The service shows one trace per ticket and one `slackoff.agent_run` span per run, with role, ticket key, duration, tokens, cost and tool names; the attributes contain no prompt, output, error text, path or JIRA address. — needs author: inspect the spans in the test tracing project.
- [ ] Tool names that are not Claude Code's own or the Chrome tools show as "other". — needs author: check "other" tool names in the test tracing project.
- [ ] The card then says "No new runs to export"; the audit log has `telemetry_exported` with the host, count and device, and no header value anywhere (audit log, Settings, server log). — needs author: after the export, check the card, `telemetry_exported` and that no header value appears.
- [ ] With a wrong header value, an export fails with "HTTP 401: the collector refused the export (check the endpoint and the auth headers)" and nothing more; confirming it again asks for a fresh preview. — needs author: export with a wrong header to the test project; expect the HTTP 401 text.

Result: ____ / Service (Langfuse or LangSmith): ____ / Notes: ____

## 6. Content on, once, for a test ticket only

Turn on "Include prompts and agent output" (the red warning shows), refine one **test** ticket that contains nothing confidential, export it, then turn the switch off again.

- [ ] The service received only that test ticket's content (agent output, and the prompt only if the run's log had it), each item at most 32 KB. — needs author: content-on export of one non-confidential test ticket.
- [ ] No credential value appears in it (the redaction runs before the cut). — needs author: check the exported content for credential values.
- [ ] The switch is off again and Settings saved. — needs author: turn content export off again and save.

Result: ____ / Notes: ____

## Accepted residuals (see README "Residual risks")

- Duplicate spans after a failed or interrupted export (a restart, the time limit, a dropped connection, or a service that stored the spans but answered with an error): the export is recorded as failed and the next export may send the same runs again.
- A timed-out or stopped run has no cost recorded (the CLI never reported one).
- OTLP header values (and Basic user or password halves) shorter than 8 characters are not redacted from error texts (failed exports never show the service's answer); the token after `Bearer`/`Basic` and a Basic pair's decoded parts of 8+ characters are (F4C-1 M-5).
- The allowlist of Claude Code's built-in tool names is kept by hand; a new tool shows as "other" until it is added.
- Usage limits are soft (at most concurrency − 1 runs over), and the automatic pause depends on the CLI's wording.
