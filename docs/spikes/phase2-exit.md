# Phase 2 exit validation (design debate + development, manual)

Phase 2 is done when a ticket goes from a chosen solution to `dev_done`, with runnable code and tests in the worktrees and the debate record viewable in the UI (design doc §10). The automated part runs against fake mode. The checks below run against **your own test JIRA project and your own test repositories**, by hand. Fill in every result slot and commit the file.

Before you commit: never write a real company hostname, names or emails in this file. Use `https://your-company.atlassian.net`, `TEST-1` and `/path/to/test-repo` in anything you write down, and blur screenshots.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Automated results (fake mode, no JIRA, no Claude)

Filled in at the end of Task 17 (commit on branch `feat/phase-2`):

| Suite | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | shared 27, web 79, server 500: 606 passed, 0 failed |
| Type check | `pnpm typecheck` | clean |
| Web build | `pnpm -F web build` | built |
| e2e phase 1, desktop 1440 | `playwright test --project=desktop` | 1 passed |
| e2e phase 1, phone 390x844 | `playwright test --project=mobile` | 2 passed (includes a simulated paired phone: phase-2 Mac-only settings read-only) |
| e2e phase 2, desktop 1440 | `playwright test --project=desktop-phase2` | 3 passed |
| e2e phase 2, phone 390x844 | `playwright test --project=mobile-phase2` | 3 passed (every page `scrollWidth === 390`, every decision through the sticky bar) |
| All of `pnpm e2e` | four Playwright runs, fresh servers each | 9 passed, about 1 minute |

What the phase-2 e2e covers, at both widths: solutions show their repositories; the repo picker with the proposed set and with an edited set (`api` removed); a debate that ends by itself (round 1 blocking, round 2 not, checklist 25/25) and one that escalates, with a "critic" ruling and a custom ruling, Finalize disabled until every disagreement is ruled; development to `dev_done` with per-repository status, commits `FAKE-1: …`, the `infra/main.tf` blocked edit and web's pre-commit hook failure ("TODO found") on step 1; the ticket folder holding only the affected repository; the snapshot-change acknowledgement (note required); the JIRA write card (target status shown before Send to JIRA, a failed write, Try again creating a new pending write, then done); "Already In Progress" for a ticket already in that status; and an audit chain that verifies (`ok: true`).

## Prerequisites

- [ ] Node 26, pnpm, git, `pnpm install` done; Claude Code installed and logged in.
- [ ] Chrome with Claude in Chrome connected and logged in to your **test** JIRA (`https://your-company.atlassian.net`).
- [ ] A **test JIRA project** (or test tickets you may change) with tickets assigned to you, in a status that has an "In Progress" transition.
- [ ] Two **test repositories** you can throw away (never your real ones for the first run), each with a passing `node --test` (or similar) suite. One uses husky v9 (check 3).
- [ ] A fresh data dir: `SLACKOFF_HOME=$(mktemp -d) pnpm dev:server` and `pnpm dev:web`, then open http://127.0.0.1:5173.
- [ ] Settings → JIRA base URL set; Repositories mapped (`TEST` → `api` `/path/to/test-api` `main`, `web` `/path/to/test-web` `main`).

Background for checks 3 and 4: [2026-11-dev-sandbox.md §6](2026-11-dev-sandbox.md#6-manual-checks-for-the-author-for-the-task-17-exit-document).

Note the main checkout state of each test repository before you start (`git -C <repo> rev-parse HEAD`, `git -C <repo> status --short`, `git -C <repo> stash list`). Every check ends by confirming it is unchanged.

## 1. One repository, end to end

Steps: map a project to one test repository with a `.slackoff/config.json` declaring `commands.test`. Fetch, refine, confirm the requirements, choose a solution (one repository). Let the debate run. If it escalates, rule and finalize. Before development starts, Slack Off re-reads the ticket (change the ticket's description in JIRA during the debate once, to see the acknowledgement). Let development run to `dev_done`.

Expected:
- [ ] The Design & debate tab shows every design version, every round, and the checklist with a conclusion for each item.
- [ ] After a JIRA change: the ticket waits on AC coverage, the acknowledgement needs a note, then development starts.
- [ ] `dev_done`; the Development tab shows commits `TEST-1: …`, checks passing, the worktree at `~/.slackoff/worktrees/TEST-1/<repo>` on branch `slackoff/TEST-1-<slug>`.
- [ ] `cd` into the worktree and run the tests yourself: they pass.
- [ ] Main checkout unchanged (HEAD, status, stash list as noted).

Result: ____ / Date: ____ / Notes: ____

## 2. Two repositories

Steps: a ticket whose chosen solution affects both test repositories. In one of them, add a pre-commit hook that fails on something the agent is likely to write (for example `grep -q TODO` on the staged diff, as in fake mode). Run to `dev_done`. Then, on a second ticket, change one repository's base branch in Settings to a name that does not exist, start development, fix the base branch, and Retry.

Expected:
- [ ] Two worktrees under `~/.slackoff/worktrees/<KEY>/`, nothing else in that folder; the same branch name in both.
- [ ] Each repository has its own commits; when the hook fails in one, the other's commit from the same step stays, the failing repository shows "Commit hook failed" with its output, and the next step fixes it.
- [ ] Missing base branch → `blocked`, the reason names the repository; after fixing it, Retry continues.
- [ ] Main checkouts unchanged.

Result: ____ / Date: ____ / Notes: ____

## 3. Husky v9 repository (incl. `HUSKY=0`)

Steps: a test repository using husky v9 (`core.hooksPath=.husky/_`, `.husky/_` gitignored) with `"install": "pnpm install"` (or npm) in `.slackoff/config.json`, and a `.husky/pre-commit` that runs the tests. Start the server from a shell with `export HUSKY=0`. Run a ticket. Then make the hook fail on purpose (for example a lint error the agent will hit). Then set `development.hookTimeoutMs` low and make the hook sleep. Finally remove `install` from the base branch's config and start a new ticket.

Expected:
- [ ] After the worktree is created, `.husky/_/pre-commit` exists in it; any lockfile change from install is reset and listed on the Development tab.
- [ ] The hook ran on every platform commit even with `HUSKY=0` in the server's environment (its output is in the commit result).
- [ ] A failing hook shows as hook failed, and its output appears in the next step's prompt (raw log under `~/.slackoff/runs/`).
- [ ] A hook timeout says so clearly ("Commit hook timed out").
- [ ] Without `install`: the new ticket is `blocked` ("… configured … but not installed"); no commit was made without hooks.

Result: ____ / Date: ____ / Notes: ____

## 4. Real JIRA In Progress write (test ticket only)

Steps: on a test ticket that is not In Progress, turn on Settings → JIRA → "Set tickets to In Progress in JIRA" (on this computer). Start development. On the Development tab, check the target status, then Send to JIRA. Repeat on a ticket that is already In Progress. Repeat once while logged out of JIRA in Chrome. Confirm one write from a paired phone (check 7).

Expected:
- [ ] Nothing is sent before you click Send to JIRA; the target status was shown first.
- [ ] The ticket shows In Progress in JIRA and Slack Off reports "set to In Progress"; no other field or comment changed in JIRA.
- [ ] The raw log of the jira-update run uses only `find` / `computer left_click` / `get_page_text` (plus tab housekeeping), and the only URL in it is `https://your-company.atlassian.net/browse/<KEY>`.
- [ ] Audit log: `jira_write_requested` → `jira_write_decided` → `jira_write_finished` (done).
- [ ] Already In Progress → "Already In Progress in JIRA — nothing was changed", no browser opened.
- [ ] Logged out → failed with "log in", the source-error banner shows, development carried on; Try again needs a new confirmation.
- [ ] Confirmed from the phone: the audit's `decidedBy` names the device.

Result: ____ / Date: ____ / Notes: ____

## 5. More than one Chrome browser

Steps: connect a second Chrome browser to Claude in Chrome (another computer or profile). With no browser chosen in Settings, fetch tickets, and start a JIRA write. Then Settings → JIRA → Detect browsers, choose this Mac's browser, and repeat both.

Expected:
- [ ] Before choosing: both fail with "Choose the Chrome browser for JIRA in Settings" (no confusing blocked reason).
- [ ] Detect browsers lists both; it works only on this computer (read-only on the phone).
- [ ] After choosing: fetching and the JIRA write succeed, and no tab was opened on the other device.

Result: ____ / Date: ____ / Notes: ____

## 6. Removing a repository from the mapping

Steps: while a two-repository ticket is developing (or blocked, ready to Retry), remove one of its repositories in Settings → Repositories, then Retry.

Expected:
- [ ] The ticket is `blocked` and the reason names the removed repository and how to fix it (map it again or choose a different solution).
- [ ] Nothing in the removed repository's main checkout changed.

Result: ____ / Date: ____ / Notes: ____

## 7. Phone over Tailscale

Steps: remote access on, phone paired (README, "Use on your phone"). From the phone: choose a solution and edit its repositories, rule on an escalated debate including one custom ruling, acknowledge a snapshot change, confirm a JIRA write, request changes on a `dev_done` ticket. Open Settings on the phone.

Expected:
- [ ] Every decision is reachable from the sticky bottom bar; no page scrolls sideways; buttons are easy to hit.
- [ ] The audit log names the phone for each decision.
- [ ] Settings on the phone: repositories, JIRA status sync, in-progress status and the JIRA browser are read-only ("Change this on the Mac"); debate rounds and development limits can be changed.

Result: ____ / Date: ____ / Notes: ____

## Security notes to confirm

- [ ] You have read README → "Security notes for development": development runs your repository's commands with your user permissions; agent-written code runs unconfined.
- [ ] Your test repositories' hooks do not delegate their critical checks to files the agent can edit (`package.json` scripts, lint-staged config), or you reviewed the diffs.
