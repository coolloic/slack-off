import { AlertTriangle, ChevronDown, ChevronRight, Loader2, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/en.ts";
import { api, ApiError, paths, type DeliveryPreview } from "../lib/api.ts";
import { confirmSheet } from "../lib/delivery-model.ts";
import { invalidateAll } from "../lib/hooks.ts";
import { cn } from "../lib/utils.ts";
import { ThisWill } from "./ThisWill.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/input.tsx";

type Load = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; plan: DeliveryPreview };

/**
 * "Confirm delivery": a bottom sheet on phones, a centred dialog from md up. It lists the server's action texts and
 * warnings word for word and the full PR descriptions; the confirm POST carries the previewed plan hash, so a plan that
 * changed since (409) is shown again instead of being sent. When the preview says `needsAck` (the delivery came back
 * because JIRA changed) a note is required (it is audited, not hashed).
 */
export function DeliveryConfirmSheet({ ticketKey, onClose, onDone }: { ticketKey: string; onClose: () => void; onDone: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [stale, setStale] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const fetchPlan = useCallback(() => {
    const mine = ++seq.current;
    setLoad({ kind: "loading" });
    api
      .get<DeliveryPreview>(paths.deliveryPreview(ticketKey))
      .then((plan) => {
        if (mine !== seq.current) return;
        setLoad({ kind: "ready", plan });
        setOpen({ [plan.prBodies[0]?.repo ?? ""]: true });
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setLoad({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }, [ticketKey]);

  useEffect(() => {
    fetchPlan();
    return () => {
      seq.current++;
    };
  }, [fetchPlan]);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    sheet.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      before?.focus?.();
    };
  }, [onClose]);

  const ready = load.kind === "ready" ? load.plan : null;
  const view = ready ? confirmSheet(ready, ready.jiraNote) : null;
  const noteEmpty = note.trim() === "";
  const requireAck = view?.needsAck === true;

  const deliver = async () => {
    if (!ready || !view?.canConfirm) return;
    setTouched(true);
    if (requireAck && noteEmpty) return;
    setPending(true);
    setError(null);
    setStale(null);
    try {
      await api.confirmDelivery(ticketKey, ready.hash, requireAck ? note.trim() : undefined);
      invalidateAll();
      onDone();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      const message = e instanceof Error ? e.message : String(e);
      if (status === 409) {
        setStale(message);
        fetchPlan();
      } else {
        setError(message);
        if (status === 400) fetchPlan();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 md:items-center" data-testid="delivery-sheet-backdrop" onClick={onClose}>
      <div
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("dlv.sheetTitle")}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl outline-none md:max-h-[85dvh] md:rounded-lg"
        data-testid="delivery-sheet"
      >
        <div className="flex shrink-0 flex-col items-center gap-2 px-4 pt-2 md:items-start md:pt-4">
          <span className="h-1 w-10 rounded-full bg-slate-300 md:hidden" aria-hidden />
          <h2 className="w-full text-headline-md text-on-surface">{t("dlv.sheetTitle")}</h2>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-3">
          {load.kind === "loading" && (
            <p className="flex items-center gap-2 py-6 text-body-md text-slate-600">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("dlv.loading")}
            </p>
          )}
          {load.kind === "error" && (
            <div role="alert" className="flex flex-col gap-2 rounded border border-rose-200 bg-rose-50 p-3 text-body-md text-rose-800">
              <span className="break-words">{t("dlv.loadFailed", { error: load.message })}</span>
              <Button size="md" onClick={fetchPlan} className="w-fit">
                {t("dlv.reload")}
              </Button>
            </div>
          )}
          {stale !== null && (
            <div role="alert" className="flex flex-col gap-1 rounded border border-amber-300 bg-amber-50 p-3 text-body-md text-amber-900" data-testid="delivery-stale">
              <span className="font-semibold">{t("dlv.stale")}</span>
              <span className="break-words text-body-sm">{stale}</span>
            </div>
          )}

          {view && (
            <>
              {view.blockers.length > 0 && (
                <section aria-label={t("dlv.blockers")} className="flex flex-col gap-1.5 rounded border border-rose-300 bg-rose-50 p-3" data-testid="delivery-blockers">
                  <h3 className="flex items-center gap-1.5 text-label-md font-semibold text-rose-800">
                    <ShieldAlert className="size-4 shrink-0" aria-hidden />
                    {t("dlv.blockers")}
                  </h3>
                  <ul className="flex flex-col gap-1 text-body-md text-rose-800">
                    {view.blockers.map((b, i) => (
                      <li key={i} className="[overflow-wrap:anywhere]">
                        {b}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section aria-label={t("dlv.actions")} className="flex flex-col gap-1.5">
                <h3 className="text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">{t("dlv.actions")}</h3>
                <ol className="flex flex-col gap-2" data-testid="delivery-actions">
                  {view.items.map((it) => (
                    <li key={it.n} className="flex gap-2 text-body-md text-on-surface">
                      <span className="w-5 shrink-0 text-right font-mono text-code-md text-slate-500">{it.n}.</span>
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {it.text}
                        {it.jira && (
                          <Badge tone="info" className="ml-2 align-middle">
                            {t("dlv.jiraTag")}
                          </Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>

              {view.warnings.length > 0 && (
                <section aria-label={t("dlv.warnings")} className="flex flex-col gap-1.5 rounded border border-amber-300 bg-amber-50 p-3" data-testid="delivery-warnings">
                  <ul className="flex flex-col gap-1.5 text-body-md text-amber-900">
                    {view.warnings.map((w, i) => (
                      <li key={i} className="flex gap-1.5">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{w}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {view.jiraNote && <p className="text-body-sm text-slate-500">{view.jiraNote}</p>}

              {view.bodies.length > 0 && (
                <section aria-label={t("dlv.bodies")} className="flex flex-col gap-1.5">
                  <h3 className="text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">{t("dlv.bodies")}</h3>
                  {view.bodies.map((b) => {
                    const isOpen = open[b.repo] === true;
                    return (
                      <div key={b.repo} className="overflow-hidden rounded border border-slate-200 bg-white">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          aria-label={t(isOpen ? "dlv.bodyHide" : "dlv.bodyShow", { repo: b.repo })}
                          onClick={() => setOpen({ ...open, [b.repo]: !isOpen })}
                          className="flex min-h-11 w-full items-center gap-2 px-3 text-left"
                        >
                          {isOpen ? <ChevronDown className="size-4 shrink-0" aria-hidden /> : <ChevronRight className="size-4 shrink-0" aria-hidden />}
                          <span className="rounded bg-surface-container px-1.5 font-mono text-code-md">{b.repo}</span>
                          <span className="min-w-0 flex-1 truncate text-body-md">{b.title}</span>
                        </button>
                        {isOpen && (
                          <div className="flex flex-col gap-2 border-t border-slate-200 p-3">
                            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-code-md text-on-surface" data-testid="pr-body">
                              {b.body}
                            </pre>
                            <p className="text-body-sm text-slate-500">{t("dlv.screenshotsStay")}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              )}

              {requireAck && (
                <section className="flex flex-col gap-1.5 rounded border border-amber-300 bg-amber-50 p-3" data-testid="delivery-ack">
                  <h3 className="text-label-md font-semibold text-amber-900">{t("dlv.ackTitle")}</h3>
                  <p className="text-body-sm text-amber-900">{t("dlv.ackBody")}</p>
                  <label className="flex flex-col gap-1">
                    <span className="text-label-md">{t("dlv.ackLabel")}</span>
                    <Textarea
                      rows={3}
                      value={note}
                      placeholder={t("dlv.ackPlaceholder")}
                      onChange={(e) => setNote(e.target.value)}
                      onBlur={() => setTouched(true)}
                      aria-invalid={touched && noteEmpty}
                      className={cn("font-mono text-code-md", touched && noteEmpty && "border-rose-400")}
                    />
                    {touched && noteEmpty && <span className="text-body-sm text-rose-600">{t("dlv.ackRequired")}</span>}
                  </label>
                </section>
              )}
            </>
          )}
          {error !== null && (
            <p role="alert" className="break-words text-body-sm text-rose-600">
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-1.5 border-t border-slate-200 bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex gap-2">
            <Button className="min-w-0 flex-1 border-0 bg-surface-container-high text-on-surface hover:bg-surface-container-highest" onClick={onClose}>
              {t("dlv.cancel")}
            </Button>
            <Button variant="decision" className="min-w-0 flex-[1.4] text-on-secondary-fixed" disabled={!view?.canConfirm || pending} onClick={() => void deliver()}>
              {pending ? t("common.loading") : t("dlv.deliver")}
            </Button>
          </div>
          <ThisWill className="text-center">{t("dlv.deliverThisWill")}</ThisWill>
        </div>
      </div>
    </div>
  );
}
