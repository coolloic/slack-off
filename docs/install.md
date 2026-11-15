# Installing Slack Off

This guide takes you from a Mac with nothing installed to Slack Off running against your own JIRA and Claude. Do the steps in order; each one ends with a **Check:** that tells you it worked. Steps 1 to 6 need neither JIRA nor Claude: at the end of step 6 you see the whole interface with fictional tickets.

Before you start, read [Before you start: is this allowed at your company?](../README.md#before-you-start-is-this-allowed-at-your-company) in the README.

Slack Off is tested on macOS only. Its command sandbox needs macOS's `sandbox-exec`; see [Not on macOS](#not-on-macos) if you are on Linux or Windows.

You also need **git**: if `git --version` asks you to install the Xcode Command Line Tools, accept and wait for it to finish.

Example values in this guide are placeholders: `https://your-company.atlassian.net`, `you@example.com`, `example-org`, `/Users/<you>`. Use your own.

## 1. Node 26

Slack Off runs its server's TypeScript directly with Node 26 (no build step for the server). Install Node 26 in any way you like: [nodejs.org](https://nodejs.org), Homebrew, or a version manager. The repository has an `.nvmrc` that says `26`, so with nvm:

```sh
nvm install 26
nvm use          # run inside the clone (step 3); reads .nvmrc
```

**Check:** `node --version` prints a version that starts with `v26.`.

If you see `node: bad option: --disable-sigusr1` when you start Slack Off later, an older Node (for example Node 22) is first on your `PATH` in that terminal. Run `node --version`, then `nvm use` (or put Node 26 first on your `PATH`) and start again. Every new terminal needs this unless Node 26 is your default (`nvm alias default 26`).

## 2. pnpm 12.6.0

The repository pins pnpm in `package.json` (`"packageManager": "pnpm@12.6.0"`). Node 26 no longer ships corepack, so install pnpm yourself, for example:

```sh
npm install -g pnpm@12.6.0
```

If you have corepack from elsewhere (`npm install -g corepack`), `corepack enable pnpm` inside the clone gives you the pinned version too. Other pnpm versions may work, but 12.6.0 is the one the project is tested with.

**Check:** `pnpm --version` prints `12.6.0`.

## 3. Clone and install

```sh
git clone https://github.com/coolloic/slack-off.git slack-off
cd slack-off
nvm use            # if you use nvm
pnpm install
```

`pnpm install` downloads the dependencies from the public npm registry. It does not change anything outside the clone except pnpm's own package store.

**Check:** `pnpm typecheck` finishes without errors (it prints only the command it ran).

## 4. Build the web UI

```sh
pnpm -F web build
```

The server serves this build on port 4317. (`pnpm start` in the next step builds it again; this step shows you that the build works on its own.)

**Check:** `ls packages/web/dist/index.html` prints the path (no "No such file").

## 5. First start

```sh
pnpm start
```

This builds the UI and starts the server on `http://127.0.0.1:4317` (only reachable from this computer). Leave it running in its terminal, and open http://127.0.0.1:4317 in your browser. The first page says **"JIRA is not configured yet. Set the JIRA base URL to start fetching tickets."** That is expected: you set JIRA up in step 8. Stop the server with Ctrl-C.

Your data lives in `~/.slackoff` (set `SLACKOFF_HOME` to use another folder).

If the server stops at once with **"Slack Off is already running (or another program uses 127.0.0.1:4317)"**, something already listens on port 4317. Find it with:

```sh
lsof -nP -iTCP:4317 -sTCP:LISTEN
```

If it is an older Slack Off, open it or stop it. If it is another program, stop that program: Slack Off's port is fixed at 4317, because its command sandbox denies exactly that port (and 5173, used by `pnpm dev:web` for development).

**Check:** with the server running, in another terminal, `curl -s http://127.0.0.1:4317/api/status` prints JSON that contains `"jira":{"configured":false`.

## 6. A first look without JIRA or Claude: fake mode

Fake mode answers every JIRA read and every agent run with canned, fictional data. It is meant for trying the interface and for the automated tests only: it never talks to JIRA, Claude or GitHub, and it must never be pointed at your real repositories or data. Start it with a throwaway data folder so it stays apart from `~/.slackoff`:

```sh
SLACKOFF_HOME="$(mktemp -d)" SLACKOFF_FAKE_EXECUTOR=1 node --disable-sigusr1 packages/server/src/main.ts
```

Open http://127.0.0.1:4317 and click **Fetch new tickets**. Three tickets arrive (FAKE-1, FAKE-2, FAKE-3). Select one and click **Start refining**, then follow the "Your decision needed" cards through solutions, design, development, acceptance and delivery. The acceptance step runs a real Playwright test, so it needs Playwright's Chromium from step 9 to pass. Stop the server with Ctrl-C when you are done; the throwaway folder can be deleted.

**Check:** after Fetch new tickets, the Tickets list shows FAKE-1, FAKE-2 and FAKE-3.

## 7. Claude Code

Slack Off runs agents through the Claude Code CLI on your computer. Install it by following Anthropic's Claude Code documentation, so that `claude` is on your `PATH`. Then choose one mode (see [Choosing how Slack Off talks to Claude](../README.md#choosing-how-slack-off-talks-to-claude)):

- **Subscription (default).** Log in once with your Claude subscription: run `claude` in a terminal and follow its login prompt. Slack Off never reads or stores this login.
- **API key.** Create an Anthropic API key in your Anthropic account, then in Slack Off: Settings → Executor → "Anthropic API key", paste the key and save. It is stored in `~/.slackoff/credentials.json` with mode 600. This mode needs the JIRA API mode, and Settings refuses it until JIRA is set to API mode: do step 8 with "JIRA API" first, then come back to this step.

The acceptance agent uses its own Claude configuration folder. In subscription mode, log in to it once as well:

```sh
CLAUDE_CONFIG_DIR=~/.slackoff-acceptance/claude-config claude /login
```

**Check:** `claude --version` prints a version, and with `pnpm start` running, the top bar of Slack Off shows **Claude Code · ready** (or `curl -s http://127.0.0.1:4317/api/status` shows `"available":true` under `executor`).

## 8. JIRA

In Settings → JIRA, set the **JIRA base URL** (https only, for example `https://your-company.atlassian.net`). Then choose one mode (see [Choosing how Slack Off reads JIRA](../README.md#choosing-how-slack-off-reads-jira)):

- **Browser (default): no API token needed, uses your own browser login.** Install Google Chrome and the Claude in Chrome extension, sign in to the extension with your Claude account, make sure the extension is connected to Claude Code (in a terminal, `claude` → `/chrome` shows it as connected), and log in to your JIRA in that Chrome. If more than one Chrome is connected to the extension, click **Detect browsers** in Settings → JIRA and choose the one logged in to JIRA.
- **JIRA API.** Create an API token in your Atlassian account settings (never use your JIRA password). In Settings → JIRA choose "JIRA API — email and API token", enter your account email (`you@example.com`) and the token, and save. Only Jira Cloud is supported in this mode.

**Check:** on the Tickets page, **Fetch new tickets** lists the open tickets assigned to you in JIRA (or "No tickets yet" if you have none), with no error banner.

## 9. Playwright's Chromium (acceptance)

The acceptance agent tests your app with Playwright's own Chromium, never your Chrome. Install it from inside the clone, so the version matches the project's Playwright:

```sh
npx playwright install chromium
```

**Check:** `npx playwright --version` prints `Version 1.64.1`, and `ls ~/Library/Caches/ms-playwright` lists a `chromium-…` folder.

## 10. GitHub CLI (delivery)

Delivery pushes branches and opens pull requests with the GitHub CLI and your own login. Install `gh` (for example with Homebrew) and log in once:

```sh
gh auth login
```

**Check:** `gh auth status` says you are logged in to github.com.

## 11. Optional: your phone over Tailscale

To decide from your phone, install Tailscale on this Mac and on your phone and sign both into the same tailnet. Then follow [Use it from your phone](../README.md#use-it-from-your-phone) in the README (turn on remote access, restart, pair the phone).

**Check:** `tailscale ip -4` (or the Tailscale app) shows this Mac's `100.x.y.z` address, and after pairing, the phone opens `http://<that address>:4317`.

## 12. Map a repository and run your first ticket

In Settings → Repositories, add a row: the JIRA project key (for example `PROJ`), a short repository name (`api`), the absolute path of a local git repository (`/Users/<you>/code/api`) and its base branch (`main`). Start with a throwaway repository you do not mind an agent working in.

Optionally, commit a `.slackoff/config.json` to that repository's base branch with its install, build, lint and test commands and an `acceptance` section (see [Configure](../README.md#configure)). Without an `acceptance` section, acceptance reports "E2E not executed".

Then on the Tickets page: **Fetch new tickets**, select a ticket of that project, **Start refining**.

**Check:** the ticket moves to Refining and, a few minutes later, shows "Your decision needed" with requirements and acceptance criteria to review.

## Not on macOS

On Linux or Windows the command sandbox is unavailable. Slack Off still starts and you can refine tickets, propose solutions and debate designs, but development commands and commits with git hooks are refused unless you turn on Settings → Workflow → "Run repository commands without the sandbox" and "Run git hooks without the sandbox", which let any code in your repositories act as you in Slack Off. Acceptance never runs without the sandbox. See [Security model and residual risks](../README.md#security-model-and-residual-risks).

**Check:** Settings → Workflow shows **"Sandbox: unavailable"** with the reason, and the server printed `Command sandbox unavailable: …` when it started.

## Uninstall

Stop Slack Off (Ctrl-C), then delete its data folders and the clone:

```sh
rm -rf ~/.slackoff
rm -rf ~/.slackoff-acceptance
rm -rf slack-off
```

That removes the database, the audit log, the run logs, the stored credentials (`credentials.json`), the worktrees and the acceptance agent's Claude configuration. Slack Off keeps everything of its own in these two folders; what you confirmed it to send (pushed branches, pull requests, JIRA changes) stays where it was sent. Your own tools (Node, pnpm, Claude Code, Chrome and its extension, Playwright's Chromium, `gh`, Tailscale) stay installed; remove them the way you installed them if you no longer need them. In your repositories, the ticket branches (`feat/<KEY>-…`, `fix/<KEY>-…` and so on, or `slackoff/…` from older versions) stay, and git lists the deleted worktrees as prunable until you run `git worktree prune` there.

**Check:** `ls ~/.slackoff ~/.slackoff-acceptance` reports "No such file or directory" for both.
