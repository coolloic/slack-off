import { ArrowLeft, ExternalLink, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router";
import { agentName } from "../../lib/agent-name.ts";
import { AsyncView, ErrorBox } from "../../components/AsyncView.tsx";
import { StateBadge } from "../../components/StateBadge.tsx";
import { StateStepper } from "../../components/StateStepper.tsx";
import { ThisWill } from "../../components/ThisWill.tsx";
import { Button, buttonVariants } from "../../components/ui/button.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { t, type MessageKey } from "../../i18n/en.ts";
import { api, paths, type DeliveryResponse, type SnapshotSummary, type Status, type TicketDetail } from "../../lib/api.ts";
import { resumedRetryNote } from "../../lib/usage-model.ts";
import { safeJiraUrl } from "../../lib/jira-link.ts";
import { asksForAnswer, settingsHrefFor } from "../../lib/settings-link.ts";
import { AnswerOptions } from "../../components/AnswerOptions.tsx";
import type { AnswerOption } from "../../lib/answer-options.ts";
import { Textarea } from "../../components/ui/input.tsx";
import { useAction, useApi, useLive } from "../../lib/hooks.ts";
import { NEEDS_YOU } from "../../lib/states.ts";
import { defaultTab, isTab, TABS, type Tab } from "../../lib/tabs.ts";
import { cn, timeAgo } from "../../lib/utils.ts";
import { AcceptanceTab } from "./AcceptanceTab.tsx";
import { BaseBranches } from "./BaseBranches.tsx";
import { CoverageTab } from "./CoverageTab.tsx";
import { DeliveryTab } from "./DeliveryTab.tsx";
import { DesignTab } from "./DesignTab.tsx";
import { DevelopmentTab } from "./DevelopmentTab.tsx";
import { RequirementsTab } from "./RequirementsTab.tsx";
import { SnapshotTab } from "./SnapshotTab.tsx";
import { SolutionsTab } from "./SolutionsTab.tsx";

const LATER_TABS: ReadonlyArray<{ id: string; label: MessageKey }> = [{ id: "audit", label: "tab.audit" }];
const TAB_SHORT: Record<Tab, MessageKey> = {
  snapshot: "tab.snapshotShort",
  requirements: "tab.requirements",
  coverage: "tab.coverage",
  solutions: "tab.solutions",
  design: "tab.design",
  development: "tab.development",
  acceptance: "tab.acceptance",
  delivery: "tab.delivery",
};
const TAB_LABEL: Record<Tab, MessageKey> = {
  snapshot: "tab.snapshot",
  requirements: "tab.requirements",
  coverage: "tab.coverage",
  solutions: "tab.solutions",
  design: "tab.design",
  development: "tab.development",
  acceptance: "tab.acceptance",
  delivery: "tab.delivery",
};

function Header({ d, snapshots, hideBlocked }: { d: TicketDetail; snapshots: SnapshotSummary[] | undefined; hideBlocked: boolean }) {
  const { ticket } = d;
  const live = useLive();
  const setReview = useAction(api.setReviewAc);
  const retry = useAction(api.retry);
  const [answer, setAnswer] = useState("");
  // the developer agent asked, or any development block: an optional answer goes with Retry
  const asks = ticket.state === "blocked" && (asksForAnswer(ticket.blockedReason) || ticket.prevState === "developing");
  // the developer agent's question with its suggested answers (one recommended)
  const question = useApi<{ question: { question: string; options: AnswerOption[] } | null }>(asks ? paths.devQuestion(ticket.key) : null);
  const abandon = useAction(api.abandon);
  const status = useApi<Status>(paths.status);
  // F-8: only a URL on the configured JIRA origin is linked (ticket.url comes from the browser agent)
  const jiraHref = safeJiraUrl(ticket.url, status.data?.jira.baseUrl);
  const running = live.running[ticket.key];
  const error = setReview.error ?? retry.error ?? abandon.error;
  // phase 4c (C-3): after a resume the stopped ticket still needs its own Retry
  const settingsHref = ticket.state === "blocked" ? settingsHrefFor(ticket.blockedReason) : null;
  const resumedNote = status.data ? resumedRetryNote(ticket.blockedReason, status.data.usage.paused !== null) : null;
  return (
    <div className="flex flex-col gap-1.5 border-b border-slate-200 px-4 py-2 max-md:border-b-0 max-md:pb-0">
      <div className="hidden flex-wrap items-center justify-between gap-2 text-body-sm md:flex">
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/" className="flex shrink-0 items-center gap-1 text-primary hover:underline">
            <ArrowLeft className="size-3.5" />
            {t("ticket.back")}
          </Link>
          <span className="text-slate-300">/</span>
          <span className="text-slate-500">{t("ticket.breadcrumb")}</span>
          <span className="text-slate-300">/</span>
          <span className="min-w-0 truncate font-mono font-semibold">{ticket.key}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-code-sm text-slate-500">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-slate-400" />
            {t("ticket.jiraReadOnly")}
          </span>
          {snapshots && <span>· {t("ticket.snapshotCount", { n: snapshots.length })}</span>}
          {jiraHref && (
            <a href={jiraHref} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline">
              {t("common.openInJira")}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          )}
        </div>
      </div>
      {/* phones: key + state live in the header bar; keep a compact title only */}
      <h1 className="line-clamp-2 break-words text-headline-sm md:hidden">{ticket.title}</h1>
      {jiraHref && (
        <a
          href={jiraHref}
          target="_blank"
          rel="noopener noreferrer"
          className="-my-1 flex min-h-11 w-fit items-center gap-1.5 text-body-md font-semibold text-primary hover:underline md:hidden"
        >
          {t("common.openInJira")}
          <ExternalLink aria-hidden="true" className="size-4" />
        </a>
      )}
      <div className="hidden flex-wrap items-center gap-2 md:flex">
        <span className="max-w-full break-all rounded bg-surface-container px-1.5 font-mono text-headline-md text-primary">{ticket.key}</span>
        <h1 className="min-w-0 break-words text-headline-lg">{ticket.title}</h1>
        <StateBadge state={ticket.state} />
      </div>
      <div className="hidden flex-wrap items-center gap-3 font-mono text-code-sm text-slate-500 md:flex">
        {NEEDS_YOU.includes(ticket.state) && (
          <span className="text-amber-700">
            ● {t("ticket.waitingForYou")} · {t(`state.${ticket.state}` as MessageKey)}
          </span>
        )}
        {ticket.jiraStatus && <span>{t("ticket.jiraStatus", { status: ticket.jiraStatus })}</span>}
        <span>{t("ticket.created", { ago: timeAgo(ticket.createdAt) })}</span>
        <span>{t("ticket.updated", { ago: timeAgo(ticket.updatedAt) })}</span>
        {running && <span className="text-primary">{t("ticket.runningAgent", { role: agentName(running) })}</span>}
        <label className="flex items-center gap-1.5">
          <Tooltip content={`${t("common.thisWill")} ${t("tickets.reviewAcThisWill")}`}>
            <span className="inline-flex">
              <Switch checked={ticket.reviewAc} disabled={setReview.pending} onCheckedChange={(v) => void setReview.run(ticket.key, v)} />
            </span>
          </Tooltip>
          <span className="font-sans text-body-sm text-slate-700">{t("ticket.reviewAc")}</span>
          {/* touch tablets have no hover: show the note instead of relying on the tooltip */}
          <ThisWill className="lg:hidden">{t("tickets.reviewAcThisWill")}</ThisWill>
        </label>
      </div>
      <BaseBranches ticketKey={ticket.key} finished={ticket.state === "pr_opened" || ticket.state === "abandoned"} canReset={ticket.state === "blocked" || ticket.state === "dev_done"} />
      {ticket.state === "blocked" && !hideBlocked && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-body-md text-rose-800">
          <span className="min-w-0 break-words">{t("ticket.blockedReason", { reason: ticket.blockedReason ?? "—" })}</span>
          {asks && (
            <div className="flex basis-full flex-col gap-1.5 text-rose-900">
              <AnswerOptions options={question.data?.question?.options ?? []} current={answer} onPick={setAnswer} />
              <label className="flex flex-col gap-1">
              <span className="text-label-md">{t("ticket.answer")}</span>
              <Textarea
                rows={3}
                maxLength={2000}
                value={answer}
                placeholder={t("ticket.answerPlaceholder")}
                onChange={(e) => setAnswer(e.target.value)}
                className="bg-white font-sans text-body-md text-on-surface"
                data-testid="retry-answer"
              />
              </label>
            </div>
          )}
          <span className="flex flex-wrap items-center gap-2">
            {resumedNote && (
              <span data-testid="resumed-note" className="font-semibold text-emerald-800">
                {resumedNote}
              </span>
            )}
            <ThisWill>{asks ? t("ticket.retryAnswerThisWill") : t("tickets.retryThisWill")}</ThisWill>
            <Button
              onClick={() => void retry.run(ticket.key, asks && answer.trim() !== "" ? answer.trim() : undefined).then((ok) => ok && setAnswer(""))}
              disabled={retry.pending}
            >
              {t("tickets.retry")}
            </Button>
            <Button
              variant="destructive"
              disabled={abandon.pending}
              onClick={() => {
                if (window.confirm(t("tickets.abandonConfirm", { key: ticket.key }))) void abandon.run(ticket.key);
              }}
            >
              {t("tickets.abandon")}
            </Button>
            {settingsHref && (
              <Link to={settingsHref} data-testid="blocked-open-settings" className={buttonVariants({ variant: "primary" })}>
                <Settings className="size-4" aria-hidden />
                {t("ticket.openSettings")}
              </Link>
            )}
          </span>
        </div>
      )}
      {error && <ErrorBox error={error} />}
    </div>
  );
}

/** Publishes the tab strip's height as --tabs-h (0 when it is gone), like the app header's --header-h. */
function useTabsHeight(): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const root = document.documentElement.style;
    const apply = () => root.setProperty("--tabs-h", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.setProperty("--tabs-h", "0px");
    };
  }, [el]);
  return setEl;
}

function Tabs({ d, active }: { d: TicketDetail; active: Tab }) {
  const tabsRef = useTabsHeight();
  const drift = d.drift;
  const attention = drift && drift.needsAck && !drift.acknowledged && drift.requirementId === d.requirement?.id;
  const nAttention = drift
    ? drift.result.baseline.filter((b) => b.status !== "covered").length +
      drift.result.current.filter((c) => c.status === "new_unsourced").length +
      drift.result.contradictions.length
    : 0;
  return (
    // sticky under the app header; its height is published as --tabs-h for what sticks or scrolls to below it
    <div
      ref={tabsRef}
      role="tablist"
      className="scroll-x sticky top-[var(--header-h,4rem)] z-30 flex flex-nowrap items-end gap-1 border-b border-slate-200 bg-white px-2 max-md:items-center max-md:gap-2 max-md:bg-surface-container-low max-md:px-3 max-md:py-2 md:px-4"
    >
      {TABS.map((tab) => (
        <Link
          key={tab}
          role="tab"
          aria-selected={tab === active}
          ref={(el) => {
            // keep the active pill visible in the horizontally scrolling strip (phones)
            if (tab === active && el && el.parentElement && el.parentElement.scrollWidth > el.parentElement.clientWidth) {
              el.parentElement.scrollLeft = el.offsetLeft - (el.parentElement.clientWidth - el.offsetWidth) / 2;
            }
          }}
          to={`/tickets/${d.ticket.key}/${tab}`}
          className={cn(
            "flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 text-body-md md:h-10",
            // phones: pill tabs (m02–m05)
            "max-md:rounded-full max-md:border-0 max-md:px-4",
            tab === active
              ? "border-primary-container font-semibold text-primary max-md:bg-primary max-md:text-white"
              : "border-transparent text-on-surface-variant hover:text-on-surface max-md:bg-white",
          )}
        >
          <span className="md:hidden">{t(TAB_SHORT[tab])}</span>
          <span className="max-md:hidden">{t(TAB_LABEL[tab])}</span>
          {tab === "coverage" && attention && <span className="rounded bg-secondary-fixed px-1 font-mono text-code-sm text-on-secondary-fixed-variant">{t("tab.attention", { n: nAttention })}</span>}
          {tab === "coverage" && drift?.acknowledged && <span className="rounded bg-emerald-50 px-1 font-mono text-code-sm text-emerald-700">✓ {t("tab.acknowledged")}</span>}
        </Link>
      ))}
      {LATER_TABS.map((tab) => (
        <Tooltip key={tab.id} content={t("common.phase3")}>
          <span role="tab" aria-disabled="true" className="hidden h-11 shrink-0 cursor-not-allowed md:flex items-center whitespace-nowrap border-b-2 border-transparent px-2.5 text-body-md text-slate-400 md:h-10">
            {t(tab.label)}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

export function TicketPage() {
  const { key = "", tab } = useParams();
  const detail = useApi<TicketDetail>(paths.ticket(key));
  const snapshots = useApi<SnapshotSummary[]>(paths.snapshots(key));
  // the generic blocked banner gives way on the Delivery tab only once a delivery exists (the tab then has its own Retry)
  const deliveries = useApi<DeliveryResponse>(tab === "delivery" ? paths.delivery(key) : null);

  if (detail.error && detail.data === undefined && "status" in detail.error && detail.error.status === 404) {
    return <div className="p-4"><ErrorBox error={t("ticket.notFound")} /></div>;
  }
  return (
    <AsyncView state={detail}>
      {(d) => {
        if (!isTab(tab)) return <Navigate replace to={`/tickets/${key}/${defaultTab(d.ticket.state, d.ticket.prevState)}`} />;
        const active = tab;
        return (
          <div className="flex flex-col">
            {/* a delivery that stopped has its own Retry / Preview again / Abandon on the Delivery tab */}
            <Header d={d} snapshots={snapshots.data} hideBlocked={active === "delivery" && d.ticket.prevState === "delivering" && (deliveries.data?.deliveries.length ?? 0) > 0} />
            <div className="hidden md:block">
              <StateStepper state={d.ticket.state} prevState={d.ticket.prevState} />
            </div>
            <Tabs d={d} active={active} />
            {active === "snapshot" && <SnapshotTab ticketKey={key} jiraUrl={d.ticket.url || null} snapshots={snapshots} canRefine={d.ticket.state === "discovered"} canRead={d.ticket.state !== "pr_opened" && d.ticket.state !== "abandoned"} />}
            {active === "requirements" && <RequirementsTab d={d} />}
            {active === "coverage" && <CoverageTab d={d} />}
            {active === "solutions" && <SolutionsTab d={d} />}
            {active === "design" && <DesignTab d={d} />}
            {active === "development" && <DevelopmentTab d={d} />}
            {active === "acceptance" && <AcceptanceTab d={d} />}
            {active === "delivery" && <DeliveryTab d={d} />}
          </div>
        );
      }}
    </AsyncView>
  );
}
