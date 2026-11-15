import type { DatabaseSync } from "node:sqlite";
import type { AgentRole, BudgetProgress, BudgetState, UsagePause, UsageSummary, UsageTotals, UsageWindow } from "@slackoff/shared";
import type { Config } from "../config.ts";
import { DEFAULT_AGENT_ATTEMPTS, DEFAULT_AGENT_TIMEOUT_MS } from "../executor/types.ts";

const HOUR = 3_600_000;
const WINDOW_MS: Record<UsageWindow, number> = { "5h": 5 * HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, "30d": 30 * 24 * HOUR };
const BY_TICKET_LIMIT = 50;

export function windowStart(window: UsageWindow, now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS[window]);
}

export const emptyTotals = (): UsageTotals => ({
  runs: 0, failedRuns: 0, runMinutes: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, estimateUsd: 0,
});

function add(into: UsageTotals, row: UsageTotals): void {
  for (const k of Object.keys(into) as (keyof UsageTotals)[]) into[k] += row[k];
}

/** the acceptance agent's run timeout when the caller does not say (config acceptance.runTimeoutMs default) */
const ACCEPTANCE_TIMEOUT_MS = 1_800_000;

/**
 * F4C-1 (I-2): one run's minutes, capped at the longest it can take — its executor timeout for every attempt (acceptance-review:
 * acceptance.runTimeoutMs; the others: the executor default). A run that stayed 'running' across a stop, or one closed by an
 * older recovery at the restart, never counts the downtime. The caps are numbers from the validated config.
 */
function runMinutesSql(acceptanceTimeoutMs: number): string {
  const cap = (ms: number) => String(Math.max(1, Math.trunc(ms)) * DEFAULT_AGENT_ATTEMPTS / 60_000);
  return `MIN(MAX(0, (julianday(COALESCE(ended_at, ?)) - julianday(started_at)) * 1440.0), CASE WHEN role = 'acceptance-review' THEN ${cap(acceptanceTimeoutMs)} ELSE ${cap(DEFAULT_AGENT_TIMEOUT_MS)} END)`;
}

/** a token count from usage_json: 0 when the JSON is invalid, the key is missing or not a number (never an error) */
const tok = (key: string) => `COALESCE(CASE WHEN json_valid(usage_json) THEN json_extract(usage_json, '$.${key}') END, 0)`;

interface Row extends UsageTotals {
  ticket_key: string | null;
  role: AgentRole;
  day: string;
}

/**
 * Sums of the agent runs started in the window, one SQL pass grouped by ticket, role and local day (the other groupings
 * are folded from it). Only SQL and json_extract: usage_json is never parsed in JavaScript.
 */
function groupedRows(db: DatabaseSync, since: Date, now: Date, acceptanceTimeoutMs: number): Row[] {
  const rows = db
    .prepare(
      `SELECT ticket_key, role, strftime('%Y-%m-%d', started_at, 'localtime') AS day,
              COUNT(*) AS runs,
              SUM(CASE WHEN status IN ('error','invalid_output') THEN 1 ELSE 0 END) AS failedRuns,
              SUM(${runMinutesSql(acceptanceTimeoutMs)}) AS runMinutes,
              SUM(${tok("input_tokens")}) AS inputTokens,
              SUM(${tok("output_tokens")}) AS outputTokens,
              SUM(${tok("cache_read_input_tokens")}) AS cacheReadTokens,
              SUM(${tok("cache_creation_input_tokens")}) AS cacheWriteTokens,
              SUM(CASE WHEN executor = 'claude-api' THEN COALESCE(cost_usd, 0) ELSE 0 END) AS usd,
              SUM(CASE WHEN executor = 'claude-code' THEN COALESCE(cost_usd, 0) ELSE 0 END) AS estimateUsd
       FROM agent_run WHERE started_at >= ?
       GROUP BY ticket_key, role, day`,
    )
    .all(now.toISOString(), since.toISOString()) as unknown as Row[];
  return rows;
}

const totalCost = (t: UsageTotals): number => t.usd + t.estimateUsd;

const LIMIT_RANGES = { runs: [1, 10000], runMinutes: [1, 100000], usd: [0.01, 100000] } as const;
export { LIMIT_RANGES };

/**
 * Progress against the thresholds over the budget window, for the current executor only (a subscription's runs and an
 * API key's runs each count against their own). maxUsd applies to the API executor alone: a subscription's cost is an
 * API-equivalent estimate, not a charge (ruling C-1). null when budgets are off.
 */
export function budgetProgress(
  db: DatabaseSync,
  o: { now: Date; executor: Config["executor"]["kind"]; budget: Config["budget"]; acceptanceRunTimeoutMs?: number },
): BudgetProgress | null {
  const b = o.budget;
  if (!b.enabled) return null;
  const since = windowStart(b.window, o.now);
  const r = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(${runMinutesSql(o.acceptanceRunTimeoutMs ?? ACCEPTANCE_TIMEOUT_MS)}), 0) AS runMinutes,
              COALESCE(SUM(COALESCE(cost_usd, 0)), 0) AS usd
       FROM agent_run WHERE executor = ? AND started_at >= ?`,
    )
    .get(o.now.toISOString(), o.executor, since.toISOString()) as { runs: number; runMinutes: number; usd: number };
  const limits = { runs: b.maxRuns, runMinutes: b.maxRunMinutes, usd: o.executor === "claude-api" ? b.maxUsd : null };
  const used = { runs: r.runs, runMinutes: r.runMinutes, usd: r.usd };
  let ratio = 0;
  let item: BudgetProgress["item"] = null;
  for (const k of ["runs", "runMinutes", "usd"] as const) {
    const limit = limits[k];
    if (limit === null || limit <= 0) continue;
    const q = used[k] / limit;
    if (item === null || q > ratio) {
      ratio = q;
      item = k;
    }
  }
  const state: BudgetState = item === null ? "ok" : ratio >= 1 ? "over" : ratio >= b.warnAt ? "warn" : "ok";
  return { window: b.window, warnAt: b.warnAt, limits, used, ratio, state, item };
}

export function usageSummary(
  db: DatabaseSync,
  o: { window: UsageWindow; now: Date; executor: Config["executor"]["kind"]; budget: Config["budget"]; paused?: UsagePause | null; acceptanceRunTimeoutMs?: number },
): UsageSummary {
  const since = windowStart(o.window, o.now);
  const rows = groupedRows(db, since, o.now, o.acceptanceRunTimeoutMs ?? ACCEPTANCE_TIMEOUT_MS);
  const totals = emptyTotals();
  const tickets = new Map<string | null, UsageTotals>();
  const roles = new Map<AgentRole, UsageTotals>();
  const days = new Map<string, UsageTotals>();
  const bucket = <K>(m: Map<K, UsageTotals>, k: K): UsageTotals => {
    let t = m.get(k);
    if (t === undefined) m.set(k, (t = emptyTotals()));
    return t;
  };
  for (const row of rows) {
    add(totals, row);
    add(bucket(tickets, row.ticket_key), row);
    add(bucket(roles, row.role), row);
    add(bucket(days, row.day), row);
  }
  const titles = new Map<string, string>(
    (db.prepare("SELECT key, title FROM ticket").all() as { key: string; title: string }[]).map((t) => [t.key, t.title]),
  );
  const byTicket = [...tickets.entries()]
    .map(([ticketKey, t]) => ({ ...t, ticketKey, title: ticketKey === null ? null : (titles.get(ticketKey) ?? null) }))
    .sort((a, b) => totalCost(b) - totalCost(a) || b.runs - a.runs)
    .slice(0, BY_TICKET_LIMIT);
  const byRole = [...roles.entries()].map(([role, t]) => ({ ...t, role })).sort((a, b) => b.runs - a.runs);
  const byDay = [...days.entries()].map(([day, t]) => ({ ...t, day })).sort((a, b) => a.day.localeCompare(b.day));
  return {
    window: o.window,
    since: since.toISOString(),
    now: o.now.toISOString(),
    executor: o.executor,
    totals,
    byTicket,
    byRole,
    byDay,
    budget: budgetProgress(db, o),
    paused: o.paused ?? null,
  };
}
