import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchedTicket } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { baselineSnapshot, getSnapshot, listSnapshots, parseCommentsMarker, saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { tmpDir } from "./helpers/tmp.ts";

function setup() {
  const db = openDatabase(":memory:");
  const home = tmpDir("snap");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('T-1', 't', 'new', ?, ?)").run(now, now);
  return { db, home };
}

function ticket(over: Partial<FetchedTicket> = {}): FetchedTicket {
  return {
    loginRequired: false,
    key: "T-1",
    title: "Title",
    description: "Desc",
    jiraUpdatedAt: "2026-11-06T00:00:00Z",
    status: null,
    comments: [{ jiraCommentId: "c1", author: "a", created: "2026-11-05T00:00:00Z", body: "hello" }],
    attachments: [],
    ...over,
  };
}

const count = (db: ReturnType<typeof setup>["db"]) =>
  (db.prepare("SELECT COUNT(*) AS n FROM ticket_snapshot").get() as { n: number }).n;

test("same content saved twice yields one row and created:false", () => {
  const { db, home } = setup();
  const a = saveSnapshot(db, home, "T-1", ticket());
  const b = saveSnapshot(db, home, "T-1", ticket());
  assert.equal(a.created, true);
  assert.equal(a.prevSnapshotId, null);
  assert.equal(b.created, false);
  assert.equal(b.snapshotId, a.snapshotId);
  assert.equal(count(db), 1);
  assert.equal(getSnapshot(db, a.snapshotId)?.changeSummary, null);
});

test("changed comment creates new row linked to previous with summary", () => {
  const { db, home } = setup();
  const a = saveSnapshot(db, home, "T-1", ticket());
  const b = saveSnapshot(db, home, "T-1", ticket({ comments: [{ jiraCommentId: "c1", author: "a", created: "2026-11-05T00:00:00Z", body: "edited" }] }));
  assert.equal(b.created, true);
  assert.equal(b.prevSnapshotId, a.snapshotId);
  const s = getSnapshot(db, b.snapshotId)!;
  assert.match(s.changeSummary!, /comments/);
  assert.doesNotMatch(s.changeSummary!, /description changed/);
  assert.equal(s.comments[0]!.body, "edited");
  assert.deepEqual(listSnapshots(db, "T-1").map((x) => x.id), [b.snapshotId, a.snapshotId]);
  assert.equal(baselineSnapshot(db, "T-1"), a.snapshotId);
  assert.equal(baselineSnapshot(db, "NOPE"), undefined);
  const audits = db.prepare("SELECT COUNT(*) AS n FROM audit_event WHERE type = 'snapshot_created'").get() as { n: number };
  assert.equal(audits.n, 2);
});

test("description change is noted in the summary", () => {
  const { db, home } = setup();
  saveSnapshot(db, home, "T-1", ticket());
  const b = saveSnapshot(db, home, "T-1", ticket({ description: "New" }));
  assert.match(getSnapshot(db, b.snapshotId)!.changeSummary!, /^description changed; comments \+0\/-0; attachments \+0\/-0$/);
});

test("base64 attachment is written once with correct sha256", () => {
  const { db, home } = setup();
  const bytes = Buffer.from("png-bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const att = { kind: "attachment" as const, filename: "a.png", mime: "image/png", url: "http://x/a.png", base64: bytes.toString("base64") };
  const a = saveSnapshot(db, home, "T-1", ticket({ attachments: [att] }));
  const file = join(home, "attachments", sha);
  assert.deepEqual(readFileSync(file), bytes);
  const s = getSnapshot(db, a.snapshotId)!;
  assert.equal(s.attachments[0]!.sha256, sha);
  assert.equal(s.attachments[0]!.localPath, file);
  const before = statSync(file);
  const b = saveSnapshot(db, home, "T-1", ticket({ title: "T2", attachments: [att] }));
  assert.equal(b.created, true);
  assert.deepEqual(readdirSync(join(home, "attachments")), [sha]);
  const after = statSync(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.match(getSnapshot(db, b.snapshotId)!.changeSummary!, /attachments \+0\/-0/);
});

test("metadata-only attachment (base64 null) stores NULL sha256 and path", () => {
  const { db, home } = setup();
  const att = { kind: "inline_image" as const, filename: "i.png", mime: "image/png", url: "http://x/i.png", base64: null };
  const a = saveSnapshot(db, home, "T-1", ticket({ attachments: [att] }));
  const s = getSnapshot(db, a.snapshotId)!;
  assert.equal(s.attachments[0]!.sha256, null);
  assert.equal(s.attachments[0]!.localPath, null);
  assert.equal(s.attachments[0]!.url, "http://x/i.png");
  assert.equal(existsSync(join(home, "attachments")), false);
  assert.equal(saveSnapshot(db, home, "T-1", ticket({ attachments: [att] })).created, false);
  const c = saveSnapshot(db, home, "T-1", ticket({ attachments: [{ ...att, url: "http://x/other.png" }] }));
  assert.equal(c.created, true);
  assert.match(getSnapshot(db, c.snapshotId)!.changeSummary!, /attachments \+1\/-1/);
});

// ---- F-I7: incomplete-comments marker ----

test("parseCommentsMarker finds the jira-browser marker and strips its line", () => {
  assert.deepEqual(parseCommentsMarker("Desc\n\n[slackoff: 12 older comments not loaded]"), { description: "Desc", notLoaded: 12 });
  assert.deepEqual(parseCommentsMarker("Desc\n[slackoff: 1 older comment not loaded]\n"), { description: "Desc", notLoaded: 1 });
  assert.deepEqual(parseCommentsMarker("Desc"), { description: "Desc", notLoaded: null });
  // the count is not always shown in JIRA: a marker without a number still marks the read incomplete (0 = unknown)
  assert.deepEqual(parseCommentsMarker("Desc\n\n[slackoff: unknown number of older comments not loaded]"), { description: "Desc", notLoaded: 0 });
  assert.deepEqual(parseCommentsMarker("Desc\n[slackoff: some older comments not loaded]"), { description: "Desc", notLoaded: 0 });
  assert.deepEqual(parseCommentsMarker("Desc\n[slackoff: older comments not loaded]"), { description: "Desc", notLoaded: 0 });
  assert.deepEqual(parseCommentsMarker("mentions [slackoff: x older comments not loaded] inline"), {
    description: "mentions [slackoff: x older comments not loaded] inline",
    notLoaded: null,
  });
});

test("a snapshot with the marker records commentsNotLoaded and a description without the marker", () => {
  const { db, home } = setup();
  const a = saveSnapshot(db, home, "T-1", ticket({ description: "Desc\n\n[slackoff: 3 older comments not loaded]" }));
  const s = getSnapshot(db, a.snapshotId)!;
  assert.equal(s.commentsNotLoaded, 3);
  assert.equal(s.description, "Desc");
  assert.equal(listSnapshots(db, "T-1")[0]!.commentsNotLoaded, 3);
  // the same text with all comments loaded is a different snapshot, with no flag
  const b = saveSnapshot(db, home, "T-1", ticket({ description: "Desc" }));
  assert.equal(b.created, true);
  assert.equal(getSnapshot(db, b.snapshotId)!.commentsNotLoaded, null);
  assert.match(getSnapshot(db, b.snapshotId)!.changeSummary ?? "", /comments/);
});

test("snapshots without the marker keep their content hash (no change for existing data)", () => {
  const { db, home } = setup();
  const a = saveSnapshot(db, home, "T-1", ticket());
  const expected = createHash("sha256")
    .update(JSON.stringify({ attachments: [], comments: [{ author: "a", body: "hello", created: "2026-11-05T00:00:00Z", jiraCommentId: "c1" }], description: "Desc", title: "Title" }))
    .digest("hex");
  assert.equal(getSnapshot(db, a.snapshotId)!.contentHash, expected);
});

test("Chrome mode: an attachment's JIRA address is not content; a re-read links the existing snapshot's files without changing it", () => {
  const { db, home } = setup();
  const att = (filename: string, url: string) => ({ kind: "attachment" as const, filename, mime: "image/png", url, base64: null });
  const URL1 = "https://jira.example.com/rest/api/3/attachment/content/1";
  const URL2 = "https://jira.example.com/rest/api/3/attachment/content/2";
  const URL3 = "https://jira.example.com/rest/api/3/attachment/content/3";
  // read before addresses were recorded; two files share a name (JIRA allows it)
  const first = saveSnapshot(db, home, "T-1", ticket({ attachments: [att("a.png", ""), att("same.png", ""), att("same.png", "")] }), "browser");
  const hash = getSnapshot(db, first.snapshotId)!.contentHash;
  // same content, now with addresses: no new snapshot, the stored rows stay as they were
  const again = saveSnapshot(db, home, "T-1", ticket({ attachments: [att("a.png", URL1), att("same.png", URL2), att("same.png", URL3)] }), "browser");
  assert.equal(again.created, false);
  assert.equal(listSnapshots(db, "T-1").length, 1);
  const raw = db.prepare("SELECT url FROM snapshot_attachment WHERE snapshot_id = ? ORDER BY id").all(first.snapshotId) as Array<{ url: string }>;
  assert.deepEqual(raw.map((r) => r.url), ["", "", ""]);
  // what the page reads: each file with its address, same-named files kept apart by position
  const shown = getSnapshot(db, first.snapshotId)!;
  assert.deepEqual(shown.attachments.map((a) => a.url), [URL1, URL2, URL3]);
  assert.equal(shown.contentHash, hash);
  // a later read with another address for a file: the latest address is shown
  saveSnapshot(db, home, "T-1", ticket({ attachments: [att("a.png", URL3), att("same.png", ""), att("same.png", "")] }), "browser");
  assert.deepEqual(getSnapshot(db, first.snapshotId)!.attachments.map((a) => a.url), [URL3, URL2, URL3]);
  // a real change (another file) is still a new snapshot
  assert.equal(saveSnapshot(db, home, "T-1", ticket({ attachments: [att("a.png", URL1), att("c.png", "")] }), "browser").created, true);
});

test("API mode keeps an attachment's address in its identity (unchanged behaviour)", () => {
  const { db, home } = setup();
  const att = (url: string) => ({ kind: "attachment" as const, filename: "a.pdf", mime: "application/pdf", url, base64: null });
  saveSnapshot(db, home, "T-1", ticket({ attachments: [att("https://jira.example.com/rest/api/3/attachment/content/1")] }), "api");
  assert.equal(saveSnapshot(db, home, "T-1", ticket({ attachments: [att("https://jira.example.com/rest/api/3/attachment/content/2")] }), "api").created, true);
});
