import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent bg-slate-300 transition-colors before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-[''] data-[state=checked]:bg-primary-container disabled:opacity-50 md:h-4 md:w-7 md:before:hidden",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[20px] md:size-3 md:data-[state=checked]:translate-x-[13px]" />
    </SwitchPrimitive.Root>
  );
}
