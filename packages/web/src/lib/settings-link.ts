/** Settings sections, in nav order; also the `/settings#<id>` anchors. */
export const SETTINGS_SECTIONS = [
  "executor", "jira", "repos", "prompts", "preferences", "workflow", "budget", "tracing", "acceptance", "delivery", "remote",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function settingsSectionFromHash(hash: string): SettingsSection | null {
  const id = hash.replace(/^#/, "");
  return (SETTINGS_SECTIONS as readonly string[]).includes(id) ? (id as SettingsSection) : null;
}

// Reasons are server-written English; the capitalised word "Settings" is how the server says "fix this there".
const RULES: ReadonlyArray<[RegExp, SettingsSection]> = [
  [/Settings → JIRA|JIRA browser in Settings|discovery limit in Settings|JIRA status sync is off/i, "jira"],
  [/Settings → Executor|Anthropic API key/i, "executor"],
  [/delivery\.ghBin/, "delivery"],
  [/repo in Settings|fix Settings|no longer mapped/, "repos"],
];

/** Where a blocked/error reason asks the user to go, or null when it does not point at Settings. */
export function settingsHrefFor(reason: string | null | undefined): string | null {
  if (!reason || !/\bSettings\b/.test(reason)) return null;
  const hit = RULES.find(([re]) => re.test(reason));
  return hit ? `/settings#${hit[1]}` : "/settings";
}

/** A block the developer answers on Retry: the developer agent's question (needsInput) or its stop after idle steps. */
export function asksForAnswer(reason: string | null | undefined): boolean {
  return !!reason && (reason.startsWith("Needs your input: ") || reason.startsWith("The agent changed nothing in "));
}
