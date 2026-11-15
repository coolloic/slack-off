// Phase 4b Task 4 (rulings B-6, B-7, B-8): the JIRA API mode against a fake fetch that records every request. Never a
// real JIRA. Fake credentials only (written through the Task 2 credential store).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers/tmp.ts";
import { parseConfig } from "../src/config.ts";
import { readCredentials, writeCredentials } from "../src/credentials/credential-store.ts";
import { ApiJiraCommenter, ApiJiraSource, ApiJiraUpdater, type ApiJiraDeps } from "../src/jira/api-jira.ts";
import { adfToText } from "../src/jira/adf.ts";
import { normalizeCommentText } from "../src/jira/jira-commenter.ts";
import { isSourceError, JiraLoginRequiredError, JiraNotConfiguredError } from "../src/jira/ticket-source.ts";

const BASE = "https://your-company.atlassian.net";
const EMAIL = "you@example.com";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "jira-rest", name), "utf8"));

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string | undefined;
}
type Route = (c: Call) => Response | Promise<Response>;

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

function fakeFetch(route: Route) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: Call = { url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, redirect: init?.redirect };
    calls.push(call);
    return route(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A search over `n` generated open tickets (PROJ-1..n), paged by nextPageToken = the next start index. */
function searchOf(n: number, o: { failPage?: number; dup?: boolean } = {}) {
  let page = 0;
  return (c: Call): Response | null => {
    if (!(c.method === "POST" && c.url === `${BASE}/rest/api/3/search/jql`)) return null;
    page++;
    if (o.failPage === page) return json({ errorMessages: ["boom"] }, 500);
    const body = c.body as { maxResults: number; nextPageToken?: string };
    const start = body.nextPageToken === undefined ? 0 : Number(body.nextPageToken);
    const end = Math.min(n, start + body.maxResults);
    const issues = Array.from({ length: end - start }, (_, i) => {
      const k = o.dup && page === 2 && i === 0 ? 1 : start + i + 1;
      return { id: String(10000 + k), key: `PROJ-${k}`, fields: { summary: `Ticket ${k}`, status: { name: "Ready for Dev" }, updated: "2026-11-08T09:00:00.000+0000" } };
    });
    return json({ issues, ...(end < n ? { nextPageToken: String(end) } : {}), isLast: end >= n });
  };
}

/** The fixture ticket PROJ-1: issue, a second comments page, attachments (B-7 redirects), transitions. */
function ticketRoutes(o: { status?: { name: string }; transitions?: unknown[]; afterPost?: string } = {}) {
  let status = o.status ?? { name: "Ready for Dev" };
  return (c: Call): Response | null => {
    const u = new URL(c.url);
    if (u.origin === "https://media.example.net") return u.pathname === "/x" ? new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }) : null;
    if (u.origin !== BASE) return null;
    const p = u.pathname;
    if (c.method === "GET" && p === "/rest/api/3/issue/PROJ-1") {
      const issue = fixture("issue-PROJ-1.json") as { fields: Record<string, unknown> };
      issue.fields.status = status;
      return json(issue);
    }
    if (c.method === "GET" && p === "/rest/api/3/issue/PROJ-1/comment" && u.searchParams.get("startAt") === "20") return json(fixture("comments-PROJ-1-startAt-20.json"));
    if (c.method === "GET" && p === "/rest/api/3/attachment/content/30001") return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    if (c.method === "GET" && p === "/rest/api/3/attachment/content/30004") return new Response(null, { status: 302, headers: { location: "http://media.example.net/x" } });
    if (c.method === "GET" && p === "/rest/api/3/attachment/content/30005") return new Response(null, { status: 302, headers: { location: "https://media.example.net/x" } });
    if (c.method === "GET" && p === "/rest/api/3/issue/PROJ-1/transitions") return json({ transitions: o.transitions ?? (fixture("transitions-PROJ-1.json") as { transitions: unknown[] }).transitions });
    if (c.method === "POST" && p === "/rest/api/3/issue/PROJ-1/transitions") {
      status = { name: o.afterPost ?? "Ready for Human Review" };
      return new Response(null, { status: 204 });
    }
    if (c.method === "POST" && p === "/rest/api/3/issue/PROJ-1/comment") return json({ id: "29999" }, 201);
    return null;
  };
}

const route = (...rs: Array<(c: Call) => Response | null>): Route => (c) => {
  for (const r of rs) {
    const res = r(c);
    if (res !== null) return res;
  }
  return json({ errorMessages: [`unexpected ${c.method} ${c.url}`] }, 404);
};

function setup(r: Route, o: { discoverLimit?: number; creds?: boolean; baseUrl?: string } = {}) {
  const home = tmpDir("apijira", "/private/var/tmp");
  const apiToken = `test-token-${randomBytes(12).toString("hex")}`;
  if (o.creds !== false) writeCredentials(home, { jira: { email: EMAIL, apiToken, updatedAt: "2026-11-09T10:00:00.000Z" }, anthropic: null, otlpHeaders: null });
  const cfg = parseConfig({ jira: { baseUrl: o.baseUrl ?? BASE, discoverLimit: o.discoverLimit ?? 100, source: "api" } }).jira;
  const f = fakeFetch(r);
  const sleeps: number[] = [];
  const deps: ApiJiraDeps = {
    fetch: f.fetch,
    config: () => cfg,
    credentials: () => readCredentials(home).jira,
    sleep: async (ms) => void sleeps.push(ms),
  };
  const basic = Buffer.from(`${EMAIL}:${apiToken}`).toString("base64");
  return { home, apiToken, basic, cfg, deps, calls: f.calls, sleeps, source: new ApiJiraSource(deps), updater: new ApiJiraUpdater(deps), commenter: new ApiJiraCommenter(deps) };
}

// ---------------------------------------------------------------- discovery

test("discover: two pages with discoverLimit 150 → both read, complete, total = rows; urls are <base>/browse/<key>", async () => {
  const s = setup(route(searchOf(130)), { discoverLimit: 150 });
  const r = await s.source.discover();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls.map((c) => (c.body as { maxResults: number }).maxResults), [100, 50]);
  assert.equal((s.calls[0]!.body as { jql: string }).jql, "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
  assert.deepEqual((s.calls[0]!.body as { fields: string[] }).fields, ["summary", "status", "updated"]);
  assert.equal((s.calls[1]!.body as { nextPageToken: string }).nextPageToken, "100");
  assert.deepEqual({ n: r.tickets.length, total: r.total, complete: r.complete, loginRequired: r.loginRequired }, { n: 130, total: 130, complete: true, loginRequired: false });
  assert.deepEqual(r.tickets[0], { key: "PROJ-1", title: "Ticket 1", url: `${BASE}/browse/PROJ-1`, status: "Ready for Dev" });
});

test("discover: discoverLimit 50 → one request with maxResults 50, complete false", async () => {
  const s = setup(route(searchOf(130)), { discoverLimit: 50 });
  const r = await s.source.discover();
  assert.equal(s.calls.length, 1);
  assert.equal((s.calls[0]!.body as { maxResults: number }).maxResults, 50);
  assert.deepEqual({ n: r.tickets.length, total: r.total, complete: r.complete }, { n: 50, total: 50, complete: false });
});

test("discover: a failing second page keeps the first page's tickets, complete false; a failing first page throws", async () => {
  const s = setup(route(searchOf(130, { failPage: 2 })), { discoverLimit: 150 });
  const r = await s.source.discover();
  assert.deepEqual({ n: r.tickets.length, complete: r.complete }, { n: 100, complete: false });
  const f = setup(route(searchOf(130, { failPage: 1 })), { discoverLimit: 150 });
  await assert.rejects(f.source.discover(), /JIRA answered 500/);
});

test("discover: a key seen twice is kept once; isLast false without a nextPageToken is an incomplete read", async () => {
  const s = setup(route(searchOf(130, { dup: true })), { discoverLimit: 150 });
  const r = await s.source.discover();
  assert.equal(new Set(r.tickets.map((t) => t.key)).size, r.tickets.length);
  assert.equal(r.tickets.filter((t) => t.key === "PROJ-1").length, 1);
  const noToken = setup(route((c) => (c.url.endsWith("/search/jql") ? json({ issues: (fixture("search-page-1.json") as { issues: unknown[] }).issues, isLast: false }) : null)));
  const r2 = await noToken.source.discover();
  assert.deepEqual({ n: r2.tickets.length, complete: r2.complete }, { n: 2, complete: false });
  const last = setup(route((c) => (c.url.endsWith("/search/jql") ? json(fixture("search-page-2.json")) : null)));
  assert.equal((await last.source.discover()).complete, true);
});

// ---------------------------------------------------------------- ticket read

test("fetchTicket: fields, ADF description, 25 comments in order (20 inline + a page of 5), attachments per B-7", async () => {
  const s = setup(route(ticketRoutes()));
  const t = await s.source.fetchTicket("PROJ-1");
  assert.equal(t.loginRequired, false);
  assert.equal(t.key, "PROJ-1");
  assert.equal(t.title, "Checkout shows the wrong total");
  assert.equal(t.status, "Ready for Dev");
  assert.equal(t.jiraUpdatedAt, "2026-11-08T09:00:00.000+0000");
  assert.match(t.description, /^Problem\nThe total ignores the discount\./);
  assert.equal(t.comments.length, 25);
  assert.deepEqual(t.comments.map((c) => c.jiraCommentId), Array.from({ length: 25 }, (_, i) => String(20001 + i)));
  assert.deepEqual(t.comments[0], { jiraCommentId: "20001", author: "Test User 1", created: "2026-11-02T10:01:00.000+0000", body: "Comment number 1" });
  const issueCall = s.calls.find((c) => new URL(c.url).pathname === "/rest/api/3/issue/PROJ-1")!;
  const q = new URL(issueCall.url).searchParams;
  assert.equal(q.get("fields"), "summary,description,status,updated,attachment,comment");
  assert.equal(q.get("expand"), "renderedFields");
  const att = new Map(t.attachments.map((a) => [a.filename, a]));
  // the image named by the description's media node is the inline image, downloaded
  assert.equal(att.get("screenshot.png")!.kind, "inline_image");
  assert.equal(att.get("screenshot.png")!.base64, PNG.toString("base64"));
  assert.equal(att.get("screenshot.png")!.url, `${BASE}/rest/api/3/attachment/content/30001`);
  // over 5 MB and not an image: metadata only, never requested
  assert.equal(att.get("huge.png")!.base64, null);
  assert.equal(att.get("notes.pdf")!.base64, null);
  assert.ok(!s.calls.some((c) => /\/content\/3000[23]$/.test(c.url)));
  // a redirect to http:// is not followed
  assert.equal(att.get("plain-http.png")!.base64, null);
  assert.ok(!s.calls.some((c) => c.url.startsWith("http://")));
  // a redirect to https:// is followed once, without Authorization; the attachment's own content field is never used
  assert.equal(att.get("elsewhere.png")!.base64, PNG.toString("base64"));
  const media = s.calls.filter((c) => c.url === "https://media.example.net/x");
  assert.equal(media.length, 1);
  assert.equal(media[0]!.headers.authorization, undefined);
  assert.ok(!s.calls.some((c) => c.url.includes("elsewhere.example.net")), "neither self nor the content field is requested");
});

test("every request goes to <base>/rest/api/3/ with Basic auth and redirect manual (but the one followed attachment redirect)", async () => {
  const s = setup(route(searchOf(3), ticketRoutes()));
  await s.source.discover();
  await s.source.fetchTicket("PROJ-1");
  await s.updater.setStatus("PROJ-1", "Ready for Human Review");
  await s.commenter.postComment("PROJ-1", "Hello");
  for (const c of s.calls) {
    assert.equal(c.redirect, "manual", c.url);
    if (c.url === "https://media.example.net/x") continue;
    assert.ok(c.url.startsWith(`${BASE}/rest/api/3/`), c.url);
    assert.equal(c.headers.authorization, `Basic ${s.basic}`, c.url);
  }
});

test("a key that is not a ticket key is refused before any request; path segments are encoded", async () => {
  const s = setup(route(ticketRoutes()));
  for (const bad of ["PROJ-1/../x", "../PROJ-1", "PROJ-1?x=1", ""]) {
    await assert.rejects(s.source.fetchTicket(bad), /Invalid ticket key/);
    await assert.rejects(s.updater.setStatus(bad, "Done"), /Invalid ticket key/);
    await assert.rejects(s.commenter.postComment(bad, "hi"), /Invalid ticket key/);
  }
  assert.equal(s.calls.length, 0);
});

// ---------------------------------------------------------------- errors

test("401 → JiraLoginRequiredError (a source error) whose message never carries the token, even when the body echoes it", async () => {
  let basic = "";
  const s = setup(() => json({ message: `bad credentials: Authorization: Basic ${basic}` }, 401));
  basic = s.basic;
  for (const p of [s.source.discover(), s.source.fetchTicket("PROJ-1"), s.updater.setStatus("PROJ-1", "Done"), s.commenter.postComment("PROJ-1", "hi")]) {
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof JiraLoginRequiredError && isSourceError(e));
      assert.equal(e.message, "The JIRA API token was rejected — update it in Settings → JIRA");
      return true;
    });
  }
});

test("any other error status: the message is redacted (token, Basic header, email) before it is cut short", async () => {
  let echo = "";
  // the Basic value starts at character 260 of the message, across the 300-character cut: cutting first would leave its
  // first 40 characters behind (the first 20 are base64 of the 15-character email alone, itself redacted; the next 20
  // encode the token)
  const head = `JIRA answered 500 for GET /rest/api/3/issue/PROJ-1: {"errorMessages":["`;
  const pad = "x".repeat(260 - head.length - " Authorization: Basic ".length);
  const s = setup(() => json({ errorMessages: [`${pad} Authorization: Basic ${echo} token=${echo}`] }, 500));
  echo = `${s.basic} ${s.apiToken} ${EMAIL}`;
  await assert.rejects(s.source.fetchTicket("PROJ-1"), (e: unknown) => {
    const m = (e as Error).message;
    assert.match(m, /JIRA answered 500/);
    for (const v of [s.apiToken, s.basic, s.basic.slice(0, 12), s.basic.slice(20, 36), s.apiToken.slice(0, 12), EMAIL]) assert.ok(!m.includes(v), `leaked ${v.slice(0, 6)}…: ${m}`);
    return true;
  });
});

test("no credentials or no URL → JiraNotConfiguredError, nothing requested", async () => {
  const noCreds = setup(route(ticketRoutes()), { creds: false });
  await assert.rejects(noCreds.source.discover(), JiraNotConfiguredError);
  await assert.rejects(noCreds.updater.setStatus("PROJ-1", "Done"), JiraNotConfiguredError);
  await assert.rejects(noCreds.commenter.postComment("PROJ-1", "hi"), JiraNotConfiguredError);
  const noUrl = setup(route(ticketRoutes()), { baseUrl: "" });
  await assert.rejects(noUrl.source.fetchTicket("PROJ-1"), JiraNotConfiguredError);
  assert.equal(noCreds.calls.length + noUrl.calls.length, 0);
});

test("a 3xx from the API is never followed: 'JIRA answered with a redirect; check the JIRA URL'", async () => {
  const s = setup(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.net/login" } }));
  await assert.rejects(s.source.fetchTicket("PROJ-1"), /JIRA answered with a redirect; check the JIRA URL/);
  assert.equal(s.calls.length, 1);
});

test("429: a read is retried once after Retry-After (at most 30 s); a write is not retried (failed)", async () => {
  let n = 0;
  const s = setup(route((c) => (c.url.endsWith("/search/jql") && n++ === 0 ? json({}, 429, { "retry-after": "1" }) : null), searchOf(3), (c) => (c.url.endsWith("/comment") && c.method === "POST" ? json({}, 429, { "retry-after": "1" }) : null)));
  const r = await s.source.discover();
  assert.equal(r.tickets.length, 3);
  assert.deepEqual(s.sleeps, [1000]);
  const posted = await s.commenter.postComment("PROJ-1", "hi");
  assert.equal(posted.outcome, "failed");
  assert.equal(s.calls.filter((c) => c.method === "POST" && c.url.endsWith("/comment")).length, 1);
  const tooLong = setup(() => json({}, 429, { "retry-after": "120" }));
  await assert.rejects(tooLong.source.fetchTicket("PROJ-1"), /rate limit/i);
  assert.equal(tooLong.calls.length, 1);
});

// ---------------------------------------------------------------- status transition

test("setStatus: already in the status (ignoring case) → already_in_status, no transition read or POST", async () => {
  const s = setup(route(ticketRoutes({ status: { name: "ready for human review" } })));
  const r = await s.updater.setStatus("PROJ-1", "Ready for Human Review");
  assert.deepEqual(r, { loginRequired: false, outcome: "already_in_status", observedStatus: "ready for human review", detail: "" });
  assert.ok(!s.calls.some((c) => c.url.includes("/transitions")));
});

test("setStatus: one matching transition → POST it, then read the status back into observedStatus", async () => {
  const s = setup(route(ticketRoutes()));
  const r = await s.updater.setStatus("PROJ-1", "ready for human review");
  assert.equal(r.outcome, "changed");
  assert.equal(r.observedStatus, "Ready for Human Review");
  const post = s.calls.find((c) => c.method === "POST")!;
  assert.deepEqual(post.body, { transition: { id: "21" } });
  assert.equal(new URL(s.calls.find((c) => c.url.includes("/transitions") && c.method === "GET")!.url).searchParams.get("expand"), "transitions.fields");
});

test("setStatus: no transition to the target → transition_unavailable (never a similar one); two → failed (ambiguous); required fields → failed without POST", async () => {
  const none = setup(route(ticketRoutes()));
  assert.equal((await none.updater.setStatus("PROJ-1", "Ready for Review")).outcome, "transition_unavailable");
  const two = setup(route(ticketRoutes({ transitions: [{ id: "1", to: { name: "Review" }, fields: {} }, { id: "2", to: { name: "review" }, fields: {} }] })));
  const amb = await two.updater.setStatus("PROJ-1", "Review");
  assert.equal(amb.outcome, "failed");
  assert.match(amb.detail, /ambiguous transition/);
  const req = setup(route(ticketRoutes()));
  const done = await req.updater.setStatus("PROJ-1", "Done");
  assert.equal(done.outcome, "failed");
  assert.match(done.detail, /required field/);
  for (const s of [none, two, req]) assert.ok(!s.calls.some((c) => c.method === "POST"));
});

// ---------------------------------------------------------------- comment

test("postComment: validates the text, posts it as ADF that reads back equal under normalizeCommentText", async () => {
  const s = setup(route(ticketRoutes()));
  const text = "Question for the PO:\n- is the discount per item?\n\nThanks";
  const r = await s.commenter.postComment("PROJ-1", text);
  assert.deepEqual(r, { loginRequired: false, outcome: "posted", detail: "" });
  const post = s.calls.find((c) => c.method === "POST")!;
  assert.equal(normalizeCommentText(adfToText((post.body as { body: unknown }).body)), normalizeCommentText(text));
  await assert.rejects(s.commenter.postComment("PROJ-1", "   "), /The comment is empty/);
  assert.equal(s.calls.filter((c) => c.method === "POST").length, 1);
});

// ---------------------------------------------------------------- no leak through the platform's sinks

import { openDatabase } from "../src/db/database.ts";
import { loadConfig } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { createApp } from "../src/http/app.ts";
import { upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { noUpdater } from "./fixtures/no-updater.ts";

test("a JIRA that echoes the Authorization header (401 and 500 bodies) leaks it to no blocked reason, SSE event, HTTP response or log line", async () => {
  let echo = "";
  const s = setup((c) => json({ message: `you sent Authorization: ${c.headers.authorization ?? ""} (${echo})` }, c.url.endsWith("/search/jql") ? 401 : 500));
  echo = `${s.apiToken} ${s.basic}`;
  const db = openDatabase(join(s.home, "slackoff.db"));
  const config = loadConfig(s.home);
  config.jira.baseUrl = BASE;
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const queue = new JobQueue(1);
  const run = async () => { throw new Error("agent must not run"); };
  const workflow = createWorkflow({ updater: noUpdater, db, home: s.home, queue, source: s.source, run: run as never, config, bus });
  const app = createApp({ db, home: s.home, repoRoot: join(import.meta.dirname, "..", "..", ".."), workflow, bus, config });
  const local = (method: string, path: string) => app.request(path, { method, headers: { host: "127.0.0.1:4317" } }, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    upsertDiscovered(db, { key: "PROJ-1", title: "T", url: `${BASE}/browse/PROJ-1`, status: "Ready for Dev" }, false);
    assert.equal((await local("POST", "/api/discover")).status, 202);
    assert.equal((await local("POST", "/api/tickets/PROJ-1/refine")).status, 202);
    await queue.idle();
    const ticket = await (await local("GET", "/api/tickets/PROJ-1")).text();
    const list = await (await local("GET", "/api/tickets")).text();
    const audit = await (await local("GET", "/api/audit")).text();
    assert.match(ticket, /"state":"blocked"/);
    const everything = [ticket, list, audit, JSON.stringify(events), logged.join("\n")].join("\n");
    for (const v of [s.apiToken, s.basic, s.basic.slice(20, 36)]) assert.ok(!everything.includes(v), `leaked ${v.slice(0, 6)}…`);
    assert.ok(events.some((e) => e.type === "source_error" && /API token was rejected/.test(e.message)));
  } finally {
    console.error = orig;
    db.close();
  }
});

// ---------------------------------------------------------------- fix round 1 (rulings 4B-8, 4B-9)

import { restUrl } from "../src/jira/api-jira.ts";
import { parseCommentsMarker } from "../src/snapshots/snapshot-store.ts";

/** A body of `total` bytes produced lazily; `pulled` is how many bytes the reader asked for. */
function lazyBody(total: number, chunk = 64 * 1024) {
  const counter = { pulled: 0 };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      counter.pulled = sent;
      c.enqueue(new Uint8Array(n).fill(0x78));
    },
  });
  return { stream, counter };
}
const MB = 1024 * 1024;

test("4B-8 (I1): pages that add no new key stop discovery as incomplete; the page count is capped at ceil(limit/100)+5", async () => {
  let n = 0;
  const empty = setup(route((c) => (c.url.endsWith("/search/jql") ? json({ issues: [], nextPageToken: `t${n++}`, isLast: false }) : null)));
  const r = await empty.source.discover();
  assert.deepEqual({ calls: empty.calls.length, n: r.tickets.length, complete: r.complete }, { calls: 1, n: 0, complete: false });
  // one new key per page, a fresh token each time: at most ceil(500/100)+5 = 10 pages
  let k = 0;
  const trickle = setup(route((c) => (c.url.endsWith("/search/jql") ? json({ issues: [{ key: `PROJ-${++k}`, fields: { summary: "s", status: { name: "Open" } } }], nextPageToken: `t${k}`, isLast: false }) : null)), { discoverLimit: 500 });
  const r2 = await trickle.source.discover();
  assert.equal(trickle.calls.length, 10);
  assert.equal(r2.complete, false);
});

test("4B-8 (I2): at most 1000 comments are read; the rest are marked not loaded (the snapshot's marker)", async () => {
  let pages = 0;
  const s = setup(route((c) => {
    const u = new URL(c.url);
    if (u.pathname === "/rest/api/3/issue/PROJ-1") return json({ key: "PROJ-1", fields: { summary: "T", status: { name: "Open" }, description: null, attachment: [], comment: { total: 1e9, comments: [] } } });
    if (u.pathname === "/rest/api/3/issue/PROJ-1/comment") {
      pages++;
      const start = Number(u.searchParams.get("startAt"));
      return json({ total: 1e9, comments: Array.from({ length: 100 }, (_, i) => ({ id: String(start + i + 1), author: { displayName: "A" }, created: "c", body: "b" })) });
    }
    return null;
  }));
  const t = await s.source.fetchTicket("PROJ-1");
  assert.equal(t.comments.length, 1000);
  assert.equal(pages, 10);
  assert.equal(parseCommentsMarker(t.description).notLoaded, 1e9 - 1000);
});

test("4B-8 (I3): an attachment over 5 MB is cut off on the stream (whatever its content-length says) or not read when declared too big", async () => {
  const lying = lazyBody(200 * MB);
  const declared = lazyBody(6 * MB);
  const s = setup(route((c) => {
    if (new URL(c.url).pathname === "/rest/api/3/issue/PROJ-1") {
      return json({ key: "PROJ-1", fields: { summary: "T", status: { name: "Open" }, description: null, comment: { total: 0, comments: [] }, attachment: [
        { id: "1", filename: "lying.png", mimeType: "image/png", size: 100 },
        { id: "2", filename: "declared.png", mimeType: "image/png", size: 100 },
      ] } });
    }
    if (c.url.endsWith("/attachment/content/1")) return new Response(lying.stream, { status: 200, headers: { "content-length": "100" } });
    if (c.url.endsWith("/attachment/content/2")) return new Response(declared.stream, { status: 200, headers: { "content-length": String(6 * MB) } });
    return null;
  }));
  const t = await s.source.fetchTicket("PROJ-1");
  assert.deepEqual(t.attachments.map((a) => a.base64), [null, null]);
  assert.ok(lying.counter.pulled <= 5 * MB + 128 * 1024, `read ${lying.counter.pulled} bytes`);
  assert.ok(declared.counter.pulled <= 128 * 1024, `read ${declared.counter.pulled} bytes of a declared 6 MB body`);
});

test("4B-8 (I3): a JSON answer over 10 MB and an error body over 64 KB are not read in full", async () => {
  const big = lazyBody(40 * MB);
  const s = setup(() => new Response(big.stream, { status: 200, headers: { "content-type": "application/json" } }));
  await assert.rejects(s.source.fetchTicket("PROJ-1"), /larger than 10 MB/);
  assert.ok(big.counter.pulled <= 10 * MB + 128 * 1024, `read ${big.counter.pulled}`);
  const err = lazyBody(40 * MB);
  const e = setup(() => new Response(err.stream, { status: 500 }));
  await assert.rejects(e.source.fetchTicket("PROJ-1"), /JIRA answered 500/);
  assert.ok(err.counter.pulled <= 64 * 1024 + 128 * 1024, `read ${err.counter.pulled}`);
});

test("4B-9 (M6): an attachment redirect to an IP literal, a private or local host is not followed", async () => {
  for (const loc of ["https://10.0.0.1/x", "https://192.168.1.2/x", "https://127.0.0.1/x", "https://[::1]/x", "https://93.184.216.34/x", "https://localhost/x", "https://intranet/x", "https://printer.local/x"]) {
    const s = setup(route((c) => {
      if (new URL(c.url).pathname === "/rest/api/3/issue/PROJ-1") {
        return json({ key: "PROJ-1", fields: { summary: "T", status: { name: "Open" }, description: null, comment: { total: 0, comments: [] }, attachment: [{ id: "1", filename: "a.png", mimeType: "image/png", size: 10 }] } });
      }
      if (c.url.endsWith("/attachment/content/1")) return new Response(null, { status: 302, headers: { location: loc } });
      return null;
    }));
    const t = await s.source.fetchTicket("PROJ-1");
    assert.equal(t.attachments[0]!.base64, null, loc);
    assert.equal(s.calls.length, 2, `${loc}: not requested`);
  }
});

test("4B-9 (M4): restUrl keeps every request under <base>/rest/api/3/ (no .., no other origin)", () => {
  assert.equal(restUrl(BASE, "/issue/PROJ-1", { fields: "status" }), `${BASE}/rest/api/3/issue/PROJ-1?fields=status`);
  for (const bad of ["/../../x", "/issue/../../../admin", "/%2e%2e/%2e%2e/x", "@elsewhere.example.net/x", "/../../../rest/api/2/x"]) {
    assert.throws(() => restUrl(BASE, bad), /outside the configured URL/, bad);
  }
  assert.equal(restUrl("https://your-company.atlassian.net/jira", "/issue/PROJ-1"), "https://your-company.atlassian.net/jira/rest/api/3/issue/PROJ-1");
  assert.throws(() => restUrl("https://your-company.atlassian.net/jira", "/../../../x"), /outside the configured URL/);
});

test("4B-9 (M2): a 403 on a write is a refusal (failed 'JIRA refused (no permission?)'), not a rejected token; on a read it still is", async () => {
  const s = setup(route((c) => (c.method === "POST" ? json({ errorMessages: ["forbidden"] }, 403) : null), ticketRoutes()));
  const r = await s.updater.setStatus("PROJ-1", TARGET_REVIEW);
  assert.equal(r.outcome, "failed");
  assert.match(r.detail, /JIRA refused \(no permission\?\)/);
  const c = await s.commenter.postComment("PROJ-1", "hi");
  assert.equal(c.outcome, "failed");
  assert.match(c.detail, /JIRA refused \(no permission\?\)/);
  const read = setup(() => json({}, 403));
  await assert.rejects(read.source.fetchTicket("PROJ-1"), JiraLoginRequiredError);
});

const TARGET_REVIEW = "Ready for Human Review";

test("4B-9 (M1): a transition POST that fails with 5xx, throws or times out is read back: applied → changed; not seen → 'may have been posted — check JIRA before retrying'", async () => {
  for (const [what, post, applied] of [
    ["503, applied", () => json({}, 503), true],
    ["503, not applied", () => json({}, 503), false],
    ["network error", () => { throw new TypeError("fetch failed"); }, false],
    ["timeout", () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }, true],
  ] as const) {
    let status = "Ready for Dev";
    const s = setup(route((c) => {
      const p = new URL(c.url).pathname;
      if (c.method === "POST" && p.endsWith("/transitions")) {
        if (applied) status = TARGET_REVIEW;
        return (post as () => Response)();
      }
      if (c.method === "GET" && p === "/rest/api/3/issue/PROJ-1") return json({ key: "PROJ-1", fields: { status: { name: status } } });
      return null;
    }, ticketRoutes()));
    const r = await s.updater.setStatus("PROJ-1", TARGET_REVIEW);
    if (applied) assert.deepEqual([r.outcome, r.observedStatus], ["changed", TARGET_REVIEW], what);
    else {
      assert.equal(r.outcome, "failed", what);
      assert.match(r.detail, /may have been posted — check JIRA before retrying/, what);
    }
  }
});

test("4B-9 (M1): a comment POST that fails with 5xx or throws is read back: found → posted; not found → 'may have been posted — check JIRA before retrying'", async () => {
  for (const found of [true, false]) {
    const text = "Is the discount per item?";
    const s = setup(route((c) => {
      const u = new URL(c.url);
      if (c.method === "POST" && u.pathname.endsWith("/comment")) return json({}, 502);
      if (c.method === "GET" && u.pathname === "/rest/api/3/issue/PROJ-1/comment") {
        return json({ total: 1, comments: [{ id: "9", author: { displayName: "Me" }, created: "c", body: found ? (textToAdfForTest(text) as object) : (textToAdfForTest("other") as object) }] });
      }
      return null;
    }));
    const r = await s.commenter.postComment("PROJ-1", text);
    if (found) assert.equal(r.outcome, "posted");
    else {
      assert.equal(r.outcome, "failed");
      assert.match(r.detail, /may have been posted — check JIRA before retrying/);
    }
  }
});

import { textToAdf as textToAdfForTest } from "../src/jira/adf.ts";

test("4B-10: over 1000 comments, the NEWEST 1000 are kept, oldest-first, and the marker counts the older ones not loaded", async () => {
  const all = Array.from({ length: 1200 }, (_, i) => ({ id: String(i + 1), author: { displayName: "A" }, created: `c${i + 1}`, body: `comment ${i + 1}` }));
  const s = setup(route((c) => {
    const u = new URL(c.url);
    if (u.pathname === "/rest/api/3/issue/PROJ-1") {
      return json({ key: "PROJ-1", fields: { summary: "T", status: { name: "Open" }, description: null, attachment: [], comment: { startAt: 0, maxResults: 20, total: 1200, comments: all.slice(0, 20) } } });
    }
    if (u.pathname === "/rest/api/3/issue/PROJ-1/comment") {
      const start = Number(u.searchParams.get("startAt"));
      const max = Number(u.searchParams.get("maxResults") ?? "100");
      return json({ startAt: start, total: 1200, comments: all.slice(start, start + max) });
    }
    return null;
  }));
  const t = await s.source.fetchTicket("PROJ-1");
  assert.equal(t.comments.length, 1000);
  assert.deepEqual(t.comments.map((c) => c.jiraCommentId), Array.from({ length: 1000 }, (_, i) => String(i + 201)));
  assert.equal(t.comments.at(-1)!.body, "comment 1200");
  assert.equal(parseCommentsMarker(t.description).notLoaded, 200);
});

// ---------------------------------------------------------------- final fix pass (ruling F4B-2)

/** `buf` as a stream in 64 KB chunks; `counter.pulled` = the bytes handed out so far */
function countedBody(buf: Buffer, counter: { pulled: number }, chunk = 64 * 1024) {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= buf.length) return c.close();
      const part = buf.subarray(at, at + chunk);
      at += part.length;
      counter.pulled += part.length;
      c.enqueue(new Uint8Array(part));
    },
  });
}

const issueWith = (attachment: unknown[], comment: unknown = { total: 0, comments: [] }) =>
  json({ key: "PROJ-1", fields: { summary: "T", status: { name: "Open" }, description: null, attachment, comment } });

test("F4B-2: 100 attachments of ~4.5 MB: at most 50 MB is pulled in total, the rest stay metadata with the reason noted", async () => {
  const counter = { pulled: 0 };
  const size = 4.5 * MB;
  const list = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1), filename: `shot-${i + 1}.png`, mimeType: "image/png", size }));
  const s = setup(route((c) => {
    const p = new URL(c.url).pathname;
    if (p === "/rest/api/3/issue/PROJ-1") return issueWith(list);
    if (p.startsWith("/rest/api/3/attachment/content/")) return new Response(countedBody(Buffer.alloc(size, 0x78), counter), { status: 200 });
    return null;
  }));
  const t = await s.source.fetchTicket("PROJ-1");
  assert.equal(t.attachments.length, 100, "every attachment is listed");
  const got = t.attachments.filter((a) => a.base64 !== null).length;
  assert.ok(counter.pulled <= 50 * MB, `pulled ${counter.pulled} bytes`);
  assert.equal(got, 11, "50 MB / 4.5 MB");
  assert.ok(s.calls.filter((c) => c.url.includes("/attachment/content/")).length <= 12);
  assert.match(t.description, /\[slackoff: 89 attachments not downloaded \(over the per-ticket budget of 20 images \/ 50 MB\)\]/);
});

test("F4B-2: at most 20 images are downloaded per ticket, however small", async () => {
  const list = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), filename: `s-${i + 1}.png`, mimeType: "image/png", size: PNG.length }));
  const s = setup(route((c) => {
    const p = new URL(c.url).pathname;
    if (p === "/rest/api/3/issue/PROJ-1") return issueWith(list);
    if (p.startsWith("/rest/api/3/attachment/content/")) return new Response(PNG, { status: 200 });
    return null;
  }));
  const t = await s.source.fetchTicket("PROJ-1");
  assert.equal(t.attachments.filter((a) => a.base64 !== null).length, 20);
  assert.equal(s.calls.filter((c) => c.url.includes("/attachment/content/")).length, 20);
  assert.match(t.description, /10 attachments not downloaded/);
});

test("F4B-2: comment pages share a 20 MB budget; the newest are kept and the marker counts the rest as not loaded", async () => {
  const counter = { pulled: 0 };
  const body = "y".repeat(30 * 1024);
  const total = 1000;
  const s = setup(route((c) => {
    const u = new URL(c.url);
    if (u.pathname === "/rest/api/3/issue/PROJ-1") return issueWith([], { total, comments: [] });
    if (u.pathname === "/rest/api/3/issue/PROJ-1/comment") {
      const start = Number(u.searchParams.get("startAt"));
      const max = Number(u.searchParams.get("maxResults") ?? "100");
      const comments = Array.from({ length: Math.min(max, total - start) }, (_, i) => ({ id: String(start + i + 1), author: { displayName: "A" }, created: "c", body }));
      return new Response(countedBody(Buffer.from(JSON.stringify({ startAt: start, total, comments })), counter), { status: 200 });
    }
    return null;
  }));
  const t = await s.source.fetchTicket("PROJ-1");
  assert.ok(counter.pulled <= 20 * MB + 128 * 1024, `pulled ${counter.pulled} bytes of comment pages`);
  assert.ok(t.comments.length > 0 && t.comments.length < total);
  assert.equal(t.comments.at(-1)!.jiraCommentId, String(total), "the newest comment is kept");
  const ids = t.comments.map((c) => Number(c.jiraCommentId));
  assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => total - ids.length + i + 1), "a contiguous newest run, oldest-first");
  assert.equal(parseCommentsMarker(t.description).notLoaded, total - t.comments.length);
});

test("F4B-2 (M-5): an attachment that times out, aborts or breaks mid-stream falls back to metadata", async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(10));
      c.error(new Error("connection reset"));
    },
  });
  const list = ["1", "2", "3", "4"].map((id) => ({ id, filename: `a${id}.png`, mimeType: "image/png", size: 100 }));
  const s = setup(route((c) => {
    const p = new URL(c.url).pathname;
    if (p === "/rest/api/3/issue/PROJ-1") return issueWith(list);
    if (p.endsWith("/content/1")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    if (p.endsWith("/content/2")) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (p.endsWith("/content/3")) return new Response(broken, { status: 200 });
    if (p.endsWith("/content/4")) return new Response(PNG, { status: 200 });
    return null;
  }));
  const t = await s.source.fetchTicket("PROJ-1");
  assert.deepEqual(t.attachments.map((a) => a.base64 !== null), [false, false, false, true]);
});
