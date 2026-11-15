// Process-level tests of main.ts (port 4317 on 127.0.0.1): single instance and signal handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { tmpDir } from "./helpers/tmp.ts";

const mainTs = resolve(import.meta.dirname, "../src/main.ts");
const fakeClaude = resolve(import.meta.dirname, "fixtures/fake-claude.ts");
const PORT = 4317;

/** Bind 127.0.0.1:4317, or null when something else already holds it. */
const holdPort = (): Promise<Server | null> =>
  new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(null));
    s.listen(PORT, "127.0.0.1", () => res(s));
  });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function startMain(home: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [mainTs], { env: { ...process.env, SLACKOFF_HOME: home, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, output: () => out, exited };
}

const dump = (home: string) => {
  const db = openDatabase(join(home, "slackoff.db"));
  try {
    return JSON.stringify(["ticket", "agent_run", "audit_event"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  } finally {
    db.close();
  }
};

test("a second instance on a port already in use changes nothing and exits with 'already running'", async () => {
  const home = tmpDir("main");
  writeFileSync(join(home, "config.json"), JSON.stringify({ jira: { baseUrl: "https://jira.example.com" }, executor: { claudeBin: "/nonexistent/claude" } }));
  // the live instance's state: a ticket being refined by an agent that is still running
  const db = openDatabase(join(home, "slackoff.db"));
  db.exec(`INSERT INTO ticket (key, title, state, review_ac, created_at, updated_at) VALUES ('P-1','t','refining',0,'x','x')`);
  db.exec(`INSERT INTO agent_run (id, ticket_key, role, executor, status, started_at) VALUES ('r1','P-1','refine-ticket','claude-code','running','x')`);
  db.close();
  const before = dump(home);

  const held = await holdPort(); // null: something else already holds 4317, which is just as good here
  try {
    const m = startMain(home);
    const { code } = await m.exited;
    assert.notEqual(code, 0);
    assert.match(m.output(), /already running/i);
    assert.doesNotMatch(m.output(), /\n\s+at\s/, "no stack trace");
    assert.equal(dump(home), before, "no DB changes: no runs marked interrupted, no ticket resumed");
  } finally {
    held?.close();
  }
});

test("SIGHUP (terminal closed) shuts down gracefully and stops running agents", async (t) => {
  const probe = await holdPort();
  if (!probe) return t.skip("port 4317 is in use");
  await new Promise((r) => probe.close(r));

  const home = tmpDir("main");
  const pidFile = join(home, "pids.json");
  const bin = join(home, "claude.sh");
  writeFileSync(bin, `#!/bin/sh\nexport FAKE_CLAUDE_SCENARIO=hang-tree FAKE_CLAUDE_PID_FILE='${pidFile}'\nexec '${process.execPath}' '${fakeClaude}' "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(home, "config.json"), JSON.stringify({ jira: { baseUrl: "https://jira.example.com" }, executor: { claudeBin: bin } }));

  const m = startMain(home);
  let child: ChildProcess | null = m.child;
  try {
    await waitFor(() => m.output().includes("listening on"));
    const res = await fetch(`http://127.0.0.1:${PORT}/api/discover`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` },
      body: "{}",
    });
    assert.equal(res.status, 202);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
    const { pid, child: grandchild } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; child: number };
    assert.ok(alive(pid) && alive(grandchild));

    m.child.kill("SIGHUP");
    const { code, signal } = await m.exited;
    child = null;
    assert.equal(signal, null, `exited by itself, not killed by SIGHUP (output: ${m.output()})`);
    assert.equal(code, 0);
    await waitFor(() => !alive(pid) && !alive(grandchild), 5000);
  } finally {
    child?.kill("SIGKILL");
    // never leave fake agents behind when an assertion failed
    if (existsSync(pidFile)) {
      const p = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; child?: number };
      for (const id of [p.pid, p.child]) if (id && alive(id)) process.kill(id, "SIGKILL");
    }
  }
});
