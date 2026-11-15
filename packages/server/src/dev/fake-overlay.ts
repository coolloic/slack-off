// Phase 4a Task 7 item 3 (phase 3 Task 17 minor): fake mode's in-memory settings — the acceptance config dir next to
// the data dir, the fake JIRA URL and the FAKE project — are an overlay on the saved config, never part of it. A
// Settings save writes what is on disk plus what the request changed; the overlay is applied again afterwards.
import { DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR, type Config, type RepoRef } from "../config.ts";

export interface FakeOverlay {
  /** set when the saved acceptance.claudeConfigDir is the default */
  claudeConfigDir?: string;
  /** set when no JIRA URL is saved */
  jiraBaseUrl?: string;
  /** set when no FAKE project with repos is saved */
  projects?: Record<string, { repos: RepoRef[] }>;
}

/** Put the overlay on `c` where `c` still has the unset value it replaces (an explicit setting is kept). */
export function applyFakeOverlay(c: Config, o: FakeOverlay): void {
  if (o.claudeConfigDir !== undefined && c.acceptance.claudeConfigDir === DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR) c.acceptance.claudeConfigDir = o.claudeConfigDir;
  if (o.jiraBaseUrl !== undefined && c.jira.baseUrl === "") c.jira.baseUrl = o.jiraBaseUrl;
  for (const [key, p] of Object.entries(o.projects ?? {})) {
    if (!c.projects[key]?.repos.length) c.projects = { ...c.projects, [key]: p };
  }
}

/**
 * What to save for the request's config `next`: every overlaid field keeps `disk`'s value, whether the request
 * changed it or not (4A-15 M-6: fake mode never saves the FAKE project, its scratch paths or the fake JIRA URL).
 */
export function withoutFakeOverlay(next: Config, disk: Config, o: FakeOverlay): Config {
  const out = structuredClone(next);
  if (o.claudeConfigDir !== undefined) out.acceptance.claudeConfigDir = disk.acceptance.claudeConfigDir;
  if (o.jiraBaseUrl !== undefined) out.jira.baseUrl = disk.jira.baseUrl;
  for (const key of Object.keys(o.projects ?? {})) {
    if (disk.projects[key] !== undefined) out.projects[key] = disk.projects[key];
    else delete out.projects[key];
  }
  return out;
}
