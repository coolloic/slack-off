import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "./api.ts";
import { canonicalJson } from "./canonical.ts";
import { commentDraft, nextAcId } from "./requirements-model.ts";
import { buildConfig, editable, shellQuote, isConfigDirty, isValidBrowserName, rowsOf, sandboxStatusView } from "./settings-model.ts";
import { en } from "../i18n/en.ts";

const config: Config = {
  jira: {
    baseUrl: "https://acme.atlassian.net", readyForDevStatus: "Ready for Dev", discoverLimit: 100, source: "browser",
    syncStatus: false, inProgressStatus: "In Progress", reviewStatus: "Ready for Human Review", browser: null,
  },
  projects: {
    B: { repos: [{ name: "b", path: "/b", baseBranch: "main" }] },
    A: { repos: [{ name: "a", path: "/a", baseBranch: "main" }, { name: "a-web", path: "/a-web", baseBranch: "develop" }] },
  },
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

test("settings: one row per (project, repository); rows of the same key group into repos[]", () => {
  const rows = rowsOf(config);
  assert.deepEqual(rows.map((r) => [r.key, r.name, r.path, r.baseBranch]), [["B", "b", "/b", "main"], ["A", "a", "/a", "main"], ["A", "a-web", "/a-web", "develop"]]);
  const same = buildConfig(config, rows, "1");
  assert.equal(same.error, null);
  assert.deepEqual(same.config.projects, config.projects);
  const two = buildConfig(config, [{ key: "C", name: "api", path: "/c/api", baseBranch: "main" }, { key: "C", name: "web", path: "/c/web", baseBranch: "main" }], "1");
  assert.equal(two.error, null);
  assert.equal(two.config.projects.C!.repos.length, 2);
  const edited = buildConfig(config, rows.map((r) => (r.name === "a" ? { ...r, path: "/a2" } : r)), "1");
  assert.deepEqual(edited.config.projects.A, { repos: [{ name: "a", path: "/a2", baseBranch: "main" }, { name: "a-web", path: "/a-web", baseBranch: "develop" }] });
});

test("settings: a blank repo name is derived from the path (P-C13), de-duplicated in the project with -2", () => {
  const added = buildConfig(config, [{ key: "C", name: "", path: "/w/Billing Service", baseBranch: "main" }], "1");
  assert.deepEqual(added.config.projects.C, { repos: [{ name: "billing-service", path: "/w/Billing Service", baseBranch: "main" }] });
  const dotted = buildConfig(config, [{ key: "D", name: " ", path: "/w/___", baseBranch: "main" }], "1");
  assert.equal(dotted.config.projects.D!.repos[0]!.name, "repo");
  const twice = buildConfig(config, [{ key: "E", name: "", path: "/x/app", baseBranch: "main" }, { key: "E", name: "", path: "/y/app", baseBranch: "main" }], "1");
  assert.deepEqual(twice.config.projects.E!.repos.map((r) => r.name), ["app", "app-2"]);
  assert.equal(twice.error, null);
});

test("settings: same key + same repo name, an invalid repo name or a relative path is an error", () => {
  const dup = buildConfig(config, [{ key: "C", name: "api", path: "/c/1", baseBranch: "main" }, { key: "C", name: "api", path: "/c/2", baseBranch: "main" }], "1");
  assert.match(dup.error ?? "", /C.*api/);
  for (const name of ["Api", "-api", "a b", "a".repeat(41)]) {
    assert.ok(buildConfig(config, [{ key: "C", name, path: "/c", baseBranch: "main" }], "1").error, name);
  }
  for (const path of ["", "  ", "relative/x"]) {
    const bad = buildConfig(config, [...rowsOf(config), { key: "E", name: "", path, baseBranch: "main" }], "1");
    assert.match(bad.error ?? "", /absolute path/, JSON.stringify(path));
  }
});

test("settings: JIRA in-progress status and debate / development limits are validated", () => {
  const withCfg = (c: Partial<Config>) => buildConfig({ ...config, ...c }, rowsOf(config), "1");
  assert.equal(withCfg({}).error, null);
  assert.ok(withCfg({ jira: { ...config.jira, inProgressStatus: "" } }).error);
  for (const maxRounds of [0, 6, 1.5, Number.NaN]) assert.ok(withCfg({ debate: { maxRounds } }).error, String(maxRounds));
  for (const maxSteps of [0, 51, Number.NaN]) assert.ok(withCfg({ development: { ...config.development, maxSteps } }).error, String(maxSteps));
  for (const ms of [9_000, 3_601_000, Number.NaN, 10_500]) {
    assert.ok(withCfg({ development: { ...config.development, hookTimeoutMs: ms } }).error, `hook ${ms}`);
    assert.ok(withCfg({ development: { ...config.development, commandTimeoutMs: ms } }).error, `command ${ms}`);
  }
  assert.equal(withCfg({ debate: { maxRounds: 5 }, development: { maxSteps: 50, hookTimeoutMs: 10_000, commandTimeoutMs: 3_600_000 } }).error, null);
});

test("settings (R21 / P-phone): on a paired phone the repo mapping, status sync and JIRA browser are read-only, limits stay editable", () => {
  for (const f of ["projects", "jira.syncStatus", "jira.inProgressStatus", "jira.browser", "executor", "jira.readyForDevStatus", "jira.discoverLimit", "remoteAccess"] as const) {
    assert.equal(editable(f, true), false, f);
    assert.equal(editable(f, false), true, f);
  }
  for (const f of ["debate.maxRounds", "development.maxSteps", "development.hookTimeoutMs", "development.commandTimeoutMs", "concurrency"] as const) {
    assert.equal(editable(f, true), true, f);
  }
});

test("canonicalJson ignores key order at every depth", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } }), canonicalJson({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("settings: an unchanged draft is not dirty even when the server returns keys in another order", () => {
  const reordered = JSON.parse(JSON.stringify({ reviewAcByDefault: false, ...config, jira: { source: "browser", ...config.jira } })) as Config;
  const built = buildConfig(reordered, rowsOf(reordered), "1");
  assert.equal(isConfigDirty(config, built), false);
});

test("settings: a real change, an empty key or a bad concurrency is dirty", () => {
  assert.equal(isConfigDirty(config, buildConfig(config, rowsOf(config), "2")), true);
  const empty = buildConfig(config, [...rowsOf(config), { key: " ", name: "", path: "/c", baseBranch: "main" }], "1");
  assert.ok(empty.error);
  assert.equal(isConfigDirty(config, empty), true);
  assert.match(buildConfig(config, rowsOf(config), "").error ?? "", /from 1 to 8/);
});

test("nextAcId never reuses an id deleted from the draft", () => {
  const ac = (id: string) => ({ id, text: id, verifiable: true, source: { type: "developer" as const, reason: "r" } });
  const v1 = { content: { background: "", functional: [], acceptanceCriteria: [ac("AC-1"), ac("AC-2"), ac("AC-3")], discussionOutcomes: [], openQuestions: [], draftComment: null } };
  assert.equal(nextAcId([v1], [ac("AC-1"), ac("AC-2")]), "AC-4"); // AC-3 deleted in the draft
  assert.equal(nextAcId([v1], [ac("AC-1"), ac("AC-9")]), "AC-10");
  assert.equal(nextAcId([], []), "AC-1");
});

test("F-I2: buildConfig rejects a Ready-for-dev status the server would refuse", () => {
  for (const bad of ["", "x".repeat(61), "a\nb", 'a"b', "a'b", "a`b", "a\tb"]) {
    const built = buildConfig({ ...config, jira: { ...config.jira, readyForDevStatus: bad } }, rowsOf(config), "1");
    assert.ok(built.error, JSON.stringify(bad));
  }
  assert.equal(buildConfig({ ...config, jira: { ...config.jira, readyForDevStatus: "To Do" } }, rowsOf(config), "1").error, null);
});

test("settings: buildConfig rejects a discovery limit outside 1-500 or not a whole number", () => {
  const withLimit = (discoverLimit: number) => buildConfig({ ...config, jira: { ...config.jira, discoverLimit } }, rowsOf(config), "1");
  for (const ok of [1, 100, 500]) assert.equal(withLimit(ok).error, null, String(ok));
  for (const bad of [0, 501, 1.5, Number.NaN]) assert.match(withLimit(bad).error ?? "", /1 and 500/, String(bad));
});

test("settings: executor.model is trimmed, empty is allowed, anything but one safe token is invalid", () => {
  const withModel = (model: string) => buildConfig({ ...config, executor: { ...config.executor, model } }, rowsOf(config), "1");
  assert.equal(withModel("").error, null);
  assert.equal(withModel("  claude-opus-5-5 ").error, null);
  assert.equal(withModel("  claude-opus-5-5 ").config.executor.model, "claude-opus-5-5");
  assert.equal(isConfigDirty(config, withModel("opus")), true);
  for (const bad of ["two words", "--dangerously-skip-permissions", "a;b", "a".repeat(81)]) {
    assert.notEqual(withModel(bad).error, null, bad);
  }
});

test("settings: base branch mirrors the server (non-empty, no spaces or control characters, not starting with '-')", () => {
  const withBranch = (baseBranch: string) => buildConfig(config, [{ key: "C", name: "api", path: "/c", baseBranch }], "1");
  for (const ok of ["main", "release/2.0", "feat_x-1"]) assert.equal(withBranch(ok).error, null, ok);
  for (const bad of ["", "  ", "-x", "a b", "a\tb", "a\u0007b", "x".repeat(201)]) assert.match(withBranch(bad).error ?? "", /base branch/i, JSON.stringify(bad));
});

test("settings: a manual JIRA browser name is 1-80 characters without control characters or line breaks", () => {
  for (const ok of ["Mac", "Work laptop (Chrome)", "x".repeat(80)]) assert.equal(isValidBrowserName(ok), true, ok);
  for (const bad of ["", "a\nb", "a\u0000b", "a\u2028b", "x".repeat(81)]) assert.equal(isValidBrowserName(bad), false, JSON.stringify(bad));
});

test("settings (task 16): on a paired phone the review status, Claude config dir, gh binary, sandbox opt-out and denied ports are read-only; review.maxAttempts and the acceptance timeouts stay editable", () => {
  for (const f of ["jira.reviewStatus", "acceptance.claudeConfigDir", "delivery.ghBin", "development.allowUnsandboxedCommands", "development.deniedLocalPorts"] as const) {
    assert.equal(editable(f, true), false, f);
    assert.equal(editable(f, false), true, f);
  }
  for (const f of ["review.maxAttempts", "acceptance.startTimeoutMs", "acceptance.runTimeoutMs"] as const) assert.equal(editable(f, true), true, f);
});

test("settings (task 16): review.maxAttempts 1-5, acceptance timeouts in whole seconds, a relative Claude config dir, a bad gh binary and bad ports are errors", () => {
  const withCfg = (patch: Partial<Config>, ports?: string) => buildConfig({ ...config, ...patch }, rowsOf(config), "1", ports);
  assert.equal(withCfg({}).error, null);
  for (const maxAttempts of [0, 6, 1.5, Number.NaN]) assert.ok(withCfg({ review: { maxAttempts } }).error, String(maxAttempts));
  assert.equal(withCfg({ review: { maxAttempts: 5 } }).error, null);
  for (const ms of [9_000, 900_001, 10_500, Number.NaN]) assert.ok(withCfg({ acceptance: { ...config.acceptance, startTimeoutMs: ms } }).error, `start ${ms}`);
  for (const ms of [59_000, 7_201_000, Number.NaN]) assert.ok(withCfg({ acceptance: { ...config.acceptance, runTimeoutMs: ms } }).error, `run ${ms}`);
  assert.equal(withCfg({ acceptance: { ...config.acceptance, startTimeoutMs: 900_000, runTimeoutMs: 60_000 } }).error, null);
  assert.ok(withCfg({ acceptance: { ...config.acceptance, claudeConfigDir: "relative/dir" } }).error);
  assert.ok(withCfg({ delivery: { ghBin: "  " } }).error);
  assert.ok(withCfg({ jira: { ...config.jira, reviewStatus: "" } }).error);
  assert.deepEqual(withCfg({}, "8080, 9000").config.development.deniedLocalPorts, [8080, 9000]);
  assert.equal(withCfg({}, "").error, null);
  for (const bad of ["0", "65536", "80,x", "1.5", "80,,81"]) assert.ok(withCfg({}, bad).error, bad);
});

test("commentDraft: the edited text wins over the agent draft; null edited falls back to the draft", () => {
  assert.equal(commentDraft("agent draft", "my edit", []).text, "my edit");
  assert.equal(commentDraft("agent draft", null, []).text, "agent draft");
  assert.equal(commentDraft("agent draft", "", []).text, "");
  assert.equal(commentDraft(null, null, []).text, "");
});

test("commentDraft: error follows the server rule (empty, over 2000, control characters; line breaks are fine)", () => {
  assert.equal(commentDraft("Which flow?", null, []).error, null);
  assert.ok(commentDraft(null, null, []).error);
  assert.ok(commentDraft("x", "   \n ", []).error);
  assert.equal(commentDraft(null, "a".repeat(2000), []).error, null);
  assert.ok(commentDraft(null, "a".repeat(2001), []).error);
  assert.equal(commentDraft(null, "line 1\nline 2\r\nline 3", []).error, null);
  assert.ok(commentDraft(null, "bad\u0007bell", []).error);
  assert.ok(commentDraft(null, "tab\there", []).error, "a tab is a control character for the server");
});

test("commentDraft: history is the clarification comments, newest first; only failed ones can be retried", () => {
  const rec = (id: number, state: "done" | "failed" | "confirmed", purpose: "clarification" | "delivery" = "clarification") => ({
    id, purpose, text: `c${id}`, state, detail: null, decidedBy: "local", requestedAt: `2026-11-0${id}T10:00:00Z`,
    decidedAt: null, finishedAt: state === "confirmed" ? null : `2026-11-0${id}T10:05:00Z`,
  });
  const h = commentDraft(null, "x", [rec(1, "done"), rec(2, "failed"), rec(3, "done", "delivery"), rec(4, "confirmed")]).history;
  assert.deepEqual(h.map((e) => [e.id, e.state, e.retry]), [[4, "confirmed", false], [2, "failed", true], [1, "done", false]]);
  assert.equal(h[1]!.text, "c2");
  assert.equal(h[1]!.at, "2026-11-02T10:05:00Z");
  assert.equal(h[0]!.at, "2026-11-04T10:00:00Z");
});

test("shellQuote: plain paths stay as they are; anything else is single-quoted with ' written as '\\''", () => {
  assert.equal(shellQuote("/srv/dev/.slackoff-accept"), "/srv/dev/.slackoff-accept");
  assert.equal(shellQuote("/Users/me/My Dir"), "'/Users/me/My Dir'");
  assert.equal(shellQuote("/Users/o'neil/x"), "'/Users/o'\\''neil/x'");
  assert.equal(shellQuote("/tmp/$(x)"), "'/tmp/$(x)'");
  assert.equal(shellQuote("/a;b&c`d`"), "'/a;b&c`d`'");
});

test("phase 4a Task 5: on a paired phone the git-hooks sandbox switch and the local-network mode are read-only", () => {
  for (const f of ["development.allowUnsandboxedHooks", "development.localNetwork"] as const) {
    assert.equal(editable(f, true), false, f);
    assert.equal(editable(f, false), true, f);
  }
});

test("phase 4a Task 5: sandboxStatusView — available: green 'on (macOS sandbox-exec)'; unavailable: amber with the reason and both switches explained; every text key exists", () => {
  const on = sandboxStatusView({ backend: { name: "sandbox-exec", available: true, reason: null }, selfCheck: { ok: true, detail: "d", at: "2026-11-08T00:00:00.000Z" }, switches: { allowUnsandboxedCommands: false, allowUnsandboxedHooks: false, localNetwork: "denylist" } });
  assert.deepEqual(on, { tone: "ok", title: "settings.sandboxStatusOn", reason: null, notes: [] });
  const off = sandboxStatusView({ backend: { name: "none", available: false, reason: "sandbox-exec is not available on linux" }, selfCheck: null, switches: { allowUnsandboxedCommands: false, allowUnsandboxedHooks: false, localNetwork: "denylist" } });
  assert.deepEqual(off, { tone: "warn", title: "settings.sandboxStatusOff", reason: "sandbox-exec is not available on linux", notes: ["settings.sandboxStatusCommandsNote", "settings.sandboxStatusHooksNote"] });
  // available but the self-check failed: amber with its detail
  const failed = sandboxStatusView({ backend: { name: "sandbox-exec", available: true, reason: null }, selfCheck: { ok: false, detail: "4317:CONNECTED", at: "x" }, switches: { allowUnsandboxedCommands: false, allowUnsandboxedHooks: false, localNetwork: "denylist" } });
  assert.equal(failed.tone, "warn");
  assert.equal(failed.reason, "4317:CONNECTED");
  for (const k of [
    "settings.sandboxStatusOn", "settings.sandboxStatusOff", "settings.sandboxStatusCommandsNote", "settings.sandboxStatusHooksNote",
    "settings.hooksSandboxOff", "settings.hooksSandboxHelp", "settings.hooksSandboxWarning", "settings.localNetwork", "settings.localNetworkHelp",
    "settings.localNetworkDenylist", "settings.localNetworkAllowlist",
  ]) assert.ok(k in en, k);
  assert.equal(
    en["settings.hooksSandboxHelp"],
    "Off (recommended): your pre-commit, commit-msg and pre-push hooks run in a sandbox that cannot reach Slack Off or read your credentials. If the sandbox is unavailable, Slack Off does not commit. On: hooks run with your full user permissions.",
  );
});

test("F4C-1 M-3: concurrency is a whole number from 1 to 8", () => {
  for (const ok of ["1", "8"]) assert.equal(buildConfig(config, rowsOf(config), ok).error, null, ok);
  for (const bad of ["0", "9", "100"]) assert.equal(buildConfig(config, rowsOf(config), bad).error, "Concurrency must be a whole number from 1 to 8.", bad);
});

test("settings (phase 4f, F-4): the case timeout is whole seconds from 1 to 600 and editable on a paired phone", () => {
  const withCfg = (patch: Partial<Config>) => buildConfig({ ...config, ...patch }, rowsOf(config), "1");
  assert.equal(editable("acceptance.caseTimeoutMs", true), true);
  for (const ms of [999, 600_001, 1_500, Number.NaN]) assert.ok(withCfg({ acceptance: { ...config.acceptance, caseTimeoutMs: ms } }).error, `case ${ms}`);
  for (const ms of [1_000, 600_000]) assert.equal(withCfg({ acceptance: { ...config.acceptance, caseTimeoutMs: ms } }).error, null, `case ${ms}`);
});
