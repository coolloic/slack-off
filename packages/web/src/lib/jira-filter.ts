import type { TicketState } from "@slackoff/shared";
import { t } from "../i18n/en.ts";
import { NEEDS_YOU } from "./states.ts";

/**
 * Tickets-list JIRA-status filter (author decisions 2026-11-06, 2026-11-08): discovery reads every open ticket assigned
 * to the developer; the list defaults to All open, and the Ready-for-Dev status is a highlight and a quick filter.
 * Values: `status:<name>` (open tickets in that JIRA status), `open` (all open), `closed` (no longer open in JIRA).
 */
export type JiraFilter = string;

interface Row {
  jiraStatus: string | null;
  jiraOpen: boolean;
}

export interface JiraFilterOption {
  value: JiraFilter;
  label: string;
}

const STATUS = "status:";

export function defaultJiraFilter(): JiraFilter {
  return "open";
}

export function matchesJiraFilter(r: Row, f: JiraFilter): boolean {
  if (f === "closed") return !r.jiraOpen;
  if (!r.jiraOpen) return false;
  if (f === "open") return true;
  return f.startsWith(STATUS) && r.jiraStatus === f.slice(STATUS.length);
}

/** All open first, then Ready-for-Dev (even with no ticket), every other open status (sorted), then Closed/reassigned when any. */
export function jiraFilterOptions(
  rows: ReadonlyArray<Row & { state?: TicketState }>,
  readyStatus: string | undefined,
  selected: JiraFilter,
): JiraFilterOption[] {
  const open = rows.filter((r) => r.jiraOpen);
  // each count is what that filter shows under All (active tickets included, F2-R1 minor)
  const shows = (r: Row & { state?: TicketState }, f: JiraFilter) =>
    r.state === undefined ? matchesJiraFilter(r, f) : isVisibleTicket({ ...r, state: r.state }, false, f);
  const count = (f: JiraFilter) => rows.filter((r) => shows(r, f)).length;
  const status = (s: string): JiraFilterOption => ({ value: `${STATUS}${s}`, label: t("tickets.jiraFilterStatus", { status: s, n: count(`${STATUS}${s}`) }) });
  const statuses = new Set(open.map((r) => r.jiraStatus).filter((s): s is string => !!s));
  if (selected.startsWith(STATUS)) statuses.add(selected.slice(STATUS.length));
  if (readyStatus) statuses.delete(readyStatus);
  const out: JiraFilterOption[] = [{ value: "open", label: t("tickets.jiraFilterOpen", { n: count("open") }) }];
  if (readyStatus) out.push(status(readyStatus));
  for (const s of [...statuses].sort((a, b) => a.localeCompare(b))) out.push(status(s));
  const closed = count("closed");
  if (closed > 0 || selected === "closed") out.push({ value: "closed", label: t("tickets.jiraFilterClosed", { n: closed }) });
  return out;
}

export type JiraStatusTone = "ready" | "progress" | "review" | "other";

/** Badge tone for a JIRA status name: the configured Ready-for-Dev / In Progress / review statuses, else neutral. */
export function jiraStatusTone(status: string, names: { ready?: string; inProgress?: string; review?: string }): JiraStatusTone {
  const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
  const s = norm(status);
  if (s && s === norm(names.ready)) return "ready";
  if (s && s === norm(names.inProgress)) return "progress";
  if (s && s === norm(names.review)) return "review";
  return "other";
}

export function isReadyStatus(r: Row, readyStatus: string | undefined): boolean {
  return !!readyStatus && r.jiraOpen && r.jiraStatus === readyStatus;
}

/** States the platform is not working on: the JIRA-status filter applies to these only (F2-I2). */
const NOT_ACTIVE: ReadonlySet<TicketState> = new Set<TicketState>(["discovered", "abandoned", "pr_opened"]);

/** The platform is working on the ticket or waits for a decision (refining … dev_done, blocked, any awaiting_*). */
export function isPlatformActive(state: TicketState): boolean {
  return !NOT_ACTIVE.has(state);
}

/** "Needs me": a decision is waiting, a JIRA write waits for "Send to JIRA", or a delivery JIRA step failed and waits for a retry. */
export function needsMe(r: { state: TicketState; jiraWritePending?: boolean; deliveryStepFailed?: boolean }): boolean {
  return NEEDS_YOU.includes(r.state) || r.jiraWritePending === true || r.deliveryStepFailed === true;
}

/** The header "Needs you" badge: decisions plus pending JIRA writes (each one is something to do). */
export function needsYouCount(s: { needsYou: number; pendingJiraWrites: number } | undefined): number {
  return s ? s.needsYou + s.pendingJiraWrites : 0;
}

/**
 * Whether a ticket shows on the list. "Needs me": every ticket awaiting a developer decision or a JIRA write, whatever
 * its JIRA status or open flag. "All": under the default, All open or a status filter, a ticket the platform is
 * working on is always shown (with its "No longer open" badge when JIRA dropped it) and the filter applies only to the
 * others (e.g. discovered); "Closed/reassigned" shows only tickets no longer open in JIRA.
 */
export function isVisibleTicket(r: Row & { state: TicketState; jiraWritePending?: boolean; deliveryStepFailed?: boolean }, needsOnly: boolean, f: JiraFilter): boolean {
  if (needsOnly) return needsMe(r);
  // Closed/reassigned lists exactly the tickets JIRA no longer returns, active or not
  if (f === "closed") return !r.jiraOpen;
  return isPlatformActive(r.state) || matchesJiraFilter(r, f);
}
