import type { Ruling } from "@slackoff/shared";

/**
 * In-memory drafts the WebMCP drafting tools leave for the ticket pages (task 18, ruling W-1). A draft only fills a
 * form: nothing here talks to the server and nothing is persisted (a reload drops it). The developer reviews the
 * page and presses the button themselves. A draft whose page is not opened within DRAFT_TTL_MS is dropped
 * (phase 4e Task 5), so an old, forgotten draft never fills a form days later.
 */
export type Draft =
  | { kind: "note"; ticketKey: string; text: string }
  | { kind: "ac_edit"; ticketKey: string; acId: string; text: string }
  | { kind: "ruling"; ticketKey: string; rulings: Array<Pick<Ruling, "commentId" | "decision" | "note">> };

export type DraftKind = Draft["kind"];

/** How long a draft waits for its page to mount before it is dropped. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const store = new Map<string, { draft: Draft; at: number }>();
const listeners = new Set<() => void>();

const id = (kind: DraftKind, ticketKey: string) => `${kind}:${ticketKey}`;

export function setDraft(d: Draft, at: number = Date.now()): void {
  store.set(id(d.kind, d.ticketKey), { draft: d, at });
  for (const l of [...listeners]) l();
}

export function peekDraft<K extends DraftKind>(kind: K, ticketKey: string, now: number = Date.now()): Extract<Draft, { kind: K }> | undefined {
  const key = id(kind, ticketKey);
  const entry = store.get(key);
  if (entry === undefined) return undefined;
  if (now - entry.at > DRAFT_TTL_MS) {
    store.delete(key); // expired: dropped, never applied
    return undefined;
  }
  return entry.draft as Extract<Draft, { kind: K }>;
}

/** Read a draft once: a page applies it and it is gone, so a later visit starts from the page's own state. */
export function takeDraft<K extends DraftKind>(kind: K, ticketKey: string, now: number = Date.now()): Extract<Draft, { kind: K }> | undefined {
  const d = peekDraft(kind, ticketKey, now);
  store.delete(id(kind, ticketKey));
  return d;
}

export function subscribeDrafts(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function clearDrafts(): void {
  store.clear();
}
