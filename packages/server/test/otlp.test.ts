// Phase 4c tasks 4-5: OTLP/HTTP JSON spans for agent runs (metadata by default), the export records, and the
// confirmed export. No network: the export goes through an injected fake fetch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, parseConfig } from "../src/config.ts";
import { SERVER_PORT, WEB_DEV_PORT } from "../src/ports.ts";
import { buildOtlpPayload, rawLogReader, SPAN_NAME, CONTENT_LIMIT_BYTES, MAX_TOOL_NAMES, type AgentRunRow } from "../src/telemetry/otlp.ts";
import { exportableRuns, previewExport } from "../src/telemetry/export-repo.ts";
import { redactorWith } from "../src/credentials/credential-store.ts";
import { EventBus } from "../src/http/events.ts";
import { createApp, type AppDeps } from "../src/http/app.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { tmpDir } from "./helpers/tmp.ts";

const dir = tmpDir("otlp");
after(() => rmSync(dir, { recursive: true, force: true }));

// fixture strings that must never leave the machine with includeContent off
const PROMPT = "Implement the refund flow described in the ticket text: customers with order 77 get money back";
const OUTPUT = "I changed src/refund.ts and wrote the tests; the secret plan is in the description";
const ERROR_TEXT = "claude exited: ENOENT /work/example-org/api/node_modules";
const REPO_PATH = "/work/example-org/api";
const JIRA_URL = "https://your-company.atlassian.net";

let n = 0;
function db() {
  return openDatabase(join(dir, `o${++n}.db`));
}

function logLines(o: { prompt?: string; output?: string; tools?: string[] }): string {
  const lines: unknown[] = [{ type: "system", subtype: "init", cwd: REPO_PATH, session_id: "s" }];
  if (o.prompt !== undefined) lines.push({ type: "user", message: { role: "user", content: [{ type: "text", text: o.prompt }] } });
  (o.tools ?? []).forEach((name, i) => {
    lines.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name, input: { file_path: `${REPO_PATH}/src/x.ts` } }] } });
    lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `contents of ${REPO_PATH}/src/x.ts` }] } });
  });
  if (o.output !== undefined) {
    lines.push({ type: "assistant", message: { content: [{ type: "text", text: o.output }] } });
    lines.push({ type: "result", subtype: "success", is_error: false, result: o.output, total_cost_usd: 0.12, usage: { input_tokens: 1200, output_tokens: 340 } });
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

function insertRun(
  d: ReturnType<typeof db>,
  home: string,
  o: { id: string; ticket?: string | null; status?: string; start?: string; end?: string | null; error?: string | null; log?: string | null; cost?: number | null; usage?: string | null; executor?: string },
) {
  let rawLogPath: string | null = null;
  if (o.log !== null) {
    rawLogPath = join(home, "runs", `${o.id}.jsonl`);
    if (o.log !== undefined) {
      mkdirSync(join(home, "runs"), { recursive: true });
      writeFileSync(rawLogPath, o.log);
    }
  }
  if (o.ticket) d.prepare("INSERT OR IGNORE INTO ticket (key, title, state, created_at, updated_at) VALUES (?, 'T', 'new', 'x', 'x')").run(o.ticket);
  d.prepare(
    `INSERT INTO agent_run (id, ticket_key, role, executor, skill_version, prompt_version_id, status, cost_usd, usage_json, raw_log_path, error, started_at, ended_at)
     VALUES (?, ?, 'implement-ticket', ?, '1.2.0', NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id, o.ticket ?? null, o.executor ?? "claude-code", o.status ?? "ok", o.cost === undefined ? 0.12 : o.cost,
    o.usage === undefined ? JSON.stringify({ input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5 }) : o.usage,
    rawLogPath, o.error ?? null, o.start ?? "2026-11-08T10:00:00.000Z", o.end === undefined ? "2026-11-08T10:02:30.500Z" : o.end,
  );
}

const rows = (d: ReturnType<typeof db>) => d.prepare("SELECT * FROM agent_run ORDER BY started_at, id").all() as unknown as AgentRunRow[];

type Attr = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; arrayValue?: { values: Array<{ stringValue?: string }> } } };
type Span = { traceId: string; spanId: string; name: string; startTimeUnixNano: string; endTimeUnixNano: string; status: { code: number }; attributes: Attr[]; events?: Array<{ name: string; attributes: Attr[] }> };
type Payload = { resourceSpans: Array<{ resource: { attributes: Attr[] }; scopeSpans: Array<{ scope: { name: string }; spans: Span[] }> }> };
const spansOf = (p: object) => (p as Payload).resourceSpans[0]!.scopeSpans[0]!.spans;
const attr = (s: Span, key: string) => s.attributes.find((a) => a.key === key)?.value;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fixture() {
  const home = tmpDir("otlp-home");
  const d = db();
  const log = logLines({ prompt: PROMPT, output: OUTPUT, tools: ["Read", "Edit", "Read", "Bash"] });
  insertRun(d, home, { id: "run-1", ticket: "SO-7", log, start: "2026-11-08T10:00:00.000Z" });
  insertRun(d, home, { id: "run-2", ticket: "SO-7", status: "error", error: ERROR_TEXT, log, start: "2026-11-08T10:05:00.000Z" });
  insertRun(d, home, { id: "run-3", ticket: null, log: logLines({ prompt: PROMPT, output: OUTPUT }), start: "2026-11-08T10:06:00.000Z" });
  return { home, d };
}

// ---------------------------------------------------------------- task 4: spans

test("three runs (two of one ticket, one without) → two traces; ids are sha256-derived; the resource and scope", async () => {
  const { home, d } = fixture();
  const p = await buildOtlpPayload(rows(d), { includeContent: false, readRawLog: rawLogReader(home), serviceVersion: "9.9.9" }) as Payload;
  const rs = p.resourceSpans;
  assert.equal(rs.length, 1);
  assert.deepEqual(rs[0]!.resource.attributes, [
    { key: "service.name", value: { stringValue: "slack-off" } },
    { key: "service.version", value: { stringValue: "9.9.9" } },
  ]);
  assert.equal(rs[0]!.scopeSpans[0]!.scope.name, "slack-off");
  const spans = spansOf(p);
  assert.equal(spans.length, 3);
  assert.ok(spans.every((s) => s.name === SPAN_NAME && SPAN_NAME === "slackoff.agent_run"));
  const [a, b, c] = spans as [Span, Span, Span];
  assert.equal(a.traceId, sha("SO-7").slice(0, 32));
  assert.equal(b.traceId, a.traceId);
  assert.equal(c.traceId, sha("run-3").slice(0, 32));
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 2);
  assert.equal(a.spanId, sha("run-1").slice(0, 16));
  assert.equal(b.spanId, sha("run-2").slice(0, 16));
  assert.match(a.traceId, /^[0-9a-f]{32}$/);
  assert.match(a.spanId, /^[0-9a-f]{16}$/);
  // unix nanoseconds as strings
  assert.equal(a.startTimeUnixNano, String(BigInt(Date.parse("2026-11-08T10:00:00.000Z")) * 1_000_000n));
  assert.equal(a.endTimeUnixNano, String(BigInt(Date.parse("2026-11-08T10:02:30.500Z")) * 1_000_000n));
  assert.deepEqual([a.status.code, b.status.code], [1, 2]);
});

test("C-8 metadata attributes: role, ticket, executor, status, versions, duration, tokens (gen_ai too), cost, tools, error category", async () => {
  const { home, d } = fixture();
  const [a, b, c] = spansOf(await buildOtlpPayload(rows(d), { includeContent: false, readRawLog: rawLogReader(home), serviceVersion: "1" })) as [Span, Span, Span];
  assert.equal(attr(a, "slackoff.role")?.stringValue, "implement-ticket");
  assert.equal(attr(a, "slackoff.ticket_key")?.stringValue, "SO-7");
  assert.equal(attr(c, "slackoff.ticket_key"), undefined);
  assert.equal(attr(a, "slackoff.executor")?.stringValue, "claude-code");
  assert.equal(attr(a, "slackoff.status")?.stringValue, "ok");
  assert.equal(attr(a, "slackoff.skill_version")?.stringValue, "1.2.0");
  assert.equal(attr(a, "slackoff.duration_ms")?.intValue, "150500");
  assert.equal(attr(a, "gen_ai.usage.input_tokens")?.intValue, "1200");
  assert.equal(attr(a, "gen_ai.usage.output_tokens")?.intValue, "340");
  assert.equal(attr(a, "slackoff.usage.input_tokens")?.intValue, "1200");
  assert.equal(attr(a, "slackoff.usage.cache_read_input_tokens")?.intValue, "5");
  assert.equal(attr(a, "slackoff.cost_usd")?.doubleValue, 0.12);
  // C-1: a subscription run's cost is an API-equivalent estimate
  assert.equal(attr(a, "slackoff.cost_kind")?.stringValue, "api_equivalent_estimate");
  assert.equal(attr(a, "slackoff.tool_calls")?.intValue, "4");
  assert.deepEqual(attr(a, "slackoff.tools")?.arrayValue?.values.map((v) => v.stringValue), ["Bash:1", "Edit:1", "Read:2"]);
  assert.deepEqual(a.events?.map((e) => [e.name, e.attributes]), ["Read", "Edit", "Read", "Bash"].map((t) => ["tool", [{ key: "tool.name", value: { stringValue: t } }]]));
  assert.equal(attr(a, "slackoff.error_category"), undefined);
  assert.equal(attr(b, "slackoff.error_category")?.stringValue, "not_found");
  assert.equal(attr(b, "error.type")?.stringValue, "not_found");
});

test("includeContent off: no prompt, output, error text, repo path, JIRA URL or home path anywhere in the payload", async () => {
  const { home, d } = fixture();
  const json = JSON.stringify(await buildOtlpPayload(rows(d), { includeContent: false, readRawLog: rawLogReader(home), serviceVersion: "1" }));
  for (const s of [PROMPT, OUTPUT, ERROR_TEXT, REPO_PATH, JIRA_URL, home, "refund", "ENOENT", "src/x.ts", "contents of"]) {
    assert.ok(!json.includes(s), `the payload must not contain ${JSON.stringify(s)}`);
  }
  assert.ok(!json.includes("slackoff.prompt") && !json.includes("slackoff.output"));
});

test("includeContent on: the prompt and the output, redacted first and then cut to 32 KB per item", async () => {
  const home = tmpDir("otlp-home");
  const d = db();
  const secret = `fake-otlp-secret-${randomBytes(8).toString("hex")}`;
  const redact = redactorWith([secret]);
  // the secret straddles the 32 KB cut: truncating first would leave its start in the span
  const long = "p".repeat(CONTENT_LIMIT_BYTES - 6) + secret + "tail";
  insertRun(d, home, { id: "run-c", ticket: "SO-8", log: logLines({ prompt: long, output: `${OUTPUT} ${secret}` }) });
  const [s] = spansOf(await buildOtlpPayload(rows(d), { includeContent: true, readRawLog: rawLogReader(home), serviceVersion: "1", redact })) as [Span];
  const prompt = attr(s, "slackoff.prompt")?.stringValue ?? "";
  const output = attr(s, "slackoff.output")?.stringValue ?? "";
  assert.ok(Buffer.byteLength(prompt) <= CONTENT_LIMIT_BYTES, String(Buffer.byteLength(prompt)));
  assert.ok(prompt.startsWith("pppp"));
  assert.ok(!prompt.includes(secret.slice(0, 10)), "a partial secret survived the cut");
  assert.match(prompt, /truncated/);
  assert.ok(output.startsWith(OUTPUT));
  assert.ok(!output.includes(secret));
  assert.match(output, /\[redacted\]/);
  // the error text is still never sent, and neither is the repo path from the tool inputs
  const json = JSON.stringify(spansOf(await buildOtlpPayload(rows(d), { includeContent: true, readRawLog: rawLogReader(home), serviceVersion: "1", redact })));
  assert.ok(!json.includes(REPO_PATH));
});

test("a missing or unreadable raw log → no events and no tool attributes, never an error; at most 200 events", async () => {
  const home = tmpDir("otlp-home");
  const d = db();
  insertRun(d, home, { id: "run-gone" }); // a path, but no file
  insertRun(d, home, { id: "run-null", log: null });
  insertRun(d, home, { id: "run-many", log: logLines({ tools: Array.from({ length: 250 }, (_, i) => (i % 2 ? "Read" : "Grep")) }), start: "2026-11-08T11:00:00.000Z" });
  insertRun(d, home, { id: "run-bad", log: "{not json\n" + JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "../../etc/passwd x" }] } }) + "\n" });
  const spans = spansOf(await buildOtlpPayload(rows(d), { includeContent: true, readRawLog: rawLogReader(home), serviceVersion: "1" }));
  const by = (id: string) => spans.find((s) => s.spanId === sha(id).slice(0, 16))!;
  for (const id of ["run-gone", "run-null"]) {
    assert.deepEqual(by(id).events ?? [], []);
    assert.equal(attr(by(id), "slackoff.prompt"), undefined);
  }
  assert.equal(by("run-many").events!.length, 200);
  assert.equal((by("run-many") as Span & { droppedEventsCount?: number }).droppedEventsCount, 50);
  assert.equal(attr(by("run-many"), "slackoff.tool_calls")?.intValue, "250");
  // a tool name that is not a plain identifier is never copied
  assert.deepEqual(by("run-bad").events?.map((e) => e.attributes[0]!.value.stringValue), ["other"]);
});

test("rawLogReader reads only regular files under <home>/runs", async () => {
  const home = tmpDir("otlp-home");
  mkdirSync(join(home, "runs"), { recursive: true });
  writeFileSync(join(home, "runs", "ok.jsonl"), "x\n");
  writeFileSync(join(home, "outside.jsonl"), "secret\n");
  const read = rawLogReader(home);
  assert.equal(await read(join(home, "runs", "ok.jsonl")), "x\n");
  assert.equal(await read(join(home, "outside.jsonl")), null);
  assert.equal(await read(join(home, "runs", "..", "outside.jsonl")), null);
  assert.equal(await read("/etc/hosts"), null);
  assert.equal(await read(join(home, "runs", "missing.jsonl")), null);
  // 4C-2 (M-3): asynchronous, at most 4 MB per log
  const read1 = read(join(home, "runs", "ok.jsonl"));
  assert.ok(read1 instanceof Promise);
  await read1;
  writeFileSync(join(home, "runs", "big.jsonl"), "y".repeat(5 * 1024 * 1024));
  assert.equal((await read(join(home, "runs", "big.jsonl")))!.length, 4 * 1024 * 1024);
});

// ---------------------------------------------------------------- task 4: the endpoint setting

test("telemetry.endpoint: https://, or http:// on a loopback host; never Slack Off's port, user info, query or fragment", async () => {
  assert.deepEqual(parseConfig({}).telemetry, { endpoint: "", includeContent: false });
  for (const ok of ["", "https://otel.example.com/v1/traces", "http://127.0.0.1:4318/v1/traces", "http://localhost:4318/v1/traces", "http://[::1]:4318/v1/traces", "https://otel.example.com:4317/v1/traces"]) {
    assert.equal(parseConfig({ telemetry: { endpoint: ok } }).telemetry.endpoint, ok, ok);
  }
  for (const bad of [
    "http://example.com/v1/traces",
    `http://127.0.0.1:${SERVER_PORT}/v1/traces`,
    `http://localhost:${WEB_DEV_PORT}/v1/traces`,
    `https://127.0.0.1:${SERVER_PORT}/v1/traces`,
    `http://[::1]:${SERVER_PORT}/v1/traces`,
    "https://user:pass@otel.example.com/v1/traces",
    "https://token@otel.example.com/v1/traces",
    "https://otel.example.com/v1/traces?api_key=abc",
    "https://otel.example.com/v1/traces#x",
    "ftp://otel.example.com/v1/traces",
    "file:///etc/passwd",
    "otel.example.com/v1/traces",
    "http://10.0.0.5:4318/v1/traces",
  ]) {
    assert.throws(() => parseConfig({ telemetry: { endpoint: bad } }), /telemetry\.endpoint/, bad);
  }
});

const TS2 = { ip: "100.101.102.103", dnsName: null };
const PHONE_ENV = { incoming: { socket: { remoteAddress: "100.88.1.2" } } };
const LOOP_ENV = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

async function appSetup(extra: Partial<AppDeps> = {}) {
  const home = tmpDir("otlp-app");
  const d = openDatabase(join(home, "slackoff.db"));
  const config = loadConfig(home);
  const bus = new EventBus();
  const run = async () => { throw new Error("agent must not run in otlp tests"); };
  const workflow = createWorkflow({ updater: noUpdater, db: d, home, queue: new JobQueue(1, { onError: () => {} }), source: new FakeTicketSource(), run: run as never, config, bus });
  const app = createApp({ db: d, home, repoRoot: join(import.meta.dirname, "..", "..", ".."), workflow, bus, config, remote: TS2, ...extra });
  const call = (env: typeof LOOP_ENV, host: string, method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(path, { method, headers: { host, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const local = (method: string, path: string, body?: unknown) => call(LOOP_ENV, "127.0.0.1:4317", method, path, body);
  const { code } = (await (await local("POST", "/api/pair/start")).json()) as { code: string };
  const redeemed = await call(PHONE_ENV, `${TS2.ip}:4317`, "POST", "/api/pair/redeem", { code, deviceName: "Pixel" });
  const cookie = `slackoff_session=${/slackoff_session=([^;]+)/.exec(redeemed.headers.get("set-cookie") ?? "")![1]!}`;
  const deviceId = ((await redeemed.json()) as { device: { id: number } }).device.id;
  const phone = (method: string, path: string, body?: unknown) => call(PHONE_ENV, `${TS2.ip}:4317`, method, path, body, cookie);
  return { home, db: d, config, bus, app, local, phone, deviceId };
}

test("a paired phone cannot change telemetry (endpoint or includeContent): 403; this computer can", async () => {
  const s = await appSetup();
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, unknown>;
  for (const telemetry of [{ endpoint: "https://otel.example.com/v1/traces", includeContent: false }, { endpoint: "", includeContent: true }]) {
    const res = await s.phone("PUT", "/api/config", { ...cfg, telemetry });
    assert.equal(res.status, 403, JSON.stringify(telemetry));
  }
  assert.deepEqual(s.config.telemetry, { endpoint: "", includeContent: false });
  const ok = await s.local("PUT", "/api/config", { ...cfg, telemetry: { endpoint: "https://otel.example.com/v1/traces", includeContent: true } });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.deepEqual(s.config.telemetry, { endpoint: "https://otel.example.com/v1/traces", includeContent: true });
  // the phone's other edits still work while telemetry stays as it is
  const cfg2 = (await (await s.phone("GET", "/api/config")).json()) as Record<string, unknown>;
  assert.equal((await s.phone("PUT", "/api/config", { ...cfg2, autoRefine: true })).status, 200);
});

// ---------------------------------------------------------------- task 4: export records

test("exportableRuns: finished runs not yet exported, oldest first, at most 500; previewExport is null until configured", async () => {
  const { home, d } = fixture();
  insertRun(d, home, { id: "run-live", status: "running", end: null, start: "2026-11-08T09:00:00.000Z" });
  assert.deepEqual(exportableRuns(d, { limit: 500 }).map((r) => r.id), ["run-1", "run-2", "run-3"]);
  assert.deepEqual(exportableRuns(d, { limit: 2 }).map((r) => r.id), ["run-1", "run-2"]);
  assert.equal(exportableRuns(d, { limit: 10_000 }).length, 3);
  assert.equal(previewExport(d, parseConfig({})), null);
  const config = parseConfig({ telemetry: { endpoint: "https://otel.example.com/v1/traces" } });
  const p = previewExport(d, config)!;
  assert.equal(p.endpointHost, "otel.example.com");
  assert.equal(p.runCount, 3);
  assert.equal(p.includeContent, false);
  assert.match(p.runIdsHash, /^[0-9a-f]{64}$/);
  assert.ok(p.attributes.includes("slackoff.ticket_key") && !p.attributes.includes("slackoff.prompt"));
  // the content switch and the destination are bound into the hash too
  assert.notEqual(previewExport(d, parseConfig({ telemetry: { endpoint: "https://otel.example.com/v1/traces", includeContent: true } }))!.runIdsHash, p.runIdsHash);
  assert.notEqual(previewExport(d, parseConfig({ telemetry: { endpoint: "https://other.example.com/v1/traces" } }))!.runIdsHash, p.runIdsHash);
  assert.ok(previewExport(d, parseConfig({ telemetry: { endpoint: "https://otel.example.com/v1/traces", includeContent: true } }))!.attributes.includes("slackoff.prompt"));
  // an exported run never shows up again
  const exportId = Number(
    d.prepare(`INSERT INTO telemetry_export (endpoint_host, run_ids_json, run_ids_hash, include_content, span_count, decided_by, requested_at, status) VALUES ('otel.example.com','["run-1"]','h',0,1,'local','t','done')`).run().lastInsertRowid,
  );
  d.prepare("INSERT INTO agent_run_exported (run_id, export_id) VALUES ('run-1', ?)").run(exportId);
  assert.deepEqual(exportableRuns(d, { limit: 500 }).map((r) => r.id), ["run-2", "run-3"]);
  assert.equal(previewExport(d, config)!.runCount, 2);
});

// ---------------------------------------------------------------- task 5: the confirmed export (fake fetch only)

interface Sent {
  url: string;
  init: RequestInit;
  body: Payload;
}
type Reply = Response | ((init: RequestInit) => Promise<Response>);

/** A fetch that records each call and answers from `replies` (the last one repeats); never touches the network. */
function fakeFetch(replies: Reply[] = [new Response("{}", { status: 200 })]) {
  const sent: Sent[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "null")) as Payload });
    const r = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    return typeof r === "function" ? r(init ?? {}) : r.clone();
  }) as typeof fetch;
  return { fn, sent };
}

const ENDPOINT = "https://otel.example.com/v1/traces";
const fakeHeader = () => `fake-otlp-auth-${randomBytes(8).toString("hex")}`;

async function exportSetup(o: { replies?: Reply[]; timeoutMs?: number; endpoint?: string; includeContent?: boolean } = {}) {
  const f = fakeFetch(o.replies);
  const s = await appSetup({ otlpFetch: f.fn, ...(o.timeoutMs ? { otlpTimeoutMs: o.timeoutMs } : {}) });
  const header = fakeHeader();
  assert.equal((await s.local("PUT", "/api/credentials/otlp-headers", { headers: { "x-otlp-auth": header, "content-type": "text/plain" } })).status, 200);
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, unknown>;
  const put = await s.local("PUT", "/api/config", { ...cfg, telemetry: { endpoint: o.endpoint ?? ENDPOINT, includeContent: o.includeContent ?? false } });
  assert.equal(put.status, 200, await put.clone().text());
  const log = logLines({ prompt: PROMPT, output: OUTPUT, tools: ["Read"] });
  insertRun(s.db, s.home, { id: "e-1", ticket: "SO-1", log, start: "2026-11-08T10:00:00.000Z" });
  insertRun(s.db, s.home, { id: "e-2", ticket: "SO-1", status: "error", error: ERROR_TEXT, log, start: "2026-11-08T10:01:00.000Z" });
  insertRun(s.db, s.home, { id: "e-3", ticket: null, log, start: "2026-11-08T10:02:00.000Z" });
  insertRun(s.db, s.home, { id: "e-live", ticket: "SO-1", status: "running", end: null, start: "2026-11-08T10:03:00.000Z" });
  type Preview = { endpointHost: string; runCount: number; includeContent: boolean; attributes: string[]; runIdsHash: string } | null;
  const preview = async (via = s.local) => (await (await via("GET", "/api/telemetry/preview")).json()) as Preview;
  const exportNow = (hash: string, via = s.local) => via("POST", "/api/telemetry/export", { runIdsHash: hash });
  const audits = () => s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'telemetry_exported' ORDER BY id").all().map((r) => JSON.parse((r as { payload_json: string }).payload_json) as Record<string, unknown>);
  const record = () => s.db.prepare("SELECT * FROM telemetry_export ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const exported = () => (s.db.prepare("SELECT COUNT(*) AS n FROM agent_run_exported").get() as { n: number }).n;
  return { ...s, f, header, preview, exportNow, audits, record, exported };
}

test("preview → export: one POST with JSON and the stored headers, the previewed spans; then nothing left; audited without the header", async () => {
  const s = await exportSetup();
  const p = (await s.preview())!;
  assert.equal(p.endpointHost, "otel.example.com");
  assert.equal(p.runCount, 3);
  const res = await s.exportNow(p.runIdsHash);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal(s.f.sent.length, 1);
  const [req] = s.f.sent as [Sent];
  assert.equal(req.url, ENDPOINT);
  assert.equal(req.init.method, "POST");
  assert.equal(req.init.redirect, "manual");
  assert.ok(req.init.signal instanceof AbortSignal);
  const headers = new Headers(req.init.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-otlp-auth"), s.header);
  assert.equal(req.body.resourceSpans[0]!.scopeSpans[0]!.spans.length, p.runCount);
  // metadata only: the request body has no prompt, output or error text
  const sentText = JSON.stringify(req.body);
  for (const v of [PROMPT, OUTPUT, ERROR_TEXT, REPO_PATH]) assert.ok(!sentText.includes(v), v);
  const r = s.record()!;
  assert.deepEqual([r.status, r.http_status, r.span_count, r.include_content, r.decided_by, r.endpoint_host], ["done", 200, 3, 0, "local", "otel.example.com"]);
  assert.equal(s.exported(), 3);
  assert.equal((await s.preview())!.runCount, 0);
  const [a] = s.audits() as [Record<string, unknown>];
  assert.deepEqual(a, { exportId: r.id, endpointHost: "otel.example.com", runCount: 3, includeContent: false, status: "done", httpStatus: 200, decidedBy: "local" });
  const everything = JSON.stringify(s.db.prepare("SELECT * FROM audit_event").all()) + JSON.stringify(s.db.prepare("SELECT * FROM telemetry_export").all()) + text;
  assert.ok(!everything.includes(s.header), "the header value leaked");
  // nothing left: a second confirmation of the same (now stale) preview is refused, nothing more is sent
  assert.equal((await s.exportNow(p.runIdsHash)).status, 409);
  assert.equal(s.f.sent.length, 1);
});

test("a run finished after the preview → the old hash is refused (409, preview again) and nothing is sent", async () => {
  const s = await exportSetup();
  const p = (await s.preview())!;
  insertRun(s.db, s.home, { id: "e-new", ticket: "SO-2", start: "2026-11-08T10:09:00.000Z" });
  const res = await s.exportNow(p.runIdsHash);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /the runs to export changed — preview again/);
  assert.equal(s.f.sent.length, 0);
  assert.equal(s.record(), undefined);
  // turning the content on after the preview is a change too
  const p2 = (await s.preview())!;
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, unknown>;
  assert.equal((await s.local("PUT", "/api/config", { ...cfg, telemetry: { endpoint: ENDPOINT, includeContent: true } })).status, 200);
  assert.equal((await s.exportNow(p2.runIdsHash)).status, 409);
  assert.equal(s.f.sent.length, 0);
});

test("the collector answers 500 → failed with the status, runs stay unexported, no second request; the echo is redacted", async () => {
  const header = { value: "" };
  const s = await exportSetup({ replies: [async (init) => new Response(`bad auth ${new Headers(init.headers).get("x-otlp-auth")} ${"x".repeat(2000)}`, { status: 500 })] });
  header.value = s.header;
  const p = (await s.preview())!;
  const res = await s.exportNow(p.runIdsHash);
  const text = await res.text();
  assert.equal(res.status, 502, text);
  assert.ok(!text.includes(s.header), "the header value leaked into the response");
  assert.match(text, /HTTP 500/);
  const r = s.record()!;
  assert.deepEqual([r.status, r.http_status], ["failed", 500]);
  assert.equal(r.detail, "HTTP 500: the collector reported an error");
  assert.ok(!text.includes("bad auth") && !text.includes("xxxx"));
  assert.equal(s.exported(), 0);
  assert.equal(s.f.sent.length, 1);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(s.f.sent.length, 1, "never retried");
  assert.equal((await s.preview())!.runCount, 3);
  const [a] = s.audits() as [Record<string, unknown>];
  assert.deepEqual([a.status, a.httpStatus, a.runCount], ["failed", 500, 3]);
  assert.ok(!JSON.stringify(s.audits()).includes(s.header));
});

test("the collector redirects (302) → failed, the redirect is not followed", async () => {
  const s = await exportSetup({ replies: [new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/collect" } })] });
  const p = (await s.preview())!;
  const res = await s.exportNow(p.runIdsHash);
  assert.equal(res.status, 502);
  assert.equal(s.f.sent.length, 1);
  assert.equal(s.f.sent[0]!.init.redirect, "manual");
  assert.deepEqual([s.record()!.status, s.record()!.http_status], ["failed", 302]);
  assert.match(String(s.record()!.detail), /redirect/i);
  assert.equal(s.exported(), 0);
});

test("a collector that never answers → failed after the timeout; a huge answer is read only up to a cap", async () => {
  const hang = await exportSetup({
    timeoutMs: 100,
    replies: [(init) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))],
  });
  const res = await hang.exportNow((await hang.preview())!.runIdsHash);
  assert.equal(res.status, 502);
  assert.equal(hang.record()!.status, "failed");
  assert.equal(hang.record()!.http_status, null);
  assert.match(String(hang.record()!.detail), /timed out/);
  assert.equal(hang.f.sent.length, 1);

  let pulls = 0;
  const endless = new ReadableStream<Uint8Array>({ pull: (c) => { pulls++; c.enqueue(new Uint8Array(64 * 1024).fill(65)); } });
  const big = await exportSetup({ replies: [new Response(endless, { status: 200 })] });
  const ok = await big.exportNow((await big.preview())!.runIdsHash);
  assert.equal(ok.status, 200, await ok.text());
  assert.equal(big.record()!.status, "done");
  assert.ok(pulls < 50, `read ${pulls} chunks`);
});

test("export off (no endpoint): the preview is null and an export is refused (409); nothing is sent", async () => {
  const f = fakeFetch();
  const s = await appSetup({ otlpFetch: f.fn });
  const res = await s.local("GET", "/api/telemetry/preview");
  assert.equal(res.status, 200);
  assert.equal(await res.json(), null);
  assert.equal((await s.local("POST", "/api/telemetry/export", { runIdsHash: "0".repeat(64) })).status, 409);
  assert.equal(f.sent.length, 0);
});

test("a paired phone may preview and confirm an export (C-7); decidedBy names the device; the header never reaches it", async () => {
  const s = await exportSetup();
  const p = (await s.preview(s.phone))!;
  assert.equal(p.runCount, 3);
  const res = await s.exportNow(p.runIdsHash, s.phone);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.ok(!text.includes(s.header));
  assert.equal(s.record()!.decided_by, `device:${s.deviceId}`);
  assert.equal(s.audits()[0]!.decidedBy, `device:${s.deviceId}`);
  // the phone still cannot set the headers or the endpoint
  assert.equal((await s.phone("PUT", "/api/credentials/otlp-headers", { headers: { "x-otlp-auth": fakeHeader() } })).status, 403);
});

test("one export at a time: a second confirmation while one is being sent is refused (409)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await exportSetup({ replies: [async () => (await gate, new Response("{}", { status: 200 }))] });
  const p = (await s.preview())!;
  const first = s.exportNow(p.runIdsHash);
  await new Promise((done) => setTimeout(done, 20));
  const second = await s.exportNow(p.runIdsHash);
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(s.f.sent.length, 1);
});

test("an export left running by a restart is closed as failed (never resent)", async () => {
  const { failInterruptedExports } = await import("../src/telemetry/export-repo.ts");
  const d = db();
  d.prepare(`INSERT INTO telemetry_export (endpoint_host, run_ids_json, run_ids_hash, include_content, span_count, decided_by, requested_at, status) VALUES ('otel.example.com','[]','h',0,0,'local','t','running')`).run();
  assert.equal(failInterruptedExports(d), 1);
  const r = d.prepare("SELECT status, detail FROM telemetry_export").get() as { status: string; detail: string };
  assert.equal(r.status, "failed");
  assert.match(r.detail, /interrupted by restart/);
});

// ---------------------------------------------------------------- fix round 1 (ruling 4C-2)

test("4C-2 I-1: a 401 echoing a Bearer token or a Basic key pair is never stored or shown — only a fixed text per class", async () => {
  const token = `fake-bearer-${randomBytes(8).toString("hex")}`;
  const pair = `pk-fake-${randomBytes(4).toString("hex")}:sk-fake-${randomBytes(4).toString("hex")}`;
  for (const [status, want] of [
    [401, "HTTP 401: the collector refused the export (check the endpoint and the auth headers)"],
    [403, "HTTP 403: the collector refused the export (check the endpoint and the auth headers)"],
    [503, "HTTP 503: the collector reported an error"],
    [307, "HTTP 307: the collector redirected; redirects are not followed (check the endpoint)"],
  ] as const) {
    const s = await exportSetup({ replies: [new Response(`invalid token ${token}; bad key pair ${pair}`, { status, headers: status === 307 ? { location: "https://elsewhere.example.com" } : {} })] });
    const res = await s.exportNow((await s.preview())!.runIdsHash);
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.equal(s.record()!.detail, want);
    const all = text + JSON.stringify(s.db.prepare("SELECT * FROM telemetry_export").all()) + JSON.stringify(s.db.prepare("SELECT * FROM audit_event").all());
    for (const leak of [token, pair, "pk-fake", "invalid token"]) assert.ok(!all.includes(leak), `${status}: ${leak}`);
  }
  const net = await exportSetup({ replies: [async () => { throw new Error(`connect ECONNREFUSED ${token}`); }] });
  await net.exportNow((await net.preview())!.runIdsHash);
  assert.equal(net.record()!.detail, "could not reach the collector");
});

test("4C-2 I-2: tool names — Claude Code built-ins and the configured MCP tools only, else 'other'; at most 50 distinct", async () => {
  const home = tmpDir("otlp-home");
  const d = db();
  const odd = ["PROJ-1_customer_AcmeCorp_password_hunter2_ghp_abcdefghijklmnop", "mcp__evil__exfiltrate", "mcp__claude-in-chrome__password_hunter2", "ReadSecretFile"];
  insertRun(d, home, { id: "run-t", log: logLines({ tools: ["Read", "mcp__claude-in-chrome__navigate", ...odd] }) });
  const [s] = spansOf(await buildOtlpPayload(rows(d), { includeContent: false, readRawLog: rawLogReader(home), serviceVersion: "1" })) as [Span];
  const json = JSON.stringify(s);
  for (const o of odd) assert.ok(!json.includes(o), o);
  assert.ok(!json.includes("hunter2") && !json.includes("AcmeCorp"));
  assert.deepEqual(attr(s, "slackoff.tools")?.arrayValue?.values.map((v) => v.stringValue), ["Read:1", "mcp__claude-in-chrome__navigate:1", "other:4"]);
  assert.ok(MAX_TOOL_NAMES === 50);
});

test("4C-2 NR3: a failed export uses up its hash — the same confirmation is refused; a fresh preview can be sent", async () => {
  const s = await exportSetup({ replies: [new Response("", { status: 500 }), new Response("{}", { status: 200 })] });
  const first = (await s.preview())!;
  assert.equal((await s.exportNow(first.runIdsHash)).status, 502);
  const again = await s.exportNow(first.runIdsHash);
  assert.equal(again.status, 409);
  assert.match(((await again.json()) as { error: string }).error, /preview again/);
  assert.equal(s.f.sent.length, 1);
  const fresh = (await s.preview())!;
  assert.notEqual(fresh.runIdsHash, first.runIdsHash);
  assert.equal(fresh.runCount, first.runCount);
  assert.equal((await s.exportNow(fresh.runIdsHash)).status, 200);
  assert.equal(s.f.sent.length, 2);
});

test("4C-2 M-2: header names host, content-length, transfer-encoding, connection… and non-Latin-1 values are refused at PUT; a bad stored set blocks the export", async () => {
  const s = await appSetup({ otlpFetch: fakeFetch().fn });
  const v = fakeHeader();
  for (const name of ["host", "Host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect", "proxy-authorization", "Proxy-Connection"]) {
    const res = await s.local("PUT", "/api/credentials/otlp-headers", { headers: { [name]: v } });
    assert.equal(res.status, 400, name);
    assert.ok(!(await res.text()).includes(v));
  }
  for (const bad of [`${v}€`, `${v}😀`, `${v}\u0001`]) assert.equal((await s.local("PUT", "/api/credentials/otlp-headers", { headers: { "x-otlp-auth": bad } })).status, 400, bad);
  for (const ok of [`Bearer ${v}`, `${v}é`]) assert.equal((await s.local("PUT", "/api/credentials/otlp-headers", { headers: { "x-otlp-auth": ok } })).status, 200, ok);

  // a hand-edited credentials.json with a forbidden header: the export is refused, nothing is sent
  const { readCredentials, writeCredentials } = await import("../src/credentials/credential-store.ts");
  const f = fakeFetch();
  const t = await appSetup({ otlpFetch: f.fn });
  writeCredentials(t.home, { ...readCredentials(t.home), otlpHeaders: { headers: { host: "evil.example.com", "x-otlp-auth": v }, updatedAt: "now" } });
  const cfg = (await (await t.local("GET", "/api/config")).json()) as Record<string, unknown>;
  assert.equal((await t.local("PUT", "/api/config", { ...cfg, telemetry: { endpoint: ENDPOINT, includeContent: false } })).status, 200);
  insertRun(t.db, t.home, { id: "h-1" });
  const res = await t.local("POST", "/api/telemetry/export", { runIdsHash: ((await (await t.local("GET", "/api/telemetry/preview")).json()) as { runIdsHash: string }).runIdsHash });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /headers/);
  assert.equal(f.sent.length, 0);
});

test("4C-2 M-4: when recording the outcome fails, the export is closed as failed (never left running); the next export works", async () => {
  const s = await exportSetup({ replies: [new Response("{}", { status: 200 })] });
  s.db.exec(`CREATE TRIGGER test_break_mark BEFORE INSERT ON agent_run_exported BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
  const res = await s.exportNow((await s.preview())!.runIdsHash);
  assert.ok(res.status >= 500, String(res.status));
  const r = s.record()!;
  assert.equal(r.status, "failed");
  assert.match(String(r.detail), /could not be recorded/);
  assert.equal(s.exported(), 0);
  s.db.exec("DROP TRIGGER test_break_mark");
  assert.equal((await s.exportNow((await s.preview())!.runIdsHash)).status, 200);
  assert.equal(s.exported(), 3);
});

test("4C-2 nit: mapped IPv6 loopback forms are refused for Slack Off's own ports", () => {
  for (const bad of [`http://[::ffff:127.0.0.1]:${SERVER_PORT}/v1/traces`, `https://[::ffff:127.0.0.1]:${SERVER_PORT}/v1/traces`, `https://[::ffff:7f00:1]:${WEB_DEV_PORT}/v1/traces`, `https://[0:0:0:0:0:ffff:7f00:1]:${SERVER_PORT}/x`, `https://[::ffff:0.0.0.0]:${SERVER_PORT}/x`]) {
    assert.throws(() => parseConfig({ telemetry: { endpoint: bad } }), /telemetry\.endpoint/, bad);
  }
});

// ---------------------------------------------------------------- final fix pass (ruling F4C-1)

test("F4C-1 M-2: two simultaneous confirmations of one preview → exactly one POST (one 200, one 409)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await exportSetup({ replies: [async () => (await gate, new Response("{}", { status: 200 }))] });
  const p = (await s.preview())!;
  const both = Promise.all([s.exportNow(p.runIdsHash), s.exportNow(p.runIdsHash)]);
  await new Promise((done) => setTimeout(done, 50));
  release();
  const statuses = (await both).map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(s.f.sent.length, 1);
  assert.equal(s.exported(), 3);
});

test("F4C-1 nit: partialSuccess.rejectedSpans is a whole number, at most the spans sent", async () => {
  for (const [rejected, want] of [[1e300, "the collector rejected 3 span(s)"], ["Infinity", "the collector rejected 3 span(s)"], [1.7, "the collector rejected 1 span(s)"], [0.4, null], [-2, null], ["x", null]] as const) {
    const s = await exportSetup({ replies: [new Response(JSON.stringify({ partialSuccess: { rejectedSpans: rejected } }), { status: 200 })] });
    assert.equal((await s.exportNow((await s.preview())!.runIdsHash)).status, 200);
    assert.equal(s.record()!.detail, want, String(rejected));
  }
});

// F4D-1 (I1): runAgent's first raw-log line (slackoff_system_prompt) is neither prompt, output nor a tool call
test("F4D-1 I1: the slackoff_system_prompt line adds no event, tool, prompt or output to a span", async () => {
  const home = tmpDir("otlp-home");
  const d = db();
  const first = JSON.stringify({ type: "slackoff_system_prompt", sha256: "b".repeat(64), preferenceSection: "## Developer preferences\n<preferences>\n> PREF-MARKER\n</preferences>" });
  insertRun(d, home, { id: "run-sys", log: `${first}\n${logLines({ prompt: PROMPT, output: OUTPUT, tools: ["Read"] })}` });
  insertRun(d, home, { id: "run-sys-only", log: `${first}\n` });
  const spans = spansOf(await buildOtlpPayload(rows(d), { includeContent: true, readRawLog: rawLogReader(home), serviceVersion: "1" }));
  const by = (id: string) => spans.find((s) => s.spanId === sha(id).slice(0, 16))!;
  assert.equal(attr(by("run-sys"), "slackoff.prompt")?.stringValue, PROMPT);
  assert.equal(attr(by("run-sys"), "slackoff.output")?.stringValue, OUTPUT);
  assert.equal(attr(by("run-sys"), "slackoff.tool_calls")?.intValue, "1");
  assert.deepEqual(by("run-sys-only").events ?? [], []);
  assert.equal(attr(by("run-sys-only"), "slackoff.prompt"), undefined);
  assert.equal(attr(by("run-sys-only"), "slackoff.output"), undefined);
  assert.ok(!JSON.stringify(spans).includes("PREF-MARKER"));
});
