import type { AgentRole } from "@slackoff/shared";

export interface AgentEventEntry {
  ticketKey: string;
  role: AgentRole;
  runId: string;
  kind: string;
  text: string;
}

/** Longest event text kept (2 KB): a huge tool result must not bloat the page. */
const MAX_TEXT = 2048;

const EMPTY: readonly AgentEventEntry[] = Object.freeze([]);

/** Live agent events per ticket, the last `limit` of each (first in, first out). Arrays are replaced, never mutated. */
export class EventBuffer {
  private readonly byKey = new Map<string, readonly AgentEventEntry[]>();
  private readonly subs = new Set<() => void>();
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }

  push(raw: AgentEventEntry): void {
    const e = raw.text.length > MAX_TEXT ? { ...raw, text: raw.text.slice(0, MAX_TEXT - 1) + "…" } : raw;
    const prev = this.byKey.get(e.ticketKey) ?? EMPTY;
    const next = prev.length >= this.limit ? [...prev.slice(prev.length - this.limit + 1), e] : [...prev, e];
    this.byKey.set(e.ticketKey, next);
    for (const fn of [...this.subs]) fn();
  }

  /** Forget the key's events (a new trial run starts with an empty log). */
  clear(key: string): void {
    if (!this.byKey.has(key)) return;
    this.byKey.delete(key);
    for (const fn of [...this.subs]) fn();
  }

  get(key: string): readonly AgentEventEntry[] {
    return this.byKey.get(key) ?? EMPTY;
  }

  filter(key: string, roles?: readonly AgentRole[]): AgentEventEntry[] {
    const all = this.get(key);
    return roles ? all.filter((e) => roles.includes(e.role)) : [...all];
  }

  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
