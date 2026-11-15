// Phase 4b Task 8: fake mode's JIRA API — a fake `fetch` that answers the Jira Cloud REST paths from the fake source's
// tickets, so the real REST code (ApiJiraSource / Updater / Commenter) runs in e2e without any network. It records
// every request it answers (never the Authorization header). Fake mode's agent runs record the configured executor kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JiraUpdateResult } from "@slackoff/shared";
import { createFakeSource, FAKE_BASE_URL } from "../src/dev/fake-mode.ts";
import { createFakeJiraApi, fakeRunRecorded } from "../src/dev/fake-jira-api.ts";
import { ApiJiraCommenter, ApiJiraSource, ApiJiraUpdater } from "../src/jira/api-jira.ts";
import { JiraLoginRequiredError } from "../src/jira/ticket-source.ts";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig } from "../src/config.ts";
import { tmpDir } from "./helpers/tmp.ts";

const TOKEN = "test-token-123-not-real";

function setup(o: { creds?: boolean } = {}) {
  const home = tmpDir("fake-jira-api", "/private/var/tmp");
  const source = createFakeSource();
  source.delayMs = 0;
  const fake = createFakeJiraApi({ source, home });
  const config = loadConfig(home);
  config.jira.baseUrl = FAKE_BASE_URL;
  config.jira.source = "api";
  const deps = { fetch: fake.fetch, config: () => config.jira, credentials: () => (o.creds === false ? null : { email: "you@example.com", apiToken: TOKEN, updatedAt: "2026-11-09T10:00:00.000Z" }) };
  return { home, source, fake, config, api: { source: new ApiJiraSource(deps), updater: new ApiJiraUpdater(deps), commenter: new ApiJiraCommenter(deps) } };
}

const requests = (home: string) =>
  existsSync(join(home, "fake-jira-api", "requests.jsonl"))
    ? readFileSync(join(home, "fake-jira-api", "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { method: string; path: string; body?: unknown })
    : [];

test("fake JIRA API: discovery and a ticket read go through the real REST code and give the fake tickets", async () => {
  const s = setup();
  const found = await s.api.source.discover();
  assert.equal(found.complete, true);
  assert.deepEqual(found.tickets.map((t) => [t.key, t.status]), [["FAKE-1", "Ready for Dev"], ["FAKE-2", "Ready for Dev"], ["FAKE-3", "In Progress"]]);
  assert.equal(found.tickets[0]!.url, `${FAKE_BASE_URL}/browse/FAKE-1`);
  const t = await s.api.source.fetchTicket("FAKE-1");
  assert.equal(t.title, "Export orders as CSV");
  assert.equal(t.status, "Ready for Dev");
  assert.equal(t.description, "Add an export button to the orders page.\n\nIt downloads a CSV file.");
  assert.deepEqual(t.comments.map((c) => [c.jiraCommentId, c.author, c.body]), [["10001", "ann", "Include a VAT column."], ["10002", "bob", "Dates must be ISO-8601."]]);
  assert.deepEqual(t.attachments.map((a) => [a.filename, a.mime, a.base64]), [["spec.pdf", "application/pdf", null]]);
  // the request log names method and path (and a write's body), never the token or the Basic header
  const log = readFileSync(join(s.home, "fake-jira-api", "requests.jsonl"), "utf8");
  assert.ok(requests(s.home).some((q) => q.method === "POST" && q.path === "/rest/api/3/search/jql"));
  assert.equal(log.includes(TOKEN), false);
  assert.equal(log.includes(Buffer.from(`you@example.com:${TOKEN}`).toString("base64")), false);
  assert.equal(log.includes("Basic"), false);
});

test("fake JIRA API: a status change is one transition POST and the read-back shows it; a comment is added once", async () => {
  const s = setup();
  const r = JiraUpdateResult.parse(await s.api.updater.setStatus("FAKE-1", "In Progress"));
  assert.equal(r.outcome, "changed");
  assert.equal(r.observedStatus, "In Progress");
  assert.equal((await s.api.source.fetchTicket("FAKE-1")).status, "In Progress");
  assert.equal((await s.api.updater.setStatus("FAKE-1", "In Progress")).outcome, "already_in_status");
  assert.equal((await s.api.updater.setStatus("FAKE-1", "No Such Status")).outcome, "transition_unavailable");
  const writes = requests(s.home).filter((q) => q.method === "POST" && q.path.endsWith("/transitions"));
  assert.deepEqual(writes.map((w) => w.path), ["/rest/api/3/issue/FAKE-1/transitions"]);

  assert.equal((await s.api.commenter.postComment("FAKE-1", "Line one\nLine two")).outcome, "posted");
  const after = await s.api.source.fetchTicket("FAKE-1");
  assert.equal(after.comments.length, 3);
  assert.equal(after.comments.at(-1)!.body, "Line one\nLine two");
  assert.equal(requests(s.home).filter((q) => q.method === "POST" && q.path.endsWith("/comment")).length, 1);
});

test("fake JIRA API: no Authorization → 401 (the token rejected); a URL off the fake base is refused, never fetched", async () => {
  const s = setup();
  const res = await s.fake.fetch(`${FAKE_BASE_URL}/rest/api/3/issue/FAKE-1`, { method: "GET" });
  assert.equal(res.status, 401);
  await assert.rejects(s.fake.fetch("https://your-company.atlassian.net/rest/api/3/issue/FAKE-1", { method: "GET", headers: { authorization: "Basic eA==" } }), /fake JIRA API/);
  await assert.rejects(setup({ creds: false }).api.source.discover(), /Set your JIRA email and API token/);
  // the real REST client maps the 401 to the API wording
  const noAuth = new ApiJiraSource({ fetch: (async (u: string, init?: RequestInit) => s.fake.fetch(u, { ...init, headers: {} })) as typeof fetch, config: () => s.config.jira, credentials: () => ({ email: "you@example.com", apiToken: TOKEN, updatedAt: "x" }) });
  await assert.rejects(noAuth.discover(), (e) => e instanceof JiraLoginRequiredError && /API token was rejected/.test(e.message));
});

test("fake mode: every fake agent run is recorded in agent_run with the configured executor kind (claude-api too)", async () => {
  const home = tmpDir("fake-run-recorded", "/private/var/tmp");
  const db = openDatabase(":memory:");
  const config = loadConfig(home);
  config.executor.kind = "claude-api";
  const run = fakeRunRecorded(db, () => config.executor.kind);
  const { Requirement } = await import("@slackoff/shared");
  await run({ role: "refine-ticket", prompt: "mode: refine", cwd: "/", allowedTools: [], chrome: false, schema: Requirement });
  config.executor.kind = "claude-code";
  await run({ role: "refine-ticket", prompt: "mode: refine", cwd: "/", allowedTools: [], chrome: false, schema: Requirement });
  const rows = db.prepare("SELECT role, executor, status FROM agent_run ORDER BY started_at, rowid").all() as Array<{ role: string; executor: string; status: string }>;
  assert.deepEqual(rows.map((r) => [r.role, r.executor, r.status]), [["refine-ticket", "claude-api", "ok"], ["refine-ticket", "claude-code", "ok"]]);
});

test("phase 4c task 6: fake runs record synthetic usage and cost; usageLimitOnce makes a ticket's first propose hit the usage limit (auto-pause)", async () => {
  const db = openDatabase(":memory:");
  db.exec("INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('FAKE-2', 'T', 'new', 'x', 'x')");
  const { ProposeResult, Requirement } = await import("@slackoff/shared");
  const { UsageLimitError } = await import("../src/executor/types.ts");
  const { currentPause } = await import("../src/cost/budget-gate.ts");
  const run = fakeRunRecorded(db, () => "claude-code", { usageLimitOnce: new Set(["FAKE-2"]) });
  await run({ role: "refine-ticket", ticketKey: "FAKE-2", prompt: "mode: refine", cwd: "/", allowedTools: [], chrome: false, schema: Requirement });
  const propose = () => run({ role: "propose-solutions", ticketKey: "FAKE-2", prompt: "propose", cwd: "/", allowedTools: [], chrome: false, schema: ProposeResult });
  await assert.rejects(propose(), (e) => e instanceof UsageLimitError && /^Claude usage limit reached/.test(e.detail));
  const pause = currentPause(db);
  assert.equal(pause?.reason, "limit_reached");
  assert.equal(pause?.pausedBy, "system");
  // only the first one
  await propose();
  const rows = db.prepare("SELECT role, status, usage_json, cost_usd FROM agent_run ORDER BY started_at, rowid").all() as Array<{ role: string; status: string; usage_json: string | null; cost_usd: number | null }>;
  assert.deepEqual(rows.map((r) => [r.role, r.status]), [["refine-ticket", "ok"], ["propose-solutions", "error"], ["propose-solutions", "ok"]]);
  for (const r of rows.filter((x) => x.status === "ok")) {
    const u = JSON.parse(r.usage_json!) as Record<string, number>;
    assert.ok(u.input_tokens! > 0 && u.output_tokens! > 0, r.usage_json!);
    assert.ok(r.cost_usd! > 0);
  }
  // no switch: never a usage error
  const plainDb = openDatabase(":memory:");
  plainDb.exec("INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('FAKE-2', 'T', 'new', 'x', 'x')");
  const plain = fakeRunRecorded(plainDb, () => "claude-code");
  await plain({ role: "propose-solutions", ticketKey: "FAKE-2", prompt: "propose", cwd: "/", allowedTools: [], chrome: false, schema: ProposeResult });
});
