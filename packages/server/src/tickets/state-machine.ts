import type { DatabaseSync } from "node:sqlite";
import { canTransition, type TicketState } from "@slackoff/shared";
import { appendAudit, type Actor } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { InvalidTransitionError, NotFoundError } from "./errors.ts";
import { getTicket } from "./ticket-repo.ts";
import { redactKnown } from "../credentials/credential-store.ts";

/** `extra` joins the state_changed audit payload (e.g. the number of disagreements on escalation). */
export function transition(db: DatabaseSync, key: string, to: TicketState, actor: Actor, reason?: string, extra: Record<string, unknown> = {}): void {
  // phase 4b (4B-2): a blocked reason (ticket row and audit) never stores a credential value
  if (reason !== undefined) reason = redactKnown(reason);
  withTx(db, () => {
    const t = getTicket(db, key);
    if (!t) throw new NotFoundError(`unknown ticket ${key}`);
    const from = t.state;
    if (!canTransition(from, to)) throw new InvalidTransitionError(`${key}: ${from} -> ${to} is not allowed`);
    // T12-1: a blocked delivery may go back to the confirmation ("Preview again") instead of continuing
    const previewAgain = from === "blocked" && t.prevState === "delivering" && to === "awaiting_confirmation";
    if (from === "blocked" && to !== "abandoned" && to !== t.prevState && !previewAgain) {
      throw new InvalidTransitionError(`${key}: blocked ticket may only return to ${t.prevState ?? "(none)"}, not ${to}`);
    }
    const now = new Date().toISOString();
    if (to === "blocked") {
      db.prepare("UPDATE ticket SET state = 'blocked', prev_state = ?, blocked_reason = ?, updated_at = ? WHERE key = ?").run(
        from,
        reason ?? null,
        now,
        key,
      );
    } else {
      db.prepare("UPDATE ticket SET state = ?, prev_state = NULL, blocked_reason = NULL, updated_at = ? WHERE key = ?").run(to, now, key);
    }
    appendAudit(db, { actor, type: "state_changed", ticketKey: key, payload: { ...extra, from, to, reason: reason ?? null } });
  });
}
