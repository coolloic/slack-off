import type { DriftResult } from "@slackoff/shared";
import { t, type MessageKey } from "../i18n/en.ts";

/** Items that need the developer's acknowledgement (spec §9.9): non-covered baseline items, unsourced new ACs and contradictions. */
export function ackItems(r: DriftResult): string[] {
  return [
    ...r.baseline.filter((b) => b.status !== "covered").map((b) => `${b.id} ${t(`cov.status.${b.status}` as MessageKey).toLowerCase()}${b.note ? ` — ${b.note}` : ""}`),
    ...r.current.filter((c) => c.status === "new_unsourced").map((c) => `${c.id} ${t("cov.status.new_unsourced").toLowerCase()}`),
    ...r.contradictions.map((c) => `${c.acId} ${t("cov.contradicts")} — ${c.explanation}`),
  ];
}

export interface ContradictionRow {
  acId: string;
  acText: string | null;
  quote: string;
  explanation: string;
}

/** Which current AC contradicts which baseline quote — the same data on desktop (Matrix) and phones. */
export function contradictionRows(r: DriftResult, acById: ReadonlyMap<string, { text: string }>): ContradictionRow[] {
  return r.contradictions.map((c) => ({ acId: c.acId, acText: acById.get(c.acId)?.text ?? null, quote: c.quote, explanation: c.explanation }));
}

export type AckPanelMode = "proceed" | "review" | "snapshot" | "acceptance";

/**
 * F-I4: when to show the acknowledgement panel. `proceed`: awaiting_drift_ack, ack starts proposing.
 * `review`: back in AC review with the latest requirement's drift still unacknowledged — ack only, so Confirm unlocks (R13).
 * `acceptance`: the JIRA ticket changed before acceptance (awaiting_review_ack) — ack starts acceptance, or re-plan.
 * `snapshot`: the JIRA ticket changed after the design (awaiting_snapshot_ack) — ack starts development, or re-plan.
 */
export function ackPanelMode(
  state: string,
  drift: { requirementId: number; needsAck: boolean; acknowledged: boolean } | null,
  latestRequirementId: number | undefined,
): AckPanelMode | null {
  if (!drift || !drift.needsAck || drift.acknowledged) return null;
  if (state === "awaiting_drift_ack") return "proceed";
  if (state === "awaiting_snapshot_ack") return "snapshot";
  if (state === "awaiting_review_ack") return "acceptance";
  if (state === "awaiting_ac_review" && drift.requirementId === latestRequirementId) return "review";
  return null;
}
