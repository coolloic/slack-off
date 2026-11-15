// The optional JIRA "In Progress" write flow (Task 12). Off unless config.jira.syncStatus. When development starts, a
// pending write is recorded (or not_needed when JIRA already shows the target status); only the developer's
// confirmation — from this computer or a paired phone, recorded as decidedBy — enqueues the jira-update run
// `jira-write:<id>`. A `changed` report is verified with a read-only fetch before it counts as done. Whatever happens,
// the ticket's platform state is never touched and development never waits for JIRA.
import type { DatabaseSync } from "node:sqlite";
import type { JiraUpdateResult, JiraWriteRecord } from "@slackoff/shared";
import { isValidReadyForDevStatus, type Config } from "../config.ts";
import { withTx } from "../db/tx.ts";
import { AgentInterruptedError } from "../executor/types.ts";
import type { EventBus } from "../http/events.ts";
import type { RepoContext } from "../projects/project-rules.ts";
import { InvalidTransitionError, NotFoundError } from "../tickets/errors.ts";
import { getTicket, setJiraStatus } from "../tickets/ticket-repo.ts";
import type { JobQueue } from "../workflow/queue.ts";
import {
  decideJiraWrite, failInterruptedJiraWrites, finishJiraWrite, listJiraWrites, recordJiraWriteSource, recordNotNeeded, requestJiraWrite, skipJiraWritesOnAbandon, writeRow,
} from "./jira-write-repo.ts";
import type { JiraUpdater } from "./jira-updater.ts";
import { isSourceError, jiraLoginMessage, jiraWriter, type JiraMode, type TicketSource } from "./ticket-source.ts";
import { describeError, logError } from "../log.ts";

export const INTERRUPTED_WRITE = "interrupted by restart — retry to send again";

export interface JiraWriteDeps {
  db: DatabaseSync;
  queue: JobQueue;
  bus: EventBus;
  config: Config;
  /** read-only: verifies a reported change */
  source: TicketSource;
  updater: JiraUpdater;
  /** M5: the JIRA mode of the running job (its wording); default the setting */
  mode?: () => JiraMode;
}

export interface JiraWriteFlow {
  /** ctx.onDevelopmentStarted (P-C7): request the write when sync is on; never throws into development. */
  maybeRequestInProgress(key: string, repos: RepoContext[]): void;
  /** pending → confirmed and enqueue `jira-write:<id>`; decidedBy 'local' or `device:<id>`. */
  confirm(key: string, writeId: number, decidedBy: string): void;
  /** pending → skipped. */
  skip(key: string, writeId: number, decidedBy: string): void;
  /** failed only: a new pending write for the same target (it needs its own confirmation). */
  retry(key: string, writeId: number, decidedBy: string): void;
  /**
   * F2-I3: the ticket is being abandoned (call inside the same transaction as the move): pending writes and confirmed
   * ones not yet being sent become skipped "ticket abandoned". A write already being sent finishes and is recorded.
   */
  abandon(key: string, decidedBy: string): void;
  /**
   * Phase 3 Task 12: delivery's JIRA status step. The developer's delivery confirmation authorizes it, so the write is
   * recorded and immediately confirmed (decidedBy = who confirmed the delivery), then sent now through the same flow
   * (not_needed / verified done / failed). Returns the final record; never re-sent automatically.
   */
  sendConfirmed(key: string, targetStatus: string, decidedBy: string): Promise<JiraWriteRecord>;
}

const same = (a: string | null | undefined, b: string): boolean => typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const TARGETS = {
  inProgress: { setting: (c: Config) => c.jira.inProgressStatus, label: "In Progress" },
  readyForReview: { setting: (c: Config) => c.jira.reviewStatus, label: "review" },
} as const;

/**
 * The target status of a JIRA write: the value the affected repos' rules declare (`jiraStatus.inProgress` /
 * `jiraStatus.readyForReview`, valid values only), else the Settings value (`jira.inProgressStatus` /
 * `jira.reviewStatus`). Repos declaring different values → the Settings value, with a note naming them.
 */
export function statusTarget(
  repos: readonly RepoContext[],
  config: Config,
  which: "inProgress" | "readyForReview",
): { status: string; note: string | null } {
  const { setting, label } = TARGETS[which];
  const global = setting(config);
  const declared = repos.flatMap((r) => {
    const v = r.rules.rules.jiraStatus?.[which];
    return typeof v === "string" && isValidReadyForDevStatus(v.trim()) ? [{ repo: r.name, status: v.trim() }] : [];
  });
  if (declared.length === 0) return { status: global, note: null };
  const first = declared[0]!;
  if (declared.every((d) => same(d.status, first.status))) return { status: first.status, note: null };
  const list = declared.map((d) => `${d.repo}: "${d.status}"`).join(", ");
  return { status: global, note: `The affected repositories declare different ${label} statuses (${list}); using the Settings value "${global}"` };
}

/** The In Progress target (phase 2): `statusTarget(…, 'inProgress')`. */
export function inProgressTarget(repos: readonly RepoContext[], config: Config): { status: string; note: string | null } {
  return statusTarget(repos, config, "inProgress");
}

export function createJiraWriteFlow(deps: JiraWriteDeps): JiraWriteFlow {
  const { db, queue, bus, config, source, updater } = deps;
  const mode = deps.mode ?? ((): JiraMode => config.jira.source);
  const changedEvent = (key: string) => bus.emit({ type: "jira_write_updated", ticketKey: key });

  /** The write `id` of ticket `key`, or NotFoundError (an id of another ticket is unknown here). */
  const ownWrite = (key: string, id: number) => {
    const w = writeRow(db, id);
    if (w.ticket_key !== key) throw new NotFoundError(`JIRA write ${id} not found for ${key}`);
    return w;
  };

  /** confirmed writes whose run has started (in this process): an abandon leaves them to finish */
  const sending = new Set<number>();

  /** F2-I3: nothing is confirmed or retried for an abandoned ticket. */
  const requireNotAbandoned = (key: string) => {
    if (getTicket(db, key)?.state === "abandoned") throw new InvalidTransitionError(`${key} is abandoned: nothing is sent to JIRA`);
  };

  const requireSync = () => {
    if (!config.jira.syncStatus) throw new InvalidTransitionError("JIRA status sync is off in Settings");
  };

  /** One finished outcome: the write row and (done) the ticket's JIRA status in one transaction (P-C21). */
  const finish = (
    key: string, id: number, state: "done" | "failed" | "not_needed", detail: string, result: JiraUpdateResult | null,
    o: { status?: string; sourceError?: boolean } = {},
  ) => {
    withTx(db, () => {
      finishJiraWrite(db, id, state, detail, result);
      if (state === "done" && o.status !== undefined) setJiraStatus(db, key, o.status);
    });
    // something the developer fixes in JIRA, Chrome or Settings: the same banner as the ticket jobs (A-2)
    if (o.sourceError) bus.emit({ type: "source_error", message: detail });
    changedEvent(key);
  };

  /** The confirmed write: run jira-update, verify a reported change with a read-only fetch. Never throws. */
  const send = async (key: string, id: number): Promise<void> => {
    const w = writeRow(db, id);
    if (w.state !== "confirmed") return;
    const target = w.target_status;
    recordJiraWriteSource(db, id, mode());
    // turned off in Settings after the confirmation: send nothing
    if (!config.jira.syncStatus) return finish(key, id, "failed", "JIRA status sync was turned off", null);
    let result: JiraUpdateResult | null = null;
    try {
      result = await updater.setStatus(key, target);
      if (result.loginRequired) return finish(key, id, "failed", jiraLoginMessage(mode()), result, { sourceError: true });
      switch (result.outcome) {
        case "already_in_status":
          return finish(key, id, "not_needed", `Already ${result.observedStatus?.trim() || target} in JIRA — nothing to change`, result);
        case "transition_unavailable":
          return finish(key, id, "failed", `JIRA offers no transition to "${target}"${result.detail ? `: ${result.detail}` : ""}`, result);
        case "failed":
          return finish(key, id, "failed", `${jiraWriter(mode()).status}${result.detail ? `: ${result.detail}` : ""}`, result);
        case "changed": {
          // never trust the agent's own report: read the ticket back (read-only role)
          let shown;
          try {
            shown = await source.fetchTicket(key);
          } catch (err) {
            if (err instanceof AgentInterruptedError) throw err;
            // the change may well have happened: say so, distinctly from a failed change
            return finish(key, id, "failed", `JIRA change reported but not verified: ${errMessage(err)} — check the ticket in JIRA`, result, {
              sourceError: isSourceError(err),
            });
          }
          if (shown.loginRequired) {
            const fix = mode() === "api" ? jiraLoginMessage("api") : "log in to JIRA in Chrome to verify, then retry";
            return finish(key, id, "failed", `JIRA did not confirm the change: ${fix}`, result, { sourceError: true });
          }
          if (!same(shown.status, target)) {
            return finish(key, id, "failed", `JIRA did not confirm the change (it shows ${shown.status === null ? "no status" : `"${shown.status}"`})`, result);
          }
          return finish(key, id, "done", `Moved to ${target} in JIRA`, result, { status: target });
        }
      }
    } catch (err) {
      // shutdown: left confirmed; startup recovery fails it (never re-sent automatically)
      if (err instanceof AgentInterruptedError) return;
      finish(key, id, "failed", `JIRA update failed: ${errMessage(err)}`, result, { sourceError: isSourceError(err) });
    }
  };

  const enqueue = (key: string, id: number) =>
    queue.enqueue(`jira-write:${id}`, async () => {
      try {
        // checked and marked synchronously: an abandon before this point skips the write, after it leaves it to finish
        if (writeRow(db, id).state !== "confirmed") return;
        sending.add(id);
        await send(key, id);
      } catch (err) {
        // recording the outcome itself failed (e.g. the DB is closing): log, never touch the ticket
        logError(`jira-write:${id} (${key}) could not be recorded: ${describeError(err)}`);
      } finally {
        sending.delete(id);
      }
    });

  return {
    maybeRequestInProgress(key, repos) {
      if (!config.jira.syncStatus) return;
      // one open request at a time (development may be resumed or restarted)
      if (listJiraWrites(db, key).some((w) => w.state === "pending" || w.state === "confirmed")) return;
      const t = getTicket(db, key);
      if (!t) return;
      const { status, note } = inProgressTarget(repos, config);
      if (same(t.jiraStatus, status)) {
        const detail = `Already ${t.jiraStatus!.trim()} in JIRA — nothing to change`;
        recordNotNeeded(db, key, status, note === null ? detail : `${detail}. ${note}`);
      } else {
        requestJiraWrite(db, key, status, note);
      }
      changedEvent(key);
    },

    confirm(key, writeId, decidedBy) {
      ownWrite(key, writeId);
      requireNotAbandoned(key);
      requireSync();
      decideJiraWrite(db, writeId, "confirmed", decidedBy);
      changedEvent(key);
      enqueue(key, writeId);
    },

    skip(key, writeId, decidedBy) {
      ownWrite(key, writeId);
      decideJiraWrite(db, writeId, "skipped", decidedBy);
      changedEvent(key);
    },

    retry(key, writeId, decidedBy) {
      const w = ownWrite(key, writeId);
      if (w.state !== "failed") throw new InvalidTransitionError(`JIRA write ${writeId} is ${w.state}; only a failed write can be retried`);
      requireNotAbandoned(key);
      requireSync();
      if (listJiraWrites(db, key).some((x) => x.state === "pending" || x.state === "confirmed")) {
        throw new InvalidTransitionError(`${key} already has a JIRA write waiting`);
      }
      requestJiraWrite(db, key, w.target_status, null, { retryOf: writeId, decidedBy });
      changedEvent(key);
    },

    async sendConfirmed(key, targetStatus, decidedBy) {
      requireNotAbandoned(key);
      requireSync();
      const id = withTx(db, () => {
        const w = requestJiraWrite(db, key, targetStatus, null);
        decideJiraWrite(db, w.id, "confirmed", decidedBy);
        return w.id;
      });
      changedEvent(key);
      sending.add(id);
      try {
        await send(key, id);
      } finally {
        sending.delete(id);
      }
      return listJiraWrites(db, key).find((w) => w.id === id)!;
    },

    abandon(key, decidedBy) {
      if (skipJiraWritesOnAbandon(db, key, decidedBy, (id) => sending.has(id)).length > 0) changedEvent(key);
    },
  };
}

/** Startup recovery: confirmed writes that never finished are failed, not re-sent. */
export function recoverJiraWrites(db: DatabaseSync): string[] {
  return failInterruptedJiraWrites(db, INTERRUPTED_WRITE);
}
