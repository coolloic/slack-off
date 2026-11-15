import { z } from 'zod';

/**
 * Phase 4d (§9.4, D-1): what one choice says about the developer's preferences, computed deterministically from the
 * solution set at the time of the choice. Numbers and enums only: no solution or note text.
 */
export const ChoiceFeatures = z.object({
  optionCount: z.number().int().min(1),
  complexity: z.enum(['S', 'M', 'L']),
  /** S < M < L; 'only' = a single option, 'tied' = every option has the same complexity */
  complexityRank: z.enum(['only', 'lowest', 'middle', 'highest', 'tied']),
  addsDependency: z.boolean(),
  anyOptionAddsDependency: z.boolean(),
  /** 4D-2 (N2): the repositories the developer chose (the solution's own set when none was given) */
  repoCount: z.number().int().min(0),
  /** min / max over the proposals' affectedRepos */
  minRepoCount: z.number().int().min(0),
  /** 4D-1: absent on signals recorded before fix round 1 (then not comparable on repositories) */
  maxRepoCount: z.number().int().min(0).optional(),
  scopeSize: z.number().int().min(0),
  minScopeSize: z.number().int().min(0),
  /** 4D-1: absent on signals recorded before fix round 1 (then not comparable on scope) */
  maxScopeSize: z.number().int().min(0).optional(),
  hasNote: z.boolean(),
});
export type ChoiceFeatures = z.infer<typeof ChoiceFeatures>;

export type PreferenceSource = 'derived' | 'edited' | 'cleared';

/** One version of the preference summary (append-only). */
export interface PreferenceSummary {
  version: number;
  text: string;
  source: PreferenceSource;
  createdAt: string;
}

/** GET /api/preferences */
export interface PreferenceState {
  current: PreferenceSummary | null;
  /** the text derived from the current signals now (what Re-derive would save) */
  derivedPreview: string;
  /** when the current version is 'edited': choices recorded since that edit; otherwise 0 */
  signalsSinceEdit: number;
  /** signals that take part in derivation (not superseded, after the last clear, the latest 20) */
  counted: number;
  /** MIN_SIGNALS */
  needed: number;
}

/** The longest preference text the developer may save. */
export const PREFERENCE_TEXT_MAX = 2000;
