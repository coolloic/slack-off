// Agent sandbox baseline (F-I1). `--allowedTools` only pre-approves tools; it does not restrict them
// (docs/spikes/2026-11-headless-chrome.md §2.3). Every agent run therefore also gets an explicit,
// non-auto-accepting permission mode, a deny list and a per-role set of available built-in tools.
import { join } from "node:path";
import { isSafeCommand } from "../projects/safe-command.ts";
import type { AgentRole } from "@slackoff/shared";

export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

/** Never inherit the user's defaultMode: `default` asks for anything not pre-approved, and with
 * `--permission-prompts none` nobody can answer, so it is denied. */
export const PERMISSION_MODE = "default";
export const PERMISSION_PROMPTS = "none";

/** Isolation from the user's own Claude Code config (H1), on every role. Verified with real 1-turn runs on
 * claude 2.1.319 (see .superpowers/sdd/phase1-hardening/report.md):
 * - `--strict-mcp-config` drops every configured MCP server; claude-in-chrome is a dynamic server that
 *   `--chrome` still connects, with its tools, so jira-browser keeps working.
 * - `--setting-sources ""` loads no user/project/local settings (their hooks, plugins, allow rules, model),
 *   while the subscription login (keychain/OAuth, not a settings file) still works. Managed policy still applies. */
export const ISOLATION_ARGS: readonly string[] = ["--strict-mcp-config", "--setting-sources", ""];

/** `--model` value (config executor.model): one token of [A-Za-z0-9._:-], max 80 chars, never starting with "-"
 * so it can never be read as a flag. "" = the CLI default. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
export const isValidModelName = (v: string): boolean => MODEL_NAME.test(v);

const chrome = (t: string) => `mcp__claude-in-chrome__${t}`;

/** Read-only claude-in-chrome tools (spike §2.8). Anything not listed here must never be granted. */
export const CHROME_READ_TOOLS: readonly string[] = [
  "ToolSearch",
  ...["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "navigate", "get_page_text", "read_page", "find"].map(chrome),
];

/** Passed as `--disallowedTools` on every run; deny rules win over any allow rule from user settings. */
export const DENIED_TOOLS: readonly string[] = [
  "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
  // write-capable or state-changing claude-in-chrome tools
  ...[
    "computer", "form_input", "javascript_tool", "file_upload", "upload_image", "shortcuts_execute", "browser_batch",
    "gif_creator", "resize_window", "switch_browser", "select_browser",
    // not needed for reading tickets (browser selection, console and network contents): denied explicitly
    "list_connected_browsers", "read_console_messages", "read_network_requests",
  ].map(chrome),
];

export const CHROME_ALL_TOOLS: readonly string[] = [
  "tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "navigate", "get_page_text", "read_page", "find",
  "computer", "form_input", "javascript_tool", "file_upload", "upload_image", "shortcuts_execute", "shortcuts_list", "browser_batch",
  "gif_creator", "resize_window", "switch_browser", "select_browser", "list_connected_browsers", "read_console_messages", "read_network_requests",
].map(chrome);

// ---- Task 1 spike decided values (docs/spikes/2026-11-dev-sandbox.md, ruling P-C15) ----

/** implement-ticket may run the repo's declared commands, each through an exact `Bash(<cmd>)` allow rule. */
export const DEV_BASH_MODE = "scoped" as const;
/** The only form the dev prompt allows (the Bash tool keeps its cwd between calls): absolute repo path, then the bare command. */
export const DEV_BASH_FORM = "cd <ticketDir>/<repo> && <cmd>";
const SAFE_TICKET_DIR = /^\/[A-Za-z0-9._/-]+$/;
const SAFE_REPO = /^[a-z0-9][a-z0-9._-]{0,39}$/;
/** The prompt's command line. Every part goes into a shell line verbatim, so only plain characters are accepted. */
export function devCommandLine(ticketDir: string, repo: string, cmd: string): string {
  if (!SAFE_TICKET_DIR.test(ticketDir) || ticketDir.split("/").includes("..")) {
    throw new SandboxPolicyError(
      `ticket directory ${JSON.stringify(ticketDir)} must be an absolute path of letters, digits, '.', '_', '-' and '/': move SLACKOFF_HOME to such a path`,
    );
  }
  if (!SAFE_REPO.test(repo) || repo === "." || repo === "..") throw new SandboxPolicyError(`invalid repo name ${JSON.stringify(repo)}`);
  if (!isSafeCommand(cmd)) throw new SandboxPolicyError(`unsafe command ${JSON.stringify(cmd)}`);
  return `cd ${join(ticketDir, repo)} && ${cmd}`;
}
/** Without `--restricted` the file tools reach any path (spike §2.2). */
export const DEV_RESTRICTED = true as const;
/** `form_input` cannot drive JIRA-style menus (spike §4.2). */
export const JIRA_UPDATE_EXTRA_TOOLS: readonly string[] = [chrome("computer")];
/** The only `computer` actions jira-update may use (enforced by the guard hook and the post-run scan): click by ref,
 * scroll, wait, look. Never type, press keys, drag or other clicks. */
export const JIRA_UPDATE_COMPUTER_ACTIONS: readonly string[] = ["left_click", "scroll", "scroll_to", "wait", "screenshot"];
/** PreToolUse hook + mandatory post-run log scan of tool results (nav-guard.ts). */
export const NAV_GUARD = "hook" as const;

// ---- Task 1 decided values for phase 3 (docs/spikes/2026-11-acceptance-delivery.md) ----

/** The acceptance agent writes Playwright specs and runs them with one exact command (spike §2). */
export const ACCEPT_MECHANISM = "specs" as const;
export const ACCEPT_TEST_COMMAND = "playwright test";
/** The prompt's form; the Bash tool keeps its cwd between calls, so later calls are the bare command (both match the
 * exact `Bash(playwright test)` rule, spike §2). */
export const ACCEPT_BASH_FORM = "cd <workDir>/acceptance && playwright test";
/** The prompt's command line for this run (`workDir` as its realpath, e.g. /private/var/…), same character check as devCommandLine. */
export function acceptCommandLine(workDir: string): string {
  if (!SAFE_TICKET_DIR.test(workDir) || workDir.split("/").includes("..")) {
    throw new SandboxPolicyError(`acceptance work directory ${JSON.stringify(workDir)} must be an absolute path of letters, digits, '.', '_', '-' and '/'`);
  }
  return `cd ${join(workDir, "acceptance")} && ${ACCEPT_TEST_COMMAND}`;
}
/** Every command line the spec guard lets through. */
export function acceptCommandForms(workDir: string): string[] {
  return [acceptCommandLine(workDir), ACCEPT_TEST_COMMAND];
}
/** phase 4f (ruling F-1): command-line and library entries run their declared cases with one exact command. */
export const ACCEPT_CASES_COMMAND = "slackoff-cases run";
/** phase 4f, decided value CASES_SHIM_FORM (spike 2026-11-acceptance-cli-library; not verified with a real claude). */
export const CASES_SHIM_FORM = "cd <workDir>/acceptance && slackoff-cases run";
export function caseCommandLine(workDir: string): string {
  acceptCommandLine(workDir); // the same character check
  return `cd ${join(workDir, "acceptance")} && ${ACCEPT_CASES_COMMAND}`;
}
export function caseCommandForms(workDir: string): string[] {
  return [caseCommandLine(workDir), ACCEPT_CASES_COMMAND];
}
/** The acceptance agent's environment from the server's (plus CLAUDE_CONFIG_DIR, set by the platform; spike §1). */
export const ACCEPT_ENV_KEYS: readonly string[] = ["PATH", "HOME", "USER"];
/** T7-7: set in the acceptance agent's environment — the unsandboxed claude's own git never takes a bare layout planted
 * in the work dir (HEAD, objects/, refs/; `git init --bare` works inside the sandbox) for a repository. */
export const ACCEPT_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.bareRepository",
  GIT_CONFIG_VALUE_0: "explicit",
});
/** The file-system / network guard of the acceptance agent's code. Ruling T7-1: every Bash command runs inside the
 * acceptance `sandbox-exec` profile through CLAUDE_CODE_SHELL_PREFIX (the playwright shim does not sandbox, T6-3);
 * the `claude` process itself is not wrapped (T1-1: the keychain login needs it). */
export const ACCEPT_FS_GUARD = "sandbox-exec" as const;
/** jira-comment's `computer` actions: clicks plus `type`, which the guard allows only with exactly the comment text
 * (spike §5). Never `key`. */
export const JIRA_COMMENT_COMPUTER_ACTIONS: readonly string[] = ["left_click", "type", "scroll", "scroll_to", "wait", "screenshot"];
/** One `type` carries a multi-line comment (spike §5). */
export const JIRA_COMMENT_MULTILINE = true;
/** The longest comment jira-comment may type. */
export const JIRA_COMMENT_MAX_CHARS = 2000;

export interface ToolPolicy {
  /** `--tools`: the built-in tools that exist at all for this run ([] = none). */
  builtin: readonly string[];
  /** Upper bound for `--allowedTools`. */
  allowed: readonly string[];
  /** `--disallowedTools` for this role. */
  denied: readonly string[];
  chrome: boolean;
  /** `--restricted`: the file tools only reach the cwd and `--add-dir` directories. */
  restricted: boolean;
  /** chrome roles allowed `computer`: the only actions (guard hook + post-run scan); null = not a computer role (R5) */
  computerActions: readonly string[] | null;
}

export interface PolicyContext {
  /** implement-ticket: bare repo commands (e.g. "pnpm test"), deduplicated */
  commands?: readonly string[];
  /** default DEV_BASH_MODE */
  bashMode?: "scoped" | "none";
  /** implement-ticket: repo-relative forbidden globs (union across affected repos, ruling A-6) */
  denyPaths?: readonly string[];
  /** chrome roles: the only pages the agent may be on (jira-update: required) */
  navAllow?: readonly string[];
  /** chrome roles: pinned device / browser-detection mode / not configured */
  browser?: { deviceId: string } | "list" | null;
  /** acceptance-review (required): the run's work dir (realpath), the agent's cwd */
  workDir?: string;
  /**
   * phase 4f, acceptance-review: the repos whose declared cases the agent writes (command-line and library entries) —
   * then its one command is `slackoff-cases run`, never `playwright test`; absent → the phase 3 Playwright specs
   */
  acceptCases?: ReadonlyArray<{ repo: string; library: string | null }>;
  /** jira-comment (required): the only text it may type */
  typeText?: string;
}

/** Programs the dev agent may never run (network, git, remote shells); also refused as allow rules (no allow/deny overlap). */
const DEV_DENIED_PROGRAMS = ["git", "gh", "curl", "wget", "ssh", "scp", "nc"];

/** One exact allow rule per command; never a `Bash(<cmd> *)` variant (it lets any extra argument through). */
export function bashAllowRules(commands: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of commands) {
    if (!isSafeCommand(c) || /[()*]/.test(c)) throw new SandboxPolicyError(`refusing command ${JSON.stringify(c)} as a Bash allow rule`);
    if (DEV_DENIED_PROGRAMS.includes(c.split(" ")[0]!)) throw new SandboxPolicyError(`the dev agent may not run ${JSON.stringify(c)}`);
    const rule = `Bash(${c})`;
    if (!out.includes(rule)) out.push(rule);
  }
  return out;
}

/** Edit and Write deny rules for repo-relative globs, matched in every directory (spike §2.1). */
export function pathDenyRules(globs: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of globs) {
    if (g === "" || g.startsWith("/") || g.length > 200 || /[\p{Cc}\p{Zl}\p{Zp}()]/u.test(g)) {
      throw new SandboxPolicyError(`refusing path rule ${JSON.stringify(g)}`);
    }
    for (const tool of ["Edit", "Write"]) {
      const rule = `${tool}(/**/${g})`;
      if (!out.includes(rule)) out.push(rule);
    }
  }
  return out;
}

const READ_ONLY_FILE_TOOLS = ["Read", "Grep", "Glob"] as const;
const DEV_FILE_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write"] as const;
const DEV_DENIED_BASH = DEV_DENIED_PROGRAMS.map((c) => `Bash(${c} *)`);
/** The platform's own files and the hooks that gate the agent's commits: never editable by the dev agent. */
const DEV_PROTECTED_PATHS = [".git", ".git/**", ".slackoff/**", ".githooks/**", ".husky/**"];
/** The acceptance agent runs nothing but the shim's `playwright test`: no package runner or interpreter either. */
const ACCEPT_DENIED_BASH = [...DEV_DENIED_PROGRAMS, "npx", "node"].map((c) => `Bash(${c} *)`);
/** The platform's scaffold: never editable by the acceptance agent (a config could add globalSetup / webServer). */
const ACCEPT_PROTECTED_PATHS = ["playwright.config.mjs", "node_modules/**"];
const ACCEPT_TOOLS = [...DEV_FILE_TOOLS, "Bash"] as const;

const without = (list: readonly string[], drop: readonly string[]) => list.filter((t) => !drop.includes(t));

function chromeBrowser(role: AgentRole, ctx: PolicyContext): { deviceId: string } | "list" | null {
  const b = ctx.browser ?? null;
  if (b === null || b === "list") return b;
  if (typeof b.deviceId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(b.deviceId)) {
    throw new SandboxPolicyError(`${role}: invalid browser device id`);
  }
  return b;
}

/** The role's policy for this run; a role without one is refused. */
export function toolPolicy(role: AgentRole, ctx: PolicyContext = {}): ToolPolicy {
  switch (role) {
    case "refine-ticket":
      return { builtin: [], allowed: [], denied: DENIED_TOOLS, chrome: false, restricted: false, computerActions: null };
    case "propose-solutions":
    case "design-solution":
    case "critique-design":
      return { builtin: READ_ONLY_FILE_TOOLS, allowed: READ_ONLY_FILE_TOOLS, denied: DENIED_TOOLS, chrome: false, restricted: DEV_RESTRICTED, computerActions: null };
    case "implement-ticket": {
      const mode = ctx.bashMode ?? DEV_BASH_MODE;
      const bash = mode === "scoped" ? bashAllowRules(ctx.commands ?? []) : [];
      return {
        builtin: bash.length > 0 ? [...DEV_FILE_TOOLS, "Bash"] : DEV_FILE_TOOLS,
        allowed: [...DEV_FILE_TOOLS, ...bash],
        denied: [
          "WebFetch", "WebSearch", "NotebookEdit", ...CHROME_ALL_TOOLS, ...DEV_DENIED_BASH,
          ...pathDenyRules([...new Set([...DEV_PROTECTED_PATHS, ...(ctx.denyPaths ?? [])])]),
        ],
        chrome: false,
        restricted: DEV_RESTRICTED,
        computerActions: null,
      };
    }
    case "acceptance-review": {
      if (ctx.workDir === undefined) throw new SandboxPolicyError("acceptance-review needs its work directory");
      acceptCommandLine(ctx.workDir);
      const cases = ctx.acceptCases !== undefined;
      return {
        builtin: ACCEPT_TOOLS,
        allowed: [...DEV_FILE_TOOLS, `Bash(${cases ? ACCEPT_CASES_COMMAND : ACCEPT_TEST_COMMAND})`],
        denied: [
          "WebFetch", "WebSearch", "NotebookEdit", ...CHROME_ALL_TOOLS, ...ACCEPT_DENIED_BASH,
          ...pathDenyRules([...new Set([...ACCEPT_PROTECTED_PATHS, ...(ctx.denyPaths ?? [])])]),
        ],
        chrome: false,
        restricted: true,
        computerActions: null,
      };
    }
    case "jira-browser": {
      const b = chromeBrowser(role, ctx);
      const extra = b === null ? [] : b === "list" ? [chrome("list_connected_browsers")] : [chrome("select_browser")];
      const allowed = [...CHROME_READ_TOOLS, ...extra];
      return { builtin: ["ToolSearch"], allowed, denied: without(DENIED_TOOLS, allowed), chrome: true, restricted: false, computerActions: null };
    }
    case "jira-update":
    case "jira-comment": {
      const b = chromeBrowser(role, ctx);
      if (b === "list") throw new SandboxPolicyError(`${role} cannot list browsers`);
      const allowed = [...CHROME_READ_TOOLS, chrome("computer"), ...(b === null ? [] : [chrome("select_browser")])];
      return {
        builtin: ["ToolSearch"],
        allowed,
        denied: without(DENIED_TOOLS, allowed),
        chrome: true,
        restricted: false,
        computerActions: role === "jira-update" ? JIRA_UPDATE_COMPUTER_ACTIONS : JIRA_COMMENT_COMPUTER_ACTIONS,
      };
    }
    default:
      throw new SandboxPolicyError(`no sandbox policy for agent role ${role}`);
  }
}

/** Throws unless `allowedTools` and `chrome` stay within the role's policy (checked against the policy's own deny list, P-C6). */
export function assertWithinPolicy(role: AgentRole, allowedTools: readonly string[], chromeOn: boolean, ctx: PolicyContext = {}): ToolPolicy {
  const p = toolPolicy(role, ctx);
  const extra = allowedTools.filter((t) => !p.allowed.includes(t) || p.denied.includes(t));
  if (extra.length > 0) throw new SandboxPolicyError(`${role} may not use: ${extra.join(", ")}`);
  if (chromeOn && !p.chrome) throw new SandboxPolicyError(`${role} may not use the browser`);
  if ((role === "jira-update" || role === "jira-comment") && (ctx.navAllow === undefined || ctx.navAllow.length === 0)) {
    throw new SandboxPolicyError(`${role} needs a navigation allow list`);
  }
  return p;
}
