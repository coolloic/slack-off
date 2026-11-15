import type { BudgetProgress, UsagePause, UsageSummary, UsageTotals, UsageWindow } from "@slackoff/shared";
import { t, type MessageKey } from "../i18n/en.ts";
import type { Status } from "./api.ts";

export const USAGE_WINDOW_OPTIONS: ReadonlyArray<{ id: UsageWindow; label: string }> = (["5h", "day", "week", "30d"] as const).map((id) => ({
  id,
  label: t(`cost.window.${id}` as MessageKey),
}));

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The main cost number: a subscription's cost is the CLI's API-equivalent estimate, not a charge (ruling C-1). */
export function costView(s: UsageSummary): { label: string; value: string } {
  return s.executor === "claude-api" ? { label: t("cost.cost"), value: usd(s.totals.usd) } : { label: t("cost.estimate"), value: usd(s.totals.estimateUsd) };
}

const costOf = (totals: UsageTotals, executor: UsageSummary["executor"]): number => (executor === "claude-api" ? totals.usd : totals.estimateUsd);

export function formatMinutes(minutes: number): string {
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

const pct = (ratio: number): number => Math.round(ratio * 100);
const windowName = (w: BudgetProgress["window"]): string => t(`banner.usageWindow.${w}` as MessageKey);

/** "Usage at 84% of your 5-hour budget." while a threshold is in its warning zone; null otherwise. */
export function budgetNotice(b: BudgetProgress | null): string | null {
  return b !== null && b.state === "warn" ? t("banner.usageWarn", { pct: pct(b.ratio), window: windowName(b.window) }) : null;
}

export function progressView(b: BudgetProgress | null): { percent: number; tone: BudgetProgress["state"]; label: string; detail: string } | null {
  if (b === null) return null;
  const item = b.item;
  const limit = item === null ? null : b.limits[item];
  const used = item === null ? 0 : b.used[item];
  const fmt = (n: number): string => (item === "usd" ? n.toFixed(2) : String(Math.round(n * 10) / 10));
  const detail =
    item === null || limit === null
      ? ""
      : t(item === "runs" ? "cost.usageRunsOf" : item === "runMinutes" ? "cost.usageMinutesOf" : "cost.usageUsdOf", { used: fmt(used), limit: fmt(limit) });
  return { percent: Math.min(100, pct(b.ratio)), tone: b.state, label: t("cost.budgetUsed", { pct: pct(b.ratio) }), detail };
}

/** The per-day bars: the last 30 days, oldest first; each height is a share of the largest day (a CSS bar, no chart library). */
export function barView(byDay: ReadonlyArray<UsageTotals & { day: string }>): Array<{ day: string; runs: number; heightPct: number }> {
  const days = byDay.slice(-30);
  const max = Math.max(0, ...days.map((d) => d.runs));
  return days.map((d) => ({ day: d.day, runs: d.runs, heightPct: max === 0 ? 0 : Math.round((d.runs / max) * 100) }));
}

export function emptyText(s: UsageSummary): string | null {
  return s.totals.runs === 0 ? t("cost.empty") : null;
}

/** The global banner: paused (links to Cost & quota, says how many tickets wait) or the warning zone; null otherwise. */
export function bannerView(usage: Status["usage"] | undefined): { kind: "paused" | "warn"; text: string; to: string } | null {
  if (usage === undefined) return null;
  if (usage.paused !== null) {
    const waiting = usage.waitingTickets > 0 ? ` ${t("banner.usageWaiting", { n: usage.waitingTickets })}` : "";
    return { kind: "paused", text: `${t("banner.usagePaused", { reason: usage.paused.detail })}${waiting}`, to: "/cost" };
  }
  if (usage.budgetState === "warn" && usage.budgetRatio !== null && usage.budgetWindow !== null) {
    return { kind: "warn", text: t("banner.usageWarn", { pct: pct(usage.budgetRatio), window: windowName(usage.budgetWindow) }), to: "/cost" };
  }
  return null;
}

/**
 * The sticky bar's action. 4C-1 (M3): with the API key (real money) only this computer resumes, so on a paired phone
 * Resume is disabled and says where to do it (the server refuses it too); pausing is always allowed.
 */
export function pauseBar(
  paused: UsagePause | null,
  // local undefined: /api/status has not answered yet; for the one case that depends on it, assume a phone until it does
  ctx: { local: boolean | undefined; executor: "claude-code" | "claude-api" } = { local: true, executor: "claude-code" },
): { action: "pause" | "resume"; label: string; thisWill: string; disabled: boolean } {
  if (paused === null) return { action: "pause", label: t("cost.pause"), thisWill: t("cost.pauseThisWill"), disabled: false };
  // F4C-1 (M-4): with the API key a phone resumes a manual or usage-limit pause; a threshold pause only on this computer
  if (ctx.local !== true && ctx.executor === "claude-api" && paused.reason === "threshold") return { action: "resume", label: t("cost.resume"), thisWill: t("cost.resumeOnComputer"), disabled: true };
  return { action: "resume", label: t("cost.resume"), thisWill: t("cost.resumeThisWill"), disabled: false };
}

/** The server refuses a phone resuming a threshold pause under the API key (403): say where to resume instead. */
export function resumeErrorText(error: string | undefined): string | undefined {
  return error !== undefined && /can only be resumed on this computer/.test(error) ? t("cost.resumeOnComputer") : error;
}

/** On a blocked ticket the usage gate stopped, once usage is resumed: Retry is what continues it (ruling C-3). */
export function resumedRetryNote(blockedReason: string | null, pausedNow: boolean): string | null {
  return !pausedNow && blockedReason !== null && blockedReason.startsWith("Paused:") ? t("ticket.resumedRetry") : null;
}

/** On a phone the by-ticket table is a list: one item per ticket, its columns folded into a line. */
export function phoneTicketRows(
  byTicket: UsageSummary["byTicket"],
  executor: UsageSummary["executor"],
): Array<{ key: string; heading: string; title: string; meta: string }> {
  return byTicket.map((r) => ({
    key: r.ticketKey ?? "none",
    heading: r.ticketKey ?? t("cost.noTicket"),
    title: r.ticketKey === null ? t("cost.noTicketNote") : (r.title ?? ""),
    meta: `${t("cost.run", { n: r.runs })} · ${usd(costOf(r, executor))}`,
  }));
}

/** L3: usage was resumed but the threshold is still over: the next run would pause again. */
export function stillOverNote(s: UsageSummary): string | null {
  return s.paused === null && s.budget !== null && s.budget.state === "over" ? t("cost.stillOver") : null;
}
