import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { z } from "zod";
import {
  ACCEPT_ENV_KEY, ACCEPT_ENV_VALUE, CHECKLIST_ID, CROSS_REPO_CHECKLIST, DEFAULT_CHECKLIST, isReservedEnvKey, RESERVED_ENV_MESSAGE, type AgentRole, type ChecklistItem,
} from "@slackoff/shared";
import { isValidReadyForDevStatus, legacyRepoName, type Config, type RepoRef } from "../config.ts";
import { ValidationError } from "../tickets/errors.ts";
import type { Ticket } from "../tickets/ticket-repo.ts";
import { runGit } from "../git/run.ts";
import { isSafeCommand } from "./safe-command.ts";
import { GlobError, matchGlob, validateGlob } from "./glob.ts";
import { DENIED_PORTS } from "../ports.ts";

export type { RepoRef };

export const RULES_CONFIG_FILE = ".slackoff/config.json";
export const RULES_MD_FILE = ".slackoff/rules.md";
const MAX_RULES_BYTES = 256 * 1024;

/** A repo's rules file is invalid: names the repo, the file and the field so the developer can fix it. */
export class ProjectRulesError extends ValidationError {
  readonly repo: string;
  readonly file: string;
  readonly field: string;
  constructor(repo: string, file: string, field: string, rule: string) {
    super(`Repository ${repo}: ${file}${field === "" ? "" : ` ${field}`}: ${rule}`);
    this.name = "ProjectRulesError";
    this.repo = repo;
    this.file = file;
    this.field = field;
  }
}

/** The ticket's project or one of its repos cannot be used as mapped; the message says how to fix it (P-C19). */
export class RepoNotMappedError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = "RepoNotMappedError";
  }
}

export { isSafeCommand } from "./safe-command.ts";

/** The platform's own files and the hooks that gate the agent's commits (S-3, P-C17): never writable by the agent. */
export const ALWAYS_FORBIDDEN: readonly string[] = Object.freeze([".git", ".git/**", "**/.git", "**/.git/**", ".slackoff/**", ".husky/**", ".githooks/**"]);

const ROLES = [
  "jira-browser", "jira-update", "refine-ticket", "propose-solutions", "design-solution", "critique-design", "implement-ticket", "acceptance-review", "jira-comment",
] as const satisfies readonly AgentRole[];

const commandSchema = z.string().refine(isSafeCommand, {
  message: "must be one command of at most 200 characters, words separated by single spaces, without shell metacharacters, quotes or newlines",
});

const SINGLE_LINE = /^[^\p{Cc}\p{Zl}\p{Zp}]+$/u;

const statusSchema = z
  .string()
  .refine(isValidReadyForDevStatus, { message: "must be a single line of 1-60 characters without quotes, backticks or control characters" });

/** Slack Off's own listeners: the command sandbox refuses connections to them, so a target app cannot use them (Task 5). */
export const RESERVED_PORTS: readonly number[] = DENIED_PORTS;

/** http://127.0.0.1:<port> or http://localhost:<port>, an optional plain path; no user info, query or fragment. */
const ACCEPT_BASE_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})(\/[A-Za-z0-9._~\/-]*)?$/;

/**
 * No "//" (an authority when resolved), no "." / ".." segments, no backslashes. Consumers still concatenate
 * `baseUrl + healthPath` as strings — never `new URL(path, base)`, which would let an absolute path replace the base.
 */
function isPlainUrlPath(path: string): boolean {
  if (path.includes("\\") || path.includes("//")) return false;
  return !path.split("?")[0]!.split("/").some((seg) => seg === "." || seg === "..");
}

export function isValidAcceptanceBaseUrl(url: string): boolean {
  const m = ACCEPT_BASE_URL.exec(url);
  if (!m || !isPlainUrlPath(m[2] ?? "")) return false;
  const port = Number(m[1]);
  return port <= 65_535 && !RESERVED_PORTS.includes(port);
}

export { isReservedEnvKey };

const envSchema = z
  .record(
    z
      .string()
      .regex(ACCEPT_ENV_KEY, { message: "keys must match ^[A-Z][A-Z0-9_]{0,63}$" })
      .refine((k) => !isReservedEnvKey(k), { message: RESERVED_ENV_MESSAGE }),
    z.string().regex(ACCEPT_ENV_VALUE, { message: "values must be at most 200 letters, digits or _ . / : @ = + , -" }),
  )
  .refine((env) => Object.keys(env).length <= 20, { message: "must set at most 20 variables" })
  .default({});

/** phase 3: a target app the platform starts and reaches over HTTP. */
const appAcceptanceSchema = z.object({
  entry: z.enum(["web", "api"]),
  install: commandSchema.optional(),
  start: commandSchema,
  stop: commandSchema.optional(),
  baseUrl: z.string().refine(isValidAcceptanceBaseUrl, {
    message: `must be http://127.0.0.1:<port> or http://localhost:<port> (an optional path), the port not ${RESERVED_PORTS.join(" or ")}`,
  }),
  /** appended to baseUrl as a string (never `new URL(healthPath, baseUrl)`) */
  healthPath: z
    .string()
    .regex(/^\/[A-Za-z0-9._~\/?&=%+,:@-]{0,199}$/, { message: "must be a path starting with '/' (no spaces)" })
    .refine(isPlainUrlPath, { message: "must not contain '//', '.' or '..' segments or backslashes" })
    .default("/"),
  /** the project's own e2e command: run by the platform as extra evidence only */
  testCommand: commandSchema.optional(),
  env: envSchema,
});

const PLAIN_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const plainRelative = (p: string) => p.split("/").every((s) => PLAIN_SEGMENT.test(s) && s !== "." && s !== ".." && s.toLowerCase() !== ".git");

/**
 * phase 4f (ruling 4F-3): programs that run whatever they are given — never cli.command's first word: the CLI under
 * acceptance is the project's own executable (a ./ path with a shebang) or a program of its own name.
 */
const GENERIC_INTERPRETERS: ReadonlySet<string> = new Set([
  "node", "nodejs", "sh", "bash", "zsh", "dash", "fish", "env", "npx", "npm", "pnpm", "yarn", "bunx", "bun", "deno", "ruby", "perl", "php", "osascript",
]);
export const isGenericInterpreter = (word: string): boolean => GENERIC_INTERPRETERS.has(word) || /^python[0-9.]*$/.test(word);

/** phase 4f: cli.command's words (isSafeCommand: single spaces, no quotes or shell metacharacters). */
export function splitCliCommand(command: string): string[] {
  return command.split(" ");
}

/**
 * phase 4f (review focus 1, 4F-5): why a cli.command is refused, or null. No word is an absolute path or has a ".."
 * segment; the first word is a path inside the exported snapshot ("./" + plain segments), never a program name.
 */
function cliCommandProblem(command: string): string | null {
  const words = splitCliCommand(command);
  for (const w of words) {
    // a flag value too (--config=/etc/x, --dir=../x)
    const parts = w.split("=");
    if (parts.some((p) => p.startsWith("/"))) return `must not name an absolute path (${w}): use a ./ path inside the repository`;
    if (parts.some((p) => p.split("/").includes(".."))) return `must not contain '..' (${w})`;
  }
  const first = words[0]!;
  if (isGenericInterpreter(first)) return `must not start with a generic interpreter (${first}): declare the project's own executable, e.g. ./bin/tool.mjs with a shebang`;
  if (first.startsWith("./")) return plainRelative(first.slice(2)) ? null : `${first} is not a plain path inside the repository`;
  // 4F-5 (M2): the project's own executable only — never a program name looked up on PATH
  return `must start with a ./ path to the project's own executable inside the repository (e.g. ./bin/tool.mjs with a shebang), not the program name ${first}`;
}

/** phase 4f (4F-3): the variables a case may set — keys the rules file allows, never a reserved one */
const caseEnvKeysSchema = z
  .array(
    z
      .string()
      .regex(ACCEPT_ENV_KEY, { message: "keys must match ^[A-Z][A-Z0-9_]{0,63}$" })
      .refine((k) => !isReservedEnvKey(k), { message: RESERVED_ENV_MESSAGE }),
  )
  .max(20)
  .default([]);
/** phase 4f (4F-4): the dotfiles a case may put at the top of its HOME (e.g. ".toolrc") */
const caseDotfilesSchema = z
  .array(
    z
      .string()
      .regex(/^\.[A-Za-z0-9._-]{1,99}$/, { message: "must be a dotfile name such as .toolrc" })
      .refine((n) => n !== ".." && n.toLowerCase() !== ".git", { message: "must not be '..' or .git" }),
  )
  .max(20)
  .default([]);

/** an npm package name, scoped or not */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** phase 4f (ruling F-1): a command-line tool, run by the platform with each declared case's arguments. */
const cliAcceptanceSchema = z.object({
  entry: z.literal("cli"),
  install: commandSchema.optional(),
  build: commandSchema.optional(),
  cli: z.object({
    command: commandSchema.superRefine((c, ctx) => {
      const why = cliCommandProblem(c);
      if (why !== null) ctx.addIssue({ code: "custom", message: why });
    }),
    /** 4F-7 (I-2, ruling F-1): the tool needs a terminal — acceptance is then not executed ("interactive CLIs are not supported") */
    interactive: z.boolean().optional(),
  }),
  testCommand: commandSchema.optional(),
  env: envSchema,
  caseEnvKeys: caseEnvKeysSchema,
  caseDotfiles: caseDotfilesSchema,
});

/** phase 4f (ruling F-2): a Node library, imported by the acceptance agent's examples. */
const libraryAcceptanceSchema = z.object({
  entry: z.literal("library"),
  install: commandSchema.optional(),
  build: commandSchema.optional(),
  library: z.object({
    runtime: z.literal("node", { message: "only Node libraries are supported (runtime 'node')" }),
    import: z.string().max(214).regex(NPM_NAME, { message: "must be an npm package name (e.g. my-lib or @scope/my-lib)" }),
    /** the package dir inside the exported snapshot */
    path: z
      .string()
      .max(200)
      .refine((p) => p === "." || plainRelative(p), { message: "must be '.' or a relative path inside the repository (plain names, no '..')" })
      .default("."),
  }),
  testCommand: commandSchema.optional(),
  env: envSchema,
  caseEnvKeys: caseEnvKeysSchema,
  caseDotfiles: caseDotfilesSchema,
});

const acceptanceSchema = z.discriminatedUnion("entry", [appAcceptanceSchema, cliAcceptanceSchema, libraryAcceptanceSchema]);

export type AcceptanceRules = z.output<typeof acceptanceSchema>;
/** phase 3 entries: an app the platform starts and reaches over HTTP */
export type AppAcceptanceRules = Extract<AcceptanceRules, { entry: "web" | "api" }>;
export type CliAcceptanceRules = Extract<AcceptanceRules, { entry: "cli" }>;
export type LibraryAcceptanceRules = Extract<AcceptanceRules, { entry: "library" }>;

export const isAppEntry = (a: AcceptanceRules): a is AppAcceptanceRules => a.entry === "web" || a.entry === "api";

const ProjectRulesSchema = z.object({
  forbiddenPaths: z
    .array(
      z
        .string()
        .min(1)
        .max(200)
        .regex(SINGLE_LINE, { message: "must be a single-line glob" })
        .superRefine((glob, ctx) => {
          try {
            validateGlob(glob);
          } catch (err) {
            ctx.addIssue({ code: "custom", message: err instanceof GlobError ? err.message : `invalid glob "${glob}"` });
          }
        }),
    )
    .default([]),
  commands: z
    .object({ install: commandSchema.optional(), test: commandSchema.optional(), build: commandSchema.optional(), lint: commandSchema.optional() })
    .prefault({}),
  jiraStatus: z
    .object({ inProgress: statusSchema.optional(), readyForReview: statusSchema.optional() })
    .prefault({}),
  checklist: z
    .object({
      add: z
        .array(
          z.object({
            id: z.string().regex(CHECKLIST_ID, { message: "must match ^[a-z][a-z0-9_]{1,39}$" }),
            group: z.enum(["non_functional", "principles", "edge_cases", "cross_repo"]),
            label: z.string().min(1).max(120).regex(SINGLE_LINE, { message: "must be a single line" }),
          }),
        )
        .default([]),
      remove: z.array(z.string()).default([]),
    })
    .prefault({}),
  prompts: z
    .partialRecord(z.enum(ROLES), z.object({ mode: z.enum(["append", "replace"]), text: z.string().max(MAX_RULES_BYTES) }))
    .default({}),
  /** Phase 3: how the acceptance run installs, starts and reaches this repo's app; null = no acceptance section. */
  acceptance: acceptanceSchema.nullable().default(null),
  /**
   * Phase 4a Task 4: the local TCP ports this repo's commands and tests need when development.localNetwork is
   * 'allowlist' (a test server's own port too: the sandbox cannot allow "ports it bound itself", spike §3)
   */
  sandbox: z
    .object({
      localPorts: z
        .array(z.number().int().min(1).max(65535))
        .max(20)
        .refine((ps) => !ps.some((p) => RESERVED_PORTS.includes(p)), { message: `must not contain ${RESERVED_PORTS.join(", ")} (always denied)` })
        .default([]),
    })
    .prefault({}),
});

export interface ProjectRules {
  /** globs relative to the repo root */
  forbiddenPaths: string[];
  commands: { install?: string; test?: string; build?: string; lint?: string };
  jiraStatus: { inProgress?: string; readyForReview?: string };
  checklist: { add: ChecklistItem[]; remove: string[] };
  prompts: Partial<Record<AgentRole, { mode: "append" | "replace"; text: string }>>;
  acceptance: AcceptanceRules | null;
  /** phase 4a Task 4 (always set when loaded; optional for hand-built rules) */
  sandbox?: { localPorts: number[] };
}

export interface LoadedRules {
  rules: ProjectRules;
  rulesMd: string;
  /** sha256 of both files (first 12 hex characters) */
  hash: string;
  /** at least one of the two files exists on the base branch */
  found: boolean;
}

export type RepoContext = RepoRef & { rules: LoadedRules };

const BASE_BRANCH = /^[^-\s\p{Cc}][^\s\p{Cc}]{0,199}$/u;

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** git's refusal to work in a repo owned by someone else (safe.directory), as a one-line message; null otherwise. */
export function gitRefusalMessage(stderr: string): string | null {
  if (!/dubious ownership|safe\.directory/i.test(stderr)) return null;
  return firstLine(stderr.replace(/^fatal:\s*/i, "")) + " — add it to git's safe.directory or fix its ownership";
}

/**
 * A repo's rules, read from its base branch commit (`git show <commit>:.slackoff/config.json` and `rules.md`) — never
 * from the working tree, so uncommitted or feature-branch edits do not change them. Missing files → defaults.
 */
/**
 * settingsCommands: the commands set for this repository in Settings (RepoRef.commands); they fill what the base
 * branch's .slackoff/config.json does not name (the file wins), so a repository without the file still has them.
 */
export async function loadProjectRules(
  repoPath: string,
  baseBranch: string,
  repoName = legacyRepoName(repoPath),
  settingsCommands?: RepoRef["commands"],
): Promise<LoadedRules> {
  if (!BASE_BRANCH.test(baseBranch)) {
    throw new RepoNotMappedError(`Repository ${repoName}: base branch "${baseBranch}" is not a valid branch name — fix Settings`);
  }
  const notTop = () => new RepoNotMappedError(`Repository ${repoName}: ${repoPath} is not the top of a git repository — fix Settings`);
  let real: string;
  try {
    real = realpathSync.native(repoPath);
  } catch {
    throw notTop();
  }
  let top;
  try {
    top = await runGit(real, ["rev-parse", "--show-toplevel"]);
  } catch (err) {
    throw new RepoNotMappedError(`Repository ${repoName}: cannot run git (${(err as Error).message})`);
  }
  const refused = gitRefusalMessage(top.stderr);
  if (top.code !== 0 && refused) throw new RepoNotMappedError(`Repository ${repoName}: ${refused}`);
  const topPath = top.stdout.trim();
  let realTop = "";
  try {
    if (top.code === 0 && topPath !== "") realTop = realpathSync.native(topPath);
  } catch {
    // treated as not the top
  }
  if (realTop !== real) throw notTop();
  const missingBranch = () =>
    new RepoNotMappedError(`Repository ${repoName}: base branch "${baseBranch}" does not exist in ${repoPath} — fix Settings`);
  // a branch only: no HEAD, tags, @{-1}, main~3, :/msg or other revision expressions
  const format = await runGit(real, ["check-ref-format", `refs/heads/${baseBranch}`]);
  if (format.code !== 0) throw missingBranch();
  const rev = await runGit(real, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${baseBranch}^{commit}`]);
  const commit = rev.stdout.trim();
  if (rev.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw missingBranch();
  const listed = await runGit(real, ["ls-tree", "--name-only", commit, "--", RULES_CONFIG_FILE, RULES_MD_FILE]);
  if (listed.code !== 0) throw new RepoNotMappedError(`Repository ${repoName}: cannot read ${baseBranch} (${firstLine(listed.stderr)})`);
  const present = new Set(listed.stdout.split("\n").filter((l) => l !== ""));

  const read = async (file: string): Promise<string | null> => {
    if (!present.has(file)) return null;
    const r = await runGit(real, ["show", `${commit}:${file}`], { maxOutput: MAX_RULES_BYTES + 64 * 1024 });
    if (r.truncated || Buffer.byteLength(r.stdout) > MAX_RULES_BYTES) {
      throw new ProjectRulesError(repoName, file, "", `is too large (the git output was too large; the limit is ${MAX_RULES_BYTES / 1024} KiB)`);
    }
    if (r.code !== 0) throw new ProjectRulesError(repoName, file, "", `cannot be read from ${baseBranch} (${firstLine(r.stderr)})`);
    return r.stdout;
  };
  const configText = await read(RULES_CONFIG_FILE);
  const rulesMd = await read(RULES_MD_FILE);

  let raw: unknown = {};
  if (configText !== null) {
    try {
      raw = JSON.parse(configText);
    } catch (err) {
      throw new ProjectRulesError(repoName, RULES_CONFIG_FILE, "", `is not valid JSON (${(err as Error).message})`);
    }
  }
  const parsed = ProjectRulesSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ProjectRulesError(repoName, RULES_CONFIG_FILE, issue.path.map(String).join("."), issue.message);
  }
  const own = Object.fromEntries(Object.entries(settingsCommands ?? {}).filter(([, v]) => typeof v === "string" && v !== ""));
  const rules = parsed.data as ProjectRules;
  if (Object.keys(own).length > 0) rules.commands = { ...own, ...rules.commands };
  const hash = createHash("sha256")
    .update(`${RULES_CONFIG_FILE}\0${configText === null ? "-" : `+${configText}`}\0${RULES_MD_FILE}\0${rulesMd === null ? "-" : `+${rulesMd}`}`)
    .update(Object.keys(own).length > 0 ? `\0settings-commands\0${JSON.stringify(Object.entries(own).sort())}` : "")
    .digest("hex")
    .slice(0, 12);
  return { rules, rulesMd: rulesMd ?? "", hash, found: configText !== null || rulesMd !== null };
}

/** File systems that ignore case by default: `.GIT` is `.git` there. */
const foldsCase = (platform: NodeJS.Platform) => platform === "darwin" || platform === "win32";

/**
 * Whether the agent may not touch `path` (relative to the repo root): the platform paths and `extra` (hook dirs
 * resolved inside the worktree, as `<dir>/**`) — always case-insensitive — and the repo's `forbiddenPaths`
 * (case-insensitive on darwin/win32). The repo root itself ("", ".") and paths escaping the repo are forbidden.
 */
export function isForbidden(path: string, rules: ProjectRules, extra: readonly string[] = [], platform: NodeJS.Platform = process.platform): boolean {
  try {
    const p = posix.normalize(path.replace(/\\/g, "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (p === "" || p === "." || p === ".." || p.startsWith("../") || p.startsWith("/")) return true;
    const always = [...ALWAYS_FORBIDDEN, ...extra].some((glob) => matchGlob(p, glob, true));
    return always || rules.forbiddenPaths.some((glob) => matchGlob(p, glob, foldsCase(platform)));
  } catch {
    return true; // fail closed: an unusable pattern forbids everything
  }
}

const projectKey = (t: Pick<Ticket, "key">) => t.key.split("-")[0] ?? "";

/** The project's mapped repos; unmapped → RepoNotMappedError (P-C19). */
export function projectRepos(t: Pick<Ticket, "key">, config: Config, bases: Readonly<Record<string, string>> = {}): RepoRef[] {
  const project = projectKey(t);
  const repos = config.projects[project]?.repos ?? [];
  if (repos.length === 0) throw new RepoNotMappedError(`Map project ${project} to a repo in Settings`);
  // bases: the ticket's own base branch per repo (tickets/base-branch-repo), over the mapping's default
  return repos.map((r) => (Object.hasOwn(bases, r.name) ? { ...r, baseBranch: bases[r.name]! } : r));
}

/** The repos a choice locked in, resolved against today's mapping (names that are gone are named in the error). */
export function affectedRepos(t: Pick<Ticket, "key">, choice: { affectedRepos: string[] | null }, config: Config, bases: Readonly<Record<string, string>> = {}): RepoRef[] {
  const repos = projectRepos(t, config, bases);
  if (choice.affectedRepos === null) {
    if (repos.length === 1) return repos;
    throw new RepoNotMappedError("Choose the affected repositories again");
  }
  return choice.affectedRepos.map((name) => {
    const r = repos.find((x) => x.name === name);
    if (!r) {
      throw new RepoNotMappedError(`Repository ${name} is no longer mapped for project ${projectKey(t)} — fix Settings or choose a different solution`);
    }
    return r;
  });
}

/**
 * The checklist for a design over these repos: the default items (+ cross-repo items when more than one repo),
 * minus the items **every** repo removes, plus every repo's additions (first occurrence of an id wins).
 */
export function resolveChecklist(repos: readonly RepoContext[]): ChecklistItem[] {
  const base = repos.length > 1 ? [...DEFAULT_CHECKLIST, ...CROSS_REPO_CHECKLIST] : [...DEFAULT_CHECKLIST];
  const known = new Set([...DEFAULT_CHECKLIST, ...CROSS_REPO_CHECKLIST, ...repos.flatMap((r) => r.rules.rules.checklist.add)].map((i) => i.id));
  for (const r of repos) {
    for (const id of r.rules.rules.checklist.remove) {
      if (!known.has(id)) throw new ProjectRulesError(r.name, RULES_CONFIG_FILE, "checklist.remove", `unknown checklist item "${id}"`);
    }
  }
  const removedByAll = (id: string) => repos.length > 0 && repos.every((r) => r.rules.rules.checklist.remove.includes(id));
  const out = base.filter((i) => !removedByAll(i.id));
  const seen = new Set(base.map((i) => i.id));
  for (const r of repos) {
    for (const item of r.rules.rules.checklist.add) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({ ...item });
    }
  }
  return out;
}
