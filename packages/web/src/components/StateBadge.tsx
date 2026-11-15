import type { TicketState } from "@slackoff/shared";
import { stateLabel, stateTone } from "../lib/states.ts";
import { Badge } from "./ui/badge.tsx";

export function StateBadge({ state, className }: { state: TicketState; className?: string }) {
  const tone = stateTone(state);
  return (
    <Badge tone={tone} pulse={tone === "decision"} className={className}>
      <span className="min-w-0 truncate">{stateLabel(state)}</span>
    </Badge>
  );
}
