// Phase 4d Task 5 (D-7, D-8): a prompt draft tried on the fictional sample ticket — read-only roles, nothing saved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TRIAL_ROLES, type AgentRole, type FetchedTicket } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { runAgent, type RunAgentRequest } from "../src/executor/run-agent.ts";
import type { ExecRequest, Executor } from "../src/executor/types.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import { savePrompt } from "../src/prompts/prompt-store.ts";
import { runTrial } from "../src/prompts/trial-run.ts";
import { fakeRun } from "../src/dev/fake-mode.ts";
import { ValidationError } from "../src/tickets/errors.ts";
import { SandboxPolicyError } from "../src/executor/sandbox.ts";
import { budgetGate, pauseUsage } from "../src/cost/budget-gate.ts";
import { loadConfig } from "../src/config.ts";
import { upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { verifyAuditChain } from "../src/audit/audit-log.ts";
import { tmpDir } from "./helpers/tmp.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const DRAFT = "TRIAL-DRAFT: keep answers short.";

test("the trial roles are the four read-only ones", () => {
  assert.deepEqual([...TRIAL_ROLES], ["refine-ticket", "propose-solutions", "design-solution", "critique-design"]);
});

test("each trial role: purpose trial, the draft as additions, no ticket, no repo rules, no retry; cwd a scratch copy deleted afterwards", async () => {
  const tmpRoot = tmpDir("trial-root");
  for (const role of TRIAL_ROLES) {
    const seen: Array<RunAgentRequest<unknown>> = [];
    let cwdExisted = false;
    const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
      seen.push(req as RunAgentRequest<unknown>);
      cwdExisted = existsSync(join(req.cwd, "src", "report", "weekly.js"));
      req.onRunStart?.("run-" + role);
      return fakeRun(req);
    };
    const r = await runTrial({ run, repoRoot, tmpRoot }, role, DRAFT);
    assert.equal(r.ok, true, `${role}: ${r.error}`);
    assert.equal(r.role, role);
    assert.equal(r.runId, "run-" + role);
    assert.equal(r.error, null);
    assert.ok(r.output !== null);
    assert.ok(r.durationMs >= 0);
    const req = seen[0]!;
    assert.equal(seen.length, 1);
    assert.equal(req.role, role);
    assert.equal(req.purpose, "trial");
    assert.equal(req.additionsOverride, DRAFT);
    assert.equal(req.ticketKey, undefined);
    assert.equal(req.repos, undefined);
    assert.equal(req.retries, 0);
    assert.equal(req.chrome, false);
    assert.deepEqual(req.allowedTools, role === "refine-ticket" ? [] : ["Read", "Grep", "Glob"]);
    assert.ok(cwdExisted, `${role}: the sample repo was copied`);
    assert.ok(!relative(tmpRoot, req.cwd).startsWith(".."), `${role}: cwd under tmpRoot`);
    assert.ok(!existsSync(req.cwd), `${role}: the scratch copy is removed`);
    assert.match(req.prompt, /SAMPLE-1|Export the weekly report as CSV|weekly-report/);
  }
  assert.deepEqual(readdirSync(tmpRoot), []);
});

test("prompt shapes follow the real jobs: refine snapshot, propose repos + requirement, design draft, critique round 1", async () => {
  const tmpRoot = tmpDir("trial-shapes");
  const prompts: Record<string, string> = {};
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => ((prompts[req.role] = req.prompt), fakeRun(req));
  for (const role of TRIAL_ROLES) await runTrial({ run, repoRoot, tmpRoot }, role, DRAFT);
  assert.match(prompts["refine-ticket"]!, /^mode: refine\n\nsnapshot:\n```json\n/);
  assert.match(prompts["refine-ticket"]!, /"key": "SAMPLE-1"/);
  assert.match(prompts["propose-solutions"]!, /^repos:\n```json\n/);
  assert.match(prompts["propose-solutions"]!, /\nrequirement:\n```json\n/);
  assert.match(prompts["design-solution"]!, /^mode: draft\n\naffectedRepos:\n```json\n/);
  assert.match(prompts["design-solution"]!, /\nsolution:\n```json\n/);
  assert.match(prompts["design-solution"]!, /\ndeveloperNote:\n```json\n""\n```/);
  assert.match(prompts["critique-design"]!, /^mode: critique\n\nround:\n```json\n1\n```/);
  assert.match(prompts["critique-design"]!, /\ndesign:\n```json\n/);
  assert.match(prompts["critique-design"]!, /\nhistory:\n```json\n\[\]\n```/);
});

test("write roles, JIRA roles and acceptance are refused (ValidationError) before anything runs; an over-long draft too", async () => {
  const tmpRoot = tmpDir("trial-refuse");
  let ran = 0;
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => (ran++, fakeRun(req));
  for (const role of ["implement-ticket", "acceptance-review", "jira-browser", "jira-update", "jira-comment"] as AgentRole[]) {
    await assert.rejects(runTrial({ run, repoRoot, tmpRoot }, role, DRAFT), ValidationError, role);
  }
  await assert.rejects(runTrial({ run, repoRoot, tmpRoot }, "refine-ticket", "x".repeat(20_001)), ValidationError);
  assert.equal(ran, 0);
  assert.deepEqual(readdirSync(tmpRoot), []);
});

/** A real runAgent over a fake executor that records the system prompt (no claude). */
function realRun(db: ReturnType<typeof openDatabase>, home: string, o: { role?: AgentRole; fail?: boolean; gate?: { check(role: AgentRole): void } } = {}) {
  const seen: ExecRequest[] = [];
  const executor: Executor = {
    kind: "claude-code",
    exec: async (r) => {
      seen.push(r);
      if (o.fail) throw new Error("boom from the agent");
      const out = await fakeRun({ role: o.role ?? "refine-ticket", prompt: r.prompt, purpose: "trial", schema: { parse: (x: unknown) => x } } as never);
      return { text: "```json\n" + JSON.stringify(out) + "\n```", usage: null, costUsd: 0.01, permissionDenials: [] };
    },
  };
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const run = <T>(req: RunAgentRequest<T>) => runAgent({ db, repoRoot, executor, home, bus, ...(o.gate ? { gate: o.gate } : {}) }, req);
  return { run, seen, events };
}

const counts = (db: ReturnType<typeof openDatabase>) =>
  Object.fromEntries(["ticket", "requirement", "solution", "design_doc", "ticket_snapshot", "choice", "prompt_version", "preference_signal"].map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));

test("real runAgent: the system prompt has the draft, not the saved text; agent_run is a trial row with the draft hash; audited; nothing else written", async () => {
  const home = tmpDir("trial-home");
  const db = openDatabase(join(home, "t.db"));
  savePrompt(db, "refine-ticket", "SAVED-TEXT: be verbose.");
  upsertDiscovered(db, { key: "T-1", title: "t", url: "https://your-company.atlassian.net/browse/T-1", status: "To Do" }, false);
  const f: FetchedTicket = { loginRequired: false, key: "T-1", title: "t", description: "d", jiraUpdatedAt: null, status: null, comments: [], attachments: [] };
  saveSnapshot(db, home, "T-1", f);
  const before = counts(db);
  const { run, seen, events } = realRun(db, home);
  const r = await runTrial({ run, repoRoot, tmpRoot: tmpDir("trial-tmp") }, "refine-ticket", DRAFT);
  assert.equal(r.ok, true, r.error ?? "");
  assert.ok(seen[0]!.systemPrompt.includes(DRAFT));
  assert.ok(!seen[0]!.systemPrompt.includes("SAVED-TEXT"));
  assert.deepEqual(counts(db), before);
  const row = db.prepare("SELECT * FROM agent_run").get() as Record<string, unknown>;
  assert.equal(row.id, r.runId);
  assert.equal(row.purpose, "trial");
  assert.equal(row.ticket_key, null);
  assert.equal(row.prompt_version_id, null);
  assert.equal(row.draft_hash, createHash("sha256").update(DRAFT).digest("hex").slice(0, 12));
  assert.equal(row.status, "ok");
  const audit = db.prepare("SELECT actor, ticket_key, payload_json FROM audit_event WHERE type = 'prompt_trial_run'").all() as Array<{ actor: string; ticket_key: string | null; payload_json: string }>;
  assert.deepEqual(audit.map((a) => [a.actor, a.ticket_key, JSON.parse(a.payload_json)]), [["developer", null, { role: "refine-ticket", runId: r.runId, draftLength: DRAFT.length }]]);
  assert.equal(verifyAuditChain(db).ok, true);
  // the live events of a trial carry no ticket and say they are a trial
  const live = events.filter((e) => e.type === "agent_event");
  assert.ok(live.every((e) => e.type === "agent_event" && e.ticketKey === undefined && e.trial === true));
});

test("a failing agent → ok:false with the (redacted) error; no ticket is blocked or touched", async () => {
  const home = tmpDir("trial-fail");
  const db = openDatabase(join(home, "t.db"));
  upsertDiscovered(db, { key: "T-1", title: "t", url: "https://your-company.atlassian.net/browse/T-1", status: "To Do" }, false);
  const before = counts(db);
  const { run } = realRun(db, home, { fail: true });
  const r = await runTrial({ run, repoRoot, tmpRoot: tmpDir("trial-tmp2") }, "propose-solutions", DRAFT);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /boom from the agent/);
  assert.equal(r.output, null);
  assert.deepEqual(counts(db), before);
  assert.equal((db.prepare("SELECT state FROM ticket").get() as { state: string }).state, "discovered");
  assert.equal((db.prepare("SELECT status, purpose FROM agent_run").get() as { status: string; purpose: string }).purpose, "trial");
});

test("4c gate: while usage is paused a trial does not run → ok:false, error starting with Paused:", async () => {
  const home = tmpDir("trial-gate");
  const db = openDatabase(join(home, "t.db"));
  const config = loadConfig(home);
  pauseUsage(db, "manual", "stop for now", "local");
  const { run, seen } = realRun(db, home, { gate: budgetGate({ db, config: () => config }) });
  const r = await runTrial({ run, repoRoot, tmpRoot: tmpDir("trial-tmp3") }, "critique-design", DRAFT);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /^Paused:/);
  assert.equal(r.runId, null);
  assert.equal(seen.length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_run").get() as { n: number }).n, 0);
});

test("runAgent refuses a trial with a ticket or repos, and an additions override outside a trial", async () => {
  const home = tmpDir("trial-guards");
  const db = openDatabase(join(home, "t.db"));
  const { run } = realRun(db, home);
  const base = { role: "refine-ticket" as const, prompt: "p", cwd: home, allowedTools: [], chrome: false, schema: (await import("@slackoff/shared")).Requirement, retries: 0 };
  await assert.rejects(run({ ...base, purpose: "trial", additionsOverride: "d", ticketKey: "T-1" }), SandboxPolicyError);
  await assert.rejects(run({ ...base, purpose: "trial", additionsOverride: "d", repos: [] as never[] }), SandboxPolicyError);
  await assert.rejects(run({ ...base, additionsOverride: "d" }), SandboxPolicyError);
  await assert.rejects(run({ ...base, role: "implement-ticket" as never, purpose: "trial", additionsOverride: "d" }), SandboxPolicyError);
  // F4D-1 (M7): nor extra directories, an acceptance work dir, a process-group file or an isolation
  const trial = { ...base, purpose: "trial" as const, additionsOverride: "d" };
  await assert.rejects(run({ ...trial, addDirs: [home] }), (e: Error) => e instanceof SandboxPolicyError && /directories/.test(e.message));
  await assert.rejects(run({ ...trial, policy: { workDir: home } }), (e: Error) => e instanceof SandboxPolicyError && /work dir/.test(e.message));
  await assert.rejects(run({ ...trial, pgidFile: join(home, "pgids") }), (e: Error) => e instanceof SandboxPolicyError && /process-group/.test(e.message));
  await assert.rejects(
    run({ ...trial, isolation: { claudeConfigDir: home, shimDir: home, sandbox: {} as never } }),
    (e: Error) => e instanceof SandboxPolicyError && /isolat/.test(e.message),
  );
  // an empty addDirs list is no extra directory
  await run({ ...trial, addDirs: [] });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM agent_run").get() as { n: number }).n, 1);
  db.prepare("DELETE FROM agent_run").run();
});

test("skills/samples is fictional: no real-looking JIRA host, no email except example.com", () => {
  const dir = join(repoRoot, "skills", "samples");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  assert.ok(files.length >= 10);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/([a-z0-9-]+)\.atlassian\.net/gi)) assert.equal(m[1], "your-company", `${f}: ${m[0]}`);
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) assert.equal(m[1], "example.com", `${f}: an email`);
  }
  assert.ok(!existsSync(join(dir, "sample-repo", ".slackoff")));
});
