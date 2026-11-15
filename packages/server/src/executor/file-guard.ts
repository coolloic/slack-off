// Phase 4b fix round 1 (ruling 4B-4): the file-tool guard. Claude Code's Read / Edit / Write / MultiEdit / Grep / Glob /
// NotebookEdit run in the unsandboxed `claude` process; `--restricted` compares the path as named, so a symlink in the
// worktree (`x -> ../../../credentials.json`, made by the agent's Bash or shipped in the repo) would reach any file.
// file-guard-hook.mjs is an exec-form PreToolUse hook that realpaths every path and refuses anything outside the run's
// roots (the ticket dir for implement-ticket, the work dir for acceptance, cwd + add-dirs for the read-only roles).
// It is self-checked before every run, like the navigation and spec guards.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_TOOLS } from "./file-guard-hook.mjs";
import { SandboxPolicyError } from "./sandbox.ts";

/** The executed hook: plain JavaScript, node: built-ins only. */
export const FILE_GUARD_SCRIPT: string = fileURLToPath(new URL("./file-guard-hook.mjs", import.meta.url));
export const FILE_GUARD_TOOLS: ReadonlySet<string> = new Set(FILE_TOOLS);

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

type HookSettings = { hooks?: { PreToolUse?: unknown[] } & Record<string, unknown> } & Record<string, unknown>;

/** `--settings` JSON installing the guard on the file tools in exec form (the server's own absolute Node). */
export function fileGuardSettings(o: { roots: readonly string[] }, paths: { node?: string; script?: string } = {}): string {
  if (o.roots.length === 0) throw new SandboxPolicyError("the file guard needs at least one root");
  for (const r of o.roots) {
    if (!isAbsolute(r) || dirname(resolve(r)) === resolve(r)) throw new SandboxPolicyError(`the file guard root ${JSON.stringify(r)} must be an absolute directory below /`);
  }
  const hook = {
    type: "command",
    command: paths.node ?? process.execPath,
    args: ["--disable-sigusr1", paths.script ?? FILE_GUARD_SCRIPT, `--slackoff-files=${b64({ roots: o.roots })}`],
    timeout: 30,
  };
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: FILE_TOOLS.join("|"), hooks: [hook] }] } });
}

/** One settings JSON with both PreToolUse lists, `first`'s entries first (its own self-check reads entry 0). */
export function mergeHookSettings(first: string | null, second: string): string {
  if (first === null) return second;
  const a = JSON.parse(first) as HookSettings;
  const b = JSON.parse(second) as HookSettings;
  return JSON.stringify({
    ...a,
    hooks: { ...(a.hooks ?? {}), PreToolUse: [...(a.hooks?.PreToolUse ?? []), ...(b.hooks?.PreToolUse ?? [])] },
  });
}

/** Runs an exec-form hook (no shell) with `input` on stdin (15 s limit). */
function runExecHook(command: string, args: readonly string[], input: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: null, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * Runs the exact hook from `settingsJson` (its file-guard entry) with calls it must block; throws unless each exits 2.
 * 4B-6 (F7): the same interpreter and script also run against a scratch root (made in `scratchParent`, removed after)
 * holding a symlink to a file outside it — refused — and a plain file — allowed: a guard that does not follow links
 * fails here.
 */
export async function fileGuardSelfCheck(settingsJson: string, scratchParent: string): Promise<void> {
  const fail = (why: string): never => {
    throw new SandboxPolicyError(`File guard self-check failed: ${why}`);
  };
  let hook: { command?: unknown; args?: unknown } | undefined;
  try {
    const list = (JSON.parse(settingsJson) as { hooks?: { PreToolUse?: Array<{ matcher?: unknown; hooks?: Array<{ command?: unknown; args?: unknown }> }> } }).hooks?.PreToolUse ?? [];
    hook = list.find((e) => e.matcher === FILE_TOOLS.join("|"))?.hooks?.[0];
  } catch {
    fail("settings are not JSON");
  }
  const command = hook?.command;
  const args = hook?.args;
  if (typeof command !== "string" || command === "") return fail("no hook command");
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return fail("the hook is not in exec form (command + args)");
  const configAt = (args as string[]).findIndex((a) => a.startsWith("--slackoff-files="));
  if (configAt < 0) return fail("the hook has no --slackoff-files configuration");
  // the dirs this check creates are removed after it (it leaves nothing behind)
  const created = mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(mkdtempSync(join(scratchParent, "file-guard-check-")));
  try {
    const root = join(scratch, "root");
    mkdirSync(root);
    writeFileSync(join(scratch, "outside.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(root, "inside.txt"), "ok\n");
    symlinkSync("../outside.json", join(root, "link.json"));
    const scratchArgs = (args as string[]).map((a, i) => (i === configAt ? `--slackoff-files=${b64({ roots: [root] })}` : a));
    const outside = "/slackoff-file-guard-selfcheck/credentials.json";
    const probes: Array<{ what: string; args: string[]; tool: string; input: Record<string, unknown>; want: number }> = [
      { what: "a Read outside the roots", args: args as string[], tool: "Read", input: { file_path: outside }, want: 2 },
      { what: "a Write outside the roots", args: args as string[], tool: "Write", input: { file_path: outside, content: "x" }, want: 2 },
      { what: "a Read without a path", args: args as string[], tool: "Read", input: {}, want: 2 },
      { what: "a Read through an in-root symlink to outside", args: scratchArgs, tool: "Read", input: { file_path: join(root, "link.json") }, want: 2 },
      { what: "a Read of a plain in-root file", args: scratchArgs, tool: "Read", input: { file_path: join(root, "inside.txt") }, want: 0 },
    ];
    // the probes run at once (one hook start each): this check precedes every run of a role with file tools
    const results = await Promise.all(
      probes.map((p) => runExecHook(command, p.args, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: p.tool, tool_input: p.input, cwd: root }))),
    );
    results.forEach((r, i) => {
      const p = probes[i]!;
      if (r.code !== p.want) fail(`${p.what} exited ${r.code} instead of ${p.want}${r.stderr.trim() ? ` (${r.stderr.trim().split("\n")[0]})` : ""}`);
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    // only the empty dirs this check created, deepest first (another job may have put its own dir there meanwhile)
    if (created !== undefined) {
      for (let d = resolve(scratchParent); ; d = dirname(d)) {
        try {
          rmdirSync(d);
        } catch {
          break;
        }
        if (d === resolve(created)) break;
      }
    }
  }
}

/**
 * Appended to the system prompt of every run that has Grep or Glob (run-agent). The guard refuses a glob with braces,
 * "..", an absolute path or a leading ~ (ruling 4B-6), and a refused call fails the whole run; agents write brace
 * patterns by habit (*.{ts,js}, or a negated brace list of folders), so they are told the rule up front instead of the rule
 * being loosened.
 */
export const FILE_GUARD_SEARCH_NOTE = [
  "",
  "",
  "## Searching files (Slack Off)",
  "In Glob patterns and in Grep's `glob` filter, stay inside the searched directory: never `..`, an absolute path, a leading `~`, or a brace alternative that starts with `/` or `~` (`*.{ts,js}` is fine). Slack Off's file guard refuses them, and a refused call fails the whole run.",
  "To skip a folder, use a negated glob such as `!**/node_modules/**`, or search a narrower `path`.",
].join("\n");
