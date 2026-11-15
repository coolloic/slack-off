// Task 10: before development, re-read the JIRA ticket. A changed snapshot runs the drift check (trigger
// snapshot_changed); per spec §9.9 it only warns: the developer must acknowledge only when the drift check needs it
// (no source / contradiction, P-C5), otherwise development starts and the UI is notified.
import { DriftResult, driftNeedsAck } from "@slackoff/shared";
import { buildDriftPrompt } from "../drift/drift-prompt.ts";
import { acknowledgeDrift, findDrifts, latestDrift, saveDrift } from "../drift/drift-repo.ts";
import { jiraLoginError, type TicketSource } from "../jira/ticket-source.ts";
import { currentChoice, firstRequirement, getRequirement } from "../requirements/requirement-repo.ts";
import { baselineSnapshot, saveSnapshot } from "../snapshots/snapshot-store.ts";
import { InvalidTransitionError, ValidationError } from "../tickets/errors.ts";
import { getTicket, setJiraStatus } from "../tickets/ticket-repo.ts";
import type { WorkflowCtx } from "../workflow/jobs.ts";

export interface PrecheckJobs {
  /** The afterDesignFinal step: design_final → checking_snapshot, then enqueue `precheck:<KEY>`. Other states: no-op. */
  start(key: string): void;
  /** Enqueue `precheck:<KEY>` for a ticket in checking_snapshot (recovery / retry). */
  enqueue(key: string): void;
  /** awaiting_snapshot_ack → developing (note required, R13), then the development job (P-C21). decidedBy is audited. */
  ackSnapshot(key: string, note: string, decidedBy: string): void;
}

const CHANGED_REASON = "The JIRA ticket changed since the requirements were confirmed — review the drift";

export function createPrecheckJobs(ctx: WorkflowCtx, source: TicketSource): PrecheckJobs {
  const { db, home, bus } = ctx;

  const checking = (key: string) => getTicket(db, key)?.state === "checking_snapshot";

  const runPrecheck = async (key: string): Promise<void> => {
    if (!checking(key)) return;
    const fetched = await source.fetchTicket(key);
    if (fetched.loginRequired) throw jiraLoginError(ctx.jiraMode());
    if (!checking(key)) return; // abandoned while the browser read the ticket
    const { snapshotId } = saveSnapshot(db, home, key, fetched, ctx.jiraMode());
    // P-C21: whether or not the content changed; a change is audited ticket_refreshed. Never guessed: null leaves it.
    if (fetched.status !== null) setJiraStatus(db, key, fetched.status);

    const choice = currentChoice(db, key);
    if (!choice) throw new InvalidTransitionError(`${key}: no solution has been chosen`);
    const current = getRequirement(db, choice.requirementId);
    if (!current) throw new Error(`${key}: the chosen requirement ${choice.requirementId} is missing`);

    // Unchanged = the ticket still reads as the snapshot the chosen requirement was written from. Comparing with that
    // snapshot (not only saveSnapshot's `created`) keeps a change whose check failed from passing unchecked on retry.
    if (snapshotId === current.snapshotId) {
      ctx.move(key, "developing", "system");
      ctx.enqueueDevelop(key);
      return;
    }
    // Reuse an earlier check of this requirement against this very snapshot: a snapshot_changed one (its ack state
    // decides), or an ac_edited one the developer already acknowledged or that needed no ack — never asked twice.
    const done = findDrifts(db, key, current.id, snapshotId, ["snapshot_changed", "ac_edited"]).find(
      (d) => d.trigger === "snapshot_changed" || d.acknowledged || !driftNeedsAck(d.result),
    );
    if (done) {
      const needsAck = driftNeedsAck(done.result) && !done.acknowledged;
      ctx.move(key, needsAck ? "awaiting_snapshot_ack" : "developing", "system", needsAck ? CHANGED_REASON : undefined);
      if (!needsAck) ctx.enqueueDevelop(key);
      return;
    }

    const baseline = firstRequirement(db, key);
    const baselineSnapshotId = baselineSnapshot(db, key);
    if (!baseline || baselineSnapshotId === undefined) throw new Error(`${key}: drift check needs a requirement and a snapshot`);
    const prompt = buildDriftPrompt(db, key, { baseline, current, baselineSnapshotId, latestSnapshotId: snapshotId });
    const t = ctx.mustGet(key);
    const result = await ctx.run({ role: "refine-ticket", ticketKey: key, prompt, cwd: ctx.cwdFor(t), allowedTools: [], chrome: false, schema: DriftResult });
    if (!checking(key)) return;
    const needsAck = driftNeedsAck(result);
    ctx.atomic(() => {
      saveDrift(db, key, current.id, baselineSnapshotId, snapshotId, "snapshot_changed", result);
      ctx.move(key, needsAck ? "awaiting_snapshot_ack" : "developing", "system", needsAck ? CHANGED_REASON : undefined);
    });
    bus.emit({ type: "snapshot_changed", ticketKey: key, needsAck });
    if (!needsAck) ctx.enqueueDevelop(key);
  };

  const enqueue = (key: string) => ctx.job(`precheck:${key}`, key, () => runPrecheck(key));

  return {
    start(key) {
      const t = getTicket(db, key);
      if (t?.state === "design_final") ctx.move(key, "checking_snapshot", "system");
      if (checking(key)) enqueue(key);
    },

    enqueue,

    ackSnapshot(key, note, decidedBy) {
      ctx.requireState(ctx.mustGet(key), "awaiting_snapshot_ack");
      if (note.trim() === "") throw new ValidationError("acknowledgement note is required");
      const drift = latestDrift(db, key);
      if (!drift || drift.trigger !== "snapshot_changed") throw new InvalidTransitionError(`${key}: no snapshot drift check to acknowledge`);
      const choice = currentChoice(db, key);
      if (!choice || drift.requirementId !== choice.requirementId) {
        throw new ValidationError(`${key}: the latest drift check is not for the chosen requirement — re-plan instead`);
      }
      ctx.atomic(() => {
        acknowledgeDrift(db, drift.id, note, decidedBy);
        ctx.move(key, "developing", "developer", undefined, { decidedBy });
      });
      ctx.enqueueDevelop(key);
    },
  };
}
