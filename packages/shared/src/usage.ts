import type { AgentRole } from './roles.ts';

export type UsageWindow = '5h' | 'day' | 'week' | '30d';
export const USAGE_WINDOWS: readonly UsageWindow[] = ['5h', 'day', 'week', '30d'];

/** Phase 4c: one set of sums over agent runs. `usd` is the cost of API-key runs; `estimateUsd` the CLI's API-equivalent estimate of subscription runs. */
export interface UsageTotals {
  runs: number;
  failedRuns: number;
  runMinutes: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  estimateUsd: number;
}

export type BudgetState = 'ok' | 'warn' | 'over';
export type BudgetWindow = '5h' | 'day' | 'week';

export interface BudgetProgress {
  window: BudgetWindow;
  warnAt: number;
  limits: { runs: number | null; runMinutes: number | null; usd: number | null };
  used: { runs: number; runMinutes: number; usd: number };
  /** the largest used/limit over the limits that apply */
  ratio: number;
  state: BudgetState;
  /** which limit is the largest (null when no limit applies) */
  item: 'runs' | 'runMinutes' | 'usd' | null;
}

export type UsagePauseReason = 'manual' | 'threshold' | 'limit_reached';

export interface UsagePause {
  id: number;
  reason: UsagePauseReason;
  detail: string;
  pausedBy: string;
  pausedAt: string;
}

export interface UsageSummary {
  window: UsageWindow;
  since: string;
  now: string;
  executor: 'claude-code' | 'claude-api';
  totals: UsageTotals;
  /** null ticketKey = runs without a ticket (discovery, trial runs) */
  byTicket: (UsageTotals & { ticketKey: string | null; title: string | null })[];
  byRole: (UsageTotals & { role: AgentRole })[];
  /** day = YYYY-MM-DD in the server's local time zone */
  byDay: (UsageTotals & { day: string })[];
  budget: BudgetProgress | null;
  paused: UsagePause | null;
}
