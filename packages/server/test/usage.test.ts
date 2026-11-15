// A zone far from UTC so the by-day grouping (local time) differs from the UTC date
process.env.TZ = "Pacific/Kiritimati";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, parseConfig } from "../src/config.ts";
import { EventBus } from "../src/http/events.ts";
import { createApp } from "../src/http/app.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { usageSummary } from "../src/cost/usage-repo.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { tmpDir } from "./helpers/tmp.ts";

const dir = tmpDir("usage");
after(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-11-08T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
const budget = parseConfig({}).budget;
let n = 0;

function insertRun(db: ReturnType<typeof openDatabase>, o: { ticket?: string | null; role?: string; executor?: "claude-code" | "claude-api"; status?: string; cost?: number | null; usage?: string | null; start: string; end?: string | null }) {
  db.prepare(
    `INSERT INTO agent_run (id, ticket_key, role, executor, status, cost_usd, usage_json, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(`r${++n}`, o.ticket ?? null, o.role ?? "refine-ticket", o.executor ?? "claude-code", o.status ?? "ok", o.cost ?? null, o.usage ?? null, o.start, o.end === undefined ? o.start : o.end);
}
const withMinutes = (startAgo: number, minutes: number) => ({ start: iso(startAgo), end: new Date(new Date(iso(startAgo)).getTime() + minutes * 60_000).toISOString() });
const usage = (i: number, o: number, cr = 0, cw = 0) => JSON.stringify({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

function seeded() {
  const db = openDatabase(join(dir, `u${++n}.db`));
  db.exec(`INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('A-1','First ticket','new','x','x'), ('A-2','Second','new','x','x')`);
  // A-1: one subscription run (10 min, estimate 0.5), one API run (5 min, 1.25 USD), one failed run without cost
  insertRun(db, { ticket: "A-1", ...withMinutes(60, 10), cost: 0.5, usage: usage(100, 50, 1000, 20) });
  insertRun(db, { ticket: "A-1", executor: "claude-api", role: "propose-solutions", ...withMinutes(30, 5), cost: 1.25, usage: usage(200, 80) });
  insertRun(db, { ticket: "A-1", status: "error", ...withMinutes(20, 1), cost: null, usage: null });
  // A-2: usage_json that is not JSON, and a run that is still running (ended_at null, started 4 minutes ago)
  insertRun(db, { ticket: "A-2", ...withMinutes(50, 2), cost: 0.1, usage: "{not json" });
  insertRun(db, { ticket: "A-2", status: "running", start: iso(4), end: null });
  // no ticket (discovery)
  insertRun(db, { ticket: null, role: "jira-browser", ...withMinutes(40, 3), cost: 0.2, usage: usage(10, 5) });
  // outside the 5h window: 6 hours ago; and exactly on the boundary (5h ago) which counts
  insertRun(db, { ticket: "A-1", ...withMinutes(360, 100), cost: 9, usage: usage(9999, 9999) });
  insertRun(db, { ticket: "A-2", ...withMinutes(300, 1), cost: 0.3, usage: usage(1, 1) });
  return db;
}

test("totals match the hand sums; outside the window is not counted; the boundary is", () => {
  const db = seeded();
  const s = usageSummary(db, { window: "5h", now: NOW, executor: "claude-code", budget });
  assert.equal(s.totals.runs, 7);
  assert.equal(s.totals.failedRuns, 1);
  // 10 + 5 + 1 + 2 + 4 (running, to now) + 3 + 1
  assert.ok(Math.abs(s.totals.runMinutes - 26) < 0.01, String(s.totals.runMinutes));
  assert.equal(s.totals.inputTokens, 100 + 200 + 10 + 1);
  assert.equal(s.totals.outputTokens, 50 + 80 + 5 + 1);
  assert.equal(s.totals.cacheReadTokens, 1000);
  assert.equal(s.totals.cacheWriteTokens, 20);
  assert.ok(Math.abs(s.totals.usd - 1.25) < 1e-9);
  assert.ok(Math.abs(s.totals.estimateUsd - (0.5 + 0.1 + 0.2 + 0.3)) < 1e-9);
  assert.equal(s.since, iso(300));
  const week = usageSummary(db, { window: "week", now: NOW, executor: "claude-code", budget });
  assert.equal(week.totals.runs, 8);
});

test("invalid usage_json counts zero tokens and does not throw; null cost counts zero", () => {
  const db = seeded();
  const s = usageSummary(db, { window: "5h", now: NOW, executor: "claude-code", budget });
  const a2 = s.byTicket.find((t) => t.ticketKey === "A-2")!;
  assert.equal(a2.runs, 3);
  assert.equal(a2.inputTokens, 1);
  assert.equal(a2.title, "Second");
});

test("byTicket: null ticket is a row, ordered by cost descending; byRole; byDay in local time", () => {
  const db = seeded();
  const s = usageSummary(db, { window: "5h", now: NOW, executor: "claude-code", budget });
  assert.deepEqual(s.byTicket.map((t) => t.ticketKey), ["A-1", "A-2", null]);
  assert.equal(s.byTicket[2]!.title, null);
  assert.equal(s.byRole.find((r) => r.role === "jira-browser")!.runs, 1);
  // 12:00Z is 02:00 on the 9th in Pacific/Kiritimati (UTC+14), whose day began 120 minutes ago: only the run 300 minutes
  // ago is still on the 8th
  assert.deepEqual(s.byDay.map((d) => [d.day, d.runs]), [["2026-11-08", 1], ["2026-11-09", 6]]);
  const week = usageSummary(db, { window: "week", now: NOW, executor: "claude-code", budget });
  assert.equal(week.byDay.reduce((a, d) => a + d.runs, 0), 8);
});

test("byTicket has at most 50 rows", () => {
  const db = openDatabase(join(dir, `many${++n}.db`));
  for (let i = 0; i < 60; i++) {
    db.prepare(`INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES (?,?,'new','x','x')`).run(`T-${i}`, "t");
    insertRun(db, { ticket: `T-${i}`, start: iso(10), cost: i });
  }
  const s = usageSummary(db, { window: "5h", now: NOW, executor: "claude-code", budget });
  assert.equal(s.byTicket.length, 50);
  assert.equal(s.byTicket[0]!.ticketKey, "T-59");
});

test("budget progress counts the current executor only and maxUsd applies to the API executor only", () => {
  const db = seeded();
  const b = { ...budget, enabled: true, maxRuns: 10, maxUsd: 2.5 };
  const sub = usageSummary(db, { window: "5h", now: NOW, executor: "claude-code", budget: b });
  assert.equal(sub.budget!.used.runs, 6); // the API run is not counted
  assert.equal(sub.budget!.limits.usd, null);
  assert.equal(sub.budget!.ratio, 0.6);
  assert.equal(sub.budget!.state, "ok");
  const api = usageSummary(db, { window: "5h", now: NOW, executor: "claude-api", budget: b });
  assert.equal(api.budget!.used.runs, 1);
  assert.equal(api.budget!.used.usd, 1.25);
  assert.equal(api.budget!.ratio, 0.5);
  assert.equal(usageSummary(db, { window: "5h", now: NOW, executor: "claude-api", budget }).budget, null);
});

// The 4c target is about 200 ms alone; under a loaded full-suite run it measured up to 2.15 s, so the gate is a
// regression guard (an accidental per-row JSON parse or an O(n²) scan takes many seconds), not the target itself.
test("10,000 runs with multi-KB usage_json aggregate in well under the regression bound", () => {
  const db = openDatabase(join(dir, `big${++n}.db`));
  const big = JSON.stringify({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 1, pad: "x".repeat(4000) });
  db.exec("BEGIN");
  const ins = db.prepare(`INSERT INTO agent_run (id, ticket_key, role, executor, status, cost_usd, usage_json, started_at, ended_at) VALUES (?,NULL,'refine-ticket','claude-code','ok',0.01,?,?,?)`);
  for (let i = 0; i < 10_000; i++) ins.run(`b${i}`, big, iso(i % 290), iso((i % 290) - 1));
  db.exec("COMMIT");
  // best of three: the whole suite runs in parallel with other test files, which can stall one measurement
  let ms = Infinity;
  let s = usageSummary(db, { window: "5h", now: NOW, executor: "claude-code", budget });
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    s = usageSummary(db, { window: "5h", now: NOW, executor: "claude-code", budget });
    ms = Math.min(ms, performance.now() - t0);
  }
  assert.equal(s.totals.runs, 10_000);
  assert.equal(s.totals.inputTokens, 50_000);
  assert.ok(ms < 3_000, `${ms} ms`);
});

function httpSetup() {
  const home = tmpDir("usage-http");
  const db = openDatabase(join(home, "slackoff.db"));
  const config = loadConfig(home);
  const bus = new EventBus();
  const workflow = createWorkflow({ updater: noUpdater, db, home, queue: new JobQueue(1, { onError: () => {} }), source: new FakeTicketSource(), run: (async () => { throw new Error("no"); }) as never, config, bus });
  const app = createApp({ db, home, repoRoot: join(import.meta.dirname, "..", "..", ".."), workflow, bus, config });
  const get = (path: string) => app.request(path, { headers: { host: "127.0.0.1:4317" } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  return { get, db };
}

test("GET /api/usage returns the summary; an unknown window is 400", async () => {
  const { get, db } = httpSetup();
  insertRun(db, { start: new Date().toISOString(), cost: 0.4 });
  const ok = await get("/api/usage?window=day");
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { window: string; totals: { runs: number }; executor: string; budget: unknown };
  assert.equal(body.window, "day");
  assert.equal(body.totals.runs, 1);
  assert.equal(body.executor, "claude-code");
  assert.equal(body.budget, null);
  assert.equal((await get("/api/usage")).status, 200);
  assert.equal((await get("/api/usage?window=x")).status, 400);
});

// ---- final fix pass (ruling F4C-1, I-2) ----

test("F4C-1 I-2: restart recovery ends a running run at its raw log's last write, or else at its start (never at the restart)", async () => {
  const { mkdirSync, utimesSync, writeFileSync } = await import("node:fs");
  const { recoverOnStartup } = await import("../src/workflow/recovery.ts");
  const db = openDatabase(join(dir, `u${++n}.db`));
  const started = new Date(Date.now() - 10 * 3_600_000);
  const lastWrite = new Date(started.getTime() + 3 * 60_000);
  mkdirSync(join(dir, "runs"), { recursive: true });
  const log = join(dir, "runs", "rec-1.jsonl");
  writeFileSync(log, "{}\n");
  utimesSync(log, lastWrite, lastWrite);
  const ins = db.prepare(`INSERT INTO agent_run (id, role, executor, status, raw_log_path, started_at) VALUES (?, 'refine-ticket', 'claude-code', 'running', ?, ?)`);
  ins.run("rec-1", log, started.toISOString());
  ins.run("rec-2", join(dir, "runs", "missing.jsonl"), started.toISOString());
  const wf = { recoverAcceptanceRuns() {}, resume() {} } as unknown as Parameters<typeof recoverOnStartup>[1];
  recoverOnStartup(db, wf);
  const ended = (id: string) => (db.prepare("SELECT status, error, ended_at FROM agent_run WHERE id = ?").get(id) as { status: string; error: string; ended_at: string });
  assert.equal(ended("rec-1").status, "error");
  assert.equal(ended("rec-1").error, "interrupted by restart");
  assert.equal(ended("rec-1").ended_at, lastWrite.toISOString());
  assert.equal(ended("rec-2").ended_at, started.toISOString());
  const s = usageSummary(db, { window: "day", now: new Date(), executor: "claude-code", budget: { ...budget, enabled: true, window: "day", maxRunMinutes: 60 } });
  assert.ok(Math.abs(s.totals.runMinutes - 3) < 0.01, String(s.totals.runMinutes));
  assert.equal(s.budget!.state, "ok");
});

test("F4C-1 I-2: one run's minutes are capped at its executor timeout (both attempts); acceptance uses its own timeout", () => {
  const db = openDatabase(join(dir, `u${++n}.db`));
  // rows closed by the old recovery: 600 minutes each
  insertRun(db, { ...withMinutes(610, 600) });
  insertRun(db, { role: "acceptance-review", ...withMinutes(610, 600) });
  insertRun(db, { status: "running", start: iso(600), end: null });
  const b = { ...budget, enabled: true, window: "day" as const, maxRunMinutes: 1000 };
  const s = usageSummary(db, { window: "day", now: NOW, executor: "claude-code", budget: b, acceptanceRunTimeoutMs: 1_800_000 });
  // 20 (2 × 10 min) + 60 (2 × 30 min) + 20
  assert.equal(Math.round(s.totals.runMinutes), 100);
  assert.equal(Math.round(s.budget!.used.runMinutes), 100);
  assert.equal(Math.round(s.byRole.find((r) => r.role === "acceptance-review")!.runMinutes), 60);
});
