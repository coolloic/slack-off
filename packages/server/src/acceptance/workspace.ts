// Task 6: the acceptance workspace. A run gets its own root outside SLACKOFF_HOME and every repo / worktree:
//   <runRoot>/work/<repo>       a history-free export (the commit's blobs, T6-6) of the commit under review
//   <runRoot>/work/acceptance   the Playwright scaffold the agent writes specs into
//   <runRoot>/bin/playwright    the agent's only `playwright`: exactly `playwright test` under a fixed env (T6-3; the
//                               caller's acceptance wrapper is the sandbox, and the sandbox cannot write bin/, T6-2)
//   <runRoot>/tmp               the run's TMPDIR and its only unix-socket dir (T6-1)
//   <runRoot>/cache             the run's package-manager caches (T6-2)
// plus the dedicated Claude Code config dir (Q-3), purged before and after. Evidence: docs/spikes/2026-11-acceptance-delivery.md §2, §4, §6.10.
import type { DatabaseSync } from "node:sqlite";
import type { AcceptanceTarget } from "@slackoff/shared";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants as fsConstants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync,
  symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import { listDesignDocs, listRounds, listRulings } from "../design/design-repo.ts";
import { runGit } from "../git/run.ts";
import { currentChoice, getSolution } from "../requirements/requirement-repo.ts";
import { mkdirNoFollow, runShimDir, runTmpDir, type SandboxScope } from "../sandbox/local-sandbox.ts";
import type { LibTarget } from "./case-runner.ts";

// ---- Task 1 decided values (spike "Decided values")
export const ACCEPT_CONFIG_DIR_MODE = "dedicated" as const;
export const ACCEPT_CONFIG_PURGE: readonly string[] = ["projects", "sessions", "todos", "shell-snapshots", "session-env", "file-history", "debug", "backups"];
/** The top-level entries allowed in the config dir (manual check 1: add any entry the login turns out to need). */
export const ACCEPT_CONFIG_ALLOWED: readonly string[] = [".claude.json", "plugins", ...ACCEPT_CONFIG_PURGE];
export const ACCEPT_PLAYWRIGHT_LINK = "symlink" as const;
export const ACCEPT_BROWSER = "chromium" as const;

export interface AcceptanceRunDirs {
  runRoot: string;
  /** <runRoot>/work: the agent's cwd */
  workDir: string;
  /** <workDir>/acceptance */
  acceptanceDir: string;
  /** <runRoot>/bin, outside workDir: holds only the `playwright` shim */
  shimDir: string;
  configDir: string;
}

export class AcceptanceIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptanceIsolationError";
  }
}

const RUN_PREFIX = "slackoff-accept-";
/** sun_path is 104 bytes with its NUL */
const SOCKET_PATH_MAX = 103;
/** The longest socket path expected in a run's tmp dir: Chromium's process-singleton socket. */
const CHROMIUM_SOCKET = join(".org.chromium.Chromium.XXXXXX", "SingletonSocket");
/** Text files the export drops when they quote the design (excludeDesignQuotes; T6-4), plus extensionless text files. */
const TEXT_EXTS = new Set([".md", ".txt", ".adoc", ".rst", ".mdx", ".markdown", ".html", ".htm", ".json", ".yaml", ".yml"]);
const QUOTE_MIN = 60;
const DB_FILE = /(\.db|\.sqlite|\.sqlite3|-wal|-shm)$/i;
const SHA = /^[0-9a-f]{7,64}$/;
/** other Claude Code sessions' scratch dirs (and Claude Code's own TMPDIR): never a run root's base */
const CLAUDE_TMP_PREFIX = "/private/tmp/claude-";
/** the name prepareRunDirs gives a run root (mkdtemp: six characters) */
export const RUN_ROOT_NAME = /^slackoff-accept-[A-Za-z0-9]{6}$/;

const inside = (path: string, dir: string): boolean => {
  const r = relative(resolve(dir), resolve(path));
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};
const sameOrInside = (path: string, dir: string) => resolve(path) === resolve(dir) || inside(path, dir);
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * T6-1: the dir run roots are made in — the real temp dir, unless a socket in `<runRoot>/tmp` (Chromium's
 * `.org.chromium.Chromium.XXXXXX/SingletonSocket`) would not fit sun_path there; then the real `/tmp`. macOS's
 * per-user temp dir (`/private/var/folders/…/T`, 56 bytes) is always too long.
 */
export function acceptRunBase(tmp: string = tmpdir()): string {
  const t = real(tmp);
  // Task 9 / T9-1: a server started from a Claude Code shell has TMPDIR under /private/tmp/claude-*, which the
  // acceptance sandbox denies (and checkScope refuses as a run root): every run would end not_executed
  if (t.startsWith(CLAUDE_TMP_PREFIX) || t.startsWith("/tmp/claude-")) return real("/tmp");
  const longest = join(t, `${RUN_PREFIX}XXXXXX`, "tmp", CHROMIUM_SOCKET);
  return Buffer.byteLength(longest) <= SOCKET_PATH_MAX ? t : real("/tmp");
}

function assertOutside(path: string, home: string, repoPaths: readonly string[], what: string): void {
  for (const d of [home, ...repoPaths]) {
    if (sameOrInside(real(path), real(d)) || sameOrInside(path, d)) throw new AcceptanceIsolationError(`${what} ${path} is inside ${d}`);
  }
}

let configDirQueue: Promise<unknown> = Promise.resolve();
/** Q-3: the dedicated config dir serves one acceptance run at a time in this process (also with concurrency > 1). */
export function withAcceptanceConfigDir<T>(fn: () => Promise<T>): Promise<T> {
  const run = configDirQueue.then(fn, fn);
  configDirQueue = run.catch(() => {});
  return run;
}

function purgeConfigDir(configDir: string): void {
  for (const n of ACCEPT_CONFIG_PURGE) rmSync(join(configDir, n), { recursive: true, force: true });
}

/**
 * A new run root (realpath) outside SLACKOFF_HOME and every repo / worktree, with work/, work/acceptance/, bin/ and
 * tmp/ (0700); the config dir created and its ACCEPT_CONFIG_PURGE folders removed.
 */
export async function prepareRunDirs(o: { home: string; repoPaths: readonly string[]; config: Config }): Promise<AcceptanceRunDirs> {
  assertOutside(tmpdir(), o.home, o.repoPaths, "the temp dir");
  const runRoot = real(mkdtempSync(join(acceptRunBase(), RUN_PREFIX)));
  try {
    assertOutside(runRoot, o.home, o.repoPaths, "the acceptance run root");
    const workDir = join(runRoot, "work");
    const dirs: AcceptanceRunDirs = {
      runRoot,
      workDir,
      acceptanceDir: join(workDir, "acceptance"),
      shimDir: runShimDir(runRoot),
      configDir: o.config.acceptance.claudeConfigDir,
    };
    for (const d of [dirs.acceptanceDir, dirs.shimDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    mkdirSync(runTmpDir(runRoot), { mode: 0o700 });
    mkdirSync(dirs.configDir, { recursive: true, mode: 0o700 });
    purgeConfigDir(dirs.configDir);
    return dirs;
  } catch (err) {
    rmSync(runRoot, { recursive: true, force: true });
    throw err;
  }
}

/** Byte-wise reader over a file, for `git cat-file --batch` output (binary-safe, any size). */
class BatchReader {
  private buf = Buffer.alloc(0);
  private pos = 0;
  private eof = false;
  private readonly fd: number;
  constructor(fd: number) {
    this.fd = fd;
  }
  private fill(): boolean {
    if (this.eof) return false;
    const chunk = Buffer.alloc(1 << 20);
    const n = readSync(this.fd, chunk, 0, chunk.length, null);
    if (n === 0) {
      this.eof = true;
      return false;
    }
    this.buf = Buffer.concat([this.buf.subarray(this.pos), chunk.subarray(0, n)]);
    this.pos = 0;
    return true;
  }
  line(): string | null {
    for (;;) {
      const i = this.buf.indexOf(10, this.pos);
      if (i !== -1) {
        const l = this.buf.subarray(this.pos, i).toString("utf8");
        this.pos = i + 1;
        return l;
      }
      if (!this.fill()) return null;
    }
  }
  /** Copy the next `n` bytes to `out` (an fd). */
  copy(n: number, out: number): void {
    let left = n;
    while (left > 0) {
      if (this.pos >= this.buf.length && !this.fill()) throw new Error("git cat-file output ended early");
      const take = Math.min(left, this.buf.length - this.pos);
      writeSync(out, this.buf, this.pos, take);
      this.pos += take;
      left -= take;
    }
  }
  skip(n: number): void {
    let left = n;
    while (left > 0) {
      if (this.pos >= this.buf.length && !this.fill()) throw new Error("git cat-file output ended early");
      const take = Math.min(left, this.buf.length - this.pos);
      this.pos += take;
      left -= take;
    }
  }
}

const BAD_COMPONENT = (c: string) => c === "" || c === "." || c === ".." || c.toLowerCase() === ".git";

/**
 * T6-6: export `sha` into `dest` from its blobs — `git ls-tree -r -z` and `git cat-file --batch` (files in the run root,
 * no pipe, R4) — so nothing of `.gitattributes` applies: no export-subst (`$Format:%B$` would put commit messages in the
 * export), no export-ignore. No history, no uncommitted changes; symlinks and the executable bit kept; a submodule is
 * an empty dir. Returns each exported file's and symlink's blob id (absolute path → id), for the no-db check (T6-5).
 */
export async function exportRepo(wt: string, sha: string, dest: string, runRoot: string): Promise<Map<string, string>> {
  const repo = basename(dest);
  const fail = (why: string) => new AcceptanceIsolationError(`cannot export ${repo}: ${why}`);
  if (!SHA.test(sha)) throw fail(`${JSON.stringify(sha)} is not a commit sha`);
  const listFile = join(runRoot, `${repo}.ls-tree`);
  const idsFile = join(runRoot, `${repo}.ids`);
  const blobsFile = join(runRoot, `${repo}.blobs`);
  try {
    const t = await runGit(wt, ["ls-tree", "-r", "-z", "--full-tree", `${sha}^{commit}`], { timeoutMs: 120_000, stdoutFile: listFile });
    if (t.code !== 0) throw fail(`git ls-tree failed: ${t.stderr.trim().slice(-500)}`);
    const files: Array<{ mode: string; oid: string; path: string }> = [];
    const dirs: string[] = [];
    for (const rec of readFileSync(listFile).toString("utf8").split("\0")) {
      if (rec === "") continue;
      const m = /^(\d{6}) (blob|commit|tree) ([0-9a-f]{40,64})\t(.+)$/s.exec(rec);
      if (!m) throw fail(`unexpected git ls-tree entry ${JSON.stringify(rec.slice(0, 200))}`);
      const [, mode, type, oid, path] = m as unknown as [string, string, string, string, string];
      if (path.split("/").some(BAD_COMPONENT)) throw fail(`refusing the path ${JSON.stringify(path)}`);
      if (type === "commit") dirs.push(path);
      else if (type === "blob") files.push({ mode, oid, path });
    }
    mkdirSync(dest, { recursive: true });
    for (const d of dirs) mkdirSync(join(dest, d), { recursive: true });
    const byOid = new Map<string, typeof files>();
    for (const f of files) byOid.set(f.oid, [...(byOid.get(f.oid) ?? []), f]);
    writeFileSync(idsFile, [...byOid.keys()].map((o) => `${o}\n`).join(""));
    const c = await runGit(wt, ["cat-file", "--batch"], { timeoutMs: 600_000, stdinFile: idsFile, stdoutFile: blobsFile });
    if (c.code !== 0) throw fail(`git cat-file failed: ${c.stderr.trim().slice(-500)}`);
    const manifest = new Map<string, string>();
    const links: Array<{ target: string; path: string; oid: string }> = [];
    const written = new Set<string>();
    const realDest = realpathSync(dest);
    const blobTmp = join(runRoot, `${repo}.blob`);
    // T6-7 (M5): on a case-insensitive file system two tree paths can name one file: never overwrite, refuse
    const place = (path: string, write: () => void) => {
      try {
        write();
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
          throw fail(`${path} collides with another path of the commit (${code}; a case-insensitive file system?)`);
        }
        throw e;
      }
    };
    const fd = openSync(blobsFile, "r");
    try {
      const r = new BatchReader(fd);
      for (let header = r.line(); header !== null && header !== ""; header = r.line()) {
        if (/^[0-9a-f]{40,64} missing$/.test(header)) continue; // reported below as a missing entry
        const h = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(header);
        if (!h || h[2] !== "blob") throw fail(`unexpected git cat-file output ${JSON.stringify(header.slice(0, 200))}`);
        const entries = byOid.get(h[1]!) ?? [];
        if (entries.length === 0) throw fail(`git cat-file returned an object that was not asked for`);
        const out = openSync(blobTmp, "w", 0o600);
        try {
          r.copy(Number(h[3]), out);
        } finally {
          closeSync(out);
        }
        r.skip(1); // the newline after the content
        // T6-7 (M2): each entry by its own mode — one blob can be a symlink's target in one place and a file in another
        for (const f of entries) {
          const abs = join(dest, f.path);
          place(f.path, () => mkdirSync(dirname(abs), { recursive: true }));
          // never write through a link: every file's parent is a real dir inside dest (links are made last)
          if (!sameOrInside(realpathSync(dirname(abs)), realDest)) throw fail(`refusing to write outside the export: ${f.path}`);
          if (f.mode === "120000") {
            links.push({ target: readFileSync(blobTmp, "utf8"), path: f.path, oid: f.oid });
          } else {
            place(f.path, () => copyFileSync(blobTmp, abs, fsConstants.COPYFILE_EXCL));
            chmodSync(abs, f.mode === "100755" ? 0o755 : 0o644);
            manifest.set(abs, f.oid);
            written.add(f.path);
          }
        }
      }
    } finally {
      closeSync(fd);
      rmSync(blobTmp, { force: true });
    }
    for (const l of links) {
      const abs = join(dest, l.path);
      place(l.path, () => symlinkSync(l.target, abs));
      manifest.set(abs, l.oid);
      written.add(l.path);
    }
    // every tree entry is there, whatever happened above
    const missing = files.filter((f) => !written.has(f.path));
    if (missing.length > 0) throw fail(`entries missing from the export: ${missing.slice(0, 5).map((f) => f.path).join(", ")}`);
    return manifest;
  } finally {
    for (const f of [listFile, idsFile, blobsFile, join(runRoot, `${repo}.blob`)]) rmSync(f, { force: true });
  }
}

/** Every entry under `dir` (not following symlinks), as paths relative to it with "/" separators. */
function walk(dir: string, visit: (rel: string, abs: string, kind: "file" | "dir" | "link" | "other") => void, rel = ""): void {
  let names: string[];
  try {
    names = readdirSync(join(dir, rel));
  } catch {
    return;
  }
  for (const n of names.sort()) {
    const r = rel === "" ? n : `${rel}/${n}`;
    const abs = join(dir, r);
    const st = lstatSync(abs);
    const kind = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    visit(r, abs, kind);
    if (kind === "dir") walk(dir, visit, r);
  }
}

/** T6-4: whitespace runs (line breaks included) as one space, trimmed: a reflowed or re-indented quote still matches. */
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
const quoteSet = (quotes: readonly string[]) => [...new Set(quotes.map(normalize).filter((q) => q.length >= QUOTE_MIN))];
const quotes_in = (text: string, qs: readonly string[]) => {
  const t = normalize(text);
  return qs.some((q) => t.includes(q));
};
/** A file with no extension counts as text when its first 8 KB hold no NUL byte. */
function isTextFile(abs: string): boolean {
  const fd = openSync(abs, "r");
  try {
    const b = Buffer.alloc(8192);
    const n = readSync(fd, b, 0, b.length, 0);
    return !b.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove the text files the branch added (not in `baseFiles`, paths relative to the repo root) that contain any of
 * `quotes` (≥60 characters; whitespace-normalized on both sides, T6-4): .md .txt .adoc .rst .mdx .markdown .html .htm
 * .json .yaml .yml and extensionless text files. The design and debate stay out of the acceptance agent's context,
 * whatever .gitattributes says. Returns the removed paths (relative, sorted).
 */
export async function excludeDesignQuotes(dest: string, baseFiles: ReadonlySet<string>, quotes: readonly string[]): Promise<string[]> {
  const qs = quoteSet(quotes);
  if (qs.length === 0) return [];
  const removed: string[] = [];
  walk(dest, (rel, abs, kind) => {
    if (kind !== "file" || baseFiles.has(rel)) return;
    const ext = extname(rel).toLowerCase();
    if (!TEXT_EXTS.has(ext) && !(ext === "" && isTextFile(abs))) return;
    if (quotes_in(readFileSync(abs, "utf8"), qs)) removed.push(rel);
  });
  for (const r of removed) rmSync(join(dest, r), { force: true });
  return removed.sort();
}

/**
 * The ≥60-character lines (trimmed, deduplicated) of the current choice's design docs (overall and per repo, with
 * their comment responses), its debate (critic comments and suggestions, designer responses, the developer's
 * rulings), the chosen solution's approach and the choice note.
 */
export function designQuoteLines(db: DatabaseSync, key: string): string[] {
  const choice = currentChoice(db, key);
  if (!choice) return [];
  const texts: string[] = [];
  const sol = getSolution(db, choice.solutionId);
  if (sol) texts.push(sol.content.approach);
  if (choice.note) texts.push(choice.note);
  for (const d of listDesignDocs(db, key).filter((x) => x.choiceId === choice.id)) {
    texts.push(d.doc.contentMd, ...d.doc.repos.map((r) => r.contentMd), ...d.doc.responses.map((r) => r.reason));
  }
  const rounds = listRounds(db, key, choice.id);
  for (const r of rounds) {
    if ("comments" in r.content) texts.push(...r.content.comments.flatMap((c) => [c.text, c.suggestion ?? ""]));
    else texts.push(...r.content.responses.map((x) => x.reason));
  }
  const roundIds = new Set(rounds.map((r) => r.id));
  texts.push(...listRulings(db, key).filter((r) => roundIds.has(r.debateRoundId)).map((r) => r.note));
  return quoteSet(texts.flatMap((t) => t.split(/\r?\n/)));
}

const shq = (s: string): string => {
  if (s.includes("'")) throw new AcceptanceIsolationError(`refusing to write the playwright shim: ${JSON.stringify(s.slice(0, 200))} contains a single quote`);
  return `'${s}'`;
};

/**
 * The Playwright scaffold in <workDir>/acceptance (config, specs/, evidence/, the @playwright/test symlink into
 * Slack Off's own install) and the shim <shimDir>/playwright. T6-3: the shim does not sandbox — the acceptance agent's
 * Bash runs inside the acceptance wrapper (T5-2) and the platform re-run under sandboxArgv, and sandboxes cannot be
 * nested. It only accepts exactly `playwright test`, cds to the acceptance dir and execs Slack Off's playwright under
 * `env -i` with a fixed environment (I2: nothing of the caller's, no tokens): PATH = node's dir + /usr/bin:/bin, HOME,
 * USER, LANG, TMPDIR / TMP / TEMP = <runRoot>/tmp. The sandbox cannot write the shim dir (T6-2). Anything else exits 2.
 */
export function writePlaywrightScaffold(dirs: AcceptanceRunDirs, repoRoot: string, targets: readonly AcceptanceTarget[], sandbox: SandboxScope): void {
  if (sandbox.kind !== "acceptance") throw new AcceptanceIsolationError(`the playwright shim runs under the acceptance sandbox, not ${sandbox.kind}`);
  if (sandbox.runRoot !== undefined && resolve(sandbox.runRoot) !== resolve(dirs.runRoot)) {
    throw new AcceptanceIsolationError(`the sandbox's run root ${sandbox.runRoot} is not this run's ${dirs.runRoot}`);
  }
  const playwright = join(repoRoot, "node_modules", ".bin", "playwright");
  const tmp = runTmpDir(dirs.runRoot);
  const env: Array<[string, string]> = [
    ["PATH", `${dirname(process.execPath)}:/usr/bin:/bin`],
    ["HOME", process.env.HOME ?? homedir()],
    ["USER", process.env.USER ?? userInfo().username],
    ...(process.env.LANG ? [["LANG", process.env.LANG] as [string, string]] : []),
    ["TMPDIR", tmp],
    ["TMP", tmp],
    ["TEMP", tmp],
  ];
  // build the whole shim before touching the scaffold, so a refused path writes nothing
  const body = [
    "#!/bin/sh",
    "# Slack Off (Task 6, T6-3): the acceptance agent's only `playwright`. Runs exactly `playwright test` from the run's",
    "# acceptance dir with a fixed environment; the caller's acceptance sandbox applies. Anything else is refused.",
    'if [ "$#" -ne 1 ] || [ "$1" != "test" ]; then',
    "  echo 'Slack Off: only \"playwright test\" is allowed here' >&2",
    "  exit 2",
    "fi",
    `cd ${shq(dirs.acceptanceDir)} || exit 2`,
    `exec /usr/bin/env -i ${env.map(([k, v]) => `${k}=${shq(v)}`).join(" ")} ${shq(playwright)} 'test'`,
    "",
  ].join("\n");
  const web = targets.find((t) => t.entry === "web");
  const config = {
    testDir: "specs",
    outputDir: "artifacts",
    reporter: [["json", { outputFile: "results.json" }]],
    workers: 1,
    use: { ...(web ? { baseURL: web.baseUrl } : {}), screenshot: "on" },
    // Playwright's own Chromium headless shell: never channel 'chrome' or a user data dir (spike §4.1)
    projects: [{ name: ACCEPT_BROWSER, use: { browserName: ACCEPT_BROWSER } }],
  };
  mkdirSync(join(dirs.acceptanceDir, "specs"), { recursive: true });
  mkdirSync(join(dirs.acceptanceDir, "evidence"), { recursive: true });
  writeFileSync(
    join(dirs.acceptanceDir, "playwright.config.mjs"),
    `// Written by Slack Off for this acceptance run.\nexport default ${JSON.stringify(config, null, 2)};\n`,
  );
  const link = join(dirs.acceptanceDir, "node_modules", "@playwright", "test");
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(join(repoRoot, "node_modules", "@playwright", "test"), link);
  const shim = join(dirs.shimDir, "playwright");
  writeFileSync(shim, body, { mode: 0o755 });
  chmodSync(shim, 0o755);
}

/** Phase 4f: what the `slackoff-cases` shim runs: per repo its target, environment and case rules (written by the platform). */
export interface CasesShimConfig {
  runRoot: string;
  acceptanceDir: string;
  acIds: string[];
  timeoutMs: number;
  repos: Array<
    | { repo: string; kind: "cli"; command: string[]; snapshotDir: string; display: string; env: Record<string, string>; caseRules: { envKeys: string[]; dotfiles: string[] } }
    | { repo: string; kind: "library"; importName: string; packageDir: string; env: Record<string, string>; caseRules: { envKeys: string[]; dotfiles: string[] } }
  >;
}

/** The Node entry of the `slackoff-cases` shim (in the server source, outside every agent dir). */
export const CASES_SHIM_SCRIPT = join(import.meta.dirname, "cases-shim.mjs");
export const CASES_SHIM = "slackoff-cases";
export const CASES_SHIM_CONFIG = "slackoff-cases.json";

/**
 * Phase 4f (Task 4): the acceptance agent's only command for command-line and library entries, `<runRoot>/bin/slackoff-cases`,
 * and its configuration next to it (the sandbox cannot write bin/, T6-2). Like the playwright shim (T6-3) it does not
 * sandbox itself — the agent's Bash wrapper is the sandbox — and accepts exactly `slackoff-cases run`: it cds to the
 * acceptance dir and execs this Node with cases-shim.mjs under `env -i` and a fixed environment. Anything else exits 2.
 */
export function writeCasesShim(dirs: AcceptanceRunDirs, cfg: CasesShimConfig, sandbox: SandboxScope): void {
  if (sandbox.kind !== "acceptance" || sandbox.runRoot === undefined || resolve(sandbox.runRoot) !== resolve(dirs.runRoot)) {
    throw new AcceptanceIsolationError("the cases shim runs under the acceptance sandbox of its own run");
  }
  const tmp = runTmpDir(dirs.runRoot);
  const env: Array<[string, string]> = [
    ["PATH", `${dirname(process.execPath)}:/usr/bin:/bin`],
    ["HOME", process.env.HOME ?? homedir()],
    ["USER", process.env.USER ?? userInfo().username],
    ...(process.env.LANG ? [["LANG", process.env.LANG] as [string, string]] : []),
    ["TMPDIR", tmp],
    ["TMP", tmp],
    ["TEMP", tmp],
  ];
  const config = join(dirs.shimDir, CASES_SHIM_CONFIG);
  const body = [
    "#!/bin/sh",
    "# Slack Off (phase 4f): the acceptance agent's only command for command-line and library entries. Runs exactly",
    "# `slackoff-cases run` (the declared cases) with a fixed environment; the caller's acceptance sandbox applies.",
    'if [ "$#" -ne 1 ] || [ "$1" != "run" ]; then',
    "  echo 'Slack Off: only \"slackoff-cases run\" is allowed here' >&2",
    "  exit 2",
    "fi",
    `cd ${shq(dirs.acceptanceDir)} || exit 2`,
    `exec /usr/bin/env -i ${env.map(([k, v]) => `${k}=${shq(v)}`).join(" ")} ${shq(process.execPath)} '--disable-sigusr1' ${shq(CASES_SHIM_SCRIPT)} ${shq(config)}`,
    "",
  ].join("\n");
  mkdirNoFollow(dirs.runRoot, dirs.shimDir);
  writeFileSync(config, JSON.stringify(cfg), { mode: 0o644 });
  const shim = join(dirs.shimDir, CASES_SHIM);
  writeFileSync(shim, body, { mode: 0o755 });
  chmodSync(shim, 0o755);
}

/**
 * Phase 4f (LIB_LINK): the case scaffold in an acceptance dir — cases/ (the agent's *.case.json) and examples/ (a
 * library's example .mjs files) — and, for a library, examples/node_modules/<name> → the snapshot's package dir
 * (`@scope/name`: node_modules/@scope/ a real dir). Dirs are made without following a symlink; whatever is at the
 * link's name is replaced (an earlier run of the agent may have planted something there).
 */
export function writeCasesScaffold(acceptanceDir: string, o: { library?: Pick<LibTarget, "importName" | "packageDir"> }): void {
  mkdirNoFollow(dirname(acceptanceDir), acceptanceDir);
  for (const d of ["cases", "examples"]) mkdirNoFollow(acceptanceDir, join(acceptanceDir, d));
  if (o.library === undefined) return;
  const name = o.library.importName;
  if (!/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(name)) throw new AcceptanceIsolationError(`refusing the library name ${JSON.stringify(name)}`);
  const link = join(acceptanceDir, "examples", "node_modules", ...name.split("/"));
  mkdirNoFollow(acceptanceDir, dirname(link));
  rmSync(link, { recursive: true, force: true });
  symlinkSync(o.library.packageDir, link);
}

/**
 * The isolation checks before the agent runs; returns the names of the checks passed. Any violation →
 * AcceptanceIsolationError listing the paths: an entry named .git; a database file; a symlink out of the run root
 * (except the @playwright/test link into <repoRoot>/node_modules); the run root, work dir or config dir inside
 * SLACKOFF_HOME or a repo; the shim dir inside the work dir or holding anything but `playwright`; a config-dir entry
 * outside ACCEPT_CONFIG_ALLOWED; a config-dir file containing a design line.
 */
export function assertAcceptanceIsolation(
  dirs: AcceptanceRunDirs,
  o: {
    home: string;
    repoPaths: readonly string[];
    repoRoot: string;
    quotes: readonly string[];
    /** T6-5: exportRepo's blob ids; a database file whose content is that committed blob is allowed */
    exported?: ReadonlyMap<string, string>;
    /** phase 4f: the files bin/ may hold (default: the playwright shim) */
    shims?: readonly string[];
  },
): string[] {
  const violations: string[] = [];
  const checks: string[] = [];
  const check = (name: string, found: string[]) => {
    if (found.length === 0) checks.push(name);
    else violations.push(`${name}: ${found.join(", ")}`);
  };

  const placed: string[] = [];
  for (const [what, p] of [["run root", dirs.runRoot], ["work dir", dirs.workDir], ["config dir", dirs.configDir]] as const) {
    try {
      assertOutside(p, o.home, o.repoPaths, what);
    } catch (e) {
      placed.push((e as Error).message);
    }
  }
  if (!inside(dirs.workDir, dirs.runRoot) || !inside(dirs.acceptanceDir, dirs.workDir)) placed.push(`work dir ${dirs.workDir} is not inside ${dirs.runRoot}`);
  check("outside-home-and-repos", placed);

  const shim: string[] = [];
  if (sameOrInside(dirs.shimDir, dirs.workDir)) shim.push(`${dirs.shimDir} is inside the work dir`);
  let shimEntries: string[] = [];
  try {
    shimEntries = readdirSync(dirs.shimDir);
  } catch {
    shim.push(`${dirs.shimDir} is missing`);
  }
  const shims = o.shims ?? ["playwright"];
  shim.push(...shimEntries.filter((n) => !shims.includes(n)).map((n) => join(dirs.shimDir, n)));
  check("shim-only", shim);

  const git: string[] = [];
  const db: string[] = [];
  const links: string[] = [];
  const pwLink = join(dirs.acceptanceDir, "node_modules", "@playwright", "test");
  const pwRoot = join(o.repoRoot, "node_modules");
  for (const base of [dirs.runRoot, dirs.configDir]) {
    walk(base, (rel, abs, kind) => {
      const name = basename(rel);
      if (name === ".git") git.push(abs);
      if (kind !== "dir" && DB_FILE.test(name) && !(kind === "file" && isCommittedBlob(abs, o.exported))) db.push(abs);
      if (kind === "link" && base === dirs.runRoot) {
        const target = resolve(dirname(abs), readlinkSync(abs));
        const ok = abs === pwLink ? inside(target, pwRoot) && inside(real(target), real(pwRoot)) : sameOrInside(target, dirs.runRoot) && sameOrInside(real(target), dirs.runRoot);
        if (!ok) links.push(`${abs} -> ${target}`);
      }
    });
  }
  check("no-git", git);
  check("no-db", db);
  check("no-escaping-links", links);

  let top: string[] = [];
  try {
    top = readdirSync(dirs.configDir);
  } catch {
    // a missing config dir has nothing in it
  }
  check("config-dir-allowlist", top.filter((n) => !ACCEPT_CONFIG_ALLOWED.includes(n)).map((n) => join(dirs.configDir, n)));

  // M6: no symlink at all in the config dir; what one points to is scanned for design text all the same
  const qs = quoteSet(o.quotes);
  const quoted: string[] = [];
  const cfgLinks: string[] = [];
  walk(dirs.configDir, (_rel, abs, kind) => {
    if (kind === "link") cfgLinks.push(`${abs} -> ${readlinkSync(abs)}`);
    if ((kind !== "file" && kind !== "link") || qs.length === 0) return;
    let text: string;
    try {
      if (kind === "link" && !lstatSync(realpathSync(abs)).isFile()) return;
      text = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    if (quotes_in(text, qs)) quoted.push(abs);
  });
  check("config-dir-no-links", cfgLinks);
  check("config-dir-no-design-text", quoted);

  if (violations.length > 0) throw new AcceptanceIsolationError(`acceptance isolation check failed — ${violations.join("; ")}`);
  return checks;
}

/** T6-5: whether `abs` holds exactly the blob exportRepo wrote there (git's blob hash, sha1 or sha256 repos). */
function isCommittedBlob(abs: string, exported: ReadonlyMap<string, string> | undefined): boolean {
  const oid = exported?.get(abs);
  if (oid === undefined) return false;
  const content = readFileSync(abs);
  const h = createHash(oid.length === 64 ? "sha256" : "sha1");
  h.update(`blob ${content.length}\0`);
  h.update(content);
  return h.digest("hex") === oid;
}

/** Remove the run root, then the config dir's ACCEPT_CONFIG_PURGE folders. */
export async function cleanupRunDirs(dirs: AcceptanceRunDirs): Promise<void> {
  rmSync(dirs.runRoot, { recursive: true, force: true });
  purgeConfigDir(dirs.configDir);
}

