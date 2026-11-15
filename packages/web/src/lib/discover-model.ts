import { t } from "../i18n/en.ts";
import type { DiscoveryRun } from "./api.ts";
import { jiraText, type JiraMode } from "./jira-mode.ts";

/** Payload of the server's `discover_finished` event (F-I3). */
export interface DiscoverOutcome {
  created: number;
  /** valid tickets read */
  returned: number;
  /** open tickets assigned to the developer, as JIRA reported */
  total: number;
  /** every open ticket was read */
  complete: boolean;
  loginRequired?: true;
  error?: string;
}

export type DiscoverPhase = { phase: "idle" } | { phase: "running" } | { phase: "finished"; result: DiscoverOutcome };

export interface DiscoverView {
  busy: boolean;
  message: string | null;
  tone: "info" | "success" | "error";
}

/** What the "Fetch new tickets" control shows: spinner while the discovery job runs, then its outcome. */
export function discoverView(d: DiscoverPhase, mode?: JiraMode): DiscoverView {
  if (d.phase === "idle") return { busy: false, message: null, tone: "info" };
  if (d.phase === "running") return { busy: true, message: t("tickets.discoverRunning"), tone: "info" };
  const r = d.result;
  if (r.loginRequired) return { busy: false, message: jiraText("tickets.discoverLogin", mode), tone: "error" };
  if (r.error) return { busy: false, message: t("tickets.discoverError", { error: r.error }), tone: "error" };
  if (r.total === 0 && r.returned === 0) return { busy: false, message: t("tickets.discoverNone"), tone: "info" };
  return { busy: false, message: t("tickets.discoverFound", { n: r.created, m: r.total }), tone: r.created > 0 ? "success" : "info" };
}

/** Shown on the Tickets list while the last discovery stopped before reading every open ticket (limit or unreadable page). */
export function incompleteNotice(last: DiscoveryRun | null | undefined): string | null {
  if (!last || last.complete) return null;
  return t("tickets.discoverIncomplete", { x: last.returned, y: last.total });
}
