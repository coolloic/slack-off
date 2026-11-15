import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import { t } from "../i18n/en.ts";

/** Custom font sizes from the @theme `--text-*` tokens in index.css (F-I5): without them twMerge reads
 * `text-label-md` as a colour and drops `text-white`. */
export const FONT_SIZES = ["headline-lg", "headline-md", "headline-sm", "body-md", "body-sm", "label-md", "label-sm", "code-lg", "code-md", "code-sm", "kbd"];

const twMerge = extendTailwindMerge({ extend: { theme: { text: FONT_SIZES } } });

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return t("time.justNow");
  const m = Math.round(s / 60);
  if (m < 60) return t("time.minutes", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return t("time.hours", { n: h });
  return t("time.days", { n: Math.round(h / 24) });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Paragraphs are separated by blank lines (skills/refine-ticket: description#p<n> is 1-based). */
export function paragraphs(text: string | null | undefined): string[] {
  return (text ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * A ticket tab's right rail on desktop: it stays in view under the app header and the sticky tab strip while the
 * page scrolls, and scrolls on its own when taller than the screen. Phones keep their own sticky decision bar.
 */
export const STICKY_RAIL =
  "lg:sticky lg:top-[calc(var(--header-h,4rem)+var(--tabs-h,0px)+1rem)] lg:self-start lg:max-h-[calc(100dvh-var(--header-h,4rem)-var(--tabs-h,0px)-2rem)] lg:overflow-y-auto";
