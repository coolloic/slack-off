import type { DatabaseSync } from "node:sqlite";
import { ChoiceFeatures, PREFERENCE_TEXT_MAX, type PreferenceSource, type PreferenceState, type PreferenceSummary } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { withTx } from "../db/tx.ts";
import { ValidationError } from "../tickets/errors.ts";
import { deriveSummary, MAX_SIGNALS, MIN_SIGNALS } from "./derive.ts";
import { stripInvisible } from "../prompts/invisible.ts";

/**
 * Phase 4d Task 1: record the features of a choice. An earlier signal of the same ticket that is still live is marked
 * superseded (kept, never deleted): only the ticket's latest choice counts. Call inside the choice's transaction.
 */
export function recordSignal(db: DatabaseSync, key: string, choiceId: number, features: ChoiceFeatures): void {
  const checked = ChoiceFeatures.parse(features);
  withTx(db, () => {
    db.prepare("UPDATE preference_signal SET superseded = 1 WHERE ticket_key = ? AND superseded = 0").run(key);
    db.prepare("INSERT INTO preference_signal (ticket_key, choice_id, features_json, created_at) VALUES (?, ?, ?, ?)").run(
      key, choiceId, JSON.stringify(checked), new Date().toISOString(),
    );
    appendAudit(db, { actor: "system", type: "preference_signal_recorded", ticketKey: key, payload: { choiceId, features: checked } });
  });
}

// ---------------------------------------------------------------- Task 2: the summary's versions

type Row = Record<string, unknown>;

interface SummaryRow extends PreferenceSummary {
  signalsUpto: number | null;
}

function current(db: DatabaseSync): SummaryRow | null {
  const r = db.prepare("SELECT * FROM preference_summary ORDER BY version DESC LIMIT 1").get() as Row | undefined;
  if (!r) return null;
  return {
    version: r.version as number,
    text: r.text as string,
    source: r.source as PreferenceSource,
    createdAt: r.created_at as string,
    signalsUpto: r.signals_upto as number | null,
  };
}

/** Signals before this id were cleared (D-3); 0 when the summary was never cleared. */
const cutoff = (db: DatabaseSync): number =>
  (db.prepare("SELECT COALESCE(MAX(cleared_before), 0) AS c FROM preference_summary WHERE source = 'cleared'").get() as { c: number }).c;

const maxSignalId = (db: DatabaseSync): number => (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM preference_signal").get() as { m: number }).m;

/** The signals that take part in deriving: not superseded, after the last clear, the newest MAX_SIGNALS, oldest first. */
function liveSignals(db: DatabaseSync): ChoiceFeatures[] {
  const rows = db
    .prepare("SELECT features_json FROM preference_signal WHERE superseded = 0 AND id >= ? ORDER BY id DESC LIMIT ?")
    .all(cutoff(db), MAX_SIGNALS) as Array<{ features_json: string }>;
  return rows.reverse().map((r) => ChoiceFeatures.parse(JSON.parse(r.features_json)));
}

function addVersion(db: DatabaseSync, text: string, source: PreferenceSource, by: string): void {
  withTx(db, () => {
    const version = (db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM preference_summary").get() as { v: number }).v;
    const upto = maxSignalId(db);
    db.prepare(
      "INSERT INTO preference_summary (version, text, source, signals_upto, cleared_before, decided_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(version, text, source, upto === 0 ? null : upto, source === "cleared" ? upto + 1 : null, by, new Date().toISOString());
    appendAudit(db, { actor: by === "system" ? "system" : "developer", type: "preference_summary_changed", payload: { version, source } });
  });
}

export function preferenceState(db: DatabaseSync): PreferenceState {
  const cur = current(db);
  const derived = deriveSummary(liveSignals(db));
  const sinceEdit =
    cur?.source === "edited"
      ? (db.prepare("SELECT COUNT(*) AS n FROM preference_signal WHERE superseded = 0 AND id > ? AND id >= ?").get(cur.signalsUpto ?? 0, cutoff(db)) as { n: number }).n
      : 0;
  return {
    current: cur === null ? null : { version: cur.version, text: cur.text, source: cur.source, createdAt: cur.createdAt },
    derivedPreview: derived.text,
    signalsSinceEdit: sinceEdit,
    counted: derived.counted,
    needed: MIN_SIGNALS,
  };
}

/**
 * After a choice is committed: a new derived version when the derived text differs from the current one (true). An
 * edited summary is never replaced this way (D-3: only Re-derive does that).
 */
export function refreshDerived(db: DatabaseSync): boolean {
  return withTx(db, () => {
    const cur = current(db);
    if (cur?.source === "edited") return false;
    const text = deriveSummary(liveSignals(db)).text;
    if (text === (cur?.text ?? "")) return false;
    addVersion(db, text, "derived", "system");
    return true;
  });
}

/**
 * The developer's own text (it reaches the propose-solutions prompt, quoted, as a reference): newlines unified, tabs to
 * spaces, every control and invisible character removed (4D-2 N1: stripInvisible), trimmed.
 */
export function cleanPreferenceText(raw: string): string {
  return stripInvisible(raw.replace(/\t/g, " "))
    .trim();
}

export function editSummary(db: DatabaseSync, text: string, by: string): void {
  // the text is never echoed back in an error (4B-3)
  if (text.length > PREFERENCE_TEXT_MAX) throw new ValidationError(`the preference text is longer than ${PREFERENCE_TEXT_MAX} characters`);
  const clean = cleanPreferenceText(text);
  if (clean === "") throw new ValidationError("the preference text is empty — use Clear to remove it");
  addVersion(db, clean, "edited", by);
}

/** An empty version; signals recorded so far no longer take part (D-3). */
export function clearSummary(db: DatabaseSync, by: string): void {
  addVersion(db, "", "cleared", by);
}

/** A new derived version from the current signals, even over an edited one. */
export function rederive(db: DatabaseSync, by: string): void {
  withTx(db, () => addVersion(db, deriveSummary(liveSignals(db)).text, "derived", by));
}

/** The current summary version, or null (none yet). Its text is '' after Clear (or when nothing was derived). */
export function currentSummary(db: DatabaseSync): { version: number; text: string } | null {
  const cur = current(db);
  return cur === null ? null : { version: cur.version, text: cur.text };
}

/**
 * 4D-1: a ticket that is abandoned no longer speaks for the developer's preferences: its live signal is superseded
 * (kept). Call inside the abandon's transaction; refreshDerived after it commits.
 */
export function supersedeTicketSignals(db: DatabaseSync, key: string): void {
  db.prepare("UPDATE preference_signal SET superseded = 1 WHERE ticket_key = ? AND superseded = 0").run(key);
}
