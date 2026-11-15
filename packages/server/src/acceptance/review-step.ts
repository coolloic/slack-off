// Task 9: the review loop's next step, derived from stored state only (ruling R7), so a restart, a retry or a re-review
// lands on the same decision as an uninterrupted run.
import type { IterationRecord, ReviewReportRecord, ReviewSeriesRecord, ReviewStep } from "@slackoff/shared";

export interface ReviewStepInput {
  series: ReviewSeriesRecord;
  /** the current series' reports */
  reports: readonly ReviewReportRecord[];
  /** the decisions on the current series' reports */
  decisions: readonly { reportId: number; decision: "rejected" | "re_review" | "confirmed" }[];
  /** the previous series' latest report; used only while the current series has no report */
  carry: ReviewReportRecord | null;
  /** every development iteration of the ticket */
  iterations: readonly IterationRecord[];
  maxAttempts: number;
}

/**
 * Attempts count in the current series only. last = the series' latest report, else the carry:
 * - last failed with no completed iteration after it: the series' own → fix(last) below the cap, else cap_reached;
 *   the carry (a new round after the cap) → fix(carry);
 * - last passed / not_executed, the series' own, no completed iteration after it and no re_review decision on it →
 *   await_decision;
 * - otherwise accept(attempts + 1) below the cap, else cap_reached.
 * An iteration is "after" a report when its id is larger than the ticket's latest iteration id when the report was
 * saved (T9-6 L1; rows from before migration 10: when it started at or after the report was saved).
 */
export function nextReviewStep(s: ReviewStepInput): ReviewStep {
  const attempts = s.reports.length;
  const own = s.reports.at(-1) ?? null;
  const last = own ?? s.carry;
  // T9-6 (L1): by id — the latest iteration id when the report was saved; the clock only for rows that lack it
  const fixedSince = (r: ReviewReportRecord) =>
    s.iterations.some((i) =>
      i.status === "done" && (r.afterIterationId !== undefined && r.afterIterationId !== null ? i.id > r.afterIterationId : i.startedAt >= r.createdAt),
    );
  const below = attempts < s.maxAttempts;

  if (last !== null && !fixedSince(last)) {
    if (last.verdict === "failed") {
      if (own === null) return { kind: "fix", reportId: last.id };
      return below ? { kind: "fix", reportId: last.id } : { kind: "cap_reached", attempts };
    }
    if (own !== null) {
      const latest = s.decisions.filter((d) => d.reportId === own.id).at(-1);
      if (latest?.decision !== "re_review") return { kind: "await_decision", reportId: own.id };
    }
  }
  return below ? { kind: "accept", attempt: attempts + 1 } : { kind: "cap_reached", attempts };
}
