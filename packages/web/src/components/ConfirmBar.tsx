import { Loader2 } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n/en.ts";
import { Button } from "./ui/button.tsx";

/**
 * Phase 4d: a confirmation pinned to the bottom of the screen (every width): what the action affects, "This will: …",
 * Confirm and Cancel (≥44px targets on phones). Escape cancels. Nothing runs until Confirm.
 */
export function ConfirmBar({
  title, thisWill, confirmLabel, onConfirm, onCancel, pending = false, children, testId,
}: {
  title: string;
  thisWill: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  children?: ReactNode;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-label={title}
      data-testid={testId}
      className="fixed inset-x-0 bottom-0 z-40 flex max-h-[70dvh] flex-col gap-2 overflow-y-auto overflow-x-hidden border-t border-slate-200 bg-surface px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-2px_8px_rgba(15,23,42,0.12)] outline-none md:px-6"
    >
      <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-2">
        <span className="text-headline-sm">{title}</span>
        {children}
        <p className="break-words text-body-sm text-on-surface-variant">
          <span className="font-semibold">{t("common.thisWill")}</span> {thisWill}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onCancel} disabled={pending}>
            {t("prompts.cancel")}
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={pending}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
