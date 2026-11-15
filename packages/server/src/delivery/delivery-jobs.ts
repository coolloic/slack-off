// Task 12: confirmed delivery. One "Confirm and deliver" authorizes exactly the actions listed in the plan and the PR
// descriptions shown in the preview (bound by the plan hash, ruling R10). The job `deliver:<KEY>` runs the steps in
// order: re-read JIRA and check drift, push each repo (never forced), open or reuse each PR, cross-link them, then —
// only with status sync on — move JIRA to the review status and comment the PR links. A push / PR failure blocks the
// ticket (Retry continues from the first unfinished step); a JIRA step failure only fails that step (retryStep).
// Nothing continues by itself after a restart.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { driftNeedsAck, SNAPSHOT_NEEDS_ACK, type DeliveryPlan, type DeliveryStepRecord } from "@slackoff/shared";
import { appendAudit } from "../audit/audit-log.ts";
import { lockedRequirementDrift } from "../acceptance/review-jobs.ts";
import { listReports, recordDecision } from "../acceptance/review-repo.ts";
import { acknowledgeDrift } from "../drift/drift-repo.ts";
import { AgentInterruptedError } from "../executor/types.ts";
import type { JiraCommentFlow } from "../jira/jira-comment-jobs.ts";
import { jiraLoginError, type TicketSource } from "../jira/ticket-source.ts";
import { statusTarget, type JiraWriteFlow } from "../jira/jira-write-jobs.ts";
import { saveSnapshot } from "../snapshots/snapshot-store.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../tickets/errors.ts";
import { getHooksPin, getTicket, listRepoWorkspaces, setJiraStatus } from "../tickets/ticket-repo.ts";
import { hooksFingerprint } from "../git/worktree.ts";
import { prepareHookWrappers } from "../sandbox/hook-wrappers.ts";
import { localNetworkFor, SandboxUnavailableError } from "../sandbox/local-sandbox.ts";
import type { WorkflowCtx } from "../workflow/jobs.ts";
import { buildDeliveryPlan, deliveryRepos, prActionText, pushActionText, repoId } from "./delivery-plan.ts";
import { createDelivery, deliveryPlan, finishStep, listDeliveries, markStep, skipPendingSteps, startStep } from "./delivery-repo.ts";
import type { GhClient } from "./gh.ts";
import { AzClient, fitAzureDescription } from "./az.ts";
import { isAzureId, prIdFromUrl, type PrClient } from "./pr-client.ts";
import { DeliveryError, pushBranch, remoteInfo } from "./git-push.ts";
import { deliveryCommentText, withLinks } from "./pr-body.ts";
import { describeError, logError } from "../log.ts";

export interface DeliveryJobs {
  /** The plan for the confirmation dialog, plus the review status note (statusTarget's). Read only. */
  preview(key: string): Promise<DeliveryPlan & { jiraNote: string | null; needsAck: boolean }>;
  /**
   * Recompute the plan: blockers → ValidationError; another hash → InvalidTransitionError (409, "review it again").
   * Then, in one transaction: decision confirmed, the delivery and its steps (ackNote stored and audited), and
   * awaiting_confirmation → delivering; `deliver:<KEY>` is enqueued.
   */
  confirm(key: string, planHash: string, ackNote: string | null, decidedBy: string): Promise<void>;
  /** A failed jira_status / jira_comment step of a ticket in pr_opened: started again and sent (decidedBy audited). */
  retryStep(key: string, stepId: number, decidedBy: string): void;
  /** Enqueue `deliver:<KEY>` for a ticket in delivering (confirm, Retry). */
  enqueue(key: string): void;
  /** T12-1: blocked (in delivery) → awaiting_confirmation: the developer previews and confirms again. */
  previewAgain(key: string, decidedBy: string): void;
  /** M2: the ticket is being abandoned (call inside the same transaction as the move): pending steps become skipped. */
  abandon(key: string): void;
}

export interface DeliveryDeps {
  source: TicketSource;
  /** a GhClient for `delivery.ghBin`, built on every use (ruling R3) */
  gh: (bin: string) => GhClient;
  /** Azure DevOps repositories: an az repos client for `delivery.azBin` (default: AzClient) */
  az?: (bin: string) => PrClient;
  jiraWrites: JiraWriteFlow;
  comments: JiraCommentFlow;
  /** fake mode only (Task 17): a last check of the worktree's origin before anything is pushed; throws to stop the push */
  beforePush?: (wt: string, repo: string) => Promise<void>;
}

/** The blocked reason of a ticket that was delivering when Slack Off stopped (startup recovery). */
export const DELIVERY_INTERRUPTED = "delivery interrupted by restart — Retry to continue";
/** T12-1: what a push / pr step would do now is not what the developer confirmed */
export const TARGETS_CHANGED = "the pull requests (or remote) changed since you confirmed — preview again";
/** I2: a JIRA step that never started before a restart */
export const JIRA_STEP_NOT_SENT = "not sent — interrupted by restart, retry to send";
/** M2: the detail of delivery steps skipped by an abandon */
export const ABANDONED_STEP = "skipped — ticket abandoned";
/** R-L1: the detail of the pending steps of a delivery the developer previewed again */
export const SUPERSEDED_STEP = "superseded — previewed again";
/** F-1: the detail of the pending steps of a delivery sent back because JIRA changed */
export const SENT_BACK_STEP = "sent back: JIRA changed";
const ALREADY_PUSHED = " (already pushed — nothing to send)";


const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isJira = (k: DeliveryStepRecord["kind"]) => k === "jira_status" || k === "jira_comment";

/** The ticket left delivering (abandoned) while a step ran. */
class LeftDelivery extends Error {
  constructor() {
    super("the ticket is no longer being delivered");
    this.name = "LeftDelivery";
  }
}

type StepOutcome =
  | { kind: "finished"; state: "done" | "failed" | "not_needed"; detail: string; result: unknown; link?: { jiraWriteId?: number; jiraCommentId?: number }; audit?: { type: string; payload: Record<string, unknown> } }
  | { kind: "stopped" };

export function createDeliveryJobs(ctx: WorkflowCtx, deps: DeliveryDeps): DeliveryJobs {
  const { db, home, config, bus } = ctx;
  const { source } = deps;
  const updated = (key: string) => bus.emit({ type: "delivery_updated", ticketKey: key });
  const stateOf = (key: string) => getTicket(db, key)?.state;
  const gh = () => deps.gh(config.delivery.ghBin);
  const az = (): PrClient => (deps.az ? deps.az(config.delivery.azBin) : new AzClient(config.delivery.azBin));
  /** the pull request client of a repository id: Azure DevOps (az repos) or GitHub (gh) */
  const clientFor = (id: string): PrClient => (isAzureId(id) ? az() : gh());
  const build = (key: string) => buildDeliveryPlan(db, home, config, { gh: gh(), az: az() }, key);

  const latest = (key: string) => {
    const d = listDeliveries(db, key).at(-1);
    if (!d) throw new NotFoundError(`${key} has no delivery`);
    return d;
  };
  const stepNow = (key: string, stepId: number): DeliveryStepRecord => {
    const s = latest(key).steps.find((x) => x.id === stepId);
    if (!s) throw new NotFoundError(`delivery step ${stepId} not found for ${key}`);
    return s;
  };

  /** A body file under the data dir's tmp/ (gh reads it), removed right after. */
  const withBodyFile = async <T>(body: string, fn: (file: string) => Promise<T>): Promise<T> => {
    const base = join(home, "tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(base, "pr-body-"));
    try {
      const file = join(dir, "body.md");
      writeFileSync(file, body, { mode: 0o600 });
      return await fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const workspace = (key: string, repo: string) => {
    const w = listRepoWorkspaces(db, key).find((x) => x.repo === repo);
    if (!w) throw new DeliveryError(`${repo}: no worktree for ${key}`, repo);
    return w;
  };
  const githubOf = async (wt: string, repo: string) => {
    const info = await remoteInfo(wt);
    if (!info.remote) throw new DeliveryError(`${repo}: origin (${info.url}) is not a GitHub or Azure DevOps repository`, repo);
    if (info.pushUrlMismatch) throw new DeliveryError(`${repo}: ${info.pushUrlMismatch}`, repo);
    return { id: repoId(info.remote), pushTarget: info.pushTarget };
  };
  /** The PRs of a delivery's done pr steps, in plan order. */
  const openedPrs = (key: string, deliveryId: number) =>
    (listDeliveries(db, key).find((d) => d.id === deliveryId)?.steps ?? [])
      .filter((s) => s.kind === "pr" && s.state === "done" && s.repo !== null)
      .map((s) => ({ repo: s.repo!, ...(s.result as { number: number; url: string; reused: boolean }) }));

  // ---- the steps

  const runSnapshot = async (key: string, d: ReturnType<typeof latest>, reportSnapshotId: number): Promise<StepOutcome> => {
    const fetched = await source.fetchTicket(key);
    if (fetched.loginRequired) throw jiraLoginError(ctx.jiraMode());
    if (stateOf(key) !== "delivering") throw new LeftDelivery();
    const { snapshotId } = saveSnapshot(db, home, key, fetched, ctx.jiraMode());
    if (fetched.status !== null) setJiraStatus(db, key, fetched.status);
    if (snapshotId === reportSnapshotId) return { kind: "finished", state: "done", detail: "JIRA unchanged since acceptance", result: { snapshotId } };
    const r = await lockedRequirementDrift(ctx, key, snapshotId, {
      checkpoint: () => {
        if (stateOf(key) !== "delivering") throw new LeftDelivery();
      },
    });
    if (r.kind === "unchanged") {
      return { kind: "finished", state: "done", detail: "JIRA changed since acceptance, back to the version the requirements were locked on", result: { snapshotId } };
    }
    const needsAck = driftNeedsAck(r.drift.result) && !r.drift.acknowledged;
    if (!needsAck) {
      if (r.kind === "new") bus.emit({ type: "snapshot_changed", ticketKey: key, needsAck: false });
      return { kind: "finished", state: "done", detail: "JIRA changed since acceptance; the drift check needs no acknowledgement", result: { snapshotId, driftId: r.drift.id } };
    }
    // T12-2: the confirm-time note covers only a drift that existed when the developer confirmed (the one that sent the
    // previous delivery back), never one found now
    if (d.ackNote !== null && r.kind === "reused" && r.drift.id <= d.driftIdAtConfirm) {
      acknowledgeDrift(db, r.drift.id, d.ackNote, d.decidedBy);
      return { kind: "finished", state: "done", detail: `JIRA changed since acceptance; acknowledged: ${d.ackNote}`, result: { snapshotId, driftId: r.drift.id } };
    }
    return { kind: "stopped" };
  };

  /** T12-1: the confirmed action text, recomputed from what is true now, must be the same */
  const requireConfirmed = (s: DeliveryStepRecord, now: string, strip = (t: string) => t) => {
    if (strip(s.text) !== strip(now)) throw new DeliveryError(`${s.repo ?? ""}: ${TARGETS_CHANGED} (confirmed: ${s.text}; now: ${now})`, s.repo);
  };

  /**
   * Phase 4a (A-1, A-3, 4A-4): the hooks dir every push of (key, repo) passes as core.hooksPath — the platform's wrapper
   * dir for the pinned hooks (the current ones when none was stored), each run in the dev-hook sandbox of the ticket's
   * worktree; no hook: an empty dir. Sandbox unavailable: DeliveryError naming the switch (the push
   * step fails and the ticket is blocked); with development.allowUnsandboxedHooks: audited hooks_unsandboxed.
   */
  const pushHooksDir = async (key: string, repo: string, wt: string, repoPath: string, branch: string): Promise<string> => {
    const pin = getHooksPin(db, key, repo) ?? (await hooksFingerprint(wt));
    try {
      // phase 4a Task 4: in allowlist mode pre-push reaches what development's hooks reach (the repos' declared ports)
      const net = config.development.localNetwork === "allowlist"
        ? localNetworkFor("allowlist", (await ctx.repoContexts(key)).flatMap((r) => r.rules.rules.sandbox?.localPorts ?? []))
        : {};
      const gate = await prepareHookWrappers({ home, key, repo, wt, pin, config, repoPath, branch, net, check: (sc) => ctx.sandboxCheck({ ...sc, ...ctx.remoteScope() }) });
      if (gate.kind === "unsandboxed") appendAudit(db, { actor: "system", type: "hooks_unsandboxed", ticketKey: key, payload: { repo, reason: gate.reason } });
      return gate.dir;
    } catch (err) {
      if (err instanceof SandboxUnavailableError) throw new DeliveryError(`${repo}: ${err.message}`, repo);
      throw err;
    }
  };

  const runPush = async (key: string, s: DeliveryStepRecord, sha: string, reportId: number): Promise<StepOutcome> => {
    const repo = s.repo!;
    const w = workspace(key, repo);
    const { id, pushTarget } = await githubOf(w.worktreePath, repo);
    // "(already pushed …)" may differ: a first attempt may have pushed before failing
    requireConfirmed(s, pushActionText(repo, w.branch, id, sha, reportId, false), (t) => t.replace(ALREADY_PUSHED, ""));
    if (deps.beforePush) await deps.beforePush(w.worktreePath, repo);
    // 4A-10: the branch recorded with the workspace
    const hooksDir = await pushHooksDir(key, repo, w.worktreePath, w.repoPath, w.branch);
    const r = await pushBranch({
      home, repo, wt: w.worktreePath, branch: w.branch, baseBranch: w.baseBranch, localSha: sha, hookTimeoutMs: config.development.hookTimeoutMs,
      hooksDir, repoPath: w.repoPath,
    });
    return {
      kind: "finished",
      state: "done",
      detail: r.pushed ? r.detail : `already pushed — ${r.detail}`,
      result: { sha, pushed: r.pushed },
      audit: { type: "branch_pushed", payload: { repo, branch: w.branch, sha, pushed: r.pushed, pushTarget } },
    };
  };

  const sameBody = (a: string, b: string) => a.replace(/\r\n/g, "\n").trimEnd() === b.replace(/\r\n/g, "\n").trimEnd();

  const runPr = async (key: string, s: DeliveryStepRecord, plan: DeliveryPlan): Promise<StepOutcome> => {
    const repo = s.repo!;
    const w = workspace(key, repo);
    const { id } = await githubOf(w.worktreePath, repo);
    const body = plan.prBodies.find((b) => b.repo === repo);
    if (!body) throw new DeliveryError(`${repo}: the confirmed plan has no pull request description for this repository`, repo);
    const client = clientFor(id);
    const found = await client.findOpenPr(id, w.branch, w.baseBranch);
    if (found.kind === "conflict") throw new DeliveryError(`${repo}: ${found.detail}`, repo);
    const attempted = (s.result as { createAttempted?: boolean } | null)?.createAttempted === true;
    let pr: { number: number; url: string; reused: boolean; adopted?: true };
    // Azure DevOps stores the description fitted to 4000 characters: compare with what was sent
    const sent = isAzureId(id) ? fitAzureDescription(body.body) : body.body;
    if (found.kind === "reusable" && attempted && sameBody(await client.getPrBody(id, found.number), sent)) {
      // T12-1: our own create went through but did not report back (interrupted / timed out): it is ours
      pr = { number: found.number, url: found.url, reused: false, adopted: true };
    } else {
      requireConfirmed(s, prActionText(found.kind === "reusable" ? found.number : null, id, w.branch, w.baseBranch, body.title));
      if (found.kind === "reusable") pr = { number: found.number, url: found.url, reused: true };
      else {
        // written before the call: a retry can tell a PR this create made from someone else's
        markStep(db, s.id, { createAttempted: true });
        const made = await withBodyFile(body.body, (bodyFile) => client.createPr({ repo: id, base: w.baseBranch, head: w.branch, title: body.title, bodyFile }));
        pr = { ...made, reused: false };
      }
    }
    return {
      kind: "finished",
      state: "done",
      detail: pr.reused ? `reused the open pull request #${pr.number}: ${pr.url}` : `${pr.adopted ? "adopted" : "opened"} pull request #${pr.number}: ${pr.url}`,
      result: pr,
      audit: { type: "pr_opened", payload: { repo, number: pr.number, url: pr.url, reused: pr.reused, ...(pr.adopted ? { adopted: true } : {}) } },
    };
  };

  const runLinks = async (key: string, deliveryId: number): Promise<StepOutcome> => {
    const prs = openedPrs(key, deliveryId);
    let edited = 0;
    for (const pr of prs) {
      // R-I1: the repository is the one the confirmed step opened the PR in (its URL), never re-derived from origin
      const parsed = prIdFromUrl(pr.url);
      if (!parsed || parsed.number !== pr.number) throw new DeliveryError(`${pr.repo}: the recorded pull request URL ${pr.url} is not readable`, pr.repo);
      const id = parsed.id;
      const client = clientFor(id);
      const w = workspace(key, pr.repo);
      const now = (await githubOf(w.worktreePath, pr.repo)).id;
      if (now.toLowerCase() !== id.toLowerCase()) throw new DeliveryError(`${pr.repo}: ${TARGETS_CHANGED} (the pull request is in ${id}; origin is now ${now})`, pr.repo);
      const body = await client.getPrBody(id, pr.number);
      const next = withLinks(body, prs.filter((o) => o.repo !== pr.repo).map((o) => ({ repo: o.repo, url: o.url })));
      if (next === body) continue;
      await withBodyFile(next, (file) => client.editPrBody(id, pr.number, file));
      edited++;
    }
    return { kind: "finished", state: "done", detail: `linked ${prs.length} pull requests (${edited} descriptions edited)`, result: { edited } };
  };

  const runJira = async (key: string, s: DeliveryStepRecord, decidedBy: string): Promise<StepOutcome> => {
    if (s.kind === "jira_status") {
      const { status } = statusTarget(await deliveryRepos(db, config, key), config, "readyForReview");
      if (!s.text.includes(`"${status}"`)) {
        return { kind: "finished", state: "failed", detail: `the review status is now "${status}", not the confirmed one — deliver again to change it`, result: null };
      }
      const w = await deps.jiraWrites.sendConfirmed(key, status, decidedBy);
      const state = w.state === "done" || w.state === "not_needed" ? w.state : "failed";
      return { kind: "finished", state, detail: w.detail ?? w.state, result: { jiraWriteId: w.id, state: w.state }, link: { jiraWriteId: w.id } };
    }
    const d = latest(key);
    const text = deliveryCommentText(openedPrs(key, d.id).map((p) => ({ repo: p.repo, url: p.url })));
    const c = await deps.comments.sendDelivery(key, text, decidedBy);
    const state = c.state === "done" || c.state === "not_needed" ? c.state : "failed";
    return { kind: "finished", state, detail: c.detail ?? c.state, result: { jiraCommentId: c.id, state: c.state }, link: { jiraCommentId: c.id } };
  };

  const record = (key: string, stepId: number, o: Extract<StepOutcome, { kind: "finished" }>, after?: () => void) => {
    ctx.atomic(() => {
      finishStep(db, stepId, o.state, o.detail, o.result, o.link);
      if (o.audit) appendAudit(db, { actor: "system", type: o.audit.type, ticketKey: key, payload: o.audit.payload });
      after?.();
    });
    updated(key);
  };

  /** A JIRA step that was started (running): send it and record the outcome; never throws, never moves the ticket. */
  const sendJiraStep = async (key: string, s: DeliveryStepRecord, decidedBy: string): Promise<void> => {
    let o: StepOutcome;
    try {
      o = await runJira(key, s, decidedBy);
    } catch (err) {
      // shutdown: left running; startup recovery fails it (never re-sent automatically)
      if (err instanceof AgentInterruptedError) return;
      o = { kind: "finished", state: "failed", detail: errMessage(err), result: null };
    }
    if (o.kind === "finished") record(key, s.id, o);
  };

  // ---- the job

  const runDeliver = async (key: string): Promise<void> => {
    if (stateOf(key) !== "delivering") return;
    const d = latest(key);
    const plan = deliveryPlan(db, d.id);
    const report = listReports(db, key).find((r) => r.id === d.reportId);
    if (!report) throw new Error(`${key}: the confirmed acceptance report ${d.reportId} is missing`);
    const gitSteps = d.steps.filter((s) => !isJira(s.kind));
    const lastSeq = gitSteps.at(-1)?.seq ?? 0;

    for (const s0 of gitSteps) {
      const s = stepNow(key, s0.id);
      if (s.state === "done" || s.state === "not_needed") continue;
      if (stateOf(key) !== "delivering") return;
      startStep(db, s.id);
      updated(key);
      let o: StepOutcome;
      try {
        if (s.kind === "snapshot") o = await runSnapshot(key, d, report.snapshotId);
        else if (s.kind === "push") {
          const sha = report.report.commits.find((c) => c.repo === s.repo)?.sha;
          if (!sha) throw new DeliveryError(`${s.repo}: the acceptance report recorded no commit for this repository`, s.repo);
          o = await runPush(key, s, sha, d.reportId);
        } else if (s.kind === "pr") o = await runPr(key, s, plan);
        else o = await runLinks(key, d.id);
      } catch (err) {
        if (err instanceof AgentInterruptedError) return;
        const left = err instanceof LeftDelivery;
        const message = left ? "the ticket left delivery: nothing more is sent" : errMessage(err);
        record(key, s.id, { kind: "finished", state: "failed", detail: message, result: undefined }, () => {
          if (!left && stateOf(key) === "delivering") ctx.move(key, "blocked", "system", `${s.text}: ${message}`);
        });
        return;
      }
      if (o.kind === "stopped") {
        record(key, s.id, { kind: "finished", state: "failed", detail: SNAPSHOT_NEEDS_ACK, result: null }, () => {
          ctx.move(key, "awaiting_confirmation", "system", SNAPSHOT_NEEDS_ACK);
          // F-1: this delivery is over; a new confirmation makes a new one
          skipPendingSteps(db, key, SENT_BACK_STEP);
        });
        bus.emit({ type: "snapshot_changed", ticketKey: key, needsAck: true });
        return;
      }
      const finished = o;
      record(key, s.id, finished, () => {
        if (s.seq === lastSeq && stateOf(key) === "delivering") ctx.move(key, "pr_opened", "system");
      });
    }
    // every PR step was already done (e.g. a crash right after the last one): the PRs are open
    if (stateOf(key) === "delivering") {
      ctx.atomic(() => ctx.move(key, "pr_opened", "system"));
      updated(key);
    }

    for (const s0 of d.steps.filter((s) => isJira(s.kind))) {
      if (stateOf(key) !== "pr_opened") return;
      const s = stepNow(key, s0.id);
      // a failed JIRA step waits for the developer's retryStep
      if (s.state !== "pending") continue;
      startStep(db, s.id);
      updated(key);
      await sendJiraStep(key, s, d.decidedBy);
    }
  };

  /** tickets whose `deliver:<KEY>` job is running (M1: no retryStep meanwhile) */
  const active = new Set<string>();
  const enqueue = (key: string) =>
    ctx.job(`deliver:${key}`, key, async () => {
      active.add(key);
      try {
        await runDeliver(key);
      } finally {
        active.delete(key);
      }
    });

  return {
    enqueue,

    async preview(key) {
      ctx.mustGet(key);
      const plan = await build(key);
      let jiraNote: string | null = null;
      try {
        jiraNote = statusTarget(await deliveryRepos(db, config, key), config, "readyForReview").note;
      } catch {
        // the repos cannot be read: the plan's blockers already say why
      }
      // the latest delivery sent the ticket back because JIRA changed: confirming again needs a note
      const latest = listDeliveries(db, key).at(-1);
      const needsAck = ctx.mustGet(key).state === "awaiting_confirmation" && latest?.reportId === listReports(db, key).at(-1)?.id && (latest?.steps.some((st) => st.kind === "snapshot" && st.state === "failed" && st.detail === SNAPSHOT_NEEDS_ACK) ?? false);
      return { ...plan, jiraNote, needsAck };
    },

    async confirm(key, planHash, ackNote, decidedBy) {
      ctx.requireState(ctx.mustGet(key), "awaiting_confirmation");
      const plan = await build(key);
      if (plan.blockers.length > 0) throw new ValidationError(`Delivery is blocked: ${plan.blockers.join("; ")}`);
      if (plan.hash !== planHash) throw new InvalidTransitionError("The delivery plan changed — review it again");
      const note = ackNote === null || ackNote.trim() === "" ? null : ackNote.trim();
      const report = listReports(db, key).at(-1)!;
      ctx.atomic(() => {
        // another confirmation may have won the race while the plan was being built
        ctx.requireState(ctx.mustGet(key), "awaiting_confirmation");
        recordDecision(db, key, report.id, "confirmed", note, decidedBy);
        createDelivery(db, key, { reportId: report.id, plan, ackNote: note, decidedBy });
        ctx.move(key, "delivering", "developer", undefined, { decidedBy });
      });
      updated(key);
      bus.emit({ type: "review_updated", ticketKey: key });
      enqueue(key);
    },

    previewAgain(key, decidedBy) {
      const t = ctx.mustGet(key);
      ctx.requireState(t, "blocked");
      if (t.prevState !== "delivering") throw new InvalidTransitionError(`${key} was not blocked in delivery: use Retry`);
      ctx.atomic(() => {
        ctx.move(key, "awaiting_confirmation", "developer", undefined, { decidedBy });
        // R-L1: the blocked delivery is over; a new confirmation makes a new one
        skipPendingSteps(db, key, SUPERSEDED_STEP);
      });
      updated(key);
    },

    abandon(key) {
      if (skipPendingSteps(db, key, ABANDONED_STEP) > 0) updated(key);
    },

    retryStep(key, stepId, decidedBy) {
      const t = ctx.mustGet(key);
      const s = stepNow(key, stepId);
      if (!isJira(s.kind)) throw new InvalidTransitionError(`delivery step ${stepId} is a ${s.kind} step: only a JIRA step is retried on its own — use Retry on the blocked ticket`);
      if (s.state !== "failed") throw new InvalidTransitionError(`delivery step ${stepId} is ${s.state}; only a failed step can be retried`);
      ctx.requireState(t, "pr_opened");
      // M1: one thing at a time — never next to the delivery job or another step being sent
      if (active.has(key) || latest(key).steps.some((x) => x.state === "running")) {
        throw new InvalidTransitionError(`a step of ${key}'s delivery is running — wait for it to finish, then retry`);
      }
      startStep(db, stepId);
      updated(key);
      ctx.queue.enqueue(`deliver-step:${stepId}`, async () => {
        try {
          await sendJiraStep(key, stepNow(key, stepId), decidedBy);
        } catch (err) {
          // recording the outcome itself failed (e.g. the DB is closing): log, never touch the ticket
          logError(`deliver-step:${stepId} (${key}) could not be recorded: ${describeError(err)}`);
        }
      });
    },
  };
}
