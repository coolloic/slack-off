import type { DatabaseSync } from "node:sqlite";
import { DriftResult, driftNeedsAck, proposeResultSchema, Requirement, type Ruling, type TicketState, isTicketKey } from "@slackoff/shared";
import type { Actor } from "../audit/audit-log.ts";
import type { Config } from "../config.ts";
import { withTx } from "../db/tx.ts";
import { acknowledgeDrift as ackDrift, latestDrift, saveDrift } from "../drift/drift-repo.ts";
import type { RunAgentRequest } from "../executor/run-agent.ts";
import { AgentInterruptedError, BrowserChoiceRequiredError, UsageLimitError } from "../executor/types.ts";
import { UsagePausedError } from "../cost/budget-gate.ts";
import type { BusEvent, EventBus } from "../http/events.ts";
import { affectedRepos, loadProjectRules, projectRepos, type RepoContext } from "../projects/project-rules.ts";
import { createDebateJobs } from "../design/debate-jobs.ts";
import { createDevJobs } from "../development/dev-jobs.ts";
import { createPrecheckJobs } from "../development/precheck.ts";
import { buildDriftPrompt, snapshotForPrompt } from "../drift/drift-prompt.ts";
import { isSourceError, jiraLoginError, JiraLoginRequiredError, type JiraMode, type TicketSource } from "../jira/ticket-source.ts";
import type { JiraUpdater } from "../jira/jira-updater.ts";
import { createJiraWriteFlow } from "../jira/jira-write-jobs.ts";
import type { JiraCommenter } from "../jira/jira-commenter.ts";
import { createJiraCommentFlow } from "../jira/jira-comment-jobs.ts";
import {
  addRequirement, currentChoice, firstRequirement, latestRequirement, listSolutions, recordChoice, saveSolutions, type RequirementRecord,
} from "../requirements/requirement-repo.ts";
import { baselineSnapshot, listSnapshots, saveSnapshot } from "../snapshots/snapshot-store.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../tickets/errors.ts";
import { transition } from "../tickets/state-machine.ts";
import { getTicket, listRepoWorkspaces, markJiraOpen, recordDiscoveryRun, upsertDiscovered, type Ticket } from "../tickets/ticket-repo.ts";
import { setTicketBase, setTicketBranchType, ticketBases, ticketBranchType } from "../tickets/base-branch-repo.ts";
import { addDevNote, clearDevQuestion, devQuestion } from "../tickets/dev-note-repo.ts";
import { branchName, git } from "../git/worktree.ts";
import { guessBranchType, isBranchType, type AnswerOption, type BranchType } from "@slackoff/shared";
import type { JobQueue } from "./queue.ts";
import { sandboxSelfCheck, type SandboxCheck, type SandboxScope } from "../sandbox/local-sandbox.ts";
import { PlatformProcesses } from "../acceptance/app-runner.ts";
import { createReviewJobs, type AcceptanceTestHooks } from "../acceptance/review-jobs.ts";
import { dirname, join } from "node:path";
import { GhClient } from "../delivery/gh.ts";
import { createDeliveryJobs } from "../delivery/delivery-jobs.ts";
import type { DeliveryPlan } from "@slackoff/shared";
import { fileURLToPath } from "node:url";
import { redactKnown, redactStored } from "../credentials/credential-store.ts";
import { refreshDerived, supersedeTicketSignals } from "../preferences/preference-repo.ts";
import { describeError, logError } from "../log.ts";

/** The Slack Off checkout (packages/server/src/workflow → the repo root): its node_modules holds @playwright/test. */
const DEFAULT_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface WorkflowDeps {
  db: DatabaseSync;
  home: string;
  queue: JobQueue;
  source: TicketSource;
  /** runAgent with its deps bound */
  run: <T>(req: RunAgentRequest<T>) => Promise<T>;
  config: Config;
  bus: EventBus;
  /** the only JIRA write: move a ticket to In Progress, each write confirmed by the developer (Task 12, P-C7) */
  updater: JiraUpdater;
  /** Task 10 (phase 3, ruling R8): posts the developer-confirmed comments; optional — the default throws when called, so tests that never send one need not pass it */
  commenter?: JiraCommenter;
  /** Hooks filled in by later flows (default no-op), see WorkflowCtx. */
  hooks?: Partial<Pick<WorkflowCtx, "afterDesignFinal" | "onDevelopmentStarted" | "enqueueDevelop" | "enqueueReview">>;
  /** Task 5: the local command sandbox's self-check before each repo command (default sandboxSelfCheck; tests inject a failing one) */
  sandboxCheck?: (s: SandboxScope) => Promise<SandboxCheck>;
  /** Task 9: the registry of target app process groups (main.ts kills them on shutdown and exit); default a new one */
  processes?: PlatformProcesses;
  /** Task 9: the Slack Off checkout whose node_modules has @playwright/test (default: this source tree's) */
  repoRoot?: string;
  /** tests only (T9-8): the seam around the move of the acceptance dir out of the run root */
  acceptanceTestHooks?: AcceptanceTestHooks;
  /**
   * Task 12 (rulings R8, R3): the gh client for a binary path; built on every use with `config.delivery.ghBin`, so a
   * Settings change applies at once. Optional: default `bin => new GhClient(bin)`.
   */
  gh?: (bin: string) => GhClient;
  /** fake mode only (Task 17): checked before every push (the fake origin must be a local bare repository) */
  beforePush?: (wt: string, repo: string) => Promise<void>;
  /** F-4 (M-3): the Tailscale address(es) the server listens on now (remote access on); default none */
  remoteHosts?: () => readonly string[];
  /** phase 4b (M5): the JIRA mode of the running job (JiraClients.mode, pinned per job) for the jobs' wording; default config.jira.source */
  jiraMode?: () => JiraMode;
}

/** What a flow module (createDebateJobs, createDevJobs) needs from the workflow: its deps plus the shared helpers. */
export interface WorkflowCtx {
  db: DatabaseSync;
  home: string;
  queue: JobQueue;
  run: <T>(req: RunAgentRequest<T>) => Promise<T>;
  config: Config;
  bus: EventBus;
  mustGet(key: string): Ticket;
  /** Change state (audited); `extra` joins the audit payload. state_changed is emitted after the enclosing `atomic` commits. */
  move(key: string, to: TicketState, actor: Actor, reason?: string, extra?: Record<string, unknown>): void;
  /** One transaction; events raised inside are emitted only once it commits. */
  atomic<T>(fn: () => T): T;
  /** Enqueue a ticket job: AgentInterruptedError leaves the ticket as is, any other error blocks it. */
  job(id: string, key: string, fn: () => Promise<void>): void;
  requireState(t: Ticket, ...states: TicketState[]): void;
  cwdFor(t: Ticket): string;
  /** The current choice's affected repos resolved against today's mapping, with their rules (RepoNotMappedError names a repo that is gone). */
  repoContexts(key: string): Promise<RepoContext[]>;
  /** Called once a design is final; default: re-read the JIRA snapshot before development (Task 10). */
  afterDesignFinal(key: string): void;
  /** Start the development job `develop:<KEY>` of a ticket in developing (default: the implement-ticket loop, Task 11). */
  enqueueDevelop(key: string): void;
  /** Start the acceptance job `review:<KEY>` of a ticket in reviewing (Task 9); called after the move has committed. */
  enqueueReview(key: string): void;
  /** Called fire-and-forget when development starts (Task 12, P-C7); default: request the optional JIRA In Progress
   * write; never changes the ticket's state. */
  onDevelopmentStarted(key: string, repos: RepoContext[]): void;
  /** Task 5: the sandbox self-check used before repository commands */
  sandboxCheck(s: SandboxScope): Promise<SandboxCheck>;
  /** F-4 (M-3): the scope fields naming the server's Tailscale listener (probed by the self-check); {} when none */
  remoteScope(): Pick<SandboxScope, "remoteHosts">;
  /** phase 4b (M5): the JIRA mode of the running job, for what a JIRA error tells the developer */
  jiraMode(): JiraMode;
}

export interface BaseBranchView {
  name: string;
  default: string;
  chosen: string | null;
  locked: boolean;
  used: string | null;
  options: string[];
}

const BASE_CANDIDATE = /^(develop|development|dev|main|master|(release|hotfix|support)\/.+)$/;
const BASE_OPTIONS_MAX = 30;

export interface Workflow {
  discover(): void;
  /** Start (or restart) refining. decidedBy: who asked ('local' | `device:<id>`), null when the platform did (auto-refine). */
  refine(key: string, decidedBy: string | null): void;
  /**
   * Read a ticket from JIRA (read-only) and save it as a snapshot, without refining or any other step: the job
   * `read:<KEY>`. Any ticket that is not finished (pr_opened, abandoned): a discovered ticket's first look, or a
   * re-read (unchanged content adds no snapshot; Chrome mode also records the attachment addresses). The state never
   * changes; a failure (an expired login…) is a source_error and changes nothing.
   */
  readSnapshot(key: string): void;
  /**
   * Each mapped repo of the ticket: the mapping's default base, the ticket's own choice (null = the default), whether
   * its ticket branch exists (then `used` is the base it was made from and the choice is locked) and the branches to
   * offer (develop/main/master, release/*, hotfix/*, support/*, local or on origin, most recent first).
   */
  baseBranches(key: string): Promise<BaseBranchView[]>;
  /** The ticket's base branch for one repo (null = the default) until that repo's ticket branch exists. */
  setBaseBranch(key: string, repo: string, branch: string | null, decidedBy: string): Promise<void>;
  /** The ticket branch's conventional type (chosen, else guessed from the title) and the name it gives; locked once a ticket branch exists. */
  branchType(key: string): { type: BranchType; chosen: boolean; locked: boolean; name: string };
  /** type null: back to the guess from the title. Only until the ticket's branch exists. */
  setBranchType(key: string, type: BranchType | null, decidedBy: string): void;
  /**
   * refined / awaiting_ac_review / awaiting_drift_ack → proposing. Not exposed as a route (proposing follows the
   * developer's AC confirmation or drift acknowledgement); decidedBy is required like every human action and audited
   * on the state change — internal callers pass "local".
   */
  propose(key: string, decidedBy: string): void;
  /**
   * Continue a ticket left in a working state (refining, refined, proposing, checking_drift, designing, design_final,
   * checking_snapshot, developing, reviewing); other states are left alone.
   */
  resume(key: string): void;
  /** awaiting_ac_review → checking_drift with the developer's edit; decidedBy audited on the state change. */
  editRequirement(key: string, r: Requirement, decidedBy: string): void;
  /** awaiting_ac_review → proposing; decidedBy audited on the state change. */
  confirmRequirement(key: string, decidedBy: string): void;
  /**
   * Human actions take decidedBy — 'local' (this computer) or `device:<id>` (a paired device), derived by the HTTP layer
   * from the request, never from its body — and audit it (Task 13: required, so no route can forget it).
   * acknowledgeDrift: audited on the acknowledgement and the state change.
   */
  acknowledgeDrift(key: string, note: string, decidedBy: string): void;
  /** awaiting_snapshot_ack → developing and enqueue develop:<KEY> (P-C21); the note is required (R13); decidedBy as above. */
  ackSnapshot(key: string, note: string, decidedBy: string): void;
  /** awaiting_snapshot_ack | awaiting_review_ack → refining: refine again from the changed ticket; decidedBy audited on the state change. */
  replan(key: string, decidedBy: string): void;
  /** awaiting_drift_ack → awaiting_ac_review; decidedBy audited on the state change. */
  backToEditing(key: string, decidedBy: string): void;
  /**
   * Choose a solution and lock its affected repos. Omitted → the solution's own set; given → non-empty, distinct, every
   * name mapped for the project (may differ from the solution's: the developer edited it; both are audited).
   * decidedBy: 'local' or `device:<id>`.
   */
  /** skipDebate: the designer writes the design once and it is final, no critic rounds (a straightforward solution). */
  choose(key: string, solutionId: number, note: string, affectedRepos: string[] | undefined, decidedBy: string, skipDebate?: boolean): void;
  /**
   * awaiting_debate_ruling | dev_done → awaiting_choice: choose a different solution (and affected repos). The old
   * design docs and debate stay; the next choice debates from a new draft. decidedBy audited on the state change.
   */
  rechoose(key: string, decidedBy: string): void;
  /**
   * awaiting_debate_ruling only: one ruling per disagreement (blocking comment of the last critic round). All for the
   * designer → design_final; otherwise back to designing, where the designer applies them once before finalizing.
   */
  ruleDebate(key: string, rulings: Ruling[], decidedBy: string): void;
  /** dev_done → developing: a new iteration (trigger developer_request) with the required note; decidedBy as above. */
  requestChanges(key: string, note: string, decidedBy: string): void;
  /** F2-R1: blocked only — trust `repo`'s current git hooks for this ticket's commits (audited hooks_repinned); then Retry. */
  acceptHooks(key: string, repo: string, decidedBy: string): Promise<void>;
  /** blocked / dev_done: remove an untouched ticket branch (no commits, clean) so the next development names it afresh. */
  resetBranch(key: string, decidedBy: string): Promise<void>;
  /** Task 12: the developer's "Send to JIRA" on a pending write (pending → confirmed, enqueues `jira-write:<id>`);
   * decidedBy 'local' or `device:<id>` (a paired phone may confirm). Never changes the ticket's state. */
  confirmJiraWrite(key: string, writeId: number, decidedBy: string): void;
  /** pending → skipped. */
  skipJiraWrite(key: string, writeId: number, decidedBy: string): void;
  /** failed only: a new pending write that needs its own confirmation. */
  retryJiraWrite(key: string, writeId: number, decidedBy: string): void;
  /** Task 10: the developer's confirmed clarification comment (requirement unclear): recorded as confirmed and sent as the job
   * `jira-comment:<id>`; any non-terminal state, independent of jira.syncStatus. Never changes the ticket's state. */
  sendClarification(key: string, text: string, decidedBy: string): { id: number };
  /** failed comments only: a new confirmed record with the same text, sent again. */
  retryComment(key: string, commentId: number, decidedBy: string): { id: number };
  /** blocked → its previous state, resumed; decidedBy audited on the state change and on a development retry iteration. */
  /** note: the developer's answer for the developer agent (its needsInput question), kept for every later step */
  retry(key: string, decidedBy: string, note?: string): void;
  /** The developer agent's open question with its suggested answers (one may be recommended), or null. */
  devQuestion(key: string): { question: string; options: AnswerOption[] } | null;
  /** → abandoned; decidedBy audited on the state change; pending / not-yet-sent JIRA writes are skipped (F2-I3). */
  abandon(key: string, decidedBy: string): void;
  /** Task 9: dev_done → reviewing: a new review round (handoff); the job re-reads the ticket, checks drift, then accepts. */
  handOff(key: string, decidedBy: string): void;
  /** Task 9: awaiting_review_ack → reviewing; the note is required (R13); the drift check is acknowledged. */
  ackReview(key: string, note: string, decidedBy: string): void;
  /** Task 9: awaiting_confirmation → developing with the note (decision rejected; a new round; a rejected iteration). */
  rejectReview(key: string, note: string, decidedBy: string): void;
  /** Task 9: awaiting_confirmation → reviewing with the note (decision re_review); refused once the round is at the cap. */
  reReview(key: string, note: string, decidedBy: string): void;
  /** Task 9: startup recovery of acceptance runs a previous process left running (before tickets are resumed). */
  recoverAcceptanceRuns(): void;
  /** Task 12: the delivery plan of a ticket in awaiting_confirmation (read only; the GET preview route, ruling R10). */
  previewDelivery(key: string): Promise<DeliveryPlan & { jiraNote: string | null; needsAck: boolean }>;
  /**
   * Task 12: "Confirm and deliver": the plan is recomputed — blockers → ValidationError, another hash →
   * InvalidTransitionError (409); then awaiting_confirmation → delivering and the job `deliver:<KEY>`. The ack note is
   * stored and audited but not hashed (R10); decidedBy audited.
   */
  confirmDelivery(key: string, planHash: string, ackNote: string | null, decidedBy: string): Promise<void>;
  /** Task 12: send a failed JIRA step (status / comment) of a delivered ticket (pr_opened) again; decidedBy audited. */
  retryDeliveryStep(key: string, stepId: number, decidedBy: string): void;
  /** T12-1: a delivery blocked because its targets changed (or any delivery block): back to awaiting_confirmation to preview again. */
  previewAgain(key: string, decidedBy: string): void;
}

const TERMINAL: ReadonlySet<TicketState> = new Set(["pr_opened", "abandoned"]);

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const json = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";

/** F-I7: the open question added to every requirement refined from an incomplete snapshot. */
/** n older comments; 0 = JIRA did not show how many */
const olderComments = (n: number) => (n > 0 ? `${n} older comments` : "some older comments");
const notLoadedQuestion = (n: number) => `${n > 0 ? olderComments(n) : "Some older comments"} were not loaded — check JIRA`;

export function createWorkflow(deps: WorkflowDeps): Workflow {
  const { db, home, queue, source, run, config, bus } = deps;

  const mustGet = (key: string): Ticket => {
    const t = getTicket(db, key);
    if (!t) throw new NotFoundError(`unknown ticket ${key}`);
    return t;
  };

  /** state_changed events collected inside `atomic`, emitted only after its transaction commits. */
  let pending: BusEvent[] | null = null;

  const move = (key: string, to: TicketState, actor: Actor, reason?: string, extra?: Record<string, unknown>): void => {
    const from = mustGet(key).state;
    transition(db, key, to, actor, reason, extra);
    const e: BusEvent = { type: "state_changed", ticketKey: key, from, to };
    if (pending) pending.push(e);
    else bus.emit(e);
  };

  const atomic = <T>(fn: () => T): T => {
    const outer = pending;
    const mine: BusEvent[] = [];
    pending = mine;
    let result: T;
    try {
      result = withTx(db, fn);
    } finally {
      pending = outer;
    }
    if (outer) outer.push(...mine);
    else for (const e of mine) bus.emit(e);
    return result;
  };

  const requireState = (t: Ticket, ...states: TicketState[]): void => {
    if (!states.includes(t.state)) {
      throw new InvalidTransitionError(`${t.key}: action requires state ${states.join(" or ")}, ticket is ${t.state}`);
    }
  };

  /** refine / drift check: the project's first repo, or the data dir when the project is not mapped. */
  const cwdFor = (t: Ticket): string => {
    const project = t.key.split("-")[0] ?? "";
    return config.projects[project]?.repos[0]?.path ?? home;
  };

  // A-2: "choose the browser" takes the login-error path (source_error banner, blocked with that message, retry recovers)
  const fail = (key: string, err: unknown): void => {
    // phase 4b (4B-2): the blocked reason a phone reads (GET /api/tickets/:key) never carries a credential
    // phase 4c (C-3): a run stopped by the usage pause says why and how to continue; Retry reruns it after a resume
    const pausedDetail = err instanceof UsagePausedError ? err.pause.detail : err instanceof UsageLimitError ? err.detail : null;
    const message = redactStored(home, pausedDetail !== null ? `Paused: ${pausedDetail} — resume in Cost & quota, then Retry` : errMessage(err));
    if (isSourceError(err)) bus.emit({ type: "source_error", message });
    const t = getTicket(db, key);
    if (t && !TERMINAL.has(t.state) && t.state !== "blocked") move(key, "blocked", "system", message);
  };

  const job = (id: string, key: string, fn: () => Promise<void>): void => {
    queue.enqueue(id, async () => {
      try {
        await fn();
      } catch (err) {
        // H2: shutdown stopped the agent; the ticket keeps its working state and is resumed on restart
        if (err instanceof AgentInterruptedError) return;
        try {
          fail(key, err);
        } catch (failErr) {
          // the ticket could not be marked blocked: hand both errors to the queue's onError
          throw new AggregateError([err, failErr], redactKnown(`${id} failed (${errMessage(err)}) and marking ${key} blocked failed (${errMessage(failErr)})`));
        }
      }
    });
  };

  /** Proposing is allowed only once the latest requirement has been checked (when edited) and any drift needing ack was acknowledged. */
  const assertMayPropose = (t: Ticket): void => {
    const req = latestRequirement(db, t.key);
    if (!req) throw new InvalidTransitionError(`${t.key}: no requirement to propose from`);
    const drift = latestDrift(db, t.key);
    const checked = drift !== null && drift.requirementId === req.id;
    if (req.source === "human" && !checked) {
      throw new InvalidTransitionError(`${t.key}: the edited requirement has not been checked for drift yet`);
    }
    if (checked && driftNeedsAck(drift.result) && !drift.acknowledged) {
      throw new InvalidTransitionError(`${t.key}: drift must be acknowledged before proposing`);
    }
  };

  const repoContexts = async (key: string): Promise<RepoContext[]> => {
    const t = mustGet(key);
    const choice = currentChoice(db, key);
    if (!choice) throw new InvalidTransitionError(`${key}: no solution has been chosen`);
    const out: RepoContext[] = [];
    for (const r of affectedRepos(t, choice, config, ticketBases(db, key))) out.push({ ...r, rules: await loadProjectRules(r.path, r.baseBranch, r.name, r.commands) });
    return out;
  };

  const jiraMode = deps.jiraMode ?? ((): JiraMode => config.jira.source);
  const jiraWrites = createJiraWriteFlow({ db, queue, bus, config, source, updater: deps.updater, mode: jiraMode });
  const jiraComments = createJiraCommentFlow({
    db, queue, bus, source, mode: jiraMode,
    commenter: deps.commenter ?? {
      postComment: async () => {
        throw new Error("no JIRA commenter is configured");
      },
    },
  });

  const ctx: WorkflowCtx = {
    db, home, queue, run, config, bus, mustGet, move, atomic, job, requireState, cwdFor, repoContexts, jiraMode,
    afterDesignFinal: deps.hooks?.afterDesignFinal ?? ((key) => precheck.start(key)),
    onDevelopmentStarted: deps.hooks?.onDevelopmentStarted ?? ((key, repos) => jiraWrites.maybeRequestInProgress(key, repos)),
    enqueueDevelop: deps.hooks?.enqueueDevelop ?? ((key) => dev.enqueue(key)),
    enqueueReview: deps.hooks?.enqueueReview ?? ((key) => review.enqueue(key)),
    sandboxCheck: deps.sandboxCheck ?? ((s) => sandboxSelfCheck(s)),
    remoteScope: () => {
      const hosts = [...(deps.remoteHosts?.() ?? [])];
      return hosts.length > 0 ? { remoteHosts: hosts } : {};
    },
  };
  const debate = createDebateJobs(ctx);
  const precheck = createPrecheckJobs(ctx, source);
  const dev = createDevJobs(ctx);
  const delivery = createDeliveryJobs(ctx, { source, gh: deps.gh ?? ((bin) => new GhClient(bin)), jiraWrites, comments: jiraComments, ...(deps.beforePush ? { beforePush: deps.beforePush } : {}) });
  const review = createReviewJobs(ctx, { source, processes: deps.processes ?? new PlatformProcesses(), repoRoot: deps.repoRoot ?? DEFAULT_REPO_ROOT, ...(deps.acceptanceTestHooks ? { testHooks: deps.acceptanceTestHooks } : {}) });

  // ---- jobs ----

  const MAX_TITLE = 4096;
  const MAX_ECHOED_KEY = 40;
  const MAX_ECHOED_KEYS = 5;
  const runDiscover = async (): Promise<void> => {
    const failed = (extra: { loginRequired?: true; error: string }) =>
      bus.emit({ type: "discover_finished", created: 0, returned: 0, total: 0, complete: false, ...extra });
    let result;
    try {
      result = await source.discover();
    } catch (err) {
      const message = redactStored(home, errMessage(err));
      bus.emit({ type: "source_error", message });
      const login = err instanceof JiraLoginRequiredError;
      failed({ ...(login ? { loginRequired: true as const } : {}), error: message });
      return;
    }
    if (result.loginRequired) {
      const message = jiraLoginError(jiraMode()).message;
      bus.emit({ type: "source_error", message });
      failed({ loginRequired: true, error: message });
      return;
    }
    // Never trust the agent's own `complete`: more rows than the limit, or fewer than JIRA reported, is an incomplete read.
    const limit = config.jira.discoverLimit;
    // F4B-5 (M-4): a title is stored at most MAX_TITLE characters long
    const read = result.tickets.slice(0, limit).map((t) => (t.title.length > MAX_TITLE ? { ...t, title: t.title.slice(0, MAX_TITLE) } : t));
    const total = Math.max(result.total, result.tickets.length);
    const complete = result.complete && result.tickets.length <= limit && result.tickets.length >= total;
    const invalid = read.filter((t) => !isTicketKey(t.key)).map((t) => t.key);
    if (invalid.length > 0) {
      // F4B-5 (M-4): each key echoed at most MAX_ECHOED_KEY characters, at most MAX_ECHOED_KEYS of them
      const shown = invalid.slice(0, MAX_ECHOED_KEYS).map((k) => JSON.stringify(k.slice(0, MAX_ECHOED_KEY)));
      const more = invalid.length > MAX_ECHOED_KEYS ? ` and ${invalid.length - MAX_ECHOED_KEYS} more` : "";
      bus.emit({ type: "source_error", message: `Skipped ticket(s) with an invalid key: ${shown.join(", ")}${more}` });
    }
    let created = 0;
    let returned = 0;
    const openKeys = new Set<string>();
    try {
      for (const t of read) {
        if (!isTicketKey(t.key)) continue;
        returned++;
        openKeys.add(t.key);
        try {
          const r = upsertDiscovered(db, t, config.reviewAcByDefault);
          if (r.created) {
            created++;
            bus.emit({ type: "ticket_discovered", ticketKey: t.key });
            if (config.autoRefine) wf.refine(t.key, null);
          }
        } catch (err) {
          bus.emit({ type: "source_error", message: `Failed to process discovered ticket ${t.key}: ${errMessage(err)}` });
        }
      }
      // Only a complete read proves a known ticket is no longer open; an incomplete one changes no flag.
      if (complete) markJiraOpen(db, openKeys);
      recordDiscoveryRun(db, { returned, total, complete });
    } catch (err) {
      bus.emit({ type: "source_error", message: `Failed to record the discovery: ${errMessage(err)}` });
    } finally {
      bus.emit({ type: "discover_finished", created, returned, total, complete });
    }
  };

  const runRefine = async (key: string): Promise<void> => {
    const t = mustGet(key);
    if (t.state !== "refining") return;
    const fetched = await source.fetchTicket(key);
    if (fetched.loginRequired) throw jiraLoginError(jiraMode());
    const { snapshotId } = saveSnapshot(db, home, key, fetched, jiraMode());
    const snap = snapshotForPrompt(db, key, snapshotId);
    const notLoaded = snap.commentsNotLoaded ?? null;
    const prompt = [
      "mode: refine",
      "",
      "snapshot:",
      json(snap),
      "",
      ...(notLoaded === null
        ? []
        : [`Note: the comments are incomplete: ${olderComments(notLoaded)} were not loaded. Do not assume they agree with the visible ones.`, ""]),
      "Reply with only the Requirement JSON object in a single ```json block.",
    ].join("\n");
    const req = await run({ role: "refine-ticket", ticketKey: key, prompt, cwd: cwdFor(t), allowedTools: [], chrome: false, schema: Requirement });
    if (notLoaded !== null) {
      const text = notLoadedQuestion(notLoaded);
      if (!req.openQuestions.some((q) => q.text === text)) req.openQuestions.push({ kind: "missing", text });
    }
    const proposeNext = atomic(() => {
      addRequirement(db, key, snapshotId, req, "agent");
      move(key, "refined", "system");
      return leaveRefined(key);
    });
    if (proposeNext) enqueuePropose(key);
  };

  /** refined -> awaiting_ac_review (review on) or proposing; returns true when a propose job must follow. Call inside `atomic`. */
  const leaveRefined = (key: string): boolean => {
    if (mustGet(key).reviewAc) {
      move(key, "awaiting_ac_review", "system");
      return false;
    }
    move(key, "proposing", "system");
    return true;
  };

  const runDriftCheck = async (key: string): Promise<void> => {
    const t = mustGet(key);
    if (t.state !== "checking_drift") return;
    const baseline = firstRequirement(db, key);
    const current = latestRequirement(db, key);
    const baseSnapId = baselineSnapshot(db, key);
    const latestSnapId = listSnapshots(db, key)[0]?.id;
    if (!baseline || !current || baseSnapId === undefined || latestSnapId === undefined) {
      throw new Error(`${key}: drift check needs a requirement and a snapshot`);
    }
    const prompt = buildDriftPrompt(db, key, { baseline, current, baselineSnapshotId: baseSnapId, latestSnapshotId: latestSnapId });
    const result = await run({ role: "refine-ticket", ticketKey: key, prompt, cwd: cwdFor(t), allowedTools: [], chrome: false, schema: DriftResult });
    atomic(() => {
      saveDrift(db, key, current.id, baseSnapId, latestSnapId, "ac_edited", result);
      move(key, driftNeedsAck(result) ? "awaiting_drift_ack" : "awaiting_ac_review", "system");
    });
  };

  const runPropose = async (key: string): Promise<void> => {
    const t = mustGet(key);
    if (t.state !== "proposing") return;
    const req = latestRequirement(db, key);
    if (!req) throw new Error(`${key}: no requirement to propose from`);
    // P-C19: no fallback to the data dir. Every mapped repo is read (read-only); its rules come from its base branch, so
    // a repo that is gone, not a git repo or lacks its base branch blocks the ticket with the repo named.
    const refs = projectRepos(t, config, ticketBases(db, key));
    const repos: RepoContext[] = [];
    for (const r of refs) repos.push({ ...r, rules: await loadProjectRules(r.path, r.baseBranch, r.name, r.commands) });
    const prompt = [
      "repos:",
      json(refs.map(({ name, path, baseBranch }) => ({ name, path, baseBranch }))),
      "",
      "requirement:",
      json(req.content),
      "",
      "Reply with only the ProposeResult JSON object in a single ```json block.",
    ].join("\n");
    const result = await run({
      role: "propose-solutions",
      ticketKey: key,
      prompt,
      cwd: refs[0]!.path,
      addDirs: refs.slice(1).map((r) => r.path),
      repos,
      allowedTools: ["Read", "Grep", "Glob"],
      chrome: false,
      // affectedRepos must be mapped names: a live run cannot invent repos (a single repo is necessarily the one)
      schema: proposeResultSchema(refs.map((r) => r.name)),
    });
    atomic(() => {
      saveSolutions(db, key, req.id, result.solutions);
      move(key, "awaiting_choice", "system");
    });
  };

  /**
   * phase 4d (§9.4): after a choice or an abandon is committed, the derived summary follows. A failure leaves the
   * decision as made (the next one or Re-derive catches up); the log line is redacted (logError → redactKnown, 4D-2).
   */
  const refreshPreferences = (): void => {
    try {
      if (refreshDerived(db)) bus.emit({ type: "preferences_changed" });
    } catch (err) {
      logError(`preferences: the summary was not refreshed: ${describeError(err)}`);
    }
  };

  const enqueueRefine = (key: string) => job(`refine:${key}`, key, () => runRefine(key));
  const enqueuePropose = (key: string) => job(`propose:${key}`, key, () => runPropose(key));
  const enqueueDrift = (key: string) => job(`drift:${key}`, key, () => runDriftCheck(key));

  const resume = (key: string): void => {
    const state = mustGet(key).state;
    if (state === "refining") enqueueRefine(key);
    else if (state === "refined") {
      if (atomic(() => leaveRefined(key))) enqueuePropose(key);
    } else if (state === "proposing") enqueuePropose(key);
    else if (state === "checking_drift") enqueueDrift(key);
    else if (state === "designing") debate.enqueue(key);
    // Task 9 carry: afterDesignFinal runs after the finalize commit and is not durable; resuming repeats it
    else if (state === "design_final") ctx.afterDesignFinal(key);
    else if (state === "checking_snapshot") precheck.enqueue(key);
    // a crash right after the move to developing (before the job was enqueued) or during a step lands here
    else if (state === "developing") ctx.enqueueDevelop(key);
    // Task 9: the acceptance job derives its next step from stored data (an unsaved run does not count)
    else if (state === "reviewing") ctx.enqueueReview(key);
    // Task 12: only through Retry (recovery never resumes a delivery): the job continues from the first unfinished step
    else if (state === "delivering") delivery.enqueue(key);
  };

  // ---- public actions ----

  const wf: Workflow = {
    discover() {
      queue.enqueue("discover", runDiscover);
    },

    readSnapshot(key) {
      const t = mustGet(key);
      if (TERMINAL.has(t.state)) throw new InvalidTransitionError(`${key}: the ticket is ${t.state}; it is not read again`);
      queue.enqueue(`read:${key}`, async () => {
        try {
          const fetched = await source.fetchTicket(key);
          if (fetched.loginRequired) throw jiraLoginError(jiraMode());
          // refining may have started meanwhile and saved it already; saveSnapshot keeps one row per content
          const { created } = saveSnapshot(db, home, key, fetched, jiraMode());
          if (created) bus.emit({ type: "snapshot_changed", ticketKey: key, needsAck: false });
          bus.emit({ type: "ticket_read", ticketKey: key, ok: true });
        } catch (err) {
          bus.emit({ type: "ticket_read", ticketKey: key, ok: false });
          if (err instanceof AgentInterruptedError) return;
          bus.emit({ type: "source_error", message: redactStored(home, `Could not read ${key} from JIRA: ${errMessage(err)}`) });
        }
      });
    },

    async baseBranches(key) {
      const t = mustGet(key);
      const chosen = ticketBases(db, key);
      const used = listRepoWorkspaces(db, key);
      return Promise.all(
        projectRepos(t, config).map(async (r): Promise<BaseBranchView> => {
          const ws = used.find((w) => w.repo === r.name) ?? null;
          const refs = await git(r.path, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes/origin"]);
          const names = refs.code === 0 ? refs.stdout.split("\n").map((l) => l.trim().replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, "")) : [];
          const own = chosen[r.name] ?? null;
          const options = [...new Set([r.baseBranch, ...(own ? [own] : []), ...names.filter((n) => n !== "HEAD" && BASE_CANDIDATE.test(n))])].slice(0, BASE_OPTIONS_MAX);
          return { name: r.name, default: r.baseBranch, chosen: own, locked: ws !== null, used: ws?.baseBranch ?? null, options };
        }),
      );
    },

    async setBaseBranch(key, repo, branch, decidedBy) {
      const t = mustGet(key);
      if (TERMINAL.has(t.state)) throw new InvalidTransitionError(`${key}: the ticket is ${t.state}`);
      const ref = projectRepos(t, config).find((r) => r.name === repo);
      if (!ref) throw new ValidationError(`${repo} is not a repository of project ${t.key.split("-")[0]}`);
      const ws = listRepoWorkspaces(db, key).find((w) => w.repo === repo);
      if (ws) throw new InvalidTransitionError(`${key}: ${repo} already has its ticket branch, made from ${ws.baseBranch}; its base cannot change`);
      if (branch === null || branch === ref.baseBranch) return setTicketBase(db, key, repo, null, decidedBy);
      const fmt = await git(ref.path, ["check-ref-format", "--branch", branch]);
      if (fmt.code !== 0 || fmt.stdout.trim() !== branch) throw new ValidationError(`"${branch}" is not a valid branch name`);
      const exists = async (r: string) => (await git(ref.path, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${r}^{commit}`])).code === 0;
      if (!(await exists(`refs/heads/${branch}`)) && !(await exists(`refs/remotes/origin/${branch}`))) {
        throw new ValidationError(`${branch} is not a branch of ${repo} (locally or on origin as last fetched) — fetch it, then choose it`);
      }
      setTicketBase(db, key, repo, branch, decidedBy);
    },

    devQuestion(key) {
      mustGet(key);
      return devQuestion(db, key);
    },

    branchType(key) {
      const t = mustGet(key);
      const own = ticketBranchType(db, key);
      const chosen = own !== null && isBranchType(own);
      const type = chosen ? (own as BranchType) : guessBranchType(t.title);
      const ws = listRepoWorkspaces(db, key);
      return { type, chosen, locked: ws.length > 0, name: ws[0]?.branch ?? branchName(key, t.title, type) };
    },

    setBranchType(key, type, decidedBy) {
      const t = mustGet(key);
      if (TERMINAL.has(t.state)) throw new InvalidTransitionError(`${key}: the ticket is ${t.state}`);
      if (type !== null && !isBranchType(type)) throw new ValidationError(`"${String(type)}" is not a branch type (feat, fix, docs, chore, refactor, test, perf, build, ci, style)`);
      const ws = listRepoWorkspaces(db, key);
      if (ws.length > 0) throw new InvalidTransitionError(`${key}: the ticket branch ${ws[0]!.branch} exists; its name cannot change`);
      setTicketBranchType(db, key, type, decidedBy);
    },

    refine(key, decidedBy) {
      const t = mustGet(key);
      if (t.state !== "refining") {
        if (decidedBy === null) move(key, "refining", "system");
        else move(key, "refining", "developer", undefined, { decidedBy });
      }
      enqueueRefine(key);
    },

    propose(key, decidedBy) {
      const t = mustGet(key);
      if (t.state !== "proposing") {
        requireState(t, "refined", "awaiting_ac_review", "awaiting_drift_ack");
        assertMayPropose(t);
        move(key, "proposing", "developer", undefined, { decidedBy });
      }
      enqueuePropose(key);
    },

    resume,

    editRequirement(key, r, decidedBy) {
      const t = mustGet(key);
      requireState(t, "awaiting_ac_review");
      const parsed = Requirement.safeParse(r);
      if (!parsed.success) throw new ValidationError(`invalid requirement: ${parsed.error.message}`);
      const prev = latestRequirement(db, key);
      if (!prev) throw new InvalidTransitionError(`${key}: no requirement to edit`);
      atomic(() => {
        addRequirement(db, key, prev.snapshotId, parsed.data, "human");
        move(key, "checking_drift", "developer", undefined, { decidedBy });
      });
      enqueueDrift(key);
    },

    confirmRequirement(key, decidedBy) {
      const t = mustGet(key);
      requireState(t, "awaiting_ac_review");
      assertMayPropose(t);
      move(key, "proposing", "developer", undefined, { decidedBy });
      enqueuePropose(key);
    },

    acknowledgeDrift(key, note, decidedBy) {
      const t = mustGet(key);
      requireState(t, "awaiting_drift_ack", "awaiting_ac_review");
      const drift = latestDrift(db, key);
      if (!drift) throw new InvalidTransitionError(`${key}: no drift check to acknowledge`);
      if (t.state === "awaiting_ac_review") {
        // F-I4: after Back to editing the developer may still acknowledge the latest requirement's drift (R13);
        // they stay in review and Confirm becomes possible.
        const req = latestRequirement(db, key);
        if (!req || drift.requirementId !== req.id) throw new InvalidTransitionError(`${key}: the latest requirement has no drift check to acknowledge`);
        if (!driftNeedsAck(drift.result) || drift.acknowledged) throw new InvalidTransitionError(`${key}: the drift check needs no acknowledgement`);
        ackDrift(db, drift.id, note, decidedBy);
        return;
      }
      atomic(() => {
        ackDrift(db, drift.id, note, decidedBy);
        move(key, "proposing", "developer", undefined, { decidedBy });
      });
      enqueuePropose(key);
    },

    ackSnapshot(key, note, decidedBy) {
      precheck.ackSnapshot(key, note, decidedBy);
    },

    replan(key, decidedBy) {
      requireState(mustGet(key), "awaiting_snapshot_ack", "awaiting_review_ack");
      move(key, "refining", "developer", undefined, { decidedBy });
      enqueueRefine(key);
    },

    backToEditing(key, decidedBy) {
      requireState(mustGet(key), "awaiting_drift_ack");
      move(key, "awaiting_ac_review", "developer", undefined, { decidedBy });
    },

    choose(key, solutionId, note, affected, decidedBy, skipDebate = false) {
      const t = mustGet(key);
      requireState(t, "awaiting_choice");
      const sol = listSolutions(db, key).find((x) => x.id === solutionId);
      if (!sol) throw new ValidationError(`solution ${solutionId} is not in the current solution set of ${key}`);
      const mapped = projectRepos(t, config).map((r) => r.name);
      let chosen: string[];
      if (affected !== undefined) chosen = affected;
      else if (sol.content.affectedRepos.length > 0) chosen = sol.content.affectedRepos;
      else if (mapped.length === 1) chosen = mapped; // phase-1 solution, one repo: it is the only candidate
      else throw new ValidationError("This solution does not name its repositories — choose the affected repositories");
      if (chosen.length === 0) throw new ValidationError("Choose at least one affected repository");
      const dup = chosen.filter((n, i) => chosen.indexOf(n) !== i);
      if (dup.length > 0) throw new ValidationError(`Duplicate affected repositories: ${[...new Set(dup)].join(", ")}`);
      const unknown = chosen.filter((n) => !mapped.includes(n));
      if (unknown.length > 0) {
        throw new ValidationError(
          `Not mapped for project ${key.split("-")[0]}: ${unknown.join(", ")} (mapped: ${mapped.join(", ")}) — fix Settings or edit the affected repositories`,
        );
      }
      atomic(() => {
        recordChoice(db, key, solutionId, note, [...chosen], decidedBy, skipDebate);
        move(key, "designing", "developer", undefined, { decidedBy });
      });
      refreshPreferences();
      debate.enqueue(key);
    },

    rechoose(key, decidedBy) {
      const t = mustGet(key);
      const from = t.state;
      requireState(t, "dev_done", "awaiting_debate_ruling");
      move(key, "awaiting_choice", "developer", undefined, { decidedBy });
      // the debate of the old choice is kept as is (listed by choice); the next choice starts from a draft
      if (from === "awaiting_debate_ruling") bus.emit({ type: "debate_updated", ticketKey: key });
    },

    ruleDebate(key, rulings, decidedBy) {
      debate.ruleDebate(key, rulings, decidedBy);
    },

    requestChanges(key, note, decidedBy) {
      dev.requestChanges(key, note, decidedBy);
    },

    resetBranch(key, decidedBy) {
      return dev.resetBranch(key, decidedBy);
    },

    acceptHooks(key, repo, decidedBy) {
      return dev.acceptHooks(key, repo, decidedBy);
    },

    confirmJiraWrite(key, writeId, decidedBy) {
      jiraWrites.confirm(key, writeId, decidedBy);
    },

    skipJiraWrite(key, writeId, decidedBy) {
      jiraWrites.skip(key, writeId, decidedBy);
    },

    retryJiraWrite(key, writeId, decidedBy) {
      jiraWrites.retry(key, writeId, decidedBy);
    },

    sendClarification(key, text, decidedBy) {
      return jiraComments.sendClarification(key, text, decidedBy);
    },

    retryComment(key, commentId, decidedBy) {
      return jiraComments.retry(key, commentId, decidedBy);
    },

    retry(key, decidedBy, note) {
      const t = mustGet(key);
      requireState(t, "blocked");
      if (note !== undefined) addDevNote(db, key, note, decidedBy);
      clearDevQuestion(db, key);
      if (!t.prevState) throw new InvalidTransitionError(`${key}: blocked ticket has no previous state to return to`);
      // Task 9: after the attempt cap a new round starts; any other review block (agent error…) re-runs acceptance
      if (t.prevState === "reviewing") {
        review.retry(key, decidedBy);
        return;
      }
      move(key, t.prevState, "developer", undefined, { decidedBy });
      // a retry iteration started by this resume names who retried (Task 11 carry)
      if (t.prevState === "developing") dev.retriedBy(key, decidedBy);
      resume(key);
    },

    abandon(key, decidedBy) {
      atomic(() => {
        move(key, "abandoned", "developer", undefined, { decidedBy });
        // F2-I3: nothing is sent to JIRA for an abandoned ticket
        jiraWrites.abandon(key, decidedBy);
        jiraComments.abandon(key);
        // M2: nothing further is pushed or opened (a step already running finishes and is recorded)
        delivery.abandon(key);
        // 4D-1: an abandoned ticket's choice no longer counts as a preference
        supersedeTicketSignals(db, key);
      });
      refreshPreferences();
    },

    handOff(key, decidedBy) {
      review.handOff(key, decidedBy);
    },

    ackReview(key, note, decidedBy) {
      review.ackReview(key, note, decidedBy);
    },

    rejectReview(key, note, decidedBy) {
      review.rejectReview(key, note, decidedBy);
    },

    reReview(key, note, decidedBy) {
      review.reReview(key, note, decidedBy);
    },

    recoverAcceptanceRuns() {
      review.recoverRuns();
    },

    previewDelivery(key) {
      return delivery.preview(key);
    },

    confirmDelivery(key, planHash, ackNote, decidedBy) {
      return delivery.confirm(key, planHash, ackNote, decidedBy);
    },

    retryDeliveryStep(key, stepId, decidedBy) {
      delivery.retryStep(key, stepId, decidedBy);
    },

    previewAgain(key, decidedBy) {
      delivery.previewAgain(key, decidedBy);
    },
  };

  return wf;
}
