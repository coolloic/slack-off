export interface CaptionLine {
  /** null = the primary action's caption; otherwise the secondary action's label. */
  label: string | null;
  thisWill: string;
}

/**
 * Caption under the phone sticky decision bar. A failed (or blocked) action's error always shows, as an alert,
 * whatever the disabled state; it replaces the primary caption. A secondary that changes state (has `thisWill`)
 * keeps its own "This will:" line; navigation-only secondaries get none.
 */
export function barCaption(
  primary: { thisWill: string },
  secondary: { label: string; thisWill?: string } | undefined,
  error: string | undefined,
): { error: string | null; lines: CaptionLine[] } {
  const lines: CaptionLine[] = error ? [] : [{ label: null, thisWill: primary.thisWill }];
  if (secondary?.thisWill) lines.push({ label: secondary.label, thisWill: secondary.thisWill });
  return { error: error ?? null, lines };
}

/**
 * Where a DecisionCard hint shows. `short` (why the primary is disabled): next to the desktop buttons and clamped to two
 * lines in the phone bar. `full` (e.g. the JIRA write's repos-disagree note, T12-3): the card body already shows it on
 * desktop, and the phone bar shows it unclamped, so it is read in full before the primary is tapped.
 */
export function hintPlacement(mode: "short" | "full"): { inCard: boolean; barClass: string } {
  return mode === "full"
    ? { inCard: false, barClass: "text-center text-body-sm font-semibold text-on-secondary-fixed-variant" }
    : { inCard: true, barClass: "line-clamp-2 text-center text-body-sm font-semibold text-on-secondary-fixed-variant" };
}
