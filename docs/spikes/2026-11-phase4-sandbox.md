# Spike: hook wrapper, git-dir write rules, loopback allowlist SBPL (phase 4a, Task 1)

Date: 2026-11-07 · macOS 15.6.1 (Darwin 24.6.0) · git 2.39.5 (Apple Git-154, the `/usr/bin/git` shim) · Node 25.6.1 for the network probes (no Node 26 on the probing machine; the probes use only `node:net`).

These were throwaway experiments, and the raw logs are not committed. Everything ran in a scratch dir `<S>` under `$TMPDIR`: a repo `<S>/repo` with a linked worktree `<S>/wt` on branch `feat`, a local bare `origin`, a fake `HOME`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. Below, `<common>` = `<S>/repo/.git` and `<admin>` = `<common>/worktrees/wt`. The network probes used two scratch listeners on free ports `P1` / `P2`, bound dual-stack on `::`, which were stopped afterwards. No Slack Off instance, real daemon or real port was contacted. The probing machine has no Tailscale address, so a VPN `utun` address of the same machine stood in for it.

Denied paths were read from the kernel's sandbox violation reports: `log show --predicate 'sender == "Sandbox"'`, filtered to `<S>`, which is read-only. Other test runs on the same machine were reporting at the same time, so the filter on `<S>` is necessary.

## Decided values

| Name | Value | Basis |
|---|---|---|
| `HOOK_GIT_WRITES` | allow (file-write\* **and** file-write-unlink): `(subpath <common>/objects)`, `(subpath <common>/refs)`, `(subpath <common>/logs)`, `(literal <common>/packed-refs)`, `(literal <common>/packed-refs.lock)`, `(subpath <admin>)`. Then deny (file-write\* **and** file-write-unlink): `<admin>/commondir`, `<admin>/gitdir`, `<admin>/config.worktree`, `<worktree>/.git`, plus unlink of `(literal <admin>)` itself. Anything else in `<common>` (config, hooks/, info/, HEAD, gc.pid, new root files) stays under the profile's `(deny file-write*)`. | §1 |
| `HOOK_ENV_KEEP` | every `GIT_*` variable in the wrapper's environment, passed as is. The platform's `gitEnv` strips inherited `GIT_*`, so each one there was set by git or by the platform: `GIT_DIR`, `GIT_INDEX_FILE`, `GIT_PREFIX`, `GIT_EDITOR`, `GIT_AUTHOR_DATE`, `GIT_EXEC_PATH`, `GIT_CONFIG_PARAMETERS`, the identity and `GIT_CONFIG_*` variables, `GIT_TERMINAL_PROMPT`. Everything else is kept too (PATH, HOME, LANG…; `TMPDIR`/`TMP`/`TEMP` and the cache variables come from `sandboxEnv(hookScope)`). **Removed:** `AGENT_ENV` (`SSH_AUTH_SOCK SSH_AGENT_PID GPG_AGENT_INFO GNUPGHOME`), every `ANTHROPIC_*`, `GH_TOKEN`, `GITHUB_TOKEN`. | §2 |
| `HOOK_STDIN` | `exec sandbox-exec … <hook> "$@"` passes stdin through untouched. A pre-push hook received 1001 ref lines (125,900 bytes, about twice a pipe buffer) byte-identical to the expected list. commit-msg gets one argument, the absolute path `<admin>/COMMIT_EDITMSG`, which is writable under `HOOK_GIT_WRITES` (an append went into the commit). | §2 |
| `LOOPBACK_ALLOWLIST_SBPL` | `(deny network-outbound (remote tcp6 "*:*"))` `(deny network-outbound (remote tcp4 "localhost:*"))` `(allow network-outbound (remote tcp4 "localhost:<p>") (remote tcp6 "localhost:<p>"))` for each allowed port, then the existing `(deny network-outbound (remote tcp "*:<denied>"))` lines **after** the allows. Use explicit `tcp4` / `tcp6` filters only: `(remote tcp "localhost:*")` misses IPv4-mapped IPv6 (`::ffff:127.0.0.1`), and it stops matching IPv4 when a `tcp6 "*:*"` rule is present. In SBPL, `localhost` matches every address of this machine (127.0.0.1, ::1, the LAN IP, a `utun` VPN address, global IPv6), so Tailscale needs no rule of its own. `127.0.0.2` is not matched. | §3 |
| `LOOPBACK_SELF_BIND` | **denied, and not expressible**: a sandboxed process that `listen(0)`s and connects to its own port gets `EPERM` in allowlist mode. No SBPL filter limits a rule to ports this sandbox bound: `(target same-sandbox)` parses on `network-outbound` but never matches, `local` filters re-open every port, and ports cannot be ranges. Following ruling A-4's fallback, a repo whose tests start their own server declares the port in `sandbox.localPorts`. | §3 |
| `NON_DARWIN_MESSAGE` | the self-check detail stays `sandbox-exec is not available on ${process.platform}` (`linux` on Linux). The hook path wraps it the same way commands do: `` `${detail} — git hooks are not run without the sandbox. To run them anyway, turn on Settings → Development → "Run git hooks without the sandbox" on this computer` ``. Status card: `Sandbox unavailable on ${platform}`. | §4 |

## 1. `HOOK_GIT_WRITES` (step 1)

**Fixture.** This is the offline stand-in for lint-staged. Task 2 copies it to `packages/server/test/fixtures/hooks/fake-lint-staged.sh`.

```sh
#!/bin/sh
# Offline stand-in for lint-staged: a backup stash, hiding unstaged changes, "formatting" staged files and re-adding
# them, restoring, a temp file in the git dir.
set -eu
gd=$(git rev-parse --absolute-git-dir)          # <common>/worktrees/<name> in a linked worktree
# 1. lint-staged-style backup: stash create + store (objects, refs/stash, logs/refs/stash)
h=$(git stash create)
if [ -n "$h" ]; then git stash store -q -m "fake-lint-staged automatic backup" "$h"; fi
# 2. temp file in the git dir (lint-staged_unstaged.patch)
git diff --binary > "$gd/lint-staged_unstaged.patch"
# 3. stash push --keep-index when there are unstaged changes
stashed=0
unstaged=$(git diff --name-only)
if [ -n "$unstaged" ]; then git stash push --keep-index -q -- $unstaged; stashed=1; fi
# 4. "format" every staged file and re-add it (index)
for f in $(git diff --cached --name-only --diff-filter=ACM); do
  printf '/* formatted */\n' >> "$f"
  git add -- "$f"
done
# 5. restore (restore + drop rather than pop: a pop re-applies the staged hunks over the formatted file → conflict)
if [ "$stashed" = 1 ]; then git checkout -q stash@{0} -- $unstaged; git reset -q -- $unstaged; git stash drop -q; fi
rm -f "$gd/lint-staged_unstaged.patch"
# 6. drop the backup (step 3 can produce the same commit as the backup within one second: then the ref did not move)
if git rev-parse -q --verify refs/stash >/dev/null; then git stash drop -q; fi
# 7. write and delete a temp file under $GIT_DIR (as git exported it, else the admin dir)
t="${GIT_DIR:-$gd}/fake-lint-staged.$$"
echo x > "$t"; rm -f "$t"
echo "fake-lint-staged: ok"
```

Two fixture pitfalls came up and are fixed in the text above:
- `git stash pop` after formatting a staged file conflicts, because the stash also holds the staged hunk.
- The `stash push` can create the same commit as the backup stash, and then the second `drop` fails with "No stash entries found".

**Method.** One file is staged (`a.js`) and one has an unstaged change (`b.js`). The base profile is `(allow default) (deny file-write*) (allow file-write* <wt> <S>/tmp /dev/null /dev/tty /dev/fd)`, with `TMPDIR=<S>/tmp`. Allows were added one at a time, and the first denial was recorded each time:

| Extra allow | Result | Denied (first report) |
|---|---|---|
| none | exit 1 | `file-write-create <admin>/index.lock` (`git stash create` refreshes the index) |
| `<admin>/index.lock` | exit 1 | `file-write-unlink <admin>/index` (the lock is renamed over the index) |
| `(subpath <admin>)` | exit 1, "unable to create temporary file" | `file-write-create <common>/objects/66` |
| + `objects/` | exit 1 | `file-write-create <common>/refs/stash.lock` |
| + `refs/` | exit 1 | `file-write-create <common>/logs/refs/stash` |
| + `logs/` | exit 0, but "Unable to create `<common>/packed-refs.lock`" printed twice | `file-write-create <common>/packed-refs.lock` (dropping the **last** stash entry deletes `refs/stash`, which locks `packed-refs`) |
| + `packed-refs`, `packed-refs.lock` | exit 0, no denial | none |
| admin narrowed to `index` + `index.lock` | exit 1, "unable to write new index file" | `file-write-create <admin>/index.stash.<pid>` (stash's temporary index) |

A linked worktree's `index`, `ORIG_HEAD`, `COMMIT_EDITMSG`, `HEAD` and their `*.lock` files are all in `<admin>`. None was needed at the common root, so ruling A-2's "common root `index`, `*.lock`, `ORIG_HEAD`, `COMMIT_EDITMSG`" can be dropped. The only common-root files the hook needs are `packed-refs` and `packed-refs.lock`.

`git gc` inside the profile stops at once with `Unable to create '<common>/gc.pid.lock'` and writes nothing, so leaving `gc.pid` denied is safe. Auto-gc after a commit runs in the platform's unsandboxed git.

**Real commit through a wrapper.** The wrapper hooks dir `<S>/wrap/{pre-commit,commit-msg,pre-push}` holds one file per hook: `exec /usr/bin/sandbox-exec -f <hook.sb> <pinned>/<name> "$@"`. `<hook.sb>` is the base profile plus the `HOOK_GIT_WRITES` rules. The platform's command is `git -c core.hooksPath=<S>/wrap commit --quiet -m …`, run outside the sandbox after `git add -A`, with one more unstaged change. The pinned pre-commit runs the fixture and then these probes:

| Probe from inside the hook | Result |
|---|---|
| fixture (stash create/store/push/drop, re-add, git-dir temp file) | ok; commit exit 0; the formatted content is in `HEAD`; the unstaged change is kept |
| append to `<common>/config`; new `<common>/hooks/post-commit`; `<common>/info/attributes`; new `<common>/FOO`; append to `<common>/HEAD` | all denied |
| append to `<admin>/commondir`, `<admin>/gitdir`; create `<admin>/config.worktree` | all denied |
| `mv <admin> <admin>.x`; `mv <admin>/commondir …`; `mv <common>/config <common>/objects/cfg`; create `objects/x` then `mv` it to `<common>/config` | all denied (the last one leaves `objects/x`) |
| append to `<wt>/.git`; `mv <wt>/.git …` | **OK before the explicit deny** (the worktree subpath allows it, and the first run broke the scratch worktree); denied once `<wt>/.git` is denied for write and unlink |
| create + delete `<admin>/probe` | OK |

**Why `commondir` and `gitdir` are denied (not in A-2).** The platform's own git runs outside the sandbox. A hook that rewrites `<admin>/commondir` could point it at a dir with a planted `config` (`core.fsmonitor`, …). Git does not read `<admin>/config`, `<admin>/hooks` or `<admin>/info`. That was checked: a planted `<admin>/config` key is not seen, and `git rev-parse --git-path hooks` / `info/attributes` resolve to `<common>`. So the subpath allow on `<admin>` is safe once those three files are denied.

**Temp-dir unlink deny (T5-8).** The real dev profiles deny `file-write-unlink` in the temp dirs, and in tests the repo is under `$TMPDIR`. With `(deny file-write-unlink (subpath <S>))` before the git allows, the fixture fails with `unable to unlink '<admin>/index.lock'`, and the failure leaves a stale `index.lock` behind. Adding `(allow file-write-unlink …)` for the same paths and `(deny file-write-unlink …)` for the denied files makes it pass again. This repeats §6.9 of the phase 3 spike: an operation-specific rule beats `file-write*` whatever the order.

**Task 2 order:**
1. the `dev-command` rules;
2. `(allow file-write* HOOK_GIT_WRITES)` and `(allow file-write-unlink HOOK_GIT_WRITES)`;
3. `(deny file-write* <common>/config <common>/hooks <common>/info <admin>/commondir <admin>/gitdir <admin>/config.worktree <wt>/.git)` and the same list as `(deny file-write-unlink …)`, plus `(literal <admin>)`.

Put the explicit `<common>/config|hooks|info` deny last even though nothing allows them. It keeps a later broad allow, such as a SLACKOFF_HOME under the temp dirs (T5-5), from opening them.

## 2. `HOOK_ENV_KEEP` and `HOOK_STDIN` (step 2)

**Method.** The same scratch repo was used. The parent environment had fake `SSH_AUTH_SOCK`, `GPG_AGENT_INFO` and `ANTHROPIC_API_KEY` values. Each pinned hook wrote `env | sort` and its arguments to `<S>/out`. The probe compared the parent environment of `git commit` with each hook's environment.

**What git adds for the hooks** (parent had no `GIT_*` except identity / config):

| Hook | Variables set by git |
|---|---|
| pre-commit | `GIT_DIR=<admin>`, `GIT_INDEX_FILE=<admin>/index`, `GIT_PREFIX=` (empty), `GIT_EDITOR=:`, `GIT_AUTHOR_DATE=@<epoch> <tz>`, `GIT_EXEC_PATH`, `GIT_CONFIG_PARAMETERS='core.hooksPath'='<wrap>'` |
| commit-msg | the same, plus the author / committer variables that were already in the parent |
| pre-push | `GIT_DIR=<admin>`, `GIT_PREFIX=`, `GIT_EXEC_PATH`, `GIT_CONFIG_PARAMETERS` (no `GIT_INDEX_FILE`, no `GIT_AUTHOR_DATE`; `GIT_EDITOR` unchanged) |

`GIT_REFLOG_ACTION` was not set for commit or push. The Apple `/usr/bin/git` shim also adds `SDKROOT`, `CPATH`, `LIBRARY_PATH`, `MANPATH` and `__CF_USER_TEXT_ENCODING`; these are harmless and can be kept.

`sandbox-exec` does not filter the environment. The fake agent and API-key variables reached the hook unchanged, so the wrapper must `unset` them itself.

**Minimal environment works.** A second wrapper ran `env -i` with only `PATH HOME TMPDIR`, the `GIT_*` variables above, the identity variables and `GIT_CONFIG_GLOBAL/NOSYSTEM`. The commit, the fixture, commit-msg and pre-push all still worked. The decided value therefore keeps the whole environment minus a strip list rather than an allowlist: hooks need the user's tool environment (nvm `PATH`, `NODE_OPTIONS`, `LANG`). Keep `GIT_INDEX_FILE` even though it equals the default index here. With `commit -a` or a pathspec, git points it at a temporary index, and a hook that drops it would lint the wrong index.

**`GIT_CONFIG_PARAMETERS` carries `core.hooksPath=<wrap>` into the hook.** If a hook runs `git commit` without `--no-verify`, the nested git invokes the wrapper inside the sandbox. A nested `sandbox-exec` fails with `sandbox_apply: Operation not permitted` (exit 71, measured), so the nested commit fails. lint-staged and commitlint do not commit. Task 3 can live with this and record it, or have the wrapper exec the hook directly when it is already sandboxed (see Concerns 2).

**Stdin.** 1000 extra branches were pushed with a pinned pre-push that runs `cat > file`. It received 1001 lines and 125,900 bytes, identical (`cmp`) to the expected `<local ref> <sha> <remote ref> <zero-sha>` lines. Its arguments were `origin <url>`. The stdin is identical under both the full-environment and the `env -i` wrappers.

**commit-msg.** `argc=1`, `$1 = <admin>/COMMIT_EDITMSG` (absolute, inside `GIT_DIR`). A hook append (`Refs: T-1`) was in the final commit message.

## 3. `LOOPBACK_ALLOWLIST_SBPL` and `LOOPBACK_SELF_BIND` (step 3)

**Method.** Two scratch listeners ran on free ports `P1` (to be allowed) and `P2` (undeclared), bound on `::` dual-stack. `node connect.mjs host:port…` ran inside each profile and printed `CONNECTED` or the error code. `selfbind.mjs` listens on `host:0` inside the profile and connects to its own port. Without a sandbox, every target below is `CONNECTED`.

| Profile (after `(allow default)`) | 127.0.0.1 / ::1 / localhost / LAN : P1 | same : P2 | `[::ffff:127.0.0.1]:P2` | self-bind v4 / v6 |
|---|---|---|---|---|
| A: `deny tcp "localhost:*"`, then `allow tcp "localhost:P1"` | all CONNECTED | all EPERM | **CONNECTED** | EPERM / EPERM |
| B: the same two rules in reverse order | all EPERM | all EPERM | — | EPERM / EPERM |
| C: as A with `remote ip` | as A | as A | **CONNECTED** | EPERM / EPERM |
| E1: `deny tcp6 "*:*"`, `deny tcp "localhost:*"` (no allow) | v4 **CONNECTED** | 127.0.0.1:P2 **CONNECTED**, ::1 EPERM | EPERM | — |
| **E3 (decided):** `deny tcp6 "*:*"`, `deny tcp4 "localhost:*"`, `allow tcp4 "localhost:P1"`, `allow tcp6 "localhost:P1"` | all CONNECTED (also the `utun` VPN address and global IPv6) | all EPERM (also `utun`, global IPv6, `0.0.0.0`, `[::]`) | EPERM (and `::ffff:7f00:1`, `::ffff:<LAN>`) | EPERM / EPERM |
| E3 + `deny tcp "*:P1"` last (a denied port) | P1 EPERM on v4, ::1, localhost | — | — | — |
| `deny tcp "*:P1"` **first**, then E3 | P1 CONNECTED | — | — | — |

Findings:
- **Later rule wins** between the deny and the allow (A vs B), as for file rules of the same operation.
- **`localhost` is "this machine", not 127/8.** It matched 127.0.0.1, ::1, the LAN IPv4, a `utun` VPN IPv4 and a global IPv6 of `en0`, but not `127.0.0.2` (unassigned, `TIMEOUT`). A Tailscale address is on a `utun` interface, so `localhost` covers it and no separate rule is needed. Not probed with a real Tailscale address.
- **IPv4-mapped IPv6 bypasses `localhost`.** `[::ffff:127.0.0.1]`, `::ffff:7f00:1` and `::ffff:<LAN>` connected through `deny tcp "localhost:*"` (A, C) and through the `tcp4` / `tcp6` variants of the same rule. The phase 3 `(remote tcp "*:<p>")` denies are **not** affected: a mapped connect to a `*:P2`-denied port is EPERM, and adding the bind deny changes nothing. Only the new allowlist needs this rule. The only way to catch mapped addresses is `(remote tcp6 "*:*")`, because SBPL hosts must be `*` or `localhost` (`127.0.0.1:*`, `[::ffff:…]:*` and `100.64.0.1:*` give "host must be * or localhost"; `localhost:1000-2000` gives "invalid port").
- **Do not mix `tcp` with `tcp6 "*:*"`.** In E1 (and in `ip6 "*:*"` + `tcp "localhost:*"`), the generic rule stopped matching IPv4 in either order, so 127.0.0.1:P2 connected. Mixing `tcp "*:<p>"` with `tcp4` / `tcp6` rules was fine (M1). `tcp6 "localhost:P1"` + `tcp "localhost:*"` was fine too (X2). The allowlist block therefore uses only explicit `tcp4` / `tcp6`, and the self-check must probe 127.0.0.1, ::1 **and** `::ffff:127.0.0.1` on an undeclared port.
- **Order against `DENIED_PORTS`.** The allows re-open a port that an earlier `*:<p>` deny closed, so the `DENIED_PORTS` / `deniedLocalPorts` deny lines must come after the allowlist block. That is in addition to `sandbox.localPorts` refusing them.
- **Cost of `tcp6 "*:*"`:** allowlist mode refuses outbound IPv6 TCP to every host, external ones too, except the declared loopback ports. External effects (Node's happy-eyeballs falling back to IPv4) were **not probed**, because no network beyond localhost was used. This mode is opt-in (A-4).

**Self-bind.** In every allowlist profile, a process that binds `127.0.0.1:0` or `[::1]:0` (bind succeeds) and connects to itself gets `EPERM`. Candidates tried:
- `(allow network-outbound (local tcp4 "localhost:*") (local tcp6 "localhost:*"))` re-opened every port, P2 included.
- `require-all` of `remote` + `local` re-opened 127.0.0.1:P2 and broke ::1:P1.
- `(target same-sandbox)`, alone or in `require-all`, parses but never matches.

SBPL has no "port bound by this sandbox" filter, so repos declare their test ports (A-4 fallback).

## 4. `NON_DARWIN_MESSAGE`

Calling the current code with a platform override (`sandboxSelfCheck(scope, {platform})`) gives:
- `linux`: `{"ok":false,"detail":"sandbox-exec is not available on linux"}`
- `win32`: `{"ok":false,"detail":"sandbox-exec is not available on win32"}`
- `commandSandbox` with the switch off: `SandboxUnavailableError: sandbox-exec is not available on linux — repository commands are not run without the sandbox. To run them anyway, turn on Settings → Development → "Run repository commands without the sandbox" on this computer`

On darwin with `/usr/bin/sandbox-exec` missing, the same branch prints `… not available on darwin`, which reads oddly. Task 5 may split it into `/usr/bin/sandbox-exec is missing`. It was not probed, because that would mean removing a system binary. It was not run on Linux either; `process.platform` there is `'linux'` by Node's documentation.

## 5. Step 4 (author): husky + lint-staged + commitlint on a real test repo

**Not verified by the author — moved to task 8 exit check.** For that check, use a husky v9 + lint-staged + commitlint test repo (`/path/to/test-repo`) and commit once through the phase 4a build, with `HOOK_GIT_WRITES`, ticket cache and tmp dirs. Expected: lint-staged formats and re-adds, its backup stash is dropped, commitlint rejects a bad message, and no `EPERM` appears in the hook output.

Husky v9's `.husky/_/h` finds the user script as `$(dirname "$(dirname "$0")")/<name>`. The wrapper must therefore exec the hook **at its pinned path**, not a copy, so that `$0` stays under `.husky/_`.

## Concerns / not verified

1. **IPv4-mapped bypass of `localhost`.** It is closed only by `tcp6 "*:*"`, which also blocks external IPv6 TCP in allowlist mode. README / Task 4 should state that. The self-check item "an undeclared port must be `EPERM`" must include `::ffff:127.0.0.1`.
2. **Nested `git commit` inside a hook** (without `--no-verify`) fails, because the nested wrapper's `sandbox-exec` cannot apply a second sandbox (§2). Task 3 decides whether that is acceptable (`hook_failed`, visible) or whether the wrapper detects "already sandboxed" and execs the hook directly. Detecting it by an environment marker alone would be spoofable from outside, so it needs a check that cannot be spoofed.
3. **A linked worktree is assumed.** A hook run in a main worktree, which the platform never uses, would need `<common>/index` and friends.
4. **`<wt>/.git` is writable in the worktree subpath allow.** The explicit deny is required: without it, the first probe run broke the scratch worktree.
5. **Not probed:** a real Tailscale address; external IPv6 / IPv4 traffic under the allowlist; real husky / lint-staged / commitlint (step 4); Linux; darwin without `sandbox-exec`; Node 26 (Node 25.6.1 was used for the network probes).

## Host effects

None outside the scratch dir:
- No clipboard, LaunchServices, launchctl, AppleEvents, keychain, rc files, `~/.gitconfig`, `~/.claude` or `~/.nvm`.
- Git ran with a fake `HOME`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.
- The scratch listeners were bound on `::` (reachable on the LAN for the few minutes of the probes) and then stopped.
- `log show` only reads the system log.
- The scratch dir was removed afterwards.
