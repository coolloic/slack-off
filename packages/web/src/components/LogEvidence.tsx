// Phase 4f (Task 5): a case's command and output (a `log` evidence file) as a monospace block. Plain text only: the
// text is a React text child (textContent), never HTML or Markdown. The block scrolls sideways inside itself; the page
// never does (390px). More than 20 lines start folded behind "Show all".
import { useEffect, useState } from "react";
import { t } from "../i18n/en.ts";
import { api } from "../lib/api.ts";
import { logModel, visibleLines, type LogModel } from "../lib/review-model.ts";

export function LogEvidence({ ticketKey, id, caption }: { ticketKey: string; id: number; caption: string }) {
  const [state, setState] = useState<{ model: LogModel } | { error: true } | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let live = true;
    setState(null);
    api
      .evidenceText(ticketKey, id)
      .then((text) => live && setState({ model: logModel(text) }))
      .catch(() => live && setState({ error: true }));
    return () => {
      live = false;
    };
  }, [ticketKey, id]);
  return (
    <figure className="flex min-w-0 max-w-full flex-col overflow-hidden rounded border border-slate-700 bg-slate-900 text-slate-100" data-testid="log-evidence">
      <figcaption className="border-b border-slate-700 px-2 py-1 text-body-sm text-slate-300 [overflow-wrap:anywhere]">{caption}</figcaption>
      {state === null && <p className="px-2 py-1.5 text-body-sm text-slate-400">{t("lb.loading")}</p>}
      {state !== null && "error" in state && (
        <p role="alert" className="px-2 py-1.5 text-body-sm text-rose-300">
          {t("lb.failed")}
        </p>
      )}
      {state !== null && "model" in state && (
        <>
          {state.model.title !== null && (
            <div className="max-w-full overflow-x-auto border-b border-slate-700 px-2 py-1 font-mono text-code-sm font-semibold whitespace-pre" data-testid="log-command">
              {state.model.title}
            </div>
          )}
          {state.model.example !== null && (
            // 4F-8 (I-2): a library case's example code, its own block above the output; scrolls inside itself (390px)
            <div className="min-w-0 max-w-full border-b border-slate-700" data-testid="log-example">
              <p className="px-2 pt-1 text-body-sm text-slate-300 [overflow-wrap:anywhere]">{t("acc.logExample", { name: state.model.example.name })}</p>
              <pre className="m-0 max-h-64 max-w-full overflow-auto px-2 py-1.5 font-mono text-code-sm whitespace-pre text-sky-100">{state.model.example.lines.join("\n")}</pre>
              {state.model.example.cut && <p className="px-2 pb-1 text-body-sm text-amber-300">{t("acc.logExampleCut")}</p>}
            </div>
          )}
          <pre className="m-0 max-h-96 max-w-full overflow-auto px-2 py-1.5 font-mono text-code-sm whitespace-pre" data-testid="log-text">
            {visibleLines(state.model, expanded).join("\n")}
          </pre>
          {state.model.truncated && <p className="px-2 py-1 text-body-sm text-amber-300">{t("acc.logTruncated")}</p>}
          {state.model.folded && (
            <button type="button" onClick={() => setExpanded(!expanded)} className="min-h-11 border-t border-slate-700 px-2 text-left text-body-sm font-semibold text-sky-300 hover:bg-slate-800 md:min-h-8">
              {expanded ? t("acc.logShowLess") : t("acc.logShowAll", { n: state.model.lines.length })}
            </button>
          )}
        </>
      )}
    </figure>
  );
}
