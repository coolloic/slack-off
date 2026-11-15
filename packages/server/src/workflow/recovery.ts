import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { recoverJiraComments } from "../jira/jira-comment-jobs.ts";
import { INTERRUPTED_WRITE, recoverJiraWrites } from "../jira/jira-write-jobs.ts";
import { DELIVERY_INTERRUPTED, JIRA_STEP_NOT_SENT } from "../delivery/delivery-jobs.ts";
import { failPendingJiraSteps, failRunningSteps } from "../delivery/delivery-repo.ts";
import { transition } from "../tickets/state-machine.ts";
import { listTickets } from "../tickets/ticket-repo.ts";
import type { Workflow } from "./jobs.ts";
import { logError } from "../log.ts";
import { failInterruptedExports } from "../telemetry/export-repo.ts";

const WORKING = new Set(["refining", "refined", "proposing", "checking_drift", "designing", "design_final", "checking_snapshot", "developing", "reviewing"]);

export const INTERRUPTED_BY_RESTART = "interrupted by restart";

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * F4C-1 (I-2): a run left running by a previous process ended, at the latest, when its raw log was last written; without
 * a readable log, at its start. Never at the restart: the downtime is not run time (it would count against maxRunMinutes).
 */
function closeInterruptedRuns(db: DatabaseSync): void {
  const now = Date.now() + 1000;
  const rows = db.prepare("SELECT id, raw_log_path, started_at FROM agent_run WHERE status = 'running'").all() as Array<{ id: string; raw_log_path: string | null; started_at: string }>;
  const close = db.prepare("UPDATE agent_run SET status = 'error', error = ?, ended_at = ? WHERE id = ? AND status = 'running'");
  for (const r of rows) {
    const start = Date.parse(r.started_at);
    let ended = r.started_at;
    try {
      const m = r.raw_log_path === null ? NaN : statSync(r.raw_log_path).mtimeMs;
      // a last write before the start or in the future (clock change) is not believed
      if (!Number.isNaN(start) && Number.isFinite(m) && m >= start && m <= now) ended = new Date(m).toISOString();
    } catch {
      // no log (or unreadable): the run is closed at its start
    }
    close.run(INTERRUPTED_BY_RESTART, ended, r.id);
  }
}

/**
 * Startup recovery (H2):
 * 1. agent runs still 'running' belong to a previous process: mark them 'error' ("interrupted by restart"), ended at their
 *    raw log's last write or else their start (F4C-1 I-2);
 * 2. continue tickets left in a working state:
 *    refining -> refine, refined -> review/propose decision, proposing -> propose, checking_drift -> drift check,
 *    designing -> the design job (its next step is derived from the stored debate),
 *    design_final -> afterDesignFinal again (it is not durable), checking_snapshot -> the snapshot re-read (Task 10),
 *    developing -> the development job (an unrecorded, interrupted step is discarded in the worktrees, Task 11),
 *    reviewing -> the acceptance job (phase 3 Task 9): first, every acceptance run still marked running has its
 *    leftover processes killed (only those carrying its run root), its run root removed and is closed 'interrupted';
 *    the job then derives its step from stored data, so the unsaved run does not count as an attempt.
 *    A ticket whose resume throws is logged and blocked with the error; the others still resume.
 * 3. a confirmed JIRA write or comment that never finished is failed ("interrupted by restart — retry to send again"),
 *    never re-sent: whether the browser changed JIRA is unknown (Task 12; phase 3 Task 10 for comments).
 * 4. phase 3 Task 12: delivery steps left running are failed (never continued), and a ticket left delivering is
 *    blocked ("delivery interrupted by restart — Retry to continue"): Retry continues from the first unfinished step;
 *    pending JIRA steps of a ticket whose PRs are open are failed ("not sent — …"), sent only by the developer's retry.
 */
export function recoverOnStartup(db: DatabaseSync, wf: Workflow): void {
  closeInterruptedRuns(db);
  try {
    wf.recoverAcceptanceRuns();
  } catch (err) {
    logError(`Recovery: could not stop interrupted acceptance runs: ${errMessage(err)}`);
  }
  try {
    recoverJiraWrites(db);
  } catch (err) {
    logError(`Recovery: could not close interrupted JIRA writes: ${errMessage(err)}`);
  }
  try {
    recoverJiraComments(db);
  } catch (err) {
    logError(`Recovery: could not close interrupted JIRA comments: ${errMessage(err)}`);
  }
  try {
    failRunningSteps(db, INTERRUPTED_WRITE);
  } catch (err) {
    logError(`Recovery: could not close interrupted delivery steps: ${errMessage(err)}`);
  }
  // phase 4c Task 5: an OTLP export left running is failed, never resent (the collector may already have it)
  try {
    failInterruptedExports(db);
  } catch (err) {
    logError(`Recovery: could not close interrupted run-tracing exports: ${errMessage(err)}`);
  }
  for (const t of listTickets(db)) {
    // I2: JIRA steps that never started are not sent by themselves either: the developer retries them
    if (t.state === "pr_opened") {
      try {
        failPendingJiraSteps(db, t.key, JIRA_STEP_NOT_SENT);
      } catch (err) {
        logError(`Recovery: could not close the JIRA steps of ${t.key}: ${errMessage(err)}`);
      }
      continue;
    }
    if (t.state === "delivering") {
      try {
        transition(db, t.key, "blocked", "system", DELIVERY_INTERRUPTED);
      } catch (err) {
        logError(`Recovery: could not block ${t.key}: ${errMessage(err)}`);
      }
      continue;
    }
    if (!WORKING.has(t.state)) continue;
    try {
      wf.resume(t.key);
    } catch (err) {
      const message = errMessage(err);
      logError(`Recovery: could not resume ${t.key}: ${message}`);
      try {
        transition(db, t.key, "blocked", "system", `Recovery failed: ${message}`);
      } catch (blockErr) {
        logError(`Recovery: could not mark ${t.key} blocked: ${errMessage(blockErr)}`);
      }
    }
  }
}
