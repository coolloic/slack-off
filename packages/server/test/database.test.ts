import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { tmpDir } from "./helpers/tmp.ts";

const dir = tmpDir("db");
after(() => rmSync(dir, { recursive: true, force: true }));

function seed(db: ReturnType<typeof openDatabase>) {
  db.exec(`INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('A-1','t','new','x','x')`);
  db.exec(`INSERT INTO ticket_snapshot (ticket_key, fetched_at, title, content_hash) VALUES ('A-1','x','t','h')`);
}

test("migrations apply once and are idempotent across opens", () => {
  const path = join(dir, "a.db");
  const db1 = openDatabase(path);
  const v1 = (db1.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(v1, migrations.length);
  seed(db1);
  db1.close();
  const db2 = openDatabase(path);
  const v2 = (db2.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(v2, migrations.length);
  const n = db2.prepare("SELECT count(*) AS n FROM ticket").get() as { n: number };
  assert.equal(n.n, 1);
  const jm = db2.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(jm.journal_mode, "wal");
  db2.close();
});

test("foreign keys are enforced", () => {
  const db = openDatabase(join(dir, "b.db"));
  assert.throws(() =>
    db.exec(`INSERT INTO ticket_snapshot (ticket_key, fetched_at, title, content_hash) VALUES ('NOPE','x','t','h')`),
  /FOREIGN KEY/);
  db.close();
});

test("snapshot tables are immutable", () => {
  const db = openDatabase(join(dir, "c.db"));
  seed(db);
  db.exec(`INSERT INTO snapshot_comment (snapshot_id, author, body) VALUES (1,'a','b')`);
  db.exec(`INSERT INTO snapshot_attachment (snapshot_id, kind, filename) VALUES (1,'attachment','f')`);
  for (const sql of [
    `UPDATE ticket_snapshot SET title='z'`, `DELETE FROM ticket_snapshot`,
    `UPDATE snapshot_comment SET body='z'`, `DELETE FROM snapshot_comment`,
    `UPDATE snapshot_attachment SET filename='z'`, `DELETE FROM snapshot_attachment`,
  ]) assert.throws(() => db.exec(sql), /immutable/, sql);
  db.close();
});

test("audit_event is append-only", () => {
  const db = openDatabase(join(dir, "d.db"));
  db.exec(`INSERT INTO audit_event (ts, actor, type, payload_json, prev_hash, hash) VALUES ('x','system','t','{}','0','1')`);
  assert.throws(() => db.exec(`DELETE FROM audit_event`), /append-only/);
  assert.throws(() => db.exec(`UPDATE audit_event SET type='y'`), /append-only/);
  db.close();
});

test("agent_run has permission_denials_json defaulting to []", () => {
  const db = openDatabase(join(dir, "e.db"));
  db.exec(`INSERT INTO agent_run (id, role, executor, status, started_at) VALUES ('r','refiner','claude-code','running','x')`);
  const r = db.prepare("SELECT permission_denials_json AS p FROM agent_run").get() as { p: string };
  assert.equal(r.p, "[]");
  db.close();
});

// ---- H7: INSERT OR REPLACE / REPLACE INTO cannot overwrite an immutable row ----

test("H7: INSERT OR REPLACE and REPLACE INTO cannot overwrite a snapshot, comment, attachment or audit row", () => {
  const db = openDatabase(join(dir, "h7.db"));
  seed(db);
  db.exec(`INSERT INTO snapshot_comment (snapshot_id, author, body) VALUES (1,'a','b')`);
  db.exec(`INSERT INTO snapshot_attachment (snapshot_id, kind, filename) VALUES (1,'attachment','f')`);
  db.exec(`INSERT INTO audit_event (ts, actor, type, payload_json, prev_hash, hash) VALUES ('x','system','t','{}','0','1')`);
  const cases: Array<[string, string, RegExp]> = [
    [`INSERT OR REPLACE INTO ticket_snapshot (id, ticket_key, fetched_at, title, content_hash) VALUES (1,'A-1','y','forged','h2')`, "SELECT title AS v FROM ticket_snapshot WHERE id = 1", /immutable/],
    [`REPLACE INTO snapshot_comment (id, snapshot_id, author, body) VALUES (1,1,'a','forged')`, "SELECT body AS v FROM snapshot_comment WHERE id = 1", /immutable/],
    [`INSERT OR REPLACE INTO snapshot_attachment (id, snapshot_id, kind, filename) VALUES (1,1,'attachment','forged')`, "SELECT filename AS v FROM snapshot_attachment WHERE id = 1", /immutable/],
    [`INSERT OR REPLACE INTO audit_event (id, ts, actor, type, payload_json, prev_hash, hash) VALUES (1,'y','system','forged','{}','0','1')`, "SELECT type AS v FROM audit_event WHERE id = 1", /append-only/],
  ];
  for (const [sql, check, msg] of cases) {
    const before = (db.prepare(check).get() as { v: string }).v;
    assert.throws(() => db.exec(sql), msg, sql);
    assert.equal((db.prepare(check).get() as { v: string }).v, before, `${sql} left the row unchanged`);
  }
  // new rows still insert normally, with or without an explicit id
  db.exec(`INSERT INTO snapshot_comment (snapshot_id, author, body) VALUES (1,'a','c')`);
  db.exec(`INSERT OR REPLACE INTO snapshot_comment (id, snapshot_id, author, body) VALUES (99,1,'a','d')`);
  assert.equal((db.prepare("SELECT count(*) AS n FROM snapshot_comment").get() as { n: number }).n, 3);
  db.close();
});

test("H7: recursive_triggers is on, so a REPLACE conflict on any unique constraint fires the delete guards", () => {
  const db = openDatabase(join(dir, "h7b.db"));
  assert.equal((db.prepare("PRAGMA recursive_triggers").get() as { recursive_triggers: number }).recursive_triggers, 1);
  db.close();
});

test("H7: migration 4 applies on top of an existing version-3 database without touching its rows", () => {
  const path = join(dir, "h7c.db");
  const old = new DatabaseSync(path);
  for (let i = 0; i < 3; i++) old.exec(migrations[i]!);
  old.exec("PRAGMA user_version = 3");
  old.exec(`INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('A-1','t','new','x','x')`);
  old.exec(`INSERT INTO ticket_snapshot (ticket_key, fetched_at, title, content_hash) VALUES ('A-1','x','t','h')`);
  old.close();
  const db = openDatabase(path);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, migrations.length);
  assert.ok(migrations.length >= 4);
  assert.equal((db.prepare("SELECT title FROM ticket_snapshot WHERE id = 1").get() as { title: string }).title, "t");
  assert.throws(() => db.exec(`REPLACE INTO ticket_snapshot (id, ticket_key, fetched_at, title, content_hash) VALUES (1,'A-1','y','forged','h2')`), /immutable/);
  db.close();
});

test("migration 5 applies on top of a version-4 database: ticket.jira_open (nullable) and discovery_run", () => {
  const path = join(dir, "m5.db");
  const old = new DatabaseSync(path);
  for (let i = 0; i < 4; i++) old.exec(migrations[i]!);
  old.exec("PRAGMA user_version = 4");
  old.exec(`INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('A-1','t','discovered','x','x')`);
  old.close();
  const db = openDatabase(path);
  assert.ok(migrations.length >= 6);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, migrations.length);
  const row = db.prepare("SELECT key, state, jira_open FROM ticket WHERE key = 'A-1'").get() as { key: string; state: string; jira_open: number | null };
  assert.deepEqual({ ...row }, { key: "A-1", state: "discovered", jira_open: null });
  const cols = (db.prepare("PRAGMA table_info(discovery_run)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(cols, ["id", "finished_at", "returned", "total", "complete"]);
  db.close();
});

test("migration 7: ticket_repo.choice_id (nullable) on top of a version-6 database", () => {
  const path = join(dir, "m7.db");
  const old = new DatabaseSync(path);
  for (let i = 0; i < 6; i++) old.exec(migrations[i]!);
  old.exec("PRAGMA user_version = 6");
  old.close();
  const db = openDatabase(path);
  assert.ok(migrations.length >= 7);
  const cols = (db.prepare("PRAGMA table_info(ticket_repo)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("choice_id"));
  const branchCols = (db.prepare("PRAGMA table_info(choice_branch)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.deepEqual(branchCols, ["choice_id", "ticket_key", "branch", "created_at"]);
  db.close();
});

test("migration 8 (F2-R1): ticket_repo.hooks_pin_json (nullable) on top of a version-7 database", () => {
  const path = join(dir, "m8.db");
  const old = new DatabaseSync(path);
  for (let i = 0; i < 7; i++) old.exec(migrations[i]!);
  old.exec("PRAGMA user_version = 7");
  old.close();
  const db = openDatabase(path);
  assert.ok(migrations.length >= 8);
  const cols = (db.prepare("PRAGMA table_info(ticket_repo)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols.includes("hooks_pin_json"));
  db.close();
});

test("phase 4c m14: usage_pause cannot be deleted, replaced or resumed twice", () => {
  const db = openDatabase(join(dir, "pause.db"));
  assert.ok(migrations.length >= 14);
  const id = Number(db.prepare("INSERT INTO usage_pause (reason, detail, paused_by, paused_at) VALUES ('manual','d','local','t0')").run().lastInsertRowid);
  assert.throws(() => db.exec("DELETE FROM usage_pause"), /append-only/);
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO usage_pause (id, reason, detail, paused_by, paused_at) VALUES (${id},'manual','x','y','z')`), /append-only/);
  assert.throws(() => db.exec(`UPDATE usage_pause SET detail = 'changed' WHERE id = ${id}`), /append-only/);
  assert.throws(() => db.exec("INSERT INTO usage_pause (reason, detail, paused_by, paused_at) VALUES ('other','d','l','t')"), /CHECK/);
  db.exec(`UPDATE usage_pause SET resumed_by = 'local', resumed_at = 't1' WHERE id = ${id}`);
  assert.throws(() => db.exec(`UPDATE usage_pause SET resumed_by = 'other', resumed_at = 't2' WHERE id = ${id}`), /append-only/);
  db.close();
});

test("fix round 1 (m15): agent_run has a started_at index; usage_pause rejects a NULL resumed_by (L2)", () => {
  const db = openDatabase(join(dir, "m15.db"));
  assert.ok(migrations.length >= 15);
  assert.ok((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_run'").all() as Array<{ name: string }>).some((r) => r.name === "agent_run_started_at"));
  const id = Number(db.prepare("INSERT INTO usage_pause (reason, detail, paused_by, paused_at) VALUES ('manual','d','local','t0')").run().lastInsertRowid);
  assert.throws(() => db.exec(`UPDATE usage_pause SET resumed_at = 't1' WHERE id = ${id}`), /append-only/);
  db.close();
});

test("phase 4c m16: telemetry_export cannot be deleted or replaced, finishes once; agent_run_exported is append-only", () => {
  const db = openDatabase(join(dir, "m16.db"));
  assert.ok(migrations.length >= 16);
  assert.ok((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version >= 16);
  db.exec("INSERT INTO agent_run (id, role, executor, status, started_at) VALUES ('run-a','refine-ticket','claude-code','ok','t0')");
  const insert = () =>
    Number(
      db.prepare(
        `INSERT INTO telemetry_export (endpoint_host, run_ids_json, run_ids_hash, include_content, span_count, decided_by, requested_at, status)
         VALUES ('otel.example.com', '["run-a"]', 'h', 0, 1, 'local', 't0', 'running')`,
      ).run().lastInsertRowid,
    );
  const id = insert();
  assert.throws(() => db.exec("DELETE FROM telemetry_export"), /append-only/);
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO telemetry_export (id, endpoint_host, run_ids_json, run_ids_hash, include_content, span_count, decided_by, requested_at, status) VALUES (${id},'x','[]','h',0,0,'l','t','running')`), /append-only/);
  assert.throws(() => db.exec(`UPDATE telemetry_export SET endpoint_host = 'evil.example.com' WHERE id = ${id}`), /append-only/);
  assert.throws(() => db.exec(`UPDATE telemetry_export SET status = 'bogus' WHERE id = ${id}`), /CHECK|append-only/);
  db.exec(`UPDATE telemetry_export SET status = 'failed', http_status = 500, detail = 'd', finished_at = 't1' WHERE id = ${id}`);
  assert.throws(() => db.exec(`UPDATE telemetry_export SET status = 'done', finished_at = 't2' WHERE id = ${id}`), /append-only/);
  const id2 = insert();
  db.exec(`UPDATE telemetry_export SET status = 'done', finished_at = 't1' WHERE id = ${id2}`); // m17: only a done export marks runs
  db.exec(`INSERT INTO agent_run_exported (run_id, export_id) VALUES ('run-a', ${id2})`);
  assert.throws(() => db.exec(`INSERT INTO agent_run_exported (run_id, export_id) VALUES ('run-a', ${id2})`), /UNIQUE|append-only/);
  assert.throws(() => db.exec(`INSERT OR REPLACE INTO agent_run_exported (run_id, export_id) VALUES ('run-a', ${id})`), /append-only/);
  assert.throws(() => db.exec(`UPDATE agent_run_exported SET export_id = ${id}`), /append-only/);
  assert.throws(() => db.exec("DELETE FROM agent_run_exported"), /append-only/);
  assert.throws(() => db.exec(`INSERT INTO agent_run_exported (run_id, export_id) VALUES ('no-such-run', ${id2})`), /FOREIGN KEY/);
  db.close();
});

test("4C-2 M-5 (m17): a run is marked exported only by an export that is done", () => {
  const db = openDatabase(join(dir, "m17.db"));
  assert.ok(migrations.length >= 17);
  db.exec("INSERT INTO agent_run (id, role, executor, status, started_at) VALUES ('run-b','refine-ticket','claude-code','ok','t0')");
  const ins = (status: string) =>
    Number(db.prepare(`INSERT INTO telemetry_export (endpoint_host, run_ids_json, run_ids_hash, include_content, span_count, decided_by, requested_at, status) VALUES ('h','[]','h',0,0,'l','t',?)`).run(status).lastInsertRowid);
  for (const st of ["running", "failed"]) assert.throws(() => db.exec(`INSERT INTO agent_run_exported (run_id, export_id) VALUES ('run-b', ${ins(st)})`), /done export/, st);
  assert.throws(() => db.exec(`INSERT INTO agent_run_exported (run_id, export_id) VALUES ('run-b', 9999)`), /done export|FOREIGN KEY/);
  db.exec(`INSERT INTO agent_run_exported (run_id, export_id) VALUES ('run-b', ${ins("done")})`);
  db.close();
});

test("F4C-1 nit (m18): at most one unresumed usage pause; an older duplicate is closed by the migration", () => {
  assert.ok(migrations.length >= 18);
  // a database at m17 with two open pauses (possible before m18): the older one is closed, the newer one stays
  const path = join(dir, "m18-old.db");
  const old = new DatabaseSync(path);
  for (let i = 0; i < 17; i++) old.exec(migrations[i]!);
  old.exec("PRAGMA user_version = 17");
  old.exec("INSERT INTO usage_pause (reason, detail, paused_by, paused_at) VALUES ('manual','first','local','t0'), ('threshold','second','system','t1')");
  old.close();
  const db = openDatabase(path);
  const rows = db.prepare("SELECT detail, resumed_by, resumed_at FROM usage_pause ORDER BY id").all() as Array<{ detail: string; resumed_by: string | null; resumed_at: string | null }>;
  assert.deepEqual(rows.map((r) => [r.detail, r.resumed_by]), [["first", "system"], ["second", null]]);
  assert.ok(rows[0]!.resumed_at);
  assert.throws(() => db.exec("INSERT INTO usage_pause (reason, detail, paused_by, paused_at) VALUES ('manual','third','local','t2')"), /UNIQUE/);
  db.exec("UPDATE usage_pause SET resumed_by = 'local', resumed_at = 't3' WHERE resumed_at IS NULL");
  db.exec("INSERT INTO usage_pause (reason, detail, paused_by, paused_at) VALUES ('manual','fourth','local','t4')");
  db.close();
});

test("4d (m19): a database at m18 gains the preference tables; its earlier runs read as ticket runs", () => {
  assert.ok(migrations.length >= 19);
  const path = join(dir, "m19-old.db");
  const old = new DatabaseSync(path);
  for (let i = 0; i < 18; i++) old.exec(migrations[i]!);
  old.exec("PRAGMA user_version = 18");
  old.exec("INSERT INTO agent_run (id, role, executor, status, started_at) VALUES ('old-run','refine-ticket','claude-code','ok','t0')");
  old.close();
  const db = openDatabase(path);
  assert.ok((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version >= 19);
  const r = db.prepare("SELECT purpose, preference_version, draft_hash FROM agent_run WHERE id = 'old-run'").get() as Record<string, unknown>;
  assert.deepEqual({ ...r }, { purpose: "ticket", preference_version: null, draft_hash: null });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM preference_signal").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM preference_summary").get() as { n: number }).n, 0);
  db.close();
});
