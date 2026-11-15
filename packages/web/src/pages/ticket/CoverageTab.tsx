import { AlertTriangle, Check, CircleDashed, History, Info, PenLine, Plus, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { AnswerOptions } from "../../components/AnswerOptions.tsx";
import { AsyncView } from "../../components/AsyncView.tsx";
import { DecisionCard } from "../../components/DecisionCard.tsx";
import { SourceTag } from "../../components/SourceTag.tsx";
import { Badge, type BadgeProps } from "../../components/ui/badge.tsx";
import { Card, CardHeader } from "../../components/ui/card.tsx";
import { Textarea } from "../../components/ui/input.tsx";
import { t, type MessageKey } from "../../i18n/en.ts";
import { api, paths, type DriftRecord, type DriftResult, type Requirement, type RequirementRecord, type TicketDetail } from "../../lib/api.ts";
import { ackItems, ackPanelMode, contradictionRows, type AckPanelMode } from "../../lib/coverage-model.ts";
import { useAction, useApi } from "../../lib/hooks.ts";
import { sourceLabel, sourceTarget } from "../../lib/sources.ts";
import { cn, formatTime, timeAgo, STICKY_RAIL } from "../../lib/utils.ts";

type Tone = NonNullable<BadgeProps["tone"]>;
const STATUS_TONE: Record<string, Tone> = {
  covered: "done",
  partial: "decision",
  missing: "blocked",
  mapped: "done",
  new_sourced: "info",
  new_developer: "info",
  new_unsourced: "blocked",
};

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "muted"}>{t(`cov.status.${status}` as MessageKey)}</Badge>;
}

/** Baseline id `AC-n@v<k>` → the AC in that version; `D-n` → discussion outcome of the baseline. */
function baselineItem(id: string, versions: RequirementRecord[]): { text: string; origin: string } | null {
  const m = /^(AC-\d+)@v(\d+)$/.exec(id);
  if (m) {
    const v = versions.find((r) => r.version === Number(m[2]));
    const ac = v?.content.acceptanceCriteria.find((a) => a.id === m[1]);
    return ac ? { text: ac.text, origin: sourceTarget(ac.source).label } : null;
  }
  const d = versions[0]?.content.discussionOutcomes.find((o) => o.id === id);
  return d ? { text: d.text, origin: d.sourceCommentIds.map((c) => sourceLabel.comment(c)).join(", ") } : null;
}

function summarize(r: DriftResult): string {
  const missing = r.baseline.filter((b) => b.status === "missing").length;
  const partial = r.baseline.filter((b) => b.status === "partial").length;
  const unsourced = r.current.filter((c) => c.status === "new_unsourced").length;
  const parts = [
    missing && `${missing} ${t("cov.missing")}`,
    partial && `${partial} ${t("cov.partial")}`,
    unsourced && `${unsourced} ${t("cov.unsourced")}`,
    r.contradictions.length && t("cov.contradictionsCount", { n: r.contradictions.length }),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : `${r.baseline.length} ${t("cov.covered")}`;
}

function SummaryBar({ r }: { r: DriftResult }) {
  const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;
  const newOnes = r.current.filter((c) => c.status !== "mapped");
  const cell = "flex flex-col gap-1 rounded border border-slate-200 p-2";
  const label = "text-label-md text-slate-600";
  return (
    <div className="grid grid-cols-2 gap-2 font-mono text-code-sm md:grid-cols-4">
      <div className={cell}>
        <span className={label}>{t("cov.baselineAcs", { n: r.baseline.length })}</span>
        <span className="flex flex-wrap gap-x-2 whitespace-nowrap">
          <span className="text-emerald-700">{count(r.baseline, (b) => b.status === "covered")} {t("cov.covered")}</span>
          <span className="text-amber-700">{count(r.baseline, (b) => b.status === "partial")} {t("cov.partial")}</span>
          <span className="text-rose-600">{count(r.baseline, (b) => b.status === "missing")} {t("cov.missing")}</span>
        </span>
      </div>
      <div className={cell}>
        <span className={label}>{t("cov.newAcs", { n: newOnes.length })}</span>
        <span className="flex flex-wrap gap-x-2 whitespace-nowrap">
          <span className="text-primary">{count(newOnes, (c) => c.status === "new_sourced")} {t("cov.sourced")}</span>
          <span className="text-primary">{count(newOnes, (c) => c.status === "new_developer")} {t("cov.developer")}</span>
          <span className="text-rose-600">{count(newOnes, (c) => c.status === "new_unsourced")} {t("cov.unsourced")}</span>
        </span>
      </div>
      <div className={cell}>
        <span className={label}>{t("cov.contradictions")}</span>
        <span className={r.contradictions.length ? "text-rose-600" : "text-emerald-700"}>{t("cov.found", { n: r.contradictions.length })}</span>
      </div>
      <div className={cell}>
        <span className={label}>{t("cov.col.result")}</span>
        <span className="text-slate-700">{summarize(r)}</span>
      </div>
    </div>
  );
}

function Matrix({ ticketKey, drift, versions, current }: { ticketKey: string; drift: DriftRecord; versions: RequirementRecord[]; current: Requirement | undefined }) {
  const r = drift.result;
  const acById = new Map((current?.acceptanceCriteria ?? []).map((a) => [a.id, a]));
  const currentRecord = versions.find((v) => v.id === drift.requirementId);
  const currentV = currentRecord?.version ?? "?";
  const newOnes = r.current.filter((c) => c.status !== "mapped");
  const cellL = "min-w-0 p-2";
  return (
    <div className="flex flex-col gap-2">
      <div className="hidden grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)] gap-2 px-1 font-mono md:grid text-[10.5px] uppercase tracking-wide text-slate-500">
        <span>{t("cov.baselineCol")}</span>
        <span>{t("cov.statusCol")}</span>
        <span>{t("cov.currentCol", { v: currentV })}</span>
      </div>
      {r.baseline.map((b) => {
        const item = baselineItem(b.id, versions);
        return (
          <div
            key={b.id}
            className={cn(
              "flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)] md:gap-2 rounded border",
              b.status === "missing" ? "border-rose-300 bg-rose-50/60" : b.status === "partial" ? "border-amber-300 bg-amber-50/40" : "border-slate-200",
            )}
          >
            <div className={cellL}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-code-md font-semibold text-primary">{b.id}</span>
                {item && <Badge>{item.origin}</Badge>}
                {/* below md the status sits in the card header */}
                <span className="ml-auto md:hidden">
                  <StatusBadge status={b.status} />
                </span>
              </div>
              <p className="mt-1 text-body-md">{item?.text ?? "—"}</p>
            </div>
            <div className="hidden p-2 md:block">
              <StatusBadge status={b.status} />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 border-t border-slate-200/70 p-2 md:border-t-0">
              <span className="font-mono text-[11px] uppercase tracking-wide text-slate-500 md:hidden">{t("cov.currentCol", { v: currentV })}</span>
              {b.coveredBy.length === 0 && (
                <div className="flex items-center gap-1.5 rounded border border-rose-200 bg-white px-2 py-1.5 text-body-sm text-rose-700">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  {t("cov.noCounterpart")}
                </div>
              )}
              {b.coveredBy.map((id) => {
                const ac = acById.get(id);
                return (
                  <div key={id}>
                    <span className="font-mono text-code-md font-semibold">{id}</span>
                    <p className="text-body-md">{ac?.text ?? t("cov.unknownCurrent")}</p>
                  </div>
                );
              })}
              {b.note && <p className="rounded border border-amber-200 bg-white px-2 py-1 font-mono text-code-sm text-amber-800">{b.note}</p>}
            </div>
          </div>
        );
      })}

      {newOnes.length > 0 && (
        <>
          <div className="my-2 flex items-center gap-3 font-mono text-code-sm uppercase tracking-wide text-slate-500">
            <span className="h-px flex-1 bg-slate-200" />
            {t("cov.newSection", { v: currentV })}
            <span className="h-px flex-1 bg-slate-200" />
          </div>
          {newOnes.map((c) => {
            const ac = acById.get(c.id);
            const bad = c.status === "new_unsourced";
            return (
              <div key={c.id} className={cn("flex flex-col md:grid md:grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)] md:gap-2 rounded border", bad ? "border-rose-300 bg-rose-50/60" : "border-slate-200")}>
                <div className={cn(cellL, "hidden font-mono text-code-sm italic text-slate-500 md:block")}>{t("cov.noBaseline")}</div>
                <div className="hidden p-2 md:block">
                  <StatusBadge status={c.status} />
                </div>
                <div className="flex min-w-0 flex-col gap-1 p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-code-md font-semibold">{c.id}</span>
                    {ac && <SourceTag ticketKey={ticketKey} source={ac.source} snapshotId={currentRecord?.snapshotId} />}
                    <span className="ml-auto md:hidden">
                      <StatusBadge status={c.status} />
                    </span>
                  </div>
                  <p className="text-body-md">{ac?.text ?? t("cov.unknownCurrent")}</p>
                </div>
              </div>
            );
          })}
        </>
      )}

      {r.contradictions.length > 0 && (
        <Card className="mt-2 border-rose-200">
          <CardHeader className="border-rose-200 bg-rose-50" title={t("cov.contradictionsSection")} />
          {contradictionRows(r, acById).map((c, i) => (
            <div key={i} className="grid grid-cols-1 gap-3 border-b border-slate-100 p-3 last:border-b-0 md:grid-cols-2">
              <div>
                <span className="font-mono text-code-md font-semibold">{c.acId}</span>
                <p className="text-body-md">{c.acText ?? "—"}</p>
              </div>
              <div>
                <span className="font-mono text-code-sm uppercase text-slate-500">{t("cov.original")}</span>
                <blockquote className="border-l-2 border-rose-300 pl-2 text-body-md italic">{c.quote}</blockquote>
                <p className="mt-1 text-body-sm text-rose-700">{c.explanation}</p>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ---- phones (Stitch m02) ----

const TILE: Record<string, { cls: string; icon: typeof Check; key: MessageKey }> = {
  covered: { cls: "bg-emerald-50 text-emerald-800 [&_.tile-icon]:bg-tertiary", icon: Check, key: "cov.tile.covered" },
  partial: { cls: "bg-secondary-fixed/50 text-on-secondary-fixed-variant [&_.tile-icon]:bg-secondary-container", icon: CircleDashed, key: "cov.tile.partial" },
  missing: { cls: "bg-rose-50 text-rose-700 [&_.tile-icon]:bg-error", icon: X, key: "cov.tile.missing" },
  new: { cls: "bg-surface-container-low text-primary [&_.tile-icon]:bg-primary", icon: Plus, key: "cov.tile.new" },
};

function PhoneTiles({ r }: { r: DriftResult }) {
  const n = {
    covered: r.baseline.filter((b) => b.status === "covered").length,
    partial: r.baseline.filter((b) => b.status === "partial").length,
    missing: r.baseline.filter((b) => b.status === "missing").length,
    new: r.current.filter((c) => c.status !== "mapped").length,
  };
  return (
    <div className="grid grid-cols-2 gap-2 md:hidden">
      {(Object.keys(n) as Array<keyof typeof n>).map((k) => {
        const tile = TILE[k]!;
        const Icon = tile.icon;
        return (
          <div key={k} className={cn("flex items-center justify-between rounded p-3", tile.cls)}>
            <div className="flex flex-col">
              <span className="text-label-md uppercase tracking-[0.05em]">{t(tile.key)}</span>
              <span className="text-headline-md text-on-surface">{n[k]}</span>
            </div>
            <span className="tile-icon flex size-9 items-center justify-center rounded text-white">
              <Icon className="size-5" />
            </span>
          </div>
        );
      })}
    </div>
  );
}

const PILL: Record<string, string> = {
  covered: "bg-emerald-100 text-emerald-800",
  partial: "bg-secondary-fixed text-on-secondary-fixed-variant",
  missing: "bg-rose-100 text-rose-700",
  new_sourced: "bg-primary-fixed text-on-primary-fixed-variant",
  new_developer: "bg-primary-fixed text-on-primary-fixed-variant",
  new_unsourced: "bg-rose-100 text-rose-700",
};

function Pill({ status }: { status: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 font-mono text-code-sm", PILL[status] ?? "bg-slate-100 text-slate-600")}>
      <span className="size-1.5 rounded-full bg-current" />
      {t(`cov.status.${status}` as MessageKey)}
    </span>
  );
}

function PhoneBaselineCards({ ticketKey, drift, versions, current }: { ticketKey: string; drift: DriftRecord; versions: RequirementRecord[]; current: Requirement | undefined }) {
  const r = drift.result;
  const acById = new Map((current?.acceptanceCriteria ?? []).map((a) => [a.id, a]));
  const currentRecord = versions.find((v) => v.id === drift.requirementId);
  const newOnes = r.current.filter((c) => c.status !== "mapped");
  const unsourced = newOnes.filter((c) => c.status === "new_unsourced");
  const card = "flex flex-col gap-2.5 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)]";
  return (
    <div className="flex flex-col gap-3 md:hidden">
      <div className="flex items-center justify-between">
        <span className="text-label-md uppercase tracking-[0.05em] text-on-surface-variant">{t("cov.phoneBaselineTitle")}</span>
        <span className="font-mono text-code-sm text-on-surface-variant">{t("cov.itemsTotal", { n: r.baseline.length })}</span>
      </div>
      {r.baseline.map((b) => {
        const item = baselineItem(b.id, versions);
        const first = b.coveredBy.map((id) => acById.get(id)).find(Boolean);
        return (
          <article key={b.id} className={card}>
            <div className="flex items-center justify-between gap-2">
              <span className={cn("min-w-0 break-all rounded px-2 py-0.5 font-mono text-code-md font-semibold", b.status === "missing" ? "bg-rose-50 text-rose-700" : "bg-surface-container-high")}>{b.id}</span>
              <Pill status={b.status} />
            </div>
            <blockquote className="rounded bg-surface-container-low px-3 py-2 text-body-md italic text-on-surface">“{item?.text ?? "—"}”</blockquote>
            <div className="flex items-center justify-between gap-2">
              <span className="text-label-md text-on-surface-variant">{t("cov.matchedCurrent")}</span>
              {first && <SourceTag ticketKey={ticketKey} source={first.source} snapshotId={currentRecord?.snapshotId} />}
            </div>
            {b.coveredBy.length === 0 ? (
              <div className="flex items-center gap-2 rounded bg-rose-50 px-3 py-2 text-body-sm text-rose-700">
                <AlertTriangle className="size-4 shrink-0" />
                {t("cov.noCounterpart")}
              </div>
            ) : (
              b.coveredBy.map((id) => (
                <div key={id} className="flex items-start gap-2 rounded bg-surface-container-low px-3 py-2">
                  {b.status === "partial" ? <RefreshCw className="mt-0.5 size-4 shrink-0 text-secondary" /> : <Check className="mt-0.5 size-4 shrink-0 text-tertiary" />}
                  <span className="min-w-0 font-mono text-code-md">
                    {id}: {acById.get(id)?.text ?? t("cov.unknownCurrent")}
                  </span>
                </div>
              ))
            )}
            {b.note && (
              <div className="flex items-start gap-2 rounded bg-secondary-fixed/40 px-3 py-2 text-body-sm">
                <Info className="mt-0.5 size-4 shrink-0 text-secondary" />
                <span className="min-w-0">
                  <span className="font-semibold">{t("cov.reasonLabel")}</span> {b.note}
                </span>
              </div>
            )}
          </article>
        );
      })}
      {newOnes.length > 0 && (
        <span className="mt-1 text-label-md uppercase tracking-[0.05em] text-on-surface-variant">{unsourced.length > 0 ? t("cov.phoneNewUnsourced") : t("cov.phoneNew")}</span>
      )}
      {newOnes.map((c) => {
        const ac = acById.get(c.id);
        return (
          <article key={c.id} className={card}>
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-all rounded bg-surface-container-high px-2 py-0.5 font-mono text-code-md font-semibold">{c.id}</span>
              <Pill status={c.status} />
            </div>
            {ac && <p className="text-body-md">{ac.text}</p>}
            {ac?.source.type === "developer" ? (
              <div className="flex flex-col gap-1 rounded bg-surface-container-low px-3 py-2 text-body-sm">
                <span className="flex items-center gap-1.5 font-semibold">
                  <PenLine className="size-4 text-primary" />
                  {t("cov.addedByYou")}
                </span>
                <span>
                  <span className="font-semibold">{t("cov.reasonLabel")}</span> {ac.source.reason}
                </span>
              </div>
            ) : (
              ac && <SourceTag ticketKey={ticketKey} source={ac.source} snapshotId={currentRecord?.snapshotId} />
            )}
          </article>
        );
      })}
      {r.contradictions.length > 0 && (
        <section aria-label={t("cov.contradictionsSection")} className="flex flex-col gap-3">
          <span className="mt-1 text-label-md uppercase tracking-[0.05em] text-rose-700">{t("cov.contradictionsSection")}</span>
          {contradictionRows(r, acById).map((c, i) => (
            <article key={i} className={cn(card, "border-l-4 border-l-error")}>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 break-all rounded bg-rose-50 px-2 py-0.5 font-mono text-code-md font-semibold text-rose-700">{c.acId}</span>
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded bg-rose-100 px-2 py-0.5 font-mono text-code-sm text-rose-700">
                  <AlertTriangle className="size-3.5" />
                  {t("cov.contradictionPill")}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-label-md text-on-surface-variant">{t("cov.currentAcLabel", { v: currentRecord?.version ?? "?" })}</span>
                <p className="rounded bg-surface-container-low px-3 py-2 text-body-md">{c.acText ?? "—"}</p>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-label-md text-on-surface-variant">{t("cov.original")}</span>
                <blockquote className="rounded border-l-2 border-rose-300 bg-rose-50/60 px-3 py-2 text-body-md italic">“{c.quote}”</blockquote>
              </div>
              <div className="flex items-start gap-2 rounded bg-rose-50 px-3 py-2 text-body-sm text-rose-800">
                <Info className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0">{c.explanation}</span>
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

function HistoryTable({ list }: { list: DriftRecord[] }) {
  return (
    <Card>
      <CardHeader icon={<History className="size-3.5" />} title={t("cov.history")} right={list.length} />
      <table className="block w-full text-left text-body-sm md:table">
        <thead className="hidden font-mono text-[10.5px] uppercase tracking-wide text-slate-500 md:table-header-group">
          <tr className="border-b border-slate-200">
            <th className="px-3 py-1.5 font-medium">{t("cov.col.time")}</th>
            <th className="px-3 font-medium">{t("cov.col.trigger")}</th>
            <th className="px-3 font-medium">{t("cov.col.result")}</th>
            <th className="px-3 font-medium">{t("cov.col.ack")}</th>
          </tr>
        </thead>
        <tbody className="block md:table-row-group">
          {list.map((d) => (
            <tr key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-100 px-3 py-2 last:border-b-0 md:table-row md:h-8 md:p-0">
              <td className="font-mono text-code-sm md:px-3" title={formatTime(d.createdAt)}>
                {timeAgo(d.createdAt)}
              </td>
              <td className="md:px-3">{t(`cov.trigger.${d.trigger}` as MessageKey)}</td>
              <td className={cn("basis-full font-mono text-code-sm md:basis-auto md:px-3", d.needsAck ? "text-amber-700" : "text-emerald-700")}>{summarize(d.result)}</td>
              <td className="md:px-3">
                {!d.needsAck ? (
                  <Badge tone="muted">{t("cov.notNeeded")}</Badge>
                ) : d.acknowledged ? (
                  <Badge tone="done">{t("cov.acknowledged")}</Badge>
                ) : (
                  <Badge tone="decision" pulse>
                    {t("cov.pending")}
                  </Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function AckPanel({ d, drift, mode }: { d: TicketDetail; drift: DriftRecord; mode: AckPanelMode }) {
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const ack = useAction(api.ackDrift);
  const back = useAction(api.backToEditing);
  const ackSnap = useAction(api.ackSnapshot);
  const ackReview = useAction(api.ackReview);
  const replan = useAction(api.replan);
  const items = ackItems(drift.result);
  const empty = note.trim() === "";
  const key = d.ticket.key;
  const primary =
    mode === "snapshot"
      ? { label: t("snap.ack"), thisWill: t("snap.ackThisWill"), pending: ackSnap.pending, run: () => ackSnap.run(key, note.trim()) }
      : mode === "acceptance"
        ? { label: t("cov.ackAccept"), thisWill: t("cov.ackAcceptThisWill"), pending: ackReview.pending, run: () => ackReview.run(key, note.trim()) }
      : mode === "proceed"
        ? { label: t("cov.ack"), thisWill: t("cov.ackThisWill"), pending: ack.pending, run: () => ack.run(key, note.trim()) }
        : { label: t("cov.ackReview"), thisWill: t("cov.ackReviewThisWill"), pending: ack.pending, run: () => ack.run(key, note.trim()) };
  const secondary =
    mode === "snapshot" || mode === "acceptance"
      ? {
          label: t("snap.replan"),
          barLabel: t("snap.replanShort"),
          thisWill: t(mode === "snapshot" ? "snap.replanThisWill" : "cov.replanAcceptThisWill"),
          pending: replan.pending,
          onClick: () => {
            if (window.confirm(t(mode === "snapshot" ? "snap.replanConfirm" : "cov.replanAcceptConfirm"))) void replan.run(key);
          },
        }
      : mode === "proceed"
        ? { label: t("cov.goBack"), barLabel: t("cov.backToEditing"), thisWill: t("cov.goBackThisWill"), pending: back.pending, onClick: () => void back.run(key) }
        : undefined;
  return (
    <DecisionCard
      phoneTitle={mode === "acceptance" ? t("cov.phoneTitleAccept") : mode === "snapshot" ? t("snap.phoneTitle") : t("cov.phoneTitle")}
      title={mode === "acceptance" ? t("cov.phoneTitleAccept") : mode === "snapshot" ? t("snap.phoneTitle") : undefined}
      subtitle={items.length > 0 ? t(mode === "acceptance" ? "cov.attentionAccept" : mode === "snapshot" ? "snap.attention" : "cov.attention", { n: items.length }) : undefined}
      primary={{
        label: primary.label,
        barLabel: mode === "snapshot" ? t("snap.ackShort") : mode === "acceptance" ? t("cov.ackAcceptShort") : undefined,
        thisWill: primary.thisWill,
        pending: primary.pending,
        onClick: () => {
          setTouched(true);
          if (!empty) void primary.run();
        },
      }}
      secondary={secondary}
      error={ack.error ?? back.error ?? ackSnap.error ?? ackReview.error ?? replan.error}
    >
      <ul className="flex flex-col gap-1 rounded border border-secondary-container/30 bg-white p-2 text-body-sm text-rose-700">
        {items.map((it, i) => (
          <li key={i} className="flex gap-1.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {it}
          </li>
        ))}
      </ul>
      {/* the check agent's suggested notes (one recommended); a revise one names the button it goes with */}
      <AnswerOptions
        options={(drift.result.ackOptions ?? [])
          .filter((o) => o.action === "acknowledge" || secondary !== undefined)
          .map((o) => ({ label: o.action === "revise" && secondary ? `${o.label} → ${secondary.barLabel ?? secondary.label}` : o.label, text: o.text, recommended: o.recommended }))}
        current={note}
        onPick={(text) => {
          setNote(text);
          setTouched(false);
        }}
      />
      <label className="flex flex-col gap-1">
        <span className="text-label-md">{t("cov.note")}</span>
        <Textarea
          rows={3}
          value={note}
          placeholder={t("cov.notePlaceholder")}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={touched && empty}
          className={cn("font-mono text-code-md", touched && empty && "border-rose-400")}
        />
        {touched && empty && <span className="text-body-sm text-rose-600">{t("cov.noteRequired")}</span>}
      </label>
    </DecisionCard>
  );
}

export function CoverageTab({ d }: { d: TicketDetail }) {
  const key = d.ticket.key;
  const drifts = useApi<DriftRecord[]>(paths.drift(key));
  const versions = useApi<RequirementRecord[]>(paths.requirements(key));
  return (
    <AsyncView state={drifts} isEmpty={(l) => l.length === 0} empty={t("cov.empty")}>
      {(list) => {
        const latest = list[0]!;
        const current = versions.data?.find((v) => v.id === latest.requirementId)?.content;
        const stale = d.requirement !== null && latest.requirementId !== d.requirement.id;
        const ackMode = ackPanelMode(d.ticket.state, latest, d.requirement?.id);
        return (
          <div className="flex flex-col gap-4 p-4 max-md:min-h-[calc(100dvh-var(--header-h,4rem))] max-md:gap-3 max-md:bg-surface-container-low max-md:px-3 lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="hidden md:block">
                <SummaryBar r={latest.result} />
              </div>
              <PhoneTiles r={latest.result} />
              <p className="font-mono text-code-sm text-slate-500 max-md:hidden">
                {t("cov.checkedAgainst", { id: latest.requirementId, base: latest.baselineSnapshotId, latest: latest.latestSnapshotId })} · {timeAgo(latest.createdAt)}
              </p>
              {stale && <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-body-sm text-slate-600">{t("cov.stale")}</div>}
              <div className="hidden md:block">
                <Matrix ticketKey={key} drift={latest} versions={versions.data ?? []} current={current} />
              </div>
              <PhoneBaselineCards ticketKey={key} drift={latest} versions={versions.data ?? []} current={current} />
              <HistoryTable list={list} />
            </div>
            {/* desktop: the decision stays in view while the matrix and history scroll (phones: its bar is sticky already) */}
            <aside
              data-testid="coverage-rail"
              className={cn("order-first flex flex-col gap-3 empty:hidden lg:order-none", STICKY_RAIL)}
            >
              {ackMode && <AckPanel d={d} drift={latest} mode={ackMode} />}
            </aside>
          </div>
        );
      }}
    </AsyncView>
  );
}
