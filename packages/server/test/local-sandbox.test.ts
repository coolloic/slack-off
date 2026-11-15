// Task 5 (ruling R-LOCAL): the macOS command sandbox for repository / agent-authored code. The deny rules are proven
// with real sandbox-exec runs; tests that need it are skipped (with the reason) on other platforms.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runProcess } from "../src/git/run.ts";
import { runCommand } from "../src/development/run-command.ts";
import { loadConfig } from "../src/config.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { apiKeyHelperPath } from "../src/executor/claude-api.ts";
import {
  commandSandbox, credentialPaths, SANDBOX_EXEC, sandboxArgv, sandboxParams, sandboxProfile, sandboxSelfCheck, SandboxUnavailableError,
  DENIED_PORTS, SELF_CHECK_SCRIPT, SLACKOFF_PORTS, sandboxEnv, ticketCacheDir, ticketTmpDir, writeShellPrefix, profileDeniesKeychain, hookScope, allowPathChecks, PARENT_ONLY_PARAMS, sandboxBackend, sandboxUnavailableNotice, type SandboxScope,
} from "../src/sandbox/local-sandbox.ts";

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const skip = HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;

const root = tmpDir("sbx");
after(() => rmSync(root, { recursive: true, force: true }));

// a fake user home (credentials), a fake SLACKOFF_HOME with a DB and a worktree, and a mapped repo
const userHome = join(root, "user");
mkdirSync(join(userHome, ".ssh"), { recursive: true });
writeFileSync(join(userHome, ".ssh/id"), "PRIVATE-KEY\n");
writeFileSync(join(userHome, ".npmrc"), "//registry/:_authToken=SECRET\n");
const home = join(root, "slackoff");
mkdirSync(join(home, "worktrees/K/api"), { recursive: true });
writeFileSync(join(home, "slackoff.db"), "DB\n");
writeFileSync(join(home, "worktrees/K/api/a.txt"), "A\n");
const repoDir = join(root, "repos/api");
mkdirSync(repoDir, { recursive: true });
writeFileSync(join(repoDir, "server.mjs"), "SRC\n");
const work = join(root, "work");
mkdirSync(work, { recursive: true });

/**
 * 4A-13: a scratch user home outside every temp dir (the dev profiles may write $TMPDIR and /tmp, so a home there would
 * make a write deny look like an allow). Never the developer's real home; removed in the end.
 */
function varTmpHome(tag: string): string {
  const d = realpathSync(mkdtempSync(`/private/var/tmp/slackoff-${tag}-`));
  process.on("exit", () => rmSync(d, { recursive: true, force: true }));
  return d;
}

const devScope: SandboxScope = { kind: "dev-command", home, allowInHome: join(home, "worktrees/K"), repos: [] };
const installScope: SandboxScope = { ...devScope, kind: "dev-install" };
// T6-2: an acceptance scope always has its run root (outside SLACKOFF_HOME and the repos)
const acceptRun = realpathSync(mkdtempSync(join(root, "run-")));
const acceptScope: SandboxScope = { kind: "acceptance", home, allowInHome: null, repos: [repoDir, join(root, "repos/web")], runRoot: acceptRun };

/** A probe run under `scope` with the injected user home: prints one `<label>:<result>` per action. */
const PROBE = `
const fs = require("node:fs"); const net = require("node:net");
const [reads, writes, conns] = JSON.parse(process.argv[1]);
const out = [];
for (const f of reads) { try { fs.readFileSync(f); out.push("read " + f + ":OK"); } catch (e) { out.push("read " + f + ":" + e.code); } }
for (const f of writes) { try { fs.appendFileSync(f, "w\\n"); out.push("write " + f + ":OK"); } catch (e) { out.push("write " + f + ":" + e.code); } }
let left = conns.length;
const done = () => { if (--left <= 0) { console.log(out.join("\\n")); process.exit(0); } };
if (left === 0) { left = 1; done(); }
for (const [host, port] of conns) {
  const s = net.connect({ host, port });
  s.setTimeout(3000, () => { out.push("conn " + host + ":" + port + ":TIMEOUT"); s.destroy(); done(); });
  s.on("connect", () => { out.push("conn " + host + ":" + port + ":OK"); s.destroy(); done(); });
  s.on("error", (e) => { out.push("conn " + host + ":" + port + ":" + e.code); done(); });
}`;

async function probe(scope: SandboxScope, a: { reads?: string[]; writes?: string[]; conns?: Array<[string, number]> }): Promise<Map<string, string>> {
  const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", PROBE, JSON.stringify([a.reads ?? [], a.writes ?? [], a.conns ?? []])]);
  const r = await runProcess(file, args, { cwd: work, timeoutMs: 20_000 });
  assert.equal(r.code, 0, r.stderr);
  const m = new Map<string, string>();
  for (const line of r.stdout.trim().split("\n")) {
    const i = line.lastIndexOf(":");
    m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

/** sandboxArgv with the fake user home injected (sandboxArgv itself uses os.homedir()). */
function sandboxArgvFor(scope: SandboxScope, file: string, args: string[], fakeHome = userHome) {
  const real = sandboxArgv(scope, file, args);
  const params = sandboxParams(scope);
  const injected = sandboxParams(scope, fakeHome);
  const i = real.args.indexOf(params[0]!);
  assert.deepEqual(real.args.slice(i, i + params.length), params);
  return { file: real.file, args: [...real.args.slice(0, i), ...injected, ...real.args.slice(i + params.length)] };
}

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((c) => c.end());
    server.on("error", reject);
    server.listen(0, host, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

// ---------------------------------------------------------------- runProcess env (R4)

test("runProcess with env: the child sees exactly that env (GIT_* removed), not the server's", async () => {
  process.env.SLACKOFF_SBX_LEAK = "leak";
  try {
    const r = await runProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], {
      env: { PATH: process.env.PATH, FOO: "1", GIT_DIR: "/x" },
    });
    const env = JSON.parse(r.stdout) as Record<string, string>;
    assert.equal(env.FOO, "1");
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.SLACKOFF_SBX_LEAK, undefined);
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    const inherited = await runProcess(process.execPath, ["-e", "console.log(process.env.SLACKOFF_SBX_LEAK)"], {});
    assert.equal(inherited.stdout.trim(), "leak", "without env the server's env is inherited (unchanged)");
  } finally {
    delete process.env.SLACKOFF_SBX_LEAK;
  }
});

// ---------------------------------------------------------------- profile and params

test("sandboxProfile: fixed text, paths only as params, both Slack Off ports denied on any host", () => {
  assert.deepEqual([...SLACKOFF_PORTS], [4317, 5173]);
  assert.deepEqual([...DENIED_PORTS].slice(0, 4), [4317, 5173, 9229, 9230]);
  for (const scope of [devScope, installScope, acceptScope, { ...acceptScope, kind: "acceptance-install" as const }]) {
    const p = sandboxProfile(scope);
    assert.ok(!p.includes("/"), `no absolute path in the profile: ${p}`);
    assert.ok(p.includes('(remote tcp "*:4317")') && p.includes('(remote tcp "*:5173")'), p);
    assert.match(p, /^\(version 1\)\s*\(allow default\)/);
    assert.ok(p.includes('(subpath (param "SLACKOFF_HOME"))'));
    // fix round 1: no signals out of the sandbox (SIGUSR1 → Node inspector), no inspector ports, no listening on them
    assert.ok(p.includes("(deny signal)\n(allow signal (target same-sandbox))"), p);
    for (const port of [4317, 5173, 9229, 9230]) {
      assert.ok(p.includes(`(remote tcp "*:${port}")`) && p.includes(`(local tcp "*:${port}")`), `${port}: ${p}`);
    }
    assert.ok(p.includes("(deny network-bind "), p);
  }
  const dev = sandboxProfile(devScope);
  assert.ok(dev.includes('(literal (param "HOME_NPMRC"))') && dev.includes('(literal (param "HOME_NETRC"))'));
  assert.ok(dev.indexOf('(param "HOME_ALLOW")') > dev.indexOf('(param "SLACKOFF_HOME")'), "the allow comes after the deny");
  // a program in the worktree resolves its real path (lstat of every parent): the parents' metadata only, never their contents
  assert.ok(dev.includes('(allow file-read-metadata (literal (param "HOME_ALLOW_UP_0")) (literal (param "HOME_ALLOW_UP_1")) (literal (param "TICKET_CACHE_UP")))'), dev);
  const inst = sandboxProfile(installScope);
  assert.ok(!inst.includes("HOME_NPMRC") && !inst.includes("HOME_NETRC"));
  assert.ok(inst.includes('(subpath (param "HOME_SSH"))') && inst.includes("HOME_ALLOW"));
  const acc = sandboxProfile(acceptScope);
  assert.ok(acc.includes('(subpath (param "REPO_0"))') && acc.includes('(subpath (param "REPO_1"))'));
  assert.ok(!acc.includes("HOME_ALLOW"));
});

test("sandboxProfile: a scope that does not fit its kind is refused", () => {
  assert.throws(() => sandboxProfile({ ...devScope, allowInHome: null }), SandboxUnavailableError);
  assert.throws(() => sandboxProfile({ ...installScope, allowInHome: null }), SandboxUnavailableError);
  assert.throws(() => sandboxProfile({ ...acceptScope, allowInHome: join(home, "worktrees/K") }), SandboxUnavailableError);
  assert.throws(() => sandboxProfile({ ...devScope, repos: [repoDir] }), SandboxUnavailableError);
  assert.throws(() => sandboxProfile({ ...devScope, allowInHome: join(root, "elsewhere") }), SandboxUnavailableError);
});

test("credentialPaths: credential locations and browser profiles; single files as literals", () => {
  const c = credentialPaths("/Users/u");
  const AS = "/Users/u/Library/Application Support";
  assert.deepEqual(c, [
    { param: "HOME_SSH", path: "/Users/u/.ssh", literal: false },
    { param: "HOME_GH", path: "/Users/u/.config/gh", literal: false },
    { param: "HOME_AWS", path: "/Users/u/.aws", literal: false },
    { param: "HOME_NPMRC", path: "/Users/u/.npmrc", literal: true },
    { param: "HOME_NETRC", path: "/Users/u/.netrc", literal: true },
    { param: "HOME_KEYCHAINS", path: "/Users/u/Library/Keychains", literal: false },
    { param: "CHROME_PROFILES", path: "/Users/u/Library/Application Support/Google/Chrome", literal: false },
    { param: "HOME_GIT_CREDENTIALS", path: "/Users/u/.git-credentials", literal: true },
    { param: "HOME_GIT_CONFIG_CREDENTIALS", path: "/Users/u/.config/git/credentials", literal: true },
    { param: "HOME_GNUPG", path: "/Users/u/.gnupg", literal: false },
    { param: "HOME_DOCKER_CONFIG", path: "/Users/u/.docker/config.json", literal: true },
    { param: "HOME_KUBE", path: "/Users/u/.kube", literal: false },
    { param: "ARC_PROFILES", path: `${AS}/Arc`, literal: false },
    { param: "BRAVE_PROFILES", path: `${AS}/BraveSoftware`, literal: false },
    { param: "FIREFOX_PROFILES", path: `${AS}/Firefox`, literal: false },
    { param: "EDGE_PROFILES", path: `${AS}/Microsoft Edge`, literal: false },
  ]);
});

test("sandboxParams: realpaths (/tmp -> /private/tmp), a missing path under its parent's realpath, no newline", () => {
  const params = (scope: SandboxScope, h = userHome) => {
    const a = sandboxParams(scope, h);
    const m = new Map<string, string>();
    for (let i = 0; i < a.length; i += 2) {
      assert.equal(a[i], "-D");
      const v = a[i + 1]!;
      m.set(v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1));
    }
    return m;
  };
  const realUser = realpathSync(userHome);
  const dev = params(devScope);
  assert.equal(dev.get("SLACKOFF_HOME"), realpathSync(home));
  assert.equal(dev.get("HOME_ALLOW"), realpathSync(join(home, "worktrees/K")));
  assert.equal(dev.get("HOME_ALLOW_UP_0"), realpathSync(home));
  assert.equal(dev.get("HOME_ALLOW_UP_1"), realpathSync(join(home, "worktrees")));
  assert.equal(dev.get("HOME_SSH"), join(realUser, ".ssh"));
  assert.equal(dev.get("HOME_AWS"), join(realUser, ".aws"), "missing ~/.aws: parent realpath + .aws");
  assert.equal(dev.get("CHROME_PROFILES"), join(realUser, "Library/Application Support/Google/Chrome"));
  assert.equal(params(installScope).has("HOME_NPMRC"), false);
  assert.equal(params(acceptScope).get("REPO_0"), realpathSync(repoDir));
  assert.equal(params(acceptScope).get("REPO_1"), join(realpathSync(join(root, "repos")), "web"));
  if (process.platform === "darwin") {
    const x = params({ ...acceptScope, home: "/tmp/slackoff-sbx-missing/x", repos: [] });
    assert.equal(x.get("SLACKOFF_HOME"), "/private/tmp/slackoff-sbx-missing/x");
  }
  assert.throws(() => sandboxParams({ ...acceptScope, repos: [join(root, "bad\nname")] }, userHome), SandboxUnavailableError);
  assert.throws(() => sandboxParams({ ...acceptScope, repos: [join(root, "bad\0name")] }, userHome), SandboxUnavailableError);
  assert.throws(() => sandboxParams({ ...acceptScope, repos: ["relative/path"] }, userHome), SandboxUnavailableError);
});

test("sandboxArgv: sandbox-exec -p <profile> <params> <file> <args>", () => {
  const a = sandboxArgv(devScope, "node", ["--test"]);
  assert.equal(a.file, SANDBOX_EXEC);
  assert.equal(a.args[0], "-p");
  assert.equal(a.args[1], sandboxProfile(devScope));
  assert.deepEqual(a.args.slice(2, -2), sandboxParams(devScope));
  assert.deepEqual(a.args.slice(-2), ["node", "--test"]);
});

// ---------------------------------------------------------------- real sandbox-exec runs

test("dev-command: Slack Off ports, credentials and the DB denied; the ticket's worktree and other ports allowed", { skip }, async () => {
  const other = await listen("127.0.0.1");
  try {
    const wtFile = join(home, "worktrees/K/api/a.txt");
    const r = await probe(devScope, {
      reads: [join(userHome, ".ssh/id"), join(userHome, ".npmrc"), join(home, "slackoff.db"), wtFile, home, join(home, "worktrees")],
      writes: [wtFile, join(home, "planted.txt")],
      conns: [["127.0.0.1", 4317], ["::1", 5173], ["localhost", 4317], ["127.0.0.1", other.port]],
    });
    assert.equal(r.get(`read ${join(userHome, ".ssh/id")}`), "EPERM");
    assert.equal(r.get(`read ${join(userHome, ".npmrc")}`), "EPERM");
    assert.equal(r.get(`read ${join(home, "slackoff.db")}`), "EPERM");
    assert.equal(r.get(`read ${wtFile}`), "OK", "the later allow overrides the SLACKOFF_HOME deny");
    assert.equal(r.get(`read ${home}`), "EPERM", "the parents' contents stay denied");
    assert.equal(r.get(`read ${join(home, "worktrees")}`), "EPERM");
    assert.equal(r.get(`write ${wtFile}`), "OK");
    assert.equal(r.get(`write ${join(home, "planted.txt")}`), "EPERM");
    assert.equal(existsSync(join(home, "planted.txt")), false);
    assert.equal(r.get("conn 127.0.0.1:4317"), "EPERM");
    assert.equal(r.get("conn ::1:5173"), "EPERM");
    assert.equal(r.get("conn localhost:4317"), "EPERM");
    assert.equal(r.get(`conn 127.0.0.1:${other.port}`), "OK");
  } finally {
    other.server.close();
  }
});

test("dev-install: ~/.npmrc readable (private registries); the DB and the ports still denied", { skip }, async () => {
  const r = await probe(installScope, {
    reads: [join(userHome, ".npmrc"), join(userHome, ".ssh/id"), join(home, "slackoff.db"), join(home, "worktrees/K/api/a.txt")],
    conns: [["127.0.0.1", 4317], ["127.0.0.1", 5173]],
  });
  assert.equal(r.get(`read ${join(userHome, ".npmrc")}`), "OK");
  assert.equal(r.get(`read ${join(userHome, ".ssh/id")}`), "EPERM");
  assert.equal(r.get(`read ${join(home, "slackoff.db")}`), "EPERM");
  assert.equal(r.get(`read ${join(home, "worktrees/K/api/a.txt")}`), "OK");
  assert.equal(r.get("conn 127.0.0.1:4317"), "EPERM");
  assert.equal(r.get("conn 127.0.0.1:5173"), "EPERM");
});

test("acceptance: worktrees and mapped repositories denied too", { skip }, async () => {
  const r = await probe(acceptScope, {
    reads: [join(home, "worktrees/K/api/a.txt"), join(repoDir, "server.mjs"), join(userHome, ".npmrc")],
    conns: [["127.0.0.1", 4317]],
  });
  assert.equal(r.get(`read ${join(home, "worktrees/K/api/a.txt")}`), "EPERM");
  assert.equal(r.get(`read ${join(repoDir, "server.mjs")}`), "EPERM");
  assert.equal(r.get(`read ${join(userHome, ".npmrc")}`), "EPERM");
  assert.equal(r.get("conn 127.0.0.1:4317"), "EPERM");
});

// ---------------------------------------------------------------- self-check

test("sandboxSelfCheck: ok inside the profile; not available off macOS", { skip }, async () => {
  const c = await sandboxSelfCheck(devScope);
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /4317:EPERM/);
  assert.match(c.detail, /5173:EPERM/);
  assert.match(c.detail, /file:EPERM/);
  assert.match(c.detail, /allowed:OK/);
  const a = await sandboxSelfCheck(acceptScope);
  assert.equal(a.ok, true, a.detail);
  // a fresh home without a database yet: the home directory itself is the denied target
  const fresh = join(root, "fresh-home");
  mkdirSync(join(fresh, "worktrees/K"), { recursive: true });
  const f = await sandboxSelfCheck({ ...devScope, home: fresh, allowInHome: join(fresh, "worktrees/K") });
  assert.equal(f.ok, true, f.detail);
});

test("sandboxSelfCheck: off macOS -> not available", async () => {
  const c = await sandboxSelfCheck(devScope, { platform: "linux" });
  assert.deepEqual(c, { ok: false, detail: "sandbox-exec is not available on linux" });
});

test("sandboxSelfCheck: fails when the allowed directory is missing (no silent pass)", { skip }, async () => {
  const c = await sandboxSelfCheck({ ...devScope, allowInHome: join(home, "worktrees/NOPE") });
  assert.equal(c.ok, false, c.detail);
});

test("selfcheck.mjs run directly (no sandbox) -> exit 1", async () => {
  const l = await listen("127.0.0.1");
  try {
    const r = await runProcess(process.execPath, [SELF_CHECK_SCRIPT, join(home, "slackoff.db"), String(l.port)], { timeoutMs: 15_000 });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`${l.port}:CONNECTED`));
    assert.match(r.stdout, /file:READABLE/);
  } finally {
    l.server.close();
  }
});

// ---------------------------------------------------------------- commandSandbox and runCommand

const failing = async () => ({ ok: false, detail: "sandbox-exec is not available on linux" });
const passing = async () => ({ ok: true, detail: "4317:EPERM 5173:EPERM file:EPERM allowed:OK" });

test("commandSandbox: ok -> sandboxed; failed + switch off -> refused naming the setting; switch on -> unsandboxed", async () => {
  const config = loadConfig(mkdtempSync(join(root, "cfg-")));
  assert.equal(config.development.allowUnsandboxedCommands, false);
  assert.deepEqual(await commandSandbox(config, devScope, passing), { kind: "sandboxed", scope: devScope });
  await assert.rejects(
    commandSandbox(config, devScope, failing),
    (e: unknown) =>
      e instanceof SandboxUnavailableError &&
      e.message.startsWith("sandbox-exec is not available on linux — repository commands are not run without the sandbox") &&
      e.message.includes('"Run repository commands without the sandbox"'),
  );
  config.development.allowUnsandboxedCommands = true;
  assert.deepEqual(await commandSandbox(config, devScope, failing), { kind: "unsandboxed", reason: "sandbox-exec is not available on linux" });
});

test("runCommand: sandboxed -> a probe connecting to 4317 gets EPERM; unsandboxed -> output says so", { skip }, async () => {
  const wt = join(home, "worktrees/K/api");
  writeFileSync(
    join(wt, "probe.js"),
    'const s = require("node:net").connect(4317, "127.0.0.1"); s.on("error", (e) => console.log("probe:" + e.code)); s.on("connect", () => { console.log("probe:CONNECTED"); s.destroy(); });',
  );
  const r = await runCommand(wt, "node probe.js", 20_000, { kind: "sandboxed", scope: devScope });
  assert.equal(r.command, "node probe.js");
  assert.match(r.outputTail, /probe:EPERM/);
  const u = await runCommand(wt, "node -v", 20_000, { kind: "unsandboxed", reason: "sandbox-exec is not available on linux" });
  assert.equal(u.exitCode, 0);
  assert.ok(u.outputTail.startsWith("[not sandboxed: sandbox-exec is not available on linux]\n"), u.outputTail);
  writeFileSync(join(wt, "env.js"), "process.stdout.write(process.env.FOO + process.env.GIT_DIR)");
  const e = await runCommand(wt, "node env.js", 20_000, null, { PATH: process.env.PATH, FOO: "f", GIT_DIR: "/x" });
  assert.equal(e.outputTail, "fundefined");
});

// ---------------------------------------------------------------- R-LOCAL-3 / T5-1: the dev agent's Bash prefix

// Claude Code runs every Bash command as `$CLAUDE_CODE_SHELL_PREFIX '<one shell command string>'` (real run, spike §6.4):
// the string sources the CLI's shell snapshot, then evals the command.
test("writeShellPrefix: every command string runs under the profile after a passing self-check; nothing else runs", { skip }, async () => {
  const dir = join(root, "prefix");
  const wrapper = writeShellPrefix(dir, devScope, { shell: "/bin/zsh", homeDir: userHome });
  assert.equal(wrapper, join(dir, "shell-prefix"));
  assert.equal(statSync(wrapper).mode & 0o777, 0o755);
  const text = readFileSync(wrapper, "utf8");
  assert.ok(text.includes(SANDBOX_EXEC) && text.includes(SELF_CHECK_SCRIPT), text);
  const wt = join(home, "worktrees/K/api");
  writeFileSync(
    join(wt, "nested.js"),
    `try { require("node:fs").readFileSync(${JSON.stringify(join(home, "slackoff.db"))}); console.log("nested:READ"); } catch (e) { console.log("nested:" + e.code); }`,
  );
  writeFileSync(
    join(wt, "probe.js"),
    'const { execFileSync } = require("node:child_process");\n' +
      'const s = require("node:net").connect(4317, "127.0.0.1");\n' +
      's.on("error", (e) => { console.log("probe:" + e.code); console.log(execFileSync("node", ["nested.js"], { encoding: "utf8" }).trim()); });\n',
  );
  const env = { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome };
  // the shape Claude Code sends: one string, with shell syntax (&&, eval, quotes)
  const r = await runProcess(wrapper, [`eval 'cd ${wt} && node probe.js' < /dev/null && pwd -P`], { env, timeoutMs: 30_000 });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /probe:EPERM/);
  assert.match(r.stdout, /nested:EPERM/, "children of the command stay inside the same sandbox");
  assert.ok(r.stdout.includes(realpathSync(wt)));
  // a path-like program is covered too (no PATH lookup involved)
  writeFileSync(join(wt, "run.sh"), "#!/bin/sh\ncat " + JSON.stringify(join(userHome, ".ssh/id")) + "\n", { mode: 0o755 });
  const p = await runProcess(wrapper, [`cd ${wt} && ./run.sh`], { env, timeoutMs: 30_000 });
  assert.notEqual(p.code, 0);
  assert.doesNotMatch(p.stdout, /PRIVATE-KEY/);
  // anything but exactly one command string is refused
  for (const args of [[], ["echo a", "echo b"]]) {
    const bad = await runProcess(wrapper, args, { env });
    assert.equal(bad.code, 126);
    assert.match(bad.stderr, /not run/);
  }
});

test("writeShellPrefix: a failing self-check refuses the command (fail closed)", { skip }, async () => {
  const h2 = join(root, "home-gone");
  mkdirSync(join(h2, "worktrees/K"), { recursive: true });
  const scope: SandboxScope = { kind: "dev-command", home: h2, allowInHome: join(h2, "worktrees/K"), repos: [] };
  const wrapper = writeShellPrefix(join(root, "prefix-gone"), scope, { shell: "/bin/zsh" });
  rmSync(join(h2, "worktrees/K"), { recursive: true });
  const marker = join(root, "prefix-ran");
  const r = await runProcess(wrapper, [`touch ${marker}`], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000 });
  assert.equal(r.code, 126);
  assert.match(r.stderr, /sandbox self-check failed/);
  assert.equal(existsSync(marker), false);
});

test("writeShellPrefix: only zsh or bash as the shell; rewritten from scratch", () => {
  assert.throws(() => writeShellPrefix(join(root, "prefix-x"), devScope, { shell: "/bin/sh" }), SandboxUnavailableError);
  assert.throws(() => writeShellPrefix(join(root, "prefix-x"), devScope, { shell: "zsh" }), SandboxUnavailableError);
  writeFileSync(join(root, "stale"), "x");
  const d = join(root, "prefix-y");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "old"), "x");
  writeShellPrefix(d, devScope, { shell: "/bin/bash" });
  assert.equal(existsSync(join(d, "old")), false);
  assert.ok(readFileSync(join(d, "shell-prefix"), "utf8").includes("'/bin/bash' -c"));
});

// ---------------------------------------------------------------- fix round 1 (security review)

const repoRoot = join(import.meta.dirname, "../../..");

/** A git repo with a linked worktree, both under the throwaway root: its common dir and the worktree's .git file. */
function gitWorktree(name: string): { common: string; wt: string } {
  const main = join(root, "git", name);
  mkdirSync(main, { recursive: true });
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { stdio: "ignore" });
  g(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "f.txt"), "f\n");
  g(main, "add", "-A");
  g(main, "commit", "-q", "-m", "init");
  const wt = join(home, "worktrees/K", name);
  g(main, "worktree", "add", "-q", "-b", `b-${name}`, wt);
  return { common: realpathSync(join(main, ".git")), wt };
}

test("profile: dev and install scopes are a write allowlist; git metadata and git config never writable", () => {
  for (const scope of [devScope, installScope]) {
    const p = sandboxProfile({ ...scope, gitProtect: ["/x/.git", "/y/.git"] });
    assert.ok(!p.includes("/x") && !p.includes("/y"));
    const denyAll = p.indexOf("(deny file-write*)\n");
    assert.ok(denyAll > 0, p);
    assert.ok(p.indexOf('(allow file-write* (subpath (param "WRITE_0"))') > denyAll, p);
    for (const name of ["TMP_0", "TICKET_CACHE", "DEV_NULL"]) assert.ok(p.includes(`(param "${name}")`), `${name}: ${p}`);
    const last = p.indexOf('(deny file-write* (subpath (param "GIT_0"))');
    assert.ok(last > p.indexOf('(param "WRITE_0")'), "git protection comes after every write allow");
    for (const name of ["GIT_0", "GIT_1", "HOME_GITCONFIG", "HOME_GITCONFIG_DIR"]) assert.ok(p.slice(last).includes(`(param "${name}")`), name);
    // T5-8: a single-operation rule beats file-write*, so the git deny is repeated for unlink, after the own-dir unlink allow
    const unlinkAllow = p.indexOf('(allow file-write-unlink (subpath (param "WRITE_0"))');
    assert.ok(unlinkAllow > 0 && p.indexOf('(deny file-write-unlink (subpath (param "GIT_0"))') > unlinkAllow, p);
  }
  assert.ok(sandboxProfile(acceptScope).includes("(deny file-write*)\n"), "T6-2: acceptance profiles are a write allowlist too");
  assert.throws(() => sandboxProfile({ ...devScope, writable: [join(root, "outside")] }), SandboxUnavailableError);
});

test("dev-command: an outside process cannot be signalled (SIGUSR1 → inspector escape); own children can", { skip }, async () => {
  // stands in for the unsandboxed Slack Off server: a node started WITHOUT --disable-sigusr1
  const { spawn } = await import("node:child_process");
  const target = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const code = `
      const out = [];
      for (const sig of ["SIGUSR1", 0]) { try { process.kill(${target.pid}, sig); out.push(sig + ":OK"); } catch (e) { out.push(sig + ":" + e.code); } }
      const c = require("node:child_process").spawn("sleep", ["5"]);
      try { c.kill("SIGTERM"); out.push("child:OK"); } catch (e) { out.push("child:" + e.code); }
      console.log(out.join(" "));`;
    const { file, args } = sandboxArgvFor(devScope, process.execPath, ["-e", code]);
    const r = await runProcess(file, args, { cwd: work, timeoutMs: 20_000 });
    assert.equal(r.stdout.trim(), "SIGUSR1:EPERM 0:EPERM child:OK", r.stderr);
    assert.equal(target.exitCode, null, "the target is still running, untouched");
  } finally {
    target.kill();
  }
});

test("dev-command: listening on Slack Off or inspector ports is denied; other ports work", { skip }, async () => {
  const code = `
    const net = require("node:net"); const out = []; let left = 4;
    const done = () => { if (--left === 0) console.log(out.join(" ")); };
    for (const port of [4317, 5173, 9229, 0]) {
      const s = net.createServer();
      s.on("error", (e) => { out.push((port || "free") + ":" + e.code); done(); });
      s.listen(port, "127.0.0.1", () => { out.push((port || "free") + ":OK"); s.close(); done(); });
    }`;
  const { file, args } = sandboxArgvFor(devScope, process.execPath, ["-e", code]);
  const r = await runProcess(file, args, { cwd: work, timeoutMs: 20_000 });
  const got = new Set(r.stdout.trim().split(" "));
  for (const want of ["4317:EPERM", "5173:EPERM", "9229:EPERM", "free:OK"]) assert.ok(got.has(want), `${want}: ${r.stdout} ${r.stderr}`);
});

test("dev-command: writes only to the repo's worktree, temp dirs and caches; git metadata, rc files and the checkout denied", { skip }, async () => {
  const api = gitWorktree("wapi");
  const web = gitWorktree("wweb");
  const scope: SandboxScope = { ...devScope, writable: [api.wt], gitProtect: [api.common, join(api.wt, ".git"), web.common, join(web.wt, ".git")] };
  // 4A-13: a scratch HOME outside the temp dirs, injected into the params (never the developer's own)
  const fakeHome = varTmpHome("rc");
  writeFileSync(join(fakeHome, ".zshrc"), "RC\n");
  const probeName = `.slackoff-sbx-probe-${process.pid}`;
  const checkout = join(repoRoot, "packages/server", probeName);
  const homeProbe = join(fakeHome, probeName);
  const code = `
    const fs = require("node:fs"); const out = [];
    const tryW = (label, f, how) => { try { const fd = fs.openSync(f, how); fs.closeSync(fd); out.push(label + ":OK"); } catch (e) { out.push(label + ":" + e.code); } };
    tryW("wt", ${JSON.stringify(join(api.wt, "new.txt"))}, "w");
    tryW("otherwt", ${JSON.stringify(join(web.wt, "new.txt"))}, "w");
    tryW("tmp", ${JSON.stringify(join(work, "t.txt"))}, "w");
    tryW("gitconfig", ${JSON.stringify(join(api.common, "config"))}, "r+");
    tryW("gitpointer", ${JSON.stringify(join(api.wt, ".git"))}, "r+");
    tryW("rc", ${JSON.stringify(join(fakeHome, ".zshrc"))}, "r+");
    tryW("homefile", ${JSON.stringify(homeProbe)}, "wx");
    tryW("checkout", ${JSON.stringify(checkout)}, "wx");
    tryW("devnull", "/dev/null", "w");
    console.log(out.join(" "));`;
  const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code], fakeHome);
  try {
    const r = await runProcess(file, args, { cwd: work, timeoutMs: 20_000, env: { PATH: process.env.PATH, HOME: fakeHome } });
    const got = new Map(r.stdout.trim().split(" ").map((x) => x.split(":") as [string, string]));
    assert.equal(got.get("wt"), "OK", r.stdout + r.stderr);
    assert.equal(got.get("tmp"), "OK");
    assert.equal(got.get("devnull"), "OK");
    assert.equal(got.get("otherwt"), "EPERM", "only this repo's worktree");
    assert.equal(got.get("gitconfig"), "EPERM", "the git common dir is protected even under an allowed temp dir");
    assert.equal(got.get("gitpointer"), "EPERM");
    assert.equal(got.get("rc"), "EPERM");
    assert.equal(readFileSync(join(fakeHome, ".zshrc"), "utf8"), "RC\n");
    assert.equal(got.get("homefile"), "EPERM");
    assert.equal(existsSync(homeProbe), false);
    assert.equal(got.get("checkout"), "EPERM");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(checkout, { force: true });
  }
});

test("sandboxSelfCheck: also proves signals out are denied and the inspector ports are closed", { skip }, async () => {
  const c = await sandboxSelfCheck(devScope);
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /9229:EPERM/);
  assert.match(c.detail, /signal:EPERM/);
});

test("every platform Node process starts with --disable-sigusr1 (root scripts, e2e web server)", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const name of ["start", "dev:server"]) assert.match(pkg.scripts[name]!, /node --disable-sigusr1 packages\/server\/src\/main\.ts/, name);
  assert.match(readFileSync(join(repoRoot, "playwright.config.ts"), "utf8"), /command: "node --disable-sigusr1 packages\/server\/src\/main\.ts"/);
  const r = execFileSync(process.execPath, ["--disable-sigusr1", "-e", "console.log('ok')"], { encoding: "utf8" });
  assert.equal(r.trim(), "ok");
});

// ---------------------------------------------------------------- fix round 2 (re-review, ruling T5-4)

const ALL_SCOPES: SandboxScope[] = [devScope, installScope, acceptScope, { ...acceptScope, kind: "acceptance-install" }];

test("profile T5-4: LaunchServices, Apple events and the pasteboard unreachable from every scope; agent sockets denied", () => {
  for (const scope of ALL_SCOPES) {
    const p = sandboxProfile(scope);
    assert.ok(!p.includes("/"), p);
    assert.ok(
      p.includes('(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name-prefix "com.apple.lsd.") (global-name "com.apple.launchservicesd") (global-name "com.apple.pasteboard.1"))'),
      p,
    );
    assert.ok(p.includes("(deny appleevent-send)"), p);
    assert.ok(p.includes('(deny network-outbound (remote unix-socket (subpath (param "AGENT_SOCK_DIR"))) (remote unix-socket (subpath (param "HOME_GNUPG_SOCKETS"))))'), p);
  }
  const dev = sandboxProfile(devScope);
  // no global package cache is writable any more; the ticket's own cache is
  const params = sandboxParams(devScope, userHome).filter((_, i, a) => i % 2 === 1);
  assert.ok(!params.some((v) => v.startsWith("CACHE_")), params.join("\n"));
  assert.ok(!params.some((v) => /^TMP_\d=.*\/C$/.test(v)), "the per-user C dir is not writable");
  assert.ok(params.includes(`TICKET_CACHE=${join(realpathSync(home), "cache", "K")}`), params.join("\n"));
  const lastAllow = dev.lastIndexOf("(allow file-write* ");
  const xcrun = dev.indexOf('(param "XCRUN_DB_0")');
  assert.ok(xcrun > lastAllow, "the xcrun cache is denied after every write allow");
  // T5-5: the claude-* deny comes before the platform's own allows (worktree, ticket cache); git and xcrun denies stay last
  // T7-9: reads denied there too
  const claude = dev.indexOf('(deny file-read* file-write* (prefix (param "CLAUDE_TMP")))');
  assert.ok(
    claude > 0 && claude < dev.indexOf('(allow file-write* (subpath (param "WRITE_0"))') && claude < dev.indexOf('(allow file-read* file-write* (subpath (param "TICKET_CACHE"))'),
    dev,
  );
  assert.ok(dev.indexOf('(param "GIT_') === -1 || dev.indexOf('(param "GIT_') > dev.indexOf('(param "TICKET_CACHE")'));
  assert.ok(params.includes("CLAUDE_TMP=/private/tmp/claude-") || process.platform !== "darwin", params.join("\n"));
});

test("sandboxEnv: agent sockets removed; package-manager caches point into the ticket's cache dir", () => {
  const base = { PATH: "/bin", HOME: "/h", SSH_AUTH_SOCK: "/s", SSH_AGENT_PID: "1", GPG_AGENT_INFO: "/g", GNUPGHOME: "/gh", FOO: "1" };
  const env = sandboxEnv(devScope, base);
  for (const k of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GPG_AGENT_INFO", "GNUPGHOME"]) assert.equal(env[k], undefined, k);
  assert.equal(env.FOO, "1");
  const c = ticketCacheDir(devScope);
  assert.equal(c, join(home, "cache", "K"));
  assert.deepEqual(
    Object.fromEntries(Object.entries(env).filter(([k]) => k !== "PATH" && k !== "HOME" && k !== "FOO")),
    {
      npm_config_cache: join(c, "npm"),
      pnpm_config_store_dir: join(c, "pnpm-store"),
      XDG_CACHE_HOME: join(c, "xdg"),
      COREPACK_HOME: join(c, "corepack"),
      PLAYWRIGHT_BROWSERS_PATH: join(c, "ms-playwright"),
      YARN_CACHE_FOLDER: join(c, "yarn"),
      BUN_INSTALL_CACHE_DIR: join(c, "bun"),
      TMPDIR: join(c, "tmp"),
      TMP: join(c, "tmp"),
      TEMP: join(c, "tmp"),
    },
  );
  assert.ok(statSync(join(c, "tmp")).isDirectory(), "the ticket's temp dir is created before the run");
  const acc = sandboxEnv(acceptScope, base);
  const rc = join(acceptRun, "cache");
  assert.deepEqual(
    acc,
    {
      PATH: "/bin", HOME: "/h", FOO: "1",
      npm_config_cache: join(rc, "npm"), pnpm_config_store_dir: join(rc, "pnpm-store"), XDG_CACHE_HOME: join(rc, "xdg"), COREPACK_HOME: join(rc, "corepack"),
      YARN_CACHE_FOLDER: join(rc, "yarn"), BUN_INSTALL_CACHE_DIR: join(rc, "bun"),
      TMPDIR: join(acceptRun, "tmp"), TMP: join(acceptRun, "tmp"), TEMP: join(acceptRun, "tmp"),
    },
    "acceptance (T6-2): agent sockets removed, per-run caches (not the browsers: Playwright's own install stays readable), the run's TMPDIR",
  );
});

test("dev-command T5-4: LaunchServices cannot open a scratch app (no marker); node, git, npm and pnpm still run", { skip }, async () => {
  const app = join(root, `SlackOffSbxProbe${process.pid}.app`);
  const marker = join(root, "app-ran");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/probe"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  writeFileSync(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string>` +
      `<key>CFBundleIdentifier</key><string>dev.slackoff.sbxprobe.p${process.pid}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`,
  );
  const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
  for (const scope of [devScope, acceptScope]) {
    const { file, args } = sandboxArgvFor(scope, "/usr/bin/open", ["-g", "-j", app]);
    const r = await runProcess(file, args, { cwd: work, timeoutMs: 20_000 });
    await new Promise((res) => setTimeout(res, 1500));
    const escaped = r.code === 0 || existsSync(marker);
    if (escaped) execFileSync(lsregister, ["-u", app], { stdio: "ignore" }); // never leave the scratch bundle registered
    assert.equal(escaped, false, `${scope.kind}: open must fail under the sandbox: ${r.code} ${r.stderr}`);
  }
  const tools = await runProcess(
    "/usr/bin/sandbox-exec",
    sandboxArgvFor(devScope, "/bin/sh", ["-c", "node -e 'console.log(1)' && git --version && npm --version && pnpm --version"]).args,
    { cwd: join(home, "worktrees/K/api"), timeoutMs: 60_000, env: { ...process.env } },
  );
  assert.equal(tools.code, 0, tools.stdout + tools.stderr);
  assert.match(tools.stdout, /git version/);
});

test("dev-command T5-4: xcrun's cache, global package caches and other Claude sessions' /tmp dirs are not writable; the ticket cache is", { skip }, async () => {
  // 4A-13: a scratch HOME with its own ~/.npm (never the developer's cache)
  const fakeHome = varTmpHome("npm");
  mkdirSync(join(fakeHome, ".npm"));
  // phase 4a Task 7: the scope's TMPDIR is a scratch dir outside the temp dirs, so the probe never touches the real
  // $TMPDIR/xcrun_db; the scratch dir is one of the scope's writable temp dirs (tmpfile:OK), so only the explicit
  // xcrun_db deny can refuse it
  const scratchTmp = varTmpHome("tmpdir");
  const savedTmp = process.env.TMPDIR;
  const probes = {
    xcrun: [join(scratchTmp, "xcrun_db"), "wx"],
    tmpfile: [join(scratchTmp, "plain.txt"), "wx"],
    npm: [join(fakeHome, ".npm", `_slackoff-probe-${process.pid}`), "wx"],
    claude: [`/private/tmp/claude-sbx-probe-${process.pid}`, "wx"],
    ticketcache: [join(ticketCacheDir(devScope), "probe.txt"), "w"],
  } as const;
  mkdirSync(ticketCacheDir(devScope), { recursive: true });
  const code = `
    const fs = require("node:fs"); const out = [];
    for (const [label, [f, how]] of Object.entries(${JSON.stringify(probes)})) {
      try { fs.closeSync(fs.openSync(f, how)); out.push(label + ":OK"); } catch (e) { out.push(label + ":" + e.code); }
    }
    console.log(out.join(" "));`;
  const created = (label: keyof typeof probes) => probes[label][1] === "wx" && existsSync(probes[label][0]);
  try {
    process.env.TMPDIR = scratchTmp;
    let argv;
    try {
      argv = sandboxArgvFor(devScope, process.execPath, ["-e", code], fakeHome);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
    assert.ok(argv.args.includes(`XCRUN_DB_1=${join(scratchTmp, "xcrun_db")}`), argv.args.join(" "));
    const r = await runProcess(argv.file, argv.args, { cwd: work, timeoutMs: 20_000, env: { PATH: process.env.PATH, HOME: fakeHome } });
    const got = new Map(r.stdout.trim().split(" ").map((x) => x.split(":") as [string, string]));
    assert.equal(got.get("tmpfile"), "OK", r.stdout + r.stderr);
    assert.equal(got.get("xcrun"), "EPERM", r.stdout + r.stderr);
    assert.equal(created("xcrun"), false);
    assert.ok(got.get("npm") === "EPERM" && !created("npm"), `npm: ${got.get("npm")}`);
    assert.equal(got.get("claude"), "EPERM");
    assert.equal(got.get("ticketcache"), "OK");
  } finally {
    for (const label of ["npm", "claude", "xcrun"] as const) if (created(label)) rmSync(probes[label][0], { force: true });
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratchTmp, { recursive: true, force: true });
  }
});

test("dev-command T5-4: unix sockets of the ssh agent's dir and ~/.gnupg are unreachable; others work; agent env removed", { skip }, async () => {
  const sockRoot = realpathSync(mkdtempSync(join(tmpdir(), "sbs-")));
  mkdirSync(join(sockRoot, "agent"));
  mkdirSync(join(sockRoot, "other"));
  mkdirSync(join(userHome, ".gnupg"), { recursive: true });
  // T5-7: a socket in a temp dir is refused too; "other" is the command's own, in its worktree
  const paths = { agent: join(sockRoot, "agent", "s"), tmp: join(sockRoot, "other", "s"), other: join(home, "worktrees/K/api", "o"), gpg: join(userHome, ".gnupg", "S.gpg-agent") };
  const servers = await Promise.all(
    Object.values(paths).map((p) => new Promise<Server>((res) => { const sv = createServer((c) => c.end()); sv.listen(p, () => res(sv)); })),
  );
  const saved = process.env.SSH_AUTH_SOCK;
  process.env.SSH_AUTH_SOCK = paths.agent;
  try {
    const code = `
      const net = require("node:net"); const out = []; const all = ${JSON.stringify(paths)}; let left = 4;
      for (const [k, p] of Object.entries(all)) {
        const s = net.connect(p);
        s.on("connect", () => { out.push(k + ":OK"); s.destroy(); if (--left === 0) fin(); });
        s.on("error", (e) => { out.push(k + ":" + e.code); if (--left === 0) fin(); });
      }
      function fin() { console.log(out.sort().join(" ") + " env:" + (process.env.SSH_AUTH_SOCK ?? "none")); }`;
    writeFileSync(join(home, "worktrees/K/api/sock.js"), code);
    const { file, args } = sandboxArgvFor(devScope, process.execPath, ["sock.js"]);
    const r = await runProcess(file, args, { cwd: join(home, "worktrees/K/api"), timeoutMs: 20_000, env: sandboxEnv(devScope, process.env) });
    assert.equal(r.stdout.trim(), "agent:EPERM gpg:EPERM other:OK tmp:EPERM env:none", r.stderr);
    // runCommand applies the same env when sandboxed
    const rc = await runCommand(join(home, "worktrees/K/api"), "node sock.js", 20_000, { kind: "sandboxed", scope: devScope });
    assert.match(rc.outputTail, /agent:EPERM .* env:none/);
  } finally {
    if (saved === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = saved;
    await Promise.all(servers.map((sv) => new Promise((res) => sv.close(res))));
    rmSync(sockRoot, { recursive: true, force: true });
  }
});

test("sandboxSelfCheck T5-4: LaunchServices must be unreachable", { skip }, async () => {
  const c = await sandboxSelfCheck(devScope);
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /launchservices:DENIED/);
});

test("writeShellPrefix T5-4: the wrapper removes agent sockets from the env and points caches at the ticket cache", { skip }, async () => {
  const wrapper = writeShellPrefix(join(root, "prefix-env"), devScope, { shell: "/bin/zsh", homeDir: userHome });
  rmSync(ticketTmpDir(devScope), { recursive: true, force: true }); // the wrapper recreates it before every command
  const r = await runProcess(wrapper, ["echo SSH=${SSH_AUTH_SOCK:-none} GPG=${GNUPGHOME:-none} NPM=$npm_config_cache T=$TMPDIR:$TMP:$TEMP; test -d $TMPDIR && echo dir"], {
    env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome, SSH_AUTH_SOCK: "/x/s", GNUPGHOME: "/x/g" },
    timeoutMs: 30_000,
  });
  const t = ticketTmpDir(devScope);
  assert.equal(r.stdout.trim(), `SSH=none GPG=none NPM=${join(ticketCacheDir(devScope), "npm")} T=${t}:${t}:${t}\ndir`, r.stderr);
});

// ---------------------------------------------------------------- ruling T5-5

test("T5-5: a SLACKOFF_HOME under /private/tmp/claude-* keeps its worktree and ticket cache writable; the rest of that root stays denied", { skip }, async () => {
  const probeRoot = `/private/tmp/claude-sbxprobe-${process.pid}`;
  const h = join(probeRoot, "home");
  const wt = join(h, "worktrees/K/api");
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(probeRoot, "sibling"), { recursive: true });
  writeFileSync(join(h, "slackoff.db"), "DB\n");
  const scope: SandboxScope = { kind: "dev-install", home: h, allowInHome: join(h, "worktrees/K"), repos: [], writable: [wt] };
  try {
    const check = await sandboxSelfCheck(scope);
    assert.equal(check.ok, true, check.detail);
    writeFileSync(
      join(wt, "install.js"),
      'const fs = require("node:fs"); const out = [];\n' +
        'const w = (k, f) => { try { fs.mkdirSync(require("node:path").dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); out.push(k + ":OK"); } catch (e) { out.push(k + ":" + e.code); } };\n' +
        'w("worktree", "node_modules/dep/index.js");\n' +
        'w("cache", process.env.npm_config_cache + "/x");\n' +
        `w("sibling", ${JSON.stringify(join(probeRoot, "sibling", "x"))});\n` +
        `w("otherclaude", ${JSON.stringify(join(probeRoot, "planted.txt"))});\n` +
        `w("home", ${JSON.stringify(join(h, "planted.txt"))});\n` +
        // T5-8: rename and unlink inside the platform's own dirs still work under /private/tmp (unlink denied there)
        'const m = (k, f) => { try { fs.renameSync(f, f + ".mv"); fs.rmSync(f + ".mv"); out.push(k + ":OK"); } catch (e) { out.push(k + ":" + e.code); } };\n' +
        'm("wtmv", "node_modules/dep/index.js"); m("cachemv", process.env.npm_config_cache + "/x");\n' +
        'console.log(out.join(" "));\n',
    );
    const r = await runCommand(wt, "node install.js", 20_000, { kind: "sandboxed", scope });
    assert.equal(r.exitCode, 0, r.outputTail);
    assert.equal(r.outputTail.trim(), "worktree:OK cache:OK sibling:EPERM otherclaude:EPERM home:EPERM wtmv:OK cachemv:OK");
    writeFileSync(join(wt, "t.test.js"), 'require("node:test")("ok", () => {});\n');
    const t = await runCommand(wt, "node --test", 30_000, { kind: "sandboxed", scope: { ...scope, kind: "dev-command" } });
    assert.equal(t.exitCode, 0, t.outputTail);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- fix round 3 (ruling T5-6)

test("profile T5-6: unix sockets denied by default in every scope; DNS and the ticket's own dirs allowed; daemon dirs denied", () => {
  for (const scope of ALL_SCOPES) {
    const p = sandboxProfile(scope);
    assert.ok(!p.includes("/"), p);
    const denyAll = p.indexOf("(deny network-outbound (remote unix-socket))");
    assert.ok(denyAll > 0, p);
    const allow = p.indexOf("(allow network-outbound (remote unix-socket ", denyAll);
    assert.ok(allow > denyAll && p.slice(allow).includes('(literal (param "MDNS_SOCKET"))'), p);
    // T5-7: the temp dirs are no longer in the socket allow (local daemons listen there)
    assert.ok(!/\(remote unix-socket \(subpath \(param "TMP_\d"\)\)\)/.test(p), p);
    const daemons = p.indexOf('(remote unix-socket (prefix (param "TMUX_TMP")))');
    assert.ok(daemons > allow, p);
    for (const n of ["CLAUDE_TMP", "LAUNCHD_TMP"]) assert.ok(p.includes(`(remote unix-socket (prefix (param "${n}")))`), n);
    for (const n of ["GROUP_CONTAINERS", "HOME_DOCKER", "AGENT_SOCK_DIR", "HOME_GNUPG_SOCKETS"]) assert.ok(p.includes(`(remote unix-socket (subpath (param "${n}")))`), n);
  }
  const dev = sandboxProfile(devScope);
  // the ticket's own dirs are re-allowed after the daemon denies (a SLACKOFF_HOME under /private/tmp/claude-*)
  const reallow = dev.lastIndexOf("(allow network-outbound (remote unix-socket ");
  assert.ok(reallow > dev.indexOf('(prefix (param "CLAUDE_TMP")))') && dev.slice(reallow).includes('(param "TICKET_CACHE")'), dev);
  assert.ok(dev.indexOf('(subpath (param "AGENT_SOCK_DIR")))') > reallow, "the agent sockets stay denied last");
  const params = sandboxParams(devScope, userHome).filter((_, i) => i % 2 === 1);
  for (const want of ["MDNS_SOCKET=/private/var/run/mDNSResponder", "TMUX_TMP=/private/tmp/tmux-", "LAUNCHD_TMP=/private/tmp/com.apple.launchd.", `HOME_DOCKER=${join(realpathSync(userHome), ".docker")}`]) {
    assert.ok(params.includes(want), `${want}\n${params.join("\n")}`);
  }
});

test("profile T5-6: Docker, agent-gateway and JetBrains ports plus development.deniedLocalPorts denied (connect and listen)", () => {
  assert.deepEqual([...DENIED_PORTS], [4317, 5173, 9229, 9230, 2375, 2376, 18789, 18790, 18791, 18792, 63342, 9222]);
  const p = sandboxProfile({ ...devScope, extraPorts: [9999] });
  for (const port of [2375, 2376, 18789, 18792, 63342, 9999]) {
    assert.ok(p.includes(`(remote tcp "*:${port}")`) && p.includes(`(local tcp "*:${port}")`), `${port}`);
  }
  assert.throws(() => sandboxProfile({ ...devScope, extraPorts: [0] }), SandboxUnavailableError);
});

/** A scratch tmux server on a socket outside every allowed dir (/private/tmp/tmux-* is denied). */
function scratchTmux(): { sock: string; stop: () => void } | null {
  let tmux: string;
  try {
    tmux = execFileSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8", env: { PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } }).trim();
  } catch {
    return null;
  }
  const dir = `/private/tmp/tmux-sbxprobe-${process.pid}`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sock = join(dir, "s");
  execFileSync(tmux, ["-S", sock, "-f", "/dev/null", "new-session", "-d", "-s", "probe", "sleep 60"], { stdio: "ignore" });
  return {
    sock,
    stop: () => {
      try {
        execFileSync(tmux, ["-S", sock, "kill-server"], { stdio: "ignore" });
      } catch {
        // already gone
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("dev-command T5-6: a scratch tmux server and a scratch Docker-style socket are unreachable; a socket in the worktree works", { skip }, async () => {
  // a short fake home: unix socket paths are limited to 104 bytes
  const shortHome = realpathSync(mkdtempSync(join(tmpdir(), "u")));
  const marker = join(root, "tmux-ran");
  const docker = join(shortHome, ".docker", "d.sock");
  const group = join(shortHome, "Library/Group Containers", "g.sock");
  mkdirSync(dirname(docker), { recursive: true });
  mkdirSync(dirname(group), { recursive: true });
  const servers: Server[] = [];
  let tmux: ReturnType<typeof scratchTmux> = null;
  try {
    for (const p of [docker, group]) {
      servers.push(await new Promise<Server>((res, rej) => { const sv = createServer((c) => c.end()); sv.once("error", rej); sv.listen(p, () => res(sv)); }));
    }
    tmux = scratchTmux();
    const wt = join(home, "worktrees/K/api");
    writeFileSync(
      join(wt, "socks.js"),
      `const net = require("node:net"); const out = []; let left = 3;
       const done = () => { if (--left === 0) { console.log(out.sort().join(" ")); process.exit(0); } };
       for (const [k, p] of [["docker", ${JSON.stringify(docker)}], ["group", ${JSON.stringify(group)}]]) {
         const s = net.connect(p); s.on("connect", () => { out.push(k + ":OK"); s.destroy(); done(); }); s.on("error", (e) => { out.push(k + ":" + e.code); done(); });
       }
       const own = net.createServer((c) => c.end()).listen("own.sock", () => {
         const s = net.connect("own.sock"); s.on("connect", () => { out.push("own:OK"); s.destroy(); own.close(); done(); }); s.on("error", (e) => { out.push("own:" + e.code); own.close(); done(); });
       });`,
    );
    const { file, args } = sandboxArgvFor(devScope, process.execPath, ["socks.js"], shortHome);
    const r = await runProcess(file, args, { cwd: wt, timeoutMs: 20_000, env: sandboxEnv(devScope, process.env) });
    assert.equal(r.stdout.trim(), "docker:EPERM group:EPERM own:OK", r.stderr);
    if (tmux === null) {
      console.log("# tmux not installed: tmux probe skipped");
    } else {
      const t = sandboxArgvFor(devScope, "/bin/sh", ["-c", `tmux -S ${tmux.sock} new-window "touch ${marker}"`]);
      const tr = await runProcess(t.file, t.args, { cwd: wt, timeoutMs: 20_000, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } });
      await new Promise((res) => setTimeout(res, 500));
      assert.notEqual(tr.code, 0, tr.stdout + tr.stderr);
      assert.equal(existsSync(marker), false, "the tmux server never ran the command");
    }
    const tools = sandboxArgvFor(devScope, "/bin/sh", ["-c", "git --version && npm --version && pnpm --version && node --test socks-none.test.js"]);
    writeFileSync(join(wt, "socks-none.test.js"), 'require("node:test")("ok", () => {});\n');
    const tl = await runProcess(tools.file, tools.args, { cwd: wt, timeoutMs: 60_000, env: sandboxEnv(devScope, process.env) });
    assert.equal(tl.code, 0, tl.stdout + tl.stderr);
  } finally {
    tmux?.stop();
    for (const sv of servers) sv.close();
    rmSync(shortHome, { recursive: true, force: true });
  }
});

test("dev-command T5-6: Docker / agent-gateway / JetBrains ports and a configured extra port refuse connections and listening", { skip }, async () => {
  const extra = await listen("127.0.0.1");
  const groups = [2375, 18789, 63342];
  const scratch: Server[] = [];
  const probed: number[] = [extra.port];
  for (const port of groups) {
    // a scratch listener on the port proves the connection would otherwise succeed; a port already in use (a real
    // daemon) is not probed at all
    const sv = await new Promise<Server | null>((res) => {
      const s = createServer((c) => c.end());
      s.once("error", () => res(null));
      s.listen(port, "127.0.0.1", () => res(s));
    });
    if (sv === null) {
      console.log(`# port ${port} in use on this machine: not probed`);
      continue;
    }
    scratch.push(sv);
    probed.push(port);
  }
  try {
    const scope: SandboxScope = { ...devScope, extraPorts: [extra.port] };
    const code = `
      const net = require("node:net"); const out = []; const ports = ${JSON.stringify(probed)}; let left = ports.length;
      for (const port of ports) {
        const s = net.connect(port, "127.0.0.1");
        s.on("connect", () => { out.push(port + ":OK"); s.destroy(); if (--left === 0) console.log(out.join(" ")); });
        s.on("error", (e) => { out.push(port + ":" + e.code); if (--left === 0) console.log(out.join(" ")); });
      }`;
    const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code]);
    const r = await runProcess(file, args, { cwd: work, timeoutMs: 20_000 });
    for (const port of probed) assert.ok(r.stdout.includes(`${port}:EPERM`), `${port}: ${r.stdout} ${r.stderr}`);
  } finally {
    extra.server.close();
    for (const sv of scratch) sv.close();
  }
});

test("dev-install T5-6: pnpm's store is the ticket cache; nothing lands in /private/tmp/.pnpm-store", { skip }, async () => {
  const before = existsSync("/private/tmp/.pnpm-store");
  const env = sandboxEnv(installScope, process.env);
  assert.equal(env.pnpm_config_store_dir, join(ticketCacheDir(installScope), "pnpm-store"));
  assert.equal(env.npm_config_store_dir, undefined, "npm warns about it; pnpm reads pnpm_config_store_dir");
  const { file, args } = sandboxArgvFor(installScope, "pnpm", ["store", "path"]);
  const r = await runProcess(file, args, { cwd: join(home, "worktrees/K/api"), timeoutMs: 30_000, env });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.trim().startsWith(join(realpathSync(home), "cache", "K")) || r.stdout.trim().startsWith(join(home, "cache", "K")), r.stdout);
  assert.equal(existsSync("/private/tmp/.pnpm-store"), before);
});

test("sandboxSelfCheck T5-6: a unix socket outside the allowed dirs must be refused; LaunchServices exactly [ NULL ]", { skip }, async () => {
  const c = await sandboxSelfCheck({ ...devScope, extraPorts: [9999] });
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /unix:EPERM/);
  assert.match(c.detail, /9999:EPERM/);
  assert.match(c.detail, /63342:EPERM/);
  assert.match(c.detail, /launchservices:DENIED/);
  const src = readFileSync(SELF_CHECK_SCRIPT, "utf8");
  assert.ok(src.includes('out.trim() === "[ NULL ]"'), "LaunchServices passes only on exactly [ NULL ]");
});

// ---------------------------------------------------------------- fix round 4 (ruling T5-7)

/** Every param named in the profile's unix-socket allow rules. */
function socketAllowParams(p: string): Set<string> {
  const out = new Set<string>();
  for (const line of p.split("\n").filter((l) => l.startsWith("(allow network-outbound (remote unix-socket "))) {
    for (const m of line.matchAll(/\(param "([A-Z_0-9]+)"\)/g)) out.add(m[1]!);
  }
  return out;
}

test("profile T5-7: the unix-socket allow is only mDNSResponder, the repo worktree(s) and the ticket cache; never a temp dir", () => {
  for (const scope of ALL_SCOPES) {
    // T6-1: an acceptance run's own tmp dir
    const want = scope.kind.startsWith("dev-") ? ["MDNS_SOCKET", "TICKET_CACHE", "WRITE_0"] : ["MDNS_SOCKET", "RUN_TMP"];
    assert.deepEqual([...socketAllowParams(sandboxProfile(scope))].sort(), want, scope.kind);
  }
  const two = sandboxProfile({ ...devScope, writable: [join(home, "worktrees/K/api"), join(home, "worktrees/K/web")] });
  assert.deepEqual([...socketAllowParams(two)].sort(), ["MDNS_SOCKET", "TICKET_CACHE", "WRITE_0", "WRITE_1"]);
  // temp dirs stay writable for files (dev), only socket connects changed
  assert.ok(sandboxProfile(devScope).includes('(allow file-write* (subpath (param "TMP_0"))'));
});

test("ticketTmpDir T5-7: <home>/cache/<KEY>/tmp, short enough for a socket in it under the default home (sun_path ≤ 104 bytes)", () => {
  assert.equal(ticketTmpDir(devScope), join(home, "cache", "K", "tmp"));
  assert.throws(() => ticketTmpDir(acceptScope), SandboxUnavailableError);
  const dflt: SandboxScope = { kind: "dev-command", home: join(homedir(), ".slackoff"), allowInHome: join(homedir(), ".slackoff", "worktrees", "PROJ-12345"), repos: [] };
  const t = ticketTmpDir(dflt);
  // typical socket names: tsx's IPC pipe, a VS Code-style IPC socket, a Chromium singleton dir
  for (const name of ["tsx-501/12345.pipe", "vscode-ipc-0b8f1c2e-4d5a-4e6f-8a9b-0c1d2e3f4a5b.sock", ".org.chromium.Chromium.AbCdEf/SingletonSocket"]) {
    const p = join(t, name);
    assert.ok(Buffer.byteLength(p) < 104, `${p}: ${Buffer.byteLength(p)} bytes`);
  }
});

/** A scratch daemon: a unix-socket server in a new scratch dir under `parent`; `stop` closes it and removes the dir. */
async function scratchDaemon(parent: string): Promise<{ sock: string; stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(parent, "t57-"));
  const sock = join(dir, "d.sock");
  try {
    const sv = await new Promise<Server>((res, rej) => {
      const s = createServer((c) => c.end("daemon\n"));
      s.once("error", rej);
      s.listen(sock, () => res(s));
    });
    return { sock, stop: () => new Promise<void>((res) => sv.close(() => { rmSync(dir, { recursive: true, force: true }); res(); })) };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

const CONNECT_ALL = `
  const net = require("node:net"); const socks = JSON.parse(process.argv[1]); const out = []; let left = socks.length;
  for (const [k, p] of socks) {
    const s = net.connect(p);
    s.setTimeout(3000, () => { out.push(k + ":TIMEOUT"); s.destroy(); if (--left === 0) console.log(out.sort().join(" ")); });
    s.on("connect", () => { out.push(k + ":OK"); s.destroy(); if (--left === 0) console.log(out.sort().join(" ")); });
    s.on("error", (e) => { out.push(k + ":" + e.code); if (--left === 0) console.log(out.sort().join(" ")); });
  }`;

test("T5-7: a scratch daemon socket under /private/tmp and under the real $TMPDIR is refused from every profile kind", { skip }, async () => {
  const daemons: Array<Awaited<ReturnType<typeof scratchDaemon>>> = [];
  try {
    daemons.push(await scratchDaemon("/private/tmp"));
    daemons.push(await scratchDaemon(realpathSync(tmpdir())));
    const socks = [["privtmp", daemons[0]!.sock], ["tmpdir", daemons[1]!.sock]];
    // control: outside the sandbox both daemons accept the connection
    const ctl = await runProcess(process.execPath, ["-e", CONNECT_ALL, JSON.stringify(socks)], { timeoutMs: 20_000 });
    assert.equal(ctl.stdout.trim(), "privtmp:OK tmpdir:OK", ctl.stderr);
    for (const scope of ALL_SCOPES) {
      const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", CONNECT_ALL, JSON.stringify(socks)]);
      const r = await runProcess(file, args, { cwd: work, timeoutMs: 20_000, env: sandboxEnv(scope, process.env) });
      assert.equal(r.stdout.trim(), "privtmp:EPERM tmpdir:EPERM", `${scope.kind}: ${r.stdout} ${r.stderr}`);
    }
  } finally {
    for (const d of daemons) await d.stop();
  }
});

test("T5-7: sockets in the command's own TMPDIR and worktree work; DNS, git status, offline npm/pnpm installs and node --test still run", { skip }, async () => {
  const g = gitWorktree("t57");
  for (const kind of ["dev-command", "dev-install"] as const) {
    const scope: SandboxScope = { ...devScope, kind, writable: [g.wt], gitProtect: [g.common, join(g.wt, ".git")] };
    const env: NodeJS.ProcessEnv = { ...sandboxEnv(scope, process.env), HOME: userHome };
    assert.equal(env.TMPDIR, ticketTmpDir(scope));
    writeFileSync(
      join(g.wt, "own.js"),
      `const net = require("node:net"); const os = require("node:os"); const path = require("node:path"); const out = []; let left = 2;
       const done = () => { if (--left === 0) { console.log(out.sort().join(" ")); process.exit(0); } };
       for (const [k, p] of [["tmpdir", path.join(os.tmpdir(), "o.sock")], ["worktree", "w.sock"]]) {
         const sv = net.createServer((c) => c.end()).listen(p, () => {
           const s = net.connect(p); s.on("connect", () => { out.push(k + ":OK"); s.destroy(); sv.close(); done(); }); s.on("error", (e) => { out.push(k + ":" + e.code); sv.close(); done(); });
         });
         sv.on("error", (e) => { out.push(k + ":LISTEN_" + e.code); done(); });
       }`,
    );
    const own = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["own.js"])), { cwd: g.wt, timeoutMs: 20_000, env });
    assert.equal(own.stdout.trim(), "tmpdir:OK worktree:OK", `${kind}: ${own.stderr}`);
    rmSync(join(g.wt, "own.js"));
  }
  // DNS (only when this machine resolves it outside the sandbox: the test must not need the network)
  const lookup = `require("node:dns").lookup("registry.npmjs.org", (e) => console.log(e ? e.code : "OK"))`;
  const outside = await runProcess(process.execPath, ["-e", lookup], { timeoutMs: 20_000 });
  const scope: SandboxScope = { ...installScope, writable: [g.wt], gitProtect: [g.common, join(g.wt, ".git")] };
  const env = { ...sandboxEnv(scope, process.env), HOME: userHome };
  if (outside.stdout.trim() === "OK") {
    const dns = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", lookup])), { cwd: g.wt, timeoutMs: 20_000, env });
    assert.equal(dns.stdout.trim(), "OK", dns.stderr);
  } else {
    console.log("# registry.npmjs.org does not resolve on this machine: sandboxed DNS not probed");
  }
  // offline installs of a local file: dependency, each package manager in its own dir; the stores in the ticket cache
  for (const pm of ["npm", "pnpm"]) {
    const d = join(g.wt, pm);
    mkdirSync(join(d, "dep"), { recursive: true });
    writeFileSync(join(d, "dep/package.json"), JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }));
    writeFileSync(join(d, "dep/index.js"), "module.exports = 42;\n");
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: `p-${pm}`, version: "1.0.0", private: true, dependencies: { dep: "file:./dep" } }));
    writeFileSync(join(d, "t.test.js"), 'const t = require("node:test"); const a = require("node:assert"); t("dep", () => a.equal(require("dep"), 42));\n');
  }
  writeFileSync(join(g.wt, ".gitignore"), "node_modules\n");
  const script = [
    "git status --porcelain >/dev/null",
    "(cd npm && npm install --offline --no-audit --no-fund >/dev/null && node --test t.test.js >/dev/null)",
    "(cd pnpm && pnpm install --offline >/dev/null && node --test t.test.js >/dev/null)",
    "pnpm store path",
  ].join(" && ");
  const r = await runProcess(...argvOf(sandboxArgvFor(scope, "/bin/sh", ["-c", script])), { cwd: g.wt, timeoutMs: 120_000, env });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.trim().startsWith(join(ticketCacheDir(scope), "pnpm-store")) || r.stdout.trim().startsWith(join(realpathSync(home), "cache", "K", "pnpm-store")), r.stdout);
});

const argvOf = (a: { file: string; args: string[] }): [string, string[]] => [a.file, a.args];

/** Self-check scratch dirs (selfcheck.mjs --unix-scratch) left in the temp dirs by `pid` (other test files run
 * self-checks concurrently). */
const scratchLeft = (pid: number | string = process.pid) =>
  [...new Set(["/private/tmp", realpathSync(tmpdir()), "/private/var/tmp"])].flatMap((d) => readdirSync(d).filter((n) => n.startsWith(`slackoff-sc-${pid}-`)).map((n) => join(d, n)));

test("sandboxSelfCheck T5-7: its own scratch socket in each temp dir must be refused (EPERM), and is removed", { skip }, async () => {
  const before = scratchLeft();
  for (const scope of [devScope, acceptScope]) {
    const c = await sandboxSelfCheck(scope);
    assert.equal(c.ok, true, `${scope.kind}: ${c.detail}`);
    assert.match(c.detail, /unixtmp0:EPERM .*unixtmp1:EPERM/);
  }
  assert.deepEqual(scratchLeft(), before, "no scratch socket dir left behind");
  // unsandboxed, the scratch socket connects: the check fails closed
  const sc = mkdtempSync(join(realpathSync(tmpdir()), `slackoff-sc-${process.pid}-`));
  try {
    const r = await runProcess(process.execPath, [SELF_CHECK_SCRIPT, join(home, "slackoff.db"), "4317", "--unix-scratch", sc], { timeoutMs: 20_000 });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /unixtmp0:CONNECTED/);
  } finally {
    rmSync(sc, { recursive: true, force: true });
  }
  assert.deepEqual(scratchLeft(), before);
});

// ---------------------------------------------------------------- fix round 5 (ruling T5-8)

const UNLINK_DENY = '(deny file-write-unlink (subpath (param "TMP_0")) (subpath (param "TMP_1")))';

test("profile T5-8: dev kinds deny unlink (and so rename out) in the temp dirs, before the re-allow of the platform's own dirs", () => {
  for (const scope of [devScope, installScope]) {
    const p = sandboxProfile(scope);
    const i = p.indexOf(UNLINK_DENY);
    assert.ok(i > p.indexOf('(allow file-write* (subpath (param "TMP_0"))'), p);
    assert.ok(i < p.indexOf('(allow file-write* (subpath (param "WRITE_0"))') && i < p.indexOf('(allow file-read* file-write* (subpath (param "TICKET_CACHE"))'), p);
    assert.ok(p.includes('(allow file-write* (subpath (param "TMP_0")) (subpath (param "TMP_1"))'), "the temp-dir write allow stays (pnpm's store lock)");
  }
  for (const scope of [acceptScope, { ...acceptScope, kind: "acceptance-install" as const }]) {
    // T6-2: acceptance kinds deny unlink (so rename) everywhere, not only in the temp dirs
    assert.ok(sandboxProfile(scope).includes("(deny file-write-unlink)\n"), "acceptance: no rename from anywhere (T6-2)");
  }
});

test("dev T5-8: a scratch daemon's socket or its directory cannot be moved from a temp dir into the worktree", { skip }, async () => {
  const g = gitWorktree("t58");
  const daemons: Array<Awaited<ReturnType<typeof scratchDaemon>>> = [];
  try {
    daemons.push(await scratchDaemon("/private/tmp"));
    daemons.push(await scratchDaemon(realpathSync(tmpdir())));
    for (const kind of ["dev-command", "dev-install"] as const) {
      const scope: SandboxScope = { ...devScope, kind, writable: [g.wt], gitProtect: [g.common, join(g.wt, ".git")] };
      const moves = daemons.flatMap((d, i) => [[`sock${i}`, d.sock, join(g.wt, `m${i}`)], [`dir${i}`, dirname(d.sock), join(g.wt, `md${i}`)]]);
      const code = `
        const fs = require("node:fs"); const net = require("node:net"); const out = []; const moves = JSON.parse(process.argv[1]);
        const reached = [];
        for (const [k, from, to] of moves) {
          try { fs.renameSync(from, to); out.push(k + ":MOVED"); reached.push([k, require("node:fs").statSync(to).isDirectory() ? to + "/d.sock" : to]); } catch (e) { out.push(k + ":" + e.code); }
        }
        let left = reached.length; const fin = () => console.log(out.sort().join(" "));
        if (left === 0) fin();
        for (const [k, p] of reached) { const s = net.connect(p); s.on("connect", () => { out.push(k + "conn:OK"); s.destroy(); if (--left === 0) fin(); }); s.on("error", (e) => { out.push(k + "conn:" + e.code); if (--left === 0) fin(); }); }`;
      const r = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", code, JSON.stringify(moves)])), { cwd: g.wt, timeoutMs: 20_000, env: sandboxEnv(scope, process.env) });
      assert.equal(r.stdout.trim(), "dir0:EPERM dir1:EPERM sock0:EPERM sock1:EPERM", `${kind}: ${r.stdout} ${r.stderr}`);
    }
  } finally {
    for (const d of daemons) await d.stop();
  }
});

test("dev T5-8: rm, mv and sockets inside the worktree, the ticket cache and the ticket TMPDIR still work", { skip }, async () => {
  const g = gitWorktree("t58own");
  for (const kind of ["dev-command", "dev-install"] as const) {
    const scope: SandboxScope = { ...devScope, kind, writable: [g.wt], gitProtect: [g.common, join(g.wt, ".git")] };
    const env = sandboxEnv(scope, process.env);
    const dirs = { wt: g.wt, cache: join(ticketCacheDir(scope), "npm"), tmp: ticketTmpDir(scope) };
    const code = `
      const fs = require("node:fs"); const net = require("node:net"); const path = require("node:path"); const dirs = JSON.parse(process.argv[1]); const out = [];
      (async () => {
        for (const [k, d] of Object.entries(dirs)) {
          try {
            fs.mkdirSync(path.join(d, "sub"), { recursive: true }); fs.writeFileSync(path.join(d, "sub/f"), "x");
            fs.renameSync(path.join(d, "sub/f"), path.join(d, "sub/g")); fs.renameSync(path.join(d, "sub"), path.join(d, "sub2"));
            fs.rmSync(path.join(d, "sub2"), { recursive: true });
            const sock = path.join(d, "s");
            await new Promise((res, rej) => { const sv = net.createServer((c) => c.end()); sv.once("error", rej); sv.listen(sock, () => { const c = net.connect(sock); c.on("connect", () => { c.destroy(); sv.close(); res(); }); c.on("error", rej); }); });
            out.push(k + ":OK");
          } catch (e) { out.push(k + ":" + e.code); }
        }
        for (const [k, f] of [["gitptr", ${JSON.stringify(join(g.wt, ".git"))}], ["gitcommon", ${JSON.stringify(join(g.common, "HEAD"))}]]) {
          try { fs.renameSync(f, f + ".mv"); out.push(k + ":MOVED"); } catch (e) { out.push(k + ":" + e.code); }
        }
        console.log(out.join(" "));
      })();`;
    const r = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", code, JSON.stringify(dirs)])), { cwd: g.wt, timeoutMs: 20_000, env });
    assert.equal(r.stdout.trim(), "wt:OK cache:OK tmp:OK gitptr:EPERM gitcommon:EPERM", `${kind}: ${r.stdout} ${r.stderr}`);
  }
});

test("sandboxSelfCheck T5-8: moving its scratch socket into an own dir must be refused; without the unlink deny it fails closed", { skip }, async () => {
  const before = scratchLeft();
  const c = await sandboxSelfCheck(devScope);
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /unixtmp0:EPERM unixmv0:EPERM unixtmp1:EPERM unixmv1:EPERM/);
  const a = await sandboxSelfCheck(acceptScope);
  assert.equal(a.ok, true, a.detail);
  assert.match(a.detail, /unixtmp0:EPERM unixmv0:EPERM unixtmp1:EPERM unixmv1:EPERM/, "acceptance (T6-1): the run's tmp dir is its own dir");
  assert.deepEqual(scratchLeft(), before, "no scratch dir left behind");
  // the same check under a profile without the T5-8 rule: the move succeeds, the check fails
  const sc = mkdtempSync(join(realpathSync(tmpdir()), `slackoff-sc-${process.pid}-`));
  try {
    const { file, args } = sandboxArgv(devScope, process.execPath, [SELF_CHECK_SCRIPT, join(home, "slackoff.db"), "4317", "--unix-scratch", sc, "--own", ticketTmpDir(devScope)]);
    const weak = args.map((x) => (x.startsWith("(version 1)") ? x.replace(UNLINK_DENY + "\n", "") : x));
    assert.notDeepEqual(weak, args);
    const r = await runProcess(file, weak, { timeoutMs: 20_000 });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /unixmv0:MOVED/);
    assert.deepEqual(readdirSync(ticketTmpDir(devScope)).filter((n) => n.startsWith("slackoff-sc-")), [], "the moved socket is removed again");
  } finally {
    rmSync(sc, { recursive: true, force: true });
  }
  assert.deepEqual(scratchLeft(), before);
});

test("writeShellPrefix T5-8: the wrapper's self-check probes the move too and leaves no scratch dir", { skip }, async () => {
  const wrapper = writeShellPrefix(join(root, "prefix-t58"), devScope, { shell: "/bin/zsh", homeDir: userHome });
  assert.match(readFileSync(wrapper, "utf8"), /--own/);
  const r = await runProcess(wrapper, ["echo ran $PPID"], { env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome }, timeoutMs: 30_000 });
  // the command runs in the wrapper's own process (exec), so its pid names the wrapper's scratch dirs
  assert.match(r.stdout.trim(), /^ran \d+$/, r.stderr);
  const wrapperPid = (await runProcess(wrapper, ["echo $$"], { env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome }, timeoutMs: 30_000 })).stdout.trim();
  assert.match(wrapperPid, /^\d+$/);
  assert.deepEqual(scratchLeft(wrapperPid), []);
});

test("sandboxSelfCheck T5-8: scratch dirs of a dead maker (a SIGKILLed wrapper) are swept; a live maker's are kept", { skip }, async () => {
  const dead = execFileSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" }).trim();
  const tmp = realpathSync(tmpdir());
  const stale = mkdtempSync(join(tmp, `slackoff-sc-${dead}-`));
  const live = mkdtempSync(join(tmp, `slackoff-sc-${process.pid}-`));
  try {
    const c = await sandboxSelfCheck(devScope);
    assert.equal(c.ok, true, c.detail);
    assert.equal(existsSync(stale), false, "the dead maker's dir is removed");
    assert.equal(existsSync(live), true, "a running maker's dir is left alone");
  } finally {
    rmSync(stale, { recursive: true, force: true });
    rmSync(live, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Task 6 (ruling T6-1)

/** An acceptance run root: realpath, outside SLACKOFF_HOME and the mapped repos, with its own tmp dir. */
function acceptRunRoot(parent: string): string {
  const r = realpathSync(mkdtempSync(join(parent, "t61-")));
  mkdirSync(join(r, "tmp"), { mode: 0o700 });
  return r;
}

test("profile T6-1: acceptance kinds allow unix sockets in <runRoot>/tmp only (re-allowed after the daemon dirs); T5-8 unlink deny with runRoot re-allowed", () => {
  const runRoot = acceptRunRoot(root);
  for (const kind of ["acceptance", "acceptance-install"] as const) {
    const scope: SandboxScope = { ...acceptScope, kind, runRoot };
    const p = sandboxProfile(scope);
    assert.ok(!p.includes("/"), p);
    assert.deepEqual([...socketAllowParams(p)].sort(), ["MDNS_SOCKET", "RUN_TMP"], kind);
    const daemons = p.indexOf('(deny network-outbound (remote unix-socket (prefix (param "TMUX_TMP")))');
    assert.ok(daemons > 0 && p.lastIndexOf('(allow network-outbound (remote unix-socket (subpath (param "RUN_TMP"))))') > daemons, "re-allowed after the daemon dirs (T5-5)");
    assert.ok(p.indexOf('(remote unix-socket (subpath (param "AGENT_SOCK_DIR")))') > p.lastIndexOf('(subpath (param "RUN_TMP"))))'), "agent sockets stay denied last");
    // T5-8 for acceptance (T6-2: everywhere): no unlink, so no rename; the run root is the platform's own dir
    const unlinkDeny = p.indexOf("(deny file-write-unlink)\n");
    const unlinkAllow = p.indexOf('(allow file-write-unlink (subpath (param "RUN_ROOT")))');
    assert.ok(unlinkDeny > 0 && unlinkAllow > unlinkDeny, p);
    assert.ok(p.includes('(allow file-read* file-write* (subpath (param "RUN_ROOT")))'), p);
    // the denied paths stay denied for unlink too, after the run-root allow (an operation-specific rule wins, §6.9)
    const denyUnlinkHome = p.indexOf('(deny file-write-unlink ', unlinkAllow);
    assert.ok(denyUnlinkHome > unlinkAllow && p.slice(denyUnlinkHome).includes('(subpath (param "SLACKOFF_HOME"))'), p);
    const params = sandboxParams(scope);
    assert.ok(params.includes(`RUN_ROOT=${runRoot}`) && params.includes(`RUN_TMP=${join(runRoot, "tmp")}`), params.join("\n"));
  }
  // T6-2: an acceptance scope without a run root is refused
  for (const kind of ["acceptance", "acceptance-install"] as const) {
    const { runRoot: _, ...noRun } = acceptScope;
    assert.throws(() => sandboxProfile({ ...noRun, kind }), SandboxUnavailableError);
  }
});

test("profile T6-1: a run root that is relative, inside or around SLACKOFF_HOME or a repo, or on a dev scope is refused", () => {
  const bad: SandboxScope[] = [
    { ...acceptScope, runRoot: "rel/run" },
    { ...acceptScope, runRoot: join(home, "run") },
    { ...acceptScope, runRoot: home },
    { ...acceptScope, runRoot: root },
    { ...acceptScope, runRoot: join(repoDir, "run") },
    { ...acceptScope, runRoot: join(homedir(), ".ssh", "run") },
    { ...devScope, runRoot: join(root, "run") },
  ];
  for (const scope of bad) assert.throws(() => sandboxProfile(scope), SandboxUnavailableError, JSON.stringify(scope.runRoot));
});

test("sandboxEnv T6-1: an acceptance command's TMPDIR / TMP / TEMP are <runRoot>/tmp (created 0700); caches per run (T6-2)", () => {
  const runRoot = realpathSync(mkdtempSync(join(root, "t61env-")));
  const env = sandboxEnv({ ...acceptScope, runRoot }, { PATH: "/usr/bin", TMPDIR: "/elsewhere", SSH_AUTH_SOCK: "/x" });
  const t = join(runRoot, "tmp");
  assert.equal(env.TMPDIR, t);
  assert.equal(env.TMP, t);
  assert.equal(env.TEMP, t);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.npm_config_cache, join(runRoot, "cache", "npm"), "T6-2: per-run caches");
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, undefined, "Playwright's own browsers stay where they are");
  assert.equal(statSync(t).mode & 0o777, 0o700);
});

test("T6-1: scratch daemons in /private/tmp and the real $TMPDIR stay unreachable from both acceptance kinds; the run's own TMPDIR works", { skip }, async () => {
  const daemons: Array<Awaited<ReturnType<typeof scratchDaemon>>> = [];
  const runRoot = acceptRunRoot("/private/tmp");
  try {
    daemons.push(await scratchDaemon("/private/tmp"));
    daemons.push(await scratchDaemon(realpathSync(tmpdir())));
    const socks = [["privtmp", daemons[0]!.sock], ["tmpdir", daemons[1]!.sock]];
    const ctl = await runProcess(process.execPath, ["-e", CONNECT_ALL, JSON.stringify(socks)], { timeoutMs: 20_000 });
    assert.equal(ctl.stdout.trim(), "privtmp:OK tmpdir:OK", ctl.stderr);
    // the command's own socket, in os.tmpdir() (= <runRoot>/tmp)
    const own = `
      const net = require("node:net"); const path = require("node:path"); const os = require("node:os");
      const p = path.join(os.tmpdir(), "own.sock");
      const s = net.createServer((c) => c.end()).listen(p, () => { const c = net.connect(p); c.on("connect", () => { console.log("own:OK " + os.tmpdir()); c.destroy(); s.close(); }); c.on("error", (e) => { console.log("own:" + e.code); s.close(); }); });
      s.on("error", (e) => console.log("own:listen-" + e.code));`;
    for (const kind of ["acceptance", "acceptance-install"] as const) {
      const scope: SandboxScope = { ...acceptScope, kind, runRoot };
      const env = sandboxEnv(scope, process.env);
      const r = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", CONNECT_ALL, JSON.stringify(socks)])), { cwd: runRoot, timeoutMs: 20_000, env });
      assert.equal(r.stdout.trim(), "privtmp:EPERM tmpdir:EPERM", `${kind}: ${r.stdout} ${r.stderr}`);
      const o = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", own])), { cwd: runRoot, timeoutMs: 20_000, env });
      assert.equal(o.stdout.trim(), `own:OK ${join(runRoot, "tmp")}`, `${kind}: ${o.stdout} ${o.stderr}`);
    }
  } finally {
    for (const d of daemons) await d.stop();
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("T6-1: a scratch daemon's socket or its directory cannot be renamed into the run root or its tmp dir; rm / mv inside the run root work", { skip }, async () => {
  const daemons: Array<Awaited<ReturnType<typeof scratchDaemon>>> = [];
  // one run root in each temp dir: the run root's unlink allow must beat the temp dirs' unlink deny in both
  const runRoots = [acceptRunRoot("/private/tmp"), acceptRunRoot(realpathSync(tmpdir()))];
  try {
    daemons.push(await scratchDaemon("/private/tmp"));
    daemons.push(await scratchDaemon(realpathSync(tmpdir())));
    for (const runRoot of runRoots) {
      for (const kind of ["acceptance", "acceptance-install"] as const) {
        const scope: SandboxScope = { ...acceptScope, kind, runRoot };
        const moves = daemons.flatMap((d, i) => [
          [`sock${i}`, d.sock, join(runRoot, "tmp", `m${i}`)],
          [`sockroot${i}`, d.sock, join(runRoot, `mr${i}`)],
          [`dir${i}`, dirname(d.sock), join(runRoot, "tmp", `md${i}`)],
        ]);
        const code = `
          const fs = require("node:fs"); const net = require("node:net"); const out = []; const moves = JSON.parse(process.argv[1]);
          const reached = [];
          for (const [k, from, to] of moves) {
            try { fs.renameSync(from, to); out.push(k + ":MOVED"); reached.push([k, fs.statSync(to).isDirectory() ? to + "/d.sock" : to]); } catch (e) { out.push(k + ":" + e.code); }
          }
          // own files: write, rename and remove inside the run root
          const own = [];
          try { fs.writeFileSync("${runRoot}/a", "a"); fs.renameSync("${runRoot}/a", "${runRoot}/tmp/b"); fs.rmSync("${runRoot}/tmp/b"); fs.mkdirSync("${runRoot}/d/e", { recursive: true }); fs.rmSync("${runRoot}/d", { recursive: true }); own.push("own:OK"); } catch (e) { own.push("own:" + e.code); }
          let left = reached.length; const fin = () => console.log([...out.sort(), ...own].join(" "));
          if (left === 0) fin();
          for (const [k, p] of reached) { const s = net.connect(p); s.on("connect", () => { out.push(k + "conn:OK"); s.destroy(); if (--left === 0) fin(); }); s.on("error", (e) => { out.push(k + "conn:" + e.code); if (--left === 0) fin(); }); }`;
        const r = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", code, JSON.stringify(moves)])), { cwd: runRoot, timeoutMs: 20_000, env: sandboxEnv(scope, process.env) });
        assert.equal(
          r.stdout.trim(),
          "dir0:EPERM dir1:EPERM sock0:EPERM sock1:EPERM sockroot0:EPERM sockroot1:EPERM own:OK",
          `${kind} ${runRoot}: ${r.stdout} ${r.stderr}`,
        );
      }
    }
  } finally {
    for (const d of daemons) await d.stop();
    for (const r of runRoots) rmSync(r, { recursive: true, force: true });
  }
});

test("sandboxSelfCheck T6-1: with a run root, the acceptance check also proves its scratch socket cannot be moved into <runRoot>/tmp", { skip }, async () => {
  const before = scratchLeft();
  const runRoot = acceptRunRoot("/private/tmp");
  try {
    for (const kind of ["acceptance", "acceptance-install"] as const) {
      const c = await sandboxSelfCheck({ ...acceptScope, kind, runRoot });
      assert.equal(c.ok, true, `${kind}: ${c.detail}`);
      assert.match(c.detail, /unixtmp0:EPERM unixmv0:EPERM unixtmp1:EPERM unixmv1:EPERM/);
    }
    assert.deepEqual(readdirSync(join(runRoot, "tmp")), [], "nothing moved into the run's tmp dir");
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
  assert.deepEqual(scratchLeft(), before, "no scratch dir left behind");
});

// ---------------------------------------------------------------- Task 6 fix round 1 (rulings T6-2, T6-3)

test("profile T6-2: acceptance kinds are a write allowlist (run root, /dev), a global unlink deny, the shim dir and Claude's files denied", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "server-claude");
  try {
    for (const kind of ["acceptance", "acceptance-install"] as const) {
      const scope: SandboxScope = { ...acceptScope, kind, acceptConfigDir: join(root, "accept-claude") };
      const p = sandboxProfile(scope);
      assert.ok(!p.includes("/"), p);
      const denyWrite = p.indexOf("(deny file-write*)\n");
      const allowWrite = p.indexOf('(allow file-write* (subpath (param "RUN_ROOT"))');
      assert.ok(denyWrite > 0 && allowWrite > denyWrite, p);
      assert.ok(p.slice(allowWrite).startsWith('(allow file-write* (subpath (param "RUN_ROOT")) (literal (param "DEV_NULL"))'), p);
      const unlinkAll = p.indexOf("(deny file-write-unlink)\n");
      const unlinkRun = p.indexOf('(allow file-write-unlink (subpath (param "RUN_ROOT")))');
      assert.ok(unlinkAll > allowWrite && unlinkRun > unlinkAll, p);
      // Claude Code's transcripts and config (C4): ~/.claude*, the server's and the acceptance agent's config dirs, other sessions' /tmp dirs
      const claude = p.indexOf('(deny file-read* file-write* (prefix (param "HOME_CLAUDE")) (subpath (param "HOME_CLAUDE_DIR")) (prefix (param "HOME_CLAUDE_JSON")) (subpath (param "ACCEPT_CLAUDE_CONFIG")) (subpath (param "SERVER_CLAUDE_CONFIG")) (prefix (param "CLAUDE_TMP")))');
      assert.ok(claude > 0, p);
      // the run root re-allowed after it (T5-5: a run root under /private/tmp/claude-*), then the shim dir and the run root itself denied
      const reallow = p.indexOf('(allow file-read* file-write* (subpath (param "RUN_ROOT")))');
      assert.ok(reallow > claude && unlinkRun > reallow, p);
      const shim = p.indexOf('(deny file-write* (subpath (param "SHIM_DIR")) (literal (param "SHIM")))');
      const shimUnlink = p.indexOf('(deny file-write-unlink (subpath (param "SHIM_DIR")) (literal (param "SHIM")) (literal (param "RUN_ROOT")))');
      assert.ok(shim > reallow && shimUnlink > unlinkRun, p);
      const params = new Map(sandboxParams(scope, userHome).filter((_, i) => i % 2 === 1).map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
      assert.equal(params.get("HOME_CLAUDE"), join(realpathSync(userHome), ".claude"));
      assert.equal(params.get("SHIM_DIR"), join(acceptRun, "bin"));
      assert.equal(params.get("SHIM"), join(acceptRun, "bin", "playwright"));
      assert.equal(params.get("SERVER_CLAUDE_CONFIG"), join(realpathSync(root), "server-claude"));
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
  // a run root overlapping a Claude dir is refused
  assert.throws(() => sandboxProfile({ ...acceptScope, acceptConfigDir: join(acceptRun, "cfg") }), SandboxUnavailableError);
});

/** Run `code` (node -e) under `scope` with the fake user home; returns stdout. */
async function underScope(scope: SandboxScope, code: string, args: string[] = [], cwd = acceptRun): Promise<string> {
  const r = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", code, ...args])), { cwd, timeoutMs: 20_000, env: sandboxEnv(scope, process.env) });
  assert.equal(r.stderr.trim(), "", r.stderr);
  return r.stdout.trim();
}

const TRY_ALL = `
  const fs = require("node:fs"); const out = [];
  for (const [k, op, a, b] of JSON.parse(process.argv[1])) {
    try {
      if (op === "write") fs.writeFileSync(a, "x");
      else if (op === "append") fs.appendFileSync(a, "x");
      else if (op === "mkdir") fs.mkdirSync(a, { recursive: true });
      else if (op === "rename") fs.renameSync(a, b);
      else if (op === "chmod") fs.chmodSync(a, 0o777);
      else if (op === "rm") fs.rmSync(a, { recursive: true });
      else if (op === "read") fs.readFileSync(a);
      else if (op === "readdir") fs.readdirSync(a);
      else if (op === "link") fs.linkSync(a, b);
      else if (op === "symlink") fs.symlinkSync(a, b);
      out.push(k + ":OK");
    } catch (e) { out.push(k + ":" + e.code); }
  }
  console.log(out.join(" "));`;

test("acceptance T6-2 (C1, C3): writes only inside the run root; the shim and the run root itself cannot be written, moved, chmodded or removed", { skip }, async () => {
  const runRoot = acceptRunRoot("/private/tmp");
  const scratch = realpathSync(mkdtempSync("/private/tmp/t62w-"));
  const varScratch = realpathSync(mkdtempSync("/private/var/tmp/t62w-"));
  try {
    mkdirSync(join(runRoot, "bin"), { recursive: true });
    writeFileSync(join(runRoot, "bin/playwright"), "#!/bin/sh\necho platform\n", { mode: 0o755 });
    mkdirSync(join(runRoot, "work/acceptance"), { recursive: true });
    for (const kind of ["acceptance", "acceptance-install"] as const) {
      const scope: SandboxScope = { ...acceptScope, kind, runRoot };
      const ops = [
        ["gitconfig", "append", join(userHome, ".gitconfig")],
        ["launchagent", "mkdir", join(userHome, "Library/LaunchAgents/x")],
        ["privtmp", "write", join(scratch, "f")],
        ["vartmp", "write", join(varScratch, "f")],
        ["realtmp", "write", join(realpathSync(tmpdir()), `t62-${process.pid}-${kind}`)],
        ["shimwrite", "write", join(runRoot, "bin/playwright")],
        ["shimnew", "write", join(runRoot, "bin/other")],
        ["shimchmod", "chmod", join(runRoot, "bin/playwright")],
        ["shimmv", "rename", join(runRoot, "bin/playwright"), join(runRoot, "work/pw")],
        ["shimrm", "rm", join(runRoot, "bin/playwright")],
        ["binmv", "rename", join(runRoot, "bin"), join(runRoot, "work/bin")],
        ["rootmv", "rename", runRoot, `${runRoot}-moved`],
        ["work", "write", join(runRoot, "work/acceptance/spec.mjs")],
        ["workmv", "rename", join(runRoot, "work/acceptance/spec.mjs"), join(runRoot, "work/acceptance/spec2.mjs")],
        ["workrm", "rm", join(runRoot, "work/acceptance/spec2.mjs")],
        ["tmp", "write", join(runRoot, "tmp/t")],
        ["cache", "mkdir", join(runRoot, "cache/npm/x")],
        ["devnull", "append", "/dev/null"],
      ];
      const out = await underScope(scope, TRY_ALL, [JSON.stringify(ops)]);
      const want = [
        "gitconfig:EPERM", "launchagent:EPERM", "privtmp:EPERM", "vartmp:EPERM", "realtmp:EPERM",
        "shimwrite:EPERM", "shimnew:EPERM", "shimchmod:EPERM", "shimmv:EPERM", "shimrm:EPERM", "binmv:EPERM", "rootmv:EPERM",
        "work:OK", "workmv:OK", "workrm:OK", "tmp:OK", "cache:OK", "devnull:OK",
      ];
      assert.equal(out, want.join(" "), `${kind}: ${out}`);
      assert.equal(readFileSync(join(runRoot, "bin/playwright"), "utf8"), "#!/bin/sh\necho platform\n");
      assert.equal(statSync(join(runRoot, "bin/playwright")).mode & 0o777, 0o755);
      assert.equal(existsSync(join(userHome, ".gitconfig")), false);
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
    rmSync(`${runRoot}-moved`, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    rmSync(varScratch, { recursive: true, force: true });
    for (const kind of ["acceptance", "acceptance-install"]) rmSync(join(realpathSync(tmpdir()), `t62-${process.pid}-${kind}`), { force: true });
  }
});

test("acceptance T6-2 (C2): a daemon socket outside the temp dirs cannot be renamed, hard-linked or symlinked into <runRoot>/tmp and reached", { skip }, async () => {
  const runRoot = acceptRunRoot("/private/tmp");
  const daemon = await scratchDaemon("/private/var/tmp");
  try {
    const ctl = await runProcess(process.execPath, ["-e", CONNECT_ALL, JSON.stringify([["d", daemon.sock]])], { timeoutMs: 20_000 });
    assert.equal(ctl.stdout.trim(), "d:OK", "control: the daemon answers outside the sandbox");
    for (const kind of ["acceptance", "acceptance-install"] as const) {
      const scope: SandboxScope = { ...acceptScope, kind, runRoot };
      const t = join(runRoot, "tmp");
      const ops = [
        ["mv", "rename", daemon.sock, join(t, "mv.sock")],
        ["mvdir", "rename", dirname(daemon.sock), join(t, "mvdir")],
        ["hard", "link", daemon.sock, join(t, "hard.sock")],
        ["sym", "symlink", daemon.sock, join(t, "sym.sock")],
      ];
      const moved = await underScope(scope, TRY_ALL, [JSON.stringify(ops)]);
      assert.match(moved, /^mv:EPERM mvdir:EPERM hard:\w+ sym:\w+$/, `${kind}: ${moved}`);
      // whatever link exists, connecting through it is refused
      const socks = ["hard.sock", "sym.sock"];
      const conn = await underScope(scope, CONNECT_ALL, [JSON.stringify([["direct", daemon.sock], ...socks.map((n) => [n, join(t, n)])])]);
      for (const part of conn.split(" ")) assert.match(part, /:(EPERM|ENOENT)$/, `${kind}: ${conn}`);
      assert.match(conn, /direct:EPERM/);
      for (const n of ["hard.sock", "sym.sock"]) rmSync(join(t, n), { force: true });
    }
    assert.ok(existsSync(daemon.sock), "the daemon's socket stayed where it was");
  } finally {
    await daemon.stop();
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("acceptance T6-2 (C4): Claude's transcripts and config — ~/.claude*, the server's and the acceptance config dir, /private/tmp/claude-* — are unreadable", { skip }, async () => {
  mkdirSync(join(userHome, ".claude/projects/p"), { recursive: true });
  writeFileSync(join(userHome, ".claude/projects/p/s.jsonl"), "DESIGN\n");
  writeFileSync(join(userHome, ".claude.json"), "{}");
  const serverCfg = join(root, "server-claude-c4");
  const acceptCfg = join(root, "accept-claude-c4");
  for (const d of [serverCfg, acceptCfg]) {
    mkdirSync(join(d, "projects"), { recursive: true });
    writeFileSync(join(d, "projects/t.jsonl"), "DESIGN\n");
  }
  // a Claude session's scratch dir: a scratch dir of our own matching /private/tmp/claude-* (no other session's dir is touched)
  const tmpProbe: string | null = mkdtempSync("/private/tmp/claude-t62c4-");
  writeFileSync(join(tmpProbe, "f"), "DESIGN\n");
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = serverCfg;
  try {
    for (const kind of ["acceptance", "acceptance-install"] as const) {
      const scope: SandboxScope = { ...acceptScope, kind, acceptConfigDir: acceptCfg };
      const ops: string[][] = [
        ["transcript", "read", join(userHome, ".claude/projects/p/s.jsonl")],
        ["claudejson", "read", join(userHome, ".claude.json")],
        ["server", "read", join(serverCfg, "projects/t.jsonl")],
        ["accept", "readdir", acceptCfg],
        ...(tmpProbe ? [["claudetmp", "read", join(tmpProbe, "f")]] : []),
      ];
      const out = await underScope(scope, TRY_ALL, [JSON.stringify(ops)]);
      assert.equal(out, ops.map(([k]) => `${k}:EPERM`).join(" "), `${kind}: ${out}`);
    }
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    if (tmpProbe) rmSync(tmpProbe, { recursive: true, force: true });
  }
});

test("sandboxSelfCheck T6-2: acceptance proves no writes outside the run root, the shim dir unwritable, a non-temp daemon socket unreachable and unmovable, the config dir unreadable", { skip }, async () => {
  const before = scratchLeft();
  const runRoot = acceptRunRoot("/private/tmp");
  const cfg = mkdtempSync(join(root, "accept-claude-sc-"));
  try {
    for (const kind of ["acceptance", "acceptance-install"] as const) {
      const c = await sandboxSelfCheck({ ...acceptScope, kind, runRoot, acceptConfigDir: cfg });
      assert.equal(c.ok, true, `${kind}: ${c.detail}`);
      assert.match(c.detail, /unixtmp0:EPERM unixmv0:EPERM unixtmp1:EPERM unixmv1:EPERM unixtmp2:EPERM unixmv2:EPERM/, c.detail);
      assert.match(c.detail, /nowrite0:EPERM nowrite1:EPERM nowrite2:EPERM nowrite3:EPERM/, c.detail);
      assert.match(c.detail, /deniedread0:EPERM/, c.detail);
    }
    assert.deepEqual(readdirSync(join(runRoot, "tmp")), []);
    assert.deepEqual(readdirSync(join(runRoot, "bin")), []);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
  assert.deepEqual(scratchLeft(), before, "no scratch dir left behind");
});

// ---------------------------------------------------------------- Task 6 fix round 2 (ruling T6-7)

test("checkScope T6-7 (M1): a broad run root — a temp-dir root, a dir containing one, /private/tmp/claude-*, $HOME or a dir under it — is refused", () => {
  const bad = [
    "/private/tmp", "/private", "/", "/private/var/tmp", realpathSync(tmpdir()), dirname(realpathSync(tmpdir())),
    "/private/tmp/claude-501", "/private/tmp/claude-x/run", homedir(), join(homedir(), "slackoff-run"), dirname(homedir()),
  ];
  for (const runRoot of bad) assert.throws(() => sandboxProfile({ ...acceptScope, runRoot }), SandboxUnavailableError, runRoot);
  // a run root of its own inside a temp dir is fine
  assert.doesNotThrow(() => sandboxProfile(acceptScope));
  assert.doesNotThrow(() => sandboxProfile({ ...acceptScope, runRoot: "/private/tmp/slackoff-accept-AbCdEf" }));
});

test("acceptance T6-7 (M5): ~/.claude.json* stay unreadable when ~/.claude is a symlink, and the link's target too", { skip }, async () => {
  const fakeHome = join(root, "user-linked");
  const target = join(root, "claude-data-elsewhere");
  mkdirSync(join(target, "projects"), { recursive: true });
  writeFileSync(join(target, "projects/s.jsonl"), "DESIGN\n");
  mkdirSync(fakeHome, { recursive: true });
  symlinkSync(target, join(fakeHome, ".claude"));
  writeFileSync(join(fakeHome, ".claude.json"), "{}");
  writeFileSync(join(fakeHome, ".claude.json.backup"), "{}");
  for (const kind of ["acceptance", "acceptance-install"] as const) {
    const scope: SandboxScope = { ...acceptScope, kind };
    const ops = [
      ["json", "read", join(fakeHome, ".claude.json")],
      ["backup", "read", join(fakeHome, ".claude.json.backup")],
      ["vialink", "read", join(fakeHome, ".claude/projects/s.jsonl")],
      ["target", "read", join(target, "projects/s.jsonl")],
    ];
    const r = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", TRY_ALL, JSON.stringify(ops)], fakeHome)), { cwd: acceptRun, timeoutMs: 20_000, env: sandboxEnv(scope, process.env) });
    assert.equal(r.stdout.trim(), "json:EPERM backup:EPERM vialink:EPERM target:EPERM", `${kind}: ${r.stdout} ${r.stderr}`);
  }
});

// ---------------------------------------------------------------- T7-1: the acceptance agent's Bash wrapper

test("writeShellPrefix T7-1: the acceptance wrapper has no listening probe (no scratch dirs, no unix peers); acceptance-install has none", () => {
  const cfg = join(root, "t71-cfg");
  mkdirSync(cfg, { recursive: true });
  const scope: SandboxScope = { ...acceptScope, acceptConfigDir: cfg };
  const wrapper = writeShellPrefix(join(root, "prefix-t71"), scope, { shell: "/bin/zsh", homeDir: userHome });
  const text = readFileSync(wrapper, "utf8");
  assert.ok(text.includes(SELF_CHECK_SCRIPT));
  for (const s of ["--unix-peer", "--unix-scratch", "mktemp", "--own"]) assert.ok(!text.includes(s), s);
  for (const s of ["--no-write", join(acceptRun, "bin"), "--denied-read", cfg, "--launchservices", "TMPDIR=", join(acceptRun, "tmp")]) assert.ok(text.includes(s), s);
  assert.match(text, /acceptance agent/);
  assert.throws(() => writeShellPrefix(join(root, "prefix-t71i"), { ...scope, kind: "acceptance-install" }, { shell: "/bin/zsh" }), SandboxUnavailableError);
});

test("writeShellPrefix T7-1: the acceptance wrapper runs a command inside the run's sandbox; its check failing refuses the command", { skip }, async () => {
  const cfg = join(root, "t71-cfg2");
  mkdirSync(cfg, { recursive: true });
  const run = realpathSync(mkdtempSync(join(root, "run-t71-")));
  mkdirSync(join(run, "bin")); // the shim dir (prepareRunDirs); the check proves it unwritable, and fails closed without it
  const scope: SandboxScope = { kind: "acceptance", home, allowInHome: null, repos: [repoDir], runRoot: run, acceptConfigDir: cfg };
  const wrapper = writeShellPrefix(join(root, "prefix-t71b"), scope, { shell: "/bin/zsh", homeDir: userHome });
  const env = { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome };
  const r = await runProcess(wrapper, [`eval 'cat ${join(repoDir, "server.mjs")}; echo tmp=$TMPDIR; echo w > ${join(run, "w.txt")} && echo wrote'`], { env, timeoutMs: 30_000 });
  assert.doesNotMatch(r.stdout, /SRC/, JSON.stringify(r));
  assert.match(r.stdout, new RegExp(`tmp=${join(run, "tmp")}`), JSON.stringify(r));
  assert.match(r.stdout, /wrote/);
  // the per-command check fails closed: the config dir it must prove unreadable is gone → nothing runs
  rmSync(cfg, { recursive: true });
  const marker = join(run, "ran");
  const bad = await runProcess(wrapper, [`touch ${marker}`], { env, timeoutMs: 30_000 });
  assert.equal(bad.code, 126);
  assert.match(bad.stderr, /sandbox self-check failed/);
  assert.equal(existsSync(marker), false);
});

// ---------------------------------------------------------------- Task 7 fix round 1 (rulings T7-2 amended, T7-4, T7-6)

const ALL_KINDS: SandboxScope[] = [devScope, installScope, acceptScope, { ...acceptScope, kind: "acceptance-install" }];
const CWD_RULE = '(allow file-write-create file-write-data (require-all (regex (param "CLAUDE_CWD_RE")) (vnode-type REGULAR-FILE)))';

test("profile T7-4: Chrome's remote-debugging port 9222 is denied (connect and listen) in every kind", () => {
  for (const scope of ALL_KINDS) {
    const p = sandboxProfile(scope);
    assert.ok(p.includes('(remote tcp "*:9222")') && p.includes('(local tcp "*:9222")'), scope.kind);
  }
});

test("profile T7-2: every kind allows creating / writing only a regular file named like Claude Code's cwd file, after the claude-* deny", () => {
  for (const scope of ALL_KINDS) {
    const p = sandboxProfile(scope);
    assert.ok(p.includes(CWD_RULE), `${scope.kind}: ${p}`);
    const lines = p.split("\n");
    const deny = lines.findIndex((l) => l.startsWith("(deny file-") && l.includes('(prefix (param "CLAUDE_TMP"))'));
    assert.ok(deny >= 0 && lines.indexOf(CWD_RULE) > deny, `${scope.kind}: the allow comes after the claude-* deny`);
    // the regex is a param (no path in the profile text), not realpath'd as a path
    const params = sandboxParams(scope);
    assert.ok(params.includes("CLAUDE_CWD_RE=^/private/tmp/claude-[0-9a-f][0-9a-f][0-9a-f][0-9a-f](-[-A-Za-z0-9_]+)?-cwd$"), params.join("\n"));
  }
  // a stand-in base (tests only) is regex-escaped
  const params = sandboxParams({ ...devScope, claudeTmp: join(root, "a.b", "claude-") });
  assert.ok(params.some((x) => x.startsWith("CLAUDE_CWD_RE=^") && x.includes("a\\.b/claude-[0-9a-f]")), params.join("\n"));
});

test("profile T7-6 / T7-7: acceptance kinds deny creating a .git entry in the work dir and <runRoot>/.git (not in caches / tmp); F4A-2: dev kinds in their worktrees", () => {
  for (const scope of ALL_KINDS) {
    const p = sandboxProfile(scope);
    const rule = '(deny file-write-create (require-all (subpath (param "RUN_WORK")) (regex (param "DOTGIT_RE"))) (literal (param "RUN_DOTGIT")))';
    assert.equal(p.includes(rule), scope.kind.startsWith("acceptance"), scope.kind);
    const params = sandboxParams(scope);
    // F4A-2: any case (a case-insensitive volume)
    assert.ok(params.includes("DOTGIT_RE=/\\.[gG][iI][tT](/|$)"), `${scope.kind}: ${params.join(" ")}`);
    if (!scope.kind.startsWith("acceptance")) {
      const dev = '(deny file-write-create (require-all (subpath (param "WRITE_0")) (regex (param "DOTGIT_RE"))))';
      // last, but for the phase 4b credentials-file pin (two lines)
      assert.equal(p.trimEnd().split("\n").at(-3), dev, `${scope.kind}: last, after every write allow`);
    }
    if (scope.kind.startsWith("acceptance")) {
      assert.ok(params.includes(`RUN_WORK=${join(acceptRun, "work")}`) && params.includes(`RUN_DOTGIT=${join(acceptRun, ".git")}`), params.join("\n"));
    }
  }
});

/** A stand-in for /tmp/claude- (never the real names): `<scratch>/claude-`. */
function cwdBase(): string {
  const d = realpathSync(mkdtempSync(join(root, "cwdbase-")));
  return join(d, "claude-");
}

test("T7-2: the exact Bash shape with the cwd-file suffix exits 0 under the dev and acceptance wrappers (new and existing file); symlink, dir, fifo or hard-link plants are EPERM", { skip }, async () => {
  const run = realpathSync(mkdtempSync(join(root, "run-t72-")));
  mkdirSync(join(run, "bin"));
  mkdirSync(join(run, "work"));
  // files a hard link must not reach: the DB in SLACKOFF_HOME (denied); a readable file the command cannot write —
  // dev: the repo's git metadata (gitProtect), acceptance: a file outside the run root
  const protectedFile = join(home, "slackoff.db");
  const before = readFileSync(protectedFile, "utf8");
  const g = gitWorktree("t72");
  const gitHead = join(g.common, "HEAD");
  const headBefore = readFileSync(gitHead, "utf8");
  const userFile = join(userHome, "t72-notes.txt");
  writeFileSync(userFile, "NOTES\n");
  const env = { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome };
  for (const [name, base, scope, cwd] of [
    ["dev", cwdBase(), { ...devScope, gitProtect: [g.common] } as SandboxScope, join(home, "worktrees/K/api")],
    ["acceptance", cwdBase(), { kind: "acceptance", home, allowInHome: null, repos: [repoDir], runRoot: run } as SandboxScope, join(run, "work")],
  ] as const) {
    const wrapper = writeShellPrefix(join(root, `prefix-t72-${name}`), { ...scope, claudeTmp: base }, { shell: "/bin/zsh", homeDir: userHome });
    const cwdFile = `${base}a1b2-cwd`;
    const shape = `eval 'cd ${cwd} && echo hello' < /dev/null && pwd -P >| ${cwdFile}`;
    const first = await runProcess(wrapper, [shape], { env, timeoutMs: 30_000 });
    assert.equal(first.code, 0, `${name} new: ${first.stdout} ${first.stderr}`);
    assert.equal(readFileSync(cwdFile, "utf8").trim(), realpathSync(cwd), name);
    const again = await runProcess(wrapper, [shape], { env, timeoutMs: 30_000 });
    assert.equal(again.code, 0, `${name} existing: ${again.stderr}`);
    // the long form with a session suffix too
    assert.equal((await runProcess(wrapper, [`pwd -P >| ${base}beef-s_1-x-cwd`], { env, timeoutMs: 30_000 })).code, 0, name);
    for (const plant of [`ln -s ${protectedFile} ${base}1111-cwd`, `mkdir ${base}2222-cwd`, `mkfifo ${base}3333-cwd`, `ln ${protectedFile} ${base}4444-cwd`, `ln ${name === "dev" ? gitHead : userFile} ${base}5555-cwd`, `echo x > ${base}zzzz-cwd`, `echo x > ${base}a1b2-cwd.x`, `rm ${cwdFile}`, ...(name === "acceptance" ? [`cat ${cwdFile}`] : [])]) {
      const r = await runProcess(wrapper, [plant], { env, timeoutMs: 30_000 });
      assert.notEqual(r.code, 0, `${name}: ${plant} ran`);
      assert.match(r.stderr, /not permitted/i, `${name}: ${plant}: ${r.stderr}`);
    }
    for (const n of ["1111", "2222", "3333", "4444", "5555", "zzzz"]) assert.equal(existsSync(`${base}${n}-cwd`), false, `${name} ${n}`);
    assert.equal(readFileSync(protectedFile, "utf8"), before);
    assert.equal(readFileSync(userFile, "utf8"), "NOTES\n");
    assert.equal(readFileSync(gitHead, "utf8"), headBefore);
  }
});

test("T7-6: inside the acceptance sandbox no .git can be created under the run root (mkdir, file, rename, git init); .gitignore can", { skip }, async () => {
  const run = realpathSync(mkdtempSync(join(root, "run-t76-")));
  const work = join(run, "work");
  mkdirSync(join(work, "sub", "d"), { recursive: true });
  mkdirSync(join(run, "bin"));
  // 4A-9: <runRoot>/tmp is the platform's (made outside the sandbox, never created or replaced from inside)
  mkdirSync(join(run, "tmp"));
  for (const kind of ["acceptance", "acceptance-install"] as const) {
    const scope: SandboxScope = { kind, home, allowInHome: null, repos: [repoDir], runRoot: run };
    const sh = async (cmd: string) => {
      const { file, args } = sandboxArgvFor(scope, "/bin/sh", ["-c", cmd]);
      return runProcess(file, args, { cwd: work, timeoutMs: 30_000, env: { PATH: "/usr/bin:/bin", HOME: userHome } });
    };
    for (const cmd of [
      `mkdir ${work}/.git`, `echo x > ${work}/sub/.git`, `mv ${work}/sub/d ${work}/sub/.git`, `mkdir -p ${work}/a/.git/objects`, `ln -s /etc ${work}/.git`,
      `mkdir ${work}/sub/.git`, `mkdir ${run}/.git`, `echo x > ${run}/.git`,
    ]) {
      const r = await sh(cmd);
      assert.notEqual(r.code, 0, `${kind}: ${cmd}`);
      assert.match(r.stderr, /not permitted/i, `${kind}: ${cmd}: ${r.stderr}`);
    }
    const init = await sh(`/usr/bin/git init -q ${work}/repo`);
    assert.notEqual(init.code, 0, `${kind}: git init ${init.stderr}`);
    assert.equal(existsSync(join(work, "repo", ".git")), false);
    for (const p of [join(work, ".git"), join(work, "sub", ".git"), join(work, "a", ".git")]) assert.equal(existsSync(p), false, p);
    assert.equal((await sh(`echo node_modules > ${work}/.gitignore && mkdir -p ${work}/.github`)).code, 0, kind);
    // T7-7: a package manager may clone a git dependency into the run's caches or tmp
    const cache = await sh(`mkdir -p ${run}/cache/x/.git ${run}/tmp/dep/.git && rm -r ${run}/cache/x ${run}/tmp/dep`);
    assert.equal(cache.code, 0, `${kind}: ${cache.stderr}`);
    assert.equal(existsSync(join(run, ".git")), false);
    rmSync(join(work, ".gitignore"));
    rmSync(join(work, ".github"), { recursive: true });
  }
});

test("writeShellPrefix T7-6: with a pgid file the wrapper records its process group before running the command", { skip }, async () => {
  const run = realpathSync(mkdtempSync(join(root, "run-t76p-")));
  mkdirSync(join(run, "bin"));
  const dir = join(root, "prefix-t76p");
  const scope: SandboxScope = { kind: "acceptance", home, allowInHome: null, repos: [repoDir], runRoot: run };
  const wrapper = writeShellPrefix(dir, scope, { shell: "/bin/zsh", homeDir: userHome, pgidFile: join(dir, "pgids") });
  assert.ok(readFileSync(wrapper, "utf8").includes(join(dir, "pgids")));
  const env = { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome };
  // runProcess starts the wrapper as a group leader (as Claude Code does) and the sandboxed shell is the same process
  const r = await runProcess(wrapper, ["echo pgid=$$; echo lstart=$(/bin/ps -o lstart= -p $$ 2>/dev/null)"], { env, timeoutMs: 30_000 });
  assert.equal(r.code, 0, r.stderr);
  const recorded = readFileSync(join(dir, "pgids"), "utf8").trim().split("\n");
  assert.equal(recorded.length, 1);
  // T7-8: "<pid>\t<lstart>" — the leader's pid and its start time (ps lstart)
  const [pid, lstart] = recorded[0]!.split("\t");
  assert.match(r.stdout, new RegExp(`pgid=${pid}\\b`));
  assert.match(lstart ?? "", /^\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/, recorded[0] ?? "");
  // the record cannot be written → nothing runs
  const unwritable = writeShellPrefix(join(root, "prefix-t78-bad"), scope, { shell: "/bin/zsh", homeDir: userHome, pgidFile: join(root, "no-such-dir", "pgids") });
  const marker = join(run, "ran-without-record");
  const bad = await runProcess(unwritable, [`touch ${marker}`], { env, timeoutMs: 30_000 });
  assert.equal(bad.code, 126);
  assert.match(bad.stderr, /not run/);
  assert.equal(existsSync(marker), false);
  // the sandbox itself cannot write the file
  const w = await runProcess(wrapper, [`echo 1 >> ${join(dir, "pgids")}`], { env, timeoutMs: 30_000 });
  assert.notEqual(w.code, 0);
  assert.equal(readFileSync(join(dir, "pgids"), "utf8").trim().split("\n").length, 2, "only the wrapper's own line was added");
});

// ---------------------------------------------------------------- Task 7 fix round 2 (rulings T7-8, T7-9)

test("profile T7-9: dev kinds deny reads of the claude-* prefix too, before the platform's own allows and the cwd-file rule", () => {
  for (const scope of [devScope, installScope]) {
    const lines = sandboxProfile(scope).split("\n");
    const deny = lines.indexOf('(deny file-read* file-write* (prefix (param "CLAUDE_TMP")))');
    assert.ok(deny >= 0, scope.kind);
    assert.ok(!lines.includes('(deny file-write* (prefix (param "CLAUDE_TMP")))'), scope.kind);
    assert.ok(lines.indexOf('(allow file-read* (subpath (param "HOME_ALLOW")))') > deny, scope.kind);
    assert.ok(lines.indexOf(CWD_RULE) > deny, scope.kind);
  }
});

test("dev-command T7-9: another session's claude-* file (stand-in) is unreadable; the worktree stays readable; the cwd file still writable", { skip }, async () => {
  const base = cwdBase();
  mkdirSync(`${base}other`, { recursive: true });
  writeFileSync(`${base}other/tail.txt`, "OTHER-SESSION\n");
  writeFileSync(`${base}0123-cwd`, "/somewhere\n");
  const wt = join(home, "worktrees/K/api");
  writeFileSync(join(wt, "own.txt"), "OWN\n");
  const wrapper = writeShellPrefix(join(root, "prefix-t79"), { ...devScope, claudeTmp: base }, { shell: "/bin/zsh", homeDir: userHome });
  const env = { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome };
  for (const f of [`${base}other/tail.txt`, `${base}0123-cwd`]) {
    const r = await runProcess(wrapper, [`cat ${f}`], { env, timeoutMs: 30_000 });
    assert.notEqual(r.code, 0, f);
    assert.match(r.stderr, /not permitted/i, f);
    assert.doesNotMatch(r.stdout, /OTHER-SESSION|somewhere/);
  }
  const ls = await runProcess(wrapper, [`ls ${base}other`], { env, timeoutMs: 30_000 });
  assert.notEqual(ls.code, 0);
  const own = await runProcess(wrapper, [`cd ${wt} && cat own.txt && pwd -P >| ${base}4567-cwd`], { env, timeoutMs: 30_000 });
  assert.equal(own.code, 0, own.stderr);
  assert.match(own.stdout, /OWN/);
});

// ---------------------------------------------------------------- final fix pass (F-3, F-4 M-2 / M-3)

const KEYCHAIN_DENY_LINE =
  '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name-prefix "com.apple.securityd.") (global-name-prefix "com.apple.security.agent") (global-name "com.apple.security.KeychainStasher") (global-name "com.apple.security.kcsharing") (global-name "com.apple.security.octagon") (global-name "com.apple.security.cloudkeychainproxy3") (global-name "com.apple.keychainsharingmessagingd"))';

test("profile F-3: every kind denies mach-lookup to the keychain daemons (securityd, SecurityServer), next to the LaunchServices deny; trustd stays reachable", () => {
  for (const scope of ALL_SCOPES) {
    const lines = sandboxProfile(scope).split("\n");
    const i = lines.indexOf(KEYCHAIN_DENY_LINE);
    assert.ok(i > 0, `${scope.kind}: ${lines.join("\n")}`);
    assert.ok(lines[i - 1]!.startsWith('(deny mach-lookup (global-name-prefix "com.apple.coreservices.")'), scope.kind);
    // certificate trust (TLS) goes through trustd: never denied
    assert.ok(!lines.join("\n").includes("com.apple.trustd"), scope.kind);
    assert.ok(profileDeniesKeychain(lines.join("\n")), scope.kind);
  }
});

test("self-check F-3: the keychain deny is checked on the profile text (a profile without it fails); runtime not probed", () => {
  const p = sandboxProfile(devScope);
  assert.equal(profileDeniesKeychain(p), true);
  assert.equal(profileDeniesKeychain(p.replace(KEYCHAIN_DENY_LINE + "\n", "")), false);
  assert.equal(profileDeniesKeychain(p.replace('(global-name "com.apple.securityd.xpc") ', "")), false);
  assert.equal(profileDeniesKeychain(p.replace('(global-name "com.apple.SecurityServer") ', "")), false);
});

test("sandboxSelfCheck F-3: the detail reports the keychain deny as profile-checked (runtime not probed)", { skip }, async () => {
  for (const scope of [devScope, acceptScope]) {
    const c = await sandboxSelfCheck(scope);
    assert.equal(c.ok, true, `${scope.kind}: ${c.detail}`);
    assert.match(c.detail, /keychain:DENIED-IN-PROFILE \(runtime not probed\)/);
  }
});

test("profile F-4 (M-2): dev kinds deny ~/.claude.json* (resolved and as named) for reads and writes; ~/.claude is not denied", () => {
  for (const scope of [devScope, installScope]) {
    const p = sandboxProfile(scope);
    assert.ok(p.includes('(deny file-read* file-write* (prefix (param "HOME_CLAUDE_JSON")) (prefix (param "HOME_CLAUDE_JSON_NAME")))'), p);
    assert.ok(!p.includes('(param "HOME_CLAUDE")') && !p.includes('"HOME_CLAUDE_DIR"'), "~/.claude stays readable for dev kinds");
    const params = sandboxParams(scope, userHome).filter((_, i, a) => i % 2 === 1);
    assert.ok(params.includes(`HOME_CLAUDE_JSON_NAME=${join(realpathSync(userHome), ".claude.json")}`), params.join("\n"));
  }
});

test("dev F-4 (M-2): ~/.claude.json and its backups are unreadable, also through a symlink; ~/.claude stays readable", { skip }, async () => {
  const fakeHome = join(root, "user-m2");
  const elsewhere = join(root, "m2-claude-json-target");
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  writeFileSync(join(fakeHome, ".claude/settings.json"), "{}");
  writeFileSync(elsewhere, "{}");
  symlinkSync(elsewhere, join(fakeHome, ".claude.json"));
  writeFileSync(join(fakeHome, ".claude.json.backup"), "{}");
  for (const kind of ["dev-command", "dev-install"] as const) {
    const scope: SandboxScope = { ...devScope, kind };
    const ops = [
      ["json", "read", join(fakeHome, ".claude.json")],
      ["backup", "read", join(fakeHome, ".claude.json.backup")],
      ["target", "read", elsewhere],
      ["dir", "read", join(fakeHome, ".claude/settings.json")],
    ];
    const r = await runProcess(...argvOf(sandboxArgvFor(scope, process.execPath, ["-e", TRY_ALL, JSON.stringify(ops)], fakeHome)), { cwd: work, timeoutMs: 20_000 });
    assert.equal(r.stdout.trim(), "json:EPERM backup:EPERM target:EPERM dir:OK", `${kind}: ${r.stdout} ${r.stderr}`);
  }
});

test("F-4 (M-3): a scope's Tailscale address is probed by the self-check (connect to <ip>:4317, EPERM) — args only, never connected here", () => {
  const ip = "100.101.102.103";
  for (const scope of [devScope, acceptScope]) {
    const s: SandboxScope = { ...scope, remoteHosts: [ip] };
    const wrapper = writeShellPrefix(join(root, `prefix-m3-${scope.kind}`), s, { shell: "/bin/zsh", homeDir: userHome });
    const text = readFileSync(wrapper, "utf8");
    assert.ok(text.includes(`'--remote' '${ip}:4317'`), text);
    // the profile already denies every host on 4317; the address is not in it (a param-free profile)
    assert.equal(sandboxProfile(s), sandboxProfile(scope));
    const plain = readFileSync(writeShellPrefix(join(root, `prefix-m3p-${scope.kind}`), scope, { shell: "/bin/zsh", homeDir: userHome }), "utf8");
    assert.ok(!plain.includes("--remote"), "no address: no remote probe");
  }
  assert.throws(() => sandboxProfile({ ...devScope, remoteHosts: ["192.168.1.5"] }), SandboxUnavailableError);
  assert.throws(() => sandboxProfile({ ...devScope, remoteHosts: ["100.64.0.1; rm -rf"] }), SandboxUnavailableError);
});

test("selfcheck.mjs F-4 (M-3): --remote <ip>:<port> must be EPERM — any other result fails the check (unsandboxed: the test's own listener)", async () => {
  // never a real address: the test's own loopback listener (CONNECTED outside the sandbox → the check fails)
  const l = await listen("127.0.0.1");
  try {
    const r = await runProcess(process.execPath, [SELF_CHECK_SCRIPT, join(home, "slackoff.db"), String(l.port), "--remote", `127.0.0.1:${l.port}`], { timeoutMs: 15_000 });
    assert.equal(r.code, 1);
    assert.match(r.stdout, new RegExp(`remote0:127\\.0\\.0\\.1:${l.port}:CONNECTED`));
    const bad = await runProcess(process.execPath, [SELF_CHECK_SCRIPT, join(home, "slackoff.db"), String(l.port), "--remote", "not-an-address"], { timeoutMs: 15_000 });
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /remote0:BADADDR/);
  } finally {
    await new Promise<void>((res) => l.server.close(() => res()));
  }
});

// ---------------------------------------------------------------- phase 4a Task 2: the dev-hook profile

const HOOK_FIXTURES = join(import.meta.dirname, "fixtures/hooks");
/** git for hook-test setup: a scratch HOME, never the developer's global or system config */
const HOOK_GIT_ENV = {
  ...process.env, HOME: userHome, XDG_CONFIG_HOME: join(userHome, ".config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};
const hg = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: HOOK_GIT_ENV }).trim();

/** A repo (identity in its own config) with a linked platform worktree in home/worktrees/K/<name>, and its git dirs. */
function hookRepo(name: string, parent = join(root, "hookgit")): { main: string; wt: string; gitDirs: { common: string; admin: string; branch: string } } {
  const main = join(parent, name);
  mkdirSync(main, { recursive: true });
  hg(main, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) hg(main, "config", k!, v!);
  writeFileSync(join(main, "a.js"), "a\n");
  writeFileSync(join(main, "b.js"), "b\n");
  hg(main, "add", "-A");
  hg(main, "commit", "-q", "-m", "init");
  const wt = join(home, "worktrees/K", name);
  hg(main, "worktree", "add", "-q", "-b", `slackoff/K-${name}`, wt);
  const common = realpathSync(join(main, ".git"));
  return { main, wt, gitDirs: { common, admin: realpathSync(join(common, "worktrees", name)), branch: `refs/heads/slackoff/K-${name}` } };
}

/** The env a hook gets inside the dev-hook sandbox in these tests (scratch HOME, the ticket's TMPDIR and caches). */
const hookEnv = (scope: SandboxScope) => sandboxEnv(scope, { PATH: process.env.PATH, HOME: userHome, XDG_CONFIG_HOME: join(userHome, ".config"), LANG: "C" });

test("profile 4a T2: dev-hook — paths only as params (COMMON_GIT, ADMIN_GIT); gitDirs required, gitProtect refused, gitDirs only for dev-hook", () => {
  const r = hookRepo("hprof");
  const scope = hookScope(home, "K", r.wt, r.gitDirs, []);
  assert.equal(scope.kind, "dev-hook");
  assert.deepEqual(scope.writable, [r.wt]);
  assert.equal(scope.allowInHome, join(home, "worktrees/K"));
  const p = sandboxProfile(scope);
  assert.ok(!p.includes("/"), `no absolute path in the profile: ${p}`);
  assert.ok(p.includes('(param "COMMON_GIT') && p.includes('(param "ADMIN_GIT")'), p);
  const params = sandboxParams(scope, userHome);
  assert.ok(params.includes(`COMMON_GIT=${r.gitDirs.common}`) && params.includes(`ADMIN_GIT=${r.gitDirs.admin}`), params.join(" "));
  // read / port / socket / LaunchServices / keychain rules exactly as dev-command
  const dev = sandboxProfile({ ...devScope, writable: [r.wt] });
  // (dev-command ends with five dev rules and the phase 4b credentials-file pin, two lines)
  assert.ok(p.startsWith(dev.trimEnd().split("\n").slice(0, -7).join("\n")), "dev-command's rules come first, unchanged");
  // the git-dir allows come after every dev-command rule; the denies after them (later rule wins)
  const allow = p.indexOf('(allow file-write* (subpath (param "COMMON_GIT_OBJECTS"))');
  const allowUnlink = p.indexOf('(allow file-write-unlink (subpath (param "COMMON_GIT_OBJECTS"))');
  const deny = p.indexOf('(deny file-write* (literal (param "COMMON_GIT_CONFIG"))');
  const denyUnlink = p.indexOf('(deny file-write-unlink (literal (param "COMMON_GIT_CONFIG"))');
  assert.ok(allow > p.indexOf('(param "XCRUN_DB_0")') && allowUnlink > allow && deny > allowUnlink && denyUnlink > deny, p);
  // the rest of the common dir is denied first (a repo in a temp dir the dev rules allow), for unlink too
  const denyCommon = p.indexOf('(deny file-write* (subpath (param "COMMON_GIT")))\n(deny file-write-unlink (subpath (param "COMMON_GIT")))\n');
  assert.ok(denyCommon > 0 && denyCommon < allow, p);
  for (const n of ["COMMON_GIT_HOOKS", "COMMON_GIT_INFO", "ADMIN_GIT_COMMONDIR", "ADMIN_GIT_GITDIR", "ADMIN_GIT_CONFIG_WORKTREE", "WT_DOTGIT_0"]) {
    assert.ok(p.slice(deny).includes(`(param "${n}")`) && p.slice(denyUnlink).includes(`(param "${n}")`), n);
  }
  assert.ok(p.slice(denyUnlink).includes('(literal (param "ADMIN_GIT"))'), "the admin dir itself is not moved away");
  const { gitDirs: _g, ...noDirs } = scope;
  assert.throws(() => sandboxProfile(noDirs), SandboxUnavailableError);
  assert.throws(() => sandboxProfile({ ...scope, gitProtect: [r.gitDirs.common] }), SandboxUnavailableError);
  assert.throws(() => sandboxProfile({ ...devScope, gitDirs: r.gitDirs }), SandboxUnavailableError);
  assert.throws(() => sandboxProfile({ ...scope, gitDirs: { ...r.gitDirs, admin: join(r.gitDirs.common, "elsewhere") } }), SandboxUnavailableError);
  for (const bad of [root, join(home, "worktrees/K/x/.git"), join(home, "sandbox/K/.git"), join(home, "cache/K/.git")]) {
    assert.throws(() => sandboxProfile({ ...scope, gitDirs: { common: bad, admin: join(bad, "worktrees/y"), branch: "refs/heads/slackoff/K-y" } }), SandboxUnavailableError, bad);
  }
  // fake mode keeps its repos in SLACKOFF_HOME/fake-repos: allowed, and readable again after the SLACKOFF_HOME deny
  const pf = sandboxProfile({ ...scope, gitDirs: { common: join(home, "fake-repos/web/.git"), admin: join(home, "fake-repos/web/.git/worktrees/y"), branch: "refs/heads/slackoff/K-y" } });
  assert.ok(pf.indexOf('(allow file-read* (subpath (param "COMMON_GIT")))') > pf.indexOf('(subpath (param "SLACKOFF_HOME")))'), pf);
});

test("profile 4a T2: dev-command and dev-install profiles are unchanged but for the 4A-3 worktree-root deny (snapshot)", () => {
  // variable-length param lists (temp dirs, home ancestors) are normalised; everything else is compared verbatim
  const norm = (p: string) =>
    p
      .replace(/\(param "(TMP|HOME_UP|HOME_ALLOW_UP|WRITE|XCRUN_DB|GIT)_\d+"\)/g, '(param "$1_n")')
      .replace(/(\((?:literal|subpath) \(param "[A-Z_]+_n"\)\))(?: \1)+/g, "$1");
  const h = "/h/slackoff";
  const got = (["dev-command", "dev-install"] as const)
    .map((kind) => `;; ${kind}\n` + norm(sandboxProfile({ kind, home: h, allowInHome: `${h}/worktrees/K`, repos: [], writable: [`${h}/worktrees/K/a`, `${h}/worktrees/K/b`], gitProtect: ["/r/.git", `${h}/worktrees/K/a/.git`] })))
    .join("");
  assert.equal(got, readFileSync(join(import.meta.dirname, "fixtures/dev-profiles.sb"), "utf8"));
});

test("dev-hook 4a T2: a lint-staged-style hook (stash, index, git-dir temp files) works; the staged rewrite lands in the index", { skip }, async () => {
  const r = hookRepo("hlint");
  writeFileSync(join(r.wt, "a.js"), "a\nstaged\n");
  hg(r.wt, "add", "a.js");
  writeFileSync(join(r.wt, "b.js"), "b\nunstaged\n");
  const scope = hookScope(home, "K", r.wt, r.gitDirs, []);
  const { file, args } = sandboxArgvFor(scope, "/bin/sh", [join(HOOK_FIXTURES, "fake-lint-staged.sh")]);
  const run = await runProcess(file, args, { cwd: r.wt, env: hookEnv(scope), timeoutMs: 60_000 });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /fake-lint-staged: ok/);
  // 4A-8: packed-refs is not writable, so dropping the last stash entry cannot delete refs/stash (git locks
  // packed-refs for a deletion): git says so, the hook still succeeds, the stash list is empty. Nothing else is denied.
  const denied = run.stderr.split("\n").filter((l) => /Unable to create|Operation not permitted/.test(l));
  assert.ok(denied.every((l) => /packed-refs\.lock': Operation not permitted$/.test(l)), run.stderr);
  assert.equal(hg(r.wt, "show", ":a.js"), "a\nstaged\n/* formatted */", "the formatted file is staged");
  assert.equal(readFileSync(join(r.wt, "b.js"), "utf8"), "b\nunstaged\n", "the unstaged change is kept");
  assert.equal(hg(r.wt, "diff", "--name-only"), "b.js");
  assert.equal(hg(r.wt, "stash", "list"), "", "the backup stash is dropped");
});

test("dev-hook 4a T2: git config, hooks, info, the worktree's .git pointer and the admin links are EPERM; Slack Off, credentials and the DB too", { skip }, async () => {
  const r = hookRepo("hdeny");
  const scope = hookScope(home, "K", r.wt, r.gitDirs, []);
  const { common, admin } = r.gitDirs;
  mkdirSync(join(common, "info"), { recursive: true });
  const code = `
    const fs = require("node:fs"); const net = require("node:net"); const out = [];
    const t = (label, fn) => { try { fn(); out.push(label + ":OK"); } catch (e) { out.push(label + ":" + e.code); } };
    t("config", () => fs.appendFileSync(${JSON.stringify(join(common, "config"))}, "[core]\\n\\tfsmonitor = /tmp/x\\n"));
    t("hooks", () => fs.writeFileSync(${JSON.stringify(join(common, "hooks/post-commit"))}, "#!/bin/sh\\n", { flag: "wx" }));
    t("info", () => fs.writeFileSync(${JSON.stringify(join(common, "info/attributes"))}, "* filter=x\\n", { flag: "wx" }));
    t("rootfile", () => fs.writeFileSync(${JSON.stringify(join(common, "FOO"))}, "x", { flag: "wx" }));
    t("HEAD", () => fs.appendFileSync(${JSON.stringify(join(common, "HEAD"))}, ""));
    t("pointer", () => fs.appendFileSync(${JSON.stringify(join(r.wt, ".git"))}, "\\n"));
    t("pointermv", () => fs.renameSync(${JSON.stringify(join(r.wt, ".git"))}, ${JSON.stringify(join(r.wt, ".git.x"))}));
    t("commondir", () => fs.appendFileSync(${JSON.stringify(join(admin, "commondir"))}, ""));
    t("gitdir", () => fs.appendFileSync(${JSON.stringify(join(admin, "gitdir"))}, ""));
    t("cfgwt", () => fs.writeFileSync(${JSON.stringify(join(admin, "config.worktree"))}, "[core]\\n", { flag: "wx" }));
    t("cfgwtmv", () => { fs.writeFileSync(${JSON.stringify(join(admin, "cw.tmp"))}, "[core]\\n"); try { fs.renameSync(${JSON.stringify(join(admin, "cw.tmp"))}, ${JSON.stringify(join(admin, "config.worktree"))}); } finally { try { fs.unlinkSync(${JSON.stringify(join(admin, "cw.tmp"))}); } catch {} } });
    t("adminmv", () => fs.renameSync(${JSON.stringify(admin)}, ${JSON.stringify(admin + ".x")}));
    t("configmv", () => fs.renameSync(${JSON.stringify(join(common, "config"))}, ${JSON.stringify(join(common, "objects/cfg"))}));
    t("admin", () => { fs.writeFileSync(${JSON.stringify(join(admin, "probe"))}, "x"); fs.unlinkSync(${JSON.stringify(join(admin, "probe"))}); });
    t("objects", () => { fs.writeFileSync(${JSON.stringify(join(common, "objects/probe"))}, "x"); fs.unlinkSync(${JSON.stringify(join(common, "objects/probe"))}); });
    t("ssh", () => fs.readFileSync(${JSON.stringify(join(userHome, ".ssh/id"))}));
    t("db", () => fs.readFileSync(${JSON.stringify(join(home, "slackoff.db"))}));
    const s = net.connect({ host: "127.0.0.1", port: 4317 });
    s.setTimeout(3000, () => { out.push("4317:TIMEOUT"); s.destroy(); fin(); });
    s.on("connect", () => { out.push("4317:CONNECTED"); s.destroy(); fin(); });
    s.on("error", (e) => { out.push("4317:" + e.code); fin(); });
    function fin() { console.log(out.join(" ")); }`;
  const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code]);
  const before = readFileSync(join(common, "config"), "utf8");
  const run = await runProcess(file, args, { cwd: r.wt, env: hookEnv(scope), timeoutMs: 20_000 });
  const got = new Map(run.stdout.trim().split(" ").map((x) => x.split(":") as [string, string]));
  for (const k of ["config", "hooks", "info", "rootfile", "HEAD", "pointer", "pointermv", "commondir", "gitdir", "cfgwt", "cfgwtmv", "adminmv", "configmv", "ssh", "db", "4317"]) {
    assert.equal(got.get(k), "EPERM", `${k}: ${run.stdout} ${run.stderr}`);
  }
  assert.equal(got.get("admin"), "OK", run.stdout);
  assert.equal(got.get("objects"), "OK", run.stdout);
  assert.equal(readFileSync(join(common, "config"), "utf8"), before);
  assert.ok(existsSync(admin) && existsSync(join(r.wt, ".git")) && !existsSync(join(admin, "config.worktree")));
});

test("dev-hook 4a T2: a repo inside SLACKOFF_HOME (fake mode's fake-repos/) — git in the hook reads it; the rest of SLACKOFF_HOME stays denied", { skip }, async () => {
  const r = hookRepo("hfake", join(home, "fake-repos"));
  writeFileSync(join(r.wt, "a.js"), "a\nTODO\n");
  hg(r.wt, "add", "a.js");
  const scope = hookScope(home, "K", r.wt, r.gitDirs, []);
  const { file, args } = sandboxArgvFor(scope, "/bin/sh", ["-c", `git diff --cached --name-only; echo "rc=$?"; cat ${JSON.stringify(join(home, "slackoff.db"))} 2>&1; cat ${JSON.stringify(join(r.main, "a.js"))} 2>&1`]);
  const run = await runProcess(file, args, { cwd: r.wt, env: hookEnv(scope), timeoutMs: 20_000 });
  assert.match(run.stdout, /^a\.js\nrc=0\n/, run.stdout + run.stderr);
  assert.equal((run.stdout.match(/Operation not permitted/g) ?? []).length, 2, `the DB and the main checkout stay denied: ${run.stdout}`);
});

test("sandboxSelfCheck 4a T2: dev-hook also proves the admin dir is writable and the common config is not", { skip }, async () => {
  const r = hookRepo("hcheck");
  const c = await sandboxSelfCheck(hookScope(home, "K", r.wt, r.gitDirs, []));
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /gitadmin:OK/);
  assert.match(c.detail, /gitconfig:EPERM/);
  assert.match(c.detail, /4317:EPERM/);
  assert.deepEqual(readdirSync(r.gitDirs.admin).filter((n) => n.startsWith("slackoff-sc-")), [], "the probe file is removed");
  // the same probes on dev-command (no git-dir allow) fail closed: the admin dir is not writable there
  const d = await sandboxSelfCheck({ ...devScope, writable: [r.wt], gitProtect: [r.gitDirs.common, join(r.wt, ".git")] });
  assert.ok(!/gitadmin/.test(d.detail), "dev-command has no git-dir probes");
});

test("selfcheck.mjs 4a T2: --git-config writable (no sandbox) fails the check without changing the file; --git-admin unwritable fails too", async () => {
  const d = mkdtempSync(join(root, "sc-git-"));
  writeFileSync(join(d, "config"), "[core]\n");
  const r = await runProcess(process.execPath, [SELF_CHECK_SCRIPT, join(home, "slackoff.db"), "1", "--git-config", join(d, "config"), "--git-admin", join(d, "missing")], { timeoutMs: 15_000 });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /gitconfig:WRITABLE/);
  assert.match(r.stdout, /gitadmin:ENOENT/);
  assert.equal(readFileSync(join(d, "config"), "utf8"), "[core]\n");
});

// ---------------------------------------------------------------- phase 4a fix round 1 (rulings 4A-3, 4A-5, 4A-7)

/** renameatx_np(RENAME_SWAP) through perl (no compiler, no xcrun shim): prints "0" or the errno text */
const SWAP = `my $r = syscall(488, -2, $ARGV[0], -2, $ARGV[1], 2); print $r == 0 ? "OK" : ($!{EPERM} ? "EPERM" : "ERR:" . ($! + 0));`;

test("4A-3: every dev kind denies renaming the worktree root (into the ticket cache), renaming its parent and swapping a dir with it", { skip }, async () => {
  const r = hookRepo("hroot");
  const base: SandboxScope = { ...devScope, writable: [r.wt] };
  const scopes: SandboxScope[] = [
    { ...base, kind: "dev-command", gitProtect: [r.gitDirs.common, join(r.wt, ".git")] },
    { ...base, kind: "dev-install", gitProtect: [r.gitDirs.common, join(r.wt, ".git")] },
    hookScope(home, "K", r.wt, r.gitDirs, []),
  ];
  for (const scope of scopes) {
    const p = sandboxProfile(scope);
    const last = p.lastIndexOf('(allow file-write');
    const deny = p.indexOf('(deny file-write-unlink (literal (param "WRITE_0"))');
    assert.ok(deny > last && p.indexOf('(deny file-write* (literal (param "WRITE_0"))') > last, `${scope.kind}: the root deny comes after every write allow\n${p}`);
    const cache = ticketCacheDir(scope);
    mkdirSync(join(cache, "swapdir"), { recursive: true });
    const tdir = join(home, "worktrees/K");
    const sh = `mv ${JSON.stringify(r.wt)} ${JSON.stringify(join(cache, "wtx"))} 2>/dev/null && echo mv:OK || echo mv:DENIED; ` +
      `mv ${JSON.stringify(tdir)} ${JSON.stringify(join(cache, "kx"))} 2>/dev/null && echo parent:OK || echo parent:DENIED; ` +
      `echo "swap:$(/usr/bin/perl -e '${SWAP}' ${JSON.stringify(join(cache, "swapdir"))} ${JSON.stringify(r.wt)})"; ` +
      `echo x > ${JSON.stringify(join(r.wt, "inside.txt"))} && echo inside:OK; ` +
      // phase 4a Task 7 item 1 (done by 4A-3): files inside the worktree are still removed and renamed as usual
      `mv ${JSON.stringify(join(r.wt, "inside.txt"))} ${JSON.stringify(join(r.wt, "moved.txt"))} && rm ${JSON.stringify(join(r.wt, "moved.txt"))} && echo rm:OK`;
    const { file, args } = sandboxArgvFor(scope, "/bin/sh", ["-c", sh]);
    const run = await runProcess(file, args, { cwd: work, env: hookEnv(scope), timeoutMs: 20_000 });
    assert.equal(run.stdout.trim(), "mv:DENIED\nparent:DENIED\nswap:EPERM\ninside:OK\nrm:OK", `${scope.kind}: ${run.stdout} ${run.stderr}`);
    assert.ok(existsSync(join(r.wt, ".git")) && existsSync(join(r.wt, "a.js")), `${scope.kind}: the worktree is still in place`);
  }
});

test("4A-5: a hook cannot move objects/, refs/ or logs/ away, nor write another branch; its own branch, the stash and objects stay writable", { skip }, async () => {
  const r = hookRepo("hrefs");
  const scope = hookScope(home, "K", r.wt, r.gitDirs, []);
  const { common } = r.gitDirs;
  const own = join(common, r.gitDirs.branch);
  const code = `
    const fs = require("node:fs"); const out = [];
    const t = (l, fn) => { try { fn(); out.push(l + ":OK"); } catch (e) { out.push(l + ":" + e.code); } };
    for (const d of ["objects", "refs", "logs"]) t("mv" + d, () => fs.renameSync(${JSON.stringify(common)} + "/" + d, ${JSON.stringify(r.wt)} + "/" + d));
    t("main", () => fs.writeFileSync(${JSON.stringify(join(common, "refs/heads/main"))}, "0".repeat(40) + "\\n"));
    t("mainlock", () => fs.writeFileSync(${JSON.stringify(join(common, "refs/heads/main.lock"))}, "x", { flag: "wx" }));
    t("newbranch", () => fs.writeFileSync(${JSON.stringify(join(common, "refs/heads/evil"))}, "x", { flag: "wx" }));
    t("tag", () => fs.writeFileSync(${JSON.stringify(join(common, "refs/tags/v1"))}, "x", { flag: "wx" }));
    t("mainlog", () => fs.appendFileSync(${JSON.stringify(join(common, "logs/refs/heads/main"))}, "x"));
    t("own", () => { const v = fs.readFileSync(${JSON.stringify(own)}); fs.writeFileSync(${JSON.stringify(own + ".lock")}, v); fs.renameSync(${JSON.stringify(own + ".lock")}, ${JSON.stringify(own)}); });
    t("ownlog", () => fs.appendFileSync(${JSON.stringify(join(common, "logs", r.gitDirs.branch))}, ""));
    t("stash", () => { fs.writeFileSync(${JSON.stringify(join(common, "refs/stash.lock"))}, "x"); fs.unlinkSync(${JSON.stringify(join(common, "refs/stash.lock"))}); });
    t("objects", () => { fs.mkdirSync(${JSON.stringify(join(common, "objects/zz"))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(join(common, "objects/zz/p"))}, "x"); fs.unlinkSync(${JSON.stringify(join(common, "objects/zz/p"))}); fs.rmdirSync(${JSON.stringify(join(common, "objects/zz"))}); });
    console.log(out.join(" "));`;
  const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code]);
  const mainBefore = readFileSync(join(common, "refs/heads/main"), "utf8");
  const run = await runProcess(file, args, { cwd: r.wt, env: hookEnv(scope), timeoutMs: 20_000 });
  const got = new Map(run.stdout.trim().split(" ").map((x) => x.split(":") as [string, string]));
  for (const k of ["mvobjects", "mvrefs", "mvlogs", "main", "mainlock", "newbranch", "tag", "mainlog"]) assert.equal(got.get(k), "EPERM", `${k}: ${run.stdout} ${run.stderr}`);
  for (const k of ["own", "ownlog", "stash", "objects"]) assert.equal(got.get(k), "OK", `${k}: ${run.stdout} ${run.stderr}`);
  assert.equal(readFileSync(join(common, "refs/heads/main"), "utf8"), mainBefore);
});

test("4A-7: the COMMON_GIT read re-allow is only in the profile when the common dir lies inside SLACKOFF_HOME", () => {
  const out = hookRepo("hread");
  const pOut = sandboxProfile(hookScope(home, "K", out.wt, out.gitDirs, []));
  assert.ok(!pOut.includes('(allow file-read* (subpath (param "COMMON_GIT")))'), pOut);
  const inside = { common: join(home, "fake-repos/x/.git"), admin: join(home, "fake-repos/x/.git/worktrees/y"), branch: "refs/heads/slackoff/b" };
  const pIn = sandboxProfile(hookScope(home, "K", out.wt, inside, []));
  assert.ok(pIn.includes('(allow file-read* (subpath (param "COMMON_GIT")))'), pIn);
});

test("4A-8: a hook cannot rewrite another branch through packed-refs (lock + rename, or in place)", { skip }, async () => {
  const r = hookRepo("hpacked");
  hg(r.main, "pack-refs", "--all");
  const { common } = r.gitDirs;
  const packed = join(common, "packed-refs");
  const before = readFileSync(packed, "utf8");
  assert.match(before, /refs\/heads\/main/);
  const scope = hookScope(home, "K", r.wt, r.gitDirs, []);
  const forged = before.replace(/^[0-9a-f]{40} refs\/heads\/main$/m, `${"1".repeat(40)} refs/heads/main`);
  const code = `
    const fs = require("node:fs"); const out = [];
    const t = (l, fn) => { try { fn(); out.push(l + ":OK"); } catch (e) { out.push(l + ":" + e.code); } };
    t("lock", () => { fs.writeFileSync(${JSON.stringify(packed + ".lock")}, ${JSON.stringify(forged)}, { flag: "wx" }); fs.renameSync(${JSON.stringify(packed + ".lock")}, ${JSON.stringify(packed)}); });
    t("inplace", () => fs.writeFileSync(${JSON.stringify(packed)}, ${JSON.stringify(forged)}));
    console.log(out.join(" "));`;
  const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code]);
  const run = await runProcess(file, args, { cwd: r.wt, env: hookEnv(scope), timeoutMs: 20_000 });
  assert.equal(run.stdout.trim(), "lock:EPERM inplace:EPERM", run.stdout + run.stderr);
  assert.equal(readFileSync(packed, "utf8"), before);
  assert.ok(!existsSync(packed + ".lock"));
});

// ---------------------------------------------------------------- phase 4a final fix (rulings F4A-1, F4A-2)

test("F4A-1 (C-A): a hook adds objects but cannot replace, delete, chmod or plant over existing ones, nor write packs or objects/info; main's config blob stays", { skip }, async () => {
  const r = hookRepo("hobjects");
  mkdirSync(join(r.main, ".slackoff"));
  writeFileSync(join(r.main, ".slackoff/config.json"), '{"real":true}\n');
  hg(r.main, "add", "-A");
  hg(r.main, "commit", "-q", "-m", "rules");
  // one pack (and its idx) next to the loose objects
  hg(r.main, "repack", "-q");
  const { common } = r.gitDirs;
  const blob = hg(r.main, "rev-parse", "main:.slackoff/config.json");
  const obj = join(common, "objects", blob.slice(0, 2), blob.slice(2));
  assert.ok(existsSync(obj), "the blob is loose");
  const pack = readdirSync(join(common, "objects/pack")).find((n) => n.endsWith(".pack"))!;
  assert.ok(pack, "a pack exists");
  const scope = hookScope(home, "K", r.wt, r.gitDirs, []);
  const forged = '{"forged":true}\n';
  const code = `
    const fs = require("node:fs"); const cp = require("node:child_process"); const out = [];
    const t = (l, fn) => { try { fn(); out.push(l + ":OK"); } catch (e) { out.push(l + ":" + (e.code ?? e.status)); } };
    const obj = ${JSON.stringify(obj)}; const dir = ${JSON.stringify(dirname(obj))};
    let fake = "";
    t("hashw", () => { fake = cp.execFileSync("git", ["hash-object", "-w", "--stdin"], { input: ${JSON.stringify(forged)}, encoding: "utf8" }).trim(); });
    const fakePath = fake ? ${JSON.stringify(join(common, "objects"))} + "/" + fake.slice(0, 2) + "/" + fake.slice(2) : "/nonexistent";
    t("rm", () => fs.unlinkSync(obj));
    t("chmod", () => fs.chmodSync(obj, 0o644));
    t("data", () => fs.writeFileSync(obj, "x"));
    t("renameover", () => { fs.writeFileSync(dir + "/tmp_obj_x", fs.readFileSync(fakePath)); try { fs.renameSync(dir + "/tmp_obj_x", obj); } finally { try { fs.unlinkSync(dir + "/tmp_obj_x"); } catch {} } });
    t("linkover", () => fs.linkSync(fakePath, obj));
    t("mvfanout", () => fs.renameSync(dir, dir + ".x"));
    t("plant", () => { fs.mkdirSync(${JSON.stringify(join(common, "objects/ee"))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(join(common, "objects/ee", "e".repeat(38)))}, "x", { flag: "wx" }); });
    t("alternates", () => fs.writeFileSync(${JSON.stringify(join(common, "objects/info/alternates"))}, "/tmp\\n"));
    t("commitgraph", () => fs.writeFileSync(${JSON.stringify(join(common, "objects/info/commit-graph"))}, "x"));
    t("packnew", () => fs.writeFileSync(${JSON.stringify(join(common, "objects/pack/pack-x.pack"))}, "x", { flag: "wx" }));
    t("packrm", () => fs.unlinkSync(${JSON.stringify(join(common, "objects/pack", pack))}));
    t("mvpack", () => fs.renameSync(${JSON.stringify(join(common, "objects/pack"))}, ${JSON.stringify(join(common, "objects/pack.x"))}));
    t("mvinfo", () => fs.renameSync(${JSON.stringify(join(common, "objects/info"))}, ${JSON.stringify(join(common, "objects/info.x"))}));
    console.log(out.join(" "));`;
  const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code]);
  const run = await runProcess(file, args, { cwd: r.wt, env: hookEnv(scope), timeoutMs: 30_000 });
  const got = new Map(run.stdout.trim().split(" ").map((x) => x.split(":") as [string, string]));
  assert.equal(got.get("hashw"), "OK", `a hook still adds objects: ${run.stdout} ${run.stderr}`);
  for (const k of ["rm", "chmod", "renameover", "mvfanout", "alternates", "commitgraph", "packnew", "packrm", "mvpack", "mvinfo"]) {
    assert.equal(got.get(k), "EPERM", `${k}: ${run.stdout} ${run.stderr}`);
  }
  // residual (documented): a NEW loose-object name may still be created with any content (git itself writes a tmp file
  // and links it to its name); only names that do not exist yet
  assert.equal(got.get("plant"), "OK", run.stdout);
  // link(2) never replaces a name
  assert.ok(["EPERM", "EEXIST"].includes(got.get("linkover")!), run.stdout);
  // writing into the 0444 object fails either way (EPERM in the sandbox, EACCES without the chmod)
  assert.ok(["EPERM", "EACCES"].includes(got.get("data")!), run.stdout);
  // the unsandboxed git still reads main's real rules
  assert.equal(hg(r.main, "show", "main:.slackoff/config.json"), '{"real":true}');
  assert.ok(existsSync(join(common, "objects/pack", pack)));
  assert.ok(!existsSync(join(common, "objects/info/alternates")));
});

// ---------------------------------------------------------------- phase 4a fix round 3 (rulings 4A-9, 4A-10)

/** A fresh SLACKOFF_HOME with ticket K's worktree `api` (a linked worktree on slackoff/K-api) and its ticket cache. */
function freshHome(tag: string): { home: string; wt: string; gitDirs: { common: string; admin: string; branch: string } } {
  const h = join(root, `home-${tag}`);
  const main = join(root, `main-${tag}`);
  mkdirSync(main, { recursive: true });
  hg(main, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) hg(main, "config", k!, v!);
  writeFileSync(join(main, "a.js"), "a\n");
  hg(main, "add", "-A");
  hg(main, "commit", "-q", "-m", "init");
  const wt = join(h, "worktrees/K/api");
  mkdirSync(join(h, "worktrees/K"), { recursive: true });
  hg(main, "worktree", "add", "-q", "-b", "slackoff/K-api", wt);
  writeFileSync(join(h, "slackoff.db"), "DB\n");
  const common = realpathSync(join(main, ".git"));
  return { home: h, wt, gitDirs: { common, admin: realpathSync(join(common, "worktrees/api")), branch: "refs/heads/slackoff/K-api" } };
}
const devKinds = (f: ReturnType<typeof freshHome>): SandboxScope[] => {
  const base: SandboxScope = { kind: "dev-command", home: f.home, allowInHome: join(f.home, "worktrees/K"), repos: [], writable: [f.wt] };
  return [base, { ...base, kind: "dev-install" }, hookScope(f.home, "K", f.wt, f.gitDirs, [])];
};

test("4A-9 profile: every dev kind denies writing or moving the ticket cache, the cache root and the ticket dir themselves, after the allows", () => {
  const f = freshHome("p9");
  for (const scope of devKinds(f)) {
    const p = sandboxProfile(scope);
    const lastAllow = p.lastIndexOf("(allow file-write");
    for (const op of ["file-write*", "file-write-unlink"]) {
      const i = p.lastIndexOf(`(deny ${op} (literal (param "TICKET_CACHE")) (literal (param "TICKET_CACHE_UP")) (literal (param "HOME_ALLOW")))`);
      assert.ok(i > lastAllow, `${scope.kind} ${op}\n${p}`);
    }
  }
});

test("4A-9: inside every dev kind the ticket cache cannot be moved away or swapped (so no symlink can take its place)", { skip }, async () => {
  const f = freshHome("m9");
  for (const scope of devKinds(f)) {
    const cache = ticketCacheDir(scope);
    mkdirSync(join(cache, "tmp"), { recursive: true });
    mkdirSync(join(f.wt, "swapdir"), { recursive: true });
    const sh = `mv ${JSON.stringify(cache)} ${JSON.stringify(join(f.wt, "cachex"))} 2>/dev/null && echo mv:OK || echo mv:DENIED; ` +
      `echo "swap:$(/usr/bin/perl -e '${SWAP}' ${JSON.stringify(join(f.wt, "swapdir"))} ${JSON.stringify(cache)})"; ` +
      `echo x > ${JSON.stringify(join(cache, "inside.txt"))} && echo inside:OK`;
    const { file, args } = sandboxArgvFor(scope, "/bin/sh", ["-c", sh]);
    const run = await runProcess(file, args, { cwd: work, env: hookEnv(scope), timeoutMs: 20_000 });
    assert.equal(run.stdout.trim(), "mv:DENIED\nswap:EPERM\ninside:OK", `${scope.kind}: ${run.stdout} ${run.stderr}`);
    assert.ok(statSync(cache).isDirectory() && !existsSync(join(f.wt, "cachex")));
  }
});

test("4A-9: a symlink planted as the ticket cache, the cache root or a worktree root makes every dev scope refuse (profile, params, env); nothing is created through it", () => {
  for (const plant of ["cache/K", "cache", "worktrees/K/api"]) {
    const f = freshHome(`s9-${plant.replace(/\//g, "_")}`);
    const target = mkdtempSync(join(root, "plant-target-"));
    const at = join(f.home, plant);
    rmSync(at, { recursive: true, force: true });
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(target, at);
    for (const scope of devKinds(f)) {
      assert.throws(() => sandboxParams(scope, userHome), SandboxUnavailableError, `${plant} ${scope.kind} params`);
      assert.throws(() => sandboxEnv(scope, {}), SandboxUnavailableError, `${plant} ${scope.kind} env`);
    }
    assert.deepEqual(readdirSync(target), [], `${plant}: nothing was created through the symlink`);
  }
});

test("4A-9: sandboxEnv creates the ticket cache and its tmp dir (0700) when missing, without following symlinks below them", () => {
  const f = freshHome("e9");
  const scope = devKinds(f)[0]!;
  const env = sandboxEnv(scope, {});
  assert.equal(env.TMPDIR, ticketTmpDir(scope));
  assert.ok(statSync(ticketTmpDir(scope)).isDirectory());
  assert.equal(statSync(ticketTmpDir(scope)).mode & 0o777, 0o700);
  const target = mkdtempSync(join(root, "plant-tmp-"));
  rmSync(ticketTmpDir(scope), { recursive: true });
  symlinkSync(target, ticketTmpDir(scope));
  assert.throws(() => sandboxEnv(scope, {}), SandboxUnavailableError);
});

test("4A-9: writeShellPrefix's wrapper refuses a command (exit 126) when the ticket cache became a symlink after it was written; nothing is created there", { skip }, async () => {
  const f = freshHome("w9");
  const scope = devKinds(f)[0]!;
  const wrapper = writeShellPrefix(join(root, "prefix-w9"), scope, { shell: "/bin/zsh", homeDir: userHome });
  const target = mkdtempSync(join(root, "plant-w9-"));
  rmSync(ticketCacheDir(scope), { recursive: true, force: true });
  symlinkSync(target, ticketCacheDir(scope));
  const r = await runProcess(wrapper, ["echo ran"], { cwd: f.wt, timeoutMs: 30_000 });
  assert.equal(r.code, 126, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /ran/);
  assert.deepEqual(readdirSync(target), []);
});

test("4A-9: acceptance — a symlinked run root or <runRoot>/tmp is refused; <runRoot>/tmp cannot be moved or written as such from inside", { skip }, async () => {
  const run = realpathSync(mkdtempSync(join(root, "run9-")));
  const scope: SandboxScope = { kind: "acceptance", home, allowInHome: null, repos: [repoDir], runRoot: run };
  const p = sandboxProfile(scope);
  for (const op of ["file-write*", "file-write-unlink"]) {
    assert.ok(p.lastIndexOf(`(deny ${op} (literal (param "RUN_TMP")))`) > p.lastIndexOf("(allow file-write"), `${op}\n${p}`);
  }
  sandboxEnv(scope, {});
  const sh = `mv ${JSON.stringify(join(run, "tmp"))} ${JSON.stringify(join(run, "tmpx"))} 2>/dev/null && echo mv:OK || echo mv:DENIED`;
  const { file, args } = sandboxArgvFor(scope, "/bin/sh", ["-c", sh]);
  const r = await runProcess(file, args, { cwd: run, timeoutMs: 20_000 });
  assert.equal(r.stdout.trim(), "mv:DENIED", r.stdout + r.stderr);
  // planted from outside: a symlinked tmp dir, then a symlinked run root
  const target = mkdtempSync(join(root, "plant-run-"));
  rmSync(join(run, "tmp"), { recursive: true });
  symlinkSync(target, join(run, "tmp"));
  assert.throws(() => sandboxParams(scope, userHome), SandboxUnavailableError);
  assert.throws(() => sandboxEnv(scope, {}), SandboxUnavailableError);
  const link = join(root, "run9-link");
  symlinkSync(run, link);
  assert.throws(() => sandboxParams({ ...scope, runRoot: link }, userHome), SandboxUnavailableError);
});

test("4A-10: the hook scope's branch must be a slackoff/ branch; a hook cannot write <admin>/HEAD or HEAD.lock", { skip }, async () => {
  const f = freshHome("h10");
  for (const bad of ["refs/heads/main", "refs/heads/feature/x", "refs/tags/slackoff/x"]) {
    assert.throws(() => sandboxProfile(hookScope(f.home, "K", f.wt, { ...f.gitDirs, branch: bad }, [])), SandboxUnavailableError, bad);
  }
  const { branch: _b, ...noBranch } = f.gitDirs;
  assert.throws(() => sandboxProfile(hookScope(f.home, "K", f.wt, noBranch, [])), SandboxUnavailableError, "the branch is required");
  const scope = hookScope(f.home, "K", f.wt, f.gitDirs, []);
  const { admin } = f.gitDirs;
  const code = `
    const fs = require("node:fs"); const out = [];
    const t = (l, fn) => { try { fn(); out.push(l + ":OK"); } catch (e) { out.push(l + ":" + e.code); } };
    t("head", () => fs.writeFileSync(${JSON.stringify(join(admin, "HEAD"))}, "ref: refs/heads/main\\n"));
    t("headlock", () => { fs.writeFileSync(${JSON.stringify(join(admin, "HEAD.lock"))}, "ref: refs/heads/main\\n", { flag: "wx" }); fs.renameSync(${JSON.stringify(join(admin, "HEAD.lock"))}, ${JSON.stringify(join(admin, "HEAD"))}); });
    t("index", () => fs.appendFileSync(${JSON.stringify(join(admin, "probe"))}, "x"));
    console.log(out.join(" "));`;
  const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code]);
  const run = await runProcess(file, args, { cwd: f.wt, env: hookEnv(scope), timeoutMs: 20_000 });
  assert.equal(run.stdout.trim(), "head:EPERM headlock:EPERM index:OK", run.stdout + run.stderr);
  assert.equal(readFileSync(join(admin, "HEAD"), "utf8"), "ref: refs/heads/slackoff/K-api\n");
});

// ---------------------------------------------------------------- phase 4a fix round 4 (ruling 4A-12)

/** The ref literals a dev-hook may write (4A-5), relative to the common dir of `freshHome`'s repo. */
const REF_LITERALS = ["refs/stash", "refs/stash.lock", "logs/refs/stash", "logs/refs/stash.lock", "refs/heads/slackoff/K-api", "refs/heads/slackoff/K-api.lock", "logs/refs/heads/slackoff/K-api", "logs/refs/heads/slackoff/K-api.lock"];

/** Replace `p` (whatever is there) with a symlink to `target`, its parent dirs made as needed. */
function plantSymlink(p: string, target: string): void {
  rmSync(p, { recursive: true, force: true });
  mkdirSync(dirname(p), { recursive: true });
  symlinkSync(target, p);
}

test("4A-12: a symlink planted at any ref literal of the dev-hook profile makes the next scope refuse (params, env, self-check); the target is never written", { skip }, async () => {
  for (const rel of REF_LITERALS) {
    const f = freshHome(`r12-${rel.replace(/[/.]/g, "_")}`);
    const rc = join(userHome, `.zshrc-${rel.replace(/[/.]/g, "_")}`);
    writeFileSync(rc, "RC\n");
    plantSymlink(join(f.gitDirs.common, rel), rc);
    const scope = hookScope(f.home, "K", f.wt, f.gitDirs, []);
    assert.throws(() => sandboxParams(scope, userHome), SandboxUnavailableError, `${rel}: params`);
    assert.throws(() => sandboxEnv(scope, {}), SandboxUnavailableError, `${rel}: env`);
    const c = await sandboxSelfCheck(scope);
    assert.equal(c.ok, false, `${rel}: self-check ${c.detail}`);
    assert.match(c.detail, /symlink/, rel);
    assert.equal(readFileSync(rc, "utf8"), "RC\n", rel);
  }
});

test("4A-12 profile: dev-hook denies creating a symlink anywhere under the common git dir, after the git-dir allows", () => {
  const f = freshHome("p12");
  const p = sandboxProfile(hookScope(f.home, "K", f.wt, f.gitDirs, []));
  const line = '(deny file-write-create (require-all (subpath (param "COMMON_GIT")) (vnode-type SYMLINK)))';
  assert.ok(p.includes(line), p);
  assert.ok(p.indexOf(line) > p.lastIndexOf('(allow file-write-unlink (subpath (param "COMMON_GIT_OBJECTS"))'), p);
  for (const scope of devKinds(f).slice(0, 2)) assert.ok(!sandboxProfile(scope).includes("vnode-type SYMLINK"), scope.kind);
});

test("4A-12: inside the dev-hook sandbox no symlink can be created under the common git dir (refs, logs, objects, admin dir) — EPERM; symlinks in the worktree still work", { skip }, async () => {
  const f = freshHome("s12");
  const { common, admin } = f.gitDirs;
  const rc = join(userHome, ".zshrc-s12");
  writeFileSync(rc, "RC\n");
  const scope = hookScope(f.home, "K", f.wt, f.gitDirs, []);
  const at = [...REF_LITERALS.map((r) => join(common, r)), join(common, "objects/zz-link"), join(admin, "COMMIT_EDITMSG.x"), join(admin, "index.lock")];
  const code = `
    const fs = require("node:fs"); const out = [];
    for (const p of ${JSON.stringify(at)}) { try { fs.rmSync(p, { force: true }); } catch {} try { fs.symlinkSync(${JSON.stringify(rc)}, p); out.push("OK"); } catch (e) { out.push(e.code); } }
    try { fs.symlinkSync(${JSON.stringify(rc)}, ${JSON.stringify(join(f.wt, "link-in-wt"))}); out.push("wt:OK"); } catch (e) { out.push("wt:" + e.code); }
    console.log(out.join(" "));`;
  const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code]);
  const run = await runProcess(file, args, { cwd: f.wt, env: hookEnv(scope), timeoutMs: 20_000 });
  assert.equal(run.stdout.trim(), [...at.map(() => "EPERM"), "wt:OK"].join(" "), run.stdout + run.stderr);
  for (const p of at) {
    let link = false;
    try {
      link = lstatSync(p).isSymbolicLink();
    } catch {
      // missing
    }
    assert.equal(link, false, p);
  }
  assert.equal(readFileSync(rc, "utf8"), "RC\n");
});

/** 4A-12: a fresh scope of each kind (dev-hook also with its repo inside SLACKOFF_HOME, as in fake mode). */
const SCOPES_12 = ["dev-command", "dev-install", "dev-hook", "dev-hook-in-home", "acceptance", "acceptance-install"] as const;
let fresh12 = 0;
function scope12(kind: (typeof SCOPES_12)[number]): SandboxScope {
  const tag = `g12-${fresh12++}`;
  if (kind === "acceptance" || kind === "acceptance-install") {
    const run = realpathSync(mkdtempSync(join(root, `run-${tag}-`)));
    mkdirSync(join(run, "tmp"));
    return { kind, home, allowInHome: null, repos: [repoDir], runRoot: run };
  }
  const f = freshHome(tag);
  if (kind === "dev-hook-in-home") {
    const main = join(f.home, "fake-repos/web");
    mkdirSync(main, { recursive: true });
    hg(main, "init", "-q", "-b", "main");
    for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) hg(main, "config", k!, v!);
    writeFileSync(join(main, "a.js"), "a\n");
    hg(main, "add", "-A");
    hg(main, "commit", "-q", "-m", "init");
    const wt = join(f.home, "worktrees/K/web");
    hg(main, "worktree", "add", "-q", "-b", "slackoff/K-web", wt);
    const common = realpathSync(join(main, ".git"));
    return hookScope(f.home, "K", wt, { common, admin: join(common, "worktrees/web"), branch: "refs/heads/slackoff/K-web" }, []);
  }
  return devKinds(f)[["dev-command", "dev-install", "dev-hook"].indexOf(kind)]!;
}

/** The params of every `(allow …)` line of a profile, read from its text (regex params aside). */
const allowParamsOf = (profile: string): string[] =>
  [...new Set(profile.split("\n").filter((l) => l.startsWith("(allow")).flatMap((l) => [...l.matchAll(/\(param "([A-Z0-9_]+)"\)/g)].map((m) => m[1]!)))].filter((n) => n !== "CLAUDE_CWD_RE").sort();

test("4A-12 (generic): every allow param sandboxParams emits, in every kind, is lstat-checked from its root; a symlink planted at any of them refuses the scope", () => {
  for (const kind of SCOPES_12) {
    const scope = scope12(kind);
    const emitted = new Set(sandboxParams(scope, userHome).filter((_, i) => i % 2 === 1).map((d) => d.slice(0, d.indexOf("="))));
    const allows = allowParamsOf(sandboxProfile(scope));
    assert.ok(allows.length > 0 && allows.every((n) => emitted.has(n)), `${kind}: ${allows.join(" ")}`);
    const checks = allowPathChecks(scope);
    assert.deepEqual(checks.map((c) => c.param).sort(), allows, `${kind}: every allow param is validated`);
    for (const c of checks) {
      if (c.root !== "/") continue;
      // system paths (temp dirs, /dev, the DNS socket, SLACKOFF_HOME's ancestors): real paths, checked from "/"
      assert.match(c.param, /^(TMP_\d+|DEV_[A-Z]+|MDNS_SOCKET|HOME_UP_\d+)$/, `${kind}: ${c.param} is checked from "/"`);
      if (existsSync(c.path)) assert.equal(realpathSync(c.path), c.path, `${kind}: ${c.param}`);
    }
    // planted from outside, one at a time, in a fresh scope each: the scope is refused, nothing goes through the link
    for (const c of checks.filter((c) => c.root !== "/" && c.path !== c.root)) {
      const s = scope12(kind);
      const p = allowPathChecks(s).find((x) => x.param === c.param)!.path;
      const target = mkdtempSync(join(root, "plant12-"));
      plantSymlink(p, target);
      assert.throws(() => sandboxParams(s, userHome), SandboxUnavailableError, `${kind}: ${c.param} (${p})`);
      assert.throws(() => sandboxEnv(s, {}), SandboxUnavailableError, `${kind}: ${c.param} env`);
      assert.deepEqual(readdirSync(target), [], `${kind}: ${c.param}`);
    }
  }
});

// ---------------------------------------------------------------- cleanup (ruling 4A-13)

test("4A-13: the TMUX_TMP and LAUNCHD_TMP prefixes are resolved on their parent only, like the other name-kept params", () => {
  for (const n of ["TMUX_TMP", "LAUNCHD_TMP", "HOME_CLAUDE", "HOME_CLAUDE_JSON_NAME"]) assert.ok(PARENT_ONLY_PARAMS.has(n), n);
  const params = sandboxParams(devScope, userHome);
  assert.ok(params.includes("TMUX_TMP=/private/tmp/tmux-") && params.includes("LAUNCHD_TMP=/private/tmp/com.apple.launchd."), params.join(" "));
});

// ---------------------------------------------------------------- phase 4a Task 4: optional local-port allowlist

const LOOPBACK_DENY = ['(deny network-outbound (remote tcp6 "*:*"))', '(deny network-outbound (remote tcp4 "localhost:*"))'];
const allowLine = (ports: number[]) => `(allow network-outbound ${ports.map((p) => `(remote tcp4 "localhost:${p}") (remote tcp6 "localhost:${p}")`).join(" ")})`;

test("Task 4 profile: no localNetwork (denylist) leaves the text unchanged; allowlist denies tcp6 *:* and tcp4 localhost:*, then allows the declared ports, before the DENIED_PORTS deny", () => {
  const f = freshHome("t4p");
  for (const base of [devScope, installScope, acceptScope, { ...acceptScope, kind: "acceptance-install" } as SandboxScope, hookScope(f.home, "K", f.wt, f.gitDirs, [])]) {
    const deny = sandboxProfile(base);
    assert.ok(!/tcp4|tcp6/.test(deny), `${base.kind}: denylist has no allowlist rules`);
    const allow = sandboxProfile({ ...base, localNetwork: { mode: "allowlist", allowPorts: [6000, 3000] } });
    const lines = allow.split("\n");
    const block = [...LOOPBACK_DENY, allowLine([3000, 6000])];
    const i = lines.indexOf(block[0]!);
    assert.ok(i > 0, `${base.kind}\n${allow}`);
    assert.deepEqual(lines.slice(i, i + 3), block, base.kind);
    assert.ok(lines[i + 3]!.startsWith('(deny network-outbound (remote tcp "*:4317")'), `${base.kind}: the DENIED_PORTS deny comes right after`);
    assert.equal(lines.filter((_, j) => j < i || j >= i + 3).join("\n"), deny, `${base.kind}: nothing else changes`);
    // no declared port: only the denies
    const none = sandboxProfile({ ...base, localNetwork: { mode: "allowlist", allowPorts: [] } }).split("\n");
    assert.deepEqual(none.slice(none.indexOf(LOOPBACK_DENY[0]!), none.indexOf(LOOPBACK_DENY[0]!) + 3), [...LOOPBACK_DENY, none[none.indexOf(LOOPBACK_DENY[0]!) + 2]!]);
    assert.ok(!none.some((l) => l.startsWith("(allow network-outbound (remote tcp4")), base.kind);
  }
  for (const bad of [[4317], [5173], [0], [70000], [1.5]]) {
    assert.throws(() => sandboxProfile({ ...devScope, localNetwork: { mode: "allowlist", allowPorts: bad } }), SandboxUnavailableError, JSON.stringify(bad));
  }
  assert.throws(() => sandboxProfile({ ...devScope, extraPorts: [7777], localNetwork: { mode: "allowlist", allowPorts: [7777] } }), SandboxUnavailableError, "a configured denied port");
});

/** a dual-stack listener on `::` (IPv4, IPv4-mapped and ::1 all reach it) */
function listenAny(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((c) => c.end());
    server.on("error", reject);
    server.listen({ port: 0, host: "::", ipv6Only: false }, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

test("Task 4 allowlist (real sandbox-exec): a declared port connects on 127.0.0.1 and ::1 (not IPv4-mapped: tcp6 *:* catches it); an undeclared one and 4317 are EPERM on all three; self-bind is EPERM (not expressible)", { skip }, async () => {
  const a = await listenAny();
  const b = await listenAny();
  try {
    const scope: SandboxScope = { ...devScope, localNetwork: { mode: "allowlist", allowPorts: [a.port] } };
    const code = `
      const net = require("node:net"); const out = [];
      const tryC = (host, port) => new Promise((res) => { const s = net.connect({ host, port }); s.setTimeout(3000, () => { s.destroy(); res("TIMEOUT"); }); s.on("connect", () => { s.destroy(); res("OK"); }); s.on("error", (e) => res(e.code)); });
      (async () => {
        for (const [l, port] of [["A", ${a.port}], ["B", ${b.port}], ["S", 4317]]) for (const h of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) out.push(l + "@" + h + "=" + await tryC(h, port));
        const sv = net.createServer((c) => c.end()); await new Promise((r) => sv.listen(0, "127.0.0.1", r));
        out.push("self=" + await tryC("127.0.0.1", sv.address().port)); sv.close();
        console.log(out.join(" "));
      })();`;
    const { file, args } = sandboxArgvFor(scope, process.execPath, ["-e", code]);
    const r = await runProcess(file, args, { cwd: work, timeoutMs: 30_000 });
    const got = new Map(r.stdout.trim().split(" ").map((x) => x.split("=") as [string, string]));
    for (const h of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      // spike §3: the IPv4-mapped form is only caught by tcp6 "*:*", which also refuses it for a declared port
      assert.equal(got.get(`A@${h}`), h.startsWith("::ffff:") ? "EPERM" : "OK", `${h}: ${r.stdout} ${r.stderr}`);
      assert.equal(got.get(`B@${h}`), "EPERM", `${h}: ${r.stdout}`);
      assert.equal(got.get(`S@${h}`), "EPERM", `${h}: ${r.stdout}`);
    }
    assert.equal(got.get("self"), "EPERM", "LOOPBACK_SELF_BIND: a repo declares its own test ports in sandbox.localPorts");
    // denylist (default): the undeclared port connects
    const d = sandboxArgvFor(devScope, process.execPath, ["-e", code]);
    const rd = await runProcess(d.file, d.args, { cwd: work, timeoutMs: 30_000 });
    assert.match(rd.stdout, /B@127\.0\.0\.1=OK/);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test("Task 4 self-check: in allowlist mode an undeclared port (the check's own listener) must be EPERM on 127.0.0.1, ::1 and ::ffff:127.0.0.1 -> undeclared:EPERM", { skip }, async () => {
  const c = await sandboxSelfCheck({ ...devScope, localNetwork: { mode: "allowlist", allowPorts: [] } });
  assert.equal(c.ok, true, c.detail);
  assert.match(c.detail, /undeclared:EPERM/);
  const dflt = await sandboxSelfCheck(devScope);
  assert.doesNotMatch(dflt.detail, /undeclared/, "denylist mode has no such probe");
});

test("selfcheck.mjs Task 4: --undeclared <port> reachable (no sandbox) fails the check, naming the host", async () => {
  const l = await listenAny();
  try {
    const r = await runProcess(process.execPath, [SELF_CHECK_SCRIPT, join(home, "slackoff.db"), "1", "--undeclared", String(l.port)], { timeoutMs: 15_000 });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /undeclared:127\.0\.0\.1=CONNECTED/);
  } finally {
    l.server.close();
  }
});

// ---------------------------------------------------------------- phase 4a Task 5: the sandbox backend

test("Task 5: sandboxBackend — darwin with /usr/bin/sandbox-exec is 'sandbox-exec'; linux, or darwin without it, is 'none' with a reason; the startup notice says what will not run", () => {
  assert.deepEqual(sandboxBackend({ platform: "darwin", exists: (p) => p === SANDBOX_EXEC }), { name: "sandbox-exec", available: true, reason: null });
  const linux = sandboxBackend({ platform: "linux" });
  assert.equal(linux.name, "none");
  assert.equal(linux.available, false);
  assert.match(linux.reason ?? "", /linux/);
  const missing = sandboxBackend({ platform: "darwin", exists: () => false });
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? "", /sandbox-exec/);
  assert.equal(sandboxUnavailableNotice(sandboxBackend({ platform: "darwin", exists: () => true })), null);
  assert.equal(
    sandboxUnavailableNotice(linux),
    `Command sandbox unavailable: ${linux.reason}. Development commands, git hooks and acceptance will not run unless you turn on the opt-outs (README → Security model and residual risks).`,
  );
});

test("Task 5: sandboxSelfCheck takes its platform verdict from sandboxBackend (unchanged behaviour off macOS)", async () => {
  const c = await sandboxSelfCheck(devScope, { platform: "linux" });
  assert.deepEqual(c, { ok: false, detail: sandboxBackend({ platform: "linux" }).reason });
});

// ---------------------------------------------------------------- phase 4a Task 6: the shell wrapper's environment

test("Task 6: writeShellPrefix's wrapper drops every ANTHROPIC_* variable and CLAUDE_CODE_OAUTH_TOKEN before the command", { skip }, async () => {
  const wrapper = writeShellPrefix(join(root, "prefix-t6"), devScope, { shell: "/bin/zsh", homeDir: userHome });
  const r = await runProcess(wrapper, ["/usr/bin/env"], {
    env: {
      PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome, ANTHROPIC_API_KEY: "x", ANTHROPIC_FOO: "y", ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      CLAUDE_CODE_OAUTH_TOKEN: "t", SLACKOFF_KEEP_ME: "kept",
    },
    timeoutMs: 30_000,
  });
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /ANTHROPIC_/);
  assert.doesNotMatch(r.stdout, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(r.stdout, /^SLACKOFF_KEEP_ME=kept$/m);
});

// ---------------------------------------------------------------- phase 4a tasks 4–7 fix round 1 (ruling 4A-15)

/** fake secrets as the server's environment could hold them */
const SECRETS_15: Record<string, string> = {
  GH_TOKEN: "g", GITHUB_TOKEN: "g2", NPM_TOKEN: "n", NODE_AUTH_TOKEN: "na", AWS_SECRET_ACCESS_KEY: "a", AWS_PROFILE: "p", APP_SECRET: "s",
  DB_PASSWORD: "pw", X_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "ak", ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
  REGISTRY_AUTH: "r", GOOGLE_APPLICATION_CREDENTIALS: "/c.json", DEPLOY_PRIVATE_KEY: "pk", SSH_AUTH_SOCK: "/s",
};
const INSTALL_KEEPS = ["NPM_TOKEN", "NODE_AUTH_TOKEN"];

test("4A-15 (I-1): sandboxEnv strips the hooks' secret list in every kind; dev-install keeps NPM_TOKEN and NODE_AUTH_TOKEN (private registries)", () => {
  const run = realpathSync(mkdtempSync(join(root, "run15-")));
  const scopes: SandboxScope[] = [devScope, installScope, { kind: "acceptance", home, allowInHome: null, repos: [repoDir], runRoot: run }, { kind: "acceptance-install", home, allowInHome: null, repos: [repoDir], runRoot: run }];
  for (const scope of scopes) {
    const env = sandboxEnv(scope, { PATH: "/bin", SLACKOFF_KEEP_ME: "kept", ...SECRETS_15 });
    for (const k of Object.keys(SECRETS_15)) {
      const kept = scope.kind === "dev-install" && INSTALL_KEEPS.includes(k);
      assert.equal(env[k], kept ? SECRETS_15[k] : undefined, `${scope.kind}: ${k}`);
    }
    assert.equal(env.SLACKOFF_KEEP_ME, "kept", scope.kind);
  }
});

test("4A-15 (I-1): runCommand with the server's environment seeded with fake tokens — the sandboxed command sees none of them (dev-install: only the npm tokens)", { skip }, async () => {
  const wt = join(home, "worktrees/K/api");
  writeFileSync(join(wt, "env15.js"), "process.stdout.write(Object.keys(process.env).sort().join(' '))");
  const saved = Object.fromEntries(Object.keys(SECRETS_15).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SECRETS_15);
  try {
    for (const scope of [devScope, installScope]) {
      const r = await runCommand(wt, "node env15.js", 20_000, { kind: "sandboxed", scope });
      const seen = new Set(r.outputTail.trim().split(" "));
      for (const k of Object.keys(SECRETS_15)) assert.equal(seen.has(k), scope.kind === "dev-install" && INSTALL_KEEPS.includes(k), `${scope.kind}: ${k}`);
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("4A-15 (I-1): the agent's shell wrapper strips the same list (GH_TOKEN, NPM_TOKEN, AWS_*, *_SECRET, CLAUDE_CODE_*, …) before the command", { skip }, async () => {
  const wrapper = writeShellPrefix(join(root, "prefix-15"), devScope, { shell: "/bin/zsh", homeDir: userHome });
  const r = await runProcess(wrapper, ["/usr/bin/env"], {
    env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`, HOME: userHome, SLACKOFF_KEEP_ME: "kept", ...SECRETS_15 },
    timeoutMs: 30_000,
  });
  assert.equal(r.code, 0, r.stderr);
  for (const k of Object.keys(SECRETS_15)) assert.doesNotMatch(r.stdout, new RegExp(`^${k}=`, "m"), k);
  assert.match(r.stdout, /^SLACKOFF_KEEP_ME=kept$/m);
});

test("4A-15 (M-3): the allowlist self-check's own listener is bound to 127.0.0.1 and ::1 only, never to every address", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/sandbox/local-sandbox.ts"), "utf8");
  const block = src.slice(src.indexOf("let undeclared"), src.indexOf("argv = sandboxArgv(scope, o.node"));
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /host: "::"/);
  assert.match(block, /"127\.0\.0\.1"/);
  assert.match(block, /"::1"/);
});

// ---------------------------------------------------------------- phase 4b Task 2 (X-4): credentials.json

test("4b T2 profile: every kind denies ${SLACKOFF_HOME}/credentials.json as a literal, pinned again last", () => {
  const r = hookRepo("hcredp");
  for (const scope of [...ALL_KINDS, hookScope(home, "K", r.wt, r.gitDirs, [])]) {
    const p = sandboxProfile(scope);
    const lines = p.trimEnd().split("\n");
    const rule = '(literal (param "SLACKOFF_CREDENTIALS"))';
    assert.ok(lines.some((l) => l.startsWith("(deny file-read* file-write* ") && l.includes('(subpath (param "SLACKOFF_HOME"))') && l.includes(rule)), `${scope.kind}: with the SLACKOFF_HOME deny`);
    assert.deepEqual(lines.slice(-2), [`(deny file-read* file-write* ${rule})`, `(deny file-write-unlink ${rule})`], `${scope.kind}: last, after every allow`);
    const params = sandboxParams(scope, userHome);
    assert.ok(params.includes(`SLACKOFF_CREDENTIALS=${join(realpathSync(home), "credentials.json")}`), `${scope.kind}: ${params.join(" ")}`);
  }
});

test("4b T2: credentialPaths with SLACKOFF_HOME adds the credentials file as a literal", () => {
  assert.deepEqual(credentialPaths("/Users/u", "/Users/u/.slackoff").at(-1), { param: "SLACKOFF_CREDENTIALS", path: "/Users/u/.slackoff/credentials.json", literal: true });
  assert.ok(!credentialPaths("/Users/u").some((c) => c.param === "SLACKOFF_CREDENTIALS"));
});

test("4B-11: no sandbox kind can read, write or list the API key helper (in SLACKOFF_HOME, outside every allowed dir)", { skip }, async () => {
  const helper = apiKeyHelperPath(home);
  mkdirSync(dirname(helper), { recursive: true, mode: 0o700 });
  writeFileSync(helper, "#!/bin/sh\nexec /usr/bin/true\n", { mode: 0o700 });
  const r = hookRepo("hkeyhelper");
  try {
    for (const scope of [...ALL_KINDS, hookScope(home, "K", r.wt, r.gitDirs, [])]) {
      const m = await probe(scope, { reads: [helper, dirname(helper)], writes: [helper] });
      assert.equal(m.get(`read ${helper}`), "EPERM", scope.kind);
      assert.equal(m.get(`read ${dirname(helper)}`), "EPERM", scope.kind);
      assert.equal(m.get(`write ${helper}`), "EPERM", scope.kind);
    }
    assert.equal(readFileSync(helper, "utf8"), "#!/bin/sh\nexec /usr/bin/true\n");
  } finally {
    rmSync(dirname(helper), { recursive: true, force: true });
  }
});

test("4b T2: no sandbox kind can read or write credentials.json (EPERM)", { skip }, async () => {
  const file = join(home, "credentials.json");
  writeFileSync(file, '{"version":1,"jira":null,"anthropic":null,"otlpHeaders":null}\n', { mode: 0o600 });
  const r = hookRepo("hcred");
  for (const scope of [...ALL_KINDS, hookScope(home, "K", r.wt, r.gitDirs, [])]) {
    const m = await probe(scope, { reads: [file], writes: [file] });
    assert.equal(m.get(`read ${file}`), "EPERM", scope.kind);
    assert.equal(m.get(`write ${file}`), "EPERM", scope.kind);
  }
  assert.equal(readFileSync(file, "utf8"), '{"version":1,"jira":null,"anthropic":null,"otlpHeaders":null}\n');
});
