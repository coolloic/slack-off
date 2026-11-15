/**
 * Record types and derivations shared by the server repo modules, HTTP responses and the web UI.
 * Defined only here: the server computes, the web renders without re-deriving.
 */
import type { AcceptanceFlow, CommentResponse, Critique, Ruling } from './schemas.ts';

// ---------------------------------------------------------------- development

export type TestRun = { command: string; exitCode: number | null; timedOut: boolean; outputTail: string };

/** skipped_checks_failed: build/lint/test failed this step, so the repo was not committed (changes kept). */
export type CommitOutcome =
  /** hookOutput (phase 4a Task 8): what the commit's hooks printed, when anything */
  | { kind: 'committed'; sha: string; hookOutput?: string }
  | { kind: 'nothing' }
  | { kind: 'skipped_checks_failed' }
  | { kind: 'hook_failed'; timedOut: boolean; outputTail: string };

export type StepRepoResult = {
  repo: string;
  violations: string[];
  tests: TestRun[];
  commit: CommitOutcome;
  pendingChanges: boolean;
  /** files the platform's checks (build / lint / test) created or changed that are still uncommitted after the step */
  checkOutputs?: string[];
};

/** The one-off install run when a worktree is created, and the paths it changed that were reset afterwards. */
export type InstallReport = { run: TestRun; resetPaths: string[] };

export type IterationTrigger = 'initial' | 'developer_request' | 'review_failed' | 'rejected' | 'retry';

export interface IterationRecord {
  id: number;
  iteration: number;
  trigger: IterationTrigger;
  note: string | null;
  status: 'running' | 'done' | 'failed';
  summary: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface StepRecord {
  id: number;
  step: number;
  summary: string;
  repos: StepRepoResult[];
  createdAt: string;
}

export type JiraWriteState = 'pending' | 'confirmed' | 'skipped' | 'done' | 'failed' | 'not_needed';

export interface JiraWriteRecord {
  id: number;
  targetStatus: string;
  state: JiraWriteState;
  detail: string | null;
  result: unknown;
  decidedBy: string | null;
  requestedAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
  /** F4B-4: the JIRA mode the write was sent in; null until it runs (and for writes from before phase 4b: the browser) */
  jiraSource: 'browser' | 'api' | null;
}

// ---------------------------------------------------------------- acceptance / review

export type AcVerdict = 'pass' | 'fail' | 'not_tested';

/** One AC as the platform evaluated it (the agent's verdict checked against the platform's own spec re-run). */
export interface AcEvaluation {
  acId: string;
  text: string;
  verdict: AcVerdict;
  /** null when the agent did not run (not_executed) */
  agentVerdict: 'pass' | 'fail' | null;
  flows: (Omit<AcceptanceFlow, 'evidence'> & {
    /** `<acId>/<n>`, matching review_evidence.ref_key */
    evidenceKeys: string[];
    testsPassed: boolean;
  })[];
  /** why the platform's verdict differs from the agent's, or null */
  mismatch: string | null;
}

export interface AcceptanceTarget {
  repo: string;
  /** phase 4f: 'cli' and 'library' entries have no baseUrl ("") and are never started */
  entry: 'web' | 'api' | 'cli' | 'library';
  baseUrl: string;
  started: boolean;
  detail: string;
}

export interface AcceptanceReport {
  verdict: 'passed' | 'failed' | 'not_executed';
  notExecutedReason: string | null;
  summary: string;
  targets: AcceptanceTarget[];
  acs: AcEvaluation[];
  specRun: TestRun | null;
  projectE2e: TestRun[];
  isolation: { ok: boolean; checks: string[]; excluded: string[] };
  commits: { repo: string; sha: string }[];
}

/** A review series (round): handoff, reject, or retry after the attempt cap each start one; re-review counts in the current one. */
export interface ReviewSeriesRecord {
  id: number;
  startedBy: 'handoff' | 'rejected' | 'retry';
  note: string | null;
  decidedBy: string;
  createdAt: string;
}

export interface ReviewReportRecord {
  id: number;
  seriesId: number;
  attempt: number;
  verdict: AcceptanceReport['verdict'];
  report: AcceptanceReport;
  developerNote: string | null;
  /** the JIRA snapshot this acceptance ran against (delivery's snapshot step compares with it, ruling R2) */
  snapshotId: number;
  /**
   * T9-6 (L1): the ticket's latest development iteration id when the report was saved (0: none); an iteration with a
   * larger id came after the report. null / absent: unknown (a row from before migration 10).
   */
  afterIterationId?: number | null;
  createdAt: string;
}

/** The review loop's next step, derived from stored state only (server computes; web shows as is). */
export type ReviewStep =
  | { kind: 'accept'; attempt: number }
  | { kind: 'fix'; reportId: number }
  | { kind: 'cap_reached'; attempts: number }
  | { kind: 'await_decision'; reportId: number };

// ---------------------------------------------------------------- delivery

/** The failed snapshot step's detail when delivery went back to the developer because JIRA changed (the next confirm needs a note). */
export const SNAPSHOT_NEEDS_ACK = 'JIRA changed since acceptance — review the drift, then confirm again with a note';

export type DeliveryActionKind = 'snapshot' | 'push' | 'pr' | 'pr_links' | 'jira_status' | 'jira_comment';

export interface DeliveryAction {
  seq: number;
  kind: DeliveryActionKind;
  repo: string | null;
  /** shown verbatim in the confirmation dialog */
  text: string;
}

export interface DeliveryPrBody {
  repo: string;
  title: string;
  /** the full description that will be sent (the version with no related-PR links) */
  body: string;
  /** null = unknown */
  isPrivate: boolean | null;
}

export interface DeliveryPlan {
  actions: DeliveryAction[];
  prBodies: DeliveryPrBody[];
  blockers: string[];
  /** not hashed: e2e not executed, public repo, JIRA unchanged (sync off)…; shown as is in the confirmation dialog */
  warnings: string[];
  /** first 16 hex chars of sha256(canonicalJson({actions, prBodies})); action texts never include the ackNote (ruling R10) */
  hash: string;
}

export interface DeliveryStepRecord {
  id: number;
  deliveryId: number;
  seq: number;
  kind: DeliveryActionKind;
  repo: string | null;
  text: string;
  /** skipped: the ticket was abandoned before the step ran */
  state: 'pending' | 'running' | 'done' | 'failed' | 'not_needed' | 'skipped';
  detail: string | null;
  result: unknown;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JiraCommentRecord {
  id: number;
  purpose: 'clarification' | 'delivery';
  text: string;
  state: JiraWriteState;
  detail: string | null;
  decidedBy: string | null;
  requestedAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
  /** F4B-4: the JIRA mode the comment was sent in; null until it runs (and for comments from before phase 4b: the browser) */
  jiraSource: 'browser' | 'api' | null;
}

// ---------------------------------------------------------------- debate

export interface DebateRoundRecord {
  id: number;
  choiceId: number;
  designDocId: number;
  round: number;
  role: 'designer' | 'critic';
  content: Critique | { responses: CommentResponse[] };
  createdAt: string;
}

export interface RulingRecord {
  id: number;
  debateRoundId: number;
  commentId: string;
  decision: Ruling['decision'];
  note: string;
  decidedBy: string;
  createdAt: string;
}

export interface Disagreement {
  roundId: number;
  commentId: string;
  checklistItem: string;
  repo: string | null;
  critic: { text: string; suggestion: string | null };
  designer: { verdict: 'accepted' | 'rebutted'; reason: string } | null;
}

/** The design debate's next step, derived from stored state only (server: nextDebateStep; web: shown as is). */
export type DebateStep =
  | { kind: 'draft' }
  | { kind: 'critique'; round: number }
  | { kind: 'revise'; round: number; mustAnswer: string[] }
  | { kind: 'finalize'; docId: number }
  | { kind: 'escalate' }
  /** mustAnswer = the comments ruled `critic` or `custom` (P-C1b) */
  | { kind: 'apply_rulings'; roundId: number; mustAnswer: string[] };

/** A critic round's content (a designer round holds `{ responses }`). */
export const isCritique = (c: DebateRoundRecord['content']): c is Critique => 'comments' in c;

/**
 * All blocking comments of the last critic round (including ones the designer accepted),
 * each with the designer's response from the designer round of the same round number (or null).
 */
export function disagreements(rounds: readonly DebateRoundRecord[]): Disagreement[] {
  let critic: DebateRoundRecord | undefined;
  for (const r of rounds) if (r.role === 'critic' && (!critic || r.round >= critic.round)) critic = r;
  if (!critic || !isCritique(critic.content)) return [];
  const round = critic.round;
  const designer = rounds.filter((r) => r.role === 'designer' && r.round === round).at(-1);
  const responses = designer && !isCritique(designer.content) ? designer.content.responses : [];
  return critic.content.comments
    .filter((c) => c.blocking)
    .map((c) => {
      const resp = responses.find((r) => r.commentId === c.id);
      return {
        roundId: critic.id,
        commentId: c.id,
        checklistItem: c.checklistItem,
        repo: c.repo,
        critic: { text: c.text, suggestion: c.suggestion },
        designer: resp ? { verdict: resp.verdict, reason: resp.reason } : null,
      };
    });
}

// ---------------------------------------------------------------- per-repo status

export type RepoStatus = 'green' | 'failing' | 'hook_failed' | 'not_run' | 'working';

export function repoStatus(r: {
  running: boolean;
  pending: boolean;
  hasTestCommand: boolean;
  lastTests: TestRun[] | null;
  lastCommit: CommitOutcome | null;
}): RepoStatus {
  if (r.running) return 'working';
  if (r.lastCommit?.kind === 'hook_failed') return 'hook_failed';
  if (r.lastTests?.some((t) => t.timedOut || t.exitCode !== 0)) return 'failing';
  if (r.pending) return 'working';
  // no test command, or tests not run (yet): never shown as passing
  if (!r.hasTestCommand || !r.lastTests || r.lastTests.length === 0) return 'not_run';
  return 'green';
}

/** The dev_done condition per repo. not_run counts as ready but must never be shown as passing. */
export function repoReady(s: RepoStatus): boolean {
  return s === 'green' || s === 'not_run';
}
