import { AlertTriangle, ArrowRight, Bot, CheckCircle2, Info, Loader2, Kanban, List, Play, RefreshCw, RotateCw, Search, Trash2, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { agentName } from "../lib/agent-name.ts";
import { Link, useSearchParams } from "react-router";
import { AsyncView, ErrorBox } from "../components/AsyncView.tsx";
import { JiraKeyLink } from "../components/JiraKeyLink.tsx";
import { StateBadge } from "../components/StateBadge.tsx";
import { ThisWill } from "../components/ThisWill.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Switch } from "../components/ui/switch.tsx";
import { Tooltip } from "../components/ui/tooltip.tsx";
import { t } from "../i18n/en.ts";
import { api, paths, type Config, type DiscoveryRun, type Status, type TicketRow } from "../lib/api.ts";
import { discoverView, incompleteNotice } from "../lib/discover-model.ts";
import { jiraText, type JiraMode } from "../lib/jira-mode.ts";
import { defaultJiraFilter, isVisibleTicket, jiraFilterOptions, jiraStatusTone, needsMe } from "../lib/jira-filter.ts";
import { startDiscover, useAction, useApi, useLive } from "../lib/hooks.ts";
import { NEEDS_YOU } from "../lib/states.ts";
import { defaultTab } from "../lib/tabs.ts";
import { cn, timeAgo } from "../lib/utils.ts";

/** Default tab to open for a ticket, by state. */
const STATE_ACTION_NEEDED = (r: TicketRow): boolean => NEEDS_YOU.includes(r.state) && r.state !== "blocked";

const STATUS_BADGE = { ready: "info", progress: "running", review: "done", other: "queued" } as const;

/** JIRA status as a badge, toned by the configured Ready-for-Dev / In Progress / review statuses; "No longer open in JIRA" once a complete fetch dropped it. */
function JiraStatus({ r, names, className }: { r: TicketRow; names: { ready?: string; inProgress?: string; review?: string }; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-1", className)}>
      {r.jiraStatus ? (
        <Badge tone={STATUS_BADGE[jiraStatusTone(r.jiraStatus, names)]} className="h-auto min-h-5 whitespace-normal break-words" data-testid="jira-status">
          {r.jiraStatus}
        </Badge>
      ) : (
        <span>{t("common.none")}</span>
      )}
      {!r.jiraOpen && (
        <Badge tone="muted" title={t("tickets.noLongerOpenHelp")} data-testid="no-longer-open">
          {t("tickets.noLongerOpen")}
        </Badge>
      )}
    </span>
  );
}

/** F2-I2: a JIRA write waits for "Send to JIRA" on the Development tab. */
function JiraWriteChip({ r }: { r: TicketRow }) {
  if (r.deliveryStepFailed && !r.jiraWritePending) {
    return (
      <Link to={`/tickets/${r.key}/delivery`} title={t("tickets.deliveryStepFailedHelp")} data-testid="delivery-step-failed" className="inline-flex min-h-11 shrink-0 items-center md:min-h-0">
        <Badge tone="blocked">{t("tickets.deliveryStepFailed")}</Badge>
      </Link>
    );
  }
  if (!r.jiraWritePending) return null;
  return (
    <Link
      to={`/tickets/${r.key}/development`}
      title={t("tickets.jiraWritePendingHelp")}
      data-testid="jira-write-pending"
      className="inline-flex min-h-11 shrink-0 items-center md:min-h-0"
    >
      <Badge tone="decision">{t("tickets.jiraWritePending")}</Badge>
    </Link>
  );
}

/** Phone ticket card (Stitch m01). */
function MobileTicketCard({
  r,
  names,
  jiraBaseUrl,
  running,
  selectable,
  selected,
  onToggle,
  reviewPending,
  onReview,
  retryPending,
  onRetry,
  abandonPending,
  onAbandon,
  mode,
}: {
  /** F4B-4: the JIRA mode set now */
  mode: JiraMode | undefined;
  r: TicketRow;
  names: { ready?: string; inProgress?: string; review?: string };
  jiraBaseUrl: string | undefined;
  running: string | undefined;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  reviewPending: boolean;
  onReview: (v: boolean) => void;
  retryPending: boolean;
  onRetry: () => void;
  abandonPending: boolean;
  onAbandon: () => void;
}) {
  const to = `/tickets/${r.key}/${defaultTab(r.state, r.prevState)}`;
  return (
    <article className="flex flex-col gap-2.5 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-2">
        {selectable && (
          <label className="-my-2 -ml-2 flex size-11 shrink-0 items-center justify-center">
            <input type="checkbox" className="size-5 accent-primary" aria-label={t("tickets.selectOne", { key: r.key })} checked={selected} onChange={onToggle} />
          </label>
        )}
        <div className="min-w-0 flex-1">
          <JiraKeyLink ticketKey={r.key} url={r.url} baseUrl={jiraBaseUrl} className="-my-2 min-h-11 font-mono text-code-lg font-semibold text-on-surface" />
        </div>
        {r.driftNeedsAction && (
          <Link to={`/tickets/${r.key}/coverage`} className="-my-2 flex size-11 shrink-0 items-center justify-center text-rose-600" aria-label={t("tickets.driftNeedsAction")}>
            <AlertTriangle className="size-5" />
          </Link>
        )}
        <StateBadge state={r.state} className="shrink-0 rounded-full" />
      </div>
      <Link to={to} className="flex flex-col gap-0.5">
        <span className="line-clamp-2 break-words text-headline-md">{r.title}</span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1 font-mono text-code-sm text-on-surface-variant">
          <JiraStatus r={r} names={names} />
          <span>· {t("tickets.updatedAgo", { ago: timeAgo(r.updatedAt) })}</span>
        </span>
      </Link>
      {r.jiraWritePending && (
        <div className="flex flex-wrap items-center gap-2">
          <JiraWriteChip r={r} />
        </div>
      )}
      {running && (
        <div className="flex items-center gap-2 rounded bg-surface-container-low px-2 py-1.5 text-body-sm">
          <Bot className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 truncate">{t("tickets.agentRunning", { role: agentName(running) })}</span>
        </div>
      )}
      {r.state === "blocked" && r.blockedReason && <p className="break-words rounded bg-rose-50 px-2 py-1 font-mono text-code-sm text-rose-600">{r.blockedReason}</p>}
      {r.state !== "abandoned" && r.state !== "blocked" && (
        <label className="flex items-start justify-between gap-3 rounded bg-surface-container-low p-2.5">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-body-md">{t("tickets.col.reviewAc")}</span>
            <span className="text-body-sm text-on-surface-variant">
              {t("common.thisWill")} {t("tickets.reviewAcThisWill")}
            </span>
          </span>
          <Switch aria-label={`${t("tickets.col.reviewAc")} ${r.key}`} checked={r.reviewAc} disabled={reviewPending} onCheckedChange={onReview} />
        </label>
      )}
      {STATE_ACTION_NEEDED(r) && (
        <Link to={to} className="flex min-h-12 items-center justify-center gap-2 rounded bg-secondary-container text-headline-sm text-on-secondary-fixed hover:bg-[#f0841c]">
          {t("tickets.review")}
          <ArrowRight className="size-4" />
        </Link>
      )}
      {r.state === "blocked" && (
        <div className="flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-2">
            <Button className="border-0 bg-surface-container-high text-on-surface" onClick={onRetry} disabled={retryPending}>
              <RotateCw className="size-4" />
              {t("tickets.retry")}
            </Button>
            <Button variant="destructive" className="border-0 bg-rose-50" onClick={onAbandon} disabled={abandonPending}>
              <Trash2 className="size-4" />
              {t("tickets.abandon")}
            </Button>
          </div>
          <p className="text-center text-body-sm text-on-surface-variant">
            {t("common.thisWill")} {jiraText("tickets.blockedThisWill", mode)}
          </p>
        </div>
      )}
    </article>
  );
}

export function TicketsPage() {
  const tickets = useApi<TicketRow[]>(paths.tickets);
  const status = useApi<Status>(paths.status);
  const config = useApi<Config>(paths.config);
  const discovery = useApi<{ lastRun: DiscoveryRun | null }>(paths.discovery);
  const live = useLive();
  const [params, setParams] = useSearchParams();
  const needsOnly = params.get("needs") === "1";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** null = the default: All open (author decision 2026-11-08) */
  const [jiraFilterChoice, setJiraFilter] = useState<string | null>(null);
  const readyStatus = config.data?.jira.readyForDevStatus || undefined;
  const jiraCfg = config.data?.jira as { inProgressStatus?: string; reviewStatus?: string } | undefined;
  const statusNames = { ready: readyStatus, inProgress: jiraCfg?.inProgressStatus, review: jiraCfg?.reviewStatus };
  const jiraFilter = jiraFilterChoice ?? defaultJiraFilter();

  const discover = useAction(startDiscover);
  const refineMany = useAction(async (keys: string[]) => {
    for (const k of keys) await api.refine(k);
  });
  const setReview = useAction(api.setReviewAc);
  const retry = useAction(api.retry);
  const abandon = useAction(api.abandon);
  const actionError = discover.error ?? refineMany.error ?? setReview.error ?? retry.error ?? abandon.error;

  const all = tickets.data ?? [];
  const waiting = all.filter(needsMe);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter(
      (r) =>
        isVisibleTicket(r, needsOnly, jiraFilter) &&
        (q === "" || r.key.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)),
    );
  }, [all, needsOnly, query, jiraFilter]);
  const jiraOptions = jiraFilterOptions(all, readyStatus, jiraFilter);
  const incomplete = incompleteNotice(discovery.data?.lastRun);
  const selectable = (r: TicketRow) => r.state === "discovered";
  const selectedRows = all.filter((r) => selected.has(r.key) && selectable(r));
  const allSelectable = rows.filter(selectable);

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const jiraConfigured = status.data?.jira.configured ?? false;
  const mode = status.data?.jira.source;
  const found = discoverView(live.discover, mode);
  const firstWaiting = waiting[0];

  return (
    <div className={cn("flex flex-col max-md:min-h-[calc(100dvh-var(--header-h,6rem))] max-md:bg-surface-container-low", selectedRows.length > 0 && "max-md:pb-32")}>
      <div className="flex flex-col gap-2 border-b border-outline-variant/30 px-4 py-2 max-md:border-b-0 max-md:bg-surface-container-low max-md:pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-baseline gap-2 max-md:hidden">
            <h1 className="shrink-0 text-headline-md">{t("nav.tickets")}</h1>
            <span className="min-w-0 text-body-sm text-on-surface-variant">{t("tickets.summary", { total: all.length, waiting: waiting.length })}</span>
          </div>
          <div className="hidden shrink-0 items-center rounded border border-outline-variant/30 bg-surface-container-low p-0.5 md:flex">
            <span className="flex h-6 items-center gap-1 rounded bg-white px-2 text-label-sm font-semibold shadow-sm">
              <List className="size-3.5" />
              {t("tickets.list")}
            </span>
            <Tooltip content={t("tickets.boardPhase")}>
              <span className="flex h-6 cursor-not-allowed items-center gap-1 px-2 text-label-sm text-slate-400" aria-disabled="true">
                <Kanban className="size-3.5" />
                {t("tickets.board")}
              </span>
            </Tooltip>
          </div>
        </div>
        {/* fetch: the button with its full "This will:" caption, and the outcome as its own status pill below */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-3">
            <Button size="sm" className="shrink-0 self-start md:self-auto" onClick={() => void discover.run()} disabled={!jiraConfigured || discover.pending || found.busy}>
              <RefreshCw className={cn("size-3.5 text-primary", (discover.pending || found.busy) && "animate-spin")} />
              {discover.pending || found.busy ? t("tickets.fetching") : t("tickets.fetch")}
            </Button>
            <ThisWill className="min-w-0 break-words">{jiraText("tickets.fetchThisWill", mode)}</ThisWill>
          </div>
          {found.message && (
            <span
              role="status"
              data-testid="discover-status"
              className={cn(
                "inline-flex max-w-full items-start gap-1.5 self-start rounded-md border px-2.5 py-1 text-body-sm break-words",
                found.tone === "error"
                  ? "border-rose-200 bg-rose-50 text-rose-700"
                  : found.tone === "success"
                    ? "border-emerald-200 bg-emerald-50 font-semibold text-emerald-800"
                    : "border-outline-variant/40 bg-surface-container-low text-on-surface-variant",
              )}
            >
              {found.tone === "error" ? (
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              ) : found.tone === "success" ? (
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
              ) : found.busy ? (
                <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
              ) : (
                <Info className="mt-0.5 size-3.5 shrink-0" />
              )}
              <span className="min-w-0">{found.message}</span>
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* phones (m01): segmented "Needs me (n) / All (n)" */}
          <div role="radiogroup" aria-label={t("tickets.filter")} className="grid w-full grid-cols-2 gap-1 rounded-lg bg-surface-container-high p-1 md:hidden">
            {[
              { on: true, label: t("tickets.needsMe", { n: waiting.length }) },
              { on: false, label: t("tickets.all", { n: all.length }) },
            ].map((o) => (
              <button
                key={String(o.on)}
                role="radio"
                aria-checked={needsOnly === o.on}
                onClick={() => setParams(o.on ? { needs: "1" } : {})}
                className={cn("flex min-h-11 items-center justify-center gap-1.5 rounded-md text-label-md", needsOnly === o.on ? "bg-white font-semibold text-on-surface shadow-sm" : "text-on-surface-variant")}
              >
                {o.on && <span className="size-2 rounded-full bg-secondary" />}
                {o.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setParams(needsOnly ? {} : { needs: "1" })}
            aria-pressed={needsOnly}
            className={cn(
              "hidden h-10 items-center max-md:!hidden md:flex gap-1.5 rounded border px-3 text-label-sm font-semibold md:h-6 md:px-2",
              needsOnly ? "border-secondary-container/40 bg-secondary-fixed text-on-secondary-fixed" : "border-slate-200 bg-white text-slate-700",
            )}
          >
            <span className={cn("size-1.5 rounded-full bg-secondary-container", needsOnly && "animate-pulse-subtle")} />
            {t("tickets.onlyNeedsMe")}
            <span className="rounded bg-white/90 px-1 text-[10px] font-bold text-secondary">{waiting.length}</span>
          </button>
          <label className="flex w-full items-center gap-2 md:w-auto">
            <span className="shrink-0 text-label-md text-on-surface-variant md:text-label-sm">{t("tickets.jiraFilter")}</span>
            <select
              aria-label={t("tickets.jiraFilter")}
              value={jiraFilter}
              disabled={needsOnly}
              title={needsOnly ? t("tickets.jiraFilterNeedsMe") : undefined}
              onChange={(e) => setJiraFilter(e.target.value)}
              className="h-11 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-body-md disabled:opacity-60 md:h-6 md:flex-none md:text-body-sm"
            >
              {jiraOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="relative flex w-full items-center md:max-w-xs">
            <Search className="pointer-events-none absolute left-2 size-3.5 text-outline" />
            <Input className="h-10 w-full pl-7 md:h-6" placeholder={t("tickets.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4">
        {actionError && <ErrorBox error={actionError} />}

        {incomplete && (
          <Link
            to="/settings"
            role="status"
            data-testid="discover-incomplete"
            className="flex min-h-11 items-center gap-2 break-words rounded border border-amber-200 bg-amber-50 px-3 py-2 text-body-sm text-amber-800 hover:underline md:min-h-0"
          >
            <Info className="size-4 shrink-0" />
            {incomplete}
          </Link>
        )}

        {firstWaiting && (
          <div className="hidden flex-wrap items-center justify-between gap-3 rounded md:flex border border-secondary-container/30 bg-secondary-fixed/30 p-2">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="size-2 shrink-0 animate-pulse-subtle rounded-full bg-secondary-container" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 font-mono text-code-md">
                  <span className="font-semibold uppercase text-secondary">{t("tickets.decisionNeeded")}</span>
                  <span className="break-all font-semibold text-primary">{firstWaiting.key}</span>
                  <StateBadge state={firstWaiting.state} />
                </div>
                <div className="break-words text-body-md md:truncate">{firstWaiting.blockedReason ?? firstWaiting.title}</div>
              </div>
            </div>
            <Link
              to={`/tickets/${firstWaiting.key}/${NEEDS_YOU.includes(firstWaiting.state) ? defaultTab(firstWaiting.state, firstWaiting.prevState) : firstWaiting.deliveryStepFailed ? "delivery" : "development"}`}
              className="flex h-11 w-full shrink-0 items-center justify-center rounded bg-secondary-container px-3 text-label-md font-semibold text-white hover:bg-[#f0841c] md:h-7 md:w-auto"
            >
              {t("tickets.review")}
            </Link>
          </div>
        )}

        {/* below md: stacked cards (Stitch m01) */}
        <div className="flex flex-col gap-3 md:hidden">
          <AsyncView state={tickets}>
            {() => (
              <>
                {rows.length === 0 && (
                  <div className="rounded-lg bg-white px-3 py-8 text-center text-body-sm text-slate-500 shadow-sm">{all.length === 0 ? t("tickets.empty") : t("tickets.emptyFiltered")}</div>
                )}
                {rows.map((r) => (
                  <MobileTicketCard
                    key={r.key}
                    mode={mode}
                    r={r}
                    names={statusNames}
                    jiraBaseUrl={status.data?.jira.baseUrl}
                    running={live.running[r.key]}
                    selectable={selectable(r)}
                    selected={selected.has(r.key)}
                    onToggle={() => toggle(r.key)}
                    reviewPending={setReview.pending}
                    onReview={(v) => void setReview.run(r.key, v)}
                    retryPending={retry.pending}
                    onRetry={() => void retry.run(r.key)}
                    abandonPending={abandon.pending}
                    onAbandon={() => {
                      if (window.confirm(t("tickets.abandonConfirm", { key: r.key }))) void abandon.run(r.key);
                    }}
                  />
                ))}
              </>
            )}
          </AsyncView>
          <p className="font-mono text-code-sm text-on-surface-variant">{t("tickets.showing", { shown: rows.length, total: all.length })}</p>
        </div>

        {/* 768–1023 (touch tablets): the Review-AC tooltip is not reachable, so its "This will" note is shown inline */}
        <p className="hidden text-body-sm text-slate-600 md:block lg:hidden">
          <span className="font-semibold">{t("tickets.col.reviewAc")}</span> — <ThisWill>{t("tickets.reviewAcThisWill")}</ThisWill>
        </p>
        <div className="hidden overflow-x-auto rounded border border-slate-200 md:block">
          <AsyncView state={tickets}>
            {() => (
              <table className="w-full border-collapse text-left">
                <thead className="whitespace-nowrap bg-surface-container-low font-mono text-[10.5px] uppercase tracking-wide text-on-surface-variant">
                  <tr className="border-b border-slate-200">
                    <th className="w-8 px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={t("tickets.selectAll")}
                        disabled={allSelectable.length === 0}
                        checked={allSelectable.length > 0 && allSelectable.every((r) => selected.has(r.key))}
                        onChange={(e) => setSelected(e.target.checked ? new Set(allSelectable.map((r) => r.key)) : new Set())}
                      />
                    </th>
                    <th className="px-2 font-medium">{t("tickets.col.key")}</th>
                    <th className="px-2 font-medium">{t("tickets.col.summary")}</th>
                    <th className="px-2 font-medium">{t("tickets.col.state")}</th>
                    <th className="px-2 font-medium">{t("tickets.col.jira")}</th>
                    <th className="px-2 font-medium">{t("tickets.col.agent")}</th>
                    <th className="px-2 text-center font-medium">{t("tickets.col.reviewAc")}</th>
                    <th className="px-2 text-center font-medium">{t("tickets.col.drift")}</th>
                    <th className="px-2 font-medium">{t("tickets.col.updated")}</th>
                    <th className="px-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-3 py-8 text-center text-body-sm text-slate-500">
                        {all.length === 0 ? t("tickets.empty") : t("tickets.emptyFiltered")}
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.key} className={cn("h-8 border-b border-slate-200 hover:bg-slate-50", needsMe(r) && "bg-amber-50/40")}>
                      <td className="px-2">
                        <input type="checkbox" aria-label={t("tickets.selectOne", { key: r.key })} disabled={!selectable(r)} checked={selected.has(r.key)} onChange={() => toggle(r.key)} />
                      </td>
                      <td className="px-2 font-mono text-code-md font-semibold text-primary">
                        <div className="min-w-[8rem] max-w-[14rem] break-all">
                          <JiraKeyLink ticketKey={r.key} url={r.url} baseUrl={status.data?.jira.baseUrl} />
                        </div>
                      </td>
                      <td className="px-2">
                        <div className="flex max-w-[20rem] items-center gap-2 2xl:max-w-[32rem]">
                          <Link to={`/tickets/${r.key}/${defaultTab(r.state, r.prevState)}`} title={r.title} className="min-w-[8rem] truncate hover:underline">
                            {r.title}
                          </Link>
                        </div>
                      </td>
                      <td className="px-2">
                        <div className="flex flex-wrap items-center gap-1">
                          {r.blockedReason && r.state === "blocked" ? (
                            <Tooltip content={r.blockedReason}>
                              <span className="inline-flex" aria-label={r.blockedReason}>
                                <StateBadge state={r.state} />
                              </span>
                            </Tooltip>
                          ) : (
                            <StateBadge state={r.state} />
                          )}
                          <JiraWriteChip r={r} />
                        </div>
                      </td>
                      <td className="px-2 text-body-sm">
                        <JiraStatus r={r} names={statusNames} className="min-w-[7rem]" />
                      </td>
                      <td className="whitespace-nowrap px-2 font-mono text-code-sm text-primary">{live.running[r.key] ? agentName(live.running[r.key]!) : <span className="text-slate-400">—</span>}</td>
                      <td className="px-2 text-center">
                        <Tooltip content={`${t("common.thisWill")} ${t("tickets.reviewAcThisWill")}`}>
                          {/* span: the tooltip trigger's data-state must not override the switch's */}
                          <span className="inline-flex">
                            <Switch
                              aria-label={`${t("tickets.col.reviewAc")} ${r.key}`}
                              checked={r.reviewAc}
                              disabled={setReview.pending}
                              onCheckedChange={(v) => void setReview.run(r.key, v)}
                            />
                          </span>
                        </Tooltip>
                      </td>
                      <td className="px-2 text-center">
                        {r.driftNeedsAction ? (
                          <Tooltip content={t("tickets.driftNeedsAction")}>
                            <Link to={`/tickets/${r.key}/coverage`} className="inline-flex text-rose-600" aria-label={t("tickets.driftNeedsAction")}>
                              <AlertTriangle className="size-4" />
                            </Link>
                          </Tooltip>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 font-mono text-code-sm text-slate-500">{timeAgo(r.updatedAt)}</td>
                      <td className="whitespace-nowrap px-2 text-right">
                        {r.state === "blocked" && (
                          <span className="flex justify-end gap-1">
                            <Tooltip content={`${t("common.thisWill")} ${t("tickets.retryThisWill")}`}>
                              <Button size="sm" onClick={() => void retry.run(r.key)} disabled={retry.pending}>
                                {t("tickets.retry")}
                              </Button>
                            </Tooltip>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={abandon.pending}
                              onClick={() => {
                                if (window.confirm(t("tickets.abandonConfirm", { key: r.key }))) void abandon.run(r.key);
                              }}
                            >
                              {t("tickets.abandon")}
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </AsyncView>
          <div className="flex items-center justify-between bg-surface-container-low px-2 py-1.5 font-mono text-code-sm text-on-surface-variant">
            <span>{t("tickets.showing", { shown: rows.length, total: all.length })}</span>
          </div>
        </div>

        {selectedRows.length > 0 && (
          <div className="fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg bg-inverse-surface p-3 font-mono text-code-md text-inverse-on-surface shadow-lg md:sticky md:inset-x-auto md:bottom-3 md:z-20 md:gap-3 md:rounded md:px-3 md:py-2">
            <span className="rounded bg-primary px-1.5 py-0.5 text-code-sm font-semibold text-white md:hidden">{t("tickets.selectedShort", { n: selectedRows.length })}</span>
            <span className="font-semibold max-md:hidden">
              {t("tickets.selected", { n: selectedRows.length })} <span className="break-all font-normal opacity-70">({selectedRows.map((r) => r.key).join(", ")})</span>
            </span>
            <button className="min-h-9 font-sans text-body-sm text-inverse-primary underline underline-offset-2 md:hidden" onClick={() => setSelected(new Set())}>
              {t("tickets.deselectAll")}
            </button>
            <Button variant="blue" className="ml-auto px-3 font-sans text-label-md md:ml-0 md:w-auto md:font-mono" onClick={() => void refineMany.run(selectedRows.map((r) => r.key)).then((ok) => ok && setSelected(new Set()))} disabled={refineMany.pending}>
              <Play className="size-3.5 md:hidden" />
              <Wand2 className="size-3.5 max-md:hidden" />
              {t("tickets.startRefining", { n: selectedRows.length })}
            </Button>
            <span className="flex basis-full items-center gap-1.5 font-sans text-body-sm opacity-90 md:basis-auto md:font-mono md:text-code-sm md:opacity-80">
              <Info className="size-4 shrink-0 md:hidden" />
              {t("common.thisWill")} {t("tickets.refineThisWill", { n: selectedRows.length })}
            </span>
            <button className="ml-auto min-h-9 max-md:hidden text-code-sm text-inverse-primary underline underline-offset-2 hover:text-white" onClick={() => setSelected(new Set())}>
              {t("tickets.deselect")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
