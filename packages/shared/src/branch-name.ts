/**
 * Ticket branches follow the conventional prefixes (feat/, fix/, docs/, chore/…): `<type>/<KEY>-<slug>`, a `-<n>`
 * suffix for a later choice of the same ticket. The JIRA key in the name means a ticket branch can never be a base
 * branch (main, develop, release/x.y.z); delivery pushes and sandboxed hooks rely on that (isTicketBranch).
 * Branches made before this naming (`slackoff/<KEY>-<slug>`) stay valid.
 */
export const BRANCH_TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "perf", "build", "ci", "style"] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

export const isBranchType = (s: unknown): s is BranchType => typeof s === "string" && (BRANCH_TYPES as readonly string[]).includes(s);

const DEFECT = /\b(bug|bugs|fix|fixes|issue|issues|error|errors|broken|defect|crash|crashes|regression|incorrect|wrong|fails?|failing|not working)\b/i;
const DOCS = /\b(docs?|documentation|readme|guide)\b/i;

/** The type a ticket's title suggests: a defect is fix, documentation is docs, anything else feat (the developer may change it). */
export function guessBranchType(title: string): BranchType {
  if (DEFECT.test(title)) return "fix";
  if (DOCS.test(title)) return "docs";
  return "feat";
}

const TICKET_BRANCH = new RegExp(`^(?:(?:${BRANCH_TYPES.join("|")})/[A-Z][A-Z0-9_]*-\\d+(?:-[a-z0-9]+)+|slackoff/[A-Za-z0-9][A-Za-z0-9._/-]*)$`);

/** A branch Slack Off made for a ticket (and may push, and let a sandboxed hook move); never a base branch. */
export function isTicketBranch(name: string): boolean {
  return TICKET_BRANCH.test(name) && !/\.\.|\/\/|\/$|\.lock$|\/\./.test(name);
}
