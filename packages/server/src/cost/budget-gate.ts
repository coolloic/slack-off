import type { DatabaseSync } from "node:sqlite";
import { WRITE_AGENT_ROLES, type AgentRole, type UsagePause, type UsagePauseReason } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import type { Config } from "../config.ts";
import type { EventBus } from "../http/events.ts";
import { budgetProgress } from "./usage-repo.ts";

const WRITE_ROLES: ReadonlySet<AgentRole> = new Set(WRITE_AGENT_ROLES);

/** A new agent run was refused because usage is paused (by hand, over a threshold, or the CLI's limit). */
export class UsagePausedError extends Error {
  readonly pause: UsagePause;
  constructor(pause: UsagePause) {
    super(`Paused: ${pause.detail}`);
    this.name = "UsagePausedError";
    this.pause = pause;
  }
}

interface PauseRow {
  id: number;
  reason: UsagePauseReason;
  detail: string;
  paused_by: string;
  paused_at: string;
}

const toPause = (r: PauseRow): UsagePause => ({ id: r.id, reason: r.reason, detail: r.detail, pausedBy: r.paused_by, pausedAt: r.paused_at });

/** The pause in force (not yet resumed), or null. Read from the table on every call, so a restart keeps it. */
export function currentPause(db: DatabaseSync): UsagePause | null {
  const r = db.prepare("SELECT id, reason, detail, paused_by, paused_at FROM usage_pause WHERE resumed_at IS NULL ORDER BY id DESC LIMIT 1").get() as PauseRow | undefined;
  return r === undefined ? null : toPause(r);
}

/** Pause new agent runs. Already paused → the existing pause, nothing new. `by`: 'local', `device:<id>` or 'system'. */
export function pauseUsage(db: DatabaseSync, reason: UsagePauseReason, detail: string, by: string, bus?: EventBus): UsagePause {
  const existing = currentPause(db);
  if (existing !== null) return existing;
  const text = detail.trim().slice(0, 300) || "paused";
  const res = db.prepare("INSERT INTO usage_pause (reason, detail, paused_by, paused_at) VALUES (?, ?, ?, ?)").run(reason, text, by, new Date().toISOString());
  const pause: UsagePause = { id: Number(res.lastInsertRowid), reason, detail: text, pausedBy: by, pausedAt: "" };
  pause.pausedAt = (db.prepare("SELECT paused_at FROM usage_pause WHERE id = ?").get(pause.id) as { paused_at: string }).paused_at;
  appendAudit(db, { actor: by === "system" ? "system" : "developer", type: "usage_paused", payload: { reason, detail: text, by } });
  bus?.emit({ type: "usage_changed" });
  return pause;
}

/** Resume: new agent runs may start again (blocked tickets still need Retry). Not paused → nothing happens. */
export function resumeUsage(db: DatabaseSync, by: string, bus?: EventBus): void {
  const p = currentPause(db);
  if (p === null) return;
  db.prepare("UPDATE usage_pause SET resumed_by = ?, resumed_at = ? WHERE id = ? AND resumed_at IS NULL").run(by, new Date().toISOString(), p.id);
  appendAudit(db, { actor: "developer", type: "usage_resumed", payload: { pauseId: p.id, by } });
  bus?.emit({ type: "usage_changed" });
}

const ITEM_LABEL = { runs: "runs", runMinutes: "run minutes", usd: "USD" } as const;
const fmt = (item: keyof typeof ITEM_LABEL, n: number): string => (item === "usd" ? n.toFixed(2) : item === "runMinutes" ? String(Math.round(n * 10) / 10) : String(n));

export function budgetGate(o: { db: DatabaseSync; config: () => Config; now?: () => Date; bus?: EventBus }): { check(role: AgentRole): void } {
  return {
    check(role) {
      // a JIRA write the developer confirmed goes ahead whatever the usage (ruling C-3)
      if (WRITE_ROLES.has(role)) return;
      const paused = currentPause(o.db);
      if (paused !== null) throw new UsagePausedError(paused);
      const cfg = o.config();
      const p = budgetProgress(o.db, { now: (o.now ?? (() => new Date()))(), executor: cfg.executor.kind, budget: cfg.budget, acceptanceRunTimeoutMs: cfg.acceptance.runTimeoutMs });
      if (p === null || p.state !== "over" || p.item === null) return;
      const detail = `${ITEM_LABEL[p.item]} reached ${fmt(p.item, p.used[p.item])}/${fmt(p.item, p.limits[p.item]!)} in the last ${p.window}`;
      throw new UsagePausedError(pauseUsage(o.db, "threshold", detail, "system", o.bus));
    },
  };
}
