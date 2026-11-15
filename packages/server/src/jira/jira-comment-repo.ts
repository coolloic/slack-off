import type { DatabaseSync } from "node:sqlite";
import type { JiraCommentRecord, JiraWriteState } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { InvalidTransitionError, NotFoundError } from "../tickets/errors.ts";

// A JIRA comment the platform posts for the developer (a clarification question, or the delivery note):
// pending → confirmed (the developer's send) → done | failed | not_needed; pending | confirmed → skipped on abandon.
// Nothing is posted without a confirmation; a failed comment is never re-sent automatically.

type Row = Record<string, unknown>;

/** decidedBy non-null = the developer's send confirmation (state confirmed); null = waits (pending). Audited `jira_comment_requested`. */
export function requestComment(
  db: DatabaseSync,
  key: string,
  purpose: JiraCommentRecord["purpose"],
  text: string,
  decidedBy: string | null,
): { id: number } {
  return withTx(db, () => {
    const now = new Date().toISOString();
    const state = decidedBy !== null ? "confirmed" : "pending";
    const res = db
      .prepare("INSERT INTO jira_comment (ticket_key, purpose, text, state, decided_by, requested_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(key, purpose, text, state, decidedBy, now, decidedBy !== null ? now : null);
    const id = Number(res.lastInsertRowid);
    appendAudit(db, {
      actor: decidedBy !== null ? "developer" : "system",
      type: "jira_comment_requested",
      ticketKey: key,
      payload: { id, purpose, text, state, decidedBy },
    });
    return { id };
  });
}

function commentRow(db: DatabaseSync, id: number): { ticket_key: string; purpose: string; state: JiraWriteState } {
  const r = db.prepare("SELECT ticket_key, purpose, state FROM jira_comment WHERE id = ?").get(id) as
    | { ticket_key: string; purpose: string; state: JiraWriteState }
    | undefined;
  if (!r) throw new NotFoundError(`JIRA comment ${id} not found`);
  return r;
}

/** The outcome of a confirmed comment; audited `jira_comment_finished`. */
export function finishComment(db: DatabaseSync, id: number, state: "done" | "failed" | "not_needed", detail: string, result: unknown): void {
  withTx(db, () => {
    const c = commentRow(db, id);
    if (c.state !== "confirmed") throw new InvalidTransitionError(`JIRA comment ${id} is ${c.state}, not confirmed`);
    db.prepare("UPDATE jira_comment SET state = ?, detail = ?, result_json = ?, finished_at = ? WHERE id = ?").run(
      state, detail, JSON.stringify(result ?? null), new Date().toISOString(), id,
    );
    appendAudit(db, { actor: "system", type: "jira_comment_finished", ticketKey: c.ticket_key, payload: { id, purpose: c.purpose, state, detail } });
  });
}

export function listComments(db: DatabaseSync, key: string): JiraCommentRecord[] {
  const rows = db.prepare("SELECT * FROM jira_comment WHERE ticket_key = ? ORDER BY id").all(key) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    purpose: r.purpose as JiraCommentRecord["purpose"],
    text: r.text as string,
    state: r.state as JiraWriteState,
    detail: r.detail as string | null,
    decidedBy: r.decided_by as string | null,
    requestedAt: r.requested_at as string,
    decidedAt: r.decided_at as string | null,
    finishedAt: r.finished_at as string | null,
    jiraSource: (r.jira_source ?? null) as JiraCommentRecord["jiraSource"],
  }));
}

/** F4B-4: the JIRA mode a confirmed comment is being sent in (set by its job, inside the job's pinned mode). */
export function recordCommentSource(db: DatabaseSync, id: number, source: "browser" | "api"): void {
  db.prepare("UPDATE jira_comment SET jira_source = ? WHERE id = ? AND state = 'confirmed'").run(source, id);
}

/** Startup recovery: a confirmed comment that never finished belonged to a previous process → failed, never re-sent. */
export function failInterruptedComments(db: DatabaseSync, detail: string): string[] {
  return withTx(db, () => {
    const rows = db.prepare("SELECT id, ticket_key FROM jira_comment WHERE state = 'confirmed' ORDER BY id").all() as Array<{ id: number; ticket_key: string }>;
    for (const r of rows) finishComment(db, r.id, "failed", detail, null);
    return [...new Set(rows.map((r) => r.ticket_key))];
  });
}

/**
 * The ticket was abandoned: its pending comments and its confirmed comments not yet being sent (`isSending` false)
 * become skipped (as skipJiraWritesOnAbandon); audited `jira_comment_finished` (state skipped). Returns how many.
 */
export function skipPendingComments(db: DatabaseSync, key: string, detail: string, isSending: (id: number) => boolean = () => false): number {
  return withTx(db, () => {
    const rows = db
      .prepare("SELECT id, purpose, state FROM jira_comment WHERE ticket_key = ? AND state IN ('pending', 'confirmed') ORDER BY id")
      .all(key) as Array<{ id: number; purpose: string; state: "pending" | "confirmed" }>;
    const now = new Date().toISOString();
    let n = 0;
    for (const r of rows) {
      if (r.state === "confirmed" && isSending(r.id)) continue;
      db.prepare("UPDATE jira_comment SET state = 'skipped', detail = ?, finished_at = ? WHERE id = ?").run(detail, now, r.id);
      appendAudit(db, { actor: "system", type: "jira_comment_finished", ticketKey: key, payload: { id: r.id, purpose: r.purpose, from: r.state, state: "skipped", detail } });
      n++;
    }
    return n;
  });
}
