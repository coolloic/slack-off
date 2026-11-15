import type { AcSource } from "@slackoff/shared";
import { t } from "../i18n/en.ts";

/** DOM id of a source anchor in the Original snapshot tab. */
export const anchor = {
  paragraph: (n: number) => `p-${n}`,
  comment: (jiraCommentId: string) => `c-${jiraCommentId}`,
  attachment: (filename: string) => `a-${filename}`,
};

/** Comment refs are the jiraCommentId; tolerate a "comment#" prefix. */
export const commentId = (ref: string): string => ref.replace(/^comment#/, "");

export const sourceLabel = {
  paragraph: (n: number | string) => t("src.description", { n }),
  comment: (id: string) => t("src.comment", { id }),
  attachment: (name: string) => t("src.attachment", { name }),
};

export interface SourceTarget {
  label: string;
  anchorId: string | null;
}

export function sourceTarget(s: AcSource): SourceTarget {
  if (s.type === "developer") return { label: t("src.developer"), anchorId: null };
  if (s.type === "description") {
    const m = /^description#p(\d+)$/.exec(s.ref);
    return m ? { label: sourceLabel.paragraph(m[1]!), anchorId: anchor.paragraph(Number(m[1])) } : { label: s.ref, anchorId: null };
  }
  if (s.type === "comment") {
    const id = commentId(s.ref);
    return { label: sourceLabel.comment(id), anchorId: anchor.comment(id) };
  }
  return { label: sourceLabel.attachment(s.ref), anchorId: anchor.attachment(s.ref) };
}

/** Link to a source inside the snapshot the requirement was built from (`snap` preselects it). */
export const focusLink = (ticketKey: string, anchorId: string, snapshotId?: number): string =>
  `/tickets/${encodeURIComponent(ticketKey)}/snapshot?${snapshotId !== undefined ? `snap=${snapshotId}&` : ""}focus=${encodeURIComponent(anchorId)}`;
