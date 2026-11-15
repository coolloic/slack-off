import { ChevronRight, Download, FileText, GitCompare, ListChecks, MessagesSquare, Star } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AsyncView, Empty, ErrorBox, Loading } from "../../components/AsyncView.tsx";
import { DecisionCard } from "../../components/DecisionCard.tsx";
import { LiveLog } from "../../components/LiveLog.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Select, Textarea } from "../../components/ui/input.tsx";
import { t, type MessageKey } from "../../i18n/en.ts";
import { api, paths, type DesignDocResponse, type DesignResponse, type TicketDetail } from "../../lib/api.ts";
import {
  checklistPanel, currentRound, docMarkdown, finalizeCaption, inlineSpans, lineDiff, mdBlocks, parseTable, rulingDraftValid, rulingsPayload, type ChecklistPanelGroup,
  type RulingDraft,
} from "../../lib/debate-model.ts";
import { useAction, useApi } from "../../lib/hooks.ts";
import { useDraft } from "../../lib/use-draft.ts";
import { cn, STICKY_RAIL } from "../../lib/utils.ts";
import { isCritique, type CommentResponse, type DebateRoundRecord, type Disagreement, type Ruling, type RulingRecord } from "@slackoff/shared";

const ROLES = ["design-solution", "critique-design"] as const;

// ---------------------------------------------------------------- Markdown as text (never HTML)

/** `code` and **bold** spans as React text nodes; everything else stays literal text (no HTML, no links). */
function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineSpans(text).map((p, i) =>
        p.kind === "code" ? (
          <code key={i} className="break-words rounded bg-surface-container px-1 font-mono text-code-md">
            {p.text}
          </code>
        ) : p.kind === "bold" ? (
          <strong key={i} className="font-semibold">
            {p.text}
          </strong>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function Markdown({ md }: { md: string }) {
  const blocks = mdBlocks(md);
  if (blocks.length === 0) return <p className="text-body-sm text-slate-400">{t("sol.none")}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2 break-words text-body-md leading-6 text-on-surface">
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const size = b.level <= 1 ? "text-headline-lg" : b.level === 2 ? "text-headline-md" : "text-headline-sm";
          return (
            <p key={i} role="heading" aria-level={Math.min(b.level + 2, 6)} className={cn("font-semibold", size)}>
              <Inline text={b.text} />
            </p>
          );
        }
        const table = b.kind === "table" ? parseTable(b.text) : null;
        if (table)
          return (
            // a wide table scrolls inside its box; the page never gets wider than the screen
            <div key={i} className="max-w-full overflow-x-auto rounded border border-slate-200" data-testid="md-table">
              <table className="w-full border-collapse text-left text-body-sm">
                <thead className="bg-slate-50">
                  <tr>
                    {table.header.map((h, j) => (
                      <th key={j} scope="col" className="border-b border-slate-200 px-2 py-1.5 align-top font-semibold">
                        <Inline text={h} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r, j) => (
                    <tr key={j} className="border-b border-slate-100 last:border-0">
                      {r.map((c, k) => (
                        <td key={k} className="min-w-[6rem] px-2 py-1.5 align-top">
                          <Inline text={c} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        if (b.kind === "code" || b.kind === "table")
          return (
            <pre key={i} className="overflow-x-auto whitespace-pre rounded border border-slate-200 bg-slate-50 p-2 font-mono text-code-md">
              {b.text}
            </pre>
          );
        if (b.kind === "list") {
          const List = b.ordered ? "ol" : "ul";
          return (
            <List key={i} className={cn("flex flex-col gap-0.5 pl-5", b.ordered ? "list-decimal" : "list-disc")}>
              {b.items.map((x, j) => (
                <li key={j}>
                  <Inline text={x} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            <Inline text={b.text} />
          </p>
        );
      })}
    </div>
  );
}

/** A collapsible section with a ≥44px header row. */
function Fold({ title, right, open, children, className }: { title: ReactNode; right?: ReactNode; open?: boolean; children: ReactNode; className?: string }) {
  return (
    <details open={open} className={cn("group rounded bg-surface-container-low", className)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-on-surface-variant transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
        {right && <span className="shrink-0 font-mono text-code-sm text-on-surface-variant">{right}</span>}
      </summary>
      <div className="px-3 pb-3">{children}</div>
    </details>
  );
}

// ---------------------------------------------------------------- design document

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DiffView({ prev, cur }: { prev: DesignDocResponse; cur: DesignDocResponse }) {
  const lines = useMemo(() => lineDiff(docMarkdown(prev), docMarkdown(cur)), [prev, cur]);
  const add = lines.filter((l) => l.kind === "add").length;
  const del = lines.filter((l) => l.kind === "del").length;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="design-diff">
      <span className="font-mono text-code-sm text-on-surface-variant">{t("design.diffSummary", { add, del, from: prev.version, to: cur.version })}</span>
      <ol className="overflow-hidden rounded border border-slate-200 font-mono text-code-md">
        {lines.map((l, i) => (
          <li
            key={i}
            className={cn(
              "flex min-w-0 gap-2 whitespace-pre-wrap break-words px-2",
              l.kind === "add" && "bg-emerald-50 text-emerald-900",
              l.kind === "del" && "bg-rose-50 text-rose-900 line-through decoration-rose-300",
            )}
          >
            <span aria-hidden className="w-3 shrink-0 select-none text-slate-400">
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            <span className="min-w-0">{l.text || " "}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DocBody({ doc }: { doc: DesignDocResponse }) {
  return (
    <div className="flex flex-col gap-2">
      <Fold title={t("design.overview")} open>
        <Markdown md={doc.contentMd} />
      </Fold>
      {doc.repos.map((r) => (
        <Fold key={r.repo} title={<span className="font-mono">{r.repo}</span>}>
          <Markdown md={r.contentMd} />
        </Fold>
      ))}
    </div>
  );
}

function DocumentCard({ ticketKey, v, version, onVersion }: { ticketKey: string; v: DesignResponse; version: number; onVersion: (n: number) => void }) {
  const [diff, setDiff] = useState(false);
  const versions = v.docs.map((d) => d.version);
  const latest = versions.at(-1);
  const meta = v.docs.find((d) => d.version === version);
  const prevVersion = versions.filter((n) => n < version).at(-1);
  const showDiff = diff && prevVersion !== undefined;
  const doc = useApi<DesignDocResponse>(paths.designDoc(ticketKey, version));
  const prev = useApi<DesignDocResponse>(showDiff ? paths.designDoc(ticketKey, prevVersion) : null);
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 max-md:rounded-lg max-md:border-0 max-md:shadow-[0_1px_3px_rgba(15,23,42,0.08)]" data-testid="design-doc">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-headline-md max-sm:w-full sm:flex-1">
          <FileText className="size-5 shrink-0 text-primary" aria-hidden />
          {t("design.document")}
        </span>
        <Select
          aria-label={t("design.version")}
          className="h-11 font-mono text-code-md md:h-9"
          value={version}
          onChange={(e) => {
            onVersion(Number(e.target.value));
            setDiff(false);
          }}
        >
          {[...versions].reverse().map((n) => (
            <option key={n} value={n}>
              {t("design.versionOption", { v: n })}
              {n === latest ? ` (${t("design.latest")})` : ""}
            </option>
          ))}
        </Select>
        <Badge tone={meta?.isFinal ? "done" : "decision"}>{meta?.isFinal ? t("design.final") : t("design.notFinal")}</Badge>
      </div>
      <div className="flex flex-wrap gap-2">
        {prevVersion !== undefined && (
          <Button size="md" aria-pressed={showDiff} className={cn(showDiff && "border-primary text-primary")} onClick={() => setDiff((x) => !x)}>
            <GitCompare className="size-4" aria-hidden />
            {showDiff ? t("design.showDocument") : t("design.showChanges", { v: prevVersion })}
          </Button>
        )}
        <Button
          size="md"
          title={t("design.exportHelp")}
          disabled={!doc.data}
          onClick={() => doc.data && download(`${ticketKey}-design-v${doc.data.version}.md`, docMarkdown(doc.data))}
        >
          <Download className="size-4" aria-hidden />
          {t("design.export")}
        </Button>
      </div>
      {doc.data === undefined ? (
        doc.error ? <ErrorBox error={doc.error.message} onRetry={doc.reload} /> : <Loading />
      ) : showDiff ? (
        prev.data ? <DiffView prev={prev.data} cur={doc.data} /> : prev.error ? <ErrorBox error={prev.error.message} /> : <Loading />
      ) : (
        <DocBody doc={doc.data} />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- checklist

const STATUS_CHIP = {
  considered: "bg-emerald-50 text-emerald-700",
  not_applicable: "bg-slate-100 text-slate-600",
  missing: "bg-amber-50 text-amber-800",
  disputed: "bg-rose-100 text-rose-700",
} as const;

function ChecklistCard({ groups, error }: { groups: ChecklistPanelGroup[]; error: string | null }) {
  const items = groups.flatMap((g) => g.items);
  const disputed = items.filter((i) => i.disputed).length;
  const missing = items.filter((i) => i.status === "missing").length;
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 max-md:rounded-lg max-md:border-0 max-md:shadow-[0_1px_3px_rgba(15,23,42,0.08)]" data-testid="design-checklist">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-headline-md">
            <ListChecks className="size-5 shrink-0 text-primary" aria-hidden />
            {t("design.checklist")}
          </span>
          <span className="text-body-sm text-on-surface-variant">{t("design.checklistSummary", { n: items.length, disputed, missing })}</span>
        </div>
        {disputed > 0 && <Badge tone="blocked">{t("design.disputedCount", { n: disputed })}</Badge>}
      </div>
      {error && <p className="rounded bg-amber-50 px-2 py-1.5 text-body-sm text-amber-800">{t("design.checklistError", { error })}</p>}
      <div className="flex flex-col gap-2">
        {groups.map((g) => (
          <Fold
            key={g.group}
            open={g.disputed > 0 || g.items.some((i) => i.status === "missing")}
            title={t(`design.group.${g.group}` as MessageKey)}
            right={g.disputed > 0 ? <span className="text-rose-700">{t("design.disputedCount", { n: g.disputed })}</span> : t("design.groupCount", { n: g.items.length })}
          >
            <ul className="flex flex-col gap-1.5">
              {g.items.map((i) => {
                const chip = i.disputed ? "disputed" : i.status;
                return (
                  <li key={i.id} className={cn("flex min-w-0 flex-col gap-1 rounded bg-white p-2", i.disputed && "ring-1 ring-rose-200")} data-testid={`checklist-${i.id}`}>
                    <span className="flex items-start gap-2">
                      <span className={cn("min-w-0 flex-1 break-words text-body-md font-medium", i.disputed && "text-rose-700")}>{i.label}</span>
                      <span className={cn("shrink-0 rounded px-1.5 py-0.5 font-mono text-code-sm", STATUS_CHIP[chip])}>{t(`design.status.${chip}` as MessageKey)}</span>
                    </span>
                    {i.conclusion && <span className="break-words text-body-sm text-on-surface-variant">{i.conclusion}</span>}
                    {i.comments > 0 && (
                      <span className="flex items-center gap-1 font-mono text-code-sm text-on-surface-variant">
                        <MessagesSquare className="size-3.5" aria-hidden />
                        {i.comments} {t("design.comments", { n: i.comments })}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Fold>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- debate timeline

const RepoTag = ({ repo }: { repo: string | null }) => (
  <span className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-code-sm text-on-surface">{repo ?? t("design.crossRepo")}</span>
);

function DesignerAnswer({ r }: { r: Pick<CommentResponse, "verdict" | "reason"> }) {
  return (
    <div className="ml-2 flex flex-col gap-0.5 border-l-2 border-primary/40 pl-2">
      <span className="font-mono text-code-sm text-primary">
        {t("design.designer")} · {t(r.verdict === "accepted" ? "design.accepted" : "design.rebutted")}
      </span>
      <span className="break-words text-body-sm text-on-surface">
        <Inline text={r.reason} />
      </span>
    </div>
  );
}

function Timeline({ v, labelOf, live, ticketKey }: { v: DesignResponse; labelOf: (id: string) => string; live: boolean; ticketKey: string }) {
  const numbers = [...new Set(v.rounds.map((r) => r.round))].sort((a, b) => a - b);
  const last = numbers.at(-1);
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 max-md:rounded-lg max-md:border-0 max-md:shadow-[0_1px_3px_rgba(15,23,42,0.08)]" data-testid="design-debate">
      <span className="flex items-center justify-between gap-2">
        <span className="text-headline-md">{t("design.debate")}</span>
        <span className="font-mono text-code-sm text-on-surface-variant">{t("design.round", { n: last ?? 0, max: v.maxRounds })}</span>
      </span>
      {live && <LiveLog ticketKey={ticketKey} roles={ROLES} />}
      {numbers.length === 0 && <p className="text-body-sm text-slate-500">{t("design.noRounds")}</p>}
      {numbers.map((n) => {
        const critic = v.rounds.filter((r) => r.round === n && r.role === "critic").at(-1);
        const designer = v.rounds.filter((r) => r.round === n && r.role === "designer").at(-1);
        return <RoundView key={n} n={n} critic={critic} designer={designer} rulings={v.rulings} open={n === last} labelOf={labelOf} />;
      })}
    </Card>
  );
}

const DECISION_LABEL: Record<Ruling["decision"], MessageKey> = { designer: "design.decision.designer", critic: "design.decision.critic", custom: "design.decision.custom" };

function RoundView({ n, critic, designer, rulings, open, labelOf }: { n: number; critic?: DebateRoundRecord; designer?: DebateRoundRecord; rulings: RulingRecord[]; open: boolean; labelOf: (id: string) => string }) {
  const comments = critic && isCritique(critic.content) ? critic.content.comments : [];
  const responses = designer && !isCritique(designer.content) ? designer.content.responses : [];
  const blocking = comments.filter((c) => c.blocking).length;
  return (
    <Fold
      open={open}
      title={t("design.roundN", { n })}
      right={blocking > 0 ? <span className="text-rose-700">{t("design.blockingCount", { n: blocking })}</span> : t("design.noBlocking")}
    >
      <ul className="flex flex-col gap-2">
        {comments.map((c) => {
          const resp = responses.find((r) => r.commentId === c.id);
          const ruling = critic ? rulings.find((r) => r.debateRoundId === critic.id && r.commentId === c.id) : undefined;
          return (
            <li key={c.id} className="flex min-w-0 flex-col gap-1.5 rounded bg-white p-2">
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone={c.blocking ? "blocked" : "muted"}>{c.blocking ? t("design.blocking") : t("design.nonBlocking")}</Badge>
                <RepoTag repo={c.repo} />
                <span className="min-w-0 break-words text-body-sm text-on-surface-variant">{labelOf(c.checklistItem)}</span>
                <span className="ml-auto font-mono text-code-sm text-on-surface-variant">
                  {t("design.critic")} · {c.id}
                </span>
              </span>
              {/* agent-written text: code and bold spans, never HTML (Inline) */}
              <span className="break-words text-body-md">
                <Inline text={c.text} />
              </span>
              {c.suggestion && (
                <span className="break-words text-body-sm text-on-surface-variant">
                  {t("design.suggestion", { s: "" })}
                  <Inline text={c.suggestion} />
                </span>
              )}
              {resp && <DesignerAnswer r={resp} />}
              {ruling && (
                <span className="break-words rounded bg-[#fff8f1] px-2 py-1 text-body-sm text-on-secondary-fixed-variant">
                  {t("design.yourRuling", { d: t(DECISION_LABEL[ruling.decision]) })}
                  {ruling.note ? ` — ${ruling.note}` : ""}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Fold>
  );
}

// ---------------------------------------------------------------- rulings

type Advice = DesignResponse["advice"][number];

function RulingCard({ i, d, label, value, advice, onChange }: { i: number; d: Disagreement; label: string; value: RulingDraft[string] | undefined; advice: Advice | undefined; onChange: (next: RulingDraft[string]) => void }) {
  const decision = value?.decision;
  const note = value?.note ?? "";
  const options: Array<{ id: Ruling["decision"]; title: MessageKey; detail: string }> = [
    { id: "designer", title: "design.acceptDesigner", detail: d.designer?.reason ?? t("design.noDesignerAnswer") },
    { id: "critic", title: "design.acceptCritic", detail: d.critic.suggestion ?? d.critic.text },
    { id: "custom", title: "design.custom", detail: t("design.customPlaceholder") },
  ];
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded bg-white p-2.5" data-testid={`ruling-${d.commentId}`}>
      <legend className="sr-only">{`${label} (${d.commentId})`}</legend>
      <span className="flex items-start gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary-fixed font-mono text-code-sm text-on-secondary-fixed-variant">{i + 1}</span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="break-words text-headline-sm">{label}</span>
            <RepoTag repo={d.repo} />
            <span className="font-mono text-code-sm text-on-surface-variant">{d.commentId}</span>
          </span>
          <span className="break-words text-body-md">
            <span className="font-semibold">{t("design.critic")}: </span>
            <Inline text={d.critic.text} />
          </span>
          {d.designer && (
            <span className="break-words text-body-md text-on-surface-variant">
              <span className="font-semibold">{t("design.designer")} ({t(d.designer.verdict === "accepted" ? "design.accepted" : "design.rebutted")}): </span>
              <Inline text={d.designer.reason} />
            </span>
          )}
        </span>
      </span>
      <div className="flex flex-col gap-1.5">
        {options.map((o) => (
          <label
            key={o.id}
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-2.5 rounded border border-slate-200 px-2.5 py-2",
              decision === o.id && "border-primary bg-primary-fixed/40",
            )}
          >
            <input
              type="radio"
              name={`ruling-${d.commentId}`}
              className="mt-0.5 size-5 shrink-0 accent-primary"
              checked={decision === o.id}
              onChange={() => onChange({ decision: o.id, note })}
            />
            <span className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-center gap-1.5 text-body-md font-semibold">
                {t(o.title)}
                {advice?.decision === o.id && (
                  <span className="flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-label-sm text-white" data-testid={`ruling-recommended-${d.commentId}`}>
                    <Star className="size-3" aria-hidden />
                    {t("answers.recommended")}
                  </span>
                )}
              </span>
              <span className="break-words text-body-sm text-on-surface-variant">
                <Inline text={o.detail} />
              </span>
              {advice?.decision === o.id && (
                <span className="break-words text-body-sm text-on-surface">
                  {t("design.adviceReason", { reason: advice.reason })}
                  {o.id === "custom" && advice.note !== "" && <> — <Inline text={advice.note} /></>}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>
      {decision === "custom" && (
        <label className="flex flex-col gap-1">
          <span className="text-body-sm font-semibold">{t("design.customHelp")}</span>
          <Textarea rows={3} value={note} onChange={(e) => onChange({ decision, note: e.target.value })} placeholder={t("design.customPlaceholder")} />
        </label>
      )}
    </fieldset>
  );
}

function RulingPanel({ ticketKey, v, version, labelOf }: { ticketKey: string; v: DesignResponse; version: number; labelOf: (id: string) => string }) {
  const [draft, setDraft] = useState<RulingDraft>({});
  // WebMCP draft (task 18): fills the ruling form only for disagreements that exist; the developer presses Finalize
  useDraft("ruling", ticketKey, (dr) =>
    setDraft((prev) => ({
      ...prev,
      ...Object.fromEntries(dr.rulings.filter((r) => v.disagreements.some((d) => d.commentId === r.commentId)).map((r) => [r.commentId, { decision: r.decision, note: r.note }])),
    })),
  );
  const rule = useAction(api.rule);
  const rechoose = useAction(api.rechoose);
  // nothing picked yet: the arbiter's recommendation is pre-selected (a custom one with its note); the developer may change any
  const full: RulingDraft = Object.fromEntries(
    v.disagreements.map((d) => {
      const a = v.advice.find((x) => x.commentId === d.commentId);
      return [d.commentId, draft[d.commentId] ?? (a ? { decision: a.decision, note: a.note } : { note: "" })];
    }),
  );
  const valid = rulingDraftValid(v.disagreements, full);
  const missingLabels = valid.missing.map((id) => {
    const d = v.disagreements.find((x) => x.commentId === id);
    return d ? `${labelOf(d.checklistItem)} (${id})` : id;
  });
  return (
    <DecisionCard
      title={t("design.rulingTitle")}
      subtitle={t("design.rulingSubtitle", { n: currentRound(v.rounds) })}
      primary={{
        label: t("design.finalize"),
        thisWill: t("design.finalizeThisWill", { what: finalizeCaption(full, version) }),
        disabled: !valid.ok,
        pending: rule.pending,
        onClick: () => {
          if (!valid.ok) return;
          void rule.run(ticketKey, rulingsPayload(v.disagreements, full));
        },
      }}
      secondary={{
        label: t("design.rechoose"),
        barLabel: t("design.rechooseShort"),
        thisWill: t("design.rechooseThisWill"),
        pending: rechoose.pending,
        onClick: () => {
          if (window.confirm(t("design.rechooseConfirm"))) void rechoose.run(ticketKey);
        },
      }}
      hint={valid.ok ? undefined : t("design.rulingMissing", { ids: missingLabels.join(", ") })}
      error={rule.error ?? rechoose.error}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-headline-sm">{t("design.ruling")}</span>
        <span className="font-mono text-code-sm text-on-secondary-fixed-variant">{t("design.rulingCount", { n: valid.missing.length })}</span>
      </span>
      {v.disagreements.map((d, i) => (
        <RulingCard
          key={d.commentId}
          i={i}
          d={d}
          label={labelOf(d.checklistItem)}
          value={full[d.commentId]}
          advice={v.advice.find((a) => a.commentId === d.commentId)}
          onChange={(next) => setDraft((x) => ({ ...x, [d.commentId]: next }))}
        />
      ))}
    </DecisionCard>
  );
}

// ---------------------------------------------------------------- tab

function Design({ d, v }: { d: TicketDetail; v: DesignResponse }) {
  const key = d.ticket.key;
  const state = d.ticket.state;
  const [picked, setPicked] = useState<number | null>(null);
  if (v.choiceId === null) return <Empty>{t("design.noChoice")}</Empty>;
  const latest = v.docs.at(-1)?.version;
  const version = picked !== null && v.docs.some((x) => x.version === picked) ? picked : latest;
  const awaiting = state === "awaiting_debate_ruling" && v.disagreements.length > 0;
  const designing = state === "designing";
  const round = currentRound(v.rounds);
  const docMeta = v.docs.find((x) => x.version === version) ?? null;
  const groups = checklistPanel(v.checklist, docMeta, v.rounds, v.rulings);
  const labels = new Map(v.checklist.map((i) => [i.id, i.label]));
  const labelOf = (id: string) => labels.get(id) ?? id;
  const final = v.docs.find((x) => x.isFinal);

  return (
    <div className="flex flex-col gap-3 p-3 max-md:min-h-[calc(100dvh-var(--header-h,4rem))] max-md:bg-surface-container-low max-lg:pb-16 lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-4 lg:p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:col-span-2" data-testid="design-strip">
        <span className="text-label-sm font-semibold uppercase tracking-[0.05em] text-on-surface-variant">{t("design.targets")}:</span>
        {v.affectedRepos.map((r) => (
          <span key={r} className="rounded bg-surface-container px-2 py-0.5 font-mono text-code-md text-on-surface">
            {r}
          </span>
        ))}
        {round > 0 && (
          <span className={cn("rounded px-2 py-0.5 font-mono text-code-sm md:ml-auto", awaiting ? "bg-secondary-fixed text-on-secondary-fixed-variant" : "bg-surface-container text-on-surface-variant")}>
            {t("design.round", { n: round, max: v.maxRounds })}
            {awaiting && round >= v.maxRounds ? ` · ${t("design.roundLimit")}` : ""}
          </span>
        )}
      </div>
      {final && state !== "designing" && state !== "awaiting_debate_ruling" && (
        <p className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-body-md text-emerald-800 lg:col-span-2">{t("design.finalBanner", { v: final.version })}</p>
      )}
      {(state === "awaiting_choice" || state === "proposing") && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-1 text-body-md text-amber-900 lg:col-span-2" data-testid="design-previous-choice">
          <span className="min-w-0 py-1.5">{t("design.previousChoice")}</span>
          <Link to={`/tickets/${key}/solutions`} className="flex min-h-11 items-center font-semibold text-primary hover:underline md:min-h-8">
            {t("design.toSolutions")}
          </Link>
        </div>
      )}
      {designing && <p className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-body-md text-blue-800 lg:col-span-2">{t("design.working")}</p>}
      <div className="flex min-w-0 flex-col gap-3 max-lg:contents lg:gap-4">
        <div className="order-1 min-w-0 lg:order-none">
          {version === undefined ? (
            <Card className="flex flex-col gap-3 p-3 max-md:rounded-lg max-md:border-0">
              <p className="text-body-md text-slate-600">{t("design.noDoc")}</p>
              <LiveLog ticketKey={key} roles={ROLES} />
            </Card>
          ) : (
            <DocumentCard ticketKey={key} v={v} version={version} onVersion={setPicked} />
          )}
        </div>
        <div className="order-3 min-w-0 lg:order-none">
          <Timeline v={v} labelOf={labelOf} live={designing && version !== undefined} ticketKey={key} />
        </div>
      </div>
      {/* the right column: in view while the main column scrolls (desktop) */}
      <div className={cn("flex min-w-0 flex-col gap-3 max-lg:contents lg:gap-4", STICKY_RAIL)}>
        {awaiting && version !== undefined && (
          <div className="order-4 min-w-0 lg:order-none">
            <RulingPanel ticketKey={key} v={v} version={latest ?? version} labelOf={labelOf} />
          </div>
        )}
        <div className="order-2 min-w-0 lg:order-none">
          <ChecklistCard groups={groups} error={v.checklistError} />
        </div>
      </div>
    </div>
  );
}

export function DesignTab({ d }: { d: TicketDetail }) {
  const view = useApi<DesignResponse>(paths.design(d.ticket.key));
  return <AsyncView state={view}>{(v) => <Design d={d} v={v} />}</AsyncView>;
}
