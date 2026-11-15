import { AlertTriangle, ArrowLeftRight, Ban, CheckCircle2, ChevronRight, CircleDashed, Copy, FileDiff, GitCommitHorizontal, ListChecks, Loader2, ShieldCheck, SquareTerminal, XCircle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { AsyncView, Empty, ErrorBox, Loading } from "../../components/AsyncView.tsx";
import { DecisionCard } from "../../components/DecisionCard.tsx";
import { LiveLog } from "../../components/LiveLog.tsx";
import { ThisWill } from "../../components/ThisWill.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card } from "../../components/ui/card.tsx";
import { Textarea } from "../../components/ui/input.tsx";
import { t } from "../../i18n/en.ts";
import { api, paths, type DevelopmentRepo, type DevelopmentResponse, type Status, type TicketDetail } from "../../lib/api.ts";
import {
  dirtyWorktreeHelp, hooksAcceptView, iterationView, jiraCard, jiraNote, repoViews, type HooksAcceptView, type IterationView, type JiraCard, type RepoView,
} from "../../lib/dev-model.ts";
import { useAction, useApi } from "../../lib/hooks.ts";
import { cn, STICKY_RAIL } from "../../lib/utils.ts";
import type { RepoStatus, TestRun } from "@slackoff/shared";

const ROLES = ["implement-ticket"] as const;
const card = "flex min-w-0 flex-col gap-3 p-3 max-md:rounded-lg max-md:border-0 max-md:shadow-[0_1px_3px_rgba(15,23,42,0.08)]";

const STATUS_CHIP: Record<RepoStatus, string> = {
  green: "bg-emerald-100 text-emerald-800",
  failing: "bg-rose-100 text-rose-700",
  hook_failed: "bg-rose-100 text-rose-700",
  not_run: "bg-slate-200 text-slate-700",
  working: "bg-blue-100 text-blue-800",
};

/** The server's per-repo status, rendered as is (P-C18). */
function StatusChip({ status, className }: { status: RepoStatus; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 font-mono text-code-sm", STATUS_CHIP[status], className)} data-testid="repo-status">
      {status === "working" ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <span className="size-1.5 rounded-full bg-current" />}
      {t(`dev.status.${status}`)}
    </span>
  );
}

function Fold({ title, right, open, children }: { title: ReactNode; right?: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="group min-w-0 rounded bg-surface-container-low">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 text-on-surface-variant transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
        {right && <span className="shrink-0 font-mono text-code-sm text-on-surface-variant">{right}</span>}
      </summary>
      <div className="min-w-0 px-3 pb-3">{children}</div>
    </details>
  );
}

/** Command output / diff text: always text, never HTML (Task 13). */
function Pre({ text, className }: { text: string; className?: string }) {
  return <pre className={cn("max-h-72 min-w-0 overflow-auto whitespace-pre rounded bg-slate-900 p-2 font-mono text-code-sm text-slate-100", className)}>{text}</pre>;
}

function CopyRow({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  const canCopy = value !== null && typeof navigator !== "undefined" && navigator.clipboard !== undefined;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded bg-surface-container-low px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-label-sm uppercase tracking-[0.05em] text-on-surface-variant">{label}</span>
        <span className={cn("min-w-0 [overflow-wrap:anywhere] font-mono text-code-md", value === null ? "italic text-slate-500" : "text-on-surface")}>{value ?? t("dev.notCreated")}</span>
      </div>
      {canCopy && (
        <button
          className="flex size-11 shrink-0 items-center justify-center rounded text-on-surface-variant hover:bg-surface-container md:size-8"
          aria-label={copied ? t("dev.copied") : t("dev.copy", { what: label })}
          title={copied ? t("dev.copied") : t("dev.copy", { what: label })}
          onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
        >
          {copied ? <CheckCircle2 className="size-4 text-emerald-700" /> : <Copy className="size-4" />}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- one repository

function TestRow({ run }: { run: TestRun }) {
  const ok = !run.timedOut && run.exitCode === 0;
  const label = run.timedOut ? t("dev.testTimedOut") : ok ? t("dev.testPassed") : t("dev.testFailed", { code: run.exitCode ?? "?" });
  return (
    <li className={cn("flex min-w-0 flex-col gap-1.5 rounded px-3 py-2", ok ? "bg-surface-container-low" : "bg-rose-50")}>
      <span className="flex min-w-0 items-center gap-2">
        {ok ? <CheckCircle2 className="size-5 shrink-0 text-emerald-700" aria-hidden /> : <XCircle className="size-5 shrink-0 text-rose-600" aria-hidden />}
        <span className={cn("min-w-0 flex-1 [overflow-wrap:anywhere] font-mono text-code-md", !ok && "text-rose-700")}>{run.command}</span>
        <span className={cn("shrink-0 font-mono text-code-sm", ok ? "text-emerald-700" : "text-rose-700")}>{label}</span>
      </span>
      {run.outputTail && !ok && <Pre text={run.outputTail} />}
      {run.outputTail && ok && (
        <details className="min-w-0">
          <summary className="flex min-h-11 cursor-pointer items-center text-body-sm text-on-surface-variant md:min-h-6">{t("dev.output")}</summary>
          <Pre text={run.outputTail} />
        </details>
      )}
    </li>
  );
}

function Checks({ r, v }: { r: DevelopmentRepo; v: RepoView }) {
  const hook = v.lastHook;
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label={t("dev.checks")}>
      <span className="flex items-center gap-2 text-headline-sm">
        <ListChecks className="size-5 text-primary" aria-hidden />
        {t("dev.checks")}
      </span>
      {v.lastTests.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {v.lastTests.map((run, i) => (
            <TestRow key={i} run={run} />
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 rounded bg-surface-container-low px-3 py-2 font-mono text-code-md text-on-surface-variant">
          <CircleDashed className="size-4 shrink-0" aria-hidden />
          {r.commands.test ? t("dev.notRunYet") : t("dev.notRunNoCommand")}
        </p>
      )}
      {hook?.kind === "hook_failed" && (
        <div className="flex min-w-0 flex-col gap-1.5 rounded bg-secondary-fixed/50 px-3 py-2 text-body-md text-on-secondary-fixed-variant">
          <span className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {hook.timedOut ? t("dev.hookTimedOut") : t("dev.hookFailed")}
          </span>
          {hook.outputTail && <Pre text={hook.outputTail} />}
        </div>
      )}
      {hook?.kind === "committed" && hook.hookOutput && (
        <details className="min-w-0" data-testid="hook-output">
          <summary className="flex min-h-11 cursor-pointer items-center text-body-sm text-on-surface-variant md:min-h-6">{t("dev.hookOutput")}</summary>
          <Pre text={hook.hookOutput} />
        </details>
      )}
      {hook?.kind === "skipped_checks_failed" && <p className="rounded bg-rose-50 px-3 py-2 text-body-sm text-rose-800">{t("dev.skippedChecks")}</p>}
      {r.pendingChanges && <p className="rounded bg-surface-container-low px-3 py-2 text-body-sm text-on-surface-variant">{t("dev.pending")}</p>}
      {r.checkOutputs.length > 0 && <p className="break-words rounded bg-surface-container-low px-3 py-2 font-mono text-code-sm text-on-surface-variant">{t("dev.checkOutputs", { files: r.checkOutputs.join(", ") })}</p>}
    </section>
  );
}

function RulesBlock({ r }: { r: DevelopmentRepo }) {
  const cmds = Object.entries(r.commands).filter(([, v]) => v);
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded border border-slate-200 p-3" aria-label={t("dev.rules")} data-testid="repo-rules">
      <span className="flex items-center gap-2 text-headline-sm">
        <ShieldCheck className="size-5 text-primary" aria-hidden />
        {t("dev.rules")}
      </span>
      {r.rulesError ? (
        <p className="break-words rounded bg-rose-50 px-2 py-1.5 text-body-sm text-rose-800">{t("dev.rulesError", { error: r.rulesError })}</p>
      ) : r.rulesFound ? (
        <p className="break-words font-mono text-code-md">{t("dev.rulesFound", { base: r.baseBranch })}</p>
      ) : (
        <p className="break-words text-body-md text-on-surface-variant">{t("dev.rulesMissing", { base: r.baseBranch })}</p>
      )}
      {r.rulesFound && (
        <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-body-sm md:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-on-surface-variant">{t("dev.commands")}</dt>
          <dd className="min-w-0 break-words font-mono text-code-sm">{cmds.length === 0 ? t("dev.noCommands") : cmds.map(([k, v]) => `${k}: ${v}`).join(" · ")}</dd>
          <dt className="text-on-surface-variant">{t("dev.forbidden")}</dt>
          <dd className="min-w-0 break-words font-mono text-code-sm">{[...r.forbiddenPaths, t("dev.forbiddenBase")].join(" · ")}</dd>
        </dl>
      )}
      <p className={cn("text-body-sm", r.hooks?.configured && !r.hooks.installed ? "text-rose-700" : "text-on-surface-variant")}>
        {r.hooks?.configured ? (r.hooks.installed ? t("dev.hooksInstalled") : t("dev.hooksMissing")) : t("dev.hooksNone")}
      </p>
      {r.install && (
        <p className="break-words font-mono text-code-sm text-on-surface-variant">
          {r.install.run.timedOut ? t("dev.installTimedOut", { command: r.install.run.command }) : t("dev.install", { command: r.install.run.command, code: r.install.run.exitCode ?? "?" })}
        </p>
      )}
    </section>
  );
}

function DiffPanel({ ticketKey, repo }: { ticketKey: string; repo: string }) {
  const [state, setState] = useState<{ loading: boolean; text?: string; truncated?: boolean; error?: string } | null>(null);
  const open = state !== null;
  const load = () => {
    setState({ loading: true });
    api.diff(ticketKey, repo).then(
      (d) => setState({ loading: false, text: d.text, truncated: d.truncated }),
      (e: unknown) => setState({ loading: false, error: e instanceof Error ? e.message : String(e) }),
    );
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Button className="w-fit" aria-expanded={open} onClick={() => (open ? setState(null) : load())}>
        <FileDiff className="size-4" aria-hidden />
        {open ? t("dev.hideDiff") : t("dev.openDiff")}
      </Button>
      {state?.loading && <Loading />}
      {state?.error && <ErrorBox error={state.error} onRetry={load} />}
      {state?.text !== undefined && (
        <>
          {state.truncated && <p className="rounded bg-amber-50 px-2 py-1.5 text-body-sm text-amber-800">{t("dev.diffTruncated")}</p>}
          {state.text === "" ? (
            <p className="text-body-sm text-on-surface-variant">{t("dev.diffEmpty")}</p>
          ) : (
            <pre className="max-h-[28rem] min-w-0 overflow-auto rounded border border-slate-200 bg-white font-mono text-code-sm" data-testid="repo-diff">
              {state.text.split("\n").map((l, i) => (
                <span
                  key={i}
                  className={cn(
                    "block w-max min-w-full whitespace-pre px-2",
                    l.startsWith("+") && !l.startsWith("+++") && "bg-emerald-50 text-emerald-900",
                    l.startsWith("-") && !l.startsWith("---") && "bg-rose-50 text-rose-900",
                    (l.startsWith("diff ") || l.startsWith("@@")) && "bg-slate-100 text-slate-600",
                  )}
                >
                  {l || " "}
                </span>
              ))}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function RepoSection({ ticketKey, r, v, hidden, picker }: { ticketKey: string; r: DevelopmentRepo; v: RepoView; hidden: boolean; picker: boolean }) {
  return (
    <Card className={cn(card, hidden && "max-lg:hidden")} data-testid={`dev-repo-${r.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        {/* below lg the repo picker already shows the name and status */}
        <span className={cn("rounded bg-surface-container px-2 py-0.5 font-mono text-headline-sm text-on-surface", picker && "max-lg:hidden")}>{r.name}</span>
        <StatusChip status={v.status} className={cn(picker && "max-lg:hidden")} />
        {r.diffStat && <span className="font-mono text-code-sm text-on-surface-variant">{t("dev.diffStat", { ins: r.diffStat.insertions, del: r.diffStat.deletions, files: r.diffStat.files })}</span>}
      </div>
      <section className="flex min-w-0 flex-col gap-2" aria-label={t("dev.workspace")}>
        <span className="flex items-center gap-2 text-headline-sm">
          <SquareTerminal className="size-5 text-primary" aria-hidden />
          {t("dev.workspace")}
        </span>
        <CopyRow label={t("dev.branch")} value={r.branch} />
        <CopyRow label={t("dev.worktree")} value={r.worktreePath} />
        <CopyRow label={t("dev.baseBranch")} value={r.baseBranch || null} />
        {v.notes.map((n) => (
          <p key={n} className="flex items-start gap-2 break-words rounded bg-amber-50 px-3 py-2 text-body-sm text-amber-900" data-testid="repo-note">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {n}
          </p>
        ))}
      </section>
      <section className="flex min-w-0 flex-col gap-2" aria-label={t("dev.commits")}>
        <span className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-headline-sm">
            <GitCommitHorizontal className="size-5 text-primary" aria-hidden />
            {t("dev.commits")}
          </span>
          {v.commits.length > 0 && <span className="rounded-full bg-primary-fixed px-2 font-mono text-code-sm text-on-primary-fixed-variant">{t("dev.commitsLocal", { n: v.commits.length })}</span>}
        </span>
        {v.commits.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">{t("dev.noCommits")}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {v.commits.map((c) => (
              <li key={c.sha7} className="flex min-w-0 items-start gap-2">
                <span className="shrink-0 rounded bg-surface-container px-1 font-mono text-code-md text-primary">{c.sha7}</span>
                <span className="min-w-0 break-words text-body-md">{c.subject}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Checks r={r} v={v} />
      {v.violations.length > 0 && (
        <section className="flex min-w-0 flex-col gap-1.5 rounded border border-rose-200 bg-rose-50/60 p-3" aria-label={t("dev.violations")}>
          <span className="flex items-center justify-between gap-2 text-headline-sm text-rose-800">
            <span className="flex items-center gap-2">
              <Ban className="size-5" aria-hidden />
              {t("dev.violations")}
            </span>
            <span className="font-mono text-code-sm">{t("dev.violationsCount", { n: v.violations.length })}</span>
          </span>
          <ul className="flex flex-col gap-1">
            {v.violations.map((p, i) => (
              <li key={i} className="break-words text-body-sm text-rose-900">
                {t("dev.violationBefore")}
                <code className="font-mono text-code-sm [overflow-wrap:anywhere]">{p}</code>
                {t("dev.violationAfter")}
              </li>
            ))}
          </ul>
        </section>
      )}
      <RulesBlock r={r} />
      {r.worktreePath && <DiffPanel key={r.name} ticketKey={ticketKey} repo={r.name} />}
    </Card>
  );
}

// ---------------------------------------------------------------- iterations

const CHIP = "rounded px-1.5 py-0.5 font-mono text-code-sm";
const testsTone: Record<IterationView["tests"], string> = { passed: "bg-emerald-50 text-emerald-700", failed: "bg-rose-50 text-rose-700", not_run: "bg-slate-100 text-slate-600" };
const hookTone: Record<IterationView["hook"], string> = { passed: "bg-emerald-50 text-emerald-700", failed: "bg-rose-50 text-rose-700", timed_out: "bg-rose-50 text-rose-700", none: "bg-slate-100 text-slate-600" };

function Iterations({ dev, selected }: { dev: DevelopmentResponse; selected: string }) {
  const list = [...dev.iterations].reverse();
  return (
    <Card className={card} data-testid="dev-iterations">
      <span className="text-headline-md">{t("dev.iterations")}</span>
      {list.length === 0 && <p className="text-body-sm text-on-surface-variant">{t("dev.noIterations")}</p>}
      {list.map((it, i) => {
        const views = dev.repos.map((r) => ({ name: r.name, v: iterationView(it, r.name) }));
        return (
          <Fold
            key={it.id}
            open={i === 0}
            title={views[0]?.v.title ?? t("dev.iterationTitle", { n: it.iteration, trigger: t(`dev.trigger.${it.trigger}`) })}
            right={`${t(`dev.iterStatus.${it.status}`)} · ${t("dev.steps", { n: it.steps.length })}`}
          >
            <div className="flex min-w-0 flex-col gap-2">
              {it.note && <p className="break-words rounded bg-[#fff8f1] px-2 py-1 text-body-sm text-on-secondary-fixed-variant">{t("dev.yourNote", { note: it.note })}</p>}
              <ul className="flex flex-col gap-1">
                {views.map(({ name, v }) => (
                  <li key={name} className={cn("flex min-w-0 flex-wrap items-center gap-1.5", name !== selected && "max-lg:hidden")}>
                    <span className="font-mono text-code-md font-semibold">{name}</span>
                    <span className={cn(CHIP, testsTone[v.tests])}>{t(`dev.tests.${v.tests}`)}</span>
                    <span className={cn(CHIP, hookTone[v.hook])}>{t(`dev.hook.${v.hook}`)}</span>
                    {v.violations.length > 0 && <span className={cn(CHIP, "bg-rose-50 text-rose-700")}>{t("dev.violationsCount", { n: v.violations.length })}</span>}
                  </li>
                ))}
              </ul>
              {it.steps.length > 0 && (
                <ol className="flex flex-col gap-1 border-l-2 border-slate-200 pl-2">
                  {it.steps.map((s) => (
                    <li key={s.id} className="min-w-0 break-words text-body-sm">
                      <span className="font-mono text-code-sm text-on-surface-variant">#{s.step}</span> {s.summary}
                    </li>
                  ))}
                </ol>
              )}
              {it.summary && <p className="break-words text-body-sm text-on-surface-variant">{it.summary}</p>}
            </div>
          </Fold>
        );
      })}
    </Card>
  );
}

// ---------------------------------------------------------------- JIRA status

function JiraPanel({ ticketKey, c, note, bar }: { ticketKey: string; c: JiraCard; note: string | null; bar: boolean }) {
  const act = useAction((id: number, action: "confirm" | "skip" | "retry") => api.jiraWrite(ticketKey, id, action));
  if (c.kind === "pending") {
    const n = jiraNote(note, c.target);
    return (
      <DecisionCard
        title={t("dev.jiraTitle", { key: ticketKey, status: c.target })}
        bar={bar}
        primary={{ label: t("dev.jiraSend"), thisWill: c.thisWill, pending: act.pending, onClick: () => void act.run(c.id, "confirm") }}
        secondary={{ label: t("dev.jiraSkip"), thisWill: t("dev.jiraSkipThisWill"), pending: act.pending, onClick: () => void act.run(c.id, "skip") }}
        error={act.error}
        // T12-3: the repos-disagree note is also in the phone bar, in full, next to "Send to JIRA"
        hint={n?.text}
        hintMode="full"
      >
        <div className="flex min-w-0 flex-col gap-1 rounded bg-white px-3 py-2" data-testid="jira-target">
          <span className="text-label-sm uppercase tracking-[0.05em] text-on-surface-variant">{t("dev.jiraTarget")}</span>
          <span className="break-words text-headline-md text-on-surface">{c.target}</span>
        </div>
        {n && (
          <p className="flex items-start gap-2 break-words rounded border border-amber-300 bg-amber-50 px-3 py-2 text-body-md font-semibold text-amber-900" data-testid="jira-note">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {n.text}
          </p>
        )}
        <p className="text-body-sm text-on-surface-variant">{t("dev.jiraNeverBlocks")}</p>
      </DecisionCard>
    );
  }
  const tag = (label: string, cls: string) => <span className={cn("shrink-0 rounded px-1.5 font-mono text-code-sm", cls)}>{label}</span>;
  return (
    <Card className={card} data-testid="jira-card">
      <span className="flex items-center gap-2 text-headline-md">
        <ArrowLeftRight className="size-5 text-primary" aria-hidden />
        {t("dev.jira")}
      </span>
      {c.kind === "off" && (
        <p className="flex items-center gap-2 rounded bg-surface-container-low px-3 py-2 text-body-md">
          {tag(t("dev.jiraOffTag"), "bg-slate-200 text-slate-700")}
          <span className="min-w-0">
            {t("dev.jiraOff")}{" "}
            <Link to="/settings" className="inline-flex min-h-11 items-center text-primary hover:underline md:min-h-0">
              → {t("settings.title")}
            </Link>
          </span>
        </p>
      )}
      {c.kind === "none" && <p className="text-body-md text-on-surface-variant">{t("dev.jiraNone")}</p>}
      {c.kind === "running" && (
        <p className="flex items-center gap-2 text-body-md text-blue-800">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {c.text}
        </p>
      )}
      {(c.kind === "done" || c.kind === "not_needed") && <p className="text-body-md text-emerald-800">{c.text}</p>}
      {c.kind === "skipped" && <p className="text-body-md text-on-surface-variant">{c.text}</p>}
      {c.kind === "failed" && (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="flex items-start gap-2 rounded bg-rose-50 px-3 py-2 text-body-md text-rose-800">
            {tag(t("dev.jiraFailedTag"), "bg-rose-100 text-rose-700")}
            <span className="min-w-0 break-words">{c.text}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={act.pending} onClick={() => void act.run(c.id, "retry")}>
              {t("dev.jiraRetry")}
            </Button>
            <ThisWill>{t("dev.jiraRetryThisWill")}</ThisWill>
          </div>
          {act.error && <ErrorBox error={act.error} />}
        </div>
      )}
      <p className="text-body-sm text-on-surface-variant">{t("dev.jiraNeverBlocks")}</p>
    </Card>
  );
}

// ---------------------------------------------------------------- dev_done decision

function DonePanel({ ticketKey, bar, handOff }: { ticketKey: string; bar: boolean; handOff: DevelopmentResponse["handOff"] }) {
  const navigate = useNavigate();
  const hand = useAction(api.handOff);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const request = useAction(api.requestChanges);
  const rechoose = useAction(api.rechoose);
  const empty = note.trim() === "";
  return (
    <DecisionCard
      title={t("dev.doneTitle")}
      phoneTitle={t("dev.donePhoneTitle")}
      subtitle={t("dev.doneSubtitle")}
      bar={bar}
      primary={{
        label: t("dev.handoff"),
        thisWill: t("dev.handoffThisWill"),
        disabled: !handOff.enabled,
        pending: hand.pending,
        onClick: () => void hand.run(ticketKey).then((ok) => ok && navigate(`/tickets/${ticketKey}/acceptance`)),
      }}
      hint={handOff.enabled ? undefined : (handOff.reason ?? undefined)}
      secondary={{
        label: open ? t("dev.sendChanges") : t("dev.requestChanges"),
        barLabel: open ? t("dev.sendChangesShort") : t("dev.requestChanges"),
        thisWill: open ? t("dev.requestChangesThisWill") : t("dev.requestOpenThisWill"),
        pending: request.pending,
        onClick: () => {
          if (!open) return setOpen(true);
          setTouched(true);
          if (!empty) void request.run(ticketKey, note.trim());
        },
      }}
      error={hand.error ?? request.error ?? rechoose.error}
      after={
        <div className="flex flex-col gap-1.5 border-t border-secondary-container/30 pt-3">
          <Button
            className="w-full"
            disabled={rechoose.pending}
            onClick={() => {
              if (window.confirm(t("dev.rechooseConfirm"))) void rechoose.run(ticketKey);
            }}
          >
            {t("design.rechoose")}
          </Button>
          <ThisWill>{t("dev.rechooseThisWill")}</ThisWill>
        </div>
      }
    >
      {open && (
        <label className="flex flex-col gap-1">
          <span className="text-label-md">{t("dev.changeNote")}</span>
          <Textarea
            rows={3}
            autoFocus
            value={note}
            placeholder={t("dev.changePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={touched && empty}
            className={cn(touched && empty && "border-rose-400")}
          />
          {touched && empty && <span className="text-body-sm text-rose-600">{t("dev.changeNoteRequired")}</span>}
        </label>
      )}
    </DecisionCard>
  );
}

// ---------------------------------------------------------------- tab

function DirtyHelp({ repo, path }: { repo: string; path: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-amber-950 lg:col-span-2" data-testid="dirty-help">
      <span className="text-headline-sm">{t("dev.dirtyTitle", { repo })}</span>
      <p className="text-body-md">{t("dev.dirtyBody")}</p>
      <code className="[overflow-wrap:anywhere] rounded bg-white px-2 py-1 font-mono text-code-md">{path}</code>
      <ul className="flex flex-col gap-1 font-mono text-code-sm">
        <li className="break-words">{t("dev.dirtyCommit")}</li>
        <li className="break-words">{t("dev.dirtyDiscard")}</li>
      </ul>
    </section>
  );
}

/** F2-R1: the hooks gate changed — accept the new hooks (this computer only), then Retry. */
function HooksChanged({ ticketKey, v }: { ticketKey: string; v: HooksAcceptView }) {
  // on success the view refreshes and this banner goes away (the hooks match the new pin); Retry then continues
  const accept = useAction(() => api.acceptHooks(ticketKey, v.repo));
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded border border-rose-300 bg-rose-50 p-3 text-rose-950 lg:col-span-2" data-testid={`hooks-changed-${v.repo}`}>
      <span className="break-words text-headline-sm">{t("dev.hooksChangedTitle", { repo: v.repo })}</span>
      <p className="break-words text-body-md">{t("dev.hooksChangedBody")}</p>
      {v.canAccept ? (
        <div className="flex flex-col gap-1">
          <Button
            className="min-h-11 self-start"
            disabled={accept.pending}
            onClick={() => void accept.run()}
          >
            <ShieldCheck className="size-4" />
            {t("dev.hooksAccept")}
          </Button>
          <ThisWill>{v.thisWill}</ThisWill>
        </div>
      ) : (
        <p className="text-body-sm">{t("dev.hooksAcceptLocalOnly")}</p>
      )}
      {accept.error && <ErrorBox error={accept.error} />}
    </section>
  );
}

function Development({ d, dev }: { d: TicketDetail; dev: DevelopmentResponse }) {
  const status = useApi<Status>(paths.status);
  const key = d.ticket.key;
  const state = d.ticket.state;
  const views = repoViews(dev);
  const [picked, setPicked] = useState<string | null>(null);
  const jira = jiraCard(dev.jiraWrites, dev.jiraSync, key, { abandoned: state === "abandoned", mode: status.data?.jira.source });
  const dirty = state === "blocked" ? dirtyWorktreeHelp(d.ticket.blockedReason, dev.ticketDir) : null;
  // the picker opens on the repository that needs you (a dirty worktree), else the first
  const selected = [picked, dirty?.repo].find((n) => views.some((v) => v.name === n)) ?? views[0]?.name ?? "";
  const devStates = ["checking_snapshot", "awaiting_snapshot_ack", "developing", "dev_done", "blocked"];
  if (!devStates.includes(state) && dev.iterations.length === 0 && dev.repos.every((r) => r.worktreePath === null)) return <Empty>{t("dev.none")}</Empty>;
  const jiraPending = jira.kind === "pending";
  const done = state === "dev_done";
  const hasBar = jiraPending || done;

  return (
    <div className={cn("flex flex-col gap-3 p-3 max-md:min-h-[calc(100dvh-var(--header-h,4rem))] max-md:bg-surface-container-low lg:grid lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start lg:gap-4 lg:p-4", hasBar && "max-lg:pb-16")}>
      {/* desktop: everything but the right column, so the right column starts at the top and stays pinned */}
      <div className="flex min-w-0 flex-col gap-3 max-lg:contents lg:gap-4">
        {state === "checking_snapshot" && (
          <p className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-body-md text-blue-800">
            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
            {t("dev.checkingSnapshot")}
          </p>
        )}
        {state === "awaiting_snapshot_ack" && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-1 text-body-md text-amber-900">
            <span className="min-w-0 py-1.5">{t("dev.awaitingAck")}</span>
            <Link to={`/tickets/${key}/coverage`} className="flex min-h-11 items-center font-semibold text-primary hover:underline md:min-h-8">
              {t("dev.toCoverage")}
            </Link>
          </div>
        )}
        {dirty && <DirtyHelp repo={dirty.repo} path={dirty.path} />}
        {hooksAcceptView(state, dev.repos, status.data?.local === true).map((v) => (
          <HooksChanged key={v.repo} ticketKey={key} v={v} />
        ))}
        {/* lg+: every repository's branch and worktree at a glance (07) */}
        <Card className="hidden min-w-0 flex-col gap-1.5 p-3 lg:flex" data-testid="dev-overview">
          <span className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-code-md">
            <span className="text-on-surface-variant">{t("dev.ticketDir")}:</span>
            <span className="[overflow-wrap:anywhere]">{dev.ticketDir}</span>
          </span>
          {dev.repos.map((r, i) => (
            <span key={r.name} className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-code-md">
              <span className="rounded bg-surface-container px-1.5 font-semibold">{r.name}</span>
              <StatusChip status={views[i]!.status} />
              <span className="text-on-surface-variant">{t("dev.branch")}:</span>
              <span className="[overflow-wrap:anywhere]">{r.branch ?? "—"}</span>
              <span className="text-on-surface-variant">{t("dev.worktree")}:</span>
              <span className="[overflow-wrap:anywhere]">{r.worktreePath ?? t("dev.notCreated")}</span>
            </span>
          ))}
        </Card>
        <div className="flex min-w-0 flex-col gap-3 max-lg:contents lg:gap-4">
          {views.length > 1 && (
            // below lg: one repository at a time (m08)
            <div role="tablist" aria-label={t("dev.repos")} className="order-1 grid gap-1 rounded-lg bg-surface-container-high p-1 lg:hidden" style={{ gridTemplateColumns: `repeat(${Math.min(views.length, 3)}, minmax(0, 1fr))` }}>
              {views.map((v) => (
                <button
                  key={v.name}
                  role="tab"
                  aria-selected={v.name === selected}
                  onClick={() => setPicked(v.name)}
                  className={cn("flex min-h-11 min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1", v.name === selected ? "bg-white shadow-sm" : "text-on-surface-variant")}
                >
                  <span className={cn("min-w-0 truncate font-mono text-code-lg", v.name === selected && "font-semibold")}>{v.name}</span>
                  <StatusChip status={v.status} />
                </button>
              ))}
            </div>
          )}
          <div className="order-2 flex min-w-0 flex-col gap-3 lg:order-none lg:gap-4">
            {dev.repos.map((r, i) => (
              <RepoSection key={r.name} ticketKey={key} r={r} v={views[i]!} hidden={r.name !== selected} picker={views.length > 1} />
            ))}
          </div>
          <div className="order-5 min-w-0 lg:order-none">
            <Iterations dev={dev} selected={selected} />
          </div>
          {(state === "developing" || state === "dev_done" || state === "blocked") && (
            <Card className={cn(card, "order-6 lg:order-none")}>
              <LiveLog ticketKey={key} roles={ROLES} />
            </Card>
          )}
        </div>
      </div>
      {/* the right column: in view while the main column scrolls (desktop) */}
      <div className={cn("flex min-w-0 flex-col gap-3 max-lg:contents lg:gap-4", STICKY_RAIL)}>
        {done && (
          <div className={cn("min-w-0 lg:order-none", jiraPending ? "order-4" : "order-3")}>
            <DonePanel ticketKey={key} bar={!jiraPending} handOff={dev.handOff} />
          </div>
        )}
        {/* phones: a JIRA write waiting for you comes first (it owns the sticky bar) */}
        <div className={cn("min-w-0 lg:order-none", jiraPending ? "order-3" : "order-4")}>
          <JiraPanel ticketKey={key} c={jira} note={dev.jiraSync.note} bar />
        </div>
      </div>
    </div>
  );
}

export function DevelopmentTab({ d }: { d: TicketDetail }) {
  const view = useApi<DevelopmentResponse>(paths.development(d.ticket.key));
  return <AsyncView state={view}>{(v) => <Development d={d} dev={v} />}</AsyncView>;
}

