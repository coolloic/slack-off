import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, saveConfig } from "../src/config.ts";
import { EventBus } from "../src/http/events.ts";
import { createApp, type AppDeps } from "../src/http/app.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { detectTailscale, listenHosts, resolveRemote, TAILSCALE_APP_BIN, type CommandRunner } from "../src/remote/tailscale.ts";
import { isLoopback } from "../src/remote/auth.ts";
import { tmpDir } from "./helpers/tmp.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TS = { ip: "100.101.102.103", dnsName: "mac.tail1234.ts.net" };
const LOCAL = "127.0.0.1:4317";
const REMOTE_HOST = `${TS.ip}:4317`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const env = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
const LOOPBACK = env("127.0.0.1");
const PHONE = env("100.88.1.2");

function setup(opts: { remote?: AppDeps["remote"]; webDist?: string | null; now?: () => number } = {}) {
  const home = tmpDir("remote");
  const db = openDatabase(join(home, "slackoff.db"));
  const config = loadConfig(home);
  const bus = new EventBus();
  const run = async () => { throw new Error("agent must not run"); };
  const workflow = createWorkflow({ updater: noUpdater, db, home, queue: new JobQueue(1, { onError: () => {} }), source: new FakeTicketSource(), run: run as never, config, bus });
  const app = createApp({
    db, home, repoRoot, workflow, bus, config,
    remote: opts.remote === undefined ? TS : opts.remote,
    webDist: opts.webDist ?? null,
    now: opts.now,
    detectTailscale: async () => TS,
  });
  const call = (
    from: ReturnType<typeof env> | undefined,
    method: string,
    path: string,
    o: { body?: unknown; host?: string; cookie?: string; headers?: Record<string, string> } = {},
  ) =>
    app.request(
      path,
      {
        method,
        headers: {
          host: o.host ?? (from === LOOPBACK ? LOCAL : REMOTE_HOST),
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(o.cookie ? { cookie: o.cookie } : {}),
          ...o.headers,
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      },
      from,
    );
  const local = (method: string, path: string, o?: Parameters<typeof call>[3]) => call(LOOPBACK, method, path, o);
  const phone = (method: string, path: string, o?: Parameters<typeof call>[3]) => call(PHONE, method, path, o);
  return { home, db, config, app, call, local, phone };
}

type S = ReturnType<typeof setup>;

async function startCode(s: S): Promise<{ code: string; url: string; expiresAt: string }> {
  const res = await s.local("POST", "/api/pair/start");
  assert.equal(res.status, 200);
  return (await res.json()) as { code: string; url: string; expiresAt: string };
}

async function pair(s: S, name = "Pixel"): Promise<{ cookie: string; token: string; setCookie: string; id: number }> {
  const { code } = await startCode(s);
  const res = await s.phone("POST", "/api/pair/redeem", { body: { code, deviceName: name } });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const token = /slackoff_session=([^;]+)/.exec(setCookie)![1]!;
  const body = (await res.json()) as { device: { id: number } };
  return { cookie: `slackoff_session=${token}`, token, setCookie, id: body.device.id };
}

const auditTypes = (s: S) => (s.db.prepare("SELECT type FROM audit_event ORDER BY id").all() as Array<{ type: string }>).map((r) => r.type);
const auditText = (s: S) => (s.db.prepare("SELECT payload_json FROM audit_event").all() as Array<{ payload_json: string }>).map((r) => r.payload_json).join("\n");

// ---- loopback decision ----

test("isLoopback only accepts loopback socket addresses", () => {
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopback(a), true, a);
  for (const a of [undefined, "", "100.88.1.2", "::ffff:100.88.1.2", "0.0.0.0", "localhost", "127.0.0.1.evil"]) assert.equal(isLoopback(a), false, String(a));
});

test("loopback requests need no session", async () => {
  const s = setup();
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const res = await s.call(env(a), "GET", "/api/tickets", { host: LOCAL });
    assert.equal(res.status, 200, a);
  }
});

test("non-loopback without a session -> 401; headers cannot fake loopback; unknown socket fails closed", async () => {
  const s = setup();
  assert.equal((await s.phone("GET", "/api/tickets")).status, 401);
  const spoof = await s.phone("GET", "/api/tickets", { host: LOCAL, headers: { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", forwarded: "for=127.0.0.1" } });
  assert.equal(spoof.status, 401);
  assert.equal((await s.call(undefined, "GET", "/api/tickets", { host: LOCAL })).status, 401);
  assert.equal((await s.phone("GET", "/api/tickets", { cookie: "slackoff_session=not-a-real-token" })).status, 401);
});

test("real socket: a loopback TCP connection is recognised", async () => {
  const s = setup();
  const server = serve({ fetch: s.app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/tickets", headers: { host: LOCAL } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
  server.close();
  assert.equal(status, 200);
});

// ---- guard (R15 extension) ----

test("Host/Origin allowlists include the Tailscale address only while remote access is active", async () => {
  const on = setup();
  const p = await pair(on);
  assert.equal((await on.phone("GET", "/api/tickets", { cookie: p.cookie, host: REMOTE_HOST })).status, 200);
  assert.equal((await on.phone("GET", "/api/tickets", { cookie: p.cookie, host: `${TS.dnsName}:4317` })).status, 200);
  assert.equal((await on.phone("GET", "/api/tickets", { cookie: p.cookie, host: `${TS.ip}:5173` })).status, 403);
  const post = await on.phone("POST", "/api/tickets/NOPE-1/abandon", { cookie: p.cookie, headers: { origin: `http://${TS.dnsName}:4317`, "content-type": "application/json" } });
  assert.equal(post.status, 404);
  const evil = await on.phone("POST", "/api/tickets/NOPE-1/abandon", { cookie: p.cookie, headers: { origin: `https://${TS.dnsName}`, "content-type": "application/json" } });
  assert.equal(evil.status, 403);

  const off = setup({ remote: null });
  assert.equal((await off.local("GET", "/api/tickets", { host: REMOTE_HOST })).status, 403);
  assert.equal((await off.local("GET", "/api/tickets", { host: `${TS.dnsName}:4317` })).status, 403);
});

// ---- pairing ----

test("pair/start and device management are loopback-only (403 even with a valid session)", async () => {
  const s = setup();
  const p = await pair(s);
  assert.equal((await s.phone("POST", "/api/pair/start", { cookie: p.cookie })).status, 403);
  assert.equal((await s.phone("POST", "/api/pair/start")).status, 403);
  assert.equal((await s.phone("GET", "/api/devices", { cookie: p.cookie })).status, 403);
  assert.equal((await s.phone("DELETE", `/api/devices/${p.id}`, { cookie: p.cookie })).status, 403);
});

test("pair/start returns an 8-digit one-time code, a phone URL and a 5-minute expiry", async () => {
  let now = Date.parse("2026-11-06T10:00:00Z");
  const s = setup({ now: () => now });
  const { code, url, expiresAt } = await startCode(s);
  assert.match(code, /^\d{8}$/);
  assert.equal(url, `http://${TS.ip}:4317/pair?code=${code}`);
  assert.equal(Date.parse(expiresAt) - now, 5 * 60_000);
  now += 5 * 60_000 + 1;
  const late = await s.phone("POST", "/api/pair/redeem", { body: { code, deviceName: "Pixel" } });
  assert.equal(late.status, 400);
  assert.equal(late.headers.get("set-cookie"), null);
});

test("pair/start without an active remote listener -> 409", async () => {
  const s = setup({ remote: null });
  assert.equal((await s.local("POST", "/api/pair/start")).status, 409);
});

test("a code redeems once; the cookie then authenticates the phone", async () => {
  const s = setup();
  const { code } = await startCode(s);
  const first = await s.phone("POST", "/api/pair/redeem", { body: { code, deviceName: "  Loïc's Pixel  " } });
  assert.equal(first.status, 200);
  const setCookie = first.headers.get("set-cookie") ?? "";
  const token = /slackoff_session=([^;]+)/.exec(setCookie)![1]!;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  for (const attr of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=15552000"]) assert.ok(setCookie.includes(attr), attr);
  assert.ok(!/secure/i.test(setCookie), "no Secure: tailnet is plain http");
  assert.equal(((await first.json()) as { device: { name: string } }).device.name, "Loïc's Pixel");

  const again = await s.phone("POST", "/api/pair/redeem", { body: { code, deviceName: "Other" } });
  assert.equal(again.status, 400);

  assert.equal((await s.phone("GET", "/api/tickets", { cookie: `slackoff_session=${token}` })).status, 200);
  assert.equal((await s.phone("GET", "/api/tickets", { cookie: `theme=dark; slackoff_session=${token}` })).status, 200);
});

test("only hashes are stored; audit never contains the code or the cookie", async () => {
  const s = setup();
  const { code } = await startCode(s);
  const codeRow = s.db.prepare("SELECT * FROM pairing_code").all() as Array<Record<string, unknown>>;
  assert.equal(codeRow.length, 1);
  assert.equal(codeRow[0]!.code_hash, sha(code));
  assert.ok(!JSON.stringify(codeRow).includes(code));
  const res = await s.phone("POST", "/api/pair/redeem", { body: { code, deviceName: "Pixel" } });
  const token = /slackoff_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
  const devices = s.db.prepare("SELECT * FROM paired_device").all() as Array<Record<string, unknown>>;
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.token_hash, sha(token));
  const dump = JSON.stringify(s.db.prepare("SELECT * FROM paired_device").all()) + JSON.stringify(s.db.prepare("SELECT * FROM pairing_code").all()) + auditText(s);
  assert.ok(!dump.includes(token), "token not stored");
  assert.ok(!auditText(s).includes(code), "code not audited");
  const list = (await (await s.local("GET", "/api/devices")).json()) as Array<Record<string, unknown>>;
  assert.equal(list.length, 1);
  assert.ok(!("tokenHash" in list[0]!) && !("token_hash" in list[0]!), "hash not exposed");
  assert.deepEqual(auditTypes(s), ["pairing_started", "device_paired"]);
});

test("revoking a device -> its cookie gets 401; revocation is audited", async () => {
  const s = setup();
  const p = await pair(s);
  assert.equal((await s.phone("GET", "/api/tickets", { cookie: p.cookie })).status, 200);
  const del = await s.local("DELETE", `/api/devices/${p.id}`);
  assert.equal(del.status, 200);
  assert.equal((await s.phone("GET", "/api/tickets", { cookie: p.cookie })).status, 401);
  assert.equal((await s.local("DELETE", "/api/devices/999")).status, 404);
  assert.deepEqual((await (await s.local("GET", "/api/devices")).json()) as unknown[], []);
  assert.ok(auditTypes(s).includes("device_revoked"));
});

test("brute force: 5 failed redeems invalidate every outstanding code and are audited", async () => {
  const s = setup();
  const { code } = await startCode(s);
  const wrong = code === "00000000" ? "11111111" : "00000000";
  for (let i = 0; i < 4; i++) assert.equal((await s.phone("POST", "/api/pair/redeem", { body: { code: wrong, deviceName: "x" } })).status, 400);
  assert.equal((await (await s.local("GET", "/api/pair/status")).json() as { locked: boolean }).locked, false);
  assert.equal((await s.phone("POST", "/api/pair/redeem", { body: { code: wrong, deviceName: "x" } })).status, 429);
  // the outstanding code itself is invalidated in the database, not just blocked in memory
  const row = s.db.prepare("SELECT used_at FROM pairing_code WHERE code_hash = ?").get(sha(code)) as { used_at: string | null };
  assert.notEqual(row.used_at, null, "outstanding code marked used");
  const locked = s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'pairing_locked'").get() as { payload_json: string };
  assert.deepEqual(JSON.parse(locked.payload_json), { failedAttempts: 5, invalidatedCodes: 1 });
  assert.equal((await (await s.local("GET", "/api/pair/status")).json() as { locked: boolean }).locked, true, "Settings can show the locked state");
  assert.equal((await s.phone("GET", "/api/pair/status")).status, 403);
  const late = await s.phone("POST", "/api/pair/redeem", { body: { code, deviceName: "x" } });
  assert.equal(late.status, 429, "the real code no longer works");
  assert.equal(late.headers.get("set-cookie"), null);
  assert.ok(!auditText(s).includes(code));
  // a fresh pairing window starts over
  const next = await startCode(s);
  assert.equal((await (await s.local("GET", "/api/pair/status")).json() as { locked: boolean }).locked, false);
  assert.equal((await s.phone("POST", "/api/pair/redeem", { body: { code: next.code, deviceName: "x" } })).status, 200);
});

test("redeem validates its body and is still guarded by Origin and JSON content-type", async () => {
  const s = setup();
  const { code } = await startCode(s);
  assert.equal((await s.phone("POST", "/api/pair/redeem", { body: { code, deviceName: "" } })).status, 400);
  const cross = await s.phone("POST", "/api/pair/redeem", { body: { code, deviceName: "x" }, headers: { origin: "https://evil.example.com" } });
  assert.equal(cross.status, 403);
  const form = await s.phone("POST", "/api/pair/redeem", { headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "4" } });
  assert.equal(form.status, 415);
});

// ---- remote status & config ----

test("GET /api/remote reports local vs remote and the phone URL", async () => {
  const s = setup();
  const local = (await (await s.local("GET", "/api/remote")).json()) as { local: boolean; active: { ip: string; dnsName: string | null; url: string } | null; detected: unknown };
  assert.equal(local.local, true);
  assert.deepEqual(local.active, { ...TS, url: `http://${TS.ip}:4317` });
  assert.deepEqual(local.detected, TS);
  const p = await pair(s);
  const phone = (await (await s.phone("GET", "/api/remote", { cookie: p.cookie })).json()) as { local: boolean };
  assert.equal(phone.local, false);
});

test("remoteAccess config: defaults, validation, restartRequired, and phones cannot change it", async () => {
  const s = setup({ remote: null });
  assert.deepEqual(s.config.remoteAccess, { enabled: false, host: "" });
  assert.throws(() => saveConfig(s.home, { ...s.config, remoteAccess: { enabled: true, host: "0.0.0.0" } }));
  assert.throws(() => saveConfig(s.home, { ...s.config, remoteAccess: { enabled: true, host: "192.168.1.10" } }));
  assert.throws(() => saveConfig(s.home, { ...s.config, remoteAccess: { enabled: true, host: "bad host!" } }));
  const cfg = (await (await s.local("GET", "/api/config")).json()) as Record<string, unknown>;
  const put = await s.local("PUT", "/api/config", { body: { ...cfg, remoteAccess: { enabled: true, host: "" } } });
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { restartRequired: boolean }).restartRequired, true);

  const on = setup();
  const p = await pair(on);
  const c2 = (await (await on.local("GET", "/api/config")).json()) as Record<string, unknown>;
  const fromPhone = await on.phone("PUT", "/api/config", { cookie: p.cookie, body: { ...c2, remoteAccess: { enabled: true, host: "100.64.0.1" } } });
  assert.equal(fromPhone.status, 403);
  const other = await on.phone("PUT", "/api/config", { cookie: p.cookie, body: { ...c2, autoRefine: true } });
  assert.equal(other.status, 200, "other settings stay editable from a paired phone");
});

test("R21: a paired phone cannot change executor, repositories or the JIRA URL; this computer can", async () => {
  const s = setup();
  const p = await pair(s);
  await s.local("PUT", "/api/config", { body: { ...s.config, projects: { ABC: { repoPath: "/repo", baseBranch: "main" } } } });
  const base = (await (await s.local("GET", "/api/config")).json()) as Record<string, unknown> & { executor: object; projects: object; jira: object };
  const changes: Array<[string, Record<string, unknown>]> = [
    ["executor.claudeBin", { executor: { ...base.executor, claudeBin: "/tmp/evil" } }],
    ["executor.model", { executor: { ...base.executor, model: "claude-opus-5-5" } }],
    ["projects repoPath", { projects: { ABC: { repoPath: "/elsewhere", baseBranch: "main" } } }],
    ["projects branch", { projects: { ABC: { repoPath: "/repo", baseBranch: "dev" } } }],
    ["projects mapping", { projects: { ABC: { repoPath: "/repo", baseBranch: "main" }, XYZ: { repoPath: "/x", baseBranch: "main" } } }],
    ["jira.baseUrl", { jira: { ...base.jira, baseUrl: "https://evil.example.com" } }],
    ["jira.readyForDevStatus", { jira: { ...base.jira, readyForDevStatus: "Done" } }],
    ["jira.discoverLimit", { jira: { ...base.jira, discoverLimit: 20 } }],
  ];
  for (const [what, patch] of changes) {
    assert.equal((await s.phone("PUT", "/api/config", { cookie: p.cookie, body: { ...base, ...patch } })).status, 403, what);
  }
  const status = await s.phone("PUT", "/api/config", { cookie: p.cookie, body: { ...base, jira: { ...base.jira, readyForDevStatus: "Ready" } } });
  assert.equal(status.status, 403, "F-I2: the ready-for-dev status steers the Tickets list for this machine, so it stays loopback-only");
  const limit = await s.phone("PUT", "/api/config", { cookie: p.cookie, body: { ...base, jira: { ...base.jira, discoverLimit: 500 } } });
  assert.equal(limit.status, 403, "R21: the discovery limit goes into the browser agent's prompt, so it is loopback-only");
  assert.equal(s.config.jira.discoverLimit, 100);
  assert.equal(s.config.executor.claudeBin, "claude");
  for (const [what, patch] of changes) {
    assert.equal((await s.local("PUT", "/api/config", { body: { ...base, ...patch } })).status, 200, `local ${what}`);
  }
  const st = (await (await s.phone("GET", "/api/status", { cookie: p.cookie })).json()) as { local: boolean };
  assert.equal(st.local, false);
  assert.equal(((await (await s.local("GET", "/api/status")).json()) as { local: boolean }).local, true);
});

test("R21 phase 2: a paired phone cannot change jira.syncStatus, jira.inProgressStatus, jira.browser or add a repo; it can change debate/development limits", async () => {
  const s = setup();
  const p = await pair(s);
  await s.local("PUT", "/api/config", { body: { ...s.config, projects: { ABC: { repos: [{ name: "api", path: "/repo", baseBranch: "main" }] } } } });
  const base = (await (await s.local("GET", "/api/config")).json()) as Record<string, unknown> & { jira: object; debate: object; development: object };
  const denied: Array<[string, Record<string, unknown>]> = [
    ["jira.syncStatus", { jira: { ...base.jira, syncStatus: true } }],
    ["jira.inProgressStatus", { jira: { ...base.jira, inProgressStatus: "Doing" } }],
    ["jira.browser", { jira: { ...base.jira, browser: { deviceId: "dev-1", name: "Mac" } } }],
    ["new repo", { projects: { ABC: { repos: [{ name: "api", path: "/repo", baseBranch: "main" }, { name: "web", path: "/web", baseBranch: "main" }] } } }],
  ];
  for (const [what, patch] of denied) {
    assert.equal((await s.phone("PUT", "/api/config", { cookie: p.cookie, body: { ...base, ...patch } })).status, 403, what);
  }
  const allowed: Array<[string, Record<string, unknown>]> = [
    ["debate.maxRounds", { debate: { maxRounds: 5 } }],
    ["development limits", { development: { maxSteps: 20, commandTimeoutMs: 120_000, hookTimeoutMs: 60_000 } }],
  ];
  for (const [what, patch] of allowed) {
    assert.equal((await s.phone("PUT", "/api/config", { cookie: p.cookie, body: { ...base, ...patch } })).status, 200, what);
  }
  assert.equal(s.config.development.maxSteps, 20);
  assert.equal((await s.phone("PUT", "/api/config", { cookie: p.cookie, body: { ...base, debate: { maxRounds: 4 } } })).status, 200);
  assert.equal(s.config.debate.maxRounds, 4);
  assert.equal(s.config.jira.syncStatus, false);
  assert.equal(s.config.jira.browser, null);
});

test("R22: a loopback socket addressed by the Tailscale name/IP is refused (local proxy such as tailscale serve)", async () => {
  const s = setup();
  for (const host of [REMOTE_HOST, `${TS.dnsName}:4317`]) {
    const res = await s.call(LOOPBACK, "GET", "/api/tickets", { host });
    assert.equal(res.status, 403, host);
    assert.equal((await s.call(LOOPBACK, "POST", "/api/pair/start", { host })).status, 403, host);
  }
  assert.equal((await s.call(LOOPBACK, "GET", "/api/tickets", { host: LOCAL })).status, 200);
});

test("unpaired access to SSE and attachments -> 401", async () => {
  const s = setup();
  assert.equal((await s.phone("GET", "/api/events")).status, 401);
  assert.equal((await s.phone("GET", "/api/tickets/P-1/snapshots/1/attachments/1")).status, 401);
});

test("revoking a device closes its open SSE stream immediately", async () => {
  const s = setup();
  const p = await pair(s);
  const other = await pair(s, "Tablet");
  const open = async (cookie: string) => {
    const res = await s.phone("GET", "/api/events", { cookie });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /connected/);
    return reader;
  };
  const mine = await open(p.cookie);
  const theirs = await open(other.cookie);
  assert.equal((await s.local("DELETE", `/api/devices/${p.id}`)).status, 200);
  const ended = await Promise.race([
    (async () => { for (;;) { const r = await mine.read(); if (r.done) return true; } })(),
    new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
  ]);
  const still = await Promise.race([theirs.read().then(() => "data"), new Promise<string>((r) => setTimeout(() => r("open"), 200))]);
  await theirs.cancel();
  if (!ended) await mine.cancel(); // let a failing run finish instead of hanging on the open stream
  assert.equal(ended, true, "revoked device's stream ended");
  assert.equal(still, "open", "other devices keep streaming");
});

// ---- tailscale detection & listeners ----

const missing: CommandRunner = async () => {
  throw Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });
};

test("detectTailscale returns null when the command is missing or fails", async () => {
  assert.equal(await detectTailscale(missing), null);
  assert.equal(await detectTailscale(async () => "not an ip\n"), null);
  assert.equal(await detectTailscale(async (_c, args) => (args[0] === "ip" ? "192.168.1.5\n" : "{}")), null, "non-Tailscale address rejected");
});

test("detectTailscale parses ip and MagicDNS name, falls back to the macOS app binary", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "tailscale") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (args[0] === "ip") return `${TS.ip}\n`;
    return JSON.stringify({ Self: { DNSName: `${TS.dnsName}.` } });
  };
  assert.deepEqual(await detectTailscale(run), TS);
  assert.ok(calls.some((c) => c.startsWith(TAILSCALE_APP_BIN)));
  const noStatus: CommandRunner = async (_cmd, args) => {
    if (args[0] === "ip") return `${TS.ip}\n`;
    throw new Error("status failed");
  };
  assert.deepEqual(await detectTailscale(noStatus), { ip: TS.ip, dnsName: null });
});

test("resolveRemote: disabled -> null; explicit IP; MagicDNS name; auto-detect", async () => {
  const detect = async () => TS;
  assert.equal(await resolveRemote({ enabled: false, host: "" }, detect), null);
  assert.deepEqual(await resolveRemote({ enabled: true, host: "" }, detect), TS);
  assert.equal(await resolveRemote({ enabled: true, host: "" }, async () => null), null);
  assert.deepEqual(await resolveRemote({ enabled: true, host: "100.64.0.9" }, async () => null), { ip: "100.64.0.9", dnsName: null });
  assert.deepEqual(await resolveRemote({ enabled: true, host: TS.dnsName }, async () => ({ ip: TS.ip, dnsName: null }), async () => TS.ip), TS);
  assert.equal(await resolveRemote({ enabled: true, host: "lan.example" }, detect, async () => "192.168.1.5"), null, "a name resolving outside the tailnet is refused");
});

test("listener hosts never contain a wildcard address", () => {
  assert.deepEqual(listenHosts(null), ["127.0.0.1"]);
  assert.deepEqual(listenHosts(TS), ["127.0.0.1", TS.ip]);
  for (const bad of ["0.0.0.0", "::", "", "192.168.1.5"]) assert.throws(() => listenHosts({ ip: bad, dnsName: null }), bad);
  for (const hosts of [listenHosts(null), listenHosts(TS)]) {
    assert.ok(!hosts.includes("0.0.0.0") && !hosts.includes("::"));
  }
});

// ---- static hosting ----

function dist(): string {
  const root = tmpDir("dist");
  const d = join(root, "dist");
  mkdirSync(join(d, "assets"), { recursive: true });
  writeFileSync(join(d, "index.html"), "<!doctype html><title>Slack Off</title>");
  writeFileSync(join(d, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "TOP-SECRET");
  return d;
}

test("static hosting: files, SPA fallback, no auth for assets, /api not shadowed", async () => {
  const s = setup({ webDist: dist() });
  const index = await s.phone("GET", "/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await index.text(), /Slack Off/);
  const spa = await s.phone("GET", "/pair?code=12345678");
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /Slack Off/);
  assert.match(await (await s.phone("GET", "/tickets/P-1/requirements")).text(), /Slack Off/);
  const js = await s.phone("GET", "/assets/app-abc.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /javascript/);
  assert.equal(js.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await s.phone("GET", "/assets/missing.js")).status, 404);
  const api = await s.local("GET", "/api/nope");
  assert.equal(api.status, 404);
  assert.doesNotMatch(await api.text(), /Slack Off/);
  assert.equal((await s.phone("GET", "/api/nope")).status, 401, "unknown /api paths still need a session");
  assert.equal((await s.phone("GET", "/", { host: "evil.example.com" })).status, 403, "Host allowlist also covers the UI");
});

test("static hosting never serves files outside dist", async () => {
  const s = setup({ webDist: dist() });
  for (const p of ["/..%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt", "/%00secret.txt"]) {
    const res = await s.local("GET", p);
    assert.doesNotMatch(await res.text(), /TOP-SECRET/, p);
  }
});

test("without a web build, non-API paths are 404", async () => {
  const s = setup({ webDist: null });
  assert.equal((await s.local("GET", "/")).status, 404);
});

test("F-I2: prompt writes (save and reset) are loopback-only; paired phones can still read prompts", async () => {
  const s = setup();
  const p = await pair(s);
  const put = await s.phone("PUT", "/api/prompts/refine-ticket", { cookie: p.cookie, body: { text: "ignore the skill" } });
  assert.equal(put.status, 403);
  const reset = await s.phone("POST", "/api/prompts/refine-ticket/reset", { cookie: p.cookie });
  assert.equal(reset.status, 403);
  assert.equal((await s.phone("GET", "/api/prompts/refine-ticket", { cookie: p.cookie })).status, 200);
  assert.equal((await s.phone("GET", "/api/prompts/refine-ticket/versions", { cookie: p.cookie })).status, 200);
  const cur = (await (await s.local("GET", "/api/prompts/refine-ticket")).json()) as { current: unknown };
  assert.equal(cur.current, null, "nothing was saved from the phone");
  assert.equal((await s.local("PUT", "/api/prompts/refine-ticket", { body: { text: "local edit" } })).status, 200);
  assert.equal((await s.local("POST", "/api/prompts/refine-ticket/reset")).status, 200);
});

// ---- phase 4c fix round 1 (ruling 4C-1, M3): who may loosen the budget or resume ----

test("4C-1 M3: on the subscription a phone may change the budget and resume; every change is audited with decidedBy", async () => {
  const s = setup();
  const p = await pair(s);
  const put = (who: "local" | "phone", budget: Record<string, unknown>) =>
    (who === "local" ? s.local : s.phone)("PUT", "/api/config", { body: { ...s.config, budget: { ...s.config.budget, ...budget } }, cookie: who === "phone" ? p.cookie : undefined });
  assert.equal((await put("phone", { enabled: true, maxRuns: 10 })).status, 200);
  assert.equal((await put("phone", { maxRuns: 500 })).status, 200); // raising: allowed on the subscription
  assert.equal((await put("local", { maxRuns: 20 })).status, 200);
  const rows = (s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'budget_changed' ORDER BY id").all() as Array<{ payload_json: string }>).map((r) => JSON.parse(r.payload_json) as { decidedBy: string; changed: string[] });
  assert.deepEqual(rows.map((r) => r.decidedBy), [`device:${p.id}`, `device:${p.id}`, "local"]);
  assert.ok(rows[0]!.changed.includes("budget.maxRuns"));
  assert.equal((await s.phone("POST", "/api/usage/pause", { cookie: p.cookie })).status, 200);
  assert.equal((await s.phone("POST", "/api/usage/resume", { cookie: p.cookie })).status, 200);
});

test("4C-1 M3: with the API key a phone may pause and tighten, but not loosen, clear or disable", async () => {
  const s = setup();
  s.config.executor.kind = "claude-api";
  s.config.jira.source = "api";
  Object.assign(s.config.budget, { enabled: true, maxRuns: 10, maxRunMinutes: 60, maxUsd: 5, warnAt: 0.8 });
  const p = await pair(s);
  const put = (who: "local" | "phone", budget: Record<string, unknown>) =>
    (who === "local" ? s.local : s.phone)("PUT", "/api/config", { body: { ...s.config, budget: { ...s.config.budget, ...budget } }, cookie: who === "phone" ? p.cookie : undefined });
  for (const loosen of [{ maxRuns: 11 }, { maxRuns: null }, { maxUsd: 6 }, { maxUsd: null }, { maxRunMinutes: 61 }, { enabled: false }, { window: "week" }, { warnAt: 0.9 }]) {
    assert.equal((await put("phone", loosen)).status, 403, JSON.stringify(loosen));
  }
  assert.equal(s.config.budget.maxRuns, 10);
  for (const tighten of [{ maxRuns: 5 }, { maxUsd: 1 }, { maxRunMinutes: 30 }, { warnAt: 0.6 }]) {
    assert.equal((await put("phone", tighten)).status, 200, JSON.stringify(tighten));
  }
  assert.equal((await s.phone("POST", "/api/usage/pause", { cookie: p.cookie })).status, 200);
  // F4C-1 (M-4): a manual pause may be resumed from the phone (a threshold pause may not: see below)
  assert.equal((await s.phone("POST", "/api/usage/resume", { cookie: p.cookie })).status, 200);
  assert.equal((await put("local", { maxRuns: 50 })).status, 200);
});

// ---- final fix pass (ruling F4C-1) ----

test("F4C-1 M-4: with the API key a phone resumes a manual or limit_reached pause, never a threshold pause", async () => {
  const { pauseUsage, currentPause } = await import("../src/cost/budget-gate.ts");
  const s = setup();
  s.config.executor.kind = "claude-api";
  s.config.jira.source = "api";
  const p = await pair(s);
  for (const reason of ["manual", "limit_reached"] as const) {
    pauseUsage(s.db, reason, "x", "system");
    const r = await s.phone("POST", "/api/usage/resume", { cookie: p.cookie });
    assert.equal(r.status, 200, reason);
    assert.equal(currentPause(s.db), null, reason);
  }
  pauseUsage(s.db, "threshold", "runs reached 10/10 in the last 5h", "system");
  const denied = await s.phone("POST", "/api/usage/resume", { cookie: p.cookie });
  assert.equal(denied.status, 403);
  assert.match(((await denied.json()) as { error: string }).error, /threshold pause .* on this computer/);
  assert.notEqual(currentPause(s.db), null);
  assert.equal((await s.local("POST", "/api/usage/resume")).status, 200);
  const by = (s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'usage_resumed' ORDER BY id").all() as Array<{ payload_json: string }>).map((r) => (JSON.parse(r.payload_json) as { by: string }).by);
  assert.deepEqual(by, [`device:${p.id}`, `device:${p.id}`, "local"]);
});

test("F4C-1 M-3: concurrency is 1..8; with the API key a phone may lower it but not raise it", async () => {
  const s = setup();
  const p = await pair(s);
  const put = (who: "local" | "phone", concurrency: unknown) =>
    (who === "local" ? s.local : s.phone)("PUT", "/api/config", { body: { ...s.config, concurrency }, cookie: who === "phone" ? p.cookie : undefined });
  for (const bad of [0, 9, 100, 1.5]) assert.equal((await put("local", bad)).status, 400, String(bad));
  // the subscription: a phone may raise it
  assert.equal((await put("phone", 3)).status, 200);
  assert.equal(s.config.concurrency, 3);
  s.config.executor.kind = "claude-api";
  s.config.jira.source = "api";
  const up = await put("phone", 4);
  assert.equal(up.status, 403);
  assert.match(((await up.json()) as { error: string }).error, /concurrency/);
  assert.equal(s.config.concurrency, 3);
  assert.equal((await put("phone", 2)).status, 200);
  assert.equal((await put("local", 8)).status, 200);
});

test("the page's img-src allows the configured https JIRA (its attachment images), nothing else", async () => {
  const s = setup({ webDist: dist() });
  const csp = async () => (await s.local("GET", "/")).headers.get("content-security-policy") ?? "";
  // no JIRA yet: only Slack Off itself
  assert.match(await csp(), /img-src 'self' data: blob:;/);
  s.config.jira.baseUrl = "https://jira.example.com/";
  assert.match(await csp(), /img-src 'self' data: blob: https:\/\/jira\.example\.com;/);
  // Jira Cloud: its attachments redirect to Atlassian's media host
  s.config.jira.baseUrl = "https://example.atlassian.net";
  assert.match(await csp(), /img-src 'self' data: blob: https:\/\/example\.atlassian\.net https:\/\/api\.media\.atlassian\.com;/);
  // the rest of the policy is unchanged
  assert.match(await csp(), /default-src 'self';.*connect-src 'self';.*frame-ancestors 'none'/);
  // never a non-https or odd value
  s.config.jira.baseUrl = "http://jira.example.com";
  assert.match(await csp(), /img-src 'self' data: blob:;/);
});
