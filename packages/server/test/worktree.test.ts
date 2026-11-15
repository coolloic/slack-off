import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertPlatformWorktree, branchName, changedPaths, commitAll, commitsSince, diffStat, diffText, ensureWorktree, git, hookDirs,
  hooksFingerprint, hooksInstalled, removeWorktree, resetToHead, restoreProtected, revertPaths, ticketDir, ticketSlug, worktreePath, WorktreeError,
} from "../src/git/worktree.ts";
import { runCommand, UnsafeCommandError } from "../src/development/run-command.ts";
import { RepoNotMappedError } from "../src/projects/project-rules.ts";
import { tmpDir } from "./helpers/tmp.ts";

const root = realpathSync(tmpDir("wt"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** git for test setup only: per-repo identity via -c, never global config */
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** A fresh repo on branch main with the given files committed (executable when the name ends in a hook name). */
function repo(files: Record<string, string>, config: Record<string, string> = {}, name = `repo-${n++}`): string {
  const dir = join(root, "repos", name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "commit.gpgsign", "false");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
    if (/(^|\/)(pre-commit|commit-msg)$/.test(p)) chmodSync(join(dir, p), 0o755);
  }
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "init");
  for (const [k, v] of Object.entries(config)) sh(dir, "config", k, v); // after the first commit, so its hooks do not gate setup
  return dir;
}

let h = 0;
const newHome = () => {
  const d = join(root, `home-${h++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const ref = (name: string, path: string, baseBranch = "main") => ({ name, path, baseBranch });
const head = (dir: string) => sh(dir, "rev-parse", "HEAD").trim();
const hook = (body: string) => `#!/bin/sh\n${body}\n`;
/** 4A-8: the repo a worktree (or the repo itself) belongs to, from its git common dir; a path that is none of these → a dir that never exists */
const repoOf = (p: string): string => {
  try {
    return dirname(realpathSync(sh(p, "rev-parse", "--path-format=absolute", "--git-common-dir").trim()));
  } catch {
    return "/nonexistent-slackoff-repo";
  }
};
/** 4A-4: commitAll always gets a hooks dir (here the worktree's resolved one, no sandbox in these tests) and the repo path */
const pinned = async (wt: string) => ({
  hooksDir: (await hooksFingerprint(wt)).dir, repoPath: repoOf(wt), branch: sh(wt, "symbolic-ref", "--short", "HEAD").trim(),
});

// ---------------------------------------------------------------- names and paths

test("ticketSlug: strip accents, lower-case, dashes, cut at a dash to ≤40, empty → ticket", () => {
  assert.equal(ticketSlug("Implement Stripe tax calculation fallback webhook"), "implement-stripe-tax-calculation");
  assert.equal(ticketSlug("Café — ünïcode!!"), "cafe-unicode");
  assert.equal(ticketSlug("???"), "ticket");
  assert.equal(ticketSlug(""), "ticket");
  assert.equal(ticketSlug("a".repeat(60)), "a".repeat(40), "a single word longer than 40 is cut at 40");
  for (const t of ["Implement Stripe tax calculation fallback webhook", "x ".repeat(50), "Ünïcödé ".repeat(10)]) {
    const s = ticketSlug(t);
    assert.ok(s.length <= 40 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s), s);
  }
});

test("branchName, ticketDir and worktreePath", () => {
  assert.equal(branchName("K-1", "Café — ünïcode!!"), "feat/K-1-cafe-unicode");
  // the type: chosen for the ticket, else guessed from the title (a defect is fix)
  assert.equal(branchName("K-1", "Login button broken"), "fix/K-1-login-button-broken");
  assert.equal(branchName("K-1", "Login button broken", "chore"), "chore/K-1-login-button-broken");
  assert.throws(() => branchName("K-1", "x", "feature" as never), WorktreeError);
  assert.equal(ticketDir("/h", "K-1"), "/h/worktrees/K-1");
  assert.equal(worktreePath("/h", "K-1", "api"), "/h/worktrees/K-1/api");
  assert.throws(() => worktreePath("/h", "../x", "api"), WorktreeError);
  assert.throws(() => worktreePath("/h", "K-1", ".."), WorktreeError);
  assert.throws(() => branchName("K 1", "x"), WorktreeError);
});

// ---------------------------------------------------------------- ensureWorktree / removeWorktree

test("ensureWorktree: one worktree per repo under worktrees/<KEY>/<repo>, same branch, main checkout untouched", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n", "b.txt": "b\n" });
  const web = repo({ "w.txt": "w\n" });
  // the developer's own checkout: a stash and uncommitted + untracked changes
  writeFileSync(join(api, "a.txt"), "stashed\n");
  sh(api, "stash", "-q");
  writeFileSync(join(api, "b.txt"), "dirty\n");
  writeFileSync(join(api, "untracked.txt"), "u\n");
  const before = { head: head(api), status: sh(api, "status", "--porcelain"), stash: sh(api, "stash", "list"), branch: sh(api, "branch", "--show-current") };

  const branch = branchName("K-1", "Add login");
  const a = await ensureWorktree({ home, key: "K-1", repo: ref("api", api), branch });
  const w = await ensureWorktree({ home, key: "K-1", repo: ref("web", web), branch });
  assert.deepEqual(a, { path: join(home, "worktrees", "K-1", "api"), created: true });
  assert.deepEqual(w, { path: join(home, "worktrees", "K-1", "web"), created: true });
  assert.equal(sh(a.path, "branch", "--show-current").trim(), "feat/K-1-add-login");
  assert.equal(sh(w.path, "branch", "--show-current").trim(), "feat/K-1-add-login");
  assert.equal(readFileSync(join(a.path, "b.txt"), "utf8"), "b\n", "the worktree starts from the base branch");

  assert.deepEqual(
    { head: head(api), status: sh(api, "status", "--porcelain"), stash: sh(api, "stash", "list"), branch: sh(api, "branch", "--show-current") },
    before,
  );
  assert.equal(readFileSync(join(api, "b.txt"), "utf8"), "dirty\n");

  const again = await ensureWorktree({ home, key: "K-1", repo: ref("api", api), branch });
  assert.deepEqual(again, { path: a.path, created: false });
});

test("ensureWorktree reuses an existing branch after the worktree dir was deleted and pruned, and uses the branch it is given", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const branch = "slackoff/K-2-old-title";
  const first = await ensureWorktree({ home, key: "K-2", repo: ref("api", api), branch });
  writeFileSync(join(first.path, "feature.txt"), "f\n");
  const c = await commitAll(home, first.path, "work", 10_000, await pinned(first.path));
  assert.equal(c.kind, "committed");

  rmSync(first.path, { recursive: true, force: true });
  sh(api, "worktree", "prune");
  const second = await ensureWorktree({ home, key: "K-2", repo: ref("api", api), branch });
  assert.equal(second.created, true);
  assert.equal(sh(second.path, "branch", "--show-current").trim(), branch, "the stored branch, not branchName(new title)");
  assert.equal(readFileSync(join(second.path, "feature.txt"), "utf8"), "f\n", "the branch's commits are kept");
  assert.notEqual(branchName("K-2", "A new title"), branch);

  // deleted but not pruned: the stale registration of exactly this platform path is replaced
  rmSync(second.path, { recursive: true, force: true });
  const third = await ensureWorktree({ home, key: "K-2", repo: ref("api", api), branch });
  assert.equal(third.created, true);
  assert.equal(readFileSync(join(third.path, "feature.txt"), "utf8"), "f\n");
});

test("ensureWorktree errors name the repo: missing base branch, not a repo, not the repo top, foreign path", async () => {
  const home = newHome();
  const web = repo({ "w.txt": "w\n" });
  await assert.rejects(
    ensureWorktree({ home, key: "K-3", repo: ref("web", web, "develop"), branch: "slackoff/K-3-x" }),
    (e: unknown) => e instanceof RepoNotMappedError && /web/.test(e.message) && /develop/.test(e.message),
  );
  const plain = join(root, "plain-dir");
  mkdirSync(plain, { recursive: true });
  await assert.rejects(
    ensureWorktree({ home, key: "K-3", repo: ref("plain", plain), branch: "slackoff/K-3-x" }),
    (e: unknown) => e instanceof RepoNotMappedError && /plain/.test(e.message) && /not a git repository/.test(e.message),
  );
  mkdirSync(join(web, "sub"));
  await assert.rejects(
    ensureWorktree({ home, key: "K-3", repo: ref("websub", join(web, "sub")), branch: "slackoff/K-3-x" }),
    (e: unknown) => e instanceof RepoNotMappedError && /websub/.test(e.message) && /not the top/.test(e.message),
  );
  // the target path exists but is not this repo's worktree
  mkdirSync(worktreePath(home, "K-3", "web"), { recursive: true });
  writeFileSync(join(worktreePath(home, "K-3", "web"), "x"), "x");
  await assert.rejects(
    ensureWorktree({ home, key: "K-3", repo: ref("web", web), branch: "slackoff/K-3-x" }),
    (e: unknown) => e instanceof WorktreeError && /web/.test(e.message),
  );
  await assert.rejects(
    ensureWorktree({ home, key: "K-3", repo: ref("web", web), branch: "slackoff/K 3" }),
    (e: unknown) => e instanceof WorktreeError,
  );
});

test("removeWorktree: clean → removed and branch kept; uncommitted files → WorktreeError naming the repo", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const branch = "slackoff/K-4-x";
  const wt = await ensureWorktree({ home, key: "K-4", repo: ref("api", api), branch });
  await removeWorktree(home, "K-4", ref("api", api));
  assert.equal(existsSync(wt.path), false);
  assert.match(sh(api, "branch", "--list", branch), /slackoff\/K-4-x/);

  const again = await ensureWorktree({ home, key: "K-4", repo: ref("api", api), branch });
  writeFileSync(join(again.path, "new.txt"), "n\n");
  await assert.rejects(removeWorktree(home, "K-4", ref("api", api)), (e: unknown) => e instanceof WorktreeError && /api/.test(e.message));
  assert.equal(existsSync(join(again.path, "new.txt")), true);
  await removeWorktree(home, "K-9", ref("api", api)); // nothing there: no-op
});

// ---------------------------------------------------------------- guards, reset, revert

test("assertPlatformWorktree and resetToHead refuse anything but <home>/worktrees/<KEY>/<repo>", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  writeFileSync(join(api, "a.txt"), "main dirty\n");
  writeFileSync(join(api, "main-untracked.txt"), "u\n");
  const status = sh(api, "status", "--porcelain");
  await assert.rejects(resetToHead(home, api, repoOf(api)), WorktreeError);
  assert.equal(sh(api, "status", "--porcelain"), status);
  assert.equal(readFileSync(join(api, "a.txt"), "utf8"), "main dirty\n");

  const wt = await ensureWorktree({ home, key: "K-5", repo: ref("api", api), branch: "slackoff/K-5-x" });
  assert.doesNotThrow(() => assertPlatformWorktree(home, wt.path, repoOf(wt.path)));
  assert.throws(() => assertPlatformWorktree(home, ticketDir(home, "K-5"), repoOf(ticketDir(home, "K-5"))), WorktreeError);
  assert.throws(() => assertPlatformWorktree(home, join(wt.path, "sub"), repoOf(join(wt.path, "sub"))), WorktreeError);
  // a symlink inside worktrees/ that points at the developer's checkout
  symlinkSync(api, join(ticketDir(home, "K-5"), "evil"));
  assert.throws(() => assertPlatformWorktree(home, join(ticketDir(home, "K-5"), "evil"), repoOf(join(ticketDir(home, "K-5"), "evil"))), WorktreeError);
  await assert.rejects(resetToHead(home, join(ticketDir(home, "K-5"), "evil"), repoOf(join(ticketDir(home, "K-5"), "evil"))), WorktreeError);
  assert.equal(readFileSync(join(api, "a.txt"), "utf8"), "main dirty\n");

  writeFileSync(join(wt.path, "a.txt"), "changed\n");
  mkdirSync(join(wt.path, "newdir"));
  writeFileSync(join(wt.path, "newdir", "f.txt"), "f\n");
  await resetToHead(home, wt.path, repoOf(wt.path));
  assert.equal(readFileSync(join(wt.path, "a.txt"), "utf8"), "a\n");
  assert.equal(existsSync(join(wt.path, "newdir")), false);
});

test("changedPaths lists tracked and untracked changes; revertPaths restores tracked and deletes untracked", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n", "infra/main.tf": "tf\n", "gone.txt": "g\n" });
  const wt = await ensureWorktree({ home, key: "K-6", repo: ref("api", api), branch: "slackoff/K-6-x" });
  writeFileSync(join(wt.path, "infra/main.tf"), "hacked\n");
  writeFileSync(join(wt.path, "a.txt"), "keep me\n");
  mkdirSync(join(wt.path, "infra/new"), { recursive: true });
  writeFileSync(join(wt.path, "infra/new/x.tf"), "x\n");
  writeFileSync(join(wt.path, "with space.txt"), "s\n");
  rmSync(join(wt.path, "gone.txt"));
  sh(wt.path, "add", "infra/main.tf"); // staged changes are reverted too

  assert.deepEqual((await changedPaths(wt.path)).sort(), ["a.txt", "gone.txt", "infra/main.tf", "infra/new/x.tf", "with space.txt"]);
  await revertPaths(home, wt.path, repoOf(wt.path), ["infra/main.tf", "infra/new/x.tf", "gone.txt", "with space.txt"]);
  assert.equal(readFileSync(join(wt.path, "infra/main.tf"), "utf8"), "tf\n");
  assert.equal(existsSync(join(wt.path, "infra/new/x.tf")), false);
  assert.equal(readFileSync(join(wt.path, "gone.txt"), "utf8"), "g\n");
  assert.equal(existsSync(join(wt.path, "with space.txt")), false);
  assert.deepEqual(await changedPaths(wt.path), ["a.txt"]);

  await assert.rejects(revertPaths(home, wt.path, repoOf(wt.path), ["../escape.txt"]), WorktreeError);
  await assert.rejects(revertPaths(home, api, repoOf(api), ["a.txt"]), WorktreeError);
});

// ---------------------------------------------------------------- commits through the repo's hooks

test("commitAll runs the repo's pre-commit: failure → hook_failed with its output, HEAD unchanged; success → committed", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const wt = await ensureWorktree({ home, key: "K-7", repo: ref("api", api), branch: "slackoff/K-7-x" });
  const hookPath = join(api, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, hook('echo "lint failed" >&2\nexit 1'));
  chmodSync(hookPath, 0o755);

  assert.deepEqual(await commitAll(home, wt.path, "nothing to do", 10_000, await pinned(wt.path)), { kind: "nothing" });

  writeFileSync(join(wt.path, "a.txt"), "change\n");
  const before = head(wt.path);
  const failed = await commitAll(home, wt.path, "K-7: change", 10_000, await pinned(wt.path));
  assert.equal(failed.kind, "hook_failed");
  assert.ok(failed.kind === "hook_failed" && failed.outputTail.includes("lint failed") && failed.timedOut === false);
  assert.equal(head(wt.path), before);
  assert.equal(readFileSync(join(wt.path, "a.txt"), "utf8"), "change\n", "the change is kept for the next step");

  writeFileSync(hookPath, hook("exit 0"));
  const ok = await commitAll(home, wt.path, "K-7: change", 10_000, await pinned(wt.path));
  assert.equal(ok.kind, "committed");
  assert.ok(ok.kind === "committed" && /^[0-9a-f]{40}$/.test(ok.sha));
  assert.equal(ok.kind === "committed" && ok.sha, head(wt.path));
  assert.ok(ok.kind === "committed" && ok.hookOutput === undefined, "a silent hook: no hook output");
  assert.equal(sh(wt.path, "log", "-1", "--format=%s").trim(), "K-7: change");
  assert.deepEqual(await commitsSince(wt.path, "main"), [{ sha: head(wt.path), subject: "K-7: change" }]);
  assert.equal(head(api), before, "the main checkout's HEAD did not move");
});

const sleeping = (marker: string) => execFileSync("ps", ["-A", "-o", "command"], { encoding: "utf8" }).split("\n").some((l) => l.includes(marker));

test("commitAll hook timeout: process group killed, no index.lock left, next commit works; a stale lock is removed", async () => {
  const home = newHome();
  const slow = join(root, "slow-marker");
  writeFileSync(slow, "");
  const api = repo({ "a.txt": "a\n" });
  const hookPath = join(api, ".git", "hooks", "pre-commit");
  // the second form leaves an index.lock behind, as a killed `commit -a` would
  writeFileSync(
    hookPath,
    hook(`if [ -f "${slow}" ]; then\n  if [ -f "${slow}-lock" ]; then touch "$(git rev-parse --path-format=absolute --git-path index.lock)"; fi\n  sleep 7.31\nfi\nexit 0`),
  );
  chmodSync(hookPath, 0o755);
  const wt = await ensureWorktree({ home, key: "K-8", repo: ref("api", api), branch: "slackoff/K-8-x" });
  const lock = join(api, ".git", "worktrees", "api", "index.lock");

  writeFileSync(join(wt.path, "a.txt"), "change\n");
  const t0 = Date.now();
  const out = await commitAll(home, wt.path, "slow", 500, await pinned(wt.path));
  assert.ok(Date.now() - t0 < 5000, "returned after the timeout, not after the hook");
  assert.equal(out.kind, "hook_failed");
  assert.ok(out.kind === "hook_failed" && out.timedOut);
  assert.equal(existsSync(lock), false);
  assert.equal(sleeping("sleep 7.31"), false, "no orphaned sleep");

  writeFileSync(`${slow}-lock`, "");
  const locked = await commitAll(home, wt.path, "slow", 500, await pinned(wt.path));
  assert.ok(locked.kind === "hook_failed" && locked.timedOut);
  assert.equal(existsSync(lock), false, "the stale lock was removed");

  rmSync(slow);
  const ok = await commitAll(home, wt.path, "fast", 10_000, await pinned(wt.path));
  assert.equal(ok.kind, "committed");
});

test("commitAll: a hook that reads stdin gets EOF and does not hang", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const hookPath = join(api, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, hook('read x\necho "read returned"\nexit 0'));
  chmodSync(hookPath, 0o755);
  const wt = await ensureWorktree({ home, key: "K-10", repo: ref("api", api), branch: "slackoff/K-10-x" });
  writeFileSync(join(wt.path, "a.txt"), "change\n");
  const out = await commitAll(home, wt.path, "stdin", 5_000, await pinned(wt.path));
  assert.equal(out.kind, "committed");
});

test("core.hooksPath=.husky: the committed hook runs inside the worktree", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n", ".husky/pre-commit": hook('echo "husky ran in $PWD"\nexit 1') }, { "core.hooksPath": ".husky" });
  const wt = await ensureWorktree({ home, key: "K-11", repo: ref("api", api), branch: "slackoff/K-11-x" });
  writeFileSync(join(wt.path, "a.txt"), "change\n");
  const out = await commitAll(home, wt.path, "husky", 10_000, await pinned(wt.path));
  assert.ok(out.kind === "hook_failed" && out.outputTail.includes(`husky ran in ${wt.path}`), JSON.stringify(out));
  assert.deepEqual(await hookDirs(wt.path), [".husky"]);
});

test("the agent cannot weaken the hooks or the rules: both are restored from HEAD before every commit (S-3)", async () => {
  const home = newHome();
  const blocking = hook('echo "blocked by hook"\nexit 1');
  const api = repo(
    { "a.txt": "a\n", ".githooks/pre-commit": blocking, ".slackoff/config.json": '{"forbiddenPaths":["infra/**"]}' },
    { "core.hooksPath": ".githooks" },
  );
  const wt = await ensureWorktree({ home, key: "K-12", repo: ref("api", api), branch: "slackoff/K-12-x" });
  assert.deepEqual(await hookDirs(wt.path), [".githooks"]);

  writeFileSync(join(wt.path, ".githooks/pre-commit"), hook("exit 0"));
  writeFileSync(join(wt.path, ".githooks/commit-msg"), hook("exit 0"));
  writeFileSync(join(wt.path, "a.txt"), "change\n");
  const out = await commitAll(home, wt.path, "tamper", 10_000, await pinned(wt.path));
  assert.ok(out.kind === "hook_failed" && out.outputTail.includes("blocked by hook"), JSON.stringify(out));
  assert.equal(readFileSync(join(wt.path, ".githooks/pre-commit"), "utf8"), blocking);
  assert.equal(existsSync(join(wt.path, ".githooks/commit-msg")), false);

  // .slackoff/ edits never reach a commit
  sh(api, "config", "--unset", "core.hooksPath");
  writeFileSync(join(wt.path, ".slackoff/config.json"), '{"forbiddenPaths":[]}');
  writeFileSync(join(wt.path, ".slackoff/rules.md"), "new rules");
  const reverted = await restoreProtected(home, wt.path, repoOf(wt.path));
  assert.deepEqual(reverted.sort(), [".slackoff/config.json", ".slackoff/rules.md"]);
  writeFileSync(join(wt.path, ".slackoff/config.json"), '{"forbiddenPaths":[]}');
  const ok = await commitAll(home, wt.path, "real change", 10_000, await pinned(wt.path));
  assert.equal(ok.kind, "committed");
  assert.equal(readFileSync(join(wt.path, ".slackoff/config.json"), "utf8"), '{"forbiddenPaths":["infra/**"]}');
  assert.equal(sh(wt.path, "show", "--name-only", "--format=", "HEAD").trim(), "a.txt");
});

test("hookDirs is [] for the shared .git/hooks; hooksInstalled detects husky v9 without its generated hooks", async () => {
  const home = newHome();
  const plain = repo({ "a.txt": "a\n" });
  const pw = await ensureWorktree({ home, key: "K-13", repo: ref("plain", plain), branch: "slackoff/K-13-x" });
  assert.deepEqual(await hookDirs(pw.path), []);
  assert.deepEqual(await hooksInstalled(pw.path), { configured: false, installed: false, hooksPath: null });

  const husky = repo(
    { "a.txt": "a\n", ".gitignore": ".husky/_\n", ".husky/pre-commit": "npm test\n", "package.json": '{"devDependencies":{"husky":"^9.0.0"}}' },
    { "core.hooksPath": ".husky/_" },
  );
  const hw = await ensureWorktree({ home, key: "K-13", repo: ref("husky", husky), branch: "slackoff/K-13-x" });
  assert.deepEqual(await hooksInstalled(hw.path), { configured: true, installed: false, hooksPath: ".husky/_" });
  mkdirSync(join(hw.path, ".husky/_"), { recursive: true });
  writeFileSync(join(hw.path, ".husky/_/pre-commit.sample"), hook("exit 0"));
  chmodSync(join(hw.path, ".husky/_/pre-commit.sample"), 0o755);
  writeFileSync(join(hw.path, ".husky/_/pre-commit"), hook("exit 0"));
  assert.equal((await hooksInstalled(hw.path)).installed, false, "not executable yet");
  chmodSync(join(hw.path, ".husky/_/pre-commit"), 0o755);
  assert.deepEqual(await hooksInstalled(hw.path), { configured: true, installed: true, hooksPath: ".husky/_" });
  assert.deepEqual(await hookDirs(hw.path), [".husky/_"]);
  // gitignored generated hooks are not restored or deleted (A-5)
  assert.deepEqual(await restoreProtected(home, hw.path, repoOf(hw.path)), []);
  assert.equal(existsSync(join(hw.path, ".husky/_/pre-commit")), true);

  // husky in package.json without core.hooksPath → configured, not installed
  const pkgOnly = repo({ "package.json": '{"scripts":{"prepare":"husky"}}' });
  const kw = await ensureWorktree({ home, key: "K-13", repo: ref("pkg", pkgOnly), branch: "slackoff/K-13-x" });
  assert.deepEqual(await hooksInstalled(kw.path), { configured: true, installed: false, hooksPath: null });
});

// ---------------------------------------------------------------- branch summaries

test("commitsSince, diffStat and diffText compare the branch with its base", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\nb\nc\n" });
  const wt = await ensureWorktree({ home, key: "K-14", repo: ref("api", api), branch: "slackoff/K-14-x" });
  assert.deepEqual(await commitsSince(wt.path, "main"), []);
  assert.deepEqual(await diffStat(wt.path, "main"), { files: 0, insertions: 0, deletions: 0 });
  writeFileSync(join(wt.path, "a.txt"), "a\nB\nc\nd\n");
  writeFileSync(join(wt.path, "new.txt"), "x".repeat(5000) + "\n");
  assert.equal((await commitAll(home, wt.path, "first", 10_000, await pinned(wt.path))).kind, "committed");
  writeFileSync(join(wt.path, "z.txt"), "z\n");
  assert.equal((await commitAll(home, wt.path, "second", 10_000, await pinned(wt.path))).kind, "committed");
  assert.deepEqual((await commitsSince(wt.path, "main")).map((c) => c.subject), ["second", "first"]);
  assert.deepEqual(await diffStat(wt.path, "main"), { files: 3, insertions: 4, deletions: 1 });
  const full = await diffText(wt.path, "main");
  assert.equal(full.truncated, false);
  assert.match(full.text, /\+B/);
  const cut = await diffText(wt.path, "main", 1000);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length > 0 && Buffer.byteLength(cut.text) <= 1000);
  assert.ok(full.text.startsWith(cut.text));
});

// ---------------------------------------------------------------- the one process-group runner

test("git() never uses a shell and reports a timeout", async () => {
  const api = repo({ "a.txt": "a\n" });
  const r = await git(api, ["rev-parse", "--show-toplevel"]);
  assert.equal(r.code, 0);
  assert.equal(realpathSync(r.stdout.trim()), api);
  assert.equal(r.timedOut, false);
  const bad = await git(api, ["rev-parse", "--verify", "--quiet", "no-such-branch;echo pwned"]);
  assert.notEqual(bad.code, 0);
  assert.doesNotMatch(bad.stdout, /pwned/);
});

test("runCommand: safe commands only, no stdin, 8 KB combined tail, timeout kills the group", async () => {
  const dir = join(root, "cmd");
  mkdirSync(dir, { recursive: true });
  await assert.rejects(runCommand(dir, 'node -e "x"', 10_000, null), UnsafeCommandError);
  await assert.rejects(runCommand(dir, "pnpm test; rm -rf /", 10_000, null), UnsafeCommandError);

  writeFileSync(
    join(dir, "big.js"),
    "process.stdin.on('data',()=>{}).on('end',()=>{for(let i=0;i<500;i++)process.stdout.write('line '+i+' '+'x'.repeat(40)+'\\n');process.stderr.write('END-ERR\\n');process.exit(3)});",
  );
  const big = await runCommand(dir, "node big.js", 10_000, null);
  assert.equal(big.command, "node big.js");
  assert.equal(big.exitCode, 3);
  assert.equal(big.timedOut, false);
  assert.ok(Buffer.byteLength(big.outputTail) <= 8192);
  assert.ok(big.outputTail.includes("line 499") && big.outputTail.includes("END-ERR"));
  assert.ok(!big.outputTail.includes("line 0 "));

  writeFileSync(join(dir, "slow.js"), "require('node:child_process').spawn('sleep',['7.33'],{stdio:'inherit'});setTimeout(()=>{},60000);");
  const slow = await runCommand(dir, "node slow.js", 500, null);
  assert.equal(slow.timedOut, true);
  assert.equal(slow.exitCode, null);
  assert.equal(sleeping("sleep 7.33"), false, "the whole process group was killed");

  const missing = await runCommand(dir, "no-such-program-xyz", 10_000, null);
  assert.equal(missing.exitCode, null);
  assert.match(missing.outputTail, /no-such-program-xyz/);
});

// ---------------------------------------------------------------- fix round 1

test("ensureWorktree refuses to re-add a branch the developer has checked out elsewhere", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const branch = "slackoff/K-20-x";
  const wt = await ensureWorktree({ home, key: "K-20", repo: ref("api", api), branch });
  rmSync(wt.path, { recursive: true, force: true }); // deleted, not pruned
  sh(api, "checkout", "-q", "--ignore-other-worktrees", branch);
  const mainHead = head(api);
  await assert.rejects(
    ensureWorktree({ home, key: "K-20", repo: ref("api", api), branch }),
    (e: unknown) => e instanceof WorktreeError && /api/.test(e.message) && e.message.includes(`branch ${branch} is checked out in ${api}`),
  );
  assert.equal(existsSync(wt.path), false);
  assert.equal(head(api), mainHead);
  assert.equal(sh(api, "branch", "--show-current").trim(), branch);
});

test("HUSKY=0 / HUSKY_SKIP_HOOKS in the server env do not reach commits or commands", async () => {
  const home = newHome();
  const api = repo(
    { "a.txt": "a\n", ".husky/pre-commit": hook('[ "$HUSKY" = "0" ] && exit 0\n[ -n "$HUSKY_SKIP_HOOKS" ] && exit 0\necho "husky hook blocked"\nexit 1') },
    { "core.hooksPath": ".husky" },
  );
  const wt = await ensureWorktree({ home, key: "K-21", repo: ref("api", api), branch: "slackoff/K-21-x" });
  writeFileSync(join(wt.path, "a.txt"), "change\n");
  writeFileSync(join(wt.path, "env.js"), "console.log('HUSKY=' + process.env.HUSKY + ' SKIP=' + process.env.HUSKY_SKIP_HOOKS)");
  const saved = { HUSKY: process.env.HUSKY, HUSKY_SKIP_HOOKS: process.env.HUSKY_SKIP_HOOKS };
  process.env.HUSKY = "0";
  process.env.HUSKY_SKIP_HOOKS = "1";
  try {
    const out = await commitAll(home, wt.path, "skip hooks?", 10_000, await pinned(wt.path));
    assert.ok(out.kind === "hook_failed" && out.outputTail.includes("husky hook blocked"), JSON.stringify(out));
    const r = await runCommand(wt.path, "node env.js", 10_000, null);
    assert.match(r.outputTail, /HUSKY=undefined SKIP=undefined/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("assertPlatformWorktree refuses a forged .git file that points at the developer's repository", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const wt = await ensureWorktree({ home, key: "K-22", repo: ref("api", api), branch: "slackoff/K-22-x" });
  writeFileSync(join(api, "a.txt"), "main dirty\n");
  writeFileSync(join(wt.path, ".git"), `gitdir: ${join(api, ".git")}\n`);
  assert.throws(() => assertPlatformWorktree(home, wt.path, repoOf(wt.path)), WorktreeError);
  await assert.rejects(resetToHead(home, wt.path, repoOf(wt.path)), WorktreeError);
  await assert.rejects(commitAll(home, wt.path, "x", 10_000, { hooksDir: "/var/empty", repoPath: api, branch: "slackoff/K-12-x" }), WorktreeError);
  assert.equal(readFileSync(join(api, "a.txt"), "utf8"), "main dirty\n");

  // another platform worktree's admin dir: the back-link does not match
  const other = await ensureWorktree({ home, key: "K-23", repo: ref("api", api), branch: "slackoff/K-23-x" });
  writeFileSync(join(wt.path, ".git"), readFileSync(join(other.path, ".git"), "utf8"));
  assert.throws(() => assertPlatformWorktree(home, wt.path, repoOf(wt.path)), WorktreeError);
});

test("restoreProtected also deletes gitignored files under the protected dirs, except husky's generated .husky/_", async () => {
  const home = newHome();
  const api = repo(
    { "a.txt": "a\n", ".gitignore": ".githooks/pre-commit\n.slackoff/local.json\n.husky/_\n", ".githooks/README": "hooks\n" },
    { "core.hooksPath": ".githooks" },
  );
  const wt = await ensureWorktree({ home, key: "K-24", repo: ref("api", api), branch: "slackoff/K-24-x" });
  writeFileSync(join(wt.path, ".githooks/pre-commit"), hook("exit 0"));
  chmodSync(join(wt.path, ".githooks/pre-commit"), 0o755);
  mkdirSync(join(wt.path, ".slackoff"), { recursive: true });
  writeFileSync(join(wt.path, ".slackoff/local.json"), "{}");
  mkdirSync(join(wt.path, ".husky/_"), { recursive: true });
  writeFileSync(join(wt.path, ".husky/_/pre-commit"), hook("exit 0"));
  const reverted = await restoreProtected(home, wt.path, repoOf(wt.path));
  assert.deepEqual(reverted.sort(), [".githooks/pre-commit", ".slackoff/local.json"]);
  assert.equal(existsSync(join(wt.path, ".githooks/pre-commit")), false);
  assert.equal(existsSync(join(wt.path, ".slackoff/local.json")), false);
  assert.equal(existsSync(join(wt.path, ".husky/_/pre-commit")), true);
});

test("F2-I1: hooksFingerprint pins hooksPath, the resolved dir and the hook files; commitAll's pinned hooks dir wins over a changed core.hooksPath", async () => {
  const home = newHome();
  const blocking = hook('echo "pinned hook ran"\nexit 1');
  const api = repo({ "a.txt": "a\n", ".githooks/pre-commit": blocking }, { "core.hooksPath": ".githooks" });
  const wt = await ensureWorktree({ home, key: "K-40", repo: ref("api", api), branch: "slackoff/K-40-x" });
  const pin = await hooksFingerprint(wt.path);
  assert.equal(pin.hooksPath, ".githooks");
  assert.equal(pin.dir, join(realpathSync(wt.path), ".githooks"));
  assert.match(pin.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(await hooksFingerprint(wt.path), pin, "stable when nothing changed");

  // the config is redirected to an empty directory: the pinned directory's hook still gates the commit
  const elsewhere = tmpDir("wt-elsewhere");
  sh(api, "config", "core.hooksPath", elsewhere);
  assert.notDeepEqual(await hooksFingerprint(wt.path), pin);
  writeFileSync(join(wt.path, "a.txt"), "change\n");
  const out = await commitAll(home, wt.path, "pinned", 10_000, { hooksDir: pin.dir, repoPath: api, branch: "slackoff/K-40-x" });
  assert.ok(out.kind === "hook_failed" && out.outputTail.includes("pinned hook ran"), JSON.stringify(out));
});

test("F2-I1: hooksFingerprint changes when a hook in the common hooks dir is rewritten", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const hooksDir = join(api, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "pre-commit"), hook("exit 1"));
  chmodSync(join(hooksDir, "pre-commit"), 0o755);
  const wt = await ensureWorktree({ home, key: "K-41", repo: ref("api", api), branch: "slackoff/K-41-x" });
  const pin = await hooksFingerprint(wt.path);
  assert.equal(pin.hooksPath, null);
  assert.equal(pin.dir, realpathSync(hooksDir));
  writeFileSync(join(hooksDir, "pre-commit"), hook("exit 0"));
  assert.notEqual((await hooksFingerprint(wt.path)).hash, pin.hash);
});

// ---------------------------------------------------------------- Task 5 fix round 1: planted git config

test("platform git never runs a planted core.fsmonitor or diff.external (defence in depth behind the sandbox)", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const wt = await ensureWorktree({ home, key: "K-40", repo: ref("api", api), branch: "slackoff/K-40-x" });
  const marker = join(root, "planted-ran");
  const script = join(root, "planted.sh");
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\nexit 0\n`);
  chmodSync(script, 0o755);
  sh(api, "config", "core.fsmonitor", script);
  sh(api, "config", "diff.external", script);
  writeFileSync(join(wt.path, "a.txt"), "changed\n");
  assert.deepEqual(await changedPaths(wt.path), ["a.txt"]);
  await diffText(wt.path, "main", 100_000);
  const r = await git(wt.path, ["diff", "HEAD"]);
  assert.match(r.stdout, /changed/);
  assert.equal(existsSync(marker), false, "the planted program never ran");
  // control: plain git does run it
  execFileSync("git", ["-C", wt.path, "status", "--porcelain"], { stdio: "ignore" });
  assert.equal(existsSync(marker), true, "control: an unprotected git runs the planted fsmonitor");
});

test("platform git runs an absolute git resolved once, never the /usr/bin/git xcrun shim (T5-4: a planted xcrun_db)", async () => {
  const { gitBin, resolveGitBin } = await import("../src/git/run.ts");
  assert.equal(
    resolveGitBin({ platform: "darwin", which: () => "/usr/bin/git", xcrunFind: () => "/Library/Developer/CommandLineTools/usr/bin/git" }),
    "/Library/Developer/CommandLineTools/usr/bin/git",
  );
  assert.equal(resolveGitBin({ platform: "darwin", which: () => "/opt/homebrew/bin/git", xcrunFind: () => "/never" }), "/opt/homebrew/bin/git");
  assert.equal(resolveGitBin({ platform: "linux", which: () => "/usr/bin/git", xcrunFind: () => "/never" }), "/usr/bin/git");
  assert.throws(() => resolveGitBin({ platform: "darwin", which: () => "/usr/bin/git", xcrunFind: () => null }), /git/);
  const bin = gitBin();
  assert.ok(bin.startsWith("/"), bin);
  if (process.platform === "darwin") assert.notEqual(bin, "/usr/bin/git");
  assert.match(execFileSync(bin, ["--version"], { encoding: "utf8" }), /git version/);
});

test("4A-3: assertPlatformWorktree with the repo path refuses a .git forged to another (self-consistent) common dir; the real one passes", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const wt = await ensureWorktree({ home, key: "K-43", repo: ref("api", api), branch: "slackoff/K-43-x" });
  const real = realpathSync(wt.path);
  assert.equal(assertPlatformWorktree(home, wt.path, api), real);
  // a self-consistent forged admin dir elsewhere: commondir ../.. and a back-link to this worktree
  const evil = join(tmpDir("wt-forged"), "evil");
  mkdirSync(join(evil, ".git/worktrees/w"), { recursive: true });
  mkdirSync(join(evil, ".git/objects"), { recursive: true });
  mkdirSync(join(evil, ".git/refs"), { recursive: true });
  writeFileSync(join(evil, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(evil, ".git/worktrees/w/commondir"), "../..\n");
  writeFileSync(join(evil, ".git/worktrees/w/gitdir"), `${join(real, ".git")}\n`);
  writeFileSync(join(evil, ".git/worktrees/w/HEAD"), "ref: refs/heads/main\n");
  const original = readFileSync(join(real, ".git"), "utf8");
  writeFileSync(join(real, ".git"), `gitdir: ${realpathSync(join(evil, ".git/worktrees/w"))}\n`);
  try {
    assert.throws(() => assertPlatformWorktree(home, wt.path, api), (e: unknown) => e instanceof WorktreeError && /not .*api|another repository|common/i.test((e as Error).message));
  } finally {
    writeFileSync(join(real, ".git"), original);
  }
});

test("4A-2: the platform's own git runs no hooks by default (worktree add, status, add); commit runs the hooks dir it is given; hook introspection still sees the configured core.hooksPath", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const configured = tmpDir("wt-configured-hooks");
  const log = join(configured, "ran.log");
  for (const name of ["post-checkout", "post-index-change", "pre-commit"]) {
    writeFileSync(join(configured, name), hook(`echo ${name} >> '${log}'`));
    chmodSync(join(configured, name), 0o755);
  }
  sh(api, "config", "core.hooksPath", configured);
  const wt = await ensureWorktree({ home, key: "K-44", repo: ref("api", api), branch: "slackoff/K-44-x" });
  writeFileSync(join(wt.path, "a.txt"), "change\n");
  await changedPaths(wt.path);
  assert.equal(existsSync(log), false, "worktree add and status ran no hook");
  const pin = await hooksFingerprint(wt.path);
  assert.equal(pin.hooksPath, configured);
  assert.equal(pin.dir, realpathSync(configured));
  assert.equal((await hooksInstalled(wt.path)).installed, true);
  const out = await commitAll(home, wt.path, "K-44: pinned", 10_000, { hooksDir: pin.dir, repoPath: api, branch: "slackoff/K-44-x" });
  assert.equal(out.kind, "committed", JSON.stringify(out));
  assert.ok(readFileSync(log, "utf8").includes("pre-commit"), "the given hooks dir ran at commit");
});

// ---------------------------------------------------------------- 4A-8: the repo path is required everywhere

/** A platform worktree of `api` whose .git is then forged to a self-consistent admin dir of another (planted) repo. */
async function forgedWorktree(key: string): Promise<{ home: string; api: string; wt: string; restore: () => void }> {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const wt = (await ensureWorktree({ home, key, repo: ref("api", api), branch: `slackoff/${key}-x` })).path;
  const real = realpathSync(wt);
  const evil = join(tmpDir("wt-forged"), "evil");
  for (const d of [".git/worktrees/w", ".git/objects", ".git/refs"]) mkdirSync(join(evil, d), { recursive: true });
  writeFileSync(join(evil, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(evil, ".git/worktrees/w/commondir"), "../..\n");
  writeFileSync(join(evil, ".git/worktrees/w/gitdir"), `${join(real, ".git")}\n`);
  writeFileSync(join(evil, ".git/worktrees/w/HEAD"), "ref: refs/heads/main\n");
  const original = readFileSync(join(real, ".git"), "utf8");
  writeFileSync(join(real, ".git"), `gitdir: ${realpathSync(join(evil, ".git/worktrees/w"))}\n`);
  return { home, api, wt, restore: () => writeFileSync(join(real, ".git"), original) };
}

test("4A-8: restoreProtected, revertPaths and resetToHead refuse a worktree whose .git is forged to another repository", async () => {
  const f = await forgedWorktree("K-45");
  try {
    await assert.rejects(restoreProtected(f.home, f.wt, f.api), WorktreeError);
    await assert.rejects(revertPaths(f.home, f.wt, f.api, ["a.txt"]), WorktreeError);
    await assert.rejects(resetToHead(f.home, f.wt, f.api), WorktreeError);
  } finally {
    f.restore();
  }
  assert.deepEqual(await restoreProtected(f.home, f.wt, f.api), [], "the real one passes");
});

test("4A-8: the views (hand-off state; repo diff and the development view share the lookup) treat a worktree whose .git is forged to another repository as missing", async () => {
  const { openDatabase } = await import("../src/db/database.ts");
  const { getTicket, setRepoWorkspace, upsertDiscovered } = await import("../src/tickets/ticket-repo.ts");
  const { handOffState } = await import("../src/http/views.ts");
  const f = await forgedWorktree("K-46");
  const db = openDatabase(":memory:");
  upsertDiscovered(db, { key: "K-46", title: "t", url: "https://your-company.atlassian.net/browse/K-46", status: "x" }, false);
  setRepoWorkspace(db, "K-46", { repo: "api", repoPath: f.api, baseBranch: "main", branch: "slackoff/K-46-x", worktreePath: f.wt });
  db.prepare("UPDATE ticket SET state = 'dev_done' WHERE key = ?").run("K-46");
  try {
    const view = await handOffState(db, f.home, getTicket(db, "K-46")!);
    assert.deepEqual(view, { enabled: false, reason: "api has no worktree — start development again" });
  } finally {
    f.restore();
  }
  assert.equal((await handOffState(db, f.home, getTicket(db, "K-46")!)).enabled, true, "the real one passes");
});

test("4A-10: commitAll commits only when the worktree's HEAD is the recorded branch — a HEAD switched to main is refused, main untouched", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const wt = await ensureWorktree({ home, key: "K-47", repo: ref("api", api), branch: "slackoff/K-47-x" });
  const mainBefore = head(api);
  const opts = { hooksDir: "/var/empty/slackoff-no-hooks", repoPath: api, branch: "slackoff/K-47-x" };
  sh(wt.path, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(wt.path, "a.txt"), "change\n");
  await assert.rejects(commitAll(home, wt.path, "K-47: x", 10_000, opts), (e: unknown) => e instanceof WorktreeError && /refs\/heads\/main/.test((e as Error).message) && /slackoff\/K-47-x/.test((e as Error).message));
  assert.equal(head(api), mainBefore, "main did not move");
  sh(wt.path, "symbolic-ref", "HEAD", "refs/heads/slackoff/K-47-x");
  assert.equal((await commitAll(home, wt.path, "K-47: x", 10_000, opts)).kind, "committed");
});

test("phase 4a Task 8: a committed result carries what the hooks printed (the step shows it); a silent commit carries none", async () => {
  const home = newHome();
  const api = repo({ "a.txt": "a\n" });
  const wt = await ensureWorktree({ home, key: "K-8", repo: ref("api", api), branch: "slackoff/K-8-x" });
  const hookPath = join(api, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, hook('echo "fake-lint: probe 127.0.0.1:4317 -> EPERM"'));
  chmodSync(hookPath, 0o755);
  writeFileSync(join(wt.path, "a.txt"), "change\n");
  const ok = await commitAll(home, wt.path, "K-8: change", 10_000, await pinned(wt.path));
  assert.equal(ok.kind, "committed");
  assert.match(ok.kind === "committed" ? (ok.hookOutput ?? "") : "", /fake-lint: probe 127\.0\.0\.1:4317 -> EPERM/);
});

// ---------------------------------------------------------------- the base branch comes up to date with origin first

/** origin (bare) with main and develop, a developer clone of it on main, and a pusher clone to move origin ahead. */
function withOrigin() {
  const seed = repo({ "a.txt": "1\n" });
  sh(seed, "branch", "develop");
  const origin = join(root, "repos", `origin-${n++}.git`);
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  const mine = join(root, "repos", `mine-${n++}`);
  execFileSync("git", ["clone", "-q", origin, mine]);
  sh(mine, "config", "commit.gpgsign", "false");
  const pusher = join(root, "repos", `pusher-${n++}`);
  execFileSync("git", ["clone", "-q", origin, pusher]);
  sh(pusher, "config", "commit.gpgsign", "false");
  const advance = (branch: string, file: string) => {
    sh(pusher, "checkout", "-q", branch);
    sh(pusher, "pull", "-q", "--ff-only");
    writeFileSync(join(pusher, file), `${file}\n`);
    sh(pusher, "add", "-A");
    sh(pusher, "commit", "-q", "-m", file);
    sh(pusher, "push", "-q", "origin", branch);
    return head(pusher);
  };
  return { origin, mine, advance };
}
const tip = (dir: string, ref: string) => sh(dir, "rev-parse", "--verify", "-q", ref).trim();

test("base from origin: a local base branch behind origin is fast-forwarded first; a missing one is created from origin", async () => {
  const { mine, advance } = withOrigin();
  sh(mine, "branch", "develop", "origin/develop"); // local develop, soon behind
  const newer = advance("develop", "new.txt");
  const home = newHome();
  const wt = await ensureWorktree({ home, key: "K-50", repo: ref("app", mine, "develop"), branch: "slackoff/K-50-x" });
  assert.equal(tip(mine, "refs/heads/develop"), newer, "local develop now matches origin");
  assert.equal(readFileSync(join(wt.path, "new.txt"), "utf8"), "new.txt\n", "the ticket branch starts from origin's latest");
  assert.equal(sh(mine, "branch", "--show-current").trim(), "main", "the developer's checkout is untouched");
  // a release branch that exists only on origin
  const rel = advance("main", "rel.txt");
  sh(join(root, "repos", `pusher-${n - 1}`), "push", "-q", "origin", "main:refs/heads/release/1.2.0");
  const wt2 = await ensureWorktree({ home, key: "K-51", repo: ref("app", mine, "release/1.2.0"), branch: "slackoff/K-51-x" });
  assert.equal(tip(mine, "refs/heads/release/1.2.0"), rel);
  assert.equal(readFileSync(join(wt2.path, "rel.txt"), "utf8"), "rel.txt\n");
});

test("base from origin: checked out and behind, local commits origin lacks, or a failed fetch block with the reason and change nothing", async () => {
  // checked out in the developer's folder and behind
  const a = withOrigin();
  a.advance("main", "x.txt");
  const before = tip(a.mine, "refs/heads/main");
  await assert.rejects(
    ensureWorktree({ home: newHome(), key: "K-52", repo: ref("app", a.mine, "main"), branch: "slackoff/K-52-x" }),
    /app: main is checked out in .* and behind origin — pull it, then Retry/,
  );
  assert.equal(tip(a.mine, "refs/heads/main"), before);
  // local commits that origin does not have
  const b = withOrigin();
  sh(b.mine, "branch", "develop", "origin/develop");
  sh(b.mine, "checkout", "-q", "develop");
  writeFileSync(join(b.mine, "local.txt"), "l\n");
  sh(b.mine, "add", "-A");
  sh(b.mine, "commit", "-q", "-m", "local");
  sh(b.mine, "checkout", "-q", "main");
  const mineTip = tip(b.mine, "refs/heads/develop");
  await assert.rejects(
    ensureWorktree({ home: newHome(), key: "K-53", repo: ref("app", b.mine, "develop"), branch: "slackoff/K-53-x" }),
    /app: your develop has commits that are not on origin — push them or reset it, then Retry/,
  );
  assert.equal(tip(b.mine, "refs/heads/develop"), mineTip);
  // origin unreachable
  const c = withOrigin();
  rmSync(c.origin, { recursive: true, force: true });
  await assert.rejects(
    ensureWorktree({ home: newHome(), key: "K-54", repo: ref("app", c.mine, "main"), branch: "slackoff/K-54-x" }),
    /app: cannot fetch main from origin \(.+\) — check the network and your access, then Retry/,
  );
  // a base on neither side
  const d = withOrigin();
  await assert.rejects(
    ensureWorktree({ home: newHome(), key: "K-55", repo: ref("app", d.mine, "release/9.9.9"), branch: "slackoff/K-55-x" }),
    /base branch release\/9\.9\.9 not found/,
  );
});

test("base from origin: up to date, or no origin at all, branches as before", async () => {
  const { mine } = withOrigin();
  const wt = await ensureWorktree({ home: newHome(), key: "K-56", repo: ref("app", mine, "main"), branch: "slackoff/K-56-x" });
  assert.equal(wt.created, true);
  const plain = repo({ "p.txt": "p\n" });
  assert.equal((await ensureWorktree({ home: newHome(), key: "K-57", repo: ref("app", plain), branch: "slackoff/K-57-x" })).created, true);
});

test("base from origin: a credential written into the remote URL never reaches the message", async () => {
  const { mine } = withOrigin();
  // nothing listens on port 1: the fetch fails at once, quoting the URL
  sh(mine, "remote", "set-url", "origin", "https://someone:SECRET-TOKEN@127.0.0.1:1/repo.git");
  await assert.rejects(
    ensureWorktree({ home: newHome(), key: "K-58", repo: ref("app", mine, "main"), branch: "slackoff/K-58-x" }),
    (err: Error) => {
      assert.match(err.message, /app: cannot fetch main from origin/);
      assert.doesNotMatch(err.message, /SECRET-TOKEN|someone:/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- hooks generated in the developer's checkout (husky)

import { adoptHooksFromCheckout } from "../src/git/worktree.ts";

/** A husky-style repo: core.hooksPath=.husky/_ (git-ignored, generated); the developer's checkout has it, a new worktree not. */
function huskyRepo(over: { ignored?: boolean; link?: boolean } = {}) {
  const dir = repo({ ".gitignore": over.ignored === false ? "node_modules\n" : ".husky/_\n", ".husky/pre-commit": "node .husky/pre-commit.mjs\n" });
  sh(dir, "config", "core.hooksPath", ".husky/_");
  mkdirSync(join(dir, ".husky", "_"), { recursive: true });
  writeFileSync(join(dir, ".husky", "_", "h"), "#!/usr/bin/env sh\necho husky\n");
  writeFileSync(join(dir, ".husky", "_", "pre-commit"), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
  chmodSync(join(dir, ".husky", "_", "h"), 0o755);
  chmodSync(join(dir, ".husky", "_", "pre-commit"), 0o755);
  if (over.link) symlinkSync("/etc/hosts", join(dir, ".husky", "_", "pre-push"));
  return dir;
}

test("adoptHooksFromCheckout: a git-ignored, generated hooks dir of plain files is copied from the developer's checkout", async () => {
  const dir = huskyRepo();
  const wt = await ensureWorktree({ home: newHome(), key: "K-90", repo: ref("app", dir), branch: "feat/K-90-x" });
  assert.equal((await hooksInstalled(wt.path)).installed, false);
  assert.deepEqual(await adoptHooksFromCheckout(dir, wt.path), [".husky/_/h", ".husky/_/pre-commit"]);
  const after = await hooksInstalled(wt.path);
  assert.equal(after.installed, true);
  assert.equal(readFileSync(join(wt.path, ".husky", "_", "pre-commit"), "utf8"), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
  // already there: nothing to do
  assert.equal(await adoptHooksFromCheckout(dir, wt.path), null);
});

test("adoptHooksFromCheckout refuses a tracked hooks dir, links in it, an absolute or escaping hooksPath, or a missing source", async () => {
  const tracked = huskyRepo({ ignored: false });
  const a = await ensureWorktree({ home: newHome(), key: "K-91", repo: ref("app", tracked), branch: "feat/K-91-x" });
  rmSync(join(a.path, ".husky", "_"), { recursive: true, force: true });
  assert.equal(await adoptHooksFromCheckout(tracked, a.path), null);
  const linked = huskyRepo({ link: true });
  const b = await ensureWorktree({ home: newHome(), key: "K-92", repo: ref("app", linked), branch: "feat/K-92-x" });
  assert.equal(await adoptHooksFromCheckout(linked, b.path), null);
  assert.equal(existsSync(join(b.path, ".husky", "_")), false);
  for (const hp of ["/tmp/hooks", "../outside", ".husky/../../x"]) {
    const d = huskyRepo();
    sh(d, "config", "core.hooksPath", hp);
    const w = await ensureWorktree({ home: newHome(), key: "K-93", repo: ref("app", d), branch: `feat/K-93-x${n++}` });
    assert.equal(await adoptHooksFromCheckout(d, w.path), null, hp);
  }
  const gone = huskyRepo();
  rmSync(join(gone, ".husky", "_"), { recursive: true, force: true });
  const c = await ensureWorktree({ home: newHome(), key: "K-94", repo: ref("app", gone), branch: "feat/K-94-x" });
  assert.equal(await adoptHooksFromCheckout(gone, c.path), null);
});

test("adoptHooksFromCheckout: husky v9's own .husky/_/.gitignore ('*') marks the generated files as ignored", async () => {
  const dir = repo({ ".gitignore": "node_modules\n", ".husky/pre-commit": "node .husky/pre-commit.mjs\n" });
  sh(dir, "config", "core.hooksPath", ".husky/_");
  mkdirSync(join(dir, ".husky", "_"), { recursive: true });
  writeFileSync(join(dir, ".husky", "_", ".gitignore"), "*");
  writeFileSync(join(dir, ".husky", "_", "h"), "#!/usr/bin/env sh\n");
  writeFileSync(join(dir, ".husky", "_", "pre-commit"), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
  chmodSync(join(dir, ".husky", "_", "h"), 0o755);
  chmodSync(join(dir, ".husky", "_", "pre-commit"), 0o755);
  const wt = await ensureWorktree({ home: newHome(), key: "K-95", repo: ref("app", dir), branch: "feat/K-95-x" });
  assert.deepEqual(await adoptHooksFromCheckout(dir, wt.path), [".husky/_/.gitignore", ".husky/_/h", ".husky/_/pre-commit"]);
  assert.equal((await hooksInstalled(wt.path)).installed, true);
});
