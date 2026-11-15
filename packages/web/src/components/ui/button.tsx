import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium text-label-md transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary-container",
  {
    variants: {
      variant: {
        primary: "bg-slate-900 text-white hover:bg-slate-800",
        secondary: "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
        decision: "bg-secondary-container text-white hover:bg-[#f0841c]",
        blue: "bg-primary text-white hover:bg-primary-container",
        destructive: "border border-rose-200 bg-white text-rose-600 hover:bg-rose-50",
        ghost: "text-on-surface-variant hover:bg-slate-100 hover:text-on-surface",
      },
      size: {
        // mobile-first: >= 36/44px touch targets on phones, dense DESIGN.md sizes from md up
        sm: "h-9 px-3 text-label-sm md:h-6 md:px-2",
        md: "h-11 px-3 md:h-7 md:px-2.5",
        lg: "h-11 px-4 text-headline-sm md:h-9",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
