import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers/tmp.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { AgentRole } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { ClaudeCodeExecutor, passFakeClaudeEnvForTests } from "../src/executor/claude-code.ts";
// phase 4b (4B-11): claude runs get an allowlisted env; the fake CLI's FAKE_CLAUDE_* settings still pass in tests
passFakeClaudeEnvForTests();
import { InvalidAgentOutputError, ToolDeniedError, runAgent } from "../src/executor/run-agent.ts";
import { AgentInterruptedError, ExecutorUnavailableError } from "../src/executor/types.ts";
import { AgentProcesses, ExecutorTimeoutError } from "../src/executor/claude-code.ts";
import { ACCEPT_GIT_ENV, DENIED_TOOLS, SandboxPolicyError, toolPolicy } from "../src/executor/sandbox.ts";
import { NAV_GUARD_SCRIPT } from "../src/executor/nav-guard.ts";
import { BrowserChoiceRequiredError, NavigationViolationError, type ExecRequest, type Executor } from "../src/executor/types.ts";
import { SPEC_GUARD_SCRIPT } from "../src/acceptance/spec-guard.ts";
import { cleanupRunDirs, prepareRunDirs, writePlaywrightScaffold } from "../src/acceptance/workspace.ts";
import { loadConfig } from "../src/config.ts";
import { runProcess } from "../src/git/run.ts";
import { SANDBOX_EXEC, type SandboxCheck, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { EventBus } from "../src/http/events.ts";
import type { BusEvent } from "../src/http/events.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fake = resolve(import.meta.dirname, "fixtures/fake-claude.ts");
const Schema = z.object({ answer: z.string() });

let home: string;
let stateFile: string;
const opened: Array<{ close(): void }> = [];
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
});
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-test-should-be-stripped";
  home = tmpDir("exec");
  stateFile = join(home, "calls.log");
  process.env.FAKE_CLAUDE_STATE_FILE = stateFile;
  process.env.FAKE_CLAUDE_JSON = JSON.stringify({ answer: "42" });
  delete process.env.FAKE_CLAUDE_DENIED_TOOL;
});

const calls = () => (existsSync(stateFile) ? readFileSync(stateFile, "utf8").split("\n").filter(Boolean) : []);

function setup(scenario: string, claudeBin: string | string[] = [process.execPath, fake]) {
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const db = openDatabase(join(home, "t.db"));
  opened.push(db);
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const deps = { db, repoRoot, executor: new ClaudeCodeExecutor(claudeBin), home, bus };
  const req = {
    role: "propose-solutions" as AgentRole,
    prompt: "do it",
    cwd: home,
    allowedTools: ["Read"],
    chrome: false,
    schema: Schema,
  };
  const run = () => db.prepare("SELECT * FROM agent_run").get() as Record<string, unknown>;
  return { db, deps, req, events, run };
}

test("ok: returns parsed object, records run, log and events", async () => {
  const { deps, req, run, events } = setup("ok");
  assert.deepEqual(await runAgent(deps, req), { answer: "42" });
  const r = run();
  assert.equal(r.status, "ok");
  assert.ok(r.skill_version);
  assert.ok(r.raw_log_path);
  assert.equal(r.permission_denials_json, "[]");
  assert.equal(r.cost_usd, 0.01);
  assert.equal(r.error, null);
  assert.deepEqual(JSON.parse(r.usage_json as string), { input_tokens: 1, output_tokens: 1 });
  assert.ok(readFileSync(r.raw_log_path as string, "utf8").includes('"type":"result"'));
  assert.ok(events.some((e) => e.type === "agent_event" && e.event.kind === "tool" && e.event.text === "Reading a file"));
  assert.ok(events.every((e) => e.type !== "agent_event" || e.runId === r.id));
});

test("argv: -p, stream-json, system prompt, allowedTools, --chrome only when requested", async () => {
  const { deps, req } = setup("ok");
  await runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: ["ToolSearch", "mcp__claude-in-chrome__navigate"] });
  const argv = JSON.parse(calls()[0] as string) as string[];
  assert.equal(argv[0], "-p");
  assert.ok(argv.includes("--verbose"));
  assert.deepEqual(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2), ["--output-format", "stream-json"]);
  assert.ok(argv.includes("--append-system-prompt"));
  assert.ok(argv.includes("--chrome"));
  const i = argv.indexOf("--allowedTools");
  assert.deepEqual(argv.slice(i + 1), ["ToolSearch", "mcp__claude-in-chrome__navigate"]);
  assert.deepEqual(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2), ["--permission-mode", "default"]);
});

test("bad-json-once: second attempt succeeds, executor called twice", async () => {
  const { deps, req, run } = setup("bad-json-once");
  assert.deepEqual(await runAgent(deps, req), { answer: "42" });
  assert.equal(calls().length, 2);
  assert.equal(run().status, "ok");
  const retryPrompt = (JSON.parse(calls()[1] as string) as string[])[1] as string;
  assert.match(retryPrompt, /failed validation/);
});

test("bad-json-always: InvalidAgentOutputError and invalid_output", async () => {
  const { deps, req, run } = setup("bad-json-always");
  await assert.rejects(runAgent(deps, req), InvalidAgentOutputError);
  assert.equal(calls().length, 2);
  assert.equal(run().status, "invalid_output");
});

test("schema-invalid JSON also counts as invalid output", async () => {
  process.env.FAKE_CLAUDE_JSON = JSON.stringify({ wrong: 1 });
  const { deps, req, run } = setup("ok");
  await assert.rejects(runAgent(deps, req), InvalidAgentOutputError);
  assert.equal(run().status, "invalid_output");
});

test("missing claudeBin -> ExecutorUnavailableError, run status error", async () => {
  const { deps, req, run } = setup("ok", "/nonexistent/claude-bin");
  await assert.rejects(runAgent(deps, req), ExecutorUnavailableError);
  assert.equal(run().status, "error");
});

test("not-logged-in -> ExecutorUnavailableError", async () => {
  const { deps, req, run } = setup("not-logged-in");
  await assert.rejects(runAgent(deps, req), ExecutorUnavailableError);
  assert.equal(run().status, "error");
});

test("denied required tool -> ToolDeniedError naming the tool, denials stored", async () => {
  const { deps, req, run } = setup("denied");
  await assert.rejects(runAgent(deps, req), (e: unknown) => e instanceof ToolDeniedError && e.message.includes("Read"));
  const r = run();
  assert.equal(r.status, "error");
  assert.deepEqual(JSON.parse(r.permission_denials_json as string), ["Read"]);
  assert.match(r.error as string, /Read/);
});

test("executor failure on second attempt records error text, not usage", async () => {
  const { deps, req, run } = setup("bad-then-error");
  await assert.rejects(runAgent(deps, req), /boom from cli/);
  const r = run();
  assert.equal(r.status, "error");
  assert.match(r.error as string, /boom from cli/);
  assert.ok(!(r.usage_json as string | null)?.includes("boom"));
});

test("no result event -> error", async () => {
  const { deps, req, run } = setup("no-result");
  await assert.rejects(runAgent(deps, req), /no result event/);
  assert.equal(run().status, "error");
});

test("is_error result with exit 0 -> error with CLI text", async () => {
  const { deps, req, run } = setup("is-error");
  await assert.rejects(runAgent(deps, req), /api exploded/);
  assert.match(run().error as string, /api exploded/);
});

test("hang with small timeout -> ExecutorTimeoutError, status error", async () => {
  const { deps, req, run } = setup("hang");
  await assert.rejects(runAgent(deps, { ...req, timeoutMs: 300 }), ExecutorTimeoutError);
  const r = run();
  assert.equal(r.status, "error");
  assert.match(r.error as string, /timed out/i);
});

test("ANTHROPIC_API_KEY is not passed to the child", async () => {
  const { deps, req } = setup("env-echo");
  assert.deepEqual(await runAgent(deps, req), { answer: "unset" });
});

test("shellPrefix (the dev agent's sandboxed Bash wrapper) is passed as CLAUDE_CODE_SHELL_PREFIX; PATH untouched; invalid values refused", async () => {
  const { deps, req } = setup("prefix-echo");
  const wrapper = join(home, "shims", "K-1", "shell-prefix");
  const out = (await runAgent(deps, { ...req, shellPrefix: wrapper })) as { answer: string };
  assert.equal(out.answer, `${wrapper}|${process.env.PATH}`);
  for (const bad of ["relative/wrapper", "/a b", "/a\nb"]) {
    await assert.rejects(runAgent(deps, { ...req, shellPrefix: bad }), SandboxPolicyError);
  }
});

test("without shellPrefix an inherited CLAUDE_CODE_SHELL_PREFIX is not passed on", async () => {
  process.env.CLAUDE_CODE_SHELL_PREFIX = "/tmp/someone-elses-prefix";
  try {
    const { deps, req } = setup("prefix-echo");
    const out = (await runAgent(deps, req)) as { answer: string };
    assert.equal(out.answer, `unset|${process.env.PATH}`);
  } finally {
    delete process.env.CLAUDE_CODE_SHELL_PREFIX;
  }
});

test("chrome:false has no --chrome; chrome:true adds ToolSearch when missing", async () => {
  const a = setup("ok");
  await runAgent(a.deps, a.req);
  assert.ok(!(JSON.parse(calls()[0] as string) as string[]).includes("--chrome"));
  const b = setup("ok");
  await runAgent(b.deps, { ...b.req, role: "jira-browser", chrome: true, allowedTools: ["mcp__claude-in-chrome__navigate"] });
  const argv = JSON.parse(calls()[1] as string) as string[];
  assert.ok(argv.slice(argv.indexOf("--allowedTools") + 1).includes("ToolSearch"));
});

test("denied tool outside allowedTools is only logged", async () => {
  process.env.FAKE_CLAUDE_DENIED_TOOL = "Bash";
  const { deps, req, run } = setup("denied");
  assert.deepEqual(await runAgent(deps, req), { answer: "42" });
  const r = run();
  assert.equal(r.status, "ok");
  assert.deepEqual(JSON.parse(r.permission_denials_json as string), ["Bash"]);
});

// ---- F-I1 sandbox baseline: argv per role ----

const CHROME = (t: string) => `mcp__claude-in-chrome__${t}`;
const CHROME_WRITE = [
  "computer", "form_input", "javascript_tool", "file_upload", "upload_image", "shortcuts_execute", "browser_batch",
  "gif_creator", "resize_window", "switch_browser", "select_browser",
].map(CHROME);
// not read-only or not needed: never available to the browser agent
const CHROME_NOT_NEEDED = ["list_connected_browsers", "read_console_messages", "read_network_requests"].map(CHROME);
const BUILTIN_WRITE = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];
const JIRA_READ = ["ToolSearch", ...["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "navigate", "get_page_text", "read_page", "find"].map(CHROME)];

/** Values that follow `flag` up to the next `--flag`. */
function flagValues(argv: string[], flag: string): string[] | null {
  const i = argv.indexOf(flag);
  if (i < 0) return null;
  const out: string[] = [];
  for (const v of argv.slice(i + 1)) {
    if (v.startsWith("--")) break;
    out.push(v);
  }
  return out;
}

function assertSandbox(argv: string[], tools: string[], allowed: string[] | null) {
  assert.deepEqual(flagValues(argv, "--permission-mode"), ["default"]);
  assert.deepEqual(flagValues(argv, "--permission-prompts"), ["none"]);
  assert.ok(!argv.some((a) => /bypassPermissions|acceptEdits|dangerously/.test(a)), "never an auto-accepting mode");
  const deny = flagValues(argv, "--disallowedTools") ?? [];
  for (const t of [...BUILTIN_WRITE, ...CHROME_WRITE, ...CHROME_NOT_NEEDED]) assert.ok(deny.includes(t), `deny list has ${t}`);
  assert.deepEqual(flagValues(argv, "--tools"), tools);
  assert.deepEqual(flagValues(argv, "--allowedTools"), allowed);
  for (const t of allowed ?? []) assert.ok(!deny.includes(t) && !BUILTIN_WRITE.includes(t) && !CHROME_WRITE.includes(t), `allowed ${t} is read-only`);
  // H1 isolation from the user's own Claude config: no user/project/local settings (hooks, plugins, allow
  // rules) and no MCP servers besides the dynamic claude-in-chrome one (verified with a real run, see report).
  assert.ok(argv.includes("--strict-mcp-config"), "--strict-mcp-config on every role");
  assert.deepEqual(flagValues(argv, "--setting-sources"), [""], "--setting-sources '' on every role");
  assert.ok(!argv.includes("--mcp-config"), "no extra MCP servers");
}

test("sandbox argv: refine-ticket has no built-in tools, explicit mode, deny list, no allow list", async () => {
  const { deps, req } = setup("ok");
  await runAgent(deps, { ...req, role: "refine-ticket", allowedTools: [] });
  assertSandbox(JSON.parse(calls()[0] as string) as string[], [""], null);
});

test("sandbox argv: propose-solutions gets only Read, Grep, Glob", async () => {
  const { deps, req } = setup("ok");
  await runAgent(deps, { ...req, role: "propose-solutions", allowedTools: ["Read", "Grep", "Glob"] });
  assertSandbox(JSON.parse(calls()[0] as string) as string[], ["Read", "Grep", "Glob"], ["Read", "Grep", "Glob"]);
});

test("sandbox argv: jira-browser gets ToolSearch built-in and the read-only chrome allow list", async () => {
  const { deps, req } = setup("ok");
  await runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ] });
  const argv = JSON.parse(calls()[0] as string) as string[];
  assert.ok(argv.includes("--chrome"));
  assertSandbox(argv, ["ToolSearch"], JIRA_READ);
});

test("sandbox: a tool outside the role policy is refused before the CLI runs", async () => {
  const { deps, req, run } = setup("ok");
  await assert.rejects(runAgent(deps, { ...req, role: "refine-ticket", allowedTools: ["Bash"] }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...req, role: "propose-solutions", allowedTools: ["Read", "Edit"] }), SandboxPolicyError);
  await assert.rejects(
    runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ, CHROME("javascript_tool")] }),
    SandboxPolicyError,
  );
  await assert.rejects(runAgent(deps, { ...req, role: "refine-ticket", chrome: true, allowedTools: [] }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...req, role: "acceptance-review", allowedTools: [] }), SandboxPolicyError);
  assert.equal(calls().length, 0);
  assert.equal(run(), undefined);
});

test("sandbox: the executor itself refuses an allow list that overlaps the deny list", async () => {
  const ex = new ClaudeCodeExecutor([process.execPath, fake]);
  const base = { prompt: "p", systemPrompt: "s", cwd: home, chrome: false, rawLogPath: join(home, "r.jsonl"), restricted: false, addDirs: [], settingsJson: null };
  await assert.rejects(
    ex.exec({ ...base, tools: ["Read"], allowedTools: ["Read", "Bash"], disallowedTools: [...DENIED_TOOLS] }, () => {}),
    SandboxPolicyError,
  );
  // the request's own deny list is used, and an empty one is refused (fail closed)
  await assert.rejects(ex.exec({ ...base, tools: ["Read"], allowedTools: ["Read", "X"], disallowedTools: ["X"] }, () => {}), SandboxPolicyError);
  await assert.rejects(ex.exec({ ...base, tools: ["Read"], allowedTools: ["Read"], disallowedTools: [] }, () => {}), SandboxPolicyError);
  assert.equal(calls().length, 0);
});

// ---- H2 agent process lifecycle ----

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function startHanging(scenario: string) {
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  const pidFile = join(home, "pids.json");
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  const agents = new AgentProcesses();
  const ex = new ClaudeCodeExecutor([process.execPath, fake], agents);
  const p = ex.exec({ prompt: "p", systemPrompt: "s", cwd: home, tools: [], allowedTools: [], chrome: false, rawLogPath: join(home, "r.jsonl"), disallowedTools: [...DENIED_TOOLS], restricted: false, addDirs: [], settingsJson: null }, () => {});
  p.catch(() => {});
  const pids = async () => {
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
    return JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; child?: number };
  };
  return { agents, ex, p, pids };
}

test("H2: stopAll kills the agent's whole process group and the run rejects as interrupted", async () => {
  const { agents, p, pids } = startHanging("hang-tree");
  const { pid, child } = await pids();
  assert.ok(alive(pid) && alive(child!));
  assert.equal(agents.size, 1);
  await agents.stopAll(2000);
  await assert.rejects(p, AgentInterruptedError);
  await waitFor(() => !alive(pid) && !alive(child!));
  assert.equal(agents.size, 0);
});

test("H2: stopAll escalates to SIGKILL when the agent ignores SIGTERM", async () => {
  const { agents, p, pids } = startHanging("hang-ignore-term");
  const { pid } = await pids();
  await new Promise((r) => setTimeout(r, 100)); // let the SIGTERM handler install
  const t0 = Date.now();
  await agents.stopAll(300);
  await assert.rejects(p, AgentInterruptedError);
  assert.ok(Date.now() - t0 >= 250, "waited the grace period first");
  await waitFor(() => !alive(pid));
});

test("H2: after stopAll no new agent is spawned", async () => {
  const agents = new AgentProcesses();
  await agents.stopAll();
  process.env.FAKE_CLAUDE_SCENARIO = "ok";
  const ex = new ClaudeCodeExecutor([process.execPath, fake], agents);
  await assert.rejects(
    ex.exec({ prompt: "p", systemPrompt: "s", cwd: home, tools: [], allowedTools: [], chrome: false, rawLogPath: join(home, "r.jsonl"), disallowedTools: [...DENIED_TOOLS], restricted: false, addDirs: [], settingsJson: null }, () => {}),
    AgentInterruptedError,
  );
  assert.equal(calls().length, 0);
});

test("H2: an interrupted run is left 'running' for startup recovery to close", async () => {
  const { deps, req, run } = setup("hang");
  const agents = new AgentProcesses();
  deps.executor = new ClaudeCodeExecutor([process.execPath, fake], agents);
  const p = runAgent(deps, req);
  p.catch(() => {});
  await waitFor(() => agents.size === 1);
  await agents.stopAll(1000);
  await assert.rejects(p, AgentInterruptedError);
  assert.equal(run().status, "running");
});

// ---- executor.model ----

test("model: --model <value> on every run when set, absent when empty", async () => {
  process.env.FAKE_CLAUDE_SCENARIO = "ok";
  const execReq = { prompt: "p", systemPrompt: "s", cwd: home, tools: [], allowedTools: [], chrome: false, rawLogPath: join(home, "r.jsonl"), disallowedTools: [...DENIED_TOOLS], restricted: false, addDirs: [], settingsJson: null };
  await new ClaudeCodeExecutor([process.execPath, fake], undefined, { model: "claude-opus-5-5" }).exec(execReq, () => {});
  await new ClaudeCodeExecutor([process.execPath, fake], undefined, { model: "" }).exec(execReq, () => {});
  await new ClaudeCodeExecutor([process.execPath, fake]).exec(execReq, () => {});
  const [withModel, empty, none] = calls().map((l) => JSON.parse(l) as string[]);
  assert.deepEqual(flagValues(withModel!, "--model"), ["claude-opus-5-5"]);
  assert.equal(empty!.includes("--model"), false);
  assert.equal(none!.includes("--model"), false);
});

test("model: the executor refuses a value that is not a single safe token", async () => {
  const execReq = { prompt: "p", systemPrompt: "s", cwd: home, tools: [], allowedTools: [], chrome: false, rawLogPath: join(home, "r.jsonl"), disallowedTools: [...DENIED_TOOLS], restricted: false, addDirs: [], settingsJson: null };
  for (const bad of ["--dangerously-skip-permissions", "a b"]) {
    await assert.rejects(new ClaudeCodeExecutor([process.execPath, fake], undefined, { model: bad }).exec(execReq, () => {}), SandboxPolicyError);
  }
  assert.equal(calls().length, 0);
});

test("H2: a run that already finished with a result is delivered even if shutdown starts before its close is handled", async () => {
  process.env.FAKE_CLAUDE_SCENARIO = "ok";
  // stopAll fires the moment the child exits on its own, i.e. before the executor has handled its 'close'
  class StopOnExit extends AgentProcesses {
    override add(child: import("node:child_process").ChildProcess): void {
      super.add(child);
      child.once("exit", () => void this.stopAll(100));
    }
  }
  const agents = new StopOnExit();
  const ex = new ClaudeCodeExecutor([process.execPath, fake], agents);
  const res = await ex.exec({ prompt: "p", systemPrompt: "s", cwd: home, tools: [], allowedTools: [], chrome: false, rawLogPath: join(home, "r.jsonl"), disallowedTools: [...DENIED_TOOLS], restricted: false, addDirs: [], settingsJson: null }, () => {});
  assert.match(res.text, /"answer"/);
  assert.equal(agents.stopping, true);
});

test("runAgent records rules_hash and repo_prompt_hash, independent of repo order", async () => {
  const { deps, req, db } = setup("ok");
  const mk = (name: string, text: string): any => ({
    name, path: `/r/${name}`, baseBranch: "main",
    rules: { rules: { forbiddenPaths: [], commands: {}, jiraStatus: {}, checklist: { add: [], remove: [] }, prompts: { "propose-solutions": { mode: "append", text } } }, rulesMd: "r", hash: `h-${name}`, found: true },
  });
  const a = mk("api", "A"), b = mk("web", "B");
  await runAgent(deps, { ...req, repos: [a, b], addDirs: ["/tmp/x"] });
  await runAgent(deps, { ...req, repos: [b, a] });
  const rows = db.prepare("SELECT rules_hash, repo_prompt_hash FROM agent_run ORDER BY started_at, rowid").all() as Array<Record<string, string | null>>;
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.rules_hash ?? "", /^[0-9a-f]{12}$/);
  assert.match(rows[0]!.repo_prompt_hash ?? "", /^[0-9a-f]{12}$/);
  assert.deepEqual(rows[0], rows[1]);
});

test("--add-dir: absolute path is passed; flag-like, relative and NUL entries are rejected before spawn", async () => {
  const { deps, req } = setup("ok");
  await runAgent(deps, { ...req, addDirs: ["/tmp/x"] });
  assert.deepEqual(flagValues(JSON.parse(calls()[0]!), "--add-dir"), ["/tmp/x"]);
  const before = calls().length;
  for (const bad of ["-x", "--dangerously-skip-permissions", "relative/dir", "/tmp/a\0b"]) {
    await assert.rejects(runAgent(deps, { ...req, addDirs: [bad] }), SandboxPolicyError, bad);
  }
  assert.equal(calls().length, before);
});

// ---- Task 6: role policies in argv (P-C6), multi-directory access, navigation guard, pinned browser ----

const fixture = (n: string) => resolve(import.meta.dirname, "fixtures", n);
const argvOf = (i = 0) => JSON.parse(calls()[i] as string) as string[];
const count = (argv: string[], v: string) => argv.filter((a) => a === v).length;
// the new roles' skills arrive in later tasks: a stub skills root for argv tests
const stubRoot = tmpDir("skills");
for (const role of ["design-solution", "critique-design", "implement-ticket", "jira-update", "acceptance-review", "jira-comment"]) {
  mkdirSync(join(stubRoot, "skills", role), { recursive: true });
  writeFileSync(join(stubRoot, "skills", role, "SKILL.md"), `---\nname: ${role}\ndescription: stub\n---\n\nstub skill\n`);
}
for (const role of ["jira-browser", "refine-ticket", "propose-solutions"]) {
  mkdirSync(join(stubRoot, "skills", role), { recursive: true });
  copyFileSync(join(repoRoot, "skills", role, "SKILL.md"), join(stubRoot, "skills", role, "SKILL.md"));
}
const stubbed = <D extends { repoRoot: string }>(deps: D): D => ({ ...deps, repoRoot: stubRoot });
const devReq = (ctx: Record<string, unknown> = { commands: ["pnpm test"] }) => ({
  role: "implement-ticket" as AgentRole,
  allowedTools: [...toolPolicy("implement-ticket", ctx).allowed],
  policy: ctx,
});

test("implement-ticket argv: restricted, scoped Bash, per-role deny list, no chrome, no add-dir", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await runAgent(deps, { ...req, ...devReq({ commands: ["pnpm test"], denyPaths: ["infra/**"] }), shellPrefix: join(home, "shims", "K-1", "shell-prefix") });
  const argv = argvOf();
  assert.ok(argv.includes("--restricted"));
  assert.deepEqual(flagValues(argv, "--tools"), ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
  const allowed = flagValues(argv, "--allowedTools")!;
  assert.ok(allowed.includes("Bash(pnpm test)"));
  assert.ok(!allowed.includes("Bash(pnpm test *)"));
  const deny = flagValues(argv, "--disallowedTools")!;
  for (const d of ["WebFetch", "WebSearch", CHROME("navigate"), "Bash(git *)", "Edit(/**/.slackoff/**)", "Write(/**/.githooks/**)", "Write(/**/.husky/**)", "Write(/**/infra/**)"]) {
    assert.ok(deny.includes(d), d);
  }
  assert.ok(!argv.includes("--chrome"));
  assert.ok(!argv.includes("--add-dir"));
  // phase 4b (4B-4): the only settings are the file guard's
  assert.deepEqual(preToolUse(argv).map((p) => p.matcher), [FILE_MATCHER]);
  assert.ok(!argv.some((a) => /bypassPermissions|dangerously|--no-verify/.test(a)));
  assert.deepEqual(flagValues(argv, "--permission-mode"), ["default"]);
  assert.ok(argv.includes("--strict-mcp-config"));
});

test("implement-ticket argv: no Bash without commands or with bashMode none", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await runAgent(deps, { ...req, ...devReq({ commands: [] }) });
  await runAgent(deps, { ...req, ...devReq({ commands: ["pnpm test"], bashMode: "none" }) });
  for (const i of [0, 1]) {
    const argv = argvOf(i);
    assert.ok(!flagValues(argv, "--tools")!.includes("Bash"));
    assert.ok(!(flagValues(argv, "--allowedTools") ?? []).some((t) => t.startsWith("Bash")));
  }
});

test("implement-ticket: WebFetch is refused; add-dirs are refused (the ticket dir holds every affected repo)", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await assert.rejects(runAgent(deps, { ...req, ...devReq(), allowedTools: ["Read", "WebFetch"] }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...req, ...devReq(), addDirs: ["/tmp/elsewhere"] }), SandboxPolicyError);
  assert.equal(calls().length, 0);
});

test("design-solution with two repos: cwd = first repo, --add-dir <second repo> exactly once", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await runAgent(deps, { ...req, role: "design-solution", allowedTools: ["Read", "Grep", "Glob"], cwd: home, addDirs: ["/repos/web", "/repos/web", home] });
  const argv = argvOf();
  assert.equal(count(argv, "--add-dir"), 1);
  assert.deepEqual(flagValues(argv, "--add-dir"), ["/repos/web"]);
  assert.ok(argv.includes("--restricted"));
});

const JIRA_ALLOW = ["https://j.example.com/", "https://j.example.com/browse/K-1"];
const jiraUpdate = (browser: { deviceId: string } | null) => {
  const policy = { navAllow: JIRA_ALLOW, browser };
  return { role: "jira-update" as AgentRole, chrome: true, allowedTools: [...toolPolicy("jira-update", policy).allowed], policy };
};

test("jira-update argv: chrome, computer, pinned select_browser and the guard hook; form_input/javascript_tool/file_upload not allowed", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await runAgent(deps, { ...req, ...jiraUpdate({ deviceId: "dev-1" }) });
  const argv = argvOf();
  assert.ok(argv.includes("--chrome"));
  const allowed = flagValues(argv, "--allowedTools")!;
  assert.ok(allowed.includes(CHROME("computer")));
  assert.ok(allowed.includes(CHROME("select_browser")));
  for (const t of ["form_input", "javascript_tool", "file_upload"]) {
    assert.ok(!allowed.includes(CHROME(t)), t);
    assert.ok(flagValues(argv, "--disallowedTools")!.includes(CHROME(t)), t);
  }
  const settings = flagValues(argv, "--settings")!;
  assert.equal(settings.length, 1);
  assert.ok(settings[0]!.includes(NAV_GUARD_SCRIPT));
  assert.ok(!argv.includes("--restricted"));
});

test("jira-update without a navigation allow list is refused", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await assert.rejects(runAgent(deps, { ...req, ...jiraUpdate(null), policy: { browser: null } }), SandboxPolicyError);
  assert.equal(calls().length, 0);
});

const PHASE1_DENIED = [
  "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
  ...["computer", "form_input", "javascript_tool", "file_upload", "upload_image", "shortcuts_execute", "browser_batch", "gif_creator", "resize_window",
    "switch_browser", "select_browser", "list_connected_browsers", "read_console_messages", "read_network_requests"].map(CHROME),
];
function phase1Argv(sys: string, o: { chrome: boolean; tools: string[]; allowed: string[] }): string[] {
  return [
    "-p", "do it", "--output-format", "stream-json", "--verbose", "--append-system-prompt", sys,
    ...(o.chrome ? ["--chrome"] : []),
    "--strict-mcp-config", "--setting-sources", "",
    "--permission-mode", "default", "--permission-prompts", "none",
    "--tools", ...(o.tools.length > 0 ? o.tools : [""]),
    "--disallowedTools", ...PHASE1_DENIED,
    ...(o.allowed.length > 0 ? ["--allowedTools", ...o.allowed] : []),
  ];
}
const sysOf = (argv: string[]) => argv[argv.indexOf("--append-system-prompt") + 1] as string;

test("regression (P-C4): single repo refine-ticket and unpinned jira-browser argv are phase-1 verbatim; propose-solutions only adds --restricted", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await runAgent(deps, { ...req, role: "refine-ticket", allowedTools: [] });
  await runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ], policy: { browser: null } });
  await runAgent(deps, { ...req, role: "propose-solutions", allowedTools: ["Read", "Grep", "Glob"] });
  const [refine, browser, propose] = [argvOf(0), argvOf(1), argvOf(2)];
  assert.deepEqual(refine, phase1Argv(sysOf(refine), { chrome: false, tools: [], allowed: [] }));
  assert.deepEqual(browser, phase1Argv(sysOf(browser), { chrome: true, tools: ["ToolSearch"], allowed: JIRA_READ }));
  assert.equal(count(propose, "--restricted"), 1);
  // phase 4b (4B-4): and the file guard's --settings
  assert.deepEqual(preToolUse(propose).map((p) => p.matcher), [FILE_MATCHER]);
  const s = propose.indexOf("--settings");
  assert.deepEqual(propose.filter((a, i) => a !== "--restricted" && i !== s && i !== s + 1), phase1Argv(sysOf(propose), { chrome: false, tools: ["Read", "Grep", "Glob"], allowed: ["Read", "Grep", "Glob"] }));
});

test("jira-browser with a pinned browser: select_browser allowed and not denied, guard hook checks the device", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  const policy = { browser: { deviceId: "dev-1" } };
  await runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ, CHROME("select_browser")], policy });
  const argv = argvOf();
  assert.ok(flagValues(argv, "--allowedTools")!.includes(CHROME("select_browser")));
  assert.ok(!flagValues(argv, "--disallowedTools")!.includes(CHROME("select_browser")));
  assert.equal(flagValues(argv, "--settings")!.length, 1);
});

async function withReplay<T>(file: string, fn: () => Promise<T>): Promise<T> {
  process.env.FAKE_CLAUDE_REPLAY = file;
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_CLAUDE_REPLAY;
  }
}

test("unpinned browser + several browsers connected -> BrowserChoiceRequiredError, no zod retry", async () => {
  await withReplay(fixture("nav-multi-browser.jsonl"), async () => {
    const { deps: d0, req, run } = setup("replay");
    const deps = stubbed(d0);
    const err = await runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ] }).catch((e: unknown) => e);
    assert.ok(err instanceof BrowserChoiceRequiredError, String(err));
    assert.equal((err as Error).message, "Choose the Chrome browser for JIRA in Settings");
    assert.equal(calls().length, 1, "no retry");
    assert.equal(run().status, "error");
  });
});

test("jira-update: a click-only escape found in tool results -> NavigationViolationError, no retry", async () => {
  await withReplay(fixture("nav-click-escape.jsonl"), async () => {
    const { deps: d0, req } = setup("replay");
    const deps = stubbed(d0);
    const err = await runAgent(deps, { ...req, ...jiraUpdate(null), schema: z.object({ status: z.string() }) }).catch((e: unknown) => e);
    assert.ok(err instanceof NavigationViolationError, String(err));
    assert.ok((err as NavigationViolationError).detail.includes("https://evil.example/phish"));
    assert.equal(calls().length, 1);
  });
});

test("pinned browser: select_browser to another device in the log -> NavigationViolationError", async () => {
  const log = join(home, "other-device.jsonl");
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "s", name: CHROME("select_browser"), input: { deviceId: "dev-2" } }] } },
    { type: "result", subtype: "success", is_error: false, result: '```json\n{"answer":"42"}\n```', permission_denials: [] },
  ];
  writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await withReplay(log, async () => {
    const { deps: d0, req } = setup("replay");
    const deps = stubbed(d0);
    const policy = { browser: { deviceId: "dev-1" } };
    await assert.rejects(
      runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ, CHROME("select_browser")], policy }),
      NavigationViolationError,
    );
  });
});

test("the post-run checks also run when the CLI itself fails (several browsers, error exit)", async () => {
  const log = join(home, "multi-fail.jsonl");
  const lines = readFileSync(fixture("nav-multi-browser.jsonl"), "utf8").trim().split("\n").slice(0, -1);
  lines.push(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "gave up", permission_denials: [] }));
  writeFileSync(log, lines.join("\n") + "\n");
  await withReplay(log, async () => {
    const { deps: d0, req } = setup("replay");
    const deps = stubbed(d0);
    await assert.rejects(runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ] }), BrowserChoiceRequiredError);
  });
});

// ---- Fix round 1: navigation guard self-check before every guarded run (T6-1) ----

test("guard self-check: a working guard lets the run proceed; a broken script or interpreter refuses it before spawn", async () => {
  const { deps: d0, req, run } = setup("ok");
  const deps = stubbed(d0);
  const pinned = { browser: { deviceId: "dev-1" } };
  await runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ, CHROME("select_browser")], policy: pinned });
  assert.equal(calls().length, 1);
  const outside = tmpDir("guard"); // not the agent's cwd
  const open = join(outside, "open.mjs");
  writeFileSync(open, "process.exit(0);\n");
  for (const navGuardPaths of [{ script: join(outside, "missing.mjs") }, { node: "/nonexistent/node" }, { script: open }]) {
    await assert.rejects(
      runAgent({ ...deps, navGuardPaths }, { ...req, ...jiraUpdate({ deviceId: "dev-1" }) }),
      (e: unknown) => e instanceof SandboxPolicyError && /Navigation guard self-check failed/.test(e.message),
      JSON.stringify(navGuardPaths),
    );
  }
  // a guard script inside the agent's own directory is refused as well
  await assert.rejects(runAgent({ ...deps, navGuardPaths: { script: join(home, "g.mjs") } }, { ...req, ...jiraUpdate(null) }), /must not be inside an agent directory/);
  assert.equal(calls().length, 1, "the CLI was never spawned for a refused run");
  assert.equal(run().status, "ok");
});

test("jira-update: the guard hook also covers computer (click-only); jira-browser's hook does not", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await runAgent(deps, { ...req, ...jiraUpdate(null) });
  await runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ, CHROME("select_browser")], policy: { browser: { deviceId: "dev-1" } } });
  const matcher = (i: number) =>
    (JSON.parse(flagValues(argvOf(i), "--settings")![0]!) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }).hooks.PreToolUse[0]!;
  assert.ok(matcher(0).matcher.split("|").includes(CHROME("computer")));
  assert.match(matcher(0).hooks[0]!.command, /SLACKOFF_COMPUTER=/);
  assert.ok(!matcher(1).matcher.split("|").includes(CHROME("computer")));
  assert.doesNotMatch(matcher(1).hooks[0]!.command, /SLACKOFF_COMPUTER=/);
});

test("jira-update: a computer action other than a click in the log -> NavigationViolationError, no retry", async () => {
  const log = join(home, "typed.jsonl");
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "c", name: CHROME("computer"), input: { action: "type", text: "hi" } }] } },
    { type: "result", subtype: "success", is_error: false, result: '```json\n{"answer":"42"}\n```', permission_denials: [] },
  ];
  writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await withReplay(log, async () => {
    const { deps: d0, req } = setup("replay");
    const deps = stubbed(d0);
    const err = await runAgent(deps, { ...req, ...jiraUpdate(null) }).catch((e: unknown) => e);
    assert.ok(err instanceof NavigationViolationError, String(err));
    assert.match((err as Error).message, /computer action "type"/);
    assert.equal(calls().length, 1);
  });
});

test("T12-1: jira-update (a write role) is never re-run on invalid output: one exec, InvalidAgentOutputError", async () => {
  await withReplay(fixture("jira-update-bad-output.jsonl"), async () => {
    const { deps: d0, req, run } = setup("replay");
    const deps = stubbed(d0);
    const err = await runAgent(deps, { ...req, ...jiraUpdate(null) }).catch((e: unknown) => e);
    assert.ok(err instanceof InvalidAgentOutputError, String(err));
    assert.equal(calls().length, 1, "no retry for a write role");
    assert.equal(run().status, "invalid_output");
  });
});

test("T12-1: retries is per request (default 1); retries: 0 makes a read role single-shot too", async () => {
  const { deps, req } = setup("bad-json-always");
  await assert.rejects(runAgent(deps, req), InvalidAgentOutputError);
  assert.equal(calls().length, 2);
  await assert.rejects(runAgent(deps, { ...req, retries: 0 }), InvalidAgentOutputError);
  assert.equal(calls().length, 3);
  // a write role cannot ask for retries
  await assert.rejects(runAgent(stubbed(deps), { ...req, ...jiraUpdate(null), retries: 1 }), SandboxPolicyError);
});

// ---- Task 7: acceptance-review (isolated config and env, sandboxed Bash, spec guard) and jira-comment (typing guard) ----

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A run root (outside `home`) with work/acceptance/specs and bin/, a config dir outside it, and its acceptance scope. */
function acceptanceRun(o: { home?: string } = {}) {
  const runRoot = realpathSync(tmpDir("t7run"));
  const cfgParent = realpathSync(tmpDir("t7cfg"));
  scratch.push(runRoot, cfgParent);
  const workDir = join(runRoot, "work");
  const shimDir = join(runRoot, "bin");
  const configDir = join(cfgParent, "claude-config");
  mkdirSync(join(workDir, "acceptance", "specs"), { recursive: true });
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const scope: SandboxScope = { kind: "acceptance", home: o.home ?? home, allowInHome: null, repos: [], runRoot, acceptConfigDir: configDir };
  return { runRoot, workDir, shimDir, configDir, scope };
}

/** An executor whose fake claude reads its FAKE_CLAUDE_* settings from a file (the isolated env carries none). */
function isolatedExecutor(scenario: string, agents?: AgentProcesses, extra: Record<string, string> = {}) {
  const envFile = join(home, "fake-env.json");
  writeFileSync(envFile, JSON.stringify({ FAKE_CLAUDE_SCENARIO: scenario, FAKE_CLAUDE_STATE_FILE: stateFile, FAKE_CLAUDE_JSON: process.env.FAKE_CLAUDE_JSON, ...extra }));
  return new ClaudeCodeExecutor([process.execPath, fake, "--fake-env", envFile], agents);
}

function acceptanceReq(a: ReturnType<typeof acceptanceRun>, policy: Record<string, unknown> = {}) {
  const ctx = { workDir: a.workDir, denyPaths: ["shop/**"], ...policy };
  return {
    role: "acceptance-review" as AgentRole,
    cwd: a.workDir,
    chrome: false,
    allowedTools: [...toolPolicy("acceptance-review", ctx).allowed],
    policy: ctx,
    isolation: { claudeConfigDir: a.configDir, shimDir: a.shimDir, sandbox: a.scope },
  };
}

const okCheck = (seen: SandboxScope[] = []) => async (s: SandboxScope): Promise<SandboxCheck> => {
  seen.push(s);
  return { ok: true, detail: "fake ok" };
};

const SECRET_ENV = { SLACKOFF_HOME: "/x/slackoff", SLACKOFF_FAKE_EXECUTOR: "1", ANTHROPIC_API_KEY: "sk-secret", GH_TOKEN: "gh-secret" };
async function withSecretEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(SECRET_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SECRET_ENV);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("acceptance-review argv: restricted, --no-session-persistence, Bash(playwright test) only, deny list, spec guard hook, no chrome / add-dir", async () => {
  const { deps: d0, req } = setup("ok");
  const a = acceptanceRun();
  const seen: SandboxScope[] = [];
  const deps = { ...stubbed(d0), executor: isolatedExecutor("ok"), sandboxCheck: okCheck(seen), mappedRepos: () => [] };
  assert.deepEqual(await runAgent(deps, { ...req, ...acceptanceReq(a) }), { answer: "42" });
  const argv = argvOf();
  assert.equal(argv[0], "-p");
  assert.ok(argv.includes("--restricted"));
  assert.equal(count(argv, "--no-session-persistence"), 1);
  assert.deepEqual(flagValues(argv, "--tools"), ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
  const allowed = flagValues(argv, "--allowedTools")!;
  assert.ok(allowed.includes("Bash(playwright test)"));
  assert.ok(!allowed.some((t) => /^Bash\(.* \*\)$/.test(t)), allowed.join(" "));
  const deny = flagValues(argv, "--disallowedTools")!;
  for (const d of ["WebFetch", "WebSearch", CHROME("navigate"), CHROME("computer"), "Bash(git *)", "Bash(npx *)", "Bash(node *)", "Write(/**/playwright.config.mjs)", "Edit(/**/node_modules/**)", "Write(/**/shop/**)"]) {
    assert.ok(deny.includes(d), d);
  }
  assert.ok(!argv.includes("--chrome"));
  assert.ok(!argv.includes("--add-dir"));
  assert.ok(!argv.some((a) => /bypassPermissions|dangerously|sandbox-exec/.test(a)));
  const settings = JSON.parse(flagValues(argv, "--settings")![0]!) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; args?: string[] }> }> } };
  assert.equal(settings.hooks.PreToolUse[0]!.matcher, "Bash");
  // T7-3: exec form (command + args), never through the shell prefix
  assert.equal(settings.hooks.PreToolUse[0]!.hooks[0]!.command, process.execPath);
  assert.ok(settings.hooks.PreToolUse[0]!.hooks[0]!.args!.includes(SPEC_GUARD_SCRIPT));
  // T7-1: the server-side self-check ran for exactly this run's acceptance scope, once
  assert.deepEqual(seen, [a.scope]);
});

test("acceptance-review env: exactly PATH HOME USER CLAUDE_CONFIG_DIR (+ the sandbox wrapper as CLAUDE_CODE_SHELL_PREFIX); PATH starts with the shim dir; claude itself unwrapped", async () => {
  await withSecretEnv(async () => {
    const { deps: d0, req } = setup("ok");
    const a = acceptanceRun();
    let execReq: ExecRequest | null = null;
    const real = isolatedExecutor("env-keys");
    let wrapperText = "";
    const executor: Executor = { kind: "claude-code", exec: (r, on) => ((execReq = r), (wrapperText = readFileSync(r.shellPrefix!, "utf8")), real.exec(r, on)) };
    const out = (await runAgent({ ...stubbed(d0), executor, sandboxCheck: okCheck(), mappedRepos: () => [] }, { ...req, ...acceptanceReq(a) })) as { answer: string };
    const seen = JSON.parse(out.answer) as { keys: string[]; path: string; prefix: string; configDir: string; prefixExists: boolean };
    // macOS: CoreFoundation in the child Node itself adds __CF_USER_TEXT_ENCODING at startup (not passed by spawn:
    // /usr/bin/env started with the same env shows none)
    // T7-7: + git's safe.bareRepository=explicit through GIT_CONFIG_COUNT / KEY_0 / VALUE_0 (8 keys)
    assert.deepEqual(seen.keys.filter((k) => k !== "__CF_USER_TEXT_ENCODING"), [
      "CLAUDE_CODE_SHELL_PREFIX", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "HOME", "PATH", "USER",
    ]);
    const path = seen.path.split(":");
    assert.equal(path[0], a.shimDir);
    assert.deepEqual(path, [a.shimDir, dirname(process.execPath), "/usr/bin", "/bin"]);
    assert.ok(!seen.path.includes("node_modules/.bin"));
    assert.equal(seen.configDir, a.configDir);
    // the acceptance wrapper (outside the run root and the work dir), present during the run and removed after it
    assert.match(seen.prefix, /\/shell-prefix$/);
    assert.ok(seen.prefix.startsWith(join(home, "sandbox")), seen.prefix);
    assert.equal(seen.prefixExists, true);
    assert.equal(existsSync(seen.prefix), false);
    // the spawned file is the claude command itself, not sandbox-exec (T1-1: the keychain login needs it unwrapped)
    const r = execReq as ExecRequest | null;
    assert.ok(r !== null);
    assert.equal(r.shellPrefix, seen.prefix);
    assert.deepEqual(r.extraArgs, ["--no-session-persistence"]);
    assert.deepEqual(r.env, {
      claudeConfigDir: a.configDir,
      keep: ["HOME", "USER"],
      path: [a.shimDir, dirname(process.execPath), "/usr/bin", "/bin"],
      set: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.bareRepository", GIT_CONFIG_VALUE_0: "explicit" },
    });
    assert.deepEqual(r.env!.set, ACCEPT_GIT_ENV);
    assert.equal(argvOf()[0], "-p");
    // T7-6: the acceptance wrapper runs every command with /bin/zsh (claude gets no SHELL and picks zsh)
    assert.match(wrapperText, /'\/bin\/zsh' -c "\$1"/);
  });
});

test("acceptance-review: a failing sandbox self-check refuses the run before claude is spawned", async () => {
  const { deps: d0, req } = setup("ok");
  const a = acceptanceRun();
  const deps = { ...stubbed(d0), executor: isolatedExecutor("ok"), sandboxCheck: async () => ({ ok: false, detail: "4317:CONNECTED" }), mappedRepos: () => [] };
  await assert.rejects(runAgent(deps, { ...req, ...acceptanceReq(a) }), (e: unknown) => e instanceof SandboxPolicyError && /isolation check failed: sandbox self-check/.test(e.message) && /4317:CONNECTED/.test(e.message));
  assert.equal(calls().length, 0);
  assert.equal(existsSync(join(home, "sandbox")), false, "no wrapper left behind");
});

test("acceptance-review needs its isolation; no other role may have one; cwd, add-dirs, shim dir, shellPrefix and scope are checked", async () => {
  const { deps: d0, req } = setup("ok");
  const a = acceptanceRun();
  const deps = { ...stubbed(d0), executor: isolatedExecutor("ok"), sandboxCheck: okCheck(), mappedRepos: () => [] };
  const base = { ...req, ...acceptanceReq(a) };
  const { isolation: _drop, ...noIsolation } = base;
  await assert.rejects(runAgent(deps, noIsolation), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...req, ...devReq(), isolation: base.isolation }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...base, cwd: a.runRoot }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...base, addDirs: ["/tmp/elsewhere"] }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...base, shellPrefix: "/bin/sh" }), SandboxPolicyError);
  const inWork = join(a.workDir, "bin");
  await assert.rejects(runAgent(deps, { ...base, isolation: { ...base.isolation, shimDir: inWork } }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...base, isolation: { ...base.isolation, claudeConfigDir: join(home, "other-config") } }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...base, isolation: { ...base.isolation, sandbox: { ...a.scope, kind: "acceptance-install" } } }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...base, policy: { ...base.policy, workDir: undefined } }), SandboxPolicyError);
  assert.equal(calls().length, 0);
});

test("signal: aborting kills the agent's process group; the run ends with AgentInterruptedError; a pre-aborted signal spawns nothing", async () => {
  const { deps, req, run } = setup("hang-tree");
  const pidFile = join(home, "pids.json");
  process.env.FAKE_CLAUDE_PID_FILE = pidFile;
  const ac = new AbortController();
  const p = runAgent(deps, { ...req, signal: ac.signal });
  p.catch(() => {});
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
  const { pid, child } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; child: number };
  assert.ok(alive(pid) && alive(child));
  ac.abort();
  await assert.rejects(p, AgentInterruptedError);
  await waitFor(() => !alive(pid) && !alive(child), 8000);
  assert.equal(run().status, "error");
  const before = calls().length;
  const again = new AbortController();
  again.abort();
  await assert.rejects(runAgent(deps, { ...req, signal: again.signal }), AgentInterruptedError);
  assert.equal(calls().length, before);
});

const COMMENT = "Acceptance result for K-1: 2 of 2 criteria passed.\n- AC-1: pass\n- AC-2: pass\nEvidence is in Slack Off.";
/** agent_run.ticket_key references the ticket */
const withTicket = <S extends { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }>(s: S): S => {
  s.db.prepare("INSERT OR IGNORE INTO ticket (key, title, state, created_at, updated_at) VALUES ('K-1', 't', 'new', 'x', 'x')").run();
  return s;
};
const jiraComment = (o: { navAllow?: string[] | undefined; typeText?: string | undefined; browser?: { deviceId: string } | null } = {}) => {
  const policy = { navAllow: ["https://j.example.com/browse/K-1"], typeText: COMMENT, browser: null, ...o };
  return { role: "jira-comment" as AgentRole, ticketKey: "K-1", chrome: true, allowedTools: [...toolPolicy("jira-comment", policy).allowed], policy };
};

test("jira-comment argv: chrome, computer, the guard hook with the comment text; a write role (no retries)", async () => {
  const { deps: d0, req } = withTicket(setup("replay"));
  const deps = stubbed(d0);
  await withReplay(fixture("jira-comment-ok.jsonl"), () => runAgent(deps, { ...req, ...jiraComment({ browser: { deviceId: "dev-1" } }) }));
  const argv = argvOf();
  assert.ok(argv.includes("--chrome"));
  assert.ok(flagValues(argv, "--allowedTools")!.includes(CHROME("computer")));
  assert.ok(!argv.includes("--no-session-persistence"));
  const hook = (JSON.parse(flagValues(argv, "--settings")![0]!) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }).hooks.PreToolUse[0]!;
  assert.ok(hook.matcher.split("|").includes(CHROME("computer")));
  assert.match(hook.hooks[0]!.command, /SLACKOFF_TYPE_TEXT=/);
  await assert.rejects(runAgent(deps, { ...req, ...jiraComment(), retries: 1 }), SandboxPolicyError);
});

test("jira-comment: navAllow must be exactly this ticket's page; the comment text is required and at most 2000 characters", async () => {
  const { deps: d0, req } = withTicket(setup("replay"));
  const deps = stubbed(d0);
  for (const navAllow of [undefined, [], ["https://j.example.com/"], ["https://j.example.com/browse/K-2"], ["https://j.example.com/browse/K-1", "https://j.example.com/"], ["https://j.example.com/browse/K-1?x=1"], ["file:///browse/K-1"]]) {
    await assert.rejects(runAgent(deps, { ...req, ...jiraComment({ navAllow }) }), SandboxPolicyError, JSON.stringify(navAllow));
  }
  for (const typeText of [undefined, "", "x".repeat(2001)]) {
    await assert.rejects(runAgent(deps, { ...req, ...jiraComment({ typeText }) }), SandboxPolicyError, String(typeText?.length));
  }
  await assert.rejects(runAgent(deps, { ...req, ...jiraComment(), ticketKey: undefined }), SandboxPolicyError);
  assert.equal(calls().length, 0);
  // a context path before /browse is fine (its own page in the log then differs, so only the policy check is shown here)
  const ctxPath = await withReplay(fixture("jira-comment-ok.jsonl"), () =>
    runAgent(deps, { ...req, ...jiraComment({ navAllow: ["https://j.example.com/jira/browse/K-1"] }) }).catch((e: unknown) => e),
  );
  assert.ok(ctxPath instanceof NavigationViolationError, String(ctxPath));
  assert.equal(calls().length, 1);
});

test("jira-comment fixtures: one exact type passes; typing it twice or pressing a key -> NavigationViolationError, no retry", async () => {
  await withReplay(fixture("jira-comment-ok.jsonl"), async () => {
    const { deps: d0, req } = withTicket(setup("replay"));
    assert.deepEqual(await runAgent(stubbed(d0), { ...req, ...jiraComment() }), { answer: "42" });
  });
  for (const [f, why] of [["jira-comment-retyped.jsonl", /typed 2 times|exactly once/], ["jira-comment-keypress.jsonl", /computer action "key"/]] as const) {
    await withReplay(fixture(f), async () => {
      const { deps: d0, req, run } = withTicket(setup("replay"));
      const before = calls().length;
      const err = await runAgent(stubbed(d0), { ...req, ...jiraComment() }).catch((e: unknown) => e);
      assert.ok(err instanceof NavigationViolationError, `${f}: ${String(err)}`);
      assert.match((err as Error).message, why, f);
      assert.equal(calls().length, before + 1, "no retry");
      void run;
      const rows = withTicket(setup("replay")).db.prepare("SELECT status FROM agent_run ORDER BY rowid").all() as Array<{ status: string }>;
      assert.equal(rows.at(-1)?.status, "error");
    });
  }
});

// ---- T7-1: the real Bash command through the acceptance wrapper (macOS sandbox-exec) ----

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const skipNoSandbox = HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

test("T7-1: runAgent runs the real self-check, then each Bash command string runs inside the acceptance sandbox: the fixture spec passes, the DB is EPERM, cat and writes outside the run root are EPERM", { skip: skipNoSandbox, timeout: 240_000 }, async () => {
  writeFileSync(join(home, "slackoff.db"), "DB-SECRET\n");
  const cfgHome = realpathSync(tmpDir("t7cfghome"));
  const ccParent = realpathSync(tmpDir("t7cc"));
  const outside = realpathSync(tmpDir("t7out"));
  scratch.push(cfgHome, ccParent, outside);
  writeFileSync(join(cfgHome, "config.json"), JSON.stringify({ acceptance: { claudeConfigDir: join(ccParent, "claude-config") } }));
  const d = await prepareRunDirs({ home, repoPaths: [], config: loadConfig(cfgHome) });
  const port = await freePort();
  const app = spawn(process.execPath, [join(import.meta.dirname, "fixtures/acceptance-app/server.mjs")], {
    env: { PATH: dirname(process.execPath), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  try {
    await new Promise<void>((res, rej) => {
      app.stdout!.on("data", (b: Buffer) => b.toString().includes("listening") && res());
      app.once("exit", (c) => rej(new Error(`fixture app exited ${c}`)));
    });
    // T7-2: a stand-in for /tmp/claude- (the real cwd-file names are never written by tests)
    const cwdBase = join(realpathSync(tmpDir("t7cwd")), "claude-");
    scratch.push(dirname(cwdBase));
    const cwdFile = `${cwdBase}0a1b-cwd`;
    const scope: SandboxScope = { kind: "acceptance", home, allowInHome: null, repos: [], runRoot: d.runRoot, acceptConfigDir: d.configDir, claudeTmp: cwdBase };
    writePlaywrightScaffold(d, repoRoot, [{ repo: "shop", entry: "web", baseUrl: `http://127.0.0.1:${port}`, started: true, detail: "" }], scope);
    writeFileSync(
      join(d.acceptanceDir, "specs/probe.spec.mjs"),
      `import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
test('reads the db', async () => { readFileSync(${JSON.stringify(join(home, "slackoff.db"))}); });
test('shop page', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading')).toHaveText('Shop');
  await expect(page.getByRole('button', { name: 'Buy' })).toBeVisible();
});
`,
    );
    // Claude Code's shell snapshot lives in the (read-denied) config dir: sourcing it fails, the command still runs
    mkdirSync(join(d.configDir, "shell-snapshots"), { recursive: true });
    const snapshot = join(d.configDir, "shell-snapshots", "snapshot-zsh-1.sh");
    writeFileSync(snapshot, "export SNAPSHOT_LOADED=yes\n");
    // the CLI's exact shape, cwd-file suffix included (Claude Code 2.1.319)
    const shape = (cmd: string) => `source ${snapshot} 2>/dev/null || true && eval '${cmd}' < /dev/null && pwd -P >| ${cwdFile}`;
    const outsideFile = join(outside, "written.txt");
    const results: Record<string, { code: number | null; stdout: string; stderr: string }> = {};
    // an executor that does what Claude Code does with a Bash call: `$CLAUDE_CODE_SHELL_PREFIX '<command string>'`,
    // with the environment the CLI got
    const executor: Executor = {
      kind: "claude-code",
      async exec(r) {
        const env = { PATH: r.env!.path.join(":"), HOME: process.env.HOME, USER: process.env.USER, CLAUDE_CONFIG_DIR: r.env!.claudeConfigDir, CLAUDE_CODE_SHELL_PREFIX: r.shellPrefix };
        const cmds: Record<string, string> = {
          playwright: shape(`cd ${d.workDir}/acceptance && playwright test`),
          snapshot: shape('echo "snap=${SNAPSHOT_LOADED:-no}"'),
          cat: shape(`cat ${join(home, "slackoff.db")}`),
          writeOutside: shape(`echo x > ${outsideFile}`),
          writeInside: shape(`echo ok > ${d.acceptanceDir}/evidence/w.txt && cat ${d.acceptanceDir}/evidence/w.txt`),
        };
        for (const [k, c] of Object.entries(cmds)) {
          const p = await runProcess(r.shellPrefix!, [c], { cwd: r.cwd, env, timeoutMs: 180_000 });
          results[k] = { code: p.code, stdout: p.stdout, stderr: p.stderr };
        }
        return { text: '```json\n{"answer":"42"}\n```', usage: null, costUsd: 0, permissionDenials: [] };
      },
    };
    const { deps: d0, req } = setup("ok");
    const policy = { workDir: d.workDir };
    await runAgent(
      { ...stubbed(d0), executor, mappedRepos: () => [] },
      {
        ...req,
        role: "acceptance-review",
        cwd: d.workDir,
        allowedTools: [...toolPolicy("acceptance-review", policy).allowed],
        policy,
        isolation: { claudeConfigDir: d.configDir, shimDir: d.shimDir, sandbox: scope },
      },
    );
    const res = JSON.parse(readFileSync(join(d.acceptanceDir, "results.json"), "utf8")) as {
      suites: Array<{ specs: Array<{ title: string; tests: Array<{ results: Array<{ status: string; error?: { message?: string } }> }> }> }>;
    };
    const specs = new Map(res.suites.flatMap((s) => s.specs).map((s) => [s.title, s.tests[0]!.results[0]!] as const));
    assert.equal(specs.get("shop page")?.status, "passed", JSON.stringify(results.playwright));
    assert.equal(specs.get("reads the db")?.status, "failed");
    assert.match(specs.get("reads the db")?.error?.message ?? "", /EPERM/);
    assert.notEqual(results.playwright!.code, 0, "one spec failed");
    assert.match(results.snapshot!.stdout, /snap=no/, `the snapshot in the read-denied config dir is not loaded: ${JSON.stringify(results)}`);
    assert.equal(results.snapshot!.code, 0, `the cwd-file suffix succeeds: ${JSON.stringify(results.snapshot)}`);
    assert.equal(readFileSync(cwdFile, "utf8").trim(), d.workDir);
    assert.notEqual(results.cat!.code, 0);
    assert.doesNotMatch(results.cat!.stdout, /DB-SECRET/);
    assert.match(results.cat!.stderr, /Operation not permitted/);
    assert.notEqual(results.writeOutside!.code, 0);
    assert.match(results.writeOutside!.stderr, /operation not permitted/i);
    assert.equal(existsSync(outsideFile), false);
    assert.equal(results.writeInside!.code, 0, JSON.stringify(results.writeInside));
    assert.match(results.writeInside!.stdout, /^ok$/m);
    assert.deepEqual(readdirSync(join(home, "sandbox", "acceptance")), [], "the wrapper is removed after the run");
  } finally {
    try {
      process.kill(-app.pid!, "SIGKILL");
    } catch {
      // gone
    }
    await cleanupRunDirs(d);
    rmSync(d.configDir, { recursive: true, force: true });
  }
});

// ---- Task 7 fix round 1 ----

test("T7-5: the acceptance scope must deny this server's SLACKOFF_HOME and every mapped repository (realpath); no mapping → refused", async () => {
  const { deps: d0, req } = setup("ok");
  const a = acceptanceRun();
  const base = { ...req, ...acceptanceReq(a) };
  const deps = { ...stubbed(d0), executor: isolatedExecutor("ok"), sandboxCheck: okCheck() };
  const other = realpathSync(tmpDir("t7other"));
  scratch.push(other);
  const mappedRepo = join(other, "repo");
  mkdirSync(mappedRepo);
  // no mapping source at all
  await assert.rejects(runAgent(deps, base), (e: unknown) => e instanceof SandboxPolicyError && /repository mapping/.test(e.message));
  // a wrong home
  await assert.rejects(
    runAgent({ ...deps, mappedRepos: () => [] }, { ...base, isolation: { ...base.isolation, sandbox: { ...a.scope, home: other } } }),
    (e: unknown) => e instanceof SandboxPolicyError && /SLACKOFF_HOME/.test(e.message),
  );
  // a mapped repo the scope does not deny
  await assert.rejects(
    runAgent({ ...deps, mappedRepos: () => [mappedRepo] }, base),
    (e: unknown) => e instanceof SandboxPolicyError && e.message.includes(mappedRepo),
  );
  assert.equal(calls().length, 0);
  // the same paths through a symlink still match (realpath)
  const link = join(other, "link");
  symlinkSync(mappedRepo, link);
  const ok = { ...base, isolation: { ...base.isolation, sandbox: { ...a.scope, repos: [mappedRepo] } } };
  assert.deepEqual(await runAgent({ ...deps, mappedRepos: () => [link] }, ok), { answer: "42" });
});

test("dev runs: an inherited CLAUDE_CODE_TMPDIR is not passed on (the cwd file stays in /tmp, where the sandbox allows it)", async () => {
  process.env.CLAUDE_CODE_TMPDIR = "/somewhere/else";
  try {
    const { deps, req } = setup("env-keys");
    const out = (await runAgent(deps, req)) as { answer: string };
    assert.ok(!(JSON.parse(out.answer) as { keys: string[] }).keys.includes("CLAUDE_CODE_TMPDIR"));
  } finally {
    delete process.env.CLAUDE_CODE_TMPDIR;
  }
});

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

const lstartOf = (pid: number): string => {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } }).trim();
  } catch {
    return "";
  }
};

/** A detached Bash command (its own process group, as Claude Code's Bash tool starts it) through the real acceptance wrapper. */
async function detachedRun(o: { bash: (workDir: string) => string; abort: boolean; beforeEnd?: (a: ReturnType<typeof acceptanceRun>, pgid: number) => void }) {
  const { deps: d0, req } = setup("ok");
  const a = acceptanceRun();
  const started = join(a.workDir, "started");
  const pidFile = join(home, "detached.json");
  const executor = isolatedExecutor("detached", undefined, {
    FAKE_CLAUDE_BASH: o.bash(a.workDir),
    FAKE_CLAUDE_STARTED: started,
    FAKE_CLAUDE_PID_FILE: pidFile,
    FAKE_CLAUDE_HANG: o.abort ? "1" : "0",
  });
  const deps = { ...stubbed(d0), executor, sandboxCheck: okCheck(), mappedRepos: () => [] };
  const ac = new AbortController();
  const p = runAgent(deps, { ...req, ...acceptanceReq(a), signal: ac.signal });
  p.catch(() => {});
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 30_000);
  const pgid = (JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number }).pid;
  // (a normal end may already have stopped it: the fake claude finishes as soon as the command started)
  if (o.abort) assert.ok(groupAlive(pgid), "the detached command is running");
  o.beforeEnd?.(a, pgid);
  if (o.abort) {
    ac.abort();
    await assert.rejects(p, AgentInterruptedError);
  } else {
    assert.deepEqual(await p, { answer: "42" });
  }
  return { a, pgid };
}

for (const mode of ["normal end", "abort"] as const) {
  test(`T7-6: a Bash command Claude Code ran in its own process group is killed after the run (${mode})`, { skip: skipNoSandbox, timeout: 60_000 }, async () => {
    let pgid = 0;
    try {
      ({ pgid } = await detachedRun({ abort: mode === "abort", bash: (w) => `cd ${w} && echo started > ${w}/started && exec node -e "setInterval(() => {}, 1000)"` }));
      await waitFor(() => !groupAlive(pgid), 10_000);
    } finally {
      if (pgid > 0 && groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
    }
  });
}

test("T7-8: a group of platform binaries only (sleep; no run root visible to ps) is killed after an abort, by its recorded pid + start time", { skip: skipNoSandbox, timeout: 60_000 }, async () => {
  let pgid = 0;
  try {
    // relative paths only: neither the command line nor (platform binaries) the environment shows the run root
    ({ pgid } = await detachedRun({ abort: true, bash: () => "echo started > started; exec /bin/sleep 600" }));
    await waitFor(() => !groupAlive(pgid), 10_000);
  } finally {
    if (pgid > 0 && groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

test("T7-8: a recorded pgid whose live leader has another start time (a reused pid) is left alone", { skip: skipNoSandbox, timeout: 60_000 }, async () => {
  let pgid = 0;
  try {
    ({ pgid } = await detachedRun({
      abort: true,
      // phase 4f 4F-2: killLeftovers also kills what holds anything under the run root (lsof +D); a reused pid holds nothing there.
      // It also kills what carries the run's TMPDIR / SLACKOFF_RUN_ROOT (`ps -E`, which shows environments only where SIP is
      // off, as on GitHub's macOS runners); a reused pid belongs to an unrelated process, so it carries neither: env -i.
      bash: () => "echo started > started; cd / && exec /usr/bin/env -i /bin/sleep 600",
      beforeEnd: (a, g) => {
        const rec = join(home, "sandbox", "acceptance", basename(a.runRoot), "pgids");
        const lines = readFileSync(rec, "utf8").trim().split("\n");
        assert.deepEqual(lines, [`${g}\t${lstartOf(g)}`]);
        writeFileSync(rec, `${g}\tMon Jan  1 00:00:00 2001\n`);
      },
    }));
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(groupAlive(pgid), "not ours by its start time: left alone");
  } finally {
    if (pgid > 0 && groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

test("T7-7: with the acceptance agent's git config (safe.bareRepository=explicit), git outside the sandbox does not take a bare layout in the work dir as a repository", async () => {
  const d = realpathSync(tmpDir("t7bare"));
  scratch.push(d);
  const fakeHome = join(d, "home");
  mkdirSync(fakeHome);
  const bare = join(d, "work", "bare-layout");
  mkdirSync(join(d, "work"));
  const base = { PATH: "/usr/bin:/bin", HOME: fakeHome, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  execFileSync("git", ["init", "-q", "--bare", bare], { env: base, stdio: "ignore" });
  const git = (env: NodeJS.ProcessEnv) => spawnSync("git", ["-C", bare, "rev-parse", "--is-inside-work-tree"], { env, encoding: "utf8" });
  const control = git(base);
  assert.equal(control.status, 0, "control: without the setting git uses the bare layout");
  const guarded = git({ ...base, ...ACCEPT_GIT_ENV });
  assert.notEqual(guarded.status, 0);
  assert.match(guarded.stderr, /bare repository/i);
});

// ---------------------------------------------------------------- phase 4a Task 6: no unsandboxed Bash by accident

test("Task 6: implement-ticket with a Bash rule but no shellPrefix and no unsandboxedReason -> SandboxPolicyError, nothing run; a reason (the switch) or the wrapper -> runs; no Bash rule -> runs", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  const before = calls().length;
  await assert.rejects(
    runAgent(deps, { ...req, ...devReq({ commands: ["pnpm test"] }) }),
    (e: unknown) => e instanceof SandboxPolicyError && e.message === "implement-ticket: Bash is allowed but its commands are not sandboxed",
  );
  await assert.rejects(runAgent(deps, { ...req, ...devReq({ commands: ["pnpm test"] }), unsandboxedReason: "  " }), SandboxPolicyError, "a blank reason is no reason");
  assert.equal(calls().length, before, "the agent never ran");
  await runAgent(deps, { ...req, ...devReq({ commands: ["pnpm test"] }), unsandboxedReason: "sandbox-exec is not available on linux" });
  await runAgent(deps, { ...req, ...devReq({ commands: ["pnpm test"] }), shellPrefix: join(home, "shims", "K-1", "shell-prefix") });
  await runAgent(deps, { ...req, ...devReq({ commands: [] }) });
  assert.equal(calls().length, before + 3);
});

// ---- phase 4b Task 2: agent_run.error passes through redactSecrets (fake values only) ----

import { writeCredentials as writeCreds } from "../src/credentials/credential-store.ts";

test("4b T2: a run error that echoes a stored credential is written to agent_run.error redacted", async () => {
  const { deps, req, run } = setup("ok");
  const apiKey = `test-key-${Date.now().toString(16)}`;
  writeCreds(home, { jira: null, anthropic: { apiKey, updatedAt: "2026-11-09T10:00:00.000Z" }, otlpHeaders: null });
  const executor: Executor = { kind: "claude-code", exec: async () => { throw new Error(`401 invalid x-api-key: ${apiKey}`); } };
  await assert.rejects(runAgent({ ...deps, executor }, req));
  const r = run();
  assert.equal(r.status, "error");
  assert.ok(!(r.error as string).includes(apiKey), r.error as string);
  assert.match(r.error as string, /401 invalid x-api-key: \[redacted\]/);
});

// ---- phase 4b fix round 1 (ruling 4B-4): the file-tool guard on every role with file tools ----

import { FILE_GUARD_SCRIPT } from "../src/executor/file-guard.ts";

type Pre = { matcher: string; hooks: Array<{ command: string; args?: string[] }> };
const preToolUse = (argv: string[]): Pre[] => {
  const s = flagValues(argv, "--settings");
  return s === null ? [] : (JSON.parse(s[0]!) as { hooks: { PreToolUse: Pre[] } }).hooks.PreToolUse;
};
const FILE_MATCHER = "Read|Edit|Write|MultiEdit|Grep|Glob|NotebookEdit";
const fileGuardRoots = (argv: string[]): string[] | null => {
  const e = preToolUse(argv).find((p) => p.matcher === FILE_MATCHER);
  if (!e) return null;
  const arg = e.hooks[0]!.args!.find((a) => a.startsWith("--slackoff-files="))!;
  assert.equal(e.hooks[0]!.command, process.execPath);
  assert.ok(e.hooks[0]!.args!.includes(FILE_GUARD_SCRIPT));
  return (JSON.parse(Buffer.from(arg.slice("--slackoff-files=".length), "base64url").toString("utf8")) as { roots: string[] }).roots;
};

test("4B-4: implement-ticket and the read-only roles run with the file guard on their cwd (+ add-dirs); roles without file tools without it", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  const web = realpathSync(tmpDir("fg-web"));
  await runAgent(deps, { ...req, ...devReq({ commands: ["pnpm test"] }), shellPrefix: join(home, "shims", "K-1", "shell-prefix") });
  await runAgent(deps, { ...req, role: "propose-solutions", allowedTools: ["Read", "Grep", "Glob"], addDirs: [web] });
  await runAgent(deps, { ...req, role: "refine-ticket", allowedTools: [] });
  await runAgent(deps, { ...req, role: "jira-browser", chrome: true, allowedTools: [...JIRA_READ], policy: { browser: null } });
  assert.deepEqual(fileGuardRoots(argvOf(0)), [realpathSync(home)]);
  assert.equal(count(argvOf(0), "--settings"), 1);
  assert.deepEqual(fileGuardRoots(argvOf(1)), [realpathSync(home), web]);
  assert.ok(!argvOf(2).includes("--settings"));
  assert.ok(!argvOf(3).includes("--settings"));
});

test("4B-4: a chrome role keeps its navigation guard first; acceptance keeps its spec guard first and adds the file guard on the work dir", async () => {
  const { deps: d0, req } = setup("ok");
  const a = acceptanceRun();
  const deps = { ...stubbed(d0), executor: isolatedExecutor("ok"), sandboxCheck: okCheck(), mappedRepos: () => [] };
  await runAgent(deps, { ...req, ...acceptanceReq(a) });
  const pre = preToolUse(argvOf());
  assert.equal(pre[0]!.matcher, "Bash");
  assert.deepEqual(fileGuardRoots(argvOf()), [a.workDir]);
});

test("4B-4: a file guard that fails its self-check stops the run before claude starts", async () => {
  const { deps: d0, req } = setup("ok");
  const open = join(tmpDir("fg-open"), "open-guard.mjs");
  writeFileSync(open, "process.exit(0);\n");
  const deps = { ...stubbed(d0), fileGuardPaths: { script: open } };
  await assert.rejects(runAgent(deps, { ...req, role: "propose-solutions", allowedTools: ["Read", "Grep", "Glob"] }), /File guard self-check failed/);
  assert.equal(calls().length, 0);
});

// ---- phase 4b fix round 2 (ruling 4B-7): the dev agent's commands' process groups are recorded and killed after the run ----

import { writeShellPrefix as devShellPrefix } from "../src/sandbox/local-sandbox.ts";

test("4B-7: a detached child of a dev agent command (left in its process group) is killed after the run", { skip: skipNoSandbox, timeout: 60_000 }, async () => {
  const { deps: d0, req } = setup("ok");
  // a scratch SLACKOFF_HOME outside the temp dirs the dev profile may write (4A-13)
  const devHome = realpathSync(tmpDir("dev-pgid", "/private/var/tmp"));
  const ticketDir = join(devHome, "worktrees", "K-1");
  const wt = join(ticketDir, "api");
  mkdirSync(wt, { recursive: true });
  const scope: SandboxScope = { kind: "dev-command", home: devHome, allowInHome: ticketDir, repos: [], writable: [wt] };
  const prefixDir = join(devHome, "sandbox", "K-1");
  const pgidFile = join(prefixDir, "pgids");
  const shellPrefix = devShellPrefix(prefixDir, scope, { pgidFile });
  const started = join(wt, "started");
  const pidFile = join(home, "detached-dev.json");
  const executor = isolatedExecutor("detached", undefined, {
    FAKE_CLAUDE_BASH: `cd ${wt} && /bin/sleep 600 & echo started > ${started}`,
    FAKE_CLAUDE_STARTED: started,
    FAKE_CLAUDE_PID_FILE: pidFile,
    FAKE_CLAUDE_HANG: "0",
  });
  let pgid = 0;
  try {
    const p = runAgent({ ...stubbed(d0), executor }, { ...req, ...devReq({ commands: ["pnpm test"] }), cwd: ticketDir, shellPrefix, pgidFile });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 30_000);
    pgid = (JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number }).pid;
    assert.deepEqual(await p, { answer: "42" });
    await waitFor(() => !groupAlive(pgid), 10_000);
    assert.equal(existsSync(pgidFile), false, "the record is removed once its groups are stopped");
  } finally {
    if (pgid > 0 && groupAlive(pgid)) process.kill(-pgid, "SIGKILL");
  }
});

test("4B-7: a pgid file without a shell prefix, or for another role, is refused", async () => {
  const { deps: d0, req } = setup("ok");
  const deps = stubbed(d0);
  await assert.rejects(runAgent(deps, { ...req, ...devReq({ commands: [] }), pgidFile: join(home, "pgids") }), SandboxPolicyError);
  await assert.rejects(runAgent(deps, { ...req, role: "propose-solutions", allowedTools: ["Read"], pgidFile: join(home, "pgids") }), SandboxPolicyError);
  assert.equal(calls().length, 0);
});

test("a run with Grep or Glob is told the file guard's glob rule (no braces); a run without them is not", async () => {
  const sysOf = (argv: string[]) => argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
  const a = setup("ok");
  await runAgent(a.deps, { ...a.req, role: "propose-solutions", allowedTools: ["Read", "Grep", "Glob"] });
  const withSearch = sysOf(JSON.parse(calls().at(-1) as string) as string[]);
  assert.match(withSearch, /stay inside the searched directory/);
  assert.match(withSearch, /never `\.\.`, an absolute path/);
  const b = setup("ok");
  await runAgent(b.deps, { ...b.req, role: "refine-ticket", allowedTools: [] });
  assert.doesNotMatch(sysOf(JSON.parse(calls().at(-1) as string) as string[]), /stay inside the searched directory/);
});
