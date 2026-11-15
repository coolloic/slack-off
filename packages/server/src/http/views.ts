// Task 13: read models for the phase-2 HTTP routes (design debate, multi-repo development, diffs). Everything the web
// shows is computed here — per-repo status included (P-C18) — so the client renders without re-deriving.
import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { debateAdvice } from "../design/design-repo.ts";
import { createHash } from "node:crypto";
import { isAbsolute, join, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  CROSS_REPO_CHECKLIST, DEFAULT_CHECKLIST, disagreements, repoStatus, type ChecklistItem, type CommitOutcome, type DebateRoundRecord,
  type DebateStep, type DesignDoc, type InstallReport, type IterationRecord, type JiraWriteRecord, type RepoStatus, type ReviewReportRecord,
  type ReviewSeriesRecord, type ReviewStep, type RulingRecord, type StepRecord, type StepRepoResult,
} from "@slackoff/shared";
import type { Config } from "../config.ts";
import { listDesignDocs, listRounds, listRulings } from "../design/design-repo.ts";
import { nextDebateStep } from "../design/debate-step.ts";
import { listIterations, openIteration } from "../development/dev-repo.ts";
import { currentSeries, getEvidence, listDecisions, listEvidence, listReports } from "../acceptance/review-repo.ts";
import { nextReviewStep } from "../acceptance/review-step.ts";
import {
  assertPlatformWorktree, changedPaths, commitsSince, diffStat, diffText, hooksFingerprint, hooksInstalled, ticketDir, worktreePath, WorktreeError,
} from "../git/worktree.ts";
import { inProgressTarget } from "../jira/jira-write-jobs.ts";
import { listJiraWrites } from "../jira/jira-write-repo.ts";
import { loadProjectRules, resolveChecklist, type LoadedRules, type RepoContext, type RepoRef } from "../projects/project-rules.ts";
import { currentChoice, type CurrentChoice } from "../requirements/requirement-repo.ts";
import { InvalidTransitionError, NotFoundError } from "../tickets/errors.ts";
import { choiceBranch, getHooksPin, listRepoWorkspaces, type RepoWorkspace, type Ticket } from "../tickets/ticket-repo.ts";
import { ticketBases } from "../tickets/base-branch-repo.ts";

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The affected repo names of the current choice, in the project's mapping order (names no longer mapped follow in the
 * choice's order). A phase-1 choice without names: the only mapped repo, else the stored workspaces.
 */
function affectedNames(t: Ticket, choice: CurrentChoice | null, config: Config, stored: readonly RepoWorkspace[]): string[] {
  if (!choice) return [];
  const mapped = config.projects[t.key.split("-")[0] ?? ""]?.repos ?? [];
  const names = choice.affectedRepos ?? (mapped.length === 1 ? [mapped[0]!.name] : stored.map((w) => w.repo));
  return [...mapped.map((r) => r.name).filter((n) => names.includes(n)), ...names.filter((n) => !mapped.some((r) => r.name === n))];
}

/** The mapped repo, with the ticket's own base branch when it chose one (tickets/base-branch-repo). */
const mappedRef = (db: DatabaseSync, t: Ticket, config: Config, name: string): RepoRef | null => {
  const r = config.projects[t.key.split("-")[0] ?? ""]?.repos.find((x) => x.name === name) ?? null;
  const own = r ? ticketBases(db, t.key)[name] : undefined;
  return r && own !== undefined ? { ...r, baseBranch: own } : r;
};

/** The repo's rules from its mapped base branch, or the reason they cannot be read (never throws). */
async function rulesOf(ref: RepoRef | null, name: string): Promise<{ rules: LoadedRules | null; error: string | null }> {
  if (!ref) return { rules: null, error: `Repository ${name} is no longer mapped — fix Settings or choose a different solution` };
  try {
    return { rules: await loadProjectRules(ref.path, ref.baseBranch, name, ref.commands), error: null };
  } catch (err) {
    return { rules: null, error: errMessage(err) };
  }
}

// ---------------------------------------------------------------- design

export interface DesignView {
  choiceId: number | null;
  affectedRepos: string[];
  /** the checklist the debate is held against; the base list when the repos' rules cannot be read (checklistError says why) */
  checklist: ChecklistItem[];
  checklistError: string | null;
  maxRounds: number;
  /** current choice's docs, without bodies (GET …/design/docs/:version) */
  docs: Array<{ version: number; isFinal: boolean; createdAt: string; checklist: DesignDoc["checklist"] }>;
  rounds: DebateRoundRecord[];
  rulings: RulingRecord[];
  disagreements: ReturnType<typeof disagreements>;
  advice: ReturnType<typeof debateAdvice>;
  /** the debate's next step derived from stored state; null before a choice */
  step: DebateStep | null;
}

export async function designView(db: DatabaseSync, config: Config, t: Ticket): Promise<DesignView> {
  const choice = currentChoice(db, t.key);
  const names = affectedNames(t, choice, config, listRepoWorkspaces(db, t.key));
  const base = names.length > 1 ? [...DEFAULT_CHECKLIST, ...CROSS_REPO_CHECKLIST] : [...DEFAULT_CHECKLIST];
  let checklist: ChecklistItem[] = base.map((i) => ({ ...i }));
  let checklistError: string | null = null;
  if (choice) {
    const loaded = await Promise.all(names.map((name) => rulesOf(mappedRef(db, t, config, name), name)));
    const repos: RepoContext[] = [];
    names.forEach((name, i) => {
      const r = loaded[i]!;
      if (!r.rules) checklistError ??= r.error;
      else repos.push({ ...mappedRef(db, t, config, name)!, rules: r.rules });
    });
    if (checklistError === null) {
      try {
        checklist = resolveChecklist(repos);
      } catch (err) {
        checklistError = errMessage(err);
      }
    }
  }
  const docs = choice ? listDesignDocs(db, t.key).filter((d) => d.choiceId === choice.id) : [];
  const rounds = choice ? listRounds(db, t.key, choice.id) : [];
  const roundIds = new Set(rounds.map((r) => r.id));
  const rulings = listRulings(db, t.key).filter((r) => roundIds.has(r.debateRoundId));
  let step: DebateStep | null = null;
  if (choice) {
    try {
      step = nextDebateStep({ docs, rounds, rulings, maxRounds: config.debate.maxRounds });
    } catch {
      step = null; // inconsistent stored debate: shown without a next step
    }
  }
  return {
    choiceId: choice?.id ?? null,
    affectedRepos: names,
    checklist,
    checklistError,
    maxRounds: config.debate.maxRounds,
    docs: docs.map((d) => ({ version: d.version, isFinal: d.isFinal, createdAt: d.createdAt, checklist: d.doc.checklist })),
    rounds,
    rulings,
    disagreements: disagreements(rounds),
    // the arbiter's recommended ruling per disagreement (escalated debates), the developer still rules
    advice: choice ? debateAdvice(db, choice.id) : [],
    step,
  };
}

/** One design doc version of the ticket (any choice), with its body; NotFoundError when there is none. */
export function designDoc(db: DatabaseSync, key: string, version: number) {
  const d = listDesignDocs(db, key).find((x) => x.version === version);
  if (!d) throw new NotFoundError(`no design doc version ${version} for ${key}`);
  return { version: d.version, choiceId: d.choiceId, requirementId: d.requirementId, isFinal: d.isFinal, createdAt: d.createdAt, ...d.doc };
}

// ---------------------------------------------------------------- development

export interface DevelopmentRepo {
  name: string;
  /** F2-R1: blocked ticket whose repo's git hooks differ from the stored pin ("Accept new git hooks", Mac only) */
  hooksChanged: boolean;
  branch: string | null;
  worktreePath: string | null;
  baseBranch: string;
  /** the stored workspace keeps its base branch (P-C8) while Settings now maps another one */
  baseBranchChanged: { stored: string; mapped: string } | null;
  rulesFound: boolean;
  /** why the repo's rules could not be read (unmapped, not a repo, invalid rules…), else null */
  rulesError: string | null;
  commands: LoadedRules["rules"]["commands"];
  forbiddenPaths: string[];
  hooks: { configured: boolean; installed: boolean; hooksPath: string | null } | null;
  install: InstallReport | null;
  diffStat: { files: number; insertions: number; deletions: number } | null;
  commits: Array<{ sha: string; subject: string }>;
  /** files the checks left uncommitted after the repo's last step */
  checkOutputs: string[];
  pendingChanges: boolean;
  /** computed with repoStatus from the repo's last recorded step (P-C18); "working" while the ticket develops */
  status: RepoStatus;
}

export interface DevelopmentView {
  branch: string | null;
  ticketDir: string;
  repos: DevelopmentRepo[];
  iterations: Array<IterationRecord & { steps: StepRecord[] }>;
  jiraWrites: JiraWriteRecord[];
  jiraSync: { enabled: boolean; targetStatus: string; note: string | null };
}

/** The repo's result in the latest recorded step that includes it (any iteration), or null. */
function lastResult(iterations: ReadonlyArray<{ steps: StepRecord[] }>, repo: string): StepRepoResult | null {
  for (let i = iterations.length - 1; i >= 0; i--) {
    const steps = iterations[i]!.steps;
    for (let j = steps.length - 1; j >= 0; j--) {
      const r = steps[j]!.repos.find((x) => x.repo === repo);
      if (r) return r;
    }
  }
  return null;
}

/**
 * The platform worktree of `repo`, or null when there is none. Its real path must be exactly
 * realpath(`<home>/worktrees`)/<KEY>/<repo>: a symlink to another ticket's (or repo's) worktree is not this one.
 */
function platformWorktree(home: string, key: string, repo: string, repoPath: string): string | null {
  const p = worktreePath(home, key, repo);
  if (!existsSync(p)) return null;
  try {
    // 4A-8: the worktree's git common dir must be its mapped repo's (the path recorded with the workspace)
    const real = assertPlatformWorktree(home, p, repoPath);
    const expected = join(realpathSync.native(home), "worktrees", key, repo);
    return real === expected ? real : null;
  } catch {
    return null;
  }
}

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

export async function developmentView(db: DatabaseSync, home: string, config: Config, t: Ticket): Promise<DevelopmentView> {
  const choice = currentChoice(db, t.key);
  const stored = listRepoWorkspaces(db, t.key);
  const iterations = listIterations(db, t.key);
  const names = affectedNames(t, choice, config, stored);
  // T13-2: while the ticket develops, the open iteration's next step is under way: its repos are "working"
  const running = t.state === "developing" && (openIteration(db, t.key) !== null || iterations.length === 0);
  const loaded = await Promise.all(names.map((name) => rulesOf(mappedRef(db, t, config, name), name)));
  const contexts: RepoContext[] = names.flatMap((name, i) => {
    const ref = mappedRef(db, t, config, name);
    const rules = loaded[i]!.rules;
    return ref && rules ? [{ ...ref, rules }] : [];
  });
  const repos = await Promise.all(
    names.map(async (name, i): Promise<DevelopmentRepo> => {
      const ref = mappedRef(db, t, config, name);
      const ws = stored.find((w) => w.repo === name) ?? null;
      const { rules, error } = loaded[i]!;
      const baseBranch = ws?.baseBranch ?? ref?.baseBranch ?? "";
      const wt = ws ? platformWorktree(home, t.key, name, ws.repoPath) : null;
      const last = lastResult(iterations, name);
      const commands = rules?.rules.commands ?? {};
      const lastCommit: CommitOutcome | null = last?.commit ?? null;
      const pin = t.state === "blocked" && wt ? getHooksPin(db, t.key, name) : null;
      const now = pin && wt ? await orNull(hooksFingerprint(wt)) : null;
      return {
        name,
        hooksChanged: pin !== null && now !== null && (pin.hooksPath !== now.hooksPath || pin.dir !== now.dir || pin.hash !== now.hash),
        branch: ws?.branch ?? (choice ? choiceBranch(db, choice.id) : null),
        worktreePath: ws?.worktreePath ?? null,
        baseBranch,
        baseBranchChanged: ws && ref && ws.baseBranch !== ref.baseBranch ? { stored: ws.baseBranch, mapped: ref.baseBranch } : null,
        rulesFound: rules?.found ?? false,
        rulesError: error,
        commands,
        forbiddenPaths: rules?.rules.forbiddenPaths ?? [],
        hooks: wt ? await orNull(hooksInstalled(wt)) : null,
        install: ws?.install ?? null,
        diffStat: wt ? await orNull(diffStat(wt, baseBranch)) : null,
        commits: wt ? ((await orNull(commitsSince(wt, baseBranch))) ?? []) : [],
        checkOutputs: last?.checkOutputs ?? [],
        pendingChanges: last?.pendingChanges ?? false,
        status: repoStatus({
          running,
          pending: last?.pendingChanges ?? false,
          hasTestCommand: Boolean(commands.test),
          lastTests: last?.tests ?? null,
          lastCommit,
        }),
      };
    }),
  );
  const target = inProgressTarget(contexts, config);
  return {
    branch: (choice ? choiceBranch(db, choice.id) : null) ?? t.branch,
    ticketDir: ticketDir(home, t.key),
    repos,
    iterations,
    jiraWrites: listJiraWrites(db, t.key),
    jiraSync: { enabled: config.jira.syncStatus, targetStatus: target.status, note: target.note },
  };
}

/**
 * The branch diff of one affected repo. The name must be an affected repo of the current choice (else NotFoundError —
 * nothing outside the ticket's repos is reachable), and the worktree must exist (else InvalidTransitionError).
 */
export async function repoDiff(db: DatabaseSync, home: string, config: Config, t: Ticket, repo: string): Promise<{ text: string; truncated: boolean }> {
  const stored = listRepoWorkspaces(db, t.key);
  if (!affectedNames(t, currentChoice(db, t.key), config, stored).includes(repo)) {
    throw new NotFoundError(`${repo} is not an affected repository of ${t.key}`);
  }
  const ws = stored.find((w) => w.repo === repo);
  const wt = ws ? platformWorktree(home, t.key, repo, ws.repoPath) : null;
  if (!ws || !wt) throw new InvalidTransitionError(`${repo} has no worktree yet for ${t.key}`);
  try {
    return await diffText(wt, ws.baseBranch);
  } catch (err) {
    if (err instanceof WorktreeError) throw new InvalidTransitionError(err.message);
    throw err;
  }
}

// ---------------------------------------------------------------- phase 3: hand-off, acceptance review, evidence

export interface HandOffView {
  enabled: boolean;
  reason: string | null;
}

/**
 * Whether "Hand over for acceptance" is available: the ticket is dev_done and no affected repo's worktree has
 * uncommitted changes (the review job would block on them). Runs `git status` in each worktree; never throws.
 */
export async function handOffState(db: DatabaseSync, home: string, t: Ticket): Promise<HandOffView> {
  if (t.state !== "dev_done") return { enabled: false, reason: "development is not finished" };
  for (const ws of listRepoWorkspaces(db, t.key)) {
    const wt = platformWorktree(home, t.key, ws.repo, ws.repoPath);
    if (!wt) return { enabled: false, reason: `${ws.repo} has no worktree — start development again` };
    try {
      if ((await changedPaths(wt)).length > 0) return { enabled: false, reason: `${ws.repo} has uncommitted changes — commit or discard them first` };
    } catch (err) {
      return { enabled: false, reason: `${ws.repo}: ${errMessage(err)}` };
    }
  }
  return { enabled: true, reason: null };
}

/**
 * `git status` is not run on every request: the result is kept per ticket until the ticket's next development step or
 * state change (the cache key is the ticket's updated-at and its newest dev_step id, which move on exactly those events).
 */
export function createHandOffCache(db: DatabaseSync, home: string): (t: Ticket) => Promise<HandOffView> {
  const cache = new Map<string, { stamp: string; value: HandOffView }>();
  return async (t) => {
    if (t.state !== "dev_done") return handOffState(db, home, t);
    const step = db
      .prepare("SELECT COALESCE(MAX(s.id), 0) AS n FROM dev_step s JOIN dev_iteration i ON i.id = s.iteration_id WHERE i.ticket_key = ?")
      .get(t.key) as { n: number };
    const stamp = `${t.updatedAt}|${step.n}`;
    const hit = cache.get(t.key);
    if (hit?.stamp === stamp) return hit.value;
    const value = await handOffState(db, home, t);
    // only "enabled" is kept: a commit or discard in the worktree changes neither key, so a disabled result would stick
    if (value.enabled) cache.set(t.key, { stamp, value });
    else cache.delete(t.key);
    return value;
  };
}

export const ISOLATION_NOTE =
  "The acceptance agent saw only the locked requirement (background, functional requirements, acceptance criteria, discussion outcomes) and your re-review note — never the design, the debate, the development notes or the code history.";

export interface ReviewView {
  maxAttempts: number;
  series: ReviewSeriesRecord[];
  reports: Array<{ id: number; seriesId: number; attempt: number; verdict: ReviewReportRecord["verdict"]; createdAt: string; decision: string | null; failedAcs: string[] }>;
  /** the current round's latest report (null before the round's first report) */
  current: ReviewReportRecord | null;
  evidence: Array<{ id: number; refKey: string; acId: string; kind: string; caption: string }>;
  step: ReviewStep | null;
  isolationNote: string;
}

const REVIEW_STEP_STATES = new Set(["reviewing", "awaiting_review_ack", "awaiting_confirmation", "developing", "blocked"]);

export function reviewView(db: DatabaseSync, config: Config, t: Ticket): ReviewView {
  const reports = listReports(db, t.key);
  const decisions = listDecisions(db, t.key);
  const latestDecision = (reportId: number) => decisions.filter((d) => d.reportId === reportId).at(-1)?.decision ?? null;
  const cur = currentSeries(db, t.key);
  const own = cur ? reports.filter((r) => r.seriesId === cur.id) : [];
  const current = own.at(-1) ?? null;
  let step: ReviewStep | null = null;
  if (cur && REVIEW_STEP_STATES.has(t.state)) {
    const ids = new Set(own.map((r) => r.id));
    const carry = own.length === 0 ? (reports.filter((r) => r.seriesId < cur.id).at(-1) ?? null) : null;
    step = nextReviewStep({
      series: cur, reports: own, carry, iterations: listIterations(db, t.key), maxAttempts: config.review.maxAttempts,
      decisions: decisions.filter((d) => ids.has(d.reportId)).map((d) => ({ reportId: d.reportId, decision: d.decision })),
    });
  }
  const allSeries = db.prepare("SELECT * FROM review_series WHERE ticket_key = ? ORDER BY id").all(t.key) as Array<Record<string, unknown>>;
  return {
    maxAttempts: config.review.maxAttempts,
    series: allSeries.map((r) => ({
      id: r.id as number, startedBy: r.started_by as ReviewSeriesRecord["startedBy"], note: r.note as string | null, decidedBy: r.decided_by as string, createdAt: r.created_at as string,
    })),
    reports: reports.map((r) => ({ id: r.id, seriesId: r.seriesId, attempt: r.attempt, verdict: r.verdict, createdAt: r.createdAt, decision: latestDecision(r.id), failedAcs: r.report.acs.filter((a) => a.verdict === "fail").map((a) => a.acId) })),
    current,
    evidence: current ? listEvidence(db, t.key, current.id) : [],
    step,
    isolationNote: current && !current.report.isolation.ok ? `${ISOLATION_NOTE} The isolation checks of the latest run did not pass.` : ISOLATION_NOTE,
  };
}

/** One report of the ticket (any round) with its evidence list and the developer's latest decision on it. */
export function reportView(db: DatabaseSync, t: Ticket, reportId: number) {
  const r = listReports(db, t.key).find((x) => x.id === reportId);
  if (!r) throw new NotFoundError(`no review report ${reportId} for ${t.key}`);
  return { ...r, decision: listDecisions(db, t.key).filter((d) => d.reportId === r.id).at(-1)?.decision ?? null, evidence: listEvidence(db, t.key, r.id) };
}

const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The bytes and content type of one evidence file of the ticket. Everything that is not exactly the recorded, regular
 * file under `<home>/reviews/<KEY>/` is a NotFoundError: an id of another ticket, a path with `..` / absolute / hidden
 * segments, a path whose real location leaves that folder (symlinked parent or file), something that is not a regular
 * file (opened with O_NOFOLLOW and checked with fstat), bytes that no longer match the recorded sha256, a screenshot
 * that is not a PNG or JPEG.
 */
export function evidenceFile(db: DatabaseSync, home: string, key: string, evidenceId: number): { data: Buffer; contentType: string } {
  const gone = () => new NotFoundError(`evidence ${evidenceId} is not available`);
  const row = getEvidence(db, key, evidenceId);
  if (!row) throw new NotFoundError(`unknown evidence ${evidenceId} for ${key}`);
  const segs = row.path.split("/");
  if (isAbsolute(row.path) || segs.some((s) => s === "" || s === "." || s === ".." || s.startsWith(".")) || segs[0] !== key) throw gone();
  let fd: number | null = null;
  try {
    const base = join(realpathSync.native(join(home, "reviews")), key);
    const real = realpathSync.native(join(base, ...segs.slice(1)));
    if (realpathSync.native(base) !== base || !real.startsWith(base + sep)) throw gone(); // reviews/<KEY> itself must not be a link
    fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_EVIDENCE_BYTES) throw gone();
    const data = Buffer.alloc(st.size);
    let off = 0;
    while (off < data.length) {
      const n = readSync(fd, data, off, data.length - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== data.length || createHash("sha256").update(data).digest("hex") !== row.sha256) throw gone();
    if (row.kind !== "screenshot") return { data, contentType: "text/plain; charset=utf-8" };
    if (data.subarray(0, 8).equals(PNG_MAGIC)) return { data, contentType: "image/png" };
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { data, contentType: "image/jpeg" };
    throw gone();
  } catch (err) {
    throw err instanceof NotFoundError ? err : gone();
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
