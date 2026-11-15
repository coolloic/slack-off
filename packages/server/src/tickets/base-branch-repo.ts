import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";

/**
 * The base branch a ticket's repo is branched from, when it is not the mapping's default (Settings): develop for a
 * feature, a release branch for a fix. Chosen per ticket and repo until that repo's ticket branch exists (then the
 * workspace records the base it was made from). Every choice is audited.
 */
export function ticketBases(db: DatabaseSync, ticketKey: string): Record<string, string> {
  const rows = db.prepare("SELECT repo_name, branch FROM ticket_base_branch WHERE ticket_key = ?").all(ticketKey) as Array<{ repo_name: string; branch: string }>;
  return Object.fromEntries(rows.map((r) => [r.repo_name, r.branch]));
}

/** branch null: back to the mapping's default. */
export function setTicketBase(db: DatabaseSync, ticketKey: string, repo: string, branch: string | null, decidedBy: string): void {
  withTx(db, () => {
    const prev = (db.prepare("SELECT branch FROM ticket_base_branch WHERE ticket_key = ? AND repo_name = ?").get(ticketKey, repo) as { branch: string } | undefined)?.branch ?? null;
    if (prev === branch) return;
    if (branch === null) db.prepare("DELETE FROM ticket_base_branch WHERE ticket_key = ? AND repo_name = ?").run(ticketKey, repo);
    else {
      db.prepare(
        "INSERT INTO ticket_base_branch (ticket_key, repo_name, branch, decided_by, decided_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (ticket_key, repo_name) DO UPDATE SET branch = excluded.branch, decided_by = excluded.decided_by, decided_at = excluded.decided_at",
      ).run(ticketKey, repo, branch, decidedBy, new Date().toISOString());
    }
    appendAudit(db, { actor: "developer", type: "base_branch_chosen", ticketKey, payload: { repo, from: prev, to: branch, decidedBy } });
  });
}

/** The ticket's branch type (feat, fix, docs…) when the developer chose one; null = guessed from the title. */
export function ticketBranchType(db: DatabaseSync, ticketKey: string): string | null {
  return (db.prepare("SELECT type FROM ticket_branch_type WHERE ticket_key = ?").get(ticketKey) as { type: string } | undefined)?.type ?? null;
}

/** type null: back to the guess from the title. Audited. */
export function setTicketBranchType(db: DatabaseSync, ticketKey: string, type: string | null, decidedBy: string): void {
  withTx(db, () => {
    const prev = ticketBranchType(db, ticketKey);
    if (prev === type) return;
    if (type === null) db.prepare("DELETE FROM ticket_branch_type WHERE ticket_key = ?").run(ticketKey);
    else {
      db.prepare(
        "INSERT INTO ticket_branch_type (ticket_key, type, decided_by, decided_at) VALUES (?, ?, ?, ?) ON CONFLICT (ticket_key) DO UPDATE SET type = excluded.type, decided_by = excluded.decided_by, decided_at = excluded.decided_at",
      ).run(ticketKey, type, decidedBy, new Date().toISOString());
    }
    appendAudit(db, { actor: "developer", type: "branch_type_chosen", ticketKey, payload: { from: prev, to: type, decidedBy } });
  });
}
