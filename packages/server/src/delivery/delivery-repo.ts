import type { DatabaseSync } from "node:sqlite";
import type { DeliveryPlan, DeliveryStepRecord } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../tickets/errors.ts";

// A confirmed delivery (immutable) and its steps, one per confirmed action: pending → running → done | failed |
// not_needed; a failed step can be started again (retry). Steps are never deleted.

type Row = Record<string, unknown>;

/** The developer's "Confirm and deliver": the delivery plus a pending step per action, one transaction; audited `delivery_confirmed`. */
export function createDelivery(
  db: DatabaseSync,
  key: string,
  d: { reportId: number; plan: DeliveryPlan; ackNote: string | null; decidedBy: string },
): { id: number } {
  if (d.plan.blockers.length > 0) throw new ValidationError(`the delivery plan has blockers: ${d.plan.blockers.join("; ")}`);
  return withTx(db, () => {
    const r = db.prepare("SELECT 1 FROM review_report WHERE id = ? AND ticket_key = ?").get(d.reportId, key);
    if (!r) throw new NotFoundError(`review report ${d.reportId} not found for ${key}`);
    const res = db
      .prepare(
        `INSERT INTO delivery (ticket_key, report_id, plan_json, plan_hash, ack_note, decided_by, created_at, drift_id_at_confirm)
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM drift_check WHERE ticket_key = ?))`,
      )
      .run(key, d.reportId, JSON.stringify(d.plan), d.plan.hash, d.ackNote, d.decidedBy, new Date().toISOString(), key);
    const id = Number(res.lastInsertRowid);
    const ins = db.prepare("INSERT INTO delivery_step (delivery_id, seq, kind, repo, text, state) VALUES (?, ?, ?, ?, ?, 'pending')");
    for (const a of d.plan.actions) ins.run(id, a.seq, a.kind, a.repo, a.text);
    appendAudit(db, {
      actor: "developer",
      type: "delivery_confirmed",
      ticketKey: key,
      payload: {
        id, reportId: d.reportId, planHash: d.plan.hash, ackNote: d.ackNote, decidedBy: d.decidedBy, actions: d.plan.actions.map((a) => a.text),
        ...(d.ackNote !== null ? { acknowledged: `acknowledged: ${d.ackNote}` } : {}),
      },
    });
    return { id };
  });
}

const toStep = (r: Row): DeliveryStepRecord => ({
  id: r.id as number,
  deliveryId: r.delivery_id as number,
  seq: r.seq as number,
  kind: r.kind as DeliveryStepRecord["kind"],
  repo: r.repo as string | null,
  text: r.text as string,
  state: r.state as DeliveryStepRecord["state"],
  detail: r.detail as string | null,
  result: r.result_json === null ? null : (JSON.parse(r.result_json as string) as unknown),
  startedAt: r.started_at as string | null,
  finishedAt: r.finished_at as string | null,
});

export function listDeliveries(
  db: DatabaseSync,
  key: string,
): {
  id: number; reportId: number; planHash: string; ackNote: string | null; decidedBy: string; createdAt: string;
  /** T12-2: the ticket's newest drift check id when the delivery was confirmed (0: none; also for rows before migration 12) */
  driftIdAtConfirm: number;
  steps: DeliveryStepRecord[];
}[] {
  const rows = db.prepare("SELECT * FROM delivery WHERE ticket_key = ? ORDER BY id").all(key) as Row[];
  const steps = db.prepare("SELECT * FROM delivery_step WHERE delivery_id = ? ORDER BY seq");
  return rows.map((r) => ({
    id: r.id as number,
    reportId: r.report_id as number,
    planHash: r.plan_hash as string,
    ackNote: r.ack_note as string | null,
    decidedBy: r.decided_by as string,
    createdAt: r.created_at as string,
    driftIdAtConfirm: (r.drift_id_at_confirm as number | null) ?? 0,
    steps: (steps.all(r.id as number) as Row[]).map(toStep),
  }));
}

/** The confirmed plan of a delivery (the exact actions and PR descriptions the developer saw). */
export function deliveryPlan(db: DatabaseSync, deliveryId: number): DeliveryPlan {
  const r = db.prepare("SELECT plan_json FROM delivery WHERE id = ?").get(deliveryId) as { plan_json: string } | undefined;
  if (!r) throw new NotFoundError(`delivery ${deliveryId} not found`);
  return JSON.parse(r.plan_json) as DeliveryPlan;
}

function stepRow(db: DatabaseSync, stepId: number): Row & { ticket_key: string; state: string } {
  const r = db
    .prepare("SELECT s.*, d.ticket_key FROM delivery_step s JOIN delivery d ON d.id = s.delivery_id WHERE s.id = ?")
    .get(stepId) as (Row & { ticket_key: string; state: string }) | undefined;
  if (!r) throw new NotFoundError(`delivery step ${stepId} not found`);
  return r;
}

/** pending | failed → running. Not audited: the step's outcome is (`delivery_step_finished`). */
export function startStep(db: DatabaseSync, stepId: number): void {
  withTx(db, () => {
    const s = stepRow(db, stepId);
    if (s.state !== "pending" && s.state !== "failed") throw new InvalidTransitionError(`delivery step ${stepId} is ${s.state}, not pending or failed`);
    db.prepare("UPDATE delivery_step SET state = 'running', started_at = ?, finished_at = NULL WHERE id = ?").run(new Date().toISOString(), stepId);
  });
}

/**
 * running → done | failed | not_needed; audited `delivery_step_finished`. `link`: the JIRA write / comment the step sent.
 * `result` undefined keeps the stored result (e.g. a "create attempted" marker survives a failure).
 */
export function finishStep(
  db: DatabaseSync,
  stepId: number,
  state: "done" | "failed" | "not_needed",
  detail: string,
  result: unknown,
  link?: { jiraWriteId?: number; jiraCommentId?: number },
): void {
  withTx(db, () => {
    const s = stepRow(db, stepId);
    if (s.state !== "running") throw new InvalidTransitionError(`delivery step ${stepId} is ${s.state}, not running`);
    if (link?.jiraWriteId !== undefined && !db.prepare("SELECT 1 FROM jira_write WHERE id = ? AND ticket_key = ?").get(link.jiraWriteId, s.ticket_key))
      throw new NotFoundError(`JIRA write ${link.jiraWriteId} not found for ${s.ticket_key}`);
    if (link?.jiraCommentId !== undefined && !db.prepare("SELECT 1 FROM jira_comment WHERE id = ? AND ticket_key = ?").get(link.jiraCommentId, s.ticket_key))
      throw new NotFoundError(`JIRA comment ${link.jiraCommentId} not found for ${s.ticket_key}`);
    db.prepare(
      `UPDATE delivery_step SET state = ?, detail = ?, result_json = ?, finished_at = ?,
         jira_write_id = COALESCE(?, jira_write_id), jira_comment_id = COALESCE(?, jira_comment_id) WHERE id = ?`,
    ).run(
      state, detail, result === undefined ? ((s.result_json as string | null) ?? null) : JSON.stringify(result ?? null), new Date().toISOString(),
      link?.jiraWriteId ?? null, link?.jiraCommentId ?? null, stepId,
    );
    appendAudit(db, {
      actor: "system",
      type: "delivery_step_finished",
      ticketKey: s.ticket_key,
      payload: { deliveryId: s.delivery_id, stepId, seq: s.seq, kind: s.kind, repo: s.repo, state, detail },
    });
  });
}

/** Startup recovery: steps left running by a previous process → failed (never continued). Returns the ticket keys touched. */
export function failRunningSteps(db: DatabaseSync, detail: string): string[] {
  return withTx(db, () => {
    const rows = db
      .prepare("SELECT s.id, d.ticket_key FROM delivery_step s JOIN delivery d ON d.id = s.delivery_id WHERE s.state = 'running' ORDER BY s.id")
      .all() as Array<{ id: number; ticket_key: string }>;
    for (const r of rows) finishStep(db, r.id, "failed", detail, undefined);
    return [...new Set(rows.map((r) => r.ticket_key))];
  });
}

/** A running step records a fact before an outside call (T12-1: "create attempted"), kept if the step then fails. */
export function markStep(db: DatabaseSync, stepId: number, result: unknown): void {
  withTx(db, () => {
    const s = stepRow(db, stepId);
    if (s.state !== "running") throw new InvalidTransitionError(`delivery step ${stepId} is ${s.state}, not running`);
    db.prepare("UPDATE delivery_step SET result_json = ? WHERE id = ?").run(JSON.stringify(result ?? null), stepId);
  });
}

/** pending steps of the ticket's deliveries (all, or only `kinds`) → `state` without running; audited `delivery_step_finished`. */
function closePending(db: DatabaseSync, key: string, state: "skipped" | "failed", detail: string, kinds?: readonly string[], latestOnly = false): number {
  return withTx(db, () => {
    const latest = latestOnly ? ` AND d.id = (SELECT MAX(id) FROM delivery WHERE ticket_key = d.ticket_key)` : "";
    const rows = (db
      .prepare(`SELECT s.id, s.delivery_id, s.seq, s.kind, s.repo FROM delivery_step s JOIN delivery d ON d.id = s.delivery_id WHERE d.ticket_key = ? AND s.state = 'pending'${latest} ORDER BY s.id`)
      .all(key) as Array<{ id: number; delivery_id: number; seq: number; kind: string; repo: string | null }>).filter((r) => !kinds || kinds.includes(r.kind));
    const now = new Date().toISOString();
    for (const r of rows) {
      db.prepare("UPDATE delivery_step SET state = ?, detail = ?, finished_at = ? WHERE id = ?").run(state, detail, now, r.id);
      appendAudit(db, {
        actor: "system",
        type: "delivery_step_finished",
        ticketKey: key,
        payload: { deliveryId: r.delivery_id, stepId: r.id, seq: r.seq, kind: r.kind, repo: r.repo, state, detail },
      });
    }
    return rows.length;
  });
}

/** M2: the ticket was abandoned — its pending delivery steps become skipped (a running step finishes and is recorded). */
export function skipPendingSteps(db: DatabaseSync, key: string, detail: string): number {
  return closePending(db, key, "skipped", detail);
}

/** I2: startup — pending JIRA steps of a ticket whose PRs are open are failed (never sent automatically); retryStep sends them.
 * F-1: only the latest delivery's (an older delivery was sent back or superseded; its steps are not the open PRs'). */
export function failPendingJiraSteps(db: DatabaseSync, key: string, detail: string): number {
  return closePending(db, key, "failed", detail, ["jira_status", "jira_comment"], true);
}

/** Tickets in pr_opened whose latest delivery (F-1) has a failed JIRA step (status / comment): counted for "Needs me"
 * until retried. */
const FAILED_DELIVERY_JIRA_TICKETS =
  `SELECT DISTINCT d.ticket_key FROM delivery_step s JOIN delivery d ON d.id = s.delivery_id JOIN ticket t ON t.key = d.ticket_key
   WHERE s.state = 'failed' AND s.kind IN ('jira_status', 'jira_comment') AND t.state = 'pr_opened'
     AND d.id = (SELECT MAX(id) FROM delivery WHERE ticket_key = d.ticket_key)`;

export function ticketsWithFailedJiraSteps(db: DatabaseSync): string[] {
  return (db.prepare(FAILED_DELIVERY_JIRA_TICKETS).all() as Array<{ ticket_key: string }>).map((r) => r.ticket_key);
}
