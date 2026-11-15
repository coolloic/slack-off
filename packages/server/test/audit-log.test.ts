import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db/database.ts";
import { appendAudit, verifyAuditChain } from "../src/audit/audit-log.ts";
import { withTx } from "../src/db/tx.ts";
import { canonicalJson } from "../src/audit/canonical-json.ts";

function seeded() {
  const db = openDatabase(":memory:");
  appendAudit(db, { actor: "system", type: "a", payload: { x: 1 } });
  appendAudit(db, { actor: "developer", type: "b", payload: { y: [1, 2] } });
  appendAudit(db, { actor: "agent:refine-ticket", type: "c", payload: null });
  return db;
}

test("canonicalJson sorts keys recursively and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
});

test("chain of 3 verifies and first prev_hash is 64 zeros", () => {
  const db = seeded();
  assert.deepEqual(verifyAuditChain(db), { ok: true, count: 3 });
  const first = db.prepare("SELECT prev_hash FROM audit_event WHERE id = 1").get() as { prev_hash: string };
  assert.equal(first.prev_hash, "0".repeat(64));
});

test("tampering with row 2 is detected", () => {
  const db = seeded();
  assert.throws(() => db.exec("UPDATE audit_event SET payload_json = '{}' WHERE id = 2"), /append-only/);
  db.exec("DROP TRIGGER audit_event_no_update");
  db.exec(`UPDATE audit_event SET payload_json = '{"y":[9]}' WHERE id = 2`);
  assert.deepEqual(verifyAuditChain(db), { ok: false, brokenAtId: 2 });
});

test("undefined and Date payloads verify", () => {
  const db = openDatabase(":memory:");
  appendAudit(db, { actor: "system", type: "u", payload: undefined });
  appendAudit(db, { actor: "system", type: "d", payload: { at: new Date(0), skip: undefined } });
  assert.deepEqual(verifyAuditChain(db), { ok: true, count: 2 });
});

test("ticketKey present and absent both verify", () => {
  const db = openDatabase(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  appendAudit(db, { actor: "system", type: "a", ticketKey: "ABC-1", payload: {} });
  appendAudit(db, { actor: "system", type: "b", payload: {} });
  assert.deepEqual(verifyAuditChain(db), { ok: true, count: 2 });
});

test("tampering prev_hash is detected", () => {
  const db = seeded();
  db.exec("DROP TRIGGER audit_event_no_update");
  db.exec(`UPDATE audit_event SET prev_hash = '${"1".repeat(64)}' WHERE id = 3`);
  assert.deepEqual(verifyAuditChain(db), { ok: false, brokenAtId: 3 });
});

function count(db: ReturnType<typeof openDatabase>, t: string) {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
}

test("appendAudit inside outer withTx commits together", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (x)");
  withTx(db, () => {
    db.exec("INSERT INTO t VALUES (1)");
    appendAudit(db, { actor: "system", type: "a", payload: {} });
  });
  assert.equal(count(db, "t"), 1);
  assert.deepEqual(verifyAuditChain(db), { ok: true, count: 1 });
});

test("outer throw rolls back row and audit", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (x)");
  assert.throws(() =>
    withTx(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      appendAudit(db, { actor: "system", type: "a", payload: {} });
      throw new Error("boom");
    }), /boom/);
  assert.equal(count(db, "t"), 0);
  assert.equal(count(db, "audit_event"), 0);
  appendAudit(db, { actor: "system", type: "after", payload: {} });
  assert.deepEqual(verifyAuditChain(db), { ok: true, count: 1 });
});

test("nested inner throw rolls back only inner part", () => {
  const db = openDatabase(":memory:");
  db.exec("CREATE TABLE t (x)");
  withTx(db, () => {
    db.exec("INSERT INTO t VALUES (1)");
    assert.throws(() =>
      withTx(db, () => {
        db.exec("INSERT INTO t VALUES (2)");
        appendAudit(db, { actor: "system", type: "inner", payload: {} });
        throw new Error("inner");
      }), /inner/);
    appendAudit(db, { actor: "system", type: "outer", payload: {} });
  });
  assert.equal(count(db, "t"), 1);
  assert.equal(count(db, "audit_event"), 1);
  assert.deepEqual(verifyAuditChain(db), { ok: true, count: 1 });
});
