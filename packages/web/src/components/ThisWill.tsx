import { t } from "../i18n/en.ts";
import { cn } from "../lib/utils.ts";

/** "This will: …" explanation shown next to every decision/side-effect button. */
export function ThisWill({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("font-mono text-code-sm text-slate-500 max-md:font-sans max-md:text-body-sm", className)}>
      <span className="font-semibold">{t("common.thisWill")}</span> {children}
    </span>
  );
}
