import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState, type TouchEvent } from "react";
import { t } from "../i18n/en.ts";
import { api, paths } from "../lib/api.ts";

export interface LightboxItem {
  id: number;
  caption: string;
  /** "screenshot" shows the picture; anything else (HTTP exchange, log) is fetched and shown as monospace text */
  kind: string;
  acId: string;
}

/** Text evidence (an HTTP exchange or a log) as plain, unrendered monospace text. */
function TextEvidence({ ticketKey, id }: { ticketKey: string; id: number }) {
  const [state, setState] = useState<{ text: string } | { error: true } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    api
      .evidenceText(ticketKey, id)
      .then((text) => live && setState({ text }))
      .catch(() => live && setState({ error: true }));
    return () => {
      live = false;
    };
  }, [ticketKey, id]);
  if (state === null) return <p className="text-body-md text-slate-300">{t("lb.loading")}</p>;
  if ("error" in state) return <p role="alert" className="text-body-md text-rose-300">{t("lb.failed")}</p>;
  return (
    <pre className="max-h-full w-full max-w-3xl overflow-auto whitespace-pre-wrap break-words rounded bg-slate-900 p-3 font-mono text-code-md text-slate-100" data-testid="lightbox-text">
      {state.text}
    </pre>
  );
}

/**
 * Full-screen evidence viewer: black background, left/right (arrow keys, buttons, swipe), Esc / X to close.
 * Everything is a >= 44px target. Picture bytes come from the evidence route; nothing is rendered as HTML.
 */
export function EvidenceLightbox({ ticketKey, items, index, onIndex, onClose }: { ticketKey: string; items: LightboxItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const n = items.length;
  const item = items[index];
  const go = (d: number) => {
    if (n > 1) onIndex((index + d + n) % n);
  };

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      before?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!item) return null;
  const onTouchStart = (e: TouchEvent) => {
    touchX.current = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const start = touchX.current;
    touchX.current = null;
    const end = e.changedTouches[0]?.clientX;
    if (start === null || end === undefined) return;
    if (end - start > 50) go(-1);
    else if (start - end > 50) go(1);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={t("lb.title")} className="fixed inset-0 z-50 flex flex-col bg-black text-white" data-testid="lightbox" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="flex min-h-14 items-center justify-between gap-2 px-3 pt-[env(safe-area-inset-top)]">
        <span className="font-mono text-code-md text-slate-300" data-testid="lightbox-counter">
          {t("lb.counter", { n: index + 1, total: n })}
        </span>
        <button ref={closeBtn} type="button" onClick={onClose} aria-label={t("lb.close")} className="flex size-11 items-center justify-center rounded-full text-white hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
          <X className="size-6" aria-hidden />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2">
        {item.kind === "screenshot" ? (
          failed === item.id ? (
            <p role="alert" className="text-body-md text-rose-300">{t("lb.failed")}</p>
          ) : (
            <img key={item.id} src={paths.evidence(ticketKey, item.id)} alt={item.caption} onError={() => setFailed(item.id)} className="h-full w-full object-contain" />
          )
        ) : (
          <TextEvidence ticketKey={ticketKey} id={item.id} />
        )}
        {n > 1 && (
          <>
            <button type="button" onClick={() => go(-1)} aria-label={t("lb.prev")} className="absolute left-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
              <ChevronLeft className="size-6" aria-hidden />
            </button>
            <button type="button" onClick={() => go(1)} aria-label={t("lb.next")} className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
              <ChevronRight className="size-6" aria-hidden />
            </button>
          </>
        )}
      </div>
      <p className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 text-center text-body-md [overflow-wrap:anywhere]" data-testid="lightbox-caption">
        <span className="font-mono">{item.acId}</span> · {item.caption}
      </p>
    </div>
  );
}
