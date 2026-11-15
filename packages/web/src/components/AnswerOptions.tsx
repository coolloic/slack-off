import { Star } from "lucide-react";
import { t } from "../i18n/en.ts";
import { orderOptions, type AnswerOption } from "../lib/answer-options.ts";
import { cn } from "../lib/utils.ts";

/**
 * Suggested answers to a decision (memory: decisions with options): the recommended one first and marked; a click
 * fills the answer box with the option's full text, which the developer can still edit or replace.
 */
export function AnswerOptions({ options, current, onPick }: { options: readonly AnswerOption[]; current: string; onPick: (text: string) => void }) {
  const list = orderOptions(options);
  if (list.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="answer-options">
      <span className="text-label-md">{t("answers.suggested")}</span>
      <div className="flex flex-wrap gap-2">
        {list.map((o, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPick(o.text)}
            aria-pressed={current.trim() === o.text.trim()}
            title={o.text}
            className={cn(
              "flex min-h-11 max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-left text-body-sm md:min-h-8",
              current.trim() === o.text.trim() ? "border-primary bg-primary text-white" : o.recommended ? "border-primary bg-white text-primary" : "border-slate-300 bg-white text-on-surface",
            )}
          >
            {o.recommended && <Star className="size-3.5 shrink-0" aria-hidden />}
            <span className="min-w-0 break-words">{o.label}</span>
            {o.recommended && <span className="shrink-0 font-semibold">· {t("answers.recommended")}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
