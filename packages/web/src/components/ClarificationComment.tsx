import { Loader2, Send } from "lucide-react";
import { useEffect, useRef } from "react";
import { t, type MessageKey } from "../i18n/en.ts";
import { useJiraMode } from "../lib/hooks.ts";
import { jiraText } from "../lib/jira-mode.ts";
import { COMMENT_MAX_CHARS, type CommentHistoryEntry } from "../lib/requirements-model.ts";
import { cn, timeAgo } from "../lib/utils.ts";
import { ErrorBox } from "./AsyncView.tsx";
import { ThisWill } from "./ThisWill.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Textarea } from "./ui/input.tsx";

/**
 * The requirement-unclear comment: an editable draft, "Send to JIRA" (which opens a confirmation showing the text
 * word for word), and the history of what was sent with a Retry for failed ones. State lives in the parent so the
 * phone and desktop layouts share it. Server messages are shown as given.
 */
export function ClarificationComment({
  ticketKey, text, error, history, sending, onEdit, onSend, onRetry, retryPending, retryError,
}: {
  ticketKey: string;
  text: string;
  /** client-side check (same rule as the server) */
  error: string | null;
  history: CommentHistoryEntry[];
  /** a comment is being sent right now: the server refuses a second one */
  sending: boolean;
  onEdit: (v: string) => void;
  onSend: () => void;
  onRetry: (id: number) => void;
  retryPending: boolean;
  retryError?: string;
}) {
  const blank = text.trim() === "";
  const mode = useJiraMode();
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="clarification-comment">
      <label className="flex flex-col gap-1">
        <span className="text-label-md text-slate-600">{t("req.draftComment")}</span>
        <Textarea value={text} onChange={(e) => onEdit(e.target.value)} rows={5} className="font-mono text-code-md max-md:text-base" />
      </label>
      <div className="flex items-center justify-between gap-2 text-body-sm">
        <span className={cn("min-w-0", error && !blank ? "text-rose-600" : "text-slate-500")} role={error && !blank ? "alert" : undefined}>
          {error && !blank ? error : ""}
        </span>
        <span className={cn("shrink-0 font-mono", text.length > COMMENT_MAX_CHARS ? "text-rose-600" : "text-slate-500")}>
          {t("req.comment.chars", { n: text.length, max: COMMENT_MAX_CHARS })}
        </span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <Button variant="decision" size="lg" className="w-full md:w-auto" disabled={error !== null || sending} onClick={onSend}>
          <Send className="size-4" />
          {t("req.comment.send")}
        </Button>
        {sending && <span className="text-body-sm text-amber-800">{t("req.comment.inFlight")}</span>}
        <ThisWill>{jiraText("req.comment.thisWill", mode, { key: ticketKey })}</ThisWill>
      </div>
      {history.length > 0 && (
        <section aria-label={t("req.comment.history")} className="flex flex-col gap-1.5 border-t border-slate-200 pt-2" data-testid="comment-history">
          <h3 className="text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">{t("req.comment.history")}</h3>
          {history.map((h) => (
            <div key={h.id} className="flex min-w-0 flex-col gap-1 rounded border border-slate-200 bg-white p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={h.state === "failed" ? "blocked" : h.state === "done" ? "done" : "running"}>{t(`req.comment.state.${h.state}` as MessageKey)}</Badge>
                <span className="text-body-sm text-slate-500">{timeAgo(h.at)}</span>
                {h.retry && (
                  <Button size="md" className="ml-auto" disabled={retryPending} onClick={() => onRetry(h.id)}>
                    {t("req.comment.retry")}
                  </Button>
                )}
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-code-sm [overflow-wrap:anywhere]">{h.text}</p>
            </div>
          ))}
          {retryError && <ErrorBox error={retryError} />}
        </section>
      )}
    </div>
  );
}

/** Confirmation: the exact text that will be posted, and what happens. A bottom sheet on phones, a dialog from md up. */
export function CommentConfirmSheet({
  ticketKey, text, pending, error, onConfirm, onClose,
}: {
  ticketKey: string;
  text: string;
  pending: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const mode = useJiraMode();
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
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 md:items-center" data-testid="comment-sheet-backdrop" onClick={onClose}>
      <div
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("req.comment.sheetTitle", { key: ticketKey })}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl outline-none md:max-h-[85dvh] md:rounded-lg"
        data-testid="comment-sheet"
      >
        <div className="flex shrink-0 flex-col items-center gap-2 px-4 pt-2 md:items-start md:pt-4">
          <span className="h-1 w-10 rounded-full bg-slate-300 md:hidden" aria-hidden />
          <h2 className="w-full text-headline-md text-on-surface">{t("req.comment.sheetTitle", { key: ticketKey })}</h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-4 py-3">
          <span className="text-body-sm text-slate-600">{t("req.comment.sheetHint")}</span>
          <pre className="whitespace-pre-wrap break-words rounded border border-slate-200 bg-white p-3 font-mono text-code-md [overflow-wrap:anywhere]" data-testid="comment-sheet-text">
            {text}
          </pre>
          {error && <ErrorBox error={error} />}
        </div>
        <div className="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-surface px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <ThisWill>{jiraText("req.comment.thisWill", mode, { key: ticketKey })}</ThisWill>
          <div className="grid grid-cols-2 gap-2 md:flex md:justify-end">
            <Button size="lg" onClick={onClose} disabled={pending}>
              {t("common.cancel")}
            </Button>
            <Button size="lg" variant="decision" onClick={onConfirm} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              {pending ? t("req.comment.sending") : t("req.comment.send")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
