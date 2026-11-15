import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRole } from "@slackoff/shared";
import { withTx } from "../db/tx.ts";
import { canonicalJson } from "./canonical-json.ts";

export type Actor = "developer" | "system" | `agent:${AgentRole}`;

const GENESIS = "0".repeat(64);

function computeHash(prevHash: string, ts: string, actor: string, type: string, ticketKey: string | null, payload: unknown): string {
  const body = canonicalJson({ ts, actor, type, ticketKey, payload });
  return createHash("sha256").update(prevHash + body).digest("hex");
}

export function appendAudit(
  db: DatabaseSync,
  e: { actor: Actor; type: string; ticketKey?: string; payload: unknown },
): { id: number; hash: string } {
  const payload: unknown = JSON.parse(JSON.stringify(e.payload ?? null));
  return withTx(db, () => {
    const last = db.prepare("SELECT hash FROM audit_event ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? GENESIS;
    const ts = new Date().toISOString();
    const ticketKey = e.ticketKey ?? null;
    const hash = computeHash(prevHash, ts, e.actor, e.type, ticketKey, payload);
    const res = db
      .prepare("INSERT INTO audit_event (ts, actor, type, ticket_key, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ts, e.actor, e.type, ticketKey, JSON.stringify(payload), prevHash, hash);
    return { id: Number(res.lastInsertRowid), hash };
  });
}

export function verifyAuditChain(db: DatabaseSync): { ok: true; count: number } | { ok: false; brokenAtId: number } {
  const rows = db.prepare("SELECT id, ts, actor, type, ticket_key, payload_json, prev_hash, hash FROM audit_event ORDER BY id").all() as Array<{
    id: number; ts: string; actor: string; type: string; ticket_key: string | null; payload_json: string; prev_hash: string; hash: string;
  }>;
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || computeHash(prev, r.ts, r.actor, r.type, r.ticket_key, JSON.parse(r.payload_json)) !== r.hash) {
      return { ok: false, brokenAtId: r.id };
    }
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
