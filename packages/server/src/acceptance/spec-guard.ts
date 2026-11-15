// Task 7: the acceptance spec guard (defense in depth). spec-guard-hook.mjs holds the scan and is the Claude Code
// PreToolUse hook on Bash: a command runs only when it is exactly one of the allowed `playwright test` forms and the
// specs are clean. The same scan runs before the platform's own re-run (Task 9). The real read / connect limits come
// from the acceptance sandbox every Bash command runs in (ruling T7-1), not from this scan: the Task 1 spike got a
// three-line dodge past it (spike §4.2).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SandboxPolicyError } from "../executor/sandbox.ts";
import { casesScaffoldDigest, caseViolations, checkExample, checkSpecCall, scaffoldDigest, specViolations } from "./spec-guard-hook.mjs";

export { casesScaffoldDigest, caseViolations, checkExample, checkSpecCall, scaffoldDigest, specViolations };

/** The executed hook: plain JavaScript, node: built-ins only. */
export const SPEC_GUARD_SCRIPT: string = fileURLToPath(new URL("./spec-guard-hook.mjs", import.meta.url));

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

export interface SpecGuardOptions {
  /** the run's work dir; the specs are in <workDir>/acceptance/specs */
  workDir: string;
  /** acceptCommandForms(workDir): the only Bash command lines allowed, verbatim */
  commands: readonly string[];
  /** scaffoldDigest of <workDir>/acceptance before the agent ran: files outside specs must stay as written */
  scaffold?: Readonly<Record<string, string>> | null;
  /** phase 4f: the repos of a cases run (then the cases rules apply instead of the specs rules; scaffold = casesScaffoldDigest) */
  cases?: ReadonlyArray<{ repo: string; library: string | null }> | null;
}

/**
 * `--settings` JSON installing the guard as the PreToolUse hook on Bash, in exec form (T7-3): `command` is the server's
 * own absolute Node and `args` the script and its configuration, so Claude Code starts it directly and never through
 * the agent's CLAUDE_CODE_SHELL_PREFIX (a sandboxed wrapper failing with a non-2 exit would let the call through).
 * `paths` exists for the self-check tests.
 */
export function specGuardSettings(o: SpecGuardOptions, paths: { node?: string; script?: string } = {}): string {
  const config = { workDir: o.workDir, commands: o.commands, scaffold: o.scaffold ?? null, cases: o.cases ?? null };
  const hook = {
    type: "command",
    command: paths.node ?? process.execPath,
    args: ["--disable-sigusr1", paths.script ?? SPEC_GUARD_SCRIPT, `--slackoff-spec=${b64(config)}`],
    timeout: 30,
  };
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } });
}

/** Runs an exec-form hook (no shell) with `input` on stdin (15 s limit). */
function runExecHook(command: string, args: readonly string[], input: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Runs the exact hook command from `settingsJson` with calls it must block; throws unless each exits 2. */
export async function specGuardSelfCheck(settingsJson: string): Promise<void> {
  const fail = (why: string): never => {
    throw new SandboxPolicyError(`Spec guard self-check failed: ${why}`);
  };
  let hook: { command?: unknown; args?: unknown } | undefined;
  try {
    hook = (JSON.parse(settingsJson) as { hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: unknown; args?: unknown }> }> } }).hooks?.PreToolUse?.[0]?.hooks?.[0];
  } catch {
    fail("settings are not JSON");
  }
  const command = hook?.command;
  const args = hook?.args;
  if (typeof command !== "string" || command === "") return fail("no hook command");
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return fail("the hook is not in exec form (command + args)");
  for (const c of ["playwright test --slackoff-selfcheck", "curl https://slackoff-guard-selfcheck.invalid/"]) {
    const r = await runExecHook(command, args as string[], JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: c } }));
    if (r.code !== 2) fail(`a disallowed command exited ${r.code} instead of 2${r.stderr.trim() ? ` (${r.stderr.trim().split("\n")[0]})` : ""}`);
  }
}
