# Phase 3 exit validation (acceptance + delivery, manual)

Phase 3 is done when a ticket goes from `dev_done` through an independent acceptance report to pull requests (and, with JIRA sync on, Ready for Human Review), with every outward action confirmed by you (design doc §10). The automated part runs against fake mode: no JIRA, no Claude, no GitHub. The checks below run against **your own test JIRA project, test repositories and a test GitHub organisation**, by hand. Fill in every result slot and commit the file.

Before you commit: never write a real company hostname, names or emails in this file. Use `https://<your-jira>.atlassian.net`, `TEST-1`, `example-org` and `/path/to/test-repo` in anything you write down, and blur screenshots.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Automated results (fake mode, no JIRA, no Claude, no GitHub)

Filled in at the end of Task 17 (branch `feat/phase-3`):

| Suite | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | shared 33, web 107, server 886: 1026 passed, 0 failed |
| Type check | `pnpm typecheck` | clean |
| e2e phase 1, desktop 1440 | `playwright test --project=desktop` | 1 passed |
| e2e phase 1, phone 390x844 | `playwright test --project=mobile` | 2 passed |
| e2e phase 2, desktop 1440 | `playwright test --project=desktop-phase2` | 3 passed |
| e2e phase 2, phone 390x844 | `playwright test --project=mobile-phase2` | 3 passed |
| e2e phase 3, desktop 1440 | `playwright test --project=desktop-phase3` | 2 passed |
| e2e phase 3, phone 390x844 | `playwright test --project=mobile-phase3` | 1 passed (every visited page `scrollWidth === 390`) |
| All of `pnpm e2e` | six Playwright runs, fresh servers and scratch dir each | 12 passed, about 2 minutes; no `slackoff-*` dir left in `$TMPDIR`, no process left running |

What the phase-3 e2e covers. Fake mode's acceptance agent writes a real Playwright spec; **the platform's re-run is real**: the `playwright` shim runs it with Playwright's own Chromium inside the acceptance sandbox, against the fake web app started in the same sandbox. Development commands run in the development sandbox. Pushes go to local bare repositories (the origin says `https://github.com/example-org/…`, rewritten by the repository's own `insteadOf` / `pushInsteadOf`, and checked before every push), and `gh` is a fake that keeps pull requests in a JSON file.

- Desktop, FAKE-1 (api + web): Hand off from the Development tab → attempt 1 fails AC-2 (its test really fails) → an automatic fix iteration (trigger `review_failed`) → attempt 2 passes; the Acceptance tab shows "Passed · attempt 2 of 3", "Previous attempts" with attempt 1 failed on AC-2, the isolation note, and a screenshot that opens in the lightbox. An edited requirement-unclear comment is confirmed word for word and sent (`done`). With JIRA sync on, the confirmation lists exactly the plan's 8 actions (re-read, 2 pushes, 2 PRs, links, status, comment) with the preview's text; after Deliver: `pr_opened`, every delivery step done, two PRs whose descriptions reference each other and hold no screenshot, a ticket branch on each bare remote, 2 `branch_pushed` and 2 `pr_opened` audit events, JIRA at Ready for Human Review with one comment holding both PR URLs.
- Desktop, FAKE-2 (option 3, api only, no `acceptance` section): "E2E not executed"; the confirmation warns "E2E was not executed" (cancelled); Reject with a note → a new iteration with trigger `rejected` → back to the developer; no PR; audit chain `ok`.
- Phone, FAKE-3 (web only, sync off): hand off through the bottom bar → JIRA changed again before acceptance (third read) → acknowledge through the bar, note required → passed on attempt 1 → lightbox close button ≥ 44 px → Confirm through the bar; the confirmation says "JIRA is not changed" → Deliver → one PR, JIRA untouched. Every bar primary is ≥ 44 px tall with "This will:" under it; no visited page scrolls sideways.

Not covered automatically (hence the checks below): the real `claude` under the sandboxed wrappers, real Chromium screenshots of your app, real `gh` and GitHub, real JIRA writes, restarts mid-delivery, and the sandbox-unavailable paths (those are covered by unit tests with an injected failing self-check, Tasks 5 and 9).

## Prerequisites

- [ ] Node 26, pnpm, git, `pnpm install` done; Claude Code installed and logged in; `npx playwright install chromium` done.
- [ ] Chrome with Claude in Chrome connected and logged in to your **test** JIRA (`https://<your-jira>.atlassian.net`); only one browser connected, or Settings → JIRA browser set.
- [ ] A **test JIRA project** with tickets assigned to you that have an "In Progress" and a "Ready for Human Review" transition.
- [ ] Two **throwaway test repositories** on GitHub in a **test organisation** (`example-org` below), cloned locally, each with a passing `node --test` (or similar) suite. One of them is a small web app you can start with one command.
- [ ] `gh auth login` done for that organisation (and nothing else you care about).
- [ ] A fresh data dir: `SLACKOFF_HOME=$(mktemp -d) pnpm dev:server` and `pnpm dev:web`, then open http://127.0.0.1:5173. Settings: JIRA base URL; Repositories `TEST` → `api` `/path/to/test-api` `main`, `web` `/path/to/test-web` `main`.

Background: [2026-11-acceptance-delivery.md §9](2026-11-acceptance-delivery.md#9-manual-checks-for-the-author-for-the-task-16-exit-document) (manual checks 1–3) and [2026-11-dev-sandbox.md](2026-11-dev-sandbox.md).

Note the main checkout state of each test repository before you start (`git -C <repo> rev-parse HEAD`, `git -C <repo> status --short`). Every check ends by confirming it is unchanged.

## 0. Dedicated acceptance config directory

Steps (spike §9, manual check 1): run `CLAUDE_CONFIG_DIR=~/.slackoff-acceptance/claude-config claude /login` once. Then run `env -i PATH="$PATH" HOME="$HOME" USER="$USER" CLAUDE_CONFIG_DIR=$HOME/.slackoff-acceptance/claude-config claude -p 'Reply with exactly: OK' --no-session-persistence --output-format json`. Delete the `ACCEPT_CONFIG_PURGE` folders in that directory (`projects`, `sessions`, `todos`, `shell-snapshots`, `session-env`, `file-history`, `debug`, `backups`; see `ACCEPT_CONFIG_PURGE` in `packages/server/src/acceptance/workspace.ts`) and run it again. Open Keychain Access and note the new item.

Expected:
- [ ] Both runs answer `OK` with `apiKeySource: none` (it reuses the login).
- [ ] After the purge the login still works.
- [ ] Keychain item name noted: ____ (expect a second `Claude Code-credentials…` entry).
- [ ] If the login was lost after the purge: report it, so `ACCEPT_CONFIG_PURGE` can be narrowed.

Result: ____ / Date: ____ / Notes: ____

## 1. One web repository with an `acceptance` section

Steps: in `test-web`'s base branch, add an `acceptance` section to `.slackoff/config.json` (`entry: "web"`, `start`, `baseUrl: "http://127.0.0.1:<port>"`, `healthPath`, `env.PORT`). Run a ticket that only affects `web` to `dev_done`, then **Hand off to acceptance**. While acceptance runs, in a terminal: `ps -Eww -o pid,command | grep -i claude` and find the acceptance `claude` process; note its `CLAUDE_CONFIG_DIR` and cwd (`lsof -a -p <pid> -d cwd`), and `ls -la <cwd>`.

Expected:
- [ ] The Acceptance tab shows a verdict, per AC its flows and real screenshots of your app; screenshots open full screen.
- [ ] The isolation note is shown and correct; any excluded file is listed.
- [ ] `CLAUDE_CONFIG_DIR` is the dedicated folder; the cwd is under the system temp dir (`slackoff-accept-…/work`), not under `~/.slackoff` or your repositories; no `.git` in it.
- [ ] After the run: the `slackoff-accept-…` run directory is gone and the app is no longer listening on its port (`lsof -iTCP:<port> -sTCP:LISTEN` empty).
- [ ] Main checkout unchanged.

Result: ____ / Date: ____ / Notes: ____

## 2. A ticket with an AC that fails

Steps: write a ticket with an AC the first implementation is likely to miss (or make the app miss it on purpose). Hand off. Then, on a second ticket, set Settings → Acceptance fix attempts per round to 1 (or make the AC impossible) so every attempt fails; then Retry.

Expected:
- [ ] Attempt 1 fails with the failed AC and evidence; a fix iteration (`review failed`) runs; acceptance runs again and passes ("Passed · attempt 2 of N").
- [ ] When every attempt fails: `blocked`, naming the failed ACs and the attempt count; **Retry** starts a new round that fixes first.
- [ ] "Previous attempts" shows both rounds.

Result: ____ / Date: ____ / Notes: ____

## 3. Your own dev server on the same port

Steps: start your app yourself on the `baseUrl` port, then hand off a ticket.

Expected:
- [ ] The report says "E2E not executed: port <port> is already in use — stop the process using it, then re-run acceptance".
- [ ] No second copy of the app was started; no acceptance agent ran (no `acceptance-review` run in the live log or under `~/.slackoff/runs/`).

Result: ____ / Date: ____ / Notes: ____

## 4. A repository without an `acceptance` section

Steps: a ticket that only affects `test-api` (no `acceptance` section). Hand off, then open Confirm & deliver.

Expected:
- [ ] The report says "E2E not executed" and every AC is "Not tested".
- [ ] The confirmation lists the warning "E2E was not executed: …" before anything is sent.

Result: ____ / Date: ____ / Notes: ____

## 5. Real delivery of two repositories to the test organisation

Steps (spike §9, manual check 3): a ticket affecting both test repositories, passed acceptance, JIRA sync off. Put `@someone` and `fixes #12` in an AC's text. Confirm & deliver. Then: make the delivery fail half-way (for example a pre-push hook in `test-web` that fails once), Retry. Then on a second ticket, push a commit to its remote branch from the GitHub web UI before delivering. Finally `gh auth logout` and open the confirmation once more.

Expected:
- [ ] Two branches `slackoff/<KEY>-…` on GitHub, exactly at the accepted commits; two PRs, base = the mapped base branch, no reviewers, no labels.
- [ ] Each PR description links the other; no screenshot file in either repository, no image or screenshot link in the descriptions ("Screenshots and evidence are in Slack Off").
- [ ] `@someone` notified nobody; `fixes #12` closed nothing (shown neutralized).
- [ ] After the partial failure, Retry did not push the first repository again and did not open a second PR.
- [ ] Remote branch with an extra commit → `blocked` ("remote branch … has commits that are not in …"), nothing forced (`git reflog` on GitHub's side unchanged; the extra commit is still there).
- [ ] `gh` logged out → the confirmation shows a blocker naming `gh auth login`; Deliver is disabled.
- [ ] A reused PR (deliver again after editing its description by hand): your text stays, only the links section changes.

Result: ____ / Date: ____ / Notes: ____

## 6. Real JIRA (test tickets only, `jira.syncStatus` on)

Steps (spike §9, manual check 2): turn on JIRA status sync. Deliver a ticket. Separately, send a requirement-unclear comment (multi-line, with a URL and a `- ` line) from the Requirements tab, then send it again. From a paired phone, confirm one delivery.

Expected:
- [ ] The ticket moves to Ready for Human Review (or your Settings value) and the read-back confirms it.
- [ ] The delivery comment appears verbatim. Check whether JIRA rewrote the URLs; if the comment still does not match after normalization, report it.
- [ ] In the raw run log (`~/.slackoff/runs/`), the jira-comment run has exactly one `type`, equal to the given text, and the only URL visited is `<jira>/browse/<KEY>`.
- [ ] The clarification comment is `Sent`; sending it again gives `Not needed`.
- [ ] The phone's delivery is in the audit log with the device name.

Result: ____ / Date: ____ / Notes: ____

## 7. Restart during a delivery

Steps: start a delivery of two repositories with a slow pre-push hook (`sleep 30`) in the second; stop the server (Ctrl-C) while it runs; start it again.

Expected:
- [ ] The ticket is `blocked` ("delivery interrupted by restart — Retry to continue"); nothing continued by itself.
- [ ] Retry finishes the delivery without pushing the first repository again or opening a second PR. **Preview again** is also offered and shows a fresh plan.

Result: ____ / Date: ____ / Notes: ____

## 8. The local command sandbox

Steps: in a test repository, add a test that does `fetch('http://127.0.0.1:4317/api/status')` and reads `~/.ssh/known_hosts`, each in its own test, printing the error. Run a ticket's development. Put the same code into an acceptance spec (for example via the project's `testCommand`, or by asking for it in the ticket). Then Settings → Development → "Run repository commands without the sandbox": try it from a paired phone, then on this computer, and run one development step. Finally, a repository whose `install` uses a private registry (`~/.npmrc` with a token).

Expected:
- [ ] In development both tests fail with `EPERM` / connection refused (the step output shows it).
- [ ] In acceptance the same code also fails.
- [ ] The switch is read-only on the phone; on this computer it can be turned on, development commands then run, the output says they were unsandboxed, and the audit log has `commands_unsandboxed`. Turn it off again afterwards.
- [ ] The private-registry `install` succeeds (`~/.npmrc` is readable for install only).
- [ ] The sandbox-unavailable paths (not macOS, no `sandbox-exec`, failing self-check) are covered only by unit tests (injected failing self-check, Tasks 5 and 9); nothing to do here.

Result: ____ / Date: ____ / Notes: ____

## 9. Real `claude` under the sandbox wrappers (carried from earlier tasks)

These were never run with the real `claude`, `gh` or JIRA during development. Check each with a real run (a development step and an acceptance run from checks 1–2 are enough), looking at the raw run logs under `~/.slackoff/runs/`.

- [ ] Real `claude` Bash exits 0 and its cwd file (`/private/tmp/claude-*-cwd`) is written, under both the development wrapper and the acceptance wrapper (no spurious non-zero exits on every Bash call).
- [ ] Exec-form hooks (the acceptance spec guard) are **not** prefixed with the shell wrapper (`CLAUDE_CODE_SHELL_PREFIX`): the hook runs and blocks a forbidden command.
- [ ] `claude`'s own git calls (if any) get `safe.bareRepository` from the environment.
- [ ] Development Bash works while `/private/tmp/claude-*` is read-denied to other sessions (the live log tail and marks still work). If it breaks, report it so the allow rule can be narrowed.
- [ ] A missing acceptance shell snapshot is fine (no error in the acceptance run).
- [ ] Real `gh pr create`, `gh pr edit --body-file` and `gh pr list --json …` behave as the fake does (PR URL as the last line of `create`; `list` fields present). Covered by check 5.
- [ ] GitHub closing references: an AC text with `Fixes:#12` and `**fixes** #12` closes nothing and links nothing in the PR.
- [ ] The keychain through the security daemons (mach-lookup to `com.apple.SecurityServer` / `com.apple.securityd.*`) is denied in every profile since the final fix pass (F-3), but only checked on the profile text, **not probed** at run time. Create a throwaway item (`security add-generic-password -s slackoff-probe -a test -w throwaway`), then from a sandboxed development test run `security find-generic-password -s slackoff-probe -w` and note what happens (expected: it fails and prints no password). Delete the item afterwards (`security delete-generic-password -s slackoff-probe`). Never probe a real credential.

Result: ____ / Date: ____ / Notes: ____

## Docs to refresh by hand

- [ ] The BA renders `docs/ba/01-user-flow.excalidraw.png`, `02-state-machine.excalidraw.png`, `03-sequence-c-deliver.excalidraw.png` and `05-er.excalidraw.png` are older than their `.mmd` sources (phase 3 states, delivery sequence, review tables), and `01-user-flow.mmd` changed in Task 17 (delivery and `review.maxAttempts` wording). Re-render them (Excalidraw import of the `.mmd`, export PNG). This was not automated: it needs the clipboard.

## Residual risks to confirm you have read

- [ ] README → "Residual risks", git hooks (F-2): files the development agent edits that your pre-commit or commit-msg hooks run (lint-staged config, eslint config, `package.json` scripts) execute **outside** the sandbox when Slack Off commits, and can act as you in Slack Off, including confirming deliveries and changing Settings. Sandboxing hooks is planned for phase 4. For this run: review the agent's diff before each commit you let through, or use test repositories whose hooks do not execute repository-controlled config. Noted: ____
- [ ] README → "Security notes for development" and "Residual risks": a forged result from an escaped spec process (confirm deliveries using the evidence); escaped processes stay sandboxed; the spec guard is defense in depth only; the sandbox ports are fixed at 4317/5173 (plus `development.deniedLocalPorts`); no sandbox off macOS; `sandbox-exec` is deprecated; `development.allowUnsandboxedCommands` returns development to phase 2's trust level; not sandboxed: the `claude` process itself, git hooks, `gh`.
