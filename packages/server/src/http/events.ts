import type { AgentRole } from "@slackoff/shared";
import type { AgentEvent } from "../executor/types.ts";
import { redactDeep } from "../credentials/credential-store.ts";

export type BusEvent =
  /** phase 4d: `trial` for a run of a prompt draft on the sample ticket (no ticket) */
  | { type: "agent_event"; ticketKey?: string; role: AgentRole; runId: string; event: AgentEvent; trial?: true }
  | { type: "state_changed"; ticketKey: string; from: string; to: string }
  | { type: "source_error"; message: string }
  /** F-I3: a newly discovered ticket was stored */
  | { type: "ticket_discovered"; ticketKey: string }
  /** the read-only "Read from JIRA" job of a discovered ticket finished (ok: a snapshot is there; else a source_error said why) */
  | { type: "ticket_read"; ticketKey: string; ok: boolean }
  /** Task 9: a design doc, debate round or ruling of the ticket was saved (or the debate was finalized / escalated) */
  | { type: "debate_updated"; ticketKey: string }
  /** Task 10: the JIRA ticket changed before development and was drift-checked; `needsAck` = the developer must acknowledge */
  | { type: "snapshot_changed"; ticketKey: string; needsAck: boolean }
  /** Task 11: a development step of the ticket was recorded */
  | { type: "dev_step"; ticketKey: string; iteration: number; step: number }
  /** Task 9 (phase 3): the ticket's acceptance review changed (a round started, a report saved, a decision recorded) */
  | { type: "review_updated"; ticketKey: string }
  /** Task 12: a JIRA write of the ticket was requested, decided or finished */
  | { type: "jira_write_updated"; ticketKey: string }
  /** Task 10 (phase 3): a JIRA comment of the ticket was requested or finished */
  | { type: "jira_comment_updated"; ticketKey: string }
  /** Task 12 (phase 3): the ticket's delivery changed (confirmed, a step started or finished) */
  | { type: "delivery_updated"; ticketKey: string }
  /** phase 4c: the usage pause or the threshold progress changed (the Cost & quota page and the banner refresh) */
  | { type: "usage_changed" }
  /** phase 4d (4D-1): the preference summary has a new version (edit, clear, re-derive, or a choice / abandon) */
  | { type: "preferences_changed" }
  /**
   * F-I3: a discovery run ended: `created` new of `returned` valid tickets read, `total` open tickets JIRA reported;
   * `complete` = every open ticket was read (only then are no-longer-open flags updated)
   */
  | { type: "discover_finished"; created: number; returned: number; total: number; complete: boolean; loginRequired?: true; error?: string };

export class EventBus {
  #subs = new Set<(e: BusEvent) => void>();

  /** phase 4b (4B-2): every string of the event is redacted before any subscriber (SSE, tests) sees it */
  emit(event: BusEvent): void {
    const e = redactDeep(event);
    for (const fn of [...this.#subs]) {
      try {
        fn(e);
      } catch {
        // a failing subscriber must not break the emitter
      }
    }
  }

  subscribe(fn: (e: BusEvent) => void): () => void {
    this.#subs.add(fn);
    return () => {
      this.#subs.delete(fn);
    };
  }
}
