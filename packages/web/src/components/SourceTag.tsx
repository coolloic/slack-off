import type { AcSource } from "@slackoff/shared";
import { Link } from "react-router";
import { t } from "../i18n/en.ts";
import { focusLink, sourceTarget } from "../lib/sources.ts";
import { Badge } from "./ui/badge.tsx";
import { Tooltip } from "./ui/tooltip.tsx";

/** AC source chip: hover shows the original quote, click jumps to it in the Original snapshot tab. */
export function SourceTag({ ticketKey, source, snapshotId }: { ticketKey: string; source: AcSource; snapshotId?: number }) {
  if (source.type === "developer") {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Badge tone="info">{t("req.devAdded")}</Badge>
        <span className="truncate text-body-sm text-slate-600" title={source.reason}>
          {t("req.reason", { reason: source.reason })}
        </span>
      </span>
    );
  }
  const target = sourceTarget(source);
  const chip = <Badge tone={source.type === "attachment" ? "info" : "muted"}>{target.label}</Badge>;
  return (
    <Tooltip
      content={
        <span className="block">
          <span className="mb-1 block font-mono text-code-sm text-slate-500">{target.label}</span>
          <q className="italic">{source.quote || "—"}</q>
        </span>
      }
    >
      {target.anchorId ? (
        <Link to={focusLink(ticketKey, target.anchorId, snapshotId)} className="inline-flex shrink-0">
          {chip}
        </Link>
      ) : (
        <span className="inline-flex shrink-0">{chip}</span>
      )}
    </Tooltip>
  );
}
