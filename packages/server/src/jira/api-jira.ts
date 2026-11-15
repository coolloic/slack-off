// Phase 4b Task 4: the JIRA API mode (Jira Cloud REST v3, email + API token; rulings B-6, B-7, B-8). The same three
// interfaces as the browser mode — TicketSource, JiraUpdater, JiraCommenter — so discovery, the confirmed writes, their
// read-back verification, the audit and the no-auto-retry rule stay in the phase 2/3 jobs unchanged.
//
// Every request carrying the credentials goes to `${jira.baseUrl}/rest/api/3/…` only, with `redirect: 'manual'`; the
// one exception is an attachment's content, whose 3xx is followed once, https only, without Authorization (B-7).
// Response fields naming other URLs (`self`, an attachment's `content`) are never requested. Every error text is
// redacted (the token, the Basic header, the email) before it is cut short or leaves this module.
import { isTicketKey, type DiscoverResult, type FetchedTicket, type JiraCommentResult, type JiraUpdateResult, type TicketSummary } from "@slackoff/shared";
import { isValidReadyForDevStatus, type Config } from "../config.ts";
import { redactKnown, redactSecrets, type Credentials } from "../credentials/credential-store.ts";
import { isIP } from "node:net";
import { adfToText, textToAdf } from "./adf.ts";
import { DISCOVER_JQL } from "./browser-jira.ts";
import { commentTextError, normalizeCommentText, type JiraCommenter } from "./jira-commenter.ts";
import type { JiraUpdater } from "./jira-updater.ts";
import { JiraLoginRequiredError, JiraNotConfiguredError, type TicketSource } from "./ticket-source.ts";

export type Fetch = typeof fetch;

export interface ApiJiraDeps {
  fetch: Fetch;
  /** read on every call (a Settings change applies at once) */
  config: () => Config["jira"];
  /** read on every call, from credentials.json (Task 2) */
  credentials: () => Credentials["jira"];
  now?: () => number;
  /** waits before the one 429 retry (tests record it) */
  sleep?: (ms: number) => Promise<void>;
}

const API = "/rest/api/3";
const TIMEOUT_MS = 30_000;
const PAGE_MAX = 100;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_RETRY_AFTER_S = 30;
const MAX_ERROR_CHARS = 300;
/** 4B-8: the most this module reads of one answer — JSON, an error body, an attachment (MAX_IMAGE_BYTES) */
const MAX_JSON_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
/** 4B-8: comments read per ticket; the rest are marked "not loaded" (the snapshot's marker) */
const MAX_COMMENTS = 1000;
const MB = 1024 * 1024;
/** F4B-2: per ticket, at most this many images downloaded and this many attachment bytes read in all */
const ATTACHMENT_MAX_IMAGES = 20;
const ATTACHMENT_BUDGET = 50 * MB;
/** F4B-2: per ticket, at most this many bytes of comment pages */
const COMMENT_BUDGET = 20 * MB;
/** 4B-8: extra discovery pages allowed beyond ceil(limit / 100) */
const EXTRA_PAGES = 5;
const MAYBE_POSTED = "may have been posted — check JIRA before retrying";
const REFUSED = "JIRA refused (no permission?)";
const TOKEN_REJECTED = "The JIRA API token was rejected — update it in Settings → JIRA";
const NO_TOKEN = "Set your JIRA email and API token in Settings → JIRA (the JIRA API mode needs them)";
const REDIRECTED = "JIRA answered with a redirect; check the JIRA URL";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * `${base}/rest/api/3${path}`: the only URLs that ever carry the credentials. The result must keep the base's origin
 * and lie under its /rest/api/3/ path (a `..`, an encoded one or an `@` in `path` is refused).
 */
export function restUrl(base: string, path: string, query?: Record<string, string>): string {
  const b = new URL(base);
  const prefix = `${b.pathname.replace(/\/+$/, "")}${API}/`;
  let u: URL;
  try {
    u = new URL(`${base.replace(/\/+$/, "")}${API}${path}`);
  } catch {
    throw new Error("refusing a JIRA request outside the configured URL");
  }
  if (!path.startsWith("/") || u.origin !== b.origin || !u.pathname.startsWith(prefix) || u.username !== "" || u.password !== "") {
    throw new Error("refusing a JIRA request outside the configured URL");
  }
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

/** 4B-9 (M6): a redirect target the attachment read may follow — a public DNS name, never an IP literal or a local name. */
function publicHost(u: URL): boolean {
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) !== 0) return false;
  if (!host.includes(".") || host === "localhost" || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return false;
  return true;
}

/**
 * At most `max` bytes of a body (4B-8). A declared content-length over `max` reads nothing; the stream is cut off at
 * `max`. "cap": null when the body is larger; "truncate": its first `max` bytes.
 */
async function readBody(res: Response, max: number, mode: "cap" | "truncate", meter?: { bytes: number }): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (mode === "cap" && Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (res.body === null) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
      size += value.byteLength;
      if (meter !== undefined) meter.bytes += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        if (mode === "cap") return null;
        return Buffer.concat(parts).subarray(0, max);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}

/** One call's connection: the base, the Basic header and the redaction for its credentials. */
interface Conn {
  base: string;
  auth: string;
  redact: (text: string) => string;
}

/** F4B-2: an answer larger than the call allows (the JSON cap, or what is left of a budget). */
class TooLargeError extends Error {}

/** Thrown for a non-2xx answer the caller may turn into a result (a failed write). */
export class JiraHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "JiraHttpError";
    this.status = status;
  }
}

function checkKey(key: string): void {
  if (!isTicketKey(key)) throw new Error(`Invalid ticket key ${JSON.stringify(key.slice(0, 40))}`);
}

/** The shared REST client of the three API-mode classes. */
class JiraRest {
  readonly #deps: ApiJiraDeps;
  constructor(deps: ApiJiraDeps) {
    this.#deps = deps;
  }

  /** The base URL and credentials as they are now; missing → JiraNotConfiguredError (never the browser mode). */
  conn(): Conn {
    const cfg = this.#deps.config();
    if (cfg.baseUrl === "") throw new JiraNotConfiguredError();
    const base = cfg.baseUrl.replace(/\/+$/, "");
    if (new URL(base).protocol !== "https:") throw new JiraNotConfiguredError("The JIRA URL must start with https://");
    const creds = this.#deps.credentials();
    if (creds === null) throw new JiraNotConfiguredError(NO_TOKEN);
    const auth = `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`;
    const own: Credentials = { jira: creds, anthropic: null, otlpHeaders: null };
    return { base, auth, redact: (t) => redactKnown(redactSecrets(t, own)) };
  }

  #url(c: Conn, path: string, query?: Record<string, string>): string {
    return restUrl(c.base, path, query);
  }

  async #send(url: string, init: RequestInit, c: Conn): Promise<Response> {
    try {
      return await this.#deps.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      const e = err as Error;
      if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error(`JIRA did not answer within ${TIMEOUT_MS / 1000} s`);
      throw new Error(c.redact(`Could not reach JIRA: ${e?.message ?? String(err)}`));
    }
  }

  /** An error text from a response: redacted first, then cut short (4B-2). */
  async #errorText(res: Response, what: string, c: Conn): Promise<string> {
    let body = "";
    try {
      body = (await readBody(res, MAX_ERROR_BYTES, "truncate"))?.toString("utf8") ?? "";
    } catch {
      // no body
    }
    const full = c.redact(`JIRA answered ${res.status} for ${what}${body.trim() ? `: ${body.trim()}` : ""}`);
    return full.length > MAX_ERROR_CHARS ? `${full.slice(0, MAX_ERROR_CHARS)}…` : full;
  }

  /**
   * One REST call. 3xx → error (never followed); 401/403 → JiraLoginRequiredError; 429 → one retry after Retry-After
   * (≤ 30 s) for a read, none for a write; another non-2xx → JiraHttpError with the redacted text.
   */
  async call(
    method: "GET" | "POST",
    path: string,
    o: { query?: Record<string, string>; body?: unknown; write?: boolean; maxBytes?: number; meter?: { bytes: number } } = {},
  ): Promise<{ status: number; json: unknown }> {
    const c = this.conn();
    const url = this.#url(c, path, o.query);
    const what = `${method} ${API}${path}`;
    const init: RequestInit = {
      method,
      headers: { authorization: c.auth, accept: "application/json", ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    };
    for (let attempt = 0; ; attempt++) {
      const res = await this.#send(url, init, c);
      if (res.status >= 300 && res.status < 400) throw new Error(REDIRECTED);
      // 4B-9 (M2): a 403 on a write is JIRA refusing that change (a permission), not a rejected token
      if (res.status === 403 && o.write) {
        await res.body?.cancel().catch(() => {});
        throw new JiraHttpError(`${REFUSED} for ${what}`, 403);
      }
      if (res.status === 401 || res.status === 403) throw new JiraLoginRequiredError(TOKEN_REJECTED);
      if (res.status === 429) {
        const after = Number(res.headers.get("retry-after") ?? "1");
        if (!o.write && attempt === 0 && Number.isFinite(after) && after >= 0 && after <= MAX_RETRY_AFTER_S) {
          await (this.#deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(after * 1000);
          continue;
        }
        throw new JiraHttpError(`JIRA is rate limiting requests (${what}); try again later`, 429);
      }
      if (res.status < 200 || res.status >= 300) throw new JiraHttpError(await this.#errorText(res, what, c), res.status);
      const max = Math.min(o.maxBytes ?? MAX_JSON_BYTES, MAX_JSON_BYTES);
      const bytes = await readBody(res, max, "cap", o.meter);
      if (bytes === null) throw new TooLargeError(`JIRA's answer to ${what} is larger than ${max === MAX_JSON_BYTES ? "10 MB" : `${max} bytes`}`);
      const text = bytes.toString("utf8");
      if (text.trim() === "") return { status: res.status, json: null };
      try {
        return { status: res.status, json: JSON.parse(text) };
      } catch {
        throw new Error(`JIRA answered ${what} with something that is not JSON`);
      }
    }
  }

  /**
   * An attachment's bytes (B-7): `${base}/rest/api/3/attachment/content/{id}` with the credentials; a 3xx is followed
   * once, to https only and without Authorization (a signed URL). Anything else → null (metadata only).
   */
  async attachment(id: string, max = MAX_IMAGE_BYTES, meter?: { bytes: number }): Promise<Buffer | null> {
    const c = this.conn();
    try {
      return await this.#attachment(c, id, Math.min(max, MAX_IMAGE_BYTES), meter);
    } catch (err) {
      // F4B-2 (M-5): a timeout, an abort or a broken stream leaves the attachment as metadata; a rejected token stays an error
      if (err instanceof JiraLoginRequiredError) throw err;
      return null;
    }
  }

  async #attachment(c: Conn, id: string, max: number, meter?: { bytes: number }): Promise<Buffer | null> {
    const url = this.#url(c, `/attachment/content/${encodeURIComponent(id)}`);
    let res = await this.#send(url, { method: "GET", headers: { authorization: c.auth } }, c);
    if (res.status === 401 || res.status === 403) throw new JiraLoginRequiredError(TOKEN_REJECTED);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      let next: URL;
      try {
        next = new URL(loc ?? "", url);
      } catch {
        return null;
      }
      if (next.protocol !== "https:" || next.username !== "" || next.password !== "" || !publicHost(next)) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      await res.body?.cancel().catch(() => {});
      res = await this.#send(next.toString(), { method: "GET" }, c);
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return readBody(res, max, "cap", meter);
  }
}

const summaryOf = (base: string, issue: unknown): TicketSummary | null => {
  if (!isObj(issue) || typeof issue.key !== "string") return null;
  const f = isObj(issue.fields) ? issue.fields : {};
  const status = isObj(f.status) ? (str(f.status.name) ?? "") : "";
  return { key: issue.key, title: str(f.summary) ?? "", url: `${base}/browse/${issue.key}`, status };
};

/** Media nodes of an ADF document (inline images): their alt text or id. */
function mediaNames(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!isObj(n)) return;
    if (n.type === "media" && isObj(n.attrs)) {
      const name = str(n.attrs.alt) || str(n.attrs.id);
      if (name) out.push(name);
    }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(doc);
  return out;
}

const commentOf = (c: unknown): FetchedTicket["comments"][number] | null => {
  if (!isObj(c)) return null;
  const id = str(c.id);
  if (id === null) return null;
  const author = isObj(c.author) ? (str(c.author.displayName) ?? "") : "";
  return { jiraCommentId: id, author, created: str(c.created) ?? "", body: adfToText(c.body) };
};

export class ApiJiraSource implements TicketSource {
  readonly #rest: JiraRest;
  readonly #deps: ApiJiraDeps;
  constructor(deps: ApiJiraDeps) {
    this.#deps = deps;
    this.#rest = new JiraRest(deps);
  }

  /**
   * POST /search/jql page by page (nextPageToken) up to jira.discoverLimit. `complete` only when JIRA said the last
   * page was read; a failing later page keeps what was read (complete false); a failing first page throws.
   */
  async discover(): Promise<DiscoverResult> {
    const { base } = this.#rest.conn();
    const limit = this.#deps.config().discoverLimit;
    const tickets: TicketSummary[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    let complete = false;
    const tokens = new Set<string>();
    // 4B-8 (I1): a bounded number of pages, whatever tokens JIRA hands out
    const maxPages = Math.ceil(limit / PAGE_MAX) + EXTRA_PAGES;
    for (let page = 0; tickets.length < limit && page < maxPages; page++) {
      let json: unknown;
      try {
        ({ json } = await this.#rest.call("POST", "/search/jql", {
          body: { jql: DISCOVER_JQL, fields: ["summary", "status", "updated"], maxResults: Math.min(PAGE_MAX, limit - tickets.length), ...(token !== undefined ? { nextPageToken: token } : {}) },
        }));
      } catch (err) {
        if (page === 0) throw err;
        break;
      }
      const issues = isObj(json) && Array.isArray(json.issues) ? json.issues : null;
      if (issues === null) {
        if (page === 0) throw new Error("JIRA's search answer has no issues list");
        break;
      }
      let added = 0;
      for (const issue of issues) {
        const s = summaryOf(base, issue);
        if (s === null || seen.has(s.key)) continue;
        seen.add(s.key);
        tickets.push(s);
        added++;
      }
      const next = isObj(json) ? str(json.nextPageToken) : null;
      if (isObj(json) && json.isLast === true) {
        complete = true;
        break;
      }
      // a page that adds nothing new is no progress: an incomplete read
      if (added === 0) break;
      // no way on (no token, or one already used) is an incomplete read
      if (next === null || tokens.has(next)) break;
      tokens.add(next);
      token = next;
    }
    const read = tickets.slice(0, limit);
    if (tickets.length > limit) complete = false;
    return { loginRequired: false, tickets: read, total: read.length, complete };
  }

  async fetchTicket(key: string): Promise<FetchedTicket> {
    checkKey(key);
    const { base } = this.#rest.conn();
    const path = `/issue/${encodeURIComponent(key)}`;
    const { json } = await this.#rest.call("GET", path, { query: { fields: "summary,description,status,updated,attachment,comment", expand: "renderedFields" } });
    if (!isObj(json) || !isObj(json.fields)) throw new Error(`JIRA's answer for ${key} has no fields`);
    const f = json.fields;
    // comments: each id once; `newest` holds the pages read from the end, newest page first
    const ids = new Set<string>();
    const fresh = (list: unknown): FetchedTicket["comments"] => {
      const out: FetchedTicket["comments"] = [];
      for (const c of Array.isArray(list) ? list : []) {
        const x = commentOf(c);
        if (x === null || ids.has(x.jiraCommentId)) continue;
        ids.add(x.jiraCommentId);
        out.push(x);
      }
      return out;
    };
    const embedded = isObj(f.comment) ? f.comment : {};
    const embeddedList = Array.isArray(embedded.comments) ? embedded.comments : [];
    const total = typeof embedded.total === "number" ? embedded.total : embeddedList.length;
    // 4B-8 (I2) / 4B-10: at most MAX_COMMENTS are read — the NEWEST ones (drift checks need the latest discussion); the
    // older ones are marked not loaded. F4B-2: the pages are read from the end backwards within one COMMENT_BUDGET of
    // bytes, so a budget that runs out still leaves the newest run (and the marker counts exactly the older ones).
    // Up to MAX_COMMENTS, the page embedded in the issue is the start (no request for it).
    const from = Math.max(0, total - MAX_COMMENTS);
    const head = from === 0 ? Math.min(embeddedList.length, total) : 0;
    const newest: FetchedTicket["comments"][] = [];
    const meter = { bytes: 0 };
    let end = total;
    let complete = true;
    while (end > from + head) {
      const start = Math.max(from + head, end - PAGE_MAX);
      const left = COMMENT_BUDGET - meter.bytes;
      if (left <= 0) {
        complete = false;
        break;
      }
      let page: unknown;
      try {
        ({ json: page } = await this.#rest.call("GET", `${path}/comment`, { query: { startAt: String(start), maxResults: String(end - start) }, maxBytes: left, meter }));
      } catch (err) {
        if (!(err instanceof TooLargeError) || meter.bytes === 0) throw err;
        complete = false;
        break;
      }
      const got = isObj(page) ? fresh(page.comments) : [];
      if (got.length === 0) {
        complete = false;
        break;
      }
      newest.push(got);
      end = start;
    }
    const comments: FetchedTicket["comments"] = complete && head > 0 ? fresh(embeddedList) : [];
    for (const page of newest.reverse()) comments.push(...page);
    // attachments: images up to 5 MB downloaded through the id-based URL (never the `content` field); the images the
    // description shows (ADF media nodes) are inline images. F4B-2: at most ATTACHMENT_MAX_IMAGES downloads and
    // ATTACHMENT_BUDGET bytes per ticket; the rest stay metadata, counted in the description's note.
    const inline = new Set(mediaNames(f.description));
    const attachments: FetchedTicket["attachments"] = [];
    const named = new Set<string>();
    const pulled = { bytes: 0 };
    let downloads = 0;
    let overBudget = 0;
    for (const a of Array.isArray(f.attachment) ? f.attachment : []) {
      if (!isObj(a)) continue;
      const id = str(a.id);
      const filename = str(a.filename) ?? "attachment";
      const mime = str(a.mimeType) ?? "application/octet-stream";
      if (id === null || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      const size = typeof a.size === "number" ? a.size : Number.POSITIVE_INFINITY;
      let bytes: Buffer | null = null;
      if (mime.startsWith("image/") && size <= MAX_IMAGE_BYTES) {
        const left = ATTACHMENT_BUDGET - pulled.bytes;
        if (downloads >= ATTACHMENT_MAX_IMAGES || size > left) overBudget++;
        else {
          downloads++;
          bytes = await this.#rest.attachment(id, left, pulled);
        }
      }
      named.add(filename);
      attachments.push({
        kind: inline.has(filename) ? "inline_image" : "attachment",
        filename,
        mime,
        url: `${base}${API}/attachment/content/${encodeURIComponent(id)}`,
        base64: bytes === null ? null : bytes.toString("base64"),
      });
    }
    for (const name of inline) {
      if (!named.has(name)) attachments.push({ kind: "inline_image", filename: name, mime: "application/octet-stream", url: "", base64: null });
    }
    if (comments.length > MAX_COMMENTS) comments.splice(0, comments.length - MAX_COMMENTS);
    const notLoaded = Math.max(0, total - comments.length);
    // F4B-2: why some attachments are metadata only (before the comments marker, which must stay the last line)
    const budgetNote = overBudget > 0 ? `\n[slackoff: ${overBudget} attachments not downloaded (over the per-ticket budget of ${ATTACHMENT_MAX_IMAGES} images / ${ATTACHMENT_BUDGET / MB} MB)]` : "";
    // the snapshot store's marker (skills/jira-browser rule 5): "[slackoff: N older comments not loaded]"
    const description = adfToText(f.description) + budgetNote + (notLoaded > 0 ? `\n[slackoff: ${notLoaded} older comments not loaded]` : "");
    return {
      loginRequired: false,
      key: str(json.key) ?? key,
      title: str(f.summary) ?? "",
      description,
      jiraUpdatedAt: str(f.updated),
      status: isObj(f.status) ? str(f.status.name) : null,
      comments,
      attachments,
    };
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class ApiJiraUpdater implements JiraUpdater {
  readonly #rest: JiraRest;
  constructor(deps: ApiJiraDeps) {
    this.#rest = new JiraRest(deps);
  }

  async #status(path: string): Promise<string | null> {
    const { json } = await this.#rest.call("GET", path, { query: { fields: "status" } });
    return isObj(json) && isObj(json.fields) && isObj(json.fields.status) ? str(json.fields.status.name) : null;
  }

  /**
   * The four outcomes of the browser mode: already_in_status (ignoring case), changed (exactly one transition to the
   * target, without required fields), transition_unavailable (none — never a similar one), failed (several, required
   * fields, or the POST refused). The jobs verify `changed` with a read-back.
   */
  async setStatus(key: string, targetStatus: string): Promise<JiraUpdateResult> {
    checkKey(key);
    if (!isValidReadyForDevStatus(targetStatus)) throw new Error("Invalid target status");
    this.#rest.conn();
    const path = `/issue/${encodeURIComponent(key)}`;
    const current = await this.#status(path);
    const result = (outcome: JiraUpdateResult["outcome"], observedStatus: string | null, detail = ""): JiraUpdateResult => ({ loginRequired: false, outcome, observedStatus, detail });
    if (current !== null && same(current, targetStatus)) return result("already_in_status", current);
    const { json } = await this.#rest.call("GET", `${path}/transitions`, { query: { expand: "transitions.fields" } });
    const list = isObj(json) && Array.isArray(json.transitions) ? json.transitions.filter(isObj) : [];
    const matches = list.filter((t) => isObj(t.to) && typeof t.to.name === "string" && same(t.to.name, targetStatus));
    if (matches.length === 0) return result("transition_unavailable", current, `no transition leads to "${targetStatus}"`);
    if (matches.length > 1) return result("failed", current, `ambiguous transition: ${matches.length} transitions lead to "${targetStatus}"`);
    const t = matches[0]!;
    const fields = isObj(t.fields) ? Object.values(t.fields) : [];
    if (fields.some((x) => isObj(x) && x.required === true)) return result("failed", current, "the transition asks for a required field; change it in JIRA");
    const id = str(t.id);
    if (id === null) return result("failed", current, "the transition has no id");
    try {
      await this.#rest.call("POST", `${path}/transitions`, { body: { transition: { id } }, write: true });
    } catch (err) {
      if (err instanceof JiraLoginRequiredError) throw err;
      if (err instanceof JiraHttpError && err.status < 500) return result("failed", current, err.message);
      // 4B-9 (M1): a 5xx, a network error or a timeout — JIRA may have made the change: read it back
      let now: string | null = null;
      try {
        now = await this.#status(path);
      } catch {
        // still unknown
      }
      if (now !== null && same(now, targetStatus)) return result("changed", now);
      return result("failed", now ?? current, `${(err as Error).message}; the change ${MAYBE_POSTED}`);
    }
    return result("changed", await this.#status(path));
  }
}

export class ApiJiraCommenter implements JiraCommenter {
  readonly #rest: JiraRest;
  constructor(deps: ApiJiraDeps) {
    this.#rest = new JiraRest(deps);
  }

  /** One POST of the text as ADF (one paragraph per line); never retried. The jobs verify it with a read-back. */
  async postComment(key: string, text: string): Promise<JiraCommentResult> {
    checkKey(key);
    const bad = commentTextError(text);
    if (bad !== null) throw new Error(bad);
    this.#rest.conn();
    const path = `/issue/${encodeURIComponent(key)}/comment`;
    try {
      await this.#rest.call("POST", path, { body: { body: textToAdf(text) }, write: true });
    } catch (err) {
      if (err instanceof JiraLoginRequiredError) throw err;
      if (err instanceof JiraHttpError && err.status < 500) return { loginRequired: false, outcome: "failed", detail: err.message };
      // 4B-9 (M1): a 5xx, a network error or a timeout — the comment may be there: read the newest ones back (the
      // jobs' own read-back then checks the count too)
      try {
        const { json } = await this.#rest.call("GET", path, { query: { orderBy: "-created", maxResults: "50" } });
        const list = isObj(json) && Array.isArray(json.comments) ? json.comments : [];
        const want = normalizeCommentText(text);
        if (list.some((c) => isObj(c) && normalizeCommentText(adfToText(c.body)) === want)) return { loginRequired: false, outcome: "posted", detail: "" };
      } catch {
        // still unknown
      }
      return { loginRequired: false, outcome: "failed", detail: `${(err as Error).message}; the comment ${MAYBE_POSTED}` };
    }
    return { loginRequired: false, outcome: "posted", detail: "" };
  }
}
