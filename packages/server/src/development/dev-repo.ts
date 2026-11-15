import type { DatabaseSync } from "node:sqlite";
import type { IterationRecord, IterationTrigger, StepRecord, StepRepoResult } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { InvalidTransitionError, NotFoundError } from "../tickets/errors.ts";

type Row = Record<string, unknown>;

const HUMAN_TRIGGERS: readonly IterationTrigger[] = ["developer_request", "rejected", "retry"];

/**
 * Start the ticket's next development iteration (only one may be running); audited `dev_iteration_started`.
 * The actor is the developer when a human trigger comes with a note or a deciding device, else the system.
 * decidedBy: 'local' or `device:<id>` when a person started it.
 */
export function startIteration(
  db: DatabaseSync,
  key: string,
  trigger: IterationTrigger,
  note: string | null,
  decidedBy: string | null = null,
): { id: number; iteration: number } {
  return withTx(db, () => {
    if (openIteration(db, key)) throw new InvalidTransitionError(`${key} already has a running development iteration`);
    const max = db.prepare("SELECT MAX(iteration) AS v FROM dev_iteration WHERE ticket_key = ?").get(key) as { v: number | null };
    const iteration = (max.v ?? 0) + 1;
    const res = db
      .prepare("INSERT INTO dev_iteration (ticket_key, iteration, trigger, note, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)")
      .run(key, iteration, trigger, note, new Date().toISOString());
    const human = HUMAN_TRIGGERS.includes(trigger) && (note !== null || decidedBy !== null);
    appendAudit(db, {
      actor: human ? "developer" : "system",
      type: "dev_iteration_started",
      ticketKey: key,
      payload: { iteration, trigger, note, ...(decidedBy !== null ? { decidedBy } : {}) },
    });
    return { id: Number(res.lastInsertRowid), iteration };
  });
}

/** The ticket's running iteration, or null. */
export function openIteration(db: DatabaseSync, key: string): { id: number; iteration: number } | null {
  const r = db
    .prepare("SELECT id, iteration FROM dev_iteration WHERE ticket_key = ? AND status = 'running' ORDER BY iteration DESC LIMIT 1")
    .get(key) as { id: number; iteration: number } | undefined;
  return r ? { id: r.id, iteration: r.iteration } : null;
}

function runningIteration(db: DatabaseSync, iterationId: number): { ticket_key: string; iteration: number } {
  const it = db.prepare("SELECT ticket_key, iteration, status FROM dev_iteration WHERE id = ?").get(iterationId) as
    | { ticket_key: string; iteration: number; status: string }
    | undefined;
  if (!it) throw new NotFoundError(`development iteration ${iterationId} not found`);
  if (it.status !== "running") throw new InvalidTransitionError(`development iteration ${iterationId} is ${it.status}`);
  return it;
}

/**
 * Record one development step of a running iteration (append-only; a step number is used once per iteration).
 * Audited `dev_step_recorded`, plus one `rule_violation` per repo whose violations are non-empty.
 */
export function addStep(db: DatabaseSync, iterationId: number, s: { step: number; summary: string; repos: StepRepoResult[] }): { id: number } {
  return withTx(db, () => {
    const it = runningIteration(db, iterationId);
    const res = db
      .prepare("INSERT INTO dev_step (iteration_id, step, summary, repos_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(iterationId, s.step, s.summary, JSON.stringify(s.repos), new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    appendAudit(db, {
      actor: "agent:implement-ticket",
      type: "dev_step_recorded",
      ticketKey: it.ticket_key,
      payload: {
        id,
        iteration: it.iteration,
        step: s.step,
        repos: s.repos.map((r) => ({ repo: r.repo, commit: r.commit.kind, pendingChanges: r.pendingChanges, violations: r.violations.length })),
      },
    });
    for (const r of s.repos) {
      if (r.violations.length === 0) continue;
      appendAudit(db, {
        actor: "system",
        type: "rule_violation",
        ticketKey: it.ticket_key,
        payload: { repo: r.repo, iteration: it.iteration, step: s.step, paths: r.violations },
      });
    }
    return { id };
  });
}

/** Close a running iteration; audited `dev_iteration_finished`. */
export function finishIteration(db: DatabaseSync, iterationId: number, status: "done" | "failed", summary: string): void {
  withTx(db, () => {
    const it = runningIteration(db, iterationId);
    db.prepare("UPDATE dev_iteration SET status = ?, summary = ?, ended_at = ? WHERE id = ?").run(status, summary, new Date().toISOString(), iterationId);
    appendAudit(db, { actor: "system", type: "dev_iteration_finished", ticketKey: it.ticket_key, payload: { iteration: it.iteration, status, summary } });
  });
}

export function listIterations(db: DatabaseSync, key: string): (IterationRecord & { steps: StepRecord[] })[] {
  const its = db.prepare("SELECT * FROM dev_iteration WHERE ticket_key = ? ORDER BY iteration").all(key) as Row[];
  const steps = db.prepare("SELECT * FROM dev_step WHERE iteration_id = ? ORDER BY step");
  return its.map((r) => ({
    id: r.id as number,
    iteration: r.iteration as number,
    trigger: r.trigger as IterationTrigger,
    note: r.note as string | null,
    status: r.status as IterationRecord["status"],
    summary: r.summary as string | null,
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string | null,
    steps: (steps.all(r.id as number) as Row[]).map((s) => ({
      id: s.id as number,
      step: s.step as number,
      summary: s.summary as string,
      repos: JSON.parse(s.repos_json as string) as StepRepoResult[],
      createdAt: s.created_at as string,
    })),
  }));
}
