import { CheckCircle2, Lock, PenLine, Sparkles, Star, TriangleAlert, XCircle } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Empty } from "../../components/AsyncView.tsx";
import { DecisionCard } from "../../components/DecisionCard.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Textarea } from "../../components/ui/input.tsx";
import { t } from "../../i18n/en.ts";
import { api, paths, type Config, type PreferenceState, type RequirementRecord, type SolutionRecord, type Status, type TicketDetail } from "../../lib/api.ts";
import { preferenceHint } from "../../lib/preferences-model.ts";
import { affectedDraft, reposCaption } from "../../lib/debate-model.ts";
import { useAction, useApi } from "../../lib/hooks.ts";
import { cn, STICKY_RAIL } from "../../lib/utils.ts";

const LETTERS = "ABCDE";

/** Phase 4d (§9.4): one line from the preference summary above the cards; "Edit" on this computer only. */
function PreferenceHint() {
  const prefs = useApi<PreferenceState>(paths.preferences);
  const status = useApi<Status>(paths.status);
  const hint = prefs.data ? preferenceHint(prefs.data) : null;
  if (hint === null) return null;
  return (
    <div data-testid="preference-hint" className="flex min-w-0 items-start gap-2 rounded border border-slate-200 bg-surface-container-low px-3 py-2 text-body-sm text-on-surface-variant">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{hint}</span>
      {status.data?.local === true && (
        <Link to="/settings#preferences" className="-my-2 flex min-h-11 shrink-0 items-center text-label-md text-primary md:min-h-0 md:my-0">
          {t("prefs.edit")}
        </Link>
      )}
    </div>
  );
}

/** Multi-repo projects: the solution's repositories and what changes in each (05 / m04). */
function RepoChanges({ s }: { s: SolutionRecord }) {
  const c = s.content;
  if (c.affectedRepos.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="solution-repos">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">{t("sol.repos")}</span>
        {c.affectedRepos.map((r) => (
          <span key={r} className="rounded bg-surface-container px-1.5 py-0.5 font-mono text-code-sm text-on-surface">
            {r}
          </span>
        ))}
      </span>
      {c.repoChanges.length > 0 && (
        <ul className="flex flex-col gap-1 rounded border border-slate-200 bg-slate-50 p-2 max-md:border-0 max-md:bg-surface-container-low">
          {c.repoChanges.map((rc) => (
            <li key={rc.repo} className="flex min-w-0 gap-2 text-body-sm">
              <span className="shrink-0 font-mono text-code-sm font-semibold text-primary">{rc.repo}</span>
              <span className="min-w-0 break-words text-on-surface-variant">{rc.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The affected-repositories picker shown once a solution is selected (multi-repo projects only). */
function RepoPicker({ mapped, proposed, repos, edited, error, onChange }: { mapped: string[]; proposed: string[]; repos: string[]; edited: boolean; error: string | null; onChange: (next: string[]) => void }) {
  return (
    <Card className="flex flex-col gap-2 p-3 max-md:rounded-lg max-md:border-0 max-md:shadow-[0_1px_3px_rgba(15,23,42,0.08)]" data-testid="repo-picker">
      <span className="flex flex-wrap items-center gap-2 text-headline-sm">
        {t("sol.reposTitle")}
        {edited && <Badge tone="decision">{t("sol.reposEdited")}</Badge>}
      </span>
      <span className="text-body-sm text-slate-500">{t("sol.reposHelp")}</span>
      <ul className="flex flex-col divide-y divide-slate-100 rounded border border-slate-200 max-md:border-0 max-md:bg-surface-container-low">
        {mapped.map((r) => (
          <li key={r}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-primary"
                checked={repos.includes(r)}
                onChange={(e) => onChange(e.target.checked ? [...repos, r] : repos.filter((x) => x !== r))}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-code-md">{r}</span>
              {proposed.includes(r) && <span className="shrink-0 text-body-sm text-slate-500">{t("sol.reposProposed")}</span>}
            </label>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-body-sm text-rose-600">
          {error}
        </p>
      )}
    </Card>
  );
}
const COMPLEXITY_TONE = { S: "done", M: "info", L: "decision" } as const;

function Section({ title, tone, items, icon }: { title: string; tone: string; items: string[]; icon: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={cn("text-label-sm font-semibold uppercase tracking-[0.05em]", tone)}>{title}</span>
      {items.length === 0 ? (
        <span className="text-body-sm text-slate-400">{t("sol.none")}</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((x, i) => (
            <li key={i} className="flex gap-1.5 text-body-md">
              <span className={cn("mt-0.5 shrink-0", tone)}>{icon}</span>
              {x}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SolutionCard({ s, letter, selected, chosen, selectable, onSelect, multiRepo }: { s: SolutionRecord; letter: string; selected: boolean; chosen: boolean; selectable: boolean; onSelect: () => void; multiRepo: boolean }) {
  const c = s.content;
  return (
    <Card className={cn("flex flex-col gap-3 p-3", selected && "border-2 border-primary-container")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={selected ? "info" : "muted"}>{t("sol.option", { l: letter })}</Badge>
        <Badge tone={COMPLEXITY_TONE[c.complexity]}>{t("sol.complexity", { c: c.complexity })}</Badge>
        {chosen && <Badge tone="done">✓ {t("sol.selected")}</Badge>}
        {c.recommended && (
          <Badge tone="info">
            <Star className="size-3" aria-hidden /> {t("answers.recommended")}
          </Badge>
        )}
      </div>
      <h3 className="break-words text-headline-md">{c.title}</h3>
      {c.recommended && c.recommendationReason && (
        <p className="break-words rounded bg-primary-fixed/40 px-2 py-1 text-body-sm text-on-surface" data-testid="recommendation-reason">
          {t("sol.whyRecommended", { reason: c.recommendationReason })}
        </p>
      )}
      {selectable && (
        <label className={cn("flex min-h-11 w-full cursor-pointer items-center justify-center gap-1.5 rounded border px-2 py-1 text-label-md md:min-h-0 md:w-fit md:justify-start", selected ? "border-primary bg-primary text-white" : "border-slate-200")}>
          <input type="radio" name="solution" checked={selected} onChange={onSelect} className="accent-white" aria-label={t("sol.option", { l: letter })} />
          {selected ? t("sol.selected") : t("sol.select")}
        </label>
      )}
      <p className="text-body-md leading-6 text-slate-700">{c.approach}</p>
      {multiRepo && <RepoChanges s={s} />}
      <div className="flex flex-col gap-1">
        <span className="text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">{t("sol.scope", { n: c.changeScope.length })}</span>
        <ul className="rounded border border-slate-200 bg-slate-50 p-2 font-mono text-code-md">
          {c.changeScope.map((x, i) => (
            <li key={i} className="truncate" title={x}>
              • {x}
            </li>
          ))}
        </ul>
      </div>
      <Section title={t("sol.pros")} tone="text-emerald-700" items={c.pros} icon={<CheckCircle2 className="size-3.5" />} />
      <Section title={t("sol.cons")} tone="text-rose-600" items={c.cons} icon={<XCircle className="size-3.5" />} />
      <Section title={t("sol.risks")} tone="text-amber-700" items={c.risks} icon={<TriangleAlert className="size-3.5" />} />
    </Card>
  );
}

const COMPLEXITY_WORD = { S: "sol.low", M: "sol.medium", L: "sol.high" } as const;
const COMPLEXITY_CHIP = { S: "bg-emerald-100 text-emerald-800", M: "bg-surface-container-high text-on-surface", L: "bg-secondary-fixed text-on-secondary-fixed-variant" } as const;

function Collapsible({ title, items, tone, box, mark }: { title: string; items: string[]; tone: string; box: string; mark: string }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, 2);
  return (
    <div className={cn("flex flex-col gap-1 rounded p-2.5", box)}>
      <span className={cn("text-label-md font-semibold uppercase tracking-[0.05em]", tone)}>{title}</span>
      <ul className="flex flex-col gap-1">
        {shown.map((x, i) => (
          <li key={i} className="flex gap-1.5 text-body-md">
            <span className={cn("shrink-0", tone)}>{mark}</span>
            <span className="min-w-0">{x}</span>
          </li>
        ))}
      </ul>
      {items.length > 2 && (
        <button className="min-h-9 self-start text-body-sm text-primary" onClick={() => setAll((v) => !v)}>
          {all ? t("sol.showLess") : t("sol.showAll", { n: items.length })}
        </button>
      )}
    </div>
  );
}

/** Phone solution card (Stitch m04): radio in the header, complexity/risk chips, collapsed lists. */
function PhoneSolutionCard({ s, letter, selected, chosen, selectable, onSelect, multiRepo }: { s: SolutionRecord; letter: string; selected: boolean; chosen: boolean; selectable: boolean; onSelect: () => void; multiRepo: boolean }) {
  const c = s.content;
  return (
    <article className={cn("flex flex-col gap-2.5 rounded-lg bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.08)]", selected && "bg-surface-container-low ring-2 ring-primary")}>
      <label className={cn("flex items-start gap-2", selectable && "cursor-pointer")}>
        {selectable && (
          <span className="-m-2 flex size-11 shrink-0 items-center justify-center">
            <input type="radio" name="solution-phone" className="size-5 accent-primary" checked={selected} onChange={onSelect} aria-label={t("sol.option", { l: letter })} />
          </span>
        )}
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="break-words text-headline-md">
            {t("sol.option", { l: letter })}: {c.title}
          </span>
          <span className="flex flex-wrap gap-1.5">
            <span className={cn("rounded px-1.5 py-0.5 font-mono text-code-sm", COMPLEXITY_CHIP[c.complexity])}>{t("sol.complexityChip", { c: t(COMPLEXITY_WORD[c.complexity]) })}</span>
            <span className={cn("rounded px-1.5 py-0.5 font-mono text-code-sm", c.risks.length ? "bg-secondary-fixed text-on-secondary-fixed-variant" : "bg-emerald-100 text-emerald-800")}>{t("sol.risksChip", { n: c.risks.length })}</span>
            {chosen && <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-code-sm text-emerald-800">✓ {t("sol.selected")}</span>}
            {c.recommended && <span className="flex items-center gap-1 rounded bg-primary px-1.5 py-0.5 font-mono text-code-sm text-white"><Star className="size-3" aria-hidden />{t("answers.recommended")}</span>}
          </span>
        </span>
      </label>
      <p className="text-body-md text-on-surface-variant">{c.approach}</p>
      {multiRepo && <RepoChanges s={s} />}
      {c.changeScope.length > 0 && <p className="break-all font-mono text-code-sm text-on-surface-variant">{c.changeScope.join(" · ")}</p>}
      <Collapsible title={t("sol.pros")} items={c.pros} tone="text-emerald-700" box="bg-surface-container-low" mark="✓" />
      <Collapsible title={t("sol.cons")} items={c.cons} tone="text-secondary" box="bg-surface-container-low" mark="–" />
      <Collapsible title={t("sol.risks")} items={c.risks} tone="text-rose-700" box="bg-rose-50/60" mark="!" />
    </article>
  );
}

export function SolutionsTab({ d }: { d: TicketDetail }) {
  const navigate = useNavigate();
  const key = d.ticket.key;
  const versions = useApi<RequirementRecord[]>(paths.requirements(key));
  const config = useApi<Config>(paths.config);
  const [pick, setPick] = useState<number | null>(null);
  const [pickedRepos, setPickedRepos] = useState<string[] | null>(null);
  const [note, setNote] = useState("");
  const [skipDebate, setSkipDebate] = useState(false);
  const choose = useAction(api.choose);
  const select = (id: number) => {
    setPick(id);
    setPickedRepos(null); // a different solution starts from its own proposed repos
  };
  const mapped = config.data?.projects[key.split("-")[0] ?? ""]?.repos.map((r) => r.name) ?? [];
  const multiRepo = mapped.length > 1;

  // Only the latest proposal batch (one per requirement version).
  const latestReq = d.solutions.reduce((m, s) => Math.max(m, s.requirementId), -1);
  const batch = d.solutions.filter((s) => s.requirementId === latestReq).sort((a, b) => a.idx - b.idx);
  const reqVersion = versions.data?.find((v) => v.id === latestReq)?.version;
  const awaiting = d.ticket.state === "awaiting_choice";
  const chosenId = d.choice?.solutionId ?? null;

  if (batch.length === 0) {
    return <Empty>{d.ticket.state === "proposing" ? t("sol.proposing") : t("sol.empty")}</Empty>;
  }
  // nothing picked yet: the recommended option is selected (the developer can pick any other)
  const recommendedId = batch.find((s) => s.content.recommended)?.id ?? null;
  const selected = batch.find((s) => s.id === (pick ?? (awaiting ? recommendedId : null)));
  const chosen = batch.find((s) => s.id === chosenId);
  const draft = selected && multiRepo ? affectedDraft(selected.content, mapped, pickedRepos) : null;
  const picker = selected && draft && (
    <RepoPicker mapped={mapped} proposed={selected.content.affectedRepos} repos={draft.repos} edited={draft.edited} error={draft.error} onChange={setPickedRepos} />
  );
  const confirmBase = draft ? reposCaption(draft.repos, draft.edited) : t("sol.confirmThisWill");
  const confirmThisWill = skipDebate ? `${confirmBase} ${t("sol.skipDebateNote")}` : confirmBase;
  // the picker needs the project's repos: never choose without it (the server would silently use the proposal)
  const configBlocker = config.data ? null : config.error ? t("sol.reposConfigError", { error: config.error.message }) : t("sol.reposLoading");

  return (
    <div className="flex flex-col gap-4 p-4 max-md:min-h-[calc(100dvh-var(--header-h,4rem))] max-md:gap-3 max-md:bg-surface-container-low max-md:px-3 lg:grid lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-3">
        {reqVersion !== undefined && (
          <span className="flex items-center gap-1.5 font-mono text-code-sm text-on-surface-variant md:hidden">
            <CheckCircle2 className="size-4 text-tertiary" />
            {t("sol.basedOnPhone", { v: reqVersion })}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-3 rounded border border-slate-200 bg-surface-container-low px-3 py-2 text-body-sm max-md:hidden">
          <span>
            {t("sol.generatedBy")}
          </span>
          {reqVersion !== undefined && (
            <span className="flex items-center gap-1 text-slate-600">
              <Lock className="size-3.5" />
              {t("sol.basedOn", { v: reqVersion })}
            </span>
          )}
        </div>
        <PreferenceHint />
        <div className="flex flex-col gap-3 md:hidden">
          {batch.map((s, i) => (
            <Fragment key={s.id}>
              <PhoneSolutionCard s={s} letter={LETTERS[i] ?? String(i + 1)} selected={awaiting ? selected?.id === s.id : chosenId === s.id} chosen={chosenId === s.id} selectable={awaiting} onSelect={() => select(s.id)} multiRepo={multiRepo} />
              {/* phones: the picker sits right under the selected solution */}
              {awaiting && selected?.id === s.id && picker}
            </Fragment>
          ))}
        </div>
        <div className="hidden grid-cols-1 items-start gap-3 md:grid md:grid-cols-[repeat(auto-fit,minmax(240px,1fr))]">
          {batch.map((s, i) => (
            <SolutionCard key={s.id} s={s} letter={LETTERS[i] ?? String(i + 1)} selected={awaiting ? selected?.id === s.id : chosenId === s.id} chosen={chosenId === s.id} selectable={awaiting} onSelect={() => select(s.id)} multiRepo={multiRepo} />
          ))}
        </div>
        {awaiting && picker && <div className="max-md:hidden">{picker}</div>}
        {awaiting && (
          <Card className="flex flex-col gap-1.5 p-3 max-md:rounded-lg max-md:border-0 max-md:shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
            <span className="flex items-center gap-1.5 text-headline-sm">
              <PenLine className="size-4" />
              {t("sol.note")}
            </span>
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("sol.notePlaceholder")} className="font-mono text-code-md" />
            <span className="text-body-sm text-slate-500">{t("sol.noteHelp")}</span>
            <label className="mt-1 flex min-h-11 cursor-pointer items-start gap-2 md:min-h-0">
              <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={skipDebate} onChange={(e) => setSkipDebate(e.target.checked)} data-testid="skip-debate" />
              <span className="flex flex-col">
                <span className="text-body-md font-semibold">{t("sol.skipDebate")}</span>
                <span className="text-body-sm text-slate-500">{t("sol.skipDebateHelp")}</span>
              </span>
            </label>
          </Card>
        )}
      </div>
      <aside className={cn("order-first flex flex-col gap-3 empty:hidden lg:order-none", STICKY_RAIL)}>
        {awaiting && (
          <DecisionCard
            title={t("sol.choose")}
            subtitle={selected ? `${t("sol.option", { l: LETTERS[batch.indexOf(selected)] ?? "" })}: ${selected.content.title}` : t("sol.pickFirst")}
            primary={{
              label: t("sol.confirm"),
              barLabel: selected ? t("sol.chooseOption", { l: LETTERS[batch.indexOf(selected)] ?? "" }) : t("sol.chooseAnOption"),
              thisWill: confirmThisWill,
              disabled: !selected || draft?.error != null || configBlocker !== null,
              pending: choose.pending,
              onClick: () => selected && !draft?.error && !configBlocker && void choose.run(key, selected.id, note, draft ? draft.repos : undefined, skipDebate),
            }}
            barSecondary={{ label: t("sol.backToRequirements"), onClick: () => navigate(`/tickets/${key}/requirements`) }}
            phoneCard={false}
            hint={selected && config.data === undefined && !config.error ? (configBlocker ?? undefined) : undefined}
            error={choose.error ?? (config.error ? (configBlocker ?? undefined) : undefined)}
          />
        )}
        {!awaiting && chosen && d.choice && (
          <Card className="flex flex-col gap-1 p-3 text-body-md">
            <span className="font-semibold text-emerald-700">{t("sol.chosen", { title: chosen.content.title })}</span>
            {d.choice.affectedRepos && d.choice.affectedRepos.length > 0 && <span className="font-mono text-code-sm text-slate-600">{t("sol.chosenRepos", { repos: d.choice.affectedRepos.join(", ") })}</span>}
            {d.choice.note && <span className="text-slate-600">{t("sol.chosenNote", { note: d.choice.note })}</span>}
            {d.choice.skipDebate && <span className="text-slate-600">{t("sol.chosenSkipDebate")}</span>}
          </Card>
        )}
      </aside>
    </div>
  );
}
