// Phase 4f Task 3: the acceptance case runner. The acceptance agent declares cases (acceptance/cases/*.case.json): for
// a command-line tool, arguments after the rules file's cli.command (ruling F-1); for a Node library, an example
// (acceptance/examples/<name>.mjs) run by Node with arguments (ruling F-2). The platform runs them one at a time, never
// through a shell (spawn(file, argv)), each in a fresh <runRoot>/cases-work/<n>/ (HOME, cwd; ruling F-5), under the
// acceptance sandbox — unless the caller already runs inside it (the agent's `slackoff-cases` shim: sandboxes do not
// nest, T6-3). Only the platform's own re-run is evidence (Task 4). Spike: docs/spikes/2026-11-acceptance-cli-library.md.
// Fix round 1 (rulings 4F-1 … 4F-4): on the platform path each case runs under its own profile (writes only in its
// cases-work/<n> and cases-tmp/<n>), every case's dir and files are made before any case starts, what is left of a case
// is killed after it, and a target changed during the run is CaseTargetError ("the app under test changed …").
import { AcceptanceCase, isCaseFilePath, type CaseResult } from "@slackoff/shared";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { runProcess } from "../git/run.ts";
import { isGenericInterpreter, splitCliCommand } from "../projects/project-rules.ts";
import { caseDirsOf, mkdirNoFollow, sandboxArgv, sandboxEnv, type SandboxScope } from "../sandbox/local-sandbox.ts";
import { killLeftovers } from "./app-runner.ts";
import { changedSince, readFileNoFollow } from "./snapshot-check.ts";
import { checkExample } from "./spec-guard.ts";

// ---- Task 1 decided values (spike "Decided values")
/** `./` words of cli.command resolve to the snapshot and the first one is spawned as is (shebang + x bit). */
export const CLI_RESOLVE = "direct" as const;
/** examples/node_modules/<name> → the snapshot's package dir (scoped: node_modules/@scope/ a real dir) */
export const LIB_LINK = "symlink" as const;
/** stdin is the case's text, always closed; never a pseudo-terminal */
export const CASE_TTY = "non-interactive" as const;

/** Ruling F-4: each of stdout and stderr keeps its last 64 KB. */
export const CASE_OUTPUT_TAIL_BYTES = 64 * 1024;
export const MAX_CASE_FILES = 200;
export const MAX_CASE_FILE_BYTES = 256 * 1024;
const MAX_EXAMPLE_BYTES = 512 * 1024;
/** 4F-3: how long one stdoutMatches may run (in a worker, terminated after), and all of them in one run */
const MATCH_TIME_LIMIT_MS = 200;
const REGEX_BUDGET_MS = 5_000;
/** after the leader exits: how long the output may take to drain (a process that left the group may hold it open) */
const CLOSE_GRACE_MS = 250;
const CASE_FILE_SUFFIX = ".case.json";

/** A command-line tool: `command` is cli.command's words with each `./` word resolved inside the snapshot. */
export type CliTarget = { kind: "cli"; repo: string; command: string[]; snapshotDir: string };
/** A Node library: `packageDir` is the package's dir inside the snapshot (a realpath). */
export type LibTarget = { kind: "library"; repo: string; importName: string; packageDir: string };

/** The declared target cannot be run as declared (missing, outside the snapshot, not executable): not_executed. */
export class CaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseTargetError";
  }
}

const insideOrSame = (path: string, dir: string): boolean => {
  const r = relative(resolve(dir), resolve(path));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * 4F-8 (Minor 2): a CLI file without the executable bit (a built `dist/cli.js` is usually 0644). Slack Off never runs it
 * through an interpreter on its own: the project makes it executable or points cli.command at a committed wrapper.
 */
const notExecutable = (shown: string): string =>
  `${shown} is not executable: add "chmod +x ${shown}" to the build command, or point cli.command at a committed ./bin wrapper with a shebang and the executable bit`;

/** realpath of `<snapshotDir>/<rel>`, which must exist and stay inside realpath(snapshotDir). */
function inSnapshot(snapshotDir: string, rel: string, shown: string): string {
  let real: string;
  try {
    real = realpathSync.native(join(snapshotDir, rel));
  } catch {
    throw new CaseTargetError(`${shown} does not exist in the exported snapshot`);
  }
  if (!insideOrSame(real, realpathSync.native(snapshotDir))) throw new CaseTargetError(`${shown} lies outside the exported snapshot`);
  return real;
}

/**
 * CLI_RESOLVE: the target for the rules file's cli.command in the exported snapshot `snapshotDir`. Every `./` word must
 * exist inside the snapshot (symlinks resolved) and becomes `<snapshotDir>/<path>`; a first `./` word must be an
 * executable regular file; the first word is always such a path (4F-5: never a program name or an interpreter). Words
 * with ".." or an absolute path are refused (the rules file schema refuses them too).
 */
export function cliTarget(repo: string, snapshotDir: string, command: string): CliTarget {
  const words = splitCliCommand(command);
  const out: string[] = [];
  for (const [i, w] of words.entries()) {
    const parts = w.split("=");
    if (parts.some((p) => p.startsWith("/"))) throw new CaseTargetError(`cli.command must not name an absolute path (${w})`);
    if (parts.some((p) => p.split("/").includes(".."))) throw new CaseTargetError(`cli.command must not contain '..' (${w})`);
    if (!w.startsWith("./")) {
      out.push(w);
      continue;
    }
    const real = inSnapshot(snapshotDir, w.slice(2), w);
    if (i === 0) {
      if (!statSync(real).isFile()) throw new CaseTargetError(`${w} is not a regular file in the exported snapshot`);
      if (!isExecutable(real)) throw new CaseTargetError(notExecutable(w));
    }
    out.push(join(snapshotDir, w.slice(2)));
  }
  if (isGenericInterpreter(words[0]!)) throw new CaseTargetError(`cli.command must not start with a generic interpreter (${words[0]}): declare the project's own executable`);
  // 4F-5 (M2): never a program name looked up on PATH
  if (!words[0]!.startsWith("./")) throw new CaseTargetError(`cli.command must start with a ./ path to the project's own executable, not the program name ${words[0]}`);
  return { kind: "cli", repo, command: out, snapshotDir };
}

/** The target for the rules file's library section: the package dir (`path`, default ".") must be a dir inside the snapshot. */
export function libraryTarget(repo: string, snapshotDir: string, importName: string, path: string): LibTarget {
  const real = inSnapshot(snapshotDir, path === "." ? "" : path, path === "." ? "the package dir" : path);
  if (!statSync(real).isDirectory()) throw new CaseTargetError(`${path} is not a directory in the exported snapshot`);
  return { kind: "library", repo, importName, packageDir: real };
}

/**
 * Ruling F-5: a case's input files, written into its work dir: plain relative paths only (isCaseFilePath), every dir
 * on the way a real dir (made 0700, never through a symlink), each file created new (O_EXCL | O_NOFOLLOW).
 */
export function writeCaseFiles(workDir: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, text] of Object.entries(files)) {
    if (!isCaseFilePath(rel)) throw new Error(`${JSON.stringify(rel)} is not a plain relative path`);
    const abs = join(workDir, rel);
    mkdirNoFollow(workDir, dirname(abs));
    const fd = openSync(abs, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  }
}

/** Read a regular file without following a symlink at its name; null when it is anything else or over `max` bytes. */
function readPlainFile(path: string, max: number): { text: string } | { why: string } {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { why: code === "ELOOP" ? "a symbolic link" : code === "ENOENT" ? "missing" : `unreadable (${code})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { why: "not a regular file" };
    if (st.size > max) return { why: `larger than ${max / 1024} KB` };
    return { text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

/** The rules file's case allowances (acceptance.caseEnvKeys, acceptance.caseDotfiles). */
export interface CaseRules {
  envKeys?: readonly string[];
  dotfiles?: readonly string[];
}

/** 4F-3 / 4F-4: an env key outside caseEnvKeys, or a top-level dotfile outside caseDotfiles; null when the case is fine. */
export function caseRuleProblem(c: AcceptanceCase, rules: CaseRules): string | null {
  const keys = Object.keys(c.env ?? {}).filter((k) => !(rules.envKeys ?? []).includes(k));
  if (keys.length > 0) return `env ${keys.join(", ")} is not allowed: the rules file's acceptance.caseEnvKeys lists the variables a case may set`;
  const dots = Object.keys(c.files ?? {}).filter((p) => !p.includes("/") && p.startsWith(".") && !(rules.dotfiles ?? []).includes(p));
  if (dots.length > 0) return `files ${dots.join(", ")} are not allowed: dotfiles at the top of HOME need the rules file's acceptance.caseDotfiles`;
  return null;
}

/**
 * The cases in `<acceptanceDir>/cases/*.case.json` (one case per file, at most MAX_CASE_FILES files of at most 256 KB,
 * regular files only — a symlink is never followed), in file-name order. Every other entry, an invalid file, a name
 * used twice, an AC id not in `acIds` and an env key or top-level dotfile the rules file does not allow (caseRules) is a
 * problem ("<file>: <why>"); those cases are left out.
 */
export function loadCases(acceptanceDir: string, acIds: readonly string[], caseRules: CaseRules = {}): { cases: AcceptanceCase[]; problems: string[] } {
  const dir = join(acceptanceDir, "cases");
  const problems: string[] = [];
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { cases: [], problems: ["cases: not a directory"] };
    names = readdirSync(dir).sort();
  } catch {
    return { cases: [], problems: ["cases: missing"] };
  }
  if (names.length > MAX_CASE_FILES) {
    problems.push(`cases: more than ${MAX_CASE_FILES} entries — only the first ${MAX_CASE_FILES} are read`);
    names = names.slice(0, MAX_CASE_FILES);
  }
  const cases: AcceptanceCase[] = [];
  const seen = new Map<string, string>();
  for (const f of names) {
    if (!f.endsWith(CASE_FILE_SUFFIX)) {
      problems.push(`${f}: not a ${CASE_FILE_SUFFIX} file`);
      continue;
    }
    const r = readPlainFile(join(dir, f), MAX_CASE_FILE_BYTES);
    if ("why" in r) {
      problems.push(`${f}: ${r.why === "a symbolic link" ? "symbolic links are not allowed" : r.why}`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(r.text);
    } catch (e) {
      problems.push(`${f}: not valid JSON (${(e as Error).message})`);
      continue;
    }
    const parsed = AcceptanceCase.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0]!;
      problems.push(`${f}: ${i.path.map(String).join(".") || "case"}: ${i.message}`);
      continue;
    }
    const c = parsed.data;
    if (seen.has(c.name)) {
      problems.push(`${f}: the case name ${c.name} is used more than once (also in ${seen.get(c.name)})`);
      continue;
    }
    if (!acIds.includes(c.acId)) {
      problems.push(`${f}: unknown acceptance criterion ${c.acId} (expected: ${acIds.join(", ")})`);
      continue;
    }
    const why = caseRuleProblem(c, caseRules);
    if (why !== null) {
      problems.push(`${f}: ${why}`);
      continue;
    }
    seen.set(c.name, f);
    cases.push(c);
  }
  return { cases, problems };
}

/** The last `max` bytes of a stream's output, kept while it runs. */
class Tail {
  private buf = Buffer.alloc(0);
  bytes = 0;
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  push(b: Buffer): void {
    this.bytes += b.length;
    this.buf = Buffer.concat([this.buf, b]);
    if (this.buf.length > 2 * this.max) this.buf = this.buf.subarray(this.buf.length - this.max);
  }
  /** decoded as UTF-8 (invalid bytes → U+FFFD), never starting inside a character */
  text(): string {
    let start = Math.max(0, this.buf.length - this.max);
    while (start < this.buf.length && (this.buf[start]! & 0xc0) === 0x80) start++;
    return this.buf.subarray(start).toString("utf8");
  }
  get truncated(): boolean {
    return this.bytes > this.max;
  }
}

/** Bidirectional formatting characters (marks, embeddings, overrides, isolates). */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Terminal output as plain text (review focus 5): CSI sequences (colours, cursor moves), OSC sequences (titles,
 * hyperlinks), CR LF → LF, and every other control character but tab and newline removed.
 */
export function plainOutput(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/g, "")
    // 4F-7 (m-3): no bidi overrides or isolates reorder what the developer reads
    .replace(BIDI, "");
}

interface RawRun {
  code: number | null;
  /** the signal that ended the leader, if any */
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stopped: boolean;
  spawnError: string | null;
  stdout: Tail;
  stderr: Tail;
}

function killGroup(pgid: number | undefined): void {
  if (pgid === undefined || pgid <= 1) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // gone
  }
}

/** One process: no shell, its own process group, stdin written then closed; the group killed when it ends or times out. */
function runOne(file: string, args: readonly string[], o: { cwd: string; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; signal?: AbortSignal; onSpawn?: (pgid: number) => void }): Promise<RawRun> {
  return new Promise((done) => {
    const run: RawRun = { code: null, signal: null, timedOut: false, stopped: false, spawnError: null, stdout: new Tail(CASE_OUTPUT_TAIL_BYTES), stderr: new Tail(CASE_OUTPUT_TAIL_BYTES) };
    let child;
    try {
      child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch (e) {
      run.spawnError = (e as Error).message;
      return done(run);
    }
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const onAbort = () => {
      run.stopped = true;
      killGroup(child.pid);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(grace);
      o.signal?.removeEventListener("abort", onAbort);
      killGroup(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      done(run);
    };
    child.once("error", (e) => {
      run.spawnError = e.message;
      if (child.pid === undefined) finish();
    });
    if (child.pid !== undefined) o.onSpawn?.(child.pid);
    child.stdout.on("data", (b: Buffer) => run.stdout.push(b));
    child.stderr.on("data", (b: Buffer) => run.stderr.push(b));
    child.stdin.on("error", () => {});
    child.stdin.end(o.stdin);
    timer = setTimeout(() => {
      run.timedOut = true;
      killGroup(child.pid);
    }, o.timeoutMs);
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("exit", (code, sig) => {
      run.code = code;
      run.signal = sig;
      // the rest of the group goes with its leader; output still in the pipes drains until 'close' (or the grace ends)
      killGroup(child.pid);
      grace = setTimeout(finish, CLOSE_GRACE_MS);
    });
    child.once("close", finish);
  });
}

const MATCH_WORKER = `const { parentPort, workerData } = require("node:worker_threads");
try {
  parentPort.postMessage({ ok: new RegExp(workerData.source).test(workerData.text) });
} catch (e) {
  parentPort.postMessage({ error: String(e && e.message) });
}`;

/**
 * 4F-3 (M1): an agent-written stdoutMatches in a worker thread, terminated after `ms` — the platform's event loop keeps
 * turning while a catastrophic pattern backtracks. true / false, "timeout", or the error it raised.
 */
export function matchWithinWorker(source: string, text: string, ms: number): Promise<boolean | "timeout" | { error: string }> {
  return new Promise((done) => {
    let settled = false;
    const w = new Worker(MATCH_WORKER, { eval: true, workerData: { source, text }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    const end = (v: boolean | "timeout" | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w.terminate();
      done(v);
    };
    const timer = setTimeout(() => end("timeout"), ms);
    w.once("message", (m: { ok?: boolean; error?: string }) => end(m.error !== undefined ? { error: m.error } : m.ok === true));
    w.once("error", (e: Error) => end({ error: e.message }));
    w.once("exit", () => end({ error: "the matcher stopped" }));
  });
}

const secs = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/** One English sentence per unmet expectation. `budget` is the run's remaining regex time (4F-3), spent here. */
async function failuresOf(c: AcceptanceCase, raw: RawRun, stdout: string, stderr: string, timeoutMs: number, budget: { ms: number }): Promise<string[]> {
  const out: string[] = [];
  const e = c.expect;
  if (raw.spawnError !== null && raw.code === null && raw.signal === null) return [`could not start the command: ${raw.spawnError}`];
  if (raw.stopped) out.push("the run was stopped before the case finished");
  if (raw.timedOut) out.push(`timed out after ${secs(timeoutMs)}`);
  // M4: a case killed by a signal never passes
  else if (raw.code === null && !raw.stopped) out.push(`killed by signal ${raw.signal ?? "(unknown)"}`);
  else if (e.exitCode !== undefined && raw.code !== e.exitCode) out.push(`expected exit code ${e.exitCode}, got ${raw.code}`);
  const kept = (t: Tail) => (t.truncated ? " (only its last 64 KB were kept)" : "");
  for (const s of e.stdoutIncludes ?? []) if (!stdout.includes(s)) out.push(`stdout does not include ${JSON.stringify(s)}${kept(raw.stdout)}`);
  for (const s of e.stderrIncludes ?? []) if (!stderr.includes(s)) out.push(`stderr does not include ${JSON.stringify(s)}${kept(raw.stderr)}`);
  if (e.stdoutMatches !== undefined) {
    if (budget.ms <= 0) out.push(`stdoutMatches /${e.stdoutMatches}/ was not evaluated: the run's ${REGEX_BUDGET_MS / 1000} s regex budget is used up`);
    else {
      const limit = Math.min(MATCH_TIME_LIMIT_MS, budget.ms);
      const t0 = Date.now();
      const m = await matchWithinWorker(e.stdoutMatches, stdout, limit);
      budget.ms -= Date.now() - t0;
      if (m === "timeout") out.push(`stdoutMatches /${e.stdoutMatches}/ could not be evaluated within its time limit (${limit} ms)`);
      else if (typeof m === "object") out.push(`stdoutMatches /${e.stdoutMatches}/ could not be evaluated: ${m.error}`);
      else if (!m) out.push(`stdout does not match /${e.stdoutMatches}/${kept(raw.stdout)}`);
    }
  }
  return out;
}

const notRun = (c: AcceptanceCase, why: string): CaseResult => ({
  name: c.name, passed: false, exitCode: null, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: "", truncated: false, failures: [why],
});

/** M3: `dir` must be a real directory (never a symlink). */
function plainDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The argv of a case, or why it cannot run (never run then). */
function argvOf(c: AcceptanceCase, target: CliTarget | LibTarget, acceptanceDir: string): string[] | { why: string } {
  if (target.kind === "cli") {
    if (c.example !== undefined) return { why: "example is only for library entries" };
    // 4F-8 (Minor 2): the same advice as cliTarget when the bit is gone by the time the case runs, never a bare EACCES
    if (!isExecutable(target.command[0]!)) return { why: notExecutable(`./${relative(target.snapshotDir, target.command[0]!)}`) };
    return [...target.command, ...c.args];
  }
  if (c.example === undefined) return { why: "a library case needs an example (a file in examples/)" };
  const exDir = join(acceptanceDir, "examples");
  if (!plainDir(acceptanceDir) || !plainDir(exDir)) return { why: "examples/ is not a plain directory (a symbolic link or missing)" };
  const file = join(exDir, c.example);
  const r = readPlainFile(file, MAX_EXAMPLE_BYTES);
  if ("why" in r) return { why: `the example examples/${c.example} is ${r.why}` };
  const v = checkExample(r.text, { libraryName: target.importName });
  if (v.length > 0) return { why: `the example examples/${c.example} breaks the acceptance rules: ${v.slice(0, 10).join("; ")}` };
  return [process.execPath, file, ...c.args];
}

/** The library link's name in an acceptance dir (LIB_LINK). */
const libLink = (acceptanceDir: string, importName: string) => join(acceptanceDir, "examples", "node_modules", ...importName.split("/"));

/**
 * 4F-1: what must not change while the cases run — each snapshot file of the CLI's command (lstat + content), the
 * library's link (lstat + readlink) and package dir; the snapshot manifest is compared separately (changedSince).
 */
function targetFingerprint(target: CliTarget | LibTarget, acceptanceDir: string): string {
  const parts: string[] = [];
  const entry = (p: string) => {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return `link:${readlinkSync(p)}`;
      if (st.isFile()) return `file:${st.mode}:${createHash("sha256").update(readFileNoFollow(p, Number.MAX_SAFE_INTEGER) ?? Buffer.alloc(0)).digest("hex")}`;
      return st.isDirectory() ? "dir" : "other";
    } catch {
      return "missing";
    }
  };
  if (target.kind === "cli") {
    for (const w of target.command) if (isAbsolute(w)) parts.push(`${w}=${entry(w)}`);
  } else {
    const link = libLink(acceptanceDir, target.importName);
    parts.push(`${link}=${entry(link)}`, `${target.packageDir}=${entry(target.packageDir)}`, `package.json=${entry(join(target.packageDir, "package.json"))}`);
  }
  return parts.join("\n");
}

/**
 * Run `cases` one after another (never concurrently). Before any case starts, the platform makes every case's
 * `<runRoot>/cases-work/<n>/` and `<runRoot>/cases-tmp/<n>/` fresh (no symlink followed) and writes its files (4F-1);
 * a case it cannot prepare — or one breaking `caseRules` — is a failure, never run. Then each case: cli — the target's
 * command + the case's args; library — this Node + `<acceptanceDir>/examples/<example>` + args, after the example
 * guard; without a shell, in its work dir, with `env` + the case's env + HOME = the work dir, TMPDIR = its tmp dir.
 * `sandbox` (this run root's acceptance scope) is narrowed per case to that case's dirs (the rest of the run root read
 * only), and whatever is left of the case is killed after it (4F-2); null only on the shim path, which already runs
 * inside the agent's sandbox. stdin written then closed; over `timeoutMs` the process group is killed. Afterwards the
 * target (the CLI's files, the library link, `manifest`'s snapshot files) must be unchanged, else CaseTargetError.
 */
export async function runCases(o: {
  cases: readonly AcceptanceCase[];
  target: CliTarget | LibTarget;
  runRoot: string;
  /** where cases/ and examples/ are (the repo's own acceptance dir when there are several, Task 4) */
  acceptanceDir: string;
  sandbox: SandboxScope | null;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** each case's process group, as soon as it is started (the platform registers it for shutdown) */
  onSpawn?: (pgid: number) => void;
  /** the rules file's case allowances */
  caseRules?: CaseRules;
  /** exportRepo's manifest of the snapshot: re-hashed after the run (4F-1) */
  manifest?: ReadonlyMap<string, string>;
  /** tests: the run's regex budget (default 5 s) */
  regexBudgetMs?: number;
}): Promise<CaseResult[]> {
  const scope = o.sandbox;
  if (scope !== null && (scope.kind !== "acceptance" || scope.runRoot === undefined || resolve(scope.runRoot) !== resolve(o.runRoot) || scope.caseDirs !== undefined)) {
    throw new Error(`acceptance cases run under the acceptance sandbox of their own run root, not ${scope.kind} (${scope.runRoot ?? "no run root"})`);
  }
  if (o.target.kind === "library") {
    // M3: never through a planted link
    if (!plainDir(o.acceptanceDir) || !plainDir(join(o.acceptanceDir, "examples"))) throw new CaseTargetError("examples/ is not a plain directory (a symbolic link or missing)");
    let ok = false;
    try {
      const link = libLink(o.acceptanceDir, o.target.importName);
      ok = lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === resolve(o.target.packageDir);
    } catch {
      // missing
    }
    if (!ok) throw new CaseTargetError(`the library link examples/node_modules/${o.target.importName} is not the platform's`);
  }
  const before = targetFingerprint(o.target, o.acceptanceDir);
  const changedBefore = new Set(o.manifest !== undefined ? changedSince(o.manifest) : []);

  // 4F-1: every case's dirs and files, made by the platform before any case runs; only the platform writes cases-work
  for (const d of ["cases-work", "cases-tmp"]) {
    rmSync(join(o.runRoot, d), { recursive: true, force: true }); // a symlink there is removed, never followed
    mkdirNoFollow(o.runRoot, join(o.runRoot, d));
  }
  const prepared = o.cases.map((c, i): string | null => {
    try {
      const why = caseRuleProblem(c, o.caseRules ?? {});
      if (why !== null) return why;
      const dirs = caseDirsOf(o.runRoot, i + 1);
      mkdirNoFollow(o.runRoot, dirs.work);
      mkdirNoFollow(o.runRoot, dirs.tmp);
      writeCaseFiles(dirs.work, c.files ?? {});
      return null;
    } catch (e) {
      return `the case's work dir could not be prepared: ${(e as Error).message}`;
    }
  });

  const budget = { ms: o.regexBudgetMs ?? REGEX_BUDGET_MS };
  const results: CaseResult[] = [];
  for (const [i, c] of o.cases.entries()) {
    if (o.signal?.aborted) {
      results.push(notRun(c, "the run was stopped before the case started"));
      continue;
    }
    if (prepared[i] !== null) {
      results.push(notRun(c, prepared[i]!));
      continue;
    }
    const dirs = caseDirsOf(o.runRoot, i + 1);
    let file: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    try {
      const argv = argvOf(c, o.target, o.acceptanceDir);
      if (!Array.isArray(argv)) {
        results.push(notRun(c, argv.why));
        continue;
      }
      env = { ...o.env, ...(c.env ?? {}), HOME: dirs.work, PWD: dirs.work };
      file = argv[0]!;
      args = argv.slice(1);
      if (scope !== null) {
        const caseScope: SandboxScope = { ...scope, caseDirs: dirs };
        env = sandboxEnv(caseScope, env);
        ({ file, args } = sandboxArgv(caseScope, file, args));
      } else for (const k of ["TMPDIR", "TMP", "TEMP"]) env[k] = dirs.tmp;
    } catch (e) {
      results.push(notRun(c, `the case could not be set up: ${(e as Error).message}`));
      continue;
    }
    const pgids: number[] = [];
    const t0 = Date.now();
    const raw = await runOne(file, args, {
      cwd: dirs.work, env, stdin: c.stdin ?? "", timeoutMs: o.timeoutMs, signal: o.signal,
      onSpawn: (p) => {
        pgids.push(p);
        o.onSpawn?.(p);
      },
    });
    const durationMs = Date.now() - t0;
    // 4F-2: nothing of a case outlives it (its group, its env marks, anything with a handle under the run root)
    if (scope !== null) killLeftovers(o.runRoot, pgids);
    const stdout = plainOutput(raw.stdout.text());
    const stderr = plainOutput(raw.stderr.text());
    const failures = await failuresOf(c, raw, stdout, stderr, o.timeoutMs, budget);
    results.push({
      name: c.name,
      passed: failures.length === 0,
      exitCode: raw.code,
      timedOut: raw.timedOut,
      durationMs,
      stdoutTail: stdout,
      stderrTail: stderr,
      truncated: raw.stdout.truncated || raw.stderr.truncated,
      failures,
    });
  }

  // 4F-1: a pass only counts for the app as exported
  const changed = [
    ...(targetFingerprint(o.target, o.acceptanceDir) !== before ? [o.target.kind === "cli" ? "the command's files" : "the library link or package dir"] : []),
    ...(o.manifest !== undefined ? changedSince(o.manifest).filter((p) => !changedBefore.has(p)).map((p) => relative(o.runRoot, p)) : []),
  ];
  if (changed.length > 0) throw new CaseTargetError(`the app under test changed during acceptance: ${changed.slice(0, 5).join(", ")}`);
  return results;
}

/** The sandboxed reader of copyCaseInputs (plain JavaScript, node: built-ins only). */
export const CASE_INPUTS_READER = fileURLToPath(new URL("./case-inputs-reader.mjs", import.meta.url));
const COPY_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * 4F-1 / 4F-5 (M1): the agent's cases and examples (`from`, a repo's acceptance dir in the OLD run root) into `to` in
 * the fresh run root of the platform's re-run. `from` must be its own real path under `oldRunRoot` (no symlink on the
 * way, checked before and after the read); the reads happen in a helper under the old run's acceptance sandbox
 * (`oldSandbox`; null only in tests without sandbox-exec), each file opened without following a link and re-checked
 * after reading, within the size caps (case files 256 KB, at most MAX_CASE_FILES; examples 512 KB, `*.mjs`; 32 MB in
 * all). The platform writes each file new (O_EXCL | O_NOFOLLOW). Returns what was skipped; a refused layout throws.
 */
export async function copyCaseInputs(o: { from: string; to: string; oldRunRoot: string; oldSandbox: SandboxScope | null }): Promise<string[]> {
  const rel = relative(o.oldRunRoot, o.from);
  const refuse = (why: string) => new CaseTargetError(`refusing to copy the cases from ${o.from}: ${why}`);
  if (rel.startsWith("..") || isAbsolute(rel) || !`${rel}/`.startsWith("work/acceptance/")) throw refuse("not an acceptance dir of the old run");
  const sameReal = () => {
    try {
      return realpathSync.native(o.from) === join(realpathSync.native(o.oldRunRoot), rel);
    } catch {
      return false;
    }
  };
  if (!sameReal()) throw refuse("it is not its own real path (a symbolic link on the way)");
  if (o.oldSandbox !== null && (o.oldSandbox.kind !== "acceptance" || resolve(o.oldSandbox.runRoot ?? "") !== resolve(o.oldRunRoot))) {
    throw refuse("the reader runs under the old run's acceptance sandbox");
  }
  const cfg = Buffer.from(
    JSON.stringify({
      root: o.oldRunRoot, dir: o.from,
      caps: { caseBytes: MAX_CASE_FILE_BYTES, caseFiles: MAX_CASE_FILES, exampleBytes: MAX_EXAMPLE_BYTES, exampleFiles: MAX_CASE_FILES, totalBytes: COPY_TOTAL_BYTES },
    }),
  ).toString("base64url");
  const base = { file: process.execPath, args: ["--disable-sigusr1", CASE_INPUTS_READER, `--slackoff-read=${cfg}`] };
  const argv = o.oldSandbox !== null ? sandboxArgv(o.oldSandbox, base.file, base.args) : base;
  const env = o.oldSandbox !== null ? sandboxEnv(o.oldSandbox, { PATH: "/usr/bin:/bin" }) : { PATH: "/usr/bin:/bin" };
  const r = await runProcess(argv.file, argv.args, { timeoutMs: 60_000, maxOutput: 64 * 1024 * 1024, env });
  if (r.code !== 0 || r.timedOut || r.truncated) throw refuse(r.stderr.trim().split("\n").at(-1) || `the reader failed (exit ${r.code ?? "—"})`);
  if (!sameReal()) throw refuse("it changed while being read");
  let out: { files: Array<{ sub: string; name: string; b64: string }>; skipped: string[] };
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw refuse("the reader's output is not JSON");
  }
  const skipped = Array.isArray(out.skipped) ? out.skipped.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  for (const sub of ["cases", "examples"]) mkdirNoFollow(dirname(join(o.to, sub)), join(o.to, sub));
  for (const f of Array.isArray(out.files) ? out.files : []) {
    const ok =
      (f.sub === "cases" && /^[A-Za-z0-9._-]{1,200}\.case\.json$/.test(f.name)) || (f.sub === "examples" && /^[a-z0-9-]{1,64}\.mjs$/.test(f.name));
    const buf = typeof f.b64 === "string" ? Buffer.from(f.b64, "base64") : null;
    if (!ok || buf === null || buf.length > (f.sub === "cases" ? MAX_CASE_FILE_BYTES : MAX_EXAMPLE_BYTES)) {
      skipped.push(`${String(f.sub)}/${String(f.name)}: refused`);
      continue;
    }
    const fd = openSync(join(o.to, f.sub, f.name), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, buf);
    } finally {
      closeSync(fd);
    }
  }
  return skipped;
}

/**
 * A shell word as a user would type it: bare when plain, single-quoted otherwise, and in the $'…' form with escapes when
 * it holds a control or bidi character (4F-7 m-3: the command line stays one line and shows what was really passed).
 */
function shellWord(a: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a;
  if (!/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(a)) return "'" + a.replace(/'/g, "'\\''") + "'";
  const esc = a.replace(/[\\'\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (ch) => {
    if (ch === "\\") return "\\\\";
    if (ch === "'") return "\\'";
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    const c = ch.charCodeAt(0);
    return c < 0x100 ? "\\x" + c.toString(16).padStart(2, "0") : "\\u" + c.toString(16).padStart(4, "0");
  });
  return "$'" + esc + "'";
}

/**
 * 4F-7 (m-3): a case's output inside a transcript. Bidi and control characters (but tab and newline) are removed, and a
 * line that could pass for one of the platform's own lines ("$ ", "(stdin…", "(files…", "--- …", "exit …", "- …") or
 * that starts with a backslash is prefixed with a backslash: the output cannot forge the transcript's frame.
 */
function framedOutput(s: string): string {
  return plainOutput(s)
    .split("\n")
    .map((l) => (/^(\$ |\(|---|exit |- |\\)/.test(l) ? "\\" + l : l))
    .join("\n");
}

const withNewline = (s: string) => (s === "" || s.endsWith("\n") ? s : `${s}\n`);

/** 4F-8 (I-2): how much of a library example's code a transcript shows. */
export const EXAMPLE_SHOWN_BYTES = 8 * 1024;
const EXAMPLE_LINE = "| ";

/** The first `max` bytes of `s`, never cut inside a character. */
function headBytes(s: string, max: number): { text: string; cut: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { text: s, cut: false };
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), cut: true };
}

/**
 * 4F-8 (I-2): a library example's code inside a transcript, right after the command line: a "--- example examples/<x> ---"
 * line, every code line prefixed with "| " (so no line of it can pass for the frame), "--- end of example ---". Control and
 * bidi characters removed, the first EXAMPLE_SHOWN_BYTES kept.
 */
function exampleSection(example: { name: string; source: string }): string {
  const { text, cut } = headBytes(plainOutput(example.source), EXAMPLE_SHOWN_BYTES);
  const lines = text.replace(/\n$/, "").split("\n");
  return [
    `--- example examples/${example.name}${cut ? ` (first ${EXAMPLE_SHOWN_BYTES / 1024} KB)` : ""} ---\n`,
    ...lines.map((l) => `${EXAMPLE_LINE}${l}\n`),
    "--- end of example ---\n",
  ].join("");
}

/**
 * The evidence text of one case (a `kind 'log'` evidence file, Task 4): the command line, a library example's code
 * (4F-8 I-2), the stdin and input files it got, both outputs and the exit; the unmet expectations last. Plain text,
 * never markup.
 */
export function caseTranscript(c: AcceptanceCase, r: CaseResult, displayCommand: string, example?: { name: string; source: string }): string {
  const stdinBytes = c.stdin === undefined ? 0 : Buffer.byteLength(c.stdin);
  const files = Object.keys(c.files ?? {});
  const tail = r.truncated ? " (last 64 KB)" : "";
  const exit = r.timedOut ? "exit — (timed out)" : r.exitCode === null ? "exit — (not run or killed by a signal)" : `exit ${r.exitCode}`;
  return [
    `$ ${[displayCommand, ...c.args.map(shellWord)].join(" ")}\n`,
    example !== undefined ? exampleSection(example) : "",
    stdinBytes > 0 ? `(stdin: ${stdinBytes} bytes: ${JSON.stringify(c.stdin!.length > 200 ? `${c.stdin!.slice(0, 200)}…` : c.stdin)})\n` : "(no stdin)\n",
    files.length > 0 ? `(files: ${files.join(", ")})\n` : "",
    `--- stdout${tail} ---\n`,
    withNewline(framedOutput(r.stdoutTail)),
    `--- stderr${tail} ---\n`,
    withNewline(framedOutput(r.stderrTail)),
    `${exit}\n`,
    r.failures.length > 0 ? `--- not as expected ---\n${r.failures.map((f) => `- ${f}\n`).join("")}` : "",
  ].join("");
}

/** 4F-8 (I-1): how much of each output the fix note's run summary keeps. */
const SUMMARY_OUTPUT_BYTES = 2 * 1024;

/** The last `max` bytes of `s`, never starting inside a character. */
function tailBytes(s: string, max: number): { text: string; cut: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return { text: s, cut: false };
  let start = buf.length - max;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return { text: buf.subarray(start).toString("utf8"), cut: true };
}

/**
 * 4F-8 (I-1): what the developer agent's fix note shows of the platform's own run of a case — the command line, the
 * exit, the unmet expectations and the last 2 KB of each output (framed as in the transcript). The caller redacts it.
 */
export function caseRunSummary(c: AcceptanceCase, r: CaseResult, displayCommand: string): string {
  const exit = r.timedOut ? "exit — (timed out)" : r.exitCode === null ? "exit — (not run or killed by a signal)" : `exit ${r.exitCode}`;
  const out = (name: string, s: string) => {
    const t = tailBytes(framedOutput(s), SUMMARY_OUTPUT_BYTES);
    return `--- ${name}${t.cut ? " (last 2 KB)" : ""} ---\n${withNewline(t.text)}`;
  };
  return [
    `$ ${[displayCommand, ...c.args.map(shellWord)].join(" ")}\n`,
    `${exit}\n`,
    r.failures.length > 0 ? `--- not as expected ---\n${r.failures.map((f) => `- ${f}\n`).join("")}` : "",
    out("stdout", r.stdoutTail),
    out("stderr", r.stderrTail),
  ].join("");
}

/**
 * Phase 4f: the base environment of a repo's cases (shim and platform re-run alike): PATH = this Node's dir and the
 * system dirs (a `#!/usr/bin/env node` CLI gets this Node), USER and LANG from the server, the rules file's
 * acceptance.env, and SLACKOFF_RUN_ROOT (killLeftovers recognises the run's processes by it). runCases adds the case's
 * env, HOME and TMPDIR. No token, no SLACKOFF_HOME, no ssh agent.
 */
export function caseEnv(acceptanceEnv: Readonly<Record<string, string>>, runRoot: string): Record<string, string> {
  const env: Record<string, string> = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
  for (const k of ["USER", "LANG"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  Object.assign(env, acceptanceEnv);
  env.SLACKOFF_RUN_ROOT = runRoot;
  return env;
}
