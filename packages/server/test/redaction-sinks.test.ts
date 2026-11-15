// Phase 4b fix round 1 (ruling 4B-2, I2): every place an error text leaves the process goes through the redaction of
// every credential value this process has read or written. One test per sink. Fake values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { tmpDir } from "./helpers/tmp.ts";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { upsertDiscovered, getTicket } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { writeCredentials } from "../src/credentials/credential-store.ts";
import { logError } from "../src/log.ts";
import { InvalidAgentOutputError, runAgent } from "../src/executor/run-agent.ts";
import type { Executor } from "../src/executor/types.ts";
import type { TicketSource } from "../src/jira/ticket-source.ts";

const AT = "2026-11-09T10:00:00.000Z";

/** A fresh home with a stored fake key (so this process knows it). */
function withKey() {
  const home = tmpDir("sink");
  const apiKey = `test-key-${randomBytes(8).toString("hex")}`;
  writeCredentials(home, { jira: null, anthropic: { apiKey, updatedAt: AT }, otlpHeaders: null });
  return { home, apiKey };
}

function captureConsoleError<T>(fn: () => Promise<T> | T): Promise<{ out: string; value: T }> {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.map((x) => (x instanceof Error ? (x.stack ?? x.message) : String(x))).join(" "));
  return Promise.resolve()
    .then(fn)
    .then(
      (value) => ({ out: lines.join("\n"), value }),
    )
    .finally(() => {
      console.error = orig;
    });
}

test("sink: EventBus.emit redacts every string of the event (SSE source_error, discover_finished, agent events)", () => {
  const { apiKey } = withKey();
  const bus = new EventBus();
  const got: BusEvent[] = [];
  bus.subscribe((e) => got.push(e));
  bus.emit({ type: "source_error", message: `401: ${apiKey}` });
  bus.emit({ type: "discover_finished", created: 0, returned: 0, total: 0, complete: false, error: `bad ${apiKey}` });
  bus.emit({ type: "agent_event", role: "refine-ticket", runId: "r", event: { kind: "text", text: `echo ${apiKey}` } });
  const text = JSON.stringify(got);
  assert.ok(!text.includes(apiKey), text);
  assert.equal((got[0] as { message: string }).message, "401: [redacted]");
});

test("sink: a blocked reason (ticket and its state_changed audit) is redacted", () => {
  const { home, apiKey } = withKey();
  const db = openDatabase(join(home, "slackoff.db"));
  upsertDiscovered(db, { key: "P-1", title: "T", url: "https://your-company.atlassian.net/browse/P-1", status: "Ready for Dev" }, false);
  transition(db, "P-1", "blocked", "system", `failed with ${apiKey}`);
  assert.equal(getTicket(db, "P-1")!.blockedReason, "failed with [redacted]");
  const audit = JSON.stringify(db.prepare("SELECT payload_json FROM audit_event").all());
  assert.ok(!audit.includes(apiKey), audit);
  db.close();
});

function workflowWith(source: TicketSource) {
  const { home, apiKey } = withKey();
  const db = openDatabase(join(home, "slackoff.db"));
  const config = loadConfig(home);
  config.jira.baseUrl = "https://your-company.atlassian.net";
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const queue = new JobQueue(1, { onError: () => {} });
  const run = async () => { throw new Error("agent must not run"); };
  const wf = createWorkflow({ updater: noUpdater, db, home, queue, source, run: run as never, config, bus });
  return { home, apiKey, db, bus, events, queue, wf };
}

test("sink: jobs fail() — the error of a failed job is redacted in the ticket's blocked reason", async () => {
  let key = "";
  const s = workflowWith({
    discover: async () => { throw new Error("unused"); },
    fetchTicket: async () => { throw new Error(`JIRA said 401 for ${key}`); },
  });
  key = s.apiKey;
  upsertDiscovered(s.db, { key: "P-1", title: "T", url: "https://your-company.atlassian.net/browse/P-1", status: "Ready for Dev" }, false);
  s.wf.refine("P-1", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "P-1")!;
  assert.equal(t.state, "blocked");
  assert.equal(t.blockedReason, "JIRA said 401 for [redacted]");
  s.db.close();
});

test("sink: discovery failed({error}) and its source_error are redacted", async () => {
  let key = "";
  const s = workflowWith({
    discover: async () => { throw new Error(`search failed: Authorization Basic ${key}`); },
    fetchTicket: async () => { throw new Error("unused"); },
  });
  key = s.apiKey;
  s.wf.discover();
  await s.queue.idle();
  const text = JSON.stringify(s.events);
  assert.ok(!text.includes(key), text);
  const done = s.events.find((e) => e.type === "discover_finished") as { error?: string } | undefined;
  assert.equal(done?.error, "search failed: Authorization Basic [redacted]");
  s.db.close();
});

test("sink: the queue's default onError logs a redacted error (stack and AggregateError parts included)", async () => {
  const { apiKey } = withKey();
  const { out } = await captureConsoleError(async () => {
    const q = new JobQueue(1);
    q.enqueue("j1", async () => { throw new Error(`boom ${apiKey}`); });
    q.enqueue("j2", async () => { throw new AggregateError([new Error(`inner ${apiKey}`)], "outer"); });
    await q.idle();
  });
  assert.ok(!out.includes(apiKey), out);
  assert.match(out, /boom \[redacted\]/);
  assert.match(out, /inner \[redacted\]/);
});

test("sink: logError (the server's error log) redacts", async () => {
  const { apiKey } = withKey();
  const { out } = await captureConsoleError(() => logError(`Recovery: could not resume P-1: ${apiKey}`));
  assert.equal(out, "Recovery: could not resume P-1: [redacted]");
});

const runDeps = (home: string, executor: Executor) => {
  const db = openDatabase(join(home, "run.db"));
  return { db, deps: { db, repoRoot: join(import.meta.dirname, "..", "..", ".."), executor, home, bus: new EventBus() } };
};
const runReq = { role: "refine-ticket" as const, prompt: "p", cwd: "/", allowedTools: [], chrome: false, schema: z.object({ answer: z.string() }) };

test("sink: runAgent rethrows the executor's error with a redacted message and stack", async () => {
  const { home, apiKey } = withKey();
  const { db, deps } = runDeps(home, { kind: "claude-code", exec: async () => { throw new Error(`401 invalid x-api-key ${apiKey}`); } });
  await assert.rejects(runAgent(deps, runReq), (e: unknown) => e instanceof Error && e.message === "401 invalid x-api-key [redacted]" && !(e.stack ?? "").includes(apiKey));
  db.close();
});

test("sink: InvalidAgentOutputError (and agent_run.error) never carry a value echoed in the output", async () => {
  const { home, apiKey } = withKey();
  // JSON.parse quotes the first 10 characters of a bad text: a truncated echo no redaction can catch (4B-2: redact
  // before truncating), so the parse error is not quoted at all
  const exec: Executor["exec"] = async () => ({ text: `${apiKey} trailing`, usage: null, costUsd: null, permissionDenials: [] });
  const { db, deps } = runDeps(home, { kind: "claude-code", exec });
  await assert.rejects(runAgent(deps, { ...runReq, retries: 0 }), (e: unknown) => e instanceof InvalidAgentOutputError && !e.message.includes(apiKey.slice(0, 10)) && !(e.stack ?? "").includes(apiKey.slice(0, 10)));
  const row = db.prepare("SELECT error FROM agent_run").get() as { error: string };
  assert.ok(!row.error.includes(apiKey.slice(0, 10)), row.error);
  db.close();
});

test("4B-6: EventBus.emit also redacts Error instances (message and stack) and class instances' own string fields", () => {
  const { apiKey } = withKey();
  class Detail {
    note = `saw ${apiKey}`;
    count = 1;
  }
  const bus = new EventBus();
  const got: unknown[] = [];
  bus.subscribe((e) => got.push(e));
  const err = new Error(`401 for ${apiKey}`);
  bus.emit({ type: "source_error", message: "x", err, detail: new Detail() } as never);
  const e = got[0] as { err: Error; detail: Detail };
  assert.equal(e.err.message, "401 for [redacted]");
  assert.ok(!(e.err.stack ?? "").includes(apiKey));
  assert.ok(e.err instanceof Error);
  assert.equal(e.detail.note, "saw [redacted]");
  assert.ok(e.detail instanceof Detail);
});

// ---- final fix pass (F4B-5, M-1): every error log line goes through logError (redacted) ----

test("F4B-5 (M-1): no file under src/ but log.ts (and main.ts's startup lines) calls console.error / console.warn", async () => {
  const { readdirSync: ls, readFileSync: read } = await import("node:fs");
  const { join: j, relative: rel } = await import("node:path");
  const srcDir = j(import.meta.dirname, "..", "src");
  const offenders: string[] = [];
  for (const e of ls(srcDir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.(ts|mjs)$/.test(e.name)) continue;
    const file = j(e.parentPath, e.name);
    const name = rel(srcDir, file);
    if (name === "log.ts" || name === "main.ts") continue;
    read(file, "utf8").split("\n").forEach((line, i) => {
      if (/console\.(error|warn)\(/.test(line)) offenders.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
