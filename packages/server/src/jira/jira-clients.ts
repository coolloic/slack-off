// Phase 4b Task 5: the JIRA implementation — the developer's Chrome (browser mode) or Jira Cloud REST (API mode) —
// chosen from config.jira.source, like the executor reads claudeBin per call: a Settings change applies without a
// restart. 4B-9 (M3): inside a job (`pinned`, the job queue's `around`) the mode is the one the job started with, so a
// write and its read-back never use two modes; outside a job each call reads the setting when it starts. There is never a fallback from one mode to the other: a missing token in API mode
// is JiraNotConfiguredError from the API implementation, not a browser run.
import { AsyncLocalStorage } from "node:async_hooks";
import type { DiscoverResult, FetchedTicket, JiraCommentResult, JiraUpdateResult } from "@slackoff/shared";
import type { Config } from "../config.ts";
import type { JiraCommenter } from "./jira-commenter.ts";
import type { JiraUpdater } from "./jira-updater.ts";
import type { JiraMode, TicketSource } from "./ticket-source.ts";

export interface JiraImpl {
  source: TicketSource;
  updater: JiraUpdater;
  commenter: JiraCommenter;
}

export interface JiraClients extends JiraImpl {
  /** runs `fn` with the JIRA mode as it is now, for every call inside it (the job queue wraps each job in it) */
  pinned<T>(fn: () => Promise<T>): Promise<T>;
  /** the mode a call made now would use: the job's pinned mode inside a job, else the setting (M5: the jobs' wording) */
  mode(): JiraMode;
}

export function jiraClients(o: { config: Config; browser: JiraImpl; api: JiraImpl }): JiraClients {
  const mode = new AsyncLocalStorage<Config["jira"]["source"]>();
  const pick = (): JiraImpl => ((mode.getStore() ?? o.config.jira.source) === "api" ? o.api : o.browser);
  return {
    pinned: (fn) => mode.run(o.config.jira.source, fn),
    mode: () => mode.getStore() ?? o.config.jira.source,
    source: {
      discover: (): Promise<DiscoverResult> => pick().source.discover(),
      fetchTicket: (key: string): Promise<FetchedTicket> => pick().source.fetchTicket(key),
    },
    updater: {
      setStatus: (key: string, target: string): Promise<JiraUpdateResult> => pick().updater.setStatus(key, target),
    },
    commenter: {
      postComment: (key: string, text: string): Promise<JiraCommentResult> => pick().commenter.postComment(key, text),
    },
  };
}
