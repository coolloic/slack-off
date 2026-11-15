#!/usr/bin/env node
// Fake `claude` CLI for tests. Scenario via FAKE_CLAUDE_SCENARIO:
//   ok | bad-json-once | bad-json-always | not-logged-in | denied | bad-then-error | no-result | is-error | env-echo | prefix-echo | hang
//   | env-record | key-echo-ok | key-echo-error | key-echo-noresult | api-auth-fail | bash-capture (phase 4b task 6)
//   | replay (FAKE_CLAUDE_REPLAY: stream-json fixture to print) | hang-tree (spawns a grandchild, then hangs) | hang-ignore-term (ignores SIGTERM, then hangs)
// FAKE_CLAUDE_PID_FILE: hang-tree / hang-ignore-term write {"pid", "child"?} there once running.
// FAKE_CLAUDE_JSON: JSON echoed by `ok` (and by the 2nd call of bad-json-once; `denied` too).
// FAKE_CLAUDE_STATE_FILE: if set, one line (the argv as JSON) is appended per invocation.
// `--fake-env <file>` as the first two arguments (Task 7: an isolated run passes no FAKE_CLAUDE_* variables): the
// FAKE_CLAUDE_* settings come from that JSON file instead, and the two arguments are not recorded.
// env-keys: answers {keys, path, prefix, configDir} of the environment it was started with.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";

const startEnv = { ...process.env };
let argv = process.argv.slice(2);
if (argv[0] === "--fake-env") {
  Object.assign(process.env, JSON.parse(readFileSync(argv[1]!, "utf8")) as Record<string, string>);
  argv = argv.slice(2);
}
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "ok";
const stateFile = process.env.FAKE_CLAUDE_STATE_FILE;
const goodJson = process.env.FAKE_CLAUDE_JSON ?? "{}";
const calls = stateFile && existsSync(stateFile) ? readFileSync(stateFile, "utf8").split("\n").filter(Boolean).length : 0;
if (stateFile) appendFileSync(stateFile, JSON.stringify(argv) + "\n");

/** phase 4b 4B-11: like the CLI, the key comes from the environment or else from --settings apiKeyHelper (run by /bin/sh) */
function helperKey(): string | null {
  const i = argv.lastIndexOf("--settings");
  if (i < 0) return null;
  const helper = (JSON.parse(argv[i + 1]!) as { apiKeyHelper?: unknown }).apiKeyHelper;
  if (typeof helper !== "string") return null;
  const r = spawnSync("/bin/sh", ["-c", helper], { env: startEnv, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}
// FAKE_CLAUDE_ECHO_KEY (tests): a value to print where a key would be, for a run that has none (subscription)
const apiKey = (): string => startEnv.ANTHROPIC_API_KEY ?? helperKey() ?? process.env.FAKE_CLAUDE_ECHO_KEY ?? "unset";
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const fence = (s: string) => "```json\n" + s + "\n```";

/**
 * F4B-3: like the CLI, the init event says where the key came from: ANTHROPIC_API_KEY in the environment, else an
 * apiKeyHelper in --settings, else "none" (a subscription login). FAKE_CLAUDE_API_KEY_SOURCE overrides it ("" = absent).
 */
function apiKeySource(): Record<string, string> {
  const forced = process.env.FAKE_CLAUDE_API_KEY_SOURCE;
  if (forced !== undefined) return forced === "" ? {} : { apiKeySource: forced };
  if (startEnv.ANTHROPIC_API_KEY !== undefined) return { apiKeySource: "ANTHROPIC_API_KEY" };
  const i = argv.lastIndexOf("--settings");
  const helper = i < 0 ? undefined : (JSON.parse(argv[i + 1]!) as { apiKeyHelper?: unknown }).apiKeyHelper;
  return { apiKeySource: typeof helper === "string" ? "apiKeyHelper" : "none" };
}
const init = { type: "system", subtype: "init", session_id: "fake", ...apiKeySource() };
// FAKE_CLAUDE_INIT_DELAY_MS (hanging scenarios only): print init that much later, once the scenario has started
if (process.env.FAKE_CLAUDE_INIT_DELAY_MS !== undefined) setTimeout(() => out(init), Number(process.env.FAKE_CLAUDE_INIT_DELAY_MS));
else out(init);

function finish(text: string, extra: Record<string, unknown> = {}, code = 0): never {
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    permission_denials: [],
    total_cost_usd: 0.01,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  });
  process.exit(code);
}

switch (scenario) {
  case "ok":
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } });
    finish(fence(goodJson));
  case "bad-json-once":
    finish(calls === 0 ? "not json at all" : fence(goodJson));
  case "bad-json-always":
    finish("still not json");
  case "denied":
    finish(fence(goodJson), {
      permission_denials: [{ tool_name: process.env.FAKE_CLAUDE_DENIED_TOOL ?? "Read", tool_use_id: "t1", tool_input: {} }],
    });
  case "bad-then-error":
    if (calls === 0) finish("not json");
    out({ type: "result", subtype: "success", is_error: true, result: "boom from cli", permission_denials: [] });
    process.exit(1);
  case "usage-limit":
    // phase 4c: the CLI reports an exhausted subscription as an error result
    out({ type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached. Your limit will reset at 3pm.\nSecond line.", permission_denials: [], total_cost_usd: 0 });
    process.exit(1);
  case "max-turns":
    // F4C-1 (I-1): an error result is still billed: it carries total_cost_usd and usage
    out({ type: "result", subtype: "error_max_turns", is_error: true, permission_denials: [], total_cost_usd: 3.5, usage: { input_tokens: 1200, output_tokens: 340 } });
    process.exit(1);
  case "no-result":
    process.exit(0);
  case "is-error":
    out({ type: "result", subtype: "success", is_error: true, result: process.env.FAKE_CLAUDE_ERROR_TEXT ?? "api exploded", permission_denials: [] });
    process.exit(0);
  case "env-echo":
    finish(fence(JSON.stringify({ answer: process.env.ANTHROPIC_API_KEY ?? "unset" })));
  case "prefix-echo":
    finish(fence(JSON.stringify({ answer: `${process.env.CLAUDE_CODE_SHELL_PREFIX ?? "unset"}|${process.env.PATH ?? ""}` })));
  case "env-keys":
    finish(
      fence(
        JSON.stringify({
          answer: JSON.stringify({
            keys: Object.keys(startEnv).sort(),
            path: startEnv.PATH ?? "",
            prefix: startEnv.CLAUDE_CODE_SHELL_PREFIX ?? "unset",
            configDir: startEnv.CLAUDE_CONFIG_DIR ?? "unset",
            prefixExists: existsSync(startEnv.CLAUDE_CODE_SHELL_PREFIX ?? "/nonexistent"),
          }),
        }),
      ),
    );
  case "detached": {
    // Task 7 fix round 1: like Claude Code's Bash tool, run FAKE_CLAUDE_BASH through the shell prefix in a process
    // group of its own; wait until it wrote FAKE_CLAUDE_STARTED, record {pid} in FAKE_CLAUDE_PID_FILE, then finish
    // (or hang with FAKE_CLAUDE_HANG=1)
    const child = spawn(startEnv.CLAUDE_CODE_SHELL_PREFIX!, [process.env.FAKE_CLAUDE_BASH!], { detached: true, stdio: "ignore", env: startEnv });
    child.unref();
    const started = process.env.FAKE_CLAUDE_STARTED!;
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (!existsSync(started) && Date.now() - t0 < 30_000) return;
      clearInterval(poll);
      writeFileSync(process.env.FAKE_CLAUDE_PID_FILE!, JSON.stringify({ pid: child.pid }));
      if (process.env.FAKE_CLAUDE_HANG === "1") setInterval(() => {}, 1000);
      else finish(fence(goodJson));
    }, 50);
    break;
  }
  case "env-record": {
    // phase 4b task 6: FAKE_CLAUDE_ENV_OUT gets {keys, auth, helperKey (what --settings apiKeyHelper printed, or null)} — every variable name it was started with, and the values
    // of ANTHROPIC_* / CLAUDE_CONFIG_DIR / CLAUDE_CODE_* — then a normal result (FAKE_CLAUDE_COST: its total_cost_usd)
    const auth = Object.fromEntries(Object.entries(startEnv).filter(([k]) => /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$)/.test(k)));
    writeFileSync(process.env.FAKE_CLAUDE_ENV_OUT!, JSON.stringify({ keys: Object.keys(startEnv).sort(), auth, helperKey: helperKey() }));
    finish(fence(goodJson), process.env.FAKE_CLAUDE_COST !== undefined ? { total_cost_usd: Number(process.env.FAKE_CLAUDE_COST) } : {});
  }
  case "key-echo-ok": {
    // the API key printed in an assistant text, a tool result, and the final answer
    const key = apiKey();
    out({ type: "user", message: { content: [{ type: "tool_result", content: `env says ANTHROPIC_API_KEY=${key}` }] } });
    finish(fence(JSON.stringify({ answer: `the key is ${key}` })));
  }
  case "key-echo-error": {
    // the API key in an assistant text, stderr and the error result (a 401 body echoed back), exit 1
    const key = apiKey();
    out({ type: "assistant", message: { content: [{ type: "text", text: `using ${key}` }] } });
    process.stderr.write(`request failed with x-api-key ${key}\n`);
    out({ type: "result", subtype: "success", is_error: true, result: `API Error: 500 {"echo":"${key}"}`, permission_denials: [] });
    process.exit(1);
  }
  case "key-echo-noresult": {
    const key = apiKey();
    process.stderr.write(`fatal: bad header x-api-key: ${key}\n`);
    process.exit(3);
  }
  case "api-auth-fail": {
    const key = apiKey();
    out({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: `Invalid API key · ${key}` }] } });
    out({ type: "result", subtype: "success", is_error: true, result: `Invalid API key · Fix external API key (${key})`, permission_denials: [], total_cost_usd: 0 });
    process.exit(1);
  }
  case "bash-capture": {
    // phase 4b task 6: like Claude Code's Bash tool, FAKE_CLAUDE_BASH (with @CLAUDE_PID@ = this process's pid) through
    // the shell prefix in its own process group; {code, stdout, stderr} go to FAKE_CLAUDE_BASH_OUT (never to stdout)
    const cmd = process.env.FAKE_CLAUDE_BASH!.split("@CLAUDE_PID@").join(String(process.pid));
    const child = spawn(startEnv.CLAUDE_CODE_SHELL_PREFIX!, [cmd], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: startEnv });
    let so = "";
    let se = "";
    child.stdout.on("data", (d: Buffer) => (so += d.toString()));
    child.stderr.on("data", (d: Buffer) => (se += d.toString()));
    child.on("close", (code) => {
      writeFileSync(process.env.FAKE_CLAUDE_BASH_OUT!, JSON.stringify({ code, stdout: so, stderr: se }));
      finish(fence(goodJson));
    });
    break;
  }
  case "hang":
    setInterval(() => {}, 1000);
    break;
  case "hang-tree": {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env.FAKE_CLAUDE_PID_FILE!, JSON.stringify({ pid: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
    break;
  }
  case "hang-ignore-term":
    process.on("SIGTERM", () => {});
    writeFileSync(process.env.FAKE_CLAUDE_PID_FILE!, JSON.stringify({ pid: process.pid }));
    setInterval(() => {}, 1000);
    break;
  case "replay": {
    // FAKE_CLAUDE_REPLAY: a stream-json fixture written to stdout line by line (it carries its own result event)
    for (const line of readFileSync(process.env.FAKE_CLAUDE_REPLAY!, "utf8").split("\n")) if (line.trim()) process.stdout.write(line + "\n");
    process.exit(0);
  }
  case "not-logged-in":
    out({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", permission_denials: [], total_cost_usd: 0 });
    process.exit(1);
  default:
    process.stderr.write(`unknown scenario ${scenario}\n`);
    process.exit(2);
}
