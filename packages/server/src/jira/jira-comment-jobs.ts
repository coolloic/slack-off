// The confirmed JIRA comment flow (phase 3 Task 10): a requirement-unclear clarification the developer confirmed (this
// computer or a paired phone, recorded as decidedBy) runs the jira-comment role as the job `jira-comment:<id>`. The
// comment is read back with a read-only fetch; whatever happens, the ticket's platform state is never touched and a
// failed comment is never re-sent automatically.
import type { DatabaseSync } from "node:sqlite";
import type { FetchedTicket, JiraCommentRecord } from "@slackoff/shared";
import { AgentInterruptedError } from "../executor/types.ts";
import type { EventBus } from "../http/events.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../tickets/errors.ts";
import { parseCommentsMarker } from "../snapshots/snapshot-store.ts";
import { getTicket } from "../tickets/ticket-repo.ts";
import type { JobQueue } from "../workflow/queue.ts";
import { commentTextError, normalizeCommentText, type JiraCommenter } from "./jira-commenter.ts";
import { failInterruptedComments, finishComment, listComments, recordCommentSource, requestComment, skipPendingComments } from "./jira-comment-repo.ts";
import { INTERRUPTED_WRITE } from "./jira-write-jobs.ts";
import { isSourceError, jiraLoginMessage, jiraWriter, type JiraMode, type TicketSource } from "./ticket-source.ts";
import { describeError, logError } from "../log.ts";

export interface JiraCommentDeps {
  db: DatabaseSync;
  queue: JobQueue;
  bus: EventBus;
  /** read-only: the state before and the read-back after */
  source: TicketSource;
  commenter: JiraCommenter;
  /** M5: the JIRA mode of the running job (its wording); default the browser mode's */
  mode?: () => JiraMode;
}

export interface JiraCommentFlow {
  /** requestComment(purpose 'clarification', confirmed) + enqueue `jira-comment:<id>`. Any non-terminal state; independent of jira.syncStatus. */
  sendClarification(key: string, text: string, decidedBy: string): { id: number };
  /** failed only: a new confirmed record with the same text, enqueued. */
  retry(key: string, commentId: number, decidedBy: string): { id: number };
  /** Delivery's use: execute the confirmed comment now and return the final record. */
  send(commentId: number): Promise<JiraCommentRecord>;
  /**
   * Phase 3 Task 12: delivery's comment step — requestComment(purpose 'delivery', confirmed by the delivery's
   * confirmation) then `send` now. Refused (ValidationError) like a clarification: bad text, or a comment of the ticket
   * is already being sent. Returns the final record.
   */
  sendDelivery(key: string, text: string, decidedBy: string): Promise<JiraCommentRecord>;
  /** The ticket is being abandoned (call inside the same transaction as the move): unsent comments become skipped. */
  abandon(key: string): void;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The fields a comment must leave alone, compared before and after (hook pins the typed text, not where it went). */
function otherChanges(before: FetchedTicket, after: FetchedTicket): string[] {
  const out: string[] = [];
  if (before.status !== after.status) out.push("status");
  if (before.title !== after.title) out.push("title");
  if (before.description !== after.description) out.push("description");
  if (after.comments.length !== before.comments.length + 1) out.push(`comments (${before.comments.length} before, ${after.comments.length} after; expected ${before.comments.length + 1})`);
  return out;
}

export function createJiraCommentFlow(deps: JiraCommentDeps): JiraCommentFlow {
  const { db, queue, bus, source, commenter } = deps;
  const mode = deps.mode ?? ((): JiraMode => "browser");
  const changed = (key: string) => bus.emit({ type: "jira_comment_updated", ticketKey: key });
  const get = (id: number): JiraCommentRecord & { key: string } => {
    const row = db.prepare("SELECT ticket_key FROM jira_comment WHERE id = ?").get(id) as { ticket_key: string } | undefined;
    if (!row) throw new NotFoundError(`JIRA comment ${id} not found`);
    return { ...listComments(db, row.ticket_key).find((c) => c.id === id)!, key: row.ticket_key };
  };

  const finish = (key: string, id: number, state: "done" | "failed" | "not_needed", detail: string, result: unknown, sourceError = false) => {
    finishComment(db, id, state, detail, result);
    // something the developer fixes in JIRA, Chrome or Settings: the same banner as the ticket jobs
    if (sourceError) bus.emit({ type: "source_error", message: detail });
    changed(key);
  };

  /** comments being sent (in this process): an abandon leaves them to finish */
  const sending = new Set<number>();
  /** jira-comment runs are serialized per ticket: a second one pre-fetches only after the first has been read back */
  const tails = new Map<string, Promise<void>>();
  const serialized = (key: string, fn: () => Promise<void>): Promise<void> => {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };

  /** Run one confirmed comment. Never throws except for a shutdown interruption (left confirmed; recovery fails it). */
  const execute = (id: number): Promise<void> => {
    const row = get(id);
    return serialized(row.key, () => executeNow(id));
  };

  const executeNow = async (id: number): Promise<void> => {
    const c = get(id);
    if (c.state !== "confirmed") return;
    const key = c.key;
    sending.add(id);
    try {
      await executeConfirmed(c, id, key);
    } finally {
      sending.delete(id);
    }
  };

  const executeConfirmed = async (c: JiraCommentRecord, id: number, key: string): Promise<void> => {
    const state = getTicket(db, key)?.state;
    // a delivery comment is sent once the PRs are open (pr_opened); any other comment stops there
    if (state === "abandoned" || (state === "pr_opened" && c.purpose !== "delivery")) return finish(key, id, "failed", "ticket closed: nothing is sent to JIRA", null);
    recordCommentSource(db, id, mode());
    const target = normalizeCommentText(c.text);
    let result: unknown = null;
    try {
      const before = await source.fetchTicket(key);
      if (before.loginRequired) return finish(key, id, "failed", jiraLoginMessage(mode()), null, true);
      if (parseCommentsMarker(before.description).notLoaded !== null) {
        return finish(key, id, "failed", `older comments not loaded on ${key} — check JIRA`, null);
      }
      if (before.comments.some((x) => normalizeCommentText(x.body) === target)) {
        return finish(key, id, "not_needed", "The comment is already posted on the ticket", null);
      }
      const posted = await commenter.postComment(key, c.text);
      result = posted;
      if (posted.loginRequired) return finish(key, id, "failed", jiraLoginMessage(mode()), posted, true);
      if (posted.outcome !== "posted") {
        return finish(key, id, "failed", `${jiraWriter(mode()).comment}${posted.detail ? `: ${posted.detail}` : ""}`, posted);
      }
      // never trust the agent's own report: read the ticket back (read-only role)
      let after: FetchedTicket;
      try {
        after = await source.fetchTicket(key);
      } catch (err) {
        if (err instanceof AgentInterruptedError) throw err;
        // the comment may well have been posted: say so, distinctly from a failed post
        return finish(key, id, "failed", `Comment reported but not verified: ${errMessage(err)} — check the ticket in JIRA`, posted, isSourceError(err));
      }
      if (after.loginRequired) return finish(key, id, "failed", `JIRA did not confirm the comment: ${jiraLoginMessage(mode())}`, posted, true);
      if (!after.comments.some((x) => normalizeCommentText(x.body) === target)) {
        return finish(key, id, "failed", "JIRA did not show the comment — check the ticket in JIRA before sending again", posted);
      }
      const other = otherChanges(before, after);
      if (other.length > 0) {
        return finish(key, id, "failed", `JIRA shows other changes on ${key} after the comment: ${other.join(", ")} — check the ticket`, posted);
      }
      return finish(key, id, "done", "Comment posted and shown in JIRA", posted);
    } catch (err) {
      if (err instanceof AgentInterruptedError) return;
      finish(key, id, "failed", `JIRA comment failed: ${errMessage(err)}`, result, isSourceError(err));
    }
  };

  const enqueue = (id: number) =>
    queue.enqueue(`jira-comment:${id}`, async () => {
      try {
        await execute(id);
      } catch (err) {
        // recording the outcome itself failed (e.g. the DB is closing): log, never touch the ticket
        logError(`jira-comment:${id} could not be recorded: ${describeError(err)}`);
      }
    });

  const requireOpen = (key: string) => {
    const t = getTicket(db, key);
    if (!t) throw new NotFoundError(`unknown ticket ${key}`);
    if (t.state === "abandoned" || t.state === "pr_opened") throw new InvalidTransitionError(`${key} is ${t.state}: nothing is sent to JIRA`);
  };

  const requireNoneSending = (key: string) => {
    if (listComments(db, key).some((c) => c.state === "confirmed")) throw new ValidationError(`a comment is already being sent for ${key}`);
  };

  const request = (key: string, text: string, decidedBy: string, purpose: JiraCommentRecord["purpose"]) => {
    // a textarea submits CRLF; a lone CR stays an error
    const clean = text.replace(/\r\n/g, "\n");
    const bad = commentTextError(clean);
    if (bad !== null) throw new ValidationError(bad);
    requireNoneSending(key);
    const { id } = requestComment(db, key, purpose, clean, decidedBy);
    changed(key);
    enqueue(id);
    return { id };
  };

  return {
    sendClarification(key, text, decidedBy) {
      requireOpen(key);
      return request(key, text, decidedBy, "clarification");
    },

    retry(key, commentId, decidedBy) {
      const c = get(commentId);
      if (c.key !== key) throw new NotFoundError(`JIRA comment ${commentId} not found for ${key}`);
      if (c.state !== "failed") throw new InvalidTransitionError(`JIRA comment ${commentId} is ${c.state}; only a failed comment can be retried`);
      requireOpen(key);
      return request(key, c.text, decidedBy, c.purpose);
    },

    abandon(key) {
      skipPendingComments(db, key, "ticket abandoned", (id) => sending.has(id));
    },

    async sendDelivery(key, text, decidedBy) {
      const bad = commentTextError(text);
      if (bad !== null) throw new ValidationError(bad);
      requireNoneSending(key);
      const { id } = requestComment(db, key, "delivery", text, decidedBy);
      changed(key);
      await execute(id);
      const { key: _key, ...rec } = get(id);
      return rec;
    },

    async send(commentId) {
      await execute(commentId);
      const { key: _key, ...rec } = get(commentId);
      return rec;
    },
  };
}

/** Startup recovery: confirmed comments that never finished are failed, not re-sent. */
export function recoverJiraComments(db: DatabaseSync): string[] {
  return failInterruptedComments(db, INTERRUPTED_WRITE);
}
