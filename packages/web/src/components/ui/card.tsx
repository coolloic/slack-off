import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded border border-slate-200 bg-white", className)} {...props} />;
}

export function CardHeader({ title, icon, right, className }: { title: ReactNode; icon?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-8 items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5", className)}>
      <div className="flex items-center gap-2 text-label-sm font-semibold uppercase tracking-[0.05em] text-slate-700">
        {icon}
        {title}
      </div>
      {right && <div className="font-mono text-code-sm text-slate-500">{right}</div>}
    </div>
  );
}
