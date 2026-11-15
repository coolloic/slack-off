// Phase 4a Task 3 (rulings A-1, A-3, 4A-1): the platform's git commits and pushes run the repository's hooks through
// generated wrappers (`-c core.hooksPath=<wrapper dir>`), each hook inside the dev-hook sandbox. Real sandbox-exec runs
// on macOS (skipped elsewhere, with the reason).
//
// No network, no developer config: HOME / XDG_CONFIG_HOME are scratch dirs (runProcess strips GIT_CONFIG_GLOBAL, so HOME
// is the lever), origins are local bare repositories, and the only TCP connect is to 127.0.0.1:4317, which the sandbox
// refuses before any packet is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { pushBranch } from "../src/delivery/git-push.ts";
import { gitBin } from "../src/git/run.ts";
import { commitAll, ensureWorktree, hooksFingerprint, ticketDir } from "../src/git/worktree.ts";
import { HOOK_NAMES, prepareHookWrappers } from "../src/sandbox/hook-wrappers.ts";
import { SANDBOX_EXEC, SandboxUnavailableError, ticketTmpDir, hookScope, type SandboxCheck, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { tmpDir } from "./helpers/tmp.ts";

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const skip = HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;

// ---------------------------------------------------------------- isolation (scratch HOME, no global git config)

const root = realpathSync(tmpDir("hooksbx"));
const userHome = join(root, "userhome");
mkdirSync(join(userHome, ".ssh"), { recursive: true });
mkdirSync(join(userHome, ".config"), { recursive: true });
writeFileSync(join(userHome, ".ssh/id"), "PRIVATE-KEY\n");
gitBin(); // resolve (xcrun) before HOME changes
assert.notEqual(process.env.HOME, userHome);
process.env.HOME = userHome;
process.env.XDG_CONFIG_HOME = join(userHome, ".config");

const GIT_ENV = { ...process.env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, ".config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
/** git for test setup only */
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "protocol.file.allow=always", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV }).trim();
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const home = join(root, "slackoff");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "slackoff.db"), "DB\n");
const FIX = join(import.meta.dirname, "fixtures/hooks");
const config: Config = loadConfig(join(root, "cfg"));

const hook = (body: string) => `#!/bin/sh\n${body}\n`;
const LINT = hook(`sh ${shq(join(FIX, "fake-lint-staged.sh"))}`);
const COMMITLINT = hook(`exec sh ${shq(join(FIX, "fake-commitlint.sh"))} "$1"`);
/** pre-push: its arguments and the ref lines on stdin, into the worktree (the hook's cwd) */
const PRE_PUSH = hook('echo "$@" > pushed-args.txt\ncat > pushed.txt');

let n = 0;
interface Fx {
  key: string;
  repo: string;
  main: string;
  bare: string;
  wt: string;
  branch: string;
}

/** A repo with `hooks` committed under .githooks (core.hooksPath=.githooks unless `hooksPath` says otherwise), a bare origin and a platform worktree. */
async function fixture(hooks: Record<string, string>, o: { hooksPath?: string; hooksDir?: string } = {}): Promise<Fx> {
  const id = n++;
  const key = `HK-${id}`;
  const repo = `api${id}`;
  const main = join(root, "repos", repo);
  mkdirSync(main, { recursive: true });
  sh(main, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) sh(main, "config", k!, v!);
  writeFileSync(join(main, "a.js"), "a\n");
  writeFileSync(join(main, "b.js"), "b\n");
  const hooksDir = o.hooksDir ?? join(main, ".githooks");
  mkdirSync(hooksDir, { recursive: true });
  for (const [name, body] of Object.entries(hooks)) {
    writeFileSync(join(hooksDir, name), body);
    chmodSync(join(hooksDir, name), 0o755);
  }
  sh(main, "add", "-A");
  sh(main, "commit", "-q", "-m", "init");
  const bare = join(root, "bare", `${repo}.git`);
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "-q", "--bare", "-b", "main");
  sh(main, "remote", "add", "origin", `file://${bare}`);
  sh(main, "push", "-q", "origin", "main");
  sh(main, "config", "core.hooksPath", o.hooksPath ?? ".githooks");
  const branch = `slackoff/${key}-x`;
  const { path: wt } = await ensureWorktree({ home, key, repo: { name: repo, path: main, baseBranch: "main" }, branch });
  return { key, repo, main, bare, wt, branch };
}

const passing = async (): Promise<SandboxCheck> => ({ ok: true, detail: "ok" });
const failing = async (): Promise<SandboxCheck> => ({ ok: false, detail: "sandbox-exec is not available on linux" });

async function wrap(f: Fx, o: { check?: (s: SandboxScope) => Promise<SandboxCheck>; cfg?: Config } = {}) {
  const pin = await hooksFingerprint(f.wt);
  const gate = await prepareHookWrappers({ home, key: f.key, repo: f.repo, wt: f.wt, repoPath: f.main, branch: f.branch, pin, config: o.cfg ?? config, ...(o.check ? { check: o.check } : {}) });
  return { pin, gate };
}
const head = (dir: string) => sh(dir, "rev-parse", "HEAD");

// ---------------------------------------------------------------- the wrapper dir

test("HOOK_NAMES: the hooks a platform commit or push can run", () => {
  assert.deepEqual([...HOOK_NAMES], ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-push", "post-rewrite", "reference-transaction"]);
});

test("prepareHookWrappers: <home>/sandbox/<KEY>/<repo>/hooks (real path, 0700, outside the agent's ticket dir), one 0755 wrapper per present hook, rewritten each time", async () => {
  const f = await fixture({ "pre-commit": LINT, "commit-msg": COMMITLINT, "pre-push": PRE_PUSH, "post-checkout": hook("exit 0"), "pre-commit.sample": hook("exit 0") });
  chmodSync(join(f.wt, ".githooks/pre-commit.sample"), 0o644);
  const { pin, gate } = await wrap(f, { check: passing });
  assert.equal(gate.kind, "sandboxed");
  assert.equal(gate.dir, join(realpathSync(home), "sandbox", f.key, f.repo, "hooks"));
  assert.equal(realpathSync(gate.dir), gate.dir);
  const tdir = realpathSync(ticketDir(home, f.key));
  assert.ok(!gate.dir.startsWith(`${tdir}/`), "the wrappers are outside the agent's writable ticket directory");
  assert.equal(statSync(gate.dir).mode & 0o777, 0o700);
  // 4A-4: every executable file of the pinned dir gets a wrapper (git never runs a hook from anywhere else)
  assert.deepEqual(readdirSync(gate.dir).sort(), ["commit-msg", "post-checkout", "pre-commit", "pre-push"], "every executable hook, nothing else");
  for (const name of readdirSync(gate.dir)) assert.equal(statSync(join(gate.dir, name)).mode & 0o777, 0o755, name);
  const text = readFileSync(join(gate.dir, "pre-commit"), "utf8");
  assert.ok(text.startsWith("#!/bin/sh\n"), text);
  assert.ok(text.includes(shq(SANDBOX_EXEC)), "runs the hook under sandbox-exec");
  assert.ok(text.includes(`${shq(join(pin.dir, "pre-commit"))} "$@"`), "execs the hook at its pinned path with git's arguments");
  assert.ok(text.includes(shq(pin.hash)), "re-checks the pinned fingerprint");
  // rewritten from scratch: a stale wrapper (or a file planted there) is gone
  writeFileSync(join(gate.dir, "post-commit"), "#!/bin/sh\n");
  await wrap(f, { check: passing });
  assert.deepEqual(readdirSync(gate.dir).sort(), ["commit-msg", "post-checkout", "pre-commit", "pre-push"]);
});

test("4A-4: a pinned dir without executable hooks -> an empty wrapper dir, no self-check (nothing runs, whatever is configured)", async () => {
  // `git init`'s executable samples are never run by git, so they need no wrapper
  const f = await fixture({ "pre-commit.sample": hook("exit 0") });
  let checks = 0;
  const { gate } = await wrap(f, { check: async () => (checks++, { ok: false, detail: "no" }) });
  assert.equal(checks, 0);
  assert.equal(gate.kind, "sandboxed");
  assert.deepEqual(readdirSync(gate.dir), []);
});

test("prepareHookWrappers: the self-check runs on the dev-hook scope of this worktree", async () => {
  const f = await fixture({ "pre-commit": LINT });
  const seen: unknown[] = [];
  await wrap(f, { check: async (s) => (seen.push(s), { ok: true, detail: "ok" }) });
  const common = realpathSync(join(f.main, ".git"));
  assert.deepEqual(seen, [hookScope(home, f.key, f.wt, { common, admin: join(common, "worktrees", f.repo), branch: `refs/heads/${f.branch}` }, [])]);
});

test("prepareHookWrappers: self-check failed + switch off -> SandboxUnavailableError naming the switch, no wrapper dir; switch on -> unsandboxed", async () => {
  const f = await fixture({ "pre-commit": LINT });
  assert.equal(config.development.allowUnsandboxedHooks, false);
  await assert.rejects(
    wrap(f, { check: failing }),
    (e: unknown) =>
      e instanceof SandboxUnavailableError &&
      e.message ===
        'sandbox-exec is not available on linux — git hooks are not run without the sandbox. To run them anyway, turn on Settings → Development → "Run git hooks without the sandbox" on this computer',
  );
  assert.equal(existsSync(join(home, "sandbox", f.key, f.repo, "hooks")), false, "no wrapper is left to run");
  const on = loadConfig(join(root, "cfg-on"));
  on.development.allowUnsandboxedHooks = true;
  const { gate } = await wrap(f, { check: failing, cfg: on });
  assert.deepEqual(gate, { kind: "unsandboxed", dir: join(realpathSync(home), "sandbox", f.key, f.repo, "hooks"), reason: "sandbox-exec is not available on linux" });
  // unsandboxed: no sandbox-exec, but the fingerprint is still re-checked before the hook runs
  const text = readFileSync(join(gate.dir, "pre-commit"), "utf8");
  assert.ok(!text.includes(SANDBOX_EXEC), text);
  writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
  const c = await commitAll(home, f.wt, `${f.key}: work`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  assert.equal(c.kind, "committed", JSON.stringify(c));
  assert.match(sh(f.wt, "show", "HEAD:a.js"), /\/\* formatted \*\//);
});

// ---------------------------------------------------------------- commits through the wrappers (real sandbox)

test("commit: the lint-staged-style pre-commit rewrites inside the sandbox and the rewrite is committed; commitlint passes a good message", { skip }, async () => {
  const f = await fixture({ "pre-commit": LINT, "commit-msg": COMMITLINT });
  const { gate } = await wrap(f);
  assert.equal(gate.kind, "sandboxed");
  writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
  const c = await commitAll(home, f.wt, `${f.key}: work`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  assert.equal(c.kind, "committed", JSON.stringify(c));
  assert.equal(sh(f.wt, "show", "HEAD:a.js"), "a\nchanged\n/* formatted */");
  assert.equal(sh(f.wt, "log", "-1", "--format=%s"), `${f.key}: work`);
  assert.equal(sh(f.wt, "stash", "list"), "");
  assert.equal(sh(f.wt, "status", "--porcelain"), "");
});

test("commit: commitlint rejects a bad message -> hook_failed with its error; nothing committed", { skip }, async () => {
  const f = await fixture({ "pre-commit": LINT, "commit-msg": COMMITLINT });
  const { gate } = await wrap(f);
  const before = head(f.wt);
  writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
  const c = await commitAll(home, f.wt, "bad message", 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  assert.equal(c.kind, "hook_failed");
  assert.match(c.kind === "hook_failed" ? c.outputTail : "", /fake-commitlint: subject must start with/);
  assert.equal(head(f.wt), before);
});

test("commit: inside the hook, Slack Off's port, the injected HOME's ssh key and the repo's git config are EPERM -> hook_failed", { skip }, async () => {
  const probe = `
const fs = require("node:fs"); const net = require("node:net"); const out = [];
const t = (l, fn) => { try { fn(); out.push(l + ":OK"); } catch (e) { out.push(l + ":" + e.code); } };
t("ssh", () => fs.readFileSync(require("node:path").join(process.env.HOME, ".ssh/id")));
t("gitconfig", () => fs.appendFileSync(process.argv[2] + "/config", "[core]\\n\\tfsmonitor = /tmp/x\\n"));
const s = net.connect({ host: "127.0.0.1", port: 4317 });
const fin = (r) => { out.push("4317:" + r); console.log(out.join(" ")); process.exit(1); };
s.setTimeout(3000, () => fin("TIMEOUT")); s.on("connect", () => fin("CONNECTED")); s.on("error", (e) => fin(e.code));`;
  writeFileSync(join(root, "probe.cjs"), probe);
  const f = await fixture({ "pre-commit": hook(`${shq(process.execPath)} ${shq(join(root, "probe.cjs"))} "$(git rev-parse --path-format=absolute --git-common-dir)"`) });
  const { gate } = await wrap(f);
  const cfgBefore = readFileSync(join(f.main, ".git/config"), "utf8");
  const before = head(f.wt);
  writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
  const c = await commitAll(home, f.wt, `${f.key}: work`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  assert.equal(c.kind, "hook_failed");
  const out = c.kind === "hook_failed" ? c.outputTail : "";
  assert.match(out, /ssh:EPERM gitconfig:EPERM 4317:EPERM/, out);
  assert.equal(readFileSync(join(f.main, ".git/config"), "utf8"), cfgBefore);
  assert.equal(head(f.wt), before);
});

test("commit: a hook changed after the wrappers were written -> not run, 'hooks changed since they were accepted', nothing committed", { skip }, async () => {
  // a hooks dir outside the worktree: restoreProtected cannot put it back
  const shared = join(root, `shared-hooks-${n}`);
  const f = await fixture({ "pre-commit": hook("exit 0") }, { hooksPath: shared, hooksDir: shared });
  const { gate } = await wrap(f);
  const marker = join(root, `tampered-ran-${n}`);
  writeFileSync(join(shared, "pre-commit"), hook(`touch ${shq(marker)}\nexit 0`));
  const before = head(f.wt);
  writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
  const c = await commitAll(home, f.wt, `${f.key}: work`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  assert.equal(c.kind, "hook_failed");
  assert.match(c.kind === "hook_failed" ? c.outputTail : "", /Slack Off: hooks changed since they were accepted/);
  assert.equal(existsSync(marker), false, "the changed hook never ran");
  assert.equal(head(f.wt), before);
});

test("commit: a worktree-level core.hooksPath pointing elsewhere is ignored — -c core.hooksPath=<wrappers> wins", { skip }, async () => {
  const f = await fixture({ "pre-commit": hook('echo "pinned hook ran" > "$TMPDIR/pinned-ran"') });
  const { gate } = await wrap(f);
  const other = join(root, `other-hooks-${n}`);
  const marker = join(root, `other-ran-${n}`);
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "pre-commit"), hook(`touch ${shq(marker)}`));
  chmodSync(join(other, "pre-commit"), 0o755);
  sh(f.main, "config", "extensions.worktreeConfig", "true");
  sh(f.wt, "config", "--worktree", "core.hooksPath", other);
  writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
  const c = await commitAll(home, f.wt, `${f.key}: work`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  assert.equal(c.kind, "committed", JSON.stringify(c));
  assert.equal(existsSync(marker), false, "the redirected hooks dir never ran");
  const tmp = ticketTmpDir(hookScope(home, f.key, f.wt, { common: "/c", admin: "/c/worktrees/x" }, []));
  assert.equal(readFileSync(join(tmp, "pinned-ran"), "utf8"), "pinned hook ran\n", "the pinned hook ran, with the ticket's TMPDIR");
});

test("commit: the hook's environment has no agent sockets, ANTHROPIC_* or GitHub tokens; git's own GIT_* variables are kept", { skip }, async () => {
  const f = await fixture({ "pre-commit": hook('env | sort > "$TMPDIR/hook-env"') });
  const { gate } = await wrap(f);
  const fake = {
    SSH_AUTH_SOCK: join(root, "no-agent.sock"), GPG_AGENT_INFO: "x", ANTHROPIC_API_KEY: "fake-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", GH_TOKEN: "fake-gh",
    GITHUB_TOKEN: "fake-gh2", CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth", CLAUDE_CODE_USE_BEDROCK: "1", NPM_TOKEN: "fake-npm", AWS_SECRET_ACCESS_KEY: "fake-aws",
    AWS_PROFILE: "fake", DB_PASSWORD: "fake-pw", APP_SECRET: "fake-secret", OPENAI_API_KEY: "fake-oa", SENTRY_AUTH_TOKEN: "fake-sentry", SLACKOFF_KEEP_ME: "kept",
    // 4A-11
    REGISTRY_AUTH: "a", MY_AUTH_TOKEN_V2: "b", NPM_CONFIG__AUTH: "c", npm_config__authToken: "d", GOOGLE_APPLICATION_CREDENTIALS: "/x.json", AZURE_CREDENTIALS: "e", DEPLOY_PRIVATE_KEY: "f",
  };
  const saved = Object.fromEntries(Object.keys(fake).map((k) => [k, process.env[k]]));
  Object.assign(process.env, fake);
  let c;
  try {
    writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
    c = await commitAll(home, f.wt, `${f.key}: work`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(c.kind, "committed", JSON.stringify(c));
  const tmp = ticketTmpDir(hookScope(home, f.key, f.wt, { common: "/c", admin: "/c/worktrees/x" }, []));
  const env = new Map(readFileSync(join(tmp, "hook-env"), "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as [string, string]));
  for (const k of Object.keys(fake).filter((k) => k !== "SLACKOFF_KEEP_ME")) assert.ok(!env.has(k), `${k} leaked`);
  assert.equal(env.get("SLACKOFF_KEEP_ME"), "kept", "the rest of the environment is kept");
  assert.equal(env.get("TMPDIR"), tmp);
  assert.equal(env.get("HOME"), userHome);
  assert.ok(env.has("GIT_INDEX_FILE") && env.has("GIT_DIR"), [...env.keys()].join(" "));
});

test("commit: husky v9 layout — .husky/_/pre-commit sources h, which finds the user script next to $0's parent; runs in the sandbox", { skip }, async () => {
  // a stand-in for husky v9's generated files (`.husky/_` is gitignored and made by `husky` at install)
  const H = '#!/usr/bin/env sh\nn=$(basename "$0")\ns=$(dirname "$(dirname "$0")")/$n\n[ ! -f "$s" ] && exit 0\nsh -e "$s" "$@"\n';
  const f = await fixture({}, { hooksPath: ".husky/_" });
  mkdirSync(join(f.wt, ".husky/_"), { recursive: true });
  writeFileSync(join(f.wt, ".husky/_/h"), H);
  writeFileSync(join(f.wt, ".husky/_/pre-commit"), '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
  writeFileSync(join(f.wt, ".husky/_/.gitignore"), "*\n");
  chmodSync(join(f.wt, ".husky/_/pre-commit"), 0o755);
  writeFileSync(join(f.wt, ".husky/pre-commit"), 'echo "husky user script ran" > "$TMPDIR/husky-ran"\n' + `${shq(process.execPath)} -e 'require("node:fs").readFileSync(process.env.HOME + "/.ssh/id")' 2>"$TMPDIR/husky-ssh-err" && echo "ssh readable" > "$TMPDIR/husky-ssh" || true\n`);
  sh(f.wt, "add", ".husky/pre-commit");
  sh(f.wt, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "husky");
  const { gate } = await wrap(f);
  assert.deepEqual(readdirSync(gate.dir), ["pre-commit"]);
  writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
  const c = await commitAll(home, f.wt, `${f.key}: work`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  assert.equal(c.kind, "committed", JSON.stringify(c));
  const tmp = ticketTmpDir(hookScope(home, f.key, f.wt, { common: "/c", admin: "/c/worktrees/x" }, []));
  assert.equal(readFileSync(join(tmp, "husky-ran"), "utf8"), "husky user script ran\n");
  assert.equal(existsSync(join(tmp, "husky-ssh")), false, "the user script ran inside the sandbox");
  assert.match(readFileSync(join(tmp, "husky-ssh-err"), "utf8"), /EPERM/);
});

test("a hook that commits again (without --no-verify) fails visibly — the nested hook cannot enter a second sandbox (4A-1)", { skip }, async () => {
  // pre-push (no index lock held) commits; the nested commit's git, inside the sandbox, reaches the pre-commit wrapper
  const f = await fixture({ "pre-commit": hook("exit 0"), "pre-push": hook('git commit -q --allow-empty -m "nested" || { echo "nested commit failed" >&2; exit 1; }') });
  writeFileSync(join(f.wt, "c.js"), "c\n");
  sh(f.wt, "add", "-A");
  sh(f.wt, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "work");
  const local = head(f.wt);
  const { gate } = await wrap(f);
  await assert.rejects(
    pushBranch({ home, repo: f.repo, wt: f.wt, branch: f.branch, baseBranch: "main", localSha: local, hookTimeoutMs: 60_000, hooksDir: gate.dir, repoPath: f.main }),
    // the wrapper dir is inside SLACKOFF_HOME, which the sandbox denies: the nested git cannot even start the wrapper
    (e: Error) => /hooks\/pre-commit: Operation not permitted/.test(e.message) && /nested commit failed/.test(e.message),
  );
  assert.equal(head(f.wt), local, "no nested commit");
  assert.throws(() => sh(f.bare, "rev-parse", "--verify", "-q", `refs/heads/${f.branch}`));
});

// ---------------------------------------------------------------- push through the wrappers (real sandbox)

test("push: pushBranch with the wrapper dir runs pre-push in the sandbox; its arguments and stdin ref lines arrive intact", { skip }, async () => {
  const f = await fixture({ "pre-push": PRE_PUSH });
  writeFileSync(join(f.wt, "c.js"), "c\n");
  sh(f.wt, "add", "-A");
  sh(f.wt, "commit", "-q", "-m", "work");
  const sha = head(f.wt);
  const { gate } = await wrap(f);
  const r = await pushBranch({ home, repo: f.repo, wt: f.wt, branch: f.branch, baseBranch: "main", localSha: sha, hookTimeoutMs: 60_000, hooksDir: gate.dir, repoPath: f.main });
  assert.equal(r.pushed, true);
  assert.equal(sh(f.bare, "rev-parse", `refs/heads/${f.branch}`), sha);
  assert.equal(readFileSync(join(f.wt, "pushed-args.txt"), "utf8"), `origin file://${f.bare}\n`);
  // `<local ref> <local sha> <remote ref> <remote sha>`; the source is a sha, so git names it as given
  assert.equal(readFileSync(join(f.wt, "pushed.txt"), "utf8"), `${sha} ${sha} refs/heads/${f.branch} ${"0".repeat(40)}\n`);
});

test("push: a pre-push hook cannot read the injected HOME's ssh key — the push fails with the hook's EPERM, nothing pushed", { skip }, async () => {
  const f = await fixture({ "pre-push": hook(`${shq(process.execPath)} -e 'try { require("node:fs").readFileSync(process.env.HOME + "/.ssh/id"); } catch (e) { console.error("pre-push ssh:" + e.code); process.exit(1); }'`) });
  const sha = head(f.wt);
  writeFileSync(join(f.wt, "c.js"), "c\n");
  sh(f.wt, "add", "-A");
  sh(f.wt, "commit", "-q", "-m", "work");
  const local = head(f.wt);
  assert.notEqual(local, sha);
  const { gate } = await wrap(f);
  await assert.rejects(
    pushBranch({ home, repo: f.repo, wt: f.wt, branch: f.branch, baseBranch: "main", localSha: local, hookTimeoutMs: 60_000, hooksDir: gate.dir, repoPath: f.main }),
    (e: Error) => /pre-push ssh:EPERM/.test(e.message),
  );
  assert.throws(() => sh(f.bare, "rev-parse", "--verify", "-q", `refs/heads/${f.branch}`));
});

test("4A-6: the opt-out wrappers (switch on, no sandbox) strip the same secrets before running the hook", async () => {
  const envFile = join(root, `optout-env-${n}`);
  const f = await fixture({ "pre-commit": hook(`env | sort > ${shq(envFile)}`) });
  const on = loadConfig(join(root, "cfg-optout"));
  on.development.allowUnsandboxedHooks = true;
  const { gate } = await wrap(f, { check: failing, cfg: on });
  assert.equal(gate.kind, "unsandboxed");
  const fake = { SSH_AUTH_SOCK: join(root, "no-agent.sock"), ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", NPM_TOKEN: "n", AWS_ACCESS_KEY_ID: "a", GH_TOKEN: "g", X_API_KEY: "x", SLACKOFF_KEEP_ME: "kept" };
  const saved = Object.fromEntries(Object.keys(fake).map((k) => [k, process.env[k]]));
  Object.assign(process.env, fake);
  let c;
  try {
    writeFileSync(join(f.wt, "a.js"), "a\nchanged\n");
    c = await commitAll(home, f.wt, `${f.key}: work`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(c.kind, "committed", JSON.stringify(c));
  const env = readFileSync(envFile, "utf8");
  for (const k of Object.keys(fake).filter((k) => k !== "SLACKOFF_KEEP_ME")) assert.ok(!new RegExp(`^${k}=`, "m").test(env), `${k} leaked`);
  assert.match(env, /^SLACKOFF_KEEP_ME=kept$/m);
});

test("4A-10: the hook scope's branch is the recorded one, whatever the worktree's HEAD says when the wrappers are written", async () => {
  const f = await fixture({ "pre-commit": LINT });
  sh(f.wt, "symbolic-ref", "HEAD", "refs/heads/main");
  const seen: SandboxScope[] = [];
  try {
    await wrap(f, { check: async (s) => (seen.push(s), { ok: true, detail: "ok" }) });
  } finally {
    sh(f.wt, "symbolic-ref", "HEAD", `refs/heads/${f.branch}`);
  }
  assert.equal(seen[0]!.gitDirs!.branch, `refs/heads/${f.branch}`);
});

test("4A-12 (N3): a hook cannot turn its ref literals into symlinks — two commits through the wrappers, the scratch HOME's ~/.zshrc and authorized_keys stay untouched; a plant from outside refuses the next wrappers", { skip }, async () => {
  // a scratch HOME outside every temp dir (the dev profiles allow writing $TMPDIR and /tmp, so a HOME there proves nothing)
  const fakeHome = realpathSync(mkdtempSync("/private/var/tmp/slackoff-n3-"));
  process.on("exit", () => rmSync(fakeHome, { recursive: true, force: true }));
  try {
    const rc = join(fakeHome, ".zshrc");
    const keys = join(fakeHome, ".ssh/authorized_keys");
    mkdirSync(join(fakeHome, ".ssh"));
    writeFileSync(rc, "RC\n");
    writeFileSync(keys, "KEYS\n");
    const id = n;
    const branchRef = `refs/heads/slackoff/HK-${id}-x`;
    // each run: write through any symlink a previous run planted, then plant (stash ref and log, the branch's lock and log)
    const body = [
      'C="$(git rev-parse --path-format=absolute --git-common-dir)"',
      `for f in refs/stash logs/refs/stash refs/stash.lock logs/${branchRef}.lock; do [ -L "$C/$f" ] && echo PWNED >> "$C/$f"; done`,
      `ln -s ${shq(rc)} "$C/refs/stash" 2>/dev/null`,
      `ln -s ${shq(keys)} "$C/logs/refs/stash" 2>/dev/null`,
      `ln -s ${shq(rc)} "$C/refs/stash.lock" 2>/dev/null`,
      `ln -s ${shq(keys)} "$C/logs/${branchRef}.lock" 2>/dev/null`,
      "exit 0",
    ].join("\n");
    const f = await fixture({ "pre-commit": hook(body) });
    assert.equal(`refs/heads/${f.branch}`, branchRef);
    const common = realpathSync(join(f.main, ".git"));
    for (const i of [1, 2]) {
      const { gate } = await wrap(f);
      assert.equal(gate.kind, "sandboxed");
      writeFileSync(join(f.wt, "a.js"), `a\nchange ${i}\n`);
      const c = await commitAll(home, f.wt, `${f.key}: work ${i}`, 60_000, { hooksDir: gate.dir, repoPath: f.main, branch: f.branch });
      assert.equal(c.kind, "committed", `commit ${i}: ${JSON.stringify(c)}`);
      for (const rel of ["refs/stash", "logs/refs/stash", "refs/stash.lock", `logs/${branchRef}.lock`]) {
        let link = false;
        try {
          link = lstatSync(join(common, rel)).isSymbolicLink();
        } catch {
          // missing
        }
        assert.equal(link, false, `commit ${i}: ${rel} became a symlink`);
      }
    }
    assert.equal(readFileSync(rc, "utf8"), "RC\n", "~/.zshrc untouched");
    assert.equal(readFileSync(keys, "utf8"), "KEYS\n", "authorized_keys untouched");
    // planted from outside (an earlier, unprotected run): the next wrappers are refused, nothing is written
    symlinkSync(rc, join(common, "refs/stash"));
    await assert.rejects(wrap(f), SandboxUnavailableError);
    assert.equal(readFileSync(rc, "utf8"), "RC\n");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
