import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriftResult, FetchedTicket, Requirement, Solution } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { verifyAuditChain } from "../src/audit/audit-log.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { getTicket, listTickets, setReviewAc, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../src/tickets/errors.ts";
import {
  addRequirement, currentChoice, firstRequirement, getRequirement, latestRequirement, listSolutions, recordChoice, saveSolutions,
} from "../src/requirements/requirement-repo.ts";
import { acknowledgeDrift, latestDrift, saveDrift } from "../src/drift/drift-repo.ts";

const summary = { key: "T-1", title: "Title", url: "http://j/T-1", status: "To Do" };

function setup() {
  const db = openDatabase(":memory:");
  const home = tmpDir("tk");
  upsertDiscovered(db, summary, false);
  const f: FetchedTicket = { loginRequired: false, key: "T-1", title: "Title", description: "d", jiraUpdatedAt: null, status: null, comments: [], attachments: [] };
  const { snapshotId } = saveSnapshot(db, home, "T-1", f);
  return { db, snapshotId };
}

const auditCount = (db: ReturnType<typeof openDatabase>, type: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE type = ?").get(type) as { n: number }).n;

function req(over: Partial<Requirement> = {}): Requirement {
  return {
    background: "bg",
    functional: [{ id: "F1", text: "f" }],
    acceptanceCriteria: [
      { id: "AC1", text: "a", verifiable: true, source: { type: "description", ref: "desc", quote: "q" } },
      { id: "AC2", text: "b", verifiable: true, source: { type: "developer", reason: "because" } },
    ],
    discussionOutcomes: [],
    openQuestions: [],
    draftComment: "please clarify",
    ...over,
  };
}

test("repeated upsertDiscovered keeps state and requirements", () => {
  const { db, snapshotId } = setup();
  assert.equal(getTicket(db, "T-1")?.state, "discovered");
  transition(db, "T-1", "refining", "system");
  addRequirement(db, "T-1", snapshotId, req(), "agent");
  assert.deepEqual(upsertDiscovered(db, { ...summary, title: "New" }, true), { created: false });
  const t = getTicket(db, "T-1")!;
  assert.equal(t.state, "refining");
  assert.equal(t.title, "New"); // H5: the JIRA title is refreshed
  assert.equal(t.reviewAc, false);
  assert.equal(latestRequirement(db, "T-1")?.version, 1);
  assert.equal(listTickets(db).length, 1);
  setReviewAc(db, "T-1", true, "local");
  assert.equal(getTicket(db, "T-1")?.reviewAc, true);
});

test("H5: re-discovery refreshes title and jira_status only, audited only when changed", () => {
  const { db, snapshotId } = setup();
  transition(db, "T-1", "refining", "system");
  addRequirement(db, "T-1", snapshotId, req(), "agent");
  setReviewAc(db, "T-1", true, "local");
  const before = getTicket(db, "T-1")!;

  // unchanged: no update, no audit
  assert.deepEqual(upsertDiscovered(db, summary, false), { created: false });
  assert.equal(auditCount(db, "ticket_refreshed"), 0);
  assert.equal(getTicket(db, "T-1")!.updatedAt, before.updatedAt);

  assert.deepEqual(upsertDiscovered(db, { ...summary, title: "Renamed", status: "In Progress", url: "http://elsewhere" }, false), { created: false });
  const t = getTicket(db, "T-1")!;
  assert.equal(t.title, "Renamed");
  assert.equal(t.jiraStatus, "In Progress");
  assert.equal(t.url, before.url, "url is not part of the refresh");
  assert.equal(t.state, "refining");
  assert.equal(t.reviewAc, true);
  assert.equal(latestRequirement(db, "T-1")?.version, 1);
  assert.equal(auditCount(db, "ticket_refreshed"), 1);
  const ev = db.prepare("SELECT actor, payload_json FROM audit_event WHERE type = 'ticket_refreshed'").get() as { actor: string; payload_json: string };
  assert.equal(ev.actor, "system");
  assert.deepEqual(JSON.parse(ev.payload_json), {
    title: { from: "Title", to: "Renamed" },
    jiraStatus: { from: "To Do", to: "In Progress" },
  });

  // only the status changes: only that field is recorded
  upsertDiscovered(db, { ...summary, title: "Renamed", status: "Done" }, false);
  const last = db.prepare("SELECT payload_json FROM audit_event WHERE type = 'ticket_refreshed' ORDER BY id DESC LIMIT 1").get() as { payload_json: string };
  assert.deepEqual(JSON.parse(last.payload_json), { jiraStatus: { from: "In Progress", to: "Done" } });
  assert.equal(auditCount(db, "ticket_refreshed"), 2);
  assert.equal(verifyAuditChain(db).ok, true);
});

test("illegal transition throws and writes no audit; legal one writes exactly one", () => {
  const { db } = setup();
  const before = auditCount(db, "state_changed");
  assert.throws(() => transition(db, "T-1", "proposing", "system"), InvalidTransitionError);
  assert.equal(auditCount(db, "state_changed"), before);
  assert.equal(getTicket(db, "T-1")?.state, "discovered");
  transition(db, "T-1", "refining", "developer");
  assert.equal(auditCount(db, "state_changed"), before + 1);
  assert.deepEqual(verifyAuditChain(db).ok, true);
});

test("blocked stores prev_state/reason and may only return to prev_state", () => {
  const { db } = setup();
  transition(db, "T-1", "refining", "system");
  transition(db, "T-1", "blocked", "system", "schema failed");
  const b = getTicket(db, "T-1")!;
  assert.equal(b.prevState, "refining");
  assert.equal(b.blockedReason, "schema failed");
  assert.throws(() => transition(db, "T-1", "refined", "developer"), InvalidTransitionError);
  assert.equal(getTicket(db, "T-1")?.state, "blocked");
  transition(db, "T-1", "refining", "developer");
  const r = getTicket(db, "T-1")!;
  assert.equal(r.state, "refining");
  assert.equal(r.prevState, null);
  assert.equal(r.blockedReason, null);
});

test("requirement versions increment and ac_trace rows match AC count", () => {
  const { db, snapshotId } = setup();
  const a = addRequirement(db, "T-1", snapshotId, req(), "agent");
  const b = addRequirement(db, "T-1", snapshotId, req({ acceptanceCriteria: [req().acceptanceCriteria[0]!] }), "human");
  assert.equal(a.version, 1);
  assert.equal(b.version, 2);
  const n = (id: number) => (db.prepare("SELECT COUNT(*) AS n FROM ac_trace WHERE requirement_id = ?").get(id) as { n: number }).n;
  assert.equal(n(a.id), 2);
  assert.equal(n(b.id), 1);
  const dev = db.prepare("SELECT * FROM ac_trace WHERE requirement_id = ? AND ac_id = 'AC2'").get(a.id) as Record<string, unknown>;
  assert.equal(dev.source_type, "developer");
  assert.equal(dev.source_ref, null);
  assert.equal(dev.quote, null);
  assert.equal(dev.reason, "because");
  assert.equal(firstRequirement(db, "T-1")?.id, a.id);
  assert.equal(latestRequirement(db, "T-1")?.id, b.id);
  assert.equal(getRequirement(db, a.id)?.draftComment, "please clarify");
  assert.deepEqual(getRequirement(db, a.id)?.content, req());
  assert.equal(auditCount(db, "requirement_saved"), 2);
});

test("failed addRequirement rolls back requirement, ac_trace and audit", () => {
  const { db, snapshotId } = setup();
  const bad = req({
    acceptanceCriteria: [
      req().acceptanceCriteria[0]!,
      { id: "AC2", text: "x", verifiable: true, source: { type: "bogus", ref: "r", quote: "q" } as never },
    ],
  });
  assert.throws(() => addRequirement(db, "T-1", snapshotId, bad, "agent"), /CHECK/);
  assert.equal(latestRequirement(db, "T-1"), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM ac_trace").get() as { n: number }).n, 0);
  assert.equal(auditCount(db, "requirement_saved"), 0);
});

const sol = (t: string): Solution => ({ title: t, approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "S", affectedRepos: ["api"], repoChanges: [{ repo: "api", summary: "s" }] });

test("solutions: latest batch only, choice audited", () => {
  const { db, snapshotId } = setup();
  const { id } = addRequirement(db, "T-1", snapshotId, req(), "agent");
  saveSolutions(db, "T-1", id, [sol("a"), sol("b")]);
  saveSolutions(db, "T-1", id, [sol("c"), sol("d"), sol("e")]);
  const list = listSolutions(db, "T-1");
  assert.deepEqual(list.map((s) => s.content.title), ["c", "d", "e"]);
  assert.deepEqual(list.map((s) => s.idx), [0, 1, 2]);
  recordChoice(db, "T-1", list[1]!.id, "go");
  assert.equal(auditCount(db, "choice_recorded"), 1);
  assert.throws(() => recordChoice(db, "T-1", 9999, "x"));
});

test("recordChoice takes an optional affectedRepos 5th argument", () => {
  const { db, snapshotId } = setup();
  const { id } = addRequirement(db, "T-1", snapshotId, req(), "agent");
  saveSolutions(db, "T-1", id, [sol("a")]);
  recordChoice(db, "T-1", listSolutions(db, "T-1")[0]!.id, "go", ["api"]);
  assert.deepEqual(currentChoice(db, "T-1")?.affectedRepos, ["api"]);
  assert.equal(auditCount(db, "choice_recorded"), 1);
});

test("H6: saveSolutions records the solution ids and titles in the audit log", () => {
  const { db, snapshotId } = setup();
  const { id } = addRequirement(db, "T-1", snapshotId, req(), "agent");
  saveSolutions(db, "T-1", id, [sol("Add a button"), sol("Use a menu")]);
  const list = listSolutions(db, "T-1");
  const ev = db.prepare("SELECT actor, ticket_key, payload_json FROM audit_event WHERE type = 'solutions_saved'").all() as Array<{ actor: string; ticket_key: string; payload_json: string }>;
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.actor, "agent:propose-solutions");
  assert.equal(ev[0]!.ticket_key, "T-1");
  assert.deepEqual(JSON.parse(ev[0]!.payload_json), {
    requirementId: id,
    solutions: list.map((s) => ({ id: s.id, title: s.content.title })),
  });
  assert.equal(verifyAuditChain(db).ok, true);
});

test("solutions of an older requirement are not listed and cannot be chosen after a new version", () => {
  const { db, snapshotId } = setup();
  const v1 = addRequirement(db, "T-1", snapshotId, req(), "agent");
  saveSolutions(db, "T-1", v1.id, [sol("a")]);
  const old = listSolutions(db, "T-1")[0]!;
  addRequirement(db, "T-1", snapshotId, req(), "human");
  assert.deepEqual(listSolutions(db, "T-1"), []);
  assert.throws(() => recordChoice(db, "T-1", old.id, "x"), ValidationError);
  assert.equal(auditCount(db, "choice_recorded"), 0);
});

test("blocked can be abandoned directly", () => {
  const { db } = setup();
  transition(db, "T-1", "refining", "system");
  transition(db, "T-1", "blocked", "system", "boom");
  transition(db, "T-1", "abandoned", "developer");
  const t = getTicket(db, "T-1")!;
  assert.equal(t.state, "abandoned");
  assert.equal(t.prevState, null);
  assert.equal(t.blockedReason, null);
});

test("setReviewAc on unknown key throws NotFoundError", () => {
  const { db } = setup();
  assert.throws(() => setReviewAc(db, "NOPE-1", true, "local"), NotFoundError);
});

test("state_changed audit payloads across block and return", () => {
  const { db } = setup();
  transition(db, "T-1", "refining", "system");
  transition(db, "T-1", "blocked", "system", "schema failed");
  transition(db, "T-1", "refining", "developer");
  const rows = db.prepare("SELECT actor, payload_json FROM audit_event WHERE type='state_changed' ORDER BY id").all() as { actor: string; payload_json: string }[];
  assert.deepEqual(rows.map((r) => JSON.parse(r.payload_json)), [
    { from: "discovered", to: "refining", reason: null },
    { from: "refining", to: "blocked", reason: "schema failed" },
    { from: "blocked", to: "refining", reason: null },
  ]);
  assert.deepEqual(rows.map((r) => r.actor), ["system", "system", "developer"]);
});

const drift: DriftResult = {
  baseline: [{ id: "AC1", status: "missing", coveredBy: [], note: "n" }],
  current: [],
  contradictions: [],
};

test("drift: save, latest, acknowledge requires note", () => {
  const { db, snapshotId } = setup();
  const { id } = addRequirement(db, "T-1", snapshotId, req(), "agent");
  const d = saveDrift(db, "T-1", id, snapshotId, snapshotId, "before_review", drift);
  const l = latestDrift(db, "T-1")!;
  assert.equal(l.id, d.id);
  assert.equal(l.acknowledged, false);
  assert.deepEqual(l.result, drift);
  assert.throws(() => acknowledgeDrift(db, d.id, "  "), ValidationError);
  assert.equal(latestDrift(db, "T-1")?.acknowledged, false);
  acknowledgeDrift(db, d.id, "reviewed");
  assert.equal(latestDrift(db, "T-1")?.acknowledged, true);
  assert.equal(auditCount(db, "drift_acknowledged"), 1);
  // Task 10 fix: who acknowledged (default 'local')
  const ackPayload = db.prepare("SELECT payload_json FROM audit_event WHERE type='drift_acknowledged'").get() as { payload_json: string };
  assert.deepEqual(JSON.parse(ackPayload.payload_json), { driftId: d.id, note: "reviewed", decidedBy: "local" });
  const ack = db.prepare("SELECT actor FROM audit_event WHERE type='drift_acknowledged'").get() as { actor: string };
  assert.equal(ack.actor, "developer");
  acknowledgeDrift(db, d.id, "again");
  assert.equal(auditCount(db, "drift_acknowledged"), 1);
  const p = db.prepare("SELECT payload_json, actor FROM audit_event WHERE type='drift_checked'").get() as { payload_json: string; actor: string };
  assert.deepEqual(JSON.parse(p.payload_json), { trigger: "before_review", needsAck: true });
});

// ---- author decision 2026-11-06: discovery reads every open ticket; known tickets missing from a complete read are flagged ----

import { lastDiscoveryRun, markJiraOpen, recordDiscoveryRun } from "../src/tickets/ticket-repo.ts";
import { tmpDir } from "./helpers/tmp.ts";

test("markJiraOpen flags known tickets missing from the open set, audits, and clears the flag when they reappear", () => {
  const { db, snapshotId } = setup();
  upsertDiscovered(db, { ...summary, key: "T-2" }, false);
  transition(db, "T-1", "refining", "system");
  addRequirement(db, "T-1", snapshotId, req(), "agent");
  assert.equal(getTicket(db, "T-1")!.jiraOpen, true, "new and pre-migration tickets count as open");

  assert.deepEqual(markJiraOpen(db, new Set(["T-2"])), { closed: ["T-1"], reopened: [] });
  const t = getTicket(db, "T-1")!;
  assert.equal(t.jiraOpen, false);
  assert.equal(t.state, "refining", "platform state is never changed");
  assert.equal(latestRequirement(db, "T-1")?.version, 1, "requirements are never touched");
  assert.equal(getTicket(db, "T-2")!.jiraOpen, true);
  assert.equal(auditCount(db, "ticket_no_longer_open"), 1);
  const ev = db.prepare("SELECT actor, ticket_key, payload_json FROM audit_event WHERE type = 'ticket_no_longer_open'").get() as { actor: string; ticket_key: string; payload_json: string };
  assert.equal(ev.actor, "system");
  assert.equal(ev.ticket_key, "T-1");
  assert.deepEqual(JSON.parse(ev.payload_json), { lastJiraStatus: "To Do" });

  // already flagged: no second audit
  assert.deepEqual(markJiraOpen(db, new Set(["T-2"])), { closed: [], reopened: [] });
  assert.equal(auditCount(db, "ticket_no_longer_open"), 1);

  // reappears: flag cleared, audited
  assert.deepEqual(markJiraOpen(db, new Set(["T-1", "T-2"])), { closed: [], reopened: ["T-1"] });
  assert.equal(getTicket(db, "T-1")!.jiraOpen, true);
  assert.equal(auditCount(db, "ticket_open_again"), 1);
  assert.equal(getTicket(db, "T-1")!.state, "refining");
  assert.equal(verifyAuditChain(db).ok, true);
});

test("recordDiscoveryRun / lastDiscoveryRun keep the latest discovery outcome", () => {
  const { db } = setup();
  assert.equal(lastDiscoveryRun(db), null);
  recordDiscoveryRun(db, { returned: 100, total: 140, complete: false });
  recordDiscoveryRun(db, { returned: 3, total: 3, complete: true });
  const last = lastDiscoveryRun(db)!;
  assert.deepEqual({ returned: last.returned, total: last.total, complete: last.complete }, { returned: 3, total: 3, complete: true });
  assert.match(last.finishedAt, /^\d{4}-\d\d-\d\dT/);
});
