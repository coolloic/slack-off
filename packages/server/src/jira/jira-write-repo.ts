import type { DatabaseSync } from "node:sqlite";
import type { JiraWriteRecord, JiraWriteState } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { InvalidTransitionError, NotFoundError } from "../tickets/errors.ts";

// The phase-2 JIRA write ("move to In Progress"): pending → confirmed | skipped by the developer;
// confirmed → done | failed | not_needed when the run ends. Nothing is written to JIRA without a confirmation.

type Row = Record<string, unknown>;

/** A write that waits for the developer's "Send to JIRA"; audited `jira_write_requested`. `detail`: a note shown with it. */
export function requestJiraWrite(
  db: DatabaseSync,
  key: string,
  targetStatus: string,
  detail: string | null = null,
  /** a developer's retry of a failed write: audited with the actor, the failed write's id and the deciding device */
  retry?: { retryOf: number; decidedBy: string },
): { id: number } {
  return withTx(db, () => {
    const res = db
      .prepare("INSERT INTO jira_write (ticket_key, target_status, state, detail, requested_at) VALUES (?, ?, 'pending', ?, ?)")
      .run(key, targetStatus, detail, new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    appendAudit(db, {
      actor: retry ? "developer" : "system",
      type: "jira_write_requested",
      ticketKey: key,
      payload: { id, targetStatus, ...(detail !== null ? { detail } : {}), ...(retry ?? {}) },
    });
    return { id };
  });
}

/** The ticket is already in the target status: nothing to ask or run. Audited `jira_write_finished` (state not_needed). */
export function recordNotNeeded(db: DatabaseSync, key: string, targetStatus: string, detail: string): { id: number } {
  return withTx(db, () => {
    const now = new Date().toISOString();
    const res = db
      .prepare("INSERT INTO jira_write (ticket_key, target_status, state, detail, requested_at, finished_at) VALUES (?, ?, 'not_needed', ?, ?, ?)")
      .run(key, targetStatus, detail, now, now);
    const id = Number(res.lastInsertRowid);
    appendAudit(db, { actor: "system", type: "jira_write_finished", ticketKey: key, payload: { id, targetStatus, state: "not_needed", detail } });
    return { id };
  });
}

export function writeRow(db: DatabaseSync, id: number): { ticket_key: string; target_status: string; state: JiraWriteState } {
  const r = db.prepare("SELECT ticket_key, target_status, state FROM jira_write WHERE id = ?").get(id) as
    | { ticket_key: string; target_status: string; state: JiraWriteState }
    | undefined;
  if (!r) throw new NotFoundError(`JIRA write ${id} not found`);
  return r;
}

/** The developer's decision on a pending write; audited `jira_write_decided`. decidedBy: 'local' or `device:<id>`. */
export function decideJiraWrite(db: DatabaseSync, id: number, decision: "confirmed" | "skipped", decidedBy: string): void {
  withTx(db, () => {
    const w = writeRow(db, id);
    if (w.state !== "pending") throw new InvalidTransitionError(`JIRA write ${id} is ${w.state}, not pending`);
    db.prepare("UPDATE jira_write SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(decision, decidedBy, new Date().toISOString(), id);
    appendAudit(db, {
      actor: "developer",
      type: "jira_write_decided",
      ticketKey: w.ticket_key,
      payload: { id, targetStatus: w.target_status, decision, decidedBy },
    });
  });
}

/** The outcome of a confirmed write; audited `jira_write_finished`. */
export function finishJiraWrite(db: DatabaseSync, id: number, state: "done" | "failed" | "not_needed", detail: string, result: unknown): void {
  withTx(db, () => {
    const w = writeRow(db, id);
    if (w.state !== "confirmed") throw new InvalidTransitionError(`JIRA write ${id} is ${w.state}, not confirmed`);
    db.prepare("UPDATE jira_write SET state = ?, detail = ?, result_json = ?, finished_at = ? WHERE id = ?").run(
      state,
      detail,
      JSON.stringify(result ?? null),
      new Date().toISOString(),
      id,
    );
    appendAudit(db, { actor: "system", type: "jira_write_finished", ticketKey: w.ticket_key, payload: { id, targetStatus: w.target_status, state, detail } });
  });
}

/** F2-I3: the detail of writes skipped because their ticket was abandoned. */
export const ABANDONED_WRITE = "ticket abandoned";

/**
 * F2-I3: the ticket was abandoned — its pending writes and its confirmed writes not yet being sent (`isSending` false)
 * become skipped with detail "ticket abandoned"; audited `jira_write_skipped` with who abandoned. Returns the ids.
 */
export function skipJiraWritesOnAbandon(db: DatabaseSync, key: string, decidedBy: string, isSending: (id: number) => boolean): number[] {
  return withTx(db, () => {
    const rows = db
      .prepare("SELECT id, target_status, state FROM jira_write WHERE ticket_key = ? AND state IN ('pending', 'confirmed') ORDER BY id")
      .all(key) as Array<{ id: number; target_status: string; state: "pending" | "confirmed" }>;
    const ids: number[] = [];
    const now = new Date().toISOString();
    for (const r of rows) {
      if (r.state === "confirmed" && isSending(r.id)) continue;
      if (r.state === "pending") {
        db.prepare("UPDATE jira_write SET state = 'skipped', detail = ?, decided_by = ?, decided_at = ?, finished_at = ? WHERE id = ?").run(
          ABANDONED_WRITE, decidedBy, now, now, r.id,
        );
      } else {
        db.prepare("UPDATE jira_write SET state = 'skipped', detail = ?, finished_at = ? WHERE id = ?").run(ABANDONED_WRITE, now, r.id);
      }
      appendAudit(db, {
        actor: "developer",
        type: "jira_write_skipped",
        ticketKey: key,
        payload: { id: r.id, targetStatus: r.target_status, from: r.state, detail: ABANDONED_WRITE, decidedBy },
      });
      ids.push(r.id);
    }
    return ids;
  });
}

export function listJiraWrites(db: DatabaseSync, key: string): JiraWriteRecord[] {
  const rows = db.prepare("SELECT * FROM jira_write WHERE ticket_key = ? ORDER BY id").all(key) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    targetStatus: r.target_status as string,
    state: r.state as JiraWriteState,
    detail: r.detail as string | null,
    result: r.result_json === null ? null : (JSON.parse(r.result_json as string) as unknown),
    decidedBy: r.decided_by as string | null,
    requestedAt: r.requested_at as string,
    decidedAt: r.decided_at as string | null,
    finishedAt: r.finished_at as string | null,
    jiraSource: (r.jira_source ?? null) as JiraWriteRecord["jiraSource"],
  }));
}

/** F4B-4: the JIRA mode a confirmed write is being sent in (set by its job, inside the job's pinned mode). */
export function recordJiraWriteSource(db: DatabaseSync, id: number, source: "browser" | "api"): void {
  db.prepare("UPDATE jira_write SET jira_source = ? WHERE id = ? AND state = 'confirmed'").run(source, id);
}

/** Startup recovery: a confirmed write that never finished belonged to a previous process. It is failed, never re-sent
 * (the browser may or may not have changed JIRA); returns the ticket keys touched. */
export function failInterruptedJiraWrites(db: DatabaseSync, detail: string): string[] {
  const rows = db.prepare("SELECT id, ticket_key FROM jira_write WHERE state = 'confirmed' ORDER BY id").all() as Array<{ id: number; ticket_key: string }>;
  for (const r of rows) finishJiraWrite(db, r.id, "failed", detail, null);
  return [...new Set(rows.map((r) => r.ticket_key))];
}
