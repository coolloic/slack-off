import type { TicketState } from "@slackoff/shared";
import { Check, ChevronRight } from "lucide-react";
import { t, type MessageKey } from "../i18n/en.ts";
import { STEPS, stepIndex } from "../lib/states.ts";
import { cn } from "../lib/utils.ts";

export function StateStepper({ state, prevState }: { state: TicketState; prevState: TicketState | null }) {
  const effective = (state === "blocked" || state === "abandoned") && prevState ? prevState : state;
  const current = stepIndex(effective);
  return (
    <ol className="scroll-x flex flex-nowrap items-center gap-1 border-b border-slate-200 bg-surface-container-low px-4 py-1.5" aria-label={t("step.aria")}>
      {STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step.id} className="flex shrink-0 items-center gap-1">
            {i > 0 && <ChevronRight className="size-3 text-slate-300" aria-hidden />}
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex h-6 items-center gap-1 whitespace-nowrap rounded-[3px] px-1.5 font-mono text-code-sm",
                done && "text-emerald-700",
                active && state === "blocked" && "border border-rose-200 bg-rose-50 font-semibold text-rose-600",
                active && state !== "blocked" && "border border-amber-200 bg-amber-50 font-semibold text-amber-800",
                !done && !active && "text-slate-400",
              )}
            >
              {done && <Check className="size-3" aria-hidden />}
              {active && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
              {t(`step.${step.id}` as MessageKey)}
              {active && <span className="ml-1 text-[10px] uppercase opacity-70">{t("step.current")}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
