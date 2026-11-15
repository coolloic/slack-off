// Phase 4a Task 7 item 4 (phase 3 Task 18 minor): the one ticket-key check — a JIRA key such as ABC-123 — that the
// shared schemas, the server's JIRA writers, the agent policy and the workflow all use.

/** A JIRA ticket key, e.g. ABC-123: an upper-case project (letters, digits, `_`), a dash and a number. */
export const TICKET_KEY = /^[A-Z][A-Z0-9_]*-[0-9]+$/;

export function isTicketKey(s: string): boolean {
  return TICKET_KEY.test(s);
}
