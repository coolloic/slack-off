import { isAbsolute } from "node:path";
import { ISOLATION_ARGS, isValidModelName, PERMISSION_MODE, PERMISSION_PROMPTS, SandboxPolicyError } from "./sandbox.ts";
import type { ExecRequest } from "./types.ts";

/** CLI flags a request may add (ExecRequest.extraArgs). */
const EXTRA_ARGS = new Set(["--no-session-persistence"]);

/**
 * Phase 4b (ruling B-1): the `claude` argv of a request — every sandbox and guard flag — shared by the subscription
 * and the API-key executors, so both run the CLI with exactly the same arguments. The command prefix (the CLI itself,
 * or [node, script] in tests) is not included. `model` (config executor.model): "" = Claude Code's default.
 * A request outside the sandbox rules gives the SandboxPolicyError instead (nothing may be spawned).
 */
export function buildClaudeArgs(req: ExecRequest, model: string): { args: string[] } | { error: SandboxPolicyError } {
  const fail = (m: string) => ({ error: new SandboxPolicyError(m) });
  const args = ["-p", req.prompt, "--output-format", "stream-json", "--verbose", "--append-system-prompt", req.systemPrompt];
  if (model !== "") {
    // config validation already enforces this; never hand the CLI something that could read as a flag
    if (!isValidModelName(model)) return fail(`invalid model name ${JSON.stringify(model)}`);
    args.push("--model", model);
  }
  if (req.chrome) args.push("--chrome");
  const tools = req.chrome && !req.allowedTools.includes("ToolSearch") ? ["ToolSearch", ...req.allowedTools] : req.allowedTools;
  const builtin = req.chrome && !req.tools.includes("ToolSearch") ? ["ToolSearch", ...req.tools] : req.tools;
  const denied = req.disallowedTools;
  if (denied.length === 0) return fail("refusing to run without a deny list");
  const overlap = tools.filter((t) => denied.includes(t));
  if (overlap.length > 0) return fail(`refusing to allow denied tool(s): ${overlap.join(", ")}`);
  // Sandbox baseline (F-I1): explicit non-auto-accepting mode, nothing can prompt, built-ins restricted, deny list.
  args.push(...ISOLATION_ARGS);
  args.push("--permission-mode", PERMISSION_MODE, "--permission-prompts", PERMISSION_PROMPTS);
  args.push("--tools", ...(builtin.length > 0 ? builtin : [""]));
  args.push("--disallowedTools", ...denied);
  if (tools.length > 0) args.push("--allowedTools", ...tools);
  if (req.restricted) args.push("--restricted");
  for (const d of req.addDirs) {
    if (!isAbsolute(d) || d.includes("\0") || d.startsWith("-")) return fail(`invalid --add-dir ${JSON.stringify(d)}`);
    args.push("--add-dir", d);
  }
  if (req.settingsJson !== null) {
    let ok = false;
    try {
      const v: unknown = JSON.parse(req.settingsJson);
      ok = v !== null && typeof v === "object" && !Array.isArray(v) && !req.settingsJson.includes("\0");
    } catch {
      // not JSON
    }
    if (!ok) return fail("invalid --settings JSON");
    args.push("--settings", req.settingsJson);
  }
  for (const a of req.extraArgs ?? []) {
    if (!EXTRA_ARGS.has(a)) return fail(`refusing CLI flag ${JSON.stringify(a)}`);
    if (!args.includes(a)) args.push(a);
  }
  // the CLI runs `<prefix> '<command>'` through its shell: only a plain absolute path
  if (req.shellPrefix !== undefined && !/^\/[A-Za-z0-9._/-]+$/.test(req.shellPrefix)) {
    return fail(`invalid shell prefix ${JSON.stringify(req.shellPrefix)}`);
  }
  return { args };
}
