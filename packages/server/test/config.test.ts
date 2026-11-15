import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigValidationError, isValidReadyForDevStatus, legacyRepoName, loadConfig, parseConfig, saveConfig, type Config } from "../src/config.ts";

const root = tmpDir("config");
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function freshHome(): string {
  const home = join(root, `home-${counter++}`);
  return home;
}

test("empty directory gets a default config.json", () => {
  const home = freshHome();
  const config = loadConfig(home);
  assert.deepEqual(config, {
    jira: {
      baseUrl: "", readyForDevStatus: "Ready for Dev", discoverLimit: 100, source: "browser",
      syncStatus: false, inProgressStatus: "In Progress", browser: null, reviewStatus: "Ready for Human Review",
    },
    projects: {},
    executor: { kind: "claude-code", claudeBin: "claude", model: "" },
    concurrency: 1,
    autoRefine: false,
    reviewAcByDefault: false,
    remoteAccess: { enabled: false, host: "" },
    debate: { maxRounds: 3 },
    development: { maxSteps: 12, commandTimeoutMs: 600_000, hookTimeoutMs: 300_000, allowUnsandboxedCommands: false, deniedLocalPorts: [], allowUnsandboxedHooks: false, localNetwork: "denylist" },
    review: { maxAttempts: 3 },
    acceptance: {
      claudeConfigDir: join(homedir(), ".slackoff-acceptance", "claude-config"), startTimeoutMs: 120_000, runTimeoutMs: 1_800_000, caseTimeoutMs: 30_000,
    },
    delivery: { ghBin: "gh", azBin: "az" },
    budget: { enabled: false, window: "5h", maxRuns: null, maxRunMinutes: null, maxUsd: null, warnAt: 0.8 },
    telemetry: { endpoint: "", includeContent: false },
  } satisfies Config);
  assert.ok(existsSync(join(home, "config.json")), "config.json written");
  const onDisk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(onDisk, config);
  assert.match(readFileSync(join(home, "config.json"), "utf8"), /^\{\n  "/);
});

test("loading an existing valid file returns its values", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      jira: { baseUrl: "https://acme.atlassian.net/", readyForDevStatus: "Ready", source: "browser" },
      projects: { ABC: { repoPath: "/repo", baseBranch: "main" } },
      executor: { kind: "claude-code", claudeBin: "/usr/local/bin/claude" },
      concurrency: 3,
      autoRefine: true,
      reviewAcByDefault: true,
    }),
  );
  const config = loadConfig(home);
  assert.equal(config.jira.baseUrl, "https://acme.atlassian.net");
  assert.equal(config.jira.readyForDevStatus, "Ready");
  assert.deepEqual(config.projects, { ABC: { repos: [{ name: "repo", path: "/repo", baseBranch: "main" }] } });
  assert.equal(config.executor.claudeBin, "/usr/local/bin/claude");
  assert.equal(config.concurrency, 3);
  assert.equal(config.autoRefine, true);
  assert.equal(config.reviewAcByDefault, true);
});

test("concurrency 0 is rejected with a message naming concurrency", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ concurrency: 0 }));
  assert.throws(() => loadConfig(home), /concurrency/);
});

test("non-https non-empty baseUrl is rejected", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ jira: { baseUrl: "http://acme.atlassian.net" } }),
  );
  assert.throws(() => loadConfig(home), /jira\.baseUrl/);
});

test("empty baseUrl is accepted", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ jira: { baseUrl: "" } }));
  assert.equal(loadConfig(home).jira.baseUrl, "");
});

test("saveConfig validates and writes, then loadConfig reads it back", () => {
  const home = freshHome();
  const config = loadConfig(home);
  saveConfig(home, { ...config, concurrency: 2, jira: { ...config.jira, baseUrl: "https://x.example.com" } });
  const reloaded = loadConfig(home);
  assert.equal(reloaded.concurrency, 2);
  assert.equal(reloaded.jira.baseUrl, "https://x.example.com");
});

test("saveConfig rejects invalid config without writing", () => {
  const home = freshHome();
  const config = loadConfig(home);
  const before = readFileSync(join(home, "config.json"), "utf8");
  assert.throws(() => saveConfig(home, { ...config, concurrency: 0 }), /concurrency/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
});

test("F-I2: readyForDevStatus must be one line of 1-60 chars without control characters, quotes or backticks", () => {
  for (const ok of ["Ready for Dev", "To Do", "Prêt (dev)", "x".repeat(60)]) {
    assert.equal(isValidReadyForDevStatus(ok), true, ok);
    assert.equal(parseConfig({ jira: { readyForDevStatus: ok } }).jira.readyForDevStatus, ok);
  }
  for (const bad of ["", "x".repeat(61), "a\nb", "a\rb", "a\tb", "a\u0000b", "a b", 'a"b', "a'b", "a`b"]) {
    assert.equal(isValidReadyForDevStatus(bad), false, JSON.stringify(bad));
    assert.throws(() => parseConfig({ jira: { readyForDevStatus: bad } }), ConfigValidationError, JSON.stringify(bad));
  }
});

test("jira.discoverLimit is a whole number 1-500, default 100", () => {
  assert.equal(parseConfig({}).jira.discoverLimit, 100);
  for (const ok of [1, 50, 500]) assert.equal(parseConfig({ jira: { discoverLimit: ok } }).jira.discoverLimit, ok);
  for (const bad of [0, -1, 501, 1.5, "100", null]) {
    assert.throws(() => parseConfig({ jira: { discoverLimit: bad } }), (e: unknown) => e instanceof ConfigValidationError && e.issues.some((i) => i.field === "jira.discoverLimit"), JSON.stringify(bad));
  }
});

// ---- phase 2: multi-repo projects, JIRA status sync, debate/development limits ----

const fieldErr = (field: RegExp) => (e: unknown) =>
  e instanceof ConfigValidationError && e.issues.some((i) => field.test(i.field)) && field.test(e.message);

test("a legacy {repoPath, baseBranch} project loads as one repo and is saved in the new format", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ projects: { PROJ: { repoPath: "/w/Billing Service", baseBranch: "main" } } }));
  const config = loadConfig(home);
  assert.deepEqual(config.projects, { PROJ: { repos: [{ name: "billing-service", path: "/w/Billing Service", baseBranch: "main" }] } });
  saveConfig(home, config);
  const onDisk = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.deepEqual(onDisk.projects, { PROJ: { repos: [{ name: "billing-service", path: "/w/Billing Service", baseBranch: "main" }] } });
});

test("legacyRepoName: basename, lower-cased, illegal characters to '-', leading non-alphanumerics dropped, max 40, empty -> repo", () => {
  assert.equal(legacyRepoName("/w/Billing Service"), "billing-service");
  assert.equal(legacyRepoName("/w/.dotfiles"), "dotfiles");
  assert.equal(legacyRepoName("/w/___"), "repo");
  assert.equal(legacyRepoName("/w/api/"), "api");
  assert.equal(legacyRepoName(""), "repo");
  assert.equal(legacyRepoName("/w/" + "A".repeat(60)), "a".repeat(40));
  assert.equal(legacyRepoName("C:\\src\\Web App"), "web-app");
});

test("projects: repos needs at least one repo, valid unique names", () => {
  const repo = (name: string) => ({ name, path: `/w/${name}`, baseBranch: "main" });
  assert.throws(() => parseConfig({ projects: { PROJ: { repos: [repo("api"), { ...repo("api"), path: "/w/other" }] } } }), fieldErr(/projects\.PROJ\.repos/));
  assert.throws(() => parseConfig({ projects: { PROJ: { repos: [] } } }), fieldErr(/projects\.PROJ\.repos/));
  assert.throws(() => parseConfig({ projects: { PROJ: { repos: [repo("Api")] } } }), fieldErr(/projects\.PROJ\.repos\.0\.name/));
  assert.throws(() => parseConfig({ projects: { PROJ: { repos: [{ ...repo("api"), baseBranch: "--output=/tmp/x" }] } } }), fieldErr(/projects\.PROJ\.repos\.0\.baseBranch/));
  for (const path of ["", "relative/dir", "./x"]) {
    assert.throws(() => parseConfig({ projects: { PROJ: { repos: [{ ...repo("api"), path }] } } }), fieldErr(/projects\.PROJ\.repos\.0\.path/), JSON.stringify(path));
  }
  assert.throws(() => parseConfig({ projects: { PROJ: { repoPath: "", baseBranch: "main" } } }), fieldErr(/projects\.PROJ\.repos\.0\.path/), "legacy empty path");
  const ok = parseConfig({ projects: { PROJ: { repos: [repo("api"), repo("web")] } } });
  assert.deepEqual(ok.projects.PROJ!.repos.map((r) => r.name), ["api", "web"]);
});

test("debate and development limits: defaults and ranges", () => {
  const d = parseConfig({});
  assert.deepEqual(d.debate, { maxRounds: 3 });
  assert.deepEqual(d.development, { maxSteps: 12, commandTimeoutMs: 600_000, hookTimeoutMs: 300_000, allowUnsandboxedCommands: false, deniedLocalPorts: [], allowUnsandboxedHooks: false, localNetwork: "denylist" });
  assert.equal(parseConfig({ debate: { maxRounds: 5 } }).debate.maxRounds, 5);
  for (const bad of [0, 6, 2.5]) assert.throws(() => parseConfig({ debate: { maxRounds: bad } }), fieldErr(/debate\.maxRounds/), String(bad));
  for (const bad of [0, 51]) assert.throws(() => parseConfig({ development: { maxSteps: bad } }), fieldErr(/development\.maxSteps/), String(bad));
  for (const bad of [9_999, 3_600_001]) {
    assert.throws(() => parseConfig({ development: { commandTimeoutMs: bad } }), fieldErr(/development\.commandTimeoutMs/), String(bad));
    assert.throws(() => parseConfig({ development: { hookTimeoutMs: bad } }), fieldErr(/development\.hookTimeoutMs/), String(bad));
  }
});

test("jira.syncStatus / inProgressStatus / browser", () => {
  const d = parseConfig({});
  assert.equal(d.jira.syncStatus, false);
  assert.equal(d.jira.inProgressStatus, "In Progress");
  assert.equal(d.jira.browser, null);
  assert.throws(() => parseConfig({ jira: { inProgressStatus: 'In "Progress' } }), fieldErr(/jira\.inProgressStatus/));
  assert.throws(() => parseConfig({ jira: { inProgressStatus: "" } }), fieldErr(/jira\.inProgressStatus/));
  const browser = { deviceId: "abc-123_X.y:z", name: "Loïc's MacBook" };
  assert.deepEqual(parseConfig({ jira: { syncStatus: true, browser } }).jira.browser, browser);
  for (const deviceId of ["has space", "line\nbreak", "", "x".repeat(129), "quote'"]) {
    assert.throws(() => parseConfig({ jira: { browser: { ...browser, deviceId } } }), fieldErr(/jira\.browser\.deviceId/), JSON.stringify(deviceId));
  }
  for (const name of ["", "a\nb", "x".repeat(81)]) {
    assert.throws(() => parseConfig({ jira: { browser: { ...browser, name } } }), fieldErr(/jira\.browser\.name/), JSON.stringify(name));
  }
});

// ---- H3 friendly config errors at startup ----

import { spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { formatConfigFileError } from "../src/config.ts";
import { tmpDir } from "./helpers/tmp.ts";

const mainTs = resolvePath(import.meta.dirname, "../src/main.ts");

function startWith(configText: string) {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  const file = join(home, "config.json");
  writeFileSync(file, configText);
  const r = spawnSync(process.execPath, [mainTs], { env: { ...process.env, SLACKOFF_HOME: home, SLACKOFF_FAKE_EXECUTOR: "" }, encoding: "utf8", timeout: 20_000 });
  return { ...r, file };
}

test("H3: an invalid field stops startup with path, field, rule and fix, without a stack trace", () => {
  const r = startWith(JSON.stringify({ concurrency: 0 }));
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(r.file), "names the file");
  assert.match(r.stderr, /Field: concurrency/);
  assert.match(r.stderr, /Rule: .*>=\s*1/);
  assert.match(r.stderr, /edit .*config\.json|edit the file/i);
  assert.match(r.stderr, /delete the field to use (its|the) default/i);
  assert.doesNotMatch(r.stderr, /\n\s+at\s/, "no stack trace");
  assert.doesNotMatch(r.stderr, /ConfigValidationError|node:internal/);
});

test("H3: a config.json that is not JSON stops startup with a clear message", () => {
  const r = startWith("{ not json");
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(r.file));
  assert.match(r.stderr, /not valid JSON/);
  assert.match(r.stderr, /delete the file/i);
  assert.doesNotMatch(r.stderr, /\n\s+at\s/);
});

test("H3: an old config with an empty repoPath stops startup with the friendly error naming the field", () => {
  const r = startWith(JSON.stringify({ projects: { PROJ: { repoPath: "", baseBranch: "main" } } }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Field: projects\.PROJ\.repos\.0\.path/);
  assert.match(r.stderr, /Rule: must be an absolute path/);
  assert.doesNotMatch(r.stderr, /\n\s+at\s/);
});

test("H3: every invalid field is listed, nested fields by their dotted path", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ jira: { baseUrl: "http://plain" }, autoRefine: "yes" }));
  let err: unknown;
  try {
    loadConfig(home);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ConfigValidationError);
  const msg = formatConfigFileError(err);
  assert.ok(msg.includes(join(home, "config.json")));
  assert.match(msg, /Field: jira\.baseUrl\n\s*Rule: must be empty or an https:\/\/ URL/);
  assert.match(msg, /Field: autoRefine\n\s*Rule: .*boolean/);
});

test("H3: parseConfig keeps its one-line API message", () => {
  assert.throws(() => parseConfig({ concurrency: 0 }), /^ConfigValidationError: Invalid config: concurrency: /);
});

test("executor.model: optional single token, default empty", () => {
  assert.equal(parseConfig({}).executor.model, "");
  for (const ok of ["claude-opus-5-5", "opus", "sonnet[1m]".replace("[1m]", ""), "us.anthropic.claude-x:1", "a".repeat(80)]) {
    assert.equal(parseConfig({ executor: { model: ok } }).executor.model, ok, ok);
  }
  for (const bad of ["two words", "x;rm -rf", "a\nb", "a".repeat(81), "--dangerously-skip-permissions", "-x", "opus/../x", "ünï"]) {
    assert.throws(() => parseConfig({ executor: { model: bad } }), (e: unknown) => e instanceof ConfigValidationError && /executor\.model/.test(e.message), JSON.stringify(bad));
  }
});

// ---- phase 3 (Task 4): review, acceptance, delivery, review status, sandbox switch ----

test("phase 3: an old config.json without the new keys loads with their defaults", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ jira: { syncStatus: true }, development: { maxSteps: 5 } }));
  const c = loadConfig(home);
  assert.equal(c.jira.reviewStatus, "Ready for Human Review");
  assert.equal(c.review.maxAttempts, 3);
  assert.equal(c.delivery.ghBin, "gh");
  assert.equal(c.development.allowUnsandboxedCommands, false);
  assert.equal(c.development.maxSteps, 5);
  assert.equal(c.acceptance.startTimeoutMs, 120_000);
  assert.equal(c.acceptance.runTimeoutMs, 1_800_000);
});

test("phase 3: review.maxAttempts 1-5, acceptance timeouts in range, reviewStatus one plain line, ghBin one line", () => {
  assert.equal(parseConfig({ review: { maxAttempts: 5 } }).review.maxAttempts, 5);
  assert.equal(parseConfig({ review: { maxAttempts: 1 } }).review.maxAttempts, 1);
  for (const bad of [0, 6, 2.5]) assert.throws(() => parseConfig({ review: { maxAttempts: bad } }), fieldErr(/review\.maxAttempts/), String(bad));
  for (const bad of [9_999, 900_001]) assert.throws(() => parseConfig({ acceptance: { startTimeoutMs: bad } }), fieldErr(/acceptance\.startTimeoutMs/));
  for (const bad of [59_999, 7_200_001]) assert.throws(() => parseConfig({ acceptance: { runTimeoutMs: bad } }), fieldErr(/acceptance\.runTimeoutMs/));
  assert.equal(parseConfig({ acceptance: { startTimeoutMs: 10_000, runTimeoutMs: 7_200_000 } }).acceptance.runTimeoutMs, 7_200_000);
  for (const bad of ['Ready "x', "", "a\nb", "x".repeat(61), "back`tick"]) {
    assert.throws(() => parseConfig({ jira: { reviewStatus: bad } }), fieldErr(/jira\.reviewStatus/), JSON.stringify(bad));
  }
  assert.equal(parseConfig({ jira: { reviewStatus: "Code Review" } }).jira.reviewStatus, "Code Review");
  assert.equal(parseConfig({ delivery: { ghBin: "/opt/homebrew/bin/gh" } }).delivery.ghBin, "/opt/homebrew/bin/gh");
  for (const bad of ["", "gh\n--web"]) assert.throws(() => parseConfig({ delivery: { ghBin: bad } }), fieldErr(/delivery\.ghBin/), JSON.stringify(bad));
  assert.equal(parseConfig({ development: { allowUnsandboxedCommands: true } }).development.allowUnsandboxedCommands, true);
  assert.throws(() => parseConfig({ development: { allowUnsandboxedCommands: "yes" } }), fieldErr(/development\.allowUnsandboxedCommands/));
  // T5-6: extra local ports the command sandbox denies (connect and listen)
  assert.deepEqual(parseConfig({ development: { deniedLocalPorts: [9999, 1] } }).development.deniedLocalPorts, [9999, 1]);
  for (const bad of [[0], [65536], [1.5], ["80"], 80]) {
    assert.throws(() => parseConfig({ development: { deniedLocalPorts: bad } }), fieldErr(/development\.deniedLocalPorts/), JSON.stringify(bad));
  }
  assert.throws(() => parseConfig({ development: { deniedLocalPorts: Array.from({ length: 101 }, (_, i) => i + 1) } }), fieldErr(/development\.deniedLocalPorts/));
  assert.throws(() => parseConfig({ acceptance: { claudeConfigDir: "relative/dir" } }), fieldErr(/acceptance\.claudeConfigDir/));
});

test("phase 3: acceptance.claudeConfigDir inside SLACKOFF_HOME is rejected by loadConfig with the field name", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ acceptance: { claudeConfigDir: join(home, "accept", "claude") } }));
  assert.throws(() => loadConfig(home), (e: unknown) => {
    assert.ok(e instanceof ConfigValidationError);
    assert.ok(e.issues.some((i) => i.field === "acceptance.claudeConfigDir"), JSON.stringify(e.issues));
    assert.equal(e.file, join(home, "config.json"));
    return true;
  });
  // the home itself, and a folder holding the home, are rejected too
  writeFileSync(join(home, "config.json"), JSON.stringify({ acceptance: { claudeConfigDir: home } }));
  assert.throws(() => loadConfig(home), /acceptance\.claudeConfigDir/);
  writeFileSync(join(home, "config.json"), JSON.stringify({ acceptance: { claudeConfigDir: join(home, "..") } }));
  assert.throws(() => loadConfig(home), /acceptance\.claudeConfigDir/);
  // a sibling folder is fine
  writeFileSync(join(home, "config.json"), JSON.stringify({ acceptance: { claudeConfigDir: `${home}-accept` } }));
  assert.equal(loadConfig(home).acceptance.claudeConfigDir, `${home}-accept`);
});

test("phase 3 (R3): saveConfig rejects a claudeConfigDir inside SLACKOFF_HOME before writing", () => {
  const home = freshHome();
  const config = loadConfig(home);
  const before = readFileSync(join(home, "config.json"), "utf8");
  assert.throws(
    () => saveConfig(home, { ...config, acceptance: { ...config.acceptance, claudeConfigDir: join(home, "not", "yet", "there") } }),
    (e: unknown) => e instanceof ConfigValidationError && e.issues.some((i) => i.field === "acceptance.claudeConfigDir"),
  );
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
});

test("phase 3: a claudeConfigDir reaching SLACKOFF_HOME through a symlink (existing or not yet created below it) is rejected", () => {
  const home = freshHome();
  const config = loadConfig(home);
  const outside = join(root, `outside-${counter++}`);
  mkdirSync(outside, { recursive: true });
  symlinkSync(home, join(outside, "link"));
  const before = readFileSync(join(home, "config.json"), "utf8");
  for (const dir of [join(outside, "link"), join(outside, "link", "claude-config")]) {
    assert.throws(() => saveConfig(home, { ...config, acceptance: { ...config.acceptance, claudeConfigDir: dir } }), /acceptance\.claudeConfigDir/, dir);
  }
  // a dangling symlink whose target would be created inside the home
  symlinkSync(join(home, "later"), join(outside, "dangling"));
  assert.throws(
    () => saveConfig(home, { ...config, acceptance: { ...config.acceptance, claudeConfigDir: join(outside, "dangling", "x") } }),
    /acceptance\.claudeConfigDir/,
  );
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
  // SLACKOFF_HOME itself given through a symlink: the check compares real paths
  const homeLink = join(outside, "home-link");
  symlinkSync(home, homeLink);
  assert.throws(
    () => saveConfig(homeLink, { ...config, acceptance: { ...config.acceptance, claudeConfigDir: join(home, "c") } }),
    /acceptance\.claudeConfigDir/,
  );
  saveConfig(home, { ...config, acceptance: { ...config.acceptance, claudeConfigDir: join(outside, "real-config") } });
  assert.equal(loadConfig(home).acceptance.claudeConfigDir, join(outside, "real-config"));
});

test("phase 3: startup with a claudeConfigDir inside SLACKOFF_HOME stops with the friendly error", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  const file = join(home, "config.json");
  writeFileSync(file, JSON.stringify({ acceptance: { claudeConfigDir: join(home, "c") } }));
  const r = spawnSync(process.execPath, [mainTs], { env: { ...process.env, SLACKOFF_HOME: home, SLACKOFF_FAKE_EXECUTOR: "" }, encoding: "utf8", timeout: 20_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Field: acceptance\.claudeConfigDir/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("fix 1: a claudeConfigDir named '..cfg' inside SLACKOFF_HOME is inside; <home>/../x is a sibling and allowed", () => {
  const home = freshHome();
  const config = loadConfig(home);
  for (const dir of [join(home, "..cfg"), join(home, "..", "x", "..", `${home.split("/").pop()}`, "..c")]) {
    assert.throws(() => saveConfig(home, { ...config, acceptance: { ...config.acceptance, claudeConfigDir: dir } }), /acceptance\.claudeConfigDir/, dir);
  }
  saveConfig(home, { ...config, acceptance: { ...config.acceptance, claudeConfigDir: `${home}/../x` } });
  assert.equal(loadConfig(home).acceptance.claudeConfigDir, `${home}/../x`);
  assert.throws(() => saveConfig(home, { ...config, acceptance: { ...config.acceptance, claudeConfigDir: `${home}/..` } }), /acceptance\.claudeConfigDir/);
});

test("fix 4: delivery.ghBin is a bare command name or an absolute path", () => {
  for (const ok of ["gh", "gh-2.60", "my_gh", "/opt/homebrew/bin/gh", "/Applications/My Tools/gh"]) {
    assert.equal(parseConfig({ delivery: { ghBin: ok } }).delivery.ghBin, ok);
  }
  for (const bad of ["./gh", "bin/gh", "../gh", "gh --web", "-gh", "~/bin/gh", "", "/x\n"]) {
    assert.throws(() => parseConfig({ delivery: { ghBin: bad } }), fieldErr(/delivery\.ghBin/), JSON.stringify(bad));
  }
});

test("phase 4a (A-3): development.allowUnsandboxedHooks defaults to false, a boolean, separate from the commands switch", () => {
  assert.equal(parseConfig({}).development.allowUnsandboxedHooks, false);
  assert.equal(parseConfig({ development: { allowUnsandboxedCommands: true } }).development.allowUnsandboxedHooks, false);
  assert.equal(parseConfig({ development: { allowUnsandboxedHooks: true } }).development.allowUnsandboxedHooks, true);
  assert.equal(parseConfig({ development: { allowUnsandboxedHooks: true } }).development.allowUnsandboxedCommands, false);
  assert.throws(() => parseConfig({ development: { allowUnsandboxedHooks: "yes" } }), fieldErr(/development\.allowUnsandboxedHooks/));
});

test("phase 4a Task 4: development.localNetwork is 'denylist' by default, 'allowlist' accepted, anything else refused", () => {
  assert.equal(parseConfig({}).development.localNetwork, "denylist");
  assert.equal(parseConfig({ development: { localNetwork: "allowlist" } }).development.localNetwork, "allowlist");
  assert.throws(() => parseConfig({ development: { localNetwork: "open" } }), fieldErr(/development\.localNetwork/));
});

// ---------------------------------------------------------------- phase 4b Task 3: executor.kind and jira.source

import { API_CHROME } from "../src/config.ts";

test("4b T3: executor.kind defaults to claude-code and jira.source to browser; an old config.json without them loads", () => {
  assert.equal(parseConfig({}).executor.kind, "claude-code");
  assert.equal(parseConfig({}).jira.source, "browser");
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ jira: { baseUrl: "https://your-company.atlassian.net" }, executor: { claudeBin: "claude" } }));
  const c = loadConfig(home);
  assert.equal(c.executor.kind, "claude-code");
  assert.equal(c.jira.source, "browser");
});

test("4b T3: the API modes are accepted; unknown kinds are refused with their field", () => {
  const api = parseConfig({ executor: { kind: "claude-api" }, jira: { source: "api" } });
  assert.equal(api.executor.kind, "claude-api");
  assert.equal(api.jira.source, "api");
  // the JIRA API mode without a URL saves (like the browser mode; using it says JIRA is not configured)
  assert.equal(parseConfig({ jira: { source: "api", baseUrl: "" } }).jira.source, "api");
  assert.equal(parseConfig({ jira: { source: "api" } }).executor.kind, "claude-code", "the subscription executor with the JIRA API mode");
  for (const [input, field] of [[{ executor: { kind: "other" } }, "executor.kind"], [{ jira: { source: "other" } }, "jira.source"]] as const) {
    assert.throws(() => parseConfig(input), (e: unknown) => e instanceof ConfigValidationError && e.issues.some((i) => i.field === field), field);
  }
});

test("4b T3 (B-4, API_CHROME unavailable): the API executor with the browser JIRA mode is refused on jira.source", { skip: API_CHROME === "unavailable" ? false : "API_CHROME is available: the two settings are independent" }, () => {
  assert.throws(
    () => parseConfig({ executor: { kind: "claude-api" }, jira: { source: "browser" } }),
    (e: unknown) =>
      e instanceof ConfigValidationError &&
      e.issues.length === 1 &&
      e.issues[0]!.field === "jira.source" &&
      e.issues[0]!.rule === "the API executor cannot drive Chrome: use the JIRA API mode",
  );
  // a saved file with that pair does not load either
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ executor: { kind: "claude-api" } }));
  assert.throws(() => loadConfig(home), (e: unknown) => e instanceof ConfigValidationError && e.issues[0]!.field === "jira.source");
});

test("4B-8 (I4): jira.baseUrl refuses user info, a query or a fragment; a trailing slash is trimmed", () => {
  // built by concatenation: "user:pw" + "@" + host reads as an email to the public-content check
  const at = "@";
  for (const bad of [`https://user:pw${at}your-company.atlassian.net`, `https://user${at}your-company.atlassian.net`, "https://your-company.atlassian.net/?x=1", "https://your-company.atlassian.net/#top"]) {
    assert.throws(() => parseConfig({ jira: { baseUrl: bad } }), (e: unknown) => e instanceof ConfigValidationError && e.issues.some((i) => i.field === "jira.baseUrl") && !e.message.includes("pw@"), bad);
  }
  assert.equal(parseConfig({ jira: { baseUrl: "https://your-company.atlassian.net/" } }).jira.baseUrl, "https://your-company.atlassian.net");
});

test("phase 4f: acceptance.caseTimeoutMs 1 s – 10 min, default 30 s", () => {
  assert.equal(parseConfig({}).acceptance.caseTimeoutMs, 30_000);
  for (const ok of [1_000, 600_000]) assert.equal(parseConfig({ acceptance: { caseTimeoutMs: ok } }).acceptance.caseTimeoutMs, ok);
  for (const bad of [500, 999, 600_001, 1_500.5]) assert.throws(() => parseConfig({ acceptance: { caseTimeoutMs: bad } }), fieldErr(/acceptance\.caseTimeoutMs/), String(bad));
});

test("a repository mapping may carry its own commands (install/build/lint/test), each one safe command", () => {
  const repo = { name: "web", path: "/r/web", baseBranch: "develop" };
  const c = parseConfig({ projects: { P: { repos: [{ ...repo, commands: { install: "npm ci", lint: "npm run lint", test: "npm run test:unit" } }] } } });
  assert.deepEqual(c.projects.P!.repos[0]!.commands, { install: "npm ci", lint: "npm run lint", test: "npm run test:unit" });
  // none: still valid, no commands key needed
  assert.equal(parseConfig({ projects: { P: { repos: [repo] } } }).projects.P!.repos[0]!.commands, undefined);
  for (const bad of ["npm ci && rm -rf /", "sh -c x", "npm ci; echo", "FOO=1 npm ci", "", "a".repeat(201)]) {
    assert.throws(() => parseConfig({ projects: { P: { repos: [{ ...repo, commands: { install: bad } }] } } }), ConfigValidationError, JSON.stringify(bad));
  }
  assert.throws(() => parseConfig({ projects: { P: { repos: [{ ...repo, commands: { deploy: "npm run deploy" } }] } } }), ConfigValidationError);
});
