// Phase 4b Task 2 (rulings X-4, B-3, B-9): the local credentials file. Every value here is an obvious fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers/tmp.ts";
import {
  CREDENTIALS_FILE, CredentialFileError, credentialStatus, readCredentials, redactKnown, redactSecrets, redactStored, writeCredentials, validateJiraInput,
  validateAnthropicInput, validateOtlpHeadersInput, type Credentials,
} from "../src/credentials/credential-store.ts";

const fake = (prefix: string) => `${prefix}${randomBytes(8).toString("hex")}`;
const EMPTY: Credentials = { jira: null, anthropic: null, otlpHeaders: null };
const AT = "2026-11-09T10:00:00.000Z";

function sample(): Credentials {
  return {
    jira: { email: "you@example.com", apiToken: fake("test-token-"), updatedAt: AT },
    anthropic: { apiKey: fake("test-key-"), updatedAt: AT },
    otlpHeaders: { headers: { "x-api-key": fake("test-otlp-") }, updatedAt: AT },
  };
}

test("no file -> every credential is null", () => {
  const home = tmpDir("cred");
  assert.deepEqual(readCredentials(home), EMPTY);
});

test("write then read: file 0600, home dir 0700, values round-trip, version 1 on disk", () => {
  const home = tmpDir("cred");
  chmodSync(home, 0o755);
  const c = sample();
  writeCredentials(home, c);
  const file = join(home, CREDENTIALS_FILE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.deepEqual(readCredentials(home), c);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
  assert.deepEqual(readdirSync(home).filter((n) => n.includes(".tmp-")), []);
});

test("a missing home dir is created 0700", () => {
  const home = join(tmpDir("cred"), "new-home");
  writeCredentials(home, sample());
  assert.equal(statSync(home).mode & 0o777, 0o700);
});

test("mode looser than 0600 -> CredentialFileError, never auto-fixed", () => {
  const home = tmpDir("cred");
  const c = sample();
  writeCredentials(home, c);
  const file = join(home, CREDENTIALS_FILE);
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    chmodSync(file, mode);
    assert.throws(() => readCredentials(home), (e: unknown) => e instanceof CredentialFileError && /mode 600 owned by you/.test(e.message));
    assert.equal(statSync(file).mode & 0o777, mode, "not auto-fixed");
  }
  chmodSync(file, 0o400);
  assert.deepEqual(readCredentials(home), c, "0400 is not looser than 0600");
});

test("a symlink, a directory or a FIFO in its place -> CredentialFileError; a write does not follow the link", () => {
  const home = tmpDir("cred");
  const target = join(tmpDir("cred-target"), "elsewhere.json");
  writeFileSync(target, JSON.stringify({ version: 1, ...EMPTY }), { mode: 0o600 });
  symlinkSync(target, join(home, CREDENTIALS_FILE));
  assert.throws(() => readCredentials(home), CredentialFileError);
  assert.throws(() => writeCredentials(home, sample()), CredentialFileError);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { version: 1, ...EMPTY }, "the link target is untouched");

  const home2 = tmpDir("cred");
  mkdirSync(join(home2, CREDENTIALS_FILE));
  assert.throws(() => readCredentials(home2), CredentialFileError);

  const home3 = tmpDir("cred");
  execFileSync("/usr/bin/mkfifo", ["-m", "600", join(home3, CREDENTIALS_FILE)]);
  assert.throws(() => readCredentials(home3), CredentialFileError);
});

test("owned by another user -> CredentialFileError (owner check injected: tests cannot chown)", () => {
  const home = tmpDir("cred");
  writeCredentials(home, sample());
  const uid = process.getuid!();
  assert.throws(() => readCredentials(home, { uid: uid + 1 }), CredentialFileError);
});

test("invalid JSON or shape -> CredentialFileError without echoing the content", () => {
  const home = tmpDir("cred");
  const secret = fake("test-token-");
  writeFileSync(join(home, CREDENTIALS_FILE), `{"jira": {"apiToken": "${secret}"`, { mode: 0o600 });
  assert.throws(() => readCredentials(home), (e: unknown) => e instanceof CredentialFileError && !e.message.includes(secret));
  writeFileSync(join(home, CREDENTIALS_FILE), JSON.stringify({ version: 1, jira: { email: 3, apiToken: secret, updatedAt: AT }, anthropic: null, otlpHeaders: null }), { mode: 0o600 });
  assert.throws(() => readCredentials(home), (e: unknown) => e instanceof CredentialFileError && !e.message.includes(secret));
  writeFileSync(join(home, CREDENTIALS_FILE), JSON.stringify({ version: 2, ...EMPTY }), { mode: 0o600 });
  assert.throws(() => readCredentials(home), CredentialFileError);
});

test("a write that fails midway leaves the old file unchanged and no .tmp-* behind", () => {
  const home = tmpDir("cred");
  const old = sample();
  writeCredentials(home, old);
  const before = readFileSync(join(home, CREDENTIALS_FILE), "utf8");
  assert.throws(() => writeCredentials(home, { ...old, anthropic: { apiKey: fake("test-key-"), updatedAt: AT } }, { beforeRename: () => { throw new Error("disk full"); } }), /disk full/);
  assert.equal(readFileSync(join(home, CREDENTIALS_FILE), "utf8"), before);
  assert.deepEqual(readdirSync(home).filter((n) => n.includes(".tmp-")), []);
});

test("a stale temp file (or a link planted under its name) is replaced, never written through", () => {
  const home = tmpDir("cred");
  const target = join(tmpDir("cred-target"), "victim.txt");
  writeFileSync(target, "untouched\n");
  symlinkSync(target, join(home, `${CREDENTIALS_FILE}.tmp-${process.pid}`));
  writeCredentials(home, sample());
  assert.equal(readFileSync(target, "utf8"), "untouched\n");
  assert.ok(lstatSync(join(home, CREDENTIALS_FILE)).isFile());
  assert.deepEqual(readdirSync(home).filter((n) => n.includes(".tmp-")), []);
});

test("a home dir owned by someone else is not tightened (owner checked first)", () => {
  const home = tmpDir("cred");
  chmodSync(home, 0o755);
  assert.throws(() => writeCredentials(home, sample(), { uid: process.getuid!() + 1 }), CredentialFileError);
  assert.equal(statSync(home).mode & 0o777, 0o755);
  assert.equal(existsSync(join(home, CREDENTIALS_FILE)), false);
});

test("credentialStatus: set / updatedAt only; emailHint only for a local request; header names, never values", () => {
  const c = sample();
  const local = credentialStatus(c, true);
  assert.deepEqual(local, {
    jira: { set: true, emailHint: "y…@example.com", updatedAt: AT },
    anthropic: { set: true, updatedAt: AT },
    otlpHeaders: { set: true, names: ["x-api-key"], updatedAt: AT },
  });
  assert.equal(credentialStatus(c, false).jira.emailHint, null);
  const text = JSON.stringify([local, credentialStatus(c, false)]);
  for (const v of [c.jira!.apiToken, c.anthropic!.apiKey, c.otlpHeaders!.headers["x-api-key"]!, "you@example.com"]) assert.ok(!text.includes(v), v);
  assert.deepEqual(credentialStatus(EMPTY, true), {
    jira: { set: false, emailHint: null, updatedAt: null },
    anthropic: { set: false, updatedAt: null },
    otlpHeaders: { set: false, names: [], updatedAt: null },
  });
});

test("redactSecrets: every value, base64(email:token) and its encoded forms become [redacted]", () => {
  const c: Credentials = { ...sample(), jira: { email: "a@b.c", apiToken: "tok", updatedAt: AT } };
  const b64 = Buffer.from("a@b.c:tok").toString("base64");
  const out = redactSecrets(`Authorization: Basic ${b64}`, c);
  assert.ok(!out.includes("tok") && !out.includes(b64), out);
  assert.match(out, /\[redacted\]/);
  const key = c.anthropic!.apiKey;
  const hv = c.otlpHeaders!.headers["x-api-key"]!;
  const r = redactSecrets(`401: key ${key} rejected; header ${hv}; ${JSON.stringify({ k: key })}`, c);
  assert.ok(!r.includes(key) && !r.includes(hv), r);
  // a value with characters JSON or a URL escapes
  const odd: Credentials = { ...EMPTY, anthropic: { apiKey: 'test-key-"q\\/&=', updatedAt: AT } };
  const r2 = redactSecrets(`json ${JSON.stringify({ k: odd.anthropic!.apiKey })} url ?k=${encodeURIComponent(odd.anthropic!.apiKey)}`, odd);
  assert.ok(!r2.includes("test-key-"), r2);
  assert.equal(redactSecrets("nothing secret", EMPTY), "nothing secret");
});

test("input validation: messages name the field and rule, never the value", () => {
  const token = fake("test-token-");
  assert.ok(validateJiraInput({ email: "you@example.com", apiToken: token }).ok);
  for (const bad of [
    { email: "no-at-sign", apiToken: token },
    { email: "you@example.com\nx", apiToken: token },
    { email: `${"a".repeat(250)}@example.com`, apiToken: token },
    { email: "you@example.com", apiToken: "" },
    { email: "you@example.com", apiToken: `${token} with space` },
    { email: "you@example.com", apiToken: "x".repeat(513) },
  ]) {
    const r = validateJiraInput(bad);
    assert.equal(r.ok, false, JSON.stringify(bad).slice(0, 80));
    if (!r.ok) assert.ok(!JSON.stringify(r.issues).includes(token) && !JSON.stringify(r.issues).includes("no-at-sign"), JSON.stringify(r.issues));
  }
  const key = fake("test-key-");
  assert.ok(validateAnthropicInput({ apiKey: key }).ok);
  for (const apiKey of ["", `${key}\n`, "é".repeat(4), "x".repeat(513)]) assert.equal(validateAnthropicInput({ apiKey }).ok, false);
  assert.ok(validateOtlpHeadersInput({ headers: { "x-api-key": fake("test-otlp-") } }).ok);
  const tooMany = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`h${i}`, "v"]));
  for (const headers of [{ "bad name": "v" }, { ["h".repeat(65)]: "v" }, { h: "a\nb" }, { h: "v".repeat(1025) }, tooMany]) {
    assert.equal(validateOtlpHeadersInput({ headers }).ok, false, Object.keys(headers)[0] ?? "");
  }
});

// ---- the public-content rule for keys (plan global constraints): no real-looking Anthropic key in the sources ----

test("no string shaped like a real Anthropic API key in the repository's sources, docs and fixtures", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const SKIP = new Set([".git", "node_modules", "dist", "test-results", "playwright-report", ".superpowers"]);
  const realKey = new RegExp("sk-" + "ant-api" + "[A-Za-z0-9_-]{20,}");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith(".slackoff-test")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && statSync(p).size < 4 * 1024 * 1024 && realKey.test(readFileSync(p, "utf8"))) hits.push(p.slice(repo.length + 1));
    }
  };
  walk(repo);
  assert.deepEqual(hits, []);
  assert.ok(realKey.test("sk-" + "ant-api03-" + "A".repeat(24)), "the pattern itself works");
});

// ---------------------------------------------------------------- fix round 1 (rulings 4B-2, 4B-3, 4B-5)

test("4B-3: an API token or key shorter than 16 characters is refused", () => {
  assert.equal(validateJiraInput({ email: "you@example.com", apiToken: "test-token-12345" }).ok, true);
  assert.equal(validateJiraInput({ email: "you@example.com", apiToken: "test-token-1234" }).ok, false);
  assert.equal(validateAnthropicInput({ apiKey: "test-key-1234567" }).ok, true);
  assert.equal(validateAnthropicInput({ apiKey: "test-key-123456" }).ok, false);
});

test("4B-3 (M2): only values of 8 characters or more are redacted; a short header value never garbles other text", () => {
  const c: Credentials = { ...EMPTY, otlpHeaders: { headers: { a: "x", b: "1234567", c: "12345678" }, updatedAt: AT } };
  assert.equal(redactSecrets("x marks 1234567 and 12345678", c), "x marks 1234567 and [redacted]");
});

test("4B-5 (M5): +-encoded, lowercase %xx, base64 / base64url of each value alone and HTML-escaped forms are redacted", () => {
  const key = "test-key-<a b>&'\"/?~ü";
  const c: Credentials = { ...EMPTY, anthropic: { apiKey: key, updatedAt: AT } };
  const html = key.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const forms = [
    new URLSearchParams({ k: key }).toString().slice(2),
    encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    Buffer.from(key).toString("base64"),
    Buffer.from(key).toString("base64url"),
    html,
    key.replace(/'/g, "&#x27;").replace(/&(?!#)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  ];
  for (const f of forms) {
    const out = redactSecrets(`before ${f} after`, c);
    assert.equal(out, "before [redacted] after", f);
  }
  const jira: Credentials = { ...EMPTY, jira: { email: "you@example.com", apiToken: "test-token-0123456789", updatedAt: AT } };
  for (const f of [Buffer.from("you@example.com:test-token-0123456789").toString("base64url"), Buffer.from("test-token-0123456789").toString("base64")]) {
    assert.ok(!redactSecrets(`x ${f} y`, jira).includes(f), f);
  }
});

test("4B-2 (I1): a replaced or removed value stays redacted in this process; an unreadable file falls back to every value seen", () => {
  const home = tmpDir("cred");
  const a = fake("test-key-a-");
  const b = fake("test-key-b-");
  const token = fake("test-token-");
  writeCredentials(home, { ...EMPTY, anthropic: { apiKey: a, updatedAt: AT } });
  writeCredentials(home, { ...EMPTY, anthropic: { apiKey: b, updatedAt: AT }, jira: { email: "you@example.com", apiToken: token, updatedAt: AT } });
  assert.equal(redactStored(home, `${a} ${b}`), "[redacted] [redacted]");
  writeCredentials(home, EMPTY);
  assert.equal(redactStored(home, `${a} ${b} ${token}`), "[redacted] [redacted] [redacted]");
  writeCredentials(home, { ...EMPTY, anthropic: { apiKey: b, updatedAt: AT } });
  chmodSync(join(home, CREDENTIALS_FILE), 0o644);
  assert.equal(redactStored(home, `key ${b}`), "key [redacted]");
  assert.equal(redactKnown(`key ${a}`), "key [redacted]");
});

test("4B-2: a value only ever read (never written here) is remembered too", () => {
  const home = tmpDir("cred");
  const key = fake("test-key-read-");
  writeFileSync(join(home, CREDENTIALS_FILE), JSON.stringify({ version: 1, jira: null, anthropic: { apiKey: key, updatedAt: AT }, otlpHeaders: null }), { mode: 0o600 });
  readCredentials(home);
  writeFileSync(join(home, CREDENTIALS_FILE), JSON.stringify({ version: 1, ...EMPTY }), { mode: 0o600 });
  assert.equal(redactKnown(`x ${key}`), "x [redacted]");
});

test("4B-5 (M3): ENOTDIR, EACCES and ELOOP become CredentialFileError without the path", () => {
  const base = tmpDir("cred");
  const notDir = join(base, "plain-file");
  writeFileSync(notDir, "x");
  const loopA = join(base, "loop-a");
  symlinkSync(join(base, "loop-b"), loopA);
  symlinkSync(loopA, join(base, "loop-b"));
  const locked = join(base, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    for (const home of [notDir, loopA, locked]) {
      assert.throws(() => readCredentials(home), (e: unknown) => e instanceof CredentialFileError && !e.message.includes(base), home);
    }
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("4B-5 (M4): a symlink, a FIFO or a loose-mode file swapped in between the lstat and the open is refused (no hang)", () => {
  const swaps: Array<[string, (file: string) => void]> = [
    ["symlink", (file) => {
      const target = join(tmpDir("cred-target"), "t.json");
      writeFileSync(target, JSON.stringify({ version: 1, ...EMPTY }), { mode: 0o600 });
      symlinkSync(target, file);
    }],
    ["fifo", (file) => execFileSync("/usr/bin/mkfifo", ["-m", "600", file])],
    ["loose mode", (file) => writeFileSync(file, JSON.stringify({ version: 1, ...EMPTY }), { mode: 0o644 })],
  ];
  for (const [name, swapIn] of swaps) {
    const home = tmpDir("cred");
    const file = join(home, CREDENTIALS_FILE);
    writeFileSync(file, JSON.stringify({ version: 1, ...EMPTY }), { mode: 0o600 });
    const afterLstat = () => {
      rmFile(file);
      swapIn(file);
    };
    assert.throws(() => readCredentials(home, { afterLstat }), CredentialFileError, name);
  }
});

import { unlinkSync as rmFile } from "node:fs";

// ---- final fix pass (ruling F4C-1, M-5) ----

test("F4C-1 M-5: a stored 'Bearer <token>' header redacts the bare token; 'Basic <b64>' the pair and each half of 8+ characters", async () => {
  const { redactDeep, redactorFor } = await import("../src/credentials/credential-store.ts");
  const token = fake("fake-bearer-");
  const user = fake("pk-fake-");
  const pass = fake("sk-fake-");
  const basic = Buffer.from(`${user}:${pass}`).toString("base64");
  const short = Buffer.from(`ab:${pass}`).toString("base64");
  const c: Credentials = { ...EMPTY, otlpHeaders: { headers: { authorization: `Bearer ${token}`, "x-langfuse": `Basic ${basic}`, "x-short": `basic ${short}` }, updatedAt: AT } };
  const text = `401 invalid token ${token}; key pair ${user}:${pass}; public ${user}; secret ${pass}; ${JSON.stringify({ t: token })}; user ab`;
  const out = redactSecrets(text, c);
  for (const leak of [token, user, pass]) assert.ok(!out.includes(leak), `${leak} in ${out}`);
  assert.match(out, /user ab$/);
  // every sink: the remembered values (redactStored / redactorFor / redactKnown / redactDeep)
  const home = tmpDir("cred-m5");
  writeCredentials(home, c);
  for (const redact of [(t: string) => redactStored(home, t), redactorFor(home), redactKnown, (t: string) => redactDeep({ t }).t]) {
    const r = redact(text);
    for (const leak of [token, user, pass]) assert.ok(!r.includes(leak), `${leak} in ${r}`);
  }
  // a value without a scheme, or a scheme with a short token, adds nothing more
  const plain: Credentials = { ...EMPTY, otlpHeaders: { headers: { a: "Bearer short", b: "Basic !!notbase64!!" }, updatedAt: AT } };
  assert.equal(redactSecrets("short Bearer and notbase64", plain), "short Bearer and notbase64");
});
