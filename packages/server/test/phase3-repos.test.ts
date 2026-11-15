import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AcceptanceReport, DeliveryPlan, FetchedTicket, Requirement } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { verifyAuditChain } from "../src/audit/audit-log.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { addRequirement } from "../src/requirements/requirement-repo.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../src/tickets/errors.ts";
import {
  beginAcceptanceRun, currentSeries, endAcceptanceRun, getEvidence, listReports, openAcceptanceRuns, recordDecision, saveReport,
  setRunProcesses, startSeries,
} from "../src/acceptance/review-repo.ts";
import { createDelivery, failRunningSteps, finishStep, listDeliveries, startStep } from "../src/delivery/delivery-repo.ts";
import {
  failInterruptedComments, finishComment, listComments, requestComment, skipPendingComments,
} from "../src/jira/jira-comment-repo.ts";
import { requestJiraWrite } from "../src/jira/jira-write-repo.ts";
import { tmpDir } from "./helpers/tmp.ts";

type Db = ReturnType<typeof openDatabase>;

const req: Requirement = {
  background: "bg",
  functional: [{ id: "F1", text: "f" }],
  acceptanceCriteria: [{ id: "AC1", text: "a", verifiable: true, source: { type: "description", ref: "desc", quote: "q" } }],
  discussionOutcomes: [],
  openQuestions: [],
  draftComment: null,
};

function setup(): { db: Db; snapshotId: number; requirementId: number } {
  const db = openDatabase(":memory:");
  const home = tmpDir("p3");
  let snapshotId = 0;
  for (const key of ["T-1", "T-2"]) {
    upsertDiscovered(db, { key, title: "Title", url: `http://j/${key}`, status: "To Do" }, false);
    const f: FetchedTicket = { loginRequired: false, key, title: "Title", description: "d", jiraUpdatedAt: null, status: null, comments: [], attachments: [] };
    const s = saveSnapshot(db, home, key, f);
    if (key === "T-1") snapshotId = s.snapshotId;
  }
  const { id: requirementId } = addRequirement(db, "T-1", snapshotId, req, "agent");
  return { db, snapshotId, requirementId };
}

const audits = (db: Db, type: string) =>
  (db.prepare("SELECT actor, ticket_key, payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{
    actor: string; ticket_key: string | null; payload_json: string;
  }>).map((r) => ({ actor: r.actor, ticketKey: r.ticket_key, ...(JSON.parse(r.payload_json) as Record<string, unknown>) }));

const report = (verdict: AcceptanceReport["verdict"] = "failed"): AcceptanceReport => ({
  verdict,
  notExecutedReason: null,
  summary: "s",
  targets: [],
  acs: [
    { acId: "AC1", text: "a", verdict: "pass", agentVerdict: "pass", flows: [], mismatch: null },
    { acId: "AC2", text: "b", verdict: "fail", agentVerdict: "fail", flows: [], mismatch: null },
    { acId: "AC3", text: "c", verdict: "not_tested", agentVerdict: null, flows: [], mismatch: null },
  ],
  specRun: null,
  projectE2e: [],
  isolation: { ok: true, checks: ["env"], excluded: [] },
  commits: [{ repo: "api", sha: "abc" }],
});

const ev = (refKey: string) => ({
  refKey, acId: "AC1", kind: "screenshot" as const, path: `T-1/1/evidence/${refKey.replace("/", "-")}.png`, caption: "c", sha256: "f".repeat(64), bytes: 10,
});

function withReport(db: Db, snapshotId: number, requirementId: number) {
  const s = startSeries(db, "T-1", "handoff", null, "local");
  const r = saveReport(db, "T-1", { seriesId: s.id, requirementId, snapshotId, attempt: 1, report: report(), developerNote: null, evidence: [ev("AC1/1")] });
  return { seriesId: s.id, reportId: r.id };
}

const plan = (n: number, blockers: string[] = []): DeliveryPlan => ({
  actions: Array.from({ length: n }, (_, i) => ({ seq: i + 1, kind: i === 0 ? ("push" as const) : ("pr" as const), repo: "api", text: `action ${i + 1}` })),
  prBodies: [{ repo: "api", title: "t", body: "b", isPrivate: true }],
  blockers,
  warnings: [],
  hash: "0123456789abcdef",
});

// ---------------------------------------------------------------- migration 9

test("migration 9: user_version 9 and the new tables, on top of a version-8 database", () => {
  const path = join(tmpDir("m9"), "m9.db");
  const old = new DatabaseSync(path);
  for (let i = 0; i < 8; i++) old.exec(migrations[i]!);
  old.exec("PRAGMA user_version = 8");
  old.close();
  const db = openDatabase(path);
  // later migrations do not edit this test (ruling R2)
  assert.ok(migrations.length >= 9);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, migrations.length);
  assert.ok((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version >= 9);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
  for (const t of ["review_series", "review_report", "review_evidence", "review_decision", "acceptance_run", "delivery", "delivery_step", "jira_comment"])
    assert.ok(tables.includes(t), t);
  const cols = (db.prepare("PRAGMA table_info(review_report)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("snapshot_id"));
});

test("migration 9: immutable tables refuse UPDATE / DELETE / REPLACE; CHECKs and UNIQUEs hold", () => {
  const { db, snapshotId, requirementId } = setup();
  const { seriesId, reportId } = withReport(db, snapshotId, requirementId);
  recordDecision(db, "T-1", reportId, "confirmed", null, "local");
  const d = createDelivery(db, "T-1", { reportId, plan: plan(2), ackNote: null, decidedBy: "local" });
  const stepId = listDeliveries(db, "T-1")[0]!.steps[0]!.id;
  const evId = (db.prepare("SELECT id FROM review_evidence").get() as { id: number }).id;
  for (const sql of [
    `UPDATE review_report SET developer_note = 'x' WHERE id = ${reportId}`,
    `DELETE FROM review_report WHERE id = ${reportId}`,
    `UPDATE review_series SET note = 'x' WHERE id = ${seriesId}`,
    `DELETE FROM review_series WHERE id = ${seriesId}`,
    `UPDATE review_evidence SET caption = 'x' WHERE id = ${evId}`,
    `DELETE FROM review_evidence WHERE id = ${evId}`,
    `UPDATE review_decision SET note = 'x'`,
    `DELETE FROM review_decision`,
    `UPDATE delivery SET ack_note = 'x' WHERE id = ${d.id}`,
    `DELETE FROM delivery WHERE id = ${d.id}`,
    `DELETE FROM delivery_step WHERE id = ${stepId}`,
    `INSERT OR REPLACE INTO review_evidence (id, report_id, ref_key, ac_id, kind, path, caption, sha256, bytes, created_at)
       VALUES (${evId}, ${reportId}, 'AC1/9', 'AC1', 'log', 'p', 'c', 's', 1, 'now')`,
    `REPLACE INTO review_report SELECT * FROM review_report WHERE id = ${reportId}`,
    `INSERT OR REPLACE INTO delivery_step SELECT * FROM delivery_step WHERE id = ${stepId}`,
  ]) assert.throws(() => db.exec(sql), /immutable|append-only|not be deleted/, sql);
  // delivery_step state is updatable (through the repo); kind / state CHECKs
  assert.throws(() => db.exec(`UPDATE delivery_step SET state = 'bogus' WHERE id = ${stepId}`), /CHECK/);
  assert.throws(() => startSeries(db, "T-1", "nope" as "handoff", null, "local"), /CHECK/);
  // the same series cannot hold attempt 1 twice
  assert.throws(
    () => saveReport(db, "T-1", { seriesId, requirementId, snapshotId, attempt: 1, report: report(), developerNote: null, evidence: [] }),
    /UNIQUE/,
  );
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------- review series / reports / evidence / decisions

test("review: series, reports (with snapshot id), evidence and decisions, all audited", () => {
  const { db, snapshotId, requirementId } = setup();
  assert.equal(currentSeries(db, "T-1"), null);
  const s1 = startSeries(db, "T-1", "handoff", null, "local");
  const s2 = startSeries(db, "T-1", "rejected", "fix the button", "device:3");
  const cur = currentSeries(db, "T-1")!;
  assert.deepEqual({ id: cur.id, startedBy: cur.startedBy, note: cur.note, decidedBy: cur.decidedBy }, {
    id: s2.id, startedBy: "rejected", note: "fix the button", decidedBy: "device:3",
  });
  assert.equal(currentSeries(db, "T-2"), null);
  const started = audits(db, "review_series_started");
  assert.equal(started.length, 2);
  assert.deepEqual({ ...started[1] }, { actor: "developer", ticketKey: "T-1", id: s2.id, startedBy: "rejected", note: "fix the button", decidedBy: "device:3" });

  const r1 = saveReport(db, "T-1", {
    seriesId: s1.id, requirementId, snapshotId, attempt: 1, report: report(), developerNote: "look at AC2", evidence: [ev("AC1/1"), ev("AC1/2")],
  });
  const reports = listReports(db, "T-1");
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.snapshotId, snapshotId);
  assert.deepEqual(
    { id: reports[0]!.id, seriesId: reports[0]!.seriesId, attempt: reports[0]!.attempt, verdict: reports[0]!.verdict, note: reports[0]!.developerNote },
    { id: r1.id, seriesId: s1.id, attempt: 1, verdict: "failed", note: "look at AC2" },
  );
  assert.deepEqual(reports[0]!.report, report());
  assert.deepEqual(listReports(db, "T-2"), []);
  const reported = audits(db, "acceptance_reported");
  assert.deepEqual(reported[0], { actor: "system", ticketKey: "T-1", id: r1.id, seriesId: s1.id, attempt: 1, verdict: "failed", failedAcs: ["AC2", "AC3"] });

  // evidence: only through its own ticket
  const evIds = (db.prepare("SELECT id FROM review_evidence ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
  assert.equal(evIds.length, 2);
  assert.deepEqual(getEvidence(db, "T-1", evIds[0]!), { path: "T-1/1/evidence/AC1-1.png", kind: "screenshot", caption: "c", sha256: "f".repeat(64) });
  assert.equal(getEvidence(db, "T-2", evIds[0]!), null);
  assert.equal(getEvidence(db, "T-1", 9999), null);

  // decisions
  recordDecision(db, "T-1", r1.id, "rejected", "AC2 is wrong", "device:3");
  assert.deepEqual(audits(db, "review_decided")[0], {
    actor: "developer", ticketKey: "T-1", reportId: r1.id, decision: "rejected", note: "AC2 is wrong", decidedBy: "device:3",
  });
  assert.throws(() => recordDecision(db, "T-2", r1.id, "confirmed", null, "local"), NotFoundError);
  assert.equal(verifyAuditChain(db).ok, true);
});

test("saveReport is one transaction: a failure part-way leaves no report and no evidence", () => {
  const { db, snapshotId, requirementId } = setup();
  const s = startSeries(db, "T-1", "handoff", null, "local");
  const before = (db.prepare("SELECT COUNT(*) AS n FROM audit_event").get() as { n: number }).n;
  // duplicate ref_key: the second evidence insert fails after the report row was written
  assert.throws(
    () => saveReport(db, "T-1", { seriesId: s.id, requirementId, snapshotId, attempt: 1, report: report(), developerNote: null, evidence: [ev("AC1/1"), ev("AC1/1")] }),
    /UNIQUE/,
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM review_report").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM review_evidence").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_event").get() as { n: number }).n, before);
  // evidence paths stay relative to reviews/
  for (const path of ["/etc/passwd", "T-1/../../x.png", "..\\x.png", ""]) {
    assert.throws(
      () => saveReport(db, "T-1", { seriesId: s.id, requirementId, snapshotId, attempt: 1, report: report(), developerNote: null, evidence: [{ ...ev("AC1/1"), path }] }),
      ValidationError,
      path,
    );
  }
  // a series of another ticket is refused
  const other = startSeries(db, "T-2", "handoff", null, "local");
  assert.throws(
    () => saveReport(db, "T-1", { seriesId: other.id, requirementId, snapshotId, attempt: 1, report: report(), developerNote: null, evidence: [] }),
    NotFoundError,
  );
});

test("acceptance runs: begin (audited acceptance_started), processes, end; open runs listed for recovery", () => {
  const { db } = setup();
  const s = startSeries(db, "T-1", "handoff", null, "local");
  const run = beginAcceptanceRun(db, "T-1", { seriesId: s.id, attempt: 1, runRoot: "/tmp/run-1" });
  assert.deepEqual(audits(db, "acceptance_started"), [{ actor: "system", ticketKey: "T-1", id: run.id, seriesId: s.id, attempt: 1 }]);
  assert.deepEqual(openAcceptanceRuns(db), [{ id: run.id, ticketKey: "T-1", runRoot: "/tmp/run-1", pgids: [] }]);
  setRunProcesses(db, run.id, [123, 456]);
  assert.deepEqual(openAcceptanceRuns(db)[0]!.pgids, [123, 456]);
  const run2 = beginAcceptanceRun(db, "T-1", { seriesId: s.id, attempt: 2, runRoot: "/tmp/run-2" });
  endAcceptanceRun(db, run.id, "finished");
  assert.deepEqual(openAcceptanceRuns(db).map((r) => r.id), [run2.id]);
  endAcceptanceRun(db, run2.id, "interrupted");
  assert.deepEqual(openAcceptanceRuns(db), []);
  assert.throws(() => endAcceptanceRun(db, run2.id, "finished"), InvalidTransitionError);
  assert.throws(() => setRunProcesses(db, 9999, [1]), NotFoundError);
  const row = db.prepare("SELECT status, ended_at FROM acceptance_run WHERE id = ?").get(run2.id) as { status: string; ended_at: string | null };
  assert.equal(row.status, "interrupted");
  assert.ok(row.ended_at);
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------- delivery

test("createDelivery: the delivery and one pending step per action in one transaction; audited with every action text", () => {
  const { db, snapshotId, requirementId } = setup();
  const { reportId } = withReport(db, snapshotId, requirementId);
  const d = createDelivery(db, "T-1", { reportId, plan: plan(3), ackNote: "known drift", decidedBy: "device:2" });
  const ds = listDeliveries(db, "T-1");
  assert.equal(ds.length, 1);
  assert.deepEqual(
    { id: ds[0]!.id, reportId: ds[0]!.reportId, planHash: ds[0]!.planHash, ackNote: ds[0]!.ackNote, decidedBy: ds[0]!.decidedBy },
    { id: d.id, reportId, planHash: "0123456789abcdef", ackNote: "known drift", decidedBy: "device:2" },
  );
  assert.deepEqual(ds[0]!.steps.map((s) => [s.seq, s.kind, s.repo, s.text, s.state, s.deliveryId]), [
    [1, "push", "api", "action 1", "pending", d.id],
    [2, "pr", "api", "action 2", "pending", d.id],
    [3, "pr", "api", "action 3", "pending", d.id],
  ]);
  const a = audits(db, "delivery_confirmed");
  assert.equal(a.length, 1);
  assert.deepEqual(a[0], {
    actor: "developer", ticketKey: "T-1", id: d.id, reportId, planHash: "0123456789abcdef", ackNote: "known drift", decidedBy: "device:2",
    actions: ["action 1", "action 2", "action 3"], acknowledged: "acknowledged: known drift",
  });
  assert.deepEqual(listDeliveries(db, "T-2"), []);
  // a plan with blockers, or a report of another ticket, is refused (nothing written)
  assert.throws(() => createDelivery(db, "T-1", { reportId, plan: plan(1, ["gh not logged in"]), ackNote: null, decidedBy: "local" }), ValidationError);
  assert.throws(() => createDelivery(db, "T-2", { reportId, plan: plan(1), ackNote: null, decidedBy: "local" }), NotFoundError);
  assert.equal(listDeliveries(db, "T-1").length, 1);
  assert.equal(verifyAuditChain(db).ok, true);
});

test("delivery steps: pending|failed -> running -> done|failed|not_needed; recovery fails running steps", () => {
  const { db, snapshotId, requirementId } = setup();
  const { reportId } = withReport(db, snapshotId, requirementId);
  createDelivery(db, "T-1", { reportId, plan: plan(3), ackNote: null, decidedBy: "local" });
  const [s1, s2, s3] = listDeliveries(db, "T-1")[0]!.steps.map((s) => s.id) as [number, number, number];
  assert.throws(() => finishStep(db, s1, "done", "x", null), InvalidTransitionError);
  startStep(db, s1);
  assert.throws(() => startStep(db, s1), InvalidTransitionError);
  const w = requestJiraWrite(db, "T-1", "Ready for Human Review");
  finishStep(db, s1, "done", "pushed", { sha: "abc" }, { jiraWriteId: w.id });
  assert.throws(() => startStep(db, s1), InvalidTransitionError);
  const link = db.prepare("SELECT jira_write_id, jira_comment_id FROM delivery_step WHERE id = ?").get(s1) as Record<string, unknown>;
  assert.deepEqual({ ...link }, { jira_write_id: w.id, jira_comment_id: null });

  startStep(db, s2);
  finishStep(db, s2, "failed", "network down", null);
  startStep(db, s2); // a failed step can be retried
  startStep(db, s3);
  const step1 = listDeliveries(db, "T-1")[0]!.steps[0]!;
  assert.equal(step1.state, "done");
  assert.equal(step1.detail, "pushed");
  assert.deepEqual(step1.result, { sha: "abc" });
  assert.ok(step1.startedAt && step1.finishedAt);

  assert.deepEqual(failRunningSteps(db, "delivery interrupted by restart — Retry to continue"), ["T-1"]);
  const steps = listDeliveries(db, "T-1")[0]!.steps;
  assert.deepEqual(steps.map((s) => s.state), ["done", "failed", "failed"]);
  assert.equal(steps[2]!.detail, "delivery interrupted by restart — Retry to continue");
  assert.deepEqual(failRunningSteps(db, "x"), []);
  const fin = audits(db, "delivery_step_finished");
  assert.equal(fin.length, 4);
  assert.deepEqual(fin[0], { actor: "system", ticketKey: "T-1", deliveryId: listDeliveries(db, "T-1")[0]!.id, stepId: s1, seq: 1, kind: "push", repo: "api", state: "done", detail: "pushed" });
  assert.throws(() => startStep(db, 9999), NotFoundError);
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------- jira comments

test("jira comments: requested pending or confirmed; finished only when confirmed; recovery and abandon", () => {
  const { db } = setup();
  const c1 = requestComment(db, "T-1", "clarification", "Is AC2 about mobile?", "local");
  const c2 = requestComment(db, "T-1", "delivery", "Delivered: PR #1", null);
  const list = listComments(db, "T-1");
  assert.deepEqual(list.map((c) => [c.id, c.purpose, c.text, c.state, c.decidedBy]), [
    [c1.id, "clarification", "Is AC2 about mobile?", "confirmed", "local"],
    [c2.id, "delivery", "Delivered: PR #1", "pending", null],
  ]);
  assert.ok(list[0]!.decidedAt);
  assert.equal(list[1]!.decidedAt, null);
  assert.deepEqual(audits(db, "jira_comment_requested"), [
    { actor: "developer", ticketKey: "T-1", id: c1.id, purpose: "clarification", text: "Is AC2 about mobile?", state: "confirmed", decidedBy: "local" },
    { actor: "system", ticketKey: "T-1", id: c2.id, purpose: "delivery", text: "Delivered: PR #1", state: "pending", decidedBy: null },
  ]);

  assert.throws(() => finishComment(db, c2.id, "done", "x", null), InvalidTransitionError);
  finishComment(db, c1.id, "done", "comment posted", { verified: true });
  assert.throws(() => finishComment(db, c1.id, "failed", "x", null), InvalidTransitionError);
  assert.deepEqual(audits(db, "jira_comment_finished")[0], { actor: "system", ticketKey: "T-1", id: c1.id, purpose: "clarification", state: "done", detail: "comment posted" });
  assert.equal(listComments(db, "T-1")[0]!.state, "done");
  assert.ok(listComments(db, "T-1")[0]!.finishedAt);

  // recovery: confirmed (in flight) → failed
  const c3 = requestComment(db, "T-2", "clarification", "q", "device:1");
  assert.deepEqual(failInterruptedComments(db, "interrupted by restart — retry to send again"), ["T-2"]);
  assert.equal(listComments(db, "T-2")[0]!.state, "failed");
  assert.equal(listComments(db, "T-2")[0]!.detail, "interrupted by restart — retry to send again");
  assert.deepEqual(failInterruptedComments(db, "x"), []);

  // abandon: only this ticket's pending / confirmed comments that are not being sent
  const c4 = requestComment(db, "T-1", "clarification", "sending", "local");
  const c5 = requestComment(db, "T-1", "clarification", "queued", "local");
  const c6 = requestComment(db, "T-2", "delivery", "other ticket", null);
  assert.equal(skipPendingComments(db, "T-1", "ticket abandoned", (id) => id === c4.id), 2);
  const states = Object.fromEntries([...listComments(db, "T-1"), ...listComments(db, "T-2")].map((c) => [c.id, c.state]));
  assert.deepEqual(states, { [c1.id]: "done", [c2.id]: "skipped", [c3.id]: "failed", [c4.id]: "confirmed", [c5.id]: "skipped", [c6.id]: "pending" });
  assert.equal(skipPendingComments(db, "T-1", "ticket abandoned"), 1); // c4 without an in-flight check
  assert.equal(listComments(db, "T-1").find((c) => c.id === c2.id)!.detail, "ticket abandoned");
  assert.throws(() => finishComment(db, 9999, "done", "x", null), NotFoundError);
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO jira_comment SELECT * FROM jira_comment WHERE id = ${c1.id}`), /JIRA comments/);
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------- fix round 1

test("delivery_step: only state / result / timing / links update; the confirmed action is immutable", () => {
  const { db, snapshotId, requirementId } = setup();
  const { reportId } = withReport(db, snapshotId, requirementId);
  createDelivery(db, "T-1", { reportId, plan: plan(2), ackNote: null, decidedBy: "local" });
  const id = listDeliveries(db, "T-1")[0]!.steps[0]!.id;
  for (const set of ["kind = 'pr'", "seq = 9", "text = 'other'", "repo = 'web'", "repo = NULL", "delivery_id = delivery_id + 1"])
    assert.throws(() => db.exec(`UPDATE delivery_step SET ${set} WHERE id = ${id}`), /delivery steps/, set);
  db.exec(`UPDATE delivery_step SET state = 'running', detail = 'd', result_json = '1', started_at = 'x', finished_at = 'y' WHERE id = ${id}`);
  startStep(db, listDeliveries(db, "T-1")[0]!.steps[1]!.id);
});

test("jira_comment: text, purpose and ticket_key are immutable after insert", () => {
  const { db } = setup();
  const c = requestComment(db, "T-1", "clarification", "q", "local");
  for (const set of ["text = 'other'", "purpose = 'delivery'", "ticket_key = 'T-2'"])
    assert.throws(() => db.exec(`UPDATE jira_comment SET ${set} WHERE id = ${c.id}`), /JIRA comments/, set);
  finishComment(db, c.id, "done", "ok", null);
  assert.equal(listComments(db, "T-1")[0]!.state, "done");
});

test("finishStep: a linked JIRA write / comment must belong to the step's ticket", () => {
  const { db, snapshotId, requirementId } = setup();
  const { reportId } = withReport(db, snapshotId, requirementId);
  createDelivery(db, "T-1", { reportId, plan: plan(2), ackNote: null, decidedBy: "local" });
  const [s1, s2] = listDeliveries(db, "T-1")[0]!.steps.map((s) => s.id) as [number, number];
  const otherWrite = requestJiraWrite(db, "T-2", "Done");
  const otherComment = requestComment(db, "T-2", "delivery", "x", null);
  startStep(db, s1);
  assert.throws(() => finishStep(db, s1, "done", "x", null, { jiraWriteId: otherWrite.id }), NotFoundError);
  assert.throws(() => finishStep(db, s1, "done", "x", null, { jiraCommentId: otherComment.id }), NotFoundError);
  assert.throws(() => finishStep(db, s1, "done", "x", null, { jiraWriteId: 9999 }), NotFoundError);
  assert.equal(listDeliveries(db, "T-1")[0]!.steps[0]!.state, "running");
  const own = requestComment(db, "T-1", "delivery", "y", "local");
  finishStep(db, s1, "done", "x", null, { jiraCommentId: own.id });
  startStep(db, s2);
});

test("saveReport: the requirement and snapshot must belong to the ticket", () => {
  const { db, snapshotId, requirementId } = setup();
  const s = startSeries(db, "T-1", "handoff", null, "local");
  const otherSnap = (db.prepare("SELECT id FROM ticket_snapshot WHERE ticket_key = 'T-2'").get() as { id: number }).id;
  const otherReq = addRequirement(db, "T-2", otherSnap, req, "agent").id;
  const base = { seriesId: s.id, attempt: 1, report: report(), developerNote: null, evidence: [] };
  assert.throws(() => saveReport(db, "T-1", { ...base, requirementId: otherReq, snapshotId }), NotFoundError);
  assert.throws(() => saveReport(db, "T-1", { ...base, requirementId, snapshotId: otherSnap }), NotFoundError);
  assert.equal(listReports(db, "T-1").length, 0);
  saveReport(db, "T-1", { ...base, requirementId, snapshotId });
});

test("saveReport: evidence paths are [A-Za-z0-9._/-]{1,200} with no hidden, empty, '.' or '..' segment", () => {
  const { db, snapshotId, requirementId } = setup();
  const s = startSeries(db, "T-1", "handoff", null, "local");
  const save = (path: string, attempt: number) =>
    saveReport(db, "T-1", { seriesId: s.id, requirementId, snapshotId, attempt, report: report(), developerNote: null, evidence: [{ ...ev("AC1/1"), path }] });
  for (const path of ["T-1/.hidden.png", "T-1/.x/a.png", ".png", "T-1/a b.png", "T-1/%2e.png", "T-1/é.png", `T-1/${"a".repeat(200)}.png`, "T-1/a:b.png"])
    assert.throws(() => save(path, 1), ValidationError, path);
  save("T-1/1/evidence/a.b-c_d.png", 1);
});

test("migration 11 (Task 12 M2): delivery_step rebuilt with state 'skipped'; rows and guards kept", () => {
  const path = join(tmpDir("m11"), "m11.db");
  const old = new DatabaseSync(path);
  for (let i = 0; i < 10; i++) old.exec(migrations[i]!);
  old.exec("PRAGMA user_version = 10");
  old.exec(`INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('T-9', 't', 'awaiting_confirmation', 'x', 'x')`);
  old.close();
  // a version-10 database with a delivery step, seeded through the repo functions before upgrading
  const seeded = openDatabaseAt10(path);
  const db = openDatabase(path);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, migrations.length);
  const row = db.prepare("SELECT state, text, detail, result_json, jira_write_id, started_at, finished_at FROM delivery_step WHERE id = ?").get(seeded.stepId) as Record<string, unknown>;
  assert.deepEqual({ ...row }, {
    state: "pending", text: "action 1", detail: "d", result_json: '{"createAttempted":true}', jira_write_id: 1, started_at: "s", finished_at: "f",
  });
  db.exec(`UPDATE delivery_step SET state = 'skipped' WHERE id = ${seeded.stepId}`);
  assert.throws(() => db.exec(`DELETE FROM delivery_step WHERE id = ${seeded.stepId}`), /must not be deleted/);
  assert.throws(() => db.exec(`UPDATE delivery_step SET text = 'x' WHERE id = ${seeded.stepId}`), /immutable/);
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO delivery_step SELECT * FROM delivery_step WHERE id = ${seeded.stepId}`), /deleted or replaced/);
});

/** Seed one delivery step into a database kept at version 10 (no openDatabase: it would migrate). */
function openDatabaseAt10(path: string): { stepId: number } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`INSERT INTO ticket_snapshot (ticket_key, prev_snapshot_id, fetched_at, jira_updated_at, title, description, content_hash, change_summary) VALUES ('T-9', NULL, 'x', NULL, 't', 'd', 'h', NULL)`);
  db.exec(`INSERT INTO requirement (ticket_key, snapshot_id, version, content_json, draft_comment, source, created_at) VALUES ('T-9', 1, 1, '{}', NULL, 'agent', 'x')`);
  db.exec(`INSERT INTO review_series (ticket_key, started_by, note, decided_by, created_at) VALUES ('T-9', 'handoff', NULL, 'local', 'x')`);
  db.exec(`INSERT INTO review_report (ticket_key, series_id, requirement_id, snapshot_id, attempt, verdict, report_json, developer_note, created_at) VALUES ('T-9', 1, 1, 1, 1, 'passed', '{}', NULL, 'x')`);
  db.exec(`INSERT INTO delivery (ticket_key, report_id, plan_json, plan_hash, ack_note, decided_by, created_at) VALUES ('T-9', 1, '{}', 'h', NULL, 'local', 'x')`);
  db.exec(`INSERT INTO jira_write (ticket_key, target_status, state, detail, requested_at) VALUES ('T-9', 'Ready for Human Review', 'pending', NULL, 'x')`);
  const r = db
    .prepare(
      `INSERT INTO delivery_step (delivery_id, seq, kind, repo, text, state, detail, result_json, jira_write_id, started_at, finished_at)
       VALUES (1, 1, 'push', 'api', 'action 1', 'pending', 'd', '{"createAttempted":true}', 1, 's', 'f')`,
    )
    .run();
  db.close();
  return { stepId: Number(r.lastInsertRowid) };
}
