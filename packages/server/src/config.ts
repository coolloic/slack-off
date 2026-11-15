import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isIPv4 } from "node:net";
import { z } from "zod";
import { isValidModelName } from "./executor/sandbox.ts";
import { isTailscaleIPv4 } from "./remote/tailscale.ts";
import { otlpEndpointIssue } from "./telemetry/otlp.ts";
import { ValidationError } from "./tickets/errors.ts";
import { isSafeCommand } from "./projects/safe-command.ts";

const baseUrlSchema = z
  .string()
  .refine(
    (value) => {
      if (value === "") return true;
      // phase 4b (4B-8, I4): no user info (it would reach fetch and its errors), no query or fragment
      if (/[?#]/.test(value)) return false;
      try {
        const u = new URL(value);
        return u.protocol === "https:" && u.username === "" && u.password === "";
      } catch {
        return false;
      }
    },
    { message: "must be empty or an https:// URL without user info, query or fragment" },
  )
  .transform((value) => value.replace(/\/+$/, ""));

/** F-I2: the status is inserted into the browser agent's prompt and a JQL string, so it is one short plain line. */
const READY_FOR_DEV_STATUS = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"'`]{1,60}$/u;

export function isValidReadyForDevStatus(value: string): boolean {
  return READY_FOR_DEV_STATUS.test(value);
}

const readyForDevStatusSchema = z.string().refine(isValidReadyForDevStatus, {
  message: "must be a single line of 1-60 characters without quotes, backticks or control characters",
});

export const DEFAULT_DISCOVER_LIMIT = 100;

export function isValidDiscoverLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 500;
}

export const DEFAULT_IN_PROGRESS_STATUS = "In Progress";
export const DEFAULT_REVIEW_STATUS = "Ready for Human Review";

/** Q-3: the dedicated Claude Code config folder the acceptance agent runs with (one-time `claude /login` by the developer). */
export const DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR = join(homedir(), ".slackoff-acceptance", "claude-config");

/** A program run with execFile (no shell): a bare command name looked up on PATH, or an absolute path on one line. */
const BARE_COMMAND = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const ABSOLUTE_BIN = /^\/[^\p{Cc}\p{Zl}\p{Zp}]{1,499}$/u;
export const isValidBin = (v: string): boolean => (BARE_COMMAND.test(v) && v !== "." && v !== "..") || ABSOLUTE_BIN.test(v);
const binSchema = z.string().refine(isValidBin, { message: "must be a command name (letters, digits, '.', '_', '-') or an absolute path" });

/** S-2: the Chrome device id goes into the browser agents' prompts, so it is one plain token. */
const BROWSER_DEVICE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const BROWSER_NAME = /^[^\p{Cc}\p{Zl}\p{Zp}]{1,80}$/u;
export const isValidBrowserDeviceId = (v: string): boolean => BROWSER_DEVICE_ID.test(v);
export const isValidBrowserName = (v: string): boolean => BROWSER_NAME.test(v);

export const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** P-C13: a repo name for a phase-1 `{repoPath}` mapping — basename, lower-cased, illegal characters to '-', leading non-[a-z0-9] dropped, max 40; empty → "repo". */
export function legacyRepoName(path: string): string {
  const base = path.split(/[\\/]+/).filter((p) => p !== "").pop() ?? "";
  const name = base.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
  return name === "" ? "repo" : name;
}

/** `base`, or `base-2`, `base-3`… (kept within 40 characters) when the name is already taken in the project. */
export function uniqueRepoName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, 40 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

/** A git revision name passed as one argv entry: never an option, no whitespace or control characters. */
const BASE_BRANCH = /^[^-\s\p{Cc}][^\s\p{Cc}]{0,199}$/u;

/** Same rule as a repository's own commands (projects/safe-command): one command, no shell. */
const settingsCommand = z.string().refine(isSafeCommand, {
  message: "must be one command of at most 200 characters, words separated by single spaces, without shell metacharacters, quotes or newlines",
});

const repoRefSchema = z.object({
  name: z.string().regex(REPO_NAME, { message: "must match ^[a-z0-9][a-z0-9._-]{0,39}$" }),
  path: z.string().refine((p) => p.trim() !== "" && isAbsolute(p), { message: "must be an absolute path to the repository" }),
  baseBranch: z.string().regex(BASE_BRANCH, { message: "must be a branch name without spaces, not starting with '-'" }),
  /**
   * The repository's commands set on this computer (Settings → Repositories), for a repository without
   * .slackoff/config.json on its base branch or one that leaves a command out: the file wins for any command it names.
   */
  commands: z
    .strictObject({ install: settingsCommand.optional(), build: settingsCommand.optional(), lint: settingsCommand.optional(), test: settingsCommand.optional() })
    .optional(),
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Phase 1 `{repoPath, baseBranch}` → `{repos: [one repo]}`; saving always writes the new shape. */
const projectSchema = z.preprocess(
  (v) =>
    isRecord(v) && !("repos" in v) && "repoPath" in v
      ? { repos: [{ name: legacyRepoName(String(v.repoPath)), path: v.repoPath, baseBranch: v.baseBranch }] }
      : v,
  z.object({
    repos: z
      .array(repoRefSchema)
      .min(1, { message: "must list at least one repository" })
      .superRefine((repos, ctx) => {
        const seen = new Set<string>();
        repos.forEach((r, i) => {
          if (seen.has(r.name)) ctx.addIssue({ code: "custom", path: [i, "name"], message: `duplicate repository name "${r.name}"` });
          seen.add(r.name);
        });
      }),
  }),
);

export type RepoRef = z.output<typeof repoRefSchema>;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

/** Empty (auto-detect), a Tailscale IPv4 (100.64.0.0/10) or a MagicDNS host name. Never a wildcard or LAN address. */
const remoteHostSchema = z
  .string()
  .transform((v) => v.trim())
  .refine(
    (v) => {
      if (v === "") return true;
      if (isIPv4(v)) return isTailscaleIPv4(v);
      return HOSTNAME.test(v) && !/^[\d.]+$/.test(v);
    },
    { message: "must be empty, a Tailscale IPv4 address (100.64.0.0/10) or a MagicDNS name" },
  );

/**
 * Phase 4b task 1 decided value (docs/spikes/2026-11-api-modes.md, ruling 4B-1: the plan's default, not verified →
 * exit check): claude-in-chrome does not work under API-key auth, so the API executor needs the JIRA API mode (B-4).
 */
export const API_CHROME: "available" | "unavailable" = "unavailable";
export const API_EXECUTOR_NEEDS_JIRA_API = "the API executor cannot drive Chrome: use the JIRA API mode";

const ConfigSchema = z.object({
  jira: z
    .object({
      baseUrl: baseUrlSchema.default(""),
      /** Tickets-list default filter and highlight; it no longer limits discovery (author decision 2026-11-06). */
      readyForDevStatus: readyForDevStatusSchema.default("Ready for Dev"),
      /** Most open tickets one discovery reads (all result pages up to this many); goes into the browser agent's prompt. */
      discoverLimit: z.number().int().min(1).max(500).default(DEFAULT_DISCOVER_LIMIT),
      /** phase 4b: how JIRA is read and written — the connected Chrome browser, or Jira Cloud REST with an API token */
      source: z.enum(["browser", "api"]).default("browser"),
      /** The only JIRA write: move a ticket to `inProgressStatus`, each time confirmed in the UI. */
      syncStatus: z.boolean().default(false),
      inProgressStatus: readyForDevStatusSchema.default(DEFAULT_IN_PROGRESS_STATUS),
      /** Phase 3: the status a delivered ticket is moved to (a repo's jiraStatus.readyForReview can name another). */
      reviewStatus: readyForDevStatusSchema.default(DEFAULT_REVIEW_STATUS),
      /** S-2: the connected Chrome browser the JIRA agents use; null = the only one connected. */
      browser: z
        .object({
          deviceId: z.string().regex(BROWSER_DEVICE_ID, { message: "must be 1-128 letters, digits, '.', '_', ':' or '-'" }),
          name: z.string().regex(BROWSER_NAME, { message: "must be a single line of 1-80 characters" }),
        })
        .nullable()
        .default(null),
    })
    .prefault({}),
  projects: z.record(z.string(), projectSchema).default({}),
  executor: z
    .object({
      /** phase 4b: the Claude Code subscription, or the same CLI authenticated with an Anthropic API key (B-1) */
      kind: z.enum(["claude-code", "claude-api"]).default("claude-code"),
      claudeBin: z.string().default("claude"),
      /** "" = Claude Code's default model; agents run with `--setting-sources ""`, so the user's settings model does not apply */
      model: z
        .string()
        .refine((v) => v === "" || isValidModelName(v), {
          message: "must be empty or one model name of letters, digits, '.', '_', ':' or '-' (max 80 characters, not starting with '-')",
        })
        .default(""),
    })
    .prefault({}),
  /** F4C-1 (M-3): agents at once, 1..8 (each one is an agent run; with the API key, raising it is loosening: this computer only) */
  concurrency: z.number().int().min(1).max(8).default(1),
  autoRefine: z.boolean().default(false),
  reviewAcByDefault: z.boolean().default(false),
  remoteAccess: z
    .object({
      enabled: z.boolean().default(false),
      host: remoteHostSchema.default(""),
    })
    .prefault({}),
  debate: z
    .object({ maxRounds: z.number().int().min(1).max(5).default(3) })
    .prefault({}),
  development: z
    .object({
      maxSteps: z.number().int().min(1).max(50).default(12),
      commandTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
      hookTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(300_000),
      /** R-LOCAL: run development commands without the macOS command sandbox when it is unavailable (this computer only). */
      allowUnsandboxedCommands: z.boolean().default(false),
      /** T5-6: extra local TCP ports the command sandbox denies (connect and listen), on top of DENIED_PORTS (this computer only). */
      deniedLocalPorts: z.array(z.number().int().min(1).max(65535)).max(100).default([]),
      /** phase 4a (A-3): run the repos' git hooks without the dev-hook sandbox when it is unavailable (this computer only). */
      allowUnsandboxedHooks: z.boolean().default(false),
      /**
       * phase 4a Task 4 (A-4): local TCP from sandboxed commands — 'denylist' (DENIED_PORTS and deniedLocalPorts refused,
       * the rest open) or 'allowlist' (only the repos' declared sandbox.localPorts and the acceptance baseUrl ports; also
       * no outbound IPv6 TCP at all, spike §3). This computer only.
       */
      localNetwork: z.enum(["denylist", "allowlist"]).default("denylist"),
    })
    .prefault({}),
  review: z
    .object({ maxAttempts: z.number().int().min(1).max(5).default(3) })
    .prefault({}),
  acceptance: z
    .object({
      /** Never inside SLACKOFF_HOME (checked against real paths by loadConfig / saveConfig, R3). */
      claudeConfigDir: z
        .string()
        .refine((p) => p.trim() !== "" && isAbsolute(p), { message: "must be an absolute path" })
        .default(DEFAULT_ACCEPT_CLAUDE_CONFIG_DIR),
      startTimeoutMs: z.number().int().min(10_000).max(900_000).default(120_000),
      runTimeoutMs: z.number().int().min(60_000).max(7_200_000).default(1_800_000),
      /** phase 4f (ruling F-4): each declared case of a command-line or library entry; phone-editable */
      caseTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
    })
    .prefault({}),
  delivery: z
    .object({
      /** read on every call (R3), so a Settings change applies at once */
      ghBin: binSchema.default("gh"),
      /** Azure DevOps repositories: the Azure CLI with its devops extension (az repos) */
      azBin: binSchema.default("az"),
    })
    .prefault({}),
  /**
   * phase 4c (C-1, C-2): thresholds on new agent runs over a rolling window of the current executor. Phone-editable:
   * loosening or tightening them only changes the developer's own consumption.
   */
  budget: z
    .object({
      enabled: z.boolean().default(false),
      window: z.enum(["5h", "day", "week"]).default("5h"),
      maxRuns: z.number().int().min(1).max(10_000).nullable().default(null),
      maxRunMinutes: z.number().min(1).max(100_000).nullable().default(null),
      maxUsd: z.number().min(0.01).max(100_000).nullable().default(null),
      warnAt: z.number().min(0.5).max(0.99).default(0.8),
    })
    .prefault({}),
  /**
   * phase 4c (C-7, C-8): run tracing — the OTLP/HTTP endpoint ("" = off) and whether prompts and outputs are sent too.
   * This computer only (sensitive in PUT /api/config). The auth headers live in credentials.json (otlpHeaders).
   */
  telemetry: z
    .object({
      endpoint: z
        .string()
        .superRefine((v, ctx) => {
          const issue = otlpEndpointIssue(v);
          if (issue !== null) ctx.addIssue({ code: "custom", message: issue });
        })
        .default(""),
      includeContent: z.boolean().default(false),
    })
    .prefault({}),
}).superRefine((c, ctx) => {
  // B-4 (API_CHROME unavailable): the JIRA agents of the browser mode need claude-in-chrome
  if ((API_CHROME as string) === "unavailable" && c.executor.kind === "claude-api" && c.jira.source === "browser") {
    ctx.addIssue({ code: "custom", path: ["jira", "source"], message: API_EXECUTOR_NEEDS_JIRA_API });
  }
});

export interface ConfigIssue {
  /** dotted path, "" for the whole file */
  field: string;
  rule: string;
}

export class ConfigValidationError extends ValidationError {
  readonly issues: ConfigIssue[];
  /** set when the error comes from reading config.json */
  file: string | null = null;
  /** the file is not a JSON object at all */
  notJson = false;
  constructor(message: string, issues: ConfigIssue[] = []) {
    super(message);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/** H3: the startup message for an unusable config.json — file, each field and rule, and how to fix it. */
export function formatConfigFileError(err: ConfigValidationError): string {
  const file = err.file ?? "config.json";
  const lines = [`Slack Off cannot start: ${file} is invalid.`, ""];
  if (err.notJson) {
    lines.push(`  ${err.issues[0]?.rule ?? "The file is not valid JSON."}`, "");
    lines.push(`Fix: correct the JSON syntax in ${file}, or delete the file to start with the default settings.`);
    return lines.join("\n");
  }
  for (const i of err.issues) {
    lines.push(`  Field: ${i.field === "" ? "(the whole file)" : i.field}`, `  Rule: ${i.rule}`, "");
  }
  const whole = err.issues.some((i) => i.field === "");
  lines.push(
    whole
      ? `Fix: the file must hold one JSON object; edit it, or delete the file to start with the default settings.`
      : `Fix: edit ${file} to correct the field(s) above, or delete the field to use its default value. Then start Slack Off again.`,
  );
  return lines.join("\n");
}

export type Config = z.output<typeof ConfigSchema>;

export function parseConfig(input: unknown): Config {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ field: issue.path.map(String).join("."), rule: issue.message }));
    const details = issues.map((i) => `${i.field}: ${i.rule}`).join("; ");
    throw new ConfigValidationError(`Invalid config: ${details}`, issues);
  }
  return result.data;
}

function configPath(home: string): string {
  return join(home, "config.json");
}

function write(home: string, config: Config): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(configPath(home), JSON.stringify(config, null, 2) + "\n");
}

/**
 * The real path of `p` even when its tail does not exist yet: the nearest existing ancestor is resolved, symlinks
 * (dangling ones too) are followed, and the missing segments are appended.
 */
export function realpathLoose(p: string, depth = 0): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    // resolved below
  }
  if (depth > 40) return abs;
  try {
    if (lstatSync(abs).isSymbolicLink()) return realpathLoose(resolve(dirname(abs), readlinkSync(abs)), depth + 1);
  } catch {
    // does not exist
  }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realpathLoose(parent, depth + 1), basename(abs));
}

const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  if (isAbsolute(rel)) return false;
  // "..cfg" is a folder inside parent; only ".." itself or a "../" prefix leaves it
  return !(rel === ".." || rel.startsWith(`..${sep}`));
};

/**
 * R3: the acceptance agent's config folder must not be SLACKOFF_HOME, lie inside it or contain it (the agent must
 * never see the database, worktrees or designs) — compared as real paths, so symlinks cannot escape.
 */
function checkHomeRelations(home: string, config: Config): void {
  const realHome = realpathLoose(home);
  const dir = realpathLoose(config.acceptance.claudeConfigDir);
  if (within(dir, realHome) || within(realHome, dir)) {
    const rule = `must be outside the Slack Off folder ${realHome} (and must not contain it)`;
    throw new ConfigValidationError(`Invalid config: acceptance.claudeConfigDir: ${rule}`, [{ field: "acceptance.claudeConfigDir", rule }]);
  }
}

export function loadConfig(home: string): Config {
  const path = configPath(home);
  if (!existsSync(path)) {
    const defaults = parseConfig({});
    write(home, defaults);
    return defaults;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const e = new ConfigValidationError(`Invalid config: ${path} is not valid JSON`, [
      { field: "", rule: `The file is not valid JSON (${(err as Error).message}).` },
    ]);
    e.file = path;
    e.notJson = true;
    throw e;
  }
  try {
    const config = parseConfig(raw);
    checkHomeRelations(home, config);
    return config;
  } catch (err) {
    if (err instanceof ConfigValidationError) err.file = path;
    throw err;
  }
}

export function saveConfig(home: string, config: Config): void {
  const validated = parseConfig(config);
  checkHomeRelations(home, validated);
  write(home, validated);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Dotted paths of the fields that differ between two configs (H6 audit), sorted; never their values. */
export function changedConfigPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys
      .flatMap((k) => {
        const path = prefix ? `${prefix}.${k}` : k;
        if (!(k in a) || !(k in b)) return [path];
        return changedConfigPaths(a[k], b[k], path);
      })
      .sort();
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}
