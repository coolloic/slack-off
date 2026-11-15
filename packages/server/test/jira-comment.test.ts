// Task 10 (phase 3): the jira-comment role and the confirmed "requirement unclear" comment: sent once, verified by a
// read-only fetch, never touching the ticket's platform state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JiraCommentResult, type FetchedTicket } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import type { RunAgentRequest } from "../src/executor/run-agent.ts";
import { NavigationViolationError } from "../src/executor/types.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { BrowserJiraCommenter, commentTextError, jiraCommentNavAllow, normalizeCommentText } from "../src/jira/jira-commenter.ts";
import { createJiraCommentFlow } from "../src/jira/jira-comment-jobs.ts";
import { listComments, requestComment } from "../src/jira/jira-comment-repo.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { recoverOnStartup } from "../src/workflow/recovery.ts";
import { getTicket, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { InvalidTransitionError, ValidationError } from "../src/tickets/errors.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { tmpDir } from "./helpers/tmp.ts";

const KEY = "K-1";
const BASE = "https://j.example.com";
const TEXT = "Which export format is wanted?\n- CSV\n- XLSX";

const fetched = (o: Partial<FetchedTicket> = {}): FetchedTicket => ({
  loginRequired: false, key: KEY, title: "Export orders", description: "Export.", jiraUpdatedAt: null, status: "Ready for Dev", comments: [], attachments: [], ...o,
});
const comment = (body: string, n = 1) => ({ jiraCommentId: `c${n}`, author: "me", created: "2026-11-08T00:00:00Z", body });

interface Opts {
  /** what the fake browser agent does to the fake JIRA when it posts (default: adds the comment with the given text) */
  post?: (source: FakeTicketSource, req: RunAgentRequest<unknown>, text: string) => JiraCommentResult | Error | void;
  tickets?: FetchedTicket;
}

function setup(o: Opts = {}) {
  const home = tmpDir("jira-comment");
  const db = openDatabase(":memory:");
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const config: Config = loadConfig(home);
  config.jira.baseUrl = BASE;
  const source = new FakeTicketSource();
  source.tickets[KEY] = o.tickets ?? fetched();
  const posts: Array<RunAgentRequest<unknown>> = [];
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    if (req.role !== "jira-comment") throw new Error(`unexpected run ${req.role}`);
    posts.push(req as RunAgentRequest<unknown>);
    const text = req.policy?.typeText ?? "";
    const custom = o.post?.(source, req as RunAgentRequest<unknown>, text);
    if (custom instanceof Error) throw custom;
    if (custom !== undefined) return req.schema.parse(custom);
    if (o.post === undefined) {
      const t = source.tickets[KEY] as FetchedTicket;
      source.tickets[KEY] = { ...t, comments: [...t.comments, comment(text, t.comments.length + 1)] };
    }
    return req.schema.parse({ loginRequired: false, outcome: "posted", detail: "saved" });
  };
  upsertDiscovered(db, { key: KEY, title: "Export orders", url: `${BASE}/browse/${KEY}`, status: "Ready for Dev" }, false);
  transition(db, KEY, "refining", "system");
  const queue = new JobQueue(1);
  const commenter = new BrowserJiraCommenter(run, config.jira, home);
  const wf = createWorkflow({ db, home, queue, source, run, config, bus, updater: noUpdater, commenter });
  return {
    db, events, config, source, posts, queue, wf, commenter,
    state: () => getTicket(db, KEY)!.state,
    comments: () => listComments(db, KEY),
    audits: (type: string) =>
      (db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ payload_json: string }>).map(
        (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
      ),
    async send(text = TEXT, by = "local") {
      const { id } = s.wf.sendClarification(KEY, text, by);
      await queue.idle();
      return s.comments().find((c) => c.id === id)!;
    },
  };
  // (self-reference below)
}
let s!: ReturnType<typeof setup>;
const fresh = (o: Opts = {}) => (s = setup(o));

// ---------------------------------------------------------------- text rules

test("normalizeCommentText: NFC, zero-width removed, list markers dropped, whitespace folded, trimmed", () => {
  assert.equal(normalizeCommentText("- api: https://x"), "api: https://x");
  assert.equal(normalizeCommentText("  * a\n• b\n12. c\n\n d  e "), "a b c d e");
  assert.equal(normalizeCommentText("é​‍ x"), "é x");
  assert.equal(normalizeCommentText("a-b - c"), "a-b - c");
});

test("commentTextError: empty, over 2000 characters, control characters other than newline", () => {
  assert.match(commentTextError("")!, /empty/i);
  assert.match(commentTextError("  \n ")!, /empty/i);
  assert.match(commentTextError("x".repeat(2001))!, /2000/);
  assert.equal(commentTextError("x".repeat(2000)), null);
  assert.equal(commentTextError("line one\nline two"), null);
  assert.match(commentTextError("bell\u0007")!, /control/i);
  assert.match(commentTextError("tab\there")!, /control/i);
  assert.match(commentTextError("cr\r\nlf")!, /control/i);
});

test("jiraCommentNavAllow is exactly the ticket's page", () => {
  assert.deepEqual(jiraCommentNavAllow(BASE, KEY), [`${BASE}/browse/${KEY}`]);
});

// ---------------------------------------------------------------- sending

test("sendClarification rejects empty and 2001-character text; nothing is recorded or run", async () => {
  fresh();
  for (const text of ["", "x".repeat(2001), "bell\u0007"]) {
    assert.throws(() => s.wf.sendClarification(KEY, text, "local"), ValidationError);
  }
  await s.queue.idle();
  assert.deepEqual(s.comments(), []);
  assert.equal(s.posts.length, 0);
});

test("a confirmed clarification: one jira-comment run whose prompt carries the text; verified -> done; audited; state unchanged", async () => {
  fresh();
  const before = s.state();
  const rec = await s.send(TEXT, "device:3");
  assert.equal(rec.state, "done");
  assert.equal(rec.purpose, "clarification");
  assert.equal(rec.decidedBy, "device:3");
  assert.equal(s.posts.length, 1);
  const req = s.posts[0]!;
  assert.equal(req.role, "jira-comment");
  assert.ok(req.prompt.includes(TEXT));
  assert.match(req.prompt, /type/);
  assert.ok(req.prompt.includes(`${BASE}/browse/${KEY}`));
  assert.deepEqual(req.policy?.navAllow, [`${BASE}/browse/${KEY}`]);
  assert.equal(req.policy?.typeText, TEXT);
  assert.equal(req.repos, undefined, "repository rules cannot rewrite the jira-comment prompt");
  assert.equal(s.state(), before);
  const requested = s.audits("jira_comment_requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0]!.decidedBy, "device:3");
  assert.equal(s.audits("jira_comment_finished").length, 1);
  assert.ok(s.events.some((e) => e.type === "jira_comment_updated" && e.ticketKey === KEY));
});

test("JIRA renders the lines as a list: '- api: https://x' matches the target 'api: https://x' after normalizing -> done", async () => {
  fresh({
    post: (src, _req, _text) => {
      const t = src.tickets[KEY] as FetchedTicket;
      src.tickets[KEY] = { ...t, comments: [comment("- api: https://x")] };
    },
  });
  const rec = await s.send("api: https://x");
  assert.equal(rec.state, "done");
});

test("the comment is already on the ticket: not_needed, the commenter is not called", async () => {
  fresh({ tickets: fetched({ comments: [comment(`- Which export format is wanted?\n- CSV\n- XLSX`)] }) });
  const rec = await s.send(TEXT);
  assert.equal(rec.state, "not_needed");
  assert.match(rec.detail ?? "", /already posted/i);
  assert.equal(s.posts.length, 0);
});

test("JIRA changed another field after the comment -> failed 'other changes'", async () => {
  fresh({
    post: (src, _r, text) => {
      const t = src.tickets[KEY] as FetchedTicket;
      src.tickets[KEY] = { ...t, description: "Changed.", comments: [comment(text)] };
    },
  });
  const rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /other changes/);
  assert.match(rec.detail ?? "", /K-1/);
  assert.match(rec.detail ?? "", /description/);
});

test("status or title changed after the comment -> failed 'other changes'", async () => {
  for (const patch of [{ status: "Done" }, { title: "Other" }]) {
    fresh({
      post: (src, _r, text) => {
        const t = src.tickets[KEY] as FetchedTicket;
        src.tickets[KEY] = { ...t, ...patch, comments: [comment(text)] };
      },
    });
    const rec = await s.send();
    assert.equal(rec.state, "failed", JSON.stringify(patch));
    assert.match(rec.detail ?? "", /other changes/);
  }
});

test("two comments appeared instead of one -> failed 'other changes'", async () => {
  fresh({
    post: (src, _r, text) => {
      const t = src.tickets[KEY] as FetchedTicket;
      src.tickets[KEY] = { ...t, comments: [comment(text, 1), comment("typed twice", 2)] };
    },
  });
  const rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /other changes/);
  assert.match(rec.detail ?? "", /comments/);
});

test("the read-back does not show the comment -> failed 'did not show'", async () => {
  fresh({ post: () => undefined });
  const rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /JIRA did not show the comment/);
});

test("loginRequired -> failed 'log in', source_error banner", async () => {
  fresh({ post: () => ({ loginRequired: true, outcome: "failed", detail: "sign-in page" }) });
  const rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /log in/i);
  assert.ok(s.events.some((e) => e.type === "source_error"));
});

test("an agent that reports failed -> failed with its detail", async () => {
  fresh({ post: () => ({ loginRequired: false, outcome: "failed", detail: "no comment box" }) });
  const rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /no comment box/);
});

test("NavigationViolationError and any other exception -> failed with the reason, never re-sent", async () => {
  fresh({ post: () => new NavigationViolationError(["typed the text twice"]) });
  let rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /typed the text twice/);
  assert.equal(s.posts.length, 1);
  fresh({ post: () => new Error("boom") });
  rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /boom/);
  assert.equal(s.posts.length, 1);
});

test("the read-only fetch before sending fails -> failed, nothing posted", async () => {
  fresh();
  s.source.tickets[KEY] = new Error("JIRA unreachable");
  const rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /unreachable/);
  assert.equal(s.posts.length, 0);
});

test("a clarification is sent in any non-terminal state, regardless of jira.syncStatus; abandoned is refused", async () => {
  fresh();
  assert.equal(s.config.jira.syncStatus, false);
  assert.equal((await s.send()).state, "done");
  transition(s.db, KEY, "abandoned", "developer");
  assert.throws(() => s.wf.sendClarification(KEY, "more?", "local"), InvalidTransitionError);
  assert.throws(() => s.wf.sendClarification("NOPE-1", "more?", "local"), /not found|unknown/i);
});

// ---------------------------------------------------------------- retry

test("retry: done -> error; failed -> a new confirmed record with the same text, sent again", async () => {
  fresh({ post: (src, _r, text) => { if (s.posts.length === 2) { const t = src.tickets[KEY] as FetchedTicket; src.tickets[KEY] = { ...t, comments: [comment(text)] }; } } });
  const first = await s.send();
  assert.equal(first.state, "failed");
  const { id } = s.wf.retryComment(KEY, first.id, "device:3");
  await s.queue.idle();
  assert.notEqual(id, first.id);
  const second = s.comments().find((c) => c.id === id)!;
  assert.equal(second.state, "done");
  assert.equal(second.text, TEXT);
  assert.equal(second.decidedBy, "device:3");
  assert.equal(s.posts.length, 2);
  assert.throws(() => s.wf.retryComment(KEY, second.id, "local"), InvalidTransitionError);
  assert.throws(() => s.wf.retryComment(KEY, 9999, "local"), /not found/i);
});

// ---------------------------------------------------------------- recovery

test("a confirmed comment is failed by recoverOnStartup and never sent", async () => {
  fresh();
  for (const to of ["refined", "awaiting_ac_review"] as const) transition(s.db, KEY, to, "system"); // not a state recovery resumes
  const { id } = requestComment(s.db, KEY, "clarification", TEXT, "local");
  recoverOnStartup(s.db, s.wf);
  await s.queue.idle();
  const rec = s.comments().find((c) => c.id === id)!;
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /interrupted by restart/);
  assert.equal(s.posts.length, 0);
  assert.equal(s.state(), "awaiting_ac_review");
});

test("without a commenter in the deps, sending fails cleanly (the default throws when called)", async () => {
  fresh();
  const wf = createWorkflow({ db: s.db, home: tmpDir("jira-comment-nc"), queue: s.queue, source: s.source, run: async () => { throw new Error("no run"); }, config: s.config, bus: new EventBus(), updater: noUpdater });
  const { id } = wf.sendClarification(KEY, TEXT, "local");
  await s.queue.idle();
  const rec = s.comments().find((c) => c.id === id)!;
  assert.equal(rec.state, "failed");
});

// ---------------------------------------------------------------- the skill

test("jira-comment SKILL.md: frontmatter, rules and a json example that parses", () => {
  const raw = readFileSync(resolve(import.meta.dirname, "../../../skills/jira-comment/SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  assert.ok(m);
  assert.equal(/^name: (.+)$/m.exec(m[1]!)?.[1], "jira-comment");
  assert.ok(/^description: Use when/m.test(m[1]!));
  for (const j of raw.matchAll(/```json\n([\s\S]*?)\n```/g)) JiraCommentResult.parse(JSON.parse(j[1]!));
});

// ---------------------------------------------------------------- fix round 1 (ruling T10-1)

test("T10-1: a second comment is refused while one is confirmed for the ticket (send and retry)", async () => {
  fresh();
  requestComment(s.db, KEY, "clarification", TEXT, "local"); // confirmed, not finished
  assert.throws(() => s.wf.sendClarification(KEY, TEXT, "local"), (e: Error) => e instanceof ValidationError && /already being sent for K-1/.test(e.message));
  const failed = requestComment(s.db, KEY, "clarification", "x", "local");
  s.db.prepare("UPDATE jira_comment SET state = 'failed' WHERE id = ?").run(failed.id);
  assert.throws(() => s.wf.retryComment(KEY, failed.id, "local"), ValidationError);
  assert.equal(s.posts.length, 0);
});

test("T10-1: with JobQueue(2) two confirmed comments with the same text post once (serialized per ticket)", async () => {
  fresh();
  const queue = new JobQueue(2);
  // the browser takes a while, so an unserialized second job would pre-fetch before the first comment exists
  const slow = { postComment: async (k: string, t: string) => { await new Promise((r) => setTimeout(r, 40)); return s.commenter.postComment(k, t); } };
  const flow = createJiraCommentFlow({ db: s.db, queue, bus: new EventBus(), source: s.source, commenter: slow });
  const a = requestComment(s.db, KEY, "clarification", TEXT, "local").id;
  const b = requestComment(s.db, KEY, "clarification", TEXT, "local").id;
  const [ra, rb] = await Promise.all([flow.send(a), flow.send(b)]);
  assert.equal(s.posts.length, 1);
  assert.deepEqual([ra.state, rb.state].sort(), ["done", "not_needed"]);
});

test("T10-1: older comments not loaded -> failed, the commenter is never called", async () => {
  fresh({ tickets: fetched({ description: "Export.\n\n[slackoff: 3 older comments not loaded]" }) });
  const rec = await s.send();
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /older comments not loaded on K-1 — check JIRA/);
  assert.equal(s.posts.length, 0);
});

test("T10-1: abandoning skips an unsent comment; a comment whose job starts after the ticket closed fails 'ticket closed'", async () => {
  fresh();
  const flow = createJiraCommentFlow({ db: s.db, queue: new JobQueue(1), bus: new EventBus(), source: s.source, commenter: s.commenter });
  const id = requestComment(s.db, KEY, "clarification", TEXT, "local").id;
  transition(s.db, KEY, "abandoned", "developer");
  const rec = await flow.send(id);
  assert.equal(rec.state, "failed");
  assert.match(rec.detail ?? "", /ticket closed/);
  assert.equal(s.posts.length, 0);
  // wf.abandon skips pending / not yet sending comments
  fresh();
  const pending = requestComment(s.db, KEY, "clarification", TEXT, null).id;
  const conf = requestComment(s.db, KEY, "clarification", "other", "local").id;
  s.wf.abandon(KEY, "local");
  assert.deepEqual(s.comments().filter((c) => [pending, conf].includes(c.id)).map((c) => c.state), ["skipped", "skipped"]);
});

test("T10-1: CRLF from a textarea is converted to LF before the check and stored that way; a lone CR is rejected", async () => {
  fresh();
  const rec = await s.send("one\r\ntwo");
  assert.equal(rec.text, "one\ntwo");
  assert.equal(rec.state, "done");
  assert.throws(() => s.wf.sendClarification(KEY, "a\rb", "local"), ValidationError);
});
