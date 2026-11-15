// Phase 4b Task 2 (index ruling X-4, rulings B-3, B-9): the JIRA API token, the Anthropic API key and the OTLP auth
// headers live only in ${SLACKOFF_HOME}/credentials.json (file 0600, dir 0700) — never in config.json, never in an HTTP
// response (only "set / not set" and a time), and every log, audit payload or error text passes through redactSecrets.
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync,
  chmodSync, unlinkSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const CREDENTIALS_FILE = "credentials.json";

export interface Credentials {
  jira: { email: string; apiToken: string; updatedAt: string } | null;
  anthropic: { apiKey: string; updatedAt: string } | null;
  otlpHeaders: { headers: Record<string, string>; updatedAt: string } | null;
}

export interface CredentialStatus {
  jira: { set: boolean; emailHint: string | null; updatedAt: string | null };
  anthropic: { set: boolean; updatedAt: string | null };
  otlpHeaders: { set: boolean; names: string[]; updatedAt: string | null };
}

export type CredentialKind = "jira" | "anthropic" | "otlpHeaders";

/** Never carries a credential value or the file's content. */
export class CredentialFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialFileError";
  }
}

const BAD_FILE = `${CREDENTIALS_FILE} must be a regular file with mode 600 owned by you`;

// ---- value rules (B-3); messages name the rule, never the value ----

/** One line, contains '@', at most 254 characters. */
const EMAIL = z
  .string()
  .max(254, { message: "must be at most 254 characters" })
  .refine((v) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v), { message: "must be a single line" })
  .refine((v) => /^[^@\s]+@[^@\s]+$/.test(v), { message: "must be an email address" });
/** 16–512 visible ASCII characters (4B-3: long enough that redacting it never garbles ordinary text). */
const SECRET = z.string().regex(/^[\x21-\x7e]{16,512}$/, { message: "must be 16-512 visible ASCII characters (no spaces)" });
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADERS = z
  .record(z.string(), z.string().max(1024, { message: "must be at most 1024 characters" }).refine((v) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v), { message: "must be a single line" }))
  .superRefine((h, ctx) => {
    const names = Object.keys(h);
    if (names.length > 10) ctx.addIssue({ code: "custom", message: "at most 10 headers" });
    for (const n of names) if (!HEADER_NAME.test(n)) ctx.addIssue({ code: "custom", message: "header names must match ^[A-Za-z0-9-]{1,64}$" });
  });

const JiraInput = z.object({ email: EMAIL, apiToken: SECRET }).strict();
const AnthropicInput = z.object({ apiKey: SECRET }).strict();
/**
 * 4C-2 (M-2): headers fetch must not take from the developer — they change the request itself (its host, its framing,
 * the connection, a proxy) — and values a header can carry: visible ASCII, space and Latin-1 (no control characters).
 */
const DENIED_HEADER = /^(host|content-length|transfer-encoding|connection|keep-alive|upgrade|te|trailer|expect|proxy-.*)$/i;
const HEADER_VALUE = /^[\x20-\x7e\xa0-\xff]*$/;
/** Why these OTLP headers cannot be sent, or null; names the rule, never a value. Checked at PUT and before each export. */
export function otlpHeadersIssue(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (DENIED_HEADER.test(name)) return "header names host, content-length, transfer-encoding, connection, keep-alive, upgrade, te, trailer, expect and proxy-* are not allowed";
    if (!HEADER_VALUE.test(value)) return "header values must be visible ASCII or Latin-1 characters";
  }
  return null;
}
const OtlpHeadersInput = z
  .object({ headers: HEADERS })
  .strict()
  .superRefine((v, ctx) => {
    const issue = otlpHeadersIssue(v.headers);
    if (issue !== null) ctx.addIssue({ code: "custom", path: ["headers"], message: issue });
  });

export interface InputIssue {
  field: string;
  rule: string;
}
export type Validated<T> = { ok: true; value: T } | { ok: false; issues: InputIssue[] };

function validate<T>(schema: z.ZodType<T>, input: unknown): Validated<T> {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  // field path and rule only: zod's own messages for a wrong type never quote the input, and ours are fixed texts.
  // A header name is user data too, so a record key is never echoed.
  return {
    ok: false,
    issues: r.error.issues.map((i) => ({
      field: i.path.length > 0 && i.path[0] === "headers" ? "headers" : i.path.map(String).join("."),
      rule: i.code === "custom" || i.code === "too_big" || i.code === "invalid_format" ? i.message : i.code === "unrecognized_keys" ? "unknown field" : "invalid value",
    })),
  };
}

export const validateJiraInput = (input: unknown): Validated<{ email: string; apiToken: string }> => validate(JiraInput, input);
export const validateAnthropicInput = (input: unknown): Validated<{ apiKey: string }> => validate(AnthropicInput, input);
export const validateOtlpHeadersInput = (input: unknown): Validated<{ headers: Record<string, string> }> => validate(OtlpHeadersInput, input);

const AT = z.string().min(1).max(64);
const FileSchema = z
  .object({
    version: z.literal(1),
    jira: z.object({ email: EMAIL, apiToken: SECRET, updatedAt: AT }).strict().nullable(),
    anthropic: z.object({ apiKey: SECRET, updatedAt: AT }).strict().nullable(),
    otlpHeaders: z.object({ headers: HEADERS, updatedAt: AT }).strict().nullable(),
  })
  .strict();

// ---- file ----

/** Test seam: the owner the file and dir must have (default: this process's uid). */
export interface CredentialFileOptions {
  uid?: number;
  /** tests: runs after the temp file is written and synced, before the rename */
  beforeRename?: () => void;
  /** tests (4B-5, M4): runs between the lstat and the open, to swap something else in */
  afterLstat?: () => void;
}

const currentUid = (o?: CredentialFileOptions): number => o?.uid ?? process.getuid!();

function checkStat(st: { isFile(): boolean; mode: number; uid: number }, uid: number): void {
  if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== uid) throw new CredentialFileError(BAD_FILE);
}

/**
 * The stored credentials; no file → all null. A symlink, anything but a regular file, a mode looser than 0600 or
 * another owner → CredentialFileError (never fixed here, B-3). Invalid JSON or shape → CredentialFileError without
 * the content.
 */
export function readCredentials(home: string, o?: CredentialFileOptions): Credentials {
  const path = join(home, CREDENTIALS_FILE);
  const uid = currentUid(o);
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new CredentialFileError(BAD_FILE);
    checkStat(st, uid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { jira: null, anthropic: null, otlpHeaders: null };
    // 4B-5 (M3): ENOTDIR, EACCES, ELOOP…: the code only, never the absolute path
    throw err instanceof CredentialFileError ? err : new CredentialFileError(`${CREDENTIALS_FILE} cannot be read (${codeOf(err)})`);
  }
  o?.afterLstat?.();
  let fd: number;
  try {
    // O_NOFOLLOW / O_NONBLOCK: a link or FIFO swapped in after the lstat is refused, never followed or waited on
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new CredentialFileError(BAD_FILE);
  }
  let text: string;
  try {
    checkStat(fstatSync(fd), uid);
    text = readFileSync(fd, "utf8");
  } catch (err) {
    throw err instanceof CredentialFileError ? err : new CredentialFileError(`${CREDENTIALS_FILE} cannot be read (${codeOf(err)})`);
  } finally {
    closeSync(fd);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CredentialFileError(`${CREDENTIALS_FILE} is not valid JSON: fix or delete it, then set the credentials again`);
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.slice(0, 2).map(String).join(".") || "(file)"))].join(", ");
    throw new CredentialFileError(`${CREDENTIALS_FILE} has invalid fields (${fields}): fix or delete it, then set the credentials again`);
  }
  const { jira, anthropic, otlpHeaders } = parsed.data;
  const c = { jira, anthropic, otlpHeaders };
  remember(c);
  return c;
}

const codeOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "error";
};

/** SLACKOFF_HOME as 0700: created so, or tightened after its owner is checked. */
function ensureHomeDir(home: string, uid: number): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const st = statSync(home);
  if (!st.isDirectory() || st.uid !== uid) throw new CredentialFileError(`the Slack Off folder must be a directory owned by you to hold ${CREDENTIALS_FILE}`);
  if ((st.mode & 0o777) !== 0o700) chmodSync(home, 0o700);
}

/**
 * Atomic replace: `<file>.tmp-<pid>` created exclusively with mode 0600, written, fsynced, renamed over the file, the
 * dir fsynced. The current file (when there is one) must pass the read checks first — a bad one is not overwritten.
 */
export function writeCredentials(home: string, next: Credentials, o?: CredentialFileOptions): void {
  const parsed = FileSchema.safeParse({ version: 1, ...next });
  if (!parsed.success) throw new CredentialFileError("refusing to write invalid credentials");
  const uid = currentUid(o);
  // 4B-2: remembered before anything can fail, so an error echoing the new value is redacted too
  remember(parsed.data);
  ensureHomeDir(home, uid);
  readCredentials(home, o);
  const path = join(home, CREDENTIALS_FILE);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    unlinkSync(tmp); // a leftover from a crash, or anything planted under the name: removed, never written through
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let fd: number | null = null;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    const data = Buffer.from(JSON.stringify(parsed.data, null, 2) + "\n");
    for (let off = 0; off < data.length; ) off += writeSync(fd, data, off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    o?.beforeRename?.();
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
  try {
    const dfd = openSync(home, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // not every file system syncs a directory; the rename itself is atomic
  }
}

// ---- status & redaction ----

/** `a…@example.com`: the first character of the local part and the domain. */
function emailHint(email: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, 1)}…${email.slice(at)}`;
}

/** What any device may see (B-9): set / not set and when; the email hint only for this computer. */
export function credentialStatus(c: Credentials, local: boolean): CredentialStatus {
  return {
    jira: { set: c.jira !== null, emailHint: c.jira && local ? emailHint(c.jira.email) : null, updatedAt: c.jira?.updatedAt ?? null },
    anthropic: { set: c.anthropic !== null, updatedAt: c.anthropic?.updatedAt ?? null },
    otlpHeaders: { set: c.otlpHeaders !== null, names: c.otlpHeaders ? Object.keys(c.otlpHeaders.headers).sort() : [], updatedAt: c.otlpHeaders?.updatedAt ?? null },
  };
}

export const REDACTED = "[redacted]";
/** 4B-3 (M2): a shorter value is never redacted (it would garble ordinary text; tokens and keys are 16+ characters). */
export const MIN_REDACTED_LENGTH = 8;

const HTML: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
const htmlEscape = (v: string, apos: string): string => v.replace(/[&<>"']/g, (ch) => (ch === "'" ? apos : HTML[ch]!));
const b64Forms = (v: string): string[] => {
  const b = Buffer.from(v).toString("base64");
  return [b, b.replace(/=+$/, ""), Buffer.from(v).toString("base64url")];
};

/**
 * Each value as it may appear in a text (4B-5, M5): raw, JSON-escaped, URL-encoded (%XX and %xx, and the form
 * encoding with "+"), HTML-escaped (&#39; and &#x27;), and base64 / base64url of the value alone.
 */
function forms(v: string): string[] {
  const uri = encodeURIComponent(v);
  return [
    v, JSON.stringify(v).slice(1, -1), uri, uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    new URLSearchParams({ k: v }).toString().slice(2), htmlEscape(v, "&#39;"), htmlEscape(v, "&#x27;"), ...b64Forms(v),
  ];
}

/** The secret values of a credentials object: the JIRA email and token and their Basic pair, the key, header values. */
function valuesOf(c: Credentials): string[] {
  const out: string[] = [];
  if (c.jira) out.push(c.jira.apiToken, c.jira.email, `${c.jira.email}:${c.jira.apiToken}`);
  if (c.anthropic) out.push(c.anthropic.apiKey);
  if (c.otlpHeaders) for (const v of Object.values(c.otlpHeaders.headers)) out.push(v, ...schemeParts(v));
  return out;
}

const AUTH_SCHEME = /^\s*(bearer|basic)\s+(\S+)\s*$/i;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * F4C-1 (M-5): a header value "Bearer <token>" or "Basic <base64>" also redacts what a service may echo alone: the token
 * after the scheme, and for Basic the decoded "user:pass" and each half. A derived value under 8 characters adds nothing.
 */
function schemeParts(value: string): string[] {
  const m = AUTH_SCHEME.exec(value);
  if (m === null) return [];
  const token = m[2]!;
  const out = [token];
  if (m[1]!.toLowerCase() === "basic" && BASE64.test(token)) {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    // only a decoding that is a printable "user:pass" (anything else was not Basic credentials)
    if (colon >= 0 && !/[\u0000-\u001f\u007f�]/.test(decoded)) out.push(decoded, decoded.slice(0, colon), decoded.slice(colon + 1));
  }
  return out.filter((v) => v.length >= MIN_REDACTED_LENGTH);
}

function needlesOf(values: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const v of values) for (const f of forms(v)) if (f.length >= MIN_REDACTED_LENGTH) all.add(f);
  return [...all].sort((a, b) => b.length - a.length);
}

function redactWith(text: string, needles: readonly string[]): string {
  let out = text;
  for (const n of needles) if (out.includes(n)) out = out.split(n).join(REDACTED);
  return out;
}

/**
 * 4B-2: every value this process has read or written (never persisted). A replaced or removed value, or one in a file
 * that no longer passes the checks, stays redacted.
 */
const known = new Set<string>();
let knownNeedles: string[] = [];
function remember(c: Credentials): void {
  let added = false;
  for (const v of valuesOf(c)) {
    if (!known.has(v)) {
      known.add(v);
      added = true;
    }
  }
  if (added) knownNeedles = needlesOf(known);
}

/** Every value of `c` (8+ characters, in each form above) replaced by "[redacted]", longest first. */
export function redactSecrets(text: string, c: Credentials): string {
  return redactWith(text, needlesOf(valuesOf(c)));
}

/** redactSecrets with every value this process has ever read or written. */
export function redactKnown(text: string): string {
  return knownNeedles.length === 0 ? text : redactWith(text, knownNeedles);
}

/**
 * Every string inside a value redacted (bus events, issue lists): plain objects and arrays are copied; an Error (its
 * message and stack) and any other class instance (its own enumerable string fields) are redacted in place, so they
 * keep their class (4B-6). F4D-1 (M8): `redact` (default: every remembered value) applies to each string on its own, so a
 * value with a quote or a backslash, or one next to an escape, is found the way it is in the text.
 */
export function redactDeep<T>(value: T, redact: (text: string) => string = redactKnown): T {
  if (redact === redactKnown && knownNeedles.length === 0) return value;
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v);
    if (v === null || typeof v !== "object" || seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    if (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    const o = v as Record<string, unknown>;
    try {
      if (v instanceof Error) {
        v.message = redact(v.message);
        if (typeof v.stack === "string") v.stack = redact(v.stack);
      }
      for (const [k, x] of Object.entries(o)) if (typeof x === "string") o[k] = redact(x);
    } catch {
      // a frozen or read-only object: left as it is
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Phase 4b task 6: a redactor for `values` held in hand (the API key a run is started with), in every form above,
 * plus every value this process has seen: the values join the remembered set (never persisted).
 */
export function redactorWith(values: readonly string[]): (text: string) => string {
  let added = false;
  for (const v of values) {
    if (!known.has(v)) {
      known.add(v);
      added = true;
    }
  }
  if (added) knownNeedles = needlesOf(known);
  return redactKnown;
}

/**
 * The current file (read, so its values join the remembered set) plus every value seen before; an unreadable file
 * falls back to the remembered set (4B-2: fails closed to it).
 */
export function redactStored(home: string, text: string): string {
  try {
    readCredentials(home);
  } catch {
    // the remembered values still apply
  }
  return redactKnown(text);
}

/** A redactor bound to one run (runAgent, the API clients): the file is read once when it is made. */
export function redactorFor(home: string): (text: string) => string {
  try {
    readCredentials(home);
  } catch {
    // the remembered values still apply
  }
  return redactKnown;
}
