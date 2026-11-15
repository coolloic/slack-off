// Phase 4c Task 4 (rulings C-5, C-8): OTLP/HTTP JSON traces for agent runs, written by hand (no OpenTelemetry SDK).
// One span per agent run (`slackoff.agent_run`), one trace per ticket, the tool calls as span events. By default a
// span holds metadata only: never a prompt, an output, an error text, a path or a JIRA address. With
// telemetry.includeContent (this computer only) the prompt and the output are added, each redacted, then cut to 32 KB.
import { createHash } from "node:crypto";
import { constants as fsc } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { redactKnown } from "../credentials/credential-store.ts";
import { SLACKOFF_PORTS } from "../ports.ts";
import { CHROME_ALL_TOOLS } from "../executor/sandbox.ts";

export const SPAN_NAME = "slackoff.agent_run";
/** Per content item (prompt, output), in UTF-8 bytes. */
export const CONTENT_LIMIT_BYTES = 32 * 1024;
/** Span events (tool calls) per span; the rest is counted in droppedEventsCount. */
export const MAX_TOOL_EVENTS = 200;
/** A raw log larger than this is read up to this many bytes (4C-2, M-3). */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** Distinct tool names per span; the rest count as "other" (4C-2, I-2). */
export const MAX_TOOL_NAMES = 50;
const TRUNCATED = "…[truncated]";
/**
 * 4C-2 (I-2): the only tool names copied into a span — Claude Code's built-in tools and the tools of the MCP server
 * Slack Off configures (claude-in-chrome). A model can call a tool by any name (ticket text, a secret); anything not
 * listed here is sent as "other".
 */
const BUILTIN_TOOLS = [
  "Agent", "Task", "Bash", "BashOutput", "KillShell", "KillBash", "Glob", "Grep", "LS", "Read", "Edit", "MultiEdit", "Write",
  "NotebookEdit", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "ExitPlanMode", "EnterPlanMode", "Skill", "SlashCommand",
  "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "AskUserQuestion",
];
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([...BUILTIN_TOOLS, ...CHROME_ALL_TOOLS]);

/** An agent_run row as stored (the columns a span is built from). */
export interface AgentRunRow {
  id: string;
  ticket_key: string | null;
  role: string;
  executor: string;
  skill_version: string | null;
  prompt_version_id: number | null;
  status: string;
  cost_usd: number | null;
  usage_json: string | null;
  raw_log_path: string | null;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}

// ---- the endpoint rule (config.ts) ----

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Any host that reaches this machine: Slack Off's own ports are refused on all of them. */
// 4C-2 nit: IPv4-mapped IPv6 loopback ([::ffff:127.x.y.z], which the URL parser writes as [::ffff:7fxx:xxxx]) and [::ffff:0:0]
const isLocalHost = (h: string): boolean =>
  LOOPBACK_HOSTS.has(h) || h === "0.0.0.0" || h === "[::]" || h === "[::ffff:0:0]" || /^127\.\d+\.\d+\.\d+$/.test(h) ||
  /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h) || h.endsWith(".localhost");

/**
 * Why `value` cannot be the OTLP endpoint, or null. Empty = off. https:// anywhere, or http:// only on 127.0.0.1,
 * localhost or [::1] (a collector on this computer); no user info, query or fragment; never Slack Off's own port.
 */
export function otlpEndpointIssue(value: string): string | null {
  if (value === "") return null;
  if (/[?#\s]/.test(value)) return "must not have a query, a fragment or spaces";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "must be an https:// URL (or http:// on 127.0.0.1, localhost or [::1])";
  }
  if (u.username !== "" || u.password !== "" || /^[a-z]+:\/\/[^/]*@/i.test(value)) return "must not contain user info (put the credentials in the OTLP headers)";
  const host = u.hostname.toLowerCase();
  if (u.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(host)) return "http:// is only allowed on 127.0.0.1, localhost or [::1] (a local collector): use https://";
  } else if (u.protocol !== "https:") {
    return "must be an https:// URL (or http:// on 127.0.0.1, localhost or [::1])";
  }
  const port = u.port === "" ? (u.protocol === "https:" ? 443 : 80) : Number(u.port);
  if (isLocalHost(host) && SLACKOFF_PORTS.includes(port)) return "must not be Slack Off's own port";
  return null;
}

/** host[:port] of a valid endpoint (what the confirmation and the audit name). */
export const endpointHost = (endpoint: string): string => new URL(endpoint).host;

// ---- the raw log ----

/**
 * A reader for the run logs: only regular files under <home>/runs (real paths, no symlink out), at most 16 MB; null
 * for anything else. agent_run.raw_log_path is never trusted to point elsewhere.
 */
export function rawLogReader(home: string): (path: string) => Promise<string | null> {
  return async (path) => {
    try {
      if (!isAbsolute(path)) return null;
      const root = await realpath(join(home, "runs"));
      const real = await realpath(path);
      const rel = relative(root, real);
      if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
      if (!(await lstat(real)).isFile()) return null;
      const fh = await open(real, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
      try {
        const st = await fh.stat();
        if (!st.isFile()) return null;
        const size = Math.min(st.size, MAX_LOG_BYTES);
        const buf = Buffer.alloc(size);
        let off = 0;
        while (off < size) {
          const { bytesRead } = await fh.read(buf, off, size - off, off);
          if (bytesRead === 0) break;
          off += bytesRead;
        }
        return buf.subarray(0, off).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  };
}

type Json = Record<string, unknown>;

interface LogFacts {
  tools: string[];
  prompt: string | null;
  output: string | null;
}

/** Tool names, the user's text (the prompt, when the log has it) and the final result text; bad lines are skipped. */
function logFacts(text: string | null): LogFacts {
  const facts: LogFacts = { tools: [], prompt: null, output: null };
  if (text === null) return facts;
  const prompts: string[] = [];
  const said: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: Json;
    try {
      ev = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (ev === null || typeof ev !== "object") continue;
    if (ev.type === "result" && typeof ev.result === "string") facts.output = ev.result;
    const content = (ev.message as Json | undefined)?.content;
    if (ev.type === "user" && typeof content === "string") prompts.push(content);
    if (!Array.isArray(content)) continue;
    for (const b of content as Json[]) {
      if (b === null || typeof b !== "object") continue;
      if (b.type === "tool_use") facts.tools.push(typeof b.name === "string" && KNOWN_TOOL_NAMES.has(b.name) ? b.name : "other");
      else if (b.type === "text" && typeof b.text === "string") (ev.type === "user" ? prompts : ev.type === "assistant" ? said : []).push(b.text);
    }
  }
  if (prompts.length > 0) facts.prompt = prompts.join("\n\n");
  if (facts.output === null && said.length > 0) facts.output = said.join("\n\n");
  return facts;
}

// ---- span parts ----

/** At most `max` UTF-8 bytes, cut on a character boundary, with a "…[truncated]" mark when cut. */
export function truncateUtf8(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  const room = max - Buffer.byteLength(TRUNCATED);
  let cut = Buffer.from(s).subarray(0, room).toString("utf8");
  // a character split by the cut decodes as U+FFFD: drop it
  while (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: AnyValue[] } };
interface KeyValue {
  key: string;
  value: AnyValue;
}
const str = (key: string, v: string): KeyValue => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): KeyValue => ({ key, value: { intValue: String(Math.max(0, Math.round(v))) } });
const dbl = (key: string, v: number): KeyValue => ({ key, value: { doubleValue: v } });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const nanos = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? String(BigInt(ms) * 1_000_000n) : "0";
};

/**
 * The error class of a failed run, from a fixed list (never the error text). invalid_output runs are their own class.
 */
export function errorCategory(status: string, error: string | null): string | null {
  if (status === "ok" || status === "running") return null;
  if (status === "invalid_output") return "invalid_output";
  const e = error ?? "";
  if (/interrupted by restart|aborted|abandon/i.test(e)) return "interrupted";
  if (/timed? ?out|timeout/i.test(e)) return "timeout";
  if (/usage limit|rate[ _]limit|\b429\b|limit reached|paused/i.test(e)) return "usage_limit";
  if (/\b401\b|\b403\b|unauthori[sz]ed|authenticat|api key|login/i.test(e)) return "auth";
  if (/ENOENT|not found/i.test(e)) return "not_found";
  if (/denied|not allowed|violation|refused|guard/i.test(e)) return "policy";
  return "other";
}

const TOKEN_KEYS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

function usageOf(json: string | null): Partial<Record<(typeof TOKEN_KEYS)[number], number>> {
  if (json === null) return {};
  try {
    const u = JSON.parse(json) as Json;
    if (u === null || typeof u !== "object") return {};
    const out: Partial<Record<(typeof TOKEN_KEYS)[number], number>> = {};
    for (const k of TOKEN_KEYS) if (typeof u[k] === "number" && Number.isFinite(u[k])) out[k] = u[k] as number;
    return out;
  } catch {
    return {};
  }
}

/** The metadata attribute names a span may carry (C-8); the preview lists them. */
export const METADATA_ATTRIBUTES: readonly string[] = [
  "slackoff.run_id", "slackoff.role", "slackoff.ticket_key", "slackoff.executor", "slackoff.status", "slackoff.skill_version",
  "slackoff.prompt_version_id", "slackoff.duration_ms", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens",
  "slackoff.usage.input_tokens", "slackoff.usage.output_tokens", "slackoff.usage.cache_read_input_tokens",
  "slackoff.usage.cache_creation_input_tokens", "slackoff.cost_usd", "slackoff.cost_kind", "slackoff.tool_calls", "slackoff.tools",
  "slackoff.error_category", "error.type", "event tool (tool.name)",
];
export const CONTENT_ATTRIBUTES: readonly string[] = ["slackoff.prompt", "slackoff.output"];

export interface BuildOptions {
  includeContent: boolean;
  /** the run's raw log text, or null (rawLogReader; read one log at a time) */
  readRawLog: (path: string) => Promise<string | null> | string | null;
  serviceVersion: string;
  /** applied to every content item before it is cut (default: every credential value this process has seen) */
  redact?: (text: string) => string;
}

function spanOf(run: AgentRunRow, o: BuildOptions, facts: LogFacts) {
  const redact = o.redact ?? redactKnown;
  // 4C-2 (I-2): listed names only (logFacts), passed through the redactor, at most MAX_TOOL_NAMES distinct
  const seenNames = new Set<string>();
  facts = {
    ...facts,
    tools: facts.tools.map((t) => {
      const name = redact(t) === t ? t : "other";
      if (seenNames.has(name)) return name;
      if (seenNames.size >= MAX_TOOL_NAMES) return "other";
      seenNames.add(name);
      return name;
    }),
  };
  const start = run.started_at;
  const end = run.ended_at ?? run.started_at;
  const durationMs = Math.max(0, Date.parse(end) - Date.parse(start)) || 0;
  const usage = usageOf(run.usage_json);
  const counts = new Map<string, number>();
  for (const t of facts.tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  const category = errorCategory(run.status, run.error);

  const attributes: KeyValue[] = [
    str("slackoff.run_id", run.id),
    str("slackoff.role", run.role),
    ...(run.ticket_key !== null ? [str("slackoff.ticket_key", run.ticket_key)] : []),
    str("slackoff.executor", run.executor),
    str("slackoff.status", run.status),
    ...(run.skill_version !== null ? [str("slackoff.skill_version", run.skill_version)] : []),
    ...(run.prompt_version_id !== null ? [int("slackoff.prompt_version_id", run.prompt_version_id)] : []),
    int("slackoff.duration_ms", durationMs),
    ...(usage.input_tokens !== undefined ? [int("gen_ai.usage.input_tokens", usage.input_tokens)] : []),
    ...(usage.output_tokens !== undefined ? [int("gen_ai.usage.output_tokens", usage.output_tokens)] : []),
    ...TOKEN_KEYS.filter((k) => usage[k] !== undefined).map((k) => int(`slackoff.usage.${k}`, usage[k]!)),
    ...(run.cost_usd !== null ? [dbl("slackoff.cost_usd", run.cost_usd), str("slackoff.cost_kind", run.executor === "claude-api" ? "charge" : "api_equivalent_estimate")] : []),
    int("slackoff.tool_calls", facts.tools.length),
    ...(counts.size > 0 ? [{ key: "slackoff.tools", value: { arrayValue: { values: [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([t, c]) => ({ stringValue: `${t}:${c}` })) } } }] : []),
    ...(category !== null ? [str("slackoff.error_category", category), str("error.type", category)] : []),
  ];
  if (o.includeContent) {
    // redact first, then cut: a cut first could leave the start of a secret that redaction no longer recognises
    if (facts.prompt !== null) attributes.push(str("slackoff.prompt", truncateUtf8(redact(facts.prompt), CONTENT_LIMIT_BYTES)));
    if (facts.output !== null) attributes.push(str("slackoff.output", truncateUtf8(redact(facts.output), CONTENT_LIMIT_BYTES)));
  }
  const startNanos = nanos(start);
  const events = facts.tools.slice(0, MAX_TOOL_EVENTS).map((t) => ({ timeUnixNano: startNanos, name: "tool", attributes: [str("tool.name", t)] }));
  return {
    traceId: sha(run.ticket_key ?? run.id).slice(0, 32),
    spanId: sha(run.id).slice(0, 16),
    name: SPAN_NAME,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: startNanos,
    endTimeUnixNano: nanos(end),
    attributes,
    events,
    ...(facts.tools.length > MAX_TOOL_EVENTS ? { droppedEventsCount: facts.tools.length - MAX_TOOL_EVENTS } : {}),
    status: run.status === "ok" ? { code: 1 } : { code: 2, message: category ?? "error" },
  };
}

/** The OTLP/HTTP JSON body (ExportTraceServiceRequest) for these runs; the logs are read one at a time. */
export async function buildOtlpPayload(runs: AgentRunRow[], o: BuildOptions): Promise<object> {
  const spans: object[] = [];
  for (const r of runs) {
    // only the facts of a log are kept, never its text
    const facts = logFacts(r.raw_log_path === null ? null : await o.readRawLog(r.raw_log_path));
    spans.push(spanOf(r, o, facts));
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: [str("service.name", "slack-off"), str("service.version", o.serviceVersion)] },
        scopeSpans: [{ scope: { name: "slack-off" }, spans }],
      },
    ],
  };
}

// ---- sending (phase 4c Task 5) ----

/** Default time limit of one export request. */
export const OTLP_TIMEOUT_MS = 30_000;
/** At most this much of a 2xx answer is read, only for the partial-success count (never stored or shown). */
const MAX_RESPONSE_BYTES = 8 * 1024;

export interface SendResult {
  ok: boolean;
  /** the collector's HTTP status, null when no answer came */
  httpStatus: number | null;
  /** a fixed text per class (4C-2, I-1): never the collector's answer or an error message */
  detail: string | null;
}

/** The start of a response body, at most `max` bytes; the rest is never read (the stream is cancelled). */
async function readCapped(res: Response, max: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // not awaited: a cancel can wait on other readers of the same body; the rest is simply never read
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/** The number of spans in an OTLP/HTTP JSON body (resourceSpans[].scopeSpans[].spans[]). */
function spanCount(payload: object): number {
  let n = 0;
  const rs = (payload as { resourceSpans?: unknown }).resourceSpans;
  for (const r of Array.isArray(rs) ? rs : []) {
    const ss = (r as { scopeSpans?: unknown } | null)?.scopeSpans;
    for (const sc of Array.isArray(ss) ? ss : []) {
      const spans = (sc as { spans?: unknown } | null)?.spans;
      if (Array.isArray(spans)) n += spans.length;
    }
  }
  return n;
}

/**
 * One POST of an OTLP/HTTP JSON body: the stored headers plus Content-Type: application/json, a time limit, redirects
 * not followed, the answer read up to a cap. Never retried. Throws nothing: every failure is a SendResult.
 */
export async function sendOtlp(
  endpoint: string,
  headers: Record<string, string>,
  payload: object,
  o: { fetch: typeof fetch; timeoutMs?: number },
): Promise<SendResult> {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  h.set("content-type", "application/json");
  const timeoutMs = o.timeoutMs ?? OTLP_TIMEOUT_MS;
  let res: Response;
  try {
    res = await o.fetch(endpoint, { method: "POST", headers: h, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error;
    const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, httpStatus: null, detail: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : "could not reach the collector" };
  }
  const status = res.status;
  if (!(status >= 200 && status < 300)) res.body?.cancel().catch(() => {});
  if (status >= 200 && status < 300) {
    let text = "";
    try {
      text = await readCapped(res, MAX_RESPONSE_BYTES);
    } catch {
      // the answer could not be read: the status still decides
    }
    let rejected = 0;
    try {
      const r = (JSON.parse(text) as { partialSuccess?: { rejectedSpans?: unknown } }).partialSuccess?.rejectedSpans;
      // F4C-1 nit: a whole number, at most the spans this request carried (a collector cannot report more)
      const n = Math.trunc(Number(r ?? 0));
      rejected = Number.isNaN(n) || n <= 0 ? 0 : Math.min(n, spanCount(payload));
    } catch {
      // not JSON: a plain success
    }
    return { ok: true, httpStatus: status, detail: rejected > 0 ? `the collector rejected ${rejected} span(s)` : null };
  }
  // redirect: 'manual' gives the 3xx itself (or an opaque redirect, status 0): never followed
  if ((status >= 300 && status < 400) || res.type === "opaqueredirect") {
    return { ok: false, httpStatus: status === 0 ? null : status, detail: `HTTP ${status}: the collector redirected; redirects are not followed (check the endpoint)` };
  }
  if (status >= 400 && status < 500) return { ok: false, httpStatus: status, detail: `HTTP ${status}: the collector refused the export (check the endpoint and the auth headers)` };
  if (status >= 500) return { ok: false, httpStatus: status, detail: `HTTP ${status}: the collector reported an error` };
  return { ok: false, httpStatus: status, detail: `HTTP ${status}: unexpected answer from the collector` };
}
