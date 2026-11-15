// Task 12: the optional JIRA "In Progress" write (jira-update role). Off by default; when on, starting development
// creates a pending write that only the developer's confirmation (this computer or a paired phone) sends; the platform
// verifies the result with a read-only fetch; nothing about it ever changes the ticket's platform state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FetchedTicket, JiraUpdateResult, ProposeResult, Requirement } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import { ClaudeCodeExecutor, passFakeClaudeEnvForTests } from "../src/executor/claude-code.ts";
// phase 4b (4B-11): claude runs get an allowlisted env; the fake CLI's FAKE_CLAUDE_* settings still pass in tests
passFakeClaudeEnvForTests();
import { runAgent, type RunAgentRequest } from "../src/executor/run-agent.ts";
import { BrowserChoiceRequiredError, NavigationViolationError } from "../src/executor/types.ts";
import { JiraLoginRequiredError } from "../src/jira/ticket-source.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { BrowserJiraUpdater } from "../src/jira/jira-updater.ts";
import { inProgressTarget, statusTarget } from "../src/jira/jira-write-jobs.ts";
import { decideJiraWrite, listJiraWrites, requestJiraWrite } from "../src/jira/jira-write-repo.ts";
import type { RepoContext } from "../src/projects/project-rules.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { recoverOnStartup } from "../src/workflow/recovery.ts";
import { getTicket, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { InvalidTransitionError, NotFoundError } from "../src/tickets/errors.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { addRequirement, listSolutions, recordChoice, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { addDesignDoc, markFinal } from "../src/design/design-repo.ts";
import { gitRepo } from "./fixtures/git-repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

const KEY = "K-1";
const BASE = "https://j.example.com";
const repoRoot = resolve(import.meta.dirname, "../../..");
const fakeClaude = resolve(import.meta.dirname, "fixtures/fake-claude.ts");
const fixture = (n: string) => resolve(import.meta.dirname, "fixtures", n);

const requirement: Requirement = {
  background: "bg",
  functional: [{ id: "FR-1", text: "export" }],
  acceptanceCriteria: [{ id: "AC-1", text: "Export CSV", verifiable: true, source: { type: "description", ref: "description#p1", quote: "Export." } }],
  discussionOutcomes: [],
  openQuestions: [],
  draftComment: null,
};
const fetched = (status: string | null): FetchedTicket => ({
  loginRequired: false, key: KEY, title: "Export orders", description: "Export.", jiraUpdatedAt: null, status, comments: [], attachments: [],
});
const proposal: ProposeResult = {
  solutions: [{ title: "Api", approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "S", affectedRepos: ["api"], repoChanges: [{ repo: "api", summary: "x" }] }],
};
const changed = (observed = "In Progress"): JiraUpdateResult => ({ loginRequired: false, outcome: "changed", observedStatus: observed, detail: "moved" });

interface Opts {
  syncStatus?: boolean;
  /** the ticket's JIRA status as last read (ticket.jira_status) */
  jiraStatus?: string;
  /** what the verifying read-only fetch shows after the change */
  verifiedStatus?: string | null;
  browser?: { deviceId: string; name: string } | null;
  /** fake jira-update answer (or thrown error); default: changed */
  update?: (req: RunAgentRequest<unknown>) => JiraUpdateResult | Error;
  /** run jira-update through the real runAgent with the fake CLI replaying this stream-json fixture */
  replay?: string;
  apiFiles?: Record<string, string>;
}

function setup(o: Opts = {}) {
  const API = gitRepo("api", o.apiFiles);
  const home = tmpDir("jira-update");
  const db = openDatabase(":memory:");
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const config: Config = loadConfig(home);
  config.projects = { K: { repos: [{ name: "api", path: API, baseBranch: "main" }] } };
  config.jira.baseUrl = BASE;
  config.jira.syncStatus = o.syncStatus ?? true;
  config.jira.browser = o.browser ?? null;
  const source = new FakeTicketSource();
  source.tickets[KEY] = fetched(o.verifiedStatus === undefined ? "In Progress" : o.verifiedStatus);
  const updates: Array<RunAgentRequest<unknown>> = [];
  const devSteps: Array<RunAgentRequest<unknown>> = [];
  const replayRun = <T>(req: RunAgentRequest<T>): Promise<T> => {
    process.env.FAKE_CLAUDE_SCENARIO = "replay";
    process.env.FAKE_CLAUDE_REPLAY = o.replay!;
    process.env.FAKE_CLAUDE_STATE_FILE = join(home, "exec-calls.log");
    const executor = new ClaudeCodeExecutor([process.execPath, fakeClaude]);
    return runAgent({ db, repoRoot, executor, home, bus }, req).finally(() => {
      delete process.env.FAKE_CLAUDE_SCENARIO;
      delete process.env.FAKE_CLAUDE_REPLAY;
      delete process.env.FAKE_CLAUDE_STATE_FILE;
    });
  };
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    if (req.role === "implement-ticket") {
      devSteps.push(req as RunAgentRequest<unknown>);
      return req.schema.parse({ summary: "s", commitMessage: "work", done: true, testsRun: [], notes: "" });
    }
    if (req.role !== "jira-update") throw new Error(`unexpected run ${req.role}`);
    updates.push(req as RunAgentRequest<unknown>);
    if (o.replay !== undefined) return replayRun(req);
    const out = (o.update ?? (() => changed()))(req as RunAgentRequest<unknown>);
    if (out instanceof Error) throw out;
    return req.schema.parse(out);
  };
  const make = () => {
    const queue = new JobQueue(1);
    const updater = new BrowserJiraUpdater(run, config.jira, home);
    const wf = createWorkflow({ db, home, queue, source, run, config, bus, updater });
    return { queue, wf };
  };
  upsertDiscovered(db, { key: KEY, title: "Export orders", url: `${BASE}/browse/${KEY}`, status: o.jiraStatus ?? "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(db, home, KEY, fetched(o.jiraStatus ?? "Ready for Dev"));
  const { id: reqId } = addRequirement(db, KEY, snapshotId, requirement, "agent");
  saveSolutions(db, KEY, reqId, proposal.solutions);
  recordChoice(db, KEY, listSolutions(db, KEY)[0]!.id, "api", ["api"]);
  const choiceId = (db.prepare("SELECT MAX(id) AS id FROM choice").get() as { id: number }).id;
  const doc = addDesignDoc(db, KEY, {
    requirementId: reqId,
    choiceId,
    doc: { contentMd: "## Overview\nD", repos: [{ repo: "api", contentMd: "A" }], checklist: [], responses: [] },
  });
  markFinal(db, KEY, doc.id);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice", "designing", "design_final", "checking_snapshot", "developing"] as const) {
    transition(db, KEY, to, "system");
  }
  const s = {
    db, home, bus, events, config, source, updates, devSteps, ...make(), make,
    state: () => getTicket(db, KEY)!.state,
    /** CLI processes started by replayed runs */
    execCalls: () => (existsSync(join(home, "exec-calls.log")) ? readFileSync(join(home, "exec-calls.log"), "utf8").split("\n").filter(Boolean).length : 0),
    ticket: () => getTicket(db, KEY)!,
    writes: () => listJiraWrites(db, KEY),
    last: () => listJiraWrites(db, KEY).at(-1)!,
    audits: (type: string) =>
      (db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ payload_json: string }>).map(
        (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
      ),
    /** run development from developing (resume) until the queue is idle */
    async develop() {
      s.wf.resume(KEY);
      await s.queue.idle();
    },
    async confirm(decidedBy = "local") {
      s.wf.confirmJiraWrite(KEY, s.last().id, decidedBy);
      await s.queue.idle();
    },
  };
  return s;
}

// ---------------------------------------------------------------- requesting

test("syncStatus off (the default): starting development creates no JIRA write and runs no jira-update", async () => {
  const home = tmpDir("jira-default");
  assert.equal(loadConfig(home).jira.syncStatus, false);
  const s = setup({ syncStatus: false });
  await s.develop();
  assert.equal(s.devSteps.length, 1);
  assert.equal(s.state(), "dev_done");
  assert.deepEqual(s.writes(), []);
  assert.equal(s.updates.length, 0);
});

test("on, ticket already 'in progress' in JIRA (case and spaces ignored): one not_needed write, no agent", async () => {
  const s = setup({ jiraStatus: " in progress " });
  await s.develop();
  assert.equal(s.state(), "dev_done");
  const w = s.writes();
  assert.equal(w.length, 1);
  assert.equal(w[0]!.state, "not_needed");
  assert.equal(w[0]!.targetStatus, "In Progress");
  assert.equal(w[0]!.detail, "Already in progress in JIRA — nothing to change");
  assert.equal(s.updates.length, 0);
  assert.ok(s.events.some((e) => e.type === "jira_write_updated" && e.ticketKey === KEY));
});

test("on, ticket 'Ready for Dev': a pending write; nothing is sent before the developer confirms", async () => {
  const s = setup();
  await s.develop();
  assert.equal(s.state(), "dev_done", "development is not held up by the pending write");
  const w = s.writes();
  assert.equal(w.length, 1);
  assert.equal(w[0]!.state, "pending");
  assert.equal(w[0]!.targetStatus, "In Progress");
  assert.equal(s.updates.length, 0);
  assert.equal(s.audits("jira_write_requested").length, 1);
  // resuming development again does not ask twice
  s.wf.resume(KEY);
  await s.queue.idle();
  assert.equal(s.writes().length, 1);
});

test("confirmed from a paired phone: one jira-update run, verified by a read-only fetch -> done, ticket.jira_status updated and audited", async () => {
  const s = setup();
  await s.develop();
  const before = s.state();
  s.source.calls.length = 0;
  await s.confirm("device:3");
  assert.equal(s.updates.length, 1);
  assert.deepEqual(s.source.calls, [`fetch:${KEY}`]);
  const w = s.last();
  assert.equal(w.state, "done", w.detail ?? "");
  assert.equal(w.decidedBy, "device:3");
  assert.equal(s.ticket().jiraStatus, "In Progress");
  assert.ok(s.audits("ticket_refreshed").some((p) => JSON.stringify(p).includes('"to":"In Progress"')));
  const decided = s.audits("jira_write_decided");
  assert.equal(decided.length, 1);
  assert.equal(decided[0]!.decidedBy, "device:3");
  assert.equal(decided[0]!.decision, "confirmed");
  const finished = s.audits("jira_write_finished");
  assert.equal(finished.at(-1)!.state, "done");
  assert.equal(s.state(), before, "the ticket's platform state never changes");
});

test("the verifying fetch shows another status -> failed 'JIRA did not confirm the change'; jira_status unchanged", async () => {
  const s = setup({ verifiedStatus: "Ready for Dev" });
  await s.develop();
  await s.confirm();
  const w = s.last();
  assert.equal(w.state, "failed");
  assert.match(w.detail ?? "", /JIRA did not confirm the change/);
  assert.equal(s.ticket().jiraStatus, "Ready for Dev");
  assert.equal(s.state(), "dev_done");
});

test("the verifying fetch fails -> failed 'JIRA change reported but not verified: <reason> — check the ticket in JIRA'", async () => {
  const s = setup();
  await s.develop();
  s.source.tickets[KEY] = new Error("fetch exploded");
  await s.confirm();
  assert.equal(s.last().state, "failed");
  assert.equal(s.last().detail, "JIRA change reported but not verified: fetch exploded — check the ticket in JIRA");
  assert.equal(s.events.filter((e) => e.type === "source_error").length, 0, "a plain error is not a source error");
});

test("the verifying fetch fails with a source error -> the not-verified wording and a source_error banner", async () => {
  const s = setup();
  await s.develop();
  s.source.tickets[KEY] = new JiraLoginRequiredError();
  await s.confirm();
  assert.equal(s.last().state, "failed");
  assert.match(s.last().detail ?? "", /^JIRA change reported but not verified: .+ — check the ticket in JIRA$/);
  assert.ok(s.events.some((e) => e.type === "source_error"));
});

// ---------------------------------------------------------------- F2-I3: abandoned tickets

test("F2-I3: abandon skips a pending write ('ticket abandoned', audited); confirm and retry are refused for an abandoned ticket", async () => {
  const s = setup();
  await s.develop();
  const id = s.last().id;
  assert.equal(s.last().state, "pending");
  s.wf.abandon(KEY, "device:2");
  await s.queue.idle();
  assert.equal(s.state(), "abandoned");
  assert.equal(s.last().state, "skipped");
  assert.equal(s.last().detail, "ticket abandoned");
  const skipped = s.audits("jira_write_skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.id, id);
  assert.equal(skipped[0]!.detail, "ticket abandoned");
  assert.equal(skipped[0]!.decidedBy, "device:2");
  assert.equal(s.updates.length, 0);
  // a pending write left on an abandoned ticket (e.g. written before this fix) is never sent
  const { id: late } = requestJiraWrite(s.db, KEY, "In Progress");
  assert.throws(() => s.wf.confirmJiraWrite(KEY, late, "local"), (e: unknown) => e instanceof InvalidTransitionError && /abandoned/.test(e.message));
  await s.queue.idle();
  assert.equal(s.updates.length, 0);
});

test("F2-I3: retry of a failed write is refused once the ticket is abandoned", async () => {
  const s = setup({ update: () => new Error("boom") });
  await s.develop();
  await s.confirm();
  const failed = s.last();
  assert.equal(failed.state, "failed");
  s.wf.abandon(KEY, "local");
  assert.equal(s.last().state, "failed", "a finished write keeps its outcome");
  assert.throws(() => s.wf.retryJiraWrite(KEY, failed.id, "local"), (e: unknown) => e instanceof InvalidTransitionError && /abandoned/.test(e.message));
  assert.equal(s.writes().length, 1);
});

test("F2-I3: a confirmed write still waiting in the queue is skipped on abandon and never sent", async () => {
  const s = setup();
  await s.develop();
  let release = () => {};
  s.queue.enqueue("blocker", () => new Promise<void>((r) => (release = r)));
  s.wf.confirmJiraWrite(KEY, s.last().id, "local");
  assert.equal(s.last().state, "confirmed");
  s.wf.abandon(KEY, "local");
  assert.equal(s.last().state, "skipped");
  assert.equal(s.last().detail, "ticket abandoned");
  release();
  await s.queue.idle();
  assert.equal(s.updates.length, 0);
  assert.equal(s.last().state, "skipped");
});

test("F2-I3: a confirmed write already being sent is left to finish on abandon", async () => {
  const s = setup();
  await s.develop();
  s.wf.confirmJiraWrite(KEY, s.last().id, "local");
  s.wf.abandon(KEY, "local");
  await s.queue.idle();
  assert.equal(s.updates.length, 1);
  assert.equal(s.last().state, "done");
});

const failures: Array<[string, Opts["update"], RegExp]> = [
  ["loginRequired", () => ({ loginRequired: true, outcome: "failed", observedStatus: null, detail: "" }), /log in/i],
  ["transition_unavailable", () => ({ loginRequired: false, outcome: "transition_unavailable", observedStatus: "Ready for Dev", detail: "only Done" }), /no transition to "In Progress"/],
  ["agent failed", () => ({ loginRequired: false, outcome: "failed", observedStatus: null, detail: "menu never opened" }), /menu never opened/],
  ["NavigationViolationError", () => new NavigationViolationError(["https://evil.example/x"]), /https:\/\/evil\.example\/x/],
  ["any other error", () => new Error("boom"), /boom/],
];
for (const [name, update, why] of failures) {
  test(`jira-update ${name} -> failed with the reason; ticket state and jira_status unchanged`, async () => {
    const s = setup({ update });
    await s.develop();
    await s.confirm();
    const w = s.last();
    assert.equal(w.state, "failed");
    assert.match(w.detail ?? "", why);
    assert.equal(s.state(), "dev_done");
    assert.equal(s.ticket().jiraStatus, "Ready for Dev");
    assert.equal(s.updates.length, 1);
  });
}

test("the agent finds it already in the target status -> not_needed", async () => {
  const s = setup({ update: () => ({ loginRequired: false, outcome: "already_in_status", observedStatus: "In Progress", detail: "" }) });
  await s.develop();
  await s.confirm();
  assert.equal(s.last().state, "not_needed");
  assert.match(s.last().detail ?? "", /Already In Progress in JIRA/);
});

test("real runAgent: a click-only escape visible only in tool results (nav-click-escape.jsonl) -> failed naming the URL", async () => {
  const s = setup({ replay: fixture("nav-click-escape.jsonl") });
  await s.develop();
  await s.confirm();
  const w = s.last();
  assert.equal(w.state, "failed");
  assert.match(w.detail ?? "", /https:\/\/evil\.example\/phish/);
  assert.equal(s.state(), "dev_done");
});

test("real runAgent: several browsers connected and none configured -> failed 'Choose the Chrome browser for JIRA in Settings'", async () => {
  const s = setup({ replay: fixture("nav-multi-browser.jsonl") });
  await s.develop();
  await s.confirm();
  assert.equal(s.last().state, "failed");
  assert.match(s.last().detail ?? "", /Choose the Chrome browser for JIRA in Settings/);
  assert.equal(s.state(), "dev_done");
});

test("the jira-update request: own allow list, click-only tools, pinned browser and a prompt that reads the status back", async () => {
  const s = setup({ browser: { deviceId: "dev-42", name: "Chrome on Mac" } });
  await s.develop();
  await s.confirm();
  const req = s.updates[0]!;
  assert.equal(req.role, "jira-update");
  assert.equal(req.chrome, true);
  assert.equal(req.ticketKey, KEY);
  const C = (t: string) => `mcp__claude-in-chrome__${t}`;
  assert.ok(req.allowedTools.includes(C("computer")));
  assert.ok(req.allowedTools.includes(C("select_browser")));
  for (const t of ["form_input", "javascript_tool", "file_upload", "switch_browser"]) assert.ok(!req.allowedTools.includes(C(t)), t);
  assert.deepEqual(req.policy?.navAllow, [`${BASE}/`, `${BASE}/browse/${KEY}`]);
  assert.deepEqual(req.policy?.browser, { deviceId: "dev-42" });
  assert.match(req.prompt, /dev-42/);
  assert.match(req.prompt, /get_page_text/);
  assert.match(req.prompt, /tabs_create_mcp/);
  assert.match(req.prompt, /tabs_close_mcp/);
  assert.match(req.prompt, /target status: In Progress/);
  assert.match(req.prompt, new RegExp(`${BASE}/browse/${KEY}`));
  // not pinned: no select_browser
  const u = setup();
  await u.develop();
  await u.confirm();
  assert.ok(!u.updates[0]!.allowedTools.includes(C("select_browser")));
  assert.equal(u.updates[0]!.policy?.browser, null);
});

test("skip -> skipped, no agent; a decided write cannot be confirmed or skipped again", async () => {
  const s = setup();
  await s.develop();
  const id = s.last().id;
  s.wf.skipJiraWrite(KEY, id, "device:7");
  await s.queue.idle();
  assert.equal(s.last().state, "skipped");
  assert.equal(s.last().decidedBy, "device:7");
  assert.equal(s.updates.length, 0);
  assert.throws(() => s.wf.confirmJiraWrite(KEY, id, "local"), InvalidTransitionError);
  assert.throws(() => s.wf.skipJiraWrite(KEY, id, "local"), InvalidTransitionError);
  assert.equal(s.state(), "dev_done");
});

test("retry: only a failed write; it creates a new pending write that again needs a confirmation", async () => {
  const s = setup({ update: () => new Error("boom") });
  await s.develop();
  const pendingId = s.last().id;
  assert.throws(() => s.wf.retryJiraWrite(KEY, pendingId, "local"), InvalidTransitionError);
  await s.confirm();
  assert.equal(s.last().state, "failed");
  s.wf.retryJiraWrite(KEY, pendingId, "local");
  await s.queue.idle();
  const w = s.writes();
  assert.equal(w.length, 2);
  assert.equal(w[1]!.state, "pending");
  assert.equal(w[1]!.targetStatus, "In Progress");
  assert.equal(s.updates.length, 1, "retry itself sends nothing");
  assert.throws(() => s.wf.retryJiraWrite(KEY, w[1]!.id, "local"), InvalidTransitionError);
});

test("T12-1: an invalid jira-update answer is not re-run: one exec, write failed", async () => {
  const s = setup({ replay: fixture("jira-update-bad-output.jsonl") });
  await s.develop();
  await s.confirm();
  assert.equal(s.last().state, "failed");
  assert.match(s.last().detail ?? "", /schema validation/);
  assert.equal(s.execCalls(), 1, "exactly one CLI run");
  const runs = s.db.prepare("SELECT status FROM agent_run WHERE role = 'jira-update'").all() as Array<{ status: string }>;
  assert.deepEqual(runs.map((r) => r.status), ["invalid_output"]);
});

const sourceErrors = (s: ReturnType<typeof setup>) => s.events.flatMap((e) => (e.type === "source_error" ? [e.message] : []));

test("T12-2: login required (agent) -> source_error with the write's reason", async () => {
  const s = setup({ update: () => ({ loginRequired: true, outcome: "failed", observedStatus: null, detail: "" }) });
  await s.develop();
  await s.confirm();
  assert.deepEqual(sourceErrors(s), [s.last().detail]);
});

test("T12-2: the verifying fetch shows a login page -> source_error with the write's reason", async () => {
  const s = setup();
  await s.develop();
  s.source.tickets[KEY] = { ...fetched(null), loginRequired: true };
  await s.confirm();
  assert.equal(s.last().state, "failed");
  assert.deepEqual(sourceErrors(s), [s.last().detail]);
});

for (const [name, err] of [
  ["BrowserChoiceRequiredError", new BrowserChoiceRequiredError()],
  ["JiraLoginRequiredError", new JiraLoginRequiredError()],
] as const) {
  test(`T12-2: ${name} -> source_error with the write's reason; other errors raise none`, async () => {
    const s = setup({ update: () => err });
    await s.develop();
    await s.confirm();
    assert.equal(s.last().state, "failed");
    assert.deepEqual(sourceErrors(s), [s.last().detail]);
    assert.match(s.last().detail ?? "", new RegExp(err.message.slice(0, 20)));
    const o = setup({ update: () => new Error("boom") });
    await o.develop();
    await o.confirm();
    assert.deepEqual(sourceErrors(o), []);
  });
}

test("sync turned off between confirmation and the run -> failed early, no agent", async () => {
  const s = setup();
  await s.develop();
  let release!: () => void;
  s.queue.enqueue("hold", () => new Promise<void>((r) => (release = r))); // the write job queues behind this one
  s.wf.confirmJiraWrite(KEY, s.last().id, "local");
  s.config.jira.syncStatus = false;
  release();
  await s.queue.idle();
  assert.equal(s.last().state, "failed");
  assert.equal(s.last().detail, "JIRA status sync was turned off");
  assert.equal(s.updates.length, 0);
});

test("retry records who asked: retryOf and decidedBy in the jira_write_requested payload, actor developer", async () => {
  const s = setup({ update: () => new Error("boom") });
  await s.develop();
  const first = s.last().id;
  await s.confirm();
  s.wf.retryJiraWrite(KEY, first, "device:5");
  const row = s.db.prepare("SELECT actor, payload_json FROM audit_event WHERE type = 'jira_write_requested' ORDER BY id DESC LIMIT 1").get() as { actor: string; payload_json: string };
  assert.equal(row.actor, "developer");
  const p = JSON.parse(row.payload_json) as Record<string, unknown>;
  assert.equal(p.retryOf, first);
  assert.equal(p.decidedBy, "device:5");
  // default decidedBy is local
  await s.confirm();
  s.wf.retryJiraWrite(KEY, s.last().id, "local");
  const p2 = JSON.parse((s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'jira_write_requested' ORDER BY id DESC LIMIT 1").get() as { payload_json: string }).payload_json);
  assert.equal(p2.decidedBy, "local");
});

test("a write of another ticket or an unknown id is refused", async () => {
  const s = setup();
  await s.develop();
  assert.throws(() => s.wf.confirmJiraWrite("K-2", s.last().id, "local"), NotFoundError);
  assert.throws(() => s.wf.confirmJiraWrite(KEY, 999, "local"), NotFoundError);
  assert.equal(s.last().state, "pending");
});

test("sync turned off after the request: confirming is refused, skipping still works", async () => {
  const s = setup();
  await s.develop();
  s.config.jira.syncStatus = false;
  assert.throws(() => s.wf.confirmJiraWrite(KEY, s.last().id, "local"), InvalidTransitionError);
  s.wf.skipJiraWrite(KEY, s.last().id, "local");
  assert.equal(s.last().state, "skipped");
});

test("restart with a confirmed write that never finished -> failed 'interrupted by restart — retry to send again', nothing re-sent", async () => {
  const s = setup();
  await s.develop();
  decideJiraWrite(s.db, s.last().id, "confirmed", "local");
  const m = s.make();
  recoverOnStartup(s.db, m.wf);
  await m.queue.idle();
  assert.equal(s.last().state, "failed");
  assert.equal(s.last().detail, "interrupted by restart — retry to send again");
  assert.equal(s.updates.length, 0);
});

test("a pending write survives a restart untouched", async () => {
  const s = setup();
  await s.develop();
  const m = s.make();
  recoverOnStartup(s.db, m.wf);
  await m.queue.idle();
  assert.equal(s.last().state, "pending");
  assert.equal(s.updates.length, 0);
});

test("the target status comes from the repo rules (jiraStatus.inProgress)", async () => {
  const s = setup({ apiFiles: { "README.md": "# api\n", ".slackoff/config.json": JSON.stringify({ jiraStatus: { inProgress: "Doing" } }) } });
  await s.develop();
  assert.equal(s.last().state, "pending");
  assert.equal(s.last().targetStatus, "Doing");
});

// ---------------------------------------------------------------- target status (unit)

const repo = (name: string, inProgress?: string): RepoContext =>
  ({ name, path: `/r/${name}`, baseBranch: "main", rules: { rules: { jiraStatus: inProgress === undefined ? {} : { inProgress } } } }) as unknown as RepoContext;

test("inProgressTarget: repo value, global fallback, conflicting repos use the global value with a note, invalid values ignored", () => {
  const cfg = loadConfig(tmpDir("target"));
  assert.deepEqual(inProgressTarget([repo("api")], cfg), { status: "In Progress", note: null });
  assert.deepEqual(inProgressTarget([repo("api", "Doing")], cfg), { status: "Doing", note: null });
  assert.deepEqual(inProgressTarget([repo("api", "Doing"), repo("web", " doing ")], cfg), { status: "Doing", note: null });
  const conflict = inProgressTarget([repo("api", "Doing"), repo("web", "In Dev")], cfg);
  assert.equal(conflict.status, "In Progress");
  assert.match(conflict.note ?? "", /api.*Doing.*web.*In Dev/);
  assert.deepEqual(inProgressTarget([repo("api", 'bad"quote')], cfg), { status: "In Progress", note: null });
  // the first repo declares none, the second does: that value is used
  assert.deepEqual(inProgressTarget([repo("api"), repo("web", "Doing")], cfg), { status: "Doing", note: null });
});

const reviewRepo = (name: string, readyForReview?: string): RepoContext =>
  ({ name, path: `/r/${name}`, baseBranch: "main", rules: { rules: { jiraStatus: readyForReview === undefined ? {} : { readyForReview } } } }) as unknown as RepoContext;

test("statusTarget readyForReview: Settings jira.reviewStatus by default, the repo value, conflicting repos -> Settings value with a note naming both", () => {
  const cfg = loadConfig(tmpDir("target"));
  assert.deepEqual(statusTarget([reviewRepo("api")], cfg, "readyForReview"), { status: "Ready for Human Review", note: null });
  assert.deepEqual(statusTarget([reviewRepo("api", "Code Review")], cfg, "readyForReview"), { status: "Code Review", note: null });
  const conflict = statusTarget([reviewRepo("api", "Code Review"), reviewRepo("web", "QA")], cfg, "readyForReview");
  assert.equal(conflict.status, "Ready for Human Review");
  assert.match(conflict.note ?? "", /api/);
  assert.match(conflict.note ?? "", /web/);
  assert.match(conflict.note ?? "", /Ready for Human Review/);
  // the in-progress value of a repo does not leak into the review target, and vice versa
  assert.deepEqual(statusTarget([repo("api", "Doing")], cfg, "readyForReview"), { status: "Ready for Human Review", note: null });
  assert.deepEqual(statusTarget([reviewRepo("api", "Code Review")], cfg, "inProgress"), { status: "In Progress", note: null });
  assert.deepEqual(statusTarget([reviewRepo("api", 'bad"quote')], cfg, "readyForReview"), { status: "Ready for Human Review", note: null });
  cfg.jira.reviewStatus = "Review";
  assert.deepEqual(statusTarget([reviewRepo("api")], cfg, "readyForReview"), { status: "Review", note: null });
});

test("requestJiraWrite keeps an optional detail (the conflicting-repos note)", () => {
  const s = setup();
  const w = requestJiraWrite(s.db, KEY, "In Progress", "note here");
  assert.equal(listJiraWrites(s.db, KEY).find((x) => x.id === w.id)!.detail, "note here");
});
