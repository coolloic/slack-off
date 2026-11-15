import type { ChoiceFeatures, StoredSolution } from "@slackoff/shared";

const RANK = { S: 0, M: 1, L: 2 } as const;

/**
 * Phase 4d (§9.4, D-1/D-2): the features of one choice among the solution set it was made from. Deterministic, numbers
 * and enums only — no solution title, approach or note text leaves this function. `note`: the developer's note on the
 * choice (only whether there is one is kept).
 */
export function choiceFeatures(
  chosen: StoredSolution,
  all: readonly StoredSolution[],
  note: string | null = null,
  /** 4D-2 (N2): the repositories the developer chose (they may edit the proposal's set); null → the solution's own */
  chosenRepos: readonly string[] | null = null,
): ChoiceFeatures {
  const options = all.length > 0 ? all : [chosen];
  const ranks = options.map((s) => RANK[s.complexity]);
  const min = Math.min(...ranks);
  const max = Math.max(...ranks);
  const mine = RANK[chosen.complexity];
  const complexityRank: ChoiceFeatures["complexityRank"] =
    options.length === 1 ? "only" : min === max ? "tied" : mine === min ? "lowest" : mine === max ? "highest" : "middle";
  const deps = (s: StoredSolution) => (s.newDependencies ?? []).length > 0;
  return {
    optionCount: options.length,
    complexity: chosen.complexity,
    complexityRank,
    addsDependency: deps(chosen),
    anyOptionAddsDependency: options.some(deps),
    // what the developer chose, against the range the proposals offered (4D-2 N2)
    repoCount: chosenRepos?.length ?? chosen.affectedRepos.length,
    minRepoCount: Math.min(...options.map((s) => s.affectedRepos.length)),
    maxRepoCount: Math.max(...options.map((s) => s.affectedRepos.length)),
    scopeSize: chosen.changeScope.length,
    minScopeSize: Math.min(...options.map((s) => s.changeScope.length)),
    maxScopeSize: Math.max(...options.map((s) => s.changeScope.length)),
    hasNote: (note ?? "").trim() !== "",
  };
}

/** A tendency is stated only over at least this many comparable choices… */
export const MIN_SIGNALS = 3;
/** …and only when at least this share of them agree. */
export const MIN_SHARE = 0.6;
/** Only the newest signals take part. */
export const MAX_SIGNALS = 20;

/** k of n agree, with n ≥ MIN_SIGNALS and k/n ≥ MIN_SHARE */
const holds = (k: number, n: number): boolean => n >= MIN_SIGNALS && k / n >= MIN_SHARE;

/**
 * Phase 4d (D-1): the preference summary, from fixed sentences and counts only (never solution or note text: the text
 * goes into the propose-solutions agent's system prompt). `signals`: the live signals, oldest first; only the newest
 * MAX_SIGNALS count. One sentence per line; '' when no tendency holds.
 */
export function deriveSummary(signals: readonly ChoiceFeatures[]): { text: string; counted: number } {
  const used = signals.slice(-MAX_SIGNALS);
  const lines: string[] = [];

  const ranked = used.filter((s) => s.complexityRank === "lowest" || s.complexityRank === "middle" || s.complexityRank === "highest");
  const lowest = ranked.filter((s) => s.complexityRank === "lowest").length;
  const highest = ranked.filter((s) => s.complexityRank === "highest").length;
  if (holds(lowest, ranked.length)) lines.push(`In ${lowest} of ${ranked.length} comparable choices you picked the simplest option (lowest complexity).`);
  else if (holds(highest, ranked.length)) lines.push(`In ${highest} of ${ranked.length} comparable choices you picked the most complex option (highest complexity).`);

  const withDeps = used.filter((s) => s.anyOptionAddsDependency);
  const avoided = withDeps.filter((s) => !s.addsDependency).length;
  const added = withDeps.length - avoided;
  if (holds(avoided, withDeps.length)) lines.push(`You avoided new dependencies in ${avoided} of ${withDeps.length} comparable choices (where an option added one).`);
  else if (holds(added, withDeps.length)) lines.push(`You chose an option that adds a new dependency in ${added} of ${withDeps.length} comparable choices (where an option added one).`);

  // 4D-1: comparable only where the options differ on the feature (a tie, or an older signal without the max, says nothing)
  const repoComparable = used.filter((s) => s.optionCount > 1 && s.maxRepoCount !== undefined && s.maxRepoCount > s.minRepoCount);
  const fewestRepos = repoComparable.filter((s) => s.repoCount <= s.minRepoCount).length;
  if (holds(fewestRepos, repoComparable.length)) {
    lines.push(`You usually chose the option that changes the fewest repositories (${fewestRepos} of ${repoComparable.length} comparable choices).`);
  }
  const scopeComparable = used.filter((s) => s.optionCount > 1 && s.maxScopeSize !== undefined && s.maxScopeSize > s.minScopeSize);
  const smallestScope = scopeComparable.filter((s) => s.scopeSize <= s.minScopeSize).length;
  if (holds(smallestScope, scopeComparable.length)) {
    lines.push(`You usually chose the option with the smallest change scope (${smallestScope} of ${scopeComparable.length} comparable choices).`);
  }

  return { text: lines.join("\n"), counted: used.length };
}
