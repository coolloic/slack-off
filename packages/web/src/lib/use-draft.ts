import { useEffect, useRef } from "react";
import { subscribeDrafts, takeDraft, type Draft, type DraftKind } from "./drafts.ts";

/** Apply a WebMCP draft for this ticket when the page mounts and whenever a new one arrives while it is open (a draft
 * older than 24 hours is dropped instead: drafts.ts DRAFT_TTL_MS). */
export function useDraft<K extends DraftKind>(kind: K, ticketKey: string, apply: (d: Extract<Draft, { kind: K }>) => void, enabled = true): void {
  const ref = useRef(apply);
  ref.current = apply;
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      const d = takeDraft(kind, ticketKey);
      if (d) ref.current(d);
    };
    run();
    return subscribeDrafts(run);
  }, [kind, ticketKey, enabled]);
}
