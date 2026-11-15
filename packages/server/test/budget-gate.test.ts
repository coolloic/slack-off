import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { z } from "zod";
import { openDatabase } from "../src/db/database.ts";
import { parseConfig, loadConfig, type Config } from "../src/config.ts";
import { ClaudeCodeExecutor, passFakeClaudeEnvForTests } from "../src/executor/claude-code.ts";
passFakeClaudeEnvForTests();
import { runAgent } from "../src/executor/run-agent.ts";
import { UsageLimitError, type Executor } from "../src/executor/types.ts";
import { budgetGate, currentPause, pauseUsage, resumeUsage, UsagePausedError } from "../src/cost/budget-gate.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import { createApp } from "../src/http/app.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { tmpDir } from "./helpers/tmp.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fake = resolve(import.meta.dirname, "fixtures/fake-claude.ts");
const Schema = z.object({ answer: z.string() });
const NOW = new Date("2026-11-08T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

let home: string;
const opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
});
beforeEach(() => {
  home = tmpDir("gate");
  process.env.FAKE_CLAUDE_JSON = JSON.stringify({ answer: "42" });
});

const cfg = (budget: Partial<Config["budget"]> = {}, kind: Config["executor"]["kind"] = "claude-code"): Config =>
  parseConfig({ executor: { kind }, jira: { source: kind === "claude-api" ? "api" : "browser" }, budget: { enabled: true, ...budget } });

function setup(config: Config = cfg({ maxRuns: 3 }), executor?: Executor) {
  const db = openDatabase(join(home, "t.db"));
  opened.push(db);
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  let calls = 0;
  const stub: Executor = executor ?? {
    kind: "claude-code",
    exec: async () => {
      calls++;
      return { text: "```json\n{\"answer\":\"42\"}\n```", usage: null, costUsd: null, permissionDenials: [] };
    },
  };
  const gate = budgetGate({ db, config: () => config, now: () => NOW, bus });
  const deps = { db, repoRoot, executor: stub, home, bus, gate };
  const req = { role: "refine-ticket" as const, prompt: "go", cwd: home, allowedTools: [], chrome: false, schema: Schema };
  const addRuns = (n: number, o: { executor?: string; minutes?: number; cost?: number | null } = {}) => {
    for (let i = 0; i < n; i++) {
      db.prepare(`INSERT INTO agent_run (id, role, executor, status, cost_usd, started_at, ended_at) VALUES (?, 'refine-ticket', ?, 'ok', ?, ?, ?)`)
        .run(`x${Math.random()}`, o.executor ?? "claude-code", o.cost ?? null, minutesAgo(60), minutesAgo(60 - (o.minutes ?? 1)));
    }
  };
  const audits = () => db.prepare("SELECT type, payload_json FROM audit_event ORDER BY id").all() as Array<{ type: string; payload_json: string }>;
  return { db, bus, events, deps, req, gate, addRuns, audits, calls: () => calls };
}

test("a run over maxRuns is refused before the executor, pauses with reason threshold and audits it", async () => {
  const s = setup();
  s.addRuns(3);
  await assert.rejects(runAgent(s.deps, s.req), (e) => e instanceof UsagePausedError && e.pause.reason === "threshold");
  assert.equal(s.calls(), 0);
  const p = currentPause(s.db)!;
  assert.equal(p.reason, "threshold");
  assert.match(p.detail, /runs reached 3\/3 in the last 5h/);
  assert.deepEqual(s.audits().map((a) => a.type), ["usage_paused"]);
  assert.equal(JSON.parse(s.audits()[0]!.payload_json).reason, "threshold");
  assert.ok(s.events.some((e) => e.type === "usage_changed"));
  // no agent_run row was written for the refused run
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM agent_run").get() as { n: number }).n, 3);
});

test("under the limit the run goes ahead; write roles pass even when paused", async () => {
  const s = setup();
  s.addRuns(2);
  assert.deepEqual(await runAgent(s.deps, s.req), { answer: "42" });
  assert.equal(s.calls(), 1);
  s.addRuns(1);
  assert.throws(() => s.gate.check("refine-ticket"), UsagePausedError);
  assert.doesNotThrow(() => s.gate.check("jira-update"));
  assert.doesNotThrow(() => s.gate.check("jira-comment"));
  assert.throws(() => s.gate.check("implement-ticket"), UsagePausedError);
  assert.throws(() => s.gate.check("acceptance-review"), UsagePausedError);
});

test("pauseUsage returns the existing pause; the pause survives a new connection; resume clears it", () => {
  const s = setup();
  const a = pauseUsage(s.db, "manual", "going out", "local", s.bus);
  const b = pauseUsage(s.db, "threshold", "other", "system", s.bus);
  assert.equal(b.id, a.id);
  assert.equal(b.reason, "manual");
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM usage_pause").get() as { n: number }).n, 1);
  const again = openDatabase(join(home, "t.db"));
  opened.push(again);
  assert.equal(currentPause(again)?.detail, "going out");
  resumeUsage(s.db, "device:abc", s.bus);
  assert.equal(currentPause(s.db), null);
  resumeUsage(s.db, "local", s.bus); // not paused: nothing happens
  assert.deepEqual(s.audits().map((x) => x.type), ["usage_paused", "usage_resumed"]);
  assert.equal(JSON.parse(s.audits()[1]!.payload_json).by, "device:abc");
});

test("budget.enabled false never pauses; maxUsd applies to the API executor only", () => {
  const off = setup(parseConfig({ budget: { enabled: false, maxRuns: 1 } }));
  off.addRuns(5);
  assert.doesNotThrow(() => off.gate.check("refine-ticket"));
  const sub = setup(cfg({ maxUsd: 1 }));
  sub.addRuns(2, { cost: 5 });
  assert.doesNotThrow(() => sub.gate.check("refine-ticket"));
});

test("maxUsd on the API executor pauses; the other executor's runs do not count", () => {
  const api = setup(cfg({ maxUsd: 1 }, "claude-api"));
  api.addRuns(3, { executor: "claude-code", cost: 5 });
  assert.doesNotThrow(() => api.gate.check("refine-ticket"));
  api.addRuns(1, { executor: "claude-api", cost: 1.5 });
  assert.throws(() => api.gate.check("refine-ticket"), (e) => e instanceof UsagePausedError && /USD reached 1\.50\/1\.00/.test(e.pause.detail));
});

test("maxRunMinutes counts a run that is still running up to now", () => {
  // (within the run's own cap: F4C-1 I-2 caps one run at its executor timeout for both attempts, 20 minutes here)
  const s = setup(cfg({ maxRunMinutes: 10 }));
  s.db.prepare(`INSERT INTO agent_run (id, role, executor, status, started_at) VALUES ('live','refine-ticket','claude-code','running',?)`).run(minutesAgo(15));
  assert.throws(() => s.gate.check("refine-ticket"), (e) => e instanceof UsagePausedError && /run minutes reached/.test(e.pause.detail));
});

test("warnAt reached but not the limit: no pause, the run goes ahead", () => {
  const s = setup(cfg({ maxRuns: 10, warnAt: 0.8 }));
  s.addRuns(8);
  assert.doesNotThrow(() => s.gate.check("refine-ticket"));
  assert.equal(currentPause(s.db), null);
});

test("a lowered limit pauses the next run only: the run in progress is not interrupted", async () => {
  const config = cfg({ maxRuns: 10 });
  const s = setup(config);
  s.addRuns(2);
  const slow: Executor = {
    kind: "claude-code",
    exec: async () => {
      config.budget.maxRuns = 1; // lowered while this run is in progress
      return { text: "```json\n{\"answer\":\"42\"}\n```", usage: null, costUsd: null, permissionDenials: [] };
    },
  };
  assert.deepEqual(await runAgent({ ...s.deps, executor: slow }, s.req), { answer: "42" });
  await assert.rejects(runAgent(s.deps, s.req), UsagePausedError);
});

test("the CLI's usage-limit error is a UsageLimitError and pauses with reason limit_reached", async () => {
  process.env.FAKE_CLAUDE_SCENARIO = "usage-limit";
  const s = setup(cfg(), new ClaudeCodeExecutor([process.execPath, fake]));
  await assert.rejects(runAgent(s.deps, s.req), (e) => e instanceof UsageLimitError && e.detail === "Claude usage limit reached. Your limit will reset at 3pm.");
  const p = currentPause(s.db)!;
  assert.equal(p.reason, "limit_reached");
  assert.equal(p.pausedBy, "system");
  assert.equal(p.detail, "Claude usage limit reached. Your limit will reset at 3pm.");
  assert.equal((s.db.prepare("SELECT status FROM agent_run").get() as { status: string }).status, "error");
  // an ordinary CLI error is not one
  process.env.FAKE_CLAUDE_SCENARIO = "is-error";
  resumeUsage(s.db, "local", s.bus);
  const s2 = setup(cfg(), new ClaudeCodeExecutor([process.execPath, fake]));
  await assert.rejects(runAgent(s2.deps, s2.req), (e) => !(e instanceof UsageLimitError));
});

// ---- HTTP ----

function httpSetup(config?: Config) {
  const h = tmpDir("gate-http");
  const db = openDatabase(join(h, "slackoff.db"));
  const c = config ?? loadConfig(h);
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const workflow = createWorkflow({ updater: noUpdater, db, home: h, queue: new JobQueue(1, { onError: () => {} }), source: new FakeTicketSource(), run: (async () => { throw new Error("no"); }) as never, config: c, bus });
  const app = createApp({ db, home: h, repoRoot, workflow, bus, config: c });
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { host: "127.0.0.1:4317", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  return { db, json, events, config: c, home: h };
}

test("POST /api/usage/pause and /resume: status, usage and audit follow; the pause is the request's", async () => {
  const h = httpSetup();
  assert.deepEqual(((await (await h.json("GET", "/api/status")).json()) as { usage: unknown }).usage, { paused: null, budgetState: null, budgetRatio: null, budgetWindow: null, waitingTickets: 0 });
  const r = await h.json("POST", "/api/usage/pause", { note: "out for lunch" });
  assert.equal(r.status, 200);
  const st = (await (await h.json("GET", "/api/status")).json()) as { usage: { paused: { reason: string; detail: string; pausedBy: string } } };
  assert.equal(st.usage.paused.reason, "manual");
  assert.match(st.usage.paused.detail, /out for lunch/);
  assert.equal(st.usage.paused.pausedBy, "local");
  assert.equal(((await (await h.json("GET", "/api/usage")).json()) as { paused: { reason: string } }).paused.reason, "manual");
  assert.equal((await h.json("POST", "/api/usage/pause", { note: "x".repeat(500) })).status, 200); // already paused: unchanged
  assert.equal((await h.json("POST", "/api/usage/resume")).status, 200);
  assert.equal(((await (await h.json("GET", "/api/status")).json()) as { usage: { paused: unknown } }).usage.paused, null);
  assert.equal(h.events.filter((e) => e.type === "usage_changed").length, 2);
});

test("/api/status.usage.budgetState is warn at warnAt and over at the limit; waitingTickets counts Paused: blocks", async () => {
  const c = cfg({ maxRuns: 5, warnAt: 0.8 });
  const h = httpSetup(c);
  for (let i = 0; i < 4; i++) {
    h.db.prepare(`INSERT INTO agent_run (id, role, executor, status, started_at, ended_at) VALUES (?, 'refine-ticket','claude-code','ok',?,?)`).run(`w${i}`, new Date().toISOString(), new Date().toISOString());
  }
  const state = async () => ((await (await h.json("GET", "/api/status")).json()) as { usage: { budgetState: string; waitingTickets: number } }).usage;
  assert.equal((await state()).budgetState, "warn");
  h.db.prepare(`INSERT INTO agent_run (id, role, executor, status, started_at, ended_at) VALUES ('w9','refine-ticket','claude-code','ok',?,?)`).run(new Date().toISOString(), new Date().toISOString());
  assert.equal((await state()).budgetState, "over");
  h.db.exec(`INSERT INTO ticket (key, title, state, blocked_reason, created_at, updated_at) VALUES ('A-1','t','blocked','Paused: x — resume','x','x'), ('A-2','t','blocked','boom','x','x')`);
  assert.equal((await state()).waitingTickets, 1);
});

test("PUT /api/config: budget values are validated (warnAt 1 is 400) and a phone-editable block", async () => {
  const h = httpSetup();
  const body = (budget: unknown) => ({ ...h.config, budget });
  const bad = await h.json("PUT", "/api/config", body({ ...h.config.budget, warnAt: 1 }));
  assert.equal(bad.status, 400);
  for (const budget of [{ maxRuns: 0 }, { maxRuns: 10001 }, { maxRuns: 1.5 }, { maxRunMinutes: 0 }, { maxUsd: 0 }, { maxUsd: 100001 }, { warnAt: 0.4 }, { window: "30d" }]) {
    assert.equal((await h.json("PUT", "/api/config", body({ ...h.config.budget, ...budget }))).status, 400, JSON.stringify(budget));
  }
  const ok = await h.json("PUT", "/api/config", body({ enabled: true, window: "day", maxRuns: 20, maxRunMinutes: 120, maxUsd: 5, warnAt: 0.9 }));
  assert.equal(ok.status, 200);
  assert.equal(h.config.budget.maxRuns, 20);
});

// ---- fix round 1 (4C-1, M2): only the CLI's own wording, first line, never stderr ----

async function limitRun(text: string): Promise<unknown> {
  home = tmpDir("gate-m2"); // a fresh database per text: an earlier pause would refuse the run
  process.env.FAKE_CLAUDE_SCENARIO = "is-error";
  process.env.FAKE_CLAUDE_ERROR_TEXT = text;
  const s = setup(cfg(), new ClaudeCodeExecutor([process.execPath, fake]));
  try {
    await runAgent(s.deps, s.req);
    return null;
  } catch (e) {
    return { limit: e instanceof UsageLimitError, paused: currentPause(s.db) !== null };
  } finally {
    delete process.env.FAKE_CLAUDE_ERROR_TEXT;
  }
}

test("M2: other texts that mention quota, a rate limit or a usage limit are ordinary errors", async () => {
  for (const text of ["quota.ts failed", "disk quota exceeded", "Error: rate limit docs missing in README", "The ticket says: usage limit reached for customers", "Failed to parse src/quota.ts\nClaude usage limit reached"]) {
    assert.deepEqual(await limitRun(text), { limit: false, paused: false }, text);
  }
});

test("M2: the CLI's own wordings and the API 429 / rate_limit_error are usage limits", async () => {
  for (const text of ["Claude usage limit reached. Your limit will reset at 3pm.", "5-hour limit reached ∙ resets 3pm", "API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"x\"}}", "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}"]) {
    assert.deepEqual(await limitRun(text), { limit: true, paused: true }, text);
  }
});

test("M2: stderr never decides (a usage-limit sentence on stderr only)", async () => {
  const { USAGE_LIMIT_RE } = await import("../src/executor/types.ts");
  assert.equal(USAGE_LIMIT_RE.test("claude failed: quota"), false);
});

test("L1: after a restart (a new connection) a run is refused with the Paused wording", () => {
  const s = setup();
  pauseUsage(s.db, "manual", "out for lunch", "local");
  const again = openDatabase(join(home, "t.db"));
  opened.push(again);
  const gate = budgetGate({ db: again, config: () => cfg() });
  assert.throws(() => gate.check("refine-ticket"), (e: Error) => e instanceof UsagePausedError && e.message === "Paused: out for lunch");
});

// ---- final fix pass (ruling F4C-1) ----

test("F4C-1 I-1: a billed error result (error_max_turns) records its cost and usage on the failed run", async () => {
  process.env.FAKE_CLAUDE_SCENARIO = "max-turns";
  try {
    const s = setup(cfg(), new ClaudeCodeExecutor([process.execPath, fake]));
    await assert.rejects(runAgent(s.deps, s.req));
    const row = s.db.prepare("SELECT status, cost_usd, usage_json FROM agent_run").get() as { status: string; cost_usd: number | null; usage_json: string | null };
    assert.equal(row.status, "error");
    assert.equal(row.cost_usd, 3.5);
    assert.deepEqual(JSON.parse(row.usage_json!), { input_tokens: 1200, output_tokens: 340 });
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
});

test("F4C-1 I-1: on the API key a billed failed run counts against maxUsd (the next run pauses)", async () => {
  process.env.FAKE_CLAUDE_SCENARIO = "max-turns";
  try {
    const inner = new ClaudeCodeExecutor([process.execPath, fake]);
    const api: Executor = { kind: "claude-api", exec: (r, e) => inner.exec(r, e) };
    const config = cfg({ maxUsd: 3 }, "claude-api");
    const s = setup(config, api);
    await assert.rejects(runAgent(s.deps, s.req), (e) => !(e instanceof UsagePausedError));
    // the run was started on the real clock: check it with a gate on the real clock
    const live = budgetGate({ db: s.db, config: () => config });
    assert.throws(() => live.check("refine-ticket"), (e) => e instanceof UsagePausedError && /USD reached 3\.50\/3\.00/.test(e.pause.detail));
  } finally {
    delete process.env.FAKE_CLAUDE_SCENARIO;
  }
});

test("F4C-1 I-1: a failure after a billed attempt keeps the earlier attempt's cost too", async () => {
  let n = 0;
  const flaky: Executor = {
    kind: "claude-api",
    exec: async () => {
      n++;
      if (n === 1) return { text: "not json", usage: { input_tokens: 5 }, costUsd: 0.25, permissionDenials: [] };
      throw Object.assign(new Error("claude failed (exit 1): "), { runCost: { usage: { input_tokens: 7 }, costUsd: 1 } });
    },
  };
  const s = setup(cfg({}, "claude-api"), flaky);
  await assert.rejects(runAgent(s.deps, s.req));
  const row = s.db.prepare("SELECT cost_usd, usage_json FROM agent_run").get() as { cost_usd: number; usage_json: string };
  assert.equal(row.cost_usd, 1.25);
  assert.deepEqual(JSON.parse(row.usage_json), { input_tokens: 7 });
});
