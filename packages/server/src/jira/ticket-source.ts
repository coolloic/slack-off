import type { DiscoverResult, FetchedTicket } from "@slackoff/shared";
import { BrowserChoiceRequiredError } from "../executor/types.ts";

export interface TicketSource {
  discover(): Promise<DiscoverResult>;
  fetchTicket(key: string): Promise<FetchedTicket>;
}

export class JiraLoginRequiredError extends Error {
  constructor(message = "JIRA login required: sign in to JIRA in Chrome and retry") {
    super(message);
    this.name = "JiraLoginRequiredError";
  }
}

/** The browser agent could not read JIRA (no connected browser, a page that did not load): nothing was read. */
export class JiraReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraReadError";
  }
}

/** Phase 4b: where JIRA is read and written (config.jira.source; pinned per job). */
export type JiraMode = "browser" | "api";

/** M5 (tasks 4-5 review): what a JIRA login failure tells the developer to do, in the mode the job ran in. */
export const BROWSER_LOGIN_MESSAGE = "JIRA needs you to log in: sign in to JIRA in Chrome, then retry";
export const API_TOKEN_REJECTED = "JIRA rejected the API token — update it in Settings → JIRA";
export const jiraLoginMessage = (mode: JiraMode): string => (mode === "api" ? API_TOKEN_REJECTED : BROWSER_LOGIN_MESSAGE);
/** The read-side login error of a mode (the browser mode keeps its original text). */
export const jiraLoginError = (mode: JiraMode): JiraLoginRequiredError => (mode === "api" ? new JiraLoginRequiredError(API_TOKEN_REJECTED) : new JiraLoginRequiredError());
/** Who reported a refused write: the browser agent, or JIRA itself (REST). */
export const jiraWriter = (mode: JiraMode): { status: string; comment: string } =>
  mode === "api"
    ? { status: "JIRA did not change the status", comment: "JIRA did not take the comment" }
    : { status: "The browser agent could not change the status", comment: "The browser agent could not post the comment" };

export class JiraNotConfiguredError extends Error {
  /** phase 4b: the JIRA API mode also says when its token is missing */
  constructor(message = "Set your JIRA URL in Settings") {
    super(message);
    this.name = "JiraNotConfiguredError";
  }
}

/** Errors the developer fixes in JIRA, Chrome or Settings (login, URL, browser choice): shown as the source_error banner
 * (ruling A-2), by the ticket jobs and by the JIRA write alike. */
export function isSourceError(err: unknown): boolean {
  return err instanceof JiraLoginRequiredError || err instanceof JiraNotConfiguredError || err instanceof BrowserChoiceRequiredError;
}
