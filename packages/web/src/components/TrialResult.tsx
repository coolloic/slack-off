import { AlertTriangle, FlaskConical } from "lucide-react";
import { t } from "../i18n/en.ts";
import type { TrialResult as Result } from "../lib/api.ts";
import { trialSummary } from "../lib/prompt-model.ts";

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="text-body-sm text-slate-500">{t("prompts.trialNone")}</p>;
  return (
    <ul className="flex list-disc flex-col gap-0.5 pl-5 text-body-sm">
      {items.map((x, i) => (
        <li key={i} className="break-words">
          {x}
        </li>
      ))}
    </ul>
  );
}

/** Phase 4d Task 5: a trial run's outcome. Agent text is shown as text only, wrapped (never sideways on a phone). */
export function TrialResult({ result }: { result: Result }) {
  const s = result.ok ? trialSummary(result.role, result.output) : null;
  const secs = (result.durationMs / 1000).toFixed(1);
  const cost = result.costUsd === null ? "-" : `$${result.costUsd.toFixed(2)}`;
  return (
    <section data-testid="trial-result" className="flex min-w-0 flex-col gap-2 rounded border border-slate-200 bg-white p-3">
      <p className="flex items-start gap-2 rounded bg-amber-50 px-2 py-1.5 text-body-sm text-amber-900">
        <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>{t("prompts.trialBanner")}</span>
      </p>
      <span className="font-mono text-code-sm text-slate-500">
        {result.role} · {t("prompts.trialMeta", { s: secs, cost })}
      </span>
      {!result.ok && (
        <div role="alert" className="flex items-start gap-2 text-body-sm text-rose-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            <span className="font-semibold">{t("prompts.trialFailed")}:</span> {result.error}
          </span>
        </div>
      )}
      {s?.kind === "refine" && (
        <>
          <span className="text-headline-sm">{t("prompts.trialAcs")}</span>
          <List items={s.acs} />
          <span className="text-headline-sm">{t("prompts.trialUnclear")}</span>
          <List items={s.unclear} />
        </>
      )}
      {s?.kind === "propose" && (
        <>
          <span className="text-headline-sm">{t("prompts.trialSolutions")}</span>
          <List items={s.solutions} />
        </>
      )}
      {s?.kind === "design" && (
        <>
          <span className="text-headline-sm">{t("prompts.trialDesign")}</span>
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 font-mono text-code-md">
            {s.lines.join("\n")}
            {s.more ? "\n..." : ""}
          </pre>
        </>
      )}
      {s?.kind === "critique" && (
        <>
          <span className="text-headline-sm">{t("prompts.trialCritique", { b: s.blocking, n: s.nonBlocking })}</span>
          <List items={s.first} />
        </>
      )}
    </section>
  );
}
