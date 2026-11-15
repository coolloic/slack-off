import type { DeliveryPlan, DeliveryStepRecord } from "@slackoff/shared";

export interface ConfirmSheet {
  items: { n: number; text: string; jira: boolean }[];
  blockers: string[];
  warnings: string[];
  bodies: { repo: string; title: string; body: string }[];
  /** the JIRA sync note ("JIRA is not changed …"), shown as a quiet line */
  jiraNote: string | null;
  /** the server says the delivery came back for JIRA drift: a note is required to confirm */
  needsAck: boolean;
  canConfirm: boolean;
}

/** The confirmation dialog's content. Action texts, warnings and descriptions are the server's, never reworded. */
export function confirmSheet(plan: DeliveryPlan & { needsAck?: boolean }, jiraNote: string | null): ConfirmSheet {
  return {
    items: plan.actions.map((a, i) => ({ n: i + 1, text: a.text, jira: a.kind === "jira_status" || a.kind === "jira_comment" })),
    blockers: plan.blockers,
    warnings: plan.warnings,
    bodies: plan.prBodies.map((b) => ({ repo: b.repo, title: b.title, body: b.body })),
    jiraNote,
    needsAck: plan.needsAck === true,
    canConfirm: plan.blockers.length === 0 && plan.actions.length > 0,
  };
}

export interface StepRow {
  id: number;
  text: string;
  state: DeliveryStepRecord["state"];
  detail: string | null;
  link: string | null;
  /** "owner/name#42" for a pull request link */
  linkLabel: string | null;
  retry: boolean;
}

/** Only http(s) links are shown as links (the result comes from `gh`, but it is data, not trusted markup). */
export function prRef(url: unknown, number: unknown): { link: string; label: string } | null {
  if (typeof url !== "string" || typeof number !== "number") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(u.pathname);
  return { link: u.href, label: m ? `${m[1]}/${m[2]}#${number}` : `#${number}` };
}

function prLink(s: DeliveryStepRecord): { link: string; label: string } | null {
  if (s.kind !== "pr" || s.state !== "done") return null;
  const r = s.result as { number?: unknown; url?: unknown } | null;
  return r ? prRef(r.url, r.number) : null;
}

/** Progress rows. Retry is offered for a failed JIRA step only; push / PR failures block the ticket (its own Retry). */
export function stepRows(d: { steps: readonly DeliveryStepRecord[] }): StepRow[] {
  return d.steps.map((s) => {
    const pr = prLink(s);
    return {
      id: s.id,
      text: s.text,
      state: s.state,
      detail: s.detail,
      link: pr?.link ?? null,
      linkLabel: pr?.label ?? null,
      retry: s.state === "failed" && s.kind.startsWith("jira_"),
    };
  });
}
