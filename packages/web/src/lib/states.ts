import type { TicketState } from "@slackoff/shared";
import { t, type MessageKey } from "../i18n/en.ts";

export type Tone = "queued" | "running" | "decision" | "done" | "blocked" | "muted";

export const NEEDS_YOU: readonly TicketState[] = [
  "awaiting_ac_review",
  "awaiting_drift_ack",
  "awaiting_choice",
  "awaiting_debate_ruling",
  "awaiting_snapshot_ack",
  "dev_done",
  "awaiting_review_ack",
  "awaiting_confirmation",
  "blocked",
];

const TONE: Record<TicketState, Tone> = {
  discovered: "queued",
  refining: "running",
  refined: "running",
  awaiting_ac_review: "decision",
  checking_drift: "running",
  awaiting_drift_ack: "decision",
  proposing: "running",
  awaiting_choice: "decision",
  designing: "running",
  awaiting_debate_ruling: "decision",
  design_final: "done",
  checking_snapshot: "running",
  awaiting_snapshot_ack: "decision",
  developing: "running",
  dev_done: "decision",
  reviewing: "running",
  awaiting_review_ack: "decision",
  awaiting_confirmation: "decision",
  delivering: "running",
  pr_opened: "done",
  blocked: "blocked",
  abandoned: "muted",
};

export const stateTone = (s: TicketState): Tone => TONE[s];
export const stateLabel = (s: TicketState): string => t(`state.${s}` as MessageKey);

/** Steps of the StateStepper; each lists the states that belong to it. */
export const STEPS: ReadonlyArray<{ id: string; states: readonly TicketState[] }> = [
  { id: "discovered", states: ["discovered"] },
  { id: "refining", states: ["refining"] },
  { id: "refined", states: ["refined"] },
  { id: "acReview", states: ["awaiting_ac_review", "checking_drift", "awaiting_drift_ack"] },
  { id: "proposing", states: ["proposing"] },
  { id: "choice", states: ["awaiting_choice"] },
  { id: "design", states: ["designing", "awaiting_debate_ruling", "design_final"] },
  { id: "develop", states: ["checking_snapshot", "awaiting_snapshot_ack", "developing", "dev_done"] },
  { id: "review", states: ["reviewing", "awaiting_review_ack", "awaiting_confirmation"] },
  { id: "pr", states: ["delivering", "pr_opened"] },
];

export function stepIndex(s: TicketState): number {
  return STEPS.findIndex((step) => step.states.includes(s));
}
