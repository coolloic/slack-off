// Phase 4b task 6: ClaudeApiExecutor — the same Claude Code CLI with the same sandbox and guard flags, authenticated
// with the Anthropic API key. Ruling 4B-11: the key reaches claude only through an apiKeyHelper script named in its
// --settings (never any environment), and every claude run gets an allowlisted environment built from scratch. Only
// the fake CLI (fixtures/fake-claude.ts) runs here: never the real claude, never the network.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AgentRole } from "@slackoff/shared";
import { CredentialFileError, writeCredentials } from "../src/credentials/credential-store.ts";
import { openDatabase } from "../src/db/database.ts";
import { buildClaudeArgs } from "../src/executor/claude-args.ts";
import { AgentProcesses, ClaudeCodeExecutor, passFakeClaudeEnvForTests } from "../src/executor/claude-code.ts";
import { API_CHROME_UNAVAILABLE, API_KEY_DELIVERY, apiKeyHelperPath, ClaudeApiExecutor, configuredExecutor, PRINT_API_KEY_SCRIPT } from "../src/executor/claude-api.ts";
import { runAgent } from "../src/executor/run-agent.ts";
import { ACCEPT_ENV_KEYS, SandboxPolicyError } from "../src/executor/sandbox.ts";
import { ExecutorUnavailableError, type ExecRequest, type Executor } from "../src/executor/types.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import { SANDBOX_EXEC, writeShellPrefix, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { tmpDir } from "./helpers/tmp.ts";

// tests only: the fake CLI's FAKE_CLAUDE_* settings pass the allowlisted environment
passFakeClaudeEnvForTests();

const repoRoot = resolve(import.meta.dirname, "../../..");
const fake = resolve(import.meta.dirname, "fixtures/fake-claude.ts");
/** obviously fake, 16+ characters (the credentials minimum); never a real-looking key */
const KEY = "test-anthropic-key-0000";
/** the server's own environment: Claude credentials, redirections and other secrets — none may reach a claude run */
const SEEDED: Record<string, string> = {
  ANTHROPIC_API_KEY: "server-env-key-should-be-stripped",
  ANTHROPIC_BASE_URL: "https://proxy.example.invalid",
  ANTHROPIC_AUTH_TOKEN: "server-env-auth-token",
  CLAUDE_CODE_OAUTH_TOKEN: "server-env-oauth-token",
  CLAUDE_CODE_SHELL_PREFIX: "/inherited/prefix",
  CLAUDE_CODE_TMPDIR: "/inherited/tmp",
  CLAUDE_CODE_FOO: "server-env-claude-code-foo",
  CLAUDE_CONFIG_DIR: "/inherited/config",
  GH_TOKEN: "server-env-gh-token-0000",
  AWS_SECRET_ACCESS_KEY: "server-env-aws-secret-0000",
  FOO_TOKEN: "server-env-foo-token-0000",
};
/** ruling 4B-11 (2): what a claude run may see (+ the fake's own settings in tests, + macOS CoreFoundation's own) */
const ALLOWED = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TERM|TMPDIR|SHELL|NO_PROXY|no_proxy|HTTPS?_PROXY|https?_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CLAUDE_CONFIG_DIR|CLAUDE_CODE_SHELL_PREFIX|FAKE_CLAUDE_[A-Z_]+|__CF_USER_TEXT_ENCODING)$/;

/** 4B-12 (M1): the network variables a run may need behind a proxy or a corporate CA */
const NETWORK_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const PROXY_PASSWORD_REFUSED = "proxy URLs with a password are not supported — they would be readable by sandboxed code";

let home: string;
let stateFile: string;
let envOut: string;
const saved: Record<string, string | undefined> = {};
const opened: Array<{ close(): void }> = [];

const storeKey = (h: string, apiKey: string | null) =>
  writeCredentials(h, { jira: null, anthropic: apiKey === null ? null : { apiKey, updatedAt: "2026-11-09T10:00:00.000Z" }, otlpHeaders: null });

beforeEach(() => {
  home = tmpDir("api-exec");
  stateFile = join(home, "calls.log");
  envOut = join(home, "env.json");
  for (const k of [...Object.keys(SEEDED), ...NETWORK_ENV, "FAKE_CLAUDE_ECHO_KEY", "FAKE_CLAUDE_SCENARIO", "FAKE_CLAUDE_STATE_FILE", "FAKE_CLAUDE_JSON", "FAKE_CLAUDE_ENV_OUT", "FAKE_CLAUDE_COST"]) saved[k] = process.env[k];
  Object.assign(process.env, SEEDED);
  process.env.FAKE_CLAUDE_STATE_FILE = stateFile;
  process.env.FAKE_CLAUDE_JSON = JSON.stringify({ answer: "42" });
  process.env.FAKE_CLAUDE_ENV_OUT = envOut;
  process.env.FAKE_CLAUDE_SCENARIO = "env-record";
  delete process.env.FAKE_CLAUDE_COST;
  storeKey(home, KEY);
});
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const calls = (): string[][] => (existsSync(stateFile) ? readFileSync(stateFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
const recorded = () => JSON.parse(readFileSync(envOut, "utf8")) as { keys: string[]; auth: Record<string, string>; helperKey: string | null };
const cmd = () => [process.execPath, fake];
const apiExec = (o: { key?: string | null; model?: string; processes?: AgentProcesses; cmd?: string[]; home?: string } = {}) =>
  new ClaudeApiExecutor(o.cmd ?? cmd(), { home: o.home ?? home, apiKey: () => (o.key === undefined ? KEY : o.key), processes: o.processes ?? new AgentProcesses(), model: o.model ?? "" });
const subExec = (o: { model?: string; cmd?: string[] } = {}) => new ClaudeCodeExecutor(o.cmd ?? cmd(), new AgentProcesses(), { model: o.model ?? "" });
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** the API run's --settings: the request's settings (or none) with the platform's apiKeyHelper merged in */
const withHelper = (settingsJson: string | null, h = home): string => JSON.stringify({ ...(settingsJson === null ? {} : (JSON.parse(settingsJson) as object)), apiKeyHelper: shq(apiKeyHelperPath(h)) });
const flagValue = (argv: string[], flag: string): string | undefined => argv[argv.lastIndexOf(flag) + 1];

function baseReq(over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: "do it",
    systemPrompt: "you are a test",
    cwd: home,
    tools: ["Read", "Grep", "Glob"],
    allowedTools: ["Read", "Grep", "Glob"],
    disallowedTools: ["WebFetch", "Bash"],
    chrome: false,
    rawLogPath: join(home, "runs", `${Math.random().toString(16).slice(2)}.jsonl`),
    restricted: false,
    addDirs: [],
    settingsJson: null,
    ...over,
  };
}

const allText = (dir: string): string =>
  existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name), "utf8")).join("\n") : "";

// ---- argv: the same flags under both executors; the API run's --settings adds only the key helper ----

test("argv: the same request gives the same argv under both executors, but for --settings, which the API run merges with {apiKeyHelper} (restricted, add-dirs, settings, shell prefix, extra args, model)", async () => {
  assert.equal(API_KEY_DELIVERY, "helper");
  const prefix = join(home, "prefix", "shell-prefix");
  const hooks = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "/bin/true" }] }] } });
  const cases: Array<[string, Partial<ExecRequest>, string]> = [
    ["plain", {}, ""],
    ["restricted", { restricted: true }, ""],
    ["addDirs", { addDirs: ["/tmp/a", "/tmp/b"] }, ""],
    ["settingsJson", { settingsJson: hooks }, ""],
    ["shellPrefix", { shellPrefix: prefix, tools: ["Read", "Bash"], allowedTools: ["Read", "Bash(pnpm test)"], disallowedTools: ["WebFetch"] }, ""],
    ["extraArgs", { extraArgs: ["--no-session-persistence"] }, ""],
    ["model", {}, "claude-test-model"],
  ];
  for (const [name, over, model] of cases) {
    const req = baseReq(over);
    await subExec({ model }).exec(req, () => {});
    await apiExec({ model }).exec(baseReq({ ...over, rawLogPath: req.rawLogPath }), () => {});
    const [a, b] = calls().slice(-2);
    assert.ok(a && b, name);
    // the subscription argv is exactly buildClaudeArgs's; the API argv is buildClaudeArgs's with the helper merged
    const sub = buildClaudeArgs(req, model);
    const api = buildClaudeArgs({ ...req, settingsJson: withHelper(req.settingsJson) }, model);
    assert.ok("args" in sub && "args" in api);
    assert.deepEqual(a, sub.args, name);
    assert.deepEqual(b, api.args, name);
    assert.equal(JSON.parse(flagValue(b, "--settings")!).apiKeyHelper, shq(apiKeyHelperPath(home)), name);
    if (req.settingsJson !== null) assert.deepEqual(JSON.parse(flagValue(b, "--settings")!).hooks, JSON.parse(req.settingsJson).hooks, name);
  }
  assert.equal(calls().length, cases.length * 2);
});

test("argv: a chrome request builds the same chrome argv for both (one builder); with API_CHROME unavailable (B-4) the API executor refuses it before spawning", async () => {
  const req = baseReq({ chrome: true, tools: [], allowedTools: ["mcp__claude-in-chrome__navigate"], disallowedTools: ["WebFetch"] });
  await subExec().exec(req, () => {});
  const built = buildClaudeArgs(req, "");
  assert.ok("args" in built);
  assert.deepEqual(calls()[0], built.args);
  assert.ok(built.args.includes("--chrome"));
  assert.equal(API_CHROME_UNAVAILABLE, true);
  await assert.rejects(apiExec().exec(req, () => {}), (e: unknown) => e instanceof ExecutorUnavailableError && /JIRA API mode/.test(e.message));
  assert.equal(calls().length, 1, "no API run started");
});

test("argv: both executors refuse the same policy violations before spawning", async () => {
  for (const over of [{ disallowedTools: [] }, { addDirs: ["-x"] }, { settingsJson: "[]" }, { settingsJson: "not json" }, { extraArgs: ["--dangerously-skip-permissions"] }, { shellPrefix: "rel/prefix" }] as Partial<ExecRequest>[]) {
    await assert.rejects(subExec().exec(baseReq(over), () => {}), SandboxPolicyError);
    await assert.rejects(apiExec().exec(baseReq(over), () => {}), SandboxPolicyError);
  }
  await assert.rejects(apiExec({ model: "-bad" }).exec(baseReq(), () => {}), SandboxPolicyError);
  assert.equal(calls().length, 0);
});

// ---- the key helper ----

test("the key helper: written 0700 (dir 0700) outside every sandbox-allowed dir, it prints the stored key; no key → non-zero, nothing printed; the script holds no key", async () => {
  await apiExec().exec(baseReq(), () => {});
  const helper = apiKeyHelperPath(home);
  assert.ok(helper.startsWith(join(home, "api-key-helper") + "/"));
  assert.equal(statSync(helper).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, "api-key-helper")).mode & 0o777, 0o700);
  assert.ok(!readFileSync(helper, "utf8").includes(KEY));
  // the fake CLI ran it, as the real CLI does with --settings apiKeyHelper
  assert.equal(recorded().helperKey, KEY);
  const ok = spawnSync("/bin/sh", ["-c", shq(helper)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, KEY);
  storeKey(home, null);
  const none = spawnSync("/bin/sh", ["-c", shq(helper)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  assert.notEqual(none.status, 0);
  assert.equal(none.stdout, "");
  assert.ok(existsSync(PRINT_API_KEY_SCRIPT));
});

test("the key helper is rewritten on every API run (a changed file is replaced); a symlinked helper dir is refused", async () => {
  await apiExec().exec(baseReq(), () => {});
  const helper = apiKeyHelperPath(home);
  writeFileSync(helper, "#!/bin/sh\necho tampered\n");
  await apiExec().exec(baseReq(), () => {});
  assert.equal(recorded().helperKey, KEY);
  rmSync(join(home, "api-key-helper"), { recursive: true });
  const elsewhere = tmpDir("api-helper-elsewhere");
  execFileSync("/bin/ln", ["-s", elsewhere, join(home, "api-key-helper")]);
  const before = calls().length;
  await assert.rejects(apiExec().exec(baseReq(), () => {}), ExecutorUnavailableError);
  assert.equal(calls().length, before);
});

// ---- environment (4B-11 (2)): allowlisted, built from scratch, in both modes ----

test("env (API): no ANTHROPIC_API_KEY anywhere — the helper delivers it; CLAUDE_CONFIG_DIR = <home>/claude-api-config (0700)", async () => {
  await apiExec().exec(baseReq(), () => {});
  const { auth, keys } = recorded();
  const cfg = join(home, "claude-api-config");
  assert.deepEqual(auth, { CLAUDE_CONFIG_DIR: cfg });
  assert.ok(!keys.some((k) => k.startsWith("ANTHROPIC_")));
  assert.ok(statSync(cfg).isDirectory());
  assert.equal(statSync(cfg).mode & 0o777, 0o700);
  assert.ok(keys.includes("PATH") && keys.includes("HOME"));
});

test("env (both modes): only the allowlist — the seeded GH_TOKEN, AWS_SECRET_ACCESS_KEY, CLAUDE_CODE_FOO, FOO_TOKEN, ANTHROPIC_* and CLAUDE_CODE_* never reach claude", async () => {
  for (const [mode, ex] of [["subscription", subExec()], ["api", apiExec()]] as const) {
    await ex.exec(baseReq(), () => {});
    const { keys } = recorded();
    const extra = keys.filter((k) => !ALLOWED.test(k));
    assert.deepEqual(extra, [], `${mode}: ${extra.join(" ")}`);
    for (const k of ["GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "CLAUDE_CODE_FOO", "FOO_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_TMPDIR", "ANTHROPIC_BASE_URL"]) assert.ok(!keys.includes(k), `${mode}: ${k}`);
    const raw = readFileSync(envOut, "utf8");
    for (const v of Object.values(SEEDED)) if (v !== SEEDED.CLAUDE_CONFIG_DIR) assert.ok(!raw.includes(v), `${mode}: ${v}`);
  }
});

test("4B-12 (M1): proxy (no userinfo), NO_PROXY and the CA variables are passed in both modes", async () => {
  const set: Record<string, string> = {
    HTTP_PROXY: "http://proxy.example.invalid:3128", HTTPS_PROXY: "http://proxy.example.invalid:3129",
    http_proxy: "http://proxy.example.invalid:3130", https_proxy: "http://proxy.example.invalid:3131",
    NO_PROXY: "localhost,127.0.0.1", no_proxy: ".example.invalid",
    NODE_EXTRA_CA_CERTS: "/etc/example/ca.pem", SSL_CERT_FILE: "/etc/example/cert.pem", SSL_CERT_DIR: "/etc/example/certs",
  };
  Object.assign(process.env, set);
  for (const ex of [subExec(), apiExec()]) {
    await ex.exec(baseReq(), () => {});
    const { keys } = recorded();
    for (const k of Object.keys(set)) assert.ok(keys.includes(k), `${ex.kind}: ${k}`);
  }
});

test("4B-12 (M1): a proxy URL with userinfo (any of the four names) refuses the run in both modes — no process, the password nowhere in the message", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    for (const url of ["http://alice:proxy-pass-0000@proxy.example.invalid:3128", "http://alice@proxy.example.invalid:3128"]) {
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete process.env[k];
      process.env[name] = url;
      for (const ex of [subExec(), apiExec()]) {
        await assert.rejects(ex.exec(baseReq(), () => {}), (e: unknown) => {
          assert.ok(e instanceof ExecutorUnavailableError, `${ex.kind} ${name}`);
          assert.equal(e.message, PROXY_PASSWORD_REFUSED);
          assert.ok(!String(e.stack).includes("proxy-pass-0000"));
          return true;
        });
      }
    }
  }
  assert.equal(calls().length, 0);
});

test("env (subscription): the user's own CLAUDE_CONFIG_DIR passes (their login); no inherited prefix; the request's prefix does", async () => {
  await subExec().exec(baseReq(), () => {});
  assert.deepEqual(recorded().auth, { CLAUDE_CONFIG_DIR: "/inherited/config" });
  const prefix = join(home, "p", "shell-prefix");
  await subExec().exec(baseReq({ shellPrefix: prefix, tools: ["Bash"], allowedTools: ["Bash(pnpm test)"], disallowedTools: ["WebFetch"] }), () => {});
  assert.deepEqual(recorded().auth, { CLAUDE_CONFIG_DIR: "/inherited/config", CLAUDE_CODE_SHELL_PREFIX: prefix });
});

test("env (API): the shell prefix is passed as CLAUDE_CODE_SHELL_PREFIX; an existing config dir is tightened to 0700", async () => {
  const cfg = join(home, "claude-api-config");
  mkdirSync(cfg, { mode: 0o755 });
  const prefix = join(home, "p", "shell-prefix");
  await apiExec().exec(baseReq({ shellPrefix: prefix, tools: ["Bash"], allowedTools: ["Bash(pnpm test)"], disallowedTools: ["WebFetch"] }), () => {});
  assert.deepEqual(recorded().auth, { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_SHELL_PREFIX: prefix });
  assert.equal(statSync(cfg).mode & 0o777, 0o700);
});

test("env (isolated acceptance run): exactly ACCEPT_ENV_KEYS + CLAUDE_CONFIG_DIR (the acceptance dir) in both modes, no key; the API run gets the helper", async () => {
  const envFile = join(home, "fake-env.json");
  writeFileSync(envFile, JSON.stringify({ FAKE_CLAUDE_SCENARIO: "env-record", FAKE_CLAUDE_STATE_FILE: stateFile, FAKE_CLAUDE_JSON: process.env.FAKE_CLAUDE_JSON, FAKE_CLAUDE_ENV_OUT: envOut }));
  const acceptCfg = join(home, "accept-config");
  const env = { claudeConfigDir: acceptCfg, keep: ACCEPT_ENV_KEYS.filter((k) => k !== "PATH"), path: ["/usr/bin", "/bin"] };
  const fakeCmd = [process.execPath, fake, "--fake-env", envFile];
  for (const ex of [apiExec({ cmd: fakeCmd }), subExec({ cmd: fakeCmd })]) {
    await ex.exec(baseReq({ env }), () => {});
    const { keys, auth } = recorded();
    // macOS: CoreFoundation in the child Node adds __CF_USER_TEXT_ENCODING itself at startup
    assert.deepEqual(keys.filter((k) => k !== "__CF_USER_TEXT_ENCODING"), [...ACCEPT_ENV_KEYS, "CLAUDE_CONFIG_DIR"].sort(), ex.kind);
    assert.deepEqual(auth, { CLAUDE_CONFIG_DIR: acceptCfg }, ex.kind);
    assert.equal(recorded().helperKey, ex.kind === "claude-api" ? KEY : null, ex.kind);
  }
  assert.equal(existsSync(join(home, "claude-api-config")), false, "an isolated run never uses the API config dir");
});

// ---- key missing, key rejected ----

test("key null → ExecutorUnavailableError (Settings → Executor) and no process is started; the key is read on every exec", async () => {
  let key: string | null = null;
  const ex = new ClaudeApiExecutor(cmd(), { home, apiKey: () => key, processes: new AgentProcesses() });
  await assert.rejects(ex.exec(baseReq(), () => {}), (e: unknown) => e instanceof ExecutorUnavailableError && e.message === "Set your Anthropic API key in Settings → Executor");
  assert.equal(calls().length, 0);
  assert.equal(existsSync(join(home, "claude-api-config")), false);
  key = KEY;
  await ex.exec(baseReq(), () => {});
  assert.equal(recorded().helperKey, KEY);
});

test("an unreadable credentials file → ExecutorUnavailableError with its (path-free) reason; no process", async () => {
  const ex = new ClaudeApiExecutor(cmd(), {
    home,
    apiKey: () => {
      throw new CredentialFileError("credentials.json must be a regular file with mode 600 owned by you");
    },
    processes: new AgentProcesses(),
  });
  await assert.rejects(ex.exec(baseReq(), () => {}), (e: unknown) => e instanceof ExecutorUnavailableError && e.message === "The Anthropic API key cannot be read: credentials.json must be a regular file with mode 600 owned by you");
  assert.equal(calls().length, 0);
});

test("an authentication failure → ExecutorUnavailableError (key rejected), its message without the key", async () => {
  process.env.FAKE_CLAUDE_SCENARIO = "api-auth-fail";
  await assert.rejects(apiExec().exec(baseReq(), () => {}), (e: unknown) => {
    assert.ok(e instanceof ExecutorUnavailableError);
    assert.equal(e.message, "The Anthropic API key was rejected — update it in Settings");
    assert.ok(!String(e.stack).includes(KEY));
    return true;
  });
});

// ---- the key never leaves the claude process (B-5, 4B-2) ----

function runDeps(executor: Executor) {
  const db = openDatabase(join(home, "t.db"));
  opened.push(db);
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  return { deps: { db, repoRoot, executor, home, bus }, db, events };
}
const agentReq = { role: "propose-solutions" as AgentRole, prompt: "do it", cwd: "", allowedTools: ["Read"], chrome: false, schema: z.object({ answer: z.string() }), retries: 0 };
const runRow = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT * FROM agent_run").get() as Record<string, unknown>;

test("agent_run: executor 'claude-api', result.total_cost_usd → cost_usd", async () => {
  process.env.FAKE_CLAUDE_COST = "0.37";
  const { deps, db } = runDeps(apiExec());
  assert.deepEqual(await runAgent(deps, { ...agentReq, cwd: home }), { answer: "42" });
  const r = runRow(db);
  assert.equal(r.executor, "claude-api");
  assert.equal(r.cost_usd, 0.37);
  assert.equal(r.status, "ok");
});

test("a CLI that prints the key (assistant text, stderr, error result) leaks it nowhere: error, agent_run, raw log, events", async () => {
  for (const scenario of ["key-echo-error", "key-echo-noresult", "api-auth-fail"]) {
    process.env.FAKE_CLAUDE_SCENARIO = scenario;
    const { deps, db, events } = runDeps(apiExec());
    let thrown: unknown;
    await assert.rejects(runAgent(deps, { ...agentReq, cwd: home }), (e: unknown) => ((thrown = e), true));
    const err = thrown as Error;
    assert.ok(!err.message.includes(KEY) && !String(err.stack).includes(KEY), `${scenario}: ${err.message}`);
    const r = runRow(db);
    assert.equal(r.status, "error");
    assert.ok(!JSON.stringify(r).includes(KEY), `${scenario}: agent_run ${String(r.error)}`);
    const raw = readFileSync(r.raw_log_path as string, "utf8");
    assert.ok(!raw.includes(KEY), `${scenario}: raw log`);
    assert.ok(!JSON.stringify(events).includes(KEY), `${scenario}: events`);
    if (scenario === "key-echo-error") {
      assert.match(err.message, /\[redacted\]/);
      assert.match(raw, /\[redacted\]/);
      assert.ok(events.some((e) => e.type === "agent_event" && e.event.text === "using [redacted]"));
    }
    if (scenario === "key-echo-noresult") assert.match(err.message, /x-api-key: \[redacted\]/);
    db.prepare("DELETE FROM agent_run").run();
    db.close();
    opened.pop();
  }
  assert.ok(!allText(join(home, "runs")).includes(KEY), "no raw log holds the key");
});

test("a successful run whose output quotes the key: the parsed result and the raw log hold [redacted]", async () => {
  process.env.FAKE_CLAUDE_SCENARIO = "key-echo-ok";
  const { deps, db, events } = runDeps(apiExec());
  assert.deepEqual(await runAgent(deps, { ...agentReq, cwd: home }), { answer: "the key is [redacted]" });
  const r = runRow(db);
  assert.ok(!JSON.stringify(r).includes(KEY));
  const raw = readFileSync(r.raw_log_path as string, "utf8");
  assert.ok(!raw.includes(KEY));
  assert.match(raw, /ANTHROPIC_API_KEY=\[redacted\]/);
  assert.ok(!JSON.stringify(events).includes(KEY));
});

test("4B-12 (m1): the subscription executor redacts every known credential value too — error, raw log, events, result", async () => {
  // KEY is stored (beforeEach): the process remembers it; the fake CLI prints it although claude never received it
  process.env.FAKE_CLAUDE_ECHO_KEY = KEY;
  process.env.FAKE_CLAUDE_SCENARIO = "key-echo-error";
  const events: string[] = [];
  const req = baseReq();
  await assert.rejects(subExec().exec(req, (e) => events.push(e.text)), (e: unknown) => {
    assert.ok(e instanceof Error && !e.message.includes(KEY) && !String(e.stack).includes(KEY), String(e));
    assert.match((e as Error).message, /\[redacted\]/);
    return true;
  });
  assert.ok(events.includes("using [redacted]"), events.join("|"));
  process.env.FAKE_CLAUDE_SCENARIO = "key-echo-ok";
  const req2 = baseReq();
  const res = await subExec().exec(req2, () => {});
  assert.ok(!res.text.includes(KEY) && res.text.includes("[redacted]"));
  for (const r of [req, req2]) assert.ok(!readFileSync(r.rawLogPath, "utf8").includes(KEY));
});

test("4B-12 (m4): no file under src/ calls passFakeClaudeEnvForTests (only its definition names it)", () => {
  const src = resolve(import.meta.dirname, "../src");
  const hits: string[] = [];
  for (const e of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    const text = readFileSync(p, "utf8").replace("export function passFakeClaudeEnvForTests(", "");
    if (text.includes("passFakeClaudeEnvForTests")) hits.push(p);
  }
  assert.deepEqual(hits, []);
  assert.match(readFileSync(join(src, "executor", "claude-code.ts"), "utf8"), /export function passFakeClaudeEnvForTests\(/);
});

test("the API key is never in argv", async () => {
  await apiExec().exec(baseReq({ addDirs: ["/tmp/a"], restricted: true }), () => {});
  assert.ok(!JSON.stringify(calls()).includes(KEY));
});

// ---- main.ts: kind and implementation chosen from the config on every call ----

test("configuredExecutor: kind is read from config.executor.kind on every access; each exec builds the matching executor", async () => {
  const exec = { kind: "claude-code" as "claude-code" | "claude-api", claudeBin: cmd() as string | string[], model: "" };
  const ex = configuredExecutor({ config: () => ({ kind: exec.kind, claudeBin: exec.claudeBin, model: exec.model }), home, apiKey: () => KEY, processes: new AgentProcesses() });
  assert.equal(ex.kind, "claude-code");
  await ex.exec(baseReq(), () => {});
  assert.equal(recorded().helperKey, null);
  exec.kind = "claude-api";
  assert.equal(ex.kind, "claude-api");
  await ex.exec(baseReq(), () => {});
  assert.equal(recorded().helperKey, KEY);
  const { deps, db } = runDeps(ex);
  await runAgent(deps, { ...agentReq, cwd: home });
  assert.equal(runRow(db).executor, "claude-api");
});

test("4B-11 (3): runAgent pins the executor per run — a retry after the setting changed keeps the kind the run started with (and agent_run.executor says so)", async () => {
  process.env.FAKE_CLAUDE_SCENARIO = "bad-json-once";
  const exec = { kind: "claude-code" as "claude-code" | "claude-api" };
  const ex = configuredExecutor({ config: () => ({ kind: exec.kind, claudeBin: cmd(), model: "" }), home, apiKey: () => KEY, processes: new AgentProcesses() });
  const { deps, db, events } = runDeps(ex);
  // the developer switches to the API executor while the first attempt is running
  deps.bus.subscribe(() => (exec.kind = "claude-api"));
  assert.deepEqual(await runAgent(deps, { ...agentReq, cwd: home, retries: 1 }), { answer: "42" });
  assert.ok(events.length > 0);
  const [first, second] = calls();
  assert.ok(first && second);
  const helperIn = (argv: string[]) => "apiKeyHelper" in (JSON.parse(flagValue(argv, "--settings") ?? "{}") as object);
  for (const argv of [first, second]) assert.ok(!helperIn(argv), "both attempts ran the subscription executor (no key helper)");
  assert.equal(runRow(db).executor, "claude-code");
  // the next run takes the new setting
  db.prepare("DELETE FROM agent_run").run();
  process.env.FAKE_CLAUDE_SCENARIO = "ok";
  await runAgent(deps, { ...agentReq, cwd: home });
  assert.equal(runRow(db).executor, "claude-api");
  assert.ok(helperIn(calls().at(-1)!));
});

// ---- real sandbox-exec: the agent's Bash under the development and acceptance wrappers (macOS only) ----

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const skipNoSandbox = HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;

/**
 * A plain (not setuid) program that reads another process's arguments and environment with sysctl(KERN_PROCARGS2), as
 * `ps -E` does; it prints only whether ANTHROPIC_API_KEY= and GH_TOKEN= are in them. Built with the CommandLineTools
 * clang when it is installed (called directly, never through an xcrun shim); null otherwise.
 */
const CLANG = "/Library/Developer/CommandLineTools/usr/bin/clang";
const SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
const PROCARGS_C = String.raw`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
static int has(const char *buf, size_t sz, const char *needle) {
  size_t n = strlen(needle);
  for (size_t i = 0; i + n <= sz; i++) if (memcmp(buf + i, needle, n) == 0) return 1;
  return 0;
}
int main(int argc, char **argv) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, atoi(argv[1])};
  size_t sz = 0;
  if (sysctl(mib, 3, NULL, &sz, NULL, 0) != 0) { perror("sysctl"); return 2; }
  char *buf = malloc(sz);
  if (sysctl(mib, 3, buf, &sz, NULL, 0) != 0) { perror("sysctl"); return 3; }
  printf("procargs bytes=%zu key-visible=%d gh-visible=%d\n", sz, has(buf, sz, "ANTHROPIC_API_KEY="), has(buf, sz, "GH_TOKEN="));
  return 0;
}
`;
function buildProcargsProbe(dir: string): string | null {
  if (!existsSync(CLANG) || !existsSync(SDK)) return null;
  const src = join(home, "procargs.c");
  const bin = join(dir, "procargs-probe");
  writeFileSync(src, PROCARGS_C);
  try {
    execFileSync(CLANG, ["-isysroot", SDK, "-o", bin, src], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    return bin;
  } catch {
    return null;
  }
}

/**
 * The Bash command, run like Claude Code's Bash tool through the wrapper: its environment; `ps -E` of the claude
 * process (the fake CLI), a plain copy of ps, and the procargs probe; then reading and running the key helper and its
 * printer from inside. Output is captured by the fake CLI (outside the sandbox) into a file, never the stream (whose
 * redaction would hide what was seen).
 */
const probeCommand = (procargs: string | null, helperHome: string): string =>
  [
    "/usr/bin/env",
    "echo '---ps---'",
    "/bin/ps -E -ww -o command= -p @CLAUDE_PID@; echo \"ps exit $?\"",
    // /bin/ps is setuid root, which the sandbox refuses to exec: a plain copy in the command's temp dir too
    "/bin/cp /bin/ps \"$TMPDIR/ps-copy\" && \"$TMPDIR/ps-copy\" -E -ww -o command= -p @CLAUDE_PID@; echo \"ps-copy exit $?\"",
    procargs === null ? "echo 'procargs not probed (no CommandLineTools clang)'" : `${shq(procargs)} @CLAUDE_PID@; echo "procargs exit $?"`,
    "echo '---helper---'",
    `/bin/cat ${shq(apiKeyHelperPath(helperHome))}; echo "cat-helper exit $?"`,
    `/bin/sh ${shq(apiKeyHelperPath(helperHome))}; echo "run-helper exit $?"`,
    `${shq(process.execPath)} ${shq(PRINT_API_KEY_SCRIPT)} ${shq(helperHome)}; echo "print-key exit $?"`,
  ].join("; ");

async function bashUnder(o: { shellPrefix: string; cwd: string; procargs: string | null; helperHome: string; env?: ExecRequest["env"] }): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = join(home, "bash-out.json");
  const envFile = join(home, "fake-env-bash.json");
  writeFileSync(envFile, JSON.stringify({ FAKE_CLAUDE_SCENARIO: "bash-capture", FAKE_CLAUDE_STATE_FILE: stateFile, FAKE_CLAUDE_JSON: process.env.FAKE_CLAUDE_JSON, FAKE_CLAUDE_BASH: probeCommand(o.procargs, o.helperHome), FAKE_CLAUDE_BASH_OUT: out }));
  const ex = apiExec({ cmd: [process.execPath, fake, "--fake-env", envFile], home: o.helperHome });
  await ex.exec(baseReq({ cwd: o.cwd, shellPrefix: o.shellPrefix, tools: ["Bash"], allowedTools: ["Bash(env)"], disallowedTools: ["WebFetch"], timeoutMs: 60_000, ...(o.env ? { env: o.env } : {}) }), () => {});
  return JSON.parse(readFileSync(out, "utf8")) as { code: number; stdout: string; stderr: string };
}

/**
 * Records what ps -E and the procargs probe saw of the claude process. Task 6 first found the key there (it was in
 * claude's environment): ruling 4B-11 moved it to the apiKeyHelper and built claude's environment from an allowlist,
 * so neither the key nor a secret of the server's own environment (GH_TOKEN, seeded) may be seen any more. The helper
 * and the key it prints must be out of reach of the sandboxed command too.
 */
function checkProbe(label: string, r: { code: number; stdout: string; stderr: string }): void {
  const [env = "", rest = ""] = r.stdout.split("---ps---");
  const [seen = "", helper = ""] = rest.split("---helper---");
  const mask = (s: string) => s.split(KEY).join("<KEY>").split(SEEDED.GH_TOKEN!).join("<GH_TOKEN>");
  console.log(`[task 6 ps -E / procargs probe, ${label}] ${JSON.stringify(mask(seen).trim())}; helper: ${JSON.stringify(mask(helper).trim())}; stderr: ${JSON.stringify(mask(r.stderr).slice(0, 300))}`);
  assert.match(env, /^PATH=/m, "the command ran and printed its environment");
  assert.doesNotMatch(env, /^ANTHROPIC_/m);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY), `${label}: the key was seen`);
  assert.ok(!r.stdout.includes(SEEDED.GH_TOKEN!), `${label}: the server's GH_TOKEN was seen`);
  assert.doesNotMatch(seen, /key-visible=1|gh-visible=1/);
  if (!seen.includes("procargs not probed")) assert.match(seen, /procargs bytes=\d+ key-visible=0 gh-visible=0/, `${label}: the probe ran`);
  assert.doesNotMatch(helper, /cat-helper exit 0/);
  assert.doesNotMatch(helper, /run-helper exit 0/);
  assert.doesNotMatch(helper, /print-key exit 0/);
}

test("dev wrapper (real sandbox-exec), API mode: no ANTHROPIC_* in the agent's Bash; ps -E / procargs see neither the key nor GH_TOKEN in claude; the helper is unreadable and prints nothing", { skip: skipNoSandbox, timeout: 120_000 }, async () => {
  // a scratch SLACKOFF_HOME outside the temp dirs the dev profile may write (4A-13); the API executor's home too
  const devHome = realpathSync(tmpDir("api-dev", "/private/var/tmp"));
  storeKey(devHome, KEY);
  const ticketDir = join(devHome, "worktrees", "K-1");
  const wt = join(ticketDir, "api");
  mkdirSync(wt, { recursive: true });
  const scope: SandboxScope = { kind: "dev-command", home: devHome, allowInHome: ticketDir, repos: [], writable: [wt] };
  const prefix = writeShellPrefix(join(devHome, "sandbox", "K-1"), scope);
  const r = await bashUnder({ shellPrefix: prefix, cwd: ticketDir, procargs: buildProcargsProbe(wt), helperHome: devHome });
  assert.equal(r.code, 0, r.stderr);
  checkProbe("dev-command sandbox", r);
});

test("acceptance wrapper (real sandbox-exec), API mode: no ANTHROPIC_* in the agent's Bash; ps -E / procargs see neither the key nor GH_TOKEN in claude; the helper is unreadable and prints nothing", { skip: skipNoSandbox, timeout: 120_000 }, async () => {
  const runRoot = realpathSync(tmpDir("api-acc-run"));
  const cfgParent = realpathSync(tmpDir("api-acc-cfg"));
  const workDir = join(runRoot, "work");
  const configDir = join(cfgParent, "claude-config");
  mkdirSync(join(workDir, "acceptance", "specs"), { recursive: true });
  mkdirSync(join(runRoot, "bin"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const scope: SandboxScope = { kind: "acceptance", home, allowInHome: null, repos: [], runRoot, acceptConfigDir: configDir };
  const prefix = writeShellPrefix(join(home, "sandbox", "acceptance", "run"), scope, { shell: "/bin/zsh" });
  const env = { claudeConfigDir: configDir, keep: ACCEPT_ENV_KEYS.filter((k) => k !== "PATH"), path: [join(runRoot, "bin"), "/usr/bin", "/bin"] };
  const r = await bashUnder({ shellPrefix: prefix, cwd: workDir, procargs: buildProcargsProbe(workDir), helperHome: home, env });
  assert.equal(r.code, 0, r.stderr);
  checkProbe("acceptance sandbox", r);
});

// ---- final fix pass (ruling F4B-3): the run must say it authenticated through the key helper ----

import { API_KEY_SOURCE_HELPER } from "../src/executor/claude-api.ts";

const MISMATCH = /not authenticated with your Anthropic API key/;

test("F4B-3: API_KEY_SOURCE_HELPER is 'apiKeyHelper'; the fake reports it for an API run, and the run succeeds", async () => {
  assert.equal(API_KEY_SOURCE_HELPER, "apiKeyHelper");
  const lines: string[] = [];
  const req = baseReq();
  const r = await apiExec().exec(req, () => {});
  lines.push(...readFileSync(req.rawLogPath, "utf8").split("\n").filter(Boolean));
  assert.equal((JSON.parse(lines[0]!) as { apiKeySource?: string }).apiKeySource, "apiKeyHelper");
  assert.ok(r.text.includes("42"));
});

test("F4B-3: a CLI that reports another key source (subscription 'none', 'ANTHROPIC_API_KEY', missing) fails the run with a clear message", async () => {
  for (const src of ["none", "ANTHROPIC_API_KEY", "/login managed key", ""]) {
    process.env.FAKE_CLAUDE_API_KEY_SOURCE = src;
    try {
      await assert.rejects(apiExec().exec(baseReq(), () => {}), (e: unknown) => {
        assert.ok(e instanceof ExecutorUnavailableError, String(e));
        assert.match(e.message, MISMATCH);
        if (src !== "") assert.ok(e.message.includes(JSON.stringify(src)), e.message);
        return true;
      }, src);
    } finally {
      delete process.env.FAKE_CLAUDE_API_KEY_SOURCE;
    }
  }
  // the subscription executor does not check it
  process.env.FAKE_CLAUDE_API_KEY_SOURCE = "none";
  try {
    await subExec().exec(baseReq(), () => {});
  } finally {
    delete process.env.FAKE_CLAUDE_API_KEY_SOURCE;
  }
});

test("F4B-3: the mismatching run is killed at once (its whole process group), not left to work until the timeout", async () => {
  const pidFile = join(home, "pid.json");
  process.env.FAKE_CLAUDE_SCENARIO = "hang-tree";
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  process.env.FAKE_CLAUDE_API_KEY_SOURCE = "none";
  process.env.FAKE_CLAUDE_INIT_DELAY_MS = "500";
  try {
    const t0 = Date.now();
    await assert.rejects(apiExec().exec(baseReq({ timeoutMs: 60_000 }), () => {}), MISMATCH);
    assert.ok(Date.now() - t0 < 20_000, `took ${Date.now() - t0} ms`);
    const { pid, child } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; child: number };
    await new Promise((r) => setTimeout(r, 200));
    for (const p of [pid, child]) assert.throws(() => process.kill(p, 0), /ESRCH/, `pid ${p} still runs`);
  } finally {
    delete process.env.FAKE_CLAUDE_PID_FILE;
    delete process.env.FAKE_CLAUDE_API_KEY_SOURCE;
    delete process.env.FAKE_CLAUDE_INIT_DELAY_MS;
  }
});

test("F4B-3: an isolated acceptance API run (its own CLAUDE_CONFIG_DIR, a subscription login there) that reports 'none' fails too", async () => {
  const envFile = join(home, "fake-env.json");
  writeFileSync(envFile, JSON.stringify({ FAKE_CLAUDE_SCENARIO: "ok", FAKE_CLAUDE_JSON: process.env.FAKE_CLAUDE_JSON, FAKE_CLAUDE_API_KEY_SOURCE: "none" }));
  const env = { claudeConfigDir: join(home, "accept-config"), keep: ACCEPT_ENV_KEYS.filter((k) => k !== "PATH"), path: ["/usr/bin", "/bin"] };
  const fakeCmd = [process.execPath, fake, "--fake-env", envFile];
  await assert.rejects(apiExec({ cmd: fakeCmd }).exec(baseReq({ env }), () => {}), MISMATCH);
  await subExec({ cmd: fakeCmd }).exec(baseReq({ env }), () => {});
});
