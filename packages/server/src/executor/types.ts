export type AgentEvent = { kind: "text" | "tool" | "status"; text: string };

export interface ExecRequest {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  /** `--tools`: built-in tools available at all ([] = none). */
  tools: string[];
  /** `--allowedTools`: pre-approved tools (never a denied one). */
  allowedTools: string[];
  chrome: boolean;
  rawLogPath: string;
  /** default 600_000 */
  timeoutMs?: number;
  /** `--disallowedTools`: the role policy's own deny list (P-C6); never empty */
  disallowedTools: string[];
  /** `--restricted`: confine the file tools to the cwd and `addDirs` */
  restricted: boolean;
  /** `--add-dir`: extra directories the file tools may reach */
  addDirs: string[];
  /** `--settings`: inline settings JSON (the navigation guard hook), null = none */
  settingsJson: string | null;
  /** R-LOCAL-3 / T5-1 (implement-ticket), T7-1 (acceptance-review): the sandboxed Bash wrapper, passed as
   * CLAUDE_CODE_SHELL_PREFIX */
  shellPrefix?: string;
  /**
   * Task 7 (acceptance-review): non-null → the child's environment is exactly the `keep` keys from the server's
   * environment, CLAUDE_CONFIG_DIR = claudeConfigDir and PATH = path.join(":") (plus CLAUDE_CODE_SHELL_PREFIX when
   * shellPrefix is set) and the fixed `set` values (T7-7); nothing else is passed. null / absent = the server's
   * environment without ANTHROPIC_API_KEY.
   */
  env?: { claudeConfigDir: string; keep: readonly string[]; path: readonly string[]; set?: Readonly<Record<string, string>> } | null;
  /** extra CLI flags (acceptance-review: ['--no-session-persistence']); only known flags are accepted */
  extraArgs?: readonly string[];
  /** aborting stops the run (abandoned acceptance, Task 9): the process group is killed, exec rejects with AgentInterruptedError */
  signal?: AbortSignal;
}

export interface ExecResult {
  text: string;
  usage: unknown;
  costUsd: number | null;
  /** tool names from result.permission_denials[].tool_name */
  permissionDenials: string[];
}

export interface Executor {
  /** agent_run.executor: the subscription login, or the same CLI with an Anthropic API key (phase 4b, B-1) */
  readonly kind: "claude-code" | "claude-api";
  exec(req: ExecRequest, onEvent: (e: AgentEvent) => void): Promise<ExecResult>;
  /** ruling 4B-11 (3): the concrete executor for the current setting; runAgent takes it once per run (absent = itself) */
  pinned?(): Executor;
}

/** The timeout of one agent run attempt unless the request sets its own (acceptance-review: acceptance.runTimeoutMs). */
export const DEFAULT_AGENT_TIMEOUT_MS = 600_000;
/** Attempts of one agent run unless the request sets retries: the first, and one retry after invalid output. */
export const DEFAULT_AGENT_ATTEMPTS = 2;

export class ExecutorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorUnavailableError";
  }
}

/** The agent was stopped because the server is shutting down (the run is closed by startup recovery), or its run was
 * aborted through ExecRequest.signal. */
export class AgentInterruptedError extends Error {
  constructor(message = "agent run interrupted by shutdown") {
    super(message);
    this.name = "AgentInterruptedError";
  }
}

/** A chrome run reached a page outside its allow list, or used a browser other than the configured one. */
export class NavigationViolationError extends Error {
  readonly detail: string[];
  constructor(detail: string[]) {
    super(`The browser agent left the allowed JIRA pages or browser: ${detail.join("; ")}`);
    this.name = "NavigationViolationError";
    this.detail = detail;
  }
}

/** Several Chrome browsers are connected and none is configured for JIRA (ruling S-2). */
export class BrowserChoiceRequiredError extends Error {
  constructor() {
    super("Choose the Chrome browser for JIRA in Settings");
    this.name = "BrowserChoiceRequiredError";
  }
}

/**
 * phase 4c (C-4, 4C-1 M2): the CLI's own wording of an exhausted subscription or rate limit, matched at the START of the
 * first line of the result text only (never stderr, never a mention further in): "Claude usage limit reached…",
 * "5-hour limit reached…", "You've hit your limit", and the API's 429 / rate_limit_error. Best effort: the wording is not stable.
 */
export const USAGE_LIMIT_RE =
  /^(?:claude\s+)?(?:usage limit reached|(?:5-hour|weekly|opus|sonnet) limit reached|you(?:'ve| have) (?:hit|reached) your (?:usage |rate )?limit|rate limit (?:reached|exceeded))|^(?:api error:?\s*)?429\b.*rate_limit_error|^api error:?\s*429\b/i;

/** The CLI reported its usage limit: the run failed, and new agent runs are paused (reason limit_reached). */
export class UsageLimitError extends Error {
  /** the first line of the CLI's text: what the pause and the blocked ticket say */
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "UsageLimitError";
    this.detail = detail;
  }
}

/** F4C-1 (I-1): what a failed run was billed (the CLI's error result still carries total_cost_usd and usage). */
export interface RunCost {
  usage: unknown;
  costUsd: number | null;
}

/** Attach the cost of a billed failure to its error, keeping the error's class (callers test instanceof). */
export function withRunCost<E extends Error>(err: E, cost: RunCost): E {
  Object.defineProperty(err, "runCost", { value: cost, enumerable: false, configurable: true });
  return err;
}

/** The cost attached by withRunCost (or a `runCost` field of the same shape); null when the error carries none. */
export function runCostOf(err: unknown): RunCost | null {
  const rc = (err as { runCost?: unknown } | null)?.runCost as Partial<RunCost> | undefined;
  if (rc === undefined || rc === null || typeof rc !== "object") return null;
  return { usage: rc.usage ?? null, costUsd: typeof rc.costUsd === "number" && Number.isFinite(rc.costUsd) ? rc.costUsd : null };
}
