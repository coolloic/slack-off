// Phase 4c Task 5: Run tracing in Settings and the export card on Cost & quota (ruling C-7: each export is confirmed).
import { t } from "../i18n/en.ts";
import type { TelemetryPreview } from "./api.ts";

/** Slack Off's own ports (packages/server/src/ports.ts): never an OTLP endpoint on this computer. */
const SLACKOFF_PORTS = [4317, 5173];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isLocalHost = (h: string) =>
  LOOPBACK.has(h) || h === "0.0.0.0" || h === "[::]" || h === "[::ffff:0:0]" || /^127\.\d+\.\d+\.\d+$/.test(h) ||
  /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h) || h.endsWith(".localhost");

/** Same rule as the server (telemetry/otlp.ts): https://, or http:// on a loopback host; no user info, query or fragment; not Slack Off's port. */
export function endpointError(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (/[?#\s]/.test(v)) return t("tracing.endpointInvalid");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return t("tracing.endpointInvalid");
  }
  if (u.username !== "" || u.password !== "" || /^[a-z]+:\/\/[^/]*@/i.test(v)) return t("tracing.endpointUserInfo");
  const host = u.hostname.toLowerCase();
  if (u.protocol === "http:" && !LOOPBACK.has(host)) return t("tracing.endpointHttp");
  if (u.protocol !== "http:" && u.protocol !== "https:") return t("tracing.endpointInvalid");
  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  if (isLocalHost(host) && SLACKOFF_PORTS.includes(port)) return t("tracing.endpointOwnPort");
  return null;
}

/** The export card on Cost & quota; null (no card) when run tracing is off. */
export function exportCard(p: TelemetryPreview | null | undefined): { label: string; disabled: boolean; fields: string } | null {
  if (!p) return null;
  return {
    label: p.runCount === 0 ? t("tracing.exportNone", { host: p.endpointHost }) : t("tracing.exportLabel", { n: p.runCount, host: p.endpointHost }),
    disabled: p.runCount === 0,
    fields: t(p.includeContent ? "tracing.fieldsContent" : "tracing.fields"),
  };
}

/** The confirmation (sticky bar on a phone): what "Confirm export" sends, and where. */
export function exportBar(p: TelemetryPreview): { confirm: string; thisWill: string; contentWarning: string | null } {
  return {
    confirm: t("tracing.confirm"),
    thisWill: t(p.includeContent ? "tracing.thisWillContent" : "tracing.thisWill", { n: p.runCount, host: p.endpointHost }),
    contentWarning: p.includeContent ? t("tracing.contentWarning") : null,
  };
}

// ---- the auth headers (credentials.json, this computer only) ----

export const MAX_OTLP_HEADERS = 10;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** 4C-2 (M-2), same as the server: names that change the request itself, and values beyond visible ASCII / Latin-1 */
const DENIED_HEADER = /^(host|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|expect|proxy-.*)$/i;
const HEADER_VALUE = /^[\x20-\x7e\xa0-\xff]+$/;

export interface HeaderRow {
  name: string;
  value: string;
}

const filled = (rows: HeaderRow[]) => rows.map((r) => ({ name: r.name.trim(), value: r.value.trim() })).filter((r) => r.name !== "" || r.value !== "");

/** Same rules as the server: 1–10 headers, names ^[A-Za-z0-9-]{1,64}$ (unique, any case), one-line values of 1–1024. Never repeats a value. */
export function headersError(rows: HeaderRow[]): string | null {
  const f = filled(rows);
  if (f.length === 0) return t("tracing.headersEmpty");
  if (f.length > MAX_OTLP_HEADERS) return t("tracing.headersTooMany", { n: MAX_OTLP_HEADERS });
  const seen = new Set<string>();
  for (const r of f) {
    if (!HEADER_NAME.test(r.name)) return t("tracing.headerNameInvalid");
    if (DENIED_HEADER.test(r.name)) return t("tracing.headerNameDenied");
    if (seen.has(r.name.toLowerCase())) return t("tracing.headerNameDuplicate");
    seen.add(r.name.toLowerCase());
    if (r.value === "" || r.value.length > 1024 || !HEADER_VALUE.test(r.value)) return t("tracing.headerValueInvalid");
  }
  return null;
}

/** The PUT /api/credentials/otlp-headers body: trimmed, empty rows dropped. */
export function headersBody(rows: HeaderRow[]): { headers: Record<string, string> } {
  return { headers: Object.fromEntries(filled(rows).map((r) => [r.name, r.value])) };
}
