import type { AgentRole } from './roles.ts';

/**
 * Phase 4d (D-7): the roles a prompt draft can be tried with on the fictional sample ticket — the read-only ones.
 * implement-ticket and acceptance-review need a worktree, a sandbox and a running app; the jira-* roles use JIRA.
 */
export const TRIAL_ROLES = ['refine-ticket', 'propose-solutions', 'design-solution', 'critique-design'] as const satisfies readonly AgentRole[];
export type TrialRole = (typeof TRIAL_ROLES)[number];
export const isTrialRole = (r: string): r is TrialRole => (TRIAL_ROLES as readonly string[]).includes(r);

/** The longest developer additions a prompt version (or a trial draft) may have. */
export const PROMPT_TEXT_MAX = 20_000;

/** POST /api/prompts/:role/trial */
export interface TrialResult {
  /** null when the run never started (paused usage, an executor that is unavailable) */
  runId: string | null;
  role: AgentRole;
  ok: boolean;
  /** the output that passed the role's schema, or null */
  output: unknown | null;
  error: string | null;
  durationMs: number;
  costUsd: number | null;
}
