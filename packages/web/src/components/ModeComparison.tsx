import { t } from "../i18n/en.ts";
import { modeComparison } from "../lib/settings-model.ts";

/**
 * Phase 4b Task 7: the comparison of the two modes (spec §7.1 for the executor, the 4b plan's table for JIRA).
 * From md up a three-column table; on a phone one card per row (aspect), each value under its column heading, so
 * nothing scrolls sideways at 390px.
 */
export function ModeComparison({ kind }: { kind: "executor" | "jira" }) {
  const c = modeComparison(kind);
  return (
    <details className="group min-w-0 border-t border-slate-200 pt-2" data-testid={`compare-${kind}`}>
      <summary className="flex min-h-11 cursor-pointer items-center text-label-md text-primary md:min-h-8">{t("settings.compareModes")}</summary>
      <table className="hidden w-full table-fixed text-left text-body-sm md:table">
        <thead>
          <tr className="border-b border-slate-200 font-mono text-[10.5px] uppercase tracking-wide text-slate-500">
            <th className="w-1/5 py-1.5 pr-2 font-medium" />
            <th className="py-1.5 pr-2 font-medium">{c.columns[0]}</th>
            <th className="py-1.5 font-medium">{c.columns[1]}</th>
          </tr>
        </thead>
        <tbody>
          {c.rows.map((r) => (
            <tr key={r.label} className="border-b border-slate-100 align-top last:border-b-0">
              <th scope="row" className="py-1.5 pr-2 font-semibold text-slate-700">
                {r.label}
              </th>
              <td className="py-1.5 pr-2 text-slate-700">{r.values[0]}</td>
              <td className="py-1.5 text-slate-700">{r.values[1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col gap-2 md:hidden" data-testid={`compare-${kind}-cards`}>
        {c.rows.map((r) => (
          <li key={r.label} className="flex min-w-0 flex-col gap-1 rounded border border-slate-200 p-2.5 text-body-sm" data-testid="compare-card">
            <span className="font-semibold text-slate-800">{r.label}</span>
            {c.columns.map((col, i) => (
              <span key={col} className="flex min-w-0 flex-col">
                <span className="text-label-sm text-slate-500">{col}</span>
                <span className="break-words text-slate-700">{r.values[i]}</span>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}
