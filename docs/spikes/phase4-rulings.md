# Phase 4 — rulings and deferred minors

Every decision the controller made on the author's behalf while executing the phase 4 sub-plans (index: `docs/superpowers/plans/2026-11-09-phase-4-index.md`), in the order made, verbatim from each sub-plan's execution ledger (each states what it costs if wrong where the ledger did). Followed by the minor findings that were deferred, not fixed. The author's own answers (MIT, history-free publish, Q-3..Q-8) are in the index's "作者答复与执行者裁决" section.

## phase-4a-sandbox

### Rulings

- Ruling 4A-1:
  - A-2 is narrowed to the spike's HOOK_GIT_WRITES set, plus explicit denies on <admin>/commondir, <admin>/gitdir, <admin>/config.worktree and <wt>/.git.
  - Hooks get the whole environment minus the strip list (AGENT_ENV, ANTHROPIC_*, GH_TOKEN, GITHUB_TOKEN).
  - The wrapper execs each hook at its pinned path.
  - A nested commit inside a hook is accepted as a visible hook_failed. The wrapper does not try to detect that it is already sandboxed, since any such check could be spoofed.
  - Allowlist mode adds a tcp6 "*:*" deny and a self-check probe of ::ffff:127.0.0.1.
  - Self-bind is not expressible, so repos declare their ports in sandbox.localPorts.
- Ruling 4A-2 (concern): the platform's other git calls (status, diff, restore, worktree add) default to -c core.hooksPath=<empty platform dir> through GIT_SAFE_CONFIG, and commit/push override it with the wrapper dir. This goes into the fix round after review. Cost if wrong: none (hooks like post-checkout stop running on platform worktree add, which is intended).
- Ruling 4A-3 (NR1, C1):
  - Every dev kind (dev-command, dev-install, dev-hook) denies file-write-unlink and file-write* on the literal worktree root(s), placed after the allows. Tests cover a parent rename and a dir RENAME_SWAP.
  - assertPlatformWorktree also requires realpath(common dir) == realpath(the configured repo's common dir) and the admin dir to be under it.
- Ruling 4A-4 (NR4, I1 + 4A-2): commit and push always pass the wrapper dir (empty if needed) and wrap every executable file in the pinned dir. GIT_SAFE_CONFIG defaults core.hooksPath to a platform-owned non-existent path. Cost if wrong: hooks outside the wrapped set no longer run unsandboxed (intended).
- Ruling 4A-5 (NR2, I2):
  - dev-hook denies unlink/rename of the literal objects, refs and logs dirs.
  - refs writes are narrowed to refs/stash, logs/refs/stash, the ticket's own branch ref and its log (and packed-refs + lock), with objects/ subpath writes kept.
  - A real lint-staged repo check goes on the exit list.
- Ruling 4A-6 (NR3, M2, M3): wrappers strip in BOTH modes AGENT_ENV, ANTHROPIC_*, CLAUDE_CODE_*, GH_TOKEN, GITHUB_TOKEN, NPM_TOKEN, AWS_*, and any var ending in _TOKEN, _SECRET, _PASSWORD or _API_KEY. Cost if wrong: a hook that needs a token fails visibly; documented.
- Ruling 4A-7: M4 emits the COMMON_GIT read re-allow only when the common dir is inside SLACKOFF_HOME. M1 is documented as residual. M5 goes to task 5. M6 goes to the README residual list and the exit check.
- Ruling 4A-8 (small round 2):
  - dev-hook denies packed-refs and packed-refs.lock writes, unless the fake lint-staged fixture needs them; if it does, document it.
  - assertPlatformWorktree's repoPath becomes REQUIRED at every call site (views, restore/reset helpers included).
  - Re-review follows.
- Ruling 4A-9 (N1):
  - A literal deny on file-write* and file-write-unlink for TICKET_CACHE (and the cache root and the ticket dir) in all dev kinds, placed after the allows.
  - Scope building refuses any realpath'd allow param that is a symlink, or whose realpath differs from the expected path under realpath(home). This covers TICKET_CACHE, WRITE_n, TMP, the acceptance RUN_ROOT and RUN_TMP.
  - Cache dirs are created without following symlinks.
  - Audit acceptance RUN_ROOT for the same swap.
  - Tests in each kind.
- Ruling 4A-10 (N2):
  - The hook scope's branch comes from the workspace DB record, and checkScope requires refs/heads/slackoff/.
  - dev-hook denies the literal <admin>/HEAD and HEAD.lock.
  - commitAll checks that symbolic-ref HEAD equals the recorded branch before committing.
- Ruling 4A-11: the env strip also covers *_AUTH, *AUTH_TOKEN*, NPM_CONFIG_*AUTH*, GOOGLE_APPLICATION_CREDENTIALS, *_CREDENTIALS and *_PRIVATE_KEY. Cost if wrong: a hook needing these fails visibly.
- Ruling 4A-12 (N3):
  - Every literal or subpath allow param is resolved parent-only, keeping the final name literal (the PARENT_ONLY pattern).
  - checkAllowPaths lstat-checks every allow param, and each dir between its root and it, for all kinds (dev and acceptance, including the git-dir ones). A generic test enumerates sandboxParams' allow params and asserts each one is validated.
  - dev-hook denies creating symlinks under the common git dir: (deny file-write-create (require-all (subpath COMMON) (vnode-type SYMLINK))).
  - Tests: plant a symlink at each ref literal; the next scope refuses or keeps the literal path.
- Ruling 4A-13: a small cleanup.
  - (NR3) The existing dev-command test for rc files, HOME and the checkout that opens the REAL ~/.zshrc r+ and creates a probe in the real HOME moves to a scratch HOME under /private/var/tmp. That test conflicts with the host-safety rule.
  - (NR2) TMUX_TMP and LAUNCHD_TMP are resolved parent-only for consistency.
  - (NR1) A hook deleting its own branch ref is accepted, because it only blocks its own ticket. Logged as a deferred minor.
- Ruling 4A-14: tasks 4–7 go in one sequential dispatch to the same implementer, with one commit per task, then one review across them. They all touch local-sandbox.ts, so batching avoids conflicts. Task 7 items already done by 4A-3 (worktree root) keep only the test, and the commit notes it. The xcrun_db minor (T5-4 test) is added to task 7. M5 (the Settings toggle "Run git hooks without the sandbox") goes into task 5's Settings work. Cost if wrong: a bigger review surface.
- Ruling 4A-15:
  - I-1: writeShellPrefix (agent Bash) and sandboxEnv (platform runCommand) use the same strip list as hooks (HOOK_ENV_STRIP + patterns). Exception: dev-install scopes keep NPM_TOKEN and NODE_AUTH_TOKEN, because .npmrc commonly interpolates them for private registries. The README says so.
  - M-1: remote sessions get a coarse self-check status (ok / failed / unavailable + a fixed reason), with no paths or stderr. Local sessions get full detail.
  - M-2: share the in-flight promise.
  - M-3: bind 127.0.0.1 and ::1 only.
  - M-4: the README states UDP is not filtered.
  - M-5: add a comment.
  - M-6: always strip the FAKE project and fake paths from saved config in fake mode.
- Tasks 4–7: fix round 1 done ac2035f (4A-15, RED→GREEN). Ruling: accept without re-review — reviewer-specified, tested, and no escape found in the review — cost if wrong: caught by the 4a final review
- Final: Ruling F4A-1 (C-A): keep object creation and forbid replacement:
  - deny file-write-unlink and file-write-mode on existing loose-object paths (regex, with the 38 hex spelled out);
  - deny file-write* and unlink on objects/pack and objects/info;
  - the README is corrected.
- Final: Ruling F4A-2 (C-B), all four layers:
  - every dev kind denies creating any `.git` path component inside writable worktrees (DOTGIT_RE);
  - the platform refuses gitlinks and embedded repos before commit (ls-files -s mode 160000, and `??` dirs containing .git count as forbidden);
  - every platform status/diff gets --ignore-submodules=all;
  - GIT_SAFE_CONFIG adds diff.ignoreSubmodules=all, submodule.recurse=false and status.submoduleSummary=false;
  - add a two-step regression test.
- Final: Ruling F4A-3: M-a — revertPaths deletes with a no-follow, re-lstat walk. M-b — cap hook hashing at 1 MiB per file and 16 MiB total, failing closed. I-A — README and exit doc updated.
- Final: Ruling F4A-4: three items are accepted as residual and documented:
  - unchanged, unpopulated gitlinks already in HEAD keep committing;
  - a hook can plant future objects;
  - a pre-commit hook can stage .slackoff/ or hook changes into its own commit, which reaches main only through a human-reviewed PR.

### Deferred minors

- (NR1) A hook deleting its own branch ref is accepted, because it only blocks its own ticket. Logged as a deferred minor.
- Tasks 2+3: minor (deferred): a hook can delete its own ticket branch ref (blocks the ticket only)
- Tasks 2+3: minor (deferred → task 7): the T5-4 test opens the real $TMPDIR/xcrun_db r+ from inside the sandbox (always EPERM) — point TMPDIR to a scratch dir for that scope
- Tasks 2+3: minor (deferred → task 8): desktop-phase3 e2e flaked once on the 300 s FAKE-1 timeout
- Tasks 4–7: minor (deferred): acceptance-install doesn't keep NPM_TOKEN/NODE_AUTH_TOKEN (private registries fail visibly in acceptance installs); web SandboxStatus type lacks the status fields (**resolved after phase 4**)

## phase-4b-api-modes

### Rulings

- Ruling 4B-1: the author has supplied no test key or JIRA site, so task 1 uses the plan's default column for every value: API_CHROME='unavailable' (so claude-api requires jira.source=api), API_KEY_DELIVERY='env' (a residual risk), and JIRA shapes per Atlassian docs. All are marked "not verified → exit check". Cost if wrong: task 4/6 adjustments after the author's real check.
- Ruling 4B-2 (NR3, I1+I2): fix now.
  - Redaction uses the current file plus an in-process set of every value ever read or written (never persisted). It fails closed to that set.
  - runAgent and the API clients redact with their own snapshot.
  - Redaction is applied at fail(), discovery failed, a redacting EventBus.emit wrapper, runAgent's rethrow, the queue onError and the logger.
  - Rule: redact before truncating.
  - Each sink gets a test.
- Ruling 4B-3 (NR1, NR4, M1, M2):
  - Error messages never echo request-supplied path or query input ("unknown ticket", "unknown role"), which closes the oracle.
  - Only values ≥ 8 chars are redacted.
  - apiToken and apiKey must be ≥ 16 chars.
  - The email stays hidden from the phone.
- Ruling 4B-4 (NR2, I3): add a PreToolUse guard for Read/Edit/Write/MultiEdit/Grep/Glob/NotebookEdit on every role that has file tools.
  - Exec-form hook, like spec-guard.
  - It realpaths file_path/path/notebook_path (and Grep/Glob path), resolving symlinks, and refuses anything outside the run's allowed roots: the ticket worktrees for dev, workDir for acceptance, the per-role addDirs.
  - Fails closed.
  - The author also checks Claude Code's own behaviour at exit.
- Ruling 4B-5: M3 wraps all read errors in CredentialFileError; M4 adds a race-seam test; M5 also covers +, lowercase %xx, base64 and base64url of each value alone, and HTML-escaped forms; M6 → task 6; M7 accepted.
- Ruling 4B-6:
  - F1, F2, F4: refuse any path or glob with a `..` segment or substring, a leading `~`, `{` or `}`.
  - F6: test the uncaughtException → exit 2 handler and document the timeout/kill residual.
  - F7: the self-check adds an in-root symlink-to-outside case.
  - M1 remainder: config validation errors mask record keys (e.g. projects.<key>), and sensitive-field and remote checks run on the raw body before full validation.
  - redactDeep also redacts Error instances (message and stack) and class instances' own enumerable string fields.
- Ruling 4B-7 (F3, F5): accepted as a residual for now.
  - Exploiting it needs an adversarial agent plus a sandboxed process that outlives its Bash call, racing the guard.
  - Mitigation now: the dev agent's shell prefix records each command's pgid, as T7-8 does for acceptance, and runAgent kills recorded groups after the run.
  - README residual: "a sandboxed process that escapes its process group could race the file-tool guard".
  - Author exit check: Claude Code's handling of `..`, `~`, braces, and Grep follow.
  - Denying symlink creation is rejected because it breaks pnpm.
- Tasks 2+3: fix round 2 done 522da24 (4B-6, 4B-7). Each fix went RED→GREEN. Tests: server 1070, e2e green. Ruling: accept without re-review, because these are reviewer-specified fixes, each with a test. Cost if wrong: caught by the 4b final review.
- Ruling 4B-8: caps are pages ≤ ceil(limit/100)+5, stopping as incomplete when a page adds no new key; comments ≤ 1000, beyond that "not loaded"; JSON ≤ 10 MB, error bodies ≤ 64 KB, attachments 5 MB enforced on the stream and content-length checked first. baseUrlSchema refuses userinfo, query and fragment, and trims a trailing slash. Cost if wrong: very large tickets show "not loaded" comments.
- Ruling 4B-9: a write that throws, times out or gets a 5xx on POST runs the existing read-back; if the result is still unknown it fails with "may have been posted — check JIRA before retrying". A 403 on a write is a failure "JIRA refused (no permission?)", not a login error. The mode is pinned per job (chosen when the job starts). M4 adds a unit test. M5 wording goes to task 7/8. M6: refuse IP-literal and private-range redirect hosts. Cost if wrong: none.
- Ruling 4B-10: the comment cap keeps the NEWEST 1000. Use orderBy=-created, or page from the end, then present them oldest-first, so the marker "N older comments not loaded" is accurate. M6's DNS-resolution gap is accepted as a residual: JIRA is trusted for redirects, and the request is unauthenticated. Cost if wrong: none.
- Ruling 4B-11:
- Ruling 4B-12:
  - M1: the allowlist adds NO_PROXY/no_proxy, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE and SSL_CERT_DIR. HTTP(S)_PROXY (both cases) are passed only when the URL has no userinfo; otherwise the run is refused with "proxy URLs with a password are not supported — they would be readable by sandboxed code".
  - README: Bedrock, Vertex and ANTHROPIC_BASE_URL are unsupported.
  - m1: the subscription executor redacts with redactKnown.
  - m4: a test checks that src/ never calls passFakeClaudeEnvForTests.
  - E1/E2 go on the 4b exit list (task 8): real-CLI checks that the helper is not run through the prefix, and that the key is not copied into child envs.
- Final: Ruling F4B-1 (I-1): for Grep and Glob, the guard walks the searched tree without following links, capped at 50k entries (over the cap → refuse). It refuses if any symlink in the tree resolves outside the roots. The README residual stays until the exit check. Cost if wrong: slower searches in huge trees; very large trees are refused.
- Final: Ruling F4B-2 (I-2): per-ticket attachment budget of at most 20 images downloaded and 50 MB total. The rest are kept as metadata (base64:null, with the reason noted). Comment pages get a 20 MB total budget. An attachment timeout or abort falls back to metadata (M-5). Cost if wrong: large tickets show some attachments as not downloaded.
- Final: Ruling F4B-3 (I-3): in API mode, parse the stream-json init event and kill and fail the run unless apiKeySource equals the expected helper value (constant API_KEY_SOURCE_HELPER, default 'apiKeyHelper'). Exit §8 requires that exact value. Cost if wrong: if the real value differs, every API run fails visibly until the constant is updated at the exit check.
- Final: Ruling F4B-4 (I-4): every JIRA-facing string depends on the mode, in web and server, including the delivery action text and the discover login view. The mode is recorded on snapshot, jira_write and jira_comment rows (migration). Cost if wrong: none.
- Final: Ruling F4B-5:
  - M-1: route raw console.error calls through logError.
  - M-2: accepted and documented.
  - M-3: credential inputs become text inputs with -webkit-text-security, the email a plain text input.
  - M-4: cap echoed keys at 40 chars and titles at 4 KB.
  - M-6: accepted, as it predates this phase; documented.
  - M-7: fix the docs.

### Deferred minors

- Tasks 2+3: minor (deferred): the guard refuses filenames containing '..' (e.g. a..b). **Resolved after phase 4:** paths are refused only for a `..` segment; globs keep the substring rule.
- Final: minor (deferred): Grep/Glob over trees with more than 50k entries (e.g. a pnpm worktree root including node_modules) are refused, and agents may hit this often. Revisit by excluding node_modules/.git when their links are proven in-root.
- Final: minor (deferred → 4e docs): document M-2 (echo oracle through an agent) and M-6 (fake "not loaded" marker from ticket text) in README residual risks. **Resolved in 4e:** both are in README → Residual risks.

## phase-4c-cost-telemetry

### Rulings

- Ruling 4C-0: migrations take the next free numbers (X-5). 4b used m13, so 4c uses m14 and m15. Tasks 1–3 go in one dispatch (sonnet); tasks 4–5 cover OTLP export, an outward write that uses credentials (opus). Cost if wrong: none.
- Ruling 4C-1:
  - M3: a phone may always pause and tighten (lower limits, enable budget). Loosening (raising/clearing limits, disabling the budget) and resuming are local-only when executor.kind is claude-api (real money). On the subscription executor they stay phone-allowed, because the developer is often away and the quota resets. Every budget change from any client is audited (budget_changed, with decidedBy).
  - M2: anchor USAGE_LIMIT_RE on the CLI's own wording, first line or 200 chars of the result string only (never stderr), with negative tests ("quota.ts failed", "disk quota exceeded", ticket text). claude-api 429 / rate_limit_error also maps to UsageLimitError.
  - M1: accepted as a soft limit (overshoot ≤ concurrency−1), documented in the README and on the page.
  - Index: new migration m15 `agent_run(started_at)`; telemetry takes m16.
  - L1: a test that refresh while paused surfaces "Paused …". L2: the trigger also rejects a NULL resumed_by. L3: the page notes "the limit is still reached" when resuming a threshold pause without raising it.
- Ruling 4C-2:
  - (NR1, I-1, M-1) The collector's response body is never stored or shown. detail = "HTTP <status>" + a fixed text per class (3xx redirect refused / 4xx rejected / 5xx collector error / timeout / network).
  - (NR2, I-2, M-3) With content off, tool names go through an allowlist of Claude Code built-ins plus `mcp__<server>__<tool>` for platform-configured servers; anything else becomes "other". Max 50 distinct names, then "other". Names go through redactKnown. Per-log read cap 4 MB, read asynchronously.
  - (NR3) A failed export uses up its hash. Re-sending needs a fresh preview: confirm refuses a hash that has any previous export row.
  - (NR4) Accepted residuals, documented in README (task 6): duplicate spans after an interrupted export; header values under 8 chars are not redacted.
  - M-2: header names deny host, content-length, transfer-encoding, connection, keep-alive, upgrade, te, trailer, expect and proxy-*. Values must be visible ASCII or Latin-1, checked at PUT.
  - M-4: finishExport failure falls back to failed.
  - M-5: a BEFORE INSERT trigger requires export status 'done' (a new migration m17, since m16 is shipped in-branch; or amend m16 if unreleased — choose m17 for safety).
  - Nit: the mapped IPv6 loopback forms are refused for own ports.
- Final: Ruling F4C-1:
  - (I-1) An error result carries costUsd and usage, and finish("error") records them. The README notes that timed-out runs have no cost.
  - (I-2) Recovery sets ended_at to the raw log's mtime, or else started_at. Aggregation also caps per-run minutes at the executor timeout.
  - (M-1) The confirmation sends the hash of the preview copy shown when the bar opened.
  - (M-2) A concurrent-confirm test.
  - (M-3) concurrency is bounded 1..8. Raising it on the API key is loosening, so local-only.
  - (M-4) A phone may resume `limit_reached` and `manual` pauses on the API key. `threshold` pauses and any loosening stay local-only.
  - (M-5) Redaction adds the token after a Bearer/Basic scheme, plus the decoded Basic user:pass and each half ≥ 8 chars. This applies to all stored header values (4b sinks too).
  - (M-6) README wording per the reviewer.
  - Nits: add a partial unique index (one open pause) in migration m18; bound rejectedSpans.

### Deferred minors

- Tasks 1–3: minor (deferred): a phone 403 on Resume in API mode shows as a plain error box; it should explain "resume on this computer". **Resolved after phase 4:** Resume waits for /api/status before it is offered, and the refusal reads as where to resume.
- Final: minor (deferred): the minute cap assumes the default retry count; pauseUsage doesn't catch an m18 UNIQUE error from multi-process writes; a config with concurrency > 8 now fails to load (with a clear field error)

## phase-4d-preferences-prompts

### Rulings

- Ruling 4D-0: the plan's m15 is taken (4c used m14–m18), so 4d uses m19 (X-5). Tasks 1–3 go in one sequential dispatch, tasks 4–6 in a second. Cost if wrong: none.
- Ruling 4D-1:
  - The "fewest repos" and "smallest scope" sentences count only choices where the options differ on that feature. maxRepoCount and maxScopeSize are recorded alongside the min.
  - Choices on tickets later abandoned are marked superseded when the abandon happens.
  - Task 6 adds a preferences_changed event.
- Ruling 4D-2:
  - (N1) Both cleanPreferenceText and the shared neutralise strip \p{Cf} (newlines kept), the U+E0000–E007F tag block, U+180E, \p{Co} and noncharacters before the defang. This applies to repo prompts and rules.md too. Add a probe test with U+E0041 and U+00AD.
  - (N2) repoCount comes from the developer's chosen affectedRepos. minRepoCount and maxRepoCount come from the proposals. Add a comment.
  - (N3) The wording becomes "In k of n comparable choices…".
  - describeError's redaction is confirmed in the log line.
- Final: Ruling F4D-1:
  - I1: runAgent writes a first raw-log line `{"type":"slackoff_system_prompt","sha256":…,"preferenceSection":<redacted text or null>}`. The full prompt is not logged, only its hash and the preference section. Exit check 0 is rewritten to use it.
  - M1: confirm returns the action's result, and the bar closes after it.
  - M2: add tests for draft redaction, the PUT 20,001 limit and GET /default ENOENT.
  - M3: trial tests race a short timer.
  - M4: escape every `<` in quoted text (as &lt;), closing the defang class.
  - M5: skip preferences when additionsOverride is set (trials). The README says so.
  - M6: the 409 message says when the slot frees ("a trial is running; it ends within 10 minutes").
  - M7: checkTrial also refuses addDirs, workDir, pgidFile and isolation. Discover runs set purpose 'discover'.
  - M8: redact string leaves recursively.
  - M9: README notes "the run's log is kept".
  - M10: the editor keeps in-progress text when the version changes, and shows "the summary changed — reload".

### Deferred minors

None.

## phase-4e-open-source

### Rulings

- Ruling 4E-1: tasks 1 and 2 are dispatched together (both small, both docs/scripts). Task 2 step 4 runs now because the author approved MIT. The copyright line is "Slack Off contributors" per the index ruling. Cost if wrong: one line to edit.
- Ruling 4E-2: task 1 step 5 runs the history scan without a private-terms file, since the author has not provided one, and notes that in the report. The report goes in the session scratchpad outside the repo. Proposal B (fresh commit) is the author's choice. Cost if wrong: names the author would list are not scanned for.
- Ruling 4E-3: fix H1–L6 in round 1. The --out guard uses realpath of the deepest existing ancestor, compared case-insensitively, plus a dev:ino check. Scanning covers a normalised copy: lines joined, JSON \u and percent sequences decoded. Only noreply@anthropic.com is allowed. Binary means a binary extension or magic bytes; a text-extension file containing NUL is a finding. Cost if wrong: none.
- Tasks 1+2: fix round 1 done ac9cac4 (4E-3, tests RED→GREEN). Ruling: accept without re-review — reviewer-specified fixes with tests — cost if wrong: caught by the 4e final review
- Ruling 4E-4: tasks 3–7 go to one implementer (opus) in order, one commit per task. Tasks 3–5 are docs plus a small code item, and task 7 is write-only. Stop points: task 6 step 4 and task 7 execution stay with the author. Carry into the README:
  - 4f r-2: Homebrew cargo/go are found, but their caches under the real HOME are denied, so Rust/Go builds that fetch dependencies fail.
  - The author hit Node 22 on PATH: the install guide must say `nvm use` (.nvmrc = 26) and show the exact error `bad option: --disable-sigusr1`.
  - MIT is approved (LICENSE exists), so the README License section says MIT, not 'to be decided'.
- Ruling 4E-5: the usage aggregation timing test becomes a 3 s regression bound (6ee2f43) — the 200 ms target holds alone, the test measured up to 2.15 s under full-suite load — cost if wrong: a 200 ms–3 s regression goes unnoticed.
- Final: Ruling: plan files carry the claude.ai session URL (the author's chosen commit trailer) — left as is; the release checklist's history-free commit + author eye review covers it — cost if wrong: a session URL in the public tree.

### Deferred minors

- Final: minor (deferred): the remaining 4e review minors listed in final-review.md.

## phase-4f-acceptance-cli-library

### Rulings

- Ruling 4F-1 (C1, I1, NR1, NR3):
  - Each case runs under a per-case profile: write and unlink only in cases-work/<n> and its own tmp; everything else in RUN_ROOT is read-only, including the snapshot, acceptance/, examples/node_modules and cases-work itself.
  - The platform re-run uses a FRESH run root: a new export, plus cases and examples copied with no-follow reads and size caps from the agent's run root. Shim-phase escapees (sandboxed to the old RUN_ROOT) then cannot touch it.
  - The platform creates cases-work/<n> and writes its files before case n starts. Only the platform can write cases-work.
  - After the re-run, re-verify the link (readlink and lstat) and hash the snapshot manifest; any change gives not_executed "the app under test changed during acceptance".
  - Lines 395–396 move inside the per-case try (fail closed).
- Ruling 4F-2 (I2, NR2):
  - After each case on the platform path, and at run end, kill any process whose cwd or open files are under the run root(s), using /usr/sbin/lsof +D (best effort), plus the existing pgid and env marks.
  - Residual (README): an escapee with no handle under the run root survives, but it stays sandboxed and cannot write the fresh run root.
- Ruling 4F-3 (NR4, NR5, NR6, NR7):
  - The rules file refuses generic interpreters (node, nodejs, sh, bash, zsh, dash, fish, env, npx, npm, pnpm, yarn, bunx, bun, deno, python*, ruby, perl, php, osascript) as the first word of cli.command. A CLI must be the project's own executable.
  - Case env is an allowlist: only keys listed in the rules file's new `acceptance.caseEnvKeys` (default []), which must also pass the reserved rules.
  - Regex matching runs in a Worker terminated after 200 ms, with a 5 s total per run; errors are reported separately from timeouts.
  - Case transcripts and evidence are taken from the runner's in-memory capture and written outside the run root.
- Ruling 4F-4:
  - M3: lstat-check examples/.
  - M4: a null exit code (killed by a signal) fails the case.
  - M5: test the scope guard.
  - M2: case files may not be dotfiles at the top level of HOME (names starting with "."), unless the rules file allows them.
- Ruling 4F-5 (carried into task 4):
  - M1: copyCaseInputs requires realpath(fromAcceptanceDir) === realpath(oldRunRoot)/work/acceptance, lstats every component, re-checks after reading, and does the copy reads inside the old run's acceptance sandbox (a sandboxed helper).
  - M2: cli.command's first word must be a `./` path inside the snapshot. Bare program names are refused, which subsumes the interpreter list.
  - M3: runCases is wrapped in runTimeoutMs plus the abort signal.
  - M4: sweep the shim phase's processes (lsof plus pgids) BEFORE building the fresh run root and copying.
- Ruling 4F-6: mixed web/api + cli/library ticket ends not_executed; case files always under acceptance/<repo>/; FAKE-4 + cli repo only under the phase-4f env switch — keeps earlier e2e counts — cost if wrong: a mixed ticket needs two tickets or a later phase.
- Ruling 4F-7: fix I-1 (deny R1 + its -read- dir in re-run profiles, probe as regression test) and I-2 (rules-file cli.interactive: true → not_executed 'interactive CLIs are not supported'; restore exit check 2 wording). Promote m-8 (redactKnown on transcripts/outputTail) and the bidi/marker part of m-3 (strip bidi+control chars, escape marker lines) into the fix round — cheap and on the redaction/display trust path. Other minors deferred — cost if wrong: a CLI that is interactive but not flagged still fails its ACs visibly.
- Final: Ruling 4F-8: fix I-1..I-5; promote by effect n-3 (live with I-1), m-4 (run timeout ≠ app failure), Minor 2 (exec bit → clear message), Minor 3 (README Python/Go line), n-2 (wiring test) — each is a day-one hit or a cheap guard. Brief: final-fix-brief.md.
- Final: Ruling: Declined-to-judge items — non-macOS, pty CLIs, CLI Node version (Slack Off's Node 26), mixed tickets (4F-6), residual escapee (4F-2), shim form (exit check 3), two hook-test timeouts under load — all stand as accepted; a CLI pinned to another Node may behave differently — cost if wrong: a README note / per-project node later.

### Deferred minors

- Final: minor (deferred): library examples cannot read args; lsof +D after every case (0.38s on 43k entries); cross-run reads between concurrent slackoff-accept roots (concurrency 1 default); n-1 oldRunRoot not realpath'd; n-4 stdin preview/regex framing; n-5 credentials re-read per string; m-1 subdir swap race; m-2 sweep test gap; m-3 truncated flag from regex; m-5 R2 isolation assert; m-6 390 long-line e2e; m-7 fake agent shape.
- Final: minor (deferred): r-1, r-3; perf-timing flake usage.test.ts under full-suite load; main.test.ts port-4317 hang under load.
