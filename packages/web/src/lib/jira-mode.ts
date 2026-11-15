import { t, type MessageKey } from "../i18n/en.ts";

/** Phase 4b: how JIRA is read and written — the developer's Chrome, or the JIRA API (config.jira.source). */
export type JiraMode = "browser" | "api";

export const JIRA_TEXT_KEYS = [
  "dev.jiraThisWill", "dev.jiraRunning", "req.comment.thisWill", "tickets.fetchThisWill", "tickets.blockedThisWill",
  "settings.syncStatusThisWill", "snap.fetchedViaValue", "tickets.discoverLogin",
] as const satisfies readonly MessageKey[];
export type JiraTextKey = (typeof JIRA_TEXT_KEYS)[number];

/**
 * F4B-4: a JIRA-facing message in the words of `mode`: `<key>` for the browser, `<key>.api` for the JIRA API. A row
 * from before phase 4b has no mode (null): it was read or sent in the browser.
 */
export function jiraText(key: JiraTextKey, mode: JiraMode | null | undefined, vars?: Record<string, string | number>): string {
  return t(mode === "api" ? (`${key}.api` as MessageKey) : key, vars);
}
