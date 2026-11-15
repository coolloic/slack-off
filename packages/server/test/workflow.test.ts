import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRole, DriftResult, FetchedTicket, ProposeResult, Requirement } from "@slackoff/shared";
import { budgetGate, pauseUsage, resumeUsage, UsagePausedError } from "../src/cost/budget-gate.ts";
import { UsageLimitError } from "../src/executor/types.ts";
import { openDatabase } from "../src/db/database.ts";
import { verifyAuditChain } from "../src/audit/audit-log.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import type { Config } from "../src/config.ts";
import type { RunAgentRequest } from "../src/executor/run-agent.ts";
import { AgentInterruptedError, ExecutorUnavailableError } from "../src/executor/types.ts";
import { JiraLoginRequiredError } from "../src/jira/ticket-source.ts";
import { BrowserChoiceRequiredError } from "../src/executor/types.ts";
import { getTicket, lastDiscoveryRun, listTickets, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { InvalidTransitionError, ValidationError } from "../src/tickets/errors.ts";
import { addRequirement, latestRequirement, listSolutions } from "../src/requirements/requirement-repo.ts";
import { latestDrift } from "../src/drift/drift-repo.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { recoverOnStartup } from "../src/workflow/recovery.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { fakeCritique, fakeDesign } from "../src/dev/fake-mode.ts";
import { gitRepo } from "./fixtures/git-repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

// P-C19: PROJ is mapped to real (temporary) git repos; propose reads their base branch
const PROJ_REPO = gitRepo("proj");
const WEB_REPO = gitRepo("web");

const config = (over: Partial<Config> = {}): Config => ({
  jira: {
    baseUrl: "https://jira.example.com", readyForDevStatus: "Ready for Dev", discoverLimit: 100, source: "browser",
    syncStatus: false, inProgressStatus: "In Progress", browser: null, reviewStatus: "Ready for Human Review",
  },
  projects: { PROJ: { repos: [{ name: "proj", path: PROJ_REPO, baseBranch: "main" }] } },
  executor: { kind: "claude-code", claudeBin: "claude", model: "" },
  concurrency: 1,
  autoRefine: false,
  reviewAcByDefault: false,
  remoteAccess: { enabled: false, host: "" },
  debate: { maxRounds: 3 },
  development: { maxSteps: 12, commandTimeoutMs: 600_000, hookTimeoutMs: 300_000, allowUnsandboxedCommands: false, deniedLocalPorts: [], allowUnsandboxedHooks: false, localNetwork: "denylist" },
  review: { maxAttempts: 3 },
  acceptance: { claudeConfigDir: "/tmp/slackoff-test-accept-config", startTimeoutMs: 120_000, runTimeoutMs: 1_800_000, caseTimeoutMs: 30_000 },
  delivery: { ghBin: "gh", azBin: "az" },
  budget: { enabled: false, window: "5h", maxRuns: null, maxRunMinutes: null, maxUsd: null, warnAt: 0.8 },
  telemetry: { endpoint: "", includeContent: false },
  ...over,
});

function fetched(key: string): FetchedTicket {
  return {
    loginRequired: false,
    key,
    title: `Title ${key}`,
    description: "Add an export button.\n\nIt downloads CSV.",
    jiraUpdatedAt: "2026-11-06T00:00:00Z",
    status: "Ready for Dev",
    comments: [{ jiraCommentId: "100", author: "ann", created: "2026-11-05T00:00:00Z", body: "Include VAT." }],
    attachments: [{ kind: "attachment", filename: "spec.pdf", mime: "application/pdf", url: "https://jira/spec.pdf", base64: null }],
  };
}

const requirement = (acText = "Export downloads CSV"): Requirement => ({
  background: "bg",
  functional: [{ id: "FR-1", text: "export" }],
  acceptanceCriteria: [
    { id: "AC-1", text: acText, verifiable: true, source: { type: "description", ref: "description#p1", quote: "Add an export button." } },
  ],
  discussionOutcomes: [{ id: "D-1", text: "VAT column", sourceCommentIds: ["100"] }],
  openQuestions: [],
  draftComment: null,
});

const covered: DriftResult = {
  baseline: [
    { id: "AC-1@v1", status: "covered", coveredBy: ["AC-1"], note: "" },
    { id: "D-1", status: "covered", coveredBy: ["AC-1"], note: "" },
  ],
  current: [{ id: "AC-1", status: "mapped" }],
  contradictions: [],
};

const unsourced: DriftResult = { ...covered, current: [{ id: "AC-1", status: "mapped" }, { id: "AC-2", status: "new_unsourced" }] };

const proposal: ProposeResult = {
  solutions: [
    { title: "A", approach: "a", changeScope: ["src/a.ts"], pros: ["p"], cons: ["c"], risks: [], complexity: "S", affectedRepos: ["proj"], repoChanges: [{ repo: "proj", summary: "a" }] },
    { title: "B", approach: "b", changeScope: ["src/b.ts"], pros: ["p"], cons: ["c"], risks: [], complexity: "M", affectedRepos: ["proj"], repoChanges: [{ repo: "proj", summary: "b" }] },
  ],
};

type Out = unknown | Error | (() => unknown);

function setup(opts: { config?: Partial<Config>; delayMs?: number; gate?: { check(role: AgentRole): void } } = {}) {
  const db = openDatabase(":memory:");
  const home = tmpDir("wf");
  const source = new FakeTicketSource();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const cfg = config(opts.config);
  const queue = new JobQueue(cfg.concurrency);
  const outputs: Record<"refine" | "check" | "propose", Out> = { refine: requirement(), check: covered, propose: proposal };
  const calls: Array<RunAgentRequest<unknown>> = [];
  let active = 0;
  let maxActive = 0;
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    opts.gate?.check(req.role);
    calls.push(req as RunAgentRequest<unknown>);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 0));
      // Task 9: choose starts the design debate; the canned fake designer/critic finish it (one revise, then final)
      if (req.role === "design-solution") return req.schema.parse(fakeDesign(req.prompt));
      if (req.role === "critique-design") return req.schema.parse(fakeCritique(req.prompt));
      const kind = req.role === "propose-solutions" ? "propose" : req.prompt.startsWith("mode: check") ? "check" : "refine";
      let out = outputs[kind];
      if (typeof out === "function") out = (out as () => unknown)();
      if (out instanceof Error) throw out;
      return req.schema.parse(out);
    } finally {
      active--;
    }
  };
  // these tests stop at developing: the development job (Task 11, development.test.ts) is a no-op job here
  const wf = createWorkflow({ updater: noUpdater, db, home, queue, source, run, config: cfg, bus, hooks: { enqueueDevelop: stubDevelop(queue) } });
  const audits = () => (db.prepare("SELECT type FROM audit_event ORDER BY id").all() as Array<{ type: string }>).map((r) => r.type);
  const state = (key: string) => getTicket(db, key)?.state;
  return { db, home, source, bus, events, queue, outputs, calls, wf, audits, state, maxActive: () => maxActive };
}

/** The develop:<KEY> job id with no work, for tests that end at developing. */
const stubDevelop = (queue: JobQueue) => (key: string) => queue.enqueue(`develop:${key}`, async () => {});

const summary = (key: string) => ({ key, title: `Title ${key}`, url: `https://jira/${key}`, status: "Ready for Dev" });

test("JobQueue de-dups by id while queued or running and idle() waits for everything", async () => {
  const q = new JobQueue(1);
  const ran: string[] = [];
  const job = (name: string) => async () => {
    await new Promise((r) => setTimeout(r, 5));
    ran.push(name);
  };
  q.enqueue("a", job("a1"));
  q.enqueue("a", job("a2"));
  q.enqueue("b", job("b1"));
  q.enqueue("b", job("b2"));
  await q.idle();
  assert.deepEqual(ran, ["a1", "b1"]);
  q.enqueue("a", job("a3"));
  await q.idle();
  assert.deepEqual(ran, ["a1", "b1", "a3"]);
  await q.idle();
});

test("full path discover -> refine -> propose -> choose with matching audit trail", async () => {
  const s = setup({ config: { projects: { PROJ: { repos: [{ name: "proj", path: PROJ_REPO, baseBranch: "main" }, { name: "web", path: WEB_REPO, baseBranch: "main" }] } } } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-1")], total: 1, complete: true };
  s.source.tickets["PROJ-1"] = fetched("PROJ-1");

  s.wf.discover();
  await s.queue.idle();
  assert.equal(s.state("PROJ-1"), "discovered");
  assert.deepEqual(s.audits(), ["ticket_discovered"]);

  s.wf.refine("PROJ-1", "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-1"), "awaiting_choice");
  assert.equal(listSolutions(s.db, "PROJ-1").length, 2);

  const [refineCall, proposeCall] = s.calls;
  assert.equal(refineCall!.role, "refine-ticket");
  assert.equal(refineCall!.prompt.split("\n")[0], "mode: refine");
  assert.match(refineCall!.prompt, /"jiraCommentId": "100"/);
  assert.match(refineCall!.prompt, /spec\.pdf/);
  assert.deepEqual(refineCall!.allowedTools, []);
  assert.equal(refineCall!.chrome, false);
  assert.equal(refineCall!.cwd, PROJ_REPO);
  assert.equal(proposeCall!.role, "propose-solutions");
  assert.deepEqual(proposeCall!.allowedTools, ["Read", "Grep", "Glob"]);
  assert.equal(proposeCall!.chrome, false);
  assert.match(proposeCall!.prompt, /"AC-1"/);
  // every mapped repo is read: cwd = the first, the others as extra directories; the prompt lists them all
  assert.equal(proposeCall!.cwd, PROJ_REPO);
  assert.deepEqual(proposeCall!.addDirs, [WEB_REPO]);
  assert.deepEqual(proposeCall!.repos?.map((r) => r.name), ["proj", "web"]);
  assert.match(proposeCall!.prompt, /"name": "proj"/);
  assert.match(proposeCall!.prompt, /"name": "web"/);
  assert.ok(proposeCall!.prompt.includes(`"path": ${JSON.stringify(WEB_REPO)}`));

  const sol = listSolutions(s.db, "PROJ-1")[1]!;
  s.wf.choose("PROJ-1", sol.id, "go with B", undefined, "local");
  assert.equal(s.state("PROJ-1"), "designing");

  assert.deepEqual(s.audits(), [
    "ticket_discovered",
    "state_changed", // discovered -> refining
    "snapshot_created",
    "requirement_saved",
    "state_changed", // refining -> refined
    "state_changed", // refined -> proposing
    "solutions_saved",
    "state_changed", // proposing -> awaiting_choice
    "choice_recorded",
    "preference_signal_recorded", // phase 4d: the choice's features, same transaction
    "state_changed", // awaiting_choice -> designing
  ]);
  assert.deepEqual(verifyAuditChain(s.db), { ok: true, count: 11 });
  const changes = s.events.filter((e) => e.type === "state_changed").map((e) => (e.type === "state_changed" ? `${e.from}>${e.to}` : ""));
  assert.deepEqual(changes, [
    "discovered>refining",
    "refining>refined",
    "refined>proposing",
    "proposing>awaiting_choice",
    "awaiting_choice>designing",
  ]);
  await s.queue.idle();
  // Task 10: design final, the re-read snapshot is unchanged -> development
  assert.equal(s.state("PROJ-1"), "developing");
});

test("autoRefine refines discovered tickets; refine's cwd falls back to the data dir (propose does not, P-C19); invalid keys are skipped", async () => {
  const s = setup({ config: { autoRefine: true } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("OTHER-7"), summary("bad key"), summary("lower-1")], total: 3, complete: true };
  s.source.tickets["OTHER-7"] = fetched("OTHER-7");
  s.wf.discover();
  await s.queue.idle();
  assert.deepEqual(listTickets(s.db).map((t) => t.key), ["OTHER-7"]);
  assert.equal(s.calls[0]!.cwd, s.home);
  assert.equal(s.state("OTHER-7"), "blocked");
  assert.equal(getTicket(s.db, "OTHER-7")!.blockedReason, "Map project OTHER to a repo in Settings");
  assert.equal(s.calls.length, 1);
  const err = s.events.find((e) => e.type === "source_error");
  assert.ok(err && err.type === "source_error");
  assert.match(err.message, /bad key/);
  assert.match(err.message, /lower-1/);
});

test("review_ac: edit -> drift with new_unsourced -> awaiting_drift_ack; propose without ack throws; ack -> proposing", async () => {
  const s = setup({ config: { reviewAcByDefault: true } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-2")], total: 1, complete: true };
  s.source.tickets["PROJ-2"] = fetched("PROJ-2");
  s.wf.discover();
  await s.queue.idle();
  s.wf.refine("PROJ-2", "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-2"), "awaiting_ac_review");

  s.outputs.check = unsourced;
  const edited = requirement("Export downloads CSV and XLSX");
  edited.acceptanceCriteria.push({ id: "AC-2", text: "Shows a toast", verifiable: true, source: { type: "description", ref: "description#p9", quote: "nope" } });
  s.wf.editRequirement("PROJ-2", edited, "local");
  assert.equal(s.state("PROJ-2"), "checking_drift");
  assert.equal(latestRequirement(s.db, "PROJ-2")!.source, "human");
  await s.queue.idle();
  assert.equal(s.state("PROJ-2"), "awaiting_drift_ack");

  const check = s.calls.find((c) => c.prompt.startsWith("mode: check"))!;
  assert.equal(check.role, "refine-ticket");
  assert.deepEqual(check.allowedTools, []);
  assert.match(check.prompt, /"AC-1@v1"/);
  assert.match(check.prompt, /"D-1"/);
  assert.match(check.prompt, /baselineSnapshot/);
  assert.match(check.prompt, /latestSnapshot/);
  assert.equal(latestDrift(s.db, "PROJ-2")!.trigger, "ac_edited");

  assert.throws(() => s.wf.propose("PROJ-2", "local"), InvalidTransitionError);
  assert.throws(() => s.wf.confirmRequirement("PROJ-2", "local"), InvalidTransitionError);
  assert.throws(() => s.wf.acknowledgeDrift("PROJ-2", "  ", "local"), ValidationError);
  assert.equal(s.state("PROJ-2"), "awaiting_drift_ack");

  s.wf.acknowledgeDrift("PROJ-2", "AC-2 agreed with PO on Slack", "device:5");
  assert.equal(s.state("PROJ-2"), "proposing");
  assert.equal(latestDrift(s.db, "PROJ-2")!.acknowledged, true);
  // Task 10 fix: the deciding device is audited on the acknowledgement and on the state change
  const ackAudit = (type: string) =>
    JSON.parse((s.db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id DESC LIMIT 1").get(type) as { payload_json: string }).payload_json);
  assert.equal(ackAudit("drift_acknowledged").decidedBy, "device:5");
  assert.equal(ackAudit("state_changed").decidedBy, "device:5");
  await s.queue.idle();
  assert.equal(s.state("PROJ-2"), "awaiting_choice");
});

test("review_ac: fully covered drift returns to awaiting_ac_review; confirm requires a check after the last edit", async () => {
  const s = setup({ config: { reviewAcByDefault: true } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-3")], total: 1, complete: true };
  s.source.tickets["PROJ-3"] = fetched("PROJ-3");
  s.wf.discover();
  await s.queue.idle();
  s.wf.refine("PROJ-3", "local");
  await s.queue.idle();

  s.wf.editRequirement("PROJ-3", requirement("Export downloads a CSV file"), "local");
  // the edit is not checked yet: confirmation is refused
  assert.throws(() => s.wf.confirmRequirement("PROJ-3", "local"), InvalidTransitionError);
  await s.queue.idle();
  assert.equal(s.state("PROJ-3"), "awaiting_ac_review");
  assert.throws(() => s.wf.backToEditing("PROJ-3", "local"), InvalidTransitionError);

  s.wf.confirmRequirement("PROJ-3", "local");
  assert.equal(s.state("PROJ-3"), "proposing");
  await s.queue.idle();
  assert.equal(s.state("PROJ-3"), "awaiting_choice");
});

test("editRequirement only in awaiting_ac_review; backToEditing returns from awaiting_drift_ack", async () => {
  const s = setup({ config: { reviewAcByDefault: true } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-4")], total: 1, complete: true };
  s.source.tickets["PROJ-4"] = fetched("PROJ-4");
  s.wf.discover();
  await s.queue.idle();
  assert.throws(() => s.wf.editRequirement("PROJ-4", requirement(), "local"), InvalidTransitionError);
  s.wf.refine("PROJ-4", "local");
  await s.queue.idle();
  s.outputs.check = unsourced;
  s.wf.editRequirement("PROJ-4", requirement("x"), "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-4"), "awaiting_drift_ack");
  s.wf.backToEditing("PROJ-4", "local");
  assert.equal(s.state("PROJ-4"), "awaiting_ac_review");
  // the unacknowledged drift still blocks confirmation until a new edit is checked clean
  assert.throws(() => s.wf.confirmRequirement("PROJ-4", "local"), InvalidTransitionError);
  s.outputs.check = covered;
  s.wf.editRequirement("PROJ-4", requirement("y"), "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-4"), "awaiting_ac_review");
  s.wf.confirmRequirement("PROJ-4", "local");
  assert.equal(s.state("PROJ-4"), "proposing");
  await s.queue.idle();
});

test("ExecutorUnavailableError blocks the ticket with the original message; retry resumes", async () => {
  const s = setup();
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-5")], total: 1, complete: true };
  s.source.tickets["PROJ-5"] = fetched("PROJ-5");
  s.wf.discover();
  await s.queue.idle();
  s.outputs.refine = new ExecutorUnavailableError("claude CLI not found on PATH");
  s.wf.refine("PROJ-5", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "PROJ-5")!;
  assert.equal(t.state, "blocked");
  assert.equal(t.prevState, "refining");
  assert.match(t.blockedReason!, /claude CLI not found on PATH/);
  assert.ok(s.events.some((e) => e.type === "state_changed" && e.ticketKey === "PROJ-5" && e.to === "blocked"));

  s.outputs.refine = requirement();
  s.wf.retry("PROJ-5", "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-5"), "awaiting_choice");
});

test("abandon moves the ticket to abandoned", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-9"), false);
  s.wf.abandon("PROJ-9", "local");
  assert.equal(s.state("PROJ-9"), "abandoned");
  assert.throws(() => s.wf.retry("PROJ-9", "local"), InvalidTransitionError);
});

test("recoverOnStartup resumes refining and checking_drift tickets to completion", async () => {
  const s = setup({ config: { reviewAcByDefault: true } });
  s.source.tickets["PROJ-6"] = fetched("PROJ-6");
  s.source.tickets["PROJ-7"] = fetched("PROJ-7");
  upsertDiscovered(s.db, summary("PROJ-6"), false);
  transition(s.db, "PROJ-6", "refining", "system");

  // PROJ-7: refined + edited, then the process died in checking_drift
  upsertDiscovered(s.db, summary("PROJ-7"), true);
  s.wf.refine("PROJ-7", "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-7"), "awaiting_ac_review");
  transition(s.db, "PROJ-7", "checking_drift", "system");

  // a fresh workflow, as after a restart
  const queue = new JobQueue(1);
  const wf2 = createWorkflow({ updater: noUpdater,
    db: s.db, home: s.home, queue, source: s.source, bus: s.bus, config: config({ reviewAcByDefault: true }),
    run: async <T>(req: RunAgentRequest<T>) =>
      req.schema.parse(req.role === "propose-solutions" ? proposal : req.prompt.startsWith("mode: check") ? covered : requirement()),
  });
  recoverOnStartup(s.db, wf2);
  await queue.idle();
  assert.equal(s.state("PROJ-6"), "awaiting_choice");
  assert.equal(s.state("PROJ-7"), "awaiting_ac_review");
  assert.equal(latestDrift(s.db, "PROJ-7")!.trigger, "ac_edited");
});

test("concurrency 1 never runs two agents at once", async () => {
  const s = setup({ delayMs: 10 });
  for (const k of ["PROJ-10", "PROJ-11", "PROJ-12"]) {
    upsertDiscovered(s.db, summary(k), false);
    s.source.tickets[k] = fetched(k);
  }
  s.wf.refine("PROJ-10", "local");
  s.wf.refine("PROJ-11", "local");
  s.wf.refine("PROJ-12", "local");
  await s.queue.idle();
  assert.equal(s.maxActive(), 1);
  for (const k of ["PROJ-10", "PROJ-11", "PROJ-12"]) assert.equal(s.state(k), "awaiting_choice");
});

test("expired JIRA login during discover changes no ticket and emits source_error", async () => {
  const s = setup({ config: { autoRefine: true } });
  upsertDiscovered(s.db, summary("PROJ-20"), false);
  const before = JSON.stringify(listTickets(s.db));
  const auditsBefore = s.audits().length;

  s.source.discoverResult = new JiraLoginRequiredError();
  s.wf.discover();
  await s.queue.idle();
  s.source.discoverResult = { loginRequired: true, tickets: [summary("PROJ-21")], total: 1, complete: false };
  s.wf.discover();
  await s.queue.idle();

  assert.equal(JSON.stringify(listTickets(s.db)), before);
  assert.equal(s.audits().length, auditsBefore);
  const errs = s.events.filter((e) => e.type === "source_error");
  assert.equal(errs.length, 2);
  assert.match(errs[0]!.type === "source_error" ? errs[0]!.message : "", /JIRA login required/);
});

test("JIRA login error while refining emits source_error and blocks the ticket for retry", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-30"), false);
  s.source.tickets["PROJ-30"] = new JiraLoginRequiredError();
  s.wf.refine("PROJ-30", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "PROJ-30")!;
  assert.equal(t.state, "blocked");
  assert.match(t.blockedReason!, /JIRA login required/);
  assert.ok(s.events.some((e) => e.type === "source_error"));
  assert.equal(s.calls.length, 0);
});

test("S-2: several browsers and none configured while refining -> source_error and blocked with that exact message", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-31"), false);
  s.source.tickets["PROJ-31"] = new BrowserChoiceRequiredError();
  s.wf.refine("PROJ-31", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "PROJ-31")!;
  assert.equal(t.state, "blocked");
  assert.equal(t.blockedReason, "Choose the Chrome browser for JIRA in Settings");
  const errs = s.events.filter((e) => e.type === "source_error");
  assert.equal(errs.length, 1);
  assert.equal(errs[0]!.type === "source_error" ? errs[0]!.message : "", "Choose the Chrome browser for JIRA in Settings");
  assert.equal(s.calls.length, 0);
});

test("JobQueue reports job errors to onError instead of discarding them", async () => {
  const seen: Array<[string, string]> = [];
  const q = new JobQueue(1, { onError: (id, err) => seen.push([id, (err as Error).message]) });
  q.enqueue("x", async () => {
    throw new Error("kaboom");
  });
  q.enqueue("y", async () => {});
  await q.idle();
  assert.deepEqual(seen, [["x", "kaboom"]]);
});

test("JobQueue guards invalid concurrency values", async () => {
  for (const c of [0, -1, 1.5, Number.NaN]) {
    const q = new JobQueue(c);
    let active = 0;
    let max = 0;
    const job = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    };
    q.enqueue("a", job);
    q.enqueue("b", job);
    await q.idle();
    assert.equal(max, 1, `concurrency ${c}`);
  }
});

test("a job whose blocked-transition fails still surfaces the error via onError", async () => {
  const seen: Array<{ id: string; err: unknown }> = [];
  const db = openDatabase(":memory:");
  const home = tmpDir("wf");
  const source = new FakeTicketSource();
  const queue = new JobQueue(1, { onError: (id, err) => seen.push({ id, err }) });
  const wf = createWorkflow({ updater: noUpdater,
    db, home, queue, source, bus: new EventBus(), config: config(),
    run: async () => {
      throw new Error("agent exploded");
    },
  });
  upsertDiscovered(db, summary("PROJ-40"), false);
  source.tickets["PROJ-40"] = fetched("PROJ-40");
  db.exec("CREATE TRIGGER no_block BEFORE UPDATE ON ticket WHEN NEW.state = 'blocked' BEGIN SELECT RAISE(ABORT, 'cannot block'); END");
  wf.refine("PROJ-40", "local");
  await queue.idle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.id, "refine:PROJ-40");
  const all = String((seen[0]!.err as Error).message) + String(((seen[0]!.err as AggregateError).errors ?? []).map((e: Error) => e.message));
  assert.match(all, /agent exploded/);
  assert.match(all, /cannot block/);
});

test("discover keeps going when one ticket fails and names it in source_error", async () => {
  const s = setup();
  s.db.exec("CREATE TRIGGER no_bad BEFORE INSERT ON ticket WHEN NEW.key = 'PROJ-50' BEGIN SELECT RAISE(ABORT, 'insert refused'); END");
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-50"), summary("PROJ-51")], total: 2, complete: true };
  s.wf.discover();
  await s.queue.idle();
  assert.deepEqual(listTickets(s.db).map((t) => t.key), ["PROJ-51"]);
  const err = s.events.find((e) => e.type === "source_error");
  assert.ok(err && err.type === "source_error");
  assert.match(err.message, /PROJ-50/);
  assert.match(err.message, /insert refused/);
});

test("a failing post-run write rolls back the whole step and emits no state_changed for it", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-60"), false);
  s.source.tickets["PROJ-60"] = fetched("PROJ-60");
  s.db.exec("CREATE TRIGGER no_refined BEFORE UPDATE ON ticket WHEN NEW.state = 'refined' BEGIN SELECT RAISE(ABORT, 'refined refused'); END");
  s.wf.refine("PROJ-60", "local");
  await s.queue.idle();
  assert.equal(latestRequirement(s.db, "PROJ-60"), null);
  const t = getTicket(s.db, "PROJ-60")!;
  assert.equal(t.state, "blocked");
  assert.match(t.blockedReason!, /refined refused/);
  const changes = s.events.filter((e) => e.type === "state_changed").map((e) => (e.type === "state_changed" ? e.to : ""));
  assert.deepEqual(changes, ["refining", "blocked"]);
});

test("recoverOnStartup continues tickets left in refined and proposing", async () => {
  const s = setup();
  for (const k of ["PROJ-70", "PROJ-71", "PROJ-72"]) s.source.tickets[k] = fetched(k);
  upsertDiscovered(s.db, summary("PROJ-70"), false); // refined, review off -> proposes
  upsertDiscovered(s.db, summary("PROJ-71"), true); // refined, review on -> awaiting_ac_review
  upsertDiscovered(s.db, summary("PROJ-72"), false); // proposing -> awaiting_choice
  for (const k of ["PROJ-70", "PROJ-71", "PROJ-72"]) {
    transition(s.db, k, "refining", "system");
    const { snapshotId } = (await import("../src/snapshots/snapshot-store.ts")).saveSnapshot(s.db, s.home, k, fetched(k));
    (await import("../src/requirements/requirement-repo.ts")).addRequirement(s.db, k, snapshotId, requirement(), "agent");
    transition(s.db, k, "refined", "system");
  }
  transition(s.db, "PROJ-72", "proposing", "system");

  recoverOnStartup(s.db, s.wf);
  await s.queue.idle();
  assert.equal(s.state("PROJ-70"), "awaiting_choice");
  assert.equal(s.state("PROJ-71"), "awaiting_ac_review");
  assert.equal(s.state("PROJ-72"), "awaiting_choice");
});

test("concurrency 2 runs different tickets in parallel and still de-dups duplicate ids", async () => {
  const s = setup({ config: { concurrency: 2 }, delayMs: 15 });
  for (const k of ["PROJ-80", "PROJ-81"]) {
    upsertDiscovered(s.db, summary(k), false);
    s.source.tickets[k] = fetched(k);
  }
  s.wf.refine("PROJ-80", "local");
  s.wf.refine("PROJ-81", "local");
  s.wf.refine("PROJ-80", "local");
  s.wf.refine("PROJ-81", "local");
  await s.queue.idle();
  assert.equal(s.maxActive(), 2);
  const refines = s.calls.filter((c) => c.role === "refine-ticket").map((c) => c.ticketKey).sort();
  assert.deepEqual(refines, ["PROJ-80", "PROJ-81"]);
  for (const k of ["PROJ-80", "PROJ-81"]) assert.equal(s.state(k), "awaiting_choice");
});

// ---- F-I3: discovery reports what it found ----

test("discover emits ticket_discovered per new ticket and discover_finished with created/total", async () => {
  const s = setup();
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-30"), summary("PROJ-31"), summary("bad key")], total: 3, complete: true };
  s.wf.discover();
  await s.queue.idle();
  const found = s.events.filter((e) => e.type === "ticket_discovered").map((e) => (e.type === "ticket_discovered" ? e.ticketKey : ""));
  assert.deepEqual(found, ["PROJ-30", "PROJ-31"]);
  assert.deepEqual(s.events.filter((e) => e.type === "discover_finished"), [{ type: "discover_finished", created: 2, returned: 2, total: 3, complete: true }]);

  s.events.length = 0;
  s.wf.discover();
  await s.queue.idle();
  assert.equal(s.events.filter((e) => e.type === "ticket_discovered").length, 0);
  assert.deepEqual(s.events.filter((e) => e.type === "discover_finished"), [{ type: "discover_finished", created: 0, returned: 2, total: 3, complete: true }]);

  s.events.length = 0;
  s.source.discoverResult = { loginRequired: false, tickets: [], total: 0, complete: true };
  s.wf.discover();
  await s.queue.idle();
  assert.deepEqual(s.events.filter((e) => e.type === "discover_finished"), [{ type: "discover_finished", created: 0, returned: 0, total: 0, complete: true }]);
});

test("discover_finished reports loginRequired and errors", async () => {
  const s = setup();
  s.source.discoverResult = new JiraLoginRequiredError();
  s.wf.discover();
  await s.queue.idle();
  s.source.discoverResult = { loginRequired: true, tickets: [], total: 0, complete: false };
  s.wf.discover();
  await s.queue.idle();
  s.source.discoverResult = new Error("chrome went away");
  s.wf.discover();
  await s.queue.idle();
  const done = s.events.filter((e) => e.type === "discover_finished");
  assert.equal(done.length, 3);
  assert.deepEqual(done[0], { type: "discover_finished", created: 0, returned: 0, total: 0, complete: false, loginRequired: true, error: new JiraLoginRequiredError().message });
  assert.deepEqual(done[1], { type: "discover_finished", created: 0, returned: 0, total: 0, complete: false, loginRequired: true, error: new JiraLoginRequiredError().message });
  assert.deepEqual(done[2], { type: "discover_finished", created: 0, returned: 0, total: 0, complete: false, error: "chrome went away" });
});

// ---- author decision 2026-11-06: every open ticket assigned to me; no-longer-open flag ----

test("a complete discovery flags known tickets it no longer returned and clears the flag when they reappear", async () => {
  const s = setup();
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-60"), summary("PROJ-61")], total: 2, complete: true };
  s.wf.discover();
  await s.queue.idle();
  s.wf.refine("PROJ-60", "local");
  await s.queue.idle();
  const stateBefore = s.state("PROJ-60");
  const reqBefore = latestRequirement(s.db, "PROJ-60")?.version;

  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-61")], total: 1, complete: true };
  s.wf.discover();
  await s.queue.idle();
  assert.equal(getTicket(s.db, "PROJ-60")!.jiraOpen, false);
  assert.equal(getTicket(s.db, "PROJ-61")!.jiraOpen, true);
  assert.equal(s.state("PROJ-60"), stateBefore, "never changes platform state");
  assert.equal(latestRequirement(s.db, "PROJ-60")?.version, reqBefore, "never touches requirements");
  assert.equal(s.audits().filter((t) => t === "ticket_no_longer_open").length, 1);

  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-60"), summary("PROJ-61")], total: 2, complete: true };
  s.wf.discover();
  await s.queue.idle();
  assert.equal(getTicket(s.db, "PROJ-60")!.jiraOpen, true);
  assert.equal(s.audits().filter((t) => t === "ticket_open_again").length, 1);
  assert.equal(verifyAuditChain(s.db).ok, true);
});

test("an incomplete, failed or login-required discovery changes no flag", async () => {
  const s = setup();
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-70"), summary("PROJ-71")], total: 2, complete: true };
  s.wf.discover();
  await s.queue.idle();
  const outcomes = [
    { loginRequired: false, tickets: [summary("PROJ-71")], total: 2, complete: false },
    // claims complete but read fewer rows than JIRA reported: treated as incomplete
    { loginRequired: false, tickets: [summary("PROJ-71")], total: 2, complete: true },
    { loginRequired: true, tickets: [], total: 0, complete: false },
    new Error("chrome went away"),
    new JiraLoginRequiredError(),
  ];
  for (const r of outcomes) {
    s.source.discoverResult = r;
    s.wf.discover();
    await s.queue.idle();
    assert.equal(getTicket(s.db, "PROJ-70")!.jiraOpen, true, JSON.stringify(r));
  }
  assert.equal(s.audits().filter((t) => t === "ticket_no_longer_open").length, 0);
  const last = s.events.filter((e) => e.type === "discover_finished");
  assert.deepEqual(last[1], { type: "discover_finished", created: 0, returned: 1, total: 2, complete: false });
  assert.deepEqual(last[2], { type: "discover_finished", created: 0, returned: 1, total: 2, complete: false });
});

test("discovery keeps at most jira.discoverLimit tickets (more is incomplete) and records each successful run", async () => {
  const s = setup({ config: { jira: { ...config().jira, discoverLimit: 2 } } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-90"), summary("PROJ-91"), summary("PROJ-92")], total: 5, complete: true };
  s.wf.discover();
  await s.queue.idle();
  assert.deepEqual(listTickets(s.db).map((t) => t.key), ["PROJ-90", "PROJ-91"]);
  assert.deepEqual(s.events.filter((e) => e.type === "discover_finished"), [{ type: "discover_finished", created: 2, returned: 2, total: 5, complete: false }]);
  const run = lastDiscoveryRun(s.db)!;
  assert.deepEqual({ returned: run.returned, total: run.total, complete: run.complete }, { returned: 2, total: 5, complete: false });

  s.source.discoverResult = new Error("boom");
  s.wf.discover();
  await s.queue.idle();
  assert.equal(lastDiscoveryRun(s.db)!.finishedAt, run.finishedAt, "a failed discovery records no run");
});

test("FakeTicketSource can answer asynchronously", async () => {
  const src = new FakeTicketSource();
  src.delayMs = 50;
  const t0 = Date.now();
  await src.discover();
  assert.ok(Date.now() - t0 >= 45);
});

// ---- F-I4: acknowledge after Back to editing ----

test("acknowledgeDrift works in awaiting_ac_review after Back to editing, then Confirm is allowed", async () => {
  const s = setup({ config: { reviewAcByDefault: true } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-40")], total: 1, complete: true };
  s.source.tickets["PROJ-40"] = fetched("PROJ-40");
  s.wf.discover();
  await s.queue.idle();
  s.wf.refine("PROJ-40", "local");
  await s.queue.idle();
  // no drift check yet: nothing to acknowledge in awaiting_ac_review
  assert.throws(() => s.wf.acknowledgeDrift("PROJ-40", "note", "local"), InvalidTransitionError);

  s.outputs.check = unsourced;
  s.wf.editRequirement("PROJ-40", requirement("x"), "local");
  await s.queue.idle();
  s.wf.backToEditing("PROJ-40", "local");
  assert.equal(s.state("PROJ-40"), "awaiting_ac_review");
  assert.throws(() => s.wf.confirmRequirement("PROJ-40", "local"), InvalidTransitionError);
  assert.throws(() => s.wf.acknowledgeDrift("PROJ-40", " ", "local"), ValidationError);

  s.wf.acknowledgeDrift("PROJ-40", "agreed with PO", "local");
  assert.equal(s.state("PROJ-40"), "awaiting_ac_review", "ack in review keeps the developer in review");
  assert.equal(latestDrift(s.db, "PROJ-40")!.acknowledged, true);
  assert.ok(s.audits().includes("drift_acknowledged"));
  // already acknowledged: a second ack is refused
  assert.throws(() => s.wf.acknowledgeDrift("PROJ-40", "again", "local"), InvalidTransitionError);

  s.wf.confirmRequirement("PROJ-40", "local");
  assert.equal(s.state("PROJ-40"), "proposing");
  await s.queue.idle();
  assert.equal(s.state("PROJ-40"), "awaiting_choice");
});

test("acknowledgeDrift in awaiting_ac_review is refused when the latest drift belongs to an older requirement", async () => {
  const s = setup({ config: { reviewAcByDefault: true } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-41")], total: 1, complete: true };
  s.source.tickets["PROJ-41"] = fetched("PROJ-41");
  s.wf.discover();
  await s.queue.idle();
  s.wf.refine("PROJ-41", "local");
  await s.queue.idle();
  s.outputs.check = unsourced;
  s.wf.editRequirement("PROJ-41", requirement("x"), "local");
  await s.queue.idle();
  s.wf.backToEditing("PROJ-41", "local");
  // a newer requirement exists without its own drift check (the latest drift belongs to v2)
  const prev = latestRequirement(s.db, "PROJ-41")!;
  addRequirement(s.db, "PROJ-41", prev.snapshotId, requirement("y"), "human");
  assert.equal(s.state("PROJ-41"), "awaiting_ac_review");
  assert.throws(() => s.wf.acknowledgeDrift("PROJ-41", "stale", "local"), InvalidTransitionError);
});

// ---- F-I7: incomplete comments ----

test("refine on an incomplete snapshot tells the agent and adds an open question", async () => {
  const s = setup({ config: { reviewAcByDefault: true } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-50")], total: 1, complete: true };
  s.source.tickets["PROJ-50"] = { ...fetched("PROJ-50"), description: "Add an export button.\n\n[slackoff: 7 older comments not loaded]" };
  s.wf.discover();
  await s.queue.idle();
  s.wf.refine("PROJ-50", "local");
  await s.queue.idle();
  const call = s.calls.find((c) => c.prompt.startsWith("mode: refine"))!;
  assert.match(call.prompt, /7 older comments were not loaded/);
  assert.match(call.prompt, /"commentsNotLoaded": 7/);
  assert.doesNotMatch(call.prompt, /\[slackoff:/);
  const q = latestRequirement(s.db, "PROJ-50")!.content.openQuestions;
  assert.deepEqual(q.filter((x) => x.text.includes("older comments")), [{ kind: "missing", text: "7 older comments were not loaded — check JIRA" }]);
});

test("a complete snapshot adds no incomplete-comments question", async () => {
  const s = setup({ config: { reviewAcByDefault: true } });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-51")], total: 1, complete: true };
  s.source.tickets["PROJ-51"] = fetched("PROJ-51");
  s.wf.discover();
  await s.queue.idle();
  s.wf.refine("PROJ-51", "local");
  await s.queue.idle();
  assert.doesNotMatch(s.calls[0]!.prompt, /not loaded/);
  assert.deepEqual(latestRequirement(s.db, "PROJ-51")!.content.openQuestions, []);
});

// ---- H2 lifecycle: shutdown interruption and startup recovery ----

test("H2: a run interrupted by shutdown leaves the ticket in its working state (resumed on restart)", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-90"), false);
  s.source.tickets["PROJ-90"] = fetched("PROJ-90");
  s.outputs.refine = new AgentInterruptedError();
  s.wf.refine("PROJ-90", "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-90"), "refining");
});

test("H2: recoverOnStartup marks agent runs left 'running' as interrupted before resuming", async () => {
  const s = setup();
  const ins = s.db.prepare(
    "INSERT INTO agent_run (id, role, executor, status, started_at) VALUES (?, 'refine-ticket', 'claude-code', ?, '2026-11-06T00:00:00Z')",
  );
  ins.run("r-running", "running");
  ins.run("r-ok", "ok");
  recoverOnStartup(s.db, s.wf);
  const rows = s.db.prepare("SELECT id, status, error, ended_at FROM agent_run ORDER BY id").all() as Array<Record<string, unknown>>;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId["r-running"]!.status, "error");
  assert.equal(byId["r-running"]!.error, "interrupted by restart");
  assert.ok(byId["r-running"]!.ended_at);
  assert.equal(byId["r-ok"]!.status, "ok");
  assert.equal(byId["r-ok"]!.error, null);
});

test("H2: recoverOnStartup continues past a failing resume and blocks that ticket with the error", async () => {
  const s = setup();
  for (const k of ["PROJ-91", "PROJ-92"]) {
    upsertDiscovered(s.db, summary(k), false);
    transition(s.db, k, "refining", "system");
  }
  const resumed: string[] = [];
  const wf = {
    ...s.wf,
    resume(key: string) {
      if (key === "PROJ-91") throw new Error("resume exploded");
      resumed.push(key);
    },
  };
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    recoverOnStartup(s.db, wf);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(resumed, ["PROJ-92"]);
  const t = getTicket(s.db, "PROJ-91")!;
  assert.equal(t.state, "blocked");
  assert.match(t.blockedReason!, /resume exploded/);
  assert.ok(errors.length > 0, "the failure is logged");
  assert.equal(verifyAuditChain(s.db).ok, true);
});

// ---- Task 8: multi-repo solutions and the affected repos chosen with the solution ----

const twoRepos = { projects: { PROJ: { repos: [{ name: "api", path: gitRepo("api"), baseBranch: "main" }, { name: "web", path: gitRepo("web"), baseBranch: "main" }] } } };
const apiWeb: ProposeResult = {
  solutions: [
    { ...proposal.solutions[0]!, affectedRepos: ["api", "web"], repoChanges: [{ repo: "api", summary: "endpoint" }, { repo: "web", summary: "button" }] },
    { ...proposal.solutions[1]!, affectedRepos: ["web"], repoChanges: [{ repo: "web", summary: "client CSV" }] },
  ],
};

/** A ticket proposed up to awaiting_choice with `out` as the agent's solutions. */
async function proposed(s: ReturnType<typeof setup>, key: string, out: ProposeResult = proposal) {
  s.outputs.propose = out;
  upsertDiscovered(s.db, summary(key), false);
  s.source.tickets[key] = fetched(key);
  s.wf.refine(key, "local");
  await s.queue.idle();
  assert.equal(s.state(key), "awaiting_choice");
  return listSolutions(s.db, key);
}

const choicePayloads = (s: ReturnType<typeof setup>) =>
  (s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'choice_recorded' ORDER BY id").all() as Array<{ payload_json: string }>).map(
    (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
  );
const choiceRepos = (s: ReturnType<typeof setup>, key: string) =>
  JSON.parse((s.db.prepare("SELECT affected_repos_json FROM choice WHERE ticket_key = ? ORDER BY id DESC LIMIT 1").get(key) as { affected_repos_json: string }).affected_repos_json) as string[];

test("P-C19: an unmapped project blocks propose with 'Map project PROJ to a repo in Settings' and never calls the agent", async () => {
  const s = setup({ config: { projects: {} } });
  upsertDiscovered(s.db, summary("PROJ-100"), false);
  s.source.tickets["PROJ-100"] = fetched("PROJ-100");
  s.wf.refine("PROJ-100", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "PROJ-100")!;
  assert.equal(t.state, "blocked");
  assert.equal(t.prevState, "proposing");
  assert.equal(t.blockedReason, "Map project PROJ to a repo in Settings");
  assert.deepEqual(s.calls.map((c) => c.role), ["refine-ticket"]);
});

test("a mapped repo that is not a git repository blocks propose naming the repo", async () => {
  const s = setup({ config: { projects: { PROJ: { repos: [{ name: "gone", path: join(tmpdir(), "slackoff-no-such-repo"), baseBranch: "main" }] } } } });
  upsertDiscovered(s.db, summary("PROJ-101"), false);
  s.source.tickets["PROJ-101"] = fetched("PROJ-101");
  s.wf.refine("PROJ-101", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "PROJ-101")!;
  assert.equal(t.state, "blocked");
  assert.match(t.blockedReason!, /gone/);
  assert.deepEqual(s.calls.map((c) => c.role), ["refine-ticket"]);
});

test("propose: a single repo is the only valid affected repo; the schema rejects names outside the mapping", async () => {
  const s = setup();
  s.outputs.propose = { solutions: [{ ...proposal.solutions[0]!, affectedRepos: ["billing"], repoChanges: [{ repo: "billing", summary: "x" }] }] };
  upsertDiscovered(s.db, summary("PROJ-102"), false);
  s.source.tickets["PROJ-102"] = fetched("PROJ-102");
  s.wf.refine("PROJ-102", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "PROJ-102")!;
  assert.equal(t.state, "blocked");
  assert.match(t.blockedReason!, /billing/);
});

/** The canned fake designer / critic only (Task 9): choose starts the design debate. */
const fakeDesignRun = async <T>(req: RunAgentRequest<T>): Promise<T> =>
  req.schema.parse(req.role === "critique-design" ? fakeCritique(req.prompt) : fakeDesign(req.prompt));

test("choose without affectedRepos locks the solution's set; the choice and audit carry it", async () => {
  const s = setup({ config: twoRepos });
  const [first] = await proposed(s, "PROJ-103", apiWeb);
  s.wf.choose("PROJ-103", first!.id, "both", undefined, "local");
  assert.equal(s.state("PROJ-103"), "designing");
  assert.deepEqual(choiceRepos(s, "PROJ-103"), ["api", "web"]);
  const p = choicePayloads(s).at(-1)!;
  assert.deepEqual(p.affectedRepos, ["api", "web"]);
  assert.deepEqual(p.solutionAffectedRepos, ["api", "web"]);
  assert.equal(p.decidedBy, "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-103"), "developing"); // Task 10: snapshot unchanged
});

test("choose with an edited affected set saves it; the audit records both the solution's and the chosen set and the device", async () => {
  const s = setup({ config: twoRepos });
  const [first] = await proposed(s, "PROJ-104", apiWeb);
  s.wf.choose("PROJ-104", first!.id, "web only", ["web"], "device:7");
  assert.equal(s.state("PROJ-104"), "designing");
  assert.deepEqual(choiceRepos(s, "PROJ-104"), ["web"]);
  const p = choicePayloads(s).at(-1)!;
  assert.deepEqual(p.affectedRepos, ["web"]);
  assert.deepEqual(p.solutionAffectedRepos, ["api", "web"]);
  assert.equal(p.decidedBy, "device:7");
  await s.queue.idle();
  assert.equal(s.state("PROJ-104"), "developing"); // Task 10: snapshot unchanged
});

test("choose: empty, unknown or duplicate affected repos -> ValidationError, nothing recorded", async () => {
  const s = setup({ config: twoRepos });
  const [first] = await proposed(s, "PROJ-105", apiWeb);
  for (const bad of [[], ["billing"], ["web", "web"], ["API"]]) {
    assert.throws(() => s.wf.choose("PROJ-105", first!.id, "x", bad, "local"), ValidationError, JSON.stringify(bad));
  }
  assert.equal(s.state("PROJ-105"), "awaiting_choice");
  assert.equal(choicePayloads(s).length, 0);
});

test("choose: a stored solution naming a repo that is no longer mapped -> ValidationError naming it", async () => {
  const s = setup({ config: twoRepos });
  const [first] = await proposed(s, "PROJ-106", apiWeb);
  const cfg = twoRepos.projects.PROJ.repos;
  const s2 = { ...s, wf: createWorkflow({ updater: noUpdater, db: s.db, home: s.home, queue: s.queue, source: s.source, run: fakeDesignRun, config: config({ projects: { PROJ: { repos: [cfg[1]!] } } }), bus: s.bus, hooks: { enqueueDevelop: stubDevelop(s.queue) } }) };
  assert.throws(() => s2.wf.choose("PROJ-106", first!.id, "x", undefined, "local"), (e: unknown) => e instanceof ValidationError && /api/.test(e.message));
  // editing the set to repos that are still mapped is allowed
  s2.wf.choose("PROJ-106", first!.id, "x", ["web"], "local");
  assert.deepEqual(choiceRepos(s, "PROJ-106"), ["web"]);
  await s.queue.idle();
  assert.equal(s.state("PROJ-106"), "developing"); // Task 10: snapshot unchanged
});

test("rechoose: dev_done -> awaiting_choice; choosing again records a new choice with a new set", async () => {
  const s = setup({ config: twoRepos });
  const [first, second] = await proposed(s, "PROJ-107", apiWeb);
  s.wf.choose("PROJ-107", first!.id, "both", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-107"), "developing"); // Task 10: snapshot unchanged
  transition(s.db, "PROJ-107", "dev_done", "system");
  s.wf.rechoose("PROJ-107", "local");
  assert.equal(s.state("PROJ-107"), "awaiting_choice");
  s.wf.choose("PROJ-107", second!.id, "client side", undefined, "local");
  assert.deepEqual(choiceRepos(s, "PROJ-107"), ["web"]);
  assert.equal(choicePayloads(s).length, 2);
  await s.queue.idle();
  assert.equal(s.state("PROJ-107"), "developing");
});

test("rechoose outside dev_done / awaiting_debate_ruling -> InvalidTransitionError", async () => {
  const s = setup({ config: twoRepos });
  const [first] = await proposed(s, "PROJ-108", apiWeb);
  assert.throws(() => s.wf.rechoose("PROJ-108", "local"), InvalidTransitionError);
  s.wf.choose("PROJ-108", first!.id, "x", undefined, "local");
  assert.throws(() => s.wf.rechoose("PROJ-108", "local"), InvalidTransitionError);
  assert.equal(s.state("PROJ-108"), "designing");
  await s.queue.idle();
  assert.equal(s.state("PROJ-108"), "developing"); // Task 10: snapshot unchanged
});

test("phase 4c C-3: a manual pause blocks the ticket with a Paused: reason; resuming does not rerun, Retry does", async () => {
  const gate = { check: (role: AgentRole) => budgetGate({ db: s.db, config: () => s.cfgRef, now: () => new Date() }).check(role) };
  const s = Object.assign(setup({ gate }), { cfgRef: config() });
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-6")], total: 1, complete: true };
  s.source.tickets["PROJ-6"] = fetched("PROJ-6");
  s.wf.discover();
  await s.queue.idle();
  pauseUsage(s.db, "manual", "out for lunch", "local");
  s.wf.refine("PROJ-6", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "PROJ-6")!;
  assert.equal(t.state, "blocked");
  assert.equal(t.blockedReason, "Paused: out for lunch — resume in Cost & quota, then Retry");
  assert.equal(s.calls.length, 0);
  resumeUsage(s.db, "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-6"), "blocked", "resuming does not rerun the ticket");
  s.wf.retry("PROJ-6", "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-6"), "awaiting_choice");
  assert.equal(s.calls[0]!.role, "refine-ticket");
});

test("phase 4c C-4: a UsageLimitError blocks the ticket with a Paused: reason too", async () => {
  const s = setup();
  s.source.discoverResult = { loginRequired: false, tickets: [summary("PROJ-7")], total: 1, complete: true };
  s.source.tickets["PROJ-7"] = fetched("PROJ-7");
  s.wf.discover();
  await s.queue.idle();
  s.outputs.refine = new UsageLimitError("claude failed (exit 1): Claude usage limit reached", "Claude usage limit reached");
  s.wf.refine("PROJ-7", "local");
  await s.queue.idle();
  assert.equal(getTicket(s.db, "PROJ-7")!.blockedReason, "Paused: Claude usage limit reached — resume in Cost & quota, then Retry");
  assert.ok(!s.events.some((e) => e.type === "source_error"));
  void UsagePausedError;
});

// ---- read the ticket from JIRA without refining (a discovered ticket's snapshot, on request) ----

import { listSnapshots } from "../src/snapshots/snapshot-store.ts";

test("readSnapshot: a discovered ticket gets its snapshot, stays discovered, runs no agent beyond the read", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-40"), false);
  s.source.tickets["PROJ-40"] = fetched("PROJ-40");
  const auditsBefore = s.audits().length;
  s.wf.readSnapshot("PROJ-40");
  await s.queue.idle();
  assert.equal(s.state("PROJ-40"), "discovered");
  assert.equal(listSnapshots(s.db, "PROJ-40").length, 1);
  assert.equal(s.calls.length, 0);
  // the capture is audited like any snapshot; nothing else is
  assert.deepEqual(s.audits().slice(auditsBefore), ["snapshot_created"]);
  assert.ok(s.events.some((e) => e.type === "snapshot_changed" && e.ticketKey === "PROJ-40" && !e.needsAck));
  assert.ok(!s.events.some((e) => e.type === "state_changed"));
  assert.ok(s.events.some((e) => e.type === "ticket_read" && e.ticketKey === "PROJ-40" && e.ok));
  // refining later reuses the same content: still one snapshot
  s.wf.refine("PROJ-40", "local");
  await s.queue.idle();
  assert.equal(listSnapshots(s.db, "PROJ-40").length, 1);
});

test("readSnapshot: any ticket that is not finished; a later read of the same content adds no snapshot and changes no state", async () => {
  const s = setup();
  assert.throws(() => s.wf.readSnapshot("NOPE-1"));
  upsertDiscovered(s.db, summary("PROJ-41"), false);
  s.source.tickets["PROJ-41"] = fetched("PROJ-41");
  s.wf.refine("PROJ-41", "local");
  await s.queue.idle();
  const state = s.state("PROJ-41");
  s.wf.readSnapshot("PROJ-41");
  await s.queue.idle();
  assert.equal(s.state("PROJ-41"), state);
  assert.equal(listSnapshots(s.db, "PROJ-41").length, 1);
  s.wf.abandon("PROJ-41", "local");
  assert.throws(() => s.wf.readSnapshot("PROJ-41"), InvalidTransitionError);
});

test("readSnapshot: an expired JIRA login emits source_error and leaves the ticket discovered, no snapshot", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-42"), false);
  s.source.tickets["PROJ-42"] = new JiraLoginRequiredError();
  s.wf.readSnapshot("PROJ-42");
  await s.queue.idle();
  assert.equal(s.state("PROJ-42"), "discovered");
  assert.equal(listSnapshots(s.db, "PROJ-42").length, 0);
  const err = s.events.find((e) => e.type === "source_error");
  assert.match(err?.type === "source_error" ? err.message : "", /JIRA login required/);
  assert.ok(s.events.some((e) => e.type === "ticket_read" && e.ticketKey === "PROJ-42" && !e.ok));
  // a loginRequired answer (not thrown) is the same
  s.source.tickets["PROJ-42"] = { ...fetched("PROJ-42"), loginRequired: true };
  s.wf.readSnapshot("PROJ-42");
  await s.queue.idle();
  assert.equal(listSnapshots(s.db, "PROJ-42").length, 0);
  assert.equal(s.events.filter((e) => e.type === "source_error").length, 2);
});

test("an incomplete read without a count (JIRA did not show it) still flags the snapshot and asks the open question", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-43"), false);
  s.source.tickets["PROJ-43"] = { ...fetched("PROJ-43"), description: "Add an export button.\n\n[slackoff: unknown number of older comments not loaded]" };
  s.wf.refine("PROJ-43", "local");
  await s.queue.idle();
  const snap = listSnapshots(s.db, "PROJ-43")[0]!;
  assert.equal(snap.commentsNotLoaded, 0);
  const req = latestRequirement(s.db, "PROJ-43")!;
  assert.ok(req.content.openQuestions.some((q) => q.text === "Some older comments were not loaded — check JIRA"));
  assert.match(String(s.calls[0]!.prompt), /some older comments were not loaded/);
  assert.doesNotMatch(String(s.calls[0]!.prompt), /\[slackoff:/);
});

// ---- the base branch per ticket (develop for features, a release branch for fixes) ----

import { execFileSync as gitExec } from "node:child_process";
import { setRepoWorkspace } from "../src/tickets/ticket-repo.ts";

test("setBaseBranch: per ticket and repo, until that repo's ticket branch exists; propose and later steps use it", async () => {
  gitExec("git", ["-C", PROJ_REPO, "branch", "-f", "release/1.32.0", "main"]);
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-60"), false);
  s.source.tickets["PROJ-60"] = fetched("PROJ-60");
  // the default is the mapping's
  assert.deepEqual((await s.wf.baseBranches("PROJ-60")).map((r) => [r.name, r.default, r.chosen, r.locked]), [["proj", "main", null, false]]);
  assert.ok((await s.wf.baseBranches("PROJ-60"))[0]!.options.includes("release/1.32.0"));
  await s.wf.setBaseBranch("PROJ-60", "proj", "release/1.32.0", "local");
  assert.equal((await s.wf.baseBranches("PROJ-60"))[0]!.chosen, "release/1.32.0");
  assert.ok(s.audits().includes("base_branch_chosen"));
  // propose reads the repo from the chosen base
  s.wf.refine("PROJ-60", "local");
  await s.queue.idle();
  const proposeCall = s.calls.find((c) => c.role === "propose-solutions")!;
  assert.match(proposeCall.prompt, /"baseBranch": "release\/1\.32\.0"/);
  // back to the default
  await s.wf.setBaseBranch("PROJ-60", "proj", null, "local");
  assert.equal((await s.wf.baseBranches("PROJ-60"))[0]!.chosen, null);
  // refused: unknown repo, a branch that is nowhere, an invalid name
  await assert.rejects(s.wf.setBaseBranch("PROJ-60", "nope", "main", "local"), ValidationError);
  await assert.rejects(s.wf.setBaseBranch("PROJ-60", "proj", "release/9.9.9", "local"), /release\/9\.9\.9 is not a branch of proj/);
  await assert.rejects(s.wf.setBaseBranch("PROJ-60", "proj", "bad..name", "local"), ValidationError);
  // locked once the ticket branch exists for that repo
  setRepoWorkspace(s.db, "PROJ-60", { repo: "proj", repoPath: PROJ_REPO, baseBranch: "main", branch: "slackoff/PROJ-60-x", worktreePath: "/tmp/x" });
  assert.equal((await s.wf.baseBranches("PROJ-60"))[0]!.locked, true);
  await assert.rejects(s.wf.setBaseBranch("PROJ-60", "proj", "release/1.32.0", "local"), InvalidTransitionError);
});

// ---- skip the design debate: one design, final at once, no critic ----

import { listDesignDocs } from "../src/design/design-repo.ts";

test("choose with skipDebate: the designer writes once, the doc is final, no critic runs; the choice records it", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-70"), false);
  s.source.tickets["PROJ-70"] = fetched("PROJ-70");
  s.wf.refine("PROJ-70", "local");
  await s.queue.idle();
  assert.equal(s.state("PROJ-70"), "awaiting_choice");
  const sol = listSolutions(s.db, "PROJ-70")[0]!;
  const before = s.calls.length;
  s.wf.choose("PROJ-70", sol.id, "straightforward", undefined, "local", true);
  await s.queue.idle();
  const roles = s.calls.slice(before).map((c) => c.role);
  assert.deepEqual(roles.filter((r) => r === "design-solution" || r === "critique-design"), ["design-solution"]);
  const docs = listDesignDocs(s.db, "PROJ-70");
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.isFinal, true);
  assert.notEqual(s.state("PROJ-70"), "designing");
  assert.notEqual(s.state("PROJ-70"), "awaiting_debate_ruling");
  const rec = (s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'choice_recorded' ORDER BY id DESC LIMIT 1").get() as { payload_json: string }).payload_json;
  assert.equal(JSON.parse(rec).skipDebate, true);
});

test("choose without skipDebate still debates (a critic runs)", async () => {
  const s = setup();
  upsertDiscovered(s.db, summary("PROJ-71"), false);
  s.source.tickets["PROJ-71"] = fetched("PROJ-71");
  s.wf.refine("PROJ-71", "local");
  await s.queue.idle();
  const sol = listSolutions(s.db, "PROJ-71")[0]!;
  s.wf.choose("PROJ-71", sol.id, "", undefined, "local");
  await s.queue.idle();
  assert.ok(s.calls.some((c) => c.role === "critique-design"));
});

// ---- the ticket branch's conventional type ----

test("branchType: guessed from the title until chosen; locked once a ticket branch exists; development names the branch with it", async () => {
  const s = setup();
  upsertDiscovered(s.db, { ...summary("PROJ-80"), title: "Totals broken on export" }, false);
  assert.deepEqual(s.wf.branchType("PROJ-80"), { type: "fix", chosen: false, locked: false, name: "fix/PROJ-80-totals-broken-on-export" });
  s.wf.setBranchType("PROJ-80", "chore", "local");
  assert.deepEqual(s.wf.branchType("PROJ-80"), { type: "chore", chosen: true, locked: false, name: "chore/PROJ-80-totals-broken-on-export" });
  assert.ok(s.audits().includes("branch_type_chosen"));
  assert.throws(() => s.wf.setBranchType("PROJ-80", "feature" as never, "local"), ValidationError);
  s.wf.setBranchType("PROJ-80", null, "local");
  assert.equal(s.wf.branchType("PROJ-80").type, "fix");
  setRepoWorkspace(s.db, "PROJ-80", { repo: "proj", repoPath: PROJ_REPO, baseBranch: "main", branch: "fix/PROJ-80-totals-broken-on-export", worktreePath: "/tmp/y" });
  assert.deepEqual(s.wf.branchType("PROJ-80"), { type: "fix", chosen: false, locked: true, name: "fix/PROJ-80-totals-broken-on-export" });
  assert.throws(() => s.wf.setBranchType("PROJ-80", "feat", "local"), InvalidTransitionError);
});
