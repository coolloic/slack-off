import { createHash, randomBytes, randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";

export const CODE_TTL_MS = 5 * 60_000;
export const SESSION_MAX_AGE_S = 180 * 24 * 60 * 60;
export const MAX_FAILED_REDEEMS = 5;
const LAST_SEEN_EVERY_MS = 60_000;

export interface Device {
  id: number;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export type RedeemResult =
  | { ok: true; device: Device; token: string }
  | { ok: false; reason: "invalid" | "locked" };

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

interface DeviceRow {
  id: number;
  name: string;
  created_at: string;
  last_seen_at: string | null;
}
const toDevice = (r: DeviceRow): Device => ({ id: r.id, name: r.name, createdAt: r.created_at, lastSeenAt: r.last_seen_at });

/**
 * Device pairing: one-time 8-digit codes (5 minutes) exchanged for a long-lived random session token. Only sha256
 * hashes of codes and tokens are stored, and lookups go by hash, so raw secrets are never compared or persisted.
 * At most MAX_FAILED_REDEEMS failed redeems per pairing window; then every outstanding code is invalidated.
 */
export function createPairing(db: DatabaseSync, now: () => number = Date.now) {
  let failures = 0;
  const revokeListeners = new Set<(deviceId: number) => void>();
  const iso = (ms = now()) => new Date(ms).toISOString();

  const invalidateOutstanding = (at: string): number =>
    Number(db.prepare("UPDATE pairing_code SET used_at = ? WHERE used_at IS NULL AND expires_at > ?").run(at, at).changes);

  function start(): { code: string; expiresAt: string } {
    const at = iso();
    const expiresAt = iso(now() + CODE_TTL_MS);
    return withTx(db, () => {
      db.prepare("DELETE FROM pairing_code WHERE used_at IS NOT NULL OR expires_at <= ?").run(at);
      invalidateOutstanding(at); // one live code at a time
      let code: string;
      do code = String(randomInt(0, 100_000_000)).padStart(8, "0");
      while (db.prepare("SELECT 1 FROM pairing_code WHERE code_hash = ?").get(sha256(code)));
      db.prepare("INSERT INTO pairing_code (code_hash, expires_at, used_at) VALUES (?, ?, NULL)").run(sha256(code), expiresAt);
      appendAudit(db, { actor: "developer", type: "pairing_started", payload: { expiresAt } });
      failures = 0;
      return { code, expiresAt };
    });
  }

  function redeem(code: string, deviceName: string): RedeemResult {
    if (failures >= MAX_FAILED_REDEEMS) return { ok: false, reason: "locked" };
    const at = iso();
    return withTx(db, (): RedeemResult => {
      const hit = /^\d{8}$/.test(code)
        ? db.prepare("UPDATE pairing_code SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").run(at, sha256(code), at)
        : { changes: 0 };
      if (Number(hit.changes) !== 1) {
        failures++;
        if (failures < MAX_FAILED_REDEEMS) return { ok: false, reason: "invalid" };
        const invalidated = invalidateOutstanding(at);
        appendAudit(db, { actor: "system", type: "pairing_locked", payload: { failedAttempts: failures, invalidatedCodes: invalidated } });
        return { ok: false, reason: "locked" };
      }
      const token = randomBytes(32).toString("base64url");
      const res = db
        .prepare("INSERT INTO paired_device (name, token_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, NULL)")
        .run(deviceName, sha256(token), at, at);
      const device: Device = { id: Number(res.lastInsertRowid), name: deviceName, createdAt: at, lastSeenAt: at };
      appendAudit(db, { actor: "developer", type: "device_paired", payload: { deviceId: device.id, name: deviceName } });
      return { ok: true, device, token };
    });
  }

  /** The active device for a session token, or null (unknown, revoked or older than the cookie lifetime). */
  function authenticate(token: string | undefined): Device | null {
    if (!token) return null;
    const row = db.prepare("SELECT id, name, created_at, last_seen_at FROM paired_device WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(token)) as
      | DeviceRow
      | undefined;
    if (!row) return null;
    const t = now();
    if (Date.parse(row.created_at) + SESSION_MAX_AGE_S * 1000 <= t) return null;
    if (!row.last_seen_at || Date.parse(row.last_seen_at) + LAST_SEEN_EVERY_MS <= t) {
      row.last_seen_at = iso(t);
      db.prepare("UPDATE paired_device SET last_seen_at = ? WHERE id = ?").run(row.last_seen_at, row.id);
    }
    return toDevice(row);
  }

  function listDevices(): Device[] {
    return (db.prepare("SELECT id, name, created_at, last_seen_at FROM paired_device WHERE revoked_at IS NULL ORDER BY id").all() as unknown as DeviceRow[]).map(toDevice);
  }

  /** Revoke a device; false when it does not exist or is already revoked. */
  function revoke(id: number): boolean {
    return withTx(db, () => {
      const row = db.prepare("SELECT id, name FROM paired_device WHERE id = ? AND revoked_at IS NULL").get(id) as { id: number; name: string } | undefined;
      if (!row) return false;
      db.prepare("UPDATE paired_device SET revoked_at = ? WHERE id = ?").run(iso(), id);
      appendAudit(db, { actor: "developer", type: "device_revoked", payload: { deviceId: id, name: row.name } });
      return true;
    }) && notifyRevoked(id);
  }

  const notifyRevoked = (id: number): true => {
    for (const fn of [...revokeListeners]) fn(id);
    return true;
  };

  /** Called with the device id right after a revocation commits (open SSE streams of that device close). */
  function onRevoke(fn: (deviceId: number) => void): () => void {
    revokeListeners.add(fn);
    return () => revokeListeners.delete(fn);
  }

  /** Pairing window state for the Settings page (no secrets): locked = too many wrong codes since the last start. */
  const status = (): { locked: boolean } => ({ locked: failures >= MAX_FAILED_REDEEMS });

  return { start, redeem, authenticate, listDevices, revoke, onRevoke, status };
}

export type Pairing = ReturnType<typeof createPairing>;
