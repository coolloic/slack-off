import type { DatabaseSync } from "node:sqlite";
import type { CommentResponse, Critique, DebateRoundRecord, DesignDoc, Ruling, RulingRecord, DebateAdvice } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../tickets/errors.ts";

export interface DesignDocRecord {
  id: number;
  version: number;
  choiceId: number;
  requirementId: number;
  doc: DesignDoc;
  isFinal: boolean;
  createdAt: string;
}

type Row = Record<string, unknown>;

/** Save the next design doc version of the ticket (append-only); audited `design_doc_saved`. */
export function addDesignDoc(
  db: DatabaseSync,
  key: string,
  d: { requirementId: number; choiceId: number; doc: DesignDoc },
): { id: number; version: number } {
  return withTx(db, () => {
    const max = db.prepare("SELECT MAX(version) AS v FROM design_doc WHERE ticket_key = ?").get(key) as { v: number | null };
    const version = (max.v ?? 0) + 1;
    const res = db
      .prepare(
        "INSERT INTO design_doc (ticket_key, requirement_id, choice_id, version, content_json, checklist_json, responses_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        key,
        d.requirementId,
        d.choiceId,
        version,
        JSON.stringify({ contentMd: d.doc.contentMd, repos: d.doc.repos }),
        JSON.stringify(d.doc.checklist),
        JSON.stringify(d.doc.responses),
        new Date().toISOString(),
      );
    const id = Number(res.lastInsertRowid);
    appendAudit(db, {
      actor: "agent:design-solution",
      type: "design_doc_saved",
      ticketKey: key,
      payload: { id, version, choiceId: d.choiceId, requirementId: d.requirementId, responses: d.doc.responses.length },
    });
    return { id, version };
  });
}

function toDoc(r: Row): DesignDocRecord {
  const content = JSON.parse(r.content_json as string) as Pick<DesignDoc, "contentMd" | "repos">;
  return {
    id: r.id as number,
    version: r.version as number,
    choiceId: r.choice_id as number,
    requirementId: r.requirement_id as number,
    doc: {
      contentMd: content.contentMd,
      repos: content.repos,
      checklist: JSON.parse(r.checklist_json as string) as DesignDoc["checklist"],
      responses: JSON.parse(r.responses_json as string) as CommentResponse[],
    },
    isFinal: r.is_final === 1,
    createdAt: r.created_at as string,
  };
}

export function listDesignDocs(db: DatabaseSync, key: string): DesignDocRecord[] {
  return (db.prepare("SELECT * FROM design_doc WHERE ticket_key = ? ORDER BY version").all(key) as Row[]).map(toDoc);
}

/** Mark a design doc final (the only change a design doc allows); audited `design_finalized`. Already final → no-op. */
export function markFinal(db: DatabaseSync, key: string, docId: number): void {
  withTx(db, () => {
    const r = db.prepare("SELECT version, is_final FROM design_doc WHERE id = ? AND ticket_key = ?").get(docId, key) as
      | { version: number; is_final: number }
      | undefined;
    if (!r) throw new NotFoundError(`design doc ${docId} of ${key} not found`);
    if (r.is_final === 1) return;
    db.prepare("UPDATE design_doc SET is_final = 1 WHERE id = ?").run(docId);
    appendAudit(db, { actor: "system", type: "design_finalized", ticketKey: key, payload: { id: docId, version: r.version } });
  });
}

/** Record one debate round (append-only); audited `debate_round_recorded`. */
export function addRound(
  db: DatabaseSync,
  key: string,
  r: { choiceId: number; designDocId: number; round: number; role: "designer" | "critic"; content: Critique | { responses: CommentResponse[] } },
): { id: number } {
  return withTx(db, () => {
    const d = db.prepare("SELECT 1 FROM design_doc WHERE id = ? AND ticket_key = ?").get(r.designDocId, key);
    if (!d) throw new NotFoundError(`design doc ${r.designDocId} of ${key} not found`);
    const res = db
      .prepare("INSERT INTO debate_round (ticket_key, choice_id, design_doc_id, round, role, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(key, r.choiceId, r.designDocId, r.round, r.role, JSON.stringify(r.content), new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    const counts =
      "comments" in r.content
        ? { comments: r.content.comments.length, blocking: r.content.comments.filter((c) => c.blocking).length }
        : { responses: r.content.responses.length };
    appendAudit(db, {
      actor: r.role === "critic" ? "agent:critique-design" : "agent:design-solution",
      type: "debate_round_recorded",
      ticketKey: key,
      payload: { id, round: r.round, role: r.role, choiceId: r.choiceId, designDocId: r.designDocId, ...counts },
    });
    return { id };
  });
}

function toRound(r: Row): DebateRoundRecord {
  return {
    id: r.id as number,
    choiceId: r.choice_id as number,
    designDocId: r.design_doc_id as number,
    round: r.round as number,
    role: r.role as "designer" | "critic",
    content: JSON.parse(r.content_json as string) as DebateRoundRecord["content"],
    createdAt: r.created_at as string,
  };
}

export function listRounds(db: DatabaseSync, key: string, choiceId?: number): DebateRoundRecord[] {
  const rows =
    choiceId === undefined
      ? (db.prepare("SELECT * FROM debate_round WHERE ticket_key = ? ORDER BY id").all(key) as Row[])
      : (db.prepare("SELECT * FROM debate_round WHERE ticket_key = ? AND choice_id = ? ORDER BY id").all(key, choiceId) as Row[]);
  return rows.map(toRound);
}

/**
 * Store the developer's rulings on a critic round's comments, one `debate_ruling` audit each.
 * A round can be ruled once: a second submission throws InvalidTransitionError. The submission must rule every
 * blocking comment of the round exactly once (non-blocking ones may be ruled too); otherwise ValidationError.
 * decidedBy: 'local' or `device:<id>`.
 */
export function saveRulings(db: DatabaseSync, key: string, roundId: number, rulings: Ruling[], decidedBy: string): void {
  withTx(db, () => {
    const round = db.prepare("SELECT role, content_json FROM debate_round WHERE id = ? AND ticket_key = ?").get(roundId, key) as
      | { role: string; content_json: string }
      | undefined;
    if (!round) throw new NotFoundError(`debate round ${roundId} of ${key} not found`);
    if (round.role !== "critic") throw new ValidationError(`debate round ${roundId} is not a critic round`);
    if (db.prepare("SELECT 1 FROM debate_ruling WHERE debate_round_id = ?").get(roundId))
      throw new InvalidTransitionError(`debate round ${roundId} was already ruled`);
    const comments = (JSON.parse(round.content_json) as Critique).comments;
    const ids = new Set(comments.map((c) => c.id));
    const given = rulings.map((r) => r.commentId);
    const unknown = given.filter((id) => !ids.has(id));
    if (unknown.length) throw new ValidationError(`unknown comments in round ${roundId}: ${unknown.join(", ")}`);
    const twice = [...new Set(given.filter((id, i) => given.indexOf(id) !== i))];
    if (twice.length) throw new ValidationError(`more than one ruling for: ${twice.join(", ")}`);
    const missing = comments.filter((c) => c.blocking && !given.includes(c.id)).map((c) => c.id);
    if (missing.length) throw new ValidationError(`every blocking comment needs a ruling; missing: ${missing.join(", ")}`);
    const now = new Date().toISOString();
    const ins = db.prepare(
      "INSERT INTO debate_ruling (ticket_key, debate_round_id, comment_id, decision, note, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of rulings) {
      const id = Number(ins.run(key, roundId, r.commentId, r.decision, r.note, decidedBy, now).lastInsertRowid);
      appendAudit(db, {
        actor: "developer",
        type: "debate_ruling",
        ticketKey: key,
        payload: { id, roundId, commentId: r.commentId, decision: r.decision, note: r.note, decidedBy },
      });
    }
  });
}

export function listRulings(db: DatabaseSync, key: string): RulingRecord[] {
  const rows = db.prepare("SELECT * FROM debate_ruling WHERE ticket_key = ? ORDER BY id").all(key) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    debateRoundId: r.debate_round_id as number,
    commentId: r.comment_id as string,
    decision: r.decision as RulingRecord["decision"],
    note: r.note as string,
    decidedBy: r.decided_by as string,
    createdAt: r.created_at as string,
  }));
}

/** The arbiter's recommendations for one escalated critic round (replaces earlier ones for that round). */
export function saveDebateAdvice(db: DatabaseSync, choiceId: number, roundId: number, advice: readonly DebateAdvice[]): void {
  withTx(db, () => {
    db.prepare("DELETE FROM debate_advice WHERE choice_id = ? AND round_id = ?").run(choiceId, roundId);
    const now = new Date().toISOString();
    for (const a of advice) {
      db.prepare("INSERT INTO debate_advice (choice_id, round_id, comment_id, decision, note, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        choiceId, roundId, a.commentId, a.decision, a.note, a.reason, now,
      );
    }
  });
}

/** The recommendations for the choice's latest escalated round, in the disagreements' order of insertion. */
export function debateAdvice(db: DatabaseSync, choiceId: number): DebateAdvice[] {
  const last = db.prepare("SELECT MAX(round_id) AS r FROM debate_advice WHERE choice_id = ?").get(choiceId) as { r: number | null };
  if (last.r === null) return [];
  return (
    db.prepare("SELECT comment_id, decision, note, reason FROM debate_advice WHERE choice_id = ? AND round_id = ? ORDER BY rowid").all(choiceId, last.r) as Array<{
      comment_id: string; decision: DebateAdvice["decision"]; note: string; reason: string;
    }>
  ).map((r) => ({ commentId: r.comment_id, decision: r.decision, note: r.note, reason: r.reason }));
}
