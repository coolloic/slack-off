import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, createWriteStream, mkdirSync } from "node:fs";
import { describeStatus, describeToolUse } from "./activity.ts";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { redactKnown } from "../credentials/credential-store.ts";
import { buildClaudeArgs } from "./claude-args.ts";
import { SandboxPolicyError } from "./sandbox.ts";
import { AgentInterruptedError, DEFAULT_AGENT_TIMEOUT_MS, ExecutorUnavailableError, USAGE_LIMIT_RE, UsageLimitError, withRunCost } from "./types.ts";
import type { AgentEvent, ExecRequest, ExecResult, Executor } from "./types.ts";

export class ExecutorTimeoutError extends Error {
  constructor(ms: number) {
    super(`Claude Code timed out after ${ms} ms`);
    this.name = "ExecutorTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = DEFAULT_AGENT_TIMEOUT_MS;
const KILL_GRACE_MS = 5_000;

type Json = Record<string, unknown>;

/** Signal an agent's whole process group (agents are spawned detached, so the group id is the pid). */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // already gone
    }
  }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * The running agent processes (H2). On shutdown `stopAll` sends SIGTERM to each process group, waits up to
 * `graceMs`, then SIGKILLs what is left; runs it interrupts reject with AgentInterruptedError, and no new
 * agent is spawned afterwards.
 */
export class AgentProcesses {
  readonly #children = new Set<ChildProcess>();
  /** children stopAll/killAllSync signalled while they were still running */
  readonly #signalled = new WeakSet<ChildProcess>();
  #stopping = false;

  get stopping(): boolean {
    return this.#stopping;
  }

  /** True when the child was still running when shutdown signalled it (its exit is an interruption). */
  wasStopped(child: ChildProcess): boolean {
    return this.#signalled.has(child);
  }

  get size(): number {
    return this.#children.size;
  }

  add(child: ChildProcess): void {
    this.#children.add(child);
    child.once("exit", () => this.#children.delete(child));
  }

  async stopAll(graceMs = KILL_GRACE_MS): Promise<void> {
    this.#stopping = true;
    const children = [...this.#children];
    for (const c of children) {
      this.#signalled.add(c);
      signalGroup(c, "SIGTERM");
    }
    await Promise.all(
      children.map(
        (c) =>
          new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(t);
              signalGroup(c, "SIGKILL"); // grandchildren that outlived their parent
              resolve();
            };
            const t = setTimeout(() => {
              c.off("exit", done);
              signalGroup(c, "SIGKILL");
              if (exited(c)) resolve();
              else c.once("exit", () => resolve());
            }, graceMs);
            if (exited(c)) done();
            else c.once("exit", done);
          }),
      ),
    );
  }

  /** Last resort from a process 'exit' handler (synchronous): SIGKILL every remaining group. */
  killAllSync(): void {
    this.#stopping = true;
    for (const c of this.#children) {
      this.#signalled.add(c);
      signalGroup(c, "SIGKILL");
    }
  }
}

const defaultProcesses = new AgentProcesses();

/** The process registry agents are added to when none is given. */
export const defaultAgentProcesses = defaultProcesses;

/**
 * Ruling 4B-11 (2): the only server variables a (non-isolated) claude run gets — built from scratch, never
 * process.env minus a list: a secret in Slack Off's own environment (GH_TOKEN, AWS_*, …) would otherwise sit in
 * claude's environment, which sandboxed code can read through process inspection (KERN_PROCARGS2). Each executor adds
 * CLAUDE_CONFIG_DIR and the platform's CLAUDE_CODE_SHELL_PREFIX itself.
 */
export const CLAUDE_ENV_ALLOW: readonly string[] = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "TMPDIR", "SHELL",
  // 4B-12 (M1): behind a proxy or a corporate CA
  "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];
/** 4B-12 (M1): passed only when the URL carries no userinfo (a password there would be readable by sandboxed code). */
const PROXY_ENV: readonly string[] = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
export const PROXY_PASSWORD_REFUSED = "proxy URLs with a password are not supported — they would be readable by sandboxed code";
const hasUserinfo = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.username !== "" || u.password !== "";
  } catch {
    return v.includes("@"); // not a URL (host:port): an "@" can only be userinfo
  }
};
const CLAUDE_ENV_ALLOW_RE = /^LC_[A-Z_]+$/;
let fakeClaudeEnv = false;
/** tests only: also pass the fake CLI's FAKE_CLAUDE_* settings (never called by the server). */
export function passFakeClaudeEnvForTests(): void {
  fakeClaudeEnv = true;
}

/**
 * The allowlisted part of the server's environment for a claude run (4B-11 (2), 4B-12), or an
 * ExecutorUnavailableError (nothing may be spawned) when a proxy URL carries userinfo.
 */
export function allowlistedEnv(): NodeJS.ProcessEnv | ExecutorUnavailableError {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (PROXY_ENV.includes(k)) {
      if (hasUserinfo(v)) return new ExecutorUnavailableError(PROXY_PASSWORD_REFUSED);
      env[k] = v;
    } else if (CLAUDE_ENV_ALLOW.includes(k) || CLAUDE_ENV_ALLOW_RE.test(k) || (fakeClaudeEnv && k.startsWith("FAKE_CLAUDE_"))) {
      env[k] = v;
    }
  }
  return env;
}

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const PLAIN_PATH = /^\/[^\0\n\r:]*$/;

/** The isolated environment of ExecRequest.env, or an error message. */
export function isolatedEnv(e: NonNullable<ExecRequest["env"]>, shellPrefix: string | undefined): NodeJS.ProcessEnv | string {
  if (!PLAIN_PATH.test(e.claudeConfigDir)) return `invalid CLAUDE_CONFIG_DIR ${JSON.stringify(e.claudeConfigDir)}`;
  if (e.path.length === 0 || e.path.some((p) => !PLAIN_PATH.test(p))) return `invalid PATH entries ${JSON.stringify(e.path)}`;
  const env: NodeJS.ProcessEnv = {};
  for (const k of e.keep) {
    if (!ENV_KEY.test(k) || ["PATH", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SHELL_PREFIX", "ANTHROPIC_API_KEY"].includes(k)) return `refusing to keep ${JSON.stringify(k)}`;
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(e.set ?? {})) {
    if (!/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k) || /[\0\n\r]/.test(v)) return `refusing to set ${JSON.stringify(k)}`;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = e.claudeConfigDir;
  env.PATH = e.path.join(":");
  if (shellPrefix !== undefined) env.CLAUDE_CODE_SHELL_PREFIX = shellPrefix;
  return env;
}

/** A bare command name resolved on the server's own PATH (spawn would look it up on the child's restricted PATH). */
export function resolveOnServerPath(bin: string): string | null {
  if (bin.includes("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const f = join(dir, bin);
    try {
      accessSync(f, constants.X_OK);
      return f;
    } catch {
      // next
    }
  }
  return null;
}

/** How runClaudeProcess tells one executor's runs apart (its authentication and the text it may never pass on). */
export interface ClaudeProcessOptions {
  /** the CLI as configured, for the "not found" message */
  bin: string;
  /** the error for a run that failed authentication, or null when this failure is not one */
  authError: (o: { code: number | null; text: string; authFailed: boolean }) => Error | null;
  /**
   * phase 4b (API key): applied to every stdout line before it is logged, parsed or turned into an event, and to
   * every error message — so a CLI that echoes a secret passes it nowhere. Default: unchanged.
   */
  redact?: (text: string) => string;
  /**
   * F4B-3 (API key): checks the first stream-json `system`/`init` event; an error kills the run's process group at
   * once and fails the run with it. Also called with null when a run that otherwise succeeded printed no init event.
   */
  checkInit?: (init: Json | null) => Error | null;
}

/**
 * Spawn `file args` (detached: its own process group) with exactly `env`, stream its stream-json output into the raw
 * log and `onEvent`, and settle with its result. Timeout, abort and shutdown stop the whole group. Shared by the
 * subscription and the API-key executors; only `env` and `o` differ between them.
 */
export function runClaudeProcess(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  req: ExecRequest,
  processes: AgentProcesses,
  onEvent: (e: AgentEvent) => void,
  o: ClaudeProcessOptions,
): Promise<ExecResult> {
  const redact = o.redact ?? ((s: string) => s);
  const scrub = <E extends Error>(err: E): E => {
    if (o.redact === undefined) return err;
    err.message = redact(err.message);
    if (err.stack !== undefined) err.stack = redact(err.stack);
    return err;
  };
  mkdirSync(dirname(req.rawLogPath), { recursive: true });
  const log = createWriteStream(req.rawLogPath, { flags: "a" });

  return new Promise<ExecResult>((resolve, rejectRaw) => {
    const reject = (err: Error) => rejectRaw(scrub(err));
    // detached: its own process group, so shutdown/timeout can stop claude and everything it started
    const child = spawn(file, [...args], { cwd: req.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    processes.add(child);
    // Task 9 (abandon): the abort signal stops the whole group like a shutdown does
    let aborted = false;
    let abortKillTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (exited(child)) return;
      aborted = true;
      signalGroup(child, "SIGTERM");
      abortKillTimer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    log.on("error", (err) => {
      clearTimeout(timer);
      signalGroup(child, "SIGTERM");
      reject(err);
    });
    let result: Json | null = null;
    let authFailed = false;
    let initSeen = false;
    let initError: Error | null = null;
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | null = null;

    child.on("error", (err) => {
      spawnError = err;
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (raw) => {
      if (!raw.trim()) return;
      const line = redact(raw);
      log.write(line + "\n");
      let ev: Json;
      try {
        ev = JSON.parse(line) as Json;
      } catch {
        return;
      }
      if (ev.type === "system" && ev.subtype === "init" && !initSeen) {
        initSeen = true;
        initError = o.checkInit?.(ev) ?? null;
        if (initError !== null) {
          signalGroup(child, "SIGTERM");
          killTimer = setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
          return;
        }
      }
      if (initError !== null) return;
      if (ev.type === "result") result = ev;
      else if (ev.type === "assistant" && ev.error === "authentication_failed") authFailed = true;
      for (const e of toAgentEvents(ev)) {
        try {
          onEvent(e);
        } catch {
          // listener errors must not break the run
        }
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(abortKillTimer);
      req.signal?.removeEventListener("abort", onAbort);
      // grandchildren that outlived claude after an abort (or after F4B-3 stopped it)
      if (aborted || initError !== null) signalGroup(child, "SIGKILL");
      log.end(() => {
        if (aborted) {
          reject(new AgentInterruptedError("agent run aborted"));
          return;
        }
        if (initError !== null) {
          reject(initError);
          return;
        }
        // Interrupted only when shutdown signalled this child while it ran and it did not still finish cleanly;
        // a run that had already exited with its result is delivered (H2).
        const finished = code === 0 && result !== null && (result as Json).is_error !== true;
        if (processes.wasStopped(child) && !finished) {
          reject(new AgentInterruptedError());
          return;
        }
        if (timedOut) {
          reject(new ExecutorTimeoutError(timeoutMs));
          return;
        }
        if (spawnError) {
          if (spawnError.code === "ENOENT") {
            reject(new ExecutorUnavailableError(`Claude CLI not found: ${o.bin}`));
          } else {
            reject(spawnError);
          }
          return;
        }
        const res = result as Json | null;
        const text = typeof res?.result === "string" ? res.result : "";
        const auth = o.authError({ code, text, authFailed });
        if (auth !== null) {
          reject(auth);
          return;
        }
        if (!res) {
          reject(new Error(`claude exited with code ${code} and no result event. ${stderr.trim()}`.trim()));
          return;
        }
        if (res.is_error === true || code !== 0) {
          const failure = text || stderr.trim();
          // only the result text decides, and only its first 200 characters of the first line
          const firstLine = (text.split("\n")[0] ?? "").trim().slice(0, 200);
          const message = `claude failed (exit ${code}): ${failure}`;
          // phase 4c (C-4): an exhausted subscription / rate limit is its own error (it pauses new agent runs)
          const failed = res.is_error === true && USAGE_LIMIT_RE.test(firstLine) ? new UsageLimitError(message, firstLine) : new Error(message);
          // F4C-1 (I-1): an error result (error_max_turns, …) is billed like any other: its cost and usage go with the error
          reject(withRunCost(failed, { usage: res.usage ?? null, costUsd: typeof res.total_cost_usd === "number" ? res.total_cost_usd : null }));
          return;
        }
        const noInit = initSeen || o.checkInit === undefined ? null : o.checkInit(null);
        if (noInit !== null) {
          reject(noInit);
          return;
        }
        const denials = Array.isArray(res.permission_denials) ? res.permission_denials : [];
        resolve({
          text,
          usage: res.usage ?? null,
          costUsd: typeof res.total_cost_usd === "number" ? res.total_cost_usd : null,
          permissionDenials: denials
            .map((d) => (d as Json | null)?.tool_name)
            .filter((n): n is string => typeof n === "string"),
        });
      });
    });
  });
}

export class ClaudeCodeExecutor implements Executor {
  readonly kind = "claude-code" as const;
  readonly #cmd: string[];
  readonly #processes: AgentProcesses;
  readonly #model: string;

  /** `claudeBin` is the executable, or a command prefix such as [node, script] (used by tests).
   * `model` (config executor.model): passed as `--model` to every run; "" = Claude Code's default. */
  constructor(claudeBin: string | readonly string[], processes: AgentProcesses = defaultProcesses, opts: { model?: string } = {}) {
    this.#cmd = typeof claudeBin === "string" ? [claudeBin] : [...claudeBin];
    this.#processes = processes;
    this.#model = opts.model ?? "";
  }

  exec(req: ExecRequest, onEvent: (e: AgentEvent) => void): Promise<ExecResult> {
    if (this.#processes.stopping) return Promise.reject(new AgentInterruptedError());
    if (req.signal?.aborted) return Promise.reject(new AgentInterruptedError("agent run aborted"));
    const [bin, ...prefix] = this.#cmd;
    const built = buildClaudeArgs(req, this.#model);
    if ("error" in built) return Promise.reject(built.error);

    let env: NodeJS.ProcessEnv;
    let file = bin as string;
    if (req.env !== undefined && req.env !== null) {
      // Task 7: an isolated run (acceptance-review) gets exactly the listed variables, nothing of the server's
      const e = isolatedEnv(req.env, req.shellPrefix);
      if (typeof e === "string") return Promise.reject(new SandboxPolicyError(e));
      env = e;
      // spawn looks a bare name up on the child's PATH, which no longer has the CLI's directory
      const resolved = resolveOnServerPath(file);
      if (resolved === null) return Promise.reject(new ExecutorUnavailableError(`Claude CLI not found: ${file}`));
      file = resolved;
    } else {
      // 4B-11 (2): the allowlist only — no ANTHROPIC_* (subscription auth), no inherited CLAUDE_CODE_* (T7-2: no
      // CLAUDE_CODE_TMPDIR, so the cwd file stays in /tmp), no other secret of the server
      const base = allowlistedEnv();
      if (base instanceof Error) return Promise.reject(base);
      env = base;
      // the user's own Claude Code config dir, where their subscription login lives
      if (process.env.CLAUDE_CONFIG_DIR !== undefined) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
      // R-LOCAL-3 / T5-1: every Bash command of the dev agent runs through the platform's sandbox wrapper
      if (req.shellPrefix !== undefined) env.CLAUDE_CODE_SHELL_PREFIX = req.shellPrefix;
    }

    return runClaudeProcess(file, [...prefix, ...built.args], env, req, this.#processes, onEvent, {
      bin: bin as string,
      authError: ({ code, text, authFailed }) =>
        code === 1 && (authFailed || text.includes("Not logged in")) ? new ExecutorUnavailableError("Claude Code is not logged in. Run `claude` and /login.") : null,
      // 4B-12 (m1): a credential value the process knows (JIRA token, API key) never reaches a log, event or error
      redact: redactKnown,
    });
  }
}

function toAgentEvents(ev: Json): AgentEvent[] {
  if (ev.type === "system") {
    // only the start means anything to the developer; thinking_tokens and the like stay in the raw log
    const text = describeStatus(typeof ev.subtype === "string" ? ev.subtype : "");
    return text ? [{ kind: "status", text }] : [];
  }
  if (ev.type === "assistant") {
    const content = (ev.message as Json | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const out: AgentEvent[] = [];
    for (const b of content as Json[]) {
      if (b.type === "text" && typeof b.text === "string") out.push({ kind: "text", text: b.text });
      else if (b.type === "tool_use" && typeof b.name === "string") {
        // what the agent is doing, in words ("Reading blocks/header/header.js"); bookkeeping calls are not shown
        const input = b.input !== null && typeof b.input === "object" && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {};
        const text = describeToolUse(b.name, input);
        if (text) out.push({ kind: "tool", text });
      }
    }
    return out;
  }
  return [];
}
