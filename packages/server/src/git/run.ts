import { execFileSync, spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The one process runner for git and repo commands (P-C16): no shell, stdin closed, no TTY, its own process group (a
 * timeout or output cap kills the whole group, hooks and test runners included), inherited GIT_* removed,
 * GIT_TERMINAL_PROMPT=0.
 */

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** the process was killed because its output went over `maxOutput` bytes; stdout/stderr hold the first bytes */
  truncated: boolean;
  /** with `tailBytes`: the last bytes of stdout and stderr interleaved as they arrived (stdout/stderr are then empty) */
  tail: string;
}

export interface ProcessOptions {
  /** working directory (default: the server's) */
  cwd?: string;
  timeoutMs?: number;
  /** stdout + stderr bytes before the process is killed (default 8 MiB); ignored with `tailBytes` */
  maxOutput?: number;
  /** keep only the last N bytes of the combined output, never killing for size (test runners, hooks) */
  tailBytes?: number;
  /** R4: replaces process.env as the base environment (still filtered by gitEnv); default gitEnv(process.env) */
  env?: NodeJS.ProcessEnv;
  /** T6-6: stdin read from this file instead of being closed (still no pipe; e.g. `git cat-file --batch`) */
  stdinFile?: string;
  /** T6-6: stdout written to this file as raw bytes (binary-safe, no size cap); `stdout` is then empty */
  stdoutFile?: string;
  /** Task 9 (T9-6 L3): called with the child's process group (= its pid, detached) once it is started */
  onSpawn?: (pgid: number) => void;
}

export type GitResult = Omit<ProcessResult, "tail">;

export interface GitOptions {
  timeoutMs?: number;
  /** stdout + stderr bytes before git is killed (default 8 MiB) */
  maxOutput?: number;
  tailBytes?: number;
  /** T6-6: see ProcessOptions */
  stdinFile?: string;
  stdoutFile?: string;
  /**
   * 4A-2: keep the repository's own core.hooksPath (no NO_HOOKS_DIR default). Only for reading the hooks configuration
   * (`config --get core.hooksPath`, `rev-parse --git-path hooks`); those never run a hook.
   */
  configuredHooks?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** startProcess: how long `exited` waits for the output to drain after the leader's exit */
const CLOSE_GRACE_MS = 250;
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

/**
 * Never passed on: variables that silently disable a repo's hooks (husky v4–v9), so commits always run the hooks, and
 * Node's test-runner context (a repo's `node --test` would otherwise report to a parent runner and exit 0 on failure).
 */
const HOOK_DISABLING = new Set(["HUSKY", "HUSKY_SKIP_HOOKS", "NODE_TEST_CONTEXT"]);

/**
 * The environment git and repo commands run with: inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 * GIT_CONFIG_*…) removed so `-C <cwd>` decides the repo, HUSKY / HUSKY_SKIP_HOOKS removed so hooks are not skipped, and
 * NODE_TEST_CONTEXT removed so a repo's test runner reports its own result.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const u = k.toUpperCase();
    if (!u.startsWith("GIT_") && !HOOK_DISABLING.has(u)) env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** Cut a UTF-8 buffer's leading bytes so a tail does not start inside a multi-byte character. */
function tailString(buf: Buffer, max: number): string {
  let start = Math.max(0, buf.length - max);
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/** Cut a UTF-8 buffer to at most `max` bytes without splitting a character. */
function headString(buf: Buffer, max: number): string {
  if (buf.length <= max) return buf.toString("utf8");
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** Run `file args` (execFile semantics, no shell). Never rejects for a non-zero exit; rejects only when it cannot be started. */
export function runProcess(file: string, args: readonly string[], opts: ProcessOptions): Promise<ProcessResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const tailBytes = opts.tailBytes;
  return new Promise((resolve, reject) => {
    const fds: number[] = [];
    const closeFds = () => {
      for (const fd of fds.splice(0)) closeSync(fd);
    };
    let stdin: "ignore" | number = "ignore";
    let stdout: "pipe" | number = "pipe";
    try {
      if (opts.stdinFile !== undefined) fds.push((stdin = openSync(opts.stdinFile, "r")));
      // T6-7 (M5): a new file only — never truncate or follow something already there
      if (opts.stdoutFile !== undefined) fds.push((stdout = openSync(opts.stdoutFile, "wx", 0o600)));
    } catch (e) {
      closeFds();
      return reject(e);
    }
    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd, env: gitEnv(opts.env ?? process.env), stdio: [stdin, stdout, "pipe"], detached: true });
    } catch (e) {
      return reject(e);
    } finally {
      // the child has its own copies now (or there is no child)
      closeFds();
    }
    if (child.pid !== undefined) opts.onSpawn?.(child.pid);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let tail = Buffer.alloc(0);
    let size = 0;
    let timedOut = false;
    let truncated = false;
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    const collect = (into: Buffer[]) => (b: Buffer) => {
      if (tailBytes !== undefined) {
        tail = Buffer.concat([tail, b]);
        if (tail.length > 2 * tailBytes) tail = tail.subarray(tail.length - tailBytes);
        return;
      }
      if (truncated) return;
      const room = maxOutput - size;
      size += b.length;
      if (b.length > room) {
        if (room > 0) into.push(b.subarray(0, room));
        truncated = true;
        return killGroup();
      }
      into.push(b);
    };
    child.stdout?.on("data", collect(out));
    child.stderr!.on("data", collect(err));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // the group may outlive its leader (a hook's background child): end it too
      killGroup();
      const text = (parts: Buffer[]) => headString(Buffer.concat(parts), maxOutput);
      resolve({
        code,
        stdout: text(out),
        stderr: text(err),
        timedOut,
        truncated,
        tail: tailBytes === undefined ? "" : tailString(tail, tailBytes),
      });
    });
  });
}

export interface StartedProcess {
  /** the process group (= the leader's pid) */
  pgid: number;
  /** the last bytes of stdout and stderr interleaved as they arrived */
  tail(): string;
  /** the leader's exit code (null when killed by a signal) */
  exited: Promise<number | null>;
}

/**
 * R4: a long-running process (an acceptance target app's `start`): no shell, stdin closed, its own process group,
 * environment `env` (filtered by gitEnv). Unlike {@link runProcess} it is never killed here — no timeout, nothing done
 * when it exits; the caller stops the group (stopTargets). Throws when the program cannot be started (ENOENT…).
 */
export function startProcess(file: string, args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv; tailBytes: number }): StartedProcess {
  const child = spawn(file, args, { cwd: o.cwd, env: gitEnv(o.env), stdio: ["ignore", "pipe", "pipe"], detached: true });
  if (child.pid === undefined) {
    // the 'error' event follows on the next tick: swallow it, the failure is thrown here
    child.once("error", () => {});
    let reason = "ENOENT (not found on PATH)";
    if (isAbsolute(file)) {
      try {
        accessSync(file, constants.X_OK);
        reason = "spawn failed";
      } catch (e) {
        reason = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
      }
    }
    throw new Error(`cannot start ${file}: ${reason}`);
  }
  const pgid = child.pid;
  let tail = Buffer.alloc(0);
  const collect = (b: Buffer) => {
    tail = Buffer.concat([tail, b]);
    if (tail.length > 2 * o.tailBytes) tail = tail.subarray(tail.length - o.tailBytes);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  // T6-7 (M4): liveness is the leader's 'exit'; then the output is given a short time to drain ('close') so tail() is
  // complete — a background child of the group may hold stdout open for good, and must not delay this
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      let timer: NodeJS.Timeout | undefined;
      void Promise.race([closed, new Promise<void>((r) => (timer = setTimeout(r, CLOSE_GRACE_MS)))]).then(() => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    child.once("error", () => resolve(null));
  });
  return { pgid, tail: () => tailString(tail, o.tailBytes), exited };
}

/**
 * Config the platform's git never takes from a repository (Task 5 fix round 1, defence in depth behind the sandbox's
 * write protection of git metadata): a planted core.fsmonitor, diff.external or textconv driver would run a program
 * in this unsandboxed git. Hooks are unaffected (the repo's hooks are required and pinned, F2-R1). F4A-2 (C-B): no
 * submodule recursion — git status / diff run a gitlink's own repository (its config: filters, fsmonitor) otherwise.
 */
export const GIT_SAFE_CONFIG: readonly string[] = [
  "-c", "core.fsmonitor=false", "-c", "diff.ignoreSubmodules=all", "-c", "submodule.recurse=false", "-c", "status.submoduleSummary=false",
];
/**
 * 4A-2 / 4A-4: the hooks dir every platform git call gets unless it passes its own `-c core.hooksPath=` (commit and
 * push pass the platform's wrapper dir, which wins as the later value): a root-owned path nobody can create, so worktree
 * add, status, restore, add… run no repository hook outside the sandbox.
 */
export const NO_HOOKS_DIR = "/var/empty/slackoff-no-hooks";
/** Subcommands that may run an external diff / textconv program: always given --no-ext-diff --no-textconv. */
const DIFFING = new Set(["diff", "log", "show"]);

/** F4A-2 (C-B): subcommands that may look into a gitlink's working tree: always given --ignore-submodules=all. */
const SUBMODULE_READING = new Set(["status", "diff"]);

/**
 * `args` with --no-ext-diff --no-textconv right after a diffing subcommand, and --ignore-submodules=all after a status
 * or diff (leading global options skipped: `-c k=v` / `-C dir` pairs, `--literal-pathspecs`…).
 */
export function safeGitArgs(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += (args[i] === "-c" || args[i] === "-C") && i + 1 < args.length ? 2 : 1;
  const sub = args[i];
  if (sub === undefined) return [...args];
  const extra = [...(DIFFING.has(sub) ? ["--no-ext-diff", "--no-textconv"] : []), ...(SUBMODULE_READING.has(sub) ? ["--ignore-submodules=all"] : [])];
  return [...args.slice(0, i + 1), ...extra, ...args.slice(i + 1)];
}

/** The first executable `name` on PATH, real path; null when there is none. */
function whichReal(name: string): string | null {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (d === "" || !isAbsolute(d)) continue;
    try {
      const f = join(d, name);
      accessSync(f, constants.X_OK);
      if (statSync(f).isFile()) return realpathSync(f);
    } catch {
      // not there
    }
  }
  return null;
}

function xcrunFindGit(): string | null {
  try {
    const p = execFileSync("/usr/bin/xcrun", ["-f", "git"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
    return isAbsolute(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * T5-4: the git the platform runs, as an absolute path. On macOS `/usr/bin/git` is the Command Line Tools shim that
 * asks xcrun, which trusts a cache in $TMPDIR (xcrun_db) a repository command could plant; so the real git behind it
 * is resolved once (`xcrun -f git`) and used directly. Elsewhere: the real path of the git on PATH.
 */
export function resolveGitBin(o: { platform?: NodeJS.Platform; which?: () => string | null; xcrunFind?: () => string | null } = {}): string {
  const found = (o.which ?? (() => whichReal("git")))();
  if (found === null) throw new Error("git was not found on PATH");
  if ((o.platform ?? process.platform) === "darwin" && found === "/usr/bin/git") {
    const real = (o.xcrunFind ?? xcrunFindGit)();
    if (real === null) throw new Error("cannot resolve the real git behind /usr/bin/git (xcrun -f git failed)");
    return real;
  }
  return found;
}

let cachedGitBin: string | null = null;
/** {@link resolveGitBin}, once per process. */
export function gitBin(): string {
  cachedGitBin ??= resolveGitBin();
  return cachedGitBin;
}

/** `<git> -c core.fsmonitor=false -C <cwd> <args>` through {@link runProcess}, git being {@link gitBin}. */
export async function runGit(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<GitResult & { tail: string }> {
  const { configuredHooks, ...rest } = opts;
  const hooks = configuredHooks === true ? [] : ["-c", `core.hooksPath=${NO_HOOKS_DIR}`];
  return runProcess(gitBin(), [...GIT_SAFE_CONFIG, ...hooks, "-C", cwd, ...safeGitArgs(args)], rest);
}
