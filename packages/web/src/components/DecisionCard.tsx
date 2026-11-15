import { AlertTriangle, ArrowRight } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n/en.ts";
import { cn } from "../lib/utils.ts";
import { barCaption, hintPlacement } from "../lib/decision-model.ts";
import { Button } from "./ui/button.tsx";

export interface DecisionAction {
  label: string;
  thisWill: string;
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  /** Shorter/more specific label for the phone sticky bar (e.g. "Choose Option B"). */
  barLabel?: string;
}

/** A plain secondary action that only appears in the phone sticky bar (e.g. "Save draft", "Back to requirements"). */
export interface BarAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Set for actions that change state (e.g. "Save draft"); navigation-only actions leave it out. */
  thisWill?: string;
}

/**
 * Orange "your decision needed" panel. Every action shows what it will do next to the button.
 * lg+: right-rail card with its buttons (desktop layout).
 * Below lg: the card sits at the top of the content without buttons, and a single opaque sticky bottom bar
 * carries the actions (secondary left, orange primary right) with the "This will:" caption — the bar is the
 * one primary on phones.
 */
export function DecisionCard({
  title,
  phoneTitle,
  subtitle,
  children,
  primary,
  secondary,
  barSecondary,
  barExtra = [],
  phoneCard = true,
  error,
  hint,
  bar = true,
  after,
  hintMode = "short",
}: {
  title?: string;
  /** Shown instead of `title` below lg (Stitch phone wording, e.g. "Decision needed: ACs drifted…"). */
  phoneTitle?: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  primary: DecisionAction;
  secondary?: DecisionAction;
  barSecondary?: BarAction;
  /** More secondary buttons for the phone bar, left of the main secondary (e.g. Acceptance: Reject + Re-run). */
  barExtra?: BarAction[];
  /** false: below lg only the sticky bar is shown (the page itself carries the choice, e.g. Solutions). */
  phoneCard?: boolean;
  error?: string;
  /** Why the primary is disabled (e.g. "Rule on: C-2"), shown next to the buttons — guidance, not an alert. */
  hint?: string;
  /** false: no phone sticky bar — the buttons stay in the card at every width (another decision owns the bar). */
  bar?: boolean;
  /** Extra content after the card's own buttons (e.g. a less important alternative action). */
  after?: ReactNode;
  /** "full": the hint is information the decision rests on (shown unclamped in the phone bar; the card body carries it on desktop). */
  hintMode?: "short" | "full";
}) {
  const placement = hintPlacement(hintMode);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!bar) return;
    document.body.classList.add("has-action-bar");
    return () => document.body.classList.remove("has-action-bar");
  }, [bar]);
  // inputs and their validation messages live in the card; bring it into view — unless it is not rendered (display:none)
  const toCard = () => {
    const el = ref.current;
    if (el && el.getClientRects().length > 0) el.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const fromBar = () => {
    primary.onClick();
    toCard();
  };
  const second: BarAction | undefined =
    barSecondary ??
    (secondary && {
      label: secondary.barLabel ?? secondary.label,
      thisWill: secondary.thisWill,
      onClick: () => (secondary.onClick(), toCard()),
      disabled: secondary.disabled || secondary.pending,
    });
  const caption = barCaption(primary, second, error);
  return (
    <>
      <section
        ref={ref}
        className={`scroll-mt-[calc(var(--header-h,3.5rem)+var(--tabs-h,0px)+0.5rem)] overflow-hidden rounded border-secondary-container/70 bg-[#fff8f1] max-lg:border-l-4 max-lg:border-l-secondary-container lg:border-2 ${phoneCard ? "" : "max-lg:hidden"}`}
        aria-label={title ?? t("decision.needed")}
      >
        <div className="flex items-start gap-2 border-b border-secondary-container/30 px-3 py-2.5">
          <span className="mt-1.5 hidden size-2 shrink-0 animate-pulse-subtle rounded-full bg-secondary-container lg:block" />
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-on-secondary-container lg:hidden" aria-hidden />
          <div className="min-w-0">
            <div className="text-headline-sm text-on-surface max-lg:hidden">{title ?? t("decision.needed")}</div>
            <div className="text-headline-md text-on-surface lg:hidden">{phoneTitle ?? title ?? t("decision.needed")}</div>
            {subtitle && <div className="text-body-sm text-on-surface-variant max-lg:text-on-secondary-fixed-variant">{subtitle}</div>}
          </div>
        </div>
        <div className={`flex flex-col gap-3 p-3 ${children || after || !bar ? "" : "max-lg:hidden"}`}>
          {children}
          <div className={bar ? "hidden lg:flex lg:flex-col lg:gap-3" : "flex flex-col gap-3"}>
            <div className="flex flex-col gap-1.5">
              <Button variant="decision" size="lg" className="w-full" onClick={primary.onClick} disabled={primary.disabled || primary.pending}>
                {primary.pending ? t("common.loading") : primary.label}
              </Button>
              {hint && placement.inCard && <p className="text-body-sm font-semibold text-on-secondary-fixed-variant">{hint}</p>}
              <p className="text-body-sm text-on-secondary-fixed-variant">
                <span className="font-semibold">{t("common.thisWill")}</span> {primary.thisWill}
              </p>
            </div>
            {secondary && (
              <div className="flex flex-col gap-1.5 border-t border-secondary-container/30 pt-3">
                <Button className="w-full" onClick={secondary.onClick} disabled={secondary.disabled || secondary.pending}>
                  {secondary.label}
                </Button>
                <p className="text-body-sm text-slate-500">
                  <span className="font-semibold">{t("common.thisWill")}</span> {secondary.thisWill}
                </p>
              </div>
            )}
          </div>
          {after}
          {error && (
            // below lg the error is shown in the sticky bar instead (one alert per layout)
            <p role="alert" className={`text-body-sm text-rose-600 ${bar ? "max-lg:hidden" : ""}`}>
              {error}
            </p>
          )}
        </div>
      </section>
      {bar && (
      <div
        className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-1.5 border-t border-slate-200 bg-surface px-3 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-[0_-2px_8px_rgba(15,23,42,0.06)] lg:hidden"
        data-testid="decision-bar"
      >
        <div className="flex gap-2">
          {barExtra.map((x) => (
            <Button key={x.label} className="min-w-0 flex-1 border-0 bg-surface-container-high px-2 text-on-surface hover:bg-surface-container-highest" onClick={x.onClick} disabled={x.disabled}>
              <span className="min-w-0 truncate">{x.label}</span>
            </Button>
          ))}
          {second && (
            <Button className="min-w-0 flex-1 border-0 bg-surface-container-high text-on-surface hover:bg-surface-container-highest" onClick={second.onClick} disabled={second.disabled}>
              <span className="min-w-0 truncate">{second.label}</span>
            </Button>
          )}
          <Button variant="decision" className={cn("min-w-0 text-on-secondary-fixed", barExtra.length > 0 ? "flex-[2]" : "flex-[1.4]")} onClick={fromBar} disabled={primary.disabled || primary.pending}>
            <span className="min-w-0 truncate">{primary.pending ? t("common.loading") : (primary.barLabel ?? primary.label)}</span>
            <ArrowRight className="size-4 shrink-0" aria-hidden />
          </Button>
        </div>
        {hint && !caption.error && <p className={placement.barClass} data-testid="decision-hint">{hint}</p>}
        {caption.error && (
          <p role="alert" className="line-clamp-3 text-center text-body-sm text-rose-600">
            {caption.error}
          </p>
        )}
        {caption.lines.map((l) => (
          <p key={l.label ?? ""} className="line-clamp-3 text-center text-body-sm text-on-surface-variant">
            {l.label && <span className="font-semibold">{l.label} — </span>}
            <span className="font-semibold">{t("common.thisWill")}</span> {l.thisWill}
          </p>
        ))}
        {barExtra.filter((x) => x.thisWill).map((x) => (
          <p key={x.label} className="line-clamp-3 text-center text-body-sm text-on-surface-variant">
            <span className="font-semibold">{x.label} — </span>
            <span className="font-semibold">{t("common.thisWill")}</span> {x.thisWill}
          </p>
        ))}
      </div>
      )}
    </>
  );
}
