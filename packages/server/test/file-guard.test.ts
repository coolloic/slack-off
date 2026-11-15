// Phase 4b fix round 1 (ruling 4B-4, I3): Claude Code's own file tools run outside the command sandbox and nothing
// realpaths their paths — a symlink the agent or the repo creates in the worktree would hand it credentials.json. The
// exec-form PreToolUse guard realpaths every path and refuses anything outside the run's roots. The hook script is
// unit-tested directly (spawned like Claude Code would); no real claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers/tmp.ts";
import { FILE_GUARD_SCRIPT, FILE_GUARD_TOOLS, fileGuardSelfCheck, fileGuardSettings, mergeHookSettings } from "../src/executor/file-guard.ts";

const scratch = realpathSync(tmpDir("fguard"));
const ticketDir = join(scratch, "home", "worktrees", "K-1");
const root = join(ticketDir, "api");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(root, "nb.ipynb"), "{}\n");
// a scratch stand-in for ${SLACKOFF_HOME}/credentials.json, outside the root
const creds = join(scratch, "home", "credentials.json");
writeFileSync(creds, '{"version":1}\n', { mode: 0o600 });
symlinkSync("../../../credentials.json", join(root, "x"));
symlinkSync("../../../credentials-missing.json", join(root, "dangling"));
symlinkSync(join(scratch, "home"), join(root, "homelink"));

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function hook(input: unknown, roots: unknown = [ticketDir], raw?: string): { code: number | null; stderr: string } {
  const args = ["--disable-sigusr1", FILE_GUARD_SCRIPT, ...(roots === null ? [] : [`--slackoff-files=${b64({ roots })}`])];
  const r = spawnSync(process.execPath, args, { input: raw ?? JSON.stringify(input), encoding: "utf8", timeout: 15_000 });
  return { code: r.status, stderr: r.stderr };
}
const call = (tool_name: string, tool_input: Record<string, unknown>, cwd = root) => ({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd });

/** The tool input naming `p` for each guarded tool. */
const inputs = (p: string): Array<[string, Record<string, unknown>]> => [
  ["Read", { file_path: p }],
  ["Edit", { file_path: p, old_string: "a", new_string: "b" }],
  ["Write", { file_path: p, content: "x" }],
  ["MultiEdit", { file_path: p, edits: [{ old_string: "a", new_string: "b" }] }],
  ["NotebookEdit", { notebook_path: p, new_source: "x" }],
  ["Grep", { pattern: "version", path: p }],
  ["Glob", { pattern: "*", path: p }],
];

test("4B-4: the guard covers exactly the file tools", () => {
  assert.deepEqual([...FILE_GUARD_TOOLS].sort(), ["Edit", "Glob", "Grep", "MultiEdit", "NotebookEdit", "Read", "Write"]);
});

test("4B-4: a symlink in the worktree to the credentials file is refused for every file tool", () => {
  for (const [tool, input] of inputs(join(root, "x"))) {
    const r = hook(call(tool, input));
    assert.equal(r.code, 2, `${tool}: ${r.stderr}`);
    assert.match(r.stderr, /Blocked by Slack Off/);
  }
  // through a symlinked directory, and as a relative path from the cwd
  assert.equal(hook(call("Read", { file_path: join(root, "homelink", "credentials.json") })).code, 2);
  assert.equal(hook(call("Read", { file_path: "x" })).code, 2);
});

test("4B-4: a normal file (or dir) under the root is allowed for every file tool", () => {
  for (const [tool, input] of inputs(join(root, "src", "a.ts"))) {
    const p = tool === "NotebookEdit" ? { ...input, notebook_path: join(root, "nb.ipynb") } : tool === "Grep" || tool === "Glob" ? { ...input, path: join(root, "src") } : input;
    const r = hook(call(tool, p));
    assert.equal(r.code, 0, `${tool}: ${r.stderr}`);
  }
  // (cwd: src — the root itself holds links out of it on purpose, which F4B-1 refuses for a search)
  // Grep / Glob without a path search the cwd (inside the root); a relative file path resolves from the cwd
  assert.equal(hook(call("Grep", { pattern: "a" }, join(root, "src"))).code, 0);
  assert.equal(hook(call("Glob", { pattern: "**/*.ts" }, join(root, "src"))).code, 0);
  assert.equal(hook(call("Read", { file_path: "src/a.ts" })).code, 0);
});

test("4B-4: Write of a missing file under the root is allowed; through a dangling link out of it, refused", () => {
  assert.equal(hook(call("Write", { file_path: join(root, "new", "deep", "f.ts"), content: "x" })).code, 0);
  assert.equal(hook(call("Write", { file_path: join(root, "dangling"), content: "x" })).code, 2);
  assert.equal(hook(call("Write", { file_path: join(root, "homelink", "planted.json"), content: "x" })).code, 2);
});

test("4B-4: .. traversal out of the root is refused (absolute, relative, in a Glob pattern)", () => {
  assert.equal(hook(call("Read", { file_path: join(root, "..", "..", "..", "credentials.json") })).code, 2);
  assert.equal(hook(call("Read", { file_path: "../../../credentials.json" })).code, 2);
  assert.equal(hook(call("Grep", { pattern: "x", path: join(root, "..", "..") })).code, 2);
  assert.equal(hook(call("Glob", { pattern: "../../../*.json" })).code, 2);
  assert.equal(hook(call("Glob", { pattern: `${scratch}/home/*.json` })).code, 2);
  assert.equal(hook(call("Grep", { pattern: "x", glob: "../../*.json" })).code, 2);
});

test("4B-4: fails closed — unknown tool, missing path, non-string path, no cwd for a relative path, bad input or config", () => {
  assert.equal(hook(call("Bash", { command: "cat x" })).code, 2);
  assert.equal(hook(call("Read", {})).code, 2);
  assert.equal(hook(call("Read", { file_path: 3 })).code, 2);
  assert.equal(hook(call("NotebookEdit", { new_source: "x" })).code, 2);
  assert.equal(hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "src/a.ts" } }).code, 2, "relative without cwd");
  assert.equal(hook(call("Read", { file_path: join(root, "src", "a.ts") }), [ticketDir], "not json").code, 2);
  assert.equal(hook(call("Read", { file_path: join(root, "src", "a.ts") }), null).code, 2, "no config");
  assert.equal(hook(call("Read", { file_path: join(root, "src", "a.ts") }), ["relative/root"]).code, 2, "relative root");
  assert.equal(hook(call("Read", { file_path: join(root, "src", "a.ts") }), ["/"]).code, 2, "the whole disk is no root");
});

test("4B-4: settings are exec form on the file tools; merged after another guard; self-check passes, and fails for a guard that lets calls through", async () => {
  const s = fileGuardSettings({ roots: [ticketDir] });
  const h = (JSON.parse(s) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; args: string[] }> }> } }).hooks.PreToolUse[0]!;
  assert.equal(h.matcher, "Read|Edit|Write|MultiEdit|Grep|Glob|NotebookEdit");
  assert.equal(h.hooks[0]!.command, process.execPath);
  assert.ok(h.hooks[0]!.args.includes(FILE_GUARD_SCRIPT));
  await fileGuardSelfCheck(s, join(scratch, "selfcheck"));
  const open = join(scratch, "open-guard.mjs");
  writeFileSync(open, "process.exit(0);\n");
  await assert.rejects(fileGuardSelfCheck(fileGuardSettings({ roots: [ticketDir] }, { script: open }), join(scratch, "selfcheck")), /File guard self-check failed/);
  assert.throws(() => fileGuardSettings({ roots: ["/"] }), /root/);
  const nav = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] } });
  const merged = JSON.parse(mergeHookSettings(nav, s)) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
  assert.deepEqual(merged.hooks.PreToolUse.map((p) => p.matcher), ["Bash", "Read|Edit|Write|MultiEdit|Grep|Glob|NotebookEdit"]);
  assert.equal(mergeHookSettings(null, s), s);
});

// ---------------------------------------------------------------- fix round 2 (ruling 4B-6)

import { readFileSync as readText, mkdtempSync } from "node:fs";

symlinkSync("..", join(root, "up"));

test("4B-6 (F1): a `..` after a symlinked dir is refused (the kernel follows `up` before `..`), in paths and Grep paths", () => {
  assert.equal(hook(call("Read", { file_path: `${root}/up/../../credentials.json` })).code, 2);
  assert.equal(hook(call("Grep", { pattern: "x", path: `${root}/up/..` })).code, 2);
  // every `..` segment, wherever it is
  assert.equal(hook(call("Read", { file_path: `${root}/src/..` })).code, 2);
  assert.equal(hook(call("Read", { file_path: "../credentials.json", }, )).code, 2);
  assert.equal(hook(call("Read", { file_path: `${root}//..//x` })).code, 2);
});

test("a name that only contains \"..\" (a..b.ts, ...) is a plain file name, not a parent step", () => {
  assert.equal(hook(call("Read", { file_path: join(root, "src", "a..b.ts") })).code, 0);
  assert.equal(hook(call("Read", { file_path: join(root, "src", "...") })).code, 0);
  assert.equal(hook(call("Grep", { pattern: "x", path: join(root, "src", "v1..v2") })).code, 0);
  // globs stay strict: a glob segment such as ..* is not a plain name
  assert.equal(hook(call("Glob", { pattern: "src/a..b.ts" })).code, 2);
});

test("4B-6 (F2): a leading ~ is refused in paths and globs", () => {
  assert.equal(hook(call("Read", { file_path: "~/.ssh/id_rsa" })).code, 2);
  assert.equal(hook(call("Glob", { pattern: "~/.ssh/*" })).code, 2);
  assert.equal(hook(call("Grep", { pattern: "x", path: "~" })).code, 2);
  assert.equal(hook(call("Grep", { pattern: "x", glob: "~/*" })).code, 2);
});

test("4B-6 (F4): braces in a path, or a glob brace alternative that steps up, is absolute or starts from home, are refused", () => {
  assert.equal(hook(call("Glob", { pattern: "{..,x}/{..,x}/credentials.json" })).code, 2);
  assert.equal(hook(call("Glob", { pattern: "{/etc/*,x}" })).code, 2);
  assert.equal(hook(call("Glob", { pattern: "src/{a,~/.ssh/*}" })).code, 2);
  assert.equal(hook(call("Glob", { pattern: "{a,{b, /etc/*}}" })).code, 2);
  assert.equal(hook(call("Glob", { pattern: "!/etc/*" })).code, 2);
  assert.equal(hook(call("Grep", { pattern: "x", glob: "{x,/Users/*/.ssh/*}" })).code, 2);
  assert.equal(hook(call("Read", { file_path: join(root, "{x}") })).code, 2);
  assert.equal(hook(call("Grep", { pattern: "x", path: join(root, "{src}") })).code, 2);
  // a brace in Grep's own pattern (a regex) is fine
  assert.equal(hook(call("Grep", { pattern: "a{1,2}" }, join(root, "src"))).code, 0);
});

test("author decision 2026-11-09: glob braces that stay inside the searched directory are allowed (agents write them by habit)", () => {
  // (in src: the fixture root holds a link that points outside, refused for that reason alone)
  const src = join(root, "src");
  assert.equal(hook(call("Glob", { pattern: "{a,b}.ts", path: src })).code, 0);
  assert.equal(hook(call("Glob", { pattern: "**/*.{ts,tsx,js}", path: src })).code, 0);
  assert.equal(hook(call("Grep", { pattern: "x", path: src, glob: "*.{html,js,json}" })).code, 0);
  assert.equal(hook(call("Grep", { pattern: "x", path: src, glob: "!{**/node_modules/**,**/dist/**,**/*.min.*,**/package-lock.json}" })).code, 0);
});

test("4B-6 (F6): an uncaught exception in the guard exits 2 (blocks); main installs the handler first", () => {
  const script = `import(${JSON.stringify(FILE_GUARD_SCRIPT)}).then((m) => { m.installCrashGuard(); setTimeout(() => { throw new Error("late failure"); }, 10); });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15_000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Blocked by Slack Off: guard error: late failure/);
  const src = readText(FILE_GUARD_SCRIPT, "utf8");
  const main = src.slice(src.indexOf("function main() {"));
  assert.match(main, /^function main\(\) \{\n {2}installCrashGuard\(\);/);
});

test("4B-6 (F7): the self-check refuses a guard that resolves paths without following symlinks", async () => {
  const dir = mkdtempSync(join("/private/var/tmp", "slackoff-fg7-"));
  try {
    const naive = join(dir, "naive-guard.mjs");
    // checks the lexical path only: an in-root symlink to outside passes
    writeFileSync(naive, `import { readFileSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
const arg = process.argv.find((a) => a.startsWith("--slackoff-files="));
const { roots } = JSON.parse(Buffer.from(arg.slice(17), "base64url").toString());
const input = JSON.parse(readFileSync(0, "utf8"));
const p = input.tool_input.file_path ?? input.tool_input.path;
if (typeof p !== "string") process.exit(2);
const r = resolve(p);
process.exit(roots.some((root) => { const x = relative(root, r); return x === "" || (!x.startsWith("..") && !isAbsolute(x)); }) ? 0 : 2);
`);
    await assert.rejects(fileGuardSelfCheck(fileGuardSettings({ roots: [ticketDir] }, { script: naive }), dir), /File guard self-check failed/);
    await fileGuardSelfCheck(fileGuardSettings({ roots: [ticketDir] }), dir);
    assert.deepEqual(readdirSync(dir).sort(), ["naive-guard.mjs"], "the self-check's scratch dir is removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { readdirSync, rmSync } from "node:fs";

// ---------------------------------------------------------------- final fix pass (ruling F4B-1)

import { checkFileCall, WALK_MAX_ENTRIES } from "../src/executor/file-guard-hook.mjs";

// A second root with trees of its own (the api root above holds links out of it on purpose).
const webRoot = join(ticketDir, "web");
const tree = (name: string) => {
  const d = join(webRoot, name);
  mkdirSync(join(d, "sub", "deep"), { recursive: true });
  writeFileSync(join(d, "sub", "deep", "f.ts"), "export {};\n");
  return d;
};
// a planted absolute link to an outside file, deep in the tree
const fileOut = tree("file-out");
symlinkSync(creds, join(fileOut, "sub", "deep", "notes.txt"));
// a committed relative link to an outside dir
const dirOut = tree("dir-out");
symlinkSync("../../../../../../home", join(dirOut, "sub", "homedir"));
// a dangling link pointing outside
const danglingOut = tree("dangling-out");
symlinkSync(join(scratch, "home", "nothing-yet.json"), join(danglingOut, "sub", "later.json"));
// links that stay inside the roots: a file, a dir in the other root, and a loop
const inOnly = tree("in-only");
symlinkSync("deep/f.ts", join(inOnly, "sub", "f-link.ts"));
symlinkSync(join(root, "src"), join(inOnly, "sub", "api-src"));
symlinkSync("..", join(inOnly, "sub", "deep", "loop"));
// an in-root link to a dir outside the searched tree that itself holds a link out
const hop = tree("hop");
const hopTarget = tree("hop-target");
symlinkSync(creds, join(hopTarget, "sub", "c.json"));
symlinkSync(hopTarget, join(hop, "sub", "elsewhere"));

const walkRoots = [ticketDir];
const grepAt = (p: string) => call("Grep", { pattern: "version", path: p, output_mode: "content" });
const globAt = (cwd: string) => call("Glob", { pattern: "**/*" }, cwd);

test("F4B-1: Grep and Glob over a tree holding a link to an outside file are refused (the link is deep in the tree)", () => {
  for (const input of [grepAt(fileOut), globAt(fileOut), call("Grep", { pattern: "version", output_mode: "content" }, fileOut), call("Glob", { pattern: "**/*", path: fileOut })]) {
    const r = hook(input, walkRoots);
    assert.equal(r.code, 2, `${input.tool_name}: ${r.stderr}`);
    assert.match(r.stderr, /symbolic link .*outside/);
  }
});

test("F4B-1: Grep and Glob over a tree holding a (relative) link to an outside dir, or a dangling link out, are refused", () => {
  for (const d of [dirOut, danglingOut]) {
    assert.equal(hook(grepAt(d), walkRoots).code, 2, d);
    assert.equal(hook(globAt(d), walkRoots).code, 2, d);
  }
});

test("F4B-1: a link to an in-root dir is walked too: an outside link there is refused", () => {
  assert.equal(hook(grepAt(hop), walkRoots).code, 2);
  assert.equal(hook(globAt(hop), walkRoots).code, 2);
});

test("F4B-1: a tree with only in-root links (a file, a dir in another root, a loop) is allowed", () => {
  const r = hook(grepAt(inOnly), walkRoots);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(hook(globAt(inOnly), walkRoots).code, 0);
  // Read of a plain file is not walked
  assert.equal(hook(call("Read", { file_path: join(fileOut, "sub", "deep", "f.ts") }), walkRoots).code, 0);
});

test("F4B-1: a tree over the entry cap is refused; the cap is 50k entries", () => {
  assert.equal(WALK_MAX_ENTRIES, 50_000);
  const big = join(webRoot, "big");
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < 30; i++) writeFileSync(join(big, `f${i}.ts`), "");
  const roots = [realpathSync(ticketDir)];
  assert.throws(() => checkFileCall(grepAt(big), roots, { maxEntries: 20 }), /too many entries/);
  assert.throws(() => checkFileCall(globAt(big), roots, { maxEntries: 20 }), /too many entries/);
  checkFileCall(grepAt(big), roots, { maxEntries: 40 });
});
