import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentRole } from "@slackoff/shared";
import type { z } from "zod";
import type { EventBus } from "../http/events.ts";
import type { RepoContext } from "../projects/project-rules.ts";
import { assembleSystemPrompt } from "../prompts/prompt-store.ts";
import { killLeftovers } from "../acceptance/app-runner.ts";
import { casesScaffoldDigest, scaffoldDigest, SPEC_GUARD_SCRIPT, specGuardSelfCheck, specGuardSettings } from "../acceptance/spec-guard.ts";
import { runShimDir, sandboxSelfCheck, writeShellPrefix, type SandboxCheck, type SandboxScope } from "../sandbox/local-sandbox.ts";
import { browserViolations, computerViolations, multipleBrowsersReported, NAV_GUARD_SCRIPT, navGuardSelfCheck, navGuardSettings, navViolations, typedTexts } from "./nav-guard.ts";
import {
  ACCEPT_ENV_KEYS, ACCEPT_GIT_ENV, acceptCommandForms, caseCommandForms, assertWithinPolicy, JIRA_COMMENT_MAX_CHARS, SandboxPolicyError, type PolicyContext, type ToolPolicy,
} from "./sandbox.ts";
import { AgentInterruptedError, BrowserChoiceRequiredError, DEFAULT_AGENT_ATTEMPTS, NavigationViolationError, runCostOf, UsageLimitError, type Executor } from "./types.ts";
import { pauseUsage } from "../cost/budget-gate.ts";
import { isTicketKey, isTrialRole, WRITE_AGENT_ROLES } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { redactorFor } from "../credentials/credential-store.ts";
import { FILE_GUARD_SCRIPT, FILE_GUARD_SEARCH_NOTE, FILE_GUARD_TOOLS, fileGuardSelfCheck, fileGuardSettings, mergeHookSettings } from "./file-guard.ts";

/** F4D-1 (I1): the type of the raw log's first line, written by runAgent before the agent starts. */
export const SYSTEM_PROMPT_LINE = "slackoff_system_prompt";

export class InvalidAgentOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAgentOutputError";
  }
}

export class ToolDeniedError extends Error {
  readonly tools: string[];
  constructor(tools: string[]) {
    super(`Required tool(s) denied by Claude Code permissions: ${tools.join(", ")}`);
    this.name = "ToolDeniedError";
    this.tools = tools;
  }
}

export interface RunAgentDeps {
  db: DatabaseSync;
  repoRoot: string;
  executor: Executor;
  home: string;
  bus: EventBus;
  /** tests only: replace the guard's interpreter or script to exercise the self-check */
  navGuardPaths?: { node?: string; script?: string };
  /** tests only (4B-4): replace the file guard's interpreter or script to exercise its self-check */
  fileGuardPaths?: { node?: string; script?: string };
  /** T7-1: the server-side sandbox self-check run before an acceptance agent starts (default sandboxSelfCheck) */
  sandboxCheck?: (scope: SandboxScope) => Promise<SandboxCheck>;
  /** T7-5: every mapped repository path (config projects), read per call; an acceptance scope must deny each.
   * Absent → acceptance-review is refused. */
  mappedRepos?: () => readonly string[];
  /** phase 4c (C-3): checked before a run starts; throws UsagePausedError while usage is paused or over a threshold. Absent = no check. */
  gate?: { check(role: AgentRole): void };
}

/** acceptance-review only (Task 7): the agent's own Claude Code config dir and environment, and its sandbox. */
export interface AgentIsolation {
  /** the dedicated config dir (acceptance.claudeConfigDir), its CLAUDE_CONFIG_DIR */
  claudeConfigDir: string;
  /** <runRoot>/bin with the `playwright` shim: first on the agent's PATH, outside its work dir */
  shimDir: string;
  /** T7-1: the run's acceptance sandbox scope; every Bash command of the agent runs under it (CLAUDE_CODE_SHELL_PREFIX) */
  sandbox: SandboxScope;
}

export interface RunAgentRequest<T> {
  role: AgentRole;
  ticketKey?: string;
  prompt: string;
  cwd: string;
  allowedTools: string[];
  chrome: boolean;
  schema: z.ZodType<T>;
  timeoutMs?: number;
  /** affected repos: their rules and prompt overrides join the system prompt */
  repos?: readonly RepoContext[];
  /** read-only roles over several repos: cwd = the first repo, the others here. Never for implement-ticket (its cwd,
   * the ticket directory, holds every affected repo). */
  addDirs?: string[];
  /** per-run sandbox inputs: commands, forbidden paths, navigation allow list, pinned browser (P-C6) */
  policy?: PolicyContext;
  /** extra runs after an output that fails validation; default 1, and always 0 for a write role (T12-1) */
  retries?: number;
  /** R-LOCAL-3 / T5-1 (implement-ticket): the wrapper every Bash command runs through (CLAUDE_CODE_SHELL_PREFIX) */
  shellPrefix?: string;
  /**
   * phase 4b (4B-7), implement-ticket with shellPrefix only: the file the wrapper records each command's process group
   * in (writeShellPrefix pgidFile); after the run every recorded group still ours is killed (T7-8) and the file removed
   */
  pgidFile?: string;
  /**
   * phase 4a Task 6 (implement-ticket): why its Bash runs without the wrapper — the reason of the failed self-check
   * when development.allowUnsandboxedCommands is on. A Bash rule needs this or shellPrefix.
   */
  unsandboxedReason?: string;
  /** acceptance-review only (required there): isolated config dir, environment and sandbox */
  isolation?: AgentIsolation;
  /** aborting stops the agent (abandoned acceptance, Task 9): AgentInterruptedError */
  signal?: AbortSignal;
  /** phase 4d (agent_run.purpose): 'ticket' by default; 'trial' = a prompt draft tried on the sample ticket (Task 5) */
  purpose?: "ticket" | "discover" | "trial";
  /** phase 4d Task 5, trial only: the unsaved draft in place of the saved developer additions (never saved) */
  additionsOverride?: string;
  /** called once with the run id when agent_run is written (before the agent starts) */
  onRunStart?: (runId: string) => void;
}

/**
 * Phase 4d (D-7, D-8): a trial runs a read-only role with a draft, on no ticket and with no repository rules; a draft
 * goes only with a trial. Refused before anything runs.
 */
function checkTrial<T>(req: RunAgentRequest<T>): void {
  if (req.purpose !== "trial") {
    if (req.additionsOverride !== undefined) throw new SandboxPolicyError("an unsaved prompt draft is only used by a trial run");
    return;
  }
  if (!isTrialRole(req.role)) throw new SandboxPolicyError(`${req.role} cannot be tried on the sample ticket`);
  if (req.ticketKey !== undefined) throw new SandboxPolicyError("a trial run belongs to no ticket");
  if (req.repos !== undefined) throw new SandboxPolicyError("a trial run reads no repository rules");
  if (req.additionsOverride === undefined) throw new SandboxPolicyError("a trial run needs the draft");
  // F4D-1 (M7): the scratch copy is the only directory; nothing of development or acceptance goes with a trial
  if ((req.addDirs ?? []).length > 0) throw new SandboxPolicyError("a trial run reads no extra directories");
  if (req.policy?.workDir !== undefined) throw new SandboxPolicyError("a trial run has no acceptance work dir");
  if (req.pgidFile !== undefined) throw new SandboxPolicyError("a trial run records no process-group file");
  if (req.isolation !== undefined) throw new SandboxPolicyError("a trial run is never isolated like acceptance-review");
}

/**
 * phase 4a Task 6: an implement-ticket run whose Bash rules would run commands outside the sandbox by accident (a
 * caller that forgot the wrapper) is refused; only the developer's switch, passed as unsandboxedReason, allows it.
 */
function checkBashSandboxed<T>(req: RunAgentRequest<T>): void {
  if (req.role !== "implement-ticket") return;
  if (!req.allowedTools.some((t) => t === "Bash" || t.startsWith("Bash("))) return;
  if (req.shellPrefix !== undefined || (req.unsandboxedReason ?? "").trim() !== "") return;
  throw new SandboxPolicyError("implement-ticket: Bash is allowed but its commands are not sandboxed");
}

/** Roles that change something outside the platform: a re-run would repeat the change without a new confirmation. */
const WRITE_ROLES: ReadonlySet<AgentRole> = new Set(WRITE_AGENT_ROLES);

function retriesFor<T>(req: RunAgentRequest<T>): number {
  if (WRITE_ROLES.has(req.role)) {
    if ((req.retries ?? 0) !== 0) throw new SandboxPolicyError(`${req.role} is a write role: its runs are never retried`);
    return 0;
  }
  const n = req.retries ?? DEFAULT_AGENT_ATTEMPTS - 1;
  if (!Number.isInteger(n) || n < 0 || n > 3) throw new SandboxPolicyError(`invalid retries ${n}`);
  return n;
}

const inside = (path: string, dir: string): boolean => {
  const r = relative(resolve(dir), resolve(path));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

const COMPUTER = "mcp__claude-in-chrome__computer";
const sameOrInside = (path: string, dir: string): boolean => resolve(path) === resolve(dir) || inside(path, dir);

/** A chrome role allowed `computer` uses only its own actions (R5), guarded by the hook and the scan. */
const computerActionsOf = (policy: ToolPolicy): readonly string[] | null =>
  policy.chrome && policy.allowed.includes(COMPUTER) ? (policy.computerActions ?? []) : null;
const typeTextOf = (ctx: PolicyContext): string | null => ctx.typeText ?? null;

/** jira-comment (R8): exactly this ticket's page and a comment text of 1–2000 characters. */
function checkJiraComment<T>(req: RunAgentRequest<T>, ctx: PolicyContext): void {
  const key = req.ticketKey ?? "";
  if (!isTicketKey(key)) throw new SandboxPolicyError("jira-comment needs the ticket key");
  const allow = ctx.navAllow ?? [];
  let ok = allow.length === 1;
  if (ok) {
    try {
      const u = new URL(allow[0]!);
      ok = (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && u.search === "" && u.hash === "" && u.pathname.endsWith(`/browse/${key}`);
    } catch {
      ok = false;
    }
  }
  if (!ok) throw new SandboxPolicyError(`jira-comment may only be on its ticket's page (<base>/browse/${key})`);
  const t = ctx.typeText;
  if (typeof t !== "string" || t.trim() === "" || t.length > JIRA_COMMENT_MAX_CHARS) {
    throw new SandboxPolicyError(`jira-comment needs the comment text (1–${JIRA_COMMENT_MAX_CHARS} characters)`);
  }
}

const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/** Task 7 / T7-1, T7-5: acceptance-review's isolation is required, consistent and tied to this server (its
 * SLACKOFF_HOME and every mapped repository denied); any other role has none. */
function checkIsolation<T>(deps: RunAgentDeps, req: RunAgentRequest<T>, ctx: PolicyContext): AgentIsolation | null {
  const iso = req.isolation;
  if (req.role !== "acceptance-review") {
    if (iso !== undefined) throw new SandboxPolicyError(`${req.role} takes no acceptance isolation`);
    return null;
  }
  if (iso === undefined) throw new SandboxPolicyError("acceptance-review runs only with its isolation (config dir, environment, sandbox)");
  const workDir = ctx.workDir;
  if (workDir === undefined) throw new SandboxPolicyError("acceptance-review needs its work directory");
  if (resolve(req.cwd) !== resolve(workDir)) throw new SandboxPolicyError("acceptance-review runs in its work directory");
  if ((req.addDirs ?? []).length > 0) throw new SandboxPolicyError("acceptance-review takes no extra directories");
  if (req.shellPrefix !== undefined) throw new SandboxPolicyError("acceptance-review's Bash wrapper is made by runAgent");
  if (!isAbsolute(iso.claudeConfigDir) || !isAbsolute(iso.shimDir)) throw new SandboxPolicyError("acceptance-review: the config and shim dirs must be absolute");
  if (sameOrInside(iso.shimDir, workDir)) throw new SandboxPolicyError("acceptance-review: the shim dir must be outside the work dir");
  if (sameOrInside(iso.claudeConfigDir, workDir) || sameOrInside(workDir, iso.claudeConfigDir)) {
    throw new SandboxPolicyError("acceptance-review: the config dir must be outside the work dir");
  }
  const sb = iso.sandbox;
  if (sb.kind !== "acceptance" || sb.runRoot === undefined) throw new SandboxPolicyError("acceptance-review runs under the acceptance sandbox of its run");
  if (resolve(runShimDir(sb.runRoot)) !== resolve(iso.shimDir)) throw new SandboxPolicyError("acceptance-review: the shim dir is not the run's");
  if (!inside(workDir, sb.runRoot)) throw new SandboxPolicyError("acceptance-review: the work dir is not inside the run root");
  if (sb.acceptConfigDir === undefined || resolve(sb.acceptConfigDir) !== resolve(iso.claudeConfigDir)) {
    throw new SandboxPolicyError("acceptance-review: the sandbox must deny the agent's own config dir");
  }
  // T7-5: the scope's denies come from this server, not from the caller alone
  if (real(sb.home) !== real(deps.home)) throw new SandboxPolicyError("acceptance-review: the sandbox must deny this server's SLACKOFF_HOME");
  if (deps.mappedRepos === undefined) throw new SandboxPolicyError("acceptance-review needs the repository mapping to check its sandbox");
  const denied = new Set(sb.repos.map(real));
  const missing = deps.mappedRepos().filter((r) => !denied.has(real(r)));
  if (missing.length > 0) throw new SandboxPolicyError(`acceptance-review: the sandbox does not deny the mapped repositories ${missing.join(", ")}`);
  return iso;
}

function pinnedDevice(ctx: PolicyContext): string | null {
  return ctx.browser !== undefined && ctx.browser !== null && ctx.browser !== "list" ? ctx.browser.deviceId : null;
}

/** Deduplicated extra directories, without the cwd; refused for implement-ticket. */
function extraDirs<T>(req: RunAgentRequest<T>): string[] {
  const dirs = [...new Set(req.addDirs ?? [])].filter((d) => resolve(d) !== resolve(req.cwd));
  if (req.role === "implement-ticket" && dirs.length > 0) throw new SandboxPolicyError("implement-ticket works in the ticket directory only (no --add-dir)");
  return dirs;
}

/** The navigation guard hook for chrome roles, self-checked (T6-1); null when nothing is pinned or limited (phase-1 argv). */
async function guardSettings(
  policy: ToolPolicy,
  ctx: PolicyContext,
  writable: readonly string[],
  paths: { node?: string; script?: string } = {},
): Promise<string | null> {
  if (!policy.chrome) return null;
  const deviceId = pinnedDevice(ctx);
  const allow = ctx.navAllow ?? null;
  const computerActions = computerActionsOf(policy);
  if (deviceId === null && allow === null && computerActions === null) return null;
  const script = paths.script ?? NAV_GUARD_SCRIPT;
  if (writable.some((d) => inside(script, d))) throw new SandboxPolicyError("the navigation guard script must not be inside an agent directory");
  const o = { allow, deviceId, computerActions, typeText: computerActions !== null ? typeTextOf(ctx) : null };
  const settings = navGuardSettings(o, paths);
  await navGuardSelfCheck(settings, o);
  return settings;
}

/**
 * Phase 4b (ruling 4B-4): every role with Claude Code file tools gets the file guard — each path the tools name is
 * realpathed (symlinks followed) and must lie in `roots` (implement-ticket: the ticket dir; acceptance: the work dir;
 * read-only roles: cwd + add-dirs). Self-checked; null for a role without file tools.
 */
async function fileGuard(
  policy: ToolPolicy,
  roots: readonly string[],
  writable: readonly string[],
  scratchParent: string,
  paths: { node?: string; script?: string } = {},
): Promise<string | null> {
  if (!policy.builtin.some((t) => FILE_GUARD_TOOLS.has(t))) return null;
  const script = paths.script ?? FILE_GUARD_SCRIPT;
  if (writable.some((d) => sameOrInside(script, d))) throw new SandboxPolicyError("the file guard script must not be inside an agent directory");
  const settings = fileGuardSettings({ roots: [...new Set(roots.map(real))] }, paths);
  await fileGuardSelfCheck(settings, scratchParent);
  return settings;
}

/** The file guard self-check's scratch parent: in SLACKOFF_HOME, outside every agent dir. */
const guardScratch = (deps: RunAgentDeps): string => join(deps.home, "sandbox", "file-guard");

const withFileGuard = (first: string | null, files: string | null): string | null => (files === null ? first : mergeHookSettings(first, files));

/** Post-run checks of a chrome run's raw log, before its output is parsed (no retry on a violation). */
function checkChromeRun(policy: ToolPolicy, ctx: PolicyContext, rawLogPath: string): void {
  if (!policy.chrome) return;
  const deviceId = pinnedDevice(ctx);
  if ((ctx.browser ?? null) === null && multipleBrowsersReported(rawLogPath)) throw new BrowserChoiceRequiredError();
  const actions = computerActionsOf(policy);
  const found = [
    ...(deviceId !== null ? browserViolations(rawLogPath, deviceId) : []),
    ...(ctx.navAllow !== undefined ? navViolations(rawLogPath, ctx.navAllow) : []),
    ...(actions !== null ? computerViolations(rawLogPath, actions, { typeText: typeTextOf(ctx) }) : []),
  ];
  // jira-comment: the hook lets a repeated correct `type` through (spike §5), so exactly one type of exactly the text
  if (actions !== null && actions.includes("type")) {
    const typed = typedTexts(rawLogPath);
    if (typed.length !== 1 || typed[0] !== typeTextOf(ctx)) {
      found.push(`the comment must be typed exactly once with the given text (typed ${typed.length} times${typed.some((t) => t !== typeTextOf(ctx)) ? ", with other text" : ""})`);
    }
  }
  if (found.length > 0) throw new NavigationViolationError(found);
}

/** `ps -o lstart=` of `pid` (C locale, trimmed); "" when it is gone or unreadable. Same form as the wrapper's record. */
function lstartOf(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * T7-8: each record is `<pid>\t<lstart>` of a wrapper (a group leader: the CLI starts Bash commands detached). Its group
 * is killed when the leader is gone (a live group id cannot be handed out again, so what is left is ours) or alive with
 * the recorded start time; a live leader with another start time is a reused pid and left alone. A record without a
 * start time falls back to the run-root match (killLeftovers).
 */
export function killRecordedGroups(runRoot: string | null, pgidFile: string): void {
  let text = "";
  try {
    text = readFileSync(pgidFile, "utf8");
  } catch {
    return; // no Bash command ran
  }
  const fallback: number[] = [];
  const seen = new Set<number>();
  for (const line of text.split("\n")) {
    const [p, ...rest] = line.split("\t");
    const pgid = Number((p ?? "").trim());
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || seen.has(pgid)) continue;
    seen.add(pgid);
    const recorded = rest.join("\t").trim();
    if (recorded === "") {
      fallback.push(pgid);
      continue;
    }
    if (alive(pgid) && lstartOf(pgid) !== recorded) continue;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // the group is gone
    }
  }
  // a record without a start time is matched by its run root (acceptance); without one (development) it is left alone
  if (runRoot !== null) killLeftovers(runRoot, fallback);
}

/** 4B-7: a pgid file only with the development wrapper that writes it. */
function checkPgidFile<T>(req: RunAgentRequest<T>): void {
  if (req.pgidFile === undefined) return;
  if (req.role !== "implement-ticket" || req.shellPrefix === undefined || !isAbsolute(req.pgidFile)) {
    throw new SandboxPolicyError("a process-group record goes only with implement-ticket's shell prefix (absolute path)");
  }
}

/**
 * The acceptance agent's spec guard hook (self-checked) for its work dir, with the scaffold as it is now. Phase 4f: with
 * `cases` (command-line and library entries) the only command is `slackoff-cases run` and the cases rules apply.
 */
async function acceptanceSettings(workDir: string, writable: readonly string[], cases?: PolicyContext["acceptCases"]): Promise<string> {
  if (writable.some((d) => sameOrInside(SPEC_GUARD_SCRIPT, d))) throw new SandboxPolicyError("the spec guard script must not be inside an agent directory");
  const acc = join(workDir, "acceptance");
  const settings =
    cases !== undefined
      ? specGuardSettings({ workDir, commands: caseCommandForms(workDir), scaffold: casesScaffoldDigest(acc, cases), cases })
      : specGuardSettings({ workDir, commands: acceptCommandForms(workDir), scaffold: scaffoldDigest(acc) });
  await specGuardSelfCheck(settings);
  return settings;
}

/** T7-1: the server-side self-check for exactly this scope (it listens where the sandbox cannot), then the run's
 * Bash wrapper, written in SLACKOFF_HOME (outside the run root and every agent dir). */
async function acceptanceShell(deps: RunAgentDeps, iso: AgentIsolation): Promise<{ shellPrefix: string; dir: string; pgidFile: string }> {
  const check = await (deps.sandboxCheck ?? ((s: SandboxScope) => sandboxSelfCheck(s)))(iso.sandbox);
  if (!check.ok) throw new SandboxPolicyError(`isolation check failed: sandbox self-check (${check.detail})`);
  const dir = join(deps.home, "sandbox", "acceptance", basename(iso.sandbox.runRoot!));
  // in SLACKOFF_HOME: the sandbox can neither write it nor remove an entry
  const pgidFile = join(dir, "pgids");
  try {
    // T7-6: /bin/zsh, the shell the CLI picks without SHELL (the agent's env has none)
    return { shellPrefix: writeShellPrefix(dir, iso.sandbox, { shell: "/bin/zsh", pgidFile }), dir, pgidFile };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw new SandboxPolicyError(`isolation check failed: ${(err as Error).message}`);
  }
}

function extractJson(text: string): string {
  const m = /```json\s*\n([\s\S]*?)```/.exec(text);
  return m ? (m[1] as string).trim() : text.trim();
}

function validate<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (err) {
    // 4B-2: never JSON.parse's message — it quotes the start of the text, cut short where no redaction can find it
    const at = /at position (\d+)/.exec((err as Error).message)?.[1];
    return { ok: false, error: `Output is not valid JSON${at !== undefined ? ` (at position ${at})` : ""}` };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: parsed.error.message };
}

export async function runAgent<T>(deps: RunAgentDeps, req: RunAgentRequest<T>): Promise<T> {
  if (req.signal?.aborted) throw new AgentInterruptedError("agent run aborted");
  // a trial's own refusals first, so they name the trial
  checkTrial(req);
  const ctx = req.policy ?? {};
  const policy = assertWithinPolicy(req.role, req.allowedTools, req.chrome, ctx);
  checkBashSandboxed(req);
  checkPgidFile(req);
  if (req.role === "jira-comment") checkJiraComment(req, ctx);
  const iso = checkIsolation(deps, req, ctx);
  const addDirs = extraDirs(req);
  const attempts = 1 + retriesFor(req);
  deps.gate?.check(req.role);
  if (iso === null) {
    const dirs = [req.cwd, ...addDirs];
    const settings = withFileGuard(await guardSettings(policy, ctx, dirs, deps.navGuardPaths), await fileGuard(policy, dirs, dirs, guardScratch(deps), deps.fileGuardPaths));
    if (req.pgidFile === undefined) return runChecked(deps, req, ctx, policy, addDirs, attempts, settings, null);
    try {
      return await runChecked(deps, req, ctx, policy, addDirs, attempts, settings, null);
    } finally {
      // 4B-7 (like T7-6 / T7-8 for acceptance): a command's process group that outlived the run is stopped
      killRecordedGroups(null, req.pgidFile);
      rmSync(req.pgidFile, { force: true });
    }
  }
  const writable = [req.cwd, iso.sandbox.runRoot!];
  const settingsJson = withFileGuard(await acceptanceSettings(ctx.workDir!, writable, ctx.acceptCases), await fileGuard(policy, [req.cwd], writable, guardScratch(deps), deps.fileGuardPaths))!;
  const shell = await acceptanceShell(deps, iso);
  try {
    return await runChecked(deps, req, ctx, policy, addDirs, attempts, settingsJson, { iso, shellPrefix: shell.shellPrefix });
  } finally {
    // T7-6: Claude Code runs each Bash command in its own process group, which outlives claude (abort, timeout, or a
    // command left running): stop every group the wrapper recorded, then remove the wrapper
    killRecordedGroups(iso.sandbox.runRoot!, shell.pgidFile);
    rmSync(shell.dir, { recursive: true, force: true });
  }
}

async function runChecked<T>(
  deps: RunAgentDeps,
  req: RunAgentRequest<T>,
  ctx: PolicyContext,
  policy: ToolPolicy,
  addDirs: string[],
  attempts: number,
  settingsJson: string | null,
  accept: { iso: AgentIsolation; shellPrefix: string } | null,
): Promise<T> {
  const { db, bus } = deps;
  // 4B-11 (3): one executor for the whole run — every attempt (and agent_run.executor) keeps the kind it started with
  const executor = deps.executor.pinned?.() ?? deps.executor;
  // phase 4b (4B-2): this run's redaction — the credentials file as it is now plus every value this process has seen
  const redact = redactorFor(deps.home);
  const trial = req.purpose === "trial";
  const sys = assembleSystemPrompt(db, deps.repoRoot, req.role, req.repos, req.additionsOverride !== undefined ? { additionsOverride: req.additionsOverride } : {});
  // what the agent gets, exactly (the logged sha256 is of this): plus the file guard's glob rule for any run that can search
  const systemPrompt = policy.builtin.some((t) => t === "Grep" || t === "Glob") ? sys.text + FILE_GUARD_SEARCH_NOTE : sys.text;
  const runId = randomUUID();
  const rawLogPath = join(deps.home, "runs", `${runId}.jsonl`);
  // F4D-1 (I1): the raw log's first line says which system prompt the agent got (it goes in through
  // --append-system-prompt, so claude's own stream never shows it): its sha256 and, redacted, the preference section.
  // Written before agent_run, so a failed write records nothing. The full prompt is never logged. Every reader of the
  // raw log skips this line: it has no message and no result.
  mkdirSync(dirname(rawLogPath), { recursive: true });
  writeFileSync(
    rawLogPath,
    `${JSON.stringify({
      type: SYSTEM_PROMPT_LINE,
      sha256: createHash("sha256").update(systemPrompt).digest("hex"),
      preferenceSection: sys.preferenceSection === null ? null : redact(sys.preferenceSection),
    })}\n`,
    { flag: "wx" },
  );
  // phase 4d: the preference summary version propose-solutions saw (null for every other role, or no summary); a
  // trial records its purpose and the hash of the unsaved draft (prompt_version_id is null: no saved version was used)
  const draftHash = trial ? createHash("sha256").update(req.additionsOverride ?? "").digest("hex").slice(0, 12) : null;
  db.prepare(
    `INSERT INTO agent_run (id, ticket_key, role, executor, skill_version, prompt_version_id, rules_hash, repo_prompt_hash, preference_version, purpose, draft_hash, status, raw_log_path, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    runId, req.ticketKey ?? null, req.role, executor.kind, sys.skillVersion, sys.promptVersionId, sys.rulesHash, sys.repoPromptHash, sys.preferenceVersion,
    req.purpose ?? "ticket", draftHash, rawLogPath, new Date().toISOString(),
  );
  if (trial) appendAudit(db, { actor: "developer", type: "prompt_trial_run", payload: { role: req.role, runId, draftLength: (req.additionsOverride ?? "").length } });
  req.onRunStart?.(runId);

  const finish = (status: "ok" | "invalid_output" | "error", denials: string[], error: string | null) => {
    db.prepare(
      `UPDATE agent_run SET status = ?, usage_json = ?, cost_usd = ?, permission_denials_json = ?, error = ?, ended_at = ? WHERE id = ?`,
    ).run(
      status,
      usage === undefined ? null : JSON.stringify(usage),
      costUsd,
      JSON.stringify(denials),
      // phase 4b Task 2: an error text (a 401 echoing the key, a CLI message) never stores a credential
      error === null ? null : redact(error),
      new Date().toISOString(),
      runId,
    );
    bus.emit({ type: "usage_changed" });
  };

  const onEvent = (event: { kind: "text" | "tool" | "status"; text: string }) =>
    bus.emit({ type: "agent_event", ticketKey: req.ticketKey, role: req.role, runId, event, ...(trial ? { trial: true as const } : {}) });

  let prompt = req.prompt;
  let lastError = "";
  let usage: unknown;
  let costUsd: number | null = null;
  const denials: string[] = [];
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      let res;
      try {
        res = await executor.exec(
        {
          prompt,
          systemPrompt,
          cwd: req.cwd,
          tools: [...policy.builtin],
          allowedTools: req.allowedTools,
          disallowedTools: [...policy.denied],
          restricted: policy.restricted,
          addDirs,
          settingsJson,
          chrome: req.chrome,
          rawLogPath,
          timeoutMs: req.timeoutMs,
          ...(accept !== null
            ? {
                shellPrefix: accept.shellPrefix,
                // Task 7: only PATH HOME USER + CLAUDE_CONFIG_DIR; the shim first on PATH, no node_modules/.bin
                env: {
                  claudeConfigDir: accept.iso.claudeConfigDir,
                  keep: ACCEPT_ENV_KEYS.filter((k) => k !== "PATH"),
                  path: [accept.iso.shimDir, dirname(process.execPath), "/usr/bin", "/bin"],
                  set: { ...ACCEPT_GIT_ENV },
                },
                extraArgs: ["--no-session-persistence"],
              }
            : req.shellPrefix !== undefined
              ? { shellPrefix: req.shellPrefix }
              : {}),
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
        },
        onEvent,
      );
      } catch (err) {
        // a failed chrome run may still have hit a browser/navigation problem: report that instead
        if (!(err instanceof AgentInterruptedError)) checkChromeRun(policy, ctx, rawLogPath);
        throw err;
      }
      checkChromeRun(policy, ctx, rawLogPath);
      usage = res.usage;
      costUsd = (costUsd ?? 0) + (res.costUsd ?? 0);
      for (const d of res.permissionDenials) if (!denials.includes(d)) denials.push(d);
      const required = res.permissionDenials.filter((d) => req.allowedTools.includes(d));
      if (required.length > 0) throw new ToolDeniedError([...new Set(required)]);

      const v = validate(res.text, req.schema);
      if (v.ok) {
        finish("ok", denials, null);
        return v.value;
      }
      lastError = v.error;
      prompt = `${req.prompt}\n\nYour previous answer failed validation:\n${v.error}\n\nReply again with only the corrected JSON in a \`\`\`json block.`;
    }
  } catch (err) {
    // F4C-1 (I-1): a failed attempt that was billed (an error result with total_cost_usd) counts like a finished one
    const billed = runCostOf(err);
    if (billed !== null) {
      if (billed.usage !== null) usage = billed.usage;
      if (billed.costUsd !== null) costUsd = (costUsd ?? 0) + billed.costUsd;
    }
    // an aborted run (Task 9: abandoned) is closed here; H2: a shutdown leaves it 'running' and startup recovery marks
    // it "interrupted by restart" (the DB may already be closing)
    if (err instanceof AgentInterruptedError && req.signal?.aborted) {
      finish("error", denials, "aborted");
      throw err;
    }
    if (err instanceof AgentInterruptedError) throw err;
    finish("error", denials, (err as Error).message);
    // phase 4c (C-4): the CLI said its usage limit is reached: no new agent run starts until the developer resumes
    if (err instanceof UsageLimitError) pauseUsage(db, "limit_reached", redact(err.detail), "system", bus);
    // the rethrown error keeps its class (callers test instanceof) with its message and stack redacted
    if (err instanceof Error) {
      err.message = redact(err.message);
      if (err.stack !== undefined) err.stack = redact(err.stack);
    }
    throw err;
  }
  finish("invalid_output", denials, lastError);
  throw new InvalidAgentOutputError(redact(`Agent output failed schema validation${attempts > 1 ? " after retry" : ""}: ${lastError}`));
}
