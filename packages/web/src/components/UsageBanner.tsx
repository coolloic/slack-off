import { Gauge, PauseCircle } from "lucide-react";
import { Link } from "react-router";
import { t } from "../i18n/en.ts";
import type { Status } from "../lib/api.ts";
import { bannerView } from "../lib/usage-model.ts";
import { cn } from "../lib/utils.ts";

/** The global usage banner: usage is paused (links to Cost & quota), or a threshold is in its warning zone. */
export function UsageBanner({ usage }: { usage: Status["usage"] | undefined }) {
  const v = bannerView(usage);
  if (v === null) return null;
  const Icon = v.kind === "paused" ? PauseCircle : Gauge;
  return (
    <Link
      to={v.to}
      role={v.kind === "paused" ? "alert" : "status"}
      data-testid="usage-banner"
      data-kind={v.kind}
      className={cn(
        "flex min-h-11 items-start justify-between gap-3 border-b px-4 py-2 text-body-md",
        v.kind === "paused" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-900",
      )}
    >
      <span className="flex min-w-0 items-start gap-2 break-words">
        <Icon className="mt-0.5 size-4 shrink-0" />
        {v.text}
      </span>
      <span className="shrink-0 font-semibold underline-offset-2">{t("banner.usageOpen")} →</span>
    </Link>
  );
}
