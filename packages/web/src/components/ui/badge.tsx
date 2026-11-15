import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px] border px-1.5 font-mono text-code-sm",
  {
    variants: {
      tone: {
        queued: "border-slate-200 bg-slate-50 text-slate-500",
        running: "border-blue-200 bg-blue-50 text-blue-600",
        decision: "border-amber-200 bg-amber-50 text-amber-700",
        done: "border-emerald-200 bg-emerald-50 text-emerald-700",
        blocked: "border-rose-200 bg-rose-50 text-rose-600",
        muted: "border-slate-200 bg-slate-100 text-slate-500",
        info: "border-primary-fixed-dim bg-primary-fixed text-on-primary-fixed-variant",
      },
    },
    defaultVariants: { tone: "muted" },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { pulse?: boolean };

export function Badge({ className, tone, pulse, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {pulse && <span className="size-1.5 animate-pulse-subtle rounded-full bg-amber-500" />}
      {children}
    </span>
  );
}
