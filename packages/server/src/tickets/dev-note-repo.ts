import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { ValidationError } from "./errors.ts";
import type { AnswerOption } from "@slackoff/shared";

export const DEV_NOTE_MAX = 2000;

/**
 * The developer's answers on Retry (to the developer agent's needsInput question, or anything it should know before
 * the next step), in order; the developer agent gets them with every later step. Every answer is audited.
 */
export function addDevNote(db: DatabaseSync, ticketKey: string, note: string, decidedBy: string): void {
  const text = note.trim();
  if (text === "") return;
  if (text.length > DEV_NOTE_MAX) throw new ValidationError(`the note is longer than ${DEV_NOTE_MAX} characters`);
  withTx(db, () => {
    const at = new Date().toISOString();
    db.prepare("INSERT INTO dev_note (ticket_key, note, decided_by, created_at) VALUES (?, ?, ?, ?)").run(ticketKey, text, decidedBy, at);
    appendAudit(db, { actor: "developer", type: "developer_note_added", ticketKey, payload: { note: text, decidedBy } });
  });
}

export function listDevNotes(db: DatabaseSync, ticketKey: string): Array<{ at: string; text: string }> {
  return (db.prepare("SELECT note, created_at FROM dev_note WHERE ticket_key = ? ORDER BY id").all(ticketKey) as Array<{ note: string; created_at: string }>).map(
    (r) => ({ at: r.created_at, text: r.note }),
  );
}

/** The developer agent's open question (needsInput) and its suggested answers; replaced by a newer one. */
export function setDevQuestion(db: DatabaseSync, ticketKey: string, question: string, options: readonly AnswerOption[]): void {
  db.prepare(
    "INSERT INTO dev_question (ticket_key, question, options_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (ticket_key) DO UPDATE SET question = excluded.question, options_json = excluded.options_json, created_at = excluded.created_at",
  ).run(ticketKey, question, JSON.stringify(options), new Date().toISOString());
}

export function devQuestion(db: DatabaseSync, ticketKey: string): { question: string; options: AnswerOption[] } | null {
  const r = db.prepare("SELECT question, options_json FROM dev_question WHERE ticket_key = ?").get(ticketKey) as { question: string; options_json: string } | undefined;
  return r ? { question: r.question, options: JSON.parse(r.options_json) as AnswerOption[] } : null;
}

/** A Retry answers (or sets aside) the question. */
export function clearDevQuestion(db: DatabaseSync, ticketKey: string): void {
  db.prepare("DELETE FROM dev_question WHERE ticket_key = ?").run(ticketKey);
}
