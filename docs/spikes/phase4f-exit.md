# Phase 4f exit validation (acceptance for command-line tools and Node libraries; manual)

Phase 4f is done when two things hold:

- A repository whose rules file declares `acceptance.entry: "cli"` or `"library"` goes through acceptance like a web app. The agent declares cases, its only command is `slackoff-cases run`, the platform re-runs every case in a fresh run directory, and the report shows each case's command and output.
- What cannot be tested is reported as "E2E not executed", never as a pass.

The automated part runs in fake mode, with no JIRA and no Claude. The checks below run **against a real `claude`**, by hand. Fill in every result slot and commit the file.

Before you commit: never write a real company hostname, names, emails, tokens or keys in this file. Use `https://your-company.atlassian.net`, `TEST-1` and `example-org` in anything you write down, and blur screenshots.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Automated results (fake mode, no JIRA, no Claude)

| Suite | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | shared 39, web 174, server 1348: 1561 passed, 0 failed |
| Type check | `pnpm typecheck` | clean |
| e2e phases 1–4d | the fourteen earlier Playwright projects | 1, 2, 3, 3, 2, 1, 2, 2, 1, 2, 7, 5, 4, 2 passed |
| e2e phase 4f, desktop 1440 | `playwright test --project=desktop-phase4f` | 1 passed |
| e2e phase 4f, phone 390x844 | `playwright test --project=mobile-phase4f` | 1 passed (the command block inside the page, `scrollWidth === 390`) |

What the phase-4f e2e covers:

- **Fake data.** Only the phase-4f runs add a third fake repository, `cli`: a small to-do CLI at `./bin/tool.mjs`, with `acceptance: {entry: "cli", cli: {command: "./bin/tool.mjs"}}`. They also add the ticket FAKE-4, which takes option 4 (`cli` only).
- **Hand-off and the failing attempt.** FAKE-4 is handed off from the Development tab. The fake agent declares one case per AC. Its first run leaves out AC-2's input file, so the platform's own re-run fails AC-2 for real.
- **Fix round.** A fix iteration (`review_failed`) runs, and attempt 2 passes.
- **Report.** The Acceptance tab shows "Passed · attempt 2 of 3". Each AC's evidence is a command block that starts with `$ ./bin/tool.mjs`. AC-2's block shows `list`, `1. milk` and `exit 0`.
- **Phone.** At 390x844 the block stays inside the page.

Not covered automatically, hence the checks below:

- a real agent writing cases;
- a real repository with an install and a build;
- the real `claude` permission rules for `slackoff-cases run`.

## 0. A real small CLI repository goes through acceptance

Use a throwaway repository with a small Node CLI:

- the CLI is committed as `./bin/<tool>.mjs`, with a shebang and the executable bit;
- `.slackoff/config.json` declares `acceptance: {entry: "cli", cli: {command: "./bin/<tool>.mjs"}}`, plus `install` and `build` if the project needs them.

Map the repository to a test project and take a ticket through development and **Hand off**.

- [ ] The agent's cases appear under `acceptance/<repo>/cases/`. There is at least one happy and one error case per AC. — needs author: throwaway CLI repo (`entry: "cli"`), real `claude` through development and Hand off.
- [ ] The report shows a command block per cited case, and each block starts with `$ ./bin/<tool>.mjs`. — needs author: same run: check each block starts with `$ ./bin/<tool>.mjs`.
- [ ] Break the CLI on purpose (wrong exit code). The AC fails in the platform's own re-run, even if the agent's own run looked fine. — needs author: break the CLI's exit code; the platform re-run must fail the AC.
- [ ] `install` and `build` ran (the CLI used the built output), with `"install": "pnpm install"` and a `build` step: the server's `PATH` and `HOME` reach them. A failing `build` reports "E2E not executed: the build failed: …". — needs author: same repo with `install`/`build`; also a failing build → "E2E not executed: the build failed".
- [ ] With an AC broken on purpose, the fix round's note (Development tab, iteration "review_failed") quotes the case JSON, the platform's command line, its exit code and the end of its output. — needs author: check the review_failed note quotes the case JSON, command, exit code and output.
- [ ] A `testCommand` in the rules file shows under "Your project's own tests" with its result; it never changes an AC. — needs author: add a `testCommand`; it shows under "Your project's own tests" and never changes an AC.
- [ ] A `cli.command` path that does not exist reports "… does not exist in the exported snapshot". — needs author: point `cli.command` at a missing path; expect "does not exist in the exported snapshot".

Result: ____

## 1. A real small Node library repository goes through acceptance

Use a throwaway Node package. Its rules file declares `acceptance: {entry: "library", library: {runtime: "node", import: "<package name>"}}`.

- [ ] The agent writes examples under `acceptance/<repo>/examples/*.mjs` that import the package by its name, and cases that name them. — needs author: throwaway Node library repo (`entry: "library"`) through acceptance with the real `claude`.
- [ ] The report shows each example's run (`$ node examples/<name>.mjs`), **the example's code** in its own block, and its output (390px: the code block scrolls inside itself). — needs author: same run: check the run, code and output blocks (and the 390px scroll).
- [ ] An example that imports `node:fs`, or uses `process`, is refused by the guard; the message names the file. — needs author: have an example import `node:fs` in the real run; the guard must refuse it naming the file.

Result: ____

## 2. An interactive CLI is reported as not executed

Use a CLI that needs a terminal: a full-screen prompt, or a password read from `/dev/tty`.

Flag it in the rules file: `"cli": { "command": "./bin/<tool>.mjs", "interactive": true }`.

- [ ] The report says **E2E not executed: interactive CLIs are not supported** (naming the repository), every AC is "Not tested" and no acceptance agent ran. — needs author: interactive CLI with `"interactive": true`; expect not executed, every AC Not tested.
- [ ] Without the flag, the run does not pass and nothing hangs past `acceptance.caseTimeoutMs` (the cases fail visibly: EOF on stdin, exit 13 from a pending prompt). — needs author: same CLI without the flag; nothing hangs past `caseTimeoutMs`.

Result: ____

## 3. `CASES_SHIM_FORM` with a real `claude`

**Not verified → exit check.** The phase 4f spike could not run a real `claude`, because its operating rules forbid it. Run acceptance once with the real acceptance agent (logged in as in the README, `CLAUDE_CONFIG_DIR=… claude /login`) on the repository from check 0.

- [ ] Both forms ran under the exact rule `Bash(slackoff-cases run)`:
  - `cd <work dir>/acceptance && slackoff-cases run`;
  - a bare `slackoff-cases run` (the Bash tool keeps its working directory). — needs author: real acceptance agent on the check-0 repo; record both forms from the Activity tab.
- [ ] Anything else was denied: `slackoff-cases run; touch x`, `node bin/x.mjs`, `./bin/<tool>.mjs`. — needs author: same run: record that the other commands were denied.

Seen in the run's log (Activity tab):

- form 1: ____
- form 2: ____
- denied: ____

Result: ____
