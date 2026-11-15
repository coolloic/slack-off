import type { InputHTMLAttributes, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/utils.ts";

const field =
  "rounded border border-slate-200 bg-white px-2 text-body-sm text-on-surface placeholder:text-slate-400 focus:border-blue-600 focus:outline focus:outline-1 focus:outline-blue-600 disabled:bg-slate-50 disabled:text-slate-500";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, "h-10 md:h-7", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea className={cn(field, "py-1.5", className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(field, "h-10 pr-6 md:h-7", className)} {...props} />;
}
