# Spike: acceptance for command-line tools and Node libraries (phase 4f, Task 1)

Date: 2026-11-08 · macOS 15.6.1 (Darwin 24.6.0) · Node 26.13.0 · `/usr/bin/sandbox-exec` with the phase 3 `acceptance`
profile (`sandboxArgv` / `sandboxEnv` from `packages/server/src/sandbox/local-sandbox.ts`, unchanged).
These were throwaway experiments only, and their scripts and raw logs are not committed. Everything ran in two places, both removed afterwards:

- a run root made like `prepareRunDirs` makes one (`acceptRunBase()` → `/private/tmp/slackoff-accept-XXXXXX`, with
  `tmp/`, `bin/` and `work/`);
- a scratch `SLACKOFF_HOME` under `/private/var/tmp` holding a fake `slackoff.db`.

The fixtures were:

- a CLI `bin/tool.mjs`, with `#!/usr/bin/env node` and mode 0755;
- the same CLI without the executable bit, and without a shebang;
- an ESM package with `exports` subpaths;
- a CommonJS package;
- a scoped package `@example-org/fixture-scoped`.

Every command ran with the following:

- cwd: `<runRoot>/cases-work/1`;
- `HOME`: that dir;
- `PATH`: `<node dir>:/usr/bin:/bin`;
- stdin: a pipe, written and then closed.

**No real `claude` run was made.** This task's operating rules forbid one, so `CASES_SHIM_FORM` is not measured; see below.

## Decided values

| Name | Value | Basis |
|---|---|---|
| `CASES_SHIM_FORM` | Allow rule exactly `Bash(slackoff-cases run)`; the guard's verbatim forms are `cd <workDir>/acceptance && slackoff-cases run` and `slackoff-cases run` (the same pair as `ACCEPT_BASH_FORM`). **Not verified** with a real `claude`. | By analogy with the phase 3 spike §2: under `Bash(playwright test)` both `cd <A> && playwright test` and a bare `playwright test` ran, and every other form was denied. The shim is the same mechanism under a different name. Phase 4f exit checklist item 3 checks this by hand. |
| `LIB_LINK` | `'symlink'`: `<workDir>/acceptance/examples/node_modules/<name>` → the snapshot's package dir `<workDir>/<repo>/<library.path>`, made by the platform. For a scoped name `@scope/name`, `node_modules/@scope/` is a real dir (0700) and `name` is the symlink in it. | §1. ESM (with `exports` subpaths), CommonJS and scoped packages all import under the `acceptance` sandbox. Node resolves the link to its real path, so the library's own dependencies come from the snapshot. The phase 3 `ACCEPT_PLAYWRIGHT_LINK` result applies unchanged. |
| `CLI_RESOLVE` | `'direct'`: each `./…` element of `cli.command` resolves to `<snapshot>/<path>`, and the first one is spawned as is (sandbox-exec `execvp`s it). The runner first checks that it is a regular file inside the snapshot and is executable. Otherwise the run is not executed, with the reason. | §2. A shebang file with mode 0755 runs directly. `#!/usr/bin/env node` needs node's dir on `PATH`. Without the x bit, `sandbox-exec` exits 71 ("execvp() … failed: Permission denied"). Without a shebang, the kernel hands the file to `/bin/sh` (exit 2, syntax error). `node <path>` would hide both mistakes and break non-Node CLIs. A rule file that wants Node declares `node ./bin/tool.mjs`. |
| `CASE_TTY` | Non-interactive is enough. The case's `stdin` is written, then always closed (EOF); no pseudo-terminal is ever allocated. | §3. `isTTY` is unset on all three streams, `getColorDepth` is absent, and `util.styleText` emits no escapes, so colours are off by default. A `readline` prompt reads the case's `stdin` when given. With no stdin, a top-level-await prompt ends at once with exit 13 ("unsettled top-level await") rather than hanging. The runner still strips ANSI (a rules-file `FORCE_COLOR`). |

## 1. `LIB_LINK`

The examples sat in `<runRoot>/work/acceptance/examples/` and were run as `node <examples>/<x>.mjs` under the `acceptance`
profile. The links were made outside the sandbox:

- `examples/node_modules/fixture-esm` and `examples/node_modules/fixture-cjs`, each a symlink;
- `examples/node_modules/@example-org/`, a real dir, holding the symlink `fixture-scoped`.

| Example | Result |
|---|---|
| `import { slugify } from 'fixture-esm'; import { extra } from 'fixture-esm/extra'` (ESM, `exports` map) | exit 0, `hello-world extra-ok` |
| `import lib, { sub } from 'fixture-cjs'` (CJS, `exports.add = …; exports.sub = …`) | exit 0, `3 2` |
| `import lib, { add } from 'fixture-cjs'` with `module.exports = { add: (a, b) => a + b }` | exit 1, `SyntaxError: Named export 'add' not found` (Node's CJS named-export detection, not the link: the default import works) |
| `import hello from '@example-org/fixture-scoped'` | exit 0, `hello x` |
| An example reading `<SLACKOFF_HOME>/slackoff.db` | `EPERM` (the sandbox is the boundary; the guard is an extra layer, F-3) |

For the skill (Task 4): with a CommonJS library, prefer the default import (`import lib from '<name>'`), because named imports work only where Node detects them.

## 2. `CLI_RESOLVE`

| Command (absolute snapshot paths) | Result |
|---|---|
| `bin/tool.mjs argv 'x; touch /tmp/pwned' '$(id)'` (0755, shebang) | exit 0, `["x; touch /tmp/pwned","$(id)"]`: the arguments arrive verbatim, and `/tmp/pwned` does not exist |
| The same with `PATH=/usr/bin:/bin` | exit 127, `env: node: No such file or directory` |
| `node bin/tool.mjs argv a` | exit 0 |
| `bin/noexec.mjs` (0644) | exit 71, `sandbox-exec: execvp() of '…/noexec.mjs' failed: Permission denied` |
| `node bin/noexec.mjs` | exit 0 |
| `bin/nosheb.mjs` (0755, no shebang) | exit 2, `/bin/sh`: `syntax error near unexpected token` |
| `node bin/nosheb.mjs` | exit 0 |

`exportRepo` keeps the executable bit (T6-6), so a committed `chmod +x` CLI runs as the user would run it. Before running, the runner checks for a missing file, a missing x bit, a symlink out of the snapshot and a non-regular file. Each one gets a readable reason, and the run never starts.

## 3. `CASE_TTY`

| Probe | Result |
|---|---|
| `process.{stdout,stdin,stderr}.isTTY`, `stdout.getColorDepth`, `JSON.stringify(styleText('red','x'))` | `null null null`, `null`, `"x"` (no escape) |
| `readline/promises` `question('Continue? ')` with stdin `yes\n` | `Continue? answer="yes"`, exit 0 |
| The same with empty stdin (closed at once) | `Continue?`, then exit 13: `Warning: Detected unsettled top-level await` |

Interactive tools that need a TTY (full-screen UIs, password prompts that open `/dev/tty`) are out of scope (ruling F-1).
The report says "E2E not executed: interactive CLIs are not supported".

## 4. The sandbox boundary for a CLI

The same run of the fixture CLI under the `acceptance` profile gave these results:

- `readdirSync('<real home>/.ssh')` → `EPERM`;
- `fetch('http://127.0.0.1:4317/api/status')` → `EPERM`, refused by the sandbox before any packet. Nothing listened on 4317.

## Concerns / not verified

1. `CASES_SHIM_FORM` has not been measured with a real `claude`, because this run's rules forbid it. The phase 4f exit checklist item 3 covers it.
2. A CLI whose shebang is `#!/usr/bin/env node` uses the first `node` on the case's `PATH`. Today that is the server's `PATH`, through `targetEnv`, so it can be a different Node than the server's own.

## Host effects

None. Only scratch dirs under `/private/tmp/slackoff-accept-*` and `/private/var/tmp/slackoff-4f-spike-*` were used, and both were removed. No `claude`, no network, and no port was reached; the 4317 probe was refused inside the sandbox.
