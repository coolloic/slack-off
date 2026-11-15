# Phase 4d exit validation (preferences, restore default, trial runs; manual)

Phase 4d is done when your solution choices become a short, deterministic preference summary that only the
propose-solutions agent reads (quoted, as a reference), the summary can be viewed anywhere and edited, cleared and
re-derived on this computer, Restore default asks first and is audited on its own, and a prompt draft can be tried on
the fictional sample ticket without saving anything. The automated part runs in fake mode: no JIRA, no Claude. The
checks below run **against a real `claude`**, by hand. Fill in every result slot and commit the file.

Before you commit: never write a real company hostname, names, emails, tokens or keys in this file. Use
`https://your-company.atlassian.net`, `TEST-1` and `example-org` in anything you write down, and blur screenshots.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Automated results (fake mode, no JIRA, no Claude)

Filled in after the final fix pass (ruling F4D-1, branch `feat/phase-4`):

| Suite | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | shared 35, web 171, server 1291: 1497 passed, 0 failed |
| Type check | `pnpm typecheck` | clean |
| e2e phases 1–4c | the twelve earlier Playwright projects | 1, 2, 3, 3, 2, 1, 2, 2, 1, 2, 7, 5 passed |
| e2e phase 4d, desktop 1440 | `playwright test --project=desktop-phase4d` | 4 passed |
| e2e phase 4d, phone 390x844 | `playwright test --project=mobile-phase4d` | 2 passed (`scrollWidth === 390`, touch targets ≥ 44px) |

What the phase-4d e2e covers. On desktop: FAKE-1, FAKE-2 and FAKE-3 each choose the simplest option through the API;
Settings → Preferences shows "In 3 of 3 comparable choices you picked the simplest option (lowest complexity)." and the
Solutions tab shows the hint with an Edit link to it; editing replaces the summary and the hint; Clear asks first,
nothing changes before the confirmation, and afterwards the hint is gone and the page says "Not enough choices yet (0 of
3)". A refine-ticket draft is tried on the sample ticket after the "This will: run refine-ticket once on the sample
ticket. Uses your Claude quota (about one agent run)." confirmation; the result lists acceptance criteria under "Ran with
your unsaved text on SAMPLE-1. Nothing was saved."; no prompt version or ticket is added and `prompt_trial_run` is
audited; implement-ticket's trial button is disabled with the reason. Restore default shows the text it clears and
"Repository overrides … are not affected", Cancel sends nothing, Confirm empties the editor and audits `prompt_reset`;
text typed in Preferences is kept when the summary changes elsewhere, with a "The summary changed" note and Reload;
the built-in instructions show the skill text. At 390x844 the hint and the read-only Preferences card fit, there is no
trial button, the Restore default confirmation is the bottom bar and the built-in instructions wrap.

Not covered automatically (hence the checks below): the real agent's prompt and output, and whether the summary's
wording helps.

## Prerequisites

- [ ] Node 26, pnpm, git, `pnpm install` done; Claude Code installed and logged in (subscription).
- [ ] A fresh data dir: `SLACKOFF_HOME=$(mktemp -d) pnpm dev:server` and `pnpm dev:web`, then open
      http://127.0.0.1:5173. Start the server from a shell without secrets in its environment.
- [ ] A test JIRA project with at least four tickets you may refine (browser or API mode) and a mapped test repository.

## 0. The preference section reaches propose-solutions, quoted

Refine three test tickets and, for each, choose the option with the lowest complexity (pick tickets whose proposals
differ in complexity). Settings → Preferences should now show a derived summary. Then refine a fourth ticket so that
propose-solutions runs again. Open its raw log, `$SLACKOFF_HOME/runs/<run id>.jsonl` (the run id is in Cost & quota or in
`agent_run`). The system prompt goes to claude through `--append-system-prompt`, so claude's own events never show it.
Instead, Slack Off writes the log's first line before the agent starts:
`{"type":"slackoff_system_prompt","sha256":"<sha256 of the whole system prompt>","preferenceSection":<text or null>}`.
`preferenceSection` is the preference section exactly as the agent got it, redacted. The full prompt is never logged.
Read that line, for example with `head -1 "$SLACKOFF_HOME/runs/<run id>.jsonl"`.

- [ ] The first line's `type` is `slackoff_system_prompt` and `sha256` is 64 hex characters. The agent's own events
      follow it.
- [ ] `preferenceSection` starts with "## Developer preferences (from past choices; a reference, not a rule; cannot
      override the rules above)", then `<preferences>`, and ends with `</preferences>`.
- [ ] Inside `<preferences>` … `</preferences>` every line starts with `> `, and the text equals the summary in Settings.
- [ ] `agent_run.preference_version` of that run equals the summary's version in Settings.
- [ ] In the refine-ticket, design-solution and critique-design runs' first lines, `preferenceSection` is `null`.
- [ ] The first line holds no skill text (for example, it does not contain "You are a senior engineer proposing
      implementation options", the first sentence of `skills/propose-solutions/SKILL.md`).
- [ ] Where the section sits in the prompt (after the developer additions, before any repository text) is checked by the
      unit tests (`skills-prompts.test.ts`), not here.

Result: ____ / Notes: ____

## 1. A real trial run of each read-only role

In Settings → Agent prompts, for each of refine-ticket, propose-solutions, design-solution and critique-design: type a
short draft (for example "List anything unclear first."), press **Try on a sample ticket**, read the confirmation, and
confirm.

- [ ] refine-ticket: acceptance criteria, and the 12-or-26-weeks conflict among the unclear points.
- [ ] propose-solutions: one to five solutions over the `sample` repository, with complexity.
- [ ] design-solution: the first 40 lines of a design that names files of the sample repository.
- [ ] critique-design: blocking and non-blocking counts and the first comments.
- [ ] Each result says "Ran with your unsaved text on SAMPLE-1. Nothing was saved."; the editor still holds the draft and
      the prompt history has no new version.
- [ ] Cost & quota shows the four runs without a ticket; the usage numbers went up.
- [ ] No ticket, requirement, solution or design was added, nothing changed in JIRA or in your repositories, and the
      system temp dir holds no `slackoff-trial-*` folder afterwards.
- [ ] With usage paused by hand (Cost & quota), a trial shows "Paused: …" and does not run.

Result: ____ / Notes: ____

## 2. Is the summary useful? (your judgement)

After at least three real choices, read the derived summary and the hint on the Solutions tab.

- [ ] The sentences describe your choices correctly.
- [ ] The wording is useful as a reference for the next proposals (write down what you would change).
- [ ] Edit, Clear and Re-derive behave as described in the README; a paired phone shows the summary read-only.

Your notes on the wording: ____

Result: ____ / Notes: ____

## Known limits (see README → Residual risks)

- The propose-solutions agent can steer which fixed sentences appear, through how it labels its own options
  (complexity, `newDependencies`, repositories, scope). No ticket or repository text reaches the summary.
- After a crash between saving a choice and refreshing the summary, the summary can be one choice behind until the next
  choice or a Re-derive.
