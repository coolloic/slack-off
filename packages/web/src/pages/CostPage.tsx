import { Activity, CircleDashed, Pause, Play, Send } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AsyncView, ErrorBox } from "../components/AsyncView.tsx";
import { ThisWill } from "../components/ThisWill.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardHeader } from "../components/ui/card.tsx";
import { Input } from "../components/ui/input.tsx";
import { t, type MessageKey } from "../i18n/en.ts";
import { api, paths, type Status, type TelemetryPreview, type UsageSummary, type UsageWindow } from "../lib/api.ts";
import { exportBar, exportCard } from "../lib/telemetry-model.ts";
import { useAction, useApi } from "../lib/hooks.ts";
import { barView, costView, emptyText, formatMinutes, pauseBar, phoneTicketRows, progressView, resumeErrorText, stillOverNote, USAGE_WINDOW_OPTIONS } from "../lib/usage-model.ts";
import { cn, timeAgo } from "../lib/utils.ts";

const TONE_BAR = { ok: "bg-slate-500", warn: "bg-amber-500", over: "bg-rose-600" } as const;

function Stat({ label, value, note, testId }: { label: string; value: string; note?: string; testId: string }) {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-1 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)] md:rounded md:border md:border-slate-200 md:shadow-none">
      <span className="text-label-sm uppercase tracking-[0.05em] text-on-surface-variant">{label}</span>
      <span className="break-words text-headline-lg">{value}</span>
      {note && <span className="font-mono text-code-sm text-on-surface-variant">{note}</span>}
    </div>
  );
}

function WindowSwitch({ value, onChange }: { value: UsageWindow; onChange: (w: UsageWindow) => void }) {
  return (
    <div role="radiogroup" aria-label={t("cost.window")} className="flex gap-1 rounded bg-surface-container p-1" data-testid="usage-window">
      {USAGE_WINDOW_OPTIONS.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn("min-h-11 min-w-0 flex-1 whitespace-nowrap rounded px-2 text-label-md md:min-h-8", value === o.id ? "bg-white font-semibold text-primary shadow-sm" : "text-on-surface-variant")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Bars({ s }: { s: UsageSummary }) {
  const bars = barView(s.byDay);
  if (bars.length === 0) return null;
  return (
    <Card data-testid="usage-bars">
      <CardHeader title={t("cost.byDay")} right={t("cost.byDayNote", { n: bars.length })} />
      <div className="flex h-36 items-end gap-px px-3 pt-4 md:h-44 md:gap-1">
        {bars.map((b) => (
          <div key={b.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${b.day}: ${b.runs}`}>
            <div className="w-full rounded-t bg-primary/80" style={{ height: `${Math.max(b.heightPct, b.runs > 0 ? 3 : 0)}%` }} />
          </div>
        ))}
      </div>
      <div className="flex justify-between px-3 py-2 font-mono text-code-sm text-on-surface-variant">
        <span>{bars[0]!.day.slice(5)}</span>
        <span>{bars.at(-1)!.day.slice(5)}</span>
      </div>
    </Card>
  );
}

function TicketList({ s }: { s: UsageSummary }) {
  if (s.byTicket.length === 0) return null;
  const phone = phoneTicketRows(s.byTicket, s.executor);
  return (
    <Card data-testid="usage-tickets">
      <CardHeader title={t("cost.byTicket")} />
      <ul className="flex flex-col divide-y divide-slate-100 md:hidden">
        {phone.map((r) => (
          <li key={r.key} className="flex min-h-11 flex-col justify-center gap-0.5 px-3 py-1">
            <span className="flex min-w-0 items-baseline justify-between gap-2">
              {r.key === "none" ? <span className="font-semibold">{r.heading}</span> : <Link to={`/tickets/${r.heading}`} className="inline-flex min-h-11 items-center font-mono font-semibold text-primary">{r.heading}</Link>}
              <span className="shrink-0 font-mono text-code-sm text-on-surface-variant">{r.meta}</span>
            </span>
            <span className="min-w-0 break-words text-body-sm text-on-surface-variant">{r.title}</span>
          </li>
        ))}
      </ul>
      <table className="hidden w-full table-fixed text-left text-body-md md:table">
        <thead>
          <tr className="border-b border-slate-200 text-label-sm uppercase text-on-surface-variant">
            <th className="w-1/2 px-3 py-1.5">{t("cost.colTicket")}</th>
            <th className="px-3 py-1.5">{t("cost.colRuns")}</th>
            <th className="px-3 py-1.5">{t("cost.colTime")}</th>
            <th className="px-3 py-1.5">{t("cost.colTokens")}</th>
            <th className="px-3 py-1.5">{t("cost.colCost")}</th>
          </tr>
        </thead>
        <tbody>
          {s.byTicket.map((r) => (
            <tr key={r.ticketKey ?? "none"} className="border-b border-slate-100">
              <td className="truncate px-3 py-1.5">
                {r.ticketKey === null ? (
                  <span>{t("cost.noTicket")}</span>
                ) : (
                  <Link to={`/tickets/${r.ticketKey}`} className="font-mono text-primary">
                    {r.ticketKey}
                  </Link>
                )}{" "}
                <span className="text-on-surface-variant">{r.ticketKey === null ? t("cost.noTicketNote") : r.title}</span>
              </td>
              <td className="px-3 py-1.5 font-mono">{r.runs}</td>
              <td className="px-3 py-1.5 font-mono">{formatMinutes(r.runMinutes)}</td>
              <td className="px-3 py-1.5 font-mono">{r.inputTokens} / {r.outputTokens}</td>
              <td className="px-3 py-1.5 font-mono">${(s.executor === "claude-api" ? r.usd : r.estimateUsd).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function RoleList({ s }: { s: UsageSummary }) {
  if (s.byRole.length === 0) return null;
  return (
    <Card data-testid="usage-roles">
      <CardHeader title={t("cost.byRole")} />
      <ul className="flex flex-col divide-y divide-slate-100">
        {s.byRole.map((r) => (
          <li key={r.role} className="flex min-h-11 items-center justify-between gap-2 px-3 py-2">
            <span className="min-w-0 truncate font-mono text-code-md">{r.role}</span>
            <span className="shrink-0 font-mono text-code-sm text-on-surface-variant">
              {t("cost.run", { n: r.runs })} · {formatMinutes(r.runMinutes)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Summary({ s }: { s: UsageSummary }) {
  const cost = costView(s);
  const progress = progressView(s.budget);
  const empty = emptyText(s);
  const stillOver = stillOverNote(s);
  const paused = s.paused;
  return (
    <div className="flex flex-col gap-3 md:gap-4">
      {paused && (
        <div role="status" data-testid="usage-paused" className="flex min-w-0 flex-col gap-1 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-body-md text-amber-900">
          <span className="font-semibold">{t(paused.reason === "manual" ? "cost.pausedByManual" : paused.reason === "threshold" ? "cost.pausedByThreshold" : "cost.pausedByLimit")}</span>
          <span className="break-words">{paused.detail}</span>
          <span className="text-body-sm">{t("cost.pausedBy", { ago: timeAgo(paused.pausedAt), by: paused.pausedBy })}</span>
          <span className="text-body-sm">{t("cost.pausedNote")}</span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        <Stat testId="usage-stat-runs" label={t("cost.runs")} value={String(s.totals.runs)} note={s.totals.failedRuns > 0 ? t("cost.failedRuns", { n: s.totals.failedRuns }) : undefined} />
        <Stat testId="usage-stat-time" label={t("cost.runTime")} value={formatMinutes(s.totals.runMinutes)} />
        <div className="col-span-2 md:col-span-1">
          <Stat testId="usage-stat-cost" label={cost.label} value={cost.value} note={`${s.totals.inputTokens + s.totals.outputTokens} tokens`} />
        </div>
      </div>
      <Card data-testid="usage-budget">
        <CardHeader title={t("cost.budget")} right={s.budget ? t("cost.budgetWindow", { window: t(`banner.usageWindow.${s.budget.window}` as MessageKey) }) : undefined} />
        <div className="flex flex-col gap-2 p-3">
          {progress ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-headline-md">{progress.label}</span>
                <span className="font-mono text-code-md text-on-surface-variant">{progress.detail}</span>
              </div>
              {stillOver && <span role="status" data-testid="usage-still-over" className="text-body-sm font-semibold text-rose-700">{stillOver}</span>}
              <div role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} data-tone={progress.tone} className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div className={cn("h-full rounded-full", TONE_BAR[progress.tone])} style={{ width: `${progress.percent}%` }} />
              </div>
            </>
          ) : (
            <span className="text-body-md text-on-surface-variant">{t("cost.budgetOff")}</span>
          )}
          {progress && <span className="text-body-sm text-on-surface-variant">{t("cost.softLimit")}</span>}
          <Link to="/settings" className="flex min-h-11 items-center self-start text-label-md text-primary">
            {t("cost.editThresholds")} →
          </Link>
        </div>
      </Card>
      {empty ? (
        <Card>
          <div data-testid="usage-empty" className="px-3 py-8 text-center text-body-md text-on-surface-variant">{empty}</div>
        </Card>
      ) : (
        <>
          <Bars s={s} />
          <div className="grid gap-3 md:gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
            <TicketList s={s} />
            <RoleList s={s} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Phase 4c Task 5 (C-7): "Export N runs to <host>" — hidden while run tracing is off. The button opens a confirmation
 * (inline on a desktop, the sticky bar on a phone) whose "This will" names the count, the fields and the host; only the
 * runs of this preview are sent (the hash binds them).
 */
function ExportCard({ preview, onOpen, confirming, inline, done, error }: {
  preview: TelemetryPreview;
  onOpen: () => void;
  confirming: boolean;
  inline: ReactNode;
  done: string | null;
  error: string | undefined;
}) {
  const card = exportCard(preview)!;
  const bar = exportBar(preview);
  return (
    <Card data-testid="export-card">
      <CardHeader title={t("tracing.cardTitle")} />
      <div className="flex min-w-0 flex-col gap-2 p-3">
        <span className="text-body-sm text-on-surface-variant">{card.fields}</span>
        {bar.contentWarning && (
          <p role="alert" data-testid="export-content-warning" className="text-body-sm font-semibold text-rose-700">
            {bar.contentWarning}
          </p>
        )}
        <Button variant="blue" size="md" className="min-h-11 w-full whitespace-normal md:w-fit" disabled={card.disabled || confirming} onClick={onOpen} data-testid="export-open">
          <Activity className="size-4 shrink-0" />
          {card.label}
        </Button>
        {confirming && <div className="max-lg:hidden">{inline}</div>}
        <span className="text-body-sm text-on-surface-variant">{t("tracing.onePerConfirm")}</span>
        {done && (
          <span role="status" data-testid="export-done" className="text-body-sm text-emerald-700">
            {done}
          </span>
        )}
        {error && <ErrorBox error={error} />}
      </div>
    </Card>
  );
}

export function CostPage() {
  const [window, setWindow] = useState<UsageWindow>("5h");
  const usage = useApi<UsageSummary>(paths.usage(window));
  const pause = useAction(api.pauseUsage);
  const resume = useAction(api.resumeUsage);
  const [note, setNote] = useState("");
  // a sticky bar below lg owns the bottom edge (the bottom navigation steps aside)
  useEffect(() => {
    document.body.classList.add("has-action-bar");
    return () => document.body.classList.remove("has-action-bar");
  }, []);
  const s = usage.data;
  const status = useApi<Status>(paths.status);
  const bar = pauseBar(s?.paused ?? null, { local: status.data?.local, executor: s?.executor ?? "claude-code" });
  const busy = pause.pending || resume.pending;
  const act = () => void (bar.action === "pause" ? pause.run(note.trim()).then((ok) => ok && setNote("")) : resume.run());
  const error = pause.error ?? resumeErrorText(resume.error);
  // phase 4c Task 5: the confirmed OTLP export
  const preview = useApi<TelemetryPreview | null>(paths.telemetryPreview);
  const exportRun = useAction(api.exportTelemetry);
  // F4C-1 (M-1): the preview as it was when the confirmation opened. The page keeps refetching the live preview (new runs,
  // usage changes), but the confirmation shows and sends this copy's hash: if the runs changed meanwhile the server
  // refuses it ("preview again") instead of sending runs the developer never saw.
  const [shown, setShown] = useState<TelemetryPreview | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const p = preview.data ?? null;
  const exportView = shown ? exportBar(shown) : null;
  // export turned off closes the confirmation
  const confirming = shown !== null && p !== null;
  const confirmExport = () => {
    if (!shown) return;
    const note = t("tracing.exported", { n: shown.runCount, host: shown.endpointHost });
    void exportRun.run(shown.runIdsHash).then((ok) => {
      setShown(null);
      setExported(ok ? note : null);
    });
  };
  const exportButtons = (cls: string) => (
    <div className={cn("flex gap-2", cls)}>
      <Button variant="blue" size="md" className="min-h-11 flex-1 md:flex-none" disabled={exportRun.pending} onClick={confirmExport} data-testid="export-confirm">
        <Send className="size-4" />
        {exportRun.pending ? t("tracing.exporting") : exportView?.confirm}
      </Button>
      <Button variant="ghost" size="md" className="min-h-11" disabled={exportRun.pending} onClick={() => setShown(null)} data-testid="export-cancel">
        {t("tracing.cancel")}
      </Button>
    </div>
  );
  const button = (cls: string) => (
    <Button variant={bar.action === "pause" ? "decision" : "blue"} size="md" className={cls} disabled={s === undefined || busy || bar.disabled} onClick={act} data-testid="usage-action">
      {bar.action === "pause" ? <Pause className="size-4" /> : <Play className="size-4" />}
      {busy ? t(bar.action === "pause" ? "cost.pausing" : "cost.resuming") : bar.label}
    </Button>
  );
  return (
    <div className="flex flex-col gap-3 p-3 pb-6 max-lg:pb-24 md:gap-4 md:p-4" data-testid="cost-page">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-center gap-2 text-headline-lg">
            <CircleDashed className="size-5 text-primary max-md:hidden" />
            {t("cost.title")}
          </h1>
          {s && <span className="w-fit rounded bg-surface-container px-2 py-0.5 font-mono text-code-sm">{t(s.executor === "claude-api" ? "cost.modeApi" : "cost.modeSubscription")}</span>}
          {s && <p className="max-w-2xl text-body-sm text-on-surface-variant">{t(s.executor === "claude-api" ? "cost.subtitleApi" : "cost.subtitleSub")}</p>}
        </div>
        <div className="flex items-center gap-2 max-lg:hidden">
          {s && !s.paused && <Input aria-label={t("cost.pauseNote")} placeholder={t("cost.pauseNote")} maxLength={200} className="h-11 w-56 md:h-7" value={note} onChange={(e) => setNote(e.target.value)} />}
          {button("")}
        </div>
      </div>
      <div className="md:max-w-md">
        <WindowSwitch value={window} onChange={setWindow} />
      </div>
      {error && <ErrorBox error={error} />}
      <AsyncView state={usage}>{(d) => <Summary s={d} />}</AsyncView>
      {p && (
        <ExportCard
          preview={p}
          confirming={confirming}
          onOpen={() => (setExported(null), setShown(p))}
          done={exported}
          error={exportRun.error}
          inline={
            <div data-testid="export-confirm-inline" className="flex flex-col gap-2 rounded border border-slate-200 bg-surface-container p-3">
              {exportButtons("")}
              <ThisWill>{exportView?.thisWill ?? ""}</ThisWill>
            </div>
          }
        />
      )}
      <div className="max-lg:hidden">
        <ThisWill>{bar.thisWill}</ThisWill>
      </div>
      <div
        data-testid="cost-bar"
        className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-1.5 border-t border-slate-200 bg-surface px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-[0_-2px_8px_rgba(15,23,42,0.06)] lg:hidden"
      >
        {confirming && exportView ? (
          <>
            {exportButtons("w-full")}
            <p data-testid="export-this-will" className="line-clamp-5 text-center text-body-sm text-on-surface-variant">
              <span className="font-semibold">{t("common.thisWill")}</span> {exportView.thisWill}
            </p>
          </>
        ) : (
          <>
            {s && !s.paused && <Input aria-label={t("cost.pauseNote")} placeholder={t("cost.pauseNote")} maxLength={200} className="h-11" value={note} onChange={(e) => setNote(e.target.value)} />}
            {button("w-full")}
            <p className="line-clamp-4 text-center text-body-sm text-on-surface-variant">
              <span className="font-semibold">{t("common.thisWill")}</span> {bar.thisWill}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
