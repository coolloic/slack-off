import { t } from "../i18n/en.ts";
import { MODE_COMPARISON, type ModeComparisonTable } from "@slackoff/shared";
import { REPO_COMMANDS, type Config, type CredentialStatus, type RepoCommand, type RepoRef, type SandboxStatus } from "./api.ts";
import { canonicalJson } from "./canonical.ts";
import { timeAgo } from "./utils.ts";
import { endpointError } from "./telemetry-model.ts";

/** One (project, repository) mapping row; rows with the same key form that project's `repos` (in row order). */
export interface RepoRow {
  key: string;
  /** ^[a-z0-9][a-z0-9._-]{0,39}$, unique in the project; blank = derived from the path */
  name: string;
  path: string;
  baseBranch: string;
  /** install / build / lint / test as typed ("" = not set) */
  commands?: Record<RepoCommand, string>;
}

const commandsRow = (c: RepoRef["commands"]): Record<RepoCommand, string> =>
  Object.fromEntries(REPO_COMMANDS.map((k) => [k, c?.[k] ?? ""])) as Record<RepoCommand, string>;

export const rowsOf = (c: Config): RepoRow[] =>
  Object.entries(c.projects).flatMap(([key, v]) =>
    v.repos.map((r) => ({ key, name: r.name, path: r.path, baseBranch: r.baseBranch, commands: commandsRow(r.commands) })),
  );

/** Same rule as the server (projects/safe-command): one command, words separated by single spaces, no shell. */
const SAFE_COMMAND = /^[A-Za-z0-9_./:@=+,-]+( [A-Za-z0-9_./:@=+,-]+)*$/;
const SHELL_FIRST = new Set(["eval", "exec", "source", ".", "command", "builtin", "export", "alias", "unset", "set", "env", "sudo", "sh", "bash", "zsh"]);
export function isSafeCommand(cmd: string): boolean {
  if (cmd.length > 200 || !SAFE_COMMAND.test(cmd)) return false;
  const first = cmd.split(" ")[0]!;
  return !first.includes("=") && !first.startsWith("-") && !SHELL_FIRST.has(first);
}

/** Same rule as the server (P-C13): basename, lower-cased, illegal characters to '-', leading non-[a-z0-9] dropped, max 40; empty → "repo". */
export function legacyRepoName(path: string): string {
  const base = path.split(/[\\/]+/).filter((p) => p !== "").pop() ?? "";
  const name = base.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
  return name === "" ? "repo" : name;
}

/** `base`, or `base-2`, `base-3`… when the name is already taken in the project. */
export function uniqueRepoName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, 40 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

/** Same rule as the server: a repository path is absolute (POSIX, or a Windows drive / UNC path). */
const ABSOLUTE_PATH = /^(\/|[A-Za-z]:[\\/]|\\\\)/;

/** Same rule as the server (F-I2): one line, 1-60 characters, no quotes, backticks or control characters. */
const READY_FOR_DEV_STATUS = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"'`]{1,60}$/u;

/** Same rule as the server: empty, or one token of [A-Za-z0-9._:-], max 80 characters, not starting with "-". */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** Same rule as the server: a branch name without spaces or control characters, not starting with '-', max 200. */
const BASE_BRANCH = /^[^-\s\p{Cc}][^\s\p{Cc}]{0,199}$/u;

/** Same rule as the server (S-2): the JIRA browser's display name, 1-80 characters, no control characters or line breaks. */
const BROWSER_NAME = /^[^\p{Cc}\p{Zl}\p{Zp}]{1,80}$/u;
export const isValidBrowserName = (v: string): boolean => BROWSER_NAME.test(v);

/** Same rule as the server: repository names are short slugs, unique within their project. */
export const REPO_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Same rule as the server: a bare command name or an absolute path on one line. */
const BARE_COMMAND = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
const ABSOLUTE_BIN = /^\/[^\p{Cc}\p{Zl}\p{Zp}]{1,499}$/u;
const isValidBin = (v: string): boolean => (BARE_COMMAND.test(v) && v !== "." && v !== "..") || ABSOLUTE_BIN.test(v);

/** "8080, 9000" → [8080, 9000]; empty → []; null when any entry is not a whole port 1-65535 (or more than 100). */
export function parsePorts(text: string): number[] | null {
  if (text.trim() === "") return [];
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length > 100 || parts.some((p) => !/^\d{1,5}$/.test(p))) return null;
  const ports = parts.map(Number);
  return ports.every((p) => p >= 1 && p <= 65535) ? ports : null;
}

const intIn = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

/** Build the config to save from the draft, the repo rows and the raw concurrency text; returns an error message when invalid. */
export function buildConfig(draft: Config, rows: RepoRow[], concurrencyText: string, portsText?: string): { config: Config; error: string | null } {
  let error: string | null = null;
  const projects: Config["projects"] = {};
  // explicit names first, so a derived name never takes one the developer typed
  const explicit = new Map<string, string[]>();
  for (const r of rows) {
    const name = r.name.trim();
    if (name !== "") explicit.set(r.key.trim(), [...(explicit.get(r.key.trim()) ?? []), name]);
  }
  for (const r of rows) {
    const key = r.key.trim();
    if (key === "") {
      error ??= t("settings.repoKeyEmpty");
      continue;
    }
    const path = r.path.trim();
    if (!ABSOLUTE_PATH.test(path)) error ??= t("settings.repoPathInvalid", { key });
    const repos = (projects[key] ??= { repos: [] }).repos;
    let name = r.name.trim();
    if (name === "") name = uniqueRepoName(legacyRepoName(path), [...repos.map((x) => x.name), ...(explicit.get(key) ?? [])]);
    else if (!REPO_NAME.test(name)) error ??= t("settings.repoNameInvalid", { key, name });
    else if (repos.some((x) => x.name === name)) error ??= t("settings.repoNameDuplicate", { key, name });
    const baseBranch = r.baseBranch.trim();
    if (!BASE_BRANCH.test(baseBranch)) error ??= t("settings.repoBranchInvalid", { key, name });
    const commands: NonNullable<RepoRef["commands"]> = {};
    for (const k of REPO_COMMANDS) {
      const v = (r.commands?.[k] ?? "").trim();
      if (v === "") continue;
      if (!isSafeCommand(v)) error ??= t("settings.repoCommandInvalid", { key, name, command: k });
      commands[k] = v;
    }
    repos.push(Object.keys(commands).length > 0 ? { name, path, baseBranch, commands } : { name, path, baseBranch });
  }
  const n = Number(concurrencyText);
  // F4C-1 (M-3): the server's range
  const concurrencyOk = /^\s*\d+\s*$/.test(concurrencyText) && n >= 1 && n <= 8;
  if (!concurrencyOk) error ??= t("settings.concurrencyInvalid");
  if (!READY_FOR_DEV_STATUS.test(draft.jira.readyForDevStatus)) error ??= t("settings.jiraReadyStatusInvalid");
  if (!READY_FOR_DEV_STATUS.test(draft.jira.inProgressStatus)) error ??= t("settings.jiraInProgressInvalid");
  const limit = draft.jira.discoverLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) error ??= t("settings.jiraDiscoverLimitInvalid");
  const model = (draft.executor.model ?? "").trim();
  if (model !== "" && !MODEL_NAME.test(model)) error ??= t("settings.executorModelInvalid");
  if (!intIn(draft.debate.maxRounds, 1, 5)) error ??= t("settings.maxRoundsInvalid");
  if (!intIn(draft.development.maxSteps, 1, 50)) error ??= t("settings.maxStepsInvalid");
  // shown in seconds: whole seconds, 10 s – 1 h
  const secs = (ms: number) => intIn(ms, 10_000, 3_600_000) && ms % 1000 === 0;
  if (!secs(draft.development.hookTimeoutMs)) error ??= t("settings.hookTimeoutInvalid");
  if (!secs(draft.development.commandTimeoutMs)) error ??= t("settings.commandTimeoutInvalid");
  if (!READY_FOR_DEV_STATUS.test(draft.jira.reviewStatus)) error ??= t("settings.jiraReviewStatusInvalid");
  if (!intIn(draft.review.maxAttempts, 1, 5)) error ??= t("settings.maxAttemptsInvalid");
  if (!intIn(draft.acceptance.startTimeoutMs, 10_000, 900_000) || draft.acceptance.startTimeoutMs % 1000 !== 0) error ??= t("settings.acceptStartInvalid");
  if (!intIn(draft.acceptance.runTimeoutMs, 60_000, 7_200_000) || draft.acceptance.runTimeoutMs % 1000 !== 0) error ??= t("settings.acceptRunInvalid");
  if (!intIn(draft.acceptance.caseTimeoutMs, 1_000, 600_000) || draft.acceptance.caseTimeoutMs % 1000 !== 0) error ??= t("settings.acceptCaseInvalid");
  // phase 4c: null = no limit; NaN = a typed value that is not a number
  const b = draft.budget;
  const inRange = (v: number | null, min: number, max: number, whole: boolean) => v === null || (Number.isFinite(v) && v >= min && v <= max && (!whole || Number.isInteger(v)));
  if (!inRange(b.maxRuns, 1, 10_000, true) || !inRange(b.maxRunMinutes, 1, 100_000, false) || !inRange(b.maxUsd, 0.01, 100_000, false) || !(b.warnAt >= 0.5 && b.warnAt <= 0.99)) {
    error ??= t("settings.budgetInvalid");
  }
  const dir = draft.acceptance.claudeConfigDir;
  if (dir.trim() === "" || !ABSOLUTE_PATH.test(dir)) error ??= t("settings.claudeConfigDirInvalid");
  if (!isValidBin(draft.delivery.ghBin)) error ??= t("settings.ghBinInvalid");
  if (!isValidBin(draft.delivery.azBin ?? "az")) error ??= t("settings.azBinInvalid");
  let ports = draft.development.deniedLocalPorts;
  if (portsText !== undefined) {
    const parsed = parsePorts(portsText);
    if (parsed === null) error ??= t("settings.deniedPortsInvalid");
    else ports = parsed;
  }
  const endpoint = draft.telemetry.endpoint.trim();
  const badEndpoint = endpointError(endpoint);
  if (badEndpoint) error ??= badEndpoint;
  error ??= modeError(draft);
  return {
    config: { ...draft, jira: withoutCredentials(draft.jira), executor: withoutCredentials({ ...draft.executor, model }), projects, concurrency: concurrencyOk ? n : draft.concurrency, development: { ...draft.development, deniedLocalPorts: ports }, telemetry: { ...draft.telemetry, endpoint } },
    error,
  };
}

/** Settings a paired phone may not change (R21; the server refuses them too). Debate / development limits stay phone-editable (P-phone). */
const MAC_ONLY = new Set([
  "projects", "executor", "prompts", "remoteAccess", "jira.baseUrl", "jira.readyForDevStatus", "jira.discoverLimit",
  "jira.syncStatus", "jira.inProgressStatus", "jira.browser",
  // phase 3 (R17 / R21): these change what is delivered, what runs, or what protects the run
  "jira.reviewStatus", "acceptance.claudeConfigDir", "delivery.ghBin", "delivery.azBin", "development.allowUnsandboxedCommands", "development.deniedLocalPorts",
  // phase 4a: the git-hooks sandbox switch and the local-network mode
  "development.allowUnsandboxedHooks", "development.localNetwork",
  // phase 4b: the executor and JIRA modes (credentials are set on this computer only, B-9)
  "executor.kind", "jira.source",
  // phase 4c (C-8): where runs are exported to and whether prompts and outputs go too
  "telemetry.endpoint", "telemetry.includeContent",
] as const);
export type SettingsField =
  | (typeof MAC_ONLY extends Set<infer F> ? F : never)
  | "debate.maxRounds" | "development.maxSteps" | "development.hookTimeoutMs" | "development.commandTimeoutMs"
  | "review.maxAttempts" | "acceptance.startTimeoutMs" | "acceptance.runTimeoutMs" | "acceptance.caseTimeoutMs"
  | "concurrency" | "autoRefine" | "reviewAcByDefault";

export const editable = (field: SettingsField, remoteClient: boolean): boolean => !remoteClient || !(MAC_ONLY as ReadonlySet<string>).has(field);

/** Dirty = the candidate differs from the saved config by value (key order is irrelevant), or it is invalid. */
export function isConfigDirty(saved: Config, built: { config: Config; error: string | null }): boolean {
  return built.error !== null || canonicalJson(built.config) !== canonicalJson(saved);
}

/** Sub-nav pills (below lg): scroll the active pill into view only when the active section changes — never on mount or re-render, never at lg+. */
export const shouldScrollActivePill = (prev: string | undefined, next: string, belowLg: boolean): boolean =>
  belowLg && prev !== undefined && prev !== next;

/** A shell word safe to paste: left as is when it only has [A-Za-z0-9_./-], else single-quoted with each ' written as '\\''. */
export function shellQuote(v: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Phase 4a Task 5: the Settings status card for the command sandbox. Available and its last check passed (or not run
 * yet): green; otherwise amber with the reason (the backend's, or the failed check's detail) and, when there is no
 * sandbox at all, what each opt-out switch does.
 */
export function sandboxStatusView(s: SandboxStatus): {
  tone: "ok" | "warn";
  title: "settings.sandboxStatusOn" | "settings.sandboxStatusOff";
  reason: string | null;
  notes: Array<"settings.sandboxStatusCommandsNote" | "settings.sandboxStatusHooksNote">;
} {
  if (!s.backend.available) {
    return { tone: "warn", title: "settings.sandboxStatusOff", reason: s.backend.reason, notes: ["settings.sandboxStatusCommandsNote", "settings.sandboxStatusHooksNote"] };
  }
  if (s.selfCheck !== null && !s.selfCheck.ok) return { tone: "warn", title: "settings.sandboxStatusOff", reason: s.selfCheck.detail, notes: [] };
  return { tone: "ok", title: "settings.sandboxStatusOn", reason: null, notes: [] };
}

// ---- phase 4b Task 7: modes and credentials ----

/** Same value as the server (config.ts API_CHROME, ruling B-4 / 4B-1): an API-key run cannot drive Chrome. */
export const API_CHROME: "available" | "unavailable" = "unavailable";

/** Same rule as the server: the API-key executor needs the JIRA API mode while API_CHROME is unavailable. */
export function modeError(c: Config): string | null {
  return (API_CHROME as string) === "unavailable" && c.executor.kind === "claude-api" && c.jira.source === "browser" ? t("settings.apiChromeUnavailable") : null;
}

/** Credential values never travel with the config (they have their own endpoints): any such field is dropped. */
const CREDENTIAL_KEYS = new Set(["email", "apiToken", "apiKey", "token", "password"]);
function withoutCredentials<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !CREDENTIAL_KEYS.has(k))) as T;
}

export type CredentialKind = "jira" | "anthropic";
export type CredentialFieldId = "anthropic.apiKey" | "jira.email" | "jira.apiToken";

export interface CredentialFieldView {
  id: CredentialFieldId;
  label: string;
  /**
   * F4B-5 (M-3): a text box, never a password box (a browser would offer to save a password field), autocomplete
   * off, never prefilled; `masked` boxes (the key, the token) hide what is typed with -webkit-text-security
   */
  inputType: "text";
  masked: boolean;
  set: boolean;
  /** "Set · updated 3d ago" / "Not set" here; "Set on this computer" / "Not set" on a paired phone */
  statusText: string;
  /** the email hint (this computer only) */
  hint: string | null;
  /** false on a paired phone (B-9: credentials are set on this computer only) */
  editable: boolean;
}

function statusText(s: { set: boolean; updatedAt: string | null }, remoteClient: boolean, now: number): string {
  if (!s.set) return t("settings.credNotSet");
  return remoteClient ? t("settings.credSetOnComputer") : t("settings.credSetUpdated", { when: timeAgo(s.updatedAt, now) });
}

/** The credential fields of one mode: Anthropic → the API key; JIRA → the email and the API token. */
export function credentialFields(kind: CredentialKind, status: CredentialStatus, remoteClient: boolean, now = Date.now()): CredentialFieldView[] {
  const editable = !remoteClient;
  if (kind === "anthropic") {
    return [{ id: "anthropic.apiKey", label: t("settings.anthropicKey"), inputType: "text", masked: true, set: status.anthropic.set, statusText: statusText(status.anthropic, remoteClient, now), hint: null, editable }];
  }
  const st = statusText(status.jira, remoteClient, now);
  return [
    { id: "jira.email", label: t("settings.jiraEmail"), inputType: "text", masked: false, set: status.jira.set, statusText: st, hint: remoteClient ? null : status.jira.emailHint, editable },
    { id: "jira.apiToken", label: t("settings.jiraToken"), inputType: "text", masked: true, set: status.jira.set, statusText: st, hint: null, editable },
  ];
}

/** What the developer typed: the email (JIRA only) and the token / key. Held in component state only. */
export interface CredentialInput {
  email: string;
  secret: string;
}

/** Same rules as the server (4B-3): an email, and a token / key of at least 16 characters. Never repeats the input. */
/** F4B-5 (M-7): the server's own rule (credential-store.ts): one @, no whitespace, at most 254 characters */
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const EMAIL_MAX = 254;
export const MIN_SECRET_LENGTH = 16;
export function credentialInputError(kind: CredentialKind, input: CredentialInput): string | null {
  if (kind === "jira" && (!EMAIL.test(input.email.trim()) || input.email.trim().length > EMAIL_MAX)) return t("settings.credEmailInvalid");
  if (input.secret.trim().length < MIN_SECRET_LENGTH) return t("settings.credSecretShort");
  return null;
}

/** The one request that carries a credential: PUT to its own endpoint, the value in the JSON body. */
export function credentialRequest(kind: "jira", input: CredentialInput): { path: "/api/credentials/jira"; body: { email: string; apiToken: string } };
export function credentialRequest(kind: "anthropic", input: CredentialInput): { path: "/api/credentials/anthropic"; body: { apiKey: string } };
export function credentialRequest(kind: CredentialKind, input: CredentialInput): { path: "/api/credentials/jira" | "/api/credentials/anthropic"; body: { email: string; apiToken: string } | { apiKey: string } };
export function credentialRequest(kind: CredentialKind, input: CredentialInput) {
  return kind === "jira"
    ? { path: "/api/credentials/jira" as const, body: { email: input.email.trim(), apiToken: input.secret.trim() } }
    : { path: "/api/credentials/anthropic" as const, body: { apiKey: input.secret.trim() } };
}

/** The mode comparison tables: one shared source with the README (`@slackoff/shared` mode-comparison.ts). */
export type ModeComparison = ModeComparisonTable;
export function modeComparison(kind: "executor" | "jira"): ModeComparison {
  return MODE_COMPARISON[kind];
}
