# Phase 4a exit validation (sandboxed git hooks, local-network mode, sandbox status, manual)

Phase 4a is done when your repositories' git hooks run inside the `dev-hook` sandbox on every platform commit and push, Settings shows the sandbox's state with the two new switches, and the optional local-port allowlist works for a repository that declares its ports. The automated part runs against fake mode: no JIRA, no Claude, no GitHub. The checks below run against **your own test repositories**, by hand. Fill in every result slot and commit the file.

Before you commit: never write a real company hostname, names or emails in this file. Use `https://<your-jira>.atlassian.net`, `TEST-1`, `example-org` and `/path/to/test-repo` in anything you write down, and blur screenshots.

Date run: ____  Slack Off commit: ____  Result: [ ] pass  [ ] fail

## Automated results (fake mode, no JIRA, no Claude, no GitHub)

Filled in at the end of Task 8 (branch `feat/phase-4`):

| Suite | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | shared 34, web 121, server 995: 1150 passed, 0 failed |
| Type check | `pnpm typecheck` | clean |
| e2e phases 1–3 | the six earlier Playwright projects | 1, 2, 3, 3, 2, 1 passed (as at the end of phase 3) |
| e2e phase 4a, desktop 1440 | `playwright test --project=desktop-phase4a` | 2 passed |
| e2e phase 4a, phone 390x844 | `playwright test --project=mobile-phase4a` | 2 passed (every visited page `scrollWidth === 390`) |
| All of `pnpm e2e` | eight Playwright runs, fresh servers and scratch dir each | 16 passed, about 2 minutes; no process left running |

What the phase-4a e2e covers. The fake `web` repository's `.githooks/pre-commit` refuses staged TODOs (as before), then runs an offline stand-in for lint-staged committed in the repository (`.githooks/fake-lint.mjs`). That script connects to `127.0.0.1:4317` and writes `<hook pid> sandboxed` to its `TMPDIR` when the connect fails with `EPERM`. FAKE-1's development (desktop and phone) asserts that the marker says `sandboxed`, and that the committed step's hook output ("Git hook output") shows `fake-lint: probe 127.0.0.1:4317 -> EPERM`. The connect is refused by the sandbox before any packet is sent. Settings → Workflow shows the green status card "Sandbox: on (macOS sandbox-exec)" and the "Run git hooks without the sandbox" switch (its red warning when on) and the "Local network" mode, editable on this computer. On a paired phone the card is shown and both controls, like the commands switch, are read-only.

Not covered automatically (hence the checks below): a real husky + lint-staged + commitlint repository, signed commits, the real `claude` under the development wrapper, the keychain, and allowlist mode with a repository whose tests start their own server.

## Prerequisites

- [ ] Node 26, pnpm, git, `pnpm install` done; Claude Code installed and logged in. — needs author: confirm `claude` is installed and logged in (subscription); the rest checked 2026-11-16: Node v26.13.0, pnpm 12.6.0, git 2.39.5, `pnpm install --frozen-lockfile` OK, `claude --version` 2.1.325.
- [x] A fresh data dir: `SLACKOFF_HOME=$(mktemp -d) pnpm dev:server` and `pnpm dev:web`, then open http://127.0.0.1:5173. Settings → Workflow shows "Sandbox: on (macOS sandbox-exec)". — verified 2026-11-16: fresh `mktemp -d` SLACKOFF_HOME; `pnpm dev:server` and `pnpm dev:web` started under `env -i` (HOME, PATH, TMPDIR only: no `GH_TOKEN`, no `ANTHROPIC_*`); `/api/status` 200 through :5173; headless Chromium, Settings → Workflow: `sandbox-status` reads "Sandbox: on (macOS sandbox-exec)".
- [ ] A **throwaway test repository** at `/path/to/test-repo` (mapped as `TEST` → `web`, base `main`) and a test JIRA ticket `TEST-1`. — needs author: create a throwaway repo at /path/to/test-repo, map `TEST` → `web` (base `main`), and a test JIRA ticket `TEST-1`.

## 0. A real husky + lint-staged + commitlint repository

Set the test repository up with husky v9 (`.husky/pre-commit` running `npx lint-staged`, `.husky/commit-msg` running `npx commitlint --edit "$1"`), a lint-staged config that formats `*.js`, and an `install` command in `.slackoff/config.json` (`pnpm install`), so `.husky/_` exists in the worktree.

- [ ] Develop `TEST-1` to `dev_done`: every step commits; the formatted files are what is committed; the development tab shows the hooks' output. — needs author: develop TEST-1 with the real `claude` on the husky + lint-staged + commitlint test repo; check commits and hook output.
- [ ] Make lint fail on purpose (stage a file the lint step rejects): the step shows `hook_failed` with lint's output; nothing is committed; the next step fixes it. — needs author: stage a file the lint step rejects during a real development step; expect `hook_failed`, nothing committed.
- [ ] Add to the pre-commit hook a probe `node -e "fetch('http://127.0.0.1:4317/api/status').then(() => console.log('REACHED'), (e) => console.log('refused', e.cause?.code))"`: the step's hook output says `refused EPERM`, never `REACHED`. — needs author: add the fetch probe to `.husky/pre-commit`, develop once; expect `refused EPERM`.
- [ ] Note whether lint-staged prints a warning about `packed-refs.lock` (its backup stash cannot be deleted through `packed-refs` inside the sandbox) and whether `git stash list` in the worktree is empty afterwards. — needs author: after check 0, record lint-staged's `packed-refs.lock` warning and `git stash list`.

Result: ____ / Date: ____ / Notes: ____

## 1. Signed commits

Only if you sign commits (`commit.gpgsign` / `gpg.format ssh`).

- [ ] A development step's commit is signed (`git log --show-signature -1` in the worktree): signing happens in the platform's own `git`, outside the sandbox; the hooks still run sandboxed. — needs author: only if you sign commits: `git log --show-signature -1` in the worktree after a real development step.

Result: ____ / Date: ____ / Notes: ____

## 2. Real `claude` Bash under the development wrapper (carried from phase 3 exit check 9)

- [ ] In a development step the real `claude` runs one of the repository's declared commands through its Bash rule: the command exits 0 (no spurious non-zero exits), and its cwd file (`/private/tmp/claude-*-cwd`) is written. Look at the raw run log under `$SLACKOFF_HOME/runs/`. — needs author: real development step; read the raw run log under `$SLACKOFF_HOME/runs/` for exit 0 and the cwd file.
- [ ] Inside that command `env` shows no `ANTHROPIC_*`, `CLAUDE_CODE_*`, `GH_TOKEN` or other token variables (start the server with a fake `GH_TOKEN=fake` to check). — needs author: start with `GH_TOKEN=fake`, have a declared command print `env` in a real development step.

Result: ____ / Date: ____ / Notes: ____

## 3. The keychain (carried from phase 3 exit check 9, unchanged)

- [ ] The keychain through the security daemons (mach-lookup to `com.apple.SecurityServer` / `com.apple.securityd.*`) is denied in every profile, but only checked on the profile text, **not probed** at run time. Create a throwaway item (`security add-generic-password -s slackoff-probe -a test -w throwaway`), then from a sandboxed development test run `security find-generic-password -s slackoff-probe -w` and note what happens (expected: it fails and prints no password). Delete the item afterwards (`security delete-generic-password -s slackoff-probe`). Never probe a real credential. — needs author: run the throwaway keychain probe yourself (audit sessions must not touch the keychain); delete the item afterwards.

Result: ____ / Date: ____ / Notes: ____

## 4. Allowlist mode with a repository whose tests start their own server

Use a test repository whose `node --test` suite starts an HTTP server on a fixed port (say 7001) and requests it.

- [ ] Settings → Workflow → Local network: "Allow declared ports only" (this computer). Without `sandbox.localPorts`, the test step fails (the connect is refused: `EPERM`). — needs author: test repo whose `node --test` suite serves on port 7001; switch to allowlist and develop with the real `claude`.
- [ ] Commit `"sandbox": { "localPorts": [7001] }` to the base branch's `.slackoff/config.json`, Retry: the tests pass. — needs author: after the previous check: commit the `localPorts` declaration, Retry, expect the tests to pass.
- [ ] Note anything that relies on outbound IPv6 (allowlist mode refuses all outbound IPv6 TCP): installs from a registry reached over IPv6, a dev server bound to `::1` only. — needs author: note IPv6-only installs or dev servers seen during check 4.
- [ ] Switch back to "Deny listed ports". — needs author: switch Local network back after check 4.

Result: ____ / Date: ____ / Notes: ____

## 5. Residual risks to confirm you have read

- [ ] README → "Security notes for development" (Git hooks in the sandbox, allowlist mode, the environment strip and its install exception, UDP not filtered) and "Residual risks": sandboxed code still reaches the internet, UDP is not filtered, secrets under other names get through, a hook can add objects (never replace, delete or chmod an existing one, nor write packs, alternates or the commit-graph) — including a planted object for a future write of this ticket's own commits — stage content into the commit it runs for, and rewrite or delete its own ticket branch ref, nested repositories and submodules are refused (no `.git` can be created in a worktree; the platform refuses an embedded repository, a populated submodule or a new / moved gitlink before committing, and never looks into submodules), a hooks directory over 1 MiB per file or 16 MiB in all blocks development (fail closed), reverting a file re-checks for swapped-in symlinks but cannot exclude a swap in the instant before the delete, a hook that commits again fails, a hook changed between the fingerprint check and git running it still runs (sandboxed), process-group escape (`setsid`) is not probed, not sandboxed: the `claude` process itself and `gh`. Noted: ____ — needs author: read README → Security model and residual risks and fill in "Noted".

## Deferred (known, not fixed in phase 4a)

- **lint-staged's `packed-refs` warning and a stale `refs/stash`.** Dropping lint-staged's last backup stash deletes `refs/stash`, which git does through `packed-refs` when the ref is packed; the sandbox refuses `packed-refs.lock`, so git warns and the hook still succeeds. The test fixture `packages/server/test/fixtures/hooks/fake-lint-staged.sh` reproduces this; check 0 records what a real one does.
- **Allowlist mode with IPv6-first clients.** Not probed (the tests use no network). A client that tries IPv6 first and does not fall back to IPv4 fails in allowlist mode.
- **Acceptance installs from a private registry.** Only the development install keeps `NPM_TOKEN` / `NODE_AUTH_TOKEN`; acceptance's install command runs without them, so a private registry there fails visibly.
- A hook can delete its own ticket branch ref (blocks only that ticket; ruling 4A-13).
- **Submodule repositories (ruling F4A-2).** A repository that uses submodules keeps its base branch's submodule pointers, but they are never initialised in the worktree, and a step that would change one is refused; change submodule pointers by hand.
- **Hooks that run `git gc` / `git repack` (ruling F4A-1).** They fail inside the sandbox (packs and `objects/info` are read only, existing loose objects cannot be deleted): `hook_failed`, visible.
- **A planted object for a future write (F4A-1 residual).** A hook can create an object file for a name that does not exist yet with content that does not match it; if the platform later writes exactly that object, git keeps the planted file. Limited to objects created after the hook ran (this ticket's own new commits); shows in the branch's diff.

## Final fix pass (rulings F4A-1, F4A-2, F4A-3)

After the 4a final review: a hook can no longer replace, delete or chmod existing objects or write packs / `objects/info` (C-A: a forged blob of main's `.slackoff/config.json` was read by `loadProjectRules`); no `.git` can be created in a worktree from any dev sandbox, the platform refuses nested repositories and gitlinks before committing, and its own status / diff never recurse into submodules (C-B: a nested repository's clean filter ran in the platform's unsandboxed `git status`, present since phase 3); `revertPaths` deletes with a no-follow, re-lstat walk; the hooks fingerprint is capped (1 MiB per file, 16 MiB in all) and fails closed. Regression tests: `packages/server/test/local-sandbox.test.ts` ("F4A-1 (C-A)…") and `packages/server/test/phase4a-final.test.ts`.
