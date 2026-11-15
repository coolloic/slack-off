import type { JiraCommentRecord, Requirement } from "@slackoff/shared";

type Ac = Requirement["acceptanceCriteria"][number];

/** Next free AC id: max n over every saved version and the draft, + 1 — a deleted id is never reused. */
export function nextAcId(versions: ReadonlyArray<{ content: Requirement }>, draft: readonly Ac[]): string {
  const all = [...versions.flatMap((v) => v.content.acceptanceCriteria), ...draft];
  const max = all.reduce((m, a) => Math.max(m, Number(/^AC-(\d+)$/.exec(a.id)?.[1] ?? 0)), 0);
  return `AC-${max + 1}`;
}

/** Apply an inline text edit (phone and desktop share this): the AC keeps its id, verifiable flag and original source (Ruling R18). */
export function editAc(ac: Ac, text: string): Ac {
  return { ...ac, text: text.trim() || ac.text };
}

/** "Added by you" applies only to ACs the developer genuinely added (source.type "developer"). */
export const isDeveloperAdded = (ac: Ac): boolean => ac.source.type === "developer";

/** Same limit as the server (JIRA_COMMENT_MAX_CHARS). */
export const COMMENT_MAX_CHARS = 2000;

export interface CommentHistoryEntry {
  id: number;
  state: JiraCommentRecord["state"];
  text: string;
  /** ISO time of the last thing that happened to it (finished, else decided, else requested) */
  at: string;
  retry: boolean;
}

/**
 * The clarification comment box: the developer's edit wins over the agent's draft (an emptied box stays empty); `error`
 * follows the server's rule (empty, over 2000 characters, control characters other than line breaks — a tab is one);
 * history is the clarification comments sent so far, newest first, and only a failed one can be retried.
 */
export function commentDraft(
  draft: string | null,
  edited: string | null,
  sent: readonly JiraCommentRecord[],
): { text: string; error: string | null; history: CommentHistoryEntry[] } {
  const text = edited ?? draft ?? "";
  const body = text.replace(/\r\n/g, "\n");
  let error: string | null = null;
  if (body.trim() === "") error = "The comment is empty";
  else if (body.length > COMMENT_MAX_CHARS) error = `The comment is longer than ${COMMENT_MAX_CHARS} characters`;
  else if (/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/.test(body)) error = "The comment contains control characters (only line breaks are allowed)";
  const history = sent
    .filter((c) => c.purpose === "clarification")
    .map((c) => ({ id: c.id, state: c.state, text: c.text, at: c.finishedAt ?? c.decidedAt ?? c.requestedAt, retry: c.state === "failed" }))
    .sort((a, b) => b.id - a.id);
  return { text, error, history };
}
