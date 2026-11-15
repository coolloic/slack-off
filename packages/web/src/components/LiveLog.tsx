import { Radio } from "lucide-react";
import { useEffect, useRef } from "react";
import { t } from "../i18n/en.ts";
import type { AgentRole } from "../lib/api.ts";
import { agentName } from "../lib/agent-name.ts";
import { useAgentEvents } from "../lib/hooks.ts";
import { cn } from "../lib/utils.ts";

/** The ticket's live agent activity (last events from SSE, P-C10). Agent text is shown as text only. */
export function LiveLog({ ticketKey, roles, className, limit = 60 }: { ticketKey: string; roles?: readonly AgentRole[]; className?: string; limit?: number }) {
  const events = useAgentEvents(ticketKey, roles);
  const shown = events.slice(-limit);
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, events]);
  return (
    <section className={cn("flex min-w-0 flex-col gap-1.5", className)} aria-label={t("design.live")} data-testid="live-log">
      <span className="flex items-center gap-1.5 text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-600">
        <Radio className="size-3.5 text-primary" aria-hidden />
        {t("design.live")}
      </span>
      {shown.length === 0 ? (
        <p className="text-body-sm text-slate-500">{t("design.liveEmpty")}</p>
      ) : (
        <ol ref={box} className="flex max-h-56 flex-col gap-0.5 overflow-y-auto overflow-x-hidden rounded bg-slate-900 p-2 font-mono text-code-sm text-slate-100">
          {shown.map((e, i) => (
            <li key={i} className="min-w-0 whitespace-pre-wrap break-words">
              {/* the agent's own words in full; what it does (a tool call, its start) quieter */}
              <span className="text-sky-300">{agentName(e.role)}</span> <span className={e.kind === "text" ? "text-slate-100" : "text-slate-400"}>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
