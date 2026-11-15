import type { DatabaseSync } from "node:sqlite";
import type { AcceptanceReport, ReviewReportRecord, ReviewSeriesRecord } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../tickets/errors.ts";

// Acceptance review records (migration 9). A series is one round of acceptance attempts (handoff, reject, or retry after
// the attempt cap start one); reports, evidence and decisions are immutable. acceptance_run is process bookkeeping
// so a restart can stop what a previous process started.

type Row = Record<string, unknown>;

export type EvidenceInput = {
  refKey: string;
  acId: string;
  kind: "screenshot" | "http" | "log";
  /** relative to `${SLACKOFF_HOME}/reviews/` */
  path: string;
  caption: string;
  sha256: string;
  bytes: number;
};

/** decidedBy: 'local' or `device:<id>`. Audited `review_series_started`. */
export function startSeries(
  db: DatabaseSync,
  key: string,
  startedBy: ReviewSeriesRecord["startedBy"],
  note: string | null,
  decidedBy: string,
): { id: number } {
  return withTx(db, () => {
    const res = db
      .prepare("INSERT INTO review_series (ticket_key, started_by, note, decided_by, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(key, startedBy, note, decidedBy, new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    appendAudit(db, { actor: "developer", type: "review_series_started", ticketKey: key, payload: { id, startedBy, note, decidedBy } });
    return { id };
  });
}

export function currentSeries(db: DatabaseSync, key: string): ReviewSeriesRecord | null {
  const r = db.prepare("SELECT * FROM review_series WHERE ticket_key = ? ORDER BY id DESC LIMIT 1").get(key) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id as number,
    startedBy: r.started_by as ReviewSeriesRecord["startedBy"],
    note: r.note as string | null,
    decidedBy: r.decided_by as string,
    createdAt: r.created_at as string,
  };
}

function seriesOf(db: DatabaseSync, key: string, seriesId: number): void {
  const r = db.prepare("SELECT 1 FROM review_series WHERE id = ? AND ticket_key = ?").get(seriesId, key);
  if (!r) throw new NotFoundError(`review series ${seriesId} not found for ${key}`);
}

/**
 * This repo's own rule (stricter than relying on the shared schema): a path relative to reviews/ made only of
 * [A-Za-z0-9._/-], 1–200 chars, whose every segment is a plain name — not empty, not ".", "..", or hidden (".x").
 */
const EVIDENCE_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
function checkEvidencePath(path: string): void {
  if (!EVIDENCE_PATH.test(path) || path.split("/").some((seg) => seg === "" || seg.startsWith("."))) {
    throw new ValidationError(`evidence path must be plain segments relative to reviews/: ${JSON.stringify(path)}`);
  }
}

/**
 * One transaction: the report, then its evidence (the report refers to evidence by ref_key, so it is never rewritten).
 * Audited `acceptance_reported` with the verdict, attempt and the ids of the ACs that did not pass.
 */
export function saveReport(
  db: DatabaseSync,
  key: string,
  r: {
    seriesId: number;
    requirementId: number;
    snapshotId: number;
    attempt: number;
    report: AcceptanceReport;
    developerNote: string | null;
    evidence: EvidenceInput[];
  },
): { id: number } {
  for (const e of r.evidence) checkEvidencePath(e.path);
  return withTx(db, () => {
    seriesOf(db, key, r.seriesId);
    if (!db.prepare("SELECT 1 FROM requirement WHERE id = ? AND ticket_key = ?").get(r.requirementId, key))
      throw new NotFoundError(`requirement ${r.requirementId} not found for ${key}`);
    if (!db.prepare("SELECT 1 FROM ticket_snapshot WHERE id = ? AND ticket_key = ?").get(r.snapshotId, key))
      throw new NotFoundError(`snapshot ${r.snapshotId} not found for ${key}`);
    const now = new Date().toISOString();
    const res = db
      .prepare(
        `INSERT INTO review_report (ticket_key, series_id, requirement_id, snapshot_id, attempt, verdict, report_json, developer_note, created_at, after_iteration_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM dev_iteration WHERE ticket_key = ?))`,
      )
      .run(key, r.seriesId, r.requirementId, r.snapshotId, r.attempt, r.report.verdict, JSON.stringify(r.report), r.developerNote, now, key);
    const id = Number(res.lastInsertRowid);
    const ins = db.prepare(
      `INSERT INTO review_evidence (report_id, ref_key, ac_id, kind, path, caption, sha256, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of r.evidence) ins.run(id, e.refKey, e.acId, e.kind, e.path, e.caption, e.sha256, e.bytes, now);
    appendAudit(db, {
      actor: "system",
      type: "acceptance_reported",
      ticketKey: key,
      payload: {
        id,
        seriesId: r.seriesId,
        attempt: r.attempt,
        verdict: r.report.verdict,
        failedAcs: r.report.acs.filter((a) => a.verdict !== "pass").map((a) => a.acId),
      },
    });
    return { id };
  });
}

/** Every series' reports, by id. */
export function listReports(db: DatabaseSync, key: string): ReviewReportRecord[] {
  const rows = db.prepare("SELECT * FROM review_report WHERE ticket_key = ? ORDER BY id").all(key) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    seriesId: r.series_id as number,
    attempt: r.attempt as number,
    verdict: r.verdict as ReviewReportRecord["verdict"],
    report: JSON.parse(r.report_json as string) as AcceptanceReport,
    developerNote: r.developer_note as string | null,
    snapshotId: r.snapshot_id as number,
    createdAt: r.created_at as string,
    afterIterationId: (r.after_iteration_id as number | null) ?? null,
  }));
}

/** Evidence of this ticket only (null for another ticket's evidence id). */
export function getEvidence(
  db: DatabaseSync,
  key: string,
  evidenceId: number,
): { path: string; kind: EvidenceInput["kind"]; caption: string; sha256: string } | null {
  const r = db
    .prepare(
      `SELECT e.path, e.kind, e.caption, e.sha256 FROM review_evidence e JOIN review_report r ON r.id = e.report_id
       WHERE e.id = ? AND r.ticket_key = ?`,
    )
    .get(evidenceId, key) as Row | undefined;
  if (!r) return null;
  return { path: r.path as string, kind: r.kind as EvidenceInput["kind"], caption: r.caption as string, sha256: r.sha256 as string };
}

/** The evidence of one report of this ticket, in saved order (what the report page lists; the file is served by id). */
export function listEvidence(
  db: DatabaseSync,
  key: string,
  reportId: number,
): { id: number; refKey: string; acId: string; kind: EvidenceInput["kind"]; caption: string }[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.ref_key, e.ac_id, e.kind, e.caption FROM review_evidence e JOIN review_report r ON r.id = e.report_id
       WHERE e.report_id = ? AND r.ticket_key = ? ORDER BY e.id`,
    )
    .all(reportId, key) as Row[];
  return rows.map((r) => ({ id: r.id as number, refKey: r.ref_key as string, acId: r.ac_id as string, kind: r.kind as EvidenceInput["kind"], caption: r.caption as string }));
}

/** The developer's decision on a report; audited `review_decided`. decidedBy: 'local' or `device:<id>`. */
export function recordDecision(
  db: DatabaseSync,
  key: string,
  reportId: number,
  decision: "rejected" | "re_review" | "confirmed",
  note: string | null,
  decidedBy: string,
): void {
  withTx(db, () => {
    const r = db.prepare("SELECT 1 FROM review_report WHERE id = ? AND ticket_key = ?").get(reportId, key);
    if (!r) throw new NotFoundError(`review report ${reportId} not found for ${key}`);
    db.prepare("INSERT INTO review_decision (ticket_key, report_id, decision, note, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      key, reportId, decision, note, decidedBy, new Date().toISOString(),
    );
    appendAudit(db, { actor: "developer", type: "review_decided", ticketKey: key, payload: { reportId, decision, note, decidedBy } });
  });
}

/** The developer's decisions on this ticket's reports, oldest first. */
export function listDecisions(
  db: DatabaseSync,
  key: string,
): { id: number; reportId: number; decision: "rejected" | "re_review" | "confirmed"; note: string | null; decidedBy: string; createdAt: string }[] {
  const rows = db.prepare("SELECT * FROM review_decision WHERE ticket_key = ? ORDER BY id").all(key) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    reportId: r.report_id as number,
    decision: r.decision as "rejected" | "re_review" | "confirmed",
    note: r.note as string | null,
    decidedBy: r.decided_by as string,
    createdAt: r.created_at as string,
  }));
}

/** A run starts; audited `acceptance_started` (ruling R2). */
export function beginAcceptanceRun(db: DatabaseSync, key: string, r: { seriesId: number; attempt: number; runRoot: string }): { id: number } {
  return withTx(db, () => {
    seriesOf(db, key, r.seriesId);
    const res = db
      .prepare("INSERT INTO acceptance_run (ticket_key, series_id, attempt, run_root, pgids_json, status, started_at) VALUES (?, ?, ?, ?, '[]', 'running', ?)")
      .run(key, r.seriesId, r.attempt, r.runRoot, new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    appendAudit(db, { actor: "system", type: "acceptance_started", ticketKey: key, payload: { id, seriesId: r.seriesId, attempt: r.attempt } });
    return { id };
  });
}

function runStatus(db: DatabaseSync, runId: number): string {
  const r = db.prepare("SELECT status FROM acceptance_run WHERE id = ?").get(runId) as { status: string } | undefined;
  if (!r) throw new NotFoundError(`acceptance run ${runId} not found`);
  return r.status;
}

/** The process groups the run started (so recovery can stop them). Bookkeeping only: not audited. */
export function setRunProcesses(db: DatabaseSync, runId: number, pgids: number[]): void {
  withTx(db, () => {
    if (runStatus(db, runId) !== "running") throw new InvalidTransitionError(`acceptance run ${runId} is not running`);
    db.prepare("UPDATE acceptance_run SET pgids_json = ? WHERE id = ?").run(JSON.stringify(pgids), runId);
  });
}

/** Bookkeeping only (the outcome is audited by saveReport): not audited. */
export function endAcceptanceRun(db: DatabaseSync, runId: number, status: "finished" | "interrupted"): void {
  withTx(db, () => {
    if (runStatus(db, runId) !== "running") throw new InvalidTransitionError(`acceptance run ${runId} is not running`);
    db.prepare("UPDATE acceptance_run SET status = ?, ended_at = ? WHERE id = ?").run(status, new Date().toISOString(), runId);
  });
}

/** Runs still marked running (startup recovery stops their process groups, then ends them interrupted). */
export function openAcceptanceRuns(db: DatabaseSync): { id: number; ticketKey: string; runRoot: string; pgids: number[] }[] {
  const rows = db.prepare("SELECT id, ticket_key, run_root, pgids_json FROM acceptance_run WHERE status = 'running' ORDER BY id").all() as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    ticketKey: r.ticket_key as string,
    runRoot: r.run_root as string,
    pgids: JSON.parse(r.pgids_json as string) as number[],
  }));
}
