import type { DatabaseSync } from "node:sqlite";
import type { RequirementRecord } from "../requirements/requirement-repo.ts";
import { getSnapshot } from "../snapshots/snapshot-store.ts";
import { NotFoundError } from "../tickets/errors.ts";

const json = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";

/** A stored snapshot as the agents read it. */
export function snapshotForPrompt(db: DatabaseSync, key: string, snapshotId: number) {
  const s = getSnapshot(db, snapshotId);
  if (!s) throw new NotFoundError(`unknown snapshot ${snapshotId}`);
  return {
    key,
    title: s.title,
    description: s.description ?? "",
    comments: s.comments.map((c) => ({ jiraCommentId: c.jiraCommentId, author: c.author, created: c.created, body: c.body })),
    attachments: s.attachments.map((a) => ({ kind: a.kind, filename: a.filename, mime: a.mime, url: a.url })),
    ...(s.commentsNotLoaded === null ? {} : { commentsNotLoaded: s.commentsNotLoaded }),
  };
}

/** Baseline requirement with AC ids rewritten to `AC-n@v<version>`; D-n ids stay as they are. */
function baselineForPrompt(r: RequirementRecord) {
  return {
    acceptanceCriteria: r.content.acceptanceCriteria.map((ac) => ({ ...ac, id: `${ac.id}@v${r.version}` })),
    discussionOutcomes: r.content.discussionOutcomes,
  };
}

/**
 * The refine-ticket check-mode prompt (phase-1 drift check after an AC edit, and the snapshot_changed check before
 * development): the baseline (first) requirement, the current requirement, the baseline and the latest snapshot.
 */
export function buildDriftPrompt(
  db: DatabaseSync,
  key: string,
  r: { baseline: RequirementRecord; current: RequirementRecord; baselineSnapshotId: number; latestSnapshotId: number },
): string {
  return [
    "mode: check",
    "",
    "baselineRequirement:",
    json(baselineForPrompt(r.baseline)),
    "",
    "currentRequirement:",
    json(r.current.content),
    "",
    "baselineSnapshot:",
    json(snapshotForPrompt(db, key, r.baselineSnapshotId)),
    "",
    "latestSnapshot:",
    json(snapshotForPrompt(db, key, r.latestSnapshotId)),
    "",
    "Reply with only the DriftResult JSON object in a single ```json block.",
  ].join("\n");
}
