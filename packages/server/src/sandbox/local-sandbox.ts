// Task 5 (ruling R-LOCAL): the local command sandbox. Slack Off treats every loopback request as the developer
// (isLocalRequest) and a token cannot stop a same-user process, so every child process the platform starts that runs
// repository- or agent-authored code runs under a macOS `sandbox-exec` profile: no TCP to Slack Off's own listeners,
// no credentials, no SLACKOFF_HOME (dev commands: only the ticket's worktrees). Evidence: docs/spikes/2026-11-acceptance-delivery.md §6.
// Not sandboxed (README): the `claude` process itself (T1-1), the platform's own git and `gh`. Phase 4a: the repos' git
// hooks run in the dev-hook profile, through the platform's wrapper hooks dir (hook-wrappers.ts).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isTicketBranch } from "@slackoff/shared";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import { runProcess } from "../git/run.ts";
import { DENIED_PORTS, SERVER_PORT, SLACKOFF_PORTS } from "../ports.ts";
import { isTailscaleIPv4 } from "../remote/tailscale.ts";
import { CREDENTIALS_FILE } from "../credentials/credential-store.ts";

export { DENIED_PORTS, SLACKOFF_PORTS };
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const SELF_CHECK_SCRIPT = join(import.meta.dirname, "selfcheck.mjs");
const SELF_CHECK_TIMEOUT_MS = 15_000;

export type SandboxKind = "dev-command" | "dev-install" | "acceptance" | "acceptance-install" | "dev-hook";

export interface SandboxScope {
  kind: SandboxKind;
  /** SLACKOFF_HOME */
  home: string;
  /** dev-*: required, the ticket directory (worktrees/<KEY>), readable; acceptance-*: always null */
  allowInHome: string | null;
  /** acceptance-*: the mapped repository paths (denied as well); dev-*: always empty */
  repos: readonly string[];
  /** dev-*: the worktree(s) this command may write (T5-3 write allowlist), inside allowInHome; default [allowInHome] */
  writable?: readonly string[];
  /** dev-*: never writable, whatever else allows it: each repo's git common dir and its worktree's `.git` file */
  gitProtect?: readonly string[];
  /** T5-6: more local TCP ports to deny (connect and listen), from config development.deniedLocalPorts */
  extraPorts?: readonly number[];
  /**
   * T6-1, acceptance-* only: the run's root dir (realpath, outside SLACKOFF_HOME and every repo). Its `tmp` dir is the
   * command's TMPDIR and the only dir in the unix-socket allow besides DNS (Chromium and test runners put their
   * sockets there); nothing is unlinked or renamed out of the temp dirs except inside the run root.
   */
  runRoot?: string;
  /** T6-2 (C4), acceptance-*: the acceptance agent's dedicated Claude Code config dir (acceptance.claudeConfigDir), denied */
  acceptConfigDir?: string;
  /** tests only: a stand-in for `/tmp/claude-` (other Claude sessions' scratch prefix and Claude Code's cwd files, T7-2) */
  claudeTmp?: string;
  /**
   * F-4 (M-3): the Tailscale IPv4 address(es) this server listens on while remote access is on. The profile already
   * denies every host on Slack Off's ports; the self-check also connects to `<ip>:<SERVER_PORT>` (must be EPERM, which
   * the sandbox decides before any packet is sent).
   */
  remoteHosts?: readonly string[];
  /**
   * dev-hook only: the repo's git common dir and this worktree's admin dir (`<common>/worktrees/<name>`), realpaths;
   * `branch`: the worktree's recorded branch (`refs/heads/slackoff/…`, from the workspace record, 4A-10), the only
   * branch ref a hook may write (4A-5)
   */
  gitDirs?: { common: string; admin: string; branch?: string };
  /**
   * phase 4a Task 4 (A-4, spike §3 LOOPBACK_ALLOWLIST_SBPL): absent = denylist (phase 3: DENIED_PORTS and extraPorts
   * refused, every other port open). 'allowlist': no TCP to this machine (any of its addresses, IPv4-mapped too) but
   * `allowPorts`, and no outbound IPv6 TCP at all; DENIED_PORTS stay refused last. A sandbox cannot be allowed the
   * ports it binds itself (LOOPBACK_SELF_BIND), so a repo declares its tests' ports in sandbox.localPorts.
   */
  localNetwork?: { mode: "allowlist"; allowPorts: readonly number[] };
  /**
   * phase 4f (ruling 4F-1), acceptance only: one case of the platform's case run. Writes, unlinks and own unix sockets
   * only in `work` (<runRoot>/cases-work/<n>) and `tmp` (<runRoot>/cases-tmp/<n>); the rest of the run root — the
   * snapshot, acceptance/, examples/node_modules, cases-work itself, other cases' dirs — is read only.
   */
  caseDirs?: { work: string; tmp: string };
  /**
   * phase 4f (ruling 4F-7, I-1), acceptance only: the platform's case re-run — the agent's old run root, which its
   * cases must never read (only copyCaseInputs' checked copies reach the re-run), and its `-read-` transcript dirs
   */
  oldRunRoot?: string;
}

/** phase 4f (4F-1): a case's work and tmp dirs in a run root. */
export function caseDirsOf(runRoot: string, n: number): { work: string; tmp: string } {
  return { work: join(runRoot, "cases-work", String(n)), tmp: join(runRoot, "cases-tmp", String(n)) };
}

/** phase 4a Task 4: the scope's local-network part for development.localNetwork and the ports the repos declare. */
export function localNetworkFor(mode: "denylist" | "allowlist", ports: Iterable<number>): Pick<SandboxScope, "localNetwork"> {
  return mode === "allowlist" ? { localNetwork: { mode: "allowlist", allowPorts: [...new Set(ports)].sort((a, b) => a - b) } } : {};
}

/**
 * Phase 4a (rulings A-1, A-2 as narrowed by 4A-1): the scope a git hook of the platform worktree `wt` (ticket `key`)
 * runs in. Reads, ports, sockets, LaunchServices and the keychain as dev-command; writes as dev-command plus the
 * HOOK_GIT_WRITES paths of `gitDirs` (spike docs/spikes/2026-11-phase4-sandbox.md §1). `gitDirs` are realpaths.
 */
export function hookScope(
  home: string, key: string, wt: string, gitDirs: { common: string; admin: string; branch?: string }, extraPorts: readonly number[],
  net: Pick<SandboxScope, "localNetwork"> = {},
): SandboxScope {
  return {
    kind: "dev-hook", home, allowInHome: join(home, "worktrees", key), repos: [], writable: [wt], gitDirs: { ...gitDirs },
    ...(extraPorts.length > 0 ? { extraPorts: [...extraPorts] } : {}),
    ...(net.localNetwork !== undefined ? { localNetwork: { mode: net.localNetwork.mode, allowPorts: [...net.localNetwork.allowPorts] } } : {}),
  };
}

const CLAUDE_TMP_DEFAULT = "/tmp/claude-";
/** T7-6: a path component named `.git` (a regex, passed as a param); F4A-2: in any case (a case-insensitive volume). */
const DOTGIT_RE = "/\\.[gG][iI][tT](/|$)";
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** T7-2 (amended): the name of Claude Code's cwd file under the (real) claude-* prefix. No `{n}` intervals: sandbox-exec
 * accepts them but never matches them (probed), so the 4 hex digits are spelled out and the id has no length cap. */
const cwdFileRe = (claudeTmpReal: string) => `^${reEscape(claudeTmpReal)}[0-9a-f][0-9a-f][0-9a-f][0-9a-f](-[-A-Za-z0-9_]+)?-cwd$`;
const HEX = "[0-9a-fA-F]";
/**
 * F4A-1 (C-A): an existing loose object or fan-out dir under the (real) objects dir — `<objects>/xx` or
 * `<objects>/xx/<38 hex>`, 24 more for SHA-256. Spelled out (no `{n}`, see cwdFileRe); upper case too (a
 * case-insensitive volume).
 */
export const looseObjectRe = (objectsReal: string) => `^${reEscape(objectsReal)}/${HEX}${HEX}(/${HEX.repeat(38)}(${HEX.repeat(24)})?)?$`;
/** Params that are regexes, not paths: never realpath'd. */
const REGEX_PARAMS = new Set(["CLAUDE_CWD_RE", "DOTGIT_RE", "LOOSE_OBJECT_RE"]);

/** Every TCP port the scope's profile denies. */
export const portsOf = (scope: SandboxScope): number[] => [...new Set([...DENIED_PORTS, ...(scope.extraPorts ?? [])])];

export interface SandboxCheck {
  ok: boolean;
  /** e.g. "4317:EPERM 5173:EPERM 9229:EPERM 9230:EPERM file:EPERM signal:EPERM allowed:OK" */
  detail: string;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export type CommandSandbox = { kind: "sandboxed"; scope: SandboxScope } | { kind: "unsandboxed"; reason: string };

/**
 * Never readable or writable inside the sandbox: credentials and browser profiles. With `slackoffHome`, also the
 * platform's own credentials file (phase 4b, X-4) — inside the denied SLACKOFF_HOME already, pinned as a literal too.
 */
export function credentialPaths(homeDir: string, slackoffHome?: string): { param: string; path: string; literal: boolean }[] {
  const as = join(homeDir, "Library/Application Support");
  const own = slackoffHome === undefined ? [] : [{ param: "SLACKOFF_CREDENTIALS", path: join(slackoffHome, CREDENTIALS_FILE), literal: true }];
  return [
    { param: "HOME_SSH", path: join(homeDir, ".ssh"), literal: false },
    { param: "HOME_GH", path: join(homeDir, ".config/gh"), literal: false },
    { param: "HOME_AWS", path: join(homeDir, ".aws"), literal: false },
    { param: "HOME_NPMRC", path: join(homeDir, ".npmrc"), literal: true },
    { param: "HOME_NETRC", path: join(homeDir, ".netrc"), literal: true },
    { param: "HOME_KEYCHAINS", path: join(homeDir, "Library/Keychains"), literal: false },
    { param: "CHROME_PROFILES", path: join(as, "Google/Chrome"), literal: false },
    { param: "HOME_GIT_CREDENTIALS", path: join(homeDir, ".git-credentials"), literal: true },
    { param: "HOME_GIT_CONFIG_CREDENTIALS", path: join(homeDir, ".config/git/credentials"), literal: true },
    { param: "HOME_GNUPG", path: join(homeDir, ".gnupg"), literal: false },
    { param: "HOME_DOCKER_CONFIG", path: join(homeDir, ".docker/config.json"), literal: true },
    { param: "HOME_KUBE", path: join(homeDir, ".kube"), literal: false },
    { param: "ARC_PROFILES", path: join(as, "Arc"), literal: false },
    { param: "BRAVE_PROFILES", path: join(as, "BraveSoftware"), literal: false },
    { param: "FIREFOX_PROFILES", path: join(as, "Firefox"), literal: false },
    { param: "EDGE_PROFILES", path: join(as, "Microsoft Edge"), literal: false },
    ...own,
  ];
}

/** T5-4: package-manager cache variables, each pointed at its own dir in the ticket's cache (the global caches in
 * the user's home stay readable but are never writable). */
const CACHE_ENV: ReadonlyArray<[string, string]> = [
  ["npm_config_cache", "npm"],
  ["pnpm_config_store_dir", "pnpm-store"],
  ["XDG_CACHE_HOME", "xdg"],
  ["COREPACK_HOME", "corepack"],
  ["PLAYWRIGHT_BROWSERS_PATH", "ms-playwright"],
  ["YARN_CACHE_FOLDER", "yarn"],
  ["BUN_INSTALL_CACHE_DIR", "bun"],
];
/** T5-7: a sandboxed command's temp dir variables, all pointed at the ticket's tmp dir. */
const TMP_ENV = ["TMPDIR", "TMP", "TEMP"];
/** T5-4: variables that hand a sandboxed command the user's ssh / gpg agent. */
export const AGENT_ENV: readonly string[] = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO", "GNUPGHOME"];
/**
 * 4A-6 / 4A-11 / 4A-15: removed from the environment of everything run in a sandbox — hooks, the platform's commands
 * (sandboxEnv) and the agent's Bash (writeShellPrefix) — with every name matching ENV_STRIP_PATTERNS (shell `case`
 * globs: API keys, Claude Code's own variables, cloud credentials, tokens, secrets).
 */
export const ENV_STRIP: readonly string[] = [...AGENT_ENV, "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN"];
export const ENV_STRIP_PATTERNS: readonly string[] = [
  "ANTHROPIC_*", "CLAUDE_CODE_*", "AWS_*", "*_TOKEN", "*_SECRET", "*_PASSWORD", "*_API_KEY",
  // 4A-11: auth values, npm registry auth (npm reads npm_config_* in any case), cloud credential files, private keys
  "*_AUTH", "*AUTH_TOKEN*", "NPM_CONFIG_*AUTH*", "npm_config_*auth*", "npm_config_*Auth*", "GOOGLE_APPLICATION_CREDENTIALS", "*_CREDENTIALS", "*_PRIVATE_KEY",
];
/** 4A-15: a dependency install keeps the tokens a project's .npmrc commonly interpolates (${NPM_TOKEN}) for private registries. */
const INSTALL_ENV_KEEP: ReadonlySet<string> = new Set(["NPM_TOKEN", "NODE_AUTH_TOKEN"]);
const globRe = (g: string) => new RegExp(`^${g.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const STRIP_RES = ENV_STRIP_PATTERNS.map(globRe);
const keptFor = (kind: SandboxKind) => (kind === "dev-install" ? INSTALL_ENV_KEEP : new Set<string>());

/** 4A-15: whether a sandboxed command of `kind` loses the variable `name`. */
export function strippedEnvName(kind: SandboxKind, name: string): boolean {
  if (keptFor(kind).has(name)) return false;
  return ENV_STRIP.includes(name) || STRIP_RES.some((r) => r.test(name));
}

/** 4A-15: the same strip as shell lines (hook wrappers, the agent's shell wrapper). */
export function envStripSh(kind: SandboxKind): string[] {
  const keep = [...keptFor(kind)];
  return [
    `unset ${ENV_STRIP.filter((n) => !keep.includes(n)).join(" ")}`,
    String.raw`for v in $(/usr/bin/env | /usr/bin/sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do`,
    ...(keep.length > 0 ? [`  case "$v" in ${keep.join("|")}) continue ;; esac`] : []),
    `  case "$v" in ${ENV_STRIP_PATTERNS.join("|")}) unset "$v" ;; esac`,
    "done",
  ];
}

/** T5-3: device files a command may write. */
const DEV_FILES: ReadonlyArray<[string, string, boolean]> = [
  ["DEV_NULL", "/dev/null", true],
  ["DEV_ZERO", "/dev/zero", true],
  ["DEV_TTY", "/dev/tty", true],
  ["DEV_FD", "/dev/fd", false],
];

/** T5-3: temp directories dev commands may write: /tmp and the user's TMPDIR (not macOS's per-user C dir, T5-4). */
function tempDirs(): string[] {
  return [...new Set([realOrParent("/tmp"), realOrParent(tmpdir())])];
}

/**
 * T6-1: `<runRoot>/tmp`, an acceptance run's TMPDIR / TMP / TEMP and its own unix-socket dir. A socket path in it must
 * stay under the 104-byte sun_path limit (acceptance/workspace.ts picks the run root's base dir for that).
 */
export function runTmpDir(runRoot: string): string {
  return join(runRoot, "tmp");
}

/** T6-2: `<runRoot>/bin`, the dir of the platform's `playwright` shim: never writable from inside the sandbox (C1). */
export function runShimDir(runRoot: string): string {
  return join(runRoot, "bin");
}

/** T6-2: `<runRoot>/cache`, an acceptance run's package-manager caches (the write allowlist has no global cache). */
export function runCacheDir(runRoot: string): string {
  return join(runRoot, "cache");
}

/** T6-2 (C4): the server's own Claude Code config dir, when it runs with CLAUDE_CONFIG_DIR. */
function serverClaudeConfigDir(): string | null {
  const d = process.env.CLAUDE_CONFIG_DIR ?? "";
  return isAbsolute(d) && !/[\n\r\0]/.test(d) ? d : null;
}

/** dev-*: `<home>/cache/<KEY>`, the ticket's own package-manager caches (T5-4). */
export function ticketCacheDir(scope: SandboxScope): string {
  if (!isDev(scope.kind) || scope.allowInHome === null) throw new SandboxUnavailableError(`${scope.kind}: no ticket cache`);
  return join(scope.home, "cache", basename(scope.allowInHome));
}

/**
 * dev-*: `<home>/cache/<KEY>/tmp`, the command's TMPDIR / TMP / TEMP (T5-7): the temp dirs are not in the unix-socket
 * allow (local daemons listen there), so a command's own sockets go here, inside the ticket cache. Kept short: a
 * socket path (sun_path) is limited to 104 bytes.
 */
export function ticketTmpDir(scope: SandboxScope): string {
  return join(ticketCacheDir(scope), "tmp");
}

/**
 * The environment of a sandboxed command (T5-4): `base` without the ssh / gpg agent variables; dev-*: every package
 * manager's cache pointed into the ticket's cache dir and TMPDIR / TMP / TEMP at its tmp dir (T5-7); both created here,
 * since the sandbox cannot create them inside the denied SLACKOFF_HOME.
 */
export function sandboxEnv(scope: SandboxScope, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // 4A-15: the same secrets as a hook's (dev-install keeps the npm registry tokens)
  for (const k of Object.keys(env)) if (strippedEnvName(scope.kind, k)) delete env[k];
  checkAllowPaths(scope);
  if (isDev(scope.kind)) {
    const dir = ticketCacheDir(scope);
    for (const [k, sub] of CACHE_ENV) env[k] = join(dir, sub);
    // 4A-9: created without following a symlink planted on the way
    const tmp = ticketTmpDir(scope);
    mkdirNoFollow(scope.home, tmp);
    for (const k of TMP_ENV) env[k] = tmp;
  } else if (scope.runRoot !== undefined && scope.caseDirs !== undefined) {
    // 4F-1: a case writes only its own dirs: temp files, sockets and package caches in its tmp dir
    const tmp = scope.caseDirs.tmp;
    mkdirNoFollow(scope.runRoot, tmp);
    for (const [k, sub] of CACHE_ENV) if (k !== "PLAYWRIGHT_BROWSERS_PATH") env[k] = join(tmp, "cache", sub);
    for (const k of TMP_ENV) env[k] = tmp;
  } else if (scope.runRoot !== undefined) {
    // T6-1: an acceptance command's temp files and sockets go to the run's own tmp dir. T6-2: its package caches into
    // the run root too (nothing else is writable); Playwright's browsers stay in their install (read only)
    for (const [k, sub] of CACHE_ENV) if (k !== "PLAYWRIGHT_BROWSERS_PATH") env[k] = join(runCacheDir(scope.runRoot), sub);
    const tmp = runTmpDir(scope.runRoot);
    mkdirNoFollow(scope.runRoot, tmp);
    for (const k of TMP_ENV) env[k] = tmp;
  }
  return env;
}

/**
 * 4A-9: create `target` (0700 for each new dir) below the existing `base` without following symlinks: every component
 * between them must be a real directory or missing. A symlink or a non-directory there is a SandboxUnavailableError.
 */
export function mkdirNoFollow(base: string, target: string): void {
  const rel = relative(resolve(base), resolve(target));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new SandboxUnavailableError(`${target} is not inside ${base}`);
  let cur = resolve(base);
  for (const part of rel === "" ? [] : rel.split(/[\\/]/)) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      mkdirSync(cur, { mode: 0o700 });
      st = lstatSync(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SandboxUnavailableError(`${cur} is not a plain directory (a symlink or a file planted in the platform's own dirs)`);
  }
}

/**
 * 4A-9 (shell): the same for a wrapper, before every command: each dir must be a real directory or is made (0700);
 * a symlink or anything else there → `exit <code>`, nothing created.
 */
export function mkdirNoFollowSh(base: string, target: string, code: number, what: string): string[] {
  const rel = relative(resolve(base), resolve(target));
  const dirs = rel === "" ? [] : rel.split(/[\\/]/).map((_, i, parts) => join(resolve(base), ...parts.slice(0, i + 1)));
  return [
    `for d in ${dirs.map(shq).join(" ")}; do`,
    `  if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then echo ${shq(`Slack Off: ${what}: $d is not a plain directory`)} >&2; exit ${code}; fi`,
    `  [ -d "$d" ] || /bin/mkdir -m 700 "$d" || exit ${code}`,
    "done",
  ];
}

/** `realOrParent(p)` must be `p`'s own place under realpath(base): no symlinked component between them (4A-9). */
function plainUnder(base: string, p: string): boolean {
  const rel = relative(resolve(base), resolve(p));
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return realOrParent(p) === join(realOrParent(base), rel);
}

/** 4A-12: the names of every param an `(allow …)` rule of the scope's profile uses (regex params aside). */
export function allowParamNames(scope: SandboxScope): string[] {
  const out = new Set<string>();
  for (const line of sandboxProfile(scope).split("\n")) {
    if (!line.startsWith("(allow")) continue;
    for (const m of line.matchAll(/\(param "([A-Z0-9_]+)"\)/g)) if (!REGEX_PARAMS.has(m[1]!)) out.add(m[1]!);
  }
  return [...out];
}

/**
 * 4A-12: what checkAllowPaths validates for each allow param — its path and the root it is checked from: SLACKOFF_HOME,
 * the git common dir (dev-hook) or the run root (acceptance), whichever holds it first; "/" for the system paths (temp
 * dirs, /dev, the DNS socket, SLACKOFF_HOME's ancestors), which are real paths already.
 */
export function allowPathChecks(scope: SandboxScope, homeDir: string = homedir()): Array<{ param: string; root: string; path: string }> {
  const params = new Map(profileParams(scope, homeDir));
  const roots = [scope.home, ...(scope.gitDirs !== undefined ? [scope.gitDirs.common] : []), ...(scope.runRoot !== undefined ? [scope.runRoot] : [])];
  return allowParamNames(scope).map((param) => {
    const path = params.get(param)!;
    const root = roots.find((r) => sameOrInside(path, r) || sameOrInside(path, realOrParent(r))) ?? "/";
    return { param, root, path };
  });
}

/** 4A-12: the first symlink at or between `root` (exclusive) and `p` (inclusive), by lstat; null when there is none. */
function symlinkBetween(root: string, p: string): string | null {
  const base = root === "/" ? "/" : sameOrInside(p, root) ? root : realOrParent(root);
  const rel = relative(resolve(base), resolve(p));
  let cur = root === "/" ? "/" : realOrParent(root);
  for (const part of rel === "" ? [] : rel.split(/[\\/]/)) {
    cur = join(cur, part);
    try {
      if (lstatSync(cur).isSymbolicLink()) return cur;
    } catch {
      return null; // missing (or not a dir): nothing below it exists
    }
  }
  return null;
}

/**
 * 4A-9 / 4A-12: no allow param of the profile may be or lie behind a symlink, planted from inside an earlier sandbox
 * (an allow comes after the credential and home denies, so a redirected one would reopen them): every allow param,
 * and each dir between its root and it, is lstat'd (allowPathChecks); the git common dir and the run root themselves
 * are no symlinks. Also the dirs that are not params but are made or used inside them: dev-* — the ticket dir, the
 * cache root, the ticket cache and its tmp dir, each writable worktree, all plain under realpath(SLACKOFF_HOME);
 * acceptance-* — its tmp, shim and work dirs plain below the run root.
 */
function checkAllowPaths(scope: SandboxScope): void {
  const refuse = (what: string, p: string) => new SandboxUnavailableError(`${scope.kind}: the ${what} ${p} is a symlink or lies behind one — refusing to sandbox with it`);
  for (const root of [scope.gitDirs?.common, scope.runRoot]) {
    let link = false;
    try {
      link = root !== undefined && lstatSync(root).isSymbolicLink();
    } catch {
      // not there yet
    }
    if (link) throw refuse("sandbox root", root!);
  }
  for (const { param, root, path } of allowPathChecks(scope)) {
    const at = symlinkBetween(root, path);
    if (at !== null) throw refuse(`allowed path ${param} (${at})`, path);
  }
  if (isDev(scope.kind)) {
    const cache = ticketCacheDir(scope);
    const checks: Array<[string, string]> = [
      ["ticket directory", scope.allowInHome!], ["cache root", join(scope.home, "cache")], ["ticket cache", cache], ["ticket tmp dir", join(cache, "tmp")],
      ...writableOf(scope).map((w): [string, string] => ["worktree", w]),
    ];
    for (const [what, p] of checks) if (!plainUnder(scope.home, p)) throw refuse(what, p);
  } else if (scope.runRoot !== undefined) {
    let link = false;
    try {
      link = lstatSync(scope.runRoot).isSymbolicLink();
    } catch {
      // not there yet
    }
    if (link) throw refuse("run root", scope.runRoot);
    const caseChecks: Array<[string, string]> = scope.caseDirs !== undefined ? [["case work dir", scope.caseDirs.work], ["case tmp dir", scope.caseDirs.tmp]] : [];
    for (const [what, p] of [["run tmp dir", runTmpDir(scope.runRoot)], ["shim dir", runShimDir(scope.runRoot)], ["run work dir", join(scope.runRoot, "work")], ...caseChecks] as const) {
      if (!plainUnder(scope.runRoot, p)) throw refuse(what, p);
    }
  }
  // TMP_n (/tmp, $TMPDIR) are checked from "/" like every allow param; no sandbox can move or replace them anyway:
  // every dev profile denies unlink there (T5-8) and acceptance profiles deny it everywhere (T6-2 C2)
}

/** The ssh agent's socket directory (from SSH_AUTH_SOCK; its parent unless that is "/"), or a path that never exists. */
function agentSocketDir(homeDir: string): string {
  const s = process.env.SSH_AUTH_SOCK ?? "";
  if (!isAbsolute(s) || /[\n\r\0]/.test(s)) return join(homeDir, ".slackoff-no-ssh-agent");
  return dirname(s) === "/" ? s : dirname(s);
}

const isDev = (k: SandboxKind) => k === "dev-command" || k === "dev-install" || k === "dev-hook";
const isInstall = (k: SandboxKind) => k === "dev-install" || k === "acceptance-install";
/** Dependency installs keep ~/.npmrc and ~/.netrc readable (private registries); the ports stay denied. */
const INSTALL_READABLE = new Set(["HOME_NPMRC", "HOME_NETRC"]);

const inside = (path: string, dir: string): boolean => {
  const r = relative(resolve(dir), resolve(path));
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

const writableOf = (scope: SandboxScope): readonly string[] => scope.writable ?? [scope.allowInHome!];
const sameOrInside = (a: string, b: string) => resolve(a) === resolve(b) || inside(a, b);

function checkScope(scope: SandboxScope): void {
  if (scope.claudeTmp !== undefined && (!isAbsolute(scope.claudeTmp) || !/^[A-Za-z0-9._/-]+$/.test(scope.claudeTmp))) {
    throw new SandboxUnavailableError(`invalid claude-* stand-in ${JSON.stringify(scope.claudeTmp)}`);
  }
  for (const h of scope.remoteHosts ?? []) {
    if (!isTailscaleIPv4(h)) throw new SandboxUnavailableError(`invalid remote address ${JSON.stringify(h)} to probe: not a Tailscale IPv4 address`);
  }
  for (const p of scope.extraPorts ?? []) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new SandboxUnavailableError(`invalid port ${JSON.stringify(p)} to deny`);
  }
  if (scope.localNetwork !== undefined) {
    if (scope.localNetwork.mode !== "allowlist") throw new SandboxUnavailableError(`invalid local network mode ${JSON.stringify(scope.localNetwork.mode)}`);
    for (const p of scope.localNetwork.allowPorts) {
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new SandboxUnavailableError(`invalid port ${JSON.stringify(p)} to allow`);
      if (portsOf(scope).includes(p)) throw new SandboxUnavailableError(`port ${p} is always denied: it cannot be allowed`);
    }
  }
  if (isDev(scope.kind)) {
    if (scope.allowInHome === null) throw new SandboxUnavailableError(`${scope.kind}: the ticket directory to allow is missing`);
    if (!inside(scope.allowInHome, scope.home)) throw new SandboxUnavailableError(`${scope.kind}: ${scope.allowInHome} is not inside SLACKOFF_HOME`);
    if (scope.repos.length > 0) throw new SandboxUnavailableError(`${scope.kind}: development commands take no repository list`);
    const w = writableOf(scope);
    if (w.length === 0) throw new SandboxUnavailableError(`${scope.kind}: nothing to write`);
    for (const d of w) {
      if (resolve(d) !== resolve(scope.allowInHome) && !inside(d, scope.allowInHome)) {
        throw new SandboxUnavailableError(`${scope.kind}: ${d} is not inside the ticket directory`);
      }
    }
  } else {
    if (scope.allowInHome !== null) throw new SandboxUnavailableError(`${scope.kind}: nothing in SLACKOFF_HOME is allowed for acceptance`);
    if ((scope.writable ?? []).length > 0 || (scope.gitProtect ?? []).length > 0) {
      throw new SandboxUnavailableError(`${scope.kind}: write allowlists are for development commands only`);
    }
    // T6-2: every acceptance scope has its run root (the only writable dir)
    if (scope.runRoot === undefined) throw new SandboxUnavailableError(`${scope.kind}: the acceptance run root is missing`);
    if (scope.oldRunRoot !== undefined) {
      // 4F-7: a sibling of this run root, never this run root, inside it or around it
      const o = scope.oldRunRoot;
      if (!isAbsolute(o) || /[\n\r\0]/.test(o) || resolve(o) === "/") throw new SandboxUnavailableError(`${scope.kind}: invalid old run root ${JSON.stringify(o)}`);
      if (sameOrInside(scope.runRoot, o) || sameOrInside(o, scope.runRoot) || resolve(scope.runRoot).startsWith(`${resolve(o)}-read-`)) {
        throw new SandboxUnavailableError(`${scope.kind}: the old run root ${o} overlaps the run root ${scope.runRoot}`);
      }
    }
    if (scope.caseDirs !== undefined) {
      // 4F-1: exactly <runRoot>/cases-work/<n> and <runRoot>/cases-tmp/<n>, for the acceptance kind only
      const { work, tmp } = scope.caseDirs;
      const n = /^[1-9][0-9]{0,3}$/.exec(basename(work))?.[0];
      if (scope.kind !== "acceptance" || n === undefined || resolve(work) !== resolve(caseDirsOf(scope.runRoot, Number(n)).work) || resolve(tmp) !== resolve(caseDirsOf(scope.runRoot, Number(n)).tmp)) {
        throw new SandboxUnavailableError(`${scope.kind}: invalid case dirs ${JSON.stringify(scope.caseDirs)} for the run root ${scope.runRoot}`);
      }
    }
    {
      // T6-1: the run root's allows come after the denies (and an unlink allow beats a file-write* deny, §6.9), so it
      // must not be, lie in or contain SLACKOFF_HOME, a repo, a credential path or a Claude Code config dir
      const r = scope.runRoot;
      if (!isAbsolute(r) || /[\n\r\0]/.test(r) || resolve(r) === "/") throw new SandboxUnavailableError(`${scope.kind}: invalid run root ${JSON.stringify(r)}`);
      const denied = [
        scope.home, ...scope.repos, ...credentialPaths(homedir()).map((c) => c.path), join(homedir(), ".claude"),
        ...(scope.acceptConfigDir !== undefined ? [scope.acceptConfigDir] : []), ...[serverClaudeConfigDir()].filter((d): d is string => d !== null),
      ];
      // T6-7 (M1): never a broad dir — a temp-dir root or anything containing one, a /private/tmp/claude-* dir (another
      // session's), $HOME or anything under or around it; a run root is a dir of its own inside a temp dir
      const rr = realOrParent(r);
      for (const t of [...tempDirs(), realOrParent(NON_TEMP_SCRATCH)]) {
        if (sameOrInside(t, rr)) throw new SandboxUnavailableError(`${scope.kind}: the run root ${r} is or contains the temp dir ${t}`);
      }
      if (/^\/private\/tmp\/claude-/.test(rr)) {
        throw new SandboxUnavailableError(`${scope.kind}: the run root ${r} is under /private/tmp/claude-*`);
      }
      for (const h of new Set([homedir(), realOrParent(homedir())])) {
        if (sameOrInside(rr, h) || sameOrInside(h, rr) || sameOrInside(r, h) || sameOrInside(h, r)) {
          throw new SandboxUnavailableError(`${scope.kind}: the run root ${r} overlaps the home directory ${h}`);
        }
      }
      for (const d of denied) {
        for (const [x, y] of [[r, d], [d, r]] as const) {
          if (sameOrInside(x, y) || sameOrInside(realOrParent(x), realOrParent(y))) {
            throw new SandboxUnavailableError(`${scope.kind}: the run root ${r} overlaps ${d}`);
          }
        }
      }
    }
  }
  if (isDev(scope.kind) && (scope.runRoot !== undefined || scope.acceptConfigDir !== undefined || scope.caseDirs !== undefined || scope.oldRunRoot !== undefined)) {
    throw new SandboxUnavailableError(`${scope.kind}: a run root is for acceptance only`);
  }
  if (scope.kind !== "dev-hook") {
    if (scope.gitDirs !== undefined) throw new SandboxUnavailableError(`${scope.kind}: git directories are for git hooks only`);
    return;
  }
  // 4a: a hook writes its repo's git dir (HOOK_GIT_WRITES); the metadata a later unsandboxed git would trust is denied
  // by explicit rules instead of gitProtect, which would deny the whole common dir
  if ((scope.gitProtect ?? []).length > 0) throw new SandboxUnavailableError("dev-hook: git hooks take git directories, not a git write protection list");
  const g = scope.gitDirs;
  if (g === undefined) throw new SandboxUnavailableError("dev-hook: the repository's git directories are missing");
  for (const d of [g.common, g.admin]) {
    if (!isAbsolute(d) || /[\n\r\0]/.test(d) || resolve(d) === "/") throw new SandboxUnavailableError(`dev-hook: invalid git directory ${JSON.stringify(d)}`);
  }
  // 4A-10: the worktree's recorded branch (from the workspace record), always a Slack Off ticket branch
  if (g.branch === undefined || !g.branch.startsWith("refs/heads/") || !isTicketBranch(g.branch.slice("refs/heads/".length))) {
    throw new SandboxUnavailableError(`dev-hook: invalid branch ref ${JSON.stringify(g.branch)}`);
  }
  if (dirname(resolve(g.admin)) !== join(resolve(g.common), "worktrees") || basename(g.admin) === "") {
    throw new SandboxUnavailableError(`dev-hook: ${g.admin} is not a worktree admin directory of ${g.common}`);
  }
  // the git-dir allows come after the SLACKOFF_HOME deny: they must never reopen the platform's own dirs. A repo inside
  // SLACKOFF_HOME (fake mode's fake-repos/) is fine; one around it, or in its worktrees / sandbox / cache dirs, is not
  for (const [c, h] of [[g.common, scope.home], [realOrParent(g.common), realOrParent(scope.home)]] as const) {
    if (sameOrInside(h, c)) throw new SandboxUnavailableError(`dev-hook: the git directory ${g.common} contains SLACKOFF_HOME`);
    for (const own of ["worktrees", "sandbox", "cache"]) {
      if (sameOrInside(c, join(h, own))) throw new SandboxUnavailableError(`dev-hook: the git directory ${g.common} is inside SLACKOFF_HOME/${own}`);
    }
  }
}

/** SLACKOFF_HOME and every directory between it and allowInHome (worktrees/<KEY> → [home, home/worktrees]). */
/** Every ancestor of SLACKOFF_HOME's real path, without "/". */
function homeAncestors(scope: SandboxScope): string[] {
  const out: string[] = [];
  for (let d = dirname(realOrParent(scope.home)); d !== dirname(d); d = dirname(d)) out.unshift(d);
  return out;
}

function allowParents(scope: SandboxScope): string[] {
  const parts = relative(resolve(scope.home), resolve(scope.allowInHome!)).split(/[\\/]/);
  return parts.map((_, i) => join(resolve(scope.home), ...parts.slice(0, i)));
}

const credentialsFor = (scope: SandboxScope, homeDir: string) =>
  credentialPaths(homeDir, scope.home).filter((c) => !(isInstall(scope.kind) && INSTALL_READABLE.has(c.param)));

/** Every `(param …)` of the scope's profile and the path it stands for. Profile and params are built from this one list. */
function profileParams(scope: SandboxScope, homeDir: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ...credentialsFor(scope, homeDir).map((c): [string, string] => [c.param, c.path]),
    ["SLACKOFF_HOME", scope.home],
    ...scope.repos.map((r, i): [string, string] => [`REPO_${i}`, r]),
    ["AGENT_SOCK_DIR", agentSocketDir(homeDir)],
    ["HOME_GNUPG_SOCKETS", join(homeDir, ".gnupg")],
    // T5-6 / T5-7: unix sockets are denied by default; only DNS resolution (mDNSResponder) and the ticket's own dirs
    // are allowed, and the dirs where local daemons listen (tmux, other Claude sessions, launchd's agent sockets, app
    // group containers, Docker) are denied again after that
    // its real path (/var is a symlink): an allow param is checked for symlinks from "/" (4A-12)
    ["MDNS_SOCKET", "/private/var/run/mDNSResponder"],
    ...tempDirs().map((p, i): [string, string] => [`TMP_${i}`, p]),
    ["TMUX_TMP", "/tmp/tmux-"],
    ["CLAUDE_TMP", scope.claudeTmp ?? CLAUDE_TMP_DEFAULT],
    // T7-2 (amended): Claude Code ends every Bash string with `pwd -P >| /tmp/claude-<4 hex>[-<id>]-cwd` (built in sandboxParams)
    ["CLAUDE_CWD_RE", ""],
    ["LAUNCHD_TMP", "/tmp/com.apple.launchd."],
    ["GROUP_CONTAINERS", join(homeDir, "Library/Group Containers")],
    ["HOME_DOCKER", join(homeDir, ".docker")],
  ];
  if (!isDev(scope.kind) && scope.runRoot !== undefined) {
    const shimDir = runShimDir(scope.runRoot);
    entries.push(
      ["RUN_ROOT", scope.runRoot],
      ["RUN_TMP", runTmpDir(scope.runRoot)],
      ["SHIM_DIR", shimDir],
      ["SHIM", join(shimDir, "playwright")],
      ...DEV_FILES.map(([n, p]): [string, string] => [n, p]),
      // T6-2 (C4): Claude Code's transcripts and config (~/.claude, ~/.claude.json and their backups: a prefix)
      ["HOME_CLAUDE", join(homeDir, ".claude")],
      // T6-7 (M5): a symlinked ~/.claude (its target) and ~/.claude.json* where it really lives
      ["HOME_CLAUDE_DIR", join(homeDir, ".claude")],
      ["HOME_CLAUDE_JSON", join(homeDir, ".claude.json")],
      // a path that never exists stands in for a dir that is not configured
      ["ACCEPT_CLAUDE_CONFIG", scope.acceptConfigDir ?? join(homeDir, ".slackoff-no-accept-config")],
      ["SERVER_CLAUDE_CONFIG", serverClaudeConfigDir() ?? join(homeDir, ".slackoff-no-server-config")],
      // T7-6 / T7-7: no .git entry in the work dir, nor <runRoot>/.git
      ["DOTGIT_RE", DOTGIT_RE],
      ["RUN_WORK", join(scope.runRoot, "work")],
      ["RUN_DOTGIT", join(scope.runRoot, ".git")],
      ...(scope.caseDirs !== undefined ? ([["CASE_WORK", scope.caseDirs.work], ["CASE_TMP", scope.caseDirs.tmp]] as Array<[string, string]>) : []),
      ...(scope.oldRunRoot !== undefined ? ([["OLD_RUN_ROOT", scope.oldRunRoot], ["OLD_RUN_READ", `${scope.oldRunRoot}-read-`]] as Array<[string, string]>) : []),
    );
  }
  if (isDev(scope.kind)) {
    entries.push(
      // F-4 (M-2): Claude Code's config (~/.claude.json and its backups: a prefix), resolved and as named; ~/.claude
      // itself stays readable for development commands
      ["HOME_CLAUDE_JSON", join(homeDir, ".claude.json")],
      ["HOME_CLAUDE_JSON_NAME", join(homeDir, ".claude.json")],
      ["HOME_ALLOW", scope.allowInHome!],
      // T7-9: the ancestors of SLACKOFF_HOME (metadata only), for a home under the read-denied claude-* prefix (T5-5)
      ...homeAncestors(scope).map((p, i): [string, string] => [`HOME_UP_${i}`, p]),
      ...allowParents(scope).map((p, i): [string, string] => [`HOME_ALLOW_UP_${i}`, p]),
      ...writableOf(scope).map((p, i): [string, string] => [`WRITE_${i}`, p]),
      ["TICKET_CACHE", ticketCacheDir(scope)],
      ["TICKET_CACHE_UP", join(scope.home, "cache")],
      ...DEV_FILES.map(([n, p]): [string, string] => [n, p]),
      // T5-4: xcrun's lookup cache next to each temp dir (a planted one redirects the /usr/bin/git shim of the
      // platform's unsandboxed git), and other Claude sessions' scratch dirs
      ...tempDirs().map((p, i): [string, string] => [`XCRUN_DB_${i}`, join(p, "xcrun_db")]),
      ...(scope.gitProtect ?? []).map((p, i): [string, string] => [`GIT_${i}`, p]),
      ["HOME_GITCONFIG", join(homeDir, ".gitconfig")],
      ["HOME_GITCONFIG_DIR", join(homeDir, ".config/git")],
      // F4A-2 (C-B): no .git path component inside a worktree
      ["DOTGIT_RE", DOTGIT_RE],
    );
  }
  if (scope.kind === "dev-hook") {
    // 4a HOOK_GIT_WRITES (spike §1): what a lint-staged-style hook writes in a linked worktree, and what stays denied
    const { common, admin, branch } = scope.gitDirs!;
    entries.push(
      ["COMMON_GIT", common],
      ["COMMON_GIT_OBJECTS", join(common, "objects")],
      // F4A-1: packs (and their idx / midx / rev) and objects/info (alternates, commit-graph) are never written, and
      // an existing loose object (or its fan-out dir) is never deleted, replaced or chmodded: new objects only
      ["OBJECTS_PACK", join(common, "objects/pack")],
      ["OBJECTS_INFO", join(common, "objects/info")],
      ["LOOSE_OBJECT_RE", looseObjectRe(realOrParent(join(common, "objects")))],
      ["COMMON_GIT_REFS", join(common, "refs")],
      ["COMMON_GIT_LOGS", join(common, "logs")],
      // 4A-5: of the refs, only the stash and the ticket's own branch (and their logs)
      ["COMMON_GIT_STASH", join(common, "refs/stash")],
      ["COMMON_GIT_STASH_LOCK", join(common, "refs/stash.lock")],
      ["COMMON_GIT_STASH_LOG", join(common, "logs/refs/stash")],
      ["COMMON_GIT_STASH_LOG_LOCK", join(common, "logs/refs/stash.lock")],
      ...(branch !== undefined
        ? ([
            ["COMMON_GIT_BRANCH", join(common, branch)],
            ["COMMON_GIT_BRANCH_LOCK", join(common, `${branch}.lock`)],
            ["COMMON_GIT_BRANCH_LOG", join(common, "logs", branch)],
            ["COMMON_GIT_BRANCH_LOG_LOCK", join(common, "logs", `${branch}.lock`)],
          ] as Array<[string, string]>)
        : []),
      ["COMMON_GIT_PACKED_REFS", join(common, "packed-refs")],
      ["COMMON_GIT_PACKED_REFS_LOCK", join(common, "packed-refs.lock")],
      ["COMMON_GIT_CONFIG", join(common, "config")],
      ["COMMON_GIT_HOOKS", join(common, "hooks")],
      ["COMMON_GIT_INFO", join(common, "info")],
      ["ADMIN_GIT", admin],
      ["ADMIN_GIT_COMMONDIR", join(admin, "commondir")],
      ["ADMIN_GIT_GITDIR", join(admin, "gitdir")],
      ["ADMIN_GIT_CONFIG_WORKTREE", join(admin, "config.worktree")],
      // 4A-10: the worktree's HEAD (the branch the platform commits to)
      ["ADMIN_GIT_HEAD", join(admin, "HEAD")],
      ["ADMIN_GIT_HEAD_LOCK", join(admin, "HEAD.lock")],
      ...writableOf(scope).map((p, i): [string, string] => [`WT_DOTGIT_${i}`, join(p, ".git")]),
      // a common dir inside SLACKOFF_HOME (fake mode): git resolves its real path (lstat of each parent)
      ...commonParentsInHome(scope).map((p, i): [string, string] => [`COMMON_GIT_UP_${i}`, p]),
    );
  }
  return entries;
}

/** dev-hook: the dirs strictly between SLACKOFF_HOME and a git common dir inside it (none for a repo outside it). */
function commonParentsInHome(scope: SandboxScope): string[] {
  const home = realOrParent(scope.home);
  const rel = relative(home, realOrParent(scope.gitDirs!.common));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return [];
  const parts = rel.split(/[\\/]/);
  return parts.slice(0, -1).map((_, i) => join(home, ...parts.slice(0, i + 1)));
}

const names = (scope: SandboxScope, prefix: string) =>
  profileParams(scope, "/").filter(([n]) => n.startsWith(prefix)).map(([n]) => n);
const sub = (n: string) => `(subpath (param "${n}"))`;
const pre = (n: string) => `(prefix (param "${n}"))`;
const us = (filter: string) => `(remote unix-socket ${filter})`;
/** dev-*: the repo worktree(s) and the ticket cache; acceptance-* with a run root: its tmp dir (T6-1). Sockets a
 * command creates there are its own. */
const ownDirs = (scope: SandboxScope): string[] =>
  isDev(scope.kind) ? [...names(scope, "WRITE_").map(sub), sub("TICKET_CACHE")] : scope.caseDirs !== undefined ? [sub("CASE_TMP")] : scope.runRoot !== undefined ? [sub("RUN_TMP")] : [];
const lit = (n: string) => `(literal (param "${n}"))`;

/**
 * The fixed SBPL text; paths only appear as `(param "NAME")` (spike §6.1). Later rules win, so the order matters:
 * - every scope: no signals out of the sandbox (a SIGUSR1 opens a Node process's inspector), no TCP to or listening on
 *   Slack Off's and the inspector's ports, no credentials, no SLACKOFF_HOME (acceptance: no mapped repos either);
 * - dev-*: writes only to this repo's worktree, temp dirs, package caches and /dev (T5-3), reads in the ticket
 *   directory, metadata of its parents; last, git metadata and the user's git config are never writable (a planted
 *   core.fsmonitor / filter / sshCommand would run in the platform's unsandboxed git);
 * - acceptance-* (T6-1, T6-2): writes only to the run root and /dev, nothing unlinked (so renamed) anywhere but inside
 *   the run root, its tmp dir the only own unix-socket dir; Claude Code's transcripts and config dirs unreadable; the
 *   shim dir and the run root itself never written or moved; every deny repeated for unlink last.
 */
/** T7-2 (amended): only creating or writing a regular file with the cwd-file name; no read, no unlink, no symlink,
 * directory, fifo or hard link (a plant there would redirect another, unsandboxed Claude session's write). */
const CWD_FILE_RULE = '(allow file-write-create file-write-data (require-all (regex (param "CLAUDE_CWD_RE")) (vnode-type REGULAR-FILE)))';

/** F-3: the keychain daemons' mach services (from /System/Library/Launch{Daemons,Agents}/*.plist MachServices). */
const KEYCHAIN_DENY =
  '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name-prefix "com.apple.securityd.") (global-name-prefix "com.apple.security.agent") (global-name "com.apple.security.KeychainStasher") (global-name "com.apple.security.kcsharing") (global-name "com.apple.security.octagon") (global-name "com.apple.security.cloudkeychainproxy3") (global-name "com.apple.keychainsharingmessagingd"))';

/**
 * F-3: the self-check's keychain item. No runtime probe can reach securityd without reading or changing keychain
 * contents (every client of it is a keychain client), so the deny is proven on the profile text: the line is present,
 * names both daemons, and no later rule allows a mach-lookup.
 */
export function profileDeniesKeychain(profile: string): boolean {
  const lines = profile.split("\n");
  const i = lines.indexOf(KEYCHAIN_DENY);
  return i >= 0 && KEYCHAIN_DENY.includes('"com.apple.SecurityServer"') && KEYCHAIN_DENY.includes('"com.apple.securityd.xpc"') && !lines.slice(i + 1).some((l) => /^\(allow mach-lookup/.test(l));
}

/**
 * phase 4a Task 4, allowlist mode only (spike §3 E3): explicit tcp4 / tcp6 filters (a plain `tcp "localhost:*"` misses
 * IPv4-mapped addresses and stops matching IPv4 next to `tcp6 "*:*"`); `localhost` covers every address of this
 * machine (Tailscale too). Before the DENIED_PORTS deny, which therefore always wins.
 */
function loopbackAllowlist(scope: SandboxScope): string[] {
  const n = scope.localNetwork;
  if (n === undefined) return [];
  const ports = [...new Set(n.allowPorts)].sort((a, b) => a - b);
  return [
    '(deny network-outbound (remote tcp6 "*:*"))',
    '(deny network-outbound (remote tcp4 "localhost:*"))',
    ...(ports.length > 0 ? [`(allow network-outbound ${ports.map((p) => `(remote tcp4 "localhost:${p}") (remote tcp6 "localhost:${p}")`).join(" ")})`] : []),
  ];
}

export function sandboxProfile(scope: SandboxScope): string {
  checkScope(scope);
  const deny = [
    ...credentialsFor(scope, "/").map((c) => (c.literal ? lit(c.param) : sub(c.param))),
    sub("SLACKOFF_HOME"),
    ...scope.repos.map((_, i) => sub(`REPO_${i}`)),
  ];
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    ...loopbackAllowlist(scope),
    `(deny network-outbound ${portsOf(scope).map((p) => `(remote tcp "*:${p}")`).join(" ")})`,
    `(deny network-bind ${portsOf(scope).map((p) => `(local tcp "*:${p}")`).join(" ")})`,
    // T5-4: no LaunchServices (opening an app runs it outside the sandbox), no Apple events, no pasteboard
    '(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd.") (global-name "com.apple.launchservicesd") (global-name "com.apple.pasteboard.1"))',
    // F-3: no keychain — securityd (the file keychain behind git's osxkeychain helper, gh's token) and secd (the data
    // protection keychain), and the keychain agents; trustd (certificate trust for TLS) stays reachable
    KEYCHAIN_DENY,
    "(deny appleevent-send)",
    // T5-6: unix sockets deny-by-default (a local daemon — tmux, Docker — would run anything outside the sandbox).
    // T5-7: never the temp dirs (VS Code, Chrome, JetBrains, proxies and VPNs listen there); a command's TMPDIR is
    // the ticket cache's tmp dir
    "(deny network-outbound (remote unix-socket))",
    `(allow network-outbound ${[lit("MDNS_SOCKET"), ...ownDirs(scope)].map(us).join(" ")})`,
    `(deny network-outbound ${[pre("TMUX_TMP"), pre("CLAUDE_TMP"), pre("LAUNCHD_TMP"), sub("GROUP_CONTAINERS"), sub("HOME_DOCKER")].map(us).join(" ")})`,
    // the ticket's / run's own dirs again (a SLACKOFF_HOME or run root under /private/tmp/claude-*, T5-5)
    ...(ownDirs(scope).length > 0 ? [`(allow network-outbound ${ownDirs(scope).map(us).join(" ")})`] : []),
    // T5-4: the user's ssh and gpg agents (they sign and authenticate as the user), last
    `(deny network-outbound (remote unix-socket ${sub("AGENT_SOCK_DIR")}) (remote unix-socket ${sub("HOME_GNUPG_SOCKETS")}))`,
  ];
  if (isDev(scope.kind)) {
    const devFiles = DEV_FILES.map(([n, , literal]) => (literal ? lit(n) : sub(n)));
    lines.push(
      "(deny file-write*)",
      `(allow file-write* ${names(scope, "TMP_").map(sub).join(" ")} ${devFiles.join(" ")})`,
      // T5-8: nothing is unlinked or renamed out of the temp dirs (a daemon's socket moved into the worktree would be
      // reachable through the own-dirs socket allow). Before the re-allow of the platform's own dirs (T5-5: a home
      // under /private/tmp keeps rm / mv working there). The write allow itself stays (pnpm's store lock).
      `(deny file-write-unlink ${names(scope, "TMP_").map(sub).join(" ")})`,
    );
  }
  if (!isDev(scope.kind)) {
    const devFiles = DEV_FILES.map(([n, , literal]) => (literal ? lit(n) : sub(n)));
    lines.push(
      // T6-2 (C3): a write allowlist — the run root (work, tmp, per-run caches) and /dev only
      "(deny file-write*)",
      // 4F-1: a case writes only its own work and tmp dirs
      `(allow file-write* ${scope.caseDirs !== undefined ? `${sub("CASE_WORK")} ${sub("CASE_TMP")}` : sub("RUN_ROOT")} ${devFiles.join(" ")})`,
      // T6-2 (C2): nothing is unlinked, so nothing renamed, anywhere (a daemon's socket moved into the run's tmp dir would
      // be reachable through its socket allow, from a temp dir or from ~/.colima, ~/.orbstack, /private/var/tmp…)
      "(deny file-write-unlink)",
    );
  }
  lines.push(`(deny file-read* file-write* ${deny.join(" ")})`);
  // 4F-7 (I-1): the platform's re-run never reads the agent's old run root or its transcript dirs
  if (scope.oldRunRoot !== undefined) lines.push(`(deny file-read* file-write* ${sub("OLD_RUN_ROOT")} ${pre("OLD_RUN_READ")})`, `(deny file-write-unlink ${sub("OLD_RUN_ROOT")} ${pre("OLD_RUN_READ")})`);
  if (!isDev(scope.kind)) {
    lines.push(
      // T6-2 (C4): Claude Code's transcripts and config hold the design and debate text; other sessions' /tmp dirs too
      `(deny file-read* file-write* ${[pre("HOME_CLAUDE"), sub("HOME_CLAUDE_DIR"), pre("HOME_CLAUDE_JSON"), sub("ACCEPT_CLAUDE_CONFIG"), sub("SERVER_CLAUDE_CONFIG"), pre("CLAUDE_TMP")].join(" ")})`,
      CWD_FILE_RULE,
      // the run root again, after that deny (T5-5: a run root under /private/tmp/claude-*)
      ...(scope.caseDirs !== undefined
        ? [`(allow file-read* ${sub("RUN_ROOT")})`, `(allow file-read* file-write* ${sub("CASE_WORK")} ${sub("CASE_TMP")})`]
        : [`(allow file-read* file-write* ${sub("RUN_ROOT")})`]),
      // the run root is the platform's own dir: rm / mv keep working inside it. An operation-specific rule beats
      // file-write* whatever the order (§6.9), so every deny below is repeated for unlink
      `(allow file-write-unlink ${scope.caseDirs !== undefined ? `${sub("CASE_WORK")} ${sub("CASE_TMP")}` : sub("RUN_ROOT")})`,
      // T7-6 / T7-7: no git repository can be planted in the work dir or as <runRoot>/.git (the unsandboxed claude's own
      // git would read it); the run's caches and tmp may hold git dependencies a package manager clones
      `(deny file-write-create (require-all ${sub("RUN_WORK")} (regex (param "DOTGIT_RE"))) ${lit("RUN_DOTGIT")})`,
      // T6-2 (C1): the platform's shim (run unsandboxed by the caller's wrapper) is never written, chmodded or moved
      `(deny file-write* ${sub("SHIM_DIR")} ${lit("SHIM")})`,
      // ... and the run root itself is not moved away (a fresh one with another bin/ in its place)
      `(deny file-write-unlink ${sub("SHIM_DIR")} ${lit("SHIM")} ${lit("RUN_ROOT")})`,
      `(deny file-write-unlink ${[...deny, pre("HOME_CLAUDE"), sub("HOME_CLAUDE_DIR"), pre("HOME_CLAUDE_JSON"), sub("ACCEPT_CLAUDE_CONFIG"), sub("SERVER_CLAUDE_CONFIG")].join(" ")})`,
    );
  }
  if (isDev(scope.kind)) {
    lines.push(
      // T5-4: other Claude sessions' scratch dirs. Before the platform's own allows (T5-5): a SLACKOFF_HOME under such a
      // path keeps its worktree and ticket cache writable, everything else there stays denied
      // T7-9: other sessions' files are not readable either (the platform's own dirs are re-allowed below, T5-5)
      '(deny file-read* file-write* (prefix (param "CLAUDE_TMP")))',
      // F-4 (M-2): Claude Code's config holds the projects' history and settings
      `(deny file-read* file-write* ${pre("HOME_CLAUDE_JSON")} ${pre("HOME_CLAUDE_JSON_NAME")})`,
      `(allow file-read-metadata ${names(scope, "HOME_UP_").map(lit).join(" ")})`,
      CWD_FILE_RULE,
      `(allow file-read* ${sub("HOME_ALLOW")})`,
      `(allow file-write* ${names(scope, "WRITE_").map(sub).join(" ")})`,
      `(allow file-read* file-write* ${sub("TICKET_CACHE")})`,
      // T5-8: a rule for one operation beats a file-write* rule whatever the order (spike §6.9), so the unlink deny on
      // the temp dirs is lifted for the platform's own dirs explicitly, and the denies below repeat it for unlink
      `(allow file-write-unlink ${[...names(scope, "WRITE_").map(sub), sub("TICKET_CACHE")].join(" ")})`,
      // a program run from the worktree resolves its real path (lstat of every parent): their metadata only
      `(allow file-read-metadata ${[...names(scope, "HOME_ALLOW_UP_"), "TICKET_CACHE_UP"].map(lit).join(" ")})`,
      `(deny file-write* ${[...names(scope, "GIT_").map(sub), lit("HOME_GITCONFIG"), sub("HOME_GITCONFIG_DIR")].join(" ")})`,
      `(deny file-write-unlink ${[...names(scope, "GIT_").map(sub), lit("HOME_GITCONFIG"), sub("HOME_GITCONFIG_DIR")].join(" ")})`,
      `(deny file-write* ${names(scope, "XCRUN_DB_").map(lit).join(" ")})`,
      `(deny file-write-unlink ${names(scope, "XCRUN_DB_").map(lit).join(" ")})`,
    );
  }
  if (scope.kind === "dev-hook") {
    // 4a (A-2 narrowed by 4A-1): the repo's objects, refs, reflogs, packed-refs and this worktree's admin dir (index,
    // HEAD, COMMIT_EDITMSG, stash's temporary index…) are writable — for unlink too, which beats file-write* (T5-8)
    // 4A-5: refs narrowed to the stash and the ticket's own branch (other branches and tags stay read only)
    const writes = [
      sub("COMMON_GIT_OBJECTS"), lit("COMMON_GIT_STASH"), lit("COMMON_GIT_STASH_LOCK"), lit("COMMON_GIT_STASH_LOG"), lit("COMMON_GIT_STASH_LOG_LOCK"),
      ...names(scope, "COMMON_GIT_BRANCH").map(lit), sub("ADMIN_GIT"),
    ].join(" ");
    // last: what the platform's unsandboxed git trusts (config, hooks, info; a worktree's commondir / gitdir links,
    // its config.worktree and .git pointer) is never written or replaced, even under a broader allow (T5-5)
    const denied = [
      // 4A-8: packed-refs holds every branch: never written from a hook
      lit("COMMON_GIT_CONFIG"), lit("COMMON_GIT_PACKED_REFS"), lit("COMMON_GIT_PACKED_REFS_LOCK"), sub("COMMON_GIT_HOOKS"), sub("COMMON_GIT_INFO"), lit("ADMIN_GIT_COMMONDIR"), lit("ADMIN_GIT_GITDIR"),
      lit("ADMIN_GIT_CONFIG_WORKTREE"), lit("ADMIN_GIT_HEAD"), lit("ADMIN_GIT_HEAD_LOCK"), ...names(scope, "WT_DOTGIT_").map(lit),
    ].join(" ");
    lines.push(
      // 4A-7: a git dir inside the denied SLACKOFF_HOME (fake mode's fake-repos/) is readable again, with the metadata of
      // the dirs above it there; a repo outside SLACKOFF_HOME needs no re-allow
      ...(names(scope, "COMMON_GIT_UP_").length > 0
        ? [`(allow file-read* ${sub("COMMON_GIT")})`, `(allow file-read-metadata ${names(scope, "COMMON_GIT_UP_").map(lit).join(" ")})`]
        : []),
      // nothing else in the common dir (HEAD, new root files, other worktrees' admin dirs), even when the repo lies in
      // a temp dir the dev rules allow (gitProtect's role for dev-command)
      `(deny file-write* ${sub("COMMON_GIT")})`,
      `(deny file-write-unlink ${sub("COMMON_GIT")})`,
      `(allow file-write* ${writes})`,
      `(allow file-write-unlink ${writes})`,
      // 4A-12: no symlink is created anywhere in the git dirs (a ref literal turned into a link to ~/.zshrc would be
      // written through by the platform's unsandboxed git, and redirect a later profile's allow)
      `(deny file-write-create (require-all ${sub("COMMON_GIT")} (vnode-type SYMLINK)))`,
      `(deny file-write* ${denied})`,
      // ... and the common and admin dirs, objects/, refs/ and logs/ themselves are not moved away (4A-5)
      `(deny file-write-unlink ${denied} ${[lit("COMMON_GIT"), lit("ADMIN_GIT"), lit("COMMON_GIT_OBJECTS"), lit("COMMON_GIT_REFS"), lit("COMMON_GIT_LOGS")].join(" ")})`,
      // F4A-1 (C-A): objects are added, never replaced — a forged blob swapped in for main's .slackoff/config.json would
      // be read by the platform's unsandboxed git. Creation (git's tmp file + link / rename to a new name) stays allowed
      `(deny file-write-data file-write-mode file-write-unlink (regex (param "LOOSE_OBJECT_RE")))`,
      `(deny file-write* ${sub("OBJECTS_PACK")} ${sub("OBJECTS_INFO")})`,
      `(deny file-write-unlink ${sub("OBJECTS_PACK")} ${sub("OBJECTS_INFO")})`,
    );
  }
  if (isDev(scope.kind)) {
    // 4A-3: the worktree root itself is never renamed, swapped or replaced (a worktree moved out and back with a forged
    // .git would hand the platform's unsandboxed git another repository's config); writes inside it stay allowed
    const roots = names(scope, "WRITE_").map(lit).join(" ");
    lines.push(`(deny file-write* ${roots})`, `(deny file-write-unlink ${roots})`);
    // 4A-9: nor the ticket cache, the cache root or the ticket dir (one moved away and replaced by a symlink would
    // redirect the next scope's realpath'd allows, e.g. to $HOME)
    const own = [lit("TICKET_CACHE"), lit("TICKET_CACHE_UP"), lit("HOME_ALLOW")].join(" ");
    lines.push(`(deny file-write* ${own})`, `(deny file-write-unlink ${own})`);
    // F4A-2 (C-B): no git repository is planted in a worktree (a nested repo's config — a clean filter — would run in
    // the platform's unsandboxed git status / add); the ticket cache may hold git dependencies a package manager clones
    const dotgit = names(scope, "WRITE_").map((w) => `(require-all ${sub(w)} (regex (param "DOTGIT_RE")))`).join(" ");
    lines.push(`(deny file-write-create ${dotgit})`);
  } else if (scope.runRoot !== undefined) {
    // 4A-9: the run's tmp dir (its unix-socket allow) is never moved away or replaced
    lines.push(`(deny file-write* ${lit("RUN_TMP")})`, `(deny file-write-unlink ${lit("RUN_TMP")})`);
    // 4F-1: nor a case's own work and tmp dirs (one moved away and replaced by a link would redirect the platform)
    if (scope.caseDirs !== undefined) {
      const own = `${lit("CASE_WORK")} ${lit("CASE_TMP")}`;
      lines.push(`(deny file-write* ${own})`, `(deny file-write-unlink ${own})`);
    }
  }
  // phase 4b Task 2 (X-4): the API token / key file, last — no allow above (a git dir or ticket dir inside
  // SLACKOFF_HOME) ever reopens it
  lines.push(`(deny file-read* file-write* ${lit("SLACKOFF_CREDENTIALS")})`, `(deny file-write-unlink ${lit("SLACKOFF_CREDENTIALS")})`);
  return lines.join("\n") + "\n";
}

/** The real path of `p`; a missing path is its nearest existing parent's real path plus the rest (/tmp → /private/tmp). */
function realOrParent(p: string): string {
  if (!isAbsolute(p)) throw new SandboxUnavailableError(`sandbox path ${JSON.stringify(p)} is not absolute`);
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Deny params resolved on their parent dir only (the name itself may be a symlink); every allow param is too (4A-12).
 * 4A-13: the tmux and launchd socket-dir prefixes as well (names, not dirs: never followed through a link there).
 */
export const PARENT_ONLY_PARAMS: ReadonlySet<string> = new Set(["HOME_CLAUDE", "HOME_CLAUDE_JSON_NAME", "TMUX_TMP", "LAUNCHD_TMP", "OLD_RUN_READ"]);

/** `-D NAME=<realpath>` for every param of the scope's profile. */
export function sandboxParams(scope: SandboxScope, homeDir: string = homedir()): string[] {
  checkScope(scope);
  checkAllowPaths(scope);
  const out: string[] = [];
  const params = profileParams(scope, homeDir);
  const claudeTmp = params.find(([n]) => n === "CLAUDE_TMP")![1];
  // 4A-12: an allow param is resolved on its parent dir only — a symlink in its place never moves the allow to its target
  const allow = new Set(allowParamNames(scope));
  for (const [name, raw] of params) {
    const path = name === "CLAUDE_CWD_RE" ? cwdFileRe(realOrParent(claudeTmp)) : raw;
    if (/[\n\r\0]/.test(path)) throw new SandboxUnavailableError(`sandbox path for ${name} contains a newline or NUL`);
    if (REGEX_PARAMS.has(name)) {
      out.push("-D", `${name}=${path}`);
      continue;
    }
    // T6-7 (M5): HOME_CLAUDE is a prefix of the literal name (only the home dir resolved), so it keeps covering
    // ~/.claude.json* when ~/.claude is a symlink; HOME_CLAUDE_DIR / HOME_CLAUDE_JSON are the resolved paths
    const real = PARENT_ONLY_PARAMS.has(name) || allow.has(name) ? join(realOrParent(dirname(path)), basename(path)) : realOrParent(path);
    if (/[\n\r\0]/.test(real)) throw new SandboxUnavailableError(`sandbox path for ${name} contains a newline or NUL`);
    out.push("-D", `${name}=${real}`);
  }
  return out;
}

/** `sandbox-exec -p <profile> -D … <file> <args>`: sandbox-exec execvp's `file` (same pid, the process group stays killable). */
export function sandboxArgv(scope: SandboxScope, file: string, args: readonly string[]): { file: string; args: string[] } {
  return { file: SANDBOX_EXEC, args: ["-p", sandboxProfile(scope), ...sandboxParams(scope), file, ...args] };
}

/** T5-6: a system socket outside every allowed dir; harmless to connect to (a datagram socket: a stream connect fails
 * with EPROTOTYPE outside the sandbox, EPERM inside). */
const UNIX_PROBE = "/private/var/run/syslog";

/** T5-7: where the self-check puts its own scratch socket: each temp dir (outside the socket allow), except under
 * /private/tmp/claude-* (not writable inside the dev sandbox, T5-4). The caller makes a scratch dir in each (the dev
 * sandbox cannot remove anything there, T5-8) and removes it after the check. */
const scratchSocketDirs = (): string[] => tempDirs().filter((d) => !d.startsWith("/private/tmp/claude-"));
/** T6-2 (C2): acceptance kinds also probe a daemon socket outside the temp dirs (a system temp dir no rule names). */
const NON_TEMP_SCRATCH = "/private/var/tmp";
const scratchDirsFor = (scope: SandboxScope): string[] =>
  isDev(scope.kind) ? scratchSocketDirs() : [...new Set([...scratchSocketDirs(), realOrParent(NON_TEMP_SCRATCH)])];
/** `slackoff-sc-<pid of the process that made it>-XXXXXX` */
const SCRATCH_RE = /^slackoff-sc-(\d+)-[A-Za-z0-9]{6}$/;

/** Remove scratch dirs whose maker is gone (a wrapper killed with SIGKILL mid-check cannot clean up after itself). */
function sweepStaleScratch(): void {
  for (const d of new Set([...scratchSocketDirs(), realOrParent(NON_TEMP_SCRATCH)])) {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of entries) {
      const m = SCRATCH_RE.exec(n);
      if (m === null) continue;
      try {
        process.kill(Number(m[1]), 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(d, n), { recursive: true, force: true });
      }
    }
  }
}

/**
 * The self-check's arguments: the denied file, the denied ports, a scratch dir per temp dir, a process outside the
 * sandbox, the allowed dir; dev-*: the own dir (the ticket's tmp dir) a scratch socket must not be movable into (T5-8).
 * acceptance-* (T6-2): the sandbox cannot create a socket outside its run root, so the caller listens on `<scratch>/s`
 * (`--unix-peer`); the check must not be able to reach or move it, nor write in the scratch dirs or the shim dir, nor
 * read the acceptance agent's config dir.
 */
/** F-4 (M-3): `--remote <ip>:<SERVER_PORT>` for each Tailscale address the server listens on. */
const remoteProbes = (scope: SandboxScope): string[] => (scope.remoteHosts ?? []).flatMap((h) => ["--remote", `${h}:${SERVER_PORT}`]);

function selfCheckArgs(scope: SandboxScope, outsidePid: string, scratch: readonly string[], undeclared: number | null = null): string[] {
  const db = join(scope.home, "slackoff.db");
  const acceptance = !isDev(scope.kind) && scope.runRoot !== undefined;
  return [
    SELF_CHECK_SCRIPT,
    existsSync(db) ? db : scope.home,
    ...portsOf(scope).map(String),
    "--unix",
    UNIX_PROBE,
    ...(acceptance
      ? [
          ...scratch.flatMap((d) => ["--unix-peer", join(d, "s")]),
          ...[...scratch, runShimDir(scope.runRoot!)].flatMap((d) => ["--no-write", d]),
          ...(scope.acceptConfigDir !== undefined && existsSync(scope.acceptConfigDir) ? ["--denied-read", scope.acceptConfigDir] : []),
        ]
      : scratch.flatMap((d) => ["--unix-scratch", d])),
    ...(isDev(scope.kind) ? ["--own", ticketTmpDir(scope)] : scope.runRoot !== undefined ? ["--own", runTmpDir(scope.runRoot)] : []),
    "--signal",
    outsidePid,
    "--launchservices",
    ...remoteProbes(scope),
    ...(scope.allowInHome !== null ? ["--allowed", scope.allowInHome] : []),
    // 4a: a hook can write its worktree's admin dir but not the repo's config
    ...(scope.kind === "dev-hook" ? ["--git-admin", scope.gitDirs!.admin, "--git-config", join(scope.gitDirs!.common, "config")] : []),
    // phase 4a Task 4: allowlist mode — the check's own listener on an undeclared port must be unreachable
    ...(undeclared !== null ? ["--undeclared", String(undeclared)] : []),
  ];
}

/**
 * T7-1: the acceptance wrapper's per-command check. The sandboxed check cannot listen on a socket outside the run root
 * and the wrapper has no listener of its own, so there are no unix-peer probes (the server runs the full
 * sandboxSelfCheck for the scope before the agent starts); the rest stays: the denied DB, every denied port, a system
 * socket, the shim dir unwritable, the agent's config dir unreadable, no signal out, no LaunchServices.
 */
function acceptanceWrapperCheckArgs(scope: SandboxScope, outsidePid: string): string[] {
  const db = join(scope.home, "slackoff.db");
  return [
    SELF_CHECK_SCRIPT,
    existsSync(db) ? db : scope.home,
    ...portsOf(scope).map(String),
    "--unix",
    UNIX_PROBE,
    "--no-write",
    runShimDir(scope.runRoot!),
    ...(scope.acceptConfigDir !== undefined && existsSync(scope.acceptConfigDir) ? ["--denied-read", scope.acceptConfigDir] : []),
    "--signal",
    outsidePid,
    "--launchservices",
    ...remoteProbes(scope),
  ];
}

/**
 * Prove the deny before use, with the same sandbox-exec line and the same node as the real run: connects to every
 * denied port, opening the DB (the home directory itself while there is no DB yet) and signalling a process outside
 * the sandbox (this server, signal 0) must fail with EPERM, and the allowed ticket directory must be listable. Never
 * depends on anything listening; the only listener is the check's own scratch socket in each temp dir (T5-7), which
 * it removes again.
 */
/** F-3: the self-check's keychain item (profile text only, see profileDeniesKeychain) */
const KEYCHAIN_ITEM = "keychain:DENIED-IN-PROFILE (runtime not probed)";

/** phase 4a Task 5: which command sandbox this computer has. Only macOS's sandbox-exec exists; elsewhere nothing. */
export interface SandboxBackend {
  name: "sandbox-exec" | "none";
  available: boolean;
  reason: string | null;
}

export function sandboxBackend(o: { platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {}): SandboxBackend {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? existsSync;
  if (platform !== "darwin") return { name: "none", available: false, reason: `sandbox-exec is not available on ${platform}` };
  if (!exists(SANDBOX_EXEC)) return { name: "none", available: false, reason: `sandbox-exec is not available (${SANDBOX_EXEC} is missing)` };
  return { name: "sandbox-exec", available: true, reason: null };
}

/** phase 4a Task 5: the line the server prints at startup when there is no sandbox (null when there is one). */
export function sandboxUnavailableNotice(b: SandboxBackend): string | null {
  if (b.available) return null;
  return `Command sandbox unavailable: ${b.reason}. Development commands, git hooks and acceptance will not run unless you turn on the opt-outs (README → Security model and residual risks).`;
}

export async function sandboxSelfCheck(scope: SandboxScope, o: { node?: string; platform?: NodeJS.Platform } = {}): Promise<SandboxCheck> {
  const backend = sandboxBackend({ platform: o.platform ?? process.platform });
  if (!backend.available) return { ok: false, detail: backend.reason! };
  let argv;
  const scratch: string[] = [];
  const peers: Server[] = [];
  const closePeers = () => Promise.all(peers.map((p) => new Promise<void>((res) => p.close(() => res()))));
  try {
    sweepStaleScratch();
    for (const d of scratchDirsFor(scope)) scratch.push(mkdtempSync(join(d, `slackoff-sc-${process.pid}-`)));
    checkAllowPaths(scope);
    if (isDev(scope.kind)) mkdirNoFollow(scope.home, ticketTmpDir(scope));
    else if (scope.runRoot !== undefined) {
      mkdirNoFollow(scope.runRoot, runTmpDir(scope.runRoot));
      mkdirNoFollow(scope.runRoot, runShimDir(scope.runRoot));
      // T6-2: this process is the "daemon" the acceptance check must not reach (the sandbox cannot listen there)
      for (const d of scratch) {
        peers.push(
          await new Promise<Server>((res, rej) => {
            const sv = createServer((c) => c.destroy());
            sv.once("error", rej);
            sv.listen(join(d, "s"), () => res(sv));
          }),
        );
      }
    }
    // phase 4a Task 4: in allowlist mode this process listens on a port the scope does not declare, on loopback only
    // (4A-15: 127.0.0.1 and ::1 — the IPv4-mapped probe reaches the 127.0.0.1 one); the sandboxed check must not reach it
    let undeclared: number | null = null;
    if (scope.localNetwork !== undefined) {
      const listen = (host: string, port: number) =>
        new Promise<Server>((res, rej) => {
          const s = createServer((c) => c.destroy());
          s.once("error", rej);
          s.listen({ port, host, ipv6Only: host === "::1" }, () => res(s));
        });
      for (let tries = 0; undeclared === null && tries < 5; tries++) {
        const v4 = await listen("127.0.0.1", 0);
        peers.push(v4);
        const p = (v4.address() as { port: number }).port;
        if (scope.localNetwork.allowPorts.includes(p)) continue;
        try {
          peers.push(await listen("::1", p));
          undeclared = p;
        } catch {
          // ::1 has that port taken: try another one
        }
      }
      if (undeclared === null) throw new SandboxUnavailableError("no undeclared port to probe");
    }
    argv = sandboxArgv(scope, o.node ?? process.execPath, selfCheckArgs(scope, String(process.pid), scratch, undeclared));
    if (!profileDeniesKeychain(argv.args[1]!)) throw new SandboxUnavailableError("the profile does not deny the keychain daemons");
  } catch (err) {
    await closePeers();
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
    return { ok: false, detail: `sandbox self-check could not start: ${(err as Error).message}` };
  }
  try {
    const r = await runProcess(argv.file, argv.args, { timeoutMs: SELF_CHECK_TIMEOUT_MS, maxOutput: 64 * 1024 });
    const out = r.stdout.trim();
    if (r.timedOut) return { ok: false, detail: `sandbox self-check timed out ${out}`.trim() };
    if (r.code === 0) return { ok: true, detail: `${out} ${KEYCHAIN_ITEM}` };
    const err = r.stderr.trim().split("\n").slice(-2).join(" ");
    return { ok: false, detail: `sandbox self-check failed: ${[out, err].filter((x) => x !== "").join(" ") || `exit ${r.code}`}` };
  } catch (err) {
    return { ok: false, detail: `sandbox self-check could not start: ${(err as Error).message}` };
  } finally {
    await closePeers();
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  }
}

/**
 * Development commands only (acceptance never uses the switch: a failed self-check there is always not_executed):
 * a passing self-check → sandboxed; otherwise unsandboxed when development.allowUnsandboxedCommands is on; otherwise
 * refused with the reason and the switch.
 */
export async function commandSandbox(
  config: Config,
  scope: SandboxScope,
  check: (s: SandboxScope) => Promise<SandboxCheck> = sandboxSelfCheck,
): Promise<CommandSandbox> {
  const c = await check(scope);
  if (c.ok) return { kind: "sandboxed", scope };
  if (config.development.allowUnsandboxedCommands) return { kind: "unsandboxed", reason: c.detail };
  throw new SandboxUnavailableError(
    `${c.detail} — repository commands are not run without the sandbox. To run them anyway, turn on Settings → Development → "Run repository commands without the sandbox" on this computer`,
  );
}

// ---- R-LOCAL-3 / ruling T5-1: every Bash command of the dev agent runs under the profile ----

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const SHELL_NAMES = new Set(["zsh", "bash"]);

/**
 * The shell Claude Code runs Bash commands with (its snapshot is written for it): $SHELL when it is an absolute zsh or
 * bash, otherwise /bin/zsh (macOS default).
 */
export function agentShell(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SHELL ?? "";
  return isAbsolute(s) && SHELL_NAMES.has(basename(s)) && !/[\n\r\0]/.test(s) ? s : "/bin/zsh";
}

/**
 * (Re)write `<dir>/shell-prefix`, the dev agent's CLAUDE_CODE_SHELL_PREFIX. Claude Code runs every Bash command as
 * `<prefix> '<one command string>'` (the string sources its shell snapshot, then evals the command; spike §6.4), so
 * the wrapper covers every command whatever PATH, alias or function the snapshot sets, and path-like programs too.
 * Per command it first runs the self-check under the same profile and node (fail closed: exit 126, nothing run), then
 * execs `sandbox-exec <profile> <shell> -c <string>`. Anything but exactly one argument is refused. A PATH shim inside
 * this sandbox would fail (nested sandbox_apply is not permitted), so none is used.
 */
export function writeShellPrefix(dir: string, scope: SandboxScope, o: { shell?: string; node?: string; homeDir?: string; pgidFile?: string } = {}): string {
  const shell = o.shell ?? agentShell();
  if (!isAbsolute(shell) || !SHELL_NAMES.has(basename(shell))) throw new SandboxUnavailableError(`unsupported shell ${JSON.stringify(shell)} for the command sandbox`);
  // T7-1: the acceptance agent's wrapper (kind acceptance, its run root); install scopes never run agent commands
  if (scope.kind === "acceptance-install" || scope.kind === "dev-hook") throw new SandboxUnavailableError(`${scope.kind}: no agent shell wrapper`);
  const acceptance = scope.kind === "acceptance";
  if (acceptance && scope.runRoot === undefined) throw new SandboxUnavailableError("acceptance: the run root is missing");
  const node = o.node ?? process.execPath;
  const sandbox = [SANDBOX_EXEC, "-p", sandboxProfile(scope), ...sandboxParams(scope, o.homeDir)].map(shq).join(" ");
  // the outside process the check must not be able to signal: this wrapper's own shell ($$)
  // T5-7 / T5-8: the check's scratch dirs, made by the wrapper (outside the sandbox) and removed after the check.
  // T7-1: none for acceptance (its check has no listening probe)
  const dirs = acceptance ? [] : scratchSocketDirs();
  const vars = dirs.map((_, i) => `\0SC${i}`);
  const check = [node, ...(acceptance ? acceptanceWrapperCheckArgs(scope, "\0PID") : selfCheckArgs(scope, "\0PID", vars))]
    .map((x) => (x === "\0PID" ? '"$$"' : vars.includes(x) ? `"$sc${vars.indexOf(x)}"` : shq(x)))
    .join(" ");
  const body = [
    "#!/bin/sh",
    acceptance
      ? "# Slack Off (T7-1): every Bash command of the acceptance agent runs under the acceptance sandbox of its run."
      : "# Slack Off (R-LOCAL-3, T5-1): every Bash command of the development agent runs under the local command sandbox.",
    'if [ "$#" -ne 1 ]; then',
    "  echo 'Slack Off: command not run: expected exactly one command string' >&2",
    "  exit 126",
    "fi",
    // T7-6: Claude Code runs each Bash command in a process group of its own, which outlives a killed claude: record
    // it (outside the sandbox, before it starts) so the platform can stop it after the run
    // T7-8: "<pid>\t<lstart>" (the leader's start time tells a reused pid apart); no record, no command
    ...(o.pgidFile !== undefined
      ? [
          `lstart=$(LC_ALL=C /bin/ps -o lstart= -p "$$" | /usr/bin/sed 's/[[:space:]]*$//')`,
          'if [ -z "$lstart" ]; then',
          "  echo 'Slack Off: command not run: could not read its start time' >&2",
          "  exit 126",
          "fi",
          `if ! printf '%s\t%s\n' "$$" "$lstart" >> ${shq(o.pgidFile)}; then`,
          "  echo 'Slack Off: command not run: could not record its process group' >&2",
          "  exit 126",
          "fi",
        ]
      : []),
    // T5-4: no ssh / gpg agent; package-manager caches in the ticket's cache dir
    // phase 4a Task 6 / 4A-15: no agent sockets, Anthropic or Claude Code variables, tokens, secrets or cloud
    // credentials reach the command (the hooks' strip list)
    ...envStripSh(scope.kind),
    // T7-1: acceptance — TMPDIR / TMP / TEMP and the package caches in the run root
    ...Object.entries(sandboxEnv(scope, {})).map(([k, v]) => `${k}=${shq(v!)}; export ${k}`),
    // T5-7: the ticket's / run's tmp dir exists before every command (the sandbox cannot create it in SLACKOFF_HOME)
    ...(acceptance
      ? mkdirNoFollowSh(scope.runRoot!, runTmpDir(scope.runRoot!), 126, "command not run")
      : mkdirNoFollowSh(scope.home, ticketTmpDir(scope), 126, "command not run")),
    // named after this shell's pid: a later self-check removes them if this wrapper is killed before it can
    ...(dirs.length > 0 ? [`trap '/bin/rm -rf ${dirs.map((_, i) => `"$sc${i}"`).join(" ")}; exit 126' HUP INT TERM`] : []),
    ...dirs.map((d, i) => `sc${i}=$(/usr/bin/mktemp -d ${shq(join(d, "slackoff-sc-"))}"$$"-XXXXXX) || { /bin/rm -rf ${dirs.slice(0, i).map((_, j) => `"$sc${j}"`).join(" ")}; exit 126; }`),
    "checked=0",
    `${sandbox} ${check} >/dev/null 2>&1 || checked=1`,
    ...(dirs.length > 0 ? [`/bin/rm -rf ${dirs.map((_, i) => `"$sc${i}"`).join(" ")}`, "trap - HUP INT TERM"] : []),
    'if [ "$checked" -ne 0 ]; then',
    "  echo 'Slack Off: command not run: the sandbox self-check failed' >&2",
    "  exit 126",
    "fi",
    `exec ${sandbox} ${shq(shell)} -c "$1"`,
    "",
  ].join("\n");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "shell-prefix");
  writeFileSync(file, body, { mode: 0o755 });
  return file;
}
