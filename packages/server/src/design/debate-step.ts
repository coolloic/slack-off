import { isCritique, type DebateRoundRecord, type DebateStep, type RulingRecord } from "@slackoff/shared";
import type { DesignDocRecord } from "./design-repo.ts";

export type { DebateStep };

export interface DebateState {
  /** design docs, rounds and rulings of the current choice only */
  docs: readonly DesignDocRecord[];
  rounds: readonly DebateRoundRecord[];
  rulings: readonly RulingRecord[];
  maxRounds: number;
}

/** The highest version, or undefined when there is none. */
export function latestDoc(docs: readonly DesignDocRecord[]): DesignDocRecord | undefined {
  return docs.reduce<DesignDocRecord | undefined>((m, d) => (!m || d.version > m.version ? d : m), undefined);
}

/**
 * The next step of the design debate, derived from stored state only (resumable after a restart):
 * - no doc → draft;
 * - latest doc reviewed: no blocking comment → finalize it, else revise (answer the blocking comments);
 * - latest doc not reviewed and the last critic round already ruled (whatever maxRounds is now: raising the cap after
 *   escalation must not drop the developer's rulings): all for the designer → finalize the latest doc; rulings applied
 *   (the latest doc is a later version than the escalated revision, P-C1) → finalize; else apply_rulings;
 * - otherwise fewer critic rounds than maxRounds → critique the next round, else escalate.
 */
export function nextDebateStep(s: DebateState): DebateStep {
  const latest = latestDoc(s.docs);
  if (!latest) return { kind: "draft" };
  const critics = s.rounds.filter((r) => r.role === "critic");
  const review = critics.filter((r) => r.designDocId === latest.id).at(-1);
  if (review && isCritique(review.content)) {
    const blocking = review.content.comments.filter((c) => c.blocking).map((c) => c.id);
    if (blocking.length === 0) return { kind: "finalize", docId: latest.id };
    return { kind: "revise", round: review.round, mustAnswer: blocking };
  }
  const lastRound = critics.reduce((m, r) => Math.max(m, r.round), 0);
  const lastCritic = critics.filter((r) => r.round === lastRound).at(-1);
  const rulings = lastCritic ? s.rulings.filter((r) => r.debateRoundId === lastCritic.id) : [];
  if (lastCritic && rulings.length > 0) {
    const toApply = rulings.filter((r) => r.decision !== "designer").map((r) => r.commentId);
    if (toApply.length === 0) return { kind: "finalize", docId: latest.id };
    // the escalated doc is the revision answering the last critic round; a later version applied the rulings.
    // Structural only: timestamps can tie or step back (P-C1).
    const escalatedDoc = s.rounds.filter((r) => r.role === "designer" && r.round === lastRound).at(-1)?.designDocId;
    const escalatedVersion = s.docs.find((d) => d.id === escalatedDoc)?.version;
    if (escalatedVersion === undefined) {
      throw new Error(`inconsistent debate: round ${lastRound} was ruled but has no designer revision`);
    }
    if (latest.version > escalatedVersion) return { kind: "finalize", docId: latest.id };
    return { kind: "apply_rulings", roundId: lastCritic.id, mustAnswer: toApply };
  }
  if (lastRound < s.maxRounds) return { kind: "critique", round: lastRound + 1 };
  return { kind: "escalate" };
}
