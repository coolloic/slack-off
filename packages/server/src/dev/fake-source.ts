import type { DiscoverResult, FetchedTicket } from "@slackoff/shared";
import type { TicketSource } from "../jira/ticket-source.ts";

/** Programmable TicketSource: set `discoverResult` / `tickets[key]`; a value that is an Error is thrown. */
export class FakeTicketSource implements TicketSource {
  discoverResult: DiscoverResult | Error = { loginRequired: false, tickets: [], total: 0, complete: true };
  tickets: Record<string, FetchedTicket | Error> = {};
  /**
   * What JIRA shows from the second read of a ticket on (it changed in JIRA after it was first read): read n (n ≥ 2)
   * returns `laterReads[key][min(n - 2, length - 1)]`.
   */
  laterReads: Record<string, FetchedTicket[]> = {};
  #reads = new Map<string, number>();
  calls: string[] = [];
  /** Answer after this many ms (0 = next microtask), so callers exercise the asynchronous path. */
  delayMs = 0;

  async #wait(): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
  }

  async discover(): Promise<DiscoverResult> {
    this.calls.push("discover");
    await this.#wait();
    if (this.discoverResult instanceof Error) throw this.discoverResult;
    return this.discoverResult;
  }

  async fetchTicket(key: string): Promise<FetchedTicket> {
    this.calls.push(`fetch:${key}`);
    await this.#wait();
    const n = (this.#reads.get(key) ?? 0) + 1;
    this.#reads.set(key, n);
    const later = this.laterReads[key];
    const t = n > 1 && later !== undefined && later.length > 0 ? later[Math.min(n - 2, later.length - 1)] : this.tickets[key];
    if (t === undefined) throw new Error(`FakeTicketSource: no ticket ${key}`);
    if (t instanceof Error) throw t;
    // a copy, like a real read: a later change to the fake JIRA must not alter what an earlier read returned
    return structuredClone(t);
  }
}
