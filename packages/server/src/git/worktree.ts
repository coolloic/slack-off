/**
 * Per-ticket, per-repo git worktrees under `${SLACKOFF_HOME}/worktrees/<KEY>/<repo>` and the platform's commits.
 *
 * The developer's own checkout is only ever asked for `worktree add` (which creates the branch) and `worktree remove`
 * (non-force); nothing here checks out, resets, stashes or cleans it. Destructive operations run only on paths that
 * pass {@link assertPlatformWorktree}. Commits run the repo's own hooks — `--no-verify` is never used — via `add -A`
 * then `commit -m` (never `commit -a`), so a timeout kill leaves no index.lock behind (S-5).
 */
import { chmodSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { guessBranchType, isBranchType, type BranchType, type CommitOutcome } from "@slackoff/shared";
import { REPO_NAME, type RepoRef } from "../config.ts";
import { RepoNotMappedError } from "../projects/project-rules.ts";
import { hashHooksDir } from "./hooks-hash.ts";
import { runGit, runProcess, type GitResult, type ProcessOptions, type ProcessResult } from "./run.ts";
import { isSshUrl, redactUrls, SSH_CONFIG } from "./net.ts";

export { runProcess, type ProcessOptions, type ProcessResult };

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

const OUTPUT_TAIL_BYTES = 8 * 1024;
/** One path segment for the ticket directory: a JIRA-like key, never `.`/`..`/separators. */
const TICKET_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA = /^[0-9a-f]{40,64}$/;
/** Directories whose tracked content is restored from HEAD before every commit (S-3). */
const PROTECTED_DIRS = [".slackoff", ".husky", ".githooks"] as const;
/** husky v9's generated, gitignored hooks dir: protected by --restricted and deny rules only (A-5). */
const GENERATED_HUSKY_DIR = ".husky/_";

/** `git -C <cwd> <args>`: no shell, stdin closed, own process group (killed whole on timeout), GIT_TERMINAL_PROMPT=0. */
export async function git(cwd: string, args: string[], timeoutMs?: number): Promise<GitResult> {
  const { tail: _tail, ...r } = await runGit(cwd, args, timeoutMs === undefined ? {} : { timeoutMs });
  return r;
}

const firstLine = (s: string) => s.trim().split("\n")[0]?.replace(/^fatal:\s*/i, "") ?? "";

async function gitOk(cwd: string, args: string[], what: string): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new WorktreeError(`${what}: ${firstLine(r.stderr) || `git exited with ${r.code}`}`);
  return r.stdout;
}

// ---------------------------------------------------------------- names and paths

/** NFKD without accents → lower-case → runs of non [a-z0-9] become one '-' → trimmed → ≤40 chars cut at a '-'; empty → 'ticket'. */
export function ticketSlug(title: string): string {
  let s = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > 40) {
    const cut = s.slice(0, 41);
    const dash = cut.lastIndexOf("-");
    s = dash > 0 ? cut.slice(0, dash) : s.slice(0, 40);
    s = s.replace(/-+$/, "");
  }
  return s === "" ? "ticket" : s;
}

function checkKey(key: string): void {
  if (!TICKET_KEY.test(key)) throw new WorktreeError(`invalid ticket key "${key}"`);
}

function checkRepoName(repo: string): void {
  if (!REPO_NAME.test(repo) || repo === "." || repo === "..") throw new WorktreeError(`invalid repository name "${repo}"`);
}

/**
 * `<type>/<KEY>-<slug>` (feat/, fix/, docs/… — the ticket's chosen type, else guessed from its title); computed only
 * when a (ticket, repo) worktree is first created — the stored branch is reused after (P-C8).
 */
export function branchName(key: string, title: string, type: BranchType = guessBranchType(title)): string {
  checkKey(key);
  if (!isBranchType(type)) throw new WorktreeError(`invalid branch type "${String(type)}"`);
  return `${type}/${key}-${ticketSlug(title)}`;
}

export function ticketDir(home: string, key: string): string {
  checkKey(key);
  return join(home, "worktrees", key);
}

export function worktreePath(home: string, key: string, repo: string): string {
  checkRepoName(repo);
  return join(ticketDir(home, key), repo);
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/** The real path of a platform worktree: `realpath(home)/worktrees/<KEY>/<repo>` exactly, or a WorktreeError. */
export function assertPlatformWorktree(home: string, path: string, repoPath: string): string {
  const realHome = realOrNull(home);
  const real = realOrNull(path);
  if (realHome === null || real === null) throw new WorktreeError(`${path} is not a Slack Off worktree (it does not exist)`);
  const rel = relative(join(realHome, "worktrees"), real);
  const parts = rel.split(sep);
  if (rel === "" || isAbsolute(rel) || parts.length !== 2 || !TICKET_KEY.test(parts[0]!) || !REPO_NAME.test(parts[1]!) || parts.includes("..")) {
    throw new WorktreeError(`${path} is not a Slack Off worktree (expected ${join(realHome, "worktrees", "<KEY>", "<repo>")})`);
  }
  if (!existsSync(join(real, ".git")) || !statSync(join(real, ".git")).isFile()) {
    throw new WorktreeError(`${path} is not a Slack Off worktree (no worktree .git file)`);
  }
  // the .git file must name a linked-worktree admin dir `<common>/worktrees/<id>` whose back-link is this worktree, so a
  // forged .git pointing at the developer's repository (or another worktree) is refused before reset / commit
  const forged = () => new WorktreeError(`${path} is not a Slack Off worktree (its .git file does not point at its own worktree admin directory)`);
  const m = readFileSync(join(real, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) throw forged();
  const admin = realOrNull(resolve(real, m[1]!));
  if (admin === null || basename(dirname(admin)) !== "worktrees") throw forged();
  let common: string | null = null;
  let backLink: string | null = null;
  try {
    common = realOrNull(resolve(admin, readFileSync(join(admin, "commondir"), "utf8").trim()));
    backLink = realOrNull(resolve(admin, readFileSync(join(admin, "gitdir"), "utf8").trim()));
  } catch {
    throw forged();
  }
  if (common !== dirname(dirname(admin)) || backLink !== join(real, ".git")) throw forged();
  // 4A-3 / 4A-8: a self-consistent admin dir of another repository is still a forgery — the common dir must be the
  // mapped repo's (required at every call site)
  const expected = repoCommonDir(repoPath);
  if (expected === null || common !== expected) {
    throw new WorktreeError(`${path} is not a Slack Off worktree of ${repoPath} (its git common dir ${common} is not ${expected ?? "that repository's"})`);
  }
  return real;
}

/** The real path of a repository's git common dir (`<repo>/.git`, or what a `.git` file / its commondir names); null if none. */
export function repoCommonDir(repoPath: string): string | null {
  const dotgit = join(repoPath, ".git");
  try {
    if (statSync(dotgit).isDirectory()) return realOrNull(dotgit);
    const m = readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) return null;
    const gitdir = resolve(repoPath, m[1]!);
    let common = gitdir;
    try {
      common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
    } catch {
      // not a linked worktree: the gitdir is the common dir
    }
    return realOrNull(common);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- create / remove

interface ListedWorktree {
  path: string;
  branch: string | null;
}

async function listWorktrees(repoTop: string): Promise<ListedWorktree[]> {
  const out = await gitOk(repoTop, ["worktree", "list", "--porcelain", "-z"], "cannot list worktrees");
  const list: ListedWorktree[] = [];
  let cur: ListedWorktree | null = null;
  for (const line of out.split("\0")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null };
      list.push(cur);
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length);
    }
  }
  return list;
}

/** The repo's real top-level path, or RepoNotMappedError naming the repo (T4-2: the mapped path must be the top). */
async function repoTop(repo: RepoRef): Promise<string> {
  const notRepo = () => new RepoNotMappedError(`${repo.name}: ${repo.path} is not a git repository — fix Settings`);
  const real = realOrNull(repo.path);
  if (real === null) throw notRepo();
  const top = await git(real, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw notRepo();
  if (realOrNull(top.stdout.trim()) !== real) {
    throw new RepoNotMappedError(`${repo.name}: ${repo.path} is not the top of a git repository — fix Settings`);
  }
  return real;
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  return r.code === 0 && SHA.test(r.stdout.trim());
}

/**
 * The (ticket, repo) worktree on `branch` — the stored branch, or `branchName(key, title)` the first time. Reuses an
 * existing worktree on that branch (`created: false`); otherwise adds one for the existing branch or a new branch from
 * the repo's base branch. Never touches the developer's checkout beyond `worktree add`.
 */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
const FETCH_TIMEOUT_MS = 120_000;

/**
 * Before a ticket branch is made from the base branch, bring the developer's local base up to date with origin:
 * fetch it (only refs/remotes/origin/<base> moves), then create a missing local base from it or fast-forward one that
 * is behind. Never a merge, never a rewrite: a base checked out in a working folder and behind, a base with commits
 * origin lacks, or a failed fetch block the step with the reason (WorktreeError) and change nothing. No origin, or a
 * base origin does not have: nothing to do (the local branch decides). Hooks never run here (a ref update fires
 * reference-transaction); ssh never prompts.
 */
async function syncBaseFromOrigin(top: string, repo: RepoRef): Promise<void> {
  const b = repo.baseBranch;
  const url = (await git(top, ["config", "--get", "remote.origin.url"])).stdout.trim();
  if (url === "" || (await git(top, ["check-ref-format", "--branch", b])).code !== 0) return;
  const pushUrl = (await git(top, ["remote", "get-url", "--push", "origin"])).stdout.trim();
  const net = isSshUrl(url) || isSshUrl(pushUrl) ? [...SSH_CONFIG] : [];
  const fetched = await runGit(top, [...NO_HOOKS, ...net, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], { timeoutMs: FETCH_TIMEOUT_MS });
  if (fetched.timedOut) throw new WorktreeError(`${repo.name}: fetching ${b} from origin took too long — check the network, then Retry`);
  if (fetched.code !== 0) {
    if (/couldn't find remote ref/i.test(fetched.stderr)) return;
    throw new WorktreeError(`${repo.name}: cannot fetch ${b} from origin (${redactUrls(firstLine(fetched.stderr)) || `git exited with ${fetched.code}`}) — check the network and your access, then Retry`);
  }
  const sha = async (ref: string) => {
    const v = await git(top, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    return v.code === 0 && SHA.test(v.stdout.trim()) ? v.stdout.trim() : null;
  };
  const remote = await sha(`refs/remotes/origin/${b}`);
  if (remote === null) return;
  const local = await sha(`refs/heads/${b}`);
  const update = async (oldValue: string) => {
    const u = await git(top, [...NO_HOOKS, "update-ref", "-m", "slackoff: base branch from origin", `refs/heads/${b}`, remote, oldValue]);
    if (u.code !== 0) throw new WorktreeError(`${repo.name}: cannot update ${b} from origin (${firstLine(u.stderr)}) — update it yourself, then Retry`);
  };
  if (local === null) return update(""); // "" = it must not exist yet
  if (local === remote) return;
  const behind = (await git(top, ["merge-base", "--is-ancestor", local, remote])).code === 0;
  if (!behind) throw new WorktreeError(`${repo.name}: your ${b} has commits that are not on origin — push them or reset it, then Retry`);
  const checkedOut = (await listWorktrees(top)).find((w) => w.branch === `refs/heads/${b}`);
  if (checkedOut) throw new WorktreeError(`${repo.name}: ${b} is checked out in ${checkedOut.path} and behind origin — pull it, then Retry`);
  await update(local);
}

export async function ensureWorktree(o: { home: string; key: string; repo: RepoRef; branch: string }): Promise<{ path: string; created: boolean }> {
  const { home, key, repo, branch } = o;
  const path = worktreePath(home, key, repo.name);
  const top = await repoTop(repo);
  const fmt = await git(top, ["check-ref-format", "--branch", branch]);
  if (fmt.code !== 0 || fmt.stdout.trim() !== branch) throw new WorktreeError(`${repo.name}: invalid branch name "${branch}"`);
  // a new ticket branch starts from the base as origin has it now (an existing one keeps its own history)
  if (!(await branchExists(top, branch))) await syncBaseFromOrigin(top, repo);
  const baseOk = (await git(top, ["check-ref-format", "--branch", repo.baseBranch])).code === 0 && (await branchExists(top, repo.baseBranch));
  if (!baseOk) throw new RepoNotMappedError(`${repo.name}: base branch ${repo.baseBranch} not found in ${repo.path} — fix Settings`);

  const listed = await listWorktrees(top);
  const realPath = realOrNull(path);
  // compare canonical paths; a deleted worktree directory still has a real parent
  const canonical = (p: string) => realOrNull(p) ?? join(realOrNull(dirname(p)) ?? dirname(p), basename(p));
  const mine = listed.find((w) => canonical(w.path) === canonical(path));
  if (mine && realPath !== null) {
    if (mine.branch === `refs/heads/${branch}`) return { path, created: false };
    throw new WorktreeError(`${repo.name}: ${path} is a worktree on ${mine.branch?.replace(/^refs\/heads\//, "") ?? "a detached HEAD"}, not ${branch}`);
  }
  if (realPath !== null) throw new WorktreeError(`${repo.name}: ${path} already exists and is not a worktree of ${repo.path}`);

  // `add -f` would also allow a second checkout of a branch checked out elsewhere: refuse that first
  const elsewhere = listed.find((w) => w !== mine && w.branch === `refs/heads/${branch}`);
  if (elsewhere) throw new WorktreeError(`${repo.name}: branch ${branch} is checked out in ${elsewhere.path} — switch that checkout to another branch`);
  // a registered worktree whose directory was deleted: `add -f` re-registers exactly this platform path
  const force = mine ? ["-f"] : [];
  const args = (await branchExists(top, branch))
    ? ["worktree", "add", "--quiet", ...force, path, branch]
    : ["worktree", "add", "--quiet", ...force, "-b", branch, path, `refs/heads/${repo.baseBranch}`];
  const r = await git(top, args, 120_000);
  if (r.code !== 0) throw new WorktreeError(`${repo.name}: cannot create the worktree (${firstLine(r.stderr)})`);
  return { path, created: true };
}

/** `worktree remove` without --force; uncommitted changes → WorktreeError naming the repo. The branch is kept (P-C9). */
export async function removeWorktree(home: string, key: string, repo: RepoRef): Promise<void> {
  const path = worktreePath(home, key, repo.name);
  if (realOrNull(path) === null) return;
  const real = assertPlatformWorktree(home, path, repo.path);
  const top = await repoTop(repo);
  if ((await changedPaths(real)).length > 0) throw new WorktreeError(`${repo.name}: the worktree ${path} has uncommitted changes — commit or discard them first`);
  const r = await git(top, ["worktree", "remove", real], 120_000);
  if (r.code !== 0) throw new WorktreeError(`${repo.name}: cannot remove the worktree ${path} (${firstLine(r.stderr)})`);
}

// ---------------------------------------------------------------- changes

/** Changed paths relative to the worktree (`status --porcelain -z -uall`), untracked included; both sides of a rename. */
export async function changedPaths(wt: string): Promise<string[]> {
  return statusPaths(wt, []);
}

async function statusPaths(wt: string, pathspec: string[]): Promise<string[]> {
  const out = await gitOk(wt, ["--literal-pathspecs", "status", "--porcelain", "-z", "-uall", "--no-renames", "--", ...pathspec], "cannot read git status");
  const paths: string[] = [];
  for (const entry of out.split("\0")) if (entry.length > 3) paths.push(entry.slice(3));
  return paths;
}

/** The gitlinks (mode 160000) of the index (`ls-files -s`) or of a tree (`ls-tree -r`): path → commit id. */
async function gitlinks(wt: string, args: string[]): Promise<Map<string, string>> {
  const out = await gitOk(wt, args, "cannot list gitlinks");
  const links = new Map<string, string>();
  for (const rec of out.split("\0")) {
    // ls-files -s: "<mode> <sha> <stage>\t<path>"; ls-tree: "<mode> <type> <sha>\t<path>"
    const m = rec.match(/^160000 (?:commit )?([0-9a-f]{40,64})(?: \d)?\t(.+)$/s);
    if (m) links.set(m[2]!, m[1]!);
  }
  return links;
}

/**
 * F4A-2 (C-B): a git repository nested in the worktree is never committed, nor looked into by the platform's git (git
 * add / status / diff run its own config — filters, fsmonitor — outside the sandbox). Refused: an untracked directory
 * git reports as a repository (`?? dir/`, with .git inside), a gitlink whose directory holds a .git (a populated
 * submodule), and any gitlink of the index that is not HEAD's (new or moved). HEAD's own unpopulated gitlinks (a
 * submodule repository's worktree, never initialised here) are kept as they are.
 */
async function assertNoNestedRepos(real: string): Promise<void> {
  const refuse = (what: string) => new WorktreeError(`${real}: ${what} — a nested repository or submodule is never committed or looked into; nothing committed`);
  const status = await gitOk(real, ["status", "--porcelain", "-z", "-uall", "--no-renames"], "cannot read git status");
  for (const entry of status.split("\0")) {
    if (!entry.startsWith("?? ") || !entry.endsWith("/")) continue;
    const dir = entry.slice(3);
    if (lstatOrNull(join(real, dir, ".git")) !== null) throw refuse(`${dir} is an embedded git repository`);
  }
  const head = await gitlinks(real, ["ls-tree", "-r", "-z", "HEAD"]);
  for (const [p, sha] of await gitlinks(real, ["ls-files", "-s", "-z"])) {
    if (lstatOrNull(join(real, p, ".git")) !== null) throw refuse(`${p}/ is an embedded git repository (a populated submodule)`);
    if (head.get(p) !== sha) {
      // nothing of it stays staged (the index back to HEAD; the next commit adds everything again)
      await gitOk(real, ["reset", "--quiet"], "cannot unstage");
      throw refuse(`${p} is a ${head.has(p) ? "moved" : "new"} gitlink (submodule)`);
    }
  }
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** The absolute path of `p` inside the real worktree, refusing anything that escapes it (`..`, absolute, via a symlinked parent). */
function inside(realWt: string, p: string): string {
  const abs = resolve(realWt, p);
  const rel = relative(realWt, abs);
  if (p === "" || isAbsolute(p) || rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new WorktreeError(`${p} is outside the worktree`);
  const parent = realOrNull(dirname(abs));
  if (parent === null) return abs; // nothing there to delete
  const relParent = relative(realWt, parent);
  if (relParent.startsWith("..") || isAbsolute(relParent)) throw new WorktreeError(`${p} is outside the worktree`);
  return join(parent, basename(abs));
}

/**
 * F4A-3 (M-a): delete `abs` (inside the real worktree `realWt`) and, for a dir, everything below it, never through a
 * symlink: right before each unlink / rmdir every component from the worktree down is lstat'd again, so a parent dir
 * swapped for a symlink after the platform looked is refused (WorktreeError), not followed. Symlinks are removed as
 * links. Missing → nothing to do.
 */
function removeNoFollow(realWt: string, abs: string): void {
  const rel = relative(realWt, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new WorktreeError(`${abs} is outside the worktree`);
  /** false when a component is missing (nothing left to delete); throws on a symlink or non-dir parent */
  const plainChain = (p: string): boolean => {
    const st = lstatOrNull(realWt);
    if (st === null || !st.isDirectory()) throw new WorktreeError(`${realWt} is not a plain directory — nothing deleted`);
    let cur = realWt;
    for (const part of relative(realWt, p).split(sep).slice(0, -1)) {
      cur = join(cur, part);
      const c = lstatOrNull(cur);
      if (c === null) return false;
      if (!c.isDirectory()) throw new WorktreeError(`${cur} changed into a ${c.isSymbolicLink() ? "symlink" : "file"} while being reverted — not deleted`);
    }
    return true;
  };
  const rm = (p: string): void => {
    if (!plainChain(p)) return;
    const st = lstatOrNull(p);
    if (st === null) return;
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) rm(join(p, name));
      if (plainChain(p) && lstatOrNull(p)?.isDirectory() === true) rmdirSync(p);
      return;
    }
    if (plainChain(p)) unlinkSync(p);
  };
  rm(abs);
}

/** Undo changes to `paths`: tracked in HEAD → restore index and file from HEAD; otherwise unstage and delete. */
export async function revertPaths(home: string, wt: string, repoPath: string, paths: string[]): Promise<void> {
  const real = assertPlatformWorktree(home, wt, repoPath);
  if (paths.length === 0) return;
  const abs = paths.map((p) => inside(real, p));
  const inHead = new Set(
    (await gitOk(real, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ...paths], "cannot read HEAD"))
      .split("\0")
      .filter((p) => p !== ""),
  );
  const untracked = paths.filter((p) => !inHead.has(p));
  if (untracked.length > 0) {
    await gitOk(real, ["--literal-pathspecs", "rm", "--cached", "--quiet", "--ignore-unmatch", "-r", "--", ...untracked], "cannot unstage");
    for (const [i, p] of paths.entries()) {
      if (inHead.has(p)) continue;
      removeNoFollow(real, abs[i]!);
    }
  }
  const tracked = paths.filter((p) => inHead.has(p));
  if (tracked.length > 0) {
    await gitOk(real, ["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked], "cannot restore files");
  }
}

// ---------------------------------------------------------------- hooks

/** 4A-2: reads the repository's own hooks configuration (runGit's no-hooks default left out); never runs a hook. */
async function hooksConfig(cwd: string, args: string[]): Promise<GitResult> {
  const { tail: _tail, ...r } = await runGit(cwd, args, { configuredHooks: true });
  return r;
}

/** The resolved hooks directory (`--git-path hooks`, which follows core.hooksPath), absolute. */
async function resolvedHooksDir(wt: string): Promise<string> {
  const r = await hooksConfig(wt, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  if (r.code !== 0) throw new WorktreeError(`cannot resolve the hooks directory: ${firstLine(r.stderr) || `git exited with ${r.code}`}`);
  return r.stdout.trim();
}

/** The hooks directory relative to the worktree when core.hooksPath points inside it (e.g. `.githooks`, `.husky/_`); else []. */
export async function hookDirs(wt: string): Promise<string[]> {
  const realWt = realOrNull(wt);
  if (realWt === null) return [];
  const dir = await resolvedHooksDir(realWt);
  // husky v9's `.husky/_` may not exist yet: resolve its parent
  const realDir = realOrNull(dir) ?? join(realOrNull(dirname(dir)) ?? dirname(dir), basename(dir));
  const rel = relative(realWt, realDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return [];
  return [rel.split(sep).join("/")];
}

function mentionsHusky(pkgJson: string): boolean {
  try {
    const pkg = JSON.parse(pkgJson) as Record<string, unknown>;
    const keys = (v: unknown) => (v && typeof v === "object" ? Object.keys(v) : []);
    const values = (v: unknown) => (v && typeof v === "object" ? Object.values(v).map(String) : []);
    return (
      [...keys(pkg.dependencies), ...keys(pkg.devDependencies), ...keys(pkg.optionalDependencies)].includes("husky") ||
      values(pkg.scripts).some((s) => /\bhusky\b/.test(s)) ||
      "husky" in pkg
    );
  } catch {
    return false;
  }
}

/**
 * configured: core.hooksPath is set, or the worktree's package.json uses husky. installed: the resolved hooks directory
 * holds at least one executable, non-*.sample file (husky v9 skips hooks silently until install ran — S-3).
 */
export async function hooksInstalled(wt: string): Promise<{ configured: boolean; installed: boolean; hooksPath: string | null }> {
  const cfg = await hooksConfig(wt, ["config", "--get", "core.hooksPath"]);
  const hooksPath = cfg.code === 0 && cfg.stdout.trim() !== "" ? cfg.stdout.trim() : null;
  let husky = false;
  try {
    husky = mentionsHusky(readFileSync(join(wt, "package.json"), "utf8"));
  } catch {
    // no package.json
  }
  const dir = await resolvedHooksDir(wt);
  let installed = false;
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".sample")) continue;
      const st = statSync(join(dir, name));
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        installed = true;
        break;
      }
    }
  } catch {
    // no hooks directory
  }
  return { configured: hooksPath !== null || husky, installed, hooksPath };
}

/**
 * A hooks directory the developer's tools generate (husky's `.husky/_` from `npm install`) is git-ignored, so a new
 * worktree lacks it, and generating it inside the sandbox fails (husky writes core.hooksPath to the read-only git
 * config). When core.hooksPath names such a directory and the worktree has none, copy it from the developer's own
 * checkout: only a relative path inside both, git-ignored (never tracked content), a real directory of plain files
 * (no links, no subdirectories), modes kept. Returns the copied paths (repo-relative), or null when nothing was
 * copied. The hooks then run in the sandbox like any other and are pinned after (hooksFingerprint).
 */
export async function adoptHooksFromCheckout(repoPath: string, wt: string): Promise<string[] | null> {
  const cfg = await hooksConfig(wt, ["config", "--get", "core.hooksPath"]);
  const hp = cfg.code === 0 ? cfg.stdout.trim() : "";
  if (hp === "" || isAbsolute(hp) || hp.startsWith("~") || hp.split(/[\\/]/).includes("..") || /[\0\n]/.test(hp)) return null;
  const top = realOrNull(repoPath);
  const root = realOrNull(wt);
  if (top === null || root === null) return null;
  const src = resolve(top, hp);
  const dst = resolve(root, hp);
  if (!src.startsWith(top + sep) || !dst.startsWith(root + sep) || existsSync(dst)) return null;
  // the directory itself, not reached through a link anywhere on its path
  if (realOrNull(src) !== src) return null;
  let st: Stats;
  try {
    st = lstatSync(src);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;
  const names = readdirSync(src).sort();
  if (names.length === 0 || names.some((n) => !lstatSync(join(src, n)).isFile())) return null;
  // generated, never tracked: nothing under it is in git, and every file is git-ignored in the developer's checkout
  // (by the repo's .gitignore, or by the generator's own .gitignore inside, as husky v9 writes "*")
  const rel = names.map((n) => `${hp.replace(/\/+$/, "")}/${n}`);
  const tracked = await git(top, ["ls-files", "--", hp]);
  if (tracked.code !== 0 || tracked.stdout.trim() !== "") return null;
  const ignored = await git(top, ["check-ignore", "--", ...rel]);
  if (ignored.code !== 0 || ignored.stdout.split("\n").filter((l) => l !== "").length !== rel.length) return null;
  mkdirSync(dst, { recursive: true });
  for (const n of names) {
    copyFileSync(join(src, n), join(dst, n), fsConstants.COPYFILE_EXCL);
    chmodSync(join(dst, n), lstatSync(join(src, n)).mode & 0o777);
  }
  return rel;
}

/** The hooks gate of a worktree, pinned when development prepares it and compared before every commit (F2-I1). */
export interface HooksPin {
  /** `git config --get core.hooksPath` as configured (any scope, worktree config included), or null */
  hooksPath: string | null;
  /** the resolved hooks directory, absolute (real path when it exists) */
  dir: string;
  /** sha256 over the hook files there (names, executable bits, contents; symlinks by target) */
  hash: string;
}

/** core.hooksPath, the resolved hooks directory and a hash of its hook files (F2-I1). */
export async function hooksFingerprint(wt: string): Promise<HooksPin> {
  const real = realOrNull(wt) ?? wt;
  const cfg = await hooksConfig(real, ["config", "--get", "core.hooksPath"]);
  const hooksPath = cfg.code === 0 && cfg.stdout.trim() !== "" ? cfg.stdout.trim() : null;
  const resolved = await resolvedHooksDir(real);
  const dir = realOrNull(resolved) ?? resolved;
  return { hooksPath, dir, hash: hashHooksDir(dir) };
}

/**
 * Restore `.slackoff/`, `.husky/`, `.githooks/` and the in-worktree hooks directory from HEAD: tracked changes restored,
 * untracked files deleted, gitignored files left alone (a generated `.husky/_`, A-5). Returns the reverted paths.
 */
export async function restoreProtected(home: string, wt: string, repoPath: string): Promise<string[]> {
  const real = assertPlatformWorktree(home, wt, repoPath);
  const dirs = [...new Set([...PROTECTED_DIRS, ...(await hookDirs(real))])];
  const changed = await statusPaths(real, dirs);
  // gitignored files there too (a hook the agent added behind .gitignore), except husky's generated `.husky/_` (A-5)
  const ignored = (await gitOk(real, ["--literal-pathspecs", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...dirs], "cannot list ignored files"))
    .split("\0")
    .filter((p) => p !== "" && p !== GENERATED_HUSKY_DIR && !p.startsWith(`${GENERATED_HUSKY_DIR}/`));
  const paths = [...new Set([...changed, ...ignored])];
  await revertPaths(home, real, repoPath, paths);
  return paths;
}

// ---------------------------------------------------------------- commit

/** After a timeout kill: delete the worktree's index.lock, but only at `<git-common-dir>/worktrees/<id>/index.lock`. */
async function removeStaleLock(realWt: string): Promise<void> {
  const gitFile = readFileSync(join(realWt, ".git"), "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
  if (!gitFile) return;
  const id = gitFile[1]!.split(/[\\/]/).filter((s) => s !== "").pop();
  if (!id) return;
  const lockOut = await git(realWt, ["rev-parse", "--path-format=absolute", "--git-path", "index.lock"]);
  const commonOut = await git(realWt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (lockOut.code !== 0 || commonOut.code !== 0) return;
  const common = realOrNull(commonOut.stdout.trim());
  const lock = lockOut.stdout.trim();
  const lockDir = realOrNull(dirname(lock));
  if (common === null || lockDir === null || !lock.endsWith(`${sep}index.lock`)) return;
  const expected = join(common, "worktrees", id);
  if (lockDir !== expected) return;
  try {
    unlinkSync(join(expected, "index.lock"));
  } catch {
    // no lock
  }
}

async function identityArgs(wt: string): Promise<string[]> {
  const name = await git(wt, ["config", "--get", "user.name"]);
  const email = await git(wt, ["config", "--get", "user.email"]);
  const args: string[] = [];
  if (name.code !== 0 || name.stdout.trim() === "") args.push("-c", "user.name=Slack Off");
  if (email.code !== 0 || email.stdout.trim() === "") args.push("-c", "user.email=slackoff@localhost");
  return args;
}

/**
 * Commit everything in a platform worktree through the repo's own hooks: restore the protected files, `add -A`, then
 * `commit -m`. No staged change → nothing; a non-zero exit or a timeout → hook_failed with the last 8 KB of output.
 * `opts.hooksDir` (absolute) is passed as `-c core.hooksPath=<dir>` (to add and commit) so a changed config cannot
 * redirect the hooks; phase 4a callers pass the hook wrapper dir (sandbox/hook-wrappers.ts).
 */
export async function commitAll(
  home: string,
  wt: string,
  message: string,
  hookTimeoutMs: number,
  opts: { hooksDir: string; repoPath: string; branch: string },
): Promise<CommitOutcome> {
  const real = assertPlatformWorktree(home, wt, opts.repoPath);
  // 4A-10: the commit goes to the recorded ticket branch only (a hook or check that re-pointed HEAD is refused)
  const headRef = async () => {
    const r = await git(real, ["symbolic-ref", "-q", "HEAD"]);
    const now = r.code === 0 ? r.stdout.trim() : "a detached HEAD";
    if (now !== `refs/heads/${opts.branch}`) throw new WorktreeError(`${real}: HEAD is ${now}, not the ticket branch refs/heads/${opts.branch} — nothing committed`);
  };
  await headRef();
  // F4A-2: before `add -A`, which looks into a populated gitlink's working tree (its `status`, its filters)
  await assertNoNestedRepos(real);
  await restoreProtected(home, real, opts.repoPath);
  // F2-I1 / phase 4a: the pinned (wrapper) hooks dir for the add too — writing the index can run post-index-change
  if (!isAbsolute(opts.hooksDir)) throw new WorktreeError(`${real}: the hooks directory to commit with must be absolute`);
  const pinned = ["-c", `core.hooksPath=${opts.hooksDir}`];
  const add = await runGit(real, [...pinned, "add", "-A"], { timeoutMs: hookTimeoutMs, tailBytes: OUTPUT_TAIL_BYTES });
  if (add.timedOut) await removeStaleLock(real);
  if (add.code !== 0) throw new WorktreeError(`${real}: git add failed${add.timedOut ? " (timed out)" : ""}: ${firstLine(add.tail)}`);
  // ... and after it: nothing the add staged may be a new or moved gitlink
  await assertNoNestedRepos(real);
  const staged = await git(real, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return { kind: "nothing" };
  await headRef();
  if (staged.code !== 1) throw new WorktreeError(`${real}: cannot read the staged changes: ${firstLine(staged.stderr)}`);

  // F2-I1: a pinned hooks directory overrides whatever core.hooksPath says now (phase 4a: the platform's wrapper dir,
  // which runs each pinned hook in the dev-hook sandbox)
  const commit = await runGit(real, [...pinned, ...(await identityArgs(real)), "commit", "--quiet", "-m", message], {
    timeoutMs: hookTimeoutMs,
    tailBytes: OUTPUT_TAIL_BYTES,
  });
  if (commit.timedOut) await removeStaleLock(real);
  if (commit.code !== 0 || commit.timedOut) return { kind: "hook_failed", timedOut: commit.timedOut, outputTail: commit.tail };
  const sha = (await gitOk(real, ["rev-parse", "HEAD"], "cannot read HEAD")).trim();
  // phase 4a Task 8: `commit --quiet` prints nothing of its own, so the tail is what the hooks printed (shown with the step)
  return { kind: "committed", sha, ...(commit.tail.trim() !== "" ? { hookOutput: commit.tail } : {}) };
}

/** `reset --hard HEAD` + `clean -fd` (ignored files kept), only in a platform worktree. */
export async function resetToHead(home: string, wt: string, repoPath: string): Promise<void> {
  const real = assertPlatformWorktree(home, wt, repoPath);
  await gitOk(real, ["reset", "--quiet", "--hard", "HEAD"], "cannot reset the worktree");
  await gitOk(real, ["clean", "-q", "-fd"], "cannot clean the worktree");
}

// ---------------------------------------------------------------- branch summaries

const baseRef = (baseBranch: string) => `refs/heads/${baseBranch}`;

/** Commits on HEAD not on the base branch, newest first. */
export async function commitsSince(wt: string, baseBranch: string): Promise<{ sha: string; subject: string }[]> {
  const out = await gitOk(wt, ["log", "-z", "--format=%H%x1f%s", `${baseRef(baseBranch)}..HEAD`], "cannot list commits");
  return out
    .split("\0")
    .filter((l) => l !== "")
    .map((l) => {
      const [sha, subject] = l.split("\x1f");
      return { sha: sha!.trim(), subject: subject ?? "" };
    });
}

/** Files, insertions and deletions of the branch against its merge base with the base branch. */
export async function diffStat(wt: string, baseBranch: string): Promise<{ files: number; insertions: number; deletions: number }> {
  const out = await gitOk(wt, ["diff", "--numstat", "-z", `${baseRef(baseBranch)}...HEAD`], "cannot read the diff");
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const rec of out.split("\0")) {
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t/);
    if (!m) continue;
    files++;
    insertions += m[1] === "-" ? 0 : Number(m[1]);
    deletions += m[2] === "-" ? 0 : Number(m[2]);
  }
  return { files, insertions, deletions };
}

/** The branch's diff against its merge base with the base branch, cut at `maxBytes`. */
export async function diffText(wt: string, baseBranch: string, maxBytes = 1_000_000): Promise<{ text: string; truncated: boolean }> {
  const r = await runGit(wt, ["diff", `${baseRef(baseBranch)}...HEAD`], { maxOutput: maxBytes });
  if (r.code !== 0 && !r.truncated) throw new WorktreeError(`cannot read the diff: ${firstLine(r.stderr)}`);
  return { text: r.stdout, truncated: r.truncated };
}
