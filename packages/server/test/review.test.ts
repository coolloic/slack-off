// Task 9: the acceptance flow — hand-off, the drift check before review, the acceptance job (export, isolation checks,
// target apps, the sandboxed agent, the platform's own re-run, verdicts), the failure loop back to development,
// reject / re-review, the attempt cap, abandon, shutdown and restart recovery.
//
// Real throwaway git repos `api` and `web` (web carries the Task 6 fixture app), a fake ticket source, fake
// implement-ticket / refine-ticket runs and the real runAgent with a fake executor for acceptance-review (no `claude`
// binary is ever run). The target app, its install / stop and the platform re-run really run under sandbox-exec, so
// the flow tests need macOS; the nextReviewStep table runs everywhere.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { connect as netConnect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  AcceptanceResult, DevStepResult, DriftResult, FetchedTicket, IterationRecord, ProposeResult, Requirement, ReviewReportRecord, ReviewSeriesRecord,
} from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import { runAgent, type RunAgentRequest } from "../src/executor/run-agent.ts";
import { AgentInterruptedError, type ExecRequest, type Executor } from "../src/executor/types.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow, type Workflow } from "../src/workflow/jobs.ts";
import { recoverOnStartup } from "../src/workflow/recovery.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { getTicket, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { ValidationError } from "../src/tickets/errors.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { addRequirement, listSolutions, recordChoice, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { addDesignDoc, markFinal } from "../src/design/design-repo.ts";
import { listIterations } from "../src/development/dev-repo.ts";
import { acknowledgeDrift, latestDrift, saveDrift } from "../src/drift/drift-repo.ts";
import { currentSeries, listReports, openAcceptanceRuns, saveReport, startSeries } from "../src/acceptance/review-repo.ts";
import { nextReviewStep } from "../src/acceptance/review-step.ts";
import { runSummary, type AcceptanceTestHooks } from "../src/acceptance/review-jobs.ts";
import { PlatformProcesses, killLeftovers } from "../src/acceptance/app-runner.ts";
import { acceptRunBase } from "../src/acceptance/workspace.ts";
import { SANDBOX_EXEC, type SandboxCheck, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { redactorWith } from "../src/credentials/credential-store.ts";

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const SKIP = HAS_SANDBOX ? false : `the acceptance flow needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;
/** a flow test: real sandbox-exec, real target app, real Playwright re-run */
const flow = (name: string, fn: () => Promise<void>, timeout = 180_000) => nodeTest(name, { skip: SKIP, timeout }, fn);
const test = nodeTest;

const KEY = "FAKE-1";
const FIXTURE = join(import.meta.dirname, "fixtures/acceptance-app");
const repoRoot = resolve(import.meta.dirname, "../../..");

const roots: string[] = [];
const processesToKill: PlatformProcesses[] = [];
after(() => {
  for (const p of processesToKill) p.killAll();
  for (const r of roots) {
    // run roots of this file's runs (outside `r`): killed and removed by the tests themselves; this is a safety net
    rmSync(r, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- nextReviewStep (pure)

const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s)).toISOString();
const seriesRec = (id: number, startedBy: ReviewSeriesRecord["startedBy"] = "handoff", s = 0): ReviewSeriesRecord => ({
  id, startedBy, note: null, decidedBy: "local", createdAt: at(s),
});
const reportRec = (id: number, seriesId: number, attempt: number, verdict: ReviewReportRecord["verdict"], s: number): ReviewReportRecord => ({
  id, seriesId, attempt, verdict, developerNote: null, snapshotId: 1, createdAt: at(s),
  report: {
    verdict, notExecutedReason: null, summary: "", targets: [], acs: [], specRun: null, projectE2e: [],
    isolation: { ok: true, checks: [], excluded: [] }, commits: [],
  },
});
const iterRec = (id: number, trigger: IterationRecord["trigger"], status: IterationRecord["status"], start: number, end: number | null): IterationRecord => ({
  id, iteration: id, trigger, note: null, status, summary: null, startedAt: at(start), endedAt: end === null ? null : at(end),
});

test("nextReviewStep: the decision table (current series only; carry only while the series has no report)", () => {
  const s1 = seriesRec(1);
  const init = iterRec(1, "initial", "done", 0, 1);
  // no report, no carry → accept 1
  assert.deepEqual(nextReviewStep({ series: s1, reports: [], decisions: [], carry: null, iterations: [init], maxAttempts: 3 }), { kind: "accept", attempt: 1 });
  // attempt 1 failed, no iteration after it → fix it
  const r1 = reportRec(10, 1, 1, "failed", 10);
  assert.deepEqual(nextReviewStep({ series: s1, reports: [r1], decisions: [], carry: null, iterations: [init], maxAttempts: 3 }), { kind: "fix", reportId: 10 });
  // a fix iteration started after it, still running → still fix (nothing completed since)
  const fixRunning = iterRec(2, "review_failed", "running", 10, null);
  assert.deepEqual(nextReviewStep({ series: s1, reports: [r1], decisions: [], carry: null, iterations: [init, fixRunning], maxAttempts: 3 }), { kind: "fix", reportId: 10 });
  // the fix iteration completed → accept 2
  const fix1 = iterRec(2, "review_failed", "done", 10, 20);
  assert.deepEqual(nextReviewStep({ series: s1, reports: [r1], decisions: [], carry: null, iterations: [init, fix1], maxAttempts: 3 }), { kind: "accept", attempt: 2 });
  // max 3: the third failed → cap reached
  const r2 = reportRec(11, 1, 2, "failed", 30);
  const fix2 = iterRec(3, "review_failed", "done", 30, 40);
  const r3 = reportRec(12, 1, 3, "failed", 50);
  assert.deepEqual(
    nextReviewStep({ series: s1, reports: [r1, r2, r3], decisions: [], carry: null, iterations: [init, fix1, fix2], maxAttempts: 3 }),
    { kind: "cap_reached", attempts: 3 },
  );
  // passed → await the developer's decision
  const p1 = reportRec(20, 1, 1, "passed", 10);
  assert.deepEqual(nextReviewStep({ series: s1, reports: [p1], decisions: [], carry: null, iterations: [init], maxAttempts: 3 }), { kind: "await_decision", reportId: 20 });
  // not_executed → await the developer's decision too
  const n1 = reportRec(21, 1, 1, "not_executed", 10);
  assert.deepEqual(nextReviewStep({ series: s1, reports: [n1], decisions: [], carry: null, iterations: [init], maxAttempts: 3 }), { kind: "await_decision", reportId: 21 });
  // passed with a re_review decision → accept n+1; at n = max → cap reached
  assert.deepEqual(
    nextReviewStep({ series: s1, reports: [p1], decisions: [{ reportId: 20, decision: "re_review" }], carry: null, iterations: [init], maxAttempts: 3 }),
    { kind: "accept", attempt: 2 },
  );
  const p2 = reportRec(22, 1, 2, "passed", 20);
  const p3 = reportRec(23, 1, 3, "passed", 30);
  assert.deepEqual(
    nextReviewStep({
      series: s1, reports: [p1, p2, p3], decisions: [{ reportId: 20, decision: "re_review" }, { reportId: 22, decision: "re_review" }, { reportId: 23, decision: "re_review" }],
      carry: null, iterations: [init], maxAttempts: 3,
    }),
    { kind: "cap_reached", attempts: 3 },
  );
  // a re_review decision on an older report does not count for the latest one
  assert.deepEqual(
    nextReviewStep({ series: s1, reports: [p1, p2], decisions: [{ reportId: 20, decision: "re_review" }], carry: null, iterations: [init], maxAttempts: 3 }),
    { kind: "await_decision", reportId: 22 },
  );
  // a new series (retry) without a report, the carry failed → fix the carry first
  const s2retry = seriesRec(2, "retry", 60);
  assert.deepEqual(nextReviewStep({ series: s2retry, reports: [], decisions: [], carry: r3, iterations: [init, fix1, fix2], maxAttempts: 3 }), { kind: "fix", reportId: 12 });
  // … and once that fix iteration completed → accept 1 of the new series
  const fix3 = iterRec(4, "review_failed", "done", 60, 70);
  assert.deepEqual(nextReviewStep({ series: s2retry, reports: [], decisions: [], carry: r3, iterations: [init, fix1, fix2, fix3], maxAttempts: 3 }), { kind: "accept", attempt: 1 });
  // a new series (rejected) without a report, the carry passed → accept 1
  const s2rej = seriesRec(2, "rejected", 60);
  assert.deepEqual(nextReviewStep({ series: s2rej, reports: [], decisions: [], carry: p1, iterations: [init], maxAttempts: 3 }), { kind: "accept", attempt: 1 });
  // the carry is ignored once the series has a report of its own
  const s2r1 = reportRec(30, 2, 1, "passed", 80);
  assert.deepEqual(nextReviewStep({ series: s2retry, reports: [s2r1], decisions: [], carry: r3, iterations: [init], maxAttempts: 3 }), { kind: "await_decision", reportId: 30 });
  // attempts count in the current series only: series 2's first failure is fixed even though series 1 used 3
  const s2f1 = reportRec(31, 2, 1, "failed", 80);
  assert.deepEqual(nextReviewStep({ series: s2retry, reports: [s2f1], decisions: [], carry: r3, iterations: [init, fix3], maxAttempts: 3 }), { kind: "fix", reportId: 31 });
});

test("nextReviewStep (T9-6 L1): 'after the report' compares iteration ids, never wall-clock times", () => {
  const s1 = seriesRec(1);
  // the report was saved when iteration 1 was the latest; iteration 2 (the fix) completed, though its clock reads earlier
  const r1 = { ...reportRec(10, 1, 1, "failed", 50), afterIterationId: 1 };
  const fix = iterRec(2, "review_failed", "done", 40, 45);
  assert.deepEqual(nextReviewStep({ series: s1, reports: [r1], decisions: [], carry: null, iterations: [iterRec(1, "initial", "done", 0, 1), fix], maxAttempts: 3 }), { kind: "accept", attempt: 2 });
  // and an iteration that existed when the report was saved never counts, whatever its clock says
  const r2 = { ...reportRec(11, 1, 1, "failed", 10), afterIterationId: 2 };
  assert.deepEqual(nextReviewStep({ series: s1, reports: [r2], decisions: [], carry: null, iterations: [iterRec(1, "initial", "done", 0, 1), iterRec(2, "developer_request", "done", 20, 30)], maxAttempts: 3 }), { kind: "fix", reportId: 11 });
});

test("runSummary (T9-3): Playwright's closing summary, the last block after the last 'Running' line; none → null", () => {
  assert.deepEqual(runSummary("\nRunning 2 tests using 1 worker\n\n[1/2] x\n  2 passed (221ms)\n"), { passed: 2, total: 2 });
  const failed = "Running 3 tests using 1 worker\n  1) [chromium] › specs/a.spec.mjs › AC-2\n    Error: x\n  1 failed\n    [chromium] › specs/a.spec.mjs › AC-2\n  1 skipped\n  1 passed (1.1s)\n";
  assert.deepEqual(runSummary(failed), { passed: 1, total: 3 });
  // the last value of each count wins (a spec can print such lines itself: a documented residual of the cross-check)
  assert.deepEqual(runSummary("  9 passed\nRunning 1 test using 1 worker\n  9 passed\n  1 failed\n"), { passed: 9, total: 10 });
  assert.equal(runSummary("Error: no tests found\n"), null);
});

test("acceptRunBase: a temp dir under /private/tmp/claude-* (a Claude Code shell) is skipped for the real /tmp", () => {
  // a path that does not exist: nothing is created or written
  assert.equal(acceptRunBase("/private/tmp/claude-501/some-session/scratch"), realpathSync("/tmp"));
  assert.equal(acceptRunBase("/private/tmp/claude-"), realpathSync("/tmp"));
});

// ---------------------------------------------------------------- the flow harness

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

type Files = Record<string, string>;
function makeRepo(parent: string, name: string, files: Files): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "commit.gpgsign", "false");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    // phase 4f: a CLI under bin/ is committed executable
    writeFileSync(join(dir, p), content, { mode: p.startsWith("bin/") ? 0o755 : 0o644 });
  }
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}
const cfgJson = (c: unknown) => JSON.stringify(c, null, 2) + "\n";

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}
function listen(port: number): Promise<Server> {
  return new Promise((res, rej) => {
    const server = createServer((c) => c.end());
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res(server));
  });
}
async function waitFor(cond: () => boolean, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}
/** any process of the group still running (ps, not a signal; zombies do not count) */
function groupAlive(pgid: number): boolean {
  const out = execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  return out.split("\n").some((l) => {
    const [g, stat] = l.trim().split(/\s+/);
    return Number(g) === pgid && !stat?.startsWith("Z");
  });
}
/** is anything answering on 127.0.0.1:port */
function answering(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = netConnect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      res(true);
    });
    s.once("error", () => res(false));
  });
}

const DESIGN_LINE = "MARK-DESIGN: the export streams the order rows from the database in pages of five hundred rows";

const requirement: Requirement = {
  background: "Shop owners export orders.",
  functional: [{ id: "FR-1", text: "export orders" }],
  acceptanceCriteria: [
    { id: "AC-1", text: "The shop answers its health check", verifiable: true, source: { type: "description", ref: "description", quote: "MARK-QUOTE" } },
    { id: "AC-2", text: "An empty cart cannot be checked out", verifiable: true, source: { type: "developer", reason: "MARK-QUOTE" } },
  ],
  discussionOutcomes: [],
  openQuestions: [{ kind: "missing", text: "MARK-OPEN" }],
  draftComment: null,
};
const fetchedTicket: FetchedTicket = {
  loginRequired: false, key: KEY, title: "Export orders", description: "Export.", jiraUpdatedAt: null, status: null, comments: [], attachments: [],
};
const proposal: ProposeResult = {
  solutions: [
    { title: "Both", approach: "MARK-SOLUTION approach", changeScope: [], pros: [], cons: [], risks: [], complexity: "M", affectedRepos: ["api", "web"], repoChanges: [{ repo: "api", summary: "x" }, { repo: "web", summary: "y" }] },
  ],
};
const DRIFT_OK: DriftResult = { baseline: [{ id: "AC-1", status: "covered", coveredBy: ["AC-1"], note: "" }], current: [{ id: "AC-1", status: "mapped" }], contradictions: [] };
const DRIFT_ACK: DriftResult = { baseline: [{ id: "AC-1", status: "missing", coveredBy: [], note: "gone" }], current: [], contradictions: [] };

/** What the fake acceptance agent sees and may do. */
interface AgentCtx {
  call: number;
  exec: ExecRequest;
  req: RunAgentRequest<unknown>;
  workDir: string;
  write(rel: string, content: string): void;
}
type AgentFn = (c: AgentCtx) => AcceptanceResult | Promise<AcceptanceResult>;

const SPEC_FILE = "specs/ac.spec.mjs";
const title = (t: string) => `${SPEC_FILE} › ${t}`;

/** A clean spec (passes the spec guard): one request-only test per entry, each attaching its response as evidence. */
function spec(tests: Array<{ name: string; body?: string }>): string {
  return [
    "import { test, expect } from '@playwright/test';",
    ...tests.map(
      (t) => `test(${JSON.stringify(t.name)}, async ({ request }, testInfo) => {
  const r = await request.get('/health');
  await testInfo.attach('response', { body: JSON.stringify({ status: r.status(), body: await r.text() }), contentType: 'application/json' });
${t.body ?? "  expect(r.status()).toBe(200);"}
});`,
    ),
    "",
  ].join("\n");
}
/** The agent's result: per AC its verdict, both citing the test of that AC. */
function result(verdicts: Record<string, "pass" | "fail">): AcceptanceResult {
  return {
    summary: "checked",
    acs: Object.entries(verdicts).map(([acId, verdict]) => ({
      acId,
      verdict,
      note: "no boundary applies",
      flows: (["happy", "error"] as const).map((kind) => ({
        kind, title: `${acId} ${kind}`, steps: ["open the shop"], expected: "ok", actual: verdict === "pass" ? "ok" : "broken",
        tests: [title(`${acId} works`)],
        evidence: [{ kind: "attachment" as const, test: title(`${acId} works`), name: "response", caption: `${acId} response` }],
      })),
    })),
  };
}
/** The default agent: a passing spec per AC, every AC pass. */
const passAll: AgentFn = (c) => {
  c.write(SPEC_FILE, spec([{ name: "AC-1 works" }, { name: "AC-2 works" }]));
  return result({ "AC-1": "pass", "AC-2": "pass" });
};
/** AC-2's test fails and the agent says so. */
const failAc2: AgentFn = (c) => {
  c.write(SPEC_FILE, spec([{ name: "AC-1 works" }, { name: "AC-2 works", body: "  expect(r.status(), 'MARK-FAILING-SPEC').toBe(418);" }]));
  return result({ "AC-1": "pass", "AC-2": "fail" });
};

type DevFn = (c: { call: number; req: RunAgentRequest<unknown>; write(repo: string, p: string, content: string): void }) => Partial<DevStepResult> | void;
/** default dev: the initial iteration commits the app change plus notes quoting the design; later ones a fix file */
const devDefault: DevFn = (c) => {
  if (c.call === 1) {
    c.write("web", "feature.txt", "feature\n");
    c.write("web", "docs/design-notes.md", `# notes\n\n${DESIGN_LINE}\n`);
  } else c.write("web", `fix-${c.call}.txt`, `fix ${c.call}\n`);
  return { done: true };
};

interface Opts {
  /** web's acceptance section (merged over the default) or null for none */
  webAcceptance?: Record<string, unknown> | null;
  /** extra files committed in web */
  webFiles?: Files;
  /** api's acceptance section, default none */
  apiAcceptance?: Record<string, unknown> | null;
  /** phase 4f: extra files committed in api (the CLI fixture) */
  apiFiles?: Files;
  agent?: AgentFn | AgentFn[];
  dev?: DevFn;
  drift?: DriftResult;
  sandboxCheck?: (scope: SandboxScope) => Promise<SandboxCheck>;
  allowUnsandboxed?: boolean;
  maxAttempts?: number;
  /** T9-8: the seam around the move of the acceptance dir out of the run root */
  acceptanceTestHooks?: AcceptanceTestHooks;  /** F-4 (M-3): the Tailscale address(es) the server listens on */
  remoteHosts?: string[];
  /** phase 4a Task 4: development.localNetwork, and api's sandbox.localPorts */
  localNetwork?: "denylist" | "allowlist";
  apiLocalPorts?: number[];
}

async function setup(o: Opts = {}) {
  const root = realpathSync(tmpDir("rv"));
  roots.push(root);
  const port = await freePort();
  const webAcc =
    o.webAcceptance === null
      ? null
      : { entry: "web", install: "node install.mjs", start: "node server.mjs", stop: "node stop.mjs", baseUrl: `http://127.0.0.1:${port}`, healthPath: "/health", env: { PORT: String(port) }, ...(o.webAcceptance ?? {}) };
  const fixtureFiles: Files = Object.fromEntries(readdirSync(FIXTURE).map((f) => [f, readFileSync(join(FIXTURE, f), "utf8")]));
  const parent = join(root, "repos");
  const API = makeRepo(parent, "api", { "README.md": "# api\n", ...(o.apiFiles ?? {}), ".slackoff/config.json": cfgJson({ ...(o.apiAcceptance ? { acceptance: o.apiAcceptance } : {}), ...(o.apiLocalPorts ? { sandbox: { localPorts: o.apiLocalPorts } } : {}) }) });
  const WEB = makeRepo(parent, "web", { "README.md": "# web\n", ...fixtureFiles, ...(o.webFiles ?? {}), ".slackoff/config.json": cfgJson(webAcc ? { acceptance: webAcc } : {}) });
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, "marker.txt"), "home\n");
  const db = openDatabase(join(home, "slackoff.db"));
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const config: Config = loadConfig(home);
  config.projects = { FAKE: { repos: [{ name: "api", path: API, baseBranch: "main" }, { name: "web", path: WEB, baseBranch: "main" }] } };
  config.acceptance.claudeConfigDir = join(root, "accept-config", "claude-config");
  config.acceptance.startTimeoutMs = 20_000;
  config.acceptance.runTimeoutMs = 120_000;
  config.review.maxAttempts = o.maxAttempts ?? 3;
  if (o.allowUnsandboxed) config.development.allowUnsandboxedCommands = true;
  if (o.localNetwork) config.development.localNetwork = o.localNetwork;
  const source = new FakeTicketSource();
  source.tickets[KEY] = fetchedTicket;
  const processes = new PlatformProcesses();
  processesToKill.push(processes);

  const devCalls: Array<RunAgentRequest<unknown>> = [];
  const refineCalls: Array<RunAgentRequest<unknown>> = [];
  const agentCalls: AgentCtx[] = [];
  /** set while an agent runs: the run's root (for the tests that look at it mid-run) */
  const live: { runRoot: string | null; pgids: number[] } = { runRoot: null, pgids: [] };

  const executor: Executor = {
    kind: "claude-code",
    async exec(exec) {
      const req = pendingReq!;
      const call = agentCalls.length + 1;
      const workDir = exec.cwd;
      const ctx: AgentCtx = {
        call, exec, req, workDir,
        write: (rel, content) => {
          const f = join(workDir, "acceptance", rel);
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f, content);
        },
      };
      agentCalls.push(ctx);
      live.runRoot = dirname(workDir);
      const fns = Array.isArray(o.agent) ? o.agent : [o.agent ?? passAll];
      const fn = fns[Math.min(call, fns.length) - 1]!;
      const out = await fn(ctx);
      return { text: "```json\n" + JSON.stringify(out) + "\n```", usage: null, costUsd: 0, permissionDenials: [] };
    },
  };
  let pendingReq: RunAgentRequest<unknown> | null = null;
  const mappedRepos = () => Object.values(config.projects).flatMap((p) => p.repos.map((r) => r.path));

  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    if (req.role === "implement-ticket") {
      devCalls.push(req as RunAgentRequest<unknown>);
      const call = devCalls.length;
      const out =
        (o.dev ?? devDefault)({
          call,
          req: req as RunAgentRequest<unknown>,
          write: (repo, p, content) => {
            const f = join(req.cwd, repo, p);
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, content);
          },
        }) ?? {};
      return req.schema.parse({ summary: `MARK-DEV step ${call}`, commitMessage: "work", done: false, testsRun: [], notes: "", ...out });
    }
    if (req.role === "refine-ticket") {
      refineCalls.push(req as RunAgentRequest<unknown>);
      return req.schema.parse(o.drift ?? DRIFT_OK);
    }
    if (req.role === "acceptance-review") {
      pendingReq = req as RunAgentRequest<unknown>;
      return runAgent({ db, repoRoot, executor, home, bus, mappedRepos, ...(o.sandboxCheck ? { sandboxCheck: o.sandboxCheck } : {}) }, req);
    }
    throw new Error(`unexpected run ${req.role}`);
  };

  const make = (hooks?: { enqueueReview?: (key: string) => void }) => {
    const queue = new JobQueue(1);
    const wf = createWorkflow({
      updater: noUpdater, db, home, queue, source, run, config, bus, processes,
      hooks: { onDevelopmentStarted: () => {}, ...(hooks ?? {}) },
      ...(o.sandboxCheck ? { sandboxCheck: o.sandboxCheck } : {}),
      ...(o.remoteHosts ? { remoteHosts: () => o.remoteHosts! } : {}),
      ...(o.acceptanceTestHooks ? { acceptanceTestHooks: o.acceptanceTestHooks } : {}),
    });
    return { queue, wf };
  };

  upsertDiscovered(db, { key: KEY, title: "Export orders", url: "https://j/FAKE-1", status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(db, home, KEY, fetchedTicket);
  const { id: reqId } = addRequirement(db, KEY, snapshotId, requirement, "agent");
  saveSolutions(db, KEY, reqId, proposal.solutions);
  recordChoice(db, KEY, listSolutions(db, KEY)[0]!.id, "MARK-NOTE both repos", ["api", "web"]);
  const choiceId = (db.prepare("SELECT MAX(id) AS id FROM choice").get() as { id: number }).id;
  const doc = addDesignDoc(db, KEY, {
    requirementId: reqId, choiceId,
    doc: { contentMd: `## Overview\n${DESIGN_LINE}\n`, repos: [{ repo: "web", contentMd: "MARK-DESIGN web steps" }], checklist: [], responses: [] },
  });
  markFinal(db, KEY, doc.id);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice", "designing", "design_final", "checking_snapshot", "developing"] as const) {
    transition(db, KEY, to, "system");
  }

  const m = make();
  const s = {
    root, port, API, WEB, home, db, bus, events, config, source, processes, devCalls, refineCalls, agentCalls, live, snapshotId, reqId,
    queue: m.queue, wf: m.wf as Workflow, make,
    state: () => getTicket(db, KEY)!.state,
    reason: () => getTicket(db, KEY)!.blockedReason ?? "",
    reports: () => listReports(db, KEY),
    series: () => db.prepare("SELECT id, started_by FROM review_series WHERE ticket_key = ? ORDER BY id").all(KEY) as Array<{ id: number; started_by: string }>,
    iterations: () => listIterations(db, KEY),
    audits: (type: string) =>
      (db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ payload_json: string }>).map(
        (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
      ),
    wt: (repo: string) => join(home, "worktrees", KEY, repo),
    async idle() {
      await s.queue.idle();
    },
  };
  // the initial development (worktrees, commits) → dev_done
  s.wf.resume(KEY);
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
  return s;
}

/** every run root this test's runs made is gone */
const runRootsOf = (s: { db: ReturnType<typeof openDatabase> }) =>
  (s.db.prepare("SELECT run_root FROM acceptance_run ORDER BY id").all() as Array<{ run_root: string }>).map((r) => r.run_root);

/** Walk a dir without following symlinks. */
function walkAll(dir: string, visit: (abs: string, kind: "file" | "dir" | "link") => void): void {
  for (const n of readdirSync(dir)) {
    const abs = join(dir, n);
    const st = lstatSync(abs);
    const kind = st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
    visit(abs, kind);
    if (kind === "dir") walkAll(abs, visit);
  }
}

// ---------------------------------------------------------------- hand-off, isolation, evidence

flow("handOff: unchanged ticket → no drift agent; one isolated acceptance run; passed → awaiting_confirmation with snapshot, evidence and audits", async () => {
  const seen: { names: string[]; marks: string[]; dbFiles: string[]; prompt: string; exec: ExecRequest | null; designNotes: boolean; appAnswered: boolean } = {
    names: [], marks: [], dbFiles: [], prompt: "", exec: null, designNotes: true, appAnswered: false,
  };
  const s = await setup({
    agent: async (c) => {
      seen.exec = c.exec;
      seen.prompt = c.exec.prompt;
      // spec §6: at the moment the agent starts, its cwd and its config dir hold no .git, no database, no design text
      for (const dir of [c.exec.cwd, c.exec.env!.claudeConfigDir]) {
        walkAll(dir, (abs, kind) => {
          const name = abs.split("/").pop()!;
          seen.names.push(name);
          if (/\.(db|sqlite|sqlite3)$|-wal$|-shm$/.test(name)) seen.dbFiles.push(abs);
          if (kind === "file" && readFileSync(abs, "utf8").includes("MARK-")) seen.marks.push(abs);
        });
      }
      seen.designNotes = existsSync(join(c.workDir, "web/docs/design-notes.md"));
      seen.appAnswered = await answering(s.port);
      return passAll(c);
    },
  });
  const fetchesBefore = s.source.calls.length;
  s.wf.handOff(KEY, "local");
  assert.equal(s.state(), "reviewing");
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  assert.equal(s.refineCalls.length, 0, "unchanged snapshot: no drift agent");
  assert.equal(s.source.calls.length, fetchesBefore + 1, "the ticket was re-read once");
  assert.equal(s.agentCalls.length, 1);
  assert.deepEqual(s.series().map((x) => x.started_by), ["handoff"]);

  // isolation at the moment of the call
  assert.ok(!seen.names.includes(".git"), "no .git");
  assert.deepEqual(seen.dbFiles, []);
  assert.deepEqual(seen.marks, [], "no design / debate / dev text reached the agent's directories");
  assert.equal(seen.designNotes, false, "the committed design quote was excluded from the export");
  assert.ok(!seen.prompt.includes("MARK-"), "no design text in the prompt");
  assert.equal(seen.appAnswered, true, "the target app was running");
  const exec = seen.exec!;
  const runRoot = dirname(exec.cwd);
  assert.equal(exec.cwd, join(runRoot, "work"), "cwd = the work dir");
  assert.equal(exec.env!.path[0], join(runRoot, "bin"), "the shim dir is first on PATH");
  assert.ok(!exec.env!.keep.some((k) => k.startsWith("SLACKOFF")), `no SLACKOFF_* kept: ${exec.env!.keep.join(" ")}`);
  assert.ok(!Object.keys(exec.env!.set ?? {}).some((k) => k.startsWith("SLACKOFF")));
  assert.equal(exec.env!.claudeConfigDir, s.config.acceptance.claudeConfigDir);

  const [rep] = s.reports();
  assert.ok(rep);
  assert.equal(rep.verdict, "passed", JSON.stringify(rep.report, null, 2));
  assert.equal(rep.attempt, 1);
  assert.equal(rep.snapshotId, s.snapshotId, "the snapshot the acceptance ran against is recorded");
  assert.deepEqual(rep.report.acs.map((a) => [a.acId, a.verdict]), [["AC-1", "pass"], ["AC-2", "pass"]]);
  assert.ok(rep.report.isolation.ok);
  assert.ok(rep.report.isolation.checks.includes("no-git"));
  assert.deepEqual(rep.report.isolation.excluded, ["web/docs/design-notes.md"]);
  // two affected repos, only web declares acceptance: api is listed as not started
  const api = rep.report.targets.find((t) => t.repo === "api");
  assert.deepEqual({ started: api?.started, detail: api?.detail }, { started: false, detail: "no acceptance section" });
  assert.equal(rep.report.targets.find((t) => t.repo === "web")?.started, true);
  assert.equal(rep.report.specRun?.exitCode, 0, rep.report.specRun?.outputTail ?? "");
  assert.deepEqual(rep.report.commits.map((c) => c.repo).sort(), ["api", "web"]);

  // evidence copied under ${home}/reviews/
  const ev = s.db.prepare("SELECT path, kind, sha256, bytes FROM review_evidence WHERE report_id = ?").all(rep.id) as Array<{ path: string; kind: string; sha256: string; bytes: number }>;
  assert.ok(ev.length >= 2, "evidence for both ACs");
  for (const e of ev) {
    const f = join(s.home, "reviews", e.path);
    assert.ok(existsSync(f), f);
    assert.ok(e.path.startsWith(`${KEY}/`), e.path);
    assert.equal(e.kind, "http");
    assert.equal(readFileSync(f).length, e.bytes);
  }

  // audits
  assert.equal(s.audits("acceptance_started").length, 1);
  const iso = s.audits("acceptance_isolation_checked");
  assert.equal(iso.length, 1);
  assert.ok((iso[0]!.checks as string[]).includes("no-db"));
  assert.deepEqual(iso[0]!.excluded, ["web/docs/design-notes.md"]);

  // after the run: app stopped, run root removed, nothing registered, run closed
  assert.equal(await answering(s.port), false, "the target app was stopped");
  assert.equal(s.processes.size, 0);
  for (const r of runRootsOf(s)) assert.equal(existsSync(r), false, r);
  assert.deepEqual(openAcceptanceRuns(s.db), []);
});

// ---------------------------------------------------------------- drift check before review

flow("drift before review: changed ticket needing an ack → awaiting_review_ack (before_review); empty ack refused; ack continues once", async () => {
  const s = await setup({ drift: DRIFT_ACK, webAcceptance: null });
  s.source.tickets[KEY] = { ...fetchedTicket, description: "Export, and now also as PDF." };
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "awaiting_review_ack");
  assert.equal(s.refineCalls.length, 1);
  const d = latestDrift(s.db, KEY)!;
  assert.equal(d.trigger, "before_review");
  assert.equal(d.acknowledged, false);
  assert.ok(s.events.some((e) => e.type === "snapshot_changed" && e.ticketKey === KEY && e.needsAck));
  assert.throws(() => s.wf.ackReview(KEY, "  ", "local"), ValidationError);
  assert.equal(s.state(), "awaiting_review_ack");
  s.wf.ackReview(KEY, "PDF is out of scope", "device:abc");
  assert.equal(latestDrift(s.db, KEY)!.acknowledged, true);
  await s.idle();
  // no acceptance section → not_executed; never back to awaiting_review_ack, no second drift run
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  assert.equal(s.refineCalls.length, 1);
  const [rep] = s.reports();
  assert.equal(rep?.snapshotId, d.latestSnapshotId, "the report records the re-read snapshot");
  assert.ok(s.audits("drift_acknowledged").some((a) => a.decidedBy === "device:abc"));
});

flow("drift before review: an acknowledged snapshot_changed check of the same snapshot is reused (no drift agent); replan from awaiting_review_ack refines", async () => {
  const s = await setup({ drift: DRIFT_ACK, webAcceptance: null });
  const changed = { ...fetchedTicket, description: "Export, changed." };
  s.source.tickets[KEY] = changed;
  const snap = saveSnapshot(s.db, s.home, KEY, changed).snapshotId;
  const { id } = saveDrift(s.db, KEY, s.reqId, s.snapshotId, snap, "snapshot_changed", DRIFT_ACK);
  acknowledgeDrift(s.db, id, "seen", "local");
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.refineCalls.length, 0, "reused");
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  assert.equal(s.reports()[0]?.snapshotId, snap);

  // an unacknowledged before_review check → awaiting_review_ack; replan → refining
  const s2 = await setup({ drift: DRIFT_ACK, webAcceptance: null });
  s2.source.tickets[KEY] = changed;
  s2.wf.handOff(KEY, "local");
  await s2.idle();
  assert.equal(s2.state(), "awaiting_review_ack");
  s2.source.tickets[KEY] = new Error("stop here"); // the refine job that follows replan fails fast
  s2.wf.replan(KEY, "local");
  await s2.idle();
  const moves = s2.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'state_changed' ORDER BY id").all() as Array<{ payload_json: string }>;
  assert.ok(moves.some((m) => JSON.parse(m.payload_json).from === "awaiting_review_ack" && JSON.parse(m.payload_json).to === "refining"));
});

// ---------------------------------------------------------------- the failure loop

flow("failure loop: AC-2 fails → review_failed iteration with the feedback → back to reviewing after the commit → passes → two reports", async () => {
  const atEnqueue: Array<{ state: string; inTx: boolean }> = [];
  const s = await setup({ agent: [failAc2, passAll] });
  s.wf.handOff(KEY, "local");
  // every later review job is enqueued only after its move to reviewing has committed (outside any transaction)
  const enqueue = s.queue.enqueue.bind(s.queue);
  s.queue.enqueue = (id, fn) => {
    if (id.startsWith("review:")) atEnqueue.push({ state: getTicket(s.db, KEY)!.state, inTx: s.db.isTransaction });
    enqueue(id, fn);
  };
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  const reps = s.reports();
  assert.deepEqual(reps.map((r) => [r.attempt, r.verdict]), [[1, "failed"], [2, "passed"]]);
  assert.deepEqual(reps[0]!.report.acs.map((a) => [a.acId, a.verdict]), [["AC-1", "pass"], ["AC-2", "fail"]]);
  const fixIt = s.iterations().find((i) => i.trigger === "review_failed")!;
  assert.ok(fixIt, "a review_failed iteration");
  assert.match(fixIt.note ?? "", /An empty cart cannot be checked out/);
  const fixPrompt = s.devCalls.at(-1)!.prompt;
  assert.match(fixPrompt, /Independent acceptance feedback — fix these first/);
  assert.match(fixPrompt, /An empty cart cannot be checked out/);
  assert.match(fixPrompt, /MARK-FAILING-SPEC/, "the failing spec's source");
  assert.deepEqual(atEnqueue, [{ state: "reviewing", inTx: false }]);
  assert.equal(s.series().length, 1, "the fix loop stays in one series");
});

flow("attempt cap: failing 3 of 3 → blocked naming the ACs; Retry starts a new round (retry) that fixes first", async () => {
  let devAfterRetry = 0;
  const s = await setup({
    agent: failAc2,
    dev: (c) => {
      if (c.call === 1) {
        c.write("web", "feature.txt", "feature\n");
        return { done: true };
      }
      if (c.call >= 4) {
        devAfterRetry++;
        throw new Error("stop the loop here");
      }
      c.write("web", `fix-${c.call}.txt`, "x\n");
      return { done: true };
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /3 of 3/);
  assert.match(s.reason(), /AC-2/);
  assert.match(s.reason(), /Retry starts a new round/);
  assert.deepEqual(s.reports().map((r) => r.attempt), [1, 2, 3]);
  s.wf.retry(KEY, "local");
  await s.idle();
  assert.deepEqual(s.series().map((x) => x.started_by), ["handoff", "retry"]);
  assert.equal(s.iterations().at(-1)!.trigger, "review_failed", "the new round fixes the carried failure first");
  assert.equal(devAfterRetry, 1);
  assert.equal(s.agentCalls.length, 3, "no acceptance before the fix");
});

flow("agent error → blocked without a report; Retry re-runs acceptance in the same round", async () => {
  const s = await setup({
    agent: [
      () => {
        throw new Error("the agent crashed");
      },
      passAll,
    ],
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /the agent crashed/);
  assert.deepEqual(s.reports(), []);
  assert.equal(s.processes.size, 0);
  s.wf.retry(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  assert.equal(s.series().length, 1, "no new round");
  assert.deepEqual(s.reports().map((r) => r.attempt), [1]);
});

flow("rejectReview → developing (rejected iteration, new round) → back to reviewing; reReview refused at the cap, else re-reads the ticket and passes the note", async () => {
  const s = await setup({});
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  assert.throws(() => s.wf.rejectReview(KEY, " ", "local"), ValidationError);
  s.wf.rejectReview(KEY, "the button is the wrong colour", "local");
  assert.equal(s.state(), "developing");
  assert.equal(s.iterations().at(-1)!.trigger, "rejected");
  assert.deepEqual(s.series().map((x) => x.started_by), ["handoff", "rejected"]);
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  assert.deepEqual(s.reports().map((r) => [r.seriesId, r.attempt]), [[s.series()[0]!.id, 1], [s.series()[1]!.id, 1]]);
  assert.ok(s.audits("review_decided").some((a) => a.decision === "rejected"));

  // re-review: re-reads the ticket (step 1 again) and gives the agent the note
  const fetches = s.source.calls.length;
  assert.throws(() => s.wf.reReview(KEY, "", "local"), ValidationError);
  s.wf.reReview(KEY, "please check the empty cart again", "local");
  assert.equal(s.state(), "reviewing");
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  assert.equal(s.source.calls.length, fetches + 1, "the ticket was re-read");
  const prompt = s.agentCalls.at(-1)!.exec.prompt;
  assert.match(prompt, /developer's note/);
  assert.match(prompt, /please check the empty cart again/);
  assert.equal(s.reports().at(-1)!.developerNote, "please check the empty cart again");
  assert.equal(s.reports().at(-1)!.attempt, 2);

  // at the cap (3 reports in this round): refused
  const cur = currentSeries(s.db, KEY)!;
  saveReport(s.db, KEY, { seriesId: cur.id, requirementId: s.reqId, snapshotId: s.snapshotId, attempt: 3, report: s.reports().at(-1)!.report, developerNote: null, evidence: [] });
  assert.throws(() => s.wf.reReview(KEY, "again", "local"), (e: Error) => e instanceof ValidationError && /Acceptance ran 3 of 3 times in this round — reject with comments instead/.test(e.message));
});

// ---------------------------------------------------------------- not executed

flow("no acceptance section anywhere → not_executed (e2e not executed), the agent is never called, awaiting_confirmation", async () => {
  const s = await setup({ webAcceptance: null });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "not_executed");
  assert.match(rep!.report.notExecutedReason ?? "", /e2e not executed/);
  assert.match(rep!.report.notExecutedReason ?? "", /api, web|web, api/);
  assert.ok(rep!.report.acs.every((a) => a.verdict === "not_tested"));
  assert.equal(s.agentCalls.length, 0);
});

flow("a failing sandbox self-check → not_executed (sandbox self-check); no agent, no app — even with allowUnsandboxedCommands", async () => {
  const scopes: SandboxScope[] = [];
  const s = await setup({
    allowUnsandboxed: true,
    sandboxCheck: async (sc) => {
      scopes.push(sc);
      return { ok: false, detail: "4317:OPEN" };
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "not_executed");
  assert.match(rep!.report.notExecutedReason ?? "", /isolation check failed: sandbox self-check: 4317:OPEN/);
  assert.equal(s.agentCalls.length, 0);
  assert.equal(rep!.report.targets.find((t) => t.repo === "web")?.started, false);
  assert.ok(!existsSync(join(s.WEB, "installed.txt")) && s.audits("acceptance_isolation_checked").length === 0);
  assert.equal(scopes[0]?.kind, "acceptance");
  assert.ok(scopes[0]?.runRoot, "the scope of the run");
  assert.deepEqual([...scopes[0]!.repos].sort(), [s.API, s.WEB].sort());
});

flow("target port already in use → not_executed (already in use); agent not called", async () => {
  const s = await setup({});
  const server = await listen(s.port);
  try {
    s.wf.handOff(KEY, "local");
    await s.idle();
  } finally {
    server.close();
  }
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "not_executed");
  assert.match(rep!.report.notExecutedReason ?? "", /already in use/);
  assert.equal(s.agentCalls.length, 0);
});

flow("uncommitted file in a worktree → blocked naming the repo", async () => {
  const s = await setup({});
  writeFileSync(join(s.wt("api"), "stray.txt"), "x\n");
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /api/);
  assert.match(s.reason(), /uncommitted/);
  assert.equal(s.agentCalls.length, 0);
});

// ---------------------------------------------------------------- the platform's own checks

/** A Playwright json report in which every AC's test passed with its response attached: what a forger would plant. */
function forgedResults(): string {
  const body = Buffer.from(JSON.stringify({ status: 200, body: "ok" })).toString("base64");
  const specOf = (name: string) => ({
    title: name, file: "ac.spec.mjs",
    tests: [{ status: "expected", expectedStatus: "passed", results: [{ status: "passed", attachments: [{ name: "response", contentType: "application/json", body }] }] }],
  });
  return JSON.stringify({ suites: [{ title: "ac.spec.mjs", file: "ac.spec.mjs", specs: [specOf("AC-1 works"), specOf("AC-2 works")] }] });
}
/** A spec that ends the runner before any result is written (a guard dodge). */
const EXIT_AT_LOAD = `import { test } from '@playwright/test';
[].at["constru" + "ctor"]("return this")()["pro" + "cess"]["exit"](0);
test('AC-1 works', async () => {});
test('AC-2 works', async () => {});
`;

flow("T9-6 (M2): an all-pass results.json planted by the agent is never read when the platform re-run writes none", async () => {
  const s = await setup({
    agent: (c) => {
      c.write(SPEC_FILE, EXIT_AT_LOAD);
      c.write("results.json", forgedResults());
      return result({ "AC-1": "pass", "AC-2": "pass" });
    },
    dev: (c) => {
      if (c.call === 1) {
        c.write("web", "feature.txt", "f\n");
        return { done: true };
      }
      throw new Error("stop the loop here");
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "failed", JSON.stringify(rep?.report.acs.map((a) => [a.acId, a.verdict, a.mismatch])));
  for (const a of rep!.report.acs) assert.equal(a.verdict, "fail");
});

/** The escaped process (T9-3 / M1): forges an all-pass results.json and flips evidence/sub between the real dir and a
 * symlink to `secret`, every 2 ms, forever (argv: acceptance dir, forged report hex, secret dir, marker). */
const ESCAPEE = `const fs = require("fs"); const path = require("path");
const [acc, forgedHex, secret] = process.argv.slice(1);
const forged = Buffer.from(forgedHex, "hex").toString();
let flip = false;
setInterval(() => {
  try { fs.mkdirSync(acc, { recursive: true }); fs.writeFileSync(path.join(acc, "results.json"), forged); } catch {}
  try {
    const sub = path.join(acc, "evidence", "sub"); const real = path.join(acc, "evidence", "sub-real");
    flip = !flip;
    if (flip) { fs.renameSync(sub, real); fs.symlinkSync(secret, sub); } else { fs.unlinkSync(sub); fs.renameSync(real, sub); }
  } catch {}
}, 2);`;
const hex = (t: string) => Buffer.from(t).toString("hex");

flow("T9-3 (M1): a process escaped from the run (detached, empty environment) that keeps forging results.json and swapping evidence/sub after the stop cannot change what is read", async () => {
  const marker = `T9ESCAPEE${process.pid}x${Date.now()}`;
  const killEscapees = () => {
    const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && m[2]!.includes(marker)) {
        try {
          process.kill(Number(m[1]), "SIGKILL");
        } catch {
          // gone
        }
      }
    }
  };
  let s: Awaited<ReturnType<typeof setup>> | null = null;
  try {
    s = await setup({
      agent: (c) => {
        const secret = join(s!.home, "secret");
        mkdirSync(secret, { recursive: true });
        writeFileSync(join(secret, "shot.png"), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("MARK-SECRET")]));
        c.write(
          SPEC_FILE,
          spec([
            {
              name: "AC-1 works",
              body: `  const P = [].at["constru" + "ctor"]("return this")()["pro" + "cess"];
  const F = P["getBuilt" + "inModule"]("f" + "s");
  const C = P["getBuilt" + "inModule"]("child_" + "pro" + "cess");
  const acc = P.cwd();
  F.mkdirSync(acc + "/evidence/sub", { recursive: true });
  F.writeFileSync(acc + "/evidence/sub/shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41]));
  const script = Buffer.from(${JSON.stringify(hex(ESCAPEE))}, "hex").toString();
  C["sp" + "awn"](P.execPath, ["-e", script, acc, ${JSON.stringify(hex(forgedResults()))}, ${JSON.stringify(secret)}, ${JSON.stringify(marker)}], { detached: true, env: {}, stdio: "ignore", cwd: acc }).unref();
  await new Promise((r) => setTimeout(r, 300));
  expect(r.status()).toBe(200);`,
            },
            { name: "AC-2 works", body: "  expect(r.status()).toBe(418);" },
          ]),
        );
        const res = result({ "AC-1": "pass", "AC-2": "pass" });
        res.acs[0]!.flows[0]!.evidence.push({ kind: "file", path: "evidence/sub/shot.png", caption: "the shop" });
        return res;
      },
      dev: (c) => {
        if (c.call === 1) {
          c.write("web", "feature.txt", "f\n");
          return { done: true };
        }
        throw new Error("stop the loop here");
      },
    });
    s.wf.handOff(KEY, "local");
    await s.idle();
    const [rep] = s.reports();
    assert.ok(rep);
    assert.equal(rep.verdict, "failed", JSON.stringify(rep.report.acs.map((a) => [a.acId, a.verdict, a.mismatch])));
    assert.equal(rep.report.acs.find((a) => a.acId === "AC-2")!.verdict, "fail", "the forged results.json was not believed");
    for (const f of readdirSync(join(s.home, "reviews", KEY), { recursive: true }) as string[]) {
      const abs = join(s.home, "reviews", KEY, f);
      if (lstatSync(abs).isFile()) assert.ok(!readFileSync(abs).includes("MARK-SECRET"), `${f} holds the secret`);
    }
  } finally {
    killEscapees();
    if (s) for (const r of runRootsOf(s)) rmSync(r, { recursive: true, force: true });
  }
});

flow("T9-6 (L3): the platform re-run's and the test command's process groups are registered while they run (shutdown kills them), and removed after", async () => {
  let maxSize = 0;
  let poll: NodeJS.Timeout | null = null;
  const s = await setup({
    webFiles: { "slow.mjs": "setTimeout(() => {}, 2500);\n" },
    webAcceptance: { testCommand: "node slow.mjs" },
    agent: (c) => {
      c.write(SPEC_FILE, spec([{ name: "AC-1 works", body: "  await new Promise((r) => setTimeout(r, 2500));\n  expect(r.status()).toBe(200);" }, { name: "AC-2 works" }]));
      return result({ "AC-1": "pass", "AC-2": "pass" });
    },
  });
  const sizes: number[] = [];
  poll = setInterval(() => {
    sizes.push(s.processes.size);
    maxSize = Math.max(maxSize, s.processes.size);
  }, 100);
  try {
    s.wf.handOff(KEY, "local");
    await s.idle();
  } finally {
    clearInterval(poll);
  }
  assert.equal(s.reports()[0]?.verdict, "passed", s.reason());
  assert.equal(maxSize, 2, `the app plus the command running (sizes seen: ${[...new Set(sizes)].join(",")})`);
  assert.equal(s.processes.size, 0);
});

const specsJsonOf = (s: { home: string; reports(): ReviewReportRecord[] }) => {
  const r = s.reports()[0]!;
  return JSON.parse(readFileSync(join(s.home, "reviews", KEY, `${r.seriesId}-${r.attempt}`, "specs.json"), "utf8")) as Record<string, string>;
};

flow("T9-8: what is read comes from the moved dir — results.json, a spec and evidence/sub swapped at the old place after the move change nothing", async () => {
  let moved = 0;
  const s = await setup({
    agent: (c) => {
      c.write(SPEC_FILE, `// REAL-SPEC\n${spec([{ name: "AC-1 works" }, { name: "AC-2 works" }])}`);
      return result({ "AC-1": "pass", "AC-2": "pass" });
    },
    acceptanceTestHooks: {
      afterMove: ({ acceptanceDir }) => {
        moved++;
        // what an escaped process could do in RUN_ROOT once the dir is gone
        const secret = join(dirname(acceptanceDir), "secret");
        mkdirSync(secret, { recursive: true });
        writeFileSync(join(secret, "shot.png"), "MARK-SECRET");
        mkdirSync(join(acceptanceDir, "specs"), { recursive: true });
        mkdirSync(join(acceptanceDir, "evidence"), { recursive: true });
        writeFileSync(join(acceptanceDir, SPEC_FILE), "// FORGED-SPEC\n");
        writeFileSync(join(acceptanceDir, "results.json"), forgedResults());
        symlinkSync(secret, join(acceptanceDir, "evidence", "sub"));
      },
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(moved, 1, "the seam ran once, between the move and the reads");
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "passed", JSON.stringify(rep?.report.acs.map((a) => [a.acId, a.verdict, a.mismatch])));
  const specs = specsJsonOf(s);
  assert.match(specs[SPEC_FILE] ?? "", /REAL-SPEC/);
  assert.doesNotMatch(specs[SPEC_FILE] ?? "", /FORGED-SPEC/);
  for (const f of readdirSync(join(s.home, "reviews", KEY), { recursive: true }) as string[]) {
    const abs = join(s.home, "reviews", KEY, f);
    if (lstatSync(abs).isFile()) assert.ok(!readFileSync(abs).includes("MARK-SECRET"), f);
  }
});

flow("T9-8: work/acceptance replaced by a symlink before the move → no results and no specs; every AC fails (acceptance output was not a directory)", async () => {
  const s = await setup({
    agent: (c) => {
      c.write(SPEC_FILE, `// REAL-SPEC\n${spec([{ name: "AC-1 works" }, { name: "AC-2 works" }])}`);
      return result({ "AC-1": "pass", "AC-2": "pass" });
    },
    dev: (c) => {
      if (c.call === 1) {
        c.write("web", "feature.txt", "f\n");
        return { done: true };
      }
      throw new Error("stop the loop here");
    },
    acceptanceTestHooks: {
      beforeMove: ({ acceptanceDir }) => {
        // an escaped process swaps the dir for a link to a copy it keeps writing in RUN_ROOT
        const decoy = join(dirname(acceptanceDir), "decoy");
        renameSync(acceptanceDir, decoy);
        writeFileSync(join(decoy, SPEC_FILE), "// FORGED-SPEC\n");
        symlinkSync(decoy, acceptanceDir);
      },
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "failed");
  for (const a of rep!.report.acs) {
    assert.equal(a.verdict, "fail");
    assert.match(a.mismatch ?? "", /acceptance output was not a directory/);
  }
  assert.deepEqual(specsJsonOf(s), {});
});

flow("T9-4: the target app or its test command writes a tracked path before the agent runs → not_executed naming it; the agent is not called", async () => {
  const s = await setup({
    webFiles: { "mutate.mjs": "import { appendFileSync } from 'node:fs';\nappendFileSync('README.md', 'touched by the test command\\n');\n" },
    webAcceptance: { testCommand: "node mutate.mjs" },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "not_executed", JSON.stringify(rep?.report.acs.map((a) => a.mismatch)));
  assert.match(rep!.report.notExecutedReason ?? "", /the target app or its install wrote tracked paths: web\/README\.md/);
  assert.equal(s.agentCalls.length, 0);
  assert.equal(await answering(s.port), false);
});

flow("agent says pass but the platform re-run fails (its spec reads SLACKOFF_HOME's DB through the shim's sandbox) → AC fail, verdict failed", async () => {
  const s = await setup({
    agent: (c) => {
      // a dodge past the static guard (spike §4.2): only the OS sandbox stops it
      c.write(
        SPEC_FILE,
        spec([
          { name: "AC-1 works" },
          {
            name: "AC-2 works",
            body: `  const G = [].at["constru" + "ctor"]("return this")();
  const m = G["pro" + "cess"]["getBuilt" + "inModule"]("f" + "s");
  m["readFile" + "Sync"](${JSON.stringify(join(s.home, "slackoff.db"))});`,
          },
        ]),
      );
      return result({ "AC-1": "pass", "AC-2": "pass" });
    },
    dev: (c) => {
      if (c.call === 1) {
        c.write("web", "feature.txt", "f\n");
        return { done: true };
      }
      throw new Error("stop the loop here");
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "failed", JSON.stringify(rep?.report.acs));
  const ac2 = rep!.report.acs.find((a) => a.acId === "AC-2")!;
  assert.equal(ac2.verdict, "fail");
  assert.equal(ac2.agentVerdict, "pass");
  assert.match(ac2.mismatch ?? "", /failed in the platform run/);
  assert.match(rep!.report.specRun?.outputTail ?? "", /EPERM|operation not permitted/i);
  assert.equal(rep!.report.acs.find((a) => a.acId === "AC-1")!.verdict, "pass");
});

flow("the agent rewrites the app under test → every AC fails (changed the app under test)", async () => {
  const s = await setup({
    agent: (c) => {
      writeFileSync(join(c.workDir, "web/server.mjs"), "// replaced\n");
      return passAll(c);
    },
    dev: (c) => {
      if (c.call === 1) {
        c.write("web", "feature.txt", "f\n");
        return { done: true };
      }
      throw new Error("stop the loop here");
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const [rep] = s.reports();
  assert.equal(rep?.verdict, "failed");
  for (const a of rep!.report.acs) {
    assert.equal(a.verdict, "fail");
    assert.match(a.mismatch ?? "", /changed the app under test: web\/server\.mjs/);
  }
});

// ---------------------------------------------------------------- abandon, shutdown, restart

/** an agent that waits until its run is aborted (or `release` is called) */
function blockingAgent() {
  const state: { started: boolean; aborted: boolean; release: ((e?: Error) => void) | null; runRoot: string | null } = {
    started: false, aborted: false, release: null, runRoot: null,
  };
  const fn: AgentFn = (c) =>
    new Promise<AcceptanceResult>((res, rej) => {
      state.started = true;
      state.runRoot = dirname(c.workDir);
      const signal = c.exec.signal;
      state.release = (e) => (e ? rej(e) : res(passAll(c)));
      signal?.addEventListener("abort", () => {
        state.aborted = true;
        rej(new AgentInterruptedError("agent run aborted"));
      });
    });
  return { state, fn };
}

flow("abandon during acceptance: the watcher aborts the agent, the app is stopped, the run root removed, no report", async () => {
  const b = blockingAgent();
  const s = await setup({ agent: b.fn });
  s.wf.handOff(KEY, "local");
  assert.ok(await waitFor(() => b.state.started, 60_000), "the agent started");
  assert.equal(await answering(s.port), true);
  s.wf.abandon(KEY, "local");
  // the watcher checks every 2 s: the agent's signal is aborted within a few seconds, not at a test timeout
  assert.ok(await waitFor(() => b.state.aborted, 6_000), "the signal was aborted within 6 s");
  await s.idle();
  assert.equal(await answering(s.port), false, "the app was stopped");
  assert.equal(existsSync(b.state.runRoot!), false, "the run root was removed");
  assert.deepEqual(s.reports(), []);
  assert.equal(s.state(), "abandoned");
  assert.deepEqual(openAcceptanceRuns(s.db), []);
}, 60_000);

flow("shutdown: PlatformProcesses.killAll stops the target app while the agent runs", async () => {
  const b = blockingAgent();
  const s = await setup({ agent: b.fn });
  s.wf.handOff(KEY, "local");
  assert.ok(await waitFor(() => b.state.started, 60_000));
  try {
    const pgids = JSON.parse((s.db.prepare("SELECT pgids_json FROM acceptance_run").get() as { pgids_json: string }).pgids_json) as number[];
    // the install's group (gone) and the app's
    const live = pgids.filter(groupAlive);
    assert.equal(live.length, 1, `live groups of ${pgids.join(",")}`);
    const [pgid] = live as [number];
    assert.equal(s.processes.size, 1);
    assert.ok(s.processes.has(pgid));
    s.processes.killAll();
    assert.ok(await waitFor(() => !groupAlive(pgid)), "the fixture app is not running");
  } finally {
    s.wf.abandon(KEY, "local");
    await s.idle();
  }
});

flow("restart mid-acceptance: recovery kills the app, removes the run root, and acceptance runs again as attempt 1", async () => {
  const b = blockingAgent();
  const s = await setup({ agent: [b.fn, passAll] });
  s.wf.handOff(KEY, "local");
  assert.ok(await waitFor(() => b.state.started, 60_000));
  const [open] = openAcceptanceRuns(s.db);
  assert.ok(open);
  const live = open.pgids.filter(groupAlive);
  assert.equal(live.length, 1, `live groups of ${open.pgids.join(",")}`);
  const [pgid] = live as [number];
  // a new process: a new workflow and startup recovery (the old job stays stuck in its agent meanwhile)
  const oldQueue = s.queue;
  const m = s.make();
  recoverOnStartup(s.db, m.wf);
  assert.ok(await waitFor(() => !groupAlive(pgid)), "the leftover app was killed");
  assert.equal(existsSync(open.runRoot), false, "the run root was removed");
  assert.equal((s.db.prepare("SELECT status FROM acceptance_run WHERE id = ?").get(open.id) as { status: string }).status, "interrupted");
  // the old process is gone: its agent ends as at shutdown
  b.state.release!(new AgentInterruptedError());
  await oldQueue.idle();
  s.queue = m.queue;
  s.wf = m.wf;
  await s.idle();
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
  assert.deepEqual(s.reports().map((r) => r.attempt), [1], "the interrupted run did not count");
});

test("killLeftovers: a process whose environment carries SLACKOFF_RUN_ROOT=<runRoot> is killed whatever its group; another run root is left alone", { skip: process.platform === "darwin" ? false : "ps -E is macOS" }, async () => {
  const root = realpathSync(tmpDir("rvk"));
  roots.push(root);
  const runRoot = join(root, "slackoff-accept-abc123");
  const spawnSleeper = (env: Record<string, string>) => {
    const out = execFileSync(
      "/bin/sh",
      ["-c", `${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)' > /dev/null 2>&1 & echo $!`],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } },
    );
    return Number(out.trim());
  };
  const mine = spawnSleeper({ SLACKOFF_RUN_ROOT: runRoot });
  const other = spawnSleeper({ SLACKOFF_RUN_ROOT: `${runRoot}0` });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    assert.ok(await waitFor(() => alive(mine) && alive(other), 5000));
    killLeftovers(runRoot, []);
    assert.ok(await waitFor(() => !alive(mine), 5000), "the run's process was killed");
    assert.ok(alive(other), "another run root's process is left alone");
  } finally {
    for (const p of [mine, other]) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
});

test("Workflow.replan accepts awaiting_review_ack; reReview / rejectReview / handOff / ackReview check the state", async () => {
  const root = realpathSync(tmpDir("rvs"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const db = openDatabase(":memory:");
  const config = loadConfig(home);
  const source = new FakeTicketSource();
  source.tickets[KEY] = new Error("no fetch in this test");
  const queue = new JobQueue(1);
  const wf = createWorkflow({
    updater: noUpdater, db, home, queue, source, config, bus: new EventBus(),
    run: async () => {
      throw new Error("no runs in this test");
    },
  });
  upsertDiscovered(db, { key: KEY, title: "t", url: "https://j/FAKE-1", status: "x" }, false);
  assert.throws(() => wf.handOff(KEY, "local"), /dev_done/);
  assert.throws(() => wf.ackReview(KEY, "n", "local"), /awaiting_review_ack/);
  assert.throws(() => wf.rejectReview(KEY, "n", "local"), /awaiting_confirmation/);
  assert.throws(() => wf.reReview(KEY, "n", "local"), /awaiting_confirmation/);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice", "designing", "design_final", "checking_snapshot", "developing", "reviewing", "awaiting_review_ack"] as const) {
    transition(db, KEY, to, "system");
  }
  startSeries(db, KEY, "handoff", null, "local");
  wf.replan(KEY, "local");
  assert.equal(getTicket(db, KEY)!.state, "refining");
  await queue.idle();
  db.close();
});

flow("F-4 (M-3): with remote access listening on a Tailscale address, the acceptance sandbox's scope carries it for the self-check", async () => {
  const scopes: SandboxScope[] = [];
  const s = await setup({
    remoteHosts: ["100.101.102.103"],
    sandboxCheck: async (sc) => {
      scopes.push(sc);
      return { ok: false, detail: "stop here" };
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(scopes[0]?.kind, "acceptance");
  assert.deepEqual(scopes[0]?.remoteHosts, ["100.101.102.103"]);
});

flow("phase 4a Task 4: allowlist mode — the acceptance scope allows the repos' sandbox.localPorts plus each declared baseUrl port", async () => {
  const scopes: SandboxScope[] = [];
  const s = await setup({
    localNetwork: "allowlist",
    apiLocalPorts: [5432],
    sandboxCheck: async (sc) => {
      scopes.push(sc);
      return { ok: false, detail: "stop here" };
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.equal(scopes[0]?.kind, "acceptance");
  // web's baseUrl is http://127.0.0.1:<s.port>
  assert.deepEqual(scopes[0]?.localNetwork, { mode: "allowlist", allowPorts: [5432, s.port].sort((a, b) => a - b) });
});

// ---------------------------------------------------------------- phase 4f (Task 4): command-line entries

const CLI_FIXTURE = join(import.meta.dirname, "fixtures/acceptance-cli");
const cliFiles = (): Files => ({ "bin/tool.mjs": readFileSync(join(CLI_FIXTURE, "bin", "tool.mjs"), "utf8") });
const CLI_ACCEPTANCE = { entry: "cli", cli: { command: "./bin/tool.mjs" } };
/** The agent's result for cases: per AC a happy and an error flow citing `cases[acId]`, evidence {kind: 'case'}. */
function caseResult(verdicts: Record<string, "pass" | "fail">, cases: Record<string, string>): AcceptanceResult {
  return {
    summary: "checked the CLI",
    acs: Object.entries(verdicts).map(([acId, verdict]) => ({
      acId, verdict, note: "no boundary applies",
      flows: (["happy", "error"] as const).map((kind) => ({
        kind, title: `${acId} ${kind}`, steps: ["run the tool"], expected: "ok", actual: verdict === "pass" ? "ok" : "broken",
        tests: [cases[acId]!], evidence: [{ kind: "case" as const, case: cases[acId]!, caption: `${acId} transcript` }],
      })),
    })),
  };
}
const caseFile = (name: string, acId: string, args: string[], expect: Record<string, unknown>) =>
  JSON.stringify({ name, acId, kind: "happy", title: name, args, expect });

flow("phase 4f: a CLI entry — the agent's only command is slackoff-cases run; a forged results/cases.json does not count; transcripts are log evidence", async () => {
  let allowed: readonly string[] = [];
  let shimExit: number | null = null;
  const s = await setup({
    webAcceptance: null, apiAcceptance: CLI_ACCEPTANCE, apiFiles: cliFiles(), maxAttempts: 1,
    agent: (c) => {
      allowed = c.exec.allowedTools;
      c.write("api/cases/list-empty.case.json", caseFile("list-empty", "AC-1", ["list"], { exitCode: 0, stdoutIncludes: ["(no items)"] }));
      // a broken expectation: the tool lists nothing, never "1. milk"
      c.write("api/cases/list-milk.case.json", caseFile("list-milk", "AC-2", ["list"], { exitCode: 0, stdoutIncludes: ["1. milk"] }));
      // the agent forges its own results: every case passed
      c.write("results/cases.json", JSON.stringify({ repos: { api: { problems: [], results: [{ name: "list-milk", passed: true }] } } }));
      shimExit = execFileSync("/bin/sh", ["-c", `${join(dirname(c.workDir), "bin", "slackoff-cases")} test; echo $?`], { encoding: "utf8" }).trim().split("\n").map(Number).at(-1) ?? null;
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "list-empty", "AC-2": "list-milk" });
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.ok(allowed.includes("Bash(slackoff-cases run)"), allowed.join(" "));
  assert.ok(!allowed.some((t) => t.includes("playwright")), allowed.join(" "));
  assert.equal(shimExit, 2, "the shim refuses anything but run");
  const rep = s.reports().at(-1)!;
  assert.equal(rep.verdict, "failed", JSON.stringify(rep.report, null, 2));
  const ac = Object.fromEntries(rep.report.acs.map((a) => [a.acId, a]));
  assert.equal(ac["AC-1"]!.verdict, "pass", JSON.stringify(ac["AC-1"]));
  assert.equal(ac["AC-2"]!.verdict, "fail");
  assert.match(ac["AC-2"]!.mismatch ?? "", /case 'list-milk' failed in the platform run/);
  assert.ok(rep.report.isolation.ok && rep.report.isolation.checks.includes("no-git"), JSON.stringify(rep.report.isolation));
  assert.equal(rep.report.targets.find((t) => t.repo === "api")?.entry, "cli");
  const ev = s.db.prepare("SELECT path, kind FROM review_evidence WHERE report_id = ?").all(rep.id) as Array<{ path: string; kind: string }>;
  assert.ok(ev.length >= 2);
  for (const e of ev) {
    assert.equal(e.kind, "log");
    const text = readFileSync(join(s.home, "reviews", e.path), "utf8");
    assert.ok(text.startsWith("$ ./bin/tool.mjs list"), text.slice(0, 80));
  }
  for (const r of runRootsOf(s)) {
    assert.equal(existsSync(r), false, r);
    assert.deepEqual(readdirSync(dirname(r)).filter((n) => n.startsWith(`${r.split("/").pop()}-`)), [], "no rerun / read dir left");
  }
  assert.deepEqual(openAcceptanceRuns(s.db), []);
});

flow("phase 4f: a failing build → not_executed (the build failed), the agent is never called", async () => {
  const s = await setup({
    webAcceptance: null, apiAcceptance: { ...CLI_ACCEPTANCE, build: "node build.mjs" },
    apiFiles: { ...cliFiles(), "build.mjs": "console.error('build: broken on purpose'); process.exit(3);\n" },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const rep = s.reports().at(-1)!;
  assert.equal(rep.verdict, "not_executed");
  assert.match(rep.report.notExecutedReason ?? "", /the build failed: build of api \(exit 3\).*broken on purpose/);
  assert.equal(s.agentCalls.length, 0);
});

flow("phase 4f: cli.command missing from the snapshot → not_executed naming it, the agent is never called", async () => {
  const s = await setup({ webAcceptance: null, apiAcceptance: { entry: "cli", cli: { command: "./bin/missing.mjs" } }, apiFiles: cliFiles() });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const rep = s.reports().at(-1)!;
  assert.equal(rep.verdict, "not_executed");
  assert.match(rep.report.notExecutedReason ?? "", /\.\/bin\/missing\.mjs does not exist in the exported snapshot/);
  assert.equal(s.agentCalls.length, 0);
});

flow("4F-8 I-5: no valid case at all → not_executed 'no valid acceptance cases: <first error>', never an empty fix round", async () => {
  const s = await setup({
    webAcceptance: null, apiAcceptance: CLI_ACCEPTANCE, apiFiles: cliFiles(), maxAttempts: 3,
    agent: (c) => {
      c.write("api/cases/bad.case.json", JSON.stringify({ name: "bad", acId: "AC-9", kind: "happy", title: "x", args: [], expect: { exitCode: 0 } }));
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "x", "AC-2": "y" });
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const rep = s.reports().find((r) => r.attempt === 1)!;
  assert.equal(rep.verdict, "not_executed", JSON.stringify(rep.report, null, 2));
  assert.match(rep.report.notExecutedReason ?? "", /^no valid acceptance cases: api: bad\.case\.json: unknown acceptance criterion AC-9/);
  assert.ok(rep.report.acs.every((a) => a.verdict === "not_tested"), JSON.stringify(rep.report.acs));
  assert.equal(s.reports().length, 1, "no further attempt");
  assert.deepEqual(s.iterations().filter((i) => i.trigger === "review_failed"), [], "no fix round");
  assert.equal(s.state(), "awaiting_confirmation", s.reason());
});

flow("phase 4f (4F-5 M3, 4F-8 m-4): the platform's re-run is bounded by acceptance.runTimeoutMs — it ends not_executed 'acceptance run timed out', not an app failure", async () => {
  const s = await setup({
    webAcceptance: null, apiAcceptance: CLI_ACCEPTANCE, apiFiles: cliFiles(), maxAttempts: 1,
    agent: (c) => {
      c.write("api/cases/sleep.case.json", caseFile("sleeps", "AC-1", ["sleep"], { exitCode: 0 }));
      c.write("api/cases/list.case.json", caseFile("list-empty", "AC-2", ["list"], { exitCode: 0 }));
      // the agent's run itself is not timed here: only the platform's re-run is
      s.config.acceptance.runTimeoutMs = 3_000;
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "sleeps", "AC-2": "list-empty" });
    },
  });
  s.config.acceptance.caseTimeoutMs = 120_000;
  const t0 = Date.now();
  s.wf.handOff(KEY, "local");
  await s.idle();
  assert.ok(Date.now() - t0 < 60_000, "not the case timeout");
  const rep = s.reports().at(-1)!;
  assert.equal(rep.verdict, "not_executed", JSON.stringify(rep.report, null, 2));
  assert.equal(rep.report.notExecutedReason, "acceptance run timed out");
  assert.deepEqual(s.iterations().filter((i) => i.trigger === "review_failed"), [], "no fix round for a timeout");
});

flow("phase 4f (4F-5 M4): what the agent's phase left running is swept BEFORE the platform builds the fresh run root", async () => {
  let stray = 0;
  const atRerun: boolean[] = [];
  // the stray is this test process's child: once killed it is a zombie until reaped, so "alive" is by ps state
  const alive = (pid: number) => {
    try {
      const st = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
      return st !== "" && !st.startsWith("Z");
    } catch {
      return false;
    }
  };
  const s = await setup({
    webAcceptance: null, apiAcceptance: CLI_ACCEPTANCE, apiFiles: cliFiles(), maxAttempts: 1,
    agent: (c) => {
      c.write("api/cases/list.case.json", caseFile("list-empty", "AC-1", ["list"], { exitCode: 0 }));
      // an escapee of the agent's phase: detached, environment emptied, its cwd in the old run root
      const p = spawn("/bin/sleep", ["120"], { cwd: c.workDir, detached: true, stdio: "ignore", env: {} });
      p.unref();
      stray = p.pid!;
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "list-empty", "AC-2": "list-empty" });
    },
    acceptanceTestHooks: { beforeRerun: () => atRerun.push(alive(stray)) },
  });
  try {
    s.wf.handOff(KEY, "local");
    await s.idle();
    assert.deepEqual(atRerun, [false], "dead before the fresh run root was made");
  } finally {
    if (stray > 0 && alive(stray)) process.kill(stray, "SIGKILL");
  }
});

flow("4F-7 I-2: a CLI flagged interactive → not_executed 'interactive CLIs are not supported'; the agent is never called", async () => {
  const s = await setup({ webAcceptance: null, apiAcceptance: { entry: "cli", cli: { command: "./bin/tool.mjs", interactive: true } }, apiFiles: cliFiles() });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const rep = s.reports().at(-1)!;
  assert.equal(rep.verdict, "not_executed");
  assert.match(rep.report.notExecutedReason ?? "", /^interactive CLIs are not supported/);
  assert.match(rep.report.summary, /E2E not executed: interactive CLIs are not supported/);
  assert.equal(s.agentCalls.length, 0);
});

flow("4F-7 m-8: a known secret value in a case's output or failures is never stored (transcript, outputTail, report)", async () => {
  const SECRET = "sk-fake-4f7-0123456789abcdef";
  redactorWith([SECRET]);
  const s = await setup({
    webAcceptance: null, apiAcceptance: CLI_ACCEPTANCE, apiFiles: cliFiles(), maxAttempts: 1,
    agent: (c) => {
      c.write("api/cases/leak.case.json", caseFile("leak", "AC-1", ["add", SECRET], { exitCode: 0, stdoutIncludes: [`${SECRET}-not-there`] }));
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "leak", "AC-2": "leak" });
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const rep = s.reports().at(-1)!;
  assert.ok(!JSON.stringify(rep.report).includes(SECRET), "not in the stored report");
  assert.match(rep.report.specRun?.outputTail ?? "", /\[redacted\]/);
  const ev = s.db.prepare("SELECT path FROM review_evidence WHERE report_id = ?").all(rep.id) as Array<{ path: string }>;
  assert.ok(ev.length > 0);
  for (const e of ev) {
    const text = readFileSync(join(s.home, "reviews", e.path), "utf8");
    assert.ok(!text.includes(SECRET), e.path);
    assert.match(text, /added \[redacted\]/);
  }
});

// ---------------------------------------------------------------- final fix pass (ruling 4F-8)

flow("4F-8 I-1 + n-3: the fix note of a failed case run carries the case, the platform's command, exit and output; specs.json and the note are redacted", async () => {
  const SECRET = "sk-fake-4f8-fedcba9876543210";
  redactorWith([SECRET]);
  const s = await setup({
    webAcceptance: null, apiAcceptance: CLI_ACCEPTANCE, apiFiles: cliFiles(), maxAttempts: 2,
    agent: (c) => {
      c.write("api/cases/list-empty.case.json", caseFile("list-empty", "AC-1", ["list"], { exitCode: 0, stdoutIncludes: ["(no items)"] }));
      c.write("api/cases/list-milk.case.json", JSON.stringify({ name: "list-milk", acId: "AC-2", kind: "happy", title: `milk ${SECRET}`, args: ["list"], expect: { exitCode: 0, stdoutIncludes: ["1. milk"] } }));
      // honest: the agent saw AC-2 fail and says so (no mismatch is recorded)
      return caseResult({ "AC-1": "pass", "AC-2": "fail" }, { "AC-1": "list-empty", "AC-2": "list-milk" });
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const first = s.reports().find((r) => r.attempt === 1)!;
  assert.equal(first.verdict, "failed");
  const fix = s.iterations().find((i) => i.trigger === "review_failed");
  assert.ok(fix, "a fix iteration started");
  const note = fix.note ?? "";
  assert.ok(note.includes('"name": "list-milk"'), note);
  assert.ok(note.includes('"1. milk"'), "the case's expectation");
  assert.ok(note.includes("$ ./bin/tool.mjs list"), "the platform's command line");
  assert.match(note, /exit 0/);
  assert.ok(note.includes('stdout does not include "1. milk"'), "the platform's failure");
  assert.ok(note.includes("(no items)"), "the platform's output");
  assert.ok(!note.includes(SECRET) && note.includes("[redacted]"), "the note is redacted");
  const specs = readFileSync(join(s.home, "reviews", KEY, `${first.seriesId}-1`, "specs.json"), "utf8");
  assert.ok(!specs.includes(SECRET), "specs.json is redacted");
  assert.match(specs, /\[redacted\]/);
});

const LIB_FIXTURE = join(import.meta.dirname, "fixtures/acceptance-lib");
const libFiles = (): Files => Object.fromEntries(readdirSync(LIB_FIXTURE).map((f) => [f, readFileSync(join(LIB_FIXTURE, f), "utf8")]));

flow("4F-8 I-2: a library case's evidence shows the example's code as well as `$ node examples/x.mjs` and its output", async () => {
  const s = await setup({
    webAcceptance: null, apiAcceptance: { entry: "library", library: { runtime: "node", import: "acceptance-lib", path: "." } }, apiFiles: libFiles(), maxAttempts: 1,
    agent: (c) => {
      c.write("api/examples/slug.mjs", "import assert from 'node:assert/strict';\nimport { slugify } from 'acceptance-lib';\n// MARK-EXAMPLE-CODE\nconsole.log(slugify(' Hello World '));\n");
      c.write("api/cases/slug-basic.case.json", JSON.stringify({ name: "slug-basic", acId: "AC-1", kind: "happy", title: "slug", args: [], example: "slug.mjs", expect: { exitCode: 0, stdoutIncludes: ["hello-world"] } }));
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "slug-basic", "AC-2": "slug-basic" });
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const rep = s.reports().at(-1)!;
  assert.equal(rep.verdict, "passed", JSON.stringify(rep.report, null, 2));
  const ev = s.db.prepare("SELECT path FROM review_evidence WHERE report_id = ?").all(rep.id) as Array<{ path: string }>;
  assert.ok(ev.length > 0);
  for (const e of ev) {
    const text = readFileSync(join(s.home, "reviews", e.path), "utf8");
    assert.ok(text.startsWith("$ node examples/slug.mjs\n--- example examples/slug.mjs ---\n"), text.slice(0, 120));
    assert.ok(text.includes("| // MARK-EXAMPLE-CODE"), text);
    assert.match(text, /--- stdout ---\nhello-world\n/);
  }
});

flow("4F-8 I-3: a CLI entry's testCommand runs in the platform's re-run like phase 3's (sandboxed, the app env) and is reported as the project's e2e", async () => {
  const s = await setup({
    webAcceptance: null, apiAcceptance: { ...CLI_ACCEPTANCE, testCommand: "node e2e.mjs" },
    apiFiles: { ...cliFiles(), "e2e.mjs": "console.log('MARK-PROJECT-E2E ran in ' + process.cwd());\nprocess.exit(1);\n" }, maxAttempts: 1,
    agent: (c) => {
      c.write("api/cases/list-empty.case.json", caseFile("list-empty", "AC-1", ["list"], { exitCode: 0, stdoutIncludes: ["(no items)"] }));
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "list-empty", "AC-2": "list-empty" });
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const rep = s.reports().at(-1)!;
  assert.equal(rep.report.projectE2e.length, 1, JSON.stringify(rep.report.projectE2e));
  const e2e = rep.report.projectE2e[0]!;
  assert.equal(e2e.command, "node e2e.mjs");
  assert.equal(e2e.exitCode, 1);
  assert.match(e2e.outputTail, /MARK-PROJECT-E2E ran in .*-rerun-[^/]+\/work\/api/, "in the platform's re-run");
  assert.equal(rep.verdict, "passed", "extra evidence only: it never decides an AC");
});

flow("4F-8 I-4: install and build see the server's PATH and HOME (as phase 3's acceptance install); a case does not", async () => {
  const root = realpathSync(tmpDir("rv-env"));
  roots.push(root);
  const marker = join(root, "server-bin");
  const serverHome = join(root, "server-home");
  mkdirSync(marker);
  mkdirSync(serverHome);
  const check = `const ok = (process.env.PATH ?? "").split(":").includes(${JSON.stringify(marker)}) && process.env.HOME === ${JSON.stringify(serverHome)};\nif (!ok) { console.error("ENV-MISSING PATH=" + process.env.PATH + " HOME=" + process.env.HOME); process.exit(5); }\n`;
  const s = await setup({
    webAcceptance: null, apiAcceptance: { ...CLI_ACCEPTANCE, install: "node install.mjs", build: "node build.mjs" },
    apiFiles: { ...cliFiles(), "install.mjs": check, "build.mjs": check }, maxAttempts: 1,
    agent: (c) => {
      c.write("api/cases/env-path.case.json", caseFile("env-path", "AC-1", ["env", "PATH"], { exitCode: 0 }));
      c.write("api/cases/env-home.case.json", caseFile("env-home", "AC-2", ["env", "HOME"], { exitCode: 0 }));
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "env-path", "AC-2": "env-home" });
    },
  });
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${marker}:${saved.PATH}`;
  process.env.HOME = serverHome;
  try {
    s.wf.handOff(KEY, "local");
    await s.idle();
  } finally {
    process.env.PATH = saved.PATH;
    process.env.HOME = saved.HOME;
  }
  const rep = s.reports().at(-1)!;
  assert.notEqual(rep.verdict, "not_executed", rep.report.notExecutedReason ?? "");
  assert.equal(rep.verdict, "passed", JSON.stringify(rep.report, null, 2));
  const ev = s.db.prepare("SELECT path FROM review_evidence WHERE report_id = ?").all(rep.id) as Array<{ path: string }>;
  const texts = ev.map((e) => readFileSync(join(s.home, "reviews", e.path), "utf8")).join("\n");
  assert.match(texts, /PATH=\S+/);
  assert.ok(!texts.includes(marker), "a case gets the minimal PATH");
  assert.ok(!texts.includes(serverHome), "a case's HOME is its work dir");
});

flow("4F-8 n-2: the platform's re-run sandboxes deny the agent's old run root (review-jobs passes oldRunRoot)", async () => {
  let planted = "";
  const s = await setup({
    webAcceptance: null, apiAcceptance: CLI_ACCEPTANCE, apiFiles: cliFiles(), maxAttempts: 1,
    agent: (c) => {
      planted = join(c.workDir, "agent-dir");
      mkdirSync(planted);
      c.write("api/cases/peek.case.json", caseFile("peek", "AC-1", ["read", planted], { exitCode: 0, stdoutIncludes: ["read: EPERM"] }));
      return caseResult({ "AC-1": "pass", "AC-2": "pass" }, { "AC-1": "peek", "AC-2": "peek" });
    },
  });
  s.wf.handOff(KEY, "local");
  await s.idle();
  const rep = s.reports().at(-1)!;
  assert.ok(planted !== "");
  assert.equal(rep.verdict, "passed", JSON.stringify(rep.report.specRun));
});
