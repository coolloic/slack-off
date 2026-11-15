import type { TicketState } from "@slackoff/shared";

/** The ticket page's tabs, in order (P-C11: one list for TicketPage and TicketsPage). */
export const TABS = ["snapshot", "requirements", "coverage", "solutions", "design", "development", "acceptance", "delivery"] as const;
export type Tab = (typeof TABS)[number];

export const isTab = (s: string | undefined): s is Tab => s !== undefined && (TABS as readonly string[]).includes(s);

/** The tab a ticket opens on: where its current decision or activity is. */
export function defaultTab(state: TicketState, prevState?: TicketState | null): Tab {
  switch (state) {
    case "blocked":
      // a blocked ticket opens where it stopped (the state before it, which the server keeps only for blocked)
      if (prevState === "delivering") return "delivery";
      if (prevState === "reviewing") return "acceptance";
      return "requirements";
    case "discovered":
      return "snapshot";
    case "awaiting_drift_ack":
    case "awaiting_snapshot_ack":
      return "coverage";
    case "proposing":
    case "awaiting_choice":
      return "solutions";
    case "designing":
    case "awaiting_debate_ruling":
    case "design_final":
      return "design";
    case "checking_snapshot":
    case "developing":
    case "dev_done":
      return "development";
    case "reviewing":
    case "awaiting_confirmation":
      return "acceptance";
    case "awaiting_review_ack":
      return "coverage";
    case "delivering":
    case "pr_opened":
      return "delivery";
    default:
      return "requirements";
  }
}
