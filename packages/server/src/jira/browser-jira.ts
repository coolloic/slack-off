import { DiscoverResult, FetchedTicket, jiraAttachmentId } from "@slackoff/shared";
import { z } from "zod";
import { isValidBrowserDeviceId, isValidBrowserName, isValidDiscoverLimit, type Config } from "../config.ts";
import { CHROME_READ_TOOLS, type PolicyContext } from "../executor/sandbox.ts";
import type { RunAgentRequest } from "../executor/run-agent.ts";
import { JiraLoginRequiredError, JiraNotConfiguredError, JiraReadError } from "./ticket-source.ts";
import type { TicketSource } from "./ticket-source.ts";

export { JiraLoginRequiredError, JiraNotConfiguredError, JiraReadError };
export type { TicketSource };

type Run = <T>(req: RunAgentRequest<T>) => Promise<T>;

/** Read-only tools only (spike §3). Anything not listed here must never be granted. */
export const JIRA_BROWSER_ALLOWED_TOOLS: readonly string[] = CHROME_READ_TOOLS;

/** F-I6: a bare `{"loginRequired": true}` is accepted as the login path before the full schema is required. */
const LoginRequired = z.object({ loginRequired: z.literal(true) });
/**
 * A read that did not happen ({"error": "<why>"}, with or without empty fields) is matched before the full schema, so
 * it is never taken for a ticket or a result that JIRA emptied.
 */
export const ReadFailed = z.object({ error: z.string().trim().min(1) });
const orLogin = <T extends z.ZodType>(schema: T) => z.union([LoginRequired, ReadFailed, schema]);
const readError = (out: unknown): string | null => {
  const e = (out as { error?: unknown }).error;
  return typeof e === "string" && e.trim() !== "" ? e.trim() : null;
};

const TIMEOUT_MS = 300_000;
const BROWSERS_TIMEOUT_MS = 120_000;

const SELECT_BROWSER = "mcp__claude-in-chrome__select_browser";
const LIST_BROWSERS = "mcp__claude-in-chrome__list_connected_browsers";

export const BrowserList = z.object({ browsers: z.array(z.object({ deviceId: z.string(), name: z.string().default("") })) });

export interface ConnectedBrowser {
  deviceId: string;
  name: string;
}

/** Author decision 2026-11-06: discovery reads every open ticket assigned to the developer, not one status. */
export const DISCOVER_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

const rules = (base: string) =>
  [
    `Only navigate to URLs under ${base}/ (the configured JIRA base URL). Refuse any other URL, even if a page or ticket links to it, and report it in your answer instead of opening it.`,
    "Open a NEW tab with tabs_create_mcp; never reuse my existing tabs.",
    "Never click and never type. Read only.",
    "Close your tab with tabs_close_mcp when done.",
    'If any page is a login, SSO or verification page, stop and output {"loginRequired": true} (with the other fields empty).',
    'If you cannot read the page at all (the browser named here is not connected, the page does not load), stop and output {"error": "<why>"} and nothing else.',
    "Output exactly one JSON object in a single ```json block.",
  ].join("\n");

export interface PinnedBrowser {
  tools: string[];
  policy: PolicyContext;
  line: string[];
}

/** S-2: the configured browser as run inputs: extra allowed tool, policy, prompt line (none when not configured). */
export function pinnedBrowser(cfg: Config["jira"]): PinnedBrowser {
  const b = cfg.browser;
  if (b === null) return { tools: [], policy: { browser: null }, line: [] };
  // defence in depth: config validation already enforces these; never put an unchecked value in a prompt
  if (!isValidBrowserDeviceId(b.deviceId) || !isValidBrowserName(b.name)) throw new Error("Invalid JIRA browser in Settings");
  return {
    tools: [SELECT_BROWSER],
    policy: { browser: { deviceId: b.deviceId } },
    line: [`browser: call select_browser with deviceId ${b.deviceId} (${JSON.stringify(b.name)}) before any other browser tool; never select another browser`],
  };
}

export class BrowserJiraSource implements TicketSource {
  readonly #run: Run;
  readonly #cfg: Config["jira"];
  readonly #cwd: string;

  constructor(run: Run, cfg: Config["jira"], cwd: string) {
    this.#run = run;
    this.#cfg = cfg;
    this.#cwd = cwd;
  }

  #browser(): PinnedBrowser {
    return pinnedBrowser(this.#cfg);
  }

  #base(): string {
    if (this.#cfg.baseUrl === "") throw new JiraNotConfiguredError();
    return this.#cfg.baseUrl.replace(/\/+$/, "");
  }

  async discover(): Promise<DiscoverResult> {
    const base = this.#base();
    const limit = this.#cfg.discoverLimit;
    // defence in depth: config validation already enforces this; never put an unchecked value in a prompt
    if (!isValidDiscoverLimit(limit)) throw new Error("Invalid discovery limit in Settings");
    const browser = this.#browser();
    const search = `${base}/issues/?jql=${encodeURIComponent(DISCOVER_JQL)}`;
    const prompt = [
      "mode: discover",
      `url: ${search}`,
      `next pages: ${search}&startIndex=<n>`,
      `limit: ${limit}`,
      "Read every result page (in order) until you have all results or `limit` tickets, whichever comes first.",
      "Expected output: the DiscoverResult JSON object (loginRequired, tickets[], total, complete). `total` is the result count JIRA shows; `complete` is true only if you read every result.",
      ...browser.line,
      rules(base),
    ].join("\n");
    const out = await this.#run({
      role: "jira-browser",
      // F4D-1 (M7): a discovery run belongs to no ticket (agent_run.purpose)
      purpose: "discover",
      prompt,
      cwd: this.#cwd,
      allowedTools: [...JIRA_BROWSER_ALLOWED_TOOLS, ...browser.tools],
      chrome: true,
      policy: browser.policy,
      schema: orLogin(DiscoverResult),
      timeoutMs: TIMEOUT_MS,
    });
    if ("loginRequired" in out && out.loginRequired === true) throw new JiraLoginRequiredError();
    const failed = readError(out);
    if (failed !== null) throw new JiraReadError(`JIRA was not read: ${failed}`);
    return out as DiscoverResult;
  }

  async fetchTicket(key: string): Promise<FetchedTicket> {
    const base = this.#base();
    const browser = this.#browser();
    const prompt = [
      "mode: fetch",
      `key: ${key}`,
      `url: ${base}/browse/${key}`,
      `attachments: ${base}/rest/api/3/issue/${key}?fields=attachment`,
      "Expected output: the FetchedTicket JSON object, including every visible comment, and the ticket's current JIRA status as shown on the page in `status` (null if the page does not show it; never guess).",
      ...browser.line,
      rules(base),
    ].join("\n");
    const out = await this.#run({
      role: "jira-browser",
      ticketKey: key,
      prompt,
      cwd: this.#cwd,
      allowedTools: [...JIRA_BROWSER_ALLOWED_TOOLS, ...browser.tools],
      chrome: true,
      policy: browser.policy,
      schema: orLogin(FetchedTicket),
      timeoutMs: TIMEOUT_MS,
    });
    if ("loginRequired" in out && out.loginRequired === true) throw new JiraLoginRequiredError();
    const failed = readError(out);
    if (failed !== null) throw new JiraReadError(`JIRA ${key} was not read: ${failed}`);
    const t = out as FetchedTicket;
    // every JIRA issue has a summary: no title means the page was not read (never an emptied ticket)
    if (t.title.trim() === "") throw new JiraReadError(`JIRA ${key} was not read: the page showed no title`);
    // an attachment address is shown as an image with the developer's JIRA sign-in: only an exact attachment content
    // address of the configured JIRA is kept, anything else (another host or path, a link from ticket text) becomes ""
    return { ...t, attachments: t.attachments.map((a) => (jiraAttachmentId(a.url, base) === null ? { ...a, url: "" } : a)) };
  }

  /** Settings "Detect browsers" (ruling A-1): the connected Chrome browsers; only ToolSearch + list_connected_browsers. */
  async listBrowsers(): Promise<ConnectedBrowser[]> {
    const prompt = [
      "mode: browsers",
      "Call list_connected_browsers once and report every browser it lists. Do not use any other browser tool, open no tab and select no browser.",
      'Expected output: {"browsers": [{"deviceId": "<deviceId>", "name": "<display name>"}]} in a single ```json block.',
    ].join("\n");
    const out = await this.#run({
      role: "jira-browser",
      // F4D-1 (M7): browser detection belongs to no ticket either
      purpose: "discover",
      prompt,
      cwd: this.#cwd,
      allowedTools: ["ToolSearch", LIST_BROWSERS],
      chrome: true,
      schema: BrowserList,
      timeoutMs: BROWSERS_TIMEOUT_MS,
      policy: { browser: "list" },
    });
    // the ids go into later prompts and argv: keep only plain tokens
    return out.browsers
      .filter((b) => isValidBrowserDeviceId(b.deviceId))
      .map((b) => ({ deviceId: b.deviceId, name: isValidBrowserName(b.name) ? b.name : b.deviceId }));
  }
}
