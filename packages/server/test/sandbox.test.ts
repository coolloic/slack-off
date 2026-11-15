// Task 6: role sandbox policies, the JIRA navigation guard (hook script + post-run log scan) and browser pinning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tmpDir } from "./helpers/tmp.ts";
import {
  bashAllowRules, CHROME_ALL_TOOLS, CHROME_READ_TOOLS, DENIED_TOOLS, DEV_BASH_FORM, DEV_BASH_MODE, DEV_RESTRICTED, devCommandLine,
  JIRA_UPDATE_COMPUTER_ACTIONS, JIRA_UPDATE_EXTRA_TOOLS, NAV_GUARD, pathDenyRules, SandboxPolicyError, toolPolicy, assertWithinPolicy,
  ACCEPT_BASH_FORM, ACCEPT_ENV_KEYS, ACCEPT_FS_GUARD, ACCEPT_MECHANISM, ACCEPT_TEST_COMMAND, acceptCommandForms, acceptCommandLine,
  JIRA_COMMENT_COMPUTER_ACTIONS, JIRA_COMMENT_MULTILINE, caseCommandForms, CASES_SHIM_FORM,
} from "../src/executor/sandbox.ts";
import {
  browserViolations, computerViolations, multipleBrowsersReported, tabLineUrl, NAV_GUARD_SCRIPT, navAllowed, navGuardSelfCheck, navGuardSettings, navViolations,
  typedTexts,
} from "../src/executor/nav-guard.ts";

const C = (t: string) => `mcp__claude-in-chrome__${t}`;
const fixture = (n: string) => resolve(import.meta.dirname, "fixtures", n);
const allow = ["https://j.example.com/", "https://j.example.com/browse/K-1"];

test("spike decided values (P-C15)", () => {
  assert.equal(DEV_BASH_MODE, "scoped");
  assert.equal(DEV_BASH_FORM, "cd <ticketDir>/<repo> && <cmd>");
  assert.equal(DEV_RESTRICTED, true);
  assert.deepEqual(JIRA_UPDATE_EXTRA_TOOLS, [C("computer")]);
  assert.equal(NAV_GUARD, "hook");
  assert.equal(devCommandLine("/h/worktrees/K-1", "api", "pnpm test"), "cd /h/worktrees/K-1/api && pnpm test");
});

test("devCommandLine refuses paths, repo names and commands outside the safe character set", () => {
  assert.throws(() => devCommandLine("/Users/me/my home/worktrees/K-1", "api", "pnpm test"), /SLACKOFF_HOME/);
  assert.throws(() => devCommandLine("relative/K-1", "api", "pnpm test"), SandboxPolicyError);
  assert.throws(() => devCommandLine("/h/$(x)/K-1", "api", "pnpm test"), SandboxPolicyError);
  assert.throws(() => devCommandLine("/h/K-1", "../x", "pnpm test"), SandboxPolicyError);
  assert.throws(() => devCommandLine("/h/K-1", "api", "pnpm test; rm -rf /"), SandboxPolicyError);
});

test("bashAllowRules: exactly Bash(<cmd>), no wildcard variant, deduplicated; unsafe commands refused", () => {
  assert.deepEqual(bashAllowRules(["pnpm test", "pnpm lint", "pnpm test"]), ["Bash(pnpm test)", "Bash(pnpm lint)"]);
  for (const bad of [
    "", "pnpm test *", "pnpm test\ntouch x", "pnpm test) Bash(rm", "a".repeat(201),
    // isSafeCommand: shell metacharacters, env prefixes, shells
    "pnpm test; touch x", "pnpm test && x", "FOO=1 pnpm test", "sh -c x", "-rf", "pnpm  test",
    // first token on the dev deny list (semantic allow/deny overlap)
    "git status", "gh pr list", "curl https://x", "wget x", "ssh host", "scp a b", "nc host 1",
  ]) {
    assert.throws(() => bashAllowRules([bad]), SandboxPolicyError, JSON.stringify(bad));
  }
});

test("pathDenyRules: Edit and Write rules per glob; unsafe globs refused", () => {
  assert.deepEqual(pathDenyRules(["infra/**"]), ["Edit(/**/infra/**)", "Write(/**/infra/**)"]);
  for (const bad of ["", "/abs/**", "a)b", "x\ny"]) assert.throws(() => pathDenyRules([bad]), SandboxPolicyError, JSON.stringify(bad));
});

test("CHROME_ALL_TOOLS lists every claude-in-chrome tool, read and write", () => {
  for (const t of ["navigate", "get_page_text", "computer", "form_input", "javascript_tool", "select_browser", "switch_browser", "list_connected_browsers", "shortcuts_list"]) {
    assert.ok(CHROME_ALL_TOOLS.includes(C(t)), t);
  }
  assert.ok(CHROME_ALL_TOOLS.every((t) => t.startsWith("mcp__claude-in-chrome__")));
});

test("read-only design roles: Read Grep Glob, phase-1 deny list, restricted", () => {
  for (const role of ["propose-solutions", "design-solution", "critique-design"] as const) {
    const p = toolPolicy(role);
    assert.deepEqual(p.builtin, ["Read", "Grep", "Glob"]);
    assert.deepEqual(p.allowed, ["Read", "Grep", "Glob"]);
    assert.deepEqual(p.denied, DENIED_TOOLS);
    assert.equal(p.chrome, false);
    assert.equal(p.restricted, true);
  }
  assert.equal(toolPolicy("refine-ticket").restricted, false);
});

test("implement-ticket: scoped Bash only with commands; deny list covers web, chrome, git and protected paths", () => {
  const p = toolPolicy("implement-ticket", { commands: ["pnpm test"], denyPaths: ["infra/**"] });
  assert.deepEqual(p.builtin, ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
  assert.deepEqual(p.allowed, ["Read", "Grep", "Glob", "Edit", "Write", "Bash(pnpm test)"]);
  assert.equal(p.restricted, true);
  assert.equal(p.chrome, false);
  for (const d of ["WebFetch", "WebSearch", "NotebookEdit", ...CHROME_ALL_TOOLS, "Edit(/**/.git)", "Write(/**/.git)", "Edit(/**/.git/**)", "Write(/**/.git/**)", "Bash(git *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)", "Bash(ssh *)", "Bash(scp *)", "Bash(nc *)",
    "Edit(/**/.slackoff/**)", "Write(/**/.slackoff/**)", "Write(/**/.githooks/**)", "Write(/**/.husky/**)", "Edit(/**/infra/**)", "Write(/**/infra/**)"]) {
    assert.ok(p.denied.includes(d), d);
  }
  assert.ok(!p.denied.includes("Bash") && !p.denied.includes("Edit") && !p.denied.includes("Write"));
  assert.ok(!toolPolicy("implement-ticket", { commands: [] }).builtin.includes("Bash"));
  assert.ok(!toolPolicy("implement-ticket").builtin.includes("Bash"));
  const none = toolPolicy("implement-ticket", { commands: ["pnpm test"], bashMode: "none" });
  assert.ok(!none.builtin.includes("Bash"));
  assert.ok(!none.allowed.some((t) => t.startsWith("Bash")));
  assert.throws(() => assertWithinPolicy("implement-ticket", ["Read", "WebFetch"], false, {}), SandboxPolicyError);
  assert.throws(() => assertWithinPolicy("implement-ticket", ["Bash(pnpm lint)"], false, { commands: ["pnpm test"] }), SandboxPolicyError);
});

test("jira-browser: phase-1 policy unless a browser is pinned or listed", () => {
  const p1 = toolPolicy("jira-browser");
  assert.deepEqual(p1.allowed, CHROME_READ_TOOLS);
  assert.deepEqual(p1.denied, DENIED_TOOLS);
  const pinned = toolPolicy("jira-browser", { browser: { deviceId: "dev-1" } });
  assert.ok(pinned.allowed.includes(C("select_browser")));
  assert.ok(!pinned.denied.includes(C("select_browser")));
  assert.ok(pinned.denied.includes(C("switch_browser")) && pinned.denied.includes(C("list_connected_browsers")));
  const list = toolPolicy("jira-browser", { browser: "list" });
  assert.ok(list.allowed.includes(C("list_connected_browsers")));
  assert.ok(!list.denied.includes(C("list_connected_browsers")));
  assert.ok(list.denied.includes(C("select_browser")));
});

test("jira-update: read tools + computer (+ select_browser when pinned); other write tools stay denied", () => {
  const p = toolPolicy("jira-update", { browser: { deviceId: "dev-1" }, navAllow: allow });
  assert.equal(p.chrome, true);
  assert.deepEqual(p.builtin, ["ToolSearch"]);
  assert.deepEqual(p.allowed, [...CHROME_READ_TOOLS, C("computer"), C("select_browser")]);
  for (const d of ["form_input", "javascript_tool", "file_upload", "switch_browser", "upload_image", "browser_batch"]) assert.ok(p.denied.includes(C(d)), d);
  for (const a of p.allowed) assert.ok(!p.denied.includes(a), a);
  assert.ok(!toolPolicy("jira-update", { browser: null, navAllow: allow }).allowed.includes(C("select_browser")));
  assert.throws(() => assertWithinPolicy("jira-update", [C("form_input")], true, { navAllow: allow }), SandboxPolicyError);
});

// ---- navigation guard ----

test("navAllowed: same origin and exactly / or /browse/<KEY> (query and hash allowed)", () => {
  assert.equal(navAllowed("https://j.example.com/browse/K-1?x=1", allow), true);
  assert.equal(navAllowed("https://j.example.com/browse/K-1#c", allow), true);
  assert.equal(navAllowed("https://j.example.com/", allow), true);
  for (const bad of [
    "https://j.example.com/browse/K-2", "https://evil.example/browse/K-1", "https://j.example.com.evil.io/", "http://j.example.com/browse/K-1",
    "https://j.example.com/browse/K-1/../../secure/admin", "https://j.example.com/secure/admin", "https://u:p@j.example.com/browse/K-1",
    "https://j.example.com:8443/browse/K-1", "javascript:alert(1)", "not a url", "",
  ]) {
    assert.equal(navAllowed(bad, allow), false, bad);
  }
});

test("navViolations: finds URLs reached by a click from tool RESULTS (get_page_text URL: and Tab Context lines)", () => {
  // also: a URL containing parentheses next to a title containing "("; a `URL:` line in the page body is not the page URL
  assert.deepEqual(navViolations(fixture("nav-click-escape.jsonl"), allow).sort(), [
    "https://evil.example/a(b)", "https://evil.example/phish", "https://j.example.com/secure/admin",
  ]);
});

const resultLog = (text: string, tool = "tabs_context_mcp") =>
  [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "q", name: C(tool), input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q", content: text }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";

test("navViolations: a Tab Context line that cannot be parsed counts as a violation", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  writeFileSync(log, resultLog('Tab Context:\n- Available tabs:\n  • tabId 3: "Odd" https://evil.example/x'));
  assert.equal(navViolations(log, allow).length, 1);
  writeFileSync(log, resultLog('Tab Context:\n- Available tabs:\n  • tabId 3: "Ok (1)" (https://j.example.com/browse/K-1)'));
  assert.deepEqual(navViolations(log, allow), []);
  writeFileSync(log, resultLog("Tab Context:\n- Executed on tabId: 3\n- something new: x"));
  assert.equal(navViolations(log, allow).length, 1);
});

test("navViolations: only the get_page_text header's URL: line counts, not body lines", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  writeFileSync(log, resultLog("Title: K-1\nURL: https://j.example.com/browse/K-1\n---\nA comment:\nURL: https://github.com/x/y", "get_page_text"));
  assert.deepEqual(navViolations(log, allow), []);
  writeFileSync(log, resultLog("Title: K-1\nURL: https://evil.example/\n---\nbody", "get_page_text"));
  assert.deepEqual(navViolations(log, allow), ["https://evil.example/"]);
  // a `URL:` line in another tool's result is page content, not the page URL
  writeFileSync(log, resultLog("URL: https://github.com/x/y", "find"));
  assert.deepEqual(navViolations(log, allow), []);
});

test("navViolations: tool_use URLs are checked too; a missing log is clean", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  writeFileSync(log, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: C("navigate"), input: { url: "https://x.example/" } }] } }) + "\nnot json\n");
  assert.deepEqual(navViolations(log, allow), ["https://x.example/"]);
  assert.deepEqual(navViolations(join(dir, "missing.jsonl"), allow), []);
});

test("browserViolations: select_browser to another device or any switch_browser", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  const use = (name: string, input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: C(name), input }] } });
  writeFileSync(log, use("select_browser", { deviceId: "dev-1" }) + "\n");
  assert.deepEqual(browserViolations(log, "dev-1"), []);
  writeFileSync(log, use("select_browser", { deviceId: "dev-1" }) + "\n" + use("select_browser", { deviceId: "dev-2" }) + "\n");
  assert.equal(browserViolations(log, "dev-1").length, 1);
  writeFileSync(log, use("switch_browser", {}) + "\n");
  assert.equal(browserViolations(log, "dev-1").length, 1);
});

test("multipleBrowsersReported reads tool results", () => {
  assert.equal(multipleBrowsersReported(fixture("nav-multi-browser.jsonl")), true);
  assert.equal(multipleBrowsersReported(fixture("nav-click-escape.jsonl")), false);
});

// ---- the hook script itself (run with this Node, as the CLI would) ----

function hook(input: string, env: Record<string, string | undefined>) {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.SLACKOFF_NAV_ALLOW;
  delete e.SLACKOFF_BROWSER;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  return spawnSync(process.execPath, [NAV_GUARD_SCRIPT], { input, env: e, encoding: "utf8" });
}
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const call = (name: string, input: unknown) => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: C(name), tool_input: input });
const env = { SLACKOFF_NAV_ALLOW: b64(allow), SLACKOFF_BROWSER: b64("dev-1") };

test("hook: out-of-scope URL exits 2 with a reason; allowed URL and tabs_create_mcp {} exit 0", () => {
  const bad = hook(call("navigate", { tabId: 1, url: "https://evil.example/" }), env);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^Blocked by Slack Off: /);
  assert.equal(hook(call("navigate", { tabId: 1, url: "https://j.example.com/browse/K-1" }), env).status, 0);
  assert.equal(hook(call("tabs_create_mcp", {}), env).status, 0);
  assert.equal(hook(call("tabs_create_mcp", { url: "https://evil.example/" }), env).status, 2);
});

test("hook: select_browser to another device or switch_browser exits 2; the pinned device exits 0", () => {
  assert.equal(hook(call("select_browser", { deviceId: "dev-2" }), env).status, 2);
  assert.equal(hook(call("select_browser", { deviceId: "dev-1" }), env).status, 0);
  assert.equal(hook(call("switch_browser", {}), env).status, 2);
  // no pinned browser: selecting any browser is refused
  assert.equal(hook(call("select_browser", { deviceId: "dev-1" }), { ...env, SLACKOFF_BROWSER: b64(null) }).status, 2);
});

test("hook: allow null skips the URL check (jira-browser), the device check still applies", () => {
  const e = { SLACKOFF_NAV_ALLOW: b64(null), SLACKOFF_BROWSER: b64("dev-1") };
  assert.equal(hook(call("navigate", { url: "https://anything.example/" }), e).status, 0);
  assert.equal(hook(call("select_browser", { deviceId: "dev-2" }), e).status, 2);
});

test("hook fails closed on tool names it does not know", () => {
  assert.equal(hook(JSON.stringify({ tool_name: "Bash", tool_input: {} }), env).status, 2);
  assert.equal(hook(call("computer", { action: "left_click" }), env).status, 2);
  assert.equal(hook(JSON.stringify({ tool_input: {} }), env).status, 2);
});

test("hook is plain JavaScript importing only node: built-ins (runs on any Node >= 18, no type stripping)", () => {
  assert.match(NAV_GUARD_SCRIPT, /\.mjs$/);
  const src = readFileSync(NAV_GUARD_SCRIPT, "utf8");
  for (const m of src.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)) assert.match(m[1]!, /^node:/, m[1]!);
  const r = spawnSync(process.execPath, ["--no-experimental-strip-types", NAV_GUARD_SCRIPT], {
    input: call("navigate", { url: "https://evil.example/" }),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 2, r.stderr);
});

test("hook fails closed: bad stdin, missing or malformed env, non-string url", () => {
  assert.equal(hook("{not json", env).status, 2);
  assert.equal(hook("", env).status, 2);
  assert.equal(hook(call("navigate", { url: "https://j.example.com/" }), { SLACKOFF_BROWSER: env.SLACKOFF_BROWSER }).status, 2);
  assert.equal(hook(call("navigate", { url: "https://j.example.com/" }), { ...env, SLACKOFF_NAV_ALLOW: "%%%" }).status, 2);
  assert.equal(hook(call("navigate", { url: "https://j.example.com/" }), { ...env, SLACKOFF_NAV_ALLOW: b64("https://j.example.com/") }).status, 2);
  assert.equal(hook(call("navigate", { url: 42 }), env).status, 2);
});

test("navGuardSettings: PreToolUse hook on navigate/tabs_create_mcp/select_browser running the guard via sh", () => {
  const s = JSON.parse(navGuardSettings({ allow, deviceId: "dev-1" })) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  const [entry] = s.hooks.PreToolUse;
  for (const t of ["navigate", "tabs_create_mcp", "select_browser", "switch_browser"]) assert.ok(new RegExp(`^(${entry!.matcher})$`).test(C(t)), t);
  assert.ok(!new RegExp(`^(${entry!.matcher})$`).test(C("get_page_text")));
  const cmd = entry!.hooks[0]!.command;
  assert.equal(entry!.hooks[0]!.type, "command");
  assert.ok(cmd.includes(`'${NAV_GUARD_SCRIPT}'`));
  // the absolute Node running the server (>= 24), never whatever `node` is first on PATH
  assert.ok(cmd.includes(` '${process.execPath}' `), cmd);
  assert.ok(!/(^|\s)node\s/.test(cmd), cmd);
  // the command as the CLI runs it (a shell): config arrives through the environment
  const run = (input: string) => spawnSync("/bin/sh", ["-c", cmd], { input, encoding: "utf8" });
  assert.equal(run(call("navigate", { url: "https://evil.example/" })).status, 2);
  assert.equal(run(call("navigate", { url: "https://j.example.com/browse/K-1" })).status, 0);
  assert.equal(run(call("select_browser", { deviceId: "dev-2" })).status, 2);
});

test("the guard script lives in the server source, not in a writable agent directory", () => {
  assert.equal(NAV_GUARD_SCRIPT, resolve(import.meta.dirname, "../src/executor/nav-guard-hook.mjs"));
});

test("navGuardSelfCheck: the real guard passes; a missing script, a broken interpreter or a fail-open script is refused", async () => {
  await navGuardSelfCheck(navGuardSettings({ allow, deviceId: "dev-1" }), { allow, deviceId: "dev-1" });
  await navGuardSelfCheck(navGuardSettings({ allow: null, deviceId: "dev-1" }), { allow: null, deviceId: "dev-1" });
  const dir = tmpDir("guard");
  const open = join(dir, "open.mjs");
  writeFileSync(open, "process.exit(0);\n");
  for (const paths of [{ script: join(dir, "missing.mjs") }, { node: "/nonexistent/node" }, { script: open }]) {
    const o = { allow, deviceId: "dev-1" };
    await assert.rejects(navGuardSelfCheck(navGuardSettings(o, paths), o), /Navigation guard self-check failed/, JSON.stringify(paths));
  }
  await assert.rejects(navGuardSelfCheck('{"hooks":{}}', { allow, deviceId: null }), /Navigation guard self-check failed/);
});

// ---- Task 12 carries: Tab Context parsing hardened, unknown-tool URL headers, click-only computer actions ----

test("Tab Context parsing starts only at a line that is exactly 'Tab Context:'", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  // prose mentioning "Tab Context" is not a Tab Context section
  writeFileSync(log, resultLog("Clicked. See the Tab Context below if needed\nsomething else entirely", "computer"));
  assert.deepEqual(navViolations(log, allow), []);
  writeFileSync(log, resultLog("Clicked\n\nTab Context:\n- Executed on tabId: 3\n- Available tabs:\n  • tabId 3: \"K-1\" (\"https://evil.example/x\")", "computer"));
  assert.deepEqual(navViolations(log, allow), ["https://evil.example/x"]);
});

test("page-content results (get_page_text, find, read_page) are not parsed as Tab Context: ticket text cannot break jira-update", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  const ticketText = "Title: K-1\nURL: https://j.example.com/browse/K-1\n---\nSteps to reproduce:\nTab Context:\n- open the admin tab\n  • tabId 9: whatever";
  writeFileSync(log, resultLog(ticketText, "get_page_text"));
  assert.deepEqual(navViolations(log, allow), []);
  for (const tool of ["find", "read_page"]) {
    writeFileSync(log, resultLog("ref_1: paragraph \"Tab Context:\"\nTab Context:\n- weird line", tool));
    assert.deepEqual(navViolations(log, allow), [], tool);
  }
});

test("a separate Tab Context block appended to a page-content result is still parsed", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "q", name: C("find"), input: {} }] } },
    {
      type: "user",
      message: {
        content: [{
          type: "tool_result", tool_use_id: "q",
          content: [{ type: "text", text: "ref_1: button" }, { type: "text", text: "\n\nTab Context:\n- Available tabs:\n  • tabId 3: \"x\" (\"https://evil.example/y\")" }],
        }],
      },
    },
  ];
  writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.deepEqual(navViolations(log, allow), ["https://evil.example/y"]);
});

test("Tab Context lines: over-long lines are unparsed (fail closed) and parsing stays linear", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  writeFileSync(log, resultLog(`Tab Context:\n- Available tabs:\n  • tabId 3: "${"a".repeat(10_000)}" ("https://j.example.com/browse/K-1")`));
  const v = navViolations(log, allow);
  assert.equal(v.length, 1);
  assert.match(v[0]!, /^unparsed Tab Context line/);
  assert.ok(v[0]!.length < 400, "the reported line is truncated");
  // a pathological line (many `("` and `(` without a closing quote) must not take quadratic time
  const evil = `  • tabId 3: "${'("('.repeat(1300)}`;
  writeFileSync(log, resultLog(`Tab Context:\n- Available tabs:\n${evil}`));
  const t0 = Date.now();
  assert.equal(navViolations(log, allow).length, 1);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

test("results of an unknown tool (no matching tool_use) are scanned for a URL: header", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  const line = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "nope", content: "Title: x\nURL: https://evil.example/u\n---\nbody" }] } };
  writeFileSync(log, JSON.stringify(line) + "\n");
  assert.deepEqual(navViolations(log, allow), ["https://evil.example/u"]);
  // a known non-page tool's URL: line is not a page header
  writeFileSync(log, resultLog("URL: https://evil.example/u", "tabs_close_mcp"));
  assert.deepEqual(navViolations(log, allow), []);
});

test("hook: computer is guarded only when click-only actions are configured; type/key/drag are blocked", () => {
  const e = { ...env, SLACKOFF_COMPUTER: b64(["left_click", "scroll", "scroll_to", "wait", "screenshot"]) };
  assert.equal(hook(call("computer", { action: "left_click", ref: "ref_1", tabId: 3 }), e).status, 0);
  assert.equal(hook(call("computer", { action: "screenshot", tabId: 3 }), e).status, 0);
  for (const bad of [
    { action: "type", text: "hello" }, { action: "key", text: "Enter" }, { action: "left_click_drag" }, { action: "double_click", ref: "ref_1" },
    { action: "left_click", ref: "ref_1", text: "cmd" }, { action: "left_click", ref: "ref_1", modifiers: "ctrl" }, {},
  ]) {
    assert.equal(hook(call("computer", { tabId: 3, ...bad }), e).status, 2, JSON.stringify(bad));
  }
  // not configured (jira-browser): computer is an unknown tool for the hook
  assert.equal(hook(call("computer", { action: "left_click", ref: "ref_1" }), env).status, 2);
  assert.equal(hook(call("computer", { action: "left_click" }), { ...env, SLACKOFF_COMPUTER: "%%%" }).status, 2);
});

test("navGuardSettings with computer actions: matcher covers computer, the self-check probes a typed key", async () => {
  const o = { allow, deviceId: "dev-1", computerActions: ["left_click"] };
  const s = navGuardSettings(o);
  const entry = (JSON.parse(s) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }).hooks.PreToolUse[0]!;
  assert.ok(new RegExp(`^(${entry.matcher})$`).test(C("computer")));
  await navGuardSelfCheck(s, o);
  // a guard that blocks navigation but lets every computer action through fails the self-check for click-only runs
  const dir = tmpDir("guard");
  const leaky = join(dir, "leaky.mjs");
  writeFileSync(leaky, 'import { readFileSync } from "node:fs";\nconst i = JSON.parse(readFileSync(0, "utf8"));\nprocess.exit(i.tool_name.endsWith("__computer") ? 0 : 2);\n');
  await assert.rejects(navGuardSelfCheck(navGuardSettings(o, { script: leaky }), o), /self-check failed: a disallowed computer/);
  // without computer actions the matcher does not include computer (jira-browser)
  const plain = (JSON.parse(navGuardSettings({ allow, deviceId: "dev-1" })) as { hooks: { PreToolUse: Array<{ matcher: string }> } }).hooks.PreToolUse[0]!;
  assert.ok(!new RegExp(`^(${plain.matcher})$`).test(C("computer")));
});

test("computerViolations: any computer action outside the click-only set is reported", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  const use = (input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: C("computer"), input }] } });
  writeFileSync(log, [use({ action: "left_click", ref: "ref_1" }), use({ action: "scroll" })].join("\n") + "\n");
  assert.deepEqual(computerViolations(log, ["left_click", "scroll"]), []);
  writeFileSync(log, [use({ action: "left_click", ref: "ref_1" }), use({ action: "type", text: "x" })].join("\n") + "\n");
  assert.deepEqual(computerViolations(log, ["left_click", "scroll"]), ['computer action "type" is not allowed']);
});

test("JIRA_UPDATE_COMPUTER_ACTIONS are click-only (no type, key or drag)", () => {
  for (const a of ["type", "key", "left_click_drag", "double_click", "triple_click", "right_click"]) assert.ok(!JIRA_UPDATE_COMPUTER_ACTIONS.includes(a), a);
  assert.ok(JIRA_UPDATE_COMPUTER_ACTIONS.includes("left_click"));
});

test("tabLineUrl is linear: a 20k-character pathological line parses in < 5 ms", () => {
  const lines = [`  • tabId 3: "${"a ".repeat(10_000)})`, `  • tabId 3: "${'("('.repeat(7000)}`, `  • tabId 3: "${" ".repeat(20_000)}x)`];
  for (const l of lines) tabLineUrl(l); // warm up
  for (const l of lines) {
    const t0 = performance.now();
    tabLineUrl(l);
    const ms = performance.now() - t0;
    assert.ok(ms < 5, `${ms} ms`);
  }
  assert.equal(tabLineUrl('  • tabId 3: "Ok (1)" (https://j.example.com/browse/K-1)'), "https://j.example.com/browse/K-1");
  assert.equal(tabLineUrl('  • tabId 3: "x"\t(https://j.example.com/)'), "https://j.example.com/");
  assert.equal(tabLineUrl('  • tabId 3: "x" ("https://evil.example/a(b)")'), "https://evil.example/a(b)");
  assert.equal(tabLineUrl('  • tabId 3: "x" https://evil.example/'), null);
});

test("computerViolations mirrors the hook: text or modifiers on a click are refused", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  const use = (input: unknown) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: C("computer"), input }] } });
  writeFileSync(log, [use({ action: "left_click", ref: "ref_1", text: "cmd" }), use({ action: "left_click", ref: "ref_2", modifiers: "ctrl" })].join("\n") + "\n");
  assert.equal(computerViolations(log, ["left_click"]).length, 2);
  writeFileSync(log, use({ action: "left_click", ref: "ref_1", text: "" }) + "\n");
  assert.deepEqual(computerViolations(log, ["left_click"]), []);
});

test("format pin: a Tab Context inside the SAME block as a find/read_page body is not parsed (real results put it in a separate block)", () => {
  const dir = tmpDir("nav");
  const log = join(dir, "r.jsonl");
  for (const tool of ["find", "read_page"]) {
    writeFileSync(log, resultLog('Found 1 matching element\n- ref_4: button "Status"\n\nTab Context:\n- Available tabs:\n  • tabId 3: "x" ("https://evil.example/z")', tool));
    assert.deepEqual(navViolations(log, allow), [], tool);
  }
});

// ---- Task 7: acceptance-review and jira-comment policies, the typing guard ----

test("Task 7 decided values: acceptance command forms, env keys, jira-comment actions (no key)", () => {
  assert.equal(ACCEPT_MECHANISM, "specs");
  assert.equal(ACCEPT_TEST_COMMAND, "playwright test");
  assert.equal(ACCEPT_BASH_FORM, "cd <workDir>/acceptance && playwright test");
  assert.deepEqual(ACCEPT_ENV_KEYS, ["PATH", "HOME", "USER"]);
  assert.equal(ACCEPT_FS_GUARD, "sandbox-exec");
  assert.deepEqual(JIRA_COMMENT_COMPUTER_ACTIONS, ["left_click", "type", "scroll", "scroll_to", "wait", "screenshot"]);
  assert.ok(!JIRA_COMMENT_COMPUTER_ACTIONS.includes("key"));
  assert.equal(JIRA_COMMENT_MULTILINE, true);
  assert.equal(acceptCommandLine("/private/var/x/work"), "cd /private/var/x/work/acceptance && playwright test");
  assert.deepEqual(acceptCommandForms("/private/var/x/work"), ["cd /private/var/x/work/acceptance && playwright test", "playwright test"]);
  for (const bad of ["relative/work", "/a b/work", "/a/../b", "/a;rm -rf /", "/a\nb"]) assert.throws(() => acceptCommandLine(bad), SandboxPolicyError, bad);
});

test("acceptance-review: file tools + Bash, only Bash(playwright test) allowed, web/chrome/git/npx/node and the scaffold denied, restricted", () => {
  assert.throws(() => toolPolicy("acceptance-review"), SandboxPolicyError, "workDir is required");
  const p = toolPolicy("acceptance-review", { workDir: "/private/var/r/work", denyPaths: ["shop/**"] });
  assert.deepEqual(p.builtin, ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
  assert.deepEqual(p.allowed, ["Read", "Grep", "Glob", "Edit", "Write", "Bash(playwright test)"]);
  assert.ok(!p.allowed.some((a) => /^Bash\(.* \*\)$/.test(a)));
  for (const d of [
    "WebFetch", "WebSearch", "NotebookEdit", ...CHROME_ALL_TOOLS, "Bash(git *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)", "Bash(ssh *)", "Bash(scp *)",
    "Bash(nc *)", "Bash(npx *)", "Bash(node *)", "Edit(/**/playwright.config.mjs)", "Write(/**/playwright.config.mjs)", "Write(/**/node_modules/**)", "Edit(/**/shop/**)", "Write(/**/shop/**)",
  ]) assert.ok(p.denied.includes(d), d);
  for (const a of p.allowed) assert.ok(!p.denied.includes(a), a);
  assert.equal(p.chrome, false);
  assert.equal(p.restricted, true);
  assert.equal(p.computerActions, null);
  assert.throws(() => assertWithinPolicy("acceptance-review", ["Bash(npx playwright test)"], false, { workDir: "/w" }), SandboxPolicyError);
  assert.throws(() => assertWithinPolicy("acceptance-review", ["Read"], true, { workDir: "/w" }), SandboxPolicyError);
});

test("jira-comment: read tools + computer (+ select_browser when pinned), its own computer actions; jira-update keeps click-only", () => {
  const navAllow = ["https://j.example.com/browse/K-1"];
  const p = toolPolicy("jira-comment", { browser: { deviceId: "dev-1" }, navAllow, typeText: "hi" });
  assert.equal(p.chrome, true);
  assert.deepEqual(p.builtin, ["ToolSearch"]);
  assert.deepEqual(p.allowed, [...CHROME_READ_TOOLS, C("computer"), C("select_browser")]);
  assert.deepEqual(p.denied, DENIED_TOOLS.filter((t) => !p.allowed.includes(t)));
  assert.deepEqual(p.computerActions, JIRA_COMMENT_COMPUTER_ACTIONS);
  assert.ok(!toolPolicy("jira-comment", { browser: null, navAllow }).allowed.includes(C("select_browser")));
  assert.throws(() => toolPolicy("jira-comment", { browser: "list", navAllow }), SandboxPolicyError);
  assert.throws(() => assertWithinPolicy("jira-comment", [C("computer")], true, { browser: null }), SandboxPolicyError, "navAllow required");
  assert.deepEqual(toolPolicy("jira-update", { navAllow: allow }).computerActions, JIRA_UPDATE_COMPUTER_ACTIONS);
  assert.equal(toolPolicy("jira-browser").computerActions, null);
  assert.equal(toolPolicy("implement-ticket").computerActions, null);
});

const COMMENT = "Acceptance result for K-1: 2 of 2 criteria passed.\n- AC-1: pass\n- AC-2: pass\nEvidence is in Slack Off.";

test("hook (jira-comment): type only with exactly the given text; key, other text, text on a click refused; jira-update still refuses any type", () => {
  const e = { ...env, SLACKOFF_COMPUTER: b64(JIRA_COMMENT_COMPUTER_ACTIONS), SLACKOFF_TYPE_TEXT: b64(COMMENT) };
  assert.equal(hook(call("computer", { tabId: 3, action: "type", text: COMMENT }), e).status, 0);
  assert.equal(hook(call("computer", { tabId: 3, action: "left_click", ref: "ref_1" }), e).status, 0);
  for (const bad of [
    { action: "type", text: "Looks good to me" }, { action: "type", text: COMMENT + " " }, { action: "type" }, { action: "key", text: "Return" }, { action: "key" },
    { action: "left_click", ref: "ref_1", text: "x" }, { action: "type", text: COMMENT, modifiers: "cmd" },
  ]) {
    const r = hook(call("computer", { tabId: 3, ...bad }), e);
    assert.equal(r.status, 2, JSON.stringify(bad));
    assert.match(r.stderr, /^Blocked by Slack Off: /);
  }
  // no type text configured: type is refused even when the action list has it
  assert.equal(hook(call("computer", { action: "type", text: COMMENT }), { ...env, SLACKOFF_COMPUTER: b64(JIRA_COMMENT_COMPUTER_ACTIONS) }).status, 2);
  // jira-update's list is not widened by jira-comment
  assert.equal(hook(call("computer", { action: "type", text: COMMENT }), { ...env, SLACKOFF_COMPUTER: b64(JIRA_UPDATE_COMPUTER_ACTIONS), SLACKOFF_TYPE_TEXT: b64(COMMENT) }).status, 2);
  assert.equal(hook(call("computer", { action: "type", text: COMMENT }), { ...e, SLACKOFF_TYPE_TEXT: "%%%" }).status, 2);
});

test("navGuardSettings with typeText: hook gets the text; the self-check types a different text and must be refused", async () => {
  const o = { allow: ["https://j.example.com/browse/K-1"], deviceId: null, computerActions: JIRA_COMMENT_COMPUTER_ACTIONS, typeText: COMMENT };
  const s = navGuardSettings(o);
  const entry = (JSON.parse(s) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }).hooks.PreToolUse[0]!;
  assert.match(entry.hooks[0]!.command, /SLACKOFF_TYPE_TEXT=/);
  await navGuardSelfCheck(s, o);
  // a guard that lets any type through fails the self-check
  const dir = tmpDir("guard");
  try {
    const leaky = join(dir, "leaky.mjs");
    writeFileSync(leaky, 'import { readFileSync } from "node:fs";\nconst i = JSON.parse(readFileSync(0, "utf8"));\nprocess.exit(i.tool_input.action === "type" ? 0 : 2);\n');
    await assert.rejects(navGuardSelfCheck(navGuardSettings(o, { script: leaky }), o), /self-check failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("computerViolations with typeText and typedTexts: the jira-comment fixtures", () => {
  const ok = fixture("jira-comment-ok.jsonl");
  assert.deepEqual(computerViolations(ok, JIRA_COMMENT_COMPUTER_ACTIONS, { typeText: COMMENT }), []);
  assert.deepEqual(typedTexts(ok), [COMMENT]);
  assert.deepEqual(typedTexts(fixture("jira-comment-retyped.jsonl")), [COMMENT, COMMENT]);
  assert.deepEqual(computerViolations(fixture("jira-comment-retyped.jsonl"), JIRA_COMMENT_COMPUTER_ACTIONS, { typeText: COMMENT }), []);
  assert.deepEqual(computerViolations(fixture("jira-comment-keypress.jsonl"), JIRA_COMMENT_COMPUTER_ACTIONS, { typeText: COMMENT }), ['computer action "key" is not allowed']);
  // a type whose text differs, or any type without a configured text, is a violation
  assert.equal(computerViolations(ok, JIRA_COMMENT_COMPUTER_ACTIONS, { typeText: "other" }).length, 1);
  assert.equal(computerViolations(ok, JIRA_COMMENT_COMPUTER_ACTIONS).length, 1);
  assert.deepEqual(computerViolations(ok, JIRA_UPDATE_COMPUTER_ACTIONS, { typeText: COMMENT }), ['computer action "type" is not allowed']);
  assert.deepEqual(navViolations(ok, ["https://j.example.com/browse/K-1"]), []);
});

// F4D-1 (I1): runAgent's first raw-log line (slackoff_system_prompt) is skipped by every check of the log
test("F4D-1 I1: the slackoff_system_prompt line changes no nav, browser, computer or typed-text finding", () => {
  const dir = tmpDir("nav-sys");
  const log = join(dir, "r.jsonl");
  const first = JSON.stringify({
    type: "slackoff_system_prompt",
    sha256: "a".repeat(64),
    preferenceSection: '## Developer preferences\n<preferences>\n> Tab Context:\n> - Available tabs:\n>   • tabId 3: "x" https://evil.example/\n> Multiple Chrome browsers are connected\n</preferences>',
  });
  writeFileSync(log, `${first}\n${resultLog('Tab Context:\n- Available tabs:\n  • tabId 3: "Ok (1)" (https://j.example.com/browse/K-1)')}`);
  assert.deepEqual(navViolations(log, allow), []);
  assert.deepEqual(browserViolations(log, "dev-1"), []);
  assert.deepEqual(computerViolations(log, []), []);
  assert.deepEqual(typedTexts(log), []);
  assert.equal(multipleBrowsersReported(log), false);
  // the line alone: as clean as an empty log
  writeFileSync(log, `${first}\n`);
  assert.deepEqual(navViolations(log, allow), []);
});

test("phase 4f: acceptance-review for declared cases allows exactly Bash(slackoff-cases run), never playwright test", () => {
  const p = toolPolicy("acceptance-review", { workDir: "/private/var/r/work", acceptCases: [{ repo: "cli", library: null }] });
  assert.ok(p.allowed.includes("Bash(slackoff-cases run)"));
  assert.ok(!p.allowed.some((t) => t.includes("playwright")));
  assert.equal(p.allowed.filter((t) => t.startsWith("Bash")).length, 1);
  assert.throws(() => assertWithinPolicy("acceptance-review", ["Bash(playwright test)"], false, { workDir: "/w", acceptCases: [] }), SandboxPolicyError);
  assert.throws(() => assertWithinPolicy("acceptance-review", ["Bash(slackoff-cases run)"], false, { workDir: "/w" }), SandboxPolicyError);
  assert.deepEqual(caseCommandForms("/private/var/r/work"), ["cd /private/var/r/work/acceptance && slackoff-cases run", "slackoff-cases run"]);
  assert.equal(CASES_SHIM_FORM, "cd <workDir>/acceptance && slackoff-cases run");
});
