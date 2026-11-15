import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, FileText, Loader2, Lock, Star, XCircle } from "lucide-react";
import { Fragment, useCallback, useRef, useState } from "react";
import { AnswerOptions } from "../../components/AnswerOptions.tsx";
import { Link, useNavigate } from "react-router";
import { AsyncView, Empty } from "../../components/AsyncView.tsx";
import { DecisionCard } from "../../components/DecisionCard.tsx";
import { DeliveryConfirmSheet } from "../../components/DeliveryConfirmSheet.tsx";
import { EvidenceLightbox, type LightboxItem } from "../../components/EvidenceLightbox.tsx";
import { LiveLog } from "../../components/LiveLog.tsx";
import { LogEvidence } from "../../components/LogEvidence.tsx";
import { ThisWill } from "../../components/ThisWill.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Textarea } from "../../components/ui/input.tsx";
import { t, type MessageKey } from "../../i18n/en.ts";
import { api, paths, type ReviewResponse, type TicketDetail } from "../../lib/api.ts";
import { useAction, useApi } from "../../lib/hooks.ts";
import { acCards, attemptTimeline, projectTests, reviewActions, verdictBanner, type AcCard, reviewRecommendation } from "../../lib/review-model.ts";
import { cn, timeAgo, STICKY_RAIL } from "../../lib/utils.ts";

const BANNER: Record<ReturnType<typeof verdictBanner>["tone"], string> = {
  done: "border-emerald-200 bg-emerald-50 text-emerald-900",
  blocked: "border-rose-200 bg-rose-50 text-rose-900",
  decision: "border-amber-300 bg-amber-50 text-amber-900",
  muted: "border-slate-200 bg-slate-50 text-slate-700",
};

function VerdictTag({ verdict }: { verdict: AcCard["verdict"] }) {
  return (
    <Badge tone={verdict === "pass" ? "done" : verdict === "fail" ? "blocked" : "muted"} className="h-6 px-2 text-code-md">
      {t(`acc.verdict.${verdict}` as MessageKey)}
    </Badge>
  );
}

function FlowChip({ kind }: { kind: string }) {
  const label = kind === "happy" || kind === "error" || kind === "edge" ? t(`acc.flow.${kind}` as MessageKey) : kind;
  return <span className="rounded-full bg-surface-container px-2 py-0.5 font-mono text-code-sm text-on-surface-variant">{label}</span>;
}

type OpenEvidence = (card: AcCard, id: number) => void;

/** Text evidence other than command blocks (HTTP exchanges): chips that open the lightbox. */
const chipLogs = (card: AcCard) => card.logs.filter((l) => !card.commands.some((c) => c.id === l.id));

/** Screenshot thumbnails (lazy, from the evidence route), log chips (a tap opens the lightbox) and, phase 4f, command blocks. */
function EvidenceRow({ ticketKey, card, open, className }: { ticketKey: string; card: AcCard; open: OpenEvidence; className?: string }) {
  if (card.shots.length === 0 && card.logs.length === 0) return <span className="text-body-sm text-slate-500">{t("acc.noEvidence")}</span>;
  const chips = chipLogs(card);
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      {card.shots.length > 0 && (
        <div className="scroll-x flex gap-2">
          {card.shots.map((s) => (
            <button key={s.id} type="button" aria-label={t("acc.openEvidence", { caption: s.caption })} onClick={() => open(card, s.id)} className="flex w-36 shrink-0 flex-col gap-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-container">
              <img src={paths.evidence(ticketKey, s.id)} alt={s.caption} loading="lazy" className="aspect-[16/10] w-full rounded border border-slate-200 bg-slate-100 object-cover object-top" />
              <span className="line-clamp-2 text-body-sm text-on-surface-variant">{s.caption}</span>
            </button>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((l) => (
            <button key={l.id} type="button" aria-label={t("acc.openLog", { caption: l.caption })} onClick={() => open(card, l.id)} className="flex min-h-11 max-w-full items-center gap-1.5 rounded border border-slate-200 bg-white px-2.5 font-mono text-code-md hover:bg-slate-50 md:min-h-8">
              <FileText className="size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{l.caption}</span>
            </button>
          ))}
        </div>
      )}
      {card.commands.map((c) => (
        <LogEvidence key={c.id} ticketKey={ticketKey} id={c.id} caption={c.caption} />
      ))}
    </div>
  );
}

function Mismatch({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-body-sm text-rose-800" data-testid="mismatch">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
}

function Steps({ steps }: { steps: string[] }) {
  return (
    <ol className="list-decimal pl-4 text-body-sm">
      {steps.map((s, i) => (
        <li key={i} className="[overflow-wrap:anywhere]">
          {s}
        </li>
      ))}
    </ol>
  );
}

/** Below lg: one card per AC; the first and every failed one start expanded. */
function AcCardView({ ticketKey, card, initiallyOpen, open }: { ticketKey: string; card: AcCard; initiallyOpen: boolean; open: OpenEvidence }) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  return (
    <Card className="overflow-hidden" data-testid="ac-card">
      <button type="button" aria-expanded={expanded} aria-label={`${card.acId} — ${expanded ? t("acc.hideDetails") : t("acc.showDetails")}`} onClick={() => setExpanded(!expanded)} className="flex min-h-11 w-full items-start gap-2 px-3 py-2.5 text-left">
        {expanded ? <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />}
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-mono text-code-lg font-semibold">{card.acId}</span>
          <span className="text-body-md [overflow-wrap:anywhere]">{card.text}</span>
          <span className="flex flex-wrap gap-1">
            {card.flows.map((f, i) => (
              <FlowChip key={i} kind={f.kind} />
            ))}
          </span>
        </span>
        <VerdictTag verdict={card.verdict} />
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 border-t border-slate-200 px-3 py-3">
          {card.flows.map((f, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded bg-surface-container-low p-2">
              <div className="flex flex-wrap items-center gap-2">
                <FlowChip kind={f.kind} />
                <span className="min-w-0 text-label-md [overflow-wrap:anywhere]">{f.title}</span>
                <span className={cn("ml-auto flex items-center gap-1 text-body-sm", f.ok ? "text-emerald-700" : "text-rose-700")}>
                  {f.ok ? <CheckCircle2 className="size-3.5" aria-hidden /> : <XCircle className="size-3.5" aria-hidden />}
                  {t(f.ok ? "acc.testPassed" : "acc.testFailed")}
                </span>
              </div>
              <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-body-sm">
                <dt className="text-slate-500">{t("acc.steps")}</dt>
                <dd className="min-w-0">
                  <Steps steps={f.steps} />
                </dd>
                <dt className="text-slate-500">{t("acc.expected")}</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]">{f.expected}</dd>
                <dt className="text-slate-500">{t("acc.actual")}</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]">{f.actual}</dd>
              </dl>
            </div>
          ))}
          <EvidenceRow ticketKey={ticketKey} card={card} open={open} />
          {card.mismatch && <Mismatch text={card.mismatch} />}
        </div>
      )}
    </Card>
  );
}

/** lg and up: AC → flow → expected → actual → evidence → result. */
function AcTable({ ticketKey, cards, open }: { ticketKey: string; cards: AcCard[]; open: OpenEvidence }) {
  return (
    <Card className="hidden overflow-hidden lg:block">
      <table className="w-full table-fixed border-collapse text-left text-body-sm" data-testid="ac-table">
        <colgroup>
          <col className="w-[17%]" />
          <col className="w-[20%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
          <col className="w-[23%]" />
          <col className="w-[10%]" />
        </colgroup>
        <thead className="bg-slate-50 text-label-sm uppercase tracking-[0.05em] text-slate-600">
          <tr>
            {(["acc.colAc", "acc.colFlow", "acc.colExpected", "acc.colActual", "acc.colEvidence", "acc.colResult"] as const).map((k) => (
              <th key={k} className="border-b border-slate-200 px-3 py-2 font-semibold">
                {t(k)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => {
            const rows = c.flows.length === 0 ? [null] : c.flows;
            return (
              <Fragment key={c.acId}>
                {rows.map((f, i) => (
                  <tr key={i} className={cn("align-top", i === rows.length - 1 && !c.mismatch && "border-b border-slate-200")}>
                    {i === 0 && (
                      <td rowSpan={rows.length} className="border-b border-slate-200 px-3 py-2 align-top">
                        <div className="font-mono text-code-md font-semibold">{c.acId}</div>
                        <div className="[overflow-wrap:anywhere]">{c.text}</div>
                      </td>
                    )}
                    {f ? (
                      <>
                        <td className="px-3 py-2">
                          <div className="mb-1 flex flex-wrap items-center gap-1.5">
                            <FlowChip kind={f.kind} />
                            <span className="font-semibold [overflow-wrap:anywhere]">{f.title}</span>
                          </div>
                          <Steps steps={f.steps} />
                        </td>
                        <td className="px-3 py-2 [overflow-wrap:anywhere]">{f.expected}</td>
                        <td className={cn("px-3 py-2 [overflow-wrap:anywhere]", !f.ok && "text-rose-700")}>{f.actual}</td>
                      </>
                    ) : (
                      <td colSpan={3} className="px-3 py-2 text-slate-500">
                        —
                      </td>
                    )}
                    {i === 0 && (
                      <>
                        <td rowSpan={rows.length} className="border-b border-slate-200 px-3 py-2 align-top">
                          <EvidenceRow ticketKey={ticketKey} card={c} open={open} />
                        </td>
                        <td rowSpan={rows.length} className="border-b border-slate-200 px-3 py-2 align-top">
                          <VerdictTag verdict={c.verdict} />
                        </td>
                      </>
                    )}
                  </tr>
                ))}
                {c.mismatch && (
                  <tr className="border-b border-slate-200">
                    <td colSpan={6} className="px-3 pb-2">
                      <Mismatch text={c.mismatch} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function PreviousAttempts({ v }: { v: ReviewResponse }) {
  const [open, setOpen] = useState(false);
  const groups = attemptTimeline(v.series, v.reports);
  const last = groups.flatMap((g) => g.items).at(-1);
  return (
    <Card>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left">
        {open ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-label-md font-semibold">{t("acc.previous")}</span>
          {!open && (
            <span className="truncate text-body-sm text-slate-500">
              {last ? `${t("acc.attempt", { n: last.attempt })} · ${t(`acc.verdictWord.${last.verdict}` as MessageKey)}` : t("acc.previousNone")}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-slate-200 px-3 py-3" data-testid="attempt-timeline">
          {groups.length === 0 && <p className="text-body-sm text-slate-500">{t("acc.previousNone")}</p>}
          {groups.map((g, gi) => (
            <div key={g.seriesId} className="flex flex-col gap-1">
              <span className="text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">{t(`acc.round.${g.startedBy}` as MessageKey, { n: gi + 1 })}</span>
              <ul className="flex flex-col gap-1 text-body-sm">
                {g.items.map((it) => (
                  <li key={it.attempt} className="[overflow-wrap:anywhere]">
                    {[
                      t("acc.attempt", { n: it.attempt }),
                      t(`acc.verdictWord.${it.verdict}` as MessageKey),
                      ...(it.failedAcs.length > 0 ? [it.failedAcs.join(", ")] : []),
                      ...(it.decision ? [t(`acc.decision.${it.decision}` as MessageKey)] : []),
                    ].join(" · ")}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function ReviewDecision({ d, v }: { d: TicketDetail; v: ReviewResponse }) {
  const key = d.ticket.key;
  const navigate = useNavigate();
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [sheet, setSheet] = useState(false);
  const reject = useAction(api.rejectReview);
  const reReview = useAction(api.reReview);
  const closeSheet = useCallback(() => setSheet(false), []);
  const curSeries = v.series.at(-1)?.id;
  const attempts = v.reports.filter((r) => r.seriesId === curSeries).length;
  const actions = reviewActions(d.ticket.state, v.step, v.maxAttempts, attempts);
  // Slack Off's recommendation from the latest report of this round, and suggested notes for reject / re-run
  const rec = reviewRecommendation(v.current);
  const empty = note.trim() === "";

  const noteRef = useRef<HTMLTextAreaElement>(null);
  const withNote = async (run: (k: string, n: string) => Promise<boolean>, then?: () => void) => {
    setTouched(true);
    if (empty) {
      // the buttons may be in the phone bar, away from the field: bring it into view
      noteRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      noteRef.current?.focus({ preventScroll: true });
      return;
    }
    if (await run(key, note.trim())) {
      setNote("");
      setTouched(false);
      then?.();
    }
  };
  const doReject = () => void withNote(reject.run, () => navigate(`/tickets/${key}/development`));
  const doReReview = () => void withNote(reReview.run);

  return (
    <>
      <DecisionCard
        title={t("acc.decisionTitle")}
        phoneTitle={t("acc.decisionPhone")}
        subtitle={t("acc.decisionSubtitle")}
        primary={{ label: t("acc.confirm"), barLabel: t("acc.confirmShort"), thisWill: t("acc.confirmThisWill"), disabled: !actions.confirm, onClick: () => setSheet(true) }}
        secondary={{ label: t("acc.reject"), thisWill: t("acc.rejectThisWill"), pending: reject.pending, disabled: !actions.reject, onClick: doReject }}
        barExtra={[{ label: t("acc.reject"), disabled: !actions.reject || reject.pending, onClick: doReject }]}
        barSecondary={{ label: t("acc.reReviewShort"), disabled: !actions.reReview.enabled || reReview.pending, onClick: doReReview }}
        error={reject.error ?? reReview.error}
        after={
          <div className="flex flex-col gap-1.5 border-t border-secondary-container/30 pt-3 max-lg:hidden">
            <Button className="w-full" disabled={!actions.reReview.enabled || reReview.pending} onClick={doReReview}>
              {reReview.pending ? t("common.loading") : t("acc.reReview")}
            </Button>
            <ThisWill>{t("acc.reReviewThisWill")}</ThisWill>
          </div>
        }
      >
        {rec && (
          <p className="flex items-start gap-1.5 rounded bg-white px-2 py-1.5 text-body-sm text-on-surface" data-testid="review-recommendation">
            <Star className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 break-words">{t("acc.recommended", { action: rec.action === "confirm" ? t("acc.confirm") : t("acc.reject"), reason: rec.reason })}</span>
          </p>
        )}
        {rec && <AnswerOptions options={rec.options} current={note} onPick={(text) => (setNote(text), setTouched(false))} />}
        <label className="flex flex-col gap-1">
          <span className="text-label-md">{t("acc.note")}</span>
          <Textarea
            ref={noteRef}
            rows={3}
            value={note}
            placeholder={t("acc.notePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && empty}
            className={cn("font-mono text-code-md", touched && empty && "border-rose-400")}
          />
          {touched && empty && <span className="text-body-sm text-rose-600">{t("acc.noteRequired")}</span>}
        </label>
        <div className="flex flex-col gap-1 lg:hidden">
          <ThisWill>{`${t("acc.reject")} — ${t("acc.rejectThisWill")}`}</ThisWill>
          <ThisWill>{`${t("acc.reReview")} — ${t("acc.reReviewThisWill")}`}</ThisWill>
        </div>
        {actions.reReview.reason && (
          <p className="text-body-sm font-semibold text-on-secondary-fixed-variant" data-testid="rereview-reason">
            {t("acc.reReview")}: {actions.reReview.reason}
          </p>
        )}
      </DecisionCard>
      {sheet && <DeliveryConfirmSheet ticketKey={key} onClose={closeSheet} onDone={() => navigate(`/tickets/${key}/delivery`)} />}
    </>
  );
}

function Acceptance({ d, v }: { d: TicketDetail; v: ReviewResponse }) {
  const key = d.ticket.key;
  const state = d.ticket.state;
  const cur = v.current;
  const banner = verdictBanner(cur, v.maxAttempts);
  const cards = cur ? acCards(cur.report, v.evidence) : [];
  const [lb, setLb] = useState<{ acId: string; index: number } | null>(null);
  const items = (card: AcCard): LightboxItem[] => [
    ...card.shots.map((s) => ({ id: s.id, caption: s.caption, kind: "screenshot", acId: card.acId })),
    ...chipLogs(card).map((l) => ({ id: l.id, caption: l.caption, kind: "log", acId: card.acId })),
  ];
  const lbCard = lb ? cards.find((c) => c.acId === lb.acId) : undefined;
  const open: OpenEvidence = (card, id) => setLb({ acId: card.acId, index: Math.max(0, items(card).findIndex((x) => x.id === id)) });
  const waiting = reviewActions(state, v.step, v.maxAttempts, 0).confirm;
  const running = state === "reviewing";

  if (!cur && !running && state !== "awaiting_review_ack") return <Empty>{t("acc.empty")}</Empty>;

  return (
    <div className={cn("flex flex-col gap-3 p-3 max-md:min-h-[calc(100dvh-var(--header-h,4rem))] max-md:bg-surface-container-low lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-4 lg:p-4", waiting && "max-lg:pb-28")}>
      <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
        {running && (
          <div className="flex items-start gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-body-md text-blue-900" data-testid="acc-running">
            <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden />
            <span className="flex flex-col">
              <span className="font-semibold">{t("acc.running")}</span>
              <span className="text-body-sm">{t("acc.runningBody")}</span>
            </span>
          </div>
        )}
        {state === "awaiting_review_ack" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-1 text-body-md text-amber-900">
            <span className="min-w-0 py-1.5">{t("acc.awaitingAck")}</span>
            <Link to={`/tickets/${key}/coverage`} className="flex min-h-11 items-center font-semibold text-primary hover:underline md:min-h-8">
              {t("acc.toCoverage")}
            </Link>
          </div>
        )}
        {v.step?.kind === "fix" && state === "developing" && <p className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-body-sm text-slate-700">{t("acc.fixing")}</p>}

        {cur && (
          <>
            <section className={cn("flex flex-col gap-0.5 rounded border px-3 py-2.5", BANNER[banner.tone])} data-testid="verdict-banner" aria-label={banner.title}>
              <span className="text-headline-sm">
                {banner.title}
                <span className="text-body-md font-normal"> · {timeAgo(cur.createdAt)}</span>
              </span>
              {banner.detail && <span className="text-body-md [overflow-wrap:anywhere]">{banner.detail}</span>}
            </section>
            <p className={cn("flex items-start gap-2 rounded px-3 py-2 text-body-sm", cur.report.isolation.ok ? "bg-surface-container text-on-surface-variant" : "border border-rose-200 bg-rose-50 text-rose-800")} data-testid="isolation-note">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {t("acc.isolation")}
                {!cur.report.isolation.ok && <span className="block font-semibold">{t("acc.isolationFailed")}</span>}
                {cur.report.isolation.excluded.length > 0 && <span className="block">{t("acc.excluded", { files: cur.report.isolation.excluded.join(", ") })}</span>}
              </span>
            </p>
            {cur.report.summary.trim() !== "" && (
              <p className="text-body-md text-on-surface [overflow-wrap:anywhere]">
                <span className="font-semibold">{t("acc.summary")}: </span>
                {cur.report.summary}
              </p>
            )}
            <section className="flex flex-col gap-2" aria-label={t("acc.criteria")}>
              <h2 className="text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">{t("acc.criteria")}</h2>
              <AcTable ticketKey={key} cards={cards} open={open} />
              <div className="flex flex-col gap-2 lg:hidden">
                {cards.map((c, i) => (
                  <AcCardView key={c.acId} ticketKey={key} card={c} initiallyOpen={i === 0 || c.verdict === "fail"} open={open} />
                ))}
              </div>
            </section>
            {cur.report.projectE2e.length > 0 && (
              // 4F-8 (I-3): the project's own test command (web, api, cli, library alike) — extra evidence only
              <section className="flex min-w-0 flex-col gap-1" aria-label={t("acc.projectTests")} data-testid="project-tests">
                <h2 className="text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">{t("acc.projectTests")}</h2>
                {projectTests(cur.report.projectE2e).map((p, i) => (
                  <details key={i} className="min-w-0 max-w-full rounded border border-slate-200">
                    <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-2 text-body-sm md:min-h-8">
                      <span className="min-w-0 font-mono text-code-sm [overflow-wrap:anywhere]">{p.command}</span>
                      <span className={cn("shrink-0 font-semibold", p.ok ? "text-emerald-700" : "text-rose-700")}>{p.status}</span>
                    </summary>
                    {p.tail.trim() !== "" && <pre className="m-0 max-h-48 max-w-full overflow-auto border-t border-slate-200 px-2 py-1.5 font-mono text-code-sm whitespace-pre">{p.tail}</pre>}
                  </details>
                ))}
              </section>
            )}
            {cur.report.commits.length > 0 && (
              <p className="font-mono text-code-sm text-slate-500 [overflow-wrap:anywhere]">
                {t("acc.commits")}: {cur.report.commits.map((c) => `${c.repo}@${c.sha.slice(0, 8)}`).join(" · ")}
              </p>
            )}
          </>
        )}
        {v.reports.length > 0 && <PreviousAttempts v={v} />}
        {running && (
          <Card>
            <div className="p-3">
              <LiveLog ticketKey={key} roles={["acceptance-review"]} />
            </div>
          </Card>
        )}
      </div>
      {waiting && cur && (
        <aside className={cn("flex flex-col gap-3", STICKY_RAIL)}>
          <ReviewDecision d={d} v={v} />
        </aside>
      )}
      {lb && lbCard && <EvidenceLightbox ticketKey={key} items={items(lbCard)} index={lb.index} onIndex={(i) => setLb({ acId: lb.acId, index: i })} onClose={() => setLb(null)} />}
    </div>
  );
}

export function AcceptanceTab({ d }: { d: TicketDetail }) {
  const view = useApi<ReviewResponse>(paths.review(d.ticket.key));
  return <AsyncView state={view}>{(v) => <Acceptance d={d} v={v} />}</AsyncView>;
}
