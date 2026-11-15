import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FetchedTicket } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { canonicalJson } from "../audit/canonical-json.ts";
import { withTx } from "../db/tx.ts";
import type { JiraMode } from "../jira/ticket-source.ts";

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

type Fetched = Pick<FetchedTicket, "title" | "description" | "comments" | "attachments">;

interface PreparedAttachment {
  kind: "attachment" | "inline_image";
  filename: string;
  mime: string;
  sha256: string | null;
  localPath: string | null;
  url: string;
  identity: string;
}

/**
 * urlIsContent: whether a metadata-only attachment's url is part of its identity. In Chrome mode it is not: the
 * reader may or may not manage to record the JIRA address (it did not before it read the attachment data), and that
 * must not read as a changed ticket. In API mode the address names the attachment and stays in.
 */
function storeAttachments(home: string, attachments: Fetched["attachments"], urlIsContent: boolean): PreparedAttachment[] {
  return attachments.map((a) => {
    if (a.base64 === null) {
      return { kind: a.kind, filename: a.filename, mime: a.mime, sha256: null, localPath: null, url: a.url, identity: canonicalJson([a.filename, urlIsContent ? a.url : ""]) };
    }
    const bytes = Buffer.from(a.base64, "base64");
    const hash = sha256(bytes);
    const dir = join(home, "attachments");
    const path = join(dir, hash);
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    return { kind: a.kind, filename: a.filename, mime: a.mime, sha256: hash, localPath: path, url: a.url, identity: canonicalJson([a.filename, hash]) };
  });
}

/**
 * skills/jira-browser rule 5: the description's final line `[slackoff: N older comments not loaded]`. JIRA does not
 * always show N, and the reader then writes it without one ("unknown number of older comments", "some older
 * comments"): still incomplete, recorded as 0 (= an unknown number).
 */
const COMMENTS_MARKER = /(?:^|\n)[ \t]*\[slackoff: (?:(\d+) |[^\]\n]*?)older comments? not loaded\][ \t]*\s*$/;

/** F-I7: split the incomplete-comments marker off the description; `notLoaded` is null when every comment was read, 0 when how many is unknown. */
export function parseCommentsMarker(description: string): { description: string; notLoaded: number | null } {
  const m = COMMENTS_MARKER.exec(description);
  if (!m) return { description, notLoaded: null };
  return { description: description.slice(0, m.index).trimEnd(), notLoaded: m[1] === undefined ? 0 : Number(m[1]) };
}

function sortedComments(f: Fetched) {
  return [...f.comments].sort((x, y) => (x.jiraCommentId < y.jiraCommentId ? -1 : x.jiraCommentId > y.jiraCommentId ? 1 : 0));
}

function diffCounts(prev: string[], next: string[]): { added: number; removed: number } {
  const p = new Set(prev);
  const n = new Set(next);
  return { added: [...n].filter((x) => !p.has(x)).length, removed: [...p].filter((x) => !n.has(x)).length };
}

/**
 * Chrome mode: remember each attachment's JIRA address per ticket, file name and position among files of that name
 * (JIRA allows two files with one name). Snapshots are immutable and the address is not content, so it lives here;
 * getSnapshot shows it for an attachment that has none of its own. The latest read wins.
 */
function recordAttachmentLinks(db: DatabaseSync, ticketKey: string, attachments: PreparedAttachment[]): void {
  const seen = new Map<string, number>();
  const now = new Date().toISOString();
  for (const a of attachments) {
    const name = a.filename ?? "";
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    if (a.sha256 !== null || a.url === "") continue;
    db.prepare(
      "INSERT INTO attachment_link (ticket_key, filename, ordinal, url, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (ticket_key, filename, ordinal) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at",
    ).run(ticketKey, name, n, a.url, now);
  }
}

export function saveSnapshot(
  db: DatabaseSync,
  home: string,
  ticketKey: string,
  f: FetchedTicket,
  /** F4B-4: the JIRA mode it was read in (recorded on a new row; null = unknown) */
  jiraSource: JiraMode | null = null,
): { snapshotId: number; created: boolean; prevSnapshotId: number | null } {
  const { description, notLoaded } = parseCommentsMarker(f.description);
  f = { ...f, description };
  return withTx(db, () => {
    const comments = sortedComments(f);
    const urlIsContent = jiraSource !== "browser";
    const attachments = storeAttachments(home, f.attachments, urlIsContent);
    const contentHash = sha256(
      canonicalJson({
        title: f.title,
        description: f.description,
        comments,
        attachments: attachments.map((a) => a.identity),
        // only present when incomplete, so complete snapshots keep their earlier hash
        ...(notLoaded === null ? {} : { commentsNotLoaded: notLoaded }),
      }),
    );

    const latest = db
      .prepare("SELECT id, content_hash, description FROM ticket_snapshot WHERE ticket_key = ? ORDER BY id DESC LIMIT 1")
      .get(ticketKey) as { id: number; content_hash: string; description: string | null } | undefined;
    if (latest && latest.content_hash === contentHash) {
      if (!urlIsContent) recordAttachmentLinks(db, ticketKey, attachments);
      return { snapshotId: latest.id, created: false, prevSnapshotId: null };
    }

    let changeSummary: string | null = null;
    if (latest) {
      const prevComments = db
        .prepare("SELECT jira_comment_id, author, created, body FROM snapshot_comment WHERE snapshot_id = ?")
        .all(latest.id) as Array<{ jira_comment_id: string; author: string; created: string; body: string }>;
      const prevAtts = db
        .prepare("SELECT filename, sha256, url FROM snapshot_attachment WHERE snapshot_id = ?")
        .all(latest.id) as Array<{ filename: string; sha256: string | null; url: string | null }>;
      const commentKey = (c: { id: string; body: string }) => canonicalJson([c.id, c.body]);
      const cd = diffCounts(
        prevComments.map((c) => commentKey({ id: c.jira_comment_id, body: c.body })),
        comments.map((c) => commentKey({ id: c.jiraCommentId, body: c.body })),
      );
      // Same identity as the content hash: filename + (sha256, or url when metadata-only).
      const prevAttKeys = prevAtts.map((a) => canonicalJson([a.filename, a.sha256 ?? (urlIsContent ? a.url : "")]));
      const nextAttKeys = attachments.map((a) => a.identity);
      const ad = diffCounts(prevAttKeys, nextAttKeys);
      const parts: string[] = [];
      if ((latest.description ?? "") !== f.description) parts.push("description changed");
      parts.push(`comments +${cd.added}/-${cd.removed}`);
      parts.push(`attachments +${ad.added}/-${ad.removed}`);
      changeSummary = parts.join("; ");
    }

    const prevSnapshotId = latest?.id ?? null;
    const res = db
      .prepare(
        "INSERT INTO ticket_snapshot (ticket_key, prev_snapshot_id, fetched_at, jira_updated_at, title, description, content_hash, change_summary, comments_not_loaded, jira_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ticketKey, prevSnapshotId, new Date().toISOString(), f.jiraUpdatedAt, f.title, f.description, contentHash, changeSummary, notLoaded, jiraSource);
    const snapshotId = Number(res.lastInsertRowid);

    const insC = db.prepare("INSERT INTO snapshot_comment (snapshot_id, jira_comment_id, author, created, body) VALUES (?, ?, ?, ?, ?)");
    for (const c of comments) insC.run(snapshotId, c.jiraCommentId, c.author, c.created, c.body);
    const insA = db.prepare(
      "INSERT INTO snapshot_attachment (snapshot_id, kind, filename, mime, local_path, sha256, url) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const a of attachments) insA.run(snapshotId, a.kind, a.filename, a.mime, a.localPath, a.sha256, a.url);

    appendAudit(db, {
      actor: "system",
      type: "snapshot_created",
      ticketKey,
      payload: { snapshotId, prevSnapshotId, contentHash, changeSummary, ...(notLoaded === null ? {} : { commentsNotLoaded: notLoaded }) },
    });
    if (!urlIsContent) recordAttachmentLinks(db, ticketKey, attachments);
    return { snapshotId, created: true, prevSnapshotId };
  });
}

export function getSnapshot(db: DatabaseSync, id: number) {
  const r = db.prepare("SELECT * FROM ticket_snapshot WHERE id = ?").get(id) as
    | {
        id: number; ticket_key: string; fetched_at: string; jira_updated_at: string | null; title: string;
        description: string | null; content_hash: string; change_summary: string | null; comments_not_loaded: number | null;
        jira_source: JiraMode | null;
      }
    | undefined;
  if (!r) return undefined;
  const comments = (
    db.prepare("SELECT id, jira_comment_id, author, created, body FROM snapshot_comment WHERE snapshot_id = ? ORDER BY id").all(id) as Array<{
      id: number; jira_comment_id: string | null; author: string | null; created: string | null; body: string | null;
    }>
  ).map((c) => ({ id: c.id, jiraCommentId: c.jira_comment_id, author: c.author, created: c.created, body: c.body }));
  const attachments = (
    db.prepare("SELECT id, kind, filename, mime, local_path, sha256, url FROM snapshot_attachment WHERE snapshot_id = ? ORDER BY id").all(id) as Array<{
      id: number; kind: string; filename: string | null; mime: string | null; local_path: string | null; sha256: string | null; url: string | null;
    }>
  );
  // an attachment read without bytes or address takes the address a later Chrome-mode read found (recordAttachmentLinks)
  const links = new Map(
    (db.prepare("SELECT filename, ordinal, url FROM attachment_link WHERE ticket_key = ?").all(r.ticket_key) as Array<{ filename: string; ordinal: number; url: string }>).map(
      (l) => [`${l.ordinal}:${l.filename}`, l.url],
    ),
  );
  const seen = new Map<string, number>();
  const shown = attachments.map((a) => {
    const name = a.filename ?? "";
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    const url = a.sha256 === null && (a.url ?? "") === "" ? (links.get(`${n}:${name}`) ?? a.url) : a.url;
    return { id: a.id, kind: a.kind, filename: a.filename, mime: a.mime, localPath: a.local_path, sha256: a.sha256, url };
  });
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    fetchedAt: r.fetched_at,
    jiraUpdatedAt: r.jira_updated_at,
    title: r.title,
    description: r.description,
    contentHash: r.content_hash,
    changeSummary: r.change_summary,
    commentsNotLoaded: r.comments_not_loaded,
    jiraSource: r.jira_source ?? null,
    comments,
    attachments: shown,
  };
}

export function listSnapshots(db: DatabaseSync, ticketKey: string) {
  return (
    db
      .prepare("SELECT id, fetched_at, content_hash, change_summary, comments_not_loaded, jira_source FROM ticket_snapshot WHERE ticket_key = ? ORDER BY id DESC")
      .all(ticketKey) as Array<{ id: number; fetched_at: string; content_hash: string; change_summary: string | null; comments_not_loaded: number | null; jira_source: JiraMode | null }>
  ).map((r) => ({ id: r.id, fetchedAt: r.fetched_at, contentHash: r.content_hash, changeSummary: r.change_summary, commentsNotLoaded: r.comments_not_loaded, jiraSource: r.jira_source ?? null }));
}

export function baselineSnapshot(db: DatabaseSync, ticketKey: string): number | undefined {
  const r = db.prepare("SELECT id FROM ticket_snapshot WHERE ticket_key = ? ORDER BY id ASC LIMIT 1").get(ticketKey) as
    | { id: number }
    | undefined;
  return r?.id;
}
