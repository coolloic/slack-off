// Phase 4a Task 3 (rulings A-1, A-3, 4A-1): the repository's git hooks run inside the dev-hook sandbox, git itself
// outside it (signing and push credentials, T5-4). Before every platform commit and push, the platform rewrites a
// wrapper hooks dir of its own, `<SLACKOFF_HOME>/sandbox/<KEY>/<repo>/hooks/` (outside the agent's ticket directory and
// denied to every sandbox), and git is pointed at it with `-c core.hooksPath=<dir>`, which beats every config layer.
// Every executable file of the pinned hooks dir gets one (4A-4); without any, the dir is empty and git runs no hook.
// Each wrapper (spike docs/spikes/2026-11-phase4-sandbox.md §2, §5):
//   1. re-checks the pinned hooks dir's fingerprint (F2-I1): changed → "hooks changed since they were accepted", exit 1;
//   2. drops the ssh / gpg agent variables, API keys and tokens (4A-6, also when unsandboxed), and points TMPDIR and the
//      package caches into the ticket's cache (sandboxEnv); git's own GIT_* variables and the rest are kept;
//   3. execs `sandbox-exec <dev-hook profile> <pinned dir>/<name> "$@"` — at its pinned path, so husky v9's `.husky/_/h`
//      still finds the user script from `$0`; stdin passes through untouched (pre-push ref lines).
// A hook that runs `git commit` itself reaches its wrapper again inside the sandbox, where a second sandbox cannot be
// applied: the nested commit fails visibly (hook_failed, 4A-1). Self-check failed: refused (SandboxUnavailableError
// naming the switch), or, with development.allowUnsandboxedHooks, wrappers that keep steps 1–2 and exec the hook directly.
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { REPO_NAME, type Config } from "../config.ts";
import { runGit } from "../git/run.ts";
import { assertPlatformWorktree, type HooksPin } from "../git/worktree.ts";
import {
  ENV_STRIP, ENV_STRIP_PATTERNS, envStripSh, hookScope, mkdirNoFollowSh, SANDBOX_EXEC, sandboxEnv, sandboxParams, sandboxProfile, sandboxSelfCheck, SandboxUnavailableError, ticketTmpDir,
  type SandboxCheck, type SandboxScope,
} from "./local-sandbox.ts";

/** The hooks a platform `git add` / `commit` / `push` usually runs (4A-4: every executable of the pinned dir is wrapped). */
export const HOOK_NAMES: readonly string[] = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-push", "post-rewrite", "reference-transaction"];

/** 4A-6 (4A-15: shared with every sandboxed command, local-sandbox.ts ENV_STRIP): removed from a hook's environment in both modes. */
export const HOOK_ENV_STRIP: readonly string[] = ENV_STRIP;
export const HOOK_ENV_STRIP_PATTERNS: readonly string[] = ENV_STRIP_PATTERNS;
const STRIP_ENV = envStripSh("dev-hook");
/** A hook file name git can run and a wrapper can be named after. */
const HOOK_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `node hook-verify.ts <dir> <sha256>`: the wrapper's fingerprint re-check. */
export const HOOK_VERIFY_SCRIPT = join(import.meta.dirname, "hook-verify.ts");

export type HookGate = { kind: "sandboxed"; dir: string } | { kind: "unsandboxed"; dir: string; reason: string };

const TICKET_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BAD_CHARS = /[\n\r\0]/;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** 4A-4: every executable file in `dir` but `*.sample` (what git could run from there), each of which gets a wrapper. */
export function wrappedHookNames(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.filter((name) => {
    // git never runs `*.sample` (what `git init` puts in .git/hooks, executable)
    if (!HOOK_FILE.test(name) || name.endsWith(".sample")) return false;
    try {
      const st = statSync(join(dir, name));
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
}

/** The real paths of the worktree's git common dir and its admin dir (`<common>/worktrees/<name>`). */
export async function hookGitDirs(wt: string): Promise<{ common: string; admin: string }> {
  const r = await runGit(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"]);
  const [common, admin] = r.stdout.trim().split("\n");
  if (r.code !== 0 || common === undefined || admin === undefined) {
    throw new SandboxUnavailableError(`cannot find the git directories of ${wt}: ${r.stderr.trim() || `git exited with ${r.code}`}`);
  }
  return { common: realpathSync.native(common), admin: realpathSync.native(admin) };
}

/** One wrapper; `sandbox` is the quoted `sandbox-exec -p … -D …` prefix, or "" when the hooks run unsandboxed. */
function wrapperText(name: string, pin: HooksPin, node: string, run: readonly string[], sandbox: string): string {
  const hook = join(pin.dir, name);
  return [
    "#!/bin/sh",
    `# Slack Off (phase 4a): git runs the repository's ${name} hook through this wrapper. Generated before every commit`,
    "# and push; never edited by hand.",
    `if ! ${[node, HOOK_VERIFY_SCRIPT, pin.dir, pin.hash].map(shq).join(" ")} </dev/null; then`,
    `  echo ${shq(`Slack Off: hooks changed since they were accepted — the ${name} hook was not run`)} >&2`,
    "  exit 1",
    "fi",
    ...run,
    `exec ${sandbox === "" ? "" : `${sandbox} `}${shq(hook)} "$@"`,
    "",
  ].join("\n");
}

/**
 * (Re)write the wrapper hooks dir of (key, repo) for the worktree `wt`, whose hooks are pinned as `pin`, after the
 * dev-hook self-check (`check`, default sandboxSelfCheck). Returns the dir to pass as core.hooksPath. Self-check failed
 * and development.allowUnsandboxedHooks off: SandboxUnavailableError naming the switch, and no wrapper dir is left.
 */
export async function prepareHookWrappers(o: {
  home: string;
  key: string;
  repo: string;
  wt: string;
  pin: HooksPin;
  config: Config;
  check?: (s: SandboxScope) => Promise<SandboxCheck>;
  /** tests: the user home the profile's credential paths are taken from (default os.homedir()) */
  homeDir?: string;
  /** the node that re-checks the fingerprint (default this server's) */
  node?: string;
  /** 4A-3 / 4A-8: the mapped repository; the worktree's git common dir must be its own */
  repoPath: string;
  /** 4A-10: the worktree's branch as recorded for the ticket (`slackoff/…`), never what its HEAD says now */
  branch: string;
  /** phase 4a Task 4: the local-network part of the hook scope (allowlist mode: the declared ports); default denylist */
  net?: Pick<SandboxScope, "localNetwork">;
}): Promise<HookGate> {
  const { key, repo, pin } = o;
  if (!TICKET_KEY.test(key)) throw new SandboxUnavailableError(`invalid ticket key ${JSON.stringify(key)}`);
  if (!REPO_NAME.test(repo) || repo === "." || repo === "..") throw new SandboxUnavailableError(`invalid repository name ${JSON.stringify(repo)}`);
  if (!isAbsolute(pin.dir) || BAD_CHARS.test(pin.dir) || !/^[0-9a-f]{64}$/.test(pin.hash)) {
    throw new SandboxUnavailableError(`invalid pinned hooks directory ${JSON.stringify(pin.dir)}`);
  }
  const node = o.node ?? process.execPath;
  if (!isAbsolute(node) || BAD_CHARS.test(node)) throw new SandboxUnavailableError(`invalid node path ${JSON.stringify(node)}`);
  const home = realpathSync.native(o.home);
  const wt = assertPlatformWorktree(home, o.wt, o.repoPath);
  const parent = join(home, "sandbox", key, repo);
  const dir = join(parent, "hooks");
  // first remove the old wrappers: whatever happens next, nothing stale is left to run
  rmSync(dir, { recursive: true, force: true });
  const names = wrappedHookNames(pin.dir);
  if (names.length === 0) {
    // 4A-4: nothing to wrap — an empty dir, so git runs no hook at all (no self-check needed)
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    return { kind: "sandboxed", dir };
  }

  const scope = hookScope(home, key, wt, { ...(await hookGitDirs(wt)), branch: `refs/heads/${o.branch}` }, o.config.development.deniedLocalPorts, o.net ?? {});
  const c = await (o.check ?? sandboxSelfCheck)(scope);
  let gate: HookGate;
  if (c.ok) gate = { kind: "sandboxed", dir };
  else if (o.config.development.allowUnsandboxedHooks) gate = { kind: "unsandboxed", dir, reason: c.detail };
  else {
    throw new SandboxUnavailableError(
      `${c.detail} — git hooks are not run without the sandbox. To run them anyway, turn on Settings → Development → "Run git hooks without the sandbox" on this computer`,
    );
  }

  // 4A-6: no ssh / gpg agent, API keys or tokens, in both modes
  let run: string[] = [...STRIP_ENV];
  let sandbox = "";
  if (gate.kind === "sandboxed") {
    sandbox = [SANDBOX_EXEC, "-p", sandboxProfile(scope), ...sandboxParams(scope, o.homeDir)].map(shq).join(" ");
    run = [
      ...run,
      // TMPDIR and the package caches in the ticket's cache
      ...Object.entries(sandboxEnv(scope, {})).map(([k, v]) => `${k}=${shq(v!)}; export ${k}`),
      // the sandbox cannot create its tmp dir inside SLACKOFF_HOME
      ...mkdirNoFollowSh(home, ticketTmpDir(scope), 1, "hook not run"),
    ];
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  if (realpathSync.native(dir) !== dir || BAD_CHARS.test(dir)) throw new SandboxUnavailableError(`the hook wrapper dir ${JSON.stringify(dir)} is not a plain real path`);
  for (const name of names) {
    writeFileSync(join(dir, name), wrapperText(name, pin, node, run, sandbox), { mode: 0o755 });
  }
  return gate;
}
