import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { InstallReport, TicketState, TicketSummary } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { NotFoundError } from "./errors.ts";

export interface Ticket {
  key: string;
  title: string;
  url: string | null;
  jiraStatus: string | null;
  state: TicketState;
  prevState: TicketState | null;
  blockedReason: string | null;
  reviewAc: boolean;
  repoPath: string | null;
  branch: string | null;
  worktreePath: string | null;
  reviewAttempts: number;
  /** false once a complete discovery no longer returned it (closed or reassigned in JIRA) */
  jiraOpen: boolean;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function toTicket(r: Row): Ticket {
  return {
    key: r.key as string,
    title: r.title as string,
    url: r.url as string | null,
    jiraStatus: r.jira_status as string | null,
    state: r.state as TicketState,
    prevState: r.prev_state as TicketState | null,
    blockedReason: r.blocked_reason as string | null,
    reviewAc: r.review_ac === 1,
    repoPath: r.repo_path as string | null,
    branch: r.branch as string | null,
    worktreePath: r.worktree_path as string | null,
    reviewAttempts: r.review_attempts as number,
    jiraOpen: r.jira_open !== 0,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/**
 * Insert a newly discovered ticket. For a known ticket only the JIRA title and status are refreshed (H5),
 * audited as `ticket_refreshed` with the changed fields; state, review_ac, requirements and solutions are never touched.
 */
export function upsertDiscovered(db: DatabaseSync, t: TicketSummary, reviewAc: boolean): { created: boolean } {
  return withTx(db, () => {
    const now = new Date().toISOString();
    const res = db
      .prepare(
        "INSERT OR IGNORE INTO ticket (key, title, url, jira_status, state, review_ac, created_at, updated_at) VALUES (?, ?, ?, ?, 'discovered', ?, ?, ?)",
      )
      .run(t.key, t.title, t.url, t.status, reviewAc ? 1 : 0, now, now);
    const created = Number(res.changes) === 1;
    if (created) {
      appendAudit(db, { actor: "system", type: "ticket_discovered", ticketKey: t.key, payload: { title: t.title, status: t.status } });
      return { created };
    }
    const cur = db.prepare("SELECT title, jira_status FROM ticket WHERE key = ?").get(t.key) as { title: string; jira_status: string | null };
    const changes: Record<string, { from: string | null; to: string }> = {};
    if (cur.title !== t.title) changes.title = { from: cur.title, to: t.title };
    if (cur.jira_status !== t.status) changes.jiraStatus = { from: cur.jira_status, to: t.status };
    if (Object.keys(changes).length > 0) {
      db.prepare("UPDATE ticket SET title = ?, jira_status = ?, updated_at = ? WHERE key = ?").run(t.title, t.status, now, t.key);
      appendAudit(db, { actor: "system", type: "ticket_refreshed", ticketKey: t.key, payload: changes });
    }
    return { created };
  });
}

export function getTicket(db: DatabaseSync, key: string): Ticket | null {
  const r = db.prepare("SELECT * FROM ticket WHERE key = ?").get(key) as Row | undefined;
  return r ? toTicket(r) : null;
}

export function listTickets(db: DatabaseSync): Ticket[] {
  return (db.prepare("SELECT * FROM ticket ORDER BY created_at, key").all() as Row[]).map(toTicket);
}

/** Set the ticket's "review AC" switch; a change is audited as `review_ac_changed` (H6). */
/** Toggle "review AC before proposing"; a change is audited `review_ac_changed` with who changed it. */
export function setReviewAc(db: DatabaseSync, key: string, on: boolean, decidedBy: string): void {
  withTx(db, () => {
    const cur = db.prepare("SELECT review_ac FROM ticket WHERE key = ?").get(key) as { review_ac: number } | undefined;
    if (!cur) throw new NotFoundError(`unknown ticket ${key}`);
    const from = cur.review_ac === 1;
    if (from === on) return;
    db.prepare("UPDATE ticket SET review_ac = ?, updated_at = ? WHERE key = ?").run(on ? 1 : 0, new Date().toISOString(), key);
    appendAudit(db, { actor: "developer", type: "review_ac_changed", ticketKey: key, payload: { from, to: on, decidedBy } });
  });
}

/**
 * After a COMPLETE successful discovery: flag known tickets missing from `openKeys` as no longer open in JIRA
 * (`ticket_no_longer_open`) and clear the flag on ones that reappeared (`ticket_open_again`). Only `jira_open`
 * changes: platform state, requirements and solutions are never touched, and nothing is abandoned.
 */
export function markJiraOpen(db: DatabaseSync, openKeys: ReadonlySet<string>): { closed: string[]; reopened: string[] } {
  return withTx(db, () => {
    const now = new Date().toISOString();
    const rows = db.prepare("SELECT key, jira_status, jira_open FROM ticket ORDER BY key").all() as Array<{ key: string; jira_status: string | null; jira_open: number | null }>;
    const closed: string[] = [];
    const reopened: string[] = [];
    for (const r of rows) {
      const open = openKeys.has(r.key);
      if (!open && r.jira_open !== 0) {
        db.prepare("UPDATE ticket SET jira_open = 0, updated_at = ? WHERE key = ?").run(now, r.key);
        appendAudit(db, { actor: "system", type: "ticket_no_longer_open", ticketKey: r.key, payload: { lastJiraStatus: r.jira_status } });
        closed.push(r.key);
      } else if (open && r.jira_open === 0) {
        db.prepare("UPDATE ticket SET jira_open = 1, updated_at = ? WHERE key = ?").run(now, r.key);
        appendAudit(db, { actor: "system", type: "ticket_open_again", ticketKey: r.key, payload: { jiraStatus: r.jira_status } });
        reopened.push(r.key);
      }
    }
    return { closed, reopened };
  });
}

export interface DiscoveryRun {
  finishedAt: string;
  /** valid tickets read */
  returned: number;
  /** open tickets JIRA reported */
  total: number;
  complete: boolean;
}

export function recordDiscoveryRun(db: DatabaseSync, r: Omit<DiscoveryRun, "finishedAt">): void {
  db.prepare("INSERT INTO discovery_run (finished_at, returned, total, complete) VALUES (?, ?, ?, ?)").run(
    new Date().toISOString(), r.returned, r.total, r.complete ? 1 : 0,
  );
}

export function lastDiscoveryRun(db: DatabaseSync): DiscoveryRun | null {
  const r = db.prepare("SELECT finished_at, returned, total, complete FROM discovery_run ORDER BY id DESC LIMIT 1").get() as
    | { finished_at: string; returned: number; total: number; complete: number }
    | undefined;
  return r ? { finishedAt: r.finished_at, returned: r.returned, total: r.total, complete: r.complete === 1 } : null;
}

// ---------------------------------------------------------------- per-repo ticket workspaces (phase 2)

export interface RepoWorkspace {
  repo: string;
  repoPath: string;
  baseBranch: string;
  branch: string;
  /** `${SLACKOFF_HOME}/worktrees/<KEY>/<repo>` */
  worktreePath: string;
  /** the one-off install at worktree creation; null when no install ran */
  install: InstallReport | null;
  /** the choice the branch was built for (T11-2); null for rows written before migration 7 */
  choiceId: number | null;
  createdAt: string;
}

function requireTicket(db: DatabaseSync, key: string): void {
  if (!db.prepare("SELECT 1 FROM ticket WHERE key = ?").get(key)) throw new NotFoundError(`unknown ticket ${key}`);
}

/**
 * Insert or update the workspace of one affected repo, and point ticket.branch / worktree_path at the branch name and
 * the ticket directory (the worktree's parent). `worktree_created` is audited only on first insert (P-C14); a later call
 * that changes a stored value is audited `repo_workspace_changed` with the changed fields. A new branch is a new worktree:
 * its install report is cleared. `choiceId` (optional) records the choice the branch is built for.
 */
export function setRepoWorkspace(
  db: DatabaseSync,
  key: string,
  w: { repo: string; repoPath: string; baseBranch: string; branch: string; worktreePath: string; choiceId?: number | null },
): void {
  withTx(db, () => {
    requireTicket(db, key);
    const now = new Date().toISOString();
    const cur = db
      .prepare("SELECT repo_path, base_branch, branch, worktree_path, choice_id FROM ticket_repo WHERE ticket_key = ? AND repo_name = ?")
      .get(key, w.repo) as { repo_path: string; base_branch: string; branch: string; worktree_path: string; choice_id: number | null } | undefined;
    const choiceId = w.choiceId === undefined ? (cur?.choice_id ?? null) : w.choiceId;
    const exists = cur !== undefined;
    if (cur) {
      const changes: Record<string, { from: string | number | null; to: string | number | null }> = {};
      const fields = [["repoPath", cur.repo_path, w.repoPath], ["baseBranch", cur.base_branch, w.baseBranch], ["branch", cur.branch, w.branch], ["worktreePath", cur.worktree_path, w.worktreePath], ["choiceId", cur.choice_id, choiceId]] as const;
      for (const [field, from, to] of fields) if (from !== to) changes[field] = { from, to };
      if (Object.keys(changes).length > 0)
        appendAudit(db, { actor: "system", type: "repo_workspace_changed", ticketKey: key, payload: { repo: w.repo, changes } });
      db.prepare(
        "UPDATE ticket_repo SET repo_path = ?, base_branch = ?, branch = ?, worktree_path = ?, choice_id = ? WHERE ticket_key = ? AND repo_name = ?",
      ).run(w.repoPath, w.baseBranch, w.branch, w.worktreePath, choiceId, key, w.repo);
      // a new branch is a new worktree: its install report and hooks pin (F2-R1) start over
      if (cur.branch !== w.branch) {
        db.prepare("UPDATE ticket_repo SET install_json = NULL, hooks_pin_json = NULL WHERE ticket_key = ? AND repo_name = ?").run(key, w.repo);
      }
    } else {
      db.prepare(
        "INSERT INTO ticket_repo (ticket_key, repo_name, repo_path, base_branch, branch, worktree_path, choice_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(key, w.repo, w.repoPath, w.baseBranch, w.branch, w.worktreePath, choiceId, now);
    }
    db.prepare("UPDATE ticket SET branch = ?, worktree_path = ?, updated_at = ? WHERE key = ?").run(w.branch, dirname(w.worktreePath), now, key);
    if (!exists) appendAudit(db, { actor: "system", type: "worktree_created", ticketKey: key, payload: { ...w } });
  });
}

export function listRepoWorkspaces(db: DatabaseSync, key: string): RepoWorkspace[] {
  const rows = db.prepare("SELECT * FROM ticket_repo WHERE ticket_key = ? ORDER BY repo_name").all(key) as Row[];
  return rows.map((r) => ({
    repo: r.repo_name as string,
    repoPath: r.repo_path as string,
    baseBranch: r.base_branch as string,
    branch: r.branch as string,
    worktreePath: r.worktree_path as string,
    install: r.install_json === null ? null : (JSON.parse(r.install_json as string) as InstallReport),
    choiceId: (r.choice_id as number | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

function workspaceRow(db: DatabaseSync, key: string, repo: string): Row {
  const r = db.prepare("SELECT * FROM ticket_repo WHERE ticket_key = ? AND repo_name = ?").get(key, repo) as Row | undefined;
  if (!r) throw new NotFoundError(`no workspace for repo ${repo} of ${key}`);
  return r;
}

/** F2-R1: the pinned hooks gate of one repo of a ticket (see git/worktree.ts HooksPin). */
export interface StoredHooksPin {
  hooksPath: string | null;
  dir: string;
  hash: string;
}

/** The stored hooks pin of (key, repo), or null before the worktree was first prepared (or after a new branch). */
export function getHooksPin(db: DatabaseSync, key: string, repo: string): StoredHooksPin | null {
  const r = db.prepare("SELECT hooks_pin_json FROM ticket_repo WHERE ticket_key = ? AND repo_name = ?").get(key, repo) as
    | { hooks_pin_json: string | null }
    | undefined;
  return r?.hooks_pin_json ? (JSON.parse(r.hooks_pin_json) as StoredHooksPin) : null;
}

/**
 * Store the hooks pin of (key, repo). `first`: audited `hooks_pinned` (system); otherwise the developer's explicit
 * re-pin, audited `hooks_repinned` with the old and new fingerprints and who decided.
 */
export function setHooksPin(
  db: DatabaseSync,
  key: string,
  repo: string,
  pin: StoredHooksPin,
  how: { kind: "first" } | { kind: "accepted"; decidedBy: string },
): void {
  withTx(db, () => {
    workspaceRow(db, key, repo);
    const old = getHooksPin(db, key, repo);
    const value = { hooksPath: pin.hooksPath, dir: pin.dir, hash: pin.hash };
    db.prepare("UPDATE ticket_repo SET hooks_pin_json = ? WHERE ticket_key = ? AND repo_name = ?").run(JSON.stringify(value), key, repo);
    if (how.kind === "first") appendAudit(db, { actor: "system", type: "hooks_pinned", ticketKey: key, payload: { repo, pin: value } });
    else appendAudit(db, { actor: "developer", type: "hooks_repinned", ticketKey: key, payload: { repo, old, new: value, decidedBy: how.decidedBy } });
  });
}

/** The branch every affected repo uses for this choice (T11-3), or null before development first started for it. */
export function choiceBranch(db: DatabaseSync, choiceId: number): string | null {
  const r = db.prepare("SELECT branch FROM choice_branch WHERE choice_id = ?").get(choiceId) as { branch: string } | undefined;
  return r?.branch ?? null;
}

/** Every branch name the ticket's choices used, oldest first. */
export function listChoiceBranches(db: DatabaseSync, key: string): string[] {
  return (db.prepare("SELECT branch FROM choice_branch WHERE ticket_key = ? ORDER BY choice_id").all(key) as Array<{ branch: string }>).map((r) => r.branch);
}

/** Fix the branch of a choice (once); audited `dev_branch_chosen`. */
export function setChoiceBranch(db: DatabaseSync, key: string, choiceId: number, branch: string): void {
  withTx(db, () => {
    requireTicket(db, key);
    db.prepare("INSERT INTO choice_branch (choice_id, ticket_key, branch, created_at) VALUES (?, ?, ?, ?)").run(choiceId, key, branch, new Date().toISOString());
    appendAudit(db, { actor: "system", type: "dev_branch_chosen", ticketKey: key, payload: { choiceId, branch } });
  });
}

/** Forget a repo's workspace once its worktree was removed (the branch is kept); audited `worktree_removed` (P-C9). */
export function removeRepoWorkspace(db: DatabaseSync, key: string, repo: string): void {
  withTx(db, () => {
    const r = workspaceRow(db, key, repo);
    db.prepare("DELETE FROM ticket_repo WHERE ticket_key = ? AND repo_name = ?").run(key, repo);
    appendAudit(db, {
      actor: "system",
      type: "worktree_removed",
      ticketKey: key,
      payload: { repo, branch: r.branch, worktreePath: r.worktree_path },
    });
  });
}

/** Store the install report of a new worktree; audited `repo_installed` with the reset paths (S-4). */
export function recordInstall(db: DatabaseSync, key: string, repo: string, report: InstallReport): void {
  withTx(db, () => {
    workspaceRow(db, key, repo);
    db.prepare("UPDATE ticket_repo SET install_json = ? WHERE ticket_key = ? AND repo_name = ?").run(JSON.stringify(report), key, repo);
    appendAudit(db, {
      actor: "system",
      type: "repo_installed",
      ticketKey: key,
      payload: {
        repo,
        command: report.run.command,
        exitCode: report.run.exitCode,
        timedOut: report.run.timedOut,
        resetPaths: report.resetPaths,
      },
    });
  });
}

/** Update the ticket's JIRA status (snapshot re-read or a finished JIRA write); a change is audited `ticket_refreshed` (P-C21). */
export function setJiraStatus(db: DatabaseSync, key: string, status: string): void {
  withTx(db, () => {
    const cur = db.prepare("SELECT jira_status FROM ticket WHERE key = ?").get(key) as { jira_status: string | null } | undefined;
    if (!cur) throw new NotFoundError(`unknown ticket ${key}`);
    if (cur.jira_status === status) return;
    db.prepare("UPDATE ticket SET jira_status = ?, updated_at = ? WHERE key = ?").run(status, new Date().toISOString(), key);
    appendAudit(db, { actor: "system", type: "ticket_refreshed", ticketKey: key, payload: { jiraStatus: { from: cur.jira_status, to: status } } });
  });
}
