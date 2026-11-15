# Contributing to Slack Off

Thanks for helping. Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md); a vulnerability goes through [SECURITY.md](SECURITY.md), never a public issue. This file covers the development setup, the tests, where the design decisions are written down, the code conventions, and the rules every change must keep. Slack Off acts on people's code, JIRA and GitHub, so the safety rules below are not negotiable.

## Development setup

Follow [docs/install.md](docs/install.md) steps 1 to 4 (Node 26, pnpm 12.6.0, `pnpm install`, `pnpm -F web build`). For development, run the server and the Vite dev server side by side:

```sh
pnpm dev:server   # http://127.0.0.1:4317 (the API; also serves packages/web/dist if built)
pnpm dev:web      # http://127.0.0.1:5173 (open this one; /api is proxied to 4317)
```

Use a throwaway data folder (`SLACKOFF_HOME="$(mktemp -d)"`) and fake mode (`SLACKOFF_FAKE_EXECUTOR=1`) unless you are deliberately testing against a real JIRA and Claude.

The packages:

- `packages/shared`: types, schemas (zod) and constants used by more than one package.
- `packages/server`: the Hono server, the workflow, the executors, the JIRA clients, the sandbox, the SQLite store (`node:sqlite`).
- `packages/web`: the React UI (Vite, Tailwind).
- `skills/`: the agent roles as Claude Code skills; `e2e/`: the Playwright suites; `scripts/`: repository checks.

## Tests

```sh
pnpm test          # unit tests of every package (node:test)
pnpm typecheck     # tsc --noEmit in every package
pnpm e2e           # every Playwright project, one after another
pnpm check:public  # tracked files hold no company hosts, personal names, emails or home paths
```

All four must pass before a change is merged.

`pnpm e2e` needs macOS (the command sandbox), the installed Google Chrome (the UI tests use `channel: 'chrome'`), Playwright's Chromium (`npx playwright install chromium`, for the acceptance re-run), and free ports 4317 and 5173: it starts its own servers there, so stop any Slack Off first (`lsof -nP -iTCP:4317 -sTCP:LISTEN`). To run one project: `pnpm exec playwright test --project=desktop-phase3` (never pass `--project` to `pnpm e2e`, which already lists every project).

**Fake mode** (`SLACKOFF_FAKE_EXECUTOR=1`) replaces JIRA, Claude and GitHub with canned answers (`packages/server/src/dev/`), so the whole workflow, every decision and the real sandbox paths can be tested without any account. New features need a fake-mode path and an e2e at desktop width and at 390x844.

## Finding something to work on

Look for issues labelled `good first issue` or `help wanted`, or open an issue (bug report or feature request; the templates ask for what is needed) before a large change, so the approach can be agreed first. Comment on an issue to say you are taking it.

## What runs automatically

- **CI** (`.github/workflows/ci.yml`) runs `pnpm typecheck`, `pnpm check:public` and `pnpm test` on macOS for every pull request. It has a read-only token and no secrets, and must stay that way: pull requests from forks run it too.
- **Nightly** (`.github/workflows/nightly.yml`) runs everything on `main` every night, `pnpm e2e` and `scripts/fresh-clone-check.sh` included, and opens (or comments on) an issue labelled `nightly-failure` when it fails. Fixing a red nightly comes before new work.
- **Dependabot** (`.github/dependabot.yml`) opens dependency-update pull requests (npm daily, GitHub Actions weekly). Review them like any other change: read the changelog, check that CI passes, and merge by hand.

## Screenshots

The README's screenshots come from the running app in fake mode: `pnpm screenshots` (`e2e/screenshots.spec.ts`) walks the fake tickets through the workflow and saves each page at 1440×900 and 390×844 in `docs/screenshots/`. Stop any Slack Off on ports 4317 and 5173 first. When your change visibly alters one of those pages, run it and commit the new PNGs, after looking at each one.

## Where decisions are written down

- `docs/superpowers/specs/`: the design document (the "spec"). It is in Chinese, as are the plans.
- `docs/superpowers/plans/`: one plan per phase, with its rulings and the cost of each ruling if it is wrong.
- `docs/spikes/`: experiments that decided a value, and each phase's exit checklist (the manual checks against real services).
- `docs/ba/`: the business-analysis diagrams; `design/`: the screen designs.
- `docs/release/`: the license decision, the history proposal and the release checklist.

When a change contradicts a written ruling, say so in the pull request and update the ruling.

## Code conventions

- **TypeScript that Node runs directly.** Node 26 strips types; there is no server build. `erasableSyntaxOnly` is on: no `enum`, `namespace`, parameter properties or other syntax that needs a transform. Import local files with their `.ts` extension.
- **`@slackoff/shared` is the only source of types and constants used across packages.** Do not redefine a shape in `server` and `web`; put it in `packages/shared/src` and import it. The README's mode tables come from `packages/shared/src/mode-comparison.ts`, and `packages/server/test/docs.test.ts` checks the README against it.
- **UI text lives in `packages/web/src/i18n/en.ts`.** Components call `t("key")`; no literal user-facing strings in components.
- **Mobile-first.** Every page must work at 390px wide with no horizontal scroll, every decision must be reachable from the sticky bottom bar, and touch targets must be at least 44px. The mobile e2e projects assert `scrollWidth === 390`.
- **Tests first** for behaviour changes: a failing test, then the code.

## Security rules

- **Never `--no-verify`, never `bypassPermissions`**, never `--dangerously-skip-permissions`, never `--force` on a push. Git hooks always run (in their sandbox).
- **Every new child process that runs repository or agent-written code goes through the command sandbox** (`packages/server/src/sandbox/`), with the environment scrubbed of secrets. A new process outside the sandbox needs a written ruling and an entry under Residual risks in the README.
- **Every outward write is confirmed by the developer, every time**: push, pull request, JIRA status, JIRA comment, trace export. The confirmation shows exactly what will be sent, the server refuses anything that changed since, and the write is audited with the device that confirmed it. No background or automatic outward write.
- Credentials stay in `credentials.json` (mode 600). They never reach a log, an HTTP response, the phone, an agent's environment or the audit log.
- Settings that widen what Slack Off may do are changeable on this computer only, never from a paired phone.

## Public content

The repository is public. In anything you commit (code, tests, fixtures, docs, screenshots, commit messages, branch names), use placeholder names only:

- JIRA: `https://your-company.atlassian.net`; tickets `PROJ-1`, `FAKE-1`, `SAMPLE-1`.
- People and email: `you@example.com`.
- GitHub: `example-org`.
- Paths: `/Users/<you>`.

Never a real company host, a real person's name or email, or your own home path. `pnpm check:public` enforces this for text files (it also runs inside `pnpm test`) and lists binary files, such as screenshots, that need a look by hand: blur or regenerate any screenshot that shows real data.

## Tests must not touch the developer's computer

Tests, e2e runs and probes use temporary folders and a temporary `SLACKOFF_HOME`. They never read or write the clipboard, the keychain, LaunchServices or launchd, shell rc files, `~/.gitconfig`, `~/.claude`, `~/.nvm` or other toolchain installs, or real user caches. A test that runs git must not depend on or write `~/.gitconfig` (use `-c` options or a temporary `GIT_CONFIG_GLOBAL`), and nothing logs in to a real service.

## Commit messages and pull requests

Use a conventional prefix: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`, optionally with a scope (`feat(web): …`). Say what changed and why in plain words. A trailer naming an AI assistant is welcome when one helped, but not required.

One logical change per pull request, with its tests and any README or exit-checklist update it needs. Run the four commands under [Tests](#tests) first.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
