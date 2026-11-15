import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchedTicket, Requirement } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { gitRepo } from "./fixtures/git-repos.ts";
import { loadConfig } from "../src/config.ts";
import { EventBus } from "../src/http/events.ts";
import { createApp, type AppDeps } from "../src/http/app.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { addRequirement } from "../src/requirements/requirement-repo.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { loadSkill } from "../src/skills/skill-loader.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const req = (ac: Requirement["acceptanceCriteria"]): Requirement => ({
  background: "bg", functional: [], acceptanceCriteria: ac, discussionOutcomes: [], openQuestions: [], draftComment: null,
});
const sourced = { id: "AC-1", text: "t", verifiable: true, source: { type: "description" as const, ref: "description#p1", quote: "q" } };

class CountingBus extends EventBus {
  subs = 0;
  override subscribe(fn: Parameters<EventBus["subscribe"]>[0]) {
    this.subs++;
    const off = super.subscribe(fn);
    return () => {
      this.subs--;
      off();
    };
  }
}

function setup() {
  const home = tmpDir("http");
  const db = openDatabase(join(home, "slackoff.db"));
  const config = loadConfig(home);
  const bus = new CountingBus();
  const run = async () => { throw new Error("agent must not run in http tests"); };
  const workflow = createWorkflow({ updater: noUpdater, db, home, queue: new JobQueue(1, { onError: () => {} }), source: new FakeTicketSource(), run: run as never, config, bus });
  const app = createApp({ db, home, repoRoot, workflow, bus, config });
  // every request comes from a loopback socket (remote sessions are covered in remote.test.ts)
  const request = (path: string, init?: RequestInit) => app.request(path, init, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const json = (method: string, path: string, body?: unknown) =>
    request(path, { method, headers: { host: "127.0.0.1:4317", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { home, db, config, bus, app, request, json };
}

const fetched: FetchedTicket = {
  loginRequired: false, key: "P-1", title: "T", description: "d", jiraUpdatedAt: null, status: null,
  comments: [], attachments: [{ kind: "attachment", filename: "a.png", mime: "image/png", url: "https://j/a.png", base64: Buffer.from("PNG").toString("base64") },
    { kind: "attachment", filename: "b.pdf", mime: "application/pdf", url: "https://j/b.pdf", base64: null }],
};

function ticketIn(s: ReturnType<typeof setup>, state: "awaiting_ac_review" | "discovered") {
  upsertDiscovered(s.db, { key: "P-1", title: "T", url: "https://j/P-1", status: "Ready for Dev" }, false);
  if (state === "discovered") return;
  const { snapshotId } = saveSnapshot(s.db, s.home, "P-1", fetched);
  addRequirement(s.db, "P-1", snapshotId, req([sourced]), "agent");
  for (const to of ["refining", "refined", "awaiting_ac_review"] as const) transition(s.db, "P-1", to, "system");
}

test("GET /api/tickets is empty on a fresh db", async () => {
  const s = setup();
  const res = await s.json("GET", "/api/tickets");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test("GET /api/tickets rows carry prevState (the state before blocked, else null)", async () => {
  const s = setup();
  ticketIn(s, "awaiting_ac_review");
  type Row = { key: string; prevState: string | null };
  const before = (await (await s.json("GET", "/api/tickets")).json()) as Row[];
  assert.equal(before[0]!.prevState, null);
  transition(s.db, "P-1", "blocked", "system");
  const after = (await (await s.json("GET", "/api/tickets")).json()) as Row[];
  assert.equal(after[0]!.prevState, "awaiting_ac_review");
});

test("developer-added AC without reason -> 400", async () => {
  const s = setup();
  ticketIn(s, "awaiting_ac_review");
  const bad = req([sourced, { id: "AC-2", text: "x", verifiable: true, source: { type: "developer" } as never }]);
  const res = await s.json("PUT", "/api/tickets/P-1/requirement", bad);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; issues?: unknown[] };
  assert.ok(body.error);
  assert.ok(Array.isArray(body.issues));
});

test("H4: blank or whitespace-only source ref, quote or developer reason -> 400; values are stored trimmed", async () => {
  const s = setup();
  ticketIn(s, "awaiting_ac_review");
  const withSource = (source: unknown) => req([sourced, { id: "AC-2", text: "x", verifiable: true, source: source as never }]);
  for (const source of [
    { type: "developer", reason: "   " },
    { type: "description", ref: " ", quote: "q" },
    { type: "comment", ref: "100", quote: "\t\n" },
  ]) {
    const res = await s.json("PUT", "/api/tickets/P-1/requirement", withSource(source));
    assert.equal(res.status, 400, JSON.stringify(source));
  }
  const ok = await s.json("PUT", "/api/tickets/P-1/requirement", withSource({ type: "developer", reason: "  agreed with PO  " }));
  assert.equal(ok.status, 200);
  const latest = s.db.prepare("SELECT content_json FROM requirement WHERE ticket_key = 'P-1' ORDER BY version DESC LIMIT 1").get() as { content_json: string };
  assert.deepEqual(JSON.parse(latest.content_json).acceptanceCriteria[1].source, { type: "developer", reason: "agreed with PO" });
});

test("choose while discovered -> 409; unknown ticket -> 404", async () => {
  const s = setup();
  ticketIn(s, "discovered");
  assert.equal((await s.json("POST", "/api/tickets/P-1/choose", { solutionId: 1, note: "" })).status, 409);
  assert.equal((await s.json("GET", "/api/tickets/NOPE-1")).status, 404);
  assert.equal((await s.json("POST", "/api/tickets/NOPE-1/abandon")).status, 404);
});

test("drift ack with empty note -> 400", async () => {
  const s = setup();
  ticketIn(s, "discovered");
  assert.equal((await s.json("POST", "/api/tickets/P-1/drift/ack", { note: "  " })).status, 400);
  assert.equal((await s.json("POST", "/api/tickets/P-1/drift/ack", {})).status, 400);
});

test("prompts: PUT then GET shows version 1; versions and reset", async () => {
  const s = setup();
  assert.equal((await s.json("PUT", "/api/prompts/refine-ticket", { text: "be terse" })).status, 200);
  const got = (await (await s.json("GET", "/api/prompts/refine-ticket")).json()) as { role: string; skill: { name: string; version: string }; current: { version: number; text: string } };
  assert.equal(got.current.version, 1);
  assert.equal(got.current.text, "be terse");
  assert.equal(got.skill.name, "refine-ticket");
  assert.equal((await s.json("POST", "/api/prompts/refine-ticket/reset")).status, 200);
  const versions = (await (await s.json("GET", "/api/prompts/refine-ticket/versions")).json()) as Array<{ version: number }>;
  assert.deepEqual(versions.map((v) => v.version), [2, 1]);
  assert.equal((await s.json("GET", "/api/prompts/not-a-role")).status, 400);
});

test("audit returns events and a valid chain", async () => {
  const s = setup();
  ticketIn(s, "discovered");
  const body = (await (await s.json("GET", "/api/audit?ticketKey=P-1")).json()) as { events: unknown[]; chain: { ok: boolean } };
  assert.equal(body.chain.ok, true);
  assert.ok(body.events.length >= 1);
});

test("ticket detail, list, patch, snapshots and attachments", async () => {
  const s = setup();
  ticketIn(s, "awaiting_ac_review");
  const list = (await (await s.json("GET", "/api/tickets")).json()) as Array<{ key: string; state: string; driftNeedsAction: boolean; reviewAc: boolean }>;
  assert.equal(list[0]!.state, "awaiting_ac_review");
  assert.equal(list[0]!.driftNeedsAction, false);
  const detail = (await (await s.json("GET", "/api/tickets/P-1")).json()) as { ticket: { key: string }; requirement: { version: number }; solutions: unknown[]; choice: unknown; drift: unknown };
  assert.equal(detail.requirement.version, 1);
  assert.deepEqual(detail.solutions, []);
  const patched = await s.json("PATCH", "/api/tickets/P-1", { reviewAc: true });
  assert.equal(patched.status, 200);
  assert.equal(((await (await s.json("GET", "/api/tickets/P-1")).json()) as { ticket: { reviewAc: boolean } }).ticket.reviewAc, true);
  assert.equal((await s.json("PATCH", "/api/tickets/P-1", { reviewAc: "yes" })).status, 400);

  const snaps = (await (await s.json("GET", "/api/tickets/P-1/snapshots")).json()) as Array<{ id: number }>;
  const snap = (await (await s.json("GET", `/api/tickets/P-1/snapshots/${snaps[0]!.id}`)).json()) as { attachments: Array<{ id: number; localPath: string | null }> };
  const [withFile, metaOnly] = [snap.attachments.find((a) => a.localPath)!, snap.attachments.find((a) => !a.localPath)!];
  const file = await s.json("GET", `/api/tickets/P-1/snapshots/${snaps[0]!.id}/attachments/${withFile.id}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.equal(await file.text(), "PNG");
  const meta = await s.json("GET", `/api/tickets/P-1/snapshots/${snaps[0]!.id}/attachments/${metaOnly.id}`);
  assert.equal(meta.status, 404);
  assert.deepEqual(await meta.json(), { error: "metadata only", url: "https://j/b.pdf" });
  assert.equal((await s.json("GET", "/api/tickets/P-1/snapshots/999")).status, 404);
  const reqs = (await (await s.json("GET", "/api/tickets/P-1/requirements")).json()) as unknown[];
  assert.equal(reqs.length, 1);
  assert.deepEqual(await (await s.json("GET", "/api/tickets/P-1/drift")).json(), []);
});

const auditRows = (s: ReturnType<typeof setup>, type: string) =>
  (s.db.prepare("SELECT actor, ticket_key, payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ actor: string; ticket_key: string | null; payload_json: string }>)
    .map((r) => ({ actor: r.actor, ticketKey: r.ticket_key, payload: JSON.parse(r.payload_json) as unknown }));

test("H6: PATCH reviewAc is audited when it changes, not when it stays the same", async () => {
  const s = setup();
  ticketIn(s, "discovered");
  assert.equal((await s.json("PATCH", "/api/tickets/P-1", { reviewAc: true })).status, 200);
  assert.equal((await s.json("PATCH", "/api/tickets/P-1", { reviewAc: true })).status, 200);
  assert.equal((await s.json("PATCH", "/api/tickets/P-1", { reviewAc: false })).status, 200);
  assert.deepEqual(auditRows(s, "review_ac_changed"), [
    { actor: "developer", ticketKey: "P-1", payload: { from: false, to: true, decidedBy: "local" } },
    { actor: "developer", ticketKey: "P-1", payload: { from: true, to: false, decidedBy: "local" } },
  ]);
});

test("H6: PUT /api/config audits the changed field paths only, never their values", async () => {
  const s = setup();
  const cfg = (await (await s.json("GET", "/api/config")).json()) as Record<string, unknown>;
  assert.equal((await s.json("PUT", "/api/config", cfg)).status, 200);
  assert.deepEqual(auditRows(s, "config_changed"), [], "no change, no audit");
  const next = {
    ...cfg,
    concurrency: 2,
    jira: { baseUrl: "https://jira.example.com", readyForDevStatus: "Ready for Dev", source: "browser" },
    projects: { ABC: { repoPath: "/secret/repo/path", baseBranch: "main" } },
  };
  assert.equal((await s.json("PUT", "/api/config", next)).status, 200);
  const rows = auditRows(s, "config_changed");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor, "developer");
  assert.equal(rows[0]!.ticketKey, null);
  assert.deepEqual(rows[0]!.payload, { changed: ["concurrency", "jira.baseUrl", "projects.ABC"] });
  const raw = JSON.stringify(rows[0]!.payload);
  assert.ok(!raw.includes("/secret/repo/path") && !raw.includes("jira.example.com"), "no values in the audit");
  assert.equal((await s.json("PUT", "/api/config", { ...next, concurrency: 0 })).status, 400);
  assert.equal(auditRows(s, "config_changed").length, 1, "a rejected change is not audited");
});

test("status and config round trip", async () => {
  const s = setup();
  const st = (await (await s.json("GET", "/api/status")).json()) as { executor: { kind: string; label: string; available: boolean }; jira: { configured: boolean; source: string }; concurrency: number; needsYou: number };
  assert.equal(st.executor.label, "Claude Code (subscription)");
  assert.equal(st.jira.configured, false);
  assert.equal(st.needsYou, 0);
  const cfg = (await (await s.json("GET", "/api/config")).json()) as Record<string, unknown>;
  assert.equal((await s.json("PUT", "/api/config", { ...cfg, concurrency: 0 })).status, 400);
  const ok = await s.json("PUT", "/api/config", { ...cfg, jira: { baseUrl: "https://jira.example.com/", readyForDevStatus: "Ready for Dev", source: "browser" } });
  assert.equal(ok.status, 200);
  assert.equal(s.config.jira.baseUrl, "https://jira.example.com");
  const st2 = (await (await s.json("GET", "/api/status")).json()) as { jira: { configured: boolean; baseUrl: string } };
  assert.equal(st2.jira.configured, true);
  assert.equal(st2.jira.baseUrl, "https://jira.example.com");
});

test("4B-11 (4): /api/status reports the API executor unavailable while no Anthropic key is set (or the file cannot be read), available once it is", async () => {
  const s = setup();
  s.config.executor.claudeBin = process.execPath;
  s.config.executor.kind = "claude-api";
  s.config.jira.source = "api";
  type St = { executor: { kind: string; available: boolean; reason?: string } };
  const status = async () => ((await (await s.json("GET", "/api/status")).json()) as St).executor;
  assert.deepEqual(await status(), { kind: "claude-api", label: "Claude Code (API key)", available: false, reason: "Set your Anthropic API key in Settings → Executor" });
  writeCredentials(s.home, { jira: null, anthropic: { apiKey: "test-anthropic-key-0000", updatedAt: "2026-11-09T10:00:00.000Z" }, otlpHeaders: null });
  assert.deepEqual(await status(), { kind: "claude-api", label: "Claude Code (API key)", available: true });
  chmodSync(join(s.home, "credentials.json"), 0o644);
  const bad = await status();
  assert.equal(bad.available, false);
  assert.match(bad.reason!, /^The Anthropic API key cannot be read: credentials\.json must be a regular file/);
  // the subscription executor does not need the key
  s.config.executor.kind = "claude-code";
  assert.equal((await status()).available, true);
});

test("discover and refine return 202; invalid JSON -> 400", async () => {
  const s = setup();
  s.config.jira.baseUrl = "https://jira.example.com";
  ticketIn(s, "discovered");
  assert.equal((await s.json("POST", "/api/discover")).status, 202);
  assert.equal((await s.json("POST", "/api/tickets/P-1/refine")).status, 202);
  const bad = await s.request("/api/tickets/P-1/drift/ack", { method: "POST", body: "{nope", headers: { host: "127.0.0.1:4317", "content-type": "application/json" } });
  assert.equal(bad.status, 400);
});

test("SSE streams bus events and unsubscribes on abort", async () => {
  const s = setup();
  const res = await s.json("GET", "/api/events");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (re: RegExp) => {
    while (!re.test(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
  };
  await until(/connected/);
  s.bus.emit({ type: "state_changed", ticketKey: "P-1", from: "a", to: "b" });
  await until(/state_changed/);
  assert.match(buf, /event: state_changed\ndata: {.*"ticketKey":"P-1"/);
  assert.equal(s.bus.subs, 1);
  await reader.cancel();
  for (let i = 0; i < 50 && s.bus.subs > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.bus.subs, 0);
});

test("discover without a JIRA URL -> 409; refine unknown ticket -> 404", async () => {
  const s = setup();
  const res = await s.json("POST", "/api/discover");
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /JIRA URL/);
  assert.equal((await s.json("POST", "/api/tickets/NOPE-1/refine")).status, 404);
});

test("invalid config -> 400 via typed error", async () => {
  const s = setup();
  const res = await s.json("PUT", "/api/config", { jira: { baseUrl: "http://insecure" } });
  assert.equal(res.status, 400);
});

test("restartRequired when concurrency differs from the running queue", async () => {
  const s = setup();
  const cfg = (await (await s.json("GET", "/api/config")).json()) as Record<string, unknown>;
  const put = (await (await s.json("PUT", "/api/config", { ...cfg, concurrency: 3 })).json()) as { restartRequired: boolean; config: { concurrency: number } };
  assert.equal(put.restartRequired, true);
  assert.equal(put.config.concurrency, 3);
  const st = (await (await s.json("GET", "/api/status")).json()) as { concurrency: number; restartRequired: boolean };
  assert.equal(st.concurrency, 1);
  assert.equal(st.restartRequired, true);
});

test("attachment responses are hardened", async () => {
  const s = setup();
  ticketIn(s, "awaiting_ac_review");
  const snaps = (await (await s.json("GET", "/api/tickets/P-1/snapshots")).json()) as Array<{ id: number }>;
  const snap = (await (await s.json("GET", `/api/tickets/P-1/snapshots/${snaps[0]!.id}`)).json()) as { attachments: Array<{ id: number; localPath: string | null }> };
  const a = snap.attachments.find((x) => x.localPath)!;
  const res = await s.json("GET", `/api/tickets/P-1/snapshots/${snaps[0]!.id}/attachments/${a.id}`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "sandbox");
  assert.match(res.headers.get("content-disposition") ?? "", /^inline/);
  await res.text();
});

test("guard: foreign Host -> 403", async () => {
  const s = setup();
  const res = await s.request("/api/tickets", { headers: { host: "evil.example.com:4317" } });
  assert.equal(res.status, 403);
  assert.equal((await s.request("/api/tickets")).status, 403);
  assert.equal((await s.request("/api/tickets", { headers: { host: "localhost:5173" } })).status, 200);
});

test("guard: foreign Origin on POST -> 403, allowed Origin works", async () => {
  const s = setup();
  const h = { host: "127.0.0.1:4317", "content-type": "application/json" };
  const bad = await s.request("/api/tickets/P-1/abandon", { method: "POST", headers: { ...h, origin: "https://evil.example.com" } });
  assert.equal(bad.status, 403);
  const ok = await s.request("/api/tickets/NOPE-1/abandon", { method: "POST", headers: { ...h, origin: "http://localhost:5173" } });
  assert.equal(ok.status, 404);
});

test("guard: non-JSON body -> 415", async () => {
  const s = setup();
  const res = await s.request("/api/tickets/P-1/drift/ack", {
    method: "POST", headers: { host: "127.0.0.1:4317", "content-type": "text/plain" }, body: '{"note":"x"}',
  });
  assert.equal(res.status, 415);
  const noType = await s.request("/api/tickets/P-1/drift/ack", {
    method: "POST", headers: { host: "127.0.0.1:4317", "content-length": "12" }, body: '{"note":"x"}',
  });
  assert.equal(noType.status, 415);
});

// ---- author decision 2026-11-06: every open ticket assigned to me ----

import { markJiraOpen, recordDiscoveryRun } from "../src/tickets/ticket-repo.ts";

test("GET /api/tickets reports jiraOpen; GET /api/discovery returns the last discovery run (null before any)", async () => {
  const s = setup();
  ticketIn(s, "discovered");
  upsertDiscovered(s.db, { key: "P-2", title: "T2", url: "https://j/P-2", status: "In Progress" }, false);
  assert.deepEqual(await (await s.json("GET", "/api/discovery")).json(), { lastRun: null });
  markJiraOpen(s.db, new Set(["P-2"]));
  recordDiscoveryRun(s.db, { returned: 1, total: 7, complete: false });
  const rows = (await (await s.json("GET", "/api/tickets")).json()) as Array<{ key: string; jiraOpen: boolean; jiraStatus: string }>;
  assert.deepEqual(rows.map((r) => [r.key, r.jiraOpen, r.jiraStatus]), [["P-1", false, "Ready for Dev"], ["P-2", true, "In Progress"]]);
  const d = (await (await s.json("GET", "/api/discovery")).json()) as { lastRun: { returned: number; total: number; complete: boolean; finishedAt: string } };
  assert.deepEqual({ ...d.lastRun, finishedAt: "x" }, { returned: 1, total: 7, complete: false, finishedAt: "x" });
});

// ---------------------------------------------------------------- phase 2 (Task 13): design debate, multi-repo
// development, JIRA write decisions, browser detection. Phone = a paired device over Tailscale (R16/R21/R22).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { repoStatus, type StepRepoResult, type TestRun } from "@slackoff/shared";
import { createFakeRepos } from "../src/dev/fake-repo.ts";
import { listSolutions, recordChoice, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { addDesignDoc, addRound } from "../src/design/design-repo.ts";
import { saveDrift } from "../src/drift/drift-repo.ts";
import { addStep, startIteration } from "../src/development/dev-repo.ts";
import { recordInstall, setChoiceBranch, setRepoWorkspace } from "../src/tickets/ticket-repo.ts";
import { requestJiraWrite } from "../src/jira/jira-write-repo.ts";
import { ensureWorktree, worktreePath } from "../src/git/worktree.ts";
import { currentChoice } from "../src/requirements/requirement-repo.ts";
import type { SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { applyFakeOverlay, type FakeOverlay } from "../src/dev/fake-overlay.ts";
import { DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR, type RepoRef } from "../src/config.ts";
import { basename } from "node:path";
import { readFileSync as readText } from "node:fs";
import { tmpDir } from "./helpers/tmp.ts";

const TS2 = { ip: "100.101.102.103", dnsName: null };
const PHONE_ENV = { incoming: { socket: { remoteAddress: "100.88.1.2" } } };
const LOOP_ENV = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

async function setup2(o: { browsers?: () => Promise<Array<{ deviceId: string; name: string }>>; sandbox?: Partial<Pick<AppDeps, "sandboxBackend" | "sandboxCheck" | "now">>; fakeOverlay?: (home: string, repos: RepoRef[]) => FakeOverlay; trial?: AppDeps["trial"]; repoRoot?: string } = {}) {
  const home = tmpDir("http2");
  const db = openDatabase(join(home, "slackoff.db"));
  const config = loadConfig(home);
  const [api, web] = await createFakeRepos(home);
  // mapping order web, api: responses follow the mapping, not the choice
  config.projects = { K: { repos: [web!, api!] } };
  const fakeOverlay = o.fakeOverlay?.(home, [api!, web!]);
  if (fakeOverlay) applyFakeOverlay(config, fakeOverlay);
  const bus = new CountingBus();
  const run = async () => { throw new Error("agent must not run in http tests"); };
  const queue = new JobQueue(1, { onError: () => {} });
  const workflow = createWorkflow({
    updater: noUpdater, db, home, queue, source: new FakeTicketSource(), run: run as never, config, bus,
    hooks: { afterDesignFinal: () => {}, enqueueDevelop: () => {}, enqueueReview: () => {}, onDevelopmentStarted: () => {} },
  });
  const app = createApp({ db, home, repoRoot: o.repoRoot ?? repoRoot, workflow, bus, config, remote: TS2, ...(o.browsers ? { listBrowsers: o.browsers } : {}), ...(o.sandbox ?? {}), ...(fakeOverlay ? { fakeOverlay } : {}), ...(o.trial ? { trial: o.trial } : {}) });
  const call = (env: typeof LOOP_ENV, host: string, method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(
      path,
      {
        method,
        headers: { host, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  const local = (method: string, path: string, body?: unknown) => call(LOOP_ENV, "127.0.0.1:4317", method, path, body);
  let phoneCookie: string | undefined;
  let phoneId = 0;
  const phoneRaw = (method: string, path: string, body?: unknown, cookie?: string) => call(PHONE_ENV, `${TS2.ip}:4317`, method, path, body, cookie);
  const pairPhone = async () => {
    const { code } = (await (await local("POST", "/api/pair/start")).json()) as { code: string };
    const res = await phoneRaw("POST", "/api/pair/redeem", { code, deviceName: "Pixel" });
    assert.equal(res.status, 200);
    phoneCookie = `slackoff_session=${/slackoff_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!}`;
    phoneId = ((await res.json()) as { device: { id: number } }).device.id;
  };
  await pairPhone();
  const phone = (method: string, path: string, body?: unknown) => phoneRaw(method, path, body, phoneCookie);
  return { home, db, config, bus, app, queue, workflow, local, phone, phoneRaw, phoneId: () => phoneId, repos: { api: api!, web: web! } };
}
type S2 = Awaited<ReturnType<typeof setup2>>;

const solution = {
  title: "Both", approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "M" as const,
  affectedRepos: ["api", "web"], repoChanges: [{ repo: "api", summary: "x" }, { repo: "web", summary: "y" }],
};
const designDoc = (md: string) => ({
  contentMd: md, repos: [{ repo: "api", contentMd: "api part" }, { repo: "web", contentMd: "web part" }],
  checklist: [{ item: "security", status: "considered" as const, conclusion: "fine" }], responses: [],
});
const critique = {
  comments: [
    { id: "C-1", checklistItem: "security", repo: "api", blocking: true, text: "no auth check", suggestion: "add one" },
    { id: "C-2", checklistItem: "security", repo: null, blocking: true, text: "no rate limit", suggestion: null },
    { id: "C-3", checklistItem: "security", repo: null, blocking: false, text: "nit", suggestion: null },
  ],
  coverage: [],
};

type Phase2State = "awaiting_choice" | "designing" | "awaiting_debate_ruling" | "checking_snapshot" | "awaiting_snapshot_ack" | "developing" | "dev_done" | "blocked_dev";

/** K-<n> walked through valid transitions to `state`, with a requirement, one solution, a choice of api+web and data. */
function seed(s: S2, key: string, state: Phase2State) {
  upsertDiscovered(s.db, { key, title: "Export orders", url: `https://j/${key}`, status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(s.db, s.home, key, { ...fetched, key });
  addRequirement(s.db, key, snapshotId, req([sourced]), "agent");
  for (const to of ["refining", "refined", "proposing"] as const) transition(s.db, key, to, "system");
  const reqId = (s.db.prepare("SELECT id FROM requirement WHERE ticket_key = ?").get(key) as { id: number }).id;
  saveSolutions(s.db, key, reqId, [solution]);
  transition(s.db, key, "awaiting_choice", "system");
  if (state === "awaiting_choice") return;
  recordChoice(s.db, key, listSolutions(s.db, key)[0]!.id, "", ["api", "web"], "local");
  transition(s.db, key, "designing", "system");
  const choiceId = currentChoice(s.db, key)!.id;
  const d1 = addDesignDoc(s.db, key, { requirementId: reqId, choiceId, doc: designDoc("v1") });
  if (state === "designing") return;
  addRound(s.db, key, { choiceId, designDocId: d1.id, round: 1, role: "critic", content: critique });
  if (state === "awaiting_debate_ruling") {
    transition(s.db, key, "awaiting_debate_ruling", "system");
    return;
  }
  const d2 = addDesignDoc(s.db, key, { requirementId: reqId, choiceId, doc: designDoc("v2") });
  addRound(s.db, key, { choiceId, designDocId: d2.id, round: 1, role: "designer", content: { responses: [] } });
  for (const to of ["design_final", "checking_snapshot"] as const) transition(s.db, key, to, "system");
  if (state === "checking_snapshot") return;
  if (state === "awaiting_snapshot_ack") {
    saveDrift(s.db, key, reqId, snapshotId, snapshotId, "snapshot_changed", { baseline: [{ id: "AC-1", status: "missing", coveredBy: [], note: "gone" }], current: [], contradictions: [] });
    transition(s.db, key, "awaiting_snapshot_ack", "system");
    return;
  }
  transition(s.db, key, "developing", "system");
  if (state === "blocked_dev") {
    transition(s.db, key, "blocked", "system", "development did not finish within 3 steps");
    return;
  }
  if (state === "dev_done") transition(s.db, key, "dev_done", "system");
}

const audit2 = (s: S2, type: string) =>
  (s.db.prepare("SELECT actor, payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ actor: string; payload_json: string }>)
    .map((r) => ({ actor: r.actor, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
const lastStateChange = (s: S2, key: string) =>
  JSON.parse((s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'state_changed' AND ticket_key = ? ORDER BY id DESC LIMIT 1").get(key) as { payload_json: string }).payload_json) as Record<string, unknown>;
const stateOf = (s: S2, key: string) => (s.db.prepare("SELECT state FROM ticket WHERE key = ?").get(key) as { state: string }).state;

// ---- design ----

test("GET /design: current choice's debate without doc bodies; unknown ticket 404; remote without a session 401", async () => {
  const s = await setup2();
  seed(s, "K-1", "awaiting_debate_ruling");
  const res = await s.local("GET", "/api/tickets/K-1/design");
  assert.equal(res.status, 200);
  const d = (await res.json()) as {
    choiceId: number; affectedRepos: string[]; checklist: Array<{ id: string }>; maxRounds: number;
    docs: Array<Record<string, unknown>>; rounds: unknown[]; rulings: unknown[]; disagreements: Array<{ commentId: string }>; step: { kind: string };
  };
  assert.equal(d.choiceId, currentChoice(s.db, "K-1")!.id);
  assert.deepEqual(d.affectedRepos, ["web", "api"], "mapping order");
  assert.ok(d.checklist.some((i) => i.id === "security"), "resolved checklist (default + cross-repo)");
  assert.equal(d.maxRounds, s.config.debate.maxRounds);
  assert.deepEqual(d.docs.map((x) => Object.keys(x).sort()), [["checklist", "createdAt", "isFinal", "version"]]);
  assert.equal(d.rounds.length, 1);
  assert.deepEqual(d.rulings, []);
  assert.deepEqual(d.disagreements.map((x) => x.commentId), ["C-1", "C-2"]);
  assert.equal(d.step.kind, "revise");
  assert.equal((await s.local("GET", "/api/tickets/NOPE-1/design")).status, 404);
  assert.equal((await s.phoneRaw("GET", "/api/tickets/K-1/design")).status, 401);
  assert.equal((await s.phone("GET", "/api/tickets/K-1/design")).status, 200);
});

test("GET /design/docs/:version: one version with its body; unknown version 404", async () => {
  const s = await setup2();
  seed(s, "K-1", "awaiting_debate_ruling");
  const res = await s.local("GET", "/api/tickets/K-1/design/docs/1");
  assert.equal(res.status, 200);
  const doc = (await res.json()) as { version: number; contentMd: string; repos: unknown[]; responses: unknown[]; checklist: unknown[]; isFinal: boolean };
  assert.equal(doc.version, 1);
  assert.equal(doc.contentMd, "v1");
  assert.equal(doc.repos.length, 2);
  assert.deepEqual(doc.responses, []);
  assert.equal((await s.local("GET", "/api/tickets/K-1/design/docs/9")).status, 404);
  assert.equal((await s.local("GET", "/api/tickets/K-1/design/docs/x")).status, 400);
});

test("debate rulings: one missing -> 400; outside awaiting_debate_ruling -> 409; a phone rules (device audited, body decidedBy ignored); second -> 409", async () => {
  const s = await setup2();
  seed(s, "K-1", "awaiting_debate_ruling");
  seed(s, "K-2", "designing");
  const one = [{ commentId: "C-1", decision: "designer", note: "" }];
  assert.equal((await s.local("POST", "/api/tickets/K-1/debate/rulings", { rulings: one })).status, 400);
  assert.equal((await s.local("POST", "/api/tickets/K-1/debate/rulings", { rulings: "nope" })).status, 400);
  const both = [...one, { commentId: "C-2", decision: "critic", note: "" }];
  assert.equal((await s.local("POST", "/api/tickets/K-2/debate/rulings", { rulings: both })).status, 409);
  const res = await s.phone("POST", "/api/tickets/K-1/debate/rulings", { rulings: both, decidedBy: "local" });
  assert.equal(res.status, 200);
  assert.equal(stateOf(s, "K-1"), "designing");
  const rulings = audit2(s, "debate_ruling");
  assert.deepEqual(rulings.map((r) => r.payload.decidedBy), [`device:${s.phoneId()}`, `device:${s.phoneId()}`]);
  assert.equal((await s.phone("POST", "/api/tickets/K-1/debate/rulings", { rulings: both })).status, 409);
});

test("rechoose: from awaiting_debate_ruling ok (phone, audited), developing -> 409", async () => {
  const s = await setup2();
  seed(s, "K-1", "awaiting_debate_ruling");
  seed(s, "K-2", "developing");
  assert.equal((await s.local("POST", "/api/tickets/K-2/rechoose")).status, 409);
  const res = await s.phone("POST", "/api/tickets/K-1/rechoose", { decidedBy: "local" });
  assert.equal(res.status, 200);
  assert.equal(stateOf(s, "K-1"), "awaiting_choice");
  assert.equal(lastStateChange(s, "K-1").decidedBy, `device:${s.phoneId()}`);
});

test("choose from a phone: the choice and its affected repos are audited with the device; ticket detail shows currentChoice", async () => {
  const s = await setup2();
  seed(s, "K-1", "awaiting_choice");
  const sol = listSolutions(s.db, "K-1")[0]!;
  const res = await s.phone("POST", "/api/tickets/K-1/choose", { solutionId: sol.id, note: "web only", affectedRepos: ["web"], decidedBy: "local" });
  assert.equal(res.status, 200);
  assert.equal(audit2(s, "choice_recorded").at(-1)!.payload.decidedBy, `device:${s.phoneId()}`);
  const detail = (await (await s.local("GET", "/api/tickets/K-1")).json()) as { choice: { id: number; solutionId: number; affectedRepos: string[]; note: string } };
  assert.equal(detail.choice.solutionId, sol.id);
  assert.deepEqual(detail.choice.affectedRepos, ["web"]);
  assert.equal(detail.choice.note, "web only");
});

// ---- snapshot ack / replan ----

test("snapshot-ack: empty note -> 400; phone acks (device audited); replan from a phone -> refining; wrong state -> 409", async () => {
  const s = await setup2();
  seed(s, "K-1", "awaiting_snapshot_ack");
  seed(s, "K-2", "awaiting_snapshot_ack");
  seed(s, "K-3", "checking_snapshot");
  assert.equal((await s.local("POST", "/api/tickets/K-1/snapshot-ack", { note: "  " })).status, 400);
  assert.equal((await s.local("POST", "/api/tickets/K-1/snapshot-ack", {})).status, 400);
  assert.equal((await s.local("POST", "/api/tickets/K-3/snapshot-ack", { note: "ok" })).status, 409);
  const res = await s.phone("POST", "/api/tickets/K-1/snapshot-ack", { note: "agreed with PO", decidedBy: "local" });
  assert.equal(res.status, 200);
  assert.equal(stateOf(s, "K-1"), "developing");
  assert.equal(lastStateChange(s, "K-1").decidedBy, `device:${s.phoneId()}`);
  assert.equal((await s.local("POST", "/api/tickets/K-3/replan")).status, 409);
  assert.equal((await s.phone("POST", "/api/tickets/K-2/replan")).status, 200);
  // the refine job then runs (and fails: no agent here); the move to refining names the device
  const toRefining = audit2(s, "state_changed").filter((r) => r.payload.to === "refining").at(-1)!;
  assert.equal(toRefining.payload.decidedBy, `device:${s.phoneId()}`);
});

// ---- development ----

const run0 = (command: string, exitCode: number): TestRun => ({ command, exitCode, timedOut: false, outputTail: exitCode === 0 ? "ok" : "boom" });
const repoResult = (repo: string, o: Partial<StepRepoResult> = {}): StepRepoResult => ({
  repo, violations: [], tests: [run0("node --test", 0)], commit: { kind: "committed", sha: "a".repeat(40) }, pendingChanges: false, ...o,
});

test("GET /development: repos in mapping order with server-computed status, install, baseBranchChanged and check outputs", async () => {
  const s = await setup2();
  seed(s, "K-1", "dev_done");
  const choiceId = currentChoice(s.db, "K-1")!.id;
  setChoiceBranch(s.db, "K-1", choiceId, "slackoff/K-1-export-orders");
  for (const r of [s.repos.api, s.repos.web]) {
    setRepoWorkspace(s.db, "K-1", {
      repo: r.name, repoPath: r.path, baseBranch: r.name === "api" ? "develop" : "main", branch: "slackoff/K-1-export-orders",
      worktreePath: worktreePath(s.home, "K-1", r.name), choiceId,
    });
  }
  recordInstall(s.db, "K-1", "web", { run: run0("pnpm install", 0), resetPaths: ["pnpm-lock.yaml"] });
  const it = startIteration(s.db, "K-1", "initial", null);
  const stepRepos = [
    repoResult("api", { tests: [run0("node --test", 1)], commit: { kind: "skipped_checks_failed" }, pendingChanges: true, checkOutputs: ["coverage/out.json"] }),
    repoResult("web"),
  ];
  addStep(s.db, it.id, { step: 1, summary: "step 1", repos: stepRepos });
  s.config.jira.syncStatus = true;
  requestJiraWrite(s.db, "K-1", "In Progress");

  const res = await s.phone("GET", "/api/tickets/K-1/development");
  assert.equal(res.status, 200);
  const d = (await res.json()) as {
    branch: string; ticketDir: string;
    repos: Array<{
      name: string; branch: string; baseBranch: string; baseBranchChanged: { stored: string; mapped: string } | null; rulesFound: boolean;
      commands: { test?: string }; forbiddenPaths: string[]; hooks: unknown; install: { resetPaths: string[] } | null; diffStat: unknown;
      commits: unknown[]; status: string; checkOutputs: string[];
    }>;
    iterations: Array<{ steps: Array<{ repos: StepRepoResult[] }> }>; jiraWrites: Array<{ state: string }>; jiraSync: { enabled: boolean; targetStatus: string; note: string | null };
  };
  assert.equal(d.branch, "slackoff/K-1-export-orders");
  assert.equal(d.ticketDir, join(s.home, "worktrees", "K-1"));
  assert.deepEqual(d.repos.map((r) => r.name), ["web", "api"]);
  const [web, api] = d.repos as [typeof d.repos[0], typeof d.repos[0]];
  assert.deepEqual(api.baseBranchChanged, { stored: "develop", mapped: "main" });
  assert.equal(web.baseBranchChanged, null);
  assert.deepEqual(web.install?.resetPaths, ["pnpm-lock.yaml"]);
  assert.equal(api.install, null);
  assert.equal(api.rulesFound, true);
  assert.equal(api.commands.test, "node --test");
  assert.ok(api.forbiddenPaths.includes("infra/**"));
  assert.deepEqual(api.checkOutputs, ["coverage/out.json"]);
  const expect = (r: StepRepoResult) => repoStatus({ running: false, pending: r.pendingChanges, hasTestCommand: true, lastTests: r.tests, lastCommit: r.commit });
  assert.equal(api.status, expect(stepRepos[0]!));
  assert.equal(api.status, "failing");
  assert.equal(web.status, expect(stepRepos[1]!));
  assert.equal(web.status, "green");
  assert.equal(api.hooks, null, "no worktree yet");
  assert.equal(api.diffStat, null);
  assert.deepEqual(api.commits, []);
  assert.equal(d.iterations[0]!.steps[0]!.repos.length, 2);
  assert.deepEqual(d.jiraWrites.map((w) => w.state), ["pending"]);
  assert.deepEqual(d.jiraSync, { enabled: true, targetStatus: s.config.jira.inProgressStatus, note: null });
  assert.equal((await s.local("GET", "/api/tickets/NOPE-1/development")).status, 404);
});

test("GET /diff: unknown repo 404, no worktree 409, traversal 404; a real worktree returns its diff as text/plain", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  const choiceId = currentChoice(s.db, "K-1")!.id;
  assert.equal((await s.local("GET", "/api/tickets/K-1/diff?repo=billing")).status, 404);
  assert.equal((await s.local("GET", "/api/tickets/K-1/diff?repo=..%2F..%2Fetc")).status, 404);
  assert.equal((await s.local("GET", "/api/tickets/K-1/diff")).status, 400);
  assert.equal((await s.local("GET", "/api/tickets/K-1/diff?repo=web")).status, 409);
  const { path } = await ensureWorktree({ home: s.home, key: "K-1", repo: s.repos.api, branch: "slackoff/K-1-x" });
  setRepoWorkspace(s.db, "K-1", { repo: "api", repoPath: s.repos.api.path, baseBranch: "main", branch: "slackoff/K-1-x", worktreePath: path, choiceId });
  writeFileSync(join(path, "new.txt"), "hello diff\n");
  execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "add", "-A"]);
  execFileSync("git", ["-C", path, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "add"]);
  const res = await s.phone("GET", "/api/tickets/K-1/diff?repo=api");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(res.headers.get("x-truncated"), null);
  assert.match(await res.text(), /\+hello diff/);
  const dev = (await (await s.local("GET", "/api/tickets/K-1/development")).json()) as { repos: Array<{ name: string; diffStat: { files: number } | null; commits: unknown[]; hooks: { configured: boolean } | null }> };
  const api = dev.repos.find((r) => r.name === "api")!;
  assert.equal(api.diffStat?.files, 1);
  assert.equal(api.commits.length, 1);
  assert.equal(api.hooks?.configured, false);
  assert.ok(existsSync(path));
});

test("request-changes: developing -> 409, empty note -> 400; phone from dev_done (device on the iteration and state change)", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  seed(s, "K-2", "dev_done");
  assert.equal((await s.local("POST", "/api/tickets/K-1/development/request-changes", { note: "more" })).status, 409);
  assert.equal((await s.local("POST", "/api/tickets/K-2/development/request-changes", { note: " " })).status, 400);
  const res = await s.phone("POST", "/api/tickets/K-2/development/request-changes", { note: "rename the button", decidedBy: "local" });
  assert.equal(res.status, 200);
  assert.equal(stateOf(s, "K-2"), "developing");
  assert.equal(audit2(s, "dev_iteration_started").at(-1)!.payload.decidedBy, `device:${s.phoneId()}`);
  assert.equal(lastStateChange(s, "K-2").decidedBy, `device:${s.phoneId()}`);
});

test("ticket retry from a phone: the state change names the device", async () => {
  const s = await setup2();
  seed(s, "K-1", "blocked_dev");
  const res = await s.phone("POST", "/api/tickets/K-1/retry", { decidedBy: "local" });
  assert.equal(res.status, 200);
  assert.equal(stateOf(s, "K-1"), "developing");
  assert.equal(lastStateChange(s, "K-1").decidedBy, `device:${s.phoneId()}`);
});

// ---- JIRA writes ----

test("JIRA writes: another ticket's id -> 404; phone confirms (device audited, body ignored); skip; retry of a failed write", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  seed(s, "K-2", "developing");
  s.config.jira.syncStatus = true;
  const other = requestJiraWrite(s.db, "K-2", "In Progress").id;
  const mine = requestJiraWrite(s.db, "K-1", "In Progress").id;
  assert.equal((await s.local("POST", `/api/tickets/K-1/jira-writes/${other}/confirm`)).status, 404);
  assert.equal((await s.local("POST", `/api/tickets/K-1/jira-writes/${other}/skip`)).status, 404);
  assert.equal((await s.local("POST", `/api/tickets/K-1/jira-writes/${other}/retry`)).status, 404);
  assert.equal((await s.local("POST", "/api/tickets/K-1/jira-writes/abc/confirm")).status, 400);
  const res = await s.phone("POST", `/api/tickets/K-1/jira-writes/${mine}/confirm`, { decidedBy: "local" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { jiraWrites: Array<{ id: number; state: string; decidedBy: string }> };
  assert.equal(body.jiraWrites.find((w) => w.id === mine)!.decidedBy, `device:${s.phoneId()}`);
  assert.deepEqual(audit2(s, "jira_write_decided").map((r) => r.payload.decidedBy), [`device:${s.phoneId()}`]);
  await s.queue.idle(); // noUpdater throws: the write fails, the ticket is untouched
  assert.equal(stateOf(s, "K-1"), "developing");
  assert.equal((await s.local("POST", `/api/tickets/K-1/jira-writes/${mine}/skip`)).status, 409);
  const retried = await s.phone("POST", `/api/tickets/K-1/jira-writes/${mine}/retry`);
  assert.equal(retried.status, 200);
  assert.equal(audit2(s, "jira_write_requested").at(-1)!.payload.decidedBy, `device:${s.phoneId()}`);
  const pending = ((await retried.json()) as { jiraWrites: Array<{ id: number; state: string }> }).jiraWrites.find((w) => w.state === "pending")!;
  assert.equal((await s.local("POST", `/api/tickets/K-1/jira-writes/${pending.id}/skip`)).status, 200);
  assert.equal(audit2(s, "jira_write_decided").at(-1)!.payload.decidedBy, "local");
});

// ---- browser detection (A-1, R21) ----

test("POST /api/jira/browsers/detect: phone -> 403; local -> 200 with the run's list; failure -> 502 with the reason", async () => {
  let fail = false;
  const s = await setup2({
    browsers: async () => {
      if (fail) throw new Error("Chrome extension not connected");
      return [{ deviceId: "dev-1", name: "Mac" }, { deviceId: "dev-2", name: "Work laptop" }];
    },
  });
  assert.equal((await s.phone("POST", "/api/jira/browsers/detect")).status, 403);
  const ok = await s.local("POST", "/api/jira/browsers/detect");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { browsers: [{ deviceId: "dev-1", name: "Mac" }, { deviceId: "dev-2", name: "Work laptop" }] });
  fail = true;
  const bad = await s.local("POST", "/api/jira/browsers/detect");
  assert.equal(bad.status, 502);
  assert.match(((await bad.json()) as { error: string }).error, /not connected/);
});

test("a phone may change debate/development limits but not JIRA sync, status or browser (R21, P-phone)", async () => {
  const s = await setup2();
  const cfg = (await (await s.local("GET", "/api/config")).json()) as { jira: Record<string, unknown>; debate: { maxRounds: number }; development: Record<string, number> };
  assert.equal((await s.phone("PUT", "/api/config", { ...cfg, debate: { maxRounds: 4 }, development: { ...cfg.development, maxSteps: 20 } })).status, 200);
  for (const jira of [{ syncStatus: true }, { inProgressStatus: "Doing" }, { browser: { deviceId: "dev-1", name: "Mac" } }]) {
    const res = await s.phone("PUT", "/api/config", { ...cfg, debate: { maxRounds: 4 }, development: { ...cfg.development, maxSteps: 20 }, jira: { ...cfg.jira, ...jira } });
    assert.equal(res.status, 403, JSON.stringify(jira));
  }
});

test("phase 3 (R21): a phone may change review.maxAttempts and acceptance timeouts but not the review status, gh, the acceptance config folder or the sandbox switch", async () => {
  const s = await setup2();
  type Cfg = Record<string, Record<string, unknown>>;
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Cfg;
  const ok = await s.phone("PUT", "/api/config", {
    ...cfg, review: { maxAttempts: 5 }, acceptance: { ...cfg.acceptance, startTimeoutMs: 30_000, runTimeoutMs: 600_000 },
  });
  assert.equal(ok.status, 200);
  const changed = (await ok.json()) as { config: Cfg };
  assert.equal(changed.config.review!.maxAttempts, 5);
  const now = changed.config;
  const outside = join(tmpdir(), "slackoff-accept-elsewhere");
  for (const patch of [
    { jira: { ...now.jira, reviewStatus: "Code Review" } },
    { delivery: { ghBin: "/opt/homebrew/bin/gh" } },
    // the Azure CLI that delivery runs for Azure DevOps repositories, like gh
    { delivery: { ...now.delivery, azBin: "/tmp/not-az" } },
    { acceptance: { ...now.acceptance, claudeConfigDir: outside } },
    { development: { ...now.development, allowUnsandboxedCommands: true } },
    { development: { ...now.development, deniedLocalPorts: [9999] } },
    // phase 4a (A-3): the git-hooks sandbox switch too
    { development: { ...now.development, allowUnsandboxedHooks: true } },
    // phase 4a Task 4: the local-network mode too
    { development: { ...now.development, localNetwork: "allowlist" } },
  ]) {
    const res = await s.phone("PUT", "/api/config", { ...now, ...patch });
    assert.equal(res.status, 403, JSON.stringify(patch));
    assert.match(((await res.json()) as { error: string }).error, /the sandbox switch/);
  }
  // from this computer they are allowed
  const local = await s.local("PUT", "/api/config", { ...now, development: { ...now.development, allowUnsandboxedCommands: true }, delivery: { ghBin: "gh2" } });
  assert.equal(local.status, 200);
  const saved = (await local.json()) as { config: Cfg };
  assert.equal(saved.config.development!.allowUnsandboxedCommands, true);
  assert.equal(saved.config.delivery!.ghBin, "gh2");
  const hooksOn = await s.local("PUT", "/api/config", { ...saved.config, development: { ...saved.config.development, allowUnsandboxedHooks: true } });
  assert.equal(hooksOn.status, 200);
  assert.equal(((await hooksOn.json()) as { config: Cfg }).config.development!.allowUnsandboxedHooks, true);
});

test("phase 3 (R3): PUT /api/config with a claudeConfigDir inside SLACKOFF_HOME -> 400, config.json unchanged", async () => {
  const s = await setup2();
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, Record<string, unknown>>;
  const file = join(s.home, "config.json");
  const before = readFileSync(file, "utf8");
  const res = await s.local("PUT", "/api/config", { ...cfg, acceptance: { ...cfg.acceptance, claudeConfigDir: join(s.home, "claude") } });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /acceptance\.claudeConfigDir/);
  assert.equal(readFileSync(file, "utf8"), before);
});

// ---- status & SSE ----

test("status counts phase-2 decisions and pending JIRA writes", async () => {
  const s = await setup2();
  seed(s, "K-1", "awaiting_debate_ruling");
  seed(s, "K-2", "awaiting_snapshot_ack");
  seed(s, "K-3", "dev_done");
  seed(s, "K-4", "developing");
  requestJiraWrite(s.db, "K-4", "In Progress");
  const st = (await (await s.local("GET", "/api/status")).json()) as { needsYou: number; pendingJiraWrites: number };
  assert.equal(st.needsYou, 3);
  assert.equal(st.pendingJiraWrites, 1);
});

test("F2-I2: the ticket list flags tickets with a pending JIRA write", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  seed(s, "K-2", "developing");
  requestJiraWrite(s.db, "K-1", "In Progress");
  const rows = (await (await s.local("GET", "/api/tickets")).json()) as Array<{ key: string; jiraWritePending: boolean }>;
  assert.equal(rows.find((r) => r.key === "K-1")?.jiraWritePending, true);
  assert.equal(rows.find((r) => r.key === "K-2")?.jiraWritePending, false);
});

test("F2-I3: confirming a JIRA write of an abandoned ticket -> 409", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  transition(s.db, "K-1", "abandoned", "developer");
  const { id } = requestJiraWrite(s.db, "K-1", "In Progress");
  const res = await s.local("POST", `/api/tickets/K-1/jira-writes/${id}/confirm`);
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /abandoned/);
  // a write that can no longer be sent is not counted as something to do
  const st = (await (await s.local("GET", "/api/status")).json()) as { pendingJiraWrites: number };
  assert.equal(st.pendingJiraWrites, 0);
  const rows = (await (await s.local("GET", "/api/tickets")).json()) as Array<{ key: string; jiraWritePending: boolean }>;
  assert.equal(rows.find((r) => r.key === "K-1")?.jiraWritePending, false);
});

test("F2-R1: accepting new git hooks is Mac-only: 403 from a paired phone; from this computer the workflow decides (409 when not blocked)", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  const phone = await s.phone("POST", "/api/tickets/K-1/development/accept-hooks", { repo: "api" });
  assert.equal(phone.status, 403);
  const local = await s.local("POST", "/api/tickets/K-1/development/accept-hooks", { repo: "api" });
  assert.equal(local.status, 409);
});

test("SSE delivers the phase-2 events to a paired phone", async () => {
  const s = await setup2();
  const res = await s.phone("GET", "/api/events");
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (re: RegExp) => {
    while (!re.test(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
  };
  await until(/connected/);
  s.bus.emit({ type: "debate_updated", ticketKey: "K-1" });
  s.bus.emit({ type: "dev_step", ticketKey: "K-1", iteration: 1, step: 2 });
  s.bus.emit({ type: "jira_write_updated", ticketKey: "K-1" });
  s.bus.emit({ type: "snapshot_changed", ticketKey: "K-1", needsAck: true });
  await until(/snapshot_changed/);
  for (const t of ["debate_updated", "dev_step", "jira_write_updated", "snapshot_changed"]) assert.match(buf, new RegExp(`event: ${t}\\ndata: `));
  assert.match(buf, /"step":2/);
  await reader.cancel();
});

// ---------------------------------------------------------------- Task 13 fix round 1

/** K-<n> in awaiting_ac_review (requirement refined from a snapshot), for the phase-1 human actions. */
function seedReview(s: S2, key: string) {
  upsertDiscovered(s.db, { key, title: "T", url: `https://j/${key}`, status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(s.db, s.home, key, { ...fetched, key });
  addRequirement(s.db, key, snapshotId, req([sourced]), "agent");
  for (const to of ["refining", "refined", "awaiting_ac_review"] as const) transition(s.db, key, to, "system");
}
const toState = (s: S2, key: string, to: string) =>
  (s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'state_changed' AND ticket_key = ? ORDER BY id").all(key) as Array<{ payload_json: string }>)
    .map((r) => JSON.parse(r.payload_json) as Record<string, unknown>)
    .filter((p) => p.to === to)
    .at(-1);

test("T13-1: phase-1 human actions from a phone name the device in the audit (forged body decidedBy ignored)", async () => {
  const s = await setup2();
  const dev = () => `device:${s.phoneId()}`;
  // refine (start)
  upsertDiscovered(s.db, { key: "K-1", title: "T", url: "https://j/K-1", status: "Ready for Dev" }, false);
  assert.equal((await s.phone("POST", "/api/tickets/K-1/refine", { decidedBy: "local" })).status, 202);
  assert.equal(toState(s, "K-1", "refining")?.decidedBy, dev());
  // abandon
  assert.equal((await s.phone("POST", "/api/tickets/K-1/abandon", { decidedBy: "local" })).status, 200);
  assert.equal(toState(s, "K-1", "abandoned")?.decidedBy, dev());
  // reviewAc toggle
  seedReview(s, "K-2");
  assert.equal((await s.phone("PATCH", "/api/tickets/K-2", { reviewAc: true, decidedBy: "local" })).status, 200);
  assert.deepEqual(audit2(s, "review_ac_changed").at(-1)!.payload, { from: false, to: true, decidedBy: dev() });
  // edit requirement → checking_drift
  const edited = req([sourced, { id: "AC-2", text: "x", verifiable: true, source: { type: "developer", reason: "agreed" } }]);
  assert.equal((await s.phone("PUT", "/api/tickets/K-2/requirement", { ...edited, decidedBy: "local" })).status, 200);
  assert.equal(toState(s, "K-2", "checking_drift")?.decidedBy, dev());
  // confirm requirement → proposing
  seedReview(s, "K-3");
  assert.equal((await s.phone("POST", "/api/tickets/K-3/confirm-requirement", { decidedBy: "local" })).status, 200);
  assert.equal(toState(s, "K-3", "proposing")?.decidedBy, dev());
  // back to editing → awaiting_ac_review
  seedReview(s, "K-4");
  const reqId = (s.db.prepare("SELECT id FROM requirement WHERE ticket_key = 'K-4'").get() as { id: number }).id;
  const snap = (s.db.prepare("SELECT id FROM ticket_snapshot WHERE ticket_key = 'K-4'").get() as { id: number }).id;
  saveDrift(s.db, "K-4", reqId, snap, snap, "ac_edited", { baseline: [{ id: "AC-1", status: "missing", coveredBy: [], note: "" }], current: [], contradictions: [] });
  for (const to of ["checking_drift", "awaiting_drift_ack"] as const) transition(s.db, "K-4", to, "system");
  assert.equal((await s.phone("POST", "/api/tickets/K-4/back-to-editing", { decidedBy: "local" })).status, 200);
  assert.equal(toState(s, "K-4", "awaiting_ac_review")?.decidedBy, dev());
  // and from this computer: local
  assert.equal((await s.local("PATCH", "/api/tickets/K-2", { reviewAc: false })).status, 200);
  assert.equal(audit2(s, "review_ac_changed").at(-1)!.payload.decidedBy, "local");
});

test("T13-2: a developing ticket's repos are 'working' while its open iteration runs; dev_done shows the last step's outcome", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  seed(s, "K-2", "dev_done");
  for (const key of ["K-1", "K-2"]) {
    const it = startIteration(s.db, key, "initial", null);
    addStep(s.db, it.id, { step: 1, summary: "s", repos: [repoResult("api", { tests: [run0("node --test", 1)], commit: { kind: "skipped_checks_failed" }, pendingChanges: true }), repoResult("web")] });
  }
  type R = { repos: Array<{ name: string; status: string }> };
  const dev = (await (await s.local("GET", "/api/tickets/K-1/development")).json()) as R;
  assert.deepEqual(dev.repos.map((r) => [r.name, r.status]), [["web", "working"], ["api", "working"]]);
  const done = (await (await s.local("GET", "/api/tickets/K-2/development")).json()) as R;
  assert.deepEqual(done.repos.map((r) => [r.name, r.status]), [["web", "green"], ["api", "failing"]]);
});

test("/diff without ?repo -> 400", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  assert.equal((await s.local("GET", "/api/tickets/K-1/diff")).status, 400);
});

test("bodies over 256 KB -> 413; ruling note over 4000 chars or comment id over 64 -> 400", async () => {
  const s = await setup2();
  seed(s, "K-1", "awaiting_debate_ruling");
  const big = await s.local("POST", "/api/tickets/K-1/snapshot-ack", { note: "x".repeat(300 * 1024) });
  assert.equal(big.status, 413);
  const long = [{ commentId: "C-1", decision: "custom", note: "n".repeat(4001) }, { commentId: "C-2", decision: "designer", note: "" }];
  assert.equal((await s.local("POST", "/api/tickets/K-1/debate/rulings", { rulings: long })).status, 400);
  const longId = [{ commentId: "C-" + "1".repeat(70), decision: "designer", note: "" }];
  assert.equal((await s.local("POST", "/api/tickets/K-1/debate/rulings", { rulings: longId })).status, 400);
  assert.equal(stateOf(s, "K-1"), "awaiting_debate_ruling");
});

test("a repo dir symlinked to another ticket's worktree is not served or inspected", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  seed(s, "K-2", "developing");
  const { path: other } = await ensureWorktree({ home: s.home, key: "K-2", repo: s.repos.api, branch: "slackoff/K-2-x" });
  const mine = worktreePath(s.home, "K-1", "api");
  mkdirSync(dirname(mine), { recursive: true });
  symlinkSync(other, mine);
  setRepoWorkspace(s.db, "K-1", { repo: "api", repoPath: s.repos.api.path, baseBranch: "main", branch: "slackoff/K-1-x", worktreePath: mine, choiceId: currentChoice(s.db, "K-1")!.id });
  assert.equal((await s.local("GET", "/api/tickets/K-1/diff?repo=api")).status, 409);
  const d = (await (await s.local("GET", "/api/tickets/K-1/development")).json()) as { repos: Array<{ name: string; hooks: unknown; diffStat: unknown }> };
  const api = d.repos.find((r) => r.name === "api")!;
  assert.equal(api.hooks, null);
  assert.equal(api.diffStat, null);
});

test("every phase-2 route answers 401 to a remote request without a session", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  const routes: Array<[string, string]> = [
    ["GET", "/api/tickets/K-1/design"],
    ["GET", "/api/tickets/K-1/design/docs/1"],
    ["POST", "/api/tickets/K-1/debate/rulings"],
    ["POST", "/api/tickets/K-1/rechoose"],
    ["POST", "/api/tickets/K-1/snapshot-ack"],
    ["POST", "/api/tickets/K-1/replan"],
    ["GET", "/api/tickets/K-1/development"],
    ["GET", "/api/tickets/K-1/diff?repo=api"],
    ["POST", "/api/tickets/K-1/development/request-changes"],
    ["POST", "/api/tickets/K-1/jira-writes/1/confirm"],
    ["POST", "/api/tickets/K-1/jira-writes/1/skip"],
    ["POST", "/api/tickets/K-1/jira-writes/1/retry"],
  ];
  for (const [method, path] of routes) {
    const res = await s.phoneRaw(method, path, method === "POST" ? {} : undefined);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  // Mac-only: refused before authentication
  assert.equal((await s.phoneRaw("POST", "/api/jira/browsers/detect")).status, 403);
});

// ---------------------------------------------------------------- phase 3 (Task 13): acceptance reports, evidence, review
// decisions, delivery and JIRA comments. Phone = a paired device (R16): decidedBy is the server's, never the body's.

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import type { AcceptanceReport } from "@slackoff/shared";
import { recordDecision, saveReport, startSeries } from "../src/acceptance/review-repo.ts";
import { createDelivery, listDeliveries, finishStep, startStep } from "../src/delivery/delivery-repo.ts";
import { InvalidTransitionError, ValidationError } from "../src/tickets/errors.ts";
import { DeliveryError } from "../src/delivery/git-push.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake image body")]);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const acReport3 = (verdict: AcceptanceReport["verdict"] = "passed"): AcceptanceReport => ({
  verdict, notExecutedReason: null, summary: "checked", targets: [],
  acs: [{ acId: "AC-1", text: "t", verdict: "pass", agentVerdict: "pass", flows: [], mismatch: null }, { acId: "AC-2", text: "u", verdict: "fail", agentVerdict: "fail", flows: [], mismatch: null }],
  specRun: null, projectE2e: [], isolation: { ok: true, checks: [], excluded: [] }, commits: [],
});

/** K-1 at awaiting_confirmation with one passed report in a fresh series and one screenshot (file under reviews/K-1/1-1/). */
function seedRv(s: S2, key = "K-1", o: { reports?: number } = {}) {
  seed(s, key, "dev_done");
  const reqId = (s.db.prepare("SELECT id FROM requirement WHERE ticket_key = ?").get(key) as { id: number }).id;
  const snapId = (s.db.prepare("SELECT id FROM ticket_snapshot WHERE ticket_key = ?").get(key) as { id: number }).id;
  const { id: seriesId } = startSeries(s.db, key, "handoff", null, "local");
  transition(s.db, key, "reviewing", "system");
  const dir = join(s.home, "reviews", key, `${seriesId}-1`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shot.png"), PNG);
  writeFileSync(join(dir, "http.json"), JSON.stringify({ status: 200 }));
  const ids: number[] = [];
  for (let i = 1; i <= (o.reports ?? 1); i++) {
    ids.push(
      saveReport(s.db, key, {
        seriesId, requirementId: reqId, snapshotId: snapId, attempt: i, report: acReport3(), developerNote: null,
        evidence: i === 1
          ? [
              { refKey: "AC-1/1", acId: "AC-1", kind: "screenshot", path: `${key}/${seriesId}-1/shot.png`, caption: "export page", sha256: sha256(PNG), bytes: PNG.length },
              { refKey: "AC-1/2", acId: "AC-1", kind: "http", path: `${key}/${seriesId}-1/http.json`, caption: "api", sha256: sha256(JSON.stringify({ status: 200 })), bytes: 14 },
            ]
          : [],
      }).id,
    );
  }
  transition(s.db, key, "awaiting_confirmation", "system");
  const evidence = s.db.prepare("SELECT e.id, e.kind FROM review_evidence e JOIN review_report r ON r.id = e.report_id WHERE r.ticket_key = ? ORDER BY e.id").all(key) as Array<{ id: number; kind: string }>;
  return { seriesId, reportIds: ids, dir, shot: evidence[0]!.id, http: evidence[1]!.id };
}

test("review/handoff: developing -> 409; dev_done -> reviewing (a phone: device audited); a dirty worktree -> 409 and disabled in /development", async () => {
  const s = await setup2();
  seed(s, "K-1", "developing");
  assert.equal((await s.local("POST", "/api/tickets/K-1/review/handoff")).status, 409);
  seed(s, "K-2", "dev_done");
  const res = await s.phone("POST", "/api/tickets/K-2/review/handoff", {});
  assert.equal(res.status, 200);
  // the review job then starts (and blocks: no agent here), so the move itself is what is checked
  const toReviewing = audit2(s, "state_changed").filter((r) => r.payload.to === "reviewing" && r.payload.from === "dev_done").at(-1)!;
  assert.equal(toReviewing.payload.decidedBy, `device:${s.phoneId()}`);

  // a worktree with an uncommitted file: disabled with the reason, and the route itself refuses
  seed(s, "K-3", "dev_done");
  const choiceId = currentChoice(s.db, "K-3")!.id;
  const { path } = await ensureWorktree({ home: s.home, key: "K-3", repo: s.repos.api, branch: "slackoff/K-3-x" });
  setRepoWorkspace(s.db, "K-3", { repo: "api", repoPath: s.repos.api.path, baseBranch: "main", branch: "slackoff/K-3-x", worktreePath: path, choiceId });
  const clean = (await (await s.local("GET", "/api/tickets/K-3/development")).json()) as { handOff: { enabled: boolean; reason: string | null } };
  assert.deepEqual(clean.handOff, { enabled: true, reason: null });
  writeFileSync(join(path, "dirty.txt"), "x");
  // cached per ticket until its next dev_step / state_changed: still enabled
  const cached = (await (await s.local("GET", "/api/tickets/K-3/development")).json()) as { handOff: { enabled: boolean } };
  assert.equal(cached.handOff.enabled, true);
  // the route checks again regardless of the cache
  const refused = await s.local("POST", "/api/tickets/K-3/review/handoff");
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /api.*uncommitted/);
  assert.equal(stateOf(s, "K-3"), "dev_done");
  // a later state change invalidates the cache
  const it = startIteration(s.db, "K-3", "initial", null);
  addStep(s.db, it.id, { step: 1, summary: "s", repos: [repoResult("api")] });
  const dirty = (await (await s.local("GET", "/api/tickets/K-3/development")).json()) as { handOff: { enabled: boolean; reason: string | null } };
  assert.equal(dirty.handOff.enabled, false);
  assert.match(dirty.handOff.reason ?? "", /api.*uncommitted/);
  // not dev_done: not enabled
  const dev = (await (await s.local("GET", "/api/tickets/K-1/development")).json()) as { handOff: { enabled: boolean; reason: string | null } };
  assert.equal(dev.handOff.enabled, false);
});

test("GET /review: maxAttempts, series, report summaries, current report, its evidence, the step and the isolation note", async () => {
  const s = await setup2();
  const r = seedRv(s);
  recordDecision(s.db, "K-1", r.reportIds[0]!, "re_review", "again", "local");
  const res = await s.phone("GET", "/api/tickets/K-1/review");
  assert.equal(res.status, 200);
  const v = (await res.json()) as {
    maxAttempts: number; series: Array<{ id: number }>; reports: Array<Record<string, unknown>>; current: { id: number; report: { verdict: string } } | null;
    evidence: Array<Record<string, unknown>>; step: { kind: string } | null; isolationNote: string;
  };
  assert.equal(v.maxAttempts, s.config.review.maxAttempts);
  assert.deepEqual(v.series.map((x) => x.id), [r.seriesId]);
  assert.deepEqual(Object.keys(v.reports[0]!).sort(), ["attempt", "createdAt", "decision", "failedAcs", "id", "seriesId", "verdict"]);
  const failed = (v.current as unknown as { report: { acs: Array<{ acId: string; verdict: string }> } }).report.acs.filter((a) => a.verdict === "fail").map((a) => a.acId);
  assert.ok(failed.length > 0, "the fixture has a failed AC");
  assert.deepEqual(v.reports[0]!.failedAcs, failed);
  assert.equal(v.reports[0]!.decision, "re_review");
  assert.equal(v.current!.id, r.reportIds[0]);
  assert.deepEqual(v.evidence.map((e) => [e.refKey, e.acId, e.kind, e.caption, Object.keys(e).sort().join()]), [
    ["AC-1/1", "AC-1", "screenshot", "export page", "acId,caption,id,kind,refKey"],
    ["AC-1/2", "AC-1", "http", "api", "acId,caption,id,kind,refKey"],
  ]);
  assert.equal(v.step!.kind, "accept");
  assert.match(v.isolationNote, /locked requirement/);
  // a ticket never handed over: an empty view
  seed(s, "K-9", "developing");
  const empty = (await (await s.local("GET", "/api/tickets/K-9/review")).json()) as { series: unknown[]; reports: unknown[]; current: unknown; evidence: unknown[]; step: unknown };
  assert.deepEqual([empty.series, empty.reports, empty.current, empty.evidence, empty.step], [[], [], null, [], null]);
  assert.equal((await s.local("GET", "/api/tickets/NOPE-1/review")).status, 404);
  // GET one report (any round), and another ticket's report id -> 404
  const one = await s.local("GET", `/api/tickets/K-1/review/reports/${r.reportIds[0]}`);
  assert.equal(one.status, 200);
  const rep = (await one.json()) as { id: number; report: { verdict: string }; evidence: unknown[]; decision: string | null };
  assert.deepEqual([rep.id, rep.report.verdict, rep.evidence.length, rep.decision], [r.reportIds[0], "passed", 2, "re_review"]);
  assert.equal((await s.local("GET", `/api/tickets/K-9/review/reports/${r.reportIds[0]}`)).status, 404);
  assert.equal((await s.local("GET", "/api/tickets/K-1/review/reports/999")).status, 404);
});

test("GET evidence: png and text are served hardened; another ticket's id -> 404", async () => {
  const s = await setup2();
  const r = seedRv(s);
  seed(s, "K-2", "dev_done");
  const shot = await s.local("GET", `/api/tickets/K-1/review/evidence/${r.shot}`);
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get("content-type"), "image/png");
  assert.equal(shot.headers.get("x-content-type-options"), "nosniff");
  assert.equal(shot.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(shot.headers.get("cache-control"), "private");
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), PNG);
  const txt = await s.local("GET", `/api/tickets/K-1/review/evidence/${r.http}`);
  assert.equal(txt.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(txt.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await txt.text(), '{"status":200}');
  const other = await s.local("GET", `/api/tickets/K-2/review/evidence/${r.shot}`);
  assert.equal(other.status, 404);
  assert.equal((await s.local("GET", "/api/tickets/K-1/review/evidence/abc")).status, 400);
  assert.equal((await s.local("GET", "/api/tickets/K-1/review/evidence/9999")).status, 404);
  assert.equal((await s.phoneRaw("GET", `/api/tickets/K-1/review/evidence/${r.shot}`)).status, 401);
});

test("GET evidence: a file swapped for a symlink out of reviews/, a changed file, a path with .. and a non-image screenshot -> 404", async () => {
  const s = await setup2();
  const r = seedRv(s);
  const secret = join(s.home, "config.json");
  writeFileSync(secret, '{"secret":true}');
  // the http evidence is replaced by a symlink to ../../config.json (outside reviews/)
  const file = join(r.dir, "http.json");
  rmSync(file);
  symlinkSync(join("..", "..", "..", "config.json"), file);
  const link = await s.local("GET", `/api/tickets/K-1/review/evidence/${r.http}`);
  assert.equal(link.status, 404);
  assert.ok(!(await link.text()).includes("secret"));
  // a symlink that stays inside reviews/ but is still a link: the file is no longer what was recorded under that path -> still refused (O_NOFOLLOW after realpath, hash check)
  // the screenshot's bytes changed after the copy -> 404
  writeFileSync(join(r.dir, "shot.png"), Buffer.concat([PNG, Buffer.from("tampered")]));
  assert.equal((await s.local("GET", `/api/tickets/K-1/review/evidence/${r.shot}`)).status, 404);
  // a row whose path holds '..' (the triggers are dropped to forge it): refused by the route itself
  for (const t of ["review_evidence_no_update", "review_evidence_no_delete"]) s.db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  writeFileSync(join(r.dir, "shot.png"), PNG);
  s.db.prepare("UPDATE review_evidence SET path = ? WHERE id = ?").run("K-1/../../config.json", r.http);
  assert.equal((await s.local("GET", `/api/tickets/K-1/review/evidence/${r.http}`)).status, 404);
  // an absolute path, and a screenshot that is not png / jpeg
  s.db.prepare("UPDATE review_evidence SET path = ? WHERE id = ?").run(secret, r.http);
  assert.equal((await s.local("GET", `/api/tickets/K-1/review/evidence/${r.http}`)).status, 404);
  writeFileSync(join(r.dir, "shot.png"), "<html>not an image</html>");
  s.db.prepare("UPDATE review_evidence SET sha256 = ? WHERE id = ?").run(sha256("<html>not an image</html>"), r.shot);
  assert.equal((await s.local("GET", `/api/tickets/K-1/review/evidence/${r.shot}`)).status, 404);
});

test("GET evidence: a directory at the recorded path -> 404 (regular files only)", async () => {
  const s = await setup2();
  const r = seedRv(s);
  rmSync(join(r.dir, "http.json"));
  mkdirSync(join(r.dir, "http.json"));
  assert.equal((await s.local("GET", `/api/tickets/K-1/review/evidence/${r.http}`)).status, 404);
});

test("review decisions: reject needs a note; re-review at the cap -> 400 'reject with comments'; wrong state -> 409; a phone is audited, body decidedBy ignored", async () => {
  const s = await setup2();
  seedRv(s, "K-1");
  for (const path of ["review/reject", "review/re-review", "review/ack"]) {
    assert.equal((await s.local("POST", `/api/tickets/K-1/${path}`, { note: "  " })).status, 400, path);
    assert.equal((await s.local("POST", `/api/tickets/K-1/${path}`, {})).status, 400, path);
  }
  // ack outside awaiting_review_ack
  assert.equal((await s.local("POST", "/api/tickets/K-1/review/ack", { note: "ok" })).status, 409);
  // at the cap: 3 reports in the round (maxAttempts 3)
  seedRv(s, "K-2", { reports: s.config.review.maxAttempts });
  const capped = await s.local("POST", "/api/tickets/K-2/review/re-review", { note: "once more" });
  assert.equal(capped.status, 400);
  assert.match(((await capped.json()) as { error: string }).error, /reject with comments/);
  assert.equal(stateOf(s, "K-2"), "awaiting_confirmation");
  // a phone re-reviews K-1; the forged decidedBy in the body is ignored
  const ok = await s.phone("POST", "/api/tickets/K-1/review/re-review", { note: "look at the export again", decidedBy: "local" });
  assert.equal(ok.status, 200);
  assert.ok(audit2(s, "state_changed").some((r) => r.payload.from === "awaiting_confirmation" && r.payload.to === "reviewing"));
  assert.equal(audit2(s, "review_decided").at(-1)!.payload.decidedBy, `device:${s.phoneId()}`);
  // reject on K-2 -> developing
  const rej = await s.phone("POST", "/api/tickets/K-2/review/reject", { note: "wrong column order" });
  assert.equal(rej.status, 200);
  assert.equal(stateOf(s, "K-2"), "developing");
  assert.equal(audit2(s, "review_decided").at(-1)!.payload.decidedBy, `device:${s.phoneId()}`);
});

test("delivery preview returns the plan with prBodies, warnings and the JIRA note; confirm: blockers 400, stale hash 409, ackNote passed, decidedBy from the request", async () => {
  const s = await setup2();
  seedRv(s);
  const plan = { actions: [], blockers: [], warnings: ["JIRA is not changed (status sync is off in Settings)"], prBodies: [{ repo: "api", title: "K-1: t", body: "b", isPrivate: true }], hash: "abcd" };
  const calls: Array<[string, string, string | null, string]> = [];
  s.workflow.previewDelivery = async () => ({ ...plan, jiraNote: null }) as never;
  s.workflow.confirmDelivery = async (key, hash, ack, by) => {
    calls.push([key, hash, ack, by]);
    if (hash === "stale") throw new InvalidTransitionError("the plan changed — review it again");
    if (hash === "blocked") throw new ValidationError("the delivery plan has blockers: gh is not logged in");
  };
  const prev = await s.phone("GET", "/api/tickets/K-1/delivery/preview");
  assert.equal(prev.status, 200);
  const p = (await prev.json()) as { prBodies: unknown[]; warnings: string[]; jiraNote: string | null; hash: string };
  assert.deepEqual([p.prBodies.length, p.warnings.length, p.jiraNote, p.hash], [1, 1, null, "abcd"]);
  assert.equal((await s.local("POST", "/api/tickets/K-1/delivery/confirm", { planHash: "stale" })).status, 409);
  assert.equal((await s.local("POST", "/api/tickets/K-1/delivery/confirm", { planHash: "blocked" })).status, 400);
  assert.equal((await s.local("POST", "/api/tickets/K-1/delivery/confirm", {})).status, 400);
  const ok = await s.phone("POST", "/api/tickets/K-1/delivery/confirm", { planHash: "abcd", ackNote: "  JIRA edit seen  ", decidedBy: "local" });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.at(-1), ["K-1", "abcd", "JIRA edit seen", `device:${s.phoneId()}`]);
  await s.local("POST", "/api/tickets/K-1/delivery/confirm", { planHash: "abcd" });
  assert.deepEqual(calls.at(-1), ["K-1", "abcd", null, "local"]);
  assert.equal((await s.local("POST", "/api/tickets/NOPE-1/delivery/confirm", { planHash: "abcd" })).status, 404);
  assert.equal((await s.phoneRaw("POST", "/api/tickets/K-1/delivery/confirm", { planHash: "abcd" })).status, 401);
});

test("delivery preview-again: 409 unless a blocked delivery; guarded and authenticated", async () => {
  const s = await setup2();
  seedRv(s);
  assert.equal((await s.local("POST", "/api/tickets/K-1/delivery/preview-again")).status, 409);
  assert.equal((await s.phoneRaw("POST", "/api/tickets/K-1/delivery/preview-again")).status, 401);
  const seen: string[] = [];
  s.workflow.previewAgain = (key, by) => { seen.push(`${key} ${by}`); };
  assert.equal((await s.phone("POST", "/api/tickets/K-1/delivery/preview-again", {})).status, 200);
  assert.deepEqual(seen, [`K-1 device:${s.phoneId()}`]);
});

test("GET /delivery: deliveries with steps (skipped included) and the opened PRs; retry of a push step -> 409, of a failed JIRA step -> 200", async () => {
  const s = await setup2();
  const r = seedRv(s);
  const plan = {
    hash: "h1", blockers: [], warnings: [], prBodies: [],
    actions: [
      { seq: 1, kind: "push" as const, repo: "api", text: "Push" },
      { seq: 2, kind: "pr" as const, repo: "api", text: "Open PR" },
      { seq: 3, kind: "jira_status" as const, repo: null, text: "Set status" },
      { seq: 4, kind: "jira_comment" as const, repo: null, text: "Comment" },
    ],
  };
  const { id } = createDelivery(s.db, "K-1", { reportId: r.reportIds[0]!, plan, ackNote: null, decidedBy: "local" });
  const steps = listDeliveries(s.db, "K-1")[0]!.steps;
  startStep(s.db, steps[0]!.id);
  finishStep(s.db, steps[0]!.id, "done", "pushed", null);
  startStep(s.db, steps[1]!.id);
  finishStep(s.db, steps[1]!.id, "done", "opened", { number: 7, url: "https://github.com/o/api/pull/7", reused: false });
  startStep(s.db, steps[2]!.id);
  finishStep(s.db, steps[2]!.id, "failed", "no transition button", null);
  s.db.prepare("UPDATE delivery_step SET state = 'skipped', detail = 'skipped — ticket abandoned' WHERE id = ?").run(steps[3]!.id);
  const v = (await (await s.phone("GET", "/api/tickets/K-1/delivery")).json()) as {
    deliveries: Array<{ id: number; steps: Array<{ state: string }> }>; prs: Array<{ repo: string; number: number; url: string }>;
  };
  assert.equal(v.deliveries[0]!.id, id);
  assert.deepEqual(v.deliveries[0]!.steps.map((x) => x.state), ["done", "done", "failed", "skipped"]);
  assert.deepEqual(v.prs, [{ repo: "api", number: 7, url: "https://github.com/o/api/pull/7" }]);
  assert.equal((await s.local("POST", `/api/tickets/K-1/delivery/steps/${steps[0]!.id}/retry`)).status, 409);
  assert.equal((await s.local("POST", "/api/tickets/K-1/delivery/steps/99999/retry")).status, 404);
  assert.equal((await s.local("POST", "/api/tickets/K-1/delivery/steps/x/retry")).status, 400);
  assert.equal((await s.phoneRaw("POST", `/api/tickets/K-1/delivery/steps/${steps[2]!.id}/retry`)).status, 401);
  // a failed JIRA step of a ticket that is not in pr_opened: refused by the workflow (409), nothing sent
  assert.equal((await s.local("POST", `/api/tickets/K-1/delivery/steps/${steps[2]!.id}/retry`)).status, 409);
  const spied: string[] = [];
  s.workflow.retryDeliveryStep = (key, stepId, by) => { spied.push(`${key} ${stepId} ${by}`); };
  assert.equal((await s.phone("POST", `/api/tickets/K-1/delivery/steps/${steps[2]!.id}/retry`, {})).status, 200);
  assert.deepEqual(spied, [`K-1 ${steps[2]!.id} device:${s.phoneId()}`]);
});

test("jira-comments: list, send (empty text 400), retry (only failed), a phone is audited; 401 without a session", async () => {
  const s = await setup2();
  seedRv(s);
  assert.deepEqual(await (await s.local("GET", "/api/tickets/K-1/jira-comments")).json(), []);
  assert.equal((await s.local("POST", "/api/tickets/K-1/jira-comments", { text: "   " })).status, 400);
  assert.equal((await s.local("POST", "/api/tickets/K-1/jira-comments", {})).status, 400);
  assert.equal((await s.phoneRaw("GET", "/api/tickets/K-1/jira-comments")).status, 401);
  assert.equal((await s.phoneRaw("POST", "/api/tickets/K-1/jira-comments", { text: "q" })).status, 401);
  assert.equal((await s.local("POST", "/api/tickets/NOPE-1/jira-comments", { text: "q" })).status, 404);
  const res = await s.phone("POST", "/api/tickets/K-1/jira-comments", { text: "Which export format do you want?", decidedBy: "local" });
  assert.equal(res.status, 202);
  const { id } = (await res.json()) as { id: number };
  assert.equal(audit2(s, "jira_comment_requested").at(-1)!.payload.decidedBy, `device:${s.phoneId()}`);
  await s.queue.idle();
  const list = (await (await s.local("GET", "/api/tickets/K-1/jira-comments")).json()) as Array<{ id: number; text: string }>;
  assert.deepEqual(list.map((c) => [c.id, c.text]), [[id, "Which export format do you want?"]]);
  // the default commenter throws: the comment failed; only a failed one is retried
  assert.equal((await s.local("POST", `/api/tickets/K-1/jira-comments/${id + 50}/retry`)).status, 404);
  s.db.prepare("UPDATE jira_comment SET state = 'done' WHERE id = ?").run(id);
  assert.equal((await s.local("POST", `/api/tickets/K-1/jira-comments/${id}/retry`)).status, 409);
  assert.equal((await s.phoneRaw("POST", `/api/tickets/K-1/jira-comments/${id}/retry`)).status, 401);
});

test("SSE carries review_updated, delivery_updated and jira_comment_updated to a paired phone", async () => {
  const s = await setup2();
  const res = await s.phone("GET", "/api/events");
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const until = async (re: RegExp) => {
    while (!re.test(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
  };
  await until(/connected/);
  for (const type of ["review_updated", "delivery_updated", "jira_comment_updated"] as const) {
    s.bus.emit({ type, ticketKey: "K-1" });
    await until(new RegExp(`event: ${type}\\ndata: {.*"ticketKey":"K-1"`));
    assert.match(buf, new RegExp(`event: ${type}`));
  }
  await reader.cancel();
});

test("/api/status counts awaiting_review_ack, awaiting_confirmation and failed delivery JIRA steps; ticket rows carry deliveryStepFailed", async () => {
  const s = await setup2();
  const needs = async () => ((await (await s.local("GET", "/api/status")).json()) as { needsYou: number }).needsYou;
  assert.equal(await needs(), 0);
  const r = seedRv(s, "K-1"); // awaiting_confirmation
  assert.equal(await needs(), 1);
  seed(s, "K-2", "dev_done"); // dev_done already counted
  transition(s.db, "K-2", "reviewing", "system");
  assert.equal(await needs(), 1);
  transition(s.db, "K-2", "awaiting_review_ack", "system");
  assert.equal(await needs(), 2);
  // K-1 delivered with a failed JIRA step: still needs me
  const plan = { hash: "h", blockers: [], warnings: [], prBodies: [], actions: [{ seq: 1, kind: "jira_status" as const, repo: null, text: "Set status" }] };
  createDelivery(s.db, "K-1", { reportId: r.reportIds[0]!, plan, ackNote: null, decidedBy: "local" });
  transition(s.db, "K-1", "delivering", "system");
  transition(s.db, "K-1", "pr_opened", "system");
  assert.equal(await needs(), 1);
  const step = listDeliveries(s.db, "K-1")[0]!.steps[0]!;
  startStep(s.db, step.id);
  finishStep(s.db, step.id, "failed", "boom", null);
  assert.equal(await needs(), 2);
  const rows = (await (await s.local("GET", "/api/tickets")).json()) as Array<{ key: string; deliveryStepFailed: boolean }>;
  assert.deepEqual(rows.map((x) => [x.key, x.deliveryStepFailed]), [["K-1", true], ["K-2", false]]);
});

test("every phase-3 route answers 401 to a remote request without a session", async () => {
  const s = await setup2();
  seedRv(s);
  const routes: Array<[string, string]> = [
    ["POST", "/api/tickets/K-1/review/handoff"],
    ["GET", "/api/tickets/K-1/review"],
    ["GET", "/api/tickets/K-1/review/reports/1"],
    ["GET", "/api/tickets/K-1/review/evidence/1"],
    ["POST", "/api/tickets/K-1/review/ack"],
    ["POST", "/api/tickets/K-1/review/reject"],
    ["POST", "/api/tickets/K-1/review/re-review"],
    ["GET", "/api/tickets/K-1/delivery/preview"],
    ["POST", "/api/tickets/K-1/delivery/confirm"],
    ["POST", "/api/tickets/K-1/delivery/preview-again"],
    ["GET", "/api/tickets/K-1/delivery"],
    ["POST", "/api/tickets/K-1/delivery/steps/1/retry"],
    ["GET", "/api/tickets/K-1/jira-comments"],
    ["POST", "/api/tickets/K-1/jira-comments"],
    ["POST", "/api/tickets/K-1/jira-comments/1/retry"],
  ];
  for (const [method, path] of routes) {
    assert.equal((await s.phoneRaw(method, path, method === "POST" ? {} : undefined)).status, 401, `${method} ${path}`);
  }
});

// ---- fix round 1 (ruling T13-1)

test("handoff state is not stuck on 'disabled': only enabled results are cached", async () => {
  const s = await setup2();
  seed(s, "K-3", "dev_done");
  const choiceId = currentChoice(s.db, "K-3")!.id;
  const { path } = await ensureWorktree({ home: s.home, key: "K-3", repo: s.repos.api, branch: "slackoff/K-3-x" });
  setRepoWorkspace(s.db, "K-3", { repo: "api", repoPath: s.repos.api.path, baseBranch: "main", branch: "slackoff/K-3-x", worktreePath: path, choiceId });
  const get = async () => ((await (await s.local("GET", "/api/tickets/K-3/development")).json()) as { handOff: { enabled: boolean } }).handOff.enabled;
  writeFileSync(join(path, "dirty.txt"), "x");
  assert.equal(await get(), false);
  rmSync(join(path, "dirty.txt"));
  assert.equal(await get(), true, "cleaned: the next GET shows enabled with no state change");
});

test("GET evidence: a file linked to a byte-identical copy outside reviews/ -> 404 (realpath containment)", async () => {
  const s = await setup2();
  const r = seedRv(s);
  const outside = join(s.home, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "copy.json"), '{"status":200}');
  rmSync(join(r.dir, "http.json"));
  symlinkSync(join(outside, "copy.json"), join(r.dir, "http.json"));
  assert.equal((await s.local("GET", `/api/tickets/K-1/review/evidence/${r.http}`)).status, 404);
});

test("GET evidence: a round folder linked to an outside folder holding identical files -> 404 (realpath containment)", async () => {
  const s = await setup2();
  const r = seedRv(s);
  const moved = join(s.home, "outside-round");
  mkdirSync(moved);
  writeFileSync(join(moved, "shot.png"), PNG);
  rmSync(r.dir, { recursive: true });
  symlinkSync(moved, r.dir);
  assert.equal((await s.local("GET", `/api/tickets/K-1/review/evidence/${r.shot}`)).status, 404);
});

test("GET evidence: a real fifo at the recorded path -> 404 (regular files only)", async () => {
  const s = await setup2();
  const r = seedRv(s);
  rmSync(join(r.dir, "http.json"));
  execFileSync("mkfifo", [join(r.dir, "http.json")]);
  assert.equal((await s.local("GET", `/api/tickets/K-1/review/evidence/${r.http}`)).status, 404);
});

test("a DeliveryError from the workflow is a 409 with its message", async () => {
  const s = await setup2();
  seedRv(s);
  s.workflow.confirmDelivery = async () => { throw new DeliveryError("remote branch b has commits that are not in api's local branch", "api"); };
  const res = await s.local("POST", "/api/tickets/K-1/delivery/confirm", { planHash: "h" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /remote branch b/);
});

test("review notes, comment text and the acknowledgement note over 4000 characters -> 400", async () => {
  const s = await setup2();
  seedRv(s);
  const long = "x".repeat(4001);
  for (const path of ["review/ack", "review/reject", "review/re-review"]) {
    assert.equal((await s.local("POST", `/api/tickets/K-1/${path}`, { note: long })).status, 400, path);
  }
  assert.equal((await s.local("POST", "/api/tickets/K-1/jira-comments", { text: long })).status, 400);
  assert.equal((await s.local("POST", "/api/tickets/K-1/delivery/confirm", { planHash: "h", ackNote: long })).status, 400);
  assert.equal((await s.local("POST", "/api/tickets/K-1/delivery/confirm", { planHash: "h".repeat(200) })).status, 400);
});

// ---------------------------------------------------------------- phase 4a Task 5: GET /api/sandbox

test("phase 4a Task 5: GET /api/sandbox — backend, a cached (60 s) dev-command self-check on a scratch scope, and the three switches; readable from a paired phone", async () => {
  let t = 1_000_000;
  const scopes: SandboxScope[] = [];
  const s = await setup2({
    sandbox: {
      now: () => t,
      sandboxBackend: () => ({ name: "sandbox-exec", available: true, reason: null }),
      sandboxCheck: async (sc) => (scopes.push(sc), { ok: true, detail: "4317:EPERM" }),
    },
  });
  s.config.development.allowUnsandboxedHooks = true;
  s.config.development.localNetwork = "allowlist";
  const res = await s.local("GET", "/api/sandbox");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { backend: unknown; selfCheck: { ok: boolean; detail: string; at: string } | null; switches: unknown };
  assert.deepEqual(body.backend, { name: "sandbox-exec", available: true, reason: null });
  assert.equal(body.selfCheck?.ok, true);
  assert.equal(body.selfCheck?.detail, "4317:EPERM");
  assert.equal(body.selfCheck?.at, new Date(1_000_000).toISOString());
  assert.deepEqual(body.switches, { allowUnsandboxedCommands: false, allowUnsandboxedHooks: true, localNetwork: "allowlist" });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0]!.kind, "dev-command");
  assert.equal(scopes[0]!.home, s.home);
  assert.ok(scopes[0]!.allowInHome!.startsWith(join(s.home, "sandbox") + "/"), scopes[0]!.allowInHome!);
  assert.deepEqual(scopes[0]!.localNetwork, { mode: "allowlist", allowPorts: [] }, "the check runs in the configured mode");
  // a paired phone may read it; within 60 s the cached check is reused
  t += 59_000;
  const ph = await s.phone("GET", "/api/sandbox");
  assert.equal(ph.status, 200);
  assert.equal(((await ph.json()) as { selfCheck: { at: string } }).selfCheck.at, new Date(1_000_000).toISOString());
  assert.equal(scopes.length, 1);
  t += 2_000;
  await s.local("GET", "/api/sandbox");
  assert.equal(scopes.length, 2, "re-checked after 60 s");
});

test("phase 4a Task 5: GET /api/sandbox off macOS — backend 'none' with its reason, no self-check run", async () => {
  let checks = 0;
  const s = await setup2({
    sandbox: { sandboxBackend: () => ({ name: "none", available: false, reason: "sandbox-exec is not available on linux" }), sandboxCheck: async () => (checks++, { ok: false, detail: "x" }) },
  });
  const body = (await (await s.phone("GET", "/api/sandbox")).json()) as { backend: { available: boolean; reason: string }; selfCheck: unknown };
  assert.equal(body.backend.available, false);
  assert.match(body.backend.reason, /not available on linux/);
  assert.equal(body.selfCheck, null);
  assert.equal(checks, 0);
});

// ---------------------------------------------------------------- phase 4a Task 7 item 3: the fake-mode overlay

test("phase 4a Task 7 / 4A-15 (M-6): fake mode's in-memory acceptance dir, JIRA URL and FAKE project are never written to config.json by a Settings save, edited or not; they stay in memory", async () => {
  const s = await setup2({
    fakeOverlay: (home, repos) => ({
      claudeConfigDir: join(dirname(home), `${basename(home)}-acceptance`, "claude-config"),
      jiraBaseUrl: "https://fake-jira.example.com",
      projects: { FAKE: { repos } },
    }),
  });
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, Record<string, unknown>>;
  assert.equal((cfg.jira as { baseUrl: string }).baseUrl, "https://fake-jira.example.com");
  assert.ok((cfg.projects as Record<string, unknown>).FAKE);
  const res = await s.local("PUT", "/api/config", { ...cfg, concurrency: 2 });
  assert.equal(res.status, 200, await res.clone().text());
  const disk = readText(join(s.home, "config.json"), "utf8");
  assert.doesNotMatch(disk, /fake-jira/);
  assert.doesNotMatch(disk, /"FAKE"/);
  const saved = JSON.parse(disk) as { concurrency: number; projects: Record<string, unknown>; acceptance: { claudeConfigDir: string } };
  assert.equal(saved.acceptance.claudeConfigDir, DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR, "the default, not the fake dir");
  assert.equal(saved.concurrency, 2);
  assert.ok(saved.projects.K, "the developer's own project is saved");
  const after = (await res.json()) as { config: { jira: { baseUrl: string }; projects: Record<string, unknown>; acceptance: { claudeConfigDir: string } } };
  assert.equal(after.config.jira.baseUrl, "https://fake-jira.example.com", "still overlaid in memory");
  assert.ok(after.config.projects.FAKE);
  assert.match(after.config.acceptance.claudeConfigDir, /-acceptance\/claude-config$/);
  // 4A-15 (M-6): edited in fake mode, they are still never saved (the FAKE repos' paths, the fake dirs and URL)
  const fakeProject = after.config.projects.FAKE as { repos: Array<{ name: string; path: string; baseBranch: string }> };
  const edited = await s.local("PUT", "/api/config", {
    ...after.config,
    jira: { ...after.config.jira, baseUrl: "https://your-company.atlassian.net" },
    acceptance: { ...after.config.acceptance, claudeConfigDir: after.config.acceptance.claudeConfigDir + "-2" },
    projects: { ...after.config.projects, FAKE: { repos: fakeProject.repos.slice(0, 1) } },
  });
  assert.equal(edited.status, 200, await edited.clone().text());
  const disk2 = JSON.parse(readText(join(s.home, "config.json"), "utf8")) as { jira: { baseUrl: string }; projects: Record<string, unknown>; acceptance: { claudeConfigDir: string } };
  assert.equal(disk2.jira.baseUrl, "");
  assert.equal(disk2.projects.FAKE, undefined);
  assert.ok(disk2.projects.K);
  assert.equal(disk2.acceptance.claudeConfigDir, DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR);
});

// ---------------------------------------------------------------- 4A-15 (M-1, M-2): GET /api/sandbox

test("4A-15 (M-1): a paired phone gets a coarse self-check (status + a fixed text), never the check's detail; this computer gets the detail", async () => {
  const detail = "sandbox self-check failed: /Users/<you>/.slackoff/slackoff.db:READABLE stderr line";
  const s = await setup2({ sandbox: { sandboxBackend: () => ({ name: "sandbox-exec", available: true, reason: null }), sandboxCheck: async () => ({ ok: false, detail }) } });
  const local = (await (await s.local("GET", "/api/sandbox")).json()) as { selfCheck: { ok: boolean; detail: string; status: string } };
  assert.equal(local.selfCheck.detail, detail);
  assert.equal(local.selfCheck.status, "failed");
  const phone = (await (await s.phone("GET", "/api/sandbox")).json()) as { selfCheck: { ok: boolean; detail: string; status: string } };
  assert.equal(phone.selfCheck.ok, false);
  assert.equal(phone.selfCheck.status, "failed");
  assert.equal(phone.selfCheck.detail, "The sandbox self-check failed. Open Settings on this computer for details.");
  const ok = await setup2({ sandbox: { sandboxBackend: () => ({ name: "sandbox-exec", available: true, reason: null }), sandboxCheck: async () => ({ ok: true, detail: "4317:EPERM /some/path" }) } });
  const p2 = (await (await ok.phone("GET", "/api/sandbox")).json()) as { selfCheck: { detail: string; status: string } };
  assert.deepEqual([p2.selfCheck.status, p2.selfCheck.detail], ["ok", "The sandbox self-check passed."]);
  const none = await setup2({ sandbox: { sandboxBackend: () => ({ name: "none", available: false, reason: "sandbox-exec is not available on linux" }) } });
  const p3 = (await (await none.phone("GET", "/api/sandbox")).json()) as { selfCheck: unknown; status: string };
  assert.equal(p3.selfCheck, null);
  assert.equal(p3.status, "unavailable");
});

test("4A-15 (M-2): concurrent GET /api/sandbox share one in-flight self-check", async () => {
  let checks = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = await setup2({
    sandbox: {
      sandboxBackend: () => ({ name: "sandbox-exec", available: true, reason: null }),
      sandboxCheck: async () => {
        checks++;
        await gate;
        return { ok: true, detail: "ok" };
      },
    },
  });
  const a = s.local("GET", "/api/sandbox");
  const b = s.phone("GET", "/api/sandbox");
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.equal(checks, 1);
});

// ---------------------------------------------------------------- phase 4b Task 2: credentials.json (X-4, B-3, B-9)

import { chmodSync, lstatSync as lstatForMode } from "node:fs";
import { randomBytes } from "node:crypto";
import { CREDENTIALS_FILE, writeCredentials } from "../src/credentials/credential-store.ts";

const statSyncMode = (p: string) => lstatForMode(p).mode & 0o777;
const fakeSecret = (prefix: string) => `${prefix}${randomBytes(8).toString("hex")}`;

async function withCredentials(s: S2) {
  const email = "you@example.com";
  const apiToken = fakeSecret("test-token-");
  const apiKey = fakeSecret("test-key-");
  const header = fakeSecret("test-otlp-");
  assert.equal((await s.local("PUT", "/api/credentials/jira", { email, apiToken })).status, 200);
  assert.equal((await s.local("PUT", "/api/credentials/anthropic", { apiKey })).status, 200);
  assert.equal((await s.local("PUT", "/api/credentials/otlp-headers", { headers: { "x-api-key": header } })).status, 200);
  const b64 = Buffer.from(`${email}:${apiToken}`).toString("base64");
  return { email, apiToken, apiKey, header, values: [email, apiToken, apiKey, header, b64] };
}

const assertNoValues = (text: string, values: string[], where: string) => {
  for (const v of values) assert.ok(!text.includes(v), `${where} must not contain a credential value`);
};

test("4b T2: GET /api/credentials is status only — the email hint for this computer, nothing but set/names/time for a phone", async () => {
  const s = await setup2();
  const empty = (await (await s.local("GET", "/api/credentials")).json()) as Record<string, { set: boolean }>;
  assert.deepEqual([empty.jira!.set, empty.anthropic!.set, empty.otlpHeaders!.set], [false, false, false]);
  const { values } = await withCredentials(s);
  const localRes = await s.local("GET", "/api/credentials");
  assert.equal(localRes.status, 200);
  const localText = await localRes.text();
  assertNoValues(localText, values, "the local status");
  const local = JSON.parse(localText) as { jira: { set: boolean; emailHint: string | null }; anthropic: { set: boolean }; otlpHeaders: { names: string[] } };
  assert.equal(local.jira.set, true);
  assert.equal(local.jira.emailHint, "y…@example.com");
  assert.equal(local.anthropic.set, true);
  assert.deepEqual(local.otlpHeaders.names, ["x-api-key"]);
  const phoneRes = await s.phone("GET", "/api/credentials");
  assert.equal(phoneRes.status, 200);
  const phoneText = await phoneRes.text();
  assertNoValues(phoneText, values, "the phone status");
  assert.equal((JSON.parse(phoneText) as { jira: { emailHint: unknown } }).jira.emailHint, null);
  assert.equal((await s.phoneRaw("GET", "/api/credentials")).status, 401, "a remote request without a session");
});

test("4b T2: GET /api/config and config.json never hold a credential", async () => {
  const s = await setup2();
  const { values } = await withCredentials(s);
  assertNoValues(await (await s.local("GET", "/api/config")).text(), values, "GET /api/config");
  assertNoValues(await (await s.phone("GET", "/api/config")).text(), values, "GET /api/config (phone)");
  assertNoValues(readFileSync(join(s.home, "config.json"), "utf8"), values, "config.json");
  const file = join(s.home, CREDENTIALS_FILE);
  assert.equal(statSyncMode(file), 0o600);
});


test("4b T2: a paired phone cannot set or remove a credential (403, nothing written)", async () => {
  const s = await setup2();
  for (const [method, path, body] of [
    ["PUT", "/api/credentials/jira", { email: "you@example.com", apiToken: fakeSecret("test-token-") }],
    ["PUT", "/api/credentials/anthropic", { apiKey: fakeSecret("test-key-") }],
    ["PUT", "/api/credentials/otlp-headers", { headers: { "x-api-key": "v" } }],
    ["DELETE", "/api/credentials/jira", undefined],
    ["DELETE", "/api/credentials/anthropic", undefined],
    ["DELETE", "/api/credentials/otlp-headers", undefined],
  ] as const) {
    const res = await s.phone(method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal(existsSync(join(s.home, CREDENTIALS_FILE)), false);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE type = 'credentials_changed'").get() as { n: number }).n, 0);
});

test("4b T2: setting and removing on this computer audits only {which, action}", async () => {
  const s = await setup2();
  const { values } = await withCredentials(s);
  assert.equal((await s.local("DELETE", "/api/credentials/anthropic")).status, 200);
  assert.equal((await s.local("DELETE", "/api/credentials/otlp-headers")).status, 200);
  const rows = s.db.prepare("SELECT actor, payload_json FROM audit_event WHERE type = 'credentials_changed' ORDER BY id").all() as Array<{ actor: string; payload_json: string }>;
  assert.deepEqual(rows.map((r) => JSON.parse(r.payload_json)), [
    { which: "jira", action: "set" }, { which: "anthropic", action: "set" }, { which: "otlpHeaders", action: "set" },
    { which: "anthropic", action: "removed" }, { which: "otlpHeaders", action: "removed" },
  ]);
  assert.ok(rows.every((r) => r.actor === "developer"));
  const all = JSON.stringify(s.db.prepare("SELECT payload_json FROM audit_event").all());
  assertNoValues(all, values, "the audit log");
  const after = (await (await s.local("GET", "/api/credentials")).json()) as Record<string, { set: boolean }>;
  assert.deepEqual([after.jira!.set, after.anthropic!.set, after.otlpHeaders!.set], [true, false, false]);
  // removing what is not set changes nothing and audits nothing; an unknown kind is 404
  assert.equal((await s.local("DELETE", "/api/credentials/anthropic")).status, 200);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE type = 'credentials_changed'").get() as { n: number }).n, 5);
  assert.equal((await s.local("DELETE", "/api/credentials/github")).status, 404);
});

test("4b T2: an invalid credential is refused (400) without echoing it", async () => {
  const s = await setup2();
  const token = fakeSecret("test-token-");
  for (const [path, body] of [
    ["/api/credentials/jira", { email: "not-an-email", apiToken: token }],
    ["/api/credentials/jira", { email: "you@example.com", apiToken: `${token} x` }],
    ["/api/credentials/anthropic", { apiKey: `${token}\n` }],
    ["/api/credentials/otlp-headers", { headers: { "bad name": token } }],
  ] as const) {
    const res = await s.local("PUT", path, body);
    assert.equal(res.status, 400, path);
    const text = await res.text();
    assert.ok(!text.includes(token) && !text.includes("not-an-email") && !text.includes("bad name"), text);
  }
  assert.equal(existsSync(join(s.home, CREDENTIALS_FILE)), false);
});

test("4b T2: every error response passes through redactSecrets", async () => {
  const s = await setup2();
  const { apiKey, apiToken } = await withCredentials(s);
  s.workflow.abandon = () => { throw new Error(`upstream said: invalid x-api-key ${apiKey} (token ${apiToken})`); };
  const res = await s.local("POST", "/api/tickets/K-1/abandon");
  assert.equal(res.status, 500);
  const { error } = (await res.json()) as { error: string };
  assert.ok(!error.includes(apiKey) && !error.includes(apiToken), error);
  assert.match(error, /\[redacted\]/);
});

test("4b T2: a credentials.json with a loose mode is refused with the fixed message, never fixed", async () => {
  const s = await setup2();
  const { values } = await withCredentials(s);
  chmodSync(join(s.home, CREDENTIALS_FILE), 0o644);
  for (const res of [await s.local("GET", "/api/credentials"), await s.local("PUT", "/api/credentials/anthropic", { apiKey: fakeSecret("test-key-") })]) {
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.match(text, /credentials\.json must be a regular file with mode 600 owned by you/);
    assertNoValues(text, values, "the error");
  }
  assert.equal(statSyncMode(join(s.home, CREDENTIALS_FILE)), 0o644);
});

// ---------------------------------------------------------------- phase 4b Task 3: executor.kind and jira.source

test("4b T3: /api/status reports the configured executor kind and JIRA source", async () => {
  const s = await setup2();
  type St = { executor: { kind: string; label: string }; jira: { source: string } };
  const before = (await (await s.local("GET", "/api/status")).json()) as St;
  assert.deepEqual([before.executor.kind, before.jira.source], ["claude-code", "browser"]);
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, Record<string, unknown>>;
  const res = await s.local("PUT", "/api/config", { ...cfg, executor: { ...cfg.executor, kind: "claude-api" }, jira: { ...cfg.jira, source: "api" } });
  assert.equal(res.status, 200, await res.clone().text());
  const after = (await (await s.phone("GET", "/api/status")).json()) as St;
  assert.deepEqual([after.executor.kind, after.jira.source], ["claude-api", "api"]);
  assert.match(after.executor.label, /API key/);
  assert.match(before.executor.label, /subscription/);
});

test("4b T3: a paired phone cannot change executor.kind or jira.source (403); this computer can", async () => {
  const s = await setup2();
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, Record<string, unknown>>;
  for (const patch of [{ jira: { ...cfg.jira, source: "api" } }, { executor: { ...cfg.executor, kind: "claude-api" }, jira: { ...cfg.jira, source: "api" } }]) {
    const res = await s.phone("PUT", "/api/config", { ...cfg, ...patch });
    assert.equal(res.status, 403, JSON.stringify(patch));
  }
  assert.equal(s.config.jira.source, "browser");
  assert.equal(s.config.executor.kind, "claude-code");
  const ok = await s.local("PUT", "/api/config", { ...cfg, jira: { ...cfg.jira, source: "api" } });
  assert.equal(ok.status, 200);
  assert.equal(s.config.jira.source, "api");
  // the pair B-4 refuses (API_CHROME unavailable) is a 400 naming jira.source
  const bad = await s.local("PUT", "/api/config", { ...cfg, executor: { ...cfg.executor, kind: "claude-api" }, jira: { ...cfg.jira, source: "browser" } });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /jira\.source: the API executor cannot drive Chrome/);
});

// ---------------------------------------------------------------- phase 4b fix round 1 (4B-2, 4B-3)

test("4B-2 (I1): an error echoing a replaced or removed key, or the key of a file now refused, is still redacted", async () => {
  const s = await setup2();
  const a = fakeSecret("test-key-a-");
  const b = fakeSecret("test-key-b-");
  let thrown = "";
  s.workflow.abandon = () => { throw new Error(thrown); };
  const errorFor = async (text: string) => {
    thrown = text;
    return ((await (await s.local("POST", "/api/tickets/K-1/abandon")).json()) as { error: string }).error;
  };
  assert.equal((await s.local("PUT", "/api/credentials/anthropic", { apiKey: a })).status, 200);
  assert.equal((await s.local("PUT", "/api/credentials/anthropic", { apiKey: b })).status, 200);
  assert.equal(await errorFor(`old ${a}`), "old [redacted]");
  assert.equal((await s.local("DELETE", "/api/credentials/anthropic")).status, 200);
  assert.equal(await errorFor(`gone ${b}`), "gone [redacted]");
  const c = fakeSecret("test-key-c-");
  assert.equal((await s.local("PUT", "/api/credentials/anthropic", { apiKey: c })).status, 200);
  chmodSync(join(s.home, CREDENTIALS_FILE), 0o644);
  assert.equal(await errorFor(`now ${c}`), "now [redacted]");
});

test("4B-3 (M1): 404 and unknown-role errors never echo the path, so redaction is no oracle", async () => {
  const s = await setup2();
  const { email } = await withCredentials(s);
  for (const path of [`/api/tickets/${encodeURIComponent(email)}`, "/api/tickets/GUESS-1", `/api/tickets/GUESS-1/snapshots/1`]) {
    const res = await s.phone("GET", path);
    assert.equal(res.status, 404, path);
    const text = await res.text();
    assert.ok(!text.includes("[redacted]") && !text.includes("GUESS") && !text.includes("example.com"), text);
  }
  const role = await s.phone("GET", `/api/prompts/x-${fakeSecret("guess-")}-y`);
  assert.equal(role.status, 400);
  const roleText = await role.text();
  assert.ok(!roleText.includes("guess-") && !roleText.includes("[redacted]"), roleText);
  const diff = await s.phone("GET", `/api/tickets/GUESS-1/diff?repo=${encodeURIComponent(email)}`);
  assert.ok(!(await diff.text()).includes("[redacted]"));
});

// ---------------------------------------------------------------- phase 4b fix round 2 (4B-6, M1 remainder)

test("4B-6 (M1): a phone's PUT /api/config touching a sensitive field is refused before validation (no echo of a guessed key)", async () => {
  const s = await setup2();
  const { email } = await withCredentials(s);
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, unknown>;
  for (const projects of [{ [email]: { repos: [{ name: "BAD NAME", path: "rel", baseBranch: "-x" }] } }, { [email]: { repos: [] } }]) {
    const res = await s.phone("PUT", "/api/config", { ...cfg, projects });
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.ok(!text.includes("[redacted]") && !text.includes(email), text);
  }
  // an invalid phone-editable value with the sensitive fields untouched is a plain 400
  const bad = await s.phone("PUT", "/api/config", { ...cfg, debate: { maxRounds: 99 } });
  assert.equal(bad.status, 400);
});

test("4B-6 (M1): config validation errors mask record keys (projects.<key>)", async () => {
  const s = await setup2();
  const { email } = await withCredentials(s);
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, unknown>;
  const res = await s.local("PUT", "/api/config", { ...cfg, projects: { [email]: { repos: [] }, "GUESS-KEY": { repos: [] } } });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(!text.includes("[redacted]") && !text.includes(email) && !text.includes("GUESS-KEY"), text);
  assert.match(text, /projects\.<key>\.repos/);
});

// ---- phase 4d task 2: preferences ----

/** K-n at awaiting_choice with two options (S and L) for the same requirement. */
function seedTwoOptions(s: S2, key: string): number[] {
  seed(s, key, "awaiting_choice");
  const reqId = (s.db.prepare("SELECT id FROM requirement WHERE ticket_key = ?").get(key) as { id: number }).id;
  saveSolutions(s.db, key, reqId, [{ ...solution, title: "small", complexity: "S" }, { ...solution, title: "big", complexity: "L" }]);
  return listSolutions(s.db, key).map((x) => x.id);
}

test("4d: choosing (from a phone) records a signal; the third simplest choice derives a summary; GET /api/preferences on any device", async () => {
  const s = await setup2();
  for (const key of ["K-1", "K-2", "K-3"]) {
    const ids = seedTwoOptions(s, key);
    assert.equal((await s.phone("POST", `/api/tickets/${key}/choose`, { solutionId: ids[0], note: "", affectedRepos: ["api", "web"] })).status, 200);
  }
  const res = await s.phone("GET", "/api/preferences");
  assert.equal(res.status, 200);
  const st = (await res.json()) as { current: { version: number; text: string; source: string } | null; derivedPreview: string; counted: number; needed: number; signalsSinceEdit: number };
  assert.equal(st.counted, 3);
  assert.equal(st.needed, 3);
  assert.equal(st.current?.source, "derived");
  assert.match(st.current!.text, /In 3 of 3 comparable choices you picked the simplest option/);
  assert.equal(st.derivedPreview, st.current!.text);
});

test("4d: editing, clearing and re-deriving preferences is for this computer only (403 on a phone, nothing changes)", async () => {
  const s = await setup2();
  const count = () => (s.db.prepare("SELECT COUNT(*) AS n FROM preference_summary").get() as { n: number }).n;
  for (const [method, path, body] of [["PUT", "/api/preferences", { text: "phone text" }], ["POST", "/api/preferences/clear", undefined], ["POST", "/api/preferences/rederive", undefined]] as const) {
    const res = await s.phone(method, path, body);
    assert.equal(res.status, 403, path);
    assert.match(((await res.json()) as { error: string }).error, /only available on this computer/);
  }
  assert.equal(count(), 0);
  const put = await s.local("PUT", "/api/preferences", { text: "Prefer small changes." });
  assert.equal(put.status, 200);
  const st = (await put.json()) as { current: { source: string; text: string; version: number } };
  assert.deepEqual([st.current.source, st.current.text, st.current.version], ["edited", "Prefer small changes.", 1]);
  assert.equal((await s.local("POST", "/api/preferences/rederive")).status, 200);
  const cleared = (await (await s.local("POST", "/api/preferences/clear")).json()) as { current: { source: string; text: string } };
  assert.deepEqual([cleared.current.source, cleared.current.text], ["cleared", ""]);
  assert.equal(count(), 3);
  assert.deepEqual(audit2(s, "preference_summary_changed").map((e) => e.payload), [
    { version: 1, source: "edited" }, { version: 2, source: "derived" }, { version: 3, source: "cleared" },
  ]);
});

test("4d: PUT /api/preferences — 2001 characters or a non-string → 400 without echoing the text; a stored credential is redacted", async () => {
  const s = await setup2();
  const long = `SECRETISH-${"x".repeat(1991)}`;
  assert.equal(long.length, 2001);
  const res = await s.local("PUT", "/api/preferences", { text: long });
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes("SECRETISH"));
  assert.equal((await s.local("PUT", "/api/preferences", { text: 42 })).status, 400);
  assert.equal((await s.local("PUT", "/api/preferences", { text: "   " })).status, 400);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM preference_summary").get() as { n: number }).n, 0);
  // phase 4b redaction applies to this sink too: a credential pasted into the text is not stored
  const key = fakeSecret("test-key-");
  assert.equal((await s.local("PUT", "/api/credentials/anthropic", { apiKey: key })).status, 200);
  assert.equal((await s.local("PUT", "/api/preferences", { text: `use ${key} please` })).status, 200);
  const stored = (s.db.prepare("SELECT text FROM preference_summary ORDER BY version DESC LIMIT 1").get() as { text: string }).text;
  assert.ok(!stored.includes(key));
  assert.match(stored, /^use .+ please$/);
});

test("4D-1: abandoning a ticket (phone) supersedes its choice's signal and the summary is re-derived", async () => {
  const s = await setup2();
  for (const key of ["K-1", "K-2", "K-3"]) {
    const ids = seedTwoOptions(s, key);
    assert.equal((await s.phone("POST", `/api/tickets/${key}/choose`, { solutionId: ids[0], note: "", affectedRepos: ["api", "web"] })).status, 200);
  }
  assert.equal((await s.phone("POST", "/api/tickets/K-2/abandon", {})).status, 200);
  const st = (await (await s.phone("GET", "/api/preferences")).json()) as { counted: number; current: { text: string; source: string } };
  assert.equal(st.counted, 2);
  assert.deepEqual([st.current.source, st.current.text], ["derived", ""]);
  const rows = s.db.prepare("SELECT ticket_key, superseded FROM preference_signal ORDER BY id").all() as Array<{ ticket_key: string; superseded: number }>;
  assert.deepEqual(rows.map((r) => [r.ticket_key, r.superseded]), [["K-1", 0], ["K-2", 1], ["K-3", 0]]);
});

// ---- phase 4d task 4: restore default audit; the built-in instructions ----

test("4d: GET /api/prompts/:role/default returns the skill body and version on any device; unknown role → 404 without echo", async () => {
  const s = await setup2();
  for (const call of [s.local, s.phone]) {
    const res = await call("GET", "/api/prompts/refine-ticket/default");
    assert.equal(res.status, 200);
    const d = (await res.json()) as { name: string; version: string; body: string };
    const skill = loadSkill(repoRoot, "refine-ticket");
    assert.deepEqual(d, { name: "refine-ticket", version: skill.version, body: skill.body });
  }
  const bad = await s.local("GET", "/api/prompts/no-such-role-zq9/default");
  assert.equal(bad.status, 404);
  assert.ok(!(await bad.text()).includes("zq9"));
});

test("4d: restore default is this computer only and audited as prompt_reset", async () => {
  const s = await setup2();
  assert.equal((await s.local("PUT", "/api/prompts/refine-ticket", { text: "be terse" })).status, 200);
  assert.equal((await s.phone("POST", "/api/prompts/refine-ticket/reset")).status, 403);
  const res = await s.local("POST", "/api/prompts/refine-ticket/reset");
  assert.equal(res.status, 200);
  const { id, version } = (await res.json()) as { id: number; version: number };
  assert.deepEqual(audit2(s, "prompt_reset").map((e) => e.payload), [{ role: "refine-ticket", id, version }]);
  assert.equal(audit2(s, "prompt_updated").length, 1);
});

// ---- phase 4d task 5: trial runs over HTTP ----

import { fakeRun } from "../src/dev/fake-mode.ts";
import type { RunAgentRequest } from "../src/executor/run-agent.ts";
import { redactorWith } from "../src/credentials/credential-store.ts";

/** F4D-1 (M3): a trial request that never answers (a broken guard) fails the test instead of hanging it. */
function within<T>(p: T | Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(timer));
}

test("4d: POST /api/prompts/:role/trial — this computer only; one at a time (409); a non-trial role → 400; the result comes back", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let runs = 0;
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    runs++;
    req.onRunStart?.("trial-run-1");
    await gate;
    return fakeRun(req);
  };
  const s = await setup2({ trial: { run, tmpRoot: tmpDir("trial-http") } });
  assert.equal((await within(s.phone("POST", "/api/prompts/refine-ticket/trial", { text: "draft" }))).status, 403);
  assert.equal((await within(s.local("POST", "/api/prompts/implement-ticket/trial", { text: "draft" }))).status, 400);
  assert.equal((await within(s.local("POST", "/api/prompts/refine-ticket/trial", { text: 5 }))).status, 400);
  assert.equal(runs, 0);
  const first = s.local("POST", "/api/prompts/refine-ticket/trial", { text: "draft" });
  await new Promise((r) => setTimeout(r, 20));
  let second: Response;
  try {
    second = await within(s.local("POST", "/api/prompts/propose-solutions/trial", { text: "draft" }));
  } finally {
    release();
  }
  assert.equal(second.status, 409);
  // F4D-1 (M6): the busy answer says when the slot frees (a trial has no retry and the default 10-minute timeout)
  assert.deepEqual(await second.json(), { error: "A trial is already running; it ends within 10 minutes." });
  const res = await within(first);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; role: string; runId: string; output: { acceptanceCriteria: unknown[] } };
  assert.deepEqual([body.ok, body.role, body.runId], [true, "refine-ticket", "trial-run-1"]);
  assert.ok(body.output.acceptanceCriteria.length > 0);
  // free again
  assert.equal((await within(s.local("POST", "/api/prompts/refine-ticket/trial", { text: "again" }))).status, 200);
  assert.equal(runs, 2);
});

test("4d: a failed trial answers 200 with ok:false and a redacted error; no ticket changes", async () => {
  const key = fakeSecret("test-key-");
  const run = async <T>(_req: RunAgentRequest<T>): Promise<T> => {
    throw new Error(`the agent said ${key}`);
  };
  const s = await setup2({ trial: { run, tmpRoot: tmpDir("trial-http2") } });
  assert.equal((await s.local("PUT", "/api/credentials/anthropic", { apiKey: key })).status, 200);
  seed(s, "K-1", "awaiting_choice");
  const res = await within(s.local("POST", "/api/prompts/propose-solutions/trial", { text: "draft" }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(key));
  const body = JSON.parse(text) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /the agent said/);
  assert.equal(stateOf(s, "K-1"), "awaiting_choice");
});

test("4d: without the trial runner (not configured) the route is a 409, never a crash", async () => {
  const s = await setup2();
  assert.equal((await within(s.local("POST", "/api/prompts/refine-ticket/trial", { text: "draft" }))).status, 409);
});

// ---- final fix pass (F4D-1 M2, M8) ----

test("F4D-1 M2: a credential in the trial draft never reaches run; the agent gets it redacted", async () => {
  const key = fakeSecret("test-key-");
  const drafts: Array<string | undefined> = [];
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    drafts.push(req.additionsOverride);
    return fakeRun(req);
  };
  const s = await setup2({ trial: { run, tmpRoot: tmpDir("trial-http-m2") } });
  assert.equal((await s.local("PUT", "/api/credentials/anthropic", { apiKey: key })).status, 200);
  const res = await within(s.local("POST", "/api/prompts/refine-ticket/trial", { text: `Be terse. Use ${key} for nothing.` }));
  assert.equal(res.status, 200);
  assert.equal(drafts.length, 1);
  assert.ok(!drafts[0]!.includes(key));
  assert.match(drafts[0]!, /^Be terse\. Use \[redacted\] for nothing\.$/);
  assert.ok(!(await res.text()).includes(key));
});

test("F4D-1 M2: PUT /api/prompts/:role with 20,001 characters → 400, the text is not echoed and no version is saved", async () => {
  const s = await setup2();
  const long = `PROMPTISH-${"x".repeat(19_991)}`;
  assert.equal(long.length, 20_001);
  const res = await s.local("PUT", "/api/prompts/refine-ticket", { text: long });
  assert.equal(res.status, 400);
  assert.ok(!(await res.text()).includes("PROMPTISH"));
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM prompt_version").get() as { n: number }).n, 0);
  // exactly the limit is fine
  assert.equal((await s.local("PUT", "/api/prompts/refine-ticket", { text: "y".repeat(20_000) })).status, 200);
});

test("F4D-1 M2: GET /api/prompts/:role/default → 404 when the role's skill file is missing (ENOENT)", async () => {
  const emptyRoot = tmpDir("no-skills");
  mkdirSync(join(emptyRoot, "skills"), { recursive: true });
  const s = await setup2({ repoRoot: emptyRoot });
  const res = await s.local("GET", "/api/prompts/refine-ticket/default");
  assert.equal(res.status, 404);
  assert.ok(!(await res.text()).includes(emptyRoot));
});

test("F4D-1 M8: the trial result's strings are redacted one by one: quotes, backslashes and JSON escapes cannot break it", async () => {
  const quoted = fakeSecret('test-"quo\\te-');
  // a credential that starts with "n": in JSON text, a newline before its tail reads "\n<tail>"
  const nKey = fakeSecret("nkey-");
  const run = async <T>(_req: RunAgentRequest<T>): Promise<T> => {
    throw new Error(`the agent said ${quoted}\n${nKey.slice(1)} and "${quoted}"`);
  };
  const s = await setup2({ trial: { run, tmpRoot: tmpDir("trial-http-m8") } });
  redactorWith([quoted, nKey]);
  const res = await within(s.local("POST", "/api/prompts/refine-ticket/trial", { text: "draft" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.ok(!body.error.includes(quoted));
  // the text after the newline is not the credential and stays as it was
  assert.equal(body.error, `the agent said [redacted]\n${nKey.slice(1)} and "[redacted]"`);
});

// ---- phase 4d task 6 (4D-1): preferences_changed ----

test("4D-1: preferences_changed is emitted on edit, clear, re-derive, and when a choice or an abandon changes the summary", async () => {
  const s = await setup2();
  const seen: string[] = [];
  s.bus.subscribe((e) => {
    if (e.type === "preferences_changed") seen.push(e.type);
  });
  await s.local("PUT", "/api/preferences", { text: "Mine." });
  await s.local("POST", "/api/preferences/clear");
  await s.local("POST", "/api/preferences/rederive");
  assert.equal(seen.length, 3);
  for (const key of ["K-1", "K-2", "K-3"]) {
    const ids = seedTwoOptions(s, key);
    await s.local("POST", `/api/tickets/${key}/choose`, { solutionId: ids[0], note: "", affectedRepos: ["api", "web"] });
  }
  assert.ok(seen.length >= 4, "a choice that changed the summary is announced");
  const before = seen.length;
  await s.local("POST", "/api/tickets/K-2/abandon", {});
  assert.equal(seen.length, before + 1);
  // a failed edit announces nothing
  await s.local("PUT", "/api/preferences", { text: "x".repeat(2001) });
  assert.equal(seen.length, before + 1);
});

test("phase 4f: a log evidence (a case transcript) is served as text/plain with nosniff, byte for byte — never as HTML", async () => {
  const s = await setup2();
  const r = seedRv(s);
  const text = "$ ./bin/tool.mjs add '<img src=x onerror=alert(1)>'\n(no stdin)\n--- stdout ---\nadded <img src=x onerror=alert(1)>\n--- stderr ---\nexit 0\n";
  writeFileSync(join(r.dir, "1.txt"), text);
  s.db
    .prepare("INSERT INTO review_evidence (report_id, ref_key, ac_id, kind, path, caption, sha256, bytes, created_at) VALUES (?, 'AC-1/9', 'AC-1', 'log', ?, 'transcript', ?, ?, '2026-11-08T00:00:00Z')")
    .run(r.reportIds[0]!, `K-1/${r.seriesId}-1/1.txt`, sha256(text), Buffer.byteLength(text));
  const id = (s.db.prepare("SELECT MAX(id) AS id FROM review_evidence").get() as { id: number }).id;
  const res = await s.local("GET", `/api/tickets/K-1/review/evidence/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal(await res.text(), text);
});

test("read-jira: 202 for a ticket in progress, 409 once it is finished, 404 for an unknown one", async () => {
  const s = setup();
  s.config.jira.baseUrl = "https://jira.example.com";
  ticketIn(s, "awaiting_ac_review");
  assert.equal((await s.json("POST", "/api/tickets/P-1/read-jira")).status, 202);
  assert.equal((await s.json("POST", "/api/tickets/NOPE-1/read-jira")).status, 404);
  assert.equal((await s.json("POST", "/api/tickets/P-1/abandon")).status, 200);
  assert.equal((await s.json("POST", "/api/tickets/P-1/read-jira")).status, 409);
});

test("base-branches: GET lists each repo's default and options; PUT chooses (400 for a branch that is nowhere, 404 for an unknown ticket)", async () => {
  const s = setup();
  s.config.projects.P = { repos: [{ name: "p", path: gitRepo("p"), baseBranch: "main" }] };
  ticketIn(s, "discovered");
  const repoName = s.config.projects.P!.repos[0]!.name;
  const get = await s.json("GET", "/api/tickets/P-1/base-branches");
  assert.equal(get.status, 200);
  const list = ((await get.json()) as { repos: Array<{ name: string; default: string; chosen: string | null; locked: boolean; options: string[] }> }).repos;
  assert.equal(list[0]!.name, repoName);
  assert.equal(list[0]!.chosen, null);
  assert.ok(list[0]!.options.includes(list[0]!.default));
  assert.equal((await s.json("PUT", `/api/tickets/P-1/base-branches/${repoName}`, { branch: "release/9.9.9" })).status, 400);
  const ok = await s.json("PUT", `/api/tickets/P-1/base-branches/${repoName}`, { branch: list[0]!.default });
  assert.equal(ok.status, 200);
  assert.equal((await s.json("GET", "/api/tickets/NOPE-1/base-branches")).status, 404);
});

test("retry: no body is a plain Retry; a note is accepted; bad JSON or a long note is 400", async () => {
  const s = setup();
  assert.equal((await s.json("POST", "/api/tickets/NOPE-1/retry")).status, 404);
  const bad = await s.request("/api/tickets/NOPE-1/retry", { method: "POST", body: "{nope", headers: { host: "127.0.0.1:4317", "content-type": "application/json" } });
  assert.equal(bad.status, 400);
  assert.equal((await s.json("POST", "/api/tickets/NOPE-1/retry", { note: "x".repeat(2001) })).status, 400);
});
