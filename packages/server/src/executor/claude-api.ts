import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { API_CHROME } from "../config.ts";
import { redactKnown, redactorWith } from "../credentials/credential-store.ts";
import { buildClaudeArgs } from "./claude-args.ts";
import { AgentProcesses, allowlistedEnv, ClaudeCodeExecutor, defaultAgentProcesses, isolatedEnv, resolveOnServerPath, runClaudeProcess } from "./claude-code.ts";
import { SandboxPolicyError } from "./sandbox.ts";
import { AgentInterruptedError, ExecutorUnavailableError, type AgentEvent, type ExecRequest, type ExecResult, type Executor } from "./types.ts";

/**
 * Phase 4b decided values (docs/spikes/2026-11-api-modes.md).
 * API_KEY_DELIVERY 'helper' (ruling 4B-11; task 6 found the key readable in claude's environment from inside the
 * sandboxes through KERN_PROCARGS2): the key reaches claude only through the platform's apiKeyHelper script, merged
 * into the run's --settings; it is never in any environment. Whether the CLI honours apiKeyHelper with
 * `--setting-sources ""` is not verified → exit check; if it does not, the run fails as "key rejected" (never env).
 */
export const API_KEY_DELIVERY: "env" | "helper" = "helper";
/** API_AUTH_ERROR: with an invalid key the CLI exits non-zero and its result text says "Invalid API key". */
export const API_AUTH_ERROR = /Invalid API key/i;
/**
 * F4B-3: the stream-json `init` event's `apiKeySource` an API-key run must report (the key came from our apiKeyHelper).
 * Any other value — "none" (a subscription login, e.g. in the acceptance agent's own config dir), "ANTHROPIC_API_KEY"
 * — or no init event kills the run and fails it. Verified against the real CLI at the exit check (§8).
 */
export const API_KEY_SOURCE_HELPER = "apiKeyHelper";
/** ruling B-4 with API_CHROME 'unavailable': an API-key run never gets --chrome. */
export const API_CHROME_UNAVAILABLE = (API_CHROME as string) === "unavailable";

/** ruling B-2: the API mode's own Claude Code config dir, never the user's ~/.claude (no subscription login is read). */
export const apiConfigDir = (home: string): string => join(home, "claude-api-config");
/**
 * 4B-11: the key helper, in SLACKOFF_HOME but outside every dir a sandbox may reach (worktrees/<KEY>, the sandbox and
 * cache dirs): no sandbox kind can read, list or run it.
 */
export const apiKeyHelperPath = (home: string): string => join(home, "api-key-helper", "key-helper");
/** The program the helper runs: it reads credentials.json with the store's checks and prints the key. */
export const PRINT_API_KEY_SCRIPT = resolve(import.meta.dirname, "../credentials/print-api-key.ts");

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** `dir` created 0700 when missing; a symlink, a non-folder or another owner's folder is refused, a wider mode tightened. */
function ownDir(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid !== undefined && st.uid !== process.getuid())) {
    throw new ExecutorUnavailableError(`The API mode's ${name} folder must be a folder owned by you`);
  }
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return dir;
}

/**
 * 4B-11: (re)write the key helper on every API run — `#!/bin/sh` that runs print-api-key.ts with this server's node
 * and an empty environment. It holds no key. Written 0700 to a fresh temp file (O_EXCL, O_NOFOLLOW), then renamed.
 */
export function writeApiKeyHelper(home: string): string {
  const file = apiKeyHelperPath(home);
  ownDir(resolve(file, ".."), "key helper");
  const body = [
    "#!/bin/sh",
    "# Slack Off (ruling 4B-11): Claude Code's apiKeyHelper in API-key mode; prints the key from credentials.json.",
    `exec /usr/bin/env -i PATH=/usr/bin:/bin ${shq(process.execPath)} ${shq(PRINT_API_KEY_SCRIPT)} ${shq(home)}`,
    "",
  ].join("\n");
  const tmp = `${file}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o700);
  renameSync(tmp, file);
  return file;
}

/** The run's --settings with the key helper merged in (the request's own settings, e.g. guard hooks, kept). */
function withKeyHelper(settingsJson: string | null, helper: string): string {
  const base = settingsJson === null ? {} : (JSON.parse(settingsJson) as Record<string, unknown>);
  return JSON.stringify({ ...base, apiKeyHelper: shq(helper) });
}

/**
 * Phase 4b (ruling B-1): the same `claude` CLI as ClaudeCodeExecutor — the same argv (buildClaudeArgs) but for the
 * key helper in --settings, the same spawn, stream, timeout and abort handling (runClaudeProcess) — authenticated
 * with the Anthropic API key from credentials.json (4B-11: through apiKeyHelper) instead of the subscription login.
 * Every line the CLI prints, and every error, is redacted of the key before it is logged, parsed, emitted or thrown.
 */
export class ClaudeApiExecutor implements Executor {
  readonly kind = "claude-api" as const;
  readonly #cmd: string[];
  readonly #home: string;
  readonly #apiKey: () => string | null;
  readonly #processes: AgentProcesses;
  readonly #model: string;

  /** `claudeBin`: the executable, or a command prefix such as [node, script] (tests). `apiKey` is read on every exec
   * (to refuse a run without a key, and for redaction); claude itself gets the key from the helper. */
  constructor(claudeBin: string | readonly string[], o: { home: string; apiKey: () => string | null; processes?: AgentProcesses; model?: string }) {
    this.#cmd = typeof claudeBin === "string" ? [claudeBin] : [...claudeBin];
    this.#home = o.home;
    this.#apiKey = o.apiKey;
    this.#processes = o.processes ?? defaultAgentProcesses;
    this.#model = o.model ?? "";
  }

  exec(req: ExecRequest, onEvent: (e: AgentEvent) => void): Promise<ExecResult> {
    if (this.#processes.stopping) return Promise.reject(new AgentInterruptedError());
    if (req.signal?.aborted) return Promise.reject(new AgentInterruptedError("agent run aborted"));
    const [bin, ...prefix] = this.#cmd;
    // the request as it is (the settings JSON included) first, so a bad request is refused as it would be by subscription
    const checked = buildClaudeArgs(req, this.#model);
    if ("error" in checked) return Promise.reject(checked.error);
    // B-4: config validation already requires jira.source 'api' with this executor; a chrome run is still refused here
    if (req.chrome && API_CHROME_UNAVAILABLE) {
      return Promise.reject(new ExecutorUnavailableError("The API executor cannot drive Chrome: use the JIRA API mode (Settings → JIRA)"));
    }
    let key: string | null;
    try {
      key = this.#apiKey();
    } catch (err) {
      // a credentials.json that fails its checks: its own message (CredentialFileError: no path, no content)
      return Promise.reject(new ExecutorUnavailableError(`The Anthropic API key cannot be read: ${redactKnown((err as Error).message)}`));
    }
    if (key === null || key === "") return Promise.reject(new ExecutorUnavailableError("Set your Anthropic API key in Settings → Executor"));
    const redact = redactorWith([key]);

    let helper: string;
    try {
      helper = writeApiKeyHelper(this.#home);
    } catch (err) {
      return Promise.reject(err instanceof ExecutorUnavailableError ? err : new ExecutorUnavailableError(`The API key helper cannot be written (${(err as NodeJS.ErrnoException).code ?? "error"})`));
    }
    const built = buildClaudeArgs({ ...req, settingsJson: withKeyHelper(req.settingsJson, helper) }, this.#model);
    if ("error" in built) return Promise.reject(built.error);

    let env: NodeJS.ProcessEnv;
    let file = bin as string;
    if (req.env !== undefined && req.env !== null) {
      // Task 7: the isolated acceptance environment as it is (4B-11: no key in it; CLAUDE_CONFIG_DIR stays the
      // acceptance agent's own dir)
      const e = isolatedEnv(req.env, req.shellPrefix);
      if (typeof e === "string") return Promise.reject(new SandboxPolicyError(e));
      env = e;
      const resolved = resolveOnServerPath(file);
      if (resolved === null) return Promise.reject(new ExecutorUnavailableError(`Claude CLI not found: ${file}`));
      file = resolved;
    } else {
      let configDir: string;
      try {
        configDir = ownDir(apiConfigDir(this.#home), "Claude config (claude-api-config)");
      } catch (err) {
        return Promise.reject(err instanceof ExecutorUnavailableError ? err : new ExecutorUnavailableError(`The API mode's Claude config folder cannot be made (${(err as NodeJS.ErrnoException).code ?? "error"})`));
      }
      // 4B-11 (2): the allowlist, the platform's config dir and, for the dev agent, its sandbox wrapper; nothing else
      const base = allowlistedEnv();
      if (base instanceof Error) return Promise.reject(base);
      env = base;
      if (req.shellPrefix !== undefined) env.CLAUDE_CODE_SHELL_PREFIX = req.shellPrefix;
      env.CLAUDE_CONFIG_DIR = configDir;
    }

    return runClaudeProcess(file, [...prefix, ...built.args], env, req, this.#processes, onEvent, {
      bin: bin as string,
      // 4B-11: a CLI that ignored the helper reports no login: the same visible failure, never a fallback to env
      authError: ({ code, text, authFailed }) =>
        code !== 0 && (authFailed || API_AUTH_ERROR.test(text) || text.includes("Not logged in"))
          ? new ExecutorUnavailableError("The Anthropic API key was rejected — update it in Settings")
          : null,
      redact,
      checkInit: apiKeySourceCheck,
    });
  }
}

/**
 * F4B-3: the init event of an API-key run must report API_KEY_SOURCE_HELPER; anything else (a subscription login, an
 * environment key, nothing) is a run on credentials the developer did not choose here.
 */
export function apiKeySourceCheck(init: Record<string, unknown> | null): Error | null {
  const v = init?.apiKeySource;
  if (v === API_KEY_SOURCE_HELPER) return null;
  const said = typeof v === "string" ? `reported apiKeySource ${JSON.stringify(v.slice(0, 40))}` : "did not report its apiKeySource";
  return new ExecutorUnavailableError(
    `Stopped: this run was not authenticated with your Anthropic API key (Claude Code ${said}, expected "${API_KEY_SOURCE_HELPER}"), so it could have used another login. Check the key in Settings → Executor.`,
  );
}

/**
 * main.ts: one Executor whose kind and implementation follow config.executor on every call (no restart). `pinned()`
 * (4B-11 (3)) gives the concrete executor for the current setting: runAgent takes it once per run, so a retry keeps
 * the kind the run started with.
 */
export function configuredExecutor(o: {
  config: () => { kind: "claude-code" | "claude-api"; claudeBin: string | readonly string[]; model: string };
  home: string;
  apiKey: () => string | null;
  processes: AgentProcesses;
}): Executor & { pinned(): Executor } {
  const current = (): Executor => {
    const c = o.config();
    return c.kind === "claude-api"
      ? new ClaudeApiExecutor(c.claudeBin, { home: o.home, apiKey: o.apiKey, processes: o.processes, model: c.model })
      : new ClaudeCodeExecutor(c.claudeBin, o.processes, { model: c.model });
  };
  return {
    get kind() {
      return o.config().kind;
    },
    exec: (req, onEvent) => current().exec(req, onEvent),
    pinned: current,
  };
}
