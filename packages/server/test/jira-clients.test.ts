// Phase 4b Task 5: the JIRA implementation (browser or REST API) is chosen on every call from config.jira.source. The
// write and comment jobs are unchanged: an API-mode write or comment goes through the same confirmation, read-back and
// audit as the browser mode. Fake fetch only — never a real JIRA.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { DiscoverResult, FetchedTicket, JiraCommentResult, JiraUpdateResult } from "@slackoff/shared";
import { tmpDir } from "./helpers/tmp.ts";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { readCredentials, writeCredentials } from "../src/credentials/credential-store.ts";
import { EventBus } from "../src/http/events.ts";
import { createApp } from "../src/http/app.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { listJiraWrites, requestJiraWrite } from "../src/jira/jira-write-repo.ts";
import { listComments } from "../src/jira/jira-comment-repo.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { ApiJiraCommenter, ApiJiraSource, ApiJiraUpdater } from "../src/jira/api-jira.ts";
import { jiraClients } from "../src/jira/jira-clients.ts";
import type { JiraUpdater } from "../src/jira/jira-updater.ts";
import type { JiraCommenter } from "../src/jira/jira-commenter.ts";

const BASE = "https://your-company.atlassian.net";
const KEY = "PROJ-1";
const TARGET = "Ready for Human Review";
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** A stateful fake Jira Cloud for one ticket: status transitions and comments. Records each request. */
function fakeJiraCloud() {
  let status = "In Progress";
  const comments: Array<{ id: string; author: { displayName: string }; created: string; body: unknown }> = [];
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    if (u.origin !== BASE) return json({}, 404);
    if (method === "GET" && u.pathname === `/rest/api/3/issue/${KEY}`) {
      return json({ key: KEY, fields: { summary: "T", status: { name: status }, updated: null, description: null, attachment: [], comment: { total: comments.length, comments } } });
    }
    if (method === "GET" && u.pathname === `/rest/api/3/issue/${KEY}/transitions`) return json({ transitions: [{ id: "21", to: { name: TARGET }, fields: {} }] });
    if (method === "POST" && u.pathname === `/rest/api/3/issue/${KEY}/transitions`) {
      status = TARGET;
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && u.pathname === `/rest/api/3/issue/${KEY}/comment`) {
      const body = JSON.parse(String(init?.body)) as { body: unknown };
      comments.push({ id: String(30000 + comments.length), author: { displayName: "Test User" }, created: "2026-11-09T10:00:00.000+0000", body: body.body });
      return json({ id: "1" }, 201);
    }
    return json({}, 404);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** The browser mode's stand-ins: an updater that reports a change, a commenter that posts, a source that reads both back. */
function fakeBrowser() {
  const source = new FakeTicketSource();
  const fetched = (status: string, comments: FetchedTicket["comments"]): FetchedTicket => ({ loginRequired: false, key: KEY, title: "T", description: "", jiraUpdatedAt: null, status, comments, attachments: [] });
  source.tickets[KEY] = fetched("In Progress", []);
  const calls: string[] = [];
  const updater: JiraUpdater = {
    setStatus: async (_k, target): Promise<JiraUpdateResult> => {
      calls.push("setStatus");
      source.tickets[KEY] = fetched(target, (source.tickets[KEY] as FetchedTicket).comments);
      return { loginRequired: false, outcome: "changed", observedStatus: target, detail: "" };
    },
  };
  const commenter: JiraCommenter = {
    postComment: async (_k, text): Promise<JiraCommentResult> => {
      calls.push("postComment");
      const t = source.tickets[KEY] as FetchedTicket;
      source.tickets[KEY] = fetched(t.status ?? "", [...t.comments, { jiraCommentId: String(t.comments.length + 1), author: "Test User", created: "now", body: text }]);
      return { loginRequired: false, outcome: "posted", detail: "" };
    },
  };
  return { source, updater, commenter, calls };
}

function setup(mode: "browser" | "api", o: { creds?: boolean } = {}) {
  const home = tmpDir("jclients", "/private/var/tmp");
  if (o.creds !== false) {
    writeCredentials(home, { jira: { email: "you@example.com", apiToken: `test-token-${randomBytes(12).toString("hex")}`, updatedAt: "2026-11-09T10:00:00.000Z" }, anthropic: null, otlpHeaders: null });
  }
  const db = openDatabase(":memory:");
  const config: Config = loadConfig(home);
  config.jira.baseUrl = BASE;
  config.jira.syncStatus = true;
  config.jira.source = mode;
  const cloud = fakeJiraCloud();
  const deps = { fetch: cloud.fetch, config: () => config.jira, credentials: () => readCredentials(home).jira };
  const browser = fakeBrowser();
  const clients = jiraClients({ config, browser, api: { source: new ApiJiraSource(deps), updater: new ApiJiraUpdater(deps), commenter: new ApiJiraCommenter(deps) } });
  const bus = new EventBus();
  const queue = new JobQueue(1, { onError: () => {}, around: clients.pinned });
  const run = async () => { throw new Error("agent must not run"); };
  const wf = createWorkflow({ db, home, queue, source: clients.source, updater: clients.updater, commenter: clients.commenter, run: run as never, config, bus });
  upsertDiscovered(db, { key: KEY, title: "T", url: `${BASE}/browse/${KEY}`, status: "In Progress" }, false);
  const firstAudit = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_event").get() as { id: number }).id;
  /** the audit after setup: types and the write / comment state they carry (never details, which name the mode) */
  const audits = () =>
    (db.prepare("SELECT type, payload_json FROM audit_event WHERE id > ? ORDER BY id").all(firstAudit) as Array<{ type: string; payload_json: string }>).map((r) => {
      const p = JSON.parse(r.payload_json) as Record<string, unknown>;
      return `${r.type}${typeof p.state === "string" ? `:${p.state}` : ""}${typeof p.decision === "string" ? `:${p.decision}` : ""}`;
    });
  return { home, db, config, cloud, browser, clients, wf, queue, audits, app: () => createApp({ db, home, repoRoot: join(import.meta.dirname, "..", "..", ".."), workflow: wf, bus, config, listBrowsers: async () => { browser.calls.push("listBrowsers"); return []; } }) };
}

test("each call reads jira.source when it starts: a switch to api sends the next discover to the API; the browser call in progress finishes", async () => {
  const config = loadConfig(tmpDir("jclients-switch", "/private/var/tmp"));
  const calls: string[] = [];
  let release!: (r: DiscoverResult) => void;
  const pending = new Promise<DiscoverResult>((r) => (release = r));
  const result = (n: number): DiscoverResult => ({ loginRequired: false, tickets: [], total: n, complete: true });
  const impl = (name: string, discover: () => Promise<DiscoverResult>) => ({
    source: { discover: () => (calls.push(`${name}.discover`), discover()), fetchTicket: async () => { throw new Error("unused"); } },
    updater: { setStatus: async (): Promise<JiraUpdateResult> => (calls.push(`${name}.setStatus`), { loginRequired: false, outcome: "changed", observedStatus: null, detail: "" }) },
    commenter: { postComment: async (): Promise<JiraCommentResult> => (calls.push(`${name}.postComment`), { loginRequired: false, outcome: "posted", detail: "" }) },
  });
  const c = jiraClients({ config, browser: impl("browser", () => pending), api: impl("api", async () => result(2)) });
  const inFlight = c.source.discover();
  config.jira.source = "api";
  assert.equal((await c.source.discover()).total, 2);
  await c.updater.setStatus(KEY, TARGET);
  await c.commenter.postComment(KEY, "hi");
  release(result(1));
  assert.equal((await inFlight).total, 1, "the browser call started before the switch finishes with its own result");
  assert.deepEqual(calls, ["browser.discover", "api.discover", "api.setStatus", "api.postComment"]);
  config.jira.source = "browser";
  await c.updater.setStatus(KEY, TARGET);
  assert.equal(calls.at(-1), "browser.setStatus");
});

test("an API-mode status write: confirmed → ApiJiraUpdater, verified by a read-back, audited exactly like the browser mode", async () => {
  const runFlow = async (mode: "browser" | "api") => {
    const s = setup(mode);
    const { id } = requestJiraWrite(s.db, KEY, TARGET);
    s.wf.confirmJiraWrite(KEY, id, "local");
    await s.queue.idle();
    return { s, write: listJiraWrites(s.db, KEY).at(-1)!, audits: s.audits() };
  };
  const api = await runFlow("api");
  const browser = await runFlow("browser");
  assert.equal(api.write.state, "done", api.write.detail ?? "");
  assert.ok(api.s.cloud.calls.includes(`POST /rest/api/3/issue/${KEY}/transitions`));
  assert.ok(api.s.cloud.calls.filter((c) => c === `GET /rest/api/3/issue/${KEY}`).length >= 2, "the status read before and the read-back after");
  assert.deepEqual(api.s.browser.calls, [], "the browser mode is never used");
  assert.equal(browser.write.state, "done");
  assert.deepEqual(api.audits, browser.audits);
});

test("an API-mode comment: done after the read-back, audited exactly like the browser mode", async () => {
  const runFlow = async (mode: "browser" | "api") => {
    const s = setup(mode);
    s.wf.sendClarification(KEY, "Question for the PO:\n- per item or per cart?", "local");
    await s.queue.idle();
    return { s, comment: listComments(s.db, KEY).at(-1)!, audits: s.audits() };
  };
  const api = await runFlow("api");
  const browser = await runFlow("browser");
  assert.equal(api.comment.state, "done", api.comment.detail ?? "");
  assert.ok(api.s.cloud.calls.includes(`POST /rest/api/3/issue/${KEY}/comment`));
  assert.deepEqual(api.s.browser.calls, []);
  assert.equal(browser.comment.state, "done");
  assert.deepEqual(api.audits, browser.audits);
});

test("API mode without credentials: the confirmed write fails with the not-configured text; nothing falls back to the browser", async () => {
  const s = setup("api", { creds: false });
  const { id } = requestJiraWrite(s.db, KEY, TARGET);
  s.wf.confirmJiraWrite(KEY, id, "local");
  await s.queue.idle();
  const w = listJiraWrites(s.db, KEY).at(-1)!;
  assert.equal(w.state, "failed");
  assert.match(w.detail ?? "", /Set your JIRA email and API token in Settings/);
  assert.deepEqual(s.browser.calls, []);
  assert.deepEqual(s.cloud.calls, []);
});

test("API mode: POST /api/jira/browsers/detect → 409 'the JIRA API mode does not use Chrome'; the browser mode still detects", async () => {
  const s = setup("api");
  const app = s.app();
  const detect = () => app.request("/api/jira/browsers/detect", { method: "POST", headers: { host: "127.0.0.1:4317" } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const res = await detect();
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /the JIRA API mode does not use Chrome/);
  assert.deepEqual(s.browser.calls, []);
  s.config.jira.source = "browser";
  assert.equal((await detect()).status, 200);
  assert.deepEqual(s.browser.calls, ["listBrowsers"]);
});

test("4B-9 (M3): the mode is pinned per job — a switch in the middle of a write job does not move its read-back to the other mode", async () => {
  const s = setup("browser");
  // the browser updater switches Settings to the API mode while it runs
  const orig = s.browser.updater.setStatus;
  s.browser.updater.setStatus = async (k, t) => {
    s.config.jira.source = "api";
    return orig(k, t);
  };
  const { id } = requestJiraWrite(s.db, KEY, TARGET);
  s.wf.confirmJiraWrite(KEY, id, "local");
  await s.queue.idle();
  const w = listJiraWrites(s.db, KEY).at(-1)!;
  assert.equal(w.state, "done", w.detail ?? "");
  assert.deepEqual(s.cloud.calls, [], "the read-back stayed in the browser mode the job started with");
});

// ---- M5 (tasks 4-5 review, folded into task 7): the jobs' JIRA wording follows the mode the job runs in ----

const API_LOGIN = "JIRA rejected the API token — update it in Settings → JIRA";

/** Both modes are stubs returning what the test says; the workflow gets the clients' mode (pinned per job). */
function wordingSetup(mode: "browser" | "api", r: { update?: JiraUpdateResult; comment?: JiraCommentResult; discover?: DiscoverResult; fetchLogin?: boolean }) {
  const home = tmpDir("jclients-wording", "/private/var/tmp");
  const db = openDatabase(":memory:");
  const config: Config = loadConfig(home);
  config.jira.baseUrl = BASE;
  config.jira.syncStatus = true;
  config.jira.source = mode;
  const fetched: FetchedTicket = { loginRequired: false, key: KEY, title: "T", description: "", jiraUpdatedAt: null, status: "In Progress", comments: [], attachments: [] };
  const impl = {
    source: {
      discover: async (): Promise<DiscoverResult> => r.discover ?? { loginRequired: false, tickets: [], total: 0, complete: true },
      fetchTicket: async (): Promise<FetchedTicket> => (r.fetchLogin ? { ...fetched, loginRequired: true } : fetched),
    },
    updater: { setStatus: async (): Promise<JiraUpdateResult> => r.update ?? { loginRequired: false, outcome: "changed", observedStatus: TARGET, detail: "" } },
    commenter: { postComment: async (): Promise<JiraCommentResult> => r.comment ?? { loginRequired: false, outcome: "posted", detail: "" } },
  };
  const clients = jiraClients({ config, browser: impl, api: impl });
  const bus = new EventBus();
  const errors: string[] = [];
  bus.subscribe((e) => {
    if (e.type === "source_error") errors.push(e.message);
  });
  const queue = new JobQueue(1, { onError: () => {}, around: clients.pinned });
  const run = async () => { throw new Error("agent must not run"); };
  const wf = createWorkflow({ db, home, queue, source: clients.source, updater: clients.updater, commenter: clients.commenter, jiraMode: clients.mode, run: run as never, config, bus });
  upsertDiscovered(db, { key: KEY, title: "T", url: `${BASE}/browse/${KEY}`, status: "In Progress" }, false);
  return { db, wf, queue, errors };
}

test("M5: a JIRA login failure in the API mode says the API token was rejected (Settings → JIRA), never 'log in to JIRA in Chrome'", async () => {
  for (const mode of ["api", "browser"] as const) {
    const login = { loginRequired: true, outcome: "failed", observedStatus: null, detail: "" } as const;
    const w = wordingSetup(mode, { update: login });
    const { id } = requestJiraWrite(w.db, KEY, TARGET);
    w.wf.confirmJiraWrite(KEY, id, "local");
    await w.queue.idle();
    const write = listJiraWrites(w.db, KEY).at(-1)!;
    assert.equal(write.state, "failed");
    if (mode === "api") assert.equal(write.detail, API_LOGIN);
    else assert.match(write.detail ?? "", /in Chrome/);

    const c = wordingSetup(mode, { comment: { loginRequired: true, outcome: "failed", detail: "" } });
    c.wf.sendClarification(KEY, "Question for the PO: per item or per cart?", "local");
    await c.queue.idle();
    const comment = listComments(c.db, KEY).at(-1)!;
    assert.equal(comment.state, "failed");
    if (mode === "api") assert.equal(comment.detail, API_LOGIN);
    else assert.match(comment.detail ?? "", /in Chrome/);

    const d = wordingSetup(mode, { discover: { loginRequired: true, tickets: [], total: 0, complete: false } });
    d.wf.discover();
    await d.queue.idle();
    assert.equal(d.errors.length, 1);
    if (mode === "api") assert.equal(d.errors[0], API_LOGIN);
    else assert.match(d.errors[0]!, /in Chrome/);

    const f = wordingSetup(mode, { fetchLogin: true });
    f.wf.refine(KEY, "local");
    await f.queue.idle();
    const blocked = f.db.prepare("SELECT blocked_reason FROM ticket WHERE key = ?").get(KEY) as { blocked_reason: string | null };
    if (mode === "api") assert.equal(blocked.blocked_reason, API_LOGIN);
    else assert.match(blocked.blocked_reason ?? "", /in Chrome/);
  }
});

test("M5: an API-mode write or comment that JIRA refuses is reported as JIRA's answer, not as 'the browser agent could not …'", async () => {
  const w = wordingSetup("api", { update: { loginRequired: false, outcome: "failed", observedStatus: null, detail: "ambiguous transition" } });
  const { id } = requestJiraWrite(w.db, KEY, TARGET);
  w.wf.confirmJiraWrite(KEY, id, "local");
  await w.queue.idle();
  const write = listJiraWrites(w.db, KEY).at(-1)!;
  assert.equal(write.detail, "JIRA did not change the status: ambiguous transition");

  const c = wordingSetup("api", { comment: { loginRequired: false, outcome: "failed", detail: "JIRA refused (no permission?)" } });
  c.wf.sendClarification(KEY, "Question for the PO: per item or per cart?", "local");
  await c.queue.idle();
  assert.equal(listComments(c.db, KEY).at(-1)!.detail, "JIRA did not take the comment: JIRA refused (no permission?)");

  // the browser mode keeps its wording
  const b = wordingSetup("browser", { update: { loginRequired: false, outcome: "failed", observedStatus: null, detail: "no button" } });
  const r = requestJiraWrite(b.db, KEY, TARGET);
  b.wf.confirmJiraWrite(KEY, r.id, "local");
  await b.queue.idle();
  assert.equal(listJiraWrites(b.db, KEY).at(-1)!.detail, "The browser agent could not change the status: no button");
});

// ---- final fix pass (ruling F4B-4): the mode a JIRA read or write ran in is recorded on its row ----

import { getSnapshot, listSnapshots } from "../src/snapshots/snapshot-store.ts";

test("F4B-4: the confirmed write, the comment and the snapshot record the JIRA mode they ran in (browser or api)", async () => {
  for (const mode of ["api", "browser"] as const) {
    const w = wordingSetup(mode, {});
    const { id } = requestJiraWrite(w.db, KEY, TARGET);
    assert.equal(listJiraWrites(w.db, KEY).at(-1)!.jiraSource, null, "a pending write has run in no mode yet");
    w.wf.confirmJiraWrite(KEY, id, "local");
    await w.queue.idle();
    const write = listJiraWrites(w.db, KEY).at(-1)!;
    assert.equal(write.jiraSource, mode);

    w.wf.sendClarification(KEY, "Question for the PO: per item or per cart?", "local");
    await w.queue.idle();
    assert.equal(listComments(w.db, KEY).at(-1)!.jiraSource, mode);

    w.wf.refine(KEY, "local");
    await w.queue.idle();
    const snaps = listSnapshots(w.db, KEY);
    assert.ok(snaps.length > 0);
    assert.equal(snaps[0]!.jiraSource, mode);
    assert.equal(getSnapshot(w.db, snaps[0]!.id)!.jiraSource, mode);
  }
});

test("F4B-4: rows from before the migration read as no mode (null); the columns refuse anything but browser / api", () => {
  const db = openDatabase(":memory:");
  upsertDiscovered(db, { key: KEY, title: "T", url: `${BASE}/browse/${KEY}`, status: "In Progress" }, false);
  db.prepare("INSERT INTO jira_write (ticket_key, target_status, state, requested_at) VALUES (?, 'X', 'pending', 'now')").run(KEY);
  assert.equal(listJiraWrites(db, KEY)[0]!.jiraSource, null);
  assert.throws(() => db.prepare("INSERT INTO jira_write (ticket_key, target_status, state, requested_at, jira_source) VALUES (?, 'X', 'pending', 'now', 'chrome')").run(KEY), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO jira_comment (ticket_key, purpose, text, state, requested_at, jira_source) VALUES (?, 'clarification', 't', 'pending', 'now', 'x')").run(KEY), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO ticket_snapshot (ticket_key, fetched_at, title, content_hash, jira_source) VALUES (?, 'now', 't', 'h', 'x')").run(KEY), /CHECK/);
});

// ---- final fix pass (F4B-5, M-4): what discovery echoes or stores from JIRA is bounded ----

test("F4B-5 (M-4): an invalid key is echoed at most 40 characters long; a title is stored at most 4 KB long", async () => {
  const longKey = `BAD-${"x".repeat(10_000)}`;
  const title = "T".repeat(10_000);
  const d = wordingSetup("api", {
    discover: { loginRequired: false, complete: true, total: 2, tickets: [
      { key: longKey, title: "t", url: `${BASE}/browse/x`, status: "Open" },
      { key: "PROJ-77", title, url: `${BASE}/browse/PROJ-77`, status: "Open" },
    ] },
  });
  d.wf.discover();
  await d.queue.idle();
  const msg = d.errors.find((e) => e.startsWith("Skipped"))!;
  assert.ok(msg.includes(JSON.stringify(longKey.slice(0, 40))), msg.slice(0, 200));
  assert.ok(msg.length < 200, `echoed ${msg.length} characters`);
  const row = d.db.prepare("SELECT title FROM ticket WHERE key = 'PROJ-77'").get() as { title: string };
  assert.equal(row.title.length, 4096);
  assert.equal(row.title, title.slice(0, 4096));
});
