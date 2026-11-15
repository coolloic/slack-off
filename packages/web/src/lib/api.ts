import type {
  AgentRole, ChecklistItem, CommentResponse, DebateRoundRecord, DebateStep, DesignDoc, Disagreement, DriftResult, InstallReport, IterationRecord,
  JiraWriteRecord, RepoStatus, Requirement, Ruling, RulingRecord, Solution, StepRecord, TicketState,
  DeliveryPlan, DeliveryStepRecord, ReviewReportRecord, ReviewSeriesRecord, ReviewStep, UsagePause, UsageSummary, UsageWindow, TrialResult, PreferenceState,
} from "@slackoff/shared";
import { pairingRedirect } from "./remote-model.ts";

export type { UsagePause, UsageSummary, UsageWindow };
export type { TrialResult, PreferenceState };
export type { AgentRole, DebateStep, DriftResult, Requirement, Ruling, Solution, TicketState };

// ---- response shapes (mirrors packages/server/src/http/app.ts) ----

export interface Status {
  executor: { kind: "claude-code" | "claude-api"; label: string; available: boolean; reason?: string };
  jira: { configured: boolean; baseUrl: string; source: "browser" | "api" };
  concurrency: number;
  restartRequired: boolean;
  needsYou: number;
  /** JIRA writes waiting for "Send to JIRA" (counted apart from needsYou; the header badge adds them) */
  pendingJiraWrites: number;
  remoteAccess: { active: boolean; url: string | null };
  /** this browser runs on the Slack Off computer; paired devices get false (R21 fields are read-only for them) */
  local: boolean;
  /** phase 4c: the usage pause, the threshold state and how many tickets the pause stopped (blocked with a "Paused:" reason) */
  usage: {
    paused: UsagePause | null;
    budgetState: "ok" | "warn" | "over" | null;
    budgetRatio: number | null;
    budgetWindow: "5h" | "day" | "week" | null;
    waitingTickets: number;
  };
}

export interface Config {
  /** readyForDevStatus: Tickets-list default filter + highlight; discoverLimit: most open tickets one fetch reads (1–500) */
  jira: {
    baseUrl: string; readyForDevStatus: string; discoverLimit: number; source: "browser" | "api";
    /** the only JIRA write (move to inProgressStatus), each one confirmed in the UI; browser = the Chrome the JIRA agents use */
    syncStatus: boolean; inProgressStatus: string; reviewStatus: string; browser: { deviceId: string; name: string } | null;
  };
  projects: Record<string, { repos: RepoRef[] }>;
  executor: { kind: "claude-code" | "claude-api"; claudeBin: string; model: string };
  concurrency: number;
  autoRefine: boolean;
  reviewAcByDefault: boolean;
  remoteAccess: { enabled: boolean; host: string };
  debate: { maxRounds: number };
  development: {
    maxSteps: number; commandTimeoutMs: number; hookTimeoutMs: number;
    /** this computer only: run repository commands without the macOS sandbox */
    allowUnsandboxedCommands: boolean;
    /** this computer only: extra local ports the command sandbox denies */
    deniedLocalPorts: number[];
    /** this computer only (phase 4a): run the repos' git hooks without the sandbox when it is unavailable */
    allowUnsandboxedHooks: boolean;
    /** this computer only (phase 4a): local TCP from sandboxed commands — deny listed ports, or allow declared ports only */
    localNetwork: "denylist" | "allowlist";
  };
  review: { maxAttempts: number };
  acceptance: { claudeConfigDir: string; startTimeoutMs: number; runTimeoutMs: number; caseTimeoutMs: number };
  delivery: { ghBin: string; azBin: string };
  /** phase 4c: thresholds on new agent runs (phone-editable) */
  budget: {
    enabled: boolean;
    window: "5h" | "day" | "week";
    maxRuns: number | null;
    maxRunMinutes: number | null;
    maxUsd: number | null;
    warnAt: number;
  };
  /** phase 4c: run tracing (this computer only) — the OTLP/HTTP endpoint ("" = off) and whether prompts and outputs are sent */
  telemetry: { endpoint: string; includeContent: boolean };
}

/**
 * GET /api/credentials (phase 4b, B-9): whether each credential is set — never a value. emailHint ("y…@example.com") only
 * for a request from this computer; a paired phone gets null.
 */
export interface CredentialStatus {
  jira: { set: boolean; emailHint: string | null; updatedAt: string | null };
  anthropic: { set: boolean; updatedAt: string | null };
  otlpHeaders: { set: boolean; names: string[]; updatedAt: string | null };
}

/** GET /api/telemetry/preview (phase 4c, C-7): what "Export N runs to <host>" would send now; null when run tracing is off. */
export interface TelemetryPreview {
  endpointHost: string;
  runCount: number;
  includeContent: boolean;
  attributes: string[];
  /** binds the run ids, the endpoint and the content switch: a change before the confirmation gives 409 */
  runIdsHash: string;
}

/** One confirmed export (POST /api/telemetry/export). */
export interface TelemetryExport {
  id: number;
  endpointHost: string;
  runCount: number;
  includeContent: boolean;
  status: "running" | "done" | "failed";
  httpStatus: number | null;
  detail: string | null;
  decidedBy: string;
  requestedAt: string;
  finishedAt: string | null;
}

/** GET /api/sandbox (phase 4a Task 5): this computer's command sandbox, its last self-check (cached a minute) and the switches. */
export interface SandboxStatus {
  backend: { name: "sandbox-exec" | "none"; available: boolean; reason: string | null };
  /** ok, failed (the self-check did not pass), or unavailable (no sandbox backend on this OS) */
  status: "ok" | "failed" | "unavailable";
  /** on a paired phone, detail is a fixed text (never paths or stderr) */
  selfCheck: { ok: boolean; status: "ok" | "failed"; detail: string; at: string } | null;
  switches: { allowUnsandboxedCommands: boolean; allowUnsandboxedHooks: boolean; localNetwork: "denylist" | "allowlist" };
}

/** One repository of a project: name ^[a-z0-9][a-z0-9._-]{0,39}$, unique in the project. */
export interface RepoRef {
  name: string;
  path: string;
  baseBranch: string;
  /** set on this computer; the repository's .slackoff/config.json wins for any command it names */
  commands?: Partial<Record<RepoCommand, string>>;
}

export const REPO_COMMANDS = ["install", "build", "lint", "test"] as const;
export type RepoCommand = (typeof REPO_COMMANDS)[number];

export interface TailscaleAddress {
  ip: string;
  dnsName: string | null;
}

export interface RemoteInfo {
  /** this browser runs on the Slack Off computer (loopback) */
  local: boolean;
  /** the Tailscale listener this server is running with, null = local only */
  active: (TailscaleAddress & { url: string }) | null;
  detected: TailscaleAddress | null;
  restartRequired: boolean;
}

export interface Device {
  id: number;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface PairingStart {
  code: string;
  url: string;
  expiresAt: string;
}

export interface TicketRow {
  key: string;
  title: string;
  url: string | null;
  jiraStatus: string | null;
  /** false once a complete fetch no longer returned it (closed or reassigned in JIRA) */
  jiraOpen: boolean;
  state: TicketState;
  /** the state before `blocked` (null otherwise): a blocked ticket opens where it stopped */
  prevState: TicketState | null;
  blockedReason: string | null;
  reviewAc: boolean;
  driftNeedsAction: boolean;
  /** a JIRA write waits for "Send to JIRA" (F2-I2) */
  jiraWritePending: boolean;
  /** a delivery JIRA step (status / comment) failed and waits for a retry */
  deliveryStepFailed: boolean;
  updatedAt: string;
}

export interface Ticket {
  key: string;
  title: string;
  url: string | null;
  jiraStatus: string | null;
  state: TicketState;
  prevState: TicketState | null;
  blockedReason: string | null;
  reviewAc: boolean;
  repoPath: string | null;
  branch: string | null;
  worktreePath: string | null;
  reviewAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequirementRecord {
  id: number;
  ticketKey: string;
  snapshotId: number;
  version: number;
  content: Requirement;
  draftComment: string | null;
  source: "agent" | "human";
  createdAt: string;
}

export interface SolutionRecord {
  id: number;
  ticketKey: string;
  requirementId: number;
  idx: number;
  content: Solution;
}

export interface DriftRecord {
  id: number;
  ticketKey: string;
  requirementId: number;
  baselineSnapshotId: number;
  latestSnapshotId: number;
  trigger: "ac_edited" | "snapshot_changed" | "before_review";
  result: DriftResult;
  needsAck: boolean;
  acknowledged: boolean;
  createdAt: string;
}

export interface TicketDetail {
  ticket: Ticket;
  requirement: RequirementRecord | null;
  solutions: SolutionRecord[];
  /** the current choice; affectedRepos null for phase-1 choices */
  choice: { id: number; solutionId: number; requirementId: number; note: string | null; affectedRepos: string[] | null; skipDebate?: boolean; createdAt: string } | null;
  drift: DriftRecord | null;
}

export interface SnapshotSummary {
  id: number;
  fetchedAt: string;
  contentHash: string;
  changeSummary: string | null;
  /** F-I7: older comments the browser agent could not load; null = complete */
  commentsNotLoaded: number | null;
  /** F4B-4: the JIRA mode it was read in; null = before phase 4b (the browser) */
  jiraSource: "browser" | "api" | null;
}

export interface SnapshotComment {
  id: number;
  jiraCommentId: string | null;
  author: string | null;
  created: string | null;
  body: string | null;
}

export interface SnapshotAttachment {
  id: number;
  kind: string;
  filename: string | null;
  mime: string | null;
  localPath: string | null;
  sha256: string | null;
  url: string | null;
}

export interface Snapshot {
  id: number;
  ticketKey: string;
  fetchedAt: string;
  jiraUpdatedAt: string | null;
  title: string;
  description: string | null;
  contentHash: string;
  changeSummary: string | null;
  commentsNotLoaded: number | null;
  /** F4B-4: the JIRA mode it was read in; null = before phase 4b (the browser) */
  jiraSource: "browser" | "api" | null;
  comments: SnapshotComment[];
  attachments: SnapshotAttachment[];
}

export interface PromptInfo {
  role: AgentRole;
  skill: { name: string; version: string };
  current: { version: number; text: string } | null;
}

/** phase 4d (D-6): GET /api/prompts/:role/default */
export interface BuiltInPrompt {
  name: string;
  version: string;
  body: string;
}

export interface PromptVersion {
  id: number;
  role: AgentRole;
  version: number;
  text: string;
  createdAt: string;
}

export type BusEvent =
  | { type: "agent_event"; ticketKey?: string; role: AgentRole; runId: string; event: { kind: string; text: string }; trial?: true }
  | { type: "state_changed"; ticketKey: string; from: string; to: string }
  | { type: "source_error"; message: string }
  | { type: "ticket_discovered"; ticketKey: string }
  | { type: "ticket_read"; ticketKey: string; ok: boolean }
  | { type: "debate_updated"; ticketKey: string }
  | { type: "snapshot_changed"; ticketKey: string; needsAck: boolean }
  | { type: "dev_step"; ticketKey: string; iteration: number; step: number }
  | { type: "jira_write_updated"; ticketKey: string }
  | { type: "review_updated"; ticketKey: string }
  | { type: "jira_comment_updated"; ticketKey: string }
  | { type: "delivery_updated"; ticketKey: string }
  | { type: "usage_changed" }
  | { type: "preferences_changed" }
  | { type: "discover_finished"; created: number; returned: number; total: number; complete: boolean; loginRequired?: true; error?: string };

/** GET /api/tickets/:key/design — the current choice's debate, docs without bodies. */
export interface DesignResponse {
  choiceId: number | null;
  affectedRepos: string[];
  checklist: ChecklistItem[];
  /** why the repos' rules could not be read (then `checklist` is the base list) */
  checklistError: string | null;
  maxRounds: number;
  docs: Array<{ version: number; isFinal: boolean; createdAt: string; checklist: DesignDoc["checklist"] }>;
  rounds: DebateRoundRecord[];
  rulings: RulingRecord[];
  disagreements: Disagreement[];
  /** the arbiter's recommended ruling per disagreement (escalated debates) */
  advice: Array<{ commentId: string; decision: "designer" | "critic" | "custom"; note: string; reason: string }>;
  step: DebateStep | null;
}

/** GET /api/tickets/:key/design/docs/:version */
export interface DesignDocResponse {
  version: number;
  choiceId: number;
  requirementId: number;
  isFinal: boolean;
  createdAt: string;
  contentMd: string;
  repos: DesignDoc["repos"];
  checklist: DesignDoc["checklist"];
  responses: CommentResponse[];
}

/** One affected repo in GET /api/tickets/:key/development; `status` is computed by the server (P-C18). */
export interface DevelopmentRepo {
  name: string;
  /** F2-R1: blocked, and this repo's git hooks differ from the pin recorded when development started */
  hooksChanged: boolean;
  branch: string | null;
  worktreePath: string | null;
  baseBranch: string;
  baseBranchChanged: { stored: string; mapped: string } | null;
  rulesFound: boolean;
  rulesError: string | null;
  commands: { install?: string; test?: string; build?: string; lint?: string };
  forbiddenPaths: string[];
  hooks: { configured: boolean; installed: boolean; hooksPath: string | null } | null;
  install: InstallReport | null;
  diffStat: { files: number; insertions: number; deletions: number } | null;
  commits: Array<{ sha: string; subject: string }>;
  checkOutputs: string[];
  pendingChanges: boolean;
  status: RepoStatus;
}

/** GET /api/tickets/:key/development */
export interface DevelopmentResponse {
  branch: string | null;
  ticketDir: string;
  repos: DevelopmentRepo[];
  iterations: Array<IterationRecord & { steps: StepRecord[] }>;
  jiraWrites: JiraWriteRecord[];
  jiraSync: { enabled: boolean; targetStatus: string; note: string | null };
  /** dev_done: whether "Hand off to acceptance" can start (no uncommitted changes in a worktree) */
  handOff: { enabled: boolean; reason: string | null };
}

/** GET /api/tickets/:key/review */
export interface ReviewResponse {
  maxAttempts: number;
  series: ReviewSeriesRecord[];
  reports: Array<{ id: number; seriesId: number; attempt: number; verdict: ReviewReportRecord["verdict"]; createdAt: string; decision: string | null; failedAcs: string[] }>;
  /** the current round's latest report */
  current: ReviewReportRecord | null;
  evidence: Array<{ id: number; refKey: string; acId: string; kind: string; caption: string }>;
  step: ReviewStep | null;
  isolationNote: string;
}

/** GET /api/tickets/:key/review/reports/:id */
export type ReviewReportResponse = ReviewReportRecord & { decision: string | null; evidence: ReviewResponse["evidence"] };

/** GET /api/tickets/:key/delivery/preview: the plan plus the JIRA sync note */
/** needsAck: the delivery came back because JIRA changed; confirming needs a note */
export type DeliveryPreview = DeliveryPlan & { jiraNote: string | null; needsAck: boolean };

export interface DeliveryRecord {
  id: number;
  reportId: number;
  planHash: string;
  ackNote: string | null;
  decidedBy: string;
  createdAt: string;
  steps: DeliveryStepRecord[];
}

/** GET /api/tickets/:key/delivery */
export interface DeliveryResponse {
  deliveries: DeliveryRecord[];
  prs: Array<{ repo: string; number: number; url: string }>;
}

/** GET /api/discovery: the last successful fetch (returned of total open tickets). */
export interface DiscoveryRun {
  finishedAt: string;
  returned: number;
  total: number;
  complete: boolean;
}

// ---- client ----

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Every request is JSON: the server's guard rejects bodies without `content-type: application/json`. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const to = pairingRedirect(res.status, window.location.pathname);
    if (to) window.location.assign(to);
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  get: <T>(path: string) => request<T>("GET", path),

  discover: () => request<{ accepted: boolean }>("POST", "/api/discover"),
  refine: (key: string) => request<{ accepted: boolean }>("POST", `/api/tickets/${enc(key)}/refine`),
  readJira: (key: string) => request<{ accepted: boolean }>("POST", `/api/tickets/${enc(key)}/read-jira`),
  resetBranch: (key: string) => request<BranchTypeView>("POST", `/api/tickets/${enc(key)}/reset-branch`),
  setBranchType: (key: string, type: string | null) => request<BranchTypeView>("PUT", `/api/tickets/${enc(key)}/branch-type`, { type }),
  setBaseBranch: (key: string, repo: string, branch: string | null) =>
    request<{ repos: BaseBranchRepo[] }>("PUT", `/api/tickets/${enc(key)}/base-branches/${enc(repo)}`, { branch }),
  setReviewAc: (key: string, reviewAc: boolean) => request<Ticket>("PATCH", `/api/tickets/${enc(key)}`, { reviewAc }),
  saveRequirement: (key: string, r: Requirement) => request<Ticket>("PUT", `/api/tickets/${enc(key)}/requirement`, r),
  confirmRequirement: (key: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/confirm-requirement`),
  ackDrift: (key: string, note: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/drift/ack`, { note }),
  backToEditing: (key: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/back-to-editing`),
  /** affectedRepos from the picker (multi-repo projects); left out, the server uses the solution's own set. */
  /** skipDebate: the designer writes the design once and it is final, no critic rounds. */
  choose: (key: string, solutionId: number, note: string, affectedRepos?: string[], skipDebate = false) =>
    request<Ticket>("POST", `/api/tickets/${enc(key)}/choose`, { solutionId, note, affectedRepos, skipDebate }),
  /** awaiting_debate_ruling: one ruling per disagreement. */
  rule: (key: string, rulings: Ruling[]) => request<Ticket>("POST", `/api/tickets/${enc(key)}/debate/rulings`, { rulings }),
  /** awaiting_debate_ruling | dev_done → awaiting_choice. */
  rechoose: (key: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/rechoose`),
  /** phase 4c: stop / allow new agent runs (any paired device) */
  pauseUsage: (note: string) => request<{ paused: UsagePause }>("POST", "/api/usage/pause", { note }),
  resumeUsage: () => request<{ paused: null }>("POST", "/api/usage/resume"),
  /** note: the developer's answer for the developer agent, kept for every later step */
  retry: (key: string, note?: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/retry`, note === undefined ? undefined : { note }),
  /** awaiting_snapshot_ack → developing (note required, R13) or → refining. */
  ackSnapshot: (key: string, note: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/snapshot-ack`, { note }),
  replan: (key: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/replan`),
  /** dev_done → developing: a new iteration with the developer's note. */
  requestChanges: (key: string, note: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/development/request-changes`, { note }),
  /** F2-R1: this computer only */
  acceptHooks: (key: string, repo: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/development/accept-hooks`, { repo }),
  /** The only JIRA write, decided by the developer (confirm / skip a pending write; retry = a new pending write). */
  jiraWrite: (key: string, id: number, action: "confirm" | "skip" | "retry") =>
    request<{ jiraWrites: JiraWriteRecord[] }>("POST", `/api/tickets/${enc(key)}/jira-writes/${id}/${action}`),
  /** Send a requirement-unclear comment to the reporter (202; the server checks the text and refuses a second one while one is being sent). */
  sendComment: (key: string, text: string) => request<{ id: number }>("POST", `/api/tickets/${enc(key)}/jira-comments`, { text }),
  /** Send a failed comment again. */
  retryComment: (key: string, id: number) => request<{ id: number }>("POST", `/api/tickets/${enc(key)}/jira-comments/${id}/retry`),
  /** This computer only (A-1): the Chrome browsers connected to Claude. */
  detectBrowsers: () => request<{ browsers: Array<{ deviceId: string; name: string }> }>("POST", "/api/jira/browsers/detect"),
  /** One affected repo's branch diff as plain text (shown as text only). */
  diff: async (key: string, repo: string): Promise<{ text: string; truncated: boolean }> => {
    const res = await fetch(`/api/tickets/${enc(key)}/diff?repo=${enc(repo)}`, { headers: { accept: "text/plain" } });
    const text = await res.text();
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const data = JSON.parse(text) as { error?: unknown };
        if (data && typeof data === "object" && "error" in data) msg = String(data.error);
      } catch {
        // not JSON
      }
      throw new ApiError(res.status, msg);
    }
    return { text, truncated: res.headers.get("x-truncated") === "1" };
  },
  abandon: (key: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/abandon`),

  /** dev_done → reviewing */
  handOff: (key: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/review/handoff`),
  /** awaiting_review_ack → reviewing (note required) */
  ackReview: (key: string, note: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/review/ack`, { note }),
  rejectReview: (key: string, note: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/review/reject`, { note }),
  reReview: (key: string, note: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/review/re-review`, { note }),
  /** 400 for blockers, 409 when the plan changed since the preview */
  confirmDelivery: (key: string, planHash: string, ackNote?: string) =>
    request<Ticket>("POST", `/api/tickets/${enc(key)}/delivery/confirm`, { planHash, ...(ackNote ? { ackNote } : {}) }),
  previewAgain: (key: string) => request<Ticket>("POST", `/api/tickets/${enc(key)}/delivery/preview-again`),
  retryDeliveryStep: (key: string, stepId: number) =>
    request<{ deliveries: DeliveryRecord[] }>("POST", `/api/tickets/${enc(key)}/delivery/steps/${stepId}/retry`),
  /** One evidence file as text (HTTP / log evidence; shown as text only). */
  evidenceText: async (key: string, id: number): Promise<string> => {
    const res = await fetch(paths.evidence(key, id));
    if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    return res.text();
  },

  /**
   * Phase 4b (B-9): this computer only. The value goes in the JSON body of this one request (never a URL, storage or
   * log); the answer is the status only.
   */
  setCredential: (path: "/api/credentials/jira" | "/api/credentials/anthropic", body: { email: string; apiToken: string } | { apiKey: string }) =>
    request<CredentialStatus>("PUT", path, body),
  removeCredential: (which: "jira" | "anthropic" | "otlp-headers") => request<CredentialStatus>("DELETE", `/api/credentials/${which}`),
  /** phase 4c: the OTLP auth headers (this computer only; the answer lists the names, never a value) */
  setOtlpHeaders: (body: { headers: Record<string, string> }) => request<CredentialStatus>("PUT", "/api/credentials/otlp-headers", body),
  /** phase 4c (C-7): send exactly the previewed runs; 409 when they (or the endpoint, or the content switch) changed */
  exportTelemetry: (runIdsHash: string) => request<{ export: TelemetryExport }>("POST", "/api/telemetry/export", { runIdsHash }),

  saveConfig: (c: Config) => request<{ config: Config; restartRequired: boolean }>("PUT", "/api/config", c),
  savePrompt: (role: AgentRole, text: string) => request<{ id: number; version: number }>("PUT", `/api/prompts/${enc(role)}`, { text }),
  resetPrompt: (role: AgentRole) => request<{ id: number; version: number }>("POST", `/api/prompts/${enc(role)}/reset`),
  /** phase 4d (§9.4): the preference summary — this computer only */
  editPreferences: (text: string) => request<PreferenceState>("PUT", "/api/preferences", { text }),
  clearPreferences: () => request<PreferenceState>("POST", "/api/preferences/clear"),
  rederivePreferences: () => request<PreferenceState>("POST", "/api/preferences/rederive"),
  /** phase 4d: run the unsaved draft once on the sample ticket (this computer only); resolves when the run is done */
  trialPrompt: (role: AgentRole, text: string) => request<TrialResult>("POST", `/api/prompts/${enc(role)}/trial`, { text }),

  startPairing: () => request<PairingStart>("POST", "/api/pair/start"),
  redeemPairing: (code: string, deviceName: string) => request<{ device: Device }>("POST", "/api/pair/redeem", { code, deviceName }),
  revokeDevice: (id: number) => request<{ revoked: boolean }>("DELETE", `/api/devices/${id}`),
};

/** A ticket's base branch for one repo: the mapping's default, the ticket's choice (null = default), locked once its ticket branch exists. */
/** The ticket branch's conventional type (chosen, else guessed from the title) and the name it gives. */
export interface BranchTypeView {
  type: string;
  chosen: boolean;
  locked: boolean;
  name: string;
}

export interface BaseBranchRepo {
  name: string;
  default: string;
  chosen: string | null;
  locked: boolean;
  used: string | null;
  options: string[];
}

export const paths = {
  baseBranches: (key: string) => `/api/tickets/${enc(key)}/base-branches`,
  devQuestion: (key: string) => `/api/tickets/${enc(key)}/dev-question`,
  branchType: (key: string) => `/api/tickets/${enc(key)}/branch-type`,
  status: "/api/status",
  remote: "/api/remote",
  devices: "/api/devices",
  pairStatus: "/api/pair/status",
  config: "/api/config",
  sandbox: "/api/sandbox",
  usage: (window: UsageWindow) => `/api/usage?window=${window}`,
  credentials: "/api/credentials",
  telemetryPreview: "/api/telemetry/preview",
  tickets: "/api/tickets",
  discovery: "/api/discovery",
  ticket: (key: string) => `/api/tickets/${enc(key)}`,
  requirements: (key: string) => `/api/tickets/${enc(key)}/requirements`,
  drift: (key: string) => `/api/tickets/${enc(key)}/drift`,
  design: (key: string) => `/api/tickets/${enc(key)}/design`,
  development: (key: string) => `/api/tickets/${enc(key)}/development`,
  review: (key: string) => `/api/tickets/${enc(key)}/review`,
  reviewReport: (key: string, id: number) => `/api/tickets/${enc(key)}/review/reports/${id}`,
  /** screenshots load straight from here (`<img>`); text evidence via api.evidenceText */
  evidence: (key: string, id: number) => `/api/tickets/${enc(key)}/review/evidence/${id}`,
  jiraComments: (key: string) => `/api/tickets/${enc(key)}/jira-comments`,
  delivery: (key: string) => `/api/tickets/${enc(key)}/delivery`,
  deliveryPreview: (key: string) => `/api/tickets/${enc(key)}/delivery/preview`,
  designDoc: (key: string, version: number) => `/api/tickets/${enc(key)}/design/docs/${version}`,
  snapshots: (key: string) => `/api/tickets/${enc(key)}/snapshots`,
  snapshot: (key: string, id: number) => `/api/tickets/${enc(key)}/snapshots/${id}`,
  attachment: (key: string, id: number, aid: number) => `/api/tickets/${enc(key)}/snapshots/${id}/attachments/${aid}`,
  prompt: (role: AgentRole) => `/api/prompts/${enc(role)}`,
  promptVersions: (role: AgentRole) => `/api/prompts/${enc(role)}/versions`,
  promptDefault: (role: AgentRole) => `/api/prompts/${enc(role)}/default`,
  preferences: "/api/preferences",
};
