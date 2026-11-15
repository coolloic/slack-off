# Phase 4 exit validation (optional modes and open-source release; third-party run)

Phase 4 is done when **someone who has never seen the project gets Slack Off running on their own Mac using only the README and [docs/install.md](../install.md)** (design doc §10, phase 4 exit). The automated part below is the closest a script gets to that: a fresh clone, the pinned toolchain, the tests, the UI build and a fake-mode start. The real exit is the third-party run further down, which the author arranges and fills in.

Before you commit: never write a real company hostname, names, emails, tokens or keys in this file. Use `https://your-company.atlassian.net`, `TEST-1`, `example-org`, `you@example.com` and `/Users/<you>` in anything you write down, and blur screenshots. Record the tester by role ("a backend developer, not involved in the project"), not by name.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Automated results (phase 4e, fake mode, no JIRA, no Claude, no GitHub)

Filled in at the end of phase 4e Tasks 3–6 (branch `feat/phase-4`), on macOS with Node v26.13.0 and pnpm 12.6.0:

| Suite | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | shared 39, web 181, server 1369. One full run passed everything; the other full runs on the author's machine each had 1 failure: `usage.test.ts` "10,000 runs … aggregate in under 200 ms" (about 240 ms while the three packages' suites run at once). It passes alone (3 of 3). Once, `local-sandbox.test.ts` T6-2 failed with `write EPIPE` under the same load and passed alone (118 of 118). Neither test was changed in phase 4e. |
| Type check | `pnpm typecheck` | clean |
| Public content | `pnpm check:public` | 0 findings; 40 binary files listed for a manual look |
| e2e phases 1–3 | `desktop`, `mobile`, `desktop-phase2`, `mobile-phase2`, `desktop-phase3`, `mobile-phase3` | re-run in 4e: `desktop-phase3` 2 passed, `mobile-phase3` 1 passed (the exact "Confirm" selector). The others were not re-run in 4e; last results are in [phase3-exit.md](phase3-exit.md). |
| e2e phase 4a (sandbox) | `desktop-phase4a`, `mobile-phase4a` | not re-run in 4e; 2 and 2 passed in [phase4a-exit.md](phase4a-exit.md) |
| e2e phase 4b (API modes) | `desktop-phase4b`, `mobile-phase4b` | re-run in 4e (the comparison table now comes from `@slackoff/shared`; the executor table has 7 rows): 1 and 2 passed |
| e2e phase 4c (cost, tracing) | `desktop-phase4c`, `mobile-phase4c` | not re-run in 4e; 7 and 5 passed in [phase4c-exit.md](phase4c-exit.md) |
| e2e phase 4d (preferences, prompts) | `desktop-phase4d`, `mobile-phase4d` | not re-run in 4e; 4 and 2 passed in [phase4d-exit.md](phase4d-exit.md) |
| e2e phase 4f (CLI and library acceptance) | `desktop-phase4f`, `mobile-phase4f` | not re-run in 4e; 1 and 1 passed in [phase4f-exit.md](phase4f-exit.md) |
| Fresh clone | `scripts/fresh-clone-check.sh` | **Pass** (commit `6ee2f43`, after ruling 4E-5 made the usage timing test a 3 s regression bound): clone, Node v26, pnpm 12.6.0, `install --frozen-lockfile` into a temporary store (reused 0, downloaded from registry.npmjs.org), typecheck, unit tests, UI build and fake-mode `/api/status` all OK; "fresh clone check: OK". An earlier run on `ed06173` failed only on the 200 ms timing test. |

Notes from writing the fresh-clone script (phase 4e Task 6):

- The clone goes under `/private/var/tmp`, not `$TMPDIR`. The command sandbox lets sandboxed commands write the system temp dirs. A checkout inside them fails the unit test that proves the checkout is read-only to sandboxed code. **Running `pnpm test` from a clone under `$TMPDIR` or `/tmp` has the same effect.**
- pnpm 12 reads `pnpm_config_store_dir` (and `pnpm_config_cache_dir`, `pnpm_config_state_dir`), not `npm_config_*`. The script sets these for the pnpm commands it runs and does not export them.
- Node 26 ships without corepack. The script uses the `pnpm` on `PATH` when it is the pinned version, and falls back to corepack only if corepack is installed.
- The usage timing test is now a 3 s regression bound (ruling 4E-5); the 200 ms target still holds when the file runs alone.

Run it yourself (it needs free port 4317 and a network connection for the install):

```sh
scripts/fresh-clone-check.sh            # prints "fresh clone check: OK" at the end
SLACKOFF_CHECK_KEEP=1 scripts/fresh-clone-check.sh   # keep the temporary folder to look at a failure
```

## The sub-plans' exit checklists

Each sub-plan has its own manual checklist against real services. Status when phase 4e Task 6 was written: every one is **not yet checked** (all result slots empty).

| Sub-plan | Exit checklist | Manual checks |
|---|---|---|
| 4a · command sandbox for agent commands and git hooks; not macOS | [phase4a-exit.md](phase4a-exit.md) | not checked (16 open) |
| 4b · JIRA API mode, Anthropic API-key mode | [phase4b-exit.md](phase4b-exit.md) | not checked (23 open). These include whether Claude Code honours the API key helper. |
| 4c · cost & quota, usage thresholds, run tracing | [phase4c-exit.md](phase4c-exit.md) | not checked (33 open) |
| 4d · preferences, agent prompt tools | [phase4d-exit.md](phase4d-exit.md) | not checked (21 open) |
| 4e · open-source release | this file and [docs/release/release-checklist.md](../release/release-checklist.md) | the third-party run below |
| 4f · acceptance for command-line tools and Node libraries | [phase4f-exit.md](phase4f-exit.md) | not checked (14 open) |

## Third-party run (the exit condition)

**Who:** one person who has never worked on Slack Off, on **their own Mac**, using **only** the README and `docs/install.md`. No help from the author while they work, except to unblock them after they have written down where they got stuck. They use a **test JIRA** project (or a free Jira Cloud site) and test repositories, never work data.

0. Before starting, write down the setup:
   - macOS version: ____
   - Node version before starting (`node --version`, or none): ____
   - Claude Code already installed and logged in? (yes / no): ____
   - Chrome with Claude in Chrome already set up? (yes / no): ____
   - `gh` already logged in? (yes / no): ____
1. **Fake mode.** Follow the install guide up to step 6 and see the ticket list in fake mode (FAKE-1, FAKE-2, FAKE-3).
   - [ ] Done. Time from a clean start: ____ min
2. **Real Claude and a test JIRA.** Connect your own Claude (subscription **or** API key, either one) and a test JIRA (browser **or** API mode, either one). Map one test repository. Fetch a test ticket and take it as far as **choosing a solution**: refine, review the ACs, see the proposed solutions, choose one.
   - Modes used: Claude ____ / JIRA ____
   - [ ] Done. Time: ____ min
3. **Every place you got stuck.** For each one: the README or install-guide section, what happened, how long it took, and how it was solved.

   | # | Section (README / install.md) | What happened | Time lost | How it was solved |
   |---|---|---|---|---|
   | 1 | | | | |
   | 2 | | | | |
   | 3 | | | | |

4. **Optional: the phone.** Turn on remote access over Tailscale, pair a phone and open the ticket from step 2 there.
   - [ ] Done / [ ] skipped. Notes: ____

Result: ____ / Date: ____ / Notes: ____

Every problem found here is fixed in the README or the install guide before publishing, with the usual commit rules, and the run is repeated if a fix changes a step.

## Before publishing: the author confirms

- [ ] **LICENSE chosen and committed:** MIT, `LICENSE` in the tree (phase 4e Task 2; [license-decision.md](../release/license-decision.md)).
- [ ] **History decided:** publish from one new, history-free commit (option B; [history-rewrite-proposal.md](../release/history-rewrite-proposal.md)), with the checks on that fresh clone done.
- [ ] **Release checklist read:** [docs/release/release-checklist.md](../release/release-checklist.md). Every step in it is the author's. Slack Off's plans do not push, change visibility, tag, release or publish.
