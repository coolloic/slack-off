export type ChecklistGroup = 'non_functional' | 'principles' | 'edge_cases' | 'cross_repo';

export interface ChecklistItem {
  /** ^[a-z][a-z0-9_]{1,39}$; fixed, rules files add/remove by id. */
  id: string;
  group: ChecklistGroup;
  label: string;
}

export const CHECKLIST_ID = /^[a-z][a-z0-9_]{1,39}$/;

const group = (g: ChecklistGroup, entries: ReadonlyArray<readonly [string, string]>): ChecklistItem[] =>
  entries.map(([id, label]) => ({ id, group: g, label }));

/** The quality checklist every design doc and critique answers item by item (order = UI order). */
export const DEFAULT_CHECKLIST: readonly ChecklistItem[] = Object.freeze([
  ...group('non_functional', [
    ['readability', 'Readability'],
    ['maintainability', 'Maintainability'],
    ['extensibility', 'Extensibility'],
    ['observability', 'Observability'],
    ['security', 'Security'],
    ['reusability', 'Reusability'],
    ['performance', 'Performance'],
    ['reliability', 'Reliability'],
    ['compatibility', 'Compatibility'],
    ['testability', 'Testability'],
  ]),
  ...group('principles', [
    ['solid', 'SOLID'],
    ['dry', 'DRY'],
    ['kiss', 'KISS'],
    ['yagni', 'YAGNI'],
    ['separation_of_concerns', 'Separation of concerns'],
    ['fits_architecture', 'Fits the existing architecture'],
  ]),
  ...group('edge_cases', [
    ['nulls', 'Nulls & empty values'],
    ['extremes', 'Extreme values & large inputs'],
    ['concurrency', 'Concurrency'],
    ['timeouts', 'Timeouts'],
    ['retries', 'Retries & idempotency'],
    ['partial_failure', 'Partial failure'],
  ]),
]);

/** Added when more than one repo is affected. */
export const CROSS_REPO_CHECKLIST: readonly ChecklistItem[] = Object.freeze(
  group('cross_repo', [
    ['api_contracts', 'API contracts between services'],
    ['rollout_order', 'Backward compatibility & rollout order'],
    ['versioning', 'Versioning of shared interfaces'],
  ]),
);

/** Which checklist ids an answer list misses, does not know, or answers more than once. */
export function coverage(
  entries: readonly { item: string }[],
  items: readonly ChecklistItem[],
): { missing: string[]; unknown: string[]; duplicate: string[] } {
  const known = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  const unknown = new Set<string>();
  for (const { item } of entries) {
    if (seen.has(item)) duplicate.add(item);
    seen.add(item);
    if (!known.has(item)) unknown.add(item);
  }
  return {
    missing: items.map((i) => i.id).filter((id) => !seen.has(id)),
    unknown: [...unknown],
    duplicate: [...duplicate],
  };
}
