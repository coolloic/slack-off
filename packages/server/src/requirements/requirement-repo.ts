import type { DatabaseSync } from "node:sqlite";
import { StoredSolution, type Requirement, type Solution } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { ValidationError } from "../tickets/errors.ts";
import { choiceFeatures } from "../preferences/derive.ts";
import { recordSignal } from "../preferences/preference-repo.ts";

export interface RequirementRecord {
  id: number;
  ticketKey: string;
  snapshotId: number;
  version: number;
  content: Requirement;
  draftComment: string | null;
  source: "agent" | "human";
  createdAt: string;
}

export interface SolutionRecord {
  id: number;
  ticketKey: string;
  requirementId: number;
  idx: number;
  /** Phase-1 rows lack affectedRepos/repoChanges; they read back as []. */
  content: StoredSolution;
}

type Row = Record<string, unknown>;

function toReq(r: Row): RequirementRecord {
  return {
    id: r.id as number,
    ticketKey: r.ticket_key as string,
    snapshotId: r.snapshot_id as number,
    version: r.version as number,
    content: JSON.parse(r.content_json as string) as Requirement,
    draftComment: r.draft_comment as string | null,
    source: r.source as "agent" | "human",
    createdAt: r.created_at as string,
  };
}

export function addRequirement(
  db: DatabaseSync,
  key: string,
  snapshotId: number,
  r: Requirement,
  source: "agent" | "human",
): { id: number; version: number } {
  return withTx(db, () => {
    const max = db.prepare("SELECT MAX(version) AS v FROM requirement WHERE ticket_key = ?").get(key) as { v: number | null };
    const version = (max.v ?? 0) + 1;
    const res = db
      .prepare("INSERT INTO requirement (ticket_key, snapshot_id, version, content_json, draft_comment, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(key, snapshotId, version, JSON.stringify(r), r.draftComment, source, new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    const ins = db.prepare(
      "INSERT INTO ac_trace (requirement_id, ac_id, snapshot_id, source_type, source_ref, quote, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const ac of r.acceptanceCriteria) {
      const s = ac.source;
      if (s.type === "developer") ins.run(id, ac.id, snapshotId, "developer", null, null, s.reason);
      else ins.run(id, ac.id, snapshotId, s.type, s.ref, s.quote, null);
    }
    appendAudit(db, {
      actor: source === "agent" ? "agent:refine-ticket" : "developer",
      type: "requirement_saved",
      ticketKey: key,
      payload: { version, source, acCount: r.acceptanceCriteria.length },
    });
    return { id, version };
  });
}

export function latestRequirement(db: DatabaseSync, key: string): RequirementRecord | null {
  const r = db.prepare("SELECT * FROM requirement WHERE ticket_key = ? ORDER BY version DESC LIMIT 1").get(key) as Row | undefined;
  return r ? toReq(r) : null;
}

export function firstRequirement(db: DatabaseSync, key: string): RequirementRecord | null {
  const r = db.prepare("SELECT * FROM requirement WHERE ticket_key = ? ORDER BY version ASC LIMIT 1").get(key) as Row | undefined;
  return r ? toReq(r) : null;
}

export function getRequirement(db: DatabaseSync, id: number): RequirementRecord | null {
  const r = db.prepare("SELECT * FROM requirement WHERE id = ?").get(id) as Row | undefined;
  return r ? toReq(r) : null;
}

export function saveSolutions(db: DatabaseSync, key: string, requirementId: number, s: Solution[]): void {
  withTx(db, () => {
    const ins = db.prepare("INSERT INTO solution (ticket_key, requirement_id, idx, content_json) VALUES (?, ?, ?, ?)");
    const saved = s.map((sol, i) => ({ id: Number(ins.run(key, requirementId, i, JSON.stringify(sol)).lastInsertRowid), title: sol.title }));
    appendAudit(db, { actor: "agent:propose-solutions", type: "solutions_saved", ticketKey: key, payload: { requirementId, solutions: saved } });
  });
}

/** One stored solution by id (any batch), or null. */
export function getSolution(db: DatabaseSync, id: number): SolutionRecord | null {
  const r = db.prepare("SELECT * FROM solution WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id as number,
    ticketKey: r.ticket_key as string,
    requirementId: r.requirement_id as number,
    idx: r.idx as number,
    content: StoredSolution.parse(JSON.parse(r.content_json as string)),
  };
}

/** Solutions of the ticket's latest requirement, latest batch only (a regenerate restarts at idx=0). */
export function listSolutions(db: DatabaseSync, key: string): SolutionRecord[] {
  const req = latestRequirement(db, key);
  if (!req) return [];
  const start = db
    .prepare("SELECT MAX(id) AS id FROM solution WHERE ticket_key = ? AND requirement_id = ? AND idx = 0")
    .get(key, req.id) as { id: number | null };
  if (start.id === null) return [];
  const rows = db
    .prepare("SELECT * FROM solution WHERE ticket_key = ? AND requirement_id = ? AND id >= ? ORDER BY idx")
    .all(key, req.id, start.id) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    ticketKey: r.ticket_key as string,
    requirementId: r.requirement_id as number,
    idx: r.idx as number,
    content: StoredSolution.parse(JSON.parse(r.content_json as string)),
  }));
}

/**
 * Record the developer's choice. affectedRepos is the set of repos locked on the choice (null for phase-1 style calls
 * and rows); it can only change by choosing again. decidedBy: 'local' or `device:<id>` (null when unknown).
 */
export function recordChoice(
  db: DatabaseSync,
  key: string,
  solutionId: number,
  note: string,
  affectedRepos: string[] | null = null,
  decidedBy: string | null = null,
  skipDebate = false,
): void {
  withTx(db, () => {
    const all = listSolutions(db, key);
    const sol = all.find((x) => x.id === solutionId);
    if (!sol) throw new ValidationError(`solution ${solutionId} is not in the current solution set of ${key}`);
    if (affectedRepos !== null && (affectedRepos.length === 0 || new Set(affectedRepos).size !== affectedRepos.length))
      throw new ValidationError("affected repos must be a non-empty list of distinct repo names");
    const res = db.prepare(
      "INSERT INTO choice (ticket_key, solution_id, requirement_id, note, affected_repos_json, skip_debate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(key, solutionId, sol.requirementId, note, affectedRepos === null ? null : JSON.stringify(affectedRepos), skipDebate ? 1 : 0, new Date().toISOString());
    // the solution's own set is audited next to the chosen one: the developer may have edited it
    appendAudit(db, {
      actor: "developer", type: "choice_recorded", ticketKey: key, payload: { solutionId, note, affectedRepos, solutionAffectedRepos: sol.content.affectedRepos, decidedBy, skipDebate },
    });
    // phase 4d (§9.4): the choice's features, in the same transaction (both or neither)
    recordSignal(db, key, Number(res.lastInsertRowid), choiceFeatures(sol.content, all.map((x) => x.content), note, affectedRepos));
  });
}

export interface CurrentChoice {
  id: number;
  solutionId: number;
  requirementId: number;
  note: string | null;
  /** null for phase-1 choices (and 4-argument recordChoice calls) */
  affectedRepos: string[] | null;
  /** the design is final as the designer writes it, no critic rounds */
  skipDebate: boolean;
  createdAt: string;
}

/** The ticket's latest choice, or null. */
export function currentChoice(db: DatabaseSync, key: string): CurrentChoice | null {
  const r = db
    .prepare("SELECT id, solution_id, requirement_id, note, affected_repos_json, skip_debate, created_at FROM choice WHERE ticket_key = ? ORDER BY id DESC LIMIT 1")
    .get(key) as Row | undefined;
  if (!r) return null;
  return {
    id: r.id as number,
    solutionId: r.solution_id as number,
    requirementId: r.requirement_id as number,
    note: r.note as string | null,
    affectedRepos: r.affected_repos_json === null ? null : (JSON.parse(r.affected_repos_json as string) as string[]),
    skipDebate: r.skip_debate === 1,
    createdAt: r.created_at as string,
  };
}
