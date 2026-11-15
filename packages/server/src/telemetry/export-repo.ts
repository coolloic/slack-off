// Phase 4c tasks 4-5 (rulings C-7, X-7): what an OTLP export would send, and the record of each confirmed export.
// There is no background export: each export is one confirmation of the runs its preview listed.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../audit/canonical-json.ts";
import type { Config } from "../config.ts";
import { withTx } from "../db/tx.ts";
import { CONTENT_ATTRIBUTES, endpointHost, METADATA_ATTRIBUTES, type AgentRunRow } from "./otlp.ts";

/** Runs one export sends at most. */
export const MAX_EXPORT_RUNS = 500;

const RUN_COLUMNS = "id, ticket_key, role, executor, skill_version, prompt_version_id, status, cost_usd, usage_json, raw_log_path, error, started_at, ended_at";

/** Finished runs (any status but running) never exported, oldest first, at most `limit` (≤ 500). */
export function exportableRuns(db: DatabaseSync, o: { limit: number }): AgentRunRow[] {
  const limit = Math.max(0, Math.min(MAX_EXPORT_RUNS, Math.floor(o.limit)));
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM agent_run r
       WHERE r.status <> 'running' AND NOT EXISTS (SELECT 1 FROM agent_run_exported x WHERE x.run_id = r.id)
       ORDER BY r.started_at, r.id LIMIT ?`,
    )
    .all(limit) as unknown as AgentRunRow[];
}

/** The newest export's id (0 = none yet): every export attempt, done or failed, changes the next preview's hash. */
export const lastExportId = (db: DatabaseSync): number => (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM telemetry_export").get() as { id: number }).id;

/**
 * What the confirmation binds: the run ids (as a set), the destination, the content switch and the newest export
 * (4C-2, NR3: an export uses up its preview, so a failed one is re-sent only after a fresh preview). A change of any of
 * them between the preview and the confirmation makes the confirmation stale (409).
 */
export function exportHash(runIds: readonly string[], endpoint: string, includeContent: boolean, afterExportId: number): string {
  return createHash("sha256").update(canonicalJson({ afterExportId, endpoint, includeContent, runIds: [...runIds].sort() })).digest("hex");
}

/** Whether an export (any outcome) was already made from this preview. */
export const hashUsed = (db: DatabaseSync, hash: string): boolean => db.prepare("SELECT 1 FROM telemetry_export WHERE run_ids_hash = ? LIMIT 1").get(hash) !== undefined;

export interface ExportPreview {
  endpointHost: string;
  runCount: number;
  includeContent: boolean;
  /** the attribute names each span may carry */
  attributes: string[];
  runIdsHash: string;
}

/** What "Export N runs to <host>" would send now; null when no endpoint is set (export off). */
export function previewExport(db: DatabaseSync, config: Config): ExportPreview | null {
  const { endpoint, includeContent } = config.telemetry;
  if (endpoint === "") return null;
  const ids = exportableRuns(db, { limit: MAX_EXPORT_RUNS }).map((r) => r.id);
  return {
    endpointHost: endpointHost(endpoint),
    runCount: ids.length,
    includeContent,
    attributes: [...METADATA_ATTRIBUTES, ...(includeContent ? CONTENT_ATTRIBUTES : [])],
    runIdsHash: exportHash(ids, endpoint, includeContent, lastExportId(db)),
  };
}

// ---- the record of each export (phase 4c Task 5) ----

export interface TelemetryExport {
  id: number;
  endpointHost: string;
  runCount: number;
  includeContent: boolean;
  status: "running" | "done" | "failed";
  httpStatus: number | null;
  detail: string | null;
  decidedBy: string;
  requestedAt: string;
  finishedAt: string | null;
}

/** Longest failure detail stored and shown (after redaction). */
export const MAX_DETAIL_CHARS = 500;

export const INTERRUPTED_EXPORT = "interrupted by restart — not sent again; preview and export again";

export function startExport(
  db: DatabaseSync,
  o: { endpointHost: string; runIds: readonly string[]; hash: string; includeContent: boolean; spanCount: number; decidedBy: string },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO telemetry_export (endpoint_host, run_ids_json, run_ids_hash, include_content, span_count, decided_by, requested_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(o.endpointHost, JSON.stringify(o.runIds), o.hash, o.includeContent ? 1 : 0, o.spanCount, o.decidedBy, new Date().toISOString()).lastInsertRowid,
  );
}

/** The outcome, once. On `done` every run sent is recorded as exported in the same transaction. */
export function finishExport(db: DatabaseSync, id: number, o: { status: "done" | "failed"; httpStatus: number | null; detail: string | null; runIds: readonly string[] }): void {
  withTx(db, () => {
    db.prepare("UPDATE telemetry_export SET status = ?, http_status = ?, detail = ?, finished_at = ? WHERE id = ?").run(
      o.status, o.httpStatus, o.detail === null ? null : o.detail.slice(0, MAX_DETAIL_CHARS), new Date().toISOString(), id,
    );
    if (o.status === "done") {
      const mark = db.prepare("INSERT INTO agent_run_exported (run_id, export_id) VALUES (?, ?)");
      for (const runId of o.runIds) mark.run(runId, id);
    }
  });
}

export function getExport(db: DatabaseSync, id: number): TelemetryExport | null {
  const r = db.prepare("SELECT * FROM telemetry_export WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as number, endpointHost: r.endpoint_host as string, runCount: r.span_count as number, includeContent: r.include_content === 1,
    status: r.status as TelemetryExport["status"], httpStatus: (r.http_status as number | null) ?? null, detail: (r.detail as string | null) ?? null,
    decidedBy: r.decided_by as string, requestedAt: r.requested_at as string, finishedAt: (r.finished_at as string | null) ?? null,
  };
}

export const exportRunning = (db: DatabaseSync): boolean => db.prepare("SELECT 1 FROM telemetry_export WHERE status = 'running' LIMIT 1").get() !== undefined;

/** Startup: an export still marked running belonged to a stopped process — failed, never resent (the collector may have it). */
export function failInterruptedExports(db: DatabaseSync): number {
  const ids = (db.prepare("SELECT id FROM telemetry_export WHERE status = 'running'").all() as Array<{ id: number }>).map((r) => r.id);
  for (const id of ids) finishExport(db, id, { status: "failed", httpStatus: null, detail: INTERRUPTED_EXPORT, runIds: [] });
  return ids.length;
}
