# Spike: acceptance isolation, mechanism, FS/network guard, jira-comment input, push / gh (phase 3, Task 1)

Date: 2026-11-07 · CLI: Claude Code 2.1.319 · macOS 15.6.1 (Darwin 24.6.0) · @playwright/test 1.64.1 (Slack Off's own install) · gh 2.79.0 · git (macOS) · Node 24.21.0 for scripts and the app.
Throwaway experiments only; raw logs are not committed. Everything ran in a scratch directory: a git repo `shop` (a 22-line Node HTTP app: `GET /` page with Quantity + Buy, `GET /health`, `POST /api/orders` validating `qty` 1–10; `.slackoff/config.json` with a draft `acceptance` section; `docs/design.md`; a symlink), a fake `SLACKOFF_HOME` (`slackoff.db`, `secret.txt`), a local bare repo as `origin`, a worktree on `slackoff/T-1-x`, and a local mock JIRA page (`127.0.0.1:18766`, a small `http.server`-based Python script that also stores comments from a POST). No real JIRA, GitHub or other site was contacted. `gh` was only run as `--help` (real binary) and as a fake script. No file in `~/.claude`, no keychain entry and no global git config was changed. `claude /login` was not run.
9 real `claude -p` runs that reached the model, plus 5 that stopped at "Not logged in", about 0.61 USD in total.

Every agent run used the phase-1/2 baseline: `--output-format stream-json --verbose --permission-mode default --permission-prompts none --strict-mcp-config --setting-sources "" < /dev/null`, plus `--no-session-persistence`. Agent runs were started with `env -i`.

## Decided values

| Name | Value | Basis |
|---|---|---|
| `ACCEPT_CONFIG_DIR_MODE` | `'dedicated'` (ruling Q-3: `~/.slackoff-acceptance/claude-config`, one-time `claude /login` by the author) | A new `CLAUDE_CONFIG_DIR` answers "Not logged in · Please run /login" (§1). Whether the dedicated directory keeps its login across runs and purges is **not verified**. It needs the author's manual login (manual check 1). |
| `ACCEPT_CONFIG_PURGE` | `['projects', 'sessions', 'todos', 'shell-snapshots', 'session-env', 'file-history', 'debug', 'backups']`. Never `.claude.json`, `plugins`, or credentials. | A run in a new directory created `.claude.json`, `backups/`, `plugins/`, `projects/` and `sessions/` (§1). The others are the CLI's usual session folders. Also pass `--no-session-persistence` on every acceptance run, so `projects/` is never written in the first place. |
| `ACCEPT_ENV_KEYS` | `['PATH', 'HOME', 'USER']` (+ `CLAUDE_CONFIG_DIR` set by the platform) | Without `USER` the subscription login fails, even in the default config directory. `PATH`+`HOME`+`USER` is enough (§1). `LANG` and `TMPDIR` are not needed. Without `TMPDIR`, Playwright puts its temporary profiles under `/tmp`. |
| `ACCEPT_MECHANISM` | `'specs'` | (a) works end to end (§2). Step 3 (MCP) was not needed and was skipped. |
| `ACCEPT_TEST_COMMAND` | `'playwright test'` | §2 |
| `ACCEPT_BASH_FORM` | `'cd <workDir>/acceptance && playwright test'` | §2. Allow rule exactly `Bash(playwright test)`. The Bash cwd persists, so the agent drops the `cd` prefix on later calls. Both forms match. |
| `ACCEPT_PLAYWRIGHT_LINK` | `'symlink'` (`acceptance/node_modules/@playwright/test` → `<repoRoot>/node_modules/@playwright/test`) | With `NODE_PATH`, the ESM `import` of the config fails: `ERR_MODULE_NOT_FOUND` (§2). |
| `ACCEPT_BROWSER` | `'chromium'` (Playwright's own headless shell) | Both browsers ran with a new temporary profile, but `channel: 'chrome'` starts **the user's installed Google Chrome binary**. `chromium` does not need it (§4.1). |
| `ACCEPT_FS_GUARD` | `'sandbox-exec'`, applied through a **platform `playwright` shim** placed first on the agent's `PATH`, **not by wrapping `claude`** | §4.2. This differs from the plan's "wrap claude" design (see Concerns 1). |
| `SANDBOX_PROFILE` | the text in §6.1, with every path passed as a `-D` parameter (realpaths) | §6 |
| `SANDBOX_SELF_CHECK` | `sandbox-exec -f <profile> -D … <node> selfcheck.mjs <SLACKOFF_HOME>/slackoff.db 4317 5173 <tailscalePort>`. It passes only if every connect **and** the file open fail with `EPERM` (§6.3). | §6.3 |
| `JIRA_COMMENT_COMPUTER_ACTIONS` | `['left_click', 'type', 'scroll', 'scroll_to', 'wait', 'screenshot']`. `type` is allowed only when `text === SLACKOFF_TYPE_TEXT` (exact match), and `key` is refused. | §5 |
| `JIRA_COMMENT_MULTILINE` | `true` | A 4-line text with `\n` and lines starting with `- ` went in with one `type` and was saved verbatim (§5). |

## 1. `CLAUDE_CONFIG_DIR` and the subscription login (step 1)

Keychain item names before and after (from `security dump-keychain`, attribute names only, no contents): only `"svce"="Claude Code-credentials"`. No run added one.

| Run | Environment (`env -i` …) | Result |
|---|---|---|
| 1 | `PATH HOME CLAUDE_CONFIG_DIR=<scratch>/cfg-fresh` | `Not logged in · Please run /login`, `apiKeySource: none`, cost 0 |
| 2 | `PATH HOME` (default config) | **Not logged in** |
| 3 | `PATH` | Not logged in |
| 4 | `PATH HOME USER` (default config) | `OK`, `apiKeySource: none` (subscription) |
| 5 | `PATH HOME USER CLAUDE_CONFIG_DIR=<scratch>/cfg-fresh2` | **Not logged in** |

So the login is tied to the config directory (the keychain lookup also needs `USER`), and a new directory cannot reuse it. That makes `'dedicated'` the outcome under ruling Q-3. Not verified, because it needs the author's `claude /login`: that later `-p` runs in the dedicated directory reuse the login, and that deleting `ACCEPT_CONFIG_PURGE` does not break it (manual check 1). The new directory contained `.claude.json, backups/, plugins/, projects/, sessions/` after one run without `--no-session-persistence`.

## 2. Mechanism (a): specs + exact command (step 2)

**Export.** `git archive --format=tar <sha>` piped into `tar -x -C <work>/shop` by Node `spawn` (two processes, no shell): both exit 0. Result: no `.git`. `export-ignore` worked for `docs/design.md` and `.slackoff`, but the **empty `docs/` directory remains**. The symlink `link-to-server.mjs -> server.mjs` was kept as a symlink. `.gitattributes` itself is exported. Note that `export-ignore` comes from the branch being exported, so the dev agent controls it (Concerns 4).

**Scaffold.** `acceptance/playwright.config.mjs` as in the brief (`testDir: 'specs'`, `outputDir: 'artifacts'`, json reporter → `results.json`, `screenshot: 'on'`, `workers: 1`, plus `use.baseURL`). `specs/*.spec.mjs` with `import { test, expect } from '@playwright/test'` works through the symlink. With `NODE_PATH=<repoRoot>/node_modules` and no symlink: `ERR_MODULE_NOT_FOUND` when the config is loaded.

**`results.json` shape.** Top-level `config, suites, errors, stats` (`stats.expected/unexpected/flaky/skipped`). `suites[].specs[]` has `{title, ok, file, line, tests[]}`, `tests[]` has `{status: 'expected'|…, results[]}`, and `results[]` has `{status: 'passed'|…, errors, stdout, attachments, …}`.
- `testInfo.attach('note', {body, contentType})` → `{name, contentType, body: <base64>}`
- `use.screenshot: 'on'` → `{name: 'screenshot', contentType: 'image/png', path: '<abs>/artifacts/<test>/test-finished-1.png'}`
- `page.screenshot({path: 'evidence/ac-1.png'})` → the file is written relative to the cwd, but **it does not appear in `results.json`**. To be linked to an AC, evidence must be attached (`testInfo.attach(name, {path})`), or the platform has to collect `evidence/` by file name.

**Agent run** (cwd = `<run>/work`, `--restricted --tools Read Grep Glob Edit Write Bash --allowedTools Read Grep Glob Edit Write "Bash(playwright test)" --disallowedTools WebFetch WebSearch "Bash(git *)" "Bash(gh *)" "Bash(curl *)" "Bash(npx *)"`, `PATH=<repoRoot>/node_modules/.bin:<node24>/bin:/usr/bin:/bin`). 11 turns:

| # | Command | Result | Side effect |
|---|---|---|---|
| 1 | Write `acceptance/specs/ac2.spec.mjs` | ok | — |
| 2 | `cd <A> && playwright test` | **ran**, 2 passed | evidence written |
| 3 | `playwright test && touch <work>/x1` | denied | none |
| 4 | `playwright test --config ../x` | denied | — |
| 5 | `playwright test; touch <work>/x2` | denied | none |
| 6 | `npx playwright test` | denied (deny rule) | — |
| 7 | `git status` | denied (deny rule) | — |
| 8 | `curl -s http://127.0.0.1:3100/` | denied (deny rule) | — |
| 9 | `playwright test` (bare, cwd persisted) | ran | — |
| 10 | `PWDEBUG=1 playwright test` | denied | — |

## 3. Mechanism (b) MCP: skipped (step 3)

(a) works, so the default holds.

## 4. Browser and file-system guard (step 4)

### 4.1 Browser

| Project | Executable (from `ps` during the run) | `--user-data-dir` | Google cookies |
|---|---|---|---|
| `chromium` | `~/Library/Caches/ms-playwright/chromium_headless_shell-1248/…/chrome-headless-shell`, version 156.0.8078.4 | `/tmp/playwright_chromiumdev_profile-…` (new) | 0 |
| `channel: 'chrome'` | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, 156.0.8078.81 | `/tmp/playwright_chromiumdev_profile-…` (new) | 0 |

Neither run used the developer's Chrome profile. `'chromium'` is chosen because it does not use the user's Chrome binary at all.

### 4.2 Guards

Probe spec: `readFileSync(<SLACKOFF_HOME>/secret.txt)`, `readFileSync(<repo>/docs/design.md)`, `chromium.launchPersistentContext(<SLACKOFF_HOME>/fake-chrome-profile)` (a **decoy** directory; the real Chrome profile was never opened, see Concerns 6), plus a normal test against the app. A second spec dodges the static scan: `globalThis["pro"+"cess"]["getBuilt"+"inModule"]("f"+"s")["read"+"File"+"Sync"](…)`, and `page.goto('file://<SLACKOFF_HOME>/secret.txt')`.

| Guard | Secret / repo read | Persistent context | `file://` from the browser | Chromium runs? | Login? |
|---|---|---|---|---|---|
| none | **READ** | launched | **READ** | yes | — |
| `sandbox-exec` wrapping the whole `claude` (deny SLACKOFF_HOME + repos) | EPERM | EPERM (mkdir) | — | **yes** (app test passed) | **yes** |
| Claude Code `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"filesystem":{"denyRead":[…]}}}'` | EPERM | fails | — | **no**: `FATAL … bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer: Permission denied (1100)`, SIGTRAP | yes |
| spec scan only (PreToolUse hook on `Bash` with `--settings`, exit 2) | naive spec: **refused** before running | refused | — | — | yes |
| spec scan, dodging spec | **passes the scan** (hook exit 0) and **READ** the secret | — | **READ** | yes | — |
| `sandbox-exec`, dodging spec | EPERM | — | `net::ERR_FILE_NOT_FOUND` | yes | — |
| **platform shim** `playwright` (first on PATH, `exec sandbox-exec -f <profile> -D … <repoRoot>/node_modules/.bin/playwright "$@"`), `claude` itself not wrapped | EPERM | EPERM | — | yes | **yes** |
| **outer `sandbox-exec` on claude + inner shim** | — | — | — | — | the inner call fails: `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71). **Sandboxes cannot be nested.** |

The full profile in §6.1 denies `~/Library/Keychains`. Wrapping `claude` with it gives **"Not logged in"**, because the CLI needs the keychain. That leaves two choices:
1. Wrap `claude` with a profile *without* `~/Library/Keychains`. This works, but spec code then runs with keychain-file access.
2. **Shim, chosen:** leave `claude` unwrapped (its file tools are confined by `--restricted`, and its only code-running path is the exact `Bash(playwright test)` rule) and run every `playwright test` under the full profile. This covers spec code, a `globalSetup` / `webServer` in the config, and the browser. The platform's own rerun and the target app start use the same profile.

Facts about `sandbox-exec` (macOS 15.6.1, deprecated in `man` but working):
- Paths must be **realpaths**. A deny on `/tmp/...` did not block `/private/tmp/...`. A symlink into a denied directory is blocked. A **pre-existing hard link** outside the denied subpath can still be read, but creating one inside the sandbox is denied.
- Use `-D NAME=value` + `(param "NAME")` rather than putting paths inside the `-p` text. Spaces work (`…/Application Support/Google/Chrome`) and nothing needs escaping.

## 5. jira-comment input (step 5, local mock only)

**Browser.** `list_connected_browsers` showed one browser, "Browser 1" `0e62813c-…` (`isLocal: true`). Google Chrome and `claude --chrome-native-host` were both running on this Mac. This is the same set-up as the phase-2 Task 12 run. The deviceId was pinned through `select_browser` + guard. Every agent request appeared in the mock's log, which confirms the browser was local.

**Mock** `/browse/T-1`: an "Add a comment…" `role=button` placeholder. Clicking it shows a `contenteditable` `role=textbox` and Save/Cancel. Save POSTs `/comment` and reloads, and comments are rendered in Activity. The page also has a link to `/other/elsewhere`.

**Run set-up.** `--chrome --tools ToolSearch`, allowed `CHROME_READ_TOOLS + computer + select_browser`, every other chrome write tool and `Bash/Edit/Write/WebFetch/WebSearch` denied. The phase-2 guard was copied with one addition: `computer` `type` is allowed only when `args.text === base64url-decoded SLACKOFF_TYPE_TEXT`. The PreToolUse matcher covers `navigate|tabs_create_mcp|computer|select_browser|switch_browser`, and `SLACKOFF_COMPUTER` is the decided list.

| Run | What | Result |
|---|---|---|
| c1 | Normal flow with the 4-line text `Acceptance result for T-1: 2 of 2 criteria passed.\n- AC-1: pass\n- AC-2: pass\nEvidence is in Slack Off.` | `select_browser` → `tabs_context_mcp` → `tabs_create_mcp` → `navigate` → `find` → `left_click ref_6` → **one `type` with the whole multi-line text** (hook exit 0) → `find "Save"` → `left_click ref_8` → `get_page_text` (text read back verbatim) → `tabs_close_mcp`. The server stored the exact string. 13 turns, 0 denials. |
| c2 | Harness asks for `type "Looks good to me"`, then `key "Return"`, then the correct text, then Cancel | `type` with the wrong text: **refused** (hook exit 2, "type text differs from the comment Slack Off asked for"). `key`: **refused** ("computer action \"key\" is not allowed"). Correct `type`: ran. Cancel: nothing saved. Both refusals are in `permission_denials`. |

Observed: `computer` inputs carry an extra `action_summary` field. `type` sends `{action, text}` and `left_click` sends `{action, ref}` (no `text`), so the existing "no modifiers" check on clicks is unaffected. The hook lets a correct `type` through **more than once**, so the post-run check "exactly one `type`, equal to the text" is required. It also cannot tell *which* field received the text.

## 6. Local-network and secret-read guard (controller ruling R-LOCAL)

Ports 4317, 5173 and 4399 (4399 stands in for the Tailscale listener; this Mac has no `100.x` address) were free. Throwaway Python listeners were bound to `0.0.0.0` on all three, so they were reachable both on loopback and on the LAN IP `192.168.20.42`, and were stopped afterwards. No Slack Off instance was running.

### 6.1 `SANDBOX_PROFILE`

```scheme
(version 1)
(allow default)
; Slack Off's own listeners (server, web dev server, Tailscale port): any host, so 127.0.0.1, ::1 and the Tailscale/LAN IP are all covered
(deny network-outbound
  (remote tcp "*:4317")
  (remote tcp "*:5173")
  (remote tcp "*:4399"))
; secrets and the platform's own data (all params are realpaths)
(deny file-read* file-write*
  (subpath (param "HOME_SSH"))        ; ~/.ssh
  (subpath (param "HOME_GH"))         ; ~/.config/gh
  (subpath (param "HOME_AWS"))        ; ~/.aws
  (literal (param "HOME_NPMRC"))      ; ~/.npmrc
  (literal (param "HOME_NETRC"))      ; ~/.netrc
  (subpath (param "HOME_KEYCHAINS"))  ; ~/Library/Keychains
  (subpath (param "CHROME_PROFILES")) ; ~/Library/Application Support/Google/Chrome
  (subpath (param "SLACKOFF_HOME"))
  (subpath (param "REPOS")))          ; one entry per mapped repo + worktree root in the product
```

In the product, the port lines come from the configured port, `5173` and the Tailscale port. SBPL only accepts `localhost` or `*` as the host, so a single remote IP cannot be targeted. `*:<port>` therefore also blocks that port on every outside host, which is acceptable here.

### 6.2 Evidence (stripped env `PATH HOME USER`)

| Check | Result |
|---|---|
| Node `connect` to 4317 / 5173 / 4399 on `127.0.0.1`, `::1`, `localhost`, LAN IP | all **EPERM** |
| same to `127.0.0.1:3100` (an app outside the deny list) | CONNECTED (other outbound traffic is allowed) |
| Target app `node server.mjs` **started inside the profile** listening on `127.0.0.1:3101`, with Playwright (inside the profile) testing it | listened, test passed |
| Chromium `page.goto` to `127.0.0.1:4317`, `localhost:5173`, `<LAN>:4399` | `net::ERR_ACCESS_DENIED` |
| Node `fetch` to the same | `EPERM` |
| Reads of `~/.ssh/known_hosts`, `~/.config/gh/hosts.yml`, `~/.npmrc`, `ls ~/.aws`, `ls ~/Library/Keychains`, Chrome `Local State`, `<SLACKOFF_HOME>/secret.txt`, `<repo>/server.mjs` | all **Operation not permitted** (control without the sandbox: readable). The exported copy `<work>/shop/server.mjs` is still readable. |
| `node -v`, `npm -v`, `pnpm -v`, `npm config get registry` | 24.21.0, 11.19.0, 12.6.0, default registry. npm silently ignores the unreadable `~/.npmrc`. |
| `pnpm install --offline` / `npm install --offline` of a `file:` dependency | ok |
| Outbound internet (package installs) | **not tested against a real host** (the spike's hard limit). Only the three ports are denied, and other outbound connections worked (`127.0.0.1:3100`). A user `~/.npmrc` with a private registry token (this Mac has one for `npm.pkg.github.com`) is **not** available inside, so private-registry installs will fail there. Run `install` outside the profile, or treat this as a known limitation. |
| `claude -p` under this profile | **Not logged in** (it needs `~/Library/Keychains`), which is why the shim is used (§4.2) |

### 6.3 `SANDBOX_SELF_CHECK`

`selfcheck.mjs <deniedFile> <port>...` connects to `127.0.0.1:<port>` for each port, opens the file, prints `4317:EPERM 5173:EPERM 4399:EPERM file:EPERM`, and exits 0 only if **every** result is `EPERM`. It does not depend on anything listening, because the sandbox denies the connect itself:
- inside the profile, with no listeners: `4317:EPERM 5173:EPERM 4399:EPERM file:EPERM`, exit 0
- outside the profile: `…:ECONNREFUSED … file:READABLE`, exit 1

Run it with the same `sandbox-exec -f <profile> -D …` line, and the same node, as the acceptance run, before every run. If it fails, the run is `not_executed` ("isolation check failed: sandbox self-check").

### 6.4 The agent's own Bash commands: PATH shim vs `CLAUDE_CODE_SHELL_PREFIX` (Task 5 follow-up, ruling T5-1)

Setup: claude 2.1.319, 4 real `claude -p --no-session-persistence` runs. Each used the platform's own implement-ticket argv (`ClaudeCodeExecutor` + `toolPolicy("implement-ticket", {commands: ["node probe.mjs"]})`, exact rule `Bash(node probe.mjs)`, `--restricted`) in a throwaway `SLACKOFF_HOME` under the scratchpad.

The declared command was `node probe.mjs`. It connects to `127.0.0.1:4317` (nothing was listening, so an unsandboxed run would get `ECONNREFUSED`) and reads a decoy `<home>/slackoff.db`.

| Run | Result |
|---|---|
| (a) PATH shim `<home>/shims/<KEY>/node` first on claude's PATH | `port4317=EPERM db=EPERM` |
| (a′) same, plus `ZDOTDIR=<scratch>` with a `.zshrc` that prepends the real node's directory (stands in for a user rc; `~/.zshrc` untouched) | `port4317=EPERM db=EPERM` |
| (b) `CLAUDE_CODE_SHELL_PREFIX=<wrapper>`, wrapper running `sandbox-exec … /bin/sh -c "$1"` | command failed (exit 2): the string is zsh/bash syntax and does not run under `/bin/sh` |
| (b′) same wrapper with `/bin/zsh -c "$1"` (and ZDOTDIR as in a′) | `port4317=EPERM db=EPERM` |
| shim inside the prefix sandbox (both at once; checked directly, not with claude) | `sandbox-exec: sandbox_apply: Operation not permitted`, exit 71: they cannot be combined |

**What the prefix receives** (logged by the wrapper): exactly **one** argument, a shell string:

`source ~/.claude/shell-snapshots/snapshot-zsh-….sh 2>/dev/null || true && { shopt -u extglob || setopt …; } … && eval 'cd <ticketDir>/api && node probe.mjs' < /dev/null && pwd -P >| /tmp/claude-<n>-cwd`

The wrapper itself runs with claude's environment (`PATH` as passed, `SHELL=/bin/zsh`).

**Conclusion (T5-1): the prefix, not the PATH shim.** (a) passed on this machine, but its PATH is whatever the CLI's shell snapshot exports (`export PATH=%q` in the binary), together with the aliases and functions the snapshot captures from the user's rc. Whether a shim stays first therefore depends on the user's shell configuration and CLI internals, so it is not a guarantee. Path-like commands (`./gradlew`) never go through it.

The prefix wraps the whole string, snapshot included, so every Bash command and everything it starts runs inside the profile. The snapshot (`~/.claude/…`) and the cwd file (`/tmp`) are outside the denied paths.

Because nesting fails, the shim is dropped and only the prefix is used. Implementation (Task 5): `writeShellPrefix`. Per command it:
- refuses anything but exactly one argument (126);
- runs the self-check under the same profile and node (if it fails: 126, nothing run);
- then runs `exec sandbox-exec <profile> <shell> -c "$1"`, where the shell is `$SHELL` if it is an absolute zsh/bash, otherwise `/bin/zsh`.

The executor passes it as `CLAUDE_CODE_SHELL_PREFIX` and never passes an inherited one on.

**Task 7 (acceptance `playwright` shim) must use the prefix too.** It has the same PATH-precedence weakness, the same nesting limit, and the same fact that `--restricted` + an exact Bash rule does not stop the snapshot from reordering PATH. Use an acceptance-scope wrapper (`acceptance` profile, no `allowInHome`) as the agent's `CLAUDE_CODE_SHELL_PREFIX`. Then `playwright test` and everything it starts run inside the profile, so `playwright` itself must **not** re-enter `sandbox-exec`. The platform's own re-run and `startTargets` keep using `sandboxArgv` directly.

The §8 recommendation "shim dir first on PATH, holds only `playwright`" is superseded. A plain `playwright` link or a wrapper on PATH is still fine for resolving the binary, but it is no longer the security boundary.

### 6.5 Profile changes from the Task 5 security review (fix round 1)

All of these are verified by real `sandbox-exec` probes in `test/local-sandbox.test.ts` and `test/development.test.ts`.

- **Signals.** `(deny signal) (allow signal (target same-sandbox))`. Without this, sandboxed code could send SIGUSR1 to an outside Node process, which opens its inspector on 9229 and lets the code run inside that process. Now `process.kill(<outside pid>, "SIGUSR1" | 0)` → EPERM, while a command can still signal its own children. Every platform Node process also starts with `--disable-sigusr1`: the root `start` and `dev:server` scripts, the e2e web server and the nav-guard hook.
- **Ports.** Ports 4317, 5173, 9229 and 9230 (`ports.ts` `DENIED_PORTS`) are denied both as `network-outbound (remote tcp "*:<p>")` and as `network-bind (local tcp "*:<p>")`. The self-check also requires `signal:EPERM` for a process outside the sandbox (signal 0: the server itself, or the wrapper's own shell).
- **Write allowlist for `dev-*` (ruling T5-3).** The profile has `(deny file-write*)`, then allows writes only to:
  - temp dirs: `/private/tmp`, the realpath of `$TMPDIR`, and its sibling `C`;
  - package caches: `~/.npm`, `~/.cache`, `~/Library/Caches`, `~/Library/pnpm`, `~/.local/share/pnpm`, `~/.yarn`, `~/.bun`;
  - `/dev/null`, `/dev/zero`, `/dev/tty` and `/dev/fd`;
  - after the credentials and SLACKOFF_HOME deny, the repo's own worktree(s) (`WRITE_i`).

  Last, `(deny file-write* GIT_i ~/.gitconfig ~/.config/git)` protects each repo's git common dir and the worktree's `.git` file. That rule has to come after the temp-dir allow, because repos and worktrees can live under `/tmp`.

  Verified under the new profiles: `npm install --offline` and `pnpm install --offline` of a `file:` dependency, `node`, and `playwright --version` all work. Writes to `~/.zshrc`, `~/<new file>`, the Slack Off checkout, another repo's worktree, `<common>/config` and the `.git` pointer file → EPERM. `git config core.fsmonitor …` → "could not lock config file … Operation not permitted".
- **Platform git (defence in depth).** Every `runGit` call adds `-c core.fsmonitor=false`. Diffing subcommands (`diff`, `log`, `show`) also get `--no-ext-diff --no-textconv`. `-c diff.external=` does **not** work for this: git then tries to run "" and fails.
- **More read-denied credentials:** `~/.git-credentials`, `~/.config/git/credentials`, `~/.gnupg`, `~/.docker/config.json`, `~/.kube`, and the Arc, Brave, Firefox and Edge profile dirs.

**For Task 7:** the acceptance profiles get the signal and port rules, but not the write allowlist yet (that task decides it). They already deny SLACKOFF_HOME and the mapped repos for both read and write.

### 6.6 Re-review fixes (Task 5 fix round 2, ruling T5-4)

All four profile kinds now also contain:
- `(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd.") (global-name "com.apple.launchservicesd") (global-name "com.apple.pasteboard.1"))`. Opening an app through LaunchServices runs it outside the sandbox. The pasteboard leaks data.
- `(deny appleevent-send)`.
- `(deny network-outbound (remote unix-socket (subpath (param "AGENT_SOCK_DIR"))) (remote unix-socket (subpath (param "HOME_GNUPG_SOCKETS"))))`. `AGENT_SOCK_DIR` is the parent of the realpath of `SSH_AUTH_SOCK` (a never-existing path when the variable is unset). This needs Unix-socket paths under the 104-byte limit to test, so the tests use `os.tmpdir()`, not the scratchpad.

The dev and install profiles also changed:
- **Write allowlist.** The global package caches and macOS's per-user `C` dir are removed. Writes go to the ticket's own cache `<home>/cache/<KEY>` instead. `npm_config_cache`, `npm_config_store_dir`, `XDG_CACHE_HOME`, `COREPACK_HOME`, `PLAYWRIGHT_BROWSERS_PATH`, `YARN_CACHE_FOLDER` and `BUN_INSTALL_CACHE_DIR` are all set there (`sandboxEnv`, also exported by the shell-prefix wrapper). npm prints `Unknown env config "store-dir"`; it is only a warning.
- **Final write deny.** It covers `<each temp dir>/xcrun_db` and `(prefix "/private/tmp/claude-")`. Consequence: a SLACKOFF_HOME or worktree under `/private/tmp/claude-*` cannot be written by sandboxed commands.

The platform's git is now an absolute path, resolved once: `xcrun -f git` when `/usr/bin/git` is the Command Line Tools shim, otherwise the realpath on PATH. On this Mac that is `/Library/Developer/CommandLineTools/usr/bin/git`.

Every sandboxed command, and the wrapper, drops `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GPG_AGENT_INFO` and `GNUPGHOME`. The self-check also runs `lsappinfo front`, which is read-only: it prints "ASN:…" when LaunchServices is reachable and "[ NULL ]" under the profile. The check requires the latter.

Evidence (macOS 15, real `sandbox-exec`):

| Probe | Result |
|---|---|
| `open -g -j <scratch SlackOffSbxProbe<pid>.app>` | dev-command and acceptance: exit 1, `kLSNoExecutableErr`, no marker; `lsregister -dump` afterwards shows no entry |
| node / git / pnpm / npm / playwright under the profile | all OK |
| `npm install --offline`, `pnpm install --offline` (`file:` dependency) with the ticket caches | exit 0 |
| `<TMPDIR>/xcrun_db` opened read-write | EPERM |
| Unix socket in the `SSH_AUTH_SOCK` dir / `~/.gnupg/S.gpg-agent` / elsewhere | EPERM / EPERM / OK |
| Writes to `~/.npm/<probe>` / `/private/tmp/claude-<probe>` / the ticket cache | EPERM / EPERM / OK |

A positive control for `open` (letting the scratch app launch) was deliberately not run (author's rule), so the `open` failure alone does not prove which rule stopped it. The `lsappinfo` difference does show that the service is unreachable. The pasteboard rule is verified by the profile text only: `pbcopy` / `pbpaste` were never run.

### 6.7 Local daemons on unix sockets and loopback ports (Task 5 fix round 3, ruling T5-6)

The re-review escaped the sandbox through daemons that run outside it and execute what they are sent: `tmux new-window` on the user's tmux server, and the Docker API. All profile kinds now treat unix sockets as deny-by-default, in this order (later rules win):
1. `(deny network-outbound (remote unix-socket))`
2. allow `MDNS_SOCKET` (`/private/var/run/mDNSResponder`, which DNS resolution needs: without it `dns.lookup("registry.npmjs.org")` → ENOTFOUND), the temp dirs, and the repo worktree(s) and ticket cache for `dev-*`
3. deny the daemon dirs: `(prefix "/private/tmp/tmux-")`, `(prefix "/private/tmp/claude-")`, `(prefix "/private/tmp/com.apple.launchd.")`, `~/Library/Group Containers`, `~/.docker`
4. `dev-*`: re-allow the worktree(s) and ticket cache (a SLACKOFF_HOME under `/private/tmp/claude-*`, T5-5)
5. deny the ssh agent's dir and `~/.gnupg` (last)

**Self-check.** It also connects to `/private/var/run/syslog`, a datagram socket outside every allowed dir. Outside the sandbox the result is EPROTOTYPE, inside it is EPERM. No message is ever sent, and no listener is needed.

The LaunchServices item now passes only on exactly `[ NULL ]`.

**TCP ports.** The ports denied for connect and listen now also include:
- Docker: 2375 and 2376
- an agent gateway seen on this machine: 18789–18792
- the JetBrains built-in server: 63342
- every port in the new config key `development.deniedLocalPorts`. It defaults to `[]`, at most 100 ports, and can only be changed on this computer.

Loopback TCP otherwise stays open for tests.

**pnpm store.** `pnpm_config_store_dir` replaces `npm_config_store_dir`, so npm no longer warns.

Evidence (real `sandbox-exec`, scratch servers only):

| Probe | Result |
|---|---|
| `tmux -S /private/tmp/tmux-sbxprobe-<pid>/s new-window "touch <marker>"` against a scratch tmux server | exit 1, `error connecting to … (Operation not permitted)`, no marker |
| Scratch sockets in `<fake home>/.docker` and `<fake home>/Library/Group Containers` | EPERM |
| A socket the command creates in its own worktree | OK |
| DNS lookup of `registry.npmjs.org` | OK |
| git / npm / pnpm / `node --test` | OK |
| `pnpm store path` (dev-install) | `<home>/cache/<KEY>/pnpm-store/v11`; `/private/tmp/.pnpm-store` not created |
| Scratch listeners on 2375, 2376, 63342 and a configured extra port | EPERM |
| Port 18789 | in use on this machine, so it was not probed; covered by the profile text only |
| Self-check | `… 2375:EPERM … 63342:EPERM file:EPERM unix:EPERM signal:EPERM launchservices:DENIED allowed:OK` |

**For Task 7.** Superseded by §6.8: the temp dirs are no longer in the unix-socket allow.

### 6.8 Unix sockets in the temp dirs (Task 5 fix round 4, ruling T5-7)

The re-review showed that allowing unix sockets in the temp dirs (`TMP_0` = `/private/tmp`, `TMP_1` = the user's `$TMPDIR`) re-opened every local daemon that listens there: VS Code's git askpass channel, Chrome's `SingletonSocket`, JetBrains, a SOCKS proxy at `/private/tmp/cc-socks`, OpenVPN and Loom. The reviewer reached one with a scratch daemon. The §6.7 deny list could never be complete, so the temp dirs are out of the allow.

**Unix-socket rules, all four profile kinds** (later rules win):
1. `(deny network-outbound (remote unix-socket))`
2. allow only `MDNS_SOCKET`, plus for `dev-*` the repo worktree(s) (`WRITE_*`) and `TICKET_CACHE`. Acceptance kinds: `MDNS_SOCKET` only.
3. the §6.7 daemon-dir denies, the `dev-*` re-allow of the ticket's own dirs, and the ssh / gpg agent denies last: unchanged.

File writes to `/private/tmp` and the user's `$TMPDIR` stay allowed for `dev-*`; only socket connects changed.

**The command's own temp dir.** Every sandboxed `dev-*` command (`runCommand`, and the agent's shell-prefix wrapper) gets `TMPDIR`, `TMP` and `TEMP` = `<home>/cache/<KEY>/tmp`, inside the ticket cache, which is in the socket allow. `sandboxEnv` creates it (mode 0700) before the run; the wrapper also runs `mkdir -p` before every command. Under the default home the path is `~/.slackoff/cache/<KEY>/tmp` (for a four-letter user name, `/Users/<you>`, and `PROJ-12345`: 42 bytes), so a socket in it stays under the 104-byte `sun_path` limit. A test checks this with tsx's pipe, a VS Code-style IPC socket and Chromium's `SingletonSocket`.

**Self-check.** New option `--unix-scratch <dir>`, passed once for each temp dir (except under `/private/tmp/claude-*`, which a dev command cannot write). For each dir the check runs inside the sandbox and:
- makes `slackoff-sc-XXXXXX/s` there and listens on it,
- connects to it, which must give `EPERM`,
- closes the socket and removes the dir in `finally`.

A setup failure (`SETUP_<code>`), `CONNECTED` or any other result fails the check. Detail: `… unix:EPERM unixtmp0:EPERM unixtmp1:EPERM signal:EPERM …`. Run outside the sandbox it reports `unixtmp0:CONNECTED` and exits 1.

Evidence (real `sandbox-exec`, scratch servers in scratch dirs only, all removed):

| Probe | Result |
|---|---|
| A scratch daemon at `/private/tmp/t57-XXXXXX/d.sock` and one at `$TMPDIR/t57-XXXXXX/d.sock`, outside the sandbox (control) | both connect |
| The same two from `dev-command`, `dev-install`, `acceptance` and `acceptance-install` | `EPERM` / `EPERM` in all four |
| A socket the command makes in `os.tmpdir()` (= the ticket tmp dir) and in its worktree, `dev-command` and `dev-install` | OK / OK |
| A socket in a `$TMPDIR` scratch dir (the old "other" case in the T5-4 agent test) | `EPERM` (was OK) |
| DNS lookup of `registry.npmjs.org` (`dev-install`) | OK |
| `git status` in a linked worktree, `npm install --offline` and `pnpm install --offline` of a `file:` dependency, `node --test` against it | all exit 0; `pnpm store path` is in `<home>/cache/K/pnpm-store` |
| Self-check, `dev-command` and `acceptance` | `ok`, `unixtmp0:EPERM unixtmp1:EPERM`, no `slackoff-sc-*` left behind |

**For Task 7 (replaces the §6.7 note).** Acceptance profiles now allow no unix socket except DNS, so Chromium's `SingletonSocket` in `$TMPDIR` is refused. `sandboxEnv` leaves an acceptance command's `TMPDIR` alone: acceptance has no ticket key in its scope, and SLACKOFF_HOME is denied to it. Task 7 must give the browser a TMPDIR of its own, outside SLACKOFF_HOME, and add that dir to the acceptance socket allow. Do not reopen the temp dirs.

### 6.9 No moving a daemon's socket out of the temp dirs (Task 5 fix round 5, ruling T5-8)

The re-review found that the dev profiles still let a command write to `/private/tmp` and `$TMPDIR`. So `mv $TMPDIR/x/s <worktree>/s`, or moving the whole directory, followed by a connect reached the daemon through the own-dirs socket allow. Hard links and symlinks were already refused.

**Rule.** The dev kinds add `(deny file-write-unlink (subpath (param "TMP_0")) (subpath (param "TMP_1")))` right after the temp-dir write allow and before the re-allow of the platform's own dirs. A rename needs unlink on its source, so it is refused too. The temp-dir write allow stays, because pnpm 12's store-operation lock needs it.

The acceptance kinds get no such rule. They have no own dir in the socket allow, so there is nothing to move a socket into. (Superseded by §6.10 and §6.11: the acceptance kinds now have an own socket dir, and deny unlink everywhere.)

**SBPL precedence (measured).** A rule for one specific operation beats a `file-write*` rule, whatever their order. In a scratch profile, `deny file-write-unlink X` followed by `allow file-write* X/sub` still refused `rm X/sub/f`. And `allow file-write-unlink X/sub` followed by `deny file-write* X/sub/g` still let `rm X/sub/g` through. So "later rules win" holds only between rules of the same kind. The profile therefore:
- re-allows `file-write-unlink` explicitly for `WRITE_*` and `TICKET_CACHE`, right after their `file-write*` allows. A SLACKOFF_HOME under a temp dir (tests, `/private/tmp/claude-*`) keeps `rm` and `mv` working;
- repeats the git-metadata, git-config and `xcrun_db` denies as `file-write-unlink` denies after that. A test checks that the worktree's `.git` file and the git common dir cannot be renamed.

**Self-check.** The caller now makes the `--unix-scratch` dirs and removes them after the check:
- They are named `slackoff-sc-<pid>-XXXXXX`, from the server's pid or the wrapper's `$$`.
- The dev sandbox cannot unlink anything in a temp dir, so the check itself cannot remove them.
- The wrapper creates them with `mktemp -d`, removes them after the check, and also removes them from a `HUP`/`INT`/`TERM` trap.
- Before each check, `sandboxSelfCheck` sweeps away scratch dirs whose maker pid no longer exists. This covers a wrapper killed with SIGKILL mid-check.

For dev kinds the check also gets `--own <ticket tmp dir>`. After the connect probe it renames the scratch socket into that dir, which must give `EPERM` (`unixmvN:EPERM`). If the move succeeds (`MOVED`), the check removes the moved socket and fails.

Evidence (real `sandbox-exec`, scratch daemons in scratch dirs only, all removed):

| Probe | Result |
|---|---|
| `rename` of a scratch daemon's socket from `/private/tmp/t57-*` and from `$TMPDIR/t57-*` into the worktree, `dev-command` and `dev-install` | `EPERM` at the rename |
| `rename` of the daemon's whole scratch dir into the worktree | `EPERM` |
| Write, rename, `rm -r` and a listening socket in the worktree, the ticket cache and the ticket TMPDIR | all OK |
| Renaming the worktree's `.git` file and the git common dir's `HEAD` | `EPERM` |
| A SLACKOFF_HOME under `/private/tmp/claude-*`: rename and remove in the worktree and the ticket cache | OK |
| The §6.8 run: DNS, `git status`, offline `npm` and `pnpm` installs, `node --test` | still exit 0 |
| Self-check, `dev-install` | `… unixtmp0:EPERM unixmv0:EPERM unixtmp1:EPERM unixmv1:EPERM …`, `ok` |
| The same check under a profile without the T5-8 rule | `unixmv0:MOVED`, exit 1, the moved socket removed |

### 6.10 The acceptance run's own temp dir (Task 6, ruling T6-1)

§6.8 left the acceptance kinds with no unix socket except DNS, so a browser or test runner that puts a socket in its
`TMPDIR` would be refused. Each acceptance run now has its own temp dir, `<runRoot>/tmp`, and the acceptance kinds get
a new optional scope field `runRoot` (params `RUN_ROOT` and `RUN_TMP`).

**Rules, acceptance kinds** (dev kinds unchanged):
1. Unix sockets: allow `MDNS_SOCKET` and `(subpath RUN_TMP)`; the §6.7 daemon-dir denies; `RUN_TMP` re-allowed after
   them (a run root under `/private/tmp/claude-*`, the T5-5 pattern); the ssh / gpg agent denies last.
2. T5-8 for acceptance: `(deny file-write-unlink TMP_0 TMP_1)`, with or without a run root. With a run root, after the
   credential / SLACKOFF_HOME / repo deny: `(allow file-read* file-write* RUN_TMP)`, `(allow file-write-unlink RUN_ROOT)`,
   then the same deny list again as `(deny file-write-unlink …)` (an operation-specific allow beats a `file-write*`
   deny whatever the order, §6.9).
3. `checkScope` refuses a run root that is relative, `/`, or is / lies in / contains SLACKOFF_HOME, a mapped repo or a
   credential path, and a run root on a dev scope.
4. `sandboxEnv` sets `TMPDIR`, `TMP` and `TEMP` to `<runRoot>/tmp` (created 0700) for an acceptance scope with a run
   root. The shim exports them before its `exec`; `targetEnv` sets them for the target's install / start / stop (the
   platform's value wins over the server's `TMPDIR` and the rule file's `acceptance.env`).
5. The self-check gets `--own <runRoot>/tmp` for an acceptance scope with a run root: moving its scratch socket there
   must be `EPERM` (`unixmvN:EPERM`).

**sun_path.** macOS's per-user temp dir is `/private/var/folders/xx/…/T` (56 bytes as a realpath), so
`<tmpdir>/slackoff-accept-XXXXXX/tmp/.org.chromium.Chromium.XXXXXX/SingletonSocket` would be 129 bytes, and no
`mkdtemp` prefix makes it fit (even an empty one leaves 112). `acceptRunBase()` therefore uses the real temp dir only when
that path fits in 103 bytes (+ NUL), and the real `/tmp` otherwise: `/private/tmp/slackoff-accept-XXXXXX/…/SingletonSocket`
is 85 bytes. `prepareRunDirs` still refuses a `tmpdir()` inside SLACKOFF_HOME or a repo, whichever base is used.

**What Chromium needs (measured).** Playwright 1.64.1's `chromium` project starts the headless shell
(`chromium_headless_shell-1248`). Under the acceptance profile, with and without the run root, the fixture spec passed;
after a run with `TMPDIR=<runRoot>/tmp` the dir held only `playwright-transform-cache-501/` and the per-run
`playwright_chromiumdev_profile-*` (removed by Playwright). The headless shell creates no `SingletonSocket`, so **no
allow beyond T6-1 was needed** and none was added. Full Chromium (`channel: 'chromium'`, "Google Chrome for Testing.app")
aborts at launch under the profile (`SIGABRT`, `kill EPERM` in Playwright's log), with or without the run root; the
scaffold never sets a channel, so this was not pursued (Task 7: keep it that way).

Evidence (real `sandbox-exec`, scratch daemons and scratch dirs only, all removed):

| Probe | Result |
|---|---|
| Scratch daemons at `/private/tmp/t57-*/d.sock` and `$TMPDIR/t57-*/d.sock`, outside the sandbox (control) | both connect |
| The same from `acceptance` and `acceptance-install` with a run root | `EPERM` / `EPERM` |
| A socket the command makes in `os.tmpdir()` (= `<runRoot>/tmp`), both kinds | OK |
| `rename` of each daemon's socket into `<runRoot>/tmp` and into `<runRoot>`, and of its dir into `<runRoot>/tmp`; run roots under `/private/tmp` and under `$TMPDIR`, both kinds | `EPERM` at every rename |
| Write, rename, `mkdir -p` and `rm -r` inside the run root (both bases) | OK |
| Self-check, `acceptance` and `acceptance-install` with a run root | `… unixtmp0:EPERM unixmv0:EPERM unixtmp1:EPERM unixmv1:EPERM …`, `ok`, nothing left in `<runRoot>/tmp` |
| Shim `playwright test` (fixture app outside the sandbox on a scratch port): spec reading `<SLACKOFF_HOME>/slackoff.db` | fails, `EPERM` |
| Same run: spec connecting to `127.0.0.1:4317` | fails, `EPERM` (refused by the sandbox; nothing was reached) |
| Same run: spec against the fixture app (heading, button) | passed; `process.env.TMPDIR` in the spec = `<runRoot>/tmp` |
| Target app started by `startTargets` (acceptance sandbox, `targetEnv`) | `/env` has no `SLACKOFF_HOME` / `GH_TOKEN` (set in the server's env by the test); reading `<SLACKOFF_HOME>/slackoff.db` → `EPERM`; its install saw `TMPDIR=<runRoot>/tmp` |
| `ps -A -E -ww -o pgid=,command=` on a sandboxed target app | its environment (`SLACKOFF_RUN_ROOT=…`) is visible, so `killLeftovers` recognises it |

**`ps` on macOS (for `killLeftovers`).** `ps -g <pgid>` lists only the group *leader*, and the BSD `e` modifier prints no
environment together with `-o command=`; `ps -A -E -ww -o pgid=,command=` lists every process with its group and
environment. Apple platform binaries (`/bin/sh`, `sleep`) show no environment there, Node and other user binaries do,
so the target app's own process (Node here) carries the mark. The run root must match as a whole path (followed by `/`,
whitespace or the end), so `<runRoot>0` is not taken for `<runRoot>`.

### 6.11 Acceptance profile hardening (Task 6 fix round 1, rulings T6-2 to T6-6)

The Task 6 review escaped the §6.10 profile twice (both probed): spec code rewrote `<runRoot>/bin/playwright`, which
the platform runs outside the sandbox (C1), and a daemon socket outside the temp dirs (`/private/var/tmp/x/d.sock`;
in real life `~/.colima`, `~/.orbstack`, `~/.rd`, Docker Desktop) was renamed into `<runRoot>/tmp` and reached (C2).
The acceptance kinds also had no write allowlist (C3) and could read Claude Code's transcripts and config, which hold
the design and debate (C4).

**Profile, acceptance kinds** (every acceptance scope now requires `runRoot`; new params `SHIM_DIR`, `SHIM`,
`HOME_CLAUDE`, `ACCEPT_CLAUDE_CONFIG` (scope `acceptConfigDir`), `SERVER_CLAUDE_CONFIG` (the server's `CLAUDE_CONFIG_DIR`);
a path that never exists stands in for one that is not configured):
1. `(deny file-write*)`, then `(allow file-write* RUN_ROOT DEV_NULL DEV_ZERO DEV_TTY DEV_FD)`: writes only in the run
   root (work, tmp, per-run caches) and `/dev`.
2. `(deny file-write-unlink)`: no unlink, so no rename, from anywhere (replaces the T6-1 temp-dir-only rule).
3. The credential / SLACKOFF_HOME / repo deny (unchanged), then
   `(deny file-read* file-write* (prefix HOME_CLAUDE) ACCEPT_CLAUDE_CONFIG SERVER_CLAUDE_CONFIG (prefix CLAUDE_TMP))` —
   `~/.claude`, `~/.claude.json` and their backups, both config dirs, every `/private/tmp/claude-*`.
4. `(allow file-read* file-write* RUN_ROOT)` again (T5-5: a run root under `/private/tmp/claude-*`), and
   `(allow file-write-unlink RUN_ROOT)`.
5. `(deny file-write* SHIM_DIR (literal SHIM))`, then `(deny file-write-unlink SHIM_DIR (literal SHIM) (literal RUN_ROOT))`
   (the run root itself cannot be moved away and replaced), then every deny of 3 again as `file-write-unlink`
   (an operation-specific allow beats `file-write*`, §6.9).

`checkScope` also refuses a run root overlapping `~/.claude` or either config dir. `sandboxEnv` points npm, pnpm, yarn,
bun, corepack and XDG caches at `<runRoot>/cache/*` (not `PLAYWRIGHT_BROWSERS_PATH`: the browsers stay in Playwright's
own install, read only).

**Self-check, acceptance kinds.** The sandbox cannot create a socket outside its run root any more, so the caller
(`sandboxSelfCheck`) listens on `<scratch>/s` in each temp dir and in `/private/var/tmp` (new: a non-temp dir no rule
names) and passes `--unix-peer` for each: connecting must be `EPERM` (`unixtmpN`), moving it into `<runRoot>/tmp` must
be `EPERM` (`unixmvN`). New items: `--no-write <dir>` for each scratch dir and the shim dir (`nowriteN:EPERM`), and
`--denied-read <acceptance config dir>` (`deniedread0:EPERM`). Dev kinds and the dev wrapper are unchanged. **For
Task 7:** the acceptance shell-prefix wrapper cannot reuse the dev wrapper's shell-only check (the sandboxed check
cannot listen there); it has to run `sandboxSelfCheck` (or the same host-listens pattern) before each command.

**The shim (T6-3, I2).** No nested `sandbox-exec` any more (sandboxes cannot be nested, §4.2, T5-2): the agent's Bash runs
inside the acceptance wrapper and the platform re-run under `sandboxArgv`. The shim only accepts exactly `test`, `cd`s to
the acceptance dir and runs `exec /usr/bin/env -i PATH=<node dir>:/usr/bin:/bin HOME USER [LANG] TMPDIR TMP TEMP=<runRoot>/tmp <repoRoot>/node_modules/.bin/playwright test`.

**Export (T6-6, I1).** `git archive` applied `export-subst` (`$Format:%B$` put commit messages, i.e. design text, in the
export) and `export-ignore` from the exported branch. The export is now `git ls-tree -r -z --full-tree <sha>` plus
`git cat-file --batch` (stdin and stdout are files in the run root: `runProcess` gained `stdinFile` / `stdoutFile`, still no
pipe), written blob by blob: bytes identical, mode 100755 → 0755, 120000 → symlink (made last, so no file is written
through a link), a submodule → empty dir, `.git` / `..` path components refused. It returns each file's blob id, so the
no-db check exempts committed database fixtures whose content still hashes to that blob (T6-5).

Evidence (real `sandbox-exec`, fake user home, scratch daemons and dirs only, all removed):

| Probe | Result |
|---|---|
| Append to `~/.gitconfig`, `mkdir ~/Library/LaunchAgents/x` (fake home), write in a `/private/tmp`, `/private/var/tmp` and `$TMPDIR` scratch dir | `EPERM` each, both kinds |
| Write, chmod, rename or remove `bin/playwright`; add a file to `bin/`; rename `bin/`; rename the run root | `EPERM` each; the shim unchanged |
| Write, rename, remove in `work/`; write in `tmp/`; `mkdir cache/npm/x`; append `/dev/null` | OK |
| A scratch daemon at `/private/var/tmp/t57-*/d.sock` (control: connects outside the sandbox) | rename of the socket or its dir into `<runRoot>/tmp` `EPERM`; hard link `EPERM`; a symlink can be made but connecting through it is `EPERM`; direct connect `EPERM` |
| Read `~/.claude/projects/p/s.jsonl`, `~/.claude.json` (fake home), the server's `CLAUDE_CONFIG_DIR`, list the acceptance config dir, read a file in a `/private/tmp/claude-*` scratch dir | `EPERM` each |
| Self-check, both kinds | `… unixtmp0..2:EPERM unixmv0..2:EPERM nowrite0..3:EPERM deniedread0:EPERM …`, `ok`, nothing left in `tmp/` or `bin/` |
| Shim run through `sandboxArgv(acceptance)` with `GH_TOKEN`, `NPM_TOKEN`, `AWS_*`, `SLACKOFF_HOME`, `CLAUDE_CONFIG_DIR` in the caller's env | none in the spec's env; DB read and 4317 `EPERM`; a spec rewriting / renaming / chmodding / removing the shim `EPERM`; the fixture-app spec passes (Chromium headless shell runs with only the run root writable) |
| `.gitattributes` `v.txt export-subst`, `hidden.md export-ignore`; commit message containing a design line | `v.txt` byte-identical to its blob, `hidden.md` exported, a 300 KB binary, a symlink, a 0755 script and a path with spaces / non-ASCII exported exactly |

### 6.12 Final fix pass (rulings F-3, F-4)

**Keychain daemons (F-3).** The keychain files were denied, but the daemons that serve them were reachable through
`mach-lookup`. Every kind now has, right after the LaunchServices deny:
`(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name-prefix "com.apple.securityd.") (global-name-prefix "com.apple.security.agent") …KeychainStasher, kcsharing, octagon, cloudkeychainproxy3, keychainsharingmessagingd)`.
The names come from the `MachServices` keys of `/System/Library/Launch{Daemons,Agents}/*.plist` (read only).
`com.apple.trustd` (certificate trust for TLS), `com.apple.security.syspolicy*` and `com.apple.security.translocation`
are not denied. Not probed at run time: every client of securityd is a keychain client, so a probe would read or
change keychain contents. `profileDeniesKeychain` checks the profile text instead (the line is present, names both
daemons, no later `allow mach-lookup`); `sandboxSelfCheck` fails without it and reports
`keychain:DENIED-IN-PROFILE (runtime not probed)`. Existing runs still pass under the profile: git, offline npm / pnpm
installs, `node --test`, and Playwright's Chromium (it runs with `--use-mock-keychain`).

**`~/.claude.json` for dev kinds (F-4 M-2).** `(deny file-read* file-write* (prefix HOME_CLAUDE_JSON) (prefix HOME_CLAUDE_JSON_NAME))`
next to the `claude-*` deny: the resolved path and the name as given (parent resolved only), so the backups and a
symlinked `~/.claude.json` are covered. `~/.claude` stays readable for development commands.

**The Tailscale listener (F-4 M-3).** The profile already denies every host on 4317. The scope now carries the IP the
server listens on (`remoteHosts`, from `main.ts`, read at each check; it must be in 100.64.0.0/10), and the self-check
connects to `<ip>:4317` (`remote0:<ip>:4317:EPERM`). The sandbox refuses the `connect` before any packet, so the live
check sends nothing. Tests never probe a real address: they assert the arguments, and run the unsandboxed check
against their own loopback listener (`CONNECTED` → fail).

## 7. push and `gh` (step 6, local bare origin only)

Command: `git push -u --no-follow-tags --recurse-submodules=no origin refs/heads/<b>:refs/heads/<b>`, run in the worktree, stdin `/dev/null`, `GIT_TERMINAL_PROMPT=0`.

| Case | Result |
|---|---|
| First push | `* [new branch]`, exit 0, upstream set |
| Second push, no change | `Everything up-to-date`, exit 0 |
| Remote advanced by another clone, local also has a new commit | `! [rejected] … (fetch first)`, exit 1, nothing forced. Detection without fetching: the remote sha from `ls-remote` is missing locally, so `git cat-file -e` fails, which means it is not an ancestor. After a fetch, `merge-base --is-ancestor <remote> HEAD` → 1. |
| `push.followTags=true` + `remote.origin.push=refs/heads/*:refs/heads/*`, with a local annotated tag on HEAD and an extra local branch | only `<b>` was updated. The remote has no tags and no other branches. |
| pre-push hook (shared `.git/hooks`, worktree push), exit 0 | ran. Args: `origin <url>`. **stdin carries git's ref lines** (`refs/heads/<b> <sha> refs/heads/<b> <sha>`); our `/dev/null` does not reach the hook. |
| pre-push hook exit 1 | `error: failed to push some refs`, exit 1, remote unchanged |
| `url."file://<scratch>/repos/".insteadOf https://github.com/example-org/` with `origin = https://github.com/example-org/shop.git` | `git config --get remote.origin.url` → `https://github.com/example-org/shop.git` (not expanded). `git remote get-url` → the expanded `file://` URL. `ls-remote` and `push` went to the bare repo. |

**gh 2.79.0 flags (from `--help`):**
- `pr create`: `-B/--base`, `-H/--head`, `-t/--title`, `-b/--body`, `-F/--body-file`, `-d/--draft`, `--dry-run` ("may still push git changes"), `-f/--fill*`, `-r/--reviewer`, `-l/--label`, `-a/--assignee`, `-w/--web`, `-e/--editor`, `--no-maintainer-edit`.
- `pr list`: `-H/--head` ("`<owner>:<branch>` syntax not supported"), `-B/--base`, `-s/--state {open|closed|merged|all}`, `--json fields`, `-q/--jq`, `-L/--limit`.
- `pr edit <n>`: `-b/--body`, `-F/--body-file`, `-t/--title`, `-B/--base`, plus label, reviewer and assignee flags.
- `auth status`: `-h/--hostname`, `-a/--active`, `-t/--show-token` (never pass). **No `--json`**: use the exit code.
- All of them inherit `-R/--repo [HOST/]OWNER/REPO`.

**Fake `gh` with `execFile`** (`env = {PATH, HOME, GH_PROMPT_DISABLED=1, GH_NO_UPDATE_NOTIFIER=1, NO_COLOR=1}`). The argv arrived exactly as passed, with no shell expansion (a body file containing `` `code` ``, `$(touch /tmp/never)` and `@someone` left nothing behind):
- `["auth","status","--hostname","github.com"]`
- `["pr","list","--repo","github.com/example-org/shop","--head","slackoff/T-1-x","--base","main","--state","open","--json","number,url,state,headRefName,baseRefName"]`
- `["pr","create","--repo",R,"--base","main","--head","slackoff/T-1-x","--title",T,"--body-file",<file>]`
- `["pr","edit","7","--repo",R,"--body-file",<file>]`

**Finding:** plain `execFile` leaves stdin as an open pipe. The fake `gh` read stdin and **hung** until it was killed. Keep stdin closed (`runProcess` already does this) and pass the body with `--body-file`.

## 8. Recommendations for later tasks

**Task 5 (run dirs / isolation)**
- `'dedicated'` config dir. Pass `--no-session-persistence` on every run, then delete `ACCEPT_CONFIG_PURGE` afterwards. The isolation check must allow only the CLI's own files in the config dir.
- Child env = exactly `PATH, HOME, USER, CLAUDE_CONFIG_DIR`. `PATH` = `<shimDir>:<node bin dir>:/usr/bin:/bin`. The shim dir is platform-owned, outside `workDir`, and holds only `playwright`. Do **not** put `<repoRoot>/node_modules/.bin` on the agent's PATH. The shim calls that playwright by absolute path.
- Export: run `git archive` and expect empty directories left by `export-ignore`. Exclude design/debate text by content (the `excludeDesignQuotes` step), not by trusting `.gitattributes`.
- Use `realpath` for every sandbox param (`/tmp` → `/private/tmp`).

**Task 6 (sandbox / runAgent)**
- Replace the planned `wrap = sandbox-exec … claude` with the shim. Wrapping `claude` with the full profile breaks the login. Wrapping it with a profile without Keychains works, but then the shim cannot be used (nested `sandbox_apply` fails). If the controller prefers the wrap, drop `HOME_KEYCHAINS` from the claude profile and accept that spec code can read keychain *files*.
- Path deny rules for `playwright.config.mjs`, `node_modules/**` and each exported repo (as planned). The config could otherwise add `globalSetup` / `webServer`. Those would still run inside the profile, but the platform owns that file.
- Keep the spec-scan hook as defense in depth only: a 3-line dodge got past it (§4.2).
- Run `SANDBOX_SELF_CHECK` before the agent starts. Run the platform's own `playwright test` rerun, and `startTargets`, under the same profile (verified: the app listens and the browser reaches it).

**Task 7 (report parsing)**
- Map evidence from `results[].attachments`. `page.screenshot({path})` files are not listed there. Either tell the agent to `testInfo.attach(name, {path})`, or collect `evidence/*` by AC-id file names.

**Task 9 (jira-comment)**
- Guard: `type` allowed only when its text equals the given text (verified). Rename the guard's message prefix from "Navigation blocked" to something neutral. After the run, check exactly one `type` with that text, plus the URL scan from phase 2.
- `JIRA_COMMENT_MULTILINE = true` (the mock's contenteditable takes `\n` from one `type`). Real JIRA's editor may turn `- ` into a list or URLs into links, so normalize both sides before verifying (manual check 2).

**Task 10 (push / PR)**
- Divergence check without fetching: `ls-remote` sha → `git cat-file -e <sha>^{commit}` + `merge-base --is-ancestor <sha> HEAD`. If the sha is missing or not an ancestor → `blocked`.
- Repo identity: `git config --get remote.origin.url` (verified not expanded).
- `gh`: run `gh auth status --hostname <host>` (exit code). Then `gh pr list --repo <host/owner/name> --head <b> --base <base> --state open --json number,url,state,headRefName,baseRefName`. Then `gh pr create … --body-file <file in runRoot>`, then `gh pr edit <n> --repo … --body-file …`. stdin closed, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`. Never `--fill`, `--web`, `--editor` or `--dry-run` (it can push).
- `-u` writes `branch.<b>.remote/merge` into the user's repo config. This is harmless, but the user can see it.

## 9. Manual checks for the author (for the Task 16 exit document)

1. **Dedicated config login.** Run `CLAUDE_CONFIG_DIR=~/.slackoff-acceptance/claude-config claude /login` once. Then `env -i PATH=… HOME=$HOME USER=$USER CLAUDE_CONFIG_DIR=… claude -p 'Reply with exactly: OK' --no-session-persistence --output-format json` should give `OK` with `apiKeySource: none`. Delete the `ACCEPT_CONFIG_PURGE` folders and repeat: it should still give `OK`. Note the keychain item name that appeared (expect a second `Claude Code-credentials…` entry).
2. **Real JIRA comment.** On a test ticket (only one browser connected, or `jira.browser` set), send a multi-line comment containing a URL and a `- ` line. The raw log should show exactly one `type`, equal to the text, and only `<jira>/browse/<KEY>`. The read-back check should pass after normalization (link and list rendering). Send it again: expect `not_needed`.
3. **Real GitHub test repo.** On a throwaway repo, run first push → PR created (base = mapped base, head = `slackoff/…`, no reviewers or labels, body says the evidence is in Slack Off) → deliver again (expect "already pushed" and the existing PR reused) → push a commit to the branch from the web UI and deliver (expect `blocked` "remote branch … has commits …", no force) → `gh auth logout` (expect it blocked at preview). Check that `@someone` / `fixes #12` from the AC text appear neutralized in the PR body.

## Concerns / not verified

1. **Plan deviation:** the plan (Task 6, line ~303) wraps `claude` in `sandbox-exec`. The evidence supports the shim instead (§4.2). The controller should rule on this before Task 6.
2. The dedicated config dir login and purge are not verified (manual check 1). If the login is lost after a purge, purge less (keep everything except `projects`/`sessions`/`todos`/`shell-snapshots`).
3. With the shim, the `claude` process itself is not OS-sandboxed. It is confined only by `--restricted` and the exact Bash rule, and read-only shell commands are auto-approved inside the working dirs only (phase 2). The `claude` process and anything it runs outside `playwright` can still reach port 4317 (it never gets a tool that could, since `curl` and `WebFetch` are denied).
4. `export-ignore` is controlled by the branch being exported. A dev agent could hide or un-hide files through `.gitattributes`. Content-based exclusion is still needed.
5. `sandbox-exec` is deprecated by Apple, although it works on 15.6.1. Pre-existing hard links to secrets outside the denied paths are readable. Outbound internet from inside the profile was not exercised against a real host, and private-registry installs lose `~/.npmrc`.
6. `launchPersistentContext` was tested only on a decoy directory under the fake `SLACKOFF_HOME`. The real Chrome profile directory is in the deny list (its `Local State` read was refused), but the persistent-context call on it was deliberately not run.
7. Step 8 of the brief (back-filling these values into Tasks 5/6/7/9/10 of the plan) was **not done**. Per the dispatch, only this document is committed. The controller should carry the values over, including the shim change.
8. Only a static mock JIRA editor was used. Real JIRA (ProseMirror) may handle `\n` from `type` differently (manual check 2).
