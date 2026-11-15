// Phase 4a final fix. F4A-3: revertPaths deletes without following a symlink swapped in; the hooks fingerprint is
// bounded and fails closed. F4A-2 (C-B): a git repository nested in a platform worktree. Its own config (a clean filter,
// fsmonitor…) must never run in the platform's unsandboxed git — git status / diff recurse into a gitlink's working
// tree and run that repository's filters. Four layers: no `.git` path component can be created inside a worktree from
// any dev sandbox; the platform refuses an embedded repository or a new / changed gitlink before committing; every
// platform status / diff passes --ignore-submodules=all; GIT_SAFE_CONFIG turns submodule recursion off.
//
// Isolation: HOME is a scratch dir under /private/var/tmp (outside every temp dir the dev sandbox may write, so every
// `.zshrc` a filter could append to is that scratch one), no global or system git config for the setup git, no network.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { gitBin, GIT_SAFE_CONFIG, runProcess } from "../src/git/run.ts";
import { hashHooksDir } from "../src/git/hooks-hash.ts";
import { changedPaths, commitAll, diffStat, diffText, ensureWorktree, restoreProtected, revertPaths, ticketDir, WorktreeError } from "../src/git/worktree.ts";
import { SANDBOX_EXEC, hookScope, sandboxArgv, sandboxEnv, ticketCacheDir, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { tmpDir } from "./helpers/tmp.ts";

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const skip = HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;

gitBin(); // resolve (xcrun) before HOME changes
const fakeHome = realpathSync(tmpDir("p4afinal-home", "/private/var/tmp"));
mkdirSync(join(fakeHome, ".config"));
assert.notEqual(process.env.HOME, fakeHome);
process.env.HOME = fakeHome;
process.env.XDG_CONFIG_HOME = join(fakeHome, ".config");
const ZSHRC = join(fakeHome, ".zshrc");

const root = realpathSync(tmpDir("p4afinal"));
const home = join(root, "slackoff");
mkdirSync(home);
const SETUP_ENV = { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: join(fakeHome, ".config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
/** git for test setup only */
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: SETUP_ENV }).trim();
const noHooks = join(root, "no-hooks");
mkdirSync(noHooks);

/** The step-1 payload (the reviewer's probe): a nested repo whose clean filter appends to $HOME/.zshrc. */
const EVIL = [
  "set -e",
  "git init -q sub",
  "cd sub",
  "git config user.name t && git config user.email t@example.com && git config commit.gpgsign false",
  "echo one > f",
  "git add -A && git commit -q -m sub",
  `git config filter.evil.clean 'sh -c "echo PWNED >> \\"\\$HOME/.zshrc\\"; cat"'`,
  "echo '* filter=evil' > .gitattributes",
].join("\n");
const UNSANDBOXED_ENV = { PATH: "/usr/bin:/bin", HOME: fakeHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let n = 0;
async function fixture() {
  const id = n++;
  const key = `NR-${id}`;
  const main = join(root, "repos", `api${id}`);
  mkdirSync(main, { recursive: true });
  sh(main, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) sh(main, "config", k!, v!);
  writeFileSync(join(main, "a.js"), "a\n");
  sh(main, "add", "-A");
  sh(main, "commit", "-q", "-m", "init");
  const branch = `slackoff/${key}-x`;
  const { path } = await ensureWorktree({ home, key, repo: { name: `api${id}`, path: main, baseBranch: "main" }, branch });
  const wt = realpathSync(path);
  const common = realpathSync(resolve(wt, sh(wt, "rev-parse", "--git-common-dir")));
  const admin = realpathSync(sh(wt, "rev-parse", "--absolute-git-dir"));
  const devCommand: SandboxScope = { kind: "dev-command", home, allowInHome: ticketDir(home, key), repos: [], writable: [wt], gitProtect: [common, join(wt, ".git")] };
  const scopes: SandboxScope[] = [devCommand, { ...devCommand, kind: "dev-install" }, hookScope(home, key, wt, { common, admin, branch: `refs/heads/${branch}` }, [])];
  const opts = { hooksDir: noHooks, repoPath: main, branch };
  return { key, main, wt, branch, scopes, opts };
}

/** `/bin/sh -c cmd` in `scope` (the scratch HOME), cwd the worktree */
async function inSandbox(scope: SandboxScope, wt: string, cmd: string) {
  const { file, args } = sandboxArgv(scope, "/bin/sh", ["-c", cmd]);
  return runProcess(file, args, { cwd: wt, timeoutMs: 30_000, env: sandboxEnv(scope, { PATH: "/usr/bin:/bin", HOME: fakeHome, LANG: "C" }) });
}

const noZshrc = (what: string) => assert.equal(existsSync(ZSHRC), false, `${what}: the nested repo's filter ran in the platform's git`);

test("F4A-2 layer 4: GIT_SAFE_CONFIG turns submodule recursion off (diff.ignoreSubmodules=all, submodule.recurse=false, status.submoduleSummary=false)", () => {
  const kv = GIT_SAFE_CONFIG.filter((_, i) => i % 2 === 1);
  for (const want of ["core.fsmonitor=false", "diff.ignoreSubmodules=all", "submodule.recurse=false", "status.submoduleSummary=false"]) assert.ok(kv.includes(want), want);
  assert.ok(GIT_SAFE_CONFIG.every((a, i) => (i % 2 === 0 ? a === "-c" : true)));
});

test("F4A-2 layer 1: no dev kind can create a .git path component inside the worktree (mkdir, file, rename, link, symlink, git init, .GIT); .gitignore and the ticket cache still can", { skip }, async () => {
  const f = await fixture();
  mkdirSync(join(f.wt, "sub/d"), { recursive: true });
  writeFileSync(join(f.wt, "plain"), "x\n");
  for (const scope of f.scopes) {
    for (const cmd of [
      "mkdir sub/.git", "echo x > sub/.git", "mv sub/d sub/.git", "mkdir -p a/b/.git/objects", "ln -s /etc sub/.git", "ln plain sub/.git",
      "mkdir sub/.GIT", "mkdir sub/.Git", "mv sub/d sub/.GIT",
    ]) {
      const r = await inSandbox(scope, f.wt, cmd);
      assert.notEqual(r.code, 0, `${scope.kind}: ${cmd}`);
      assert.match(r.stderr, /not permitted/i, `${scope.kind}: ${cmd}: ${r.stderr}`);
    }
    const init = await inSandbox(scope, f.wt, "/usr/bin/git init -q repo");
    assert.notEqual(init.code, 0, `${scope.kind}: git init ${init.stderr}`);
    for (const p of ["sub/.git", "sub/.GIT", "a/b/.git", "repo/.git"]) assert.equal(existsSync(join(f.wt, p)), false, `${scope.kind}: ${p}`);
    const ok = await inSandbox(scope, f.wt, "echo dist > .gitignore && mkdir -p .github/x && echo y > .gitkeep && mv sub/d sub/e && mv sub/e sub/d && rm -r .github .gitkeep .gitignore");
    assert.equal(ok.code, 0, `${scope.kind}: ${ok.stderr}`);
    // a package manager may clone a git dependency into the ticket's cache
    const cache = ticketCacheDir(scope);
    const dep = await inSandbox(scope, f.wt, `mkdir -p '${cache}/dep/.git' && rm -r '${cache}/dep'`);
    assert.equal(dep.code, 0, `${scope.kind}: ${dep.stderr}`);
  }
});

test("F4A-2 (C-B) two-step regression: step 1 plants a nested repo with a clean filter, the platform commits; step 2 edits it, the platform's status / diff / commit — the filter never runs", { skip }, async () => {
  const f = await fixture();
  const dev = f.scopes[0]!;
  // step 1, in the dev-command sandbox: refused (no .git can be created)
  const step1 = await inSandbox(dev, f.wt, EVIL);
  assert.notEqual(step1.code, 0, `the sandbox let a nested repo be created: ${step1.stdout}${step1.stderr}`);
  assert.equal(existsSync(join(f.wt, "sub/.git")), false);
  noZshrc("step 1");

  // the same step with the commands sandbox switched off (development.allowUnsandboxedCommands): the platform layers
  const r = await runProcess("/bin/sh", ["-c", EVIL], { cwd: f.wt, timeoutMs: 30_000, env: UNSANDBOXED_ENV });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(f.wt, "sub/.git/config")));
  const before = sh(f.wt, "rev-parse", "HEAD");
  assert.deepEqual(await changedPaths(f.wt), ["sub/"]);
  await assert.rejects(commitAll(home, f.wt, "step 1", 30_000, f.opts), (e: unknown) => e instanceof WorktreeError && /sub\/?.*(embedded|nested) git repositor/i.test(e.message));
  assert.equal(sh(f.wt, "rev-parse", "HEAD"), before, "nothing committed");
  assert.equal(sh(f.wt, "ls-files", "-s", "--", "sub"), "", "no gitlink staged");
  noZshrc("step 1 commit");

  // step 2: the nested repo's file changes; every platform read of the worktree
  writeFileSync(join(f.wt, "sub/f"), "two\n");
  await changedPaths(f.wt);
  await restoreProtected(home, f.wt, f.main);
  await assert.rejects(commitAll(home, f.wt, "step 2", 30_000, f.opts), WorktreeError);
  noZshrc("step 2");
});

test("F4A-2 layers 2–4: a gitlink already on the branch — status, diff and commit never look into it; populated, new or moved gitlinks are refused; HEAD's unpopulated ones are kept", { skip }, async () => {
  const f = await fixture();
  // committed by hand (outside every platform path): the reviewer's state after step 1 on the old code
  const r = await runProcess("/bin/sh", ["-c", EVIL], { cwd: f.wt, timeoutMs: 30_000, env: UNSANDBOXED_ENV });
  assert.equal(r.code, 0, r.stderr);
  sh(f.wt, "add", "sub");
  sh(f.wt, "commit", "-q", "-m", "gitlink");
  assert.match(sh(f.wt, "ls-files", "-s", "--", "sub"), /^160000 /);
  const gitlink = sh(f.wt, "rev-parse", "HEAD:sub");
  noZshrc("setup");

  // step 2: the nested repo's file changes
  writeFileSync(join(f.wt, "sub/f"), "two\n");
  assert.deepEqual(await changedPaths(f.wt), [], "the gitlink's working tree is not looked at");
  noZshrc("status");
  await diffStat(f.wt, "main");
  await diffText(f.wt, "main");
  noZshrc("diff");
  await restoreProtected(home, f.wt, f.main);
  noZshrc("restoreProtected");
  writeFileSync(join(f.wt, "a.js"), "a\nb\n");
  const before = sh(f.wt, "rev-parse", "HEAD");
  await assert.rejects(commitAll(home, f.wt, "edit", 30_000, f.opts), (e: unknown) => e instanceof WorktreeError && /sub\/ is an embedded git repository/.test(e.message));
  assert.equal(sh(f.wt, "rev-parse", "HEAD"), before);
  noZshrc("commit (populated gitlink)");

  // a submodule repository's worktree as the platform makes it: the gitlink's dir is empty — ordinary changes commit
  rmSync(join(f.wt, "sub"), { recursive: true, force: true });
  mkdirSync(join(f.wt, "sub"));
  const c = await commitAll(home, f.wt, "edit", 30_000, f.opts);
  assert.equal(c.kind, "committed", JSON.stringify(c));
  assert.equal(sh(f.wt, "rev-parse", "HEAD:sub"), gitlink, "HEAD's gitlink kept as it was");

  // a moved gitlink in the index (a hook can write the index) is unstaged and refused, never committed
  sh(f.wt, "update-index", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
  writeFileSync(join(f.wt, "a.js"), "a\nb\nc\n");
  await assert.rejects(commitAll(home, f.wt, "edit 2", 30_000, f.opts), (e: unknown) => e instanceof WorktreeError && /sub is a moved gitlink/.test(e.message));
  assert.equal(sh(f.wt, "rev-parse", "HEAD:sub"), gitlink);
  assert.equal(sh(f.wt, "ls-files", "-s", "--", "sub").split(" ")[1], gitlink, "unstaged back to HEAD's");
  // and a new one
  sh(f.wt, "update-index", "--add", "--cacheinfo", `160000,${"2".repeat(40)},vendor/x`);
  await assert.rejects(commitAll(home, f.wt, "edit 3", 30_000, f.opts), (e: unknown) => e instanceof WorktreeError && /vendor\/x is a new gitlink/.test(e.message));
  assert.equal(sh(f.wt, "ls-files", "--", "vendor"), "");
  noZshrc("commits");
});

// ---------------------------------------------------------------- F4A-3 (M-a, M-b)

/**
 * Simulates a process racing the platform: the first lstat of `trigger` (the platform's last look before it deletes)
 * first replaces `dir` with a symlink to `target`. lstatSync is node:fs's own (ESM bindings re-synced).
 */
function raceOnLstat(t: TestContext, trigger: string, dir: string, target: string): void {
  const real = fs.lstatSync;
  let fired = false;
  t.mock.method(fs, "lstatSync", ((p: fs.PathLike, o?: fs.StatSyncOptions) => {
    if (!fired && String(p) === trigger) {
      fired = true;
      renameSync(dir, `${dir}.moved`);
      symlinkSync(target, dir);
    }
    return real(p, o as fs.StatSyncOptions);
  }) as typeof fs.lstatSync);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("F4A-3 (M-a): revertPaths deletes without following a parent dir swapped for a symlink after the check — the file outside is kept", async (t) => {
  const f = await fixture();
  const outside = join(root, "outside-ma");
  mkdirSync(outside);
  writeFileSync(join(outside, "victim.txt"), "keep me\n");
  mkdirSync(join(f.wt, "gen"));
  writeFileSync(join(f.wt, "gen/victim.txt"), "agent file\n");
  raceOnLstat(t, join(f.wt, "gen/victim.txt"), join(f.wt, "gen"), outside);
  await revertPaths(home, f.wt, f.main, ["gen/victim.txt"]).catch((e: unknown) => assert.ok(e instanceof WorktreeError, String(e)));
  assert.equal(readFileSync(join(outside, "victim.txt"), "utf8"), "keep me\n", "a file outside the worktree was deleted through the swapped-in symlink");
});

test("F4A-3 (M-a): revertPaths still deletes untracked files and whole dirs (symlinks inside are removed, never followed)", async () => {
  const f = await fixture();
  const outside = join(root, "outside-ma2");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep\n");
  mkdirSync(join(f.wt, "d/e"), { recursive: true });
  writeFileSync(join(f.wt, "d/e/x.txt"), "x\n");
  symlinkSync(outside, join(f.wt, "d/link"));
  writeFileSync(join(f.wt, "top.txt"), "t\n");
  await revertPaths(home, f.wt, f.main, ["d", "top.txt"]);
  assert.equal(existsSync(join(f.wt, "d")), false);
  assert.equal(existsSync(join(f.wt, "top.txt")), false);
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n");
});

const MiB = 1024 * 1024;

test("F4A-3 (M-b): the hooks fingerprint reads at most 1 MiB per file and 16 MiB in all — over that it fails closed (throws; hook-verify exits 1)", async () => {
  const dir = join(root, "hooks-mb");
  mkdirSync(dir);
  writeFileSync(join(dir, "pre-commit"), Buffer.alloc(MiB, 0x61));
  chmodSync(join(dir, "pre-commit"), 0o755);
  const at = hashHooksDir(dir);
  assert.match(at, /^[0-9a-f]{64}$/, "exactly 1 MiB is hashed");
  writeFileSync(join(dir, "big"), Buffer.alloc(MiB + 1, 0x61));
  assert.throws(() => hashHooksDir(dir), /1 MiB/);
  const verify = join(import.meta.dirname, "../src/sandbox/hook-verify.ts");
  const r = await runProcess(process.execPath, [verify, dir, at], { timeoutMs: 30_000 });
  assert.equal(r.code, 1, "hook-verify fails closed");
  rmSync(join(dir, "big"));
  for (let i = 0; i < 16; i++) writeFileSync(join(dir, `part-${String(i).padStart(2, "0")}`), Buffer.alloc(MiB, 0x62));
  assert.throws(() => hashHooksDir(dir), /16 MiB/);
});
