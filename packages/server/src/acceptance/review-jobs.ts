// Task 9: the acceptance flow. A hand-off, a reject or a Retry after the attempt cap starts a review series (round);
// the job `review:<KEY>` (state reviewing) re-reads the ticket and checks it for drift before an acceptance run
// (§9.9 trigger before_review), runs one isolated acceptance (export, isolation checks, target apps, the sandboxed
// acceptance agent, the platform's own re-run, verdicts, evidence) and then follows nextReviewStep: a failed report goes
// back to development with the feedback, until the round's attempt cap; passed / not executed waits for the developer.
// Every decision is derived from stored data (ruling R7), so a restart re-enqueues the job and lands on the same step.
import { createHash } from "node:crypto";
import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  DriftResult, acceptanceResultSchema, driftNeedsAck, type AcceptanceCase, type AcceptanceReport, type CaseResult, type AcceptanceResult, type AcceptanceTarget, type AcEvaluation, type ReviewReportRecord,
  type TestRun, isTicketKey,
} from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { listIterations, startIteration } from "../development/dev-repo.ts";
import { runCommand } from "../development/run-command.ts";
import { acknowledgeDrift, findDrifts, saveDrift, type DriftRecord } from "../drift/drift-repo.ts";
import { buildDriftPrompt } from "../drift/drift-prompt.ts";
import { killRecordedGroups } from "../executor/run-agent.ts";
import { acceptCommandLine, caseCommandLine, SandboxPolicyError, toolPolicy, type PolicyContext } from "../executor/sandbox.ts";
import { changedPaths, git } from "../git/worktree.ts";
import { jiraLoginError, type TicketSource } from "../jira/ticket-source.ts";
import { isAppEntry, type AppAcceptanceRules, type CliAcceptanceRules, type LibraryAcceptanceRules, type RepoContext } from "../projects/project-rules.ts";
import { currentChoice, firstRequirement, getRequirement } from "../requirements/requirement-repo.ts";
import { baselineSnapshot, saveSnapshot } from "../snapshots/snapshot-store.ts";
import { InvalidTransitionError, ValidationError } from "../tickets/errors.ts";
import { getTicket, listRepoWorkspaces, setJiraStatus } from "../tickets/ticket-repo.ts";
import { localNetworkFor, type SandboxScope } from "../sandbox/local-sandbox.ts";
import type { EvidenceInput } from "./review-repo.ts";
import {
  beginAcceptanceRun, currentSeries, endAcceptanceRun, listDecisions, listReports, openAcceptanceRuns, recordDecision, saveReport, setRunProcesses, startSeries,
} from "./review-repo.ts";
import { nextReviewStep, type ReviewStepInput } from "./review-step.ts";
import { acceptanceInput, buildAcceptancePrompt } from "./acceptance-input.ts";
import { evaluate, evaluateCases, evidenceResolver, overallVerdict, parsePlaywrightReport, reviewFeedback, type SpecRun } from "./verdicts.ts";
import { caseEnv, caseRunSummary, caseTranscript, CaseTargetError, cliTarget, copyCaseInputs, libraryTarget, loadCases, runCases, type CliTarget, type LibTarget } from "./case-runner.ts";
import { changedSince } from "./snapshot-check.ts";
import { redactDeep, redactStored } from "../credentials/credential-store.ts";
import { killLeftovers, PlatformProcesses, startTargets, stopTargets, targetEnv, type StartedTarget } from "./app-runner.ts";
import { scaffoldDigest, specViolations } from "./spec-guard.ts";
import { applyDropped, copyEvidence } from "./evidence-copy.ts";
import {
  acceptRunBase, assertAcceptanceIsolation, CASES_SHIM, CASES_SHIM_CONFIG, cleanupRunDirs, designQuoteLines, excludeDesignQuotes, exportRepo, prepareRunDirs, RUN_ROOT_NAME,
  withAcceptanceConfigDir, writeCasesScaffold, writeCasesShim, writePlaywrightScaffold, type AcceptanceRunDirs, type CasesShimConfig,
} from "./workspace.ts";
import type { WorkflowCtx } from "../workflow/jobs.ts";
import { logError } from "../log.ts";

export interface ReviewJobs {
  /** Enqueue `review:<KEY>` for a ticket in reviewing (hand-off, re-review, fix iteration done, recovery, retry). */
  enqueue(key: string): void;
  /** dev_done → reviewing; a new round (handoff); the job re-reads the ticket first. */
  handOff(key: string, decidedBy: string): void;
  /** awaiting_review_ack → reviewing; the note is required (R13); the drift check that stopped the review is acknowledged. */
  ackReview(key: string, note: string, decidedBy: string): void;
  /** awaiting_confirmation → developing: decision rejected, a new round (rejected) and a rejected iteration with the note. */
  rejectReview(key: string, note: string, decidedBy: string): void;
  /** awaiting_confirmation → reviewing: decision re_review (counts in the current round); refused at the cap. */
  reReview(key: string, note: string, decidedBy: string): void;
  /** Workflow.retry of a ticket blocked in reviewing: back to reviewing (a new round when the cap was reached), then the job. */
  retry(key: string, decidedBy: string): void;
  /** Startup: stop and remove what acceptance runs of a previous process left (before tickets are resumed). */
  recoverRuns(): void;
}

/** Tests only (T9-8): the seam around the move of <workDir>/acceptance out of the run root (T9-3). */
export interface AcceptanceTestHooks {
  /** right before the move, after every process of the run was stopped */
  beforeMove?(o: { acceptanceDir: string; runRoot: string }): void;
  /** right after the move, before anything is read */
  afterMove?(o: { acceptanceDir: string; readDir: string }): void;
  /** phase 4f: after the agent phase's sweep, right before the fresh run root of the case re-run is made */
  beforeRerun?(o: { runRoot: string }): void;
}

export interface ReviewDeps {
  source: TicketSource;
  /** the platform's target app process groups (main.ts kills them on shutdown and exit) */
  processes: PlatformProcesses;
  /** the Slack Off checkout (its node_modules has @playwright/test) */
  repoRoot: string;
  testHooks?: AcceptanceTestHooks;
}

/** The ticket left reviewing (abandoned) while the job ran: stop quietly, save nothing. */
class LeftReviewing extends Error {
  constructor() {
    super("the ticket is no longer in review");
    this.name = "LeftReviewing";
  }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const WATCH_MS = 2_000;
const MAX_SPEC_FILE = 64 * 1024;
const MAX_SPEC_FILES = 50;
const REVIEW_CHANGED = "The JIRA ticket changed since the requirements were locked — review the drift before acceptance";
/** audit type of the before-review re-read (the stored proof that step 1 is done for a round / re-review, R7) */
const SNAPSHOT_CHECKED = "review_snapshot_checked";

/**
 * §9.9 before_review: the locked requirement checked against the JIRA snapshot `snapshotId` (Task 9 step 1's rules,
 * shared with delivery's snapshot step, Task 12):
 * - `unchanged`: the snapshot is the locked requirement's own;
 * - `reused`: a check of this requirement against this very snapshot exists — a before_review one (its ack state
 *   decides), or a snapshot_changed one that was acknowledged or needed no ack (never asked twice);
 * - `new`: refine-ticket ran in drift mode and its before_review check was saved; `withSaved(needsAck)` runs in the same
 *   transaction as the save.
 */
export async function lockedRequirementDrift(
  ctx: WorkflowCtx,
  key: string,
  snapshotId: number,
  o: { checkpoint(): void; withSaved?(needsAck: boolean): void },
): Promise<{ kind: "unchanged" } | { kind: "reused" | "new"; drift: DriftRecord }> {
  const { db } = ctx;
  const choice = currentChoice(db, key);
  if (!choice) throw new InvalidTransitionError(`${key}: no solution has been chosen`);
  const current = getRequirement(db, choice.requirementId);
  if (!current) throw new Error(`${key}: the chosen requirement ${choice.requirementId} is missing`);
  if (snapshotId === current.snapshotId) return { kind: "unchanged" };
  const done = findDrifts(db, key, current.id, snapshotId, ["before_review", "snapshot_changed"]).find(
    (d) => d.trigger === "before_review" || d.acknowledged || !driftNeedsAck(d.result),
  );
  if (done) return { kind: "reused", drift: done };
  const baseline = firstRequirement(db, key);
  const baselineSnapshotId = baselineSnapshot(db, key);
  if (!baseline || baselineSnapshotId === undefined) throw new Error(`${key}: drift check needs a requirement and a snapshot`);
  const prompt = buildDriftPrompt(db, key, { baseline, current, baselineSnapshotId, latestSnapshotId: snapshotId });
  const result = await ctx.run({ role: "refine-ticket", ticketKey: key, prompt, cwd: ctx.cwdFor(ctx.mustGet(key)), allowedTools: [], chrome: false, schema: DriftResult });
  o.checkpoint();
  const needsAck = driftNeedsAck(result);
  const id = ctx.atomic(() => {
    const saved = saveDrift(db, key, current.id, baselineSnapshotId, snapshotId, "before_review", result);
    o.withSaved?.(needsAck);
    return saved.id;
  });
  return { kind: "new", drift: findDrifts(db, key, current.id, snapshotId, ["before_review"]).find((d) => d.id === id)! };
}

export function createReviewJobs(ctx: WorkflowCtx, deps: ReviewDeps): ReviewJobs {
  const { db, home, config, bus } = ctx;
  const { source, processes, repoRoot } = deps;

  const reviewing = (key: string) => getTicket(db, key)?.state === "reviewing";
  const checkpoint = (key: string) => {
    if (!reviewing(key)) throw new LeftReviewing();
  };
  const mappedRepos = (): string[] => Object.values(config.projects).flatMap((p) => p.repos.map((r) => r.path));
  const updated = (key: string) => bus.emit({ type: "review_updated", ticketKey: key });

  // ---- stored state

  const stepInput = (key: string): ReviewStepInput => {
    const series = currentSeries(db, key);
    if (!series) throw new InvalidTransitionError(`${key}: no review round has been started`);
    const all = listReports(db, key);
    const reports = all.filter((r) => r.seriesId === series.id);
    const ids = new Set(reports.map((r) => r.id));
    const decisions = listDecisions(db, key)
      .filter((d) => ids.has(d.reportId))
      .map((d) => ({ reportId: d.reportId, decision: d.decision }));
    const carry = reports.length === 0 ? (all.filter((r) => r.seriesId < series.id).at(-1) ?? null) : null;
    return { series, reports, decisions, carry, iterations: listIterations(db, key), maxAttempts: config.review.maxAttempts };
  };

  /** The re-review note of the current round's latest report (the latest decision on it is re_review), else null. */
  const reReviewOf = (key: string, s: ReviewStepInput): { reportId: number; note: string | null } | null => {
    const own = s.reports.at(-1);
    if (!own) return null;
    const d = listDecisions(db, key).filter((x) => x.reportId === own.id).at(-1);
    return d?.decision === "re_review" ? { reportId: own.id, note: d.note } : null;
  };

  /** Step 1 is due when the round has no report yet, or after a re-review decision; this names that occasion. */
  const recheckOccasion = (key: string, s: ReviewStepInput): { seriesId: number; afterReportId: number | null } | null => {
    if (s.reports.length === 0) return { seriesId: s.series.id, afterReportId: null };
    const rr = reReviewOf(key, s);
    return rr ? { seriesId: s.series.id, afterReportId: rr.reportId } : null;
  };

  const checkedMarks = (key: string): Array<{ seriesId: number; afterReportId: number | null; snapshotId: number }> =>
    (db.prepare("SELECT payload_json FROM audit_event WHERE type = ? AND ticket_key = ? ORDER BY id").all(SNAPSHOT_CHECKED, key) as Array<{ payload_json: string }>).map(
      (r) => JSON.parse(r.payload_json) as { seriesId: number; afterReportId: number | null; snapshotId: number },
    );
  const markChecked = (key: string, o: { seriesId: number; afterReportId: number | null }, snapshotId: number) =>
    appendAudit(db, { actor: "system", type: SNAPSHOT_CHECKED, ticketKey: key, payload: { ...o, snapshotId } });

  // ---- step 1: re-read and drift check (§9.9 before_review)

  /** The snapshot to accept against, or null when the review stopped (awaiting_review_ack). */
  const recheck = async (key: string, occasion: { seriesId: number; afterReportId: number | null }): Promise<number | null> => {
    const fetched = await source.fetchTicket(key);
    if (fetched.loginRequired) throw jiraLoginError(ctx.jiraMode());
    checkpoint(key);
    const { snapshotId } = saveSnapshot(db, home, key, fetched, ctx.jiraMode());
    if (fetched.status !== null) setJiraStatus(db, key, fetched.status);
    const r = await lockedRequirementDrift(ctx, key, snapshotId, {
      checkpoint: () => checkpoint(key),
      withSaved: (needsAck) => {
        if (needsAck) ctx.move(key, "awaiting_review_ack", "system", REVIEW_CHANGED);
        else markChecked(key, occasion, snapshotId);
      },
    });
    if (r.kind === "unchanged") {
      markChecked(key, occasion, snapshotId);
      return snapshotId;
    }
    if (r.kind === "reused") {
      if (driftNeedsAck(r.drift.result) && !r.drift.acknowledged) {
        ctx.move(key, "awaiting_review_ack", "system", REVIEW_CHANGED);
        bus.emit({ type: "snapshot_changed", ticketKey: key, needsAck: true });
        return null;
      }
      markChecked(key, occasion, snapshotId);
      return snapshotId;
    }
    const needsAck = driftNeedsAck(r.drift.result);
    bus.emit({ type: "snapshot_changed", ticketKey: key, needsAck });
    return needsAck ? null : snapshotId;
  };

  // ---- the job

  const runReview = async (key: string): Promise<void> => {
    try {
      for (;;) {
        if (!reviewing(key)) return;
        const s = stepInput(key);
        const step = nextReviewStep(s);
        if (step.kind === "await_decision") {
          ctx.move(key, "awaiting_confirmation", "system");
          updated(key);
          return;
        }
        if (step.kind === "cap_reached") {
          const last = s.reports.at(-1);
          const failedAcs = last ? last.report.acs.filter((a) => a.verdict !== "pass").map((a) => a.acId) : [];
          ctx.move(
            key, "blocked", "system",
            `acceptance failed ${step.attempts} of ${config.review.maxAttempts} attempts in this round${failedAcs.length > 0 ? `: ${failedAcs.join(", ")}` : ""} — Retry starts a new round`,
          );
          return;
        }
        if (step.kind === "fix") {
          const report = [...s.reports, ...(s.carry ? [s.carry] : [])].find((r) => r.id === step.reportId)!;
          // 4F-8 (n-3): every known secret value redacted before the note is stored (and sent to the developer agent)
          const note = redactStored(home, reviewFeedback(report.report, readStoredSpecs(key, report)));
          ctx.atomic(() => {
            startIteration(db, key, "review_failed", note, null);
            ctx.move(key, "developing", "system");
          });
          updated(key);
          ctx.enqueueDevelop(key);
          return;
        }
        // accept: step 1 when due (a new round, or after a re-review), then one acceptance run
        const occasion = recheckOccasion(key, s);
        let snapshotId: number | null = null;
        if (occasion) {
          const mark = checkedMarks(key).filter((m) => m.seriesId === occasion.seriesId && m.afterReportId === occasion.afterReportId).at(-1);
          snapshotId = mark ? mark.snapshotId : await recheck(key, occasion);
          if (snapshotId === null) return; // awaiting_review_ack
        }
        if (snapshotId === null) snapshotId = s.reports.at(-1)?.snapshotId ?? lockedSnapshot(key);
        const saved = await withAcceptanceConfigDir(() => acceptOnce(key, step.attempt, snapshotId, reReviewOf(key, s)?.note ?? null));
        if (!saved) return;
      }
    } catch (err) {
      if (err instanceof LeftReviewing) return;
      throw err;
    }
  };

  const lockedSnapshot = (key: string): number => {
    const choice = currentChoice(db, key);
    const req = choice ? getRequirement(db, choice.requirementId) : null;
    if (!req) throw new Error(`${key}: no locked requirement`);
    return req.snapshotId;
  };

  /** One acceptance run; true when its report was saved. */
  const acceptOnce = async (key: string, attempt: number, snapshotId: number, developerNote: string | null): Promise<boolean> => {
    checkpoint(key);
    const series = currentSeries(db, key)!;
    const repos = await ctx.repoContexts(key);
    const choice = currentChoice(db, key)!;
    const req = getRequirement(db, choice.requirementId)!;
    const acs = req.content.acceptanceCriteria.map((a) => ({ id: a.id, text: a.text }));
    const commits = await headsOf(key, repos);
    checkpoint(key);

    // phase 4f: command-line and library entries run declared cases (acceptCaseEntries); web / api entries as phase 3
    const caseEntries = repos.filter((r) => r.rules.rules.acceptance !== null && !isAppEntry(r.rules.rules.acceptance));
    const declared = repos.filter((r) => r.rules.rules.acceptance !== null && isAppEntry(r.rules.rules.acceptance));
    const appRules = (r: RepoContext) => r.rules.rules.acceptance as AppAcceptanceRules;
    const caseRules = (r: RepoContext) => r.rules.rules.acceptance as CliAcceptanceRules | LibraryAcceptanceRules;
    const undeclared: AcceptanceTarget[] = repos
      .filter((r) => !declared.includes(r))
      .map((r) =>
        r.rules.rules.acceptance === null
          ? { repo: r.name, entry: "web", baseUrl: "", started: false, detail: "no acceptance section" }
          : { repo: r.name, entry: caseRules(r).entry, baseUrl: "", started: false, detail: "declared cases: not run yet" },
      );
    // phase 4a Task 4: in allowlist mode the run reaches the repos' declared sandbox.localPorts and each app's baseUrl port
    const net = localNetworkFor(config.development.localNetwork, [
      ...repos.flatMap((r) => r.rules.rules.sandbox?.localPorts ?? []),
      ...declared.map((r) => Number(new URL(appRules(r).baseUrl).port)).filter((p) => p > 0),
    ]);
    let started: StartedTarget[] = declared.map((r) => ({
      repo: r.name, entry: appRules(r).entry, baseUrl: appRules(r).baseUrl, started: false, detail: "not started", pgid: null,
    }));
    const targetsNow = (): AcceptanceTarget[] => {
      const by = new Map<string, AcceptanceTarget>([
        ...undeclared.map((t) => [t.repo, t] as const),
        ...started.map(({ repo, entry, baseUrl, started: st, detail }) => [repo, { repo, entry, baseUrl, started: st, detail }] as const),
      ]);
      return repos.map((r) => by.get(r.name)!);
    };
    let isolation: AcceptanceReport["isolation"] = { ok: false, checks: [], excluded: [] };
    const projectE2e: TestRun[] = [];
    const notExecuted = (reason: string): AcceptanceReport => ({
      verdict: "not_executed",
      notExecutedReason: reason,
      summary: `E2E not executed: ${reason}`,
      targets: targetsNow(),
      acs: acs.map((a) => ({ acId: a.id, text: a.text, verdict: "not_tested", agentVerdict: null, flows: [], mismatch: null })),
      specRun: null,
      projectE2e,
      isolation,
      commits: commits.map(({ repo, sha }) => ({ repo, sha })),
    });
    const save = (report: AcceptanceReport, evidence: EvidenceInput[] = []): true => {
      checkpoint(key); // abandoned meanwhile: no report
      saveReport(db, key, { seriesId: series.id, requirementId: req.id, snapshotId, attempt, report, developerNote, evidence });
      updated(key);
      return true;
    };

    if (caseEntries.length > 0 && declared.length > 0) {
      const names = (rs: RepoContext[]) => rs.map((r) => `${r.name} (${r.rules.rules.acceptance!.entry})`).join(", ");
      return save(
        notExecuted(`one acceptance run cannot mix web or API apps (${names(declared)}) with command-line tools or libraries (${names(caseEntries)}) — choose the repositories of one kind`),
      );
    }
    if (caseEntries.length > 0) {
      const setDetail = (repo: string, detail: string) => {
        const t = undeclared.find((x) => x.repo === repo);
        if (t) t.detail = detail;
      };
      return acceptCaseEntries({
        key, attempt, seriesId: series.id, acs, commits, developerNote, caseRepos: caseEntries.map((r) => ({ name: r.name, rules: caseRules(r) })), net,
        save, notExecuted, setDetail, setIsolation: (i) => (isolation = i), targets: targetsNow,
      });
    }
    if (declared.length === 0) {
      return save(notExecuted(`no acceptance section in .slackoff/config.json of ${repos.map((r) => r.name).join(", ")} — e2e not executed`));
    }

    let dirs: AcceptanceRunDirs | null = null;
    /** T9-3: where the acceptance dir is read from once the run is stopped */
    let readDir: string | null = null;
    let runId: number | null = null;
    let interrupted = false;
    const pgids: number[] = [];
    const controller = new AbortController();
    let scope: SandboxScope | null = null;
    /** every target stopped and every process of the run killed (also from the watcher; safe to repeat) */
    const stopAll = async (): Promise<void> => {
      if (dirs === null) return;
      const d = dirs;
      const sc = scope ?? { kind: "acceptance" as const, home, allowInHome: null, repos: mappedRepos(), runRoot: d.runRoot, acceptConfigDir: d.configDir, ...net };
      await stopTargets(started, d.workDir, { env: targetEnv({}, d.runRoot), sandbox: sc, processes, runRoot: d.runRoot });
      killLeftovers(d.runRoot, pgids);
    };
    // R7: abandoned (or closed) while the run goes on → abort the agent and stop the apps; the job stops at its next checkpoint
    const watcher = setInterval(() => {
      if (reviewing(key)) return;
      controller.abort();
      void stopAll().catch(() => {});
    }, WATCH_MS);

    try {
      dirs = await prepareRunDirs({ home, repoPaths: mappedRepos(), config });
      runId = beginAcceptanceRun(db, key, { seriesId: series.id, attempt, runRoot: dirs.runRoot }).id;
      const d = dirs;
      const run = runId;
      const sc: SandboxScope = {
        kind: "acceptance", home, allowInHome: null, repos: mappedRepos(), runRoot: d.runRoot, acceptConfigDir: d.configDir,
        ...(config.development.deniedLocalPorts.length > 0 ? { extraPorts: config.development.deniedLocalPorts } : {}),
        ...net,
        ...ctx.remoteScope(),
      };
      scope = sc;
      // T9-6 (L3): every command the platform runs for this run is registered like the target apps (shutdown kills it)
      const track = {
        add: (p: number) => {
          processes.add(p, d.runRoot);
          pgids.push(p);
          setRunProcesses(db, run, [...pgids]);
        },
        remove: (p: number) => processes.remove(p),
      };
      // T9-1: the self-check needs the run's scope (run root, config dir, every mapped repo); never skipped
      // (development.allowUnsandboxedCommands does not apply to acceptance)
      const check = await ctx.sandboxCheck(sc);
      if (!check.ok) return save(notExecuted(`isolation check failed: sandbox self-check: ${check.detail}`));
      checkpoint(key);

      // export, exclusions, scaffold, isolation checks: any failure → not executed (T9-1)
      const manifest = new Map<string, string>();
      const excluded: string[] = [];
      let checks: string[];
      let scaffold: Record<string, string>;
      try {
        const quotes = designQuoteLines(db, key);
        for (const c of commits) {
          const dest = join(d.workDir, c.repo);
          const m = await exportRepo(c.wt, c.sha, dest, d.runRoot);
          const gone = await excludeDesignQuotes(dest, await baseFilesOf(c.wt, c.baseBranch), quotes);
          for (const p of gone) m.delete(join(dest, p));
          excluded.push(...gone.map((p) => `${c.repo}/${p}`));
          for (const [k, v] of m) manifest.set(k, v);
        }
        writePlaywrightScaffold(d, repoRoot, started, sc);
        checks = assertAcceptanceIsolation(d, { home, repoPaths: mappedRepos(), repoRoot, quotes, exported: manifest });
        scaffold = scaffoldDigest(d.acceptanceDir);
      } catch (err) {
        if (err instanceof LeftReviewing) throw err;
        isolation = { ok: false, checks: [], excluded };
        const msg = errMessage(err);
        return save(notExecuted(msg.startsWith("isolation check failed") ? msg : `isolation check failed: ${msg}`));
      }
      isolation = { ok: true, checks, excluded };
      appendAudit(db, { actor: "system", type: "acceptance_isolation_checked", ticketKey: key, payload: { runId: run, seriesId: series.id, attempt, checks, excluded } });
      checkpoint(key);

      // the target apps (sandboxed; every group registered for shutdown and recovery)
      const st = await startTargets({
        workDir: d.workDir,
        repos: declared.map((r) => ({ name: r.name, acceptance: appRules(r) })),
        startTimeoutMs: config.acceptance.startTimeoutMs,
        commandTimeoutMs: config.development.commandTimeoutMs,
        runRoot: d.runRoot,
        sandbox: sc,
        processes,
        onPgid: (p) => {
          pgids.push(p);
          setRunProcesses(db, run, [...pgids]);
        },
      });
      started = st.targets;
      if (st.notExecutedReason !== null) return save(notExecuted(st.notExecutedReason));
      checkpoint(key);

      // the project's own e2e command: extra evidence only
      for (const r of declared) {
        const a = appRules(r);
        if (!a.testCommand) continue;
        projectE2e.push(await runCommand(join(d.workDir, r.name), a.testCommand, config.development.commandTimeoutMs, { kind: "sandboxed", scope: sc }, targetEnv(a.env, d.runRoot), track));
        checkpoint(key);
      }

      // T9-4: before the agent runs the export must still be exactly what was committed; what the target apps, their
      // install or the project's test command wrote in tracked paths is theirs, not the agent's
      const before = changedSince(manifest).map((abs) => relative(d.workDir, abs));
      if (before.length > 0) {
        return save(notExecuted(`the target app or its install wrote tracked paths: ${before.slice(0, 20).join(", ")}${before.length > 20 ? "…" : ""} — tracked files must stay as committed during acceptance`));
      }

      // the acceptance agent
      const policy: PolicyContext = { workDir: d.workDir, denyPaths: commits.map((c) => `${c.repo}/**`) };
      const prompt = buildAcceptancePrompt(acceptanceInput(db, key, developerNote), {
        workDir: d.workDir, targets: targetsNow().filter((t) => t.started), commandLine: acceptCommandLine(d.workDir), attempt, maxAttempts: config.review.maxAttempts,
      });
      let agent: AcceptanceResult;
      try {
        agent = await ctx.run({
          role: "acceptance-review",
          ticketKey: key,
          prompt,
          cwd: d.workDir,
          allowedTools: [...toolPolicy("acceptance-review", policy).allowed],
          chrome: false,
          schema: acceptanceResultSchema(acs.map((a) => a.id)),
          policy,
          timeoutMs: config.acceptance.runTimeoutMs,
          isolation: { claudeConfigDir: d.configDir, shimDir: d.shimDir, sandbox: sc },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new LeftReviewing();
        // runAgent's own isolation checks before the agent starts (its sandbox self-check, the wrapper): not executed
        if (err instanceof SandboxPolicyError && err.message.startsWith("isolation check failed")) return save(notExecuted(err.message));
        throw err; // agent error / timeout / invalid output → blocked; shutdown → left for recovery
      }
      checkpoint(key);

      // the app under test must be exactly what was exported (T9-1: compared with exportRepo's blob ids; T9-4: it was
      // before the agent ran, so any change now happened during the agent run)
      const changed = changedSince(manifest).map((abs) => relative(d.workDir, abs));
      // the platform's own re-run: results and evidence only from it (T8-2 / T9-1: nothing stale)
      for (const n of ["results.json", "evidence", "artifacts", "test-results"]) rmSync(join(d.acceptanceDir, n), { recursive: true, force: true });
      mkdirSync(join(d.acceptanceDir, "evidence"));
      const violations = specViolations(d.acceptanceDir, scaffold);
      let specRun: TestRun | null = null;
      if (violations.length === 0) {
        // T9-1: the shim does not sandbox itself; it runs under the run's acceptance sandbox, from the acceptance dir
        specRun = await runCommand(d.acceptanceDir, `${join(d.shimDir, "playwright")} test`, config.acceptance.runTimeoutMs, { kind: "sandboxed", scope: sc }, targetEnv({}, d.runRoot), track);
      }
      // T8-2 carry: evidence is read only once every agent, test and target process of the run is dead
      await stopAll();
      checkpoint(key);

      // T9-3 (M1): a process that escaped the stop (detached, empty environment: killLeftovers cannot see it) may still
      // write in the run root. The acceptance dir is moved out of it, into a fresh 0700 platform dir next to it (same
      // volume): the sandbox only lets a run write inside RUN_ROOT, so nothing changes under the moved dir any more and
      // every read below is from there. (Residual: such a process lives on, sandboxed, until it exits on its own.)
      deps.testHooks?.beforeMove?.({ acceptanceDir: d.acceptanceDir, runRoot: d.runRoot });
      readDir = mkdtempSync(`${d.runRoot}-read-`);
      const acc = join(readDir, "acceptance");
      renameSync(d.acceptanceDir, acc);
      deps.testHooks?.afterMove?.({ acceptanceDir: d.acceptanceDir, readDir });
      // T9-8: what was moved must be the directory itself — a symlink put in its place would lead every read back into
      // the still-writable run root: then there are no results and no specs at all
      const isDir = lstatSync(acc).isDirectory();
      const accReal = isDir ? realpathSync(acc) : acc;
      const specSources = isDir ? readSpecs(acc) : {};
      const noRun: SpecRun = { run: { command: "", exitCode: null, timedOut: false, outputTail: "" }, tests: [] };
      let parsed: SpecRun = specRun && isDir ? parsePlaywrightReport(join(acc, "results.json"), specRun) : specRun ? { ...noRun, run: specRun } : noRun;
      // what was written before the move could still be forged: results.json must agree with the run's own output
      const agrees = specRun === null || resultsAgree(parsed, specRun.outputTail);
      if (!agrees) parsed = { ...parsed, tests: [] };
      // attachment paths in results.json name the old place of the acceptance dir
      const oldAcc = d.acceptanceDir + sep;
      const resolve = evidenceResolver(acc);
      const ev = evaluate(agent, parsed, acs, (rel) => (isDir ? resolve(rel.startsWith(oldAcc) ? join(acc, rel.slice(oldAcc.length)) : rel) : null));
      let evaluated = ev.acs;
      const override = !isDir
        ? "acceptance output was not a directory (it was replaced before the platform read it)"
        : changed.length > 0
          ? `the acceptance agent changed the app under test: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? "…" : ""} (the target app and its tests must not write version-controlled paths)`
          : violations.length > 0
            ? `spec guard: ${violations.slice(0, 10).join("; ")}`
            : !agrees
              ? "the platform run's results.json does not match its own output (a process of the run may have outlived it)"
              : null;
      if (override !== null) evaluated = evaluated.map((a) => ({ ...a, verdict: "fail", mismatch: a.mismatch ? `${override}; ${a.mismatch}` : override }));

      const reviewRel = `${key}/${series.id}-${attempt}`;
      const reviewDir = reviewDirOf(key, series.id, attempt);
      rmSync(reviewDir, { recursive: true, force: true }); // an earlier, unsaved try of this attempt
      mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
      const copied = copyEvidence(ev.evidence, {
        roots: ["evidence", "artifacts"].map((n) => join(accReal, n)),
        destDir: reviewDir,
        relBase: reviewRel,
      });
      evaluated = applyDropped(evaluated, copied);
      writeFileSync(join(reviewDir, "specs.json"), JSON.stringify(redactDeep(specSources, (t) => redactStored(home, t))), { mode: 0o600 });

      const report: AcceptanceReport = {
        verdict: overallVerdict(evaluated),
        notExecutedReason: null,
        summary: agent.summary,
        targets: targetsNow(),
        acs: evaluated,
        specRun,
        projectE2e,
        isolation,
        commits: commits.map(({ repo, sha }) => ({ repo, sha })),
      };
      return save(report, copied.kept);
    } catch (err) {
      interrupted = true;
      throw err;
    } finally {
      clearInterval(watcher);
      try {
        await stopAll();
      } catch {
        // stopTargets never throws; killLeftovers neither
      }
      if (readDir !== null) rmSync(readDir, { recursive: true, force: true });
      if (dirs !== null) {
        try {
          await cleanupRunDirs(dirs);
        } catch (err) {
          logError(`${key}: could not remove the acceptance run root ${dirs.runRoot}: ${errMessage(err)}`);
        }
      }
      if (runId !== null) {
        try {
          endAcceptanceRun(db, runId, interrupted ? "interrupted" : "finished");
        } catch {
          // already ended (recovery) or the database is closing (shutdown)
        }
      }
    }
  };

  /**
   * Phase 4f (Task 4, rulings F-1 … F-5, 4F-1 … 4F-5): one acceptance run of command-line and library entries. Run root R1:
   * export, install / build (acceptance-install sandbox), the targets, the case scaffold and the `slackoff-cases` shim,
   * the isolation checks, the sandboxed agent (its only command `slackoff-cases run`). Then every process of R1 is
   * swept (4F-5 M4) and the platform re-runs every case in a FRESH run root R2 (a new export and build, the agent's cases
   * and examples copied by copyCaseInputs, per-case sandboxes, bounded by runTimeoutMs): only that run is evidence. Its
   * transcripts are written from the in-memory results outside both run roots and copied like any evidence (T8-2 / T9-3).
   */
  const acceptCaseEntries = async (o: {
    key: string;
    attempt: number;
    seriesId: number;
    acs: Array<{ id: string; text: string }>;
    commits: Array<{ repo: string; sha: string; wt: string; baseBranch: string }>;
    developerNote: string | null;
    caseRepos: Array<{ name: string; rules: CliAcceptanceRules | LibraryAcceptanceRules }>;
    net: Pick<SandboxScope, "localNetwork">;
    save(report: AcceptanceReport, evidence?: EvidenceInput[]): true;
    notExecuted(reason: string): AcceptanceReport;
    setDetail(repo: string, detail: string): void;
    setIsolation(i: AcceptanceReport["isolation"]): void;
    targets(): AcceptanceTarget[];
  }): Promise<boolean> => {
    const { key, attempt, acs, commits } = o;
    const acIds = acs.map((a) => a.id);
    // 4F-7 (I-2, ruling F-1): a tool that needs a terminal cannot be run by declared cases — say so, run nothing
    const interactive = o.caseRepos.filter((r) => r.rules.entry === "cli" && r.rules.cli.interactive === true);
    if (interactive.length > 0) {
      for (const r of interactive) o.setDetail(r.name, "interactive CLI (acceptance.cli.interactive): not run");
      return o.save(o.notExecuted(`interactive CLIs are not supported (${interactive.map((r) => r.name).join(", ")} declares acceptance.cli.interactive)`));
    }
    let dirs: AcceptanceRunDirs | null = null;
    let fresh: string | null = null;
    let readDir: string | null = null;
    let runId: number | null = null;
    let interrupted = false;
    const pgids: number[] = [];
    const controller = new AbortController();
    const sweep = () => {
      for (const r of [dirs?.runRoot, fresh]) if (r) killLeftovers(r, pgids);
    };
    const watcher = setInterval(() => {
      if (reviewing(key)) return;
      controller.abort();
      try {
        sweep();
      } catch {
        // best effort
      }
    }, WATCH_MS);
    const display = (r: { rules: CliAcceptanceRules | LibraryAcceptanceRules }, c: AcceptanceCase) =>
      r.rules.entry === "cli" ? r.rules.cli.command : `node examples/${c.example ?? "?"}`;

    try {
      dirs = await prepareRunDirs({ home, repoPaths: mappedRepos(), config });
      runId = beginAcceptanceRun(db, key, { seriesId: o.seriesId, attempt, runRoot: dirs.runRoot }).id;
      const d = dirs;
      const run = runId;
      const scopeOf = (runRoot: string): SandboxScope => ({
        kind: "acceptance", home, allowInHome: null, repos: mappedRepos(), runRoot, acceptConfigDir: d.configDir,
        ...(config.development.deniedLocalPorts.length > 0 ? { extraPorts: config.development.deniedLocalPorts } : {}),
        ...o.net,
        ...ctx.remoteScope(),
      });
      const sc = scopeOf(d.runRoot);
      const track = {
        add: (p: number) => {
          processes.add(p, d.runRoot);
          pgids.push(p);
          setRunProcesses(db, run, [...pgids]);
        },
        remove: (p: number) => processes.remove(p),
      };
      const check = await ctx.sandboxCheck(sc);
      if (!check.ok) return o.save(o.notExecuted(`isolation check failed: sandbox self-check: ${check.detail}`));
      checkpoint(key);

      /** export, install / build, targets and case scaffold in one run root; a reason when it cannot be used */
      const quotes = designQuoteLines(db, key);
      const prepare = async (runRoot: string, workDir: string, acceptanceDir: string, scope: SandboxScope) => {
        const manifest = new Map<string, string>();
        const excluded: string[] = [];
        for (const c of commits) {
          const dest = join(workDir, c.repo);
          const m = await exportRepo(c.wt, c.sha, dest, runRoot);
          const gone = await excludeDesignQuotes(dest, await baseFilesOf(c.wt, c.baseBranch), quotes);
          for (const p of gone) m.delete(join(dest, p));
          excluded.push(...gone.map((p) => `${c.repo}/${p}`));
          for (const [k, v] of m) manifest.set(k, v);
        }
        checkpoint(key);
        for (const r of o.caseRepos) {
          for (const [what, cmd] of [["install", r.rules.install], ["build", r.rules.build]] as const) {
            if (cmd === undefined) continue;
            // 4F-8 (I-4): as phase 3's acceptance install — the server's PATH and HOME (targetEnv); the cases keep caseEnv
            const t = await runCommand(join(workDir, r.name), cmd, config.development.commandTimeoutMs, { kind: "sandboxed", scope: { ...scope, kind: "acceptance-install" } }, targetEnv(r.rules.env, runRoot), track);
            checkpoint(key);
            if (t.exitCode !== 0) {
              const tail = t.outputTail.trim();
              return { reason: `the build failed: ${what} of ${r.name} (${t.timedOut ? "timed out" : `exit ${t.exitCode ?? "—"}`}): ${tail.length > 1500 ? `…${tail.slice(-1500)}` : tail}` } as const;
            }
          }
        }
        // T9-4: install and build must leave the tracked files as committed
        const wrote = changedSince(manifest).map((abs) => relative(workDir, abs));
        if (wrote.length > 0) return { reason: `the install or build wrote tracked paths: ${wrote.slice(0, 20).join(", ")}${wrote.length > 20 ? "…" : ""} — tracked files must stay as committed during acceptance` } as const;
        const targets = new Map<string, CliTarget | LibTarget>();
        for (const r of o.caseRepos) {
          const snap = join(workDir, r.name);
          try {
            const t = r.rules.entry === "cli" ? cliTarget(r.name, snap, r.rules.cli.command) : libraryTarget(r.name, snap, r.rules.library.import, r.rules.library.path);
            targets.set(r.name, t);
            writeCasesScaffold(join(acceptanceDir, r.name), t.kind === "library" ? { library: t } : {});
          } catch (err) {
            if (err instanceof CaseTargetError) return { reason: `${r.name}: ${err.message}` } as const;
            throw err;
          }
        }
        return { manifest, excluded, targets } as const;
      };

      let first;
      try {
        first = await prepare(d.runRoot, d.workDir, d.acceptanceDir, sc);
      } catch (err) {
        if (err instanceof LeftReviewing) throw err;
        const msg = errMessage(err);
        return o.save(o.notExecuted(msg.startsWith("isolation check failed") ? msg : `isolation check failed: ${msg}`));
      }
      if ("reason" in first) return o.save(o.notExecuted(first.reason ?? "the run could not be prepared"));
      const cases = o.caseRepos.map((r) => ({ repo: r.name, library: r.rules.entry === "library" ? r.rules.library.import : null }));
      const shimConfig = (runRoot: string, acceptanceDir: string, targets: ReadonlyMap<string, CliTarget | LibTarget>): CasesShimConfig => ({
        runRoot, acceptanceDir, acIds, timeoutMs: config.acceptance.caseTimeoutMs,
        repos: o.caseRepos.map((r) => {
          const t = targets.get(r.name)!;
          const rules = { envKeys: [...r.rules.caseEnvKeys], dotfiles: [...r.rules.caseDotfiles] };
          const env = caseEnv(r.rules.env, runRoot);
          return t.kind === "cli"
            ? { repo: r.name, kind: "cli" as const, command: t.command, snapshotDir: t.snapshotDir, display: r.rules.entry === "cli" ? r.rules.cli.command : "", env, caseRules: rules }
            : { repo: r.name, kind: "library" as const, importName: t.importName, packageDir: t.packageDir, env, caseRules: rules };
        }),
      });
      let checks: string[];
      try {
        writeCasesShim(d, shimConfig(d.runRoot, d.acceptanceDir, first.targets), sc);
        checks = assertAcceptanceIsolation(d, { home, repoPaths: mappedRepos(), repoRoot, quotes, exported: first.manifest, shims: [CASES_SHIM, CASES_SHIM_CONFIG] });
      } catch (err) {
        o.setIsolation({ ok: false, checks: [], excluded: first.excluded });
        const msg = errMessage(err);
        return o.save(o.notExecuted(msg.startsWith("isolation check failed") ? msg : `isolation check failed: ${msg}`));
      }
      o.setIsolation({ ok: true, checks, excluded: first.excluded });
      appendAudit(db, { actor: "system", type: "acceptance_isolation_checked", ticketKey: key, payload: { runId: run, seriesId: o.seriesId, attempt, checks, excluded: first.excluded } });
      for (const r of o.caseRepos) o.setDetail(r.name, "built; the agent declares its cases");
      checkpoint(key);

      // the acceptance agent: its only command is slackoff-cases run
      const policy: PolicyContext = { workDir: d.workDir, denyPaths: commits.map((c) => `${c.repo}/**`), acceptCases: cases };
      const prompt = buildAcceptancePrompt(acceptanceInput(db, key, o.developerNote), {
        workDir: d.workDir, targets: [], commandLine: caseCommandLine(d.workDir), attempt, maxAttempts: config.review.maxAttempts,
        cases: o.caseRepos.map((r) => (r.rules.entry === "cli" ? { repo: r.name, entry: "cli" as const, command: r.rules.cli.command } : { repo: r.name, entry: "library" as const, import: r.rules.library.import })),
      });
      let agent: AcceptanceResult;
      try {
        agent = await ctx.run({
          role: "acceptance-review", ticketKey: key, prompt, cwd: d.workDir,
          allowedTools: [...toolPolicy("acceptance-review", policy).allowed],
          chrome: false, schema: acceptanceResultSchema(acIds), policy, timeoutMs: config.acceptance.runTimeoutMs,
          isolation: { claudeConfigDir: d.configDir, shimDir: d.shimDir, sandbox: sc },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new LeftReviewing();
        if (err instanceof SandboxPolicyError && err.message.startsWith("isolation check failed")) return o.save(o.notExecuted(err.message));
        throw err;
      }
      checkpoint(key);
      // 4F-5 (M4): nothing of the agent's phase outlives it before the fresh run root exists
      killLeftovers(d.runRoot, pgids);
      deps.testHooks?.beforeRerun?.({ runRoot: d.runRoot });

      // 4F-1: the platform's own re-run, in a fresh run root next to R1 (R1's sandbox cannot write it)
      fresh = mkdtempSync(`${d.runRoot}-rerun-`);
      const f: AcceptanceRunDirs = { runRoot: fresh, workDir: join(fresh, "work"), acceptanceDir: join(fresh, "work", "acceptance"), shimDir: join(fresh, "bin"), configDir: d.configDir };
      for (const x of [f.acceptanceDir, f.shimDir, join(fresh, "tmp")]) mkdirSync(x, { recursive: true, mode: 0o700 });
      // 4F-7 (I-1): nothing of the re-run reads the agent's old run root (only the checked copies reach it)
      const sc2: SandboxScope = { ...scopeOf(fresh), oldRunRoot: d.runRoot };
      let second;
      try {
        second = await prepare(fresh, f.workDir, f.acceptanceDir, sc2);
        if (!("reason" in second)) {
          for (const r of o.caseRepos) {
            await copyCaseInputs({ from: join(d.acceptanceDir, r.name), to: join(f.acceptanceDir, r.name), oldRunRoot: d.runRoot, oldSandbox: sc });
          }
        }
      } catch (err) {
        if (err instanceof LeftReviewing) throw err;
        return o.save(o.notExecuted(`the platform's re-run could not be prepared: ${errMessage(err)}`));
      }
      if ("reason" in second) return o.save(o.notExecuted(`the platform's re-run could not be prepared: ${second.reason ?? ""}`));
      checkpoint(key);

      const runTimeout = AbortSignal.timeout(config.acceptance.runTimeoutMs);
      const signal = AbortSignal.any([controller.signal, runTimeout]);
      const results = new Map<string, CaseResult>();
      const declaredCases = new Map<string, { c: AcceptanceCase; repo: (typeof o.caseRepos)[number] }>();
      const problems: string[] = [];
      const sources: Record<string, string> = {};
      const examples = new Map<string, { name: string; source: string }>();
      for (const r of o.caseRepos) {
        const acc = join(f.acceptanceDir, r.name);
        const loaded = loadCases(acc, acIds, { envKeys: r.rules.caseEnvKeys, dotfiles: r.rules.caseDotfiles });
        problems.push(...loaded.problems.map((p) => `${r.name}: ${p}`));
        const mine = loaded.cases.filter((c) => {
          if (!declaredCases.has(c.name)) return true;
          problems.push(`${r.name}: the case name ${c.name} is used in another repository too`);
          return false;
        });
        for (const c of mine) {
          declaredCases.set(c.name, { c, repo: r });
          sources[`${r.name}/cases/${c.name}.case.json`] = JSON.stringify(c, null, 2);
          if (c.example !== undefined) {
            const text = readTextNoFollow(join(acc, "examples", c.example), 512 * 1024);
            if (text !== null) {
              sources[`${r.name}/examples/${c.example}`] = text;
              examples.set(c.name, { name: c.example, source: text });
            }
          }
        }
        if (mine.length === 0) continue;
        let rs: CaseResult[];
        try {
          rs = await runCases({
            cases: mine, target: second.targets.get(r.name)!, runRoot: fresh, acceptanceDir: acc, sandbox: sc2, env: caseEnv(r.rules.env, fresh),
            timeoutMs: config.acceptance.caseTimeoutMs, signal, onSpawn: track.add, caseRules: { envKeys: r.rules.caseEnvKeys, dotfiles: r.rules.caseDotfiles },
            manifest: second.manifest,
          });
        } catch (err) {
          if (controller.signal.aborted) throw new LeftReviewing();
          if (err instanceof CaseTargetError) return o.save(o.notExecuted(err.message));
          throw err;
        }
        for (const x of rs) results.set(x.name, x);
        o.setDetail(r.name, `${rs.filter((x) => x.passed).length} of ${rs.length} case(s) passed in the platform's run`);
        checkpoint(key);
      }
      if (controller.signal.aborted) throw new LeftReviewing();
      // 4F-8 (m-4): the whole re-run hit acceptance.runTimeoutMs — no verdict on the app (only a case's own timeout fails it)
      if (runTimeout.aborted) return o.save(o.notExecuted("acceptance run timed out"));

      // 4F-8 (I-5): no valid case at all — nothing of the app was tested: not executed, never a fix round with nothing in it
      if (results.size === 0) {
        const firstProblem = problems[0] ?? "no case was declared";
        return o.save(redactDeep(o.notExecuted(`no valid acceptance cases: ${firstProblem}`), (t) => redactStored(home, t)));
      }

      // 4F-8 (I-3): the project's own test command, as phase 3 runs it — in the re-run's snapshot, sandboxed, the app
      // environment (targetEnv); extra evidence only, it never decides an AC
      const projectE2e: TestRun[] = [];
      for (const r of o.caseRepos) {
        if (!r.rules.testCommand) continue;
        projectE2e.push(await runCommand(join(f.workDir, r.name), r.rules.testCommand, config.development.commandTimeoutMs, { kind: "sandboxed", scope: sc2 }, targetEnv(r.rules.env, fresh), track));
        checkpoint(key);
      }
      sweep();
      checkpoint(key);

      // the transcripts, from the in-memory results, outside both run roots (4F-3); copied like any evidence (T8-2 / T9-3)
      readDir = mkdtempSync(`${d.runRoot}-read-`);
      const transcripts = new Map<string, string>();
      let i = 0;
      for (const [name, r] of results) {
        const dc = declaredCases.get(name)!;
        const file = join(readDir, `${++i}.txt`);
        // 4F-7 (m-8): every known secret value redacted before anything is stored (fails closed to the remembered values)
        writeFileSync(file, redactStored(home, caseTranscript(dc.c, r, display(dc.repo, dc.c), examples.get(name))), { flag: "wx", mode: 0o600 });
        transcripts.set(name, file);
        // 4F-8 (I-1): the platform's own run of the case, for the fix note
        sources[`${dc.repo.name}/runs/${name}.txt`] = caseRunSummary(dc.c, r, display(dc.repo, dc.c));
      }
      const ev = evaluateCases(agent, results, acs, (name) => transcripts.get(name) ?? null);
      let evaluated = ev.acs;
      const reviewRel = `${key}/${o.seriesId}-${attempt}`;
      const reviewDir = reviewDirOf(key, o.seriesId, attempt);
      rmSync(reviewDir, { recursive: true, force: true });
      mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
      const copied = copyEvidence(ev.evidence, { roots: [realpathSync(readDir)], destDir: reviewDir, relBase: reviewRel });
      evaluated = applyDropped(evaluated, copied);
      // 4F-8 (n-3): what the fix note quotes is redacted before it is stored
      writeFileSync(join(reviewDir, "specs.json"), JSON.stringify(redactDeep(sources, (t) => redactStored(home, t))), { mode: 0o600 });
      const all = [...results.values()];
      const outputTail = [
        ...problems.map((p) => `PROBLEM ${p}`),
        ...all.map((x) => `${x.passed ? "PASS" : "FAIL"} ${x.name}${x.failures.length > 0 ? `: ${x.failures.slice(0, 3).join("; ")}` : ""}`),
      ].join("\n");
      const report: AcceptanceReport = {
        verdict: overallVerdict(evaluated),
        notExecutedReason: null,
        summary: agent.summary,
        targets: o.targets(),
        acs: evaluated,
        specRun: { command: "slackoff-cases run (the platform's own re-run)", exitCode: all.length > 0 && all.every((x) => x.passed) && problems.length === 0 ? 0 : 1, timedOut: all.some((x) => x.timedOut), outputTail: outputTail.slice(-8000) },
        projectE2e,
        isolation: { ok: true, checks, excluded: first.excluded },
        commits: commits.map(({ repo, sha }) => ({ repo, sha })),
      };
      // 4F-7 (m-8): the case output quoted in the report (outputTail, failures in mismatches) redacted too
      return o.save(redactDeep(report, (t) => redactStored(home, t)), copied.kept);
    } catch (err) {
      interrupted = true;
      throw err;
    } finally {
      clearInterval(watcher);
      try {
        sweep();
      } catch {
        // best effort
      }
      if (readDir !== null) rmSync(readDir, { recursive: true, force: true });
      if (fresh !== null) rmSync(fresh, { recursive: true, force: true });
      if (dirs !== null) {
        try {
          await cleanupRunDirs(dirs);
        } catch (err) {
          logError(`${key}: could not remove the acceptance run root ${dirs.runRoot}: ${errMessage(err)}`);
        }
      }
      if (runId !== null) {
        try {
          endAcceptanceRun(db, runId, interrupted ? "interrupted" : "finished");
        } catch {
          // already ended (recovery) or the database is closing (shutdown)
        }
      }
    }
  };

  /** Each affected repo's worktree: clean, at its HEAD; any problem names the repo (→ blocked). */
  const headsOf = async (key: string, repos: RepoContext[]) => {
    const stored = listRepoWorkspaces(db, key);
    const out: Array<{ repo: string; sha: string; wt: string; baseBranch: string }> = [];
    for (const r of repos) {
      const w = stored.find((x) => x.repo === r.name);
      if (!w) throw new Error(`${r.name}: no worktree for ${key} — development has not run in this repository`);
      let dirty: string[];
      try {
        dirty = await changedPaths(w.worktreePath);
      } catch (err) {
        throw new Error(`${r.name}: cannot read the worktree: ${errMessage(err)}`);
      }
      if (dirty.length > 0) {
        throw new Error(`${r.name}: the worktree has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? "…" : ""}) — commit or discard them, then Retry`);
      }
      const head = await git(w.worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const sha = head.stdout.trim();
      if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`${r.name}: cannot read the worktree's HEAD: ${head.stderr.trim()}`);
      out.push({ repo: r.name, sha, wt: w.worktreePath, baseBranch: w.baseBranch });
    }
    return out;
  };

  /** The files of the branch's base (merge-base with the base branch): the design-quote exclusion looks at added files only. */
  const baseFilesOf = async (wt: string, baseBranch: string): Promise<Set<string>> => {
    const mb = await git(wt, ["merge-base", "HEAD", `refs/heads/${baseBranch}`]);
    const base = mb.code === 0 ? mb.stdout.trim() : "";
    if (!/^[0-9a-f]{40,64}$/.test(base)) return new Set(); // unknown base: every text file is checked
    const ls = await git(wt, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", base]);
    return new Set(ls.code === 0 ? ls.stdout.split("\0").filter((p) => p !== "") : []);
  };

  const reviewDirOf = (key: string, seriesId: number, attempt: number): string => {
    if (!isTicketKey(key)) throw new Error(`invalid ticket key ${JSON.stringify(key)}`);
    return join(home, "reviews", key, `${seriesId}-${attempt}`);
  };

  /** The spec sources stored with a report (for the fix feedback); {} when there are none. */
  const readStoredSpecs = (key: string, r: ReviewReportRecord): Record<string, string> => {
    try {
      const v = JSON.parse(readTextNoFollow(join(reviewDirOf(key, r.seriesId, r.attempt), "specs.json"), 4 * 1024 * 1024) ?? "{}") as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      return {};
    }
  };

  const enqueue = (key: string) => ctx.job(`review:${key}`, key, () => runReview(key));

  const requireNote = (note: string, what: string): string => {
    const t = note.trim();
    if (t === "") throw new ValidationError(`a note is required to ${what}`);
    return t;
  };

  /** The drift check that stopped this review: the newest unacknowledged one needing an ack, before_review first. */
  const pendingDrift = (key: string): DriftRecord | null => {
    const choice = currentChoice(db, key);
    if (!choice) return null;
    const rows = db
      .prepare("SELECT id, latest_snapshot_id FROM drift_check WHERE ticket_key = ? AND requirement_id = ? AND acknowledged = 0 AND trigger IN ('before_review', 'snapshot_changed') ORDER BY id DESC")
      .all(key, choice.requirementId) as Array<{ id: number; latest_snapshot_id: number }>;
    const drifts = rows.flatMap((r) => findDrifts(db, key, choice.requirementId, r.latest_snapshot_id, ["before_review", "snapshot_changed"]).filter((d) => d.id === r.id));
    const needing = drifts.filter((d) => driftNeedsAck(d.result) && !d.acknowledged);
    return needing.find((d) => d.trigger === "before_review") ?? needing[0] ?? null;
  };

  return {
    enqueue,

    handOff(key, decidedBy) {
      ctx.requireState(ctx.mustGet(key), "dev_done");
      ctx.atomic(() => {
        ctx.move(key, "reviewing", "developer", undefined, { decidedBy });
        startSeries(db, key, "handoff", null, decidedBy);
      });
      updated(key);
      enqueue(key);
    },

    ackReview(key, note, decidedBy) {
      ctx.requireState(ctx.mustGet(key), "awaiting_review_ack");
      const text = requireNote(note, "acknowledge the drift");
      const drift = pendingDrift(key);
      if (!drift) throw new InvalidTransitionError(`${key}: no drift check to acknowledge`);
      const s = stepInput(key);
      const occasion = recheckOccasion(key, s);
      ctx.atomic(() => {
        acknowledgeDrift(db, drift.id, text, decidedBy);
        // R7: the re-read is done for this occasion: the job continues with this snapshot, never stops here again
        if (occasion) markChecked(key, occasion, drift.latestSnapshotId);
        ctx.move(key, "reviewing", "developer", undefined, { decidedBy });
      });
      enqueue(key);
    },

    rejectReview(key, note, decidedBy) {
      ctx.requireState(ctx.mustGet(key), "awaiting_confirmation");
      const text = requireNote(note, "reject the acceptance result");
      const s = stepInput(key);
      const last = s.reports.at(-1);
      if (!last) throw new InvalidTransitionError(`${key}: no acceptance report to reject`);
      ctx.atomic(() => {
        recordDecision(db, key, last.id, "rejected", text, decidedBy);
        startSeries(db, key, "rejected", text, decidedBy);
        startIteration(db, key, "rejected", text, decidedBy);
        ctx.move(key, "developing", "developer", undefined, { decidedBy });
      });
      updated(key);
      ctx.enqueueDevelop(key);
    },

    reReview(key, note, decidedBy) {
      ctx.requireState(ctx.mustGet(key), "awaiting_confirmation");
      const text = requireNote(note, "ask for another review");
      const s = stepInput(key);
      const last = s.reports.at(-1);
      if (!last) throw new InvalidTransitionError(`${key}: no acceptance report to review again`);
      const n = s.reports.length;
      const max = config.review.maxAttempts;
      if (n >= max) throw new ValidationError(`Acceptance ran ${n} of ${max} times in this round — reject with comments instead`);
      ctx.atomic(() => {
        recordDecision(db, key, last.id, "re_review", text, decidedBy);
        ctx.move(key, "reviewing", "developer", undefined, { decidedBy });
      });
      updated(key);
      enqueue(key);
    },

    retry(key, decidedBy) {
      const t = ctx.mustGet(key);
      ctx.requireState(t, "blocked");
      const s = currentSeries(db, key) ? stepInput(key) : null;
      const last = s?.reports.at(-1);
      // the block was the attempt cap (derived from stored data): a new round, which fixes the carried failure first
      const cap = s !== null && last?.verdict === "failed" && s.reports.length >= config.review.maxAttempts;
      ctx.atomic(() => {
        ctx.move(key, "reviewing", "developer", undefined, { decidedBy });
        if (cap) startSeries(db, key, "retry", null, decidedBy);
      });
      if (cap) updated(key);
      enqueue(key);
    },

    recoverRuns() {
      for (const r of openAcceptanceRuns(db)) {
        try {
          killLeftovers(r.runRoot, r.pgids);
          const name = basename(r.runRoot);
          // the agent's Bash groups, recorded by its wrapper in SLACKOFF_HOME (T7-6)
          if (RUN_ROOT_NAME.test(name)) {
            const wrapperDir = join(home, "sandbox", "acceptance", name);
            killRecordedGroups(r.runRoot, join(wrapperDir, "pgids"));
            rmSync(wrapperDir, { recursive: true, force: true });
          }
          // only a run root the platform made: <a temp base>/slackoff-accept-XXXXXX
          const bases = new Set([acceptRunBase(), realOr(tmpdir()), realOr("/tmp")]);
          if (RUN_ROOT_NAME.test(name) && bases.has(dirname(r.runRoot))) {
            rmSync(r.runRoot, { recursive: true, force: true });
            // T9-3: its read dir(s), `<runRoot>-read-XXXXXX`; phase 4f: the fresh run root(s) of the case re-run, `<runRoot>-rerun-XXXXXX`
            for (const n of readdirSync(dirname(r.runRoot))) {
              if (n.startsWith(`${name}-read-`) && /^[A-Za-z0-9]{6}$/.test(n.slice(name.length + 6))) rmSync(join(dirname(r.runRoot), n), { recursive: true, force: true });
              if (n.startsWith(`${name}-rerun-`) && /^[A-Za-z0-9]{6}$/.test(n.slice(name.length + 7))) {
                killLeftovers(join(dirname(r.runRoot), n), r.pgids);
                rmSync(join(dirname(r.runRoot), n), { recursive: true, force: true });
              }
            }
          } else logError(`Recovery: not removing ${JSON.stringify(r.runRoot)}: not an acceptance run root`);
        } catch (err) {
          logError(`Recovery: could not stop acceptance run ${r.id} of ${r.ticketKey}: ${errMessage(err)}`);
        }
        try {
          endAcceptanceRun(db, r.id, "interrupted");
        } catch (err) {
          logError(`Recovery: could not close acceptance run ${r.id}: ${errMessage(err)}`);
        }
      }
      // the dedicated config dir's session folders (the run's transcripts) go too
      try {
        for (const n of ["projects", "sessions", "todos", "shell-snapshots", "session-env", "file-history", "debug", "backups"]) {
          rmSync(join(config.acceptance.claudeConfigDir, n), { recursive: true, force: true });
        }
      } catch {
        // nothing to purge
      }
    },
  };
}

const realOr = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

// ---------------------------------------------------------------- reading files the sandbox could write

/** A regular file read through an O_NOFOLLOW fd (never a symlink), at most `max` bytes; null when it is not one or too big. */
function readFileNoFollow(path: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}
const readTextNoFollow = (path: string, max: number): string | null => readFileNoFollow(path, max)?.toString("utf8") ?? null;

/** The agent's spec sources (`specs/<path>` → text): regular .mjs files only, each ≤64 KB, at most 50. */
function readSpecs(acceptanceDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const root = join(acceptanceDir, "specs");
  const walk = (rel: string) => {
    let names: string[];
    try {
      if (!lstatSync(join(root, rel)).isDirectory()) return;
      names = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (Object.keys(out).length >= MAX_SPEC_FILES) return;
      const r = rel === "" ? n : `${rel}/${n}`;
      let st;
      try {
        st = lstatSync(join(root, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(r);
      else if (st.isFile() && n.endsWith(".mjs")) {
        const text = readTextNoFollow(join(root, r), MAX_SPEC_FILE);
        if (text !== null) out[`specs/${r}`] = text;
      }
    }
  };
  walk("");
  return out;
}


// ---------------------------------------------------------------- results.json against the run's own output (T9-3)

/**
 * Playwright's summary at the end of the re-run's output (`  2 passed (1.2s)`, `  1 failed`, …; the last block after
 * the last "Running N tests" line), or null when there is none.
 */
export function runSummary(output: string): { passed: number; total: number } | null {
  const lines = output.split("\n");
  let start = 0;
  lines.forEach((l, i) => {
    if (/^Running \d+ tests? using/.test(l.trim())) start = i;
  });
  const counts = new Map<string, number>();
  for (const l of lines.slice(start)) {
    const m = /^\s+(\d+) (passed|failed|flaky|skipped|did not run|interrupted)\b/.exec(l);
    if (m) counts.set(m[2]!, Number(m[1]));
  }
  if (counts.size === 0) return null;
  return { passed: counts.get("passed") ?? 0, total: [...counts.values()].reduce((a, b) => a + b, 0) };
}

/** A parsed results.json agrees with the run's output: no more passing tests, and no more tests, than it reported. */
function resultsAgree(parsed: SpecRun, output: string): boolean {
  if (parsed.tests.length === 0) return true;
  const sum = runSummary(output);
  if (sum === null) return false;
  return parsed.tests.filter((t) => t.ok).length <= sum.passed && parsed.tests.length <= sum.total;
}
