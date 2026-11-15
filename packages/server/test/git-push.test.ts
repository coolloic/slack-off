import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPush, DeliveryError, parseGithubRemote, pushBranch, remoteBranchSha, remoteDefaultBranch, remoteInfo } from "../src/delivery/git-push.ts";
import { GhClient } from "../src/delivery/gh.ts";
import { ensureWorktree, hooksFingerprint } from "../src/git/worktree.ts";
import { gitBin, runGit } from "../src/git/run.ts";
import { tmpDir } from "./helpers/tmp.ts";

// No network, ever: every remote below is a local bare repository. ssh / https origins are only ever *names* that
// `url.<file:///…>.insteadOf` (in the scratch repo config) maps to a bare repo. HOME is a scratch dir so neither the
// developer's ~/.gitconfig nor ~/.config/git is read (runProcess strips GIT_CONFIG_GLOBAL, so HOME is the lever).
const root = realpathSync(tmpDir("gitpush"));
const home = join(root, "home");
const dataHome = join(root, "slackoff-home");
let real = "";
before(() => {
  mkdirSync(home, { recursive: true });
  gitBin(); // resolve (xcrun) before HOME changes
  real = process.env.HOME ?? "";
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  assert.notEqual(real, home);
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
/** git for test setup only (scratch HOME is set in `before`) */
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();

let n = 0;
interface Fx {
  bare: string;
  clone: string; // the developer's repo (origin = bare)
  wt: string;
  branch: string;
  head: string;
  repoName: string;
}

/** A bare origin with main pushed, the developer's repo, and a platform worktree on slackoff/T-1-x with one commit. */
async function fixture(opts: { origin?: (bare: string) => string; insteadOf?: (bare: string) => [string, string] } = {}): Promise<Fx> {
  const id = n++;
  const repoName = `api${id}`;
  const bare = join(root, "bare", `${repoName}.git`);
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "-q", "--bare", "-b", "main");
  const clone = join(root, "repos", repoName);
  mkdirSync(clone, { recursive: true });
  sh(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "a.txt"), "a\n");
  sh(clone, "add", "-A");
  sh(clone, "commit", "-q", "-m", "init");
  sh(clone, "remote", "add", "origin", `file://${bare}`);
  sh(clone, "push", "-q", "origin", "main");
  if (opts.origin) {
    const [from, to] = opts.insteadOf!(bare);
    sh(clone, "config", `url.${to}.insteadOf`, from);
    sh(clone, "remote", "set-url", "origin", opts.origin(bare));
  }
  const branch = "slackoff/T-1-x";
  const { path: wt } = await ensureWorktree({ home: dataHome, key: `T-${id}`, repo: { name: repoName, path: clone, baseBranch: "main" }, branch });
  writeFileSync(join(wt, "b.txt"), "b\n");
  sh(wt, "add", "-A");
  sh(wt, "commit", "-q", "-m", "work");
  return { bare, clone, wt, branch, head: sh(wt, "rev-parse", "HEAD"), repoName };
}
const ghOrigin = { origin: () => "https://github.com/example-org/api.git", insteadOf: (b: string) => ["https://github.com/example-org/api.git", `file://${b}`] as [string, string] };
const sshOrigin = { origin: () => "git@github.com:example-org/api.git", insteadOf: (b: string) => ["git@github.com:example-org/api.git", `file://${b}`] as [string, string] };

/** 4A-4: pushBranch always gets a hooks dir; here the worktree's resolved one (no sandbox in these tests) */
const push = async (f: Fx, o: Partial<Parameters<typeof pushBranch>[0]> = {}) =>
  pushBranch({ home: dataHome, repo: f.repoName, wt: f.wt, branch: f.branch, baseBranch: "main", localSha: f.head, hookTimeoutMs: 20_000, hooksDir: (await hooksFingerprint(f.wt)).dir, repoPath: f.clone, ...o });
const remoteRef = (f: Fx, b: string) => {
  try {
    return sh(f.bare, "rev-parse", "--verify", "-q", `refs/heads/${b}`);
  } catch {
    return null;
  }
};
const rejectsWith = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof DeliveryError && re.test((e as Error).message));

/** another developer's clone pushes a new commit to the ticket branch */
function otherClonePushes(f: Fx): string {
  const other = join(root, "other", `${f.repoName}`);
  mkdirSync(join(other, ".."), { recursive: true });
  sh(root, "clone", "-q", f.bare, other);
  if (remoteRef(f, f.branch) !== null) sh(other, "checkout", "-q", f.branch);
  else sh(other, "checkout", "-q", "-b", f.branch, "main");
  writeFileSync(join(other, "theirs.txt"), "t\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-q", "-m", "theirs");
  sh(other, "push", "-q", f.bare, `${f.branch}:${f.branch}`);
  return sh(other, "rev-parse", "HEAD");
}

test("parseGithubRemote: https, scp-like and ssh:// forms; everything else null", () => {
  const want = { host: "github.com", owner: "example-org", name: "api" };
  for (const u of ["https://github.com/example-org/api", "https://github.com/example-org/api.git", "git@github.com:example-org/api.git", "git@github.com:example-org/api", "ssh://git@github.com/example-org/api.git", "ssh://git@github.com/example-org/api"]) {
    assert.deepEqual(parseGithubRemote(u), want, u);
  }
  for (const u of ["/tmp/x.git", "https://gitlab.example/x", "file:///tmp/x.git", "", "https://github.com/only-owner", "https://github.com/a/b/c"]) {
    assert.equal(parseGithubRemote(u), null, u);
  }
});

test("remoteInfo: pushurl for another owner is a mismatch; insteadOf alone is not, and pushTarget is the expanded file URL", async () => {
  const f = await fixture(ghOrigin);
  const info = await remoteInfo(f.wt);
  assert.equal(info.url, "https://github.com/example-org/api.git"); // not expanded
  assert.deepEqual(info.github, { host: "github.com", owner: "example-org", name: "api" });
  assert.equal(info.pushUrlMismatch, null);
  assert.equal(info.pushTarget, `file://${f.bare}`);

  sh(f.clone, "config", "remote.origin.pushurl", "https://github.com/other-org/api.git");
  const info2 = await remoteInfo(f.wt);
  assert.ok(info2.pushUrlMismatch);
  assert.match(info2.pushUrlMismatch!, /other-org/);
  // the same identity in another spelling is fine
  sh(f.clone, "config", "remote.origin.pushurl", "git@github.com:example-org/api.git");
  assert.equal((await remoteInfo(f.wt)).pushUrlMismatch, null);
});

test("remoteInfo: no origin is a DeliveryError; a non-GitHub origin has github null", async () => {
  const f = await fixture();
  assert.equal((await remoteInfo(f.wt)).github, null);
  sh(f.clone, "remote", "remove", "origin");
  await rejectsWith(remoteInfo(f.wt), /origin/);
});

test("remoteBranchSha / remoteDefaultBranch read the local bare origin", async () => {
  const f = await fixture();
  assert.equal(await remoteBranchSha(f.wt, f.branch), null);
  assert.equal(await remoteDefaultBranch(f.wt), "main");
  await push(f);
  assert.equal(await remoteBranchSha(f.wt, f.branch), f.head);
});

test("checkPush: a remote sha missing locally is diverged, and nothing is fetched", async () => {
  const f = await fixture();
  const theirs = otherClonePushes(f);
  const calls: string[][] = [];
  const run: typeof runGit = (cwd, args, o) => {
    calls.push([...args]);
    return runGit(cwd, args, o);
  };
  const refsBefore = sh(f.bare, "for-each-ref");
  const localBefore = sh(f.wt, "for-each-ref");
  const c = await checkPush(f.wt, f.branch, f.head, run);
  assert.deepEqual(c, { kind: "diverged", remoteSha: theirs });
  assert.ok(!calls.some((a) => a.includes("fetch") || a.includes("pull")), JSON.stringify(calls));
  assert.equal(sh(f.bare, "for-each-ref"), refsBefore);
  assert.equal(sh(f.wt, "for-each-ref"), localBefore); // no remote-tracking refs appeared
});

test("checkPush: ready, already_pushed, ancestor and a locally known diverged commit", async () => {
  const f = await fixture();
  assert.deepEqual(await checkPush(f.wt, f.branch, f.head), { kind: "ready" });
  await push(f);
  assert.deepEqual(await checkPush(f.wt, f.branch, f.head), { kind: "already_pushed" });
  // a new local commit: the remote branch is now an ancestor → ready
  writeFileSync(join(f.wt, "c.txt"), "c\n");
  sh(f.wt, "add", "-A");
  sh(f.wt, "commit", "-q", "-m", "more");
  const head2 = sh(f.wt, "rev-parse", "HEAD");
  assert.deepEqual(await checkPush(f.wt, f.branch, head2), { kind: "ready" });
  // a local commit that is not a descendant of the remote tip (known locally, e.g. after a reset)
  assert.deepEqual(await checkPush(f.wt, f.branch, sh(f.wt, "rev-parse", "main")), { kind: "diverged", remoteSha: f.head });
});

test("pushBranch: first push creates the branch and sets the upstream; a second one is 'already pushed'", async () => {
  const f = await fixture();
  const r = await push(f);
  assert.equal(r.pushed, true);
  assert.equal(remoteRef(f, f.branch), f.head);
  assert.equal(sh(f.wt, "config", "--get", `branch.${f.branch}.remote`), "origin");
  assert.equal(sh(f.wt, "config", "--get", `branch.${f.branch}.merge`), `refs/heads/${f.branch}`);
  const again = await push(f);
  assert.equal(again.pushed, false);
  assert.match(again.detail, /already/i);
});

test("pushBranch: the remote branch moved on → DeliveryError, remote unchanged (never forced)", async () => {
  const f = await fixture();
  await push(f);
  const theirs = otherClonePushes(f);
  writeFileSync(join(f.wt, "d.txt"), "d\n");
  sh(f.wt, "add", "-A");
  sh(f.wt, "commit", "-q", "-m", "mine");
  const head2 = sh(f.wt, "rev-parse", "HEAD");
  await rejectsWith(push(f, { localSha: head2 }), new RegExp(`remote branch ${f.branch} has commits that are not in ${f.repoName}'s local branch — resolve it in the repository, then Retry`));
  assert.equal(remoteRef(f, f.branch), theirs);
});

test("pushBranch: followTags, a push refspec and other branches do not widen the push", async () => {
  const f = await fixture();
  sh(f.wt, "config", "push.followTags", "true");
  sh(f.wt, "config", "remote.origin.push", "refs/heads/*:refs/heads/*");
  sh(f.wt, "tag", "-a", "-m", "release", "v1");
  sh(f.wt, "branch", "slackoff/other");
  sh(f.wt, "branch", "feature-local");
  await push(f);
  assert.equal(remoteRef(f, f.branch), f.head);
  assert.equal(remoteRef(f, "slackoff/other"), null);
  assert.equal(remoteRef(f, "feature-local"), null);
  assert.equal(sh(f.bare, "tag", "--list"), "");
});

test("pushBranch refuses the base branch, the remote default branch and a branch that is not a ticket branch (<type>/<KEY>-…)", async () => {
  const f = await fixture();
  await rejectsWith(push(f, { baseBranch: f.branch }), /base branch/);
  await rejectsWith(push(f, { branch: "main" }), /not a Slack Off ticket branch/);
  await rejectsWith(push(f, { branch: "feature/x" }), /not a Slack Off ticket branch/);
  await rejectsWith(push(f, { branch: "release/1.32.0" }), /not a Slack Off ticket branch/);
  // remote default branch: the bare repo's HEAD names a slackoff/ branch
  sh(f.clone, "push", "-q", "origin", `${f.head}:refs/heads/${f.branch}`);
  sh(f.bare, "symbolic-ref", "HEAD", `refs/heads/${f.branch}`);
  await rejectsWith(push(f), /default branch/);
});

test("pushBranch refuses a dirty worktree and a HEAD that is not the recorded sha, naming the repository", async () => {
  const f = await fixture();
  writeFileSync(join(f.wt, "untracked.txt"), "x");
  await rejectsWith(push(f), new RegExp(`${f.repoName}.*uncommitted`));
  const g = await fixture();
  await rejectsWith(push(g, { localSha: "0".repeat(40) }), new RegExp(`${g.repoName}.*(HEAD|recorded)`));
  assert.equal(remoteRef(g, g.branch), null);
});

test("pushBranch: a failing pre-push hook is a DeliveryError with its output; nothing is pushed", async () => {
  const f = await fixture();
  const hooks = join(f.clone, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\ncat >/dev/null\necho 'lint failed: no console.log' >&2\nexit 1\n");
  chmodSync(join(hooks, "pre-push"), 0o755);
  await rejectsWith(push(f), /lint failed: no console\.log/);
  assert.equal(remoteRef(f, f.branch), null);
});

test("pushBranch pushes exactly the accepted commit: one made in the worktree after the checks is not what lands", async () => {
  const f = await fixture();
  let extra = "";
  const run: typeof runGit = async (cwd, args, o) => {
    if (args.includes("push") && extra === "") {
      writeFileSync(join(f.wt, "late.txt"), "late\n");
      sh(f.wt, "add", "-A");
      sh(f.wt, "commit", "-q", "-m", "late");
      extra = sh(f.wt, "rev-parse", "HEAD");
    }
    return runGit(cwd, args, o);
  };
  await push(f, { run });
  assert.notEqual(extra, f.head);
  assert.equal(remoteRef(f, f.branch), f.head);
});

test("remoteInfo: a pushInsteadOf that sends GitHub pushes to another repository is a mismatch; a file:// push target is not", async () => {
  const f = await fixture(ghOrigin);
  assert.equal((await remoteInfo(f.wt)).pushUrlMismatch, null); // file:// target (fake mode)
  sh(f.clone, "config", "url.https://github.com/other-org/.pushInsteadOf", "https://github.com/example-org/");
  const info = await remoteInfo(f.wt);
  assert.match(info.pushTarget, /other-org/);
  assert.ok(info.pushUrlMismatch);
  assert.match(info.pushUrlMismatch!, /other-org/);
});

test("an https GitHub origin routed by insteadOf: remoteInfo shows the GitHub URL and the push lands in the bare repo", async () => {
  const f = await fixture(ghOrigin);
  assert.equal((await remoteInfo(f.wt)).url, "https://github.com/example-org/api.git");
  await push(f);
  assert.equal(remoteRef(f, f.branch), f.head);
});

test("ssh-form origin: push and ls-remote carry -c core.sshCommand=ssh -o BatchMode=yes (and still land in the bare repo)", async () => {
  const f = await fixture(sshOrigin);
  const calls: string[][] = [];
  const run: typeof runGit = (cwd, args, o) => {
    calls.push([...args]);
    return runGit(cwd, args, o);
  };
  await push(f, { run });
  const pushCall = calls.find((a) => a.includes("push"))!;
  assert.ok(pushCall.join("\u0000").includes(["-c", "core.sshCommand=ssh -o BatchMode=yes"].join("\u0000")), JSON.stringify(pushCall));
  const tail = pushCall.slice(pushCall.indexOf("push"));
  assert.deepEqual(tail, ["push", "-u", "--no-follow-tags", "--recurse-submodules=no", "origin", `${f.head}:refs/heads/${f.branch}`]);
  for (const a of calls) assert.ok(!a.some((x) => /^(--force|-f|--no-verify|\+)/.test(x)), a.join(" "));
  assert.equal(remoteRef(f, f.branch), f.head);
  // a non-ssh origin gets no sshCommand
  const g = await fixture();
  const calls2: string[][] = [];
  await push(g, { run: (c, a, o) => (calls2.push([...a]), runGit(c, a, o)) });
  assert.ok(!calls2.some((a) => a.some((x) => x.startsWith("core.sshCommand"))));
});

// ---------------------------------------------------------------- gh

const ghDir = join(root, "gh");
mkdirSync(ghDir, { recursive: true });
const ghBin = join(ghDir, "gh");
const ghLog = join(ghDir, "calls.jsonl");
const ghBehavior = join(ghDir, "behavior.json");
writeFileSync(
  ghBin,
  `#!${process.execPath}
const fs = require("node:fs");
const b = JSON.parse(fs.readFileSync(${JSON.stringify(ghBehavior)}, "utf8"));
let stdinBytes = 0;
try { stdinBytes = fs.readFileSync(0).length; } catch (e) { stdinBytes = "err:" + e.code; }
const env = {};
for (const k of ["GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "NO_COLOR"]) env[k] = process.env[k];
env.hasGit = Object.keys(process.env).filter((k) => k.startsWith("GIT_") && k !== "GIT_TERMINAL_PROMPT");
const bodyFile = process.argv.includes("--body-file") ? process.argv[process.argv.indexOf("--body-file") + 1] : null;
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ argv: process.argv.slice(2), stdinBytes, env, body: bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : null }) + "\\n");
if (b.noActive && process.argv.includes("--active")) { process.stderr.write("unknown flag: --active\\n"); process.exit(1); }
let out = b.stdout;
if (b.filterBase && process.argv.includes("--base")) { const base = process.argv[process.argv.indexOf("--base") + 1]; out = JSON.stringify(JSON.parse(out).filter((p) => p.baseRefName === base)); }
if (out) process.stdout.write(out);
if (b.stderr) process.stderr.write(b.stderr);
process.exit(b.code ?? 0);
`,
);
chmodSync(ghBin, 0o755);
const fakeGh = (b: { stdout?: string; stderr?: string; code?: number; filterBase?: boolean; noActive?: boolean }) => {
  writeFileSync(ghBehavior, JSON.stringify(b));
  writeFileSync(ghLog, "");
};
const ghCalls = () =>
  readFileSync(ghLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { argv: string[]; stdinBytes: number | string; env: Record<string, unknown>; body: string | null });

test("GhClient.createPr: argv, --body-file, no draft/fill/dry-run/merge; stdin is closed (EOF) and the env is pinned", async () => {
  fakeGh({ stdout: "Creating pull request for slackoff/T-1-x into main\nhttps://github.com/example-org/api/pull/42\n" });
  const bodyFile = join(ghDir, "body.md");
  writeFileSync(bodyFile, "## Summary\nEvidence is in Slack Off.\n");
  const gh = new GhClient(ghBin, 20_000);
  const pr = await gh.createPr({ repo: "github.com/example-org/api", base: "main", head: "slackoff/T-1-x", title: "T-1: x", bodyFile });
  assert.deepEqual(pr, { number: 42, url: "https://github.com/example-org/api/pull/42" });
  const [c] = ghCalls();
  assert.deepEqual(c!.argv, ["pr", "create", "--repo", "github.com/example-org/api", "--base", "main", "--head", "slackoff/T-1-x", "--title", "T-1: x", "--body-file", bodyFile]);
  assert.equal(c!.body, "## Summary\nEvidence is in Slack Off.\n");
  assert.equal(c!.stdinBytes, 0);
  assert.equal(c!.env.GH_PROMPT_DISABLED, "1");
  assert.equal(c!.env.GH_NO_UPDATE_NOTIFIER, "1");
  assert.equal(c!.env.NO_COLOR, "1");
  for (const bad of ["--draft", "--fill", "--dry-run", "--web", "--editor", "merge", "--reviewer", "--label"]) assert.ok(!c!.argv.includes(bad), bad);
});

test("GhClient.findOpenPr: reusable for the same repo and base; conflict for a fork, another base, or two PRs", async () => {
  const gh = new GhClient(ghBin, 20_000);
  const pr = (o: Record<string, unknown> = {}) => ({ number: 7, url: "https://github.com/example-org/api/pull/7", state: "OPEN", headRefName: "slackoff/T-1-x", baseRefName: "main", isCrossRepository: false, headRepositoryOwner: { login: "example-org" }, ...o });
  const find = async (list: unknown[]) => {
    fakeGh({ stdout: JSON.stringify(list), filterBase: true }); // like real gh, honours --base if it is given
    return gh.findOpenPr("github.com/example-org/api", "slackoff/T-1-x", "main");
  };
  assert.deepEqual(await find([]), { kind: "none" });
  assert.deepEqual(await find([pr()]), { kind: "reusable", number: 7, url: "https://github.com/example-org/api/pull/7" });
  const argv = ghCalls().at(-1)!.argv;
  assert.deepEqual(argv, ["pr", "list", "--repo", "github.com/example-org/api", "--head", "slackoff/T-1-x", "--state", "open", "--json", "number,url,state,headRefName,baseRefName,isCrossRepository,headRepositoryOwner"]);
  assert.equal((await find([pr({ isCrossRepository: true, headRepositoryOwner: { login: "someone" } })])).kind, "conflict");
  assert.equal((await find([pr({ baseRefName: "develop" })])).kind, "conflict");
  assert.equal((await find([pr({ headRepositoryOwner: { login: "someone" } })])).kind, "conflict");
  assert.equal((await find([pr(), pr({ number: 8, isCrossRepository: true })])).kind, "conflict");
});

test("GhClient: authStatus uses only the exit code; getPrBody, editPrBody and repoVisibility argv", async () => {
  const gh = new GhClient(ghBin, 20_000);
  fakeGh({ code: 1, stderr: "You are not logged into any GitHub hosts" });
  assert.equal((await gh.authStatus("github.com")).ok, false);
  assert.deepEqual(ghCalls()[0]!.argv, ["auth", "status", "--hostname", "github.com", "--active"]);
  fakeGh({ code: 0, stderr: "Logged in" });
  assert.equal((await gh.authStatus("github.com")).ok, true);
  // only the active account counts: another, expired login on the same host makes plain "gh auth status" fail
  assert.deepEqual(ghCalls().map((c) => c.argv), [["auth", "status", "--hostname", "github.com", "--active"]]);
  // a gh without --active (before 2.40): the plain check
  fakeGh({ code: 0, noActive: true });
  assert.equal((await gh.authStatus("github.com")).ok, true);
  assert.deepEqual(ghCalls().map((c) => c.argv), [["auth", "status", "--hostname", "github.com", "--active"], ["auth", "status", "--hostname", "github.com"]]);

  fakeGh({ stdout: JSON.stringify({ body: "hello <!-- slackoff:links -->" }) });
  assert.equal(await gh.getPrBody("github.com/example-org/api", 7), "hello <!-- slackoff:links -->");
  assert.deepEqual(ghCalls()[0]!.argv, ["pr", "view", "7", "--repo", "github.com/example-org/api", "--json", "body"]);

  fakeGh({});
  const f = join(ghDir, "edit.md");
  writeFileSync(f, "new");
  await gh.editPrBody("github.com/example-org/api", 7, f);
  assert.deepEqual(ghCalls()[0]!.argv, ["pr", "edit", "7", "--repo", "github.com/example-org/api", "--body-file", f]);

  fakeGh({ stdout: JSON.stringify({ isPrivate: true }) });
  assert.equal(await gh.repoVisibility("github.com/example-org/api"), true);
  assert.deepEqual(ghCalls()[0]!.argv, ["repo", "view", "github.com/example-org/api", "--json", "isPrivate"]);
  fakeGh({ stdout: JSON.stringify({ isPrivate: false }) });
  assert.equal(await gh.repoVisibility("github.com/example-org/api"), false);
  fakeGh({ code: 1, stderr: "boom" });
  assert.equal(await gh.repoVisibility("github.com/example-org/api"), null);
});

test("GhClient: a failing gh surfaces its stderr; a missing binary is a DeliveryError", async () => {
  const gh = new GhClient(ghBin, 20_000);
  fakeGh({ code: 1, stderr: "GraphQL: Resource not accessible by integration\n" });
  await rejectsWith(gh.createPr({ repo: "github.com/example-org/api", base: "main", head: "slackoff/T-1-x", title: "t", bodyFile: join(ghDir, "none.md") }), /Resource not accessible by integration/);
  await rejectsWith(gh.findOpenPr("github.com/example-org/api", "h", "main"), /Resource not accessible/);
  await rejectsWith(new GhClient(join(ghDir, "does-not-exist")).getPrBody("github.com/example-org/api", 1), /gh/);
  assert.ok(existsSync(ghBin));
});

// ---- Azure DevOps remotes ----

import { parseRemote } from "../src/delivery/git-push.ts";

/** the user@host part of a remote URL, built so it does not read as an email address */
const at = (user: string, host: string) => [user, host].join("@");

test("parseRemote: Azure DevOps https (with or without a user), visualstudio.com and ssh forms; GitHub still GitHub", () => {
  const az = { forge: "azure", host: "dev.azure.com", owner: "Contoso-Org/Web Apps", name: "shop-ui" };
  for (const u of [
    "https://dev.azure.com/Contoso-Org/Web%20Apps/_git/shop-ui",
    `https://${at("someone", "dev.azure.com")}/Contoso-Org/Web%20Apps/_git/shop-ui`,
    "https://contoso-org.visualstudio.com/Web%20Apps/_git/shop-ui",
    "https://contoso-org.visualstudio.com/DefaultCollection/Web%20Apps/_git/shop-ui",
    `${at("git", "ssh.dev.azure.com")}:v3/Contoso-Org/Web%20Apps/shop-ui`,
    `ssh://${at("git", "ssh.dev.azure.com")}/v3/Contoso-Org/Web%20Apps/shop-ui`,
  ]) {
    const r = parseRemote(u);
    assert.ok(r, u);
    assert.equal(r!.forge, "azure", u);
    assert.equal(r!.name, az.name, u);
    assert.equal(r!.owner.toLowerCase(), az.owner.toLowerCase(), u);
  }
  assert.deepEqual(parseRemote("https://github.com/example-org/api.git"), { forge: "github", host: "github.com", owner: "example-org", name: "api" });
  for (const u of ["https://dev.azure.com/org/_git/repo", "https://evil.example/org/proj/_git/repo", "https://dev.azure.com/org/proj/_git/repo/extra", "file:///tmp/x"]) {
    assert.equal(parseRemote(u), null, u);
  }
});

test("remoteInfo: an Azure DevOps origin is its remote (no github); a pushurl to another Azure repo is a mismatch", async () => {
  const f = await fixture();
  sh(f.clone, "remote", "set-url", "origin", `https://${at("someone", "dev.azure.com")}/Org/Proj/_git/repo`);
  const info = await remoteInfo(f.wt);
  assert.equal(info.github, null);
  assert.deepEqual(info.remote, { forge: "azure", host: "dev.azure.com", owner: "Org/Proj", name: "repo" });
  assert.equal(info.url, "https://dev.azure.com/Org/Proj/_git/repo", "credentials are never shown");
  sh(f.clone, "config", "remote.origin.pushurl", "https://dev.azure.com/Org/Proj/_git/other");
  assert.match((await remoteInfo(f.wt)).pushUrlMismatch ?? "", /other/);
});
