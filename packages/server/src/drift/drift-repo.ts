import type { DatabaseSync } from "node:sqlite";
import { driftNeedsAck, type DriftResult } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { NotFoundError, ValidationError } from "../tickets/errors.ts";

export type DriftTrigger = "ac_edited" | "snapshot_changed" | "before_review";

export interface DriftRecord {
  id: number;
  ticketKey: string;
  requirementId: number;
  baselineSnapshotId: number;
  latestSnapshotId: number;
  trigger: DriftTrigger;
  result: DriftResult;
  acknowledged: boolean;
  createdAt: string;
}

export function saveDrift(
  db: DatabaseSync,
  key: string,
  requirementId: number,
  baselineSnapshotId: number,
  latestSnapshotId: number,
  trigger: DriftTrigger,
  r: DriftResult,
): { id: number } {
  return withTx(db, () => {
    const res = db
      .prepare(
        "INSERT INTO drift_check (ticket_key, requirement_id, baseline_snapshot_id, latest_snapshot_id, trigger, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(key, requirementId, baselineSnapshotId, latestSnapshotId, trigger, JSON.stringify(r), new Date().toISOString());
    appendAudit(db, { actor: "system", type: "drift_checked", ticketKey: key, payload: { trigger, needsAck: driftNeedsAck(r) } });
    return { id: Number(res.lastInsertRowid) };
  });
}

export function latestDrift(db: DatabaseSync, key: string): DriftRecord | null {
  const r = db.prepare("SELECT * FROM drift_check WHERE ticket_key = ? ORDER BY id DESC LIMIT 1").get(key) as Record<string, unknown> | undefined;
  return r ? toRecord(r) : null;
}

function driftById(db: DatabaseSync, id: number): DriftRecord | null {
  const r = db.prepare("SELECT * FROM drift_check WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? toRecord(r) : null;
}

function toRecord(r: Record<string, unknown>): DriftRecord {
  return {
    id: r.id as number,
    ticketKey: r.ticket_key as string,
    requirementId: r.requirement_id as number,
    baselineSnapshotId: r.baseline_snapshot_id as number,
    latestSnapshotId: r.latest_snapshot_id as number,
    trigger: r.trigger as DriftTrigger,
    result: JSON.parse(r.result_json as string) as DriftResult,
    acknowledged: r.acknowledged === 1,
    createdAt: r.created_at as string,
  };
}

/** `decidedBy`: 'local' on this computer, `device:<id>` for a paired device (audited). */
export function acknowledgeDrift(db: DatabaseSync, driftId: number, note: string, decidedBy = "local"): void {
  if (note.trim() === "") throw new ValidationError("acknowledgement note is required");
  withTx(db, () => {
    const row = db.prepare("SELECT ticket_key, acknowledged FROM drift_check WHERE id = ?").get(driftId) as
      | { ticket_key: string; acknowledged: number }
      | undefined;
    if (!row) throw new NotFoundError(`unknown drift check ${driftId}`);
    if (row.acknowledged === 1) return;
    db.prepare("UPDATE drift_check SET acknowledged = 1 WHERE id = ?").run(driftId);
    appendAudit(db, { actor: "developer", type: "drift_acknowledged", ticketKey: row.ticket_key, payload: { driftId, note, decidedBy } });
  });
}

/** The drift checks with one of `triggers` for this requirement against this snapshot, newest first. */
export function findDrifts(db: DatabaseSync, key: string, requirementId: number, latestSnapshotId: number, triggers: readonly DriftTrigger[]): DriftRecord[] {
  const rows = db
    .prepare("SELECT id, trigger FROM drift_check WHERE ticket_key = ? AND requirement_id = ? AND latest_snapshot_id = ? ORDER BY id DESC")
    .all(key, requirementId, latestSnapshotId) as Array<{ id: number; trigger: DriftTrigger }>;
  return rows.filter((r) => triggers.includes(r.trigger)).map((r) => driftById(db, r.id)!);
}
