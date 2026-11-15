import { CheckCircle2, Circle, ExternalLink, Loader2, Minus, SkipForward, XCircle } from "lucide-react";
import { Link } from "react-router";
import { AsyncView, Empty } from "../../components/AsyncView.tsx";
import { ThisWill } from "../../components/ThisWill.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Card, CardHeader } from "../../components/ui/card.tsx";
import { t, type MessageKey } from "../../i18n/en.ts";
import { api, paths, type DeliveryRecord, type DeliveryResponse, type TicketDetail } from "../../lib/api.ts";
import { prRef, stepRows, type StepRow } from "../../lib/delivery-model.ts";
import { useAction, useApi } from "../../lib/hooks.ts";
import { cn, timeAgo } from "../../lib/utils.ts";

function StateIcon({ state }: { state: StepRow["state"] }) {
  const label = t(`dlv.state.${state}` as MessageKey);
  const cls = "size-5 shrink-0";
  switch (state) {
    case "done":
      return <CheckCircle2 role="img" aria-label={label} className={cn(cls, "text-emerald-600")} />;
    case "running":
      return <Loader2 role="img" aria-label={label} className={cn(cls, "animate-spin text-blue-600")} />;
    case "failed":
      return <XCircle role="img" aria-label={label} className={cn(cls, "text-rose-600")} />;
    case "not_needed":
      return <Minus role="img" aria-label={label} className={cn(cls, "text-slate-400")} />;
    case "skipped":
      return <SkipForward role="img" aria-label={label} className={cn(cls, "text-slate-400")} />;
    default:
      return <Circle role="img" aria-label={label} className={cn(cls, "text-slate-400")} />;
  }
}

function Steps({ ticketKey, delivery, retryable }: { ticketKey: string; delivery: DeliveryRecord; retryable: boolean }) {
  const retry = useAction(api.retryDeliveryStep);
  const rows = stepRows(delivery);
  return (
    <ol className="flex flex-col divide-y divide-slate-100" data-testid="delivery-steps">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-col gap-1.5 px-3 py-2.5" data-state={r.state}>
          <div className="flex items-start gap-2.5">
            <StateIcon state={r.state} />
            <span className={cn("min-w-0 flex-1 text-body-md [overflow-wrap:anywhere]", (r.state === "not_needed" || r.state === "skipped") && "text-slate-500")}>{r.text}</span>
          </div>
          {r.link && r.linkLabel && (
            <a href={r.link} target="_blank" rel="noopener noreferrer" className="ml-7 flex min-h-11 w-fit items-center gap-1.5 font-mono text-code-md text-primary hover:underline md:min-h-8">
              {r.linkLabel}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
          {r.state === "failed" && r.detail && (
            <p role="alert" className="ml-7 text-body-sm text-rose-700 [overflow-wrap:anywhere]">
              {r.detail}
            </p>
          )}
          {r.retry && retryable && (
            <div className="ml-7 flex flex-wrap items-center gap-2">
              <Button size="md" disabled={retry.pending} onClick={() => void retry.run(ticketKey, r.id)}>
                {retry.pending ? t("common.loading") : t("dlv.retry")}
              </Button>
              <ThisWill>{t("dlv.retryThisWill")}</ThisWill>
            </div>
          )}
        </li>
      ))}
      {retry.error && (
        <li role="alert" className="px-3 py-2 text-body-sm text-rose-600">
          {retry.error}
        </li>
      )}
    </ol>
  );
}

function Delivery({ d, v }: { d: TicketDetail; v: DeliveryResponse }) {
  const key = d.ticket.key;
  const { state, prevState, blockedReason } = d.ticket;
  const retry = useAction(api.retry);
  const again = useAction(api.previewAgain);
  const abandon = useAction(api.abandon);
  const latest = v.deliveries.at(-1);
  const earlier = v.deliveries.slice(0, -1).reverse();
  // a delivery that stopped (push / PR failed, or the app restarted): Retry continues, Preview again starts over from a fresh plan
  const stopped = state === "blocked" && prevState === "delivering";
  const jiraStep = latest?.steps.find((s) => s.kind === "jira_status");

  if (!latest) return <Empty>{t("dlv.empty")}</Empty>;
  return (
    <div className="flex flex-col gap-3 p-3 max-md:min-h-[calc(100dvh-var(--header-h,4rem))] max-md:bg-surface-container-low lg:max-w-3xl lg:p-4">
      {stopped && (
        <section role="alert" className="flex flex-col gap-2 rounded border border-rose-200 bg-rose-50 px-3 py-3 text-body-md text-rose-900" data-testid="delivery-blocked">
          <span className="font-semibold">{t("dlv.blockedTitle")}</span>
          <span className="[overflow-wrap:anywhere]">{blockedReason ?? "—"}</span>
          <span className="text-body-sm">{t("dlv.blockedHint")}</span>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex flex-col gap-1">
              <Button className="w-full sm:w-auto" disabled={retry.pending} onClick={() => void retry.run(key)}>
                {retry.pending ? t("common.loading") : t("dlv.retry")}
              </Button>
              <ThisWill>{t("dlv.ticketRetryThisWill")}</ThisWill>
            </div>
            <div className="flex flex-col gap-1">
              <Button className="w-full sm:w-auto" disabled={again.pending} onClick={() => void again.run(key)}>
                {again.pending ? t("common.loading") : t("dlv.previewAgain")}
              </Button>
              <ThisWill>{t("dlv.previewAgainThisWill")}</ThisWill>
            </div>
          </div>
          <Button
            variant="destructive"
            className="w-full sm:w-fit"
            disabled={abandon.pending}
            onClick={() => {
              if (window.confirm(t("tickets.abandonConfirm", { key }))) void abandon.run(key);
            }}
          >
            {t("tickets.abandon")}
          </Button>
          {(retry.error ?? again.error ?? abandon.error) && <span className="text-body-sm text-rose-700">{retry.error ?? again.error ?? abandon.error}</span>}
        </section>
      )}
      {state === "delivering" && (
        <p className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-body-md text-blue-900">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
          {t("dlv.running")}
        </p>
      )}

      <Card>
        <CardHeader title={t("dlv.progress")} right={timeAgo(latest.createdAt)} />
        <Steps ticketKey={key} delivery={latest} retryable />
      </Card>

      {state === "pr_opened" && (
        <Card className="border-emerald-200 bg-emerald-50" data-testid="delivery-done">
          <div className="flex flex-col gap-2 px-3 py-3">
            <h2 className="flex items-center gap-2 text-headline-sm text-emerald-900">
              <CheckCircle2 className="size-5 shrink-0" aria-hidden />
              {t("dlv.doneTitle")}
            </h2>
            <ul className="flex flex-col gap-2">
              {v.prs.map((p) => {
                const row = prRef(p.url, p.number);
                return (
                  <li key={p.repo} className="flex flex-wrap items-center gap-2 rounded border border-emerald-200 bg-white px-3 py-2">
                    <span className="rounded bg-surface-container px-1.5 font-mono text-code-md">{p.repo}</span>
                    {row ? (
                      <a href={row.link} target="_blank" rel="noopener noreferrer" aria-label={t("dlv.openPr", { label: row.label })} className="flex min-h-11 items-center gap-1.5 font-mono text-code-md text-primary hover:underline md:min-h-8">
                        {row.label}
                        <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    ) : (
                      <span className="font-mono text-code-md">#{p.number}</span>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="text-body-md text-emerald-900">{jiraStep?.state === "done" ? t("dlv.doneJira", { status: d.ticket.jiraStatus ?? "—" }) : t("dlv.doneJiraUnchanged")}</p>
          </div>
        </Card>
      )}

      {earlier.length > 0 && (
        <details className="rounded border border-slate-200 bg-white">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 text-label-md font-semibold">{t("dlv.earlier", { n: earlier.length })}</summary>
          <div className="flex flex-col gap-3 border-t border-slate-200 p-2">
            {earlier.map((e) => (
              <Card key={e.id}>
                <CardHeader title={t("dlv.deliveryN", { n: e.id, ago: timeAgo(e.createdAt) })} />
                <Steps ticketKey={key} delivery={e} retryable={false} />
              </Card>
            ))}
          </div>
        </details>
      )}
      <Link to={`/tickets/${key}/acceptance`} className="flex min-h-11 w-fit items-center text-body-md font-semibold text-primary hover:underline">
        {t("dlv.toAcceptance")}
      </Link>
    </div>
  );
}

export function DeliveryTab({ d }: { d: TicketDetail }) {
  const view = useApi<DeliveryResponse>(paths.delivery(d.ticket.key));
  return (
    <AsyncView state={view} isEmpty={(v) => v.deliveries.length === 0} empty={t("dlv.empty")}>
      {(v) => <Delivery d={d} v={v} />}
    </AsyncView>
  );
}
