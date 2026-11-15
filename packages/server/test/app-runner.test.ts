// Task 6: the target app lifecycle of an acceptance run (install, start, health check, stop) and the long-running
// process runner it uses. Real processes from test/fixtures/acceptance-app; the sandboxed runs need macOS sandbox-exec.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppAcceptanceRules } from "../src/projects/project-rules.ts";
import { loadConfig } from "../src/config.ts";
import { runProcess, startProcess } from "../src/git/run.ts";
import { SANDBOX_EXEC, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { cleanupRunDirs, prepareRunDirs, type AcceptanceRunDirs } from "../src/acceptance/workspace.ts";
import { tmpDir } from "./helpers/tmp.ts";
import {
  ACCEPT_APP_ENV_KEYS, PlatformProcesses, killLeftovers, portInUse, startTargets, stopTargets, targetEnv, type StartedTarget,
} from "../src/acceptance/app-runner.ts";

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const skip = HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;

const FIXTURE = join(import.meta.dirname, "fixtures/acceptance-app");
const root = realpathSync(tmpDir("ar"));
const made: AcceptanceRunDirs[] = [];
const pgids: number[] = [];
after(async () => {
  for (const p of pgids) {
    try {
      process.kill(-p, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const d of made) await cleanupRunDirs(d);
  rmSync(root, { recursive: true, force: true });
});

const home = join(root, "slackoff");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "slackoff.db"), "DB\n");

/** Is any process of group `pgid` still running? (`ps`, not a signal) */
function groupAlive(pgid: number): boolean {
  const out = execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  return out.split("\n").some((l) => {
    const [g, stat] = l.trim().split(/\s+/);
    return Number(g) === pgid && !stat?.startsWith("Z");
  });
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

function listen(host: string, port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((res, rej) => {
    const server = createServer((c) => c.end());
    server.once("error", rej);
    server.listen(port, host, () => res({ server, port: (server.address() as { port: number }).port }));
  });
}

async function runDirs(): Promise<AcceptanceRunDirs> {
  const cfgHome = mkdtempSync(join(root, "cfg-"));
  writeFileSync(join(cfgHome, "config.json"), JSON.stringify({ acceptance: { claudeConfigDir: join(mkdtempSync(join(root, "ccfg-")), "claude-config") } }));
  const d = await prepareRunDirs({ home, repoPaths: [], config: loadConfig(cfgHome) });
  made.push(d);
  return d;
}

/** The fixture app copied to <workDir>/<name>, and its acceptance rules. */
function app(d: AcceptanceRunDirs, name: string, port: number, o: Partial<AppAcceptanceRules> & { mode?: string } = {}): { name: string; acceptance: AppAcceptanceRules } {
  cpSync(FIXTURE, join(d.workDir, name), { recursive: true });
  const { mode, ...rules } = o;
  return {
    name,
    acceptance: {
      entry: "web",
      install: "node install.mjs",
      start: "node server.mjs",
      stop: "node stop.mjs",
      baseUrl: `http://127.0.0.1:${port}`,
      healthPath: "/health",
      env: { PORT: String(port), ...(mode ? { FIXTURE_MODE: mode } : {}) },
      ...rules,
    },
  };
}

const scopeOf = (d: AcceptanceRunDirs): SandboxScope => ({ kind: "acceptance", home, allowInHome: null, repos: [], runRoot: d.runRoot });

async function start(d: AcceptanceRunDirs, repos: Array<{ name: string; acceptance: AppAcceptanceRules }>, o: { startTimeoutMs?: number; processes?: PlatformProcesses } = {}) {
  const seen: number[] = [];
  const processes = o.processes ?? new PlatformProcesses();
  const r = await startTargets({
    workDir: d.workDir,
    repos,
    startTimeoutMs: o.startTimeoutMs ?? 20_000,
    commandTimeoutMs: 30_000,
    runRoot: d.runRoot,
    sandbox: scopeOf(d),
    processes,
    onPgid: (p) => {
      seen.push(p);
      pgids.push(p);
    },
  });
  return { ...r, seen, processes };
}

const stop = (d: AcceptanceRunDirs, targets: readonly StartedTarget[], processes: PlatformProcesses) =>
  stopTargets(targets, d.workDir, { env: targetEnv({}, d.runRoot), sandbox: scopeOf(d), processes, runRoot: d.runRoot });

// ---------------------------------------------------------------- startProcess

test("startProcess: keeps running after it returns (no timeout, not killed); exited resolves when it exits; tail keeps the output", async () => {
  const p = startProcess(process.execPath, ["-e", "console.log('hello ' + process.env.MARK); setInterval(() => {}, 1000)"], {
    cwd: root, env: { PATH: process.env.PATH, MARK: "m1" }, tailBytes: 1024,
  });
  pgids.push(p.pgid);
  assert.ok(await waitFor(() => p.tail().includes("hello m1")), p.tail());
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(groupAlive(p.pgid), "still running");
  process.kill(-p.pgid, "SIGTERM");
  assert.equal(await p.exited, null);
  const q = startProcess(process.execPath, ["-e", "process.exit(3)"], { cwd: root, env: { PATH: process.env.PATH }, tailBytes: 10 });
  assert.equal(await q.exited, 3);
  assert.throws(() => startProcess(join(root, "no-such-program"), [], { cwd: root, env: {}, tailBytes: 10 }), /ENOENT/);
});

test("startProcess: its own process group, stdin closed, GIT_* removed", async () => {
  const p = startProcess(
    process.execPath,
    ["-e", "let n = 0; process.stdin.on('data', () => n++); process.stdin.on('end', () => { console.log('eof', n, process.env.GIT_DIR ?? 'none', process.pid); setTimeout(() => process.exit(0), 50); })"],
    { cwd: root, env: { PATH: process.env.PATH, GIT_DIR: "/x" }, tailBytes: 1024 },
  );
  assert.equal(await p.exited, 0);
  assert.match(p.tail(), new RegExp(`^eof 0 none ${p.pgid}$`, "m"));
});

// ---------------------------------------------------------------- targetEnv / portInUse / PlatformProcesses

test("targetEnv: only PATH HOME USER LANG + the rule file env + the run's TMPDIR / TMP / TEMP + SLACKOFF_RUN_ROOT", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { SLACKOFF_HOME: "/h", GH_TOKEN: "t", SSH_AUTH_SOCK: "/s", AWS_PROFILE: "p", NPM_TOKEN: "n", ANTHROPIC_API_KEY: "k", LANG: "en_US.UTF-8", TMPDIR: "/elsewhere" });
    const env = targetEnv({ PORT: "3000", TMPDIR: "/rules-tmp" }, "/private/tmp/slackoff-accept-abc123");
    assert.deepEqual(ACCEPT_APP_ENV_KEYS, ["PATH", "HOME", "USER", "LANG", "TMPDIR"]);
    const tmp = "/private/tmp/slackoff-accept-abc123/tmp";
    assert.deepEqual(
      Object.keys(env).sort(),
      ["HOME", "LANG", "PATH", "PORT", "SLACKOFF_RUN_ROOT", "TEMP", "TMP", "TMPDIR", ...(process.env.USER ? ["USER"] : [])].sort(),
    );
    assert.equal(env.TMPDIR, tmp, "T6-1: the run's own tmp dir, whatever the server's or the rule file's");
    assert.equal(env.TMP, tmp);
    assert.equal(env.TEMP, tmp);
    assert.equal(env.SLACKOFF_RUN_ROOT, "/private/tmp/slackoff-accept-abc123");
    assert.equal(env.PORT, "3000");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("portInUse: true for a listener on 127.0.0.1 and on ::1; false for a free port", async () => {
  const v4 = await listen("127.0.0.1");
  try {
    assert.equal(await portInUse(`http://127.0.0.1:${v4.port}`), true);
    assert.equal(await portInUse(`http://localhost:${v4.port}/app`), true);
  } finally {
    v4.server.close();
  }
  const v6 = await listen("::1");
  try {
    assert.equal(await portInUse(`http://127.0.0.1:${v6.port}`), true);
  } finally {
    v6.server.close();
  }
  assert.equal(await portInUse(`http://127.0.0.1:${await freePort()}`), false);
});

test("PlatformProcesses.killAll kills every registered process group", async () => {
  const procs = new PlatformProcesses();
  const a = spawn("/bin/sh", ["-c", "sleep 30 & sleep 30"], { detached: true, stdio: "ignore" });
  const b = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  pgids.push(a.pid!, b.pid!);
  procs.add(a.pid!, "/r1");
  procs.add(b.pid!, "/r2");
  await waitFor(() => groupAlive(a.pid!) && groupAlive(b.pid!));
  procs.killAll();
  assert.ok(await waitFor(() => !groupAlive(a.pid!) && !groupAlive(b.pid!)), "both groups gone");
  procs.killAll(); // nothing left: no throw
});

test("killLeftovers: kills a group whose environment names the run root; leaves a group that does not", async () => {
  const runRoot = "/private/tmp/slackoff-accept-zz9zz9";
  const keep = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
  const kill = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, SLACKOFF_RUN_ROOT: runRoot } });
  const near = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, SLACKOFF_RUN_ROOT: `${runRoot}0` } });
  pgids.push(keep.pid!, kill.pid!, near.pid!);
  await waitFor(() => groupAlive(keep.pid!) && groupAlive(kill.pid!) && groupAlive(near.pid!));
  await new Promise((r) => setTimeout(r, 200));
  killLeftovers(runRoot, [keep.pid!, kill.pid!, near.pid!, 999_999]);
  assert.ok(await waitFor(() => !groupAlive(kill.pid!)), "the run's group is killed");
  assert.ok(groupAlive(keep.pid!), "an unrelated group (e.g. a reused pid) is left alone");
  assert.ok(groupAlive(near.pid!), "another run root that merely starts with it is left alone");
  process.kill(-keep.pid!, "SIGKILL");
  process.kill(-near.pid!, "SIGKILL");
});

// ---------------------------------------------------------------- startTargets / stopTargets

test("startTargets: a port already in use → not executed, nothing started", { skip }, async () => {
  const d = await runDirs();
  const busy = await listen("127.0.0.1");
  try {
    const free = await freePort();
    const r = await start(d, [app(d, "api", free), app(d, "web", busy.port)]);
    assert.match(r.notExecutedReason ?? "", new RegExp(`port ${busy.port} is already in use — stop the process using it, then re-run acceptance`));
    assert.deepEqual(r.seen, []);
    assert.equal(r.targets.some((t) => t.started), false);
    assert.equal(existsSync(join(d.workDir, "api/installed.txt")), false, "not even installed");
  } finally {
    busy.server.close();
  }
});

test("startTargets: the fixture app installs, starts in the sandbox with the whitelisted env and passes its health check; stopTargets leaves nothing", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const saved = { SLACKOFF_HOME: process.env.SLACKOFF_HOME, GH_TOKEN: process.env.GH_TOKEN };
  process.env.SLACKOFF_HOME = home;
  process.env.GH_TOKEN = "fake-token-for-test";
  try {
    const port = await freePort();
    const r = await start(d, [app(d, "shop", port)]);
    assert.equal(r.notExecutedReason, null, JSON.stringify(r.targets));
    assert.equal(r.targets.length, 1);
    const t = r.targets[0]!;
    assert.equal(t.started, true);
    assert.equal(t.repo, "shop");
    assert.equal(t.baseUrl, `http://127.0.0.1:${port}`);
    assert.equal(t.pgid, r.seen[0]);
    // install ran in the sandbox with the run's TMPDIR
    assert.equal(readFileSync(join(d.workDir, "shop/installed.txt"), "utf8").trim(), join(d.runRoot, "tmp"));
    const keys = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/env`)).text()) as string[];
    assert.ok(!keys.includes("SLACKOFF_HOME") && !keys.includes("GH_TOKEN"), keys.join(" "));
    assert.ok(keys.includes("SLACKOFF_RUN_ROOT") && keys.includes("PORT"), keys.join(" "));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/read?f=${encodeURIComponent(join(home, "slackoff.db"))}`)).text(), "EPERM");
    // I4: the group id before stopTargets clears it
    const pgid = t.pgid!;
    assert.ok(pgid > 1 && groupAlive(pgid) && r.processes.size === 1);
    await stop(d, r.targets, r.processes);
    assert.equal(groupAlive(pgid), false, "no process of the app left");
    assert.equal(t.pgid, null);
    assert.equal(r.processes.size, 0, "unregistered");
    assert.equal(await portInUse(t.baseUrl), false);
    r.processes.killAll(); // empty: nothing to kill
    assert.equal(readFileSync(join(d.workDir, "stop-order.log"), "utf8"), "shop\n", "the declared stop command ran");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("startTargets: a start command that exits at once → not executed, reason names the repo and shows its output", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const r = await start(d, [app(d, "shop", await freePort(), { mode: "fail" })]);
  assert.match(r.notExecutedReason ?? "", /shop/);
  assert.match(r.notExecutedReason ?? "", /refusing to start/);
  assert.equal(r.targets[0]!.started, false);
});

test("startTargets: an install that fails → not executed with the repo and its output; the app is not started", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const a = app(d, "shop", await freePort());
  a.acceptance.env = { ...a.acceptance.env, FIXTURE_INSTALL: "fail" };
  const r = await start(d, [a]);
  assert.match(r.notExecutedReason ?? "", /shop/);
  assert.match(r.notExecutedReason ?? "", /failed on purpose/);
  assert.deepEqual(r.seen, []);
});

test("startTargets: no answer before the start timeout → \"did not respond\", the process group is killed", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const procs = new PlatformProcesses();
  const r = await start(d, [app(d, "shop", await freePort(), { mode: "nolisten" })], { startTimeoutMs: 2000, processes: procs });
  assert.match(r.notExecutedReason ?? "", /shop did not respond/);
  assert.match(r.notExecutedReason ?? "", /not listening/);
  assert.equal(r.seen.length, 1);
  assert.ok(await waitFor(() => !groupAlive(r.seen[0]!)), "the group is gone");
  assert.equal(r.targets[0]!.pgid, null);
});

test("startTargets: two repos start in mapping order (api, then web) and stop in reverse", { skip, timeout: 90_000 }, async () => {
  const d = await runDirs();
  const r = await start(d, [app(d, "api", await freePort(), { entry: "api" }), app(d, "web", await freePort())]);
  assert.equal(r.notExecutedReason, null, JSON.stringify(r.targets));
  assert.deepEqual(r.targets.map((t) => t.repo), ["api", "web"]);
  assert.deepEqual(r.targets.map((t) => t.pgid), r.seen);
  assert.equal(r.processes.size, 2);
  await stop(d, r.targets, r.processes);
  assert.equal(r.processes.size, 0);
  assert.equal(readFileSync(join(d.workDir, "stop-order.log"), "utf8"), "web\napi\n");
  for (const p of r.seen) assert.equal(groupAlive(p), false);
});

test("killLeftovers: recognises a sandboxed target app of the run (by SLACKOFF_RUN_ROOT) and kills it; another run root leaves it", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const r = await start(d, [app(d, "shop", await freePort())]);
  assert.equal(r.notExecutedReason, null, JSON.stringify(r.targets));
  const pgid = r.targets[0]!.pgid!;
  killLeftovers(`${d.runRoot}x`, [pgid]);
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(groupAlive(pgid), "a different run root does not match");
  killLeftovers(d.runRoot, [pgid]);
  assert.ok(await waitFor(() => !groupAlive(pgid)), "the run's app is killed");
  r.processes.remove(pgid);
});

// ---------------------------------------------------------------- fix round 1 (I5, M2, M7)

test("startProcess M2: exited resolves once the output is drained (tail complete)", async () => {
  const p = startProcess(process.execPath, ["-e", "process.stdout.write('y'.repeat(200000) + 'END')"], { cwd: root, env: { PATH: process.env.PATH }, tailBytes: 64 });
  assert.equal(await p.exited, 0);
  assert.ok(p.tail().endsWith("END"), p.tail());
});

test("startTargets I5: two targets on the same port are refused before anything starts", { skip }, async () => {
  const d = await runDirs();
  const port = await freePort();
  const r = await start(d, [app(d, "api", port, { entry: "api" }), app(d, "web", port)]);
  assert.match(r.notExecutedReason ?? "", new RegExp(`api and web both use port ${port}`));
  assert.deepEqual(r.seen, []);
});

test("startTargets I5: a port taken after the first check (before the next start) → not executed, the next app not started", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const webPort = await freePort();
  let squatter: Awaited<ReturnType<typeof listen>> | null = null;
  const procs = new PlatformProcesses();
  try {
    const r = await startTargets({
      workDir: d.workDir,
      repos: [app(d, "api", await freePort(), { entry: "api" }), app(d, "web", webPort)],
      startTimeoutMs: 20_000, commandTimeoutMs: 30_000, runRoot: d.runRoot, sandbox: scopeOf(d), processes: procs,
      onPgid: (p) => {
        pgids.push(p);
        // another process grabs web's port while api is starting
        if (squatter === null) void listen("127.0.0.1", webPort).then((l) => (squatter = l));
      },
    });
    assert.match(r.notExecutedReason ?? "", new RegExp(`port ${webPort} is already in use`));
    assert.equal(r.targets[1]!.started, false);
    assert.equal(r.targets[1]!.pgid, null);
    assert.equal(existsSync(join(d.workDir, "web/installed.txt")), false, "web was not even installed");
    await stopTargets(r.targets, d.workDir, { env: targetEnv({}, d.runRoot), sandbox: scopeOf(d), processes: procs, runRoot: d.runRoot });
    assert.equal(procs.size, 0);
  } finally {
    (squatter as Awaited<ReturnType<typeof listen>> | null)?.server.close();
  }
});

test("startTargets I5: an answer from another process while the app has already exited is not \"ready\"", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const port = await freePort();
  let impostor: Awaited<ReturnType<typeof listen>> | null = null;
  try {
    const r = await startTargets({
      workDir: d.workDir,
      repos: [app(d, "shop", port, { mode: "fail", healthPath: "/" })],
      startTimeoutMs: 10_000, commandTimeoutMs: 30_000, runRoot: d.runRoot, sandbox: scopeOf(d), processes: new PlatformProcesses(),
      onPgid: async (p) => {
        pgids.push(p);
        impostor = await listenHttp(port);
      },
    });
    assert.match(r.notExecutedReason ?? "", /shop exited before it was ready/);
    assert.equal(r.targets[0]!.started, false);
  } finally {
    (impostor as Awaited<ReturnType<typeof listen>> | null)?.server.close();
  }
});

/** A plain HTTP answer on 127.0.0.1:port (an impostor app). */
function listenHttp(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((res, rej) => {
    const server = createServer((c) => c.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"));
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res({ server, port }));
  });
}

test("stopTargets M7: forces the acceptance kind and the run root, so the stop command runs even with a scope missing them", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const r = await start(d, [app(d, "shop", await freePort())]);
  assert.equal(r.notExecutedReason, null);
  const { runRoot: _, ...bare } = scopeOf(d);
  await stopTargets(r.targets, d.workDir, { env: targetEnv({}, d.runRoot), sandbox: { ...bare, kind: "acceptance-install" }, processes: r.processes, runRoot: d.runRoot });
  assert.equal(readFileSync(join(d.workDir, "stop-order.log"), "utf8"), "shop\n");
  assert.equal(r.processes.size, 0);
});

// ---------------------------------------------------------------- fix round 2 (ruling T6-7)

test("startProcess T6-7 (M4): exited resolves when the leader exits even while a background child still holds stdout", async () => {
  const p = startProcess("/bin/sh", ["-c", "sleep 30 & echo started"], { cwd: root, env: { PATH: "/usr/bin:/bin" }, tailBytes: 1024 });
  pgids.push(p.pgid);
  const t0 = Date.now();
  const code = await Promise.race([p.exited, new Promise<"hung">((r) => setTimeout(() => r("hung"), 5_000))]);
  assert.equal(code, 0, "resolved on the leader's exit");
  assert.ok(Date.now() - t0 < 3_000);
  assert.match(p.tail(), /started/);
  assert.ok(groupAlive(p.pgid), "the background child is still there (the caller stops the group)");
  process.kill(-p.pgid, "SIGKILL");
});

test("runProcess T6-7 (M5): stdoutFile is created exclusively (an existing file is refused), and no fd is left open when spawn throws", async () => {
  const out = join(root, "exists.out");
  writeFileSync(out, "keep");
  await assert.rejects(runProcess(process.execPath, ["-e", "1"], { stdoutFile: out }), /EEXIST/);
  assert.equal(readFileSync(out, "utf8"), "keep");
  const inFile = join(root, "in.txt");
  writeFileSync(inFile, "x");
  const fds = () => readdirSync("/dev/fd").length;
  const before = fds();
  for (let i = 0; i < 5; i++) {
    // a NUL in an argument makes spawn throw synchronously
    await assert.rejects(runProcess(process.execPath, ["bad\0arg"], { stdinFile: inFile, stdoutFile: join(root, `o${i}.out`) }));
  }
  assert.equal(fds(), before, "fds closed");
});

test("startTargets T6-7 (M4): a start whose leader exits while a background child answers is not \"ready\"", { skip, timeout: 60_000 }, async () => {
  const d = await runDirs();
  const r = await start(d, [app(d, "shop", await freePort(), { mode: "daemonize" })]);
  assert.match(r.notExecutedReason ?? "", /shop exited before it was ready/);
  assert.equal(r.targets[0]!.started, false);
  assert.ok(await waitFor(() => !groupAlive(r.seen[0]!)), "the whole group, the background child included, is killed");
});
