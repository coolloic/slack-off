// Phase 4b Task 7: the executor / JIRA mode switch, the credential fields and the mode comparison tables (models only).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config, CredentialStatus } from "./api.ts";
import { en } from "../i18n/en.ts";
import { MODE_COMPARISON } from "@slackoff/shared";
import {
  API_CHROME, buildConfig, credentialFields, credentialInputError, credentialRequest, editable, modeComparison, modeError, rowsOf,
} from "./settings-model.ts";

const config: Config = {
  jira: {
    baseUrl: "https://your-company.atlassian.net", readyForDevStatus: "Ready for Dev", discoverLimit: 100, source: "browser",
    syncStatus: false, inProgressStatus: "In Progress", reviewStatus: "Ready for Human Review", browser: null,
  },
  projects: { A: { repos: [{ name: "a", path: "/a", baseBranch: "main" }] } },
  executor: { kind: "claude-code", claudeBin: "claude", model: "" },
  concurrency: 1,
  autoRefine: false,
  reviewAcByDefault: false,
  remoteAccess: { enabled: false, host: "" },
  debate: { maxRounds: 3 },
  development: { maxSteps: 12, commandTimeoutMs: 600_000, hookTimeoutMs: 300_000, allowUnsandboxedCommands: false, deniedLocalPorts: [], allowUnsandboxedHooks: false, localNetwork: "denylist" },
  review: { maxAttempts: 3 },
  acceptance: { claudeConfigDir: "/srv/dev/.slackoff-accept", startTimeoutMs: 120_000, runTimeoutMs: 1_800_000, caseTimeoutMs: 30_000 },
  delivery: { ghBin: "gh" },
  budget: { enabled: false, window: "5h", maxRuns: null, maxRunMinutes: null, maxUsd: null, warnAt: 0.8 },
  telemetry: { endpoint: "", includeContent: false },
};

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const THREE_DAYS_AGO = new Date(NOW - 3 * 24 * 3600_000).toISOString();
const status = (o: { jira?: boolean; anthropic?: boolean } = {}): CredentialStatus => ({
  jira: { set: o.jira ?? false, emailHint: o.jira ? "y…@example.com" : null, updatedAt: o.jira ? THREE_DAYS_AGO : null },
  anthropic: { set: o.anthropic ?? false, updatedAt: o.anthropic ? THREE_DAYS_AGO : null },
  otlpHeaders: { set: false, names: [], updatedAt: null },
});

const FAKE_TOKEN = "test-token-123-not-real";
const FAKE_KEY = "test-anthropic-key-not-real";

test("phase 4b: on a paired phone both mode switches are read-only; on this computer they are editable", () => {
  for (const f of ["executor.kind", "jira.source"] as const) {
    assert.equal(editable(f, true), false, f);
    assert.equal(editable(f, false), true, f);
  }
});

test("phase 4b: on a paired phone the three credential fields are read-only and say 'Set on this computer' / 'Not set' (never an email hint)", () => {
  const set = [...credentialFields("anthropic", status({ jira: true, anthropic: true }), true, NOW), ...credentialFields("jira", status({ jira: true, anthropic: true }), true, NOW)];
  assert.deepEqual(set.map((f) => f.id), ["anthropic.apiKey", "jira.email", "jira.apiToken"]);
  for (const f of set) {
    assert.equal(f.editable, false, f.id);
    assert.equal(f.statusText, "Set on this computer", f.id);
    assert.equal(f.hint, null, `${f.id}: no email hint on a phone`);
  }
  const unset = [...credentialFields("anthropic", status(), true, NOW), ...credentialFields("jira", status(), true, NOW)];
  for (const f of unset) {
    assert.equal(f.editable, false, f.id);
    assert.equal(f.statusText, "Not set", f.id);
  }
});

test("phase 4b: on this computer the credential fields are editable, show 'Set · updated 3d ago' and the email hint, never a value", () => {
  const fields = [...credentialFields("anthropic", status({ jira: true, anthropic: true }), false, NOW), ...credentialFields("jira", status({ jira: true, anthropic: true }), false, NOW)];
  for (const f of fields) {
    assert.equal(f.editable, true, f.id);
    assert.equal(f.statusText, "Set · updated 3d ago", f.id);
    // F4B-5 (M-3): never a password box (Chrome would offer to save it): a text box, never prefilled; the key and the
    // token are masked (-webkit-text-security), the email is plain text
    assert.equal(f.inputType, "text", f.id);
    assert.equal(f.masked, f.id !== "jira.email", f.id);
  }
  assert.equal(fields.find((f) => f.id === "jira.email")!.hint, "y…@example.com");
  assert.equal(credentialFields("jira", status(), false, NOW)[0]!.statusText, "Not set");
});

test("phase 4b: the credential values are never part of the saved config (no apiToken / apiKey / email in the request body)", () => {
  // even a draft that somehow carries credential fields (a stale object, a bug elsewhere) saves without them
  const polluted = {
    ...config,
    jira: { ...config.jira, source: "api", email: "you@example.com", apiToken: FAKE_TOKEN },
    executor: { ...config.executor, kind: "claude-api", apiKey: FAKE_KEY },
  } as unknown as Config;
  const built = buildConfig(polluted, rowsOf(polluted), "1", "");
  assert.equal(built.error, null);
  const body = JSON.stringify(built.config);
  for (const s of ["apiToken", "apiKey", "\"email\"", FAKE_TOKEN, FAKE_KEY, "you@example.com"]) assert.equal(body.includes(s), false, s);
  assert.equal(built.config.jira.source, "api");
  assert.equal(built.config.executor.kind, "claude-api");
});

test("phase 4b: the credential request goes to its own endpoint; the input is checked first (token / key ≥ 16 characters, an email)", () => {
  assert.deepEqual(credentialRequest("jira", { email: " you@example.com ", secret: FAKE_TOKEN }), { path: "/api/credentials/jira", body: { email: "you@example.com", apiToken: FAKE_TOKEN } });
  assert.deepEqual(credentialRequest("anthropic", { email: "", secret: FAKE_KEY }), { path: "/api/credentials/anthropic", body: { apiKey: FAKE_KEY } });
  assert.equal(credentialInputError("jira", { email: "you@example.com", secret: FAKE_TOKEN }), null);
  assert.equal(credentialInputError("anthropic", { email: "", secret: FAKE_KEY }), null);
  assert.equal(credentialInputError("jira", { email: "not-an-email", secret: FAKE_TOKEN }), en["settings.credEmailInvalid"]);
  assert.equal(credentialInputError("jira", { email: "you@example.com", secret: "short-token" }), en["settings.credSecretShort"]);
  assert.equal(credentialInputError("anthropic", { email: "", secret: "" }), en["settings.credSecretShort"]);
  // the message never repeats what was typed
  assert.equal((credentialInputError("jira", { email: "x", secret: "abc" }) ?? "").includes("abc"), false);
});

test("phase 4b (B-4): API_CHROME unavailable → the API-key executor with the browser JIRA mode is a validation error", () => {
  assert.equal(API_CHROME, "unavailable");
  const bad: Config = { ...config, executor: { ...config.executor, kind: "claude-api" }, jira: { ...config.jira, source: "browser" } };
  assert.equal(modeError(bad), "The API key mode cannot drive Chrome: switch JIRA to the API mode too.");
  assert.equal(buildConfig(bad, rowsOf(bad), "1").error, "The API key mode cannot drive Chrome: switch JIRA to the API mode too.");
  for (const ok of [
    config,
    { ...config, jira: { ...config.jira, source: "api" as const } },
    { ...config, executor: { ...config.executor, kind: "claude-api" as const }, jira: { ...config.jira, source: "api" as const } },
  ]) {
    assert.equal(modeError(ok), null);
    assert.equal(buildConfig(ok, rowsOf(ok), "1").error, null);
  }
});

test("phase 4b/4e: the comparison tables — 7 executor rows (spec §7.1 + credentials), 6 JIRA rows, from the shared data", () => {
  const ex = modeComparison("executor");
  assert.deepEqual(ex.columns, ["Claude Code subscription (default)", "Anthropic API key"]);
  assert.equal(ex.rows.length, 7);
  assert.equal(ex, MODE_COMPARISON.executor); // one source with the README
  const jira = modeComparison("jira");
  assert.deepEqual(jira.columns, ["Browser (default)", "JIRA API"]);
  assert.deepEqual(jira.rows.map((r) => r.label), ["Needs", "Credentials", "Speed and cost", "Robustness", "Supported", "Good for"]);
  assert.deepEqual(jira.rows[0], { label: "Needs", values: ["Chrome with Claude in Chrome, logged in to JIRA", "An Atlassian API token and your email"] });
  for (const r of [...ex.rows, ...jira.rows]) {
    assert.equal(r.values.length, 2, r.label);
    for (const v of [r.label, ...r.values]) assert.ok(v.length > 0 && !v.includes("{"), `${r.label}: ${v}`);
  }
});

test("F4B-5 (M-7): the email check is the server's own (one @, no spaces, ≤ 254 characters; no dot required)", () => {
  const ok = (email: string) => credentialInputError("jira", { email, secret: FAKE_TOKEN }) === null;
  assert.equal(ok("you@localhost"), true);
  assert.equal(ok("you@example.com"), true);
  assert.equal(ok("you@@example.com"), false);
  assert.equal(ok("you @example.com"), false);
  assert.equal(ok(`${"a".repeat(250)}@b.co`), false);
  assert.equal(ok("noatsign"), false);
});

test("phase 4c: the budget thresholds are checked like the server (runs 1-10000, minutes 1-100000, USD 0.01-100000, warn 50-99%)", () => {
  const withBudget = (b: Partial<Config["budget"]>): Config => ({ ...config, budget: { ...config.budget, ...b } });
  const err = (b: Partial<Config["budget"]>) => buildConfig(withBudget(b), rowsOf(config), "1").error;
  assert.equal(err({}), null);
  assert.equal(err({ enabled: true, maxRuns: 50, maxRunMinutes: 120, maxUsd: 5, warnAt: 0.8 }), null);
  const message = "Budget: runs 1–10000, minutes 1–100000, USD 0.01–100000 (or empty for no limit), warn at 50–99%.";
  for (const bad of [{ maxRuns: 0 }, { maxRuns: 10001 }, { maxRuns: 1.5 }, { maxRuns: Number.NaN }, { maxRunMinutes: 0 }, { maxUsd: 0 }, { maxUsd: 100001 }, { warnAt: 1 }, { warnAt: 0.4 }]) {
    assert.equal(err(bad), message, JSON.stringify(bad));
  }
});

test("phase 4c: run tracing is set on this computer only; a bad endpoint blocks Save", () => {
  assert.equal(editable("telemetry.endpoint", true), false);
  assert.equal(editable("telemetry.includeContent", true), false);
  assert.equal(editable("telemetry.endpoint", false), true);
  const withEndpoint = (endpoint: string): Config => ({ ...config, telemetry: { endpoint, includeContent: false } });
  assert.equal(buildConfig(withEndpoint("https://otel.example.com/v1/traces"), rowsOf(config), "1").error, null);
  assert.match(buildConfig(withEndpoint("http://example.com/v1/traces"), rowsOf(config), "1").error ?? "", /http:\/\//);
  assert.equal(buildConfig(withEndpoint("  https://otel.example.com/v1/traces "), rowsOf(config), "1").config.telemetry.endpoint, "https://otel.example.com/v1/traces");
});

test("a repository's commands (Settings): kept when set, dropped when blank, refused when not one safe command", () => {
  const withRepo: Config = { ...config, projects: { P: { repos: [{ name: "web", path: "/r/web", baseBranch: "develop", commands: { install: "npm ci", lint: "npm run lint" } }] } } };
  const rows = rowsOf(withRepo);
  assert.deepEqual(rows[0]!.commands, { install: "npm ci", build: "", lint: "npm run lint", test: "" });
  const built = buildConfig(withRepo, rows, "1");
  assert.equal(built.error, null);
  assert.deepEqual(built.config.projects.P!.repos[0]!.commands, { install: "npm ci", lint: "npm run lint" });
  // all blank: no commands key at all
  const blank = buildConfig(withRepo, [{ ...rows[0]!, commands: { install: " ", build: "", lint: "", test: "" } }], "1");
  assert.equal(blank.config.projects.P!.repos[0]!.commands, undefined);
  // not one safe command
  const bad = buildConfig(withRepo, [{ ...rows[0]!, commands: { ...rows[0]!.commands!, install: "npm ci && rm -rf /" } }], "1");
  assert.equal(bad.error, "Project P, repository web: install must be one command without shell characters (for example npm ci).");
});
