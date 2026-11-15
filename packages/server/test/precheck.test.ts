// Task 10: re-read the JIRA snapshot before development; a changed snapshot runs the drift check (snapshot_changed) and
// needs the developer's acknowledgement only when the drift check says so (spec §9.9, P-C5); jira_status refresh (P-C21).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriftResult, FetchedTicket, ProposeResult, Requirement } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import type { RunAgentRequest } from "../src/executor/run-agent.ts";
import { BrowserChoiceRequiredError } from "../src/executor/types.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { fakeCritique, fakeDesign } from "../src/dev/fake-mode.ts";
import { JiraLoginRequiredError } from "../src/jira/ticket-source.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { recoverOnStartup } from "../src/workflow/recovery.ts";
import { getTicket, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { InvalidTransitionError, ValidationError } from "../src/tickets/errors.ts";
import { listSnapshots, saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { addRequirement, currentChoice, listSolutions, recordChoice, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { acknowledgeDrift, latestDrift, saveDrift } from "../src/drift/drift-repo.ts";
import { gitRepo } from "./fixtures/git-repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

const API = gitRepo("api");

const requirement: Requirement = {
  background: "bg",
  functional: [{ id: "FR-1", text: "export" }],
  acceptanceCriteria: [{ id: "AC-1", text: "Export CSV", verifiable: true, source: { type: "description", ref: "description#p1", quote: "Export." } }],
  discussionOutcomes: [],
  openQuestions: [],
  draftComment: null,
};
const base: FetchedTicket = {
  loginRequired: false, key: "K-1", title: "T", description: "Export.", jiraUpdatedAt: null, status: null, comments: [], attachments: [],
};
const changed: FetchedTicket = { ...base, description: "Export.\n\nAlso add a PDF export." };
const proposal: ProposeResult = {
  solutions: [{ title: "A", approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "S", affectedRepos: ["api"], repoChanges: [{ repo: "api", summary: "x" }] }],
};
const covered: DriftResult = {
  baseline: [{ id: "AC-1@v1", status: "covered", coveredBy: ["AC-1"], note: "" }],
  current: [{ id: "AC-1", status: "mapped" }],
  contradictions: [],
};
const unsourced: DriftResult = { ...covered, current: [{ id: "AC-1", status: "mapped" }, { id: "AC-9", status: "new_unsourced" }] };

/** Records every job id enqueued (the develop:<KEY> seam of Task 11 is a job id). */
class RecordingQueue extends JobQueue {
  ids: string[] = [];
  override enqueue(id: string, fn: () => Promise<void>): void {
    this.ids.push(id);
    super.enqueue(id, fn);
  }
}

function setup() {
  const home = tmpDir("precheck");
  const db = openDatabase(":memory:");
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const config: Config = loadConfig(home);
  config.projects = { K: { repos: [{ name: "api", path: API, baseBranch: "main" }] } };
  const source = new FakeTicketSource();
  source.tickets["K-1"] = base;
  const out: { check: DriftResult | Error } = { check: unsourced };
  const calls: Array<RunAgentRequest<unknown>> = [];
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    calls.push(req as RunAgentRequest<unknown>);
    if (req.role === "design-solution") return req.schema.parse(fakeDesign(req.prompt));
    if (req.role === "critique-design") return req.schema.parse(fakeCritique(req.prompt));
    if (req.role === "refine-ticket" && req.prompt.startsWith("mode: check")) {
      if (out.check instanceof Error) throw out.check;
      return req.schema.parse(structuredClone(out.check));
    }
    if (req.role === "refine-ticket") return req.schema.parse(structuredClone(requirement));
    if (req.role === "propose-solutions") return req.schema.parse(structuredClone(proposal));
    throw new Error(`unexpected run ${req.role}`);
  };
  const make = () => {
    const queue = new RecordingQueue(1);
    // the develop:<KEY> job is a no-op here (the development loop is tested in development.test.ts)
    const wf = createWorkflow({ updater: noUpdater, db, home, queue, source, run, config, bus, hooks: { enqueueDevelop: (key) => queue.enqueue(`develop:${key}`, async () => {}) } });
    return { queue, wf };
  };
  upsertDiscovered(db, { key: "K-1", title: "T", url: "https://j/K-1", status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(db, home, "K-1", base);
  const { id: reqId } = addRequirement(db, "K-1", snapshotId, requirement, "agent");
  saveSolutions(db, "K-1", reqId, proposal.solutions);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice"] as const) transition(db, "K-1", to, "system");
  const state = () => getTicket(db, "K-1")!.state;
  const audits = (type: string) =>
    (db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ payload_json: string }>).map(
      (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
    );
  const moves = () => events.flatMap((e) => (e.type === "state_changed" ? [`${e.from}>${e.to}`] : []));
  const snapEvents = () => events.filter((e) => e.type === "snapshot_changed");
  const checks = () => calls.filter((c) => c.role === "refine-ticket" && c.prompt.startsWith("mode: check"));
  return { home, db, bus, events, config, source, out, calls, make, reqId, baseSnapshotId: snapshotId, state, audits, moves, snapEvents, checks, ...make() };
}

/** Put K-1 in design_final without a debate (the hook is then driven by resume / recovery). */
function designFinal(s: ReturnType<typeof setup>) {
  const sol = listSolutions(s.db, "K-1")[0]!;
  recordChoice(s.db, "K-1", sol.id, "go", ["api"]);
  transition(s.db, "K-1", "designing", "system");
  transition(s.db, "K-1", "design_final", "system");
}

test("design final -> checking_snapshot automatically; unchanged snapshot -> developing, no drift check, develop job enqueued", async () => {
  const s = setup();
  s.wf.choose("K-1", listSolutions(s.db, "K-1")[0]!.id, "go", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state(), "developing", getTicket(s.db, "K-1")!.blockedReason ?? "");
  const m = s.moves();
  assert.deepEqual(m.slice(m.indexOf("designing>design_final")), ["designing>design_final", "design_final>checking_snapshot", "checking_snapshot>developing"]);
  assert.ok(s.queue.ids.includes("precheck:K-1"));
  assert.ok(s.queue.ids.includes("develop:K-1"));
  assert.deepEqual(s.source.calls, ["fetch:K-1"]);
  assert.equal(latestDrift(s.db, "K-1"), null);
  assert.equal(s.checks().length, 0);
  assert.equal(s.snapEvents().length, 0);
  assert.equal(listSnapshots(s.db, "K-1").length, 1);
});

test("changed snapshot + drift needing ack -> snapshot_changed drift record, awaiting_snapshot_ack, event needsAck:true, no develop job", async () => {
  const s = setup();
  s.source.tickets["K-1"] = changed;
  s.out.check = unsourced;
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "awaiting_snapshot_ack", getTicket(s.db, "K-1")!.blockedReason ?? "");
  const latestSnap = listSnapshots(s.db, "K-1")[0]!.id;
  assert.notEqual(latestSnap, s.baseSnapshotId);
  const d = latestDrift(s.db, "K-1")!;
  assert.equal(d.trigger, "snapshot_changed");
  assert.equal(d.requirementId, currentChoice(s.db, "K-1")!.requirementId);
  assert.equal(d.baselineSnapshotId, s.baseSnapshotId);
  assert.equal(d.latestSnapshotId, latestSnap);
  assert.equal(d.acknowledged, false);
  assert.deepEqual(s.snapEvents(), [{ type: "snapshot_changed", ticketKey: "K-1", needsAck: true }]);
  assert.deepEqual(s.audits("drift_checked").at(-1), { trigger: "snapshot_changed", needsAck: true });
  assert.ok(!s.queue.ids.includes("develop:K-1"));
  // the same prompt assembly as the phase-1 drift check: baseline, current (chosen), baseline and latest snapshots
  const [check] = s.checks();
  assert.ok(check);
  for (const sec of ["baselineRequirement:", "currentRequirement:", "baselineSnapshot:", "latestSnapshot:"]) assert.ok(check.prompt.includes(sec), sec);
  assert.ok(check.prompt.includes("Also add a PDF export."));
  assert.ok(check.prompt.includes('"AC-1@v1"'));
});

test("changed snapshot + drift needing no ack -> drift record, event needsAck:false, drift_checked audit, straight to developing", async () => {
  const s = setup();
  s.source.tickets["K-1"] = changed;
  s.out.check = covered;
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "developing", getTicket(s.db, "K-1")!.blockedReason ?? "");
  assert.equal(latestDrift(s.db, "K-1")!.trigger, "snapshot_changed");
  assert.deepEqual(s.snapEvents(), [{ type: "snapshot_changed", ticketKey: "K-1", needsAck: false }]);
  assert.deepEqual(s.audits("drift_checked").at(-1), { trigger: "snapshot_changed", needsAck: false });
  assert.ok(s.queue.ids.includes("develop:K-1"));
});

async function awaitingAck() {
  const s = setup();
  s.source.tickets["K-1"] = changed;
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "awaiting_snapshot_ack");
  return s;
}

test("ackSnapshot: an empty note -> ValidationError, nothing changes; with a note -> drift acknowledged, developing, develop job", async () => {
  const s = await awaitingAck();
  for (const note of ["", "   "]) assert.throws(() => s.wf.ackSnapshot("K-1", note, "local"), ValidationError);
  assert.equal(s.state(), "awaiting_snapshot_ack");
  assert.equal(latestDrift(s.db, "K-1")!.acknowledged, false);
  s.wf.ackSnapshot("K-1", "PDF export is out of scope, agreed with PO", "local");
  assert.equal(s.state(), "developing");
  assert.equal(latestDrift(s.db, "K-1")!.acknowledged, true);
  assert.equal(s.audits("drift_acknowledged").at(-1)!.note, "PDF export is out of scope, agreed with PO");
  assert.equal(s.audits("drift_acknowledged").at(-1)!.decidedBy, "local");
  assert.ok(s.queue.ids.includes("develop:K-1"));
  assert.throws(() => s.wf.ackSnapshot("K-1", "again", "local"), InvalidTransitionError);
});

test("ackSnapshot / replan outside awaiting_snapshot_ack -> InvalidTransitionError", () => {
  const s = setup();
  assert.throws(() => s.wf.ackSnapshot("K-1", "note", "local"), InvalidTransitionError);
  assert.throws(() => s.wf.replan("K-1", "local"), InvalidTransitionError);
  assert.equal(s.state(), "awaiting_choice");
});

test("replan -> refining, and the refine job runs from the latest snapshot", async () => {
  const s = await awaitingAck();
  s.wf.replan("K-1", "local");
  assert.equal(s.state(), "refining");
  assert.ok(s.queue.ids.includes("refine:K-1"));
  await s.queue.idle();
  // a new requirement from the changed snapshot, then new solutions to choose from
  assert.equal(s.state(), "awaiting_choice", getTicket(s.db, "K-1")!.blockedReason ?? "");
  const refine = s.calls.find((c) => c.role === "refine-ticket" && c.prompt.startsWith("mode: refine"));
  assert.ok(refine?.prompt.includes("Also add a PDF export."));
});

test("login expired -> blocked with the login message and a source_error; retry -> checking_snapshot and fetches again", async () => {
  const s = setup();
  s.source.tickets["K-1"] = new JiraLoginRequiredError();
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  const t = getTicket(s.db, "K-1")!;
  assert.equal(t.state, "blocked");
  assert.equal(t.prevState, "checking_snapshot");
  assert.equal(t.blockedReason, new JiraLoginRequiredError().message);
  assert.ok(s.events.some((e) => e.type === "source_error"));
  s.source.tickets["K-1"] = base;
  s.wf.retry("K-1", "local");
  assert.equal(s.state(), "checking_snapshot");
  await s.queue.idle();
  assert.equal(s.state(), "developing");
  assert.deepEqual(s.source.calls, ["fetch:K-1", "fetch:K-1"]);
});

test("a fetched {loginRequired: true} takes the same path", async () => {
  const s = setup();
  s.source.tickets["K-1"] = { ...base, loginRequired: true };
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.equal(getTicket(s.db, "K-1")!.blockedReason, new JiraLoginRequiredError().message);
  assert.equal(listSnapshots(s.db, "K-1").length, 1);
});

test("several browsers, none chosen -> blocked with 'Choose the Chrome browser for JIRA in Settings' (A-2)", async () => {
  const s = setup();
  s.source.tickets["K-1"] = new BrowserChoiceRequiredError();
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.equal(getTicket(s.db, "K-1")!.blockedReason, "Choose the Chrome browser for JIRA in Settings");
  assert.ok(s.events.some((e) => e.type === "source_error" && e.message === "Choose the Chrome browser for JIRA in Settings"));
});

test("unchanged snapshot with status 'In Progress' -> ticket.jira_status updated, ticket_refreshed audited (P-C21); same status -> no audit", async () => {
  const s = setup();
  s.source.tickets["K-1"] = { ...base, status: "In Progress" };
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "developing");
  assert.equal(listSnapshots(s.db, "K-1").length, 1);
  assert.equal(getTicket(s.db, "K-1")!.jiraStatus, "In Progress");
  assert.deepEqual(s.audits("ticket_refreshed"), [{ jiraStatus: { from: "Ready for Dev", to: "In Progress" } }]);
});

test("status not read (null) leaves ticket.jira_status alone", async () => {
  const s = setup();
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(getTicket(s.db, "K-1")!.jiraStatus, "Ready for Dev");
  assert.deepEqual(s.audits("ticket_refreshed"), []);
});

test("restart: tickets left in design_final or checking_snapshot are resumed", async () => {
  const s = setup();
  designFinal(s);
  // a second ticket stopped mid-check
  upsertDiscovered(s.db, { key: "K-2", title: "T2", url: "https://j/K-2", status: "Ready for Dev" }, false);
  const snap2 = saveSnapshot(s.db, s.home, "K-2", { ...base, key: "K-2" }).snapshotId;
  const req2 = addRequirement(s.db, "K-2", snap2, requirement, "agent").id;
  saveSolutions(s.db, "K-2", req2, proposal.solutions);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice"] as const) transition(s.db, "K-2", to, "system");
  recordChoice(s.db, "K-2", listSolutions(s.db, "K-2")[0]!.id, "go", ["api"]);
  for (const to of ["designing", "design_final", "checking_snapshot"] as const) transition(s.db, "K-2", to, "system");
  s.source.tickets["K-2"] = { ...base, key: "K-2" };

  const after = s.make();
  recoverOnStartup(s.db, after.wf);
  await after.queue.idle();
  assert.equal(getTicket(s.db, "K-1")!.state, "developing");
  assert.equal(getTicket(s.db, "K-2")!.state, "developing");
  assert.ok(after.queue.ids.includes("precheck:K-1"));
  assert.ok(after.queue.ids.includes("precheck:K-2"));
  assert.ok(after.queue.ids.includes("develop:K-1"));
  assert.ok(after.queue.ids.includes("develop:K-2"));
});

test("a changed snapshot whose drift check failed is checked again on retry (not taken as unchanged)", async () => {
  const s = setup();
  s.source.tickets["K-1"] = changed;
  s.out.check = new Error("agent crashed");
  designFinal(s);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.equal(latestDrift(s.db, "K-1"), null);
  s.out.check = unsourced;
  s.wf.retry("K-1", "local");
  await s.queue.idle();
  // the re-read is identical to the saved (changed) snapshot, yet it was never checked
  assert.equal(s.state(), "awaiting_snapshot_ack");
  assert.equal(s.checks().length, 2);
  assert.equal(latestDrift(s.db, "K-1")!.trigger, "snapshot_changed");
});

test("a snapshot already checked for this requirement is not checked again (ack kept)", async () => {
  const s = await awaitingAck();
  s.wf.ackSnapshot("K-1", "fine", "local");
  // the developer later goes round again (e.g. rechoose) and the design is final once more, JIRA unchanged since
  transition(s.db, "K-1", "dev_done", "system");
  s.wf.rechoose("K-1", "local");
  recordChoice(s.db, "K-1", listSolutions(s.db, "K-1")[0]!.id, "again", ["api"]);
  transition(s.db, "K-1", "designing", "system");
  transition(s.db, "K-1", "design_final", "system");
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "developing");
  assert.equal(s.checks().length, 1);
});

test("ackSnapshot from a paired phone: decidedBy device:<id> on the acknowledgement and the state change", async () => {
  const s = await awaitingAck();
  s.wf.ackSnapshot("K-1", "ok from my phone", "device:9");
  assert.equal(s.state(), "developing");
  assert.equal(s.audits("drift_acknowledged").at(-1)!.decidedBy, "device:9");
  assert.equal(s.audits("state_changed").at(-1)!.decidedBy, "device:9");
});

test("ackSnapshot: the latest drift must be for the chosen requirement -> otherwise ValidationError", async () => {
  const s = await awaitingAck();
  const latestSnap = listSnapshots(s.db, "K-1")[0]!.id;
  const other = addRequirement(s.db, "K-1", latestSnap, requirement, "human").id;
  saveDrift(s.db, "K-1", other, s.baseSnapshotId, latestSnap, "snapshot_changed", unsourced);
  assert.throws(() => s.wf.ackSnapshot("K-1", "note", "local"), ValidationError);
  assert.equal(s.state(), "awaiting_snapshot_ack");
  assert.equal(latestDrift(s.db, "K-1")!.acknowledged, false);
});

/** The changed snapshot is already stored, with an ac_edited drift check of the chosen requirement against it. */
function acEditedAgainstChanged(s: ReturnType<typeof setup>, result: DriftResult, acknowledged: boolean) {
  const { snapshotId } = saveSnapshot(s.db, s.home, "K-1", changed);
  const d = saveDrift(s.db, "K-1", s.reqId, s.baseSnapshotId, snapshotId, "ac_edited", result);
  if (acknowledged) acknowledgeDrift(s.db, d.id, "seen during AC review");
  s.source.tickets["K-1"] = changed;
  designFinal(s);
}

test("an acknowledged ac_edited drift check of this requirement against the new snapshot is reused: no second check or ack", async () => {
  const s = setup();
  acEditedAgainstChanged(s, unsourced, true);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "developing");
  assert.equal(s.checks().length, 0);
  assert.ok(s.queue.ids.includes("develop:K-1"));
});

test("an ac_edited drift check needing no ack is reused too", async () => {
  const s = setup();
  acEditedAgainstChanged(s, covered, false);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "developing");
  assert.equal(s.checks().length, 0);
});

test("an unacknowledged ac_edited drift needing ack is not reused: the snapshot_changed check runs", async () => {
  const s = setup();
  acEditedAgainstChanged(s, unsourced, false);
  s.wf.resume("K-1");
  await s.queue.idle();
  assert.equal(s.state(), "awaiting_snapshot_ack");
  assert.equal(s.checks().length, 1);
  assert.equal(latestDrift(s.db, "K-1")!.trigger, "snapshot_changed");
});
