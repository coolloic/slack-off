// Task 11: the multi-repo development loop (implement-ticket). Real throwaway git repos `api` and `web` under the OS
// temp dir; a fake agent run writes files into the ticket directory's worktrees. The platform reverts forbidden paths,
// runs each repo's checks, commits per repo through the repo's own hooks, and feeds failures back to the next step.
import { test as nodeTest } from "node:test";
import { existsSync as exists0 } from "node:fs";

// Task 5: every repo command runs under the macOS sandbox (fail closed elsewhere), so this whole file needs sandbox-exec.
const NO_SANDBOX_REASON =
  process.platform === "darwin" && exists0("/usr/bin/sandbox-exec") ? null : `development tests need macOS /usr/bin/sandbox-exec (platform ${process.platform})`;
const test = ((name: string, ...rest: unknown[]) =>
  NO_SANDBOX_REASON === null
    ? (nodeTest as (...a: unknown[]) => unknown)(name, ...rest)
    : nodeTest(name, { skip: NO_SANDBOX_REASON }, () => {})) as unknown as typeof nodeTest;
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DevStepResult, FetchedTicket, ProposeResult, Requirement, StepRepoResult } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import type { RunAgentRequest } from "../src/executor/run-agent.ts";
import { AgentInterruptedError } from "../src/executor/types.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import type { RepoContext } from "../src/projects/project-rules.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { recoverOnStartup } from "../src/workflow/recovery.ts";
import { getHooksPin, getTicket, listRepoWorkspaces, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { InvalidTransitionError, NotFoundError, ValidationError } from "../src/tickets/errors.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { addRequirement, listSolutions, recordChoice, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { addDesignDoc, markFinal } from "../src/design/design-repo.ts";
import { listIterations, startIteration } from "../src/development/dev-repo.ts";
import { stripTicketKey } from "../src/development/dev-jobs.ts";
import { developmentView } from "../src/http/views.ts";
import { ticketDir } from "../src/git/worktree.ts";
import { gitBin } from "../src/git/run.ts";
import { SANDBOX_EXEC, type SandboxCheck, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { tmpDir } from "./helpers/tmp.ts";

// phase 4a: a scratch HOME and no global / system git config for every repo and hook in this file (runProcess strips
// GIT_CONFIG_GLOBAL from the platform's git, so HOME is the lever there)
const scratchHome = realpathSync(tmpDir("dev-userhome"));
gitBin(); // resolve (xcrun) before HOME changes
process.env.HOME = scratchHome;
process.env.XDG_CONFIG_HOME = join(scratchHome, ".config");
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const KEY = "FAKE-1";

/** git for test setup only: per-repo identity via -c, never global config */
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const TODO_HOOK = '#!/bin/sh\nif git diff --cached | grep -q "^+.*TODO"; then\n  echo "TODO found"\n  exit 1\nfi\nexit 0\n';

type Files = Record<string, string>;

/** A repo on main with `files` committed; `*.sh`-like hooks under .githooks/ are committed executable. */
function makeRepo(parent: string, name: string, files: Files, opts: { hooksPath?: string; config?: Record<string, string> } = {}): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "commit.gpgsign", "false");
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
    if (p.startsWith(".githooks/")) chmodSync(join(dir, p), 0o755);
  }
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  if (opts.hooksPath) sh(dir, "config", "core.hooksPath", opts.hooksPath);
  for (const [k, v] of Object.entries(opts.config ?? {})) sh(dir, "config", k, v);
  return dir;
}

const cfg = (c: unknown) => JSON.stringify(c, null, 2) + "\n";
const API_FILES: Files = { "README.md": "# api\n", ".slackoff/config.json": cfg({ forbiddenPaths: ["infra/**"], commands: { test: "node --test" } }) };
const WEB_FILES: Files = { "README.md": "# web\n", ".slackoff/config.json": cfg({ commands: { test: "node --test" } }), ".githooks/pre-commit": TODO_HOOK };

const PASSING_TEST = 'import { test } from "node:test";\ntest("ok", () => {});\n';
const failingTest = (marker: string) => `import { test } from "node:test";\ntest("boom", () => { throw new Error("${marker}"); });\n`;

const requirement: Requirement = {
  background: "bg",
  functional: [{ id: "FR-1", text: "export" }],
  acceptanceCriteria: [{ id: "AC-1", text: "Export CSV", verifiable: true, source: { type: "description", ref: "description#p1", quote: "Export." } }],
  discussionOutcomes: [],
  openQuestions: [],
  draftComment: null,
};
const fetched: FetchedTicket = {
  loginRequired: false, key: KEY, title: "Export orders", description: "Export.", jiraUpdatedAt: null, status: null, comments: [], attachments: [],
};
const proposal: ProposeResult = {
  solutions: [
    { title: "Both", approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "M", affectedRepos: ["api", "web"], repoChanges: [{ repo: "api", summary: "x" }, { repo: "web", summary: "y" }] },
    { title: "Api only", approach: "b", changeScope: [], pros: [], cons: [], risks: [], complexity: "S", affectedRepos: ["api"], repoChanges: [{ repo: "api", summary: "x" }] },
  ],
};

/** What a fake implement-ticket step sees and may do. */
interface StepCtx {
  /** 1-based count of implement-ticket runs in this test */
  call: number;
  req: RunAgentRequest<unknown>;
  write(repo: string, path: string, content: string): void;
  wt(repo: string): string;
}
type Step = (c: StepCtx) => Partial<DevStepResult> | void;

interface Opts {
  api?: Files;
  web?: Files;
  apiRepo?: { hooksPath?: string; config?: Record<string, string> };
  webRepo?: { hooksPath?: string; config?: Record<string, string> };
  maxSteps?: number;
  hookTimeoutMs?: number;
  /** replaces the real sandbox self-check (Task 5) */
  sandboxCheck?: (scope: SandboxScope) => Promise<SandboxCheck>;
  allowUnsandboxed?: boolean;
  /** phase 4a (A-3): development.allowUnsandboxedHooks */
  allowUnsandboxedHooks?: boolean;
  /** phase 3 Task 9: replaces the acceptance job's enqueue */
  enqueueReview?: (key: string) => void;  /** F-4 (M-3): the Tailscale address(es) the server listens on */
  remoteHosts?: string[];
  /** phase 4a Task 4: development.localNetwork */
  localNetwork?: "denylist" | "allowlist";
}

function setup(steps: Step[] | ((c: StepCtx) => Partial<DevStepResult> | void), o: Opts = {}) {
  const parent = tmpDir("dev-repos");
  const API = makeRepo(parent, "api", o.api ?? API_FILES, o.apiRepo);
  const WEB = makeRepo(parent, "web", o.web ?? WEB_FILES, { hooksPath: ".githooks", ...o.webRepo });
  const home = tmpDir("dev-home");
  const db = openDatabase(":memory:");
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const config: Config = loadConfig(home);
  config.projects = { FAKE: { repos: [{ name: "api", path: API, baseBranch: "main" }, { name: "web", path: WEB, baseBranch: "main" }] } };
  config.development.maxSteps = o.maxSteps ?? 6;
  if (o.hookTimeoutMs !== undefined) config.development.hookTimeoutMs = o.hookTimeoutMs;
  if (o.allowUnsandboxed) config.development.allowUnsandboxedCommands = true;
  if (o.allowUnsandboxedHooks) config.development.allowUnsandboxedHooks = true;
  if (o.localNetwork) config.development.localNetwork = o.localNetwork;
  const source = new FakeTicketSource();
  source.tickets[KEY] = fetched;
  const calls: Array<RunAgentRequest<unknown>> = [];
  const started: Array<{ key: string; repos: RepoContext[] }> = [];
  const tdir = ticketDir(home, KEY);
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    if (req.role !== "implement-ticket") throw new Error(`unexpected run ${req.role}`);
    calls.push(req as RunAgentRequest<unknown>);
    const call = calls.length;
    const fn = typeof steps === "function" ? steps : steps[Math.min(call, steps.length) - 1]!;
    const ctx: StepCtx = {
      call,
      req: req as RunAgentRequest<unknown>,
      wt: (repo) => join(req.cwd, repo),
      write: (repo, p, content) => {
        const f = join(req.cwd, repo, p);
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, content);
      },
    };
    const out = fn(ctx) ?? {};
    return req.schema.parse({ summary: `step ${call}`, commitMessage: "work", done: false, testsRun: [], notes: "", ...out });
  };
  const make = () => {
    const queue = new JobQueue(1);
    const wf = createWorkflow({ updater: noUpdater,
      db, home, queue, source, run, config, bus,
      hooks: { onDevelopmentStarted: (key, repos) => started.push({ key, repos }), ...(o.enqueueReview ? { enqueueReview: o.enqueueReview } : {}) },
      ...(o.sandboxCheck ? { sandboxCheck: o.sandboxCheck } : {}),
      ...(o.remoteHosts ? { remoteHosts: () => o.remoteHosts! } : {}),
    });
    return { queue, wf };
  };
  upsertDiscovered(db, { key: KEY, title: "Export orders", url: "https://j/FAKE-1", status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(db, home, KEY, fetched);
  const { id: reqId } = addRequirement(db, KEY, snapshotId, requirement, "agent");
  saveSolutions(db, KEY, reqId, proposal.solutions);
  const sols = listSolutions(db, KEY);
  recordChoice(db, KEY, sols[0]!.id, "both repos", ["api", "web"]);
  const choiceId = (db.prepare("SELECT MAX(id) AS id FROM choice").get() as { id: number }).id;
  const doc = addDesignDoc(db, KEY, {
    requirementId: reqId,
    choiceId,
    doc: { contentMd: "## Overview\nDESIGN-OVERVIEW", repos: [{ repo: "api", contentMd: "API-STEPS" }, { repo: "web", contentMd: "WEB-STEPS" }], checklist: [], responses: [] },
  });
  markFinal(db, KEY, doc.id);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice", "designing", "design_final", "checking_snapshot", "developing"] as const) {
    transition(db, KEY, to, "system");
  }
  const s = {
    parent, API, WEB, home, db, bus, events, config, source, calls, started, tdir, sols, ...make(), make,
    state: () => getTicket(db, KEY)!.state,
    reason: () => getTicket(db, KEY)!.blockedReason ?? "",
    wt: (repo: string) => join(tdir, repo),
    iterations: () => listIterations(db, KEY),
    lastIteration: () => listIterations(db, KEY).at(-1)!,
    steps: () => listIterations(db, KEY).flatMap((i) => i.steps),
    repoResult: (step: number, repo: string, iteration?: number): StepRepoResult => {
      const it = iteration === undefined ? listIterations(db, KEY).at(-1)! : listIterations(db, KEY).find((i) => i.iteration === iteration)!;
      return it.steps.find((x) => x.step === step)!.repos.find((r) => r.repo === repo)!;
    },
    audits: (type: string) =>
      (db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ payload_json: string }>).map(
        (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
      ),
    /** commits on the ticket branch of `repo` not on main, oldest first */
    subjects: (repo: string) => sh(join(tdir, repo), "log", "--format=%s", "main..HEAD").trim().split("\n").filter((l) => l !== "").reverse(),
    status: (dir: string) => sh(dir, "status", "--porcelain", "-uall").trim(),
    /** run develop from the current state (resume) and wait for the queue */
    async go() {
      s.wf.resume(KEY);
      await s.queue.idle();
    },
    async restart() {
      const m = make();
      s.queue = m.queue;
      s.wf = m.wf;
      recoverOnStartup(db, s.wf);
      await s.queue.idle();
    },
  };
  return s;
}

const headOf = (dir: string) => sh(dir, "rev-parse", "HEAD").trim();
const branchOf = (dir: string) => sh(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();

// ---------------------------------------------------------------- happy path, violations, hook failure

test("two steps over api and web: per-repo commits prefixed with the key, forbidden path reverted and audited, hook failure fed back, dev_done", async () => {
  const seen: { dirs: string[]; webFileAtStep2: string | null } = { dirs: [], webFileAtStep2: null };
  let apiHead = "";
  let webHead = "";
  const s = setup([
    (c) => {
      seen.dirs = readdirSync(c.req.cwd).sort();
      c.write("api", "src/a.js", "export const a = 1;\n");
      c.write("api", "test/a.test.js", PASSING_TEST);
      c.write("api", "infra/x.tf", "resource {}\n");
      c.write("web", "src/b.js", "// TODO: finish\nexport const b = 2;\n");
      return { commitMessage: "FAKE-1: add the CSV export" };
    },
    (c) => {
      seen.webFileAtStep2 = readFileSync(join(c.wt("web"), "src/b.js"), "utf8");
      c.write("web", "src/b.js", "export const b = 2;\n");
      return { commitMessage: "finish the export button", done: true };
    },
  ]);
  apiHead = headOf(s.API);
  webHead = headOf(s.WEB);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());

  // the agent ran in the ticket directory, which holds only the affected repos
  assert.equal(s.calls[0]!.cwd, s.tdir);
  assert.deepEqual(seen.dirs, ["api", "web"]);
  assert.equal(s.calls[0]!.addDirs, undefined);
  // the only command form: cd <ticketDir>/<repo> && <cmd>
  assert.ok(s.calls[0]!.prompt.includes(`cd ${s.tdir}/api && node --test`), s.calls[0]!.prompt);
  assert.ok(s.calls[0]!.prompt.includes(`cd ${s.tdir}/web && node --test`));
  assert.match(s.calls[0]!.prompt, /^mode: step/);
  assert.match(s.calls[0]!.prompt, /DESIGN-OVERVIEW/);
  assert.match(s.calls[0]!.prompt, /WEB-STEPS/);
  assert.deepEqual(s.calls[0]!.policy?.commands, ["node --test"]);
  assert.ok(s.calls[0]!.policy?.denyPaths?.includes("infra/**"));
  assert.ok(s.calls[0]!.policy?.denyPaths?.includes(".githooks/**"));
  assert.ok(s.calls[0]!.allowedTools.includes("Bash(node --test)"));
  assert.deepEqual(s.calls[0]!.repos?.map((r) => r.name), ["api", "web"]);

  // step 1: api committed (no doubled key), infra reverted; web's hook refused the TODO and its change is kept
  const api1 = s.repoResult(1, "api");
  assert.equal(api1.commit.kind, "committed");
  assert.deepEqual(api1.violations, ["infra/x.tf"]);
  const web1 = s.repoResult(1, "web");
  assert.equal(web1.commit.kind, "hook_failed");
  assert.equal(web1.pendingChanges, true);
  assert.match(seen.webFileAtStep2 ?? "", /TODO/);
  assert.ok(s.calls[1]!.prompt.includes("TODO found"));

  assert.deepEqual(s.subjects("api"), ["FAKE-1: add the CSV export"]);
  assert.deepEqual(s.subjects("web"), ["FAKE-1: finish the export button"]);
  assert.ok(!existsSync(join(s.wt("api"), "infra/x.tf")));
  const apiFiles = sh(s.wt("api"), "log", "--name-only", "--format=", "main..HEAD");
  assert.ok(!apiFiles.includes("infra/x.tf"));
  assert.equal(s.status(s.wt("api")), "");
  assert.equal(s.status(s.wt("web")), "");

  const violations = s.audits("rule_violation");
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.repo, "api");

  // done: tests ran in every repo, including api which did not change in step 2
  const api2 = s.repoResult(2, "api");
  assert.ok(api2.tests.some((t) => t.command === "node --test" && t.exitCode === 0));
  const it = s.lastIteration();
  assert.equal(it.status, "done");
  assert.equal(it.trigger, "initial");
  const stepEvents = s.events.filter((e) => e.type === "dev_step");
  assert.deepEqual(stepEvents, [
    { type: "dev_step", ticketKey: KEY, iteration: 1, step: 1 },
    { type: "dev_step", ticketKey: KEY, iteration: 1, step: 2 },
  ]);

  // onDevelopmentStarted once, with both repo contexts
  assert.equal(s.started.length, 1);
  assert.deepEqual(s.started[0]!.repos.map((r) => r.name), ["api", "web"]);

  // the developer's own checkouts are untouched
  for (const [dir, head] of [[s.API, apiHead], [s.WEB, webHead]] as const) {
    assert.equal(headOf(dir), head);
    assert.equal(branchOf(dir), "main");
    assert.equal(s.status(dir), "");
  }
  const ws = listRepoWorkspaces(s.db, KEY);
  assert.deepEqual(ws.map((w) => [w.repo, w.branch, w.worktreePath]), [
    ["api", "feat/FAKE-1-export-orders", s.wt("api")],
    ["web", "feat/FAKE-1-export-orders", s.wt("web")],
  ]);
});

test("stripTicketKey removes only this ticket's leading key", () => {
  assert.equal(stripTicketKey("FAKE-1: add x", "FAKE-1"), "add x");
  assert.equal(stripTicketKey("FAKE-1 add x", "FAKE-1"), "add x");
  assert.equal(stripTicketKey("[FAKE-1] add x", "FAKE-1"), "add x");
  assert.equal(stripTicketKey("UTF-8 safe export", "FAKE-1"), "UTF-8 safe export");
  assert.equal(stripTicketKey("FAKE-12 thing", "FAKE-1"), "FAKE-12 thing");
  assert.equal(stripTicketKey("FAKE-1:", "FAKE-1"), "FAKE-1:");
});

// ---------------------------------------------------------------- checks

test("api tests fail: api not committed (skipped_checks_failed, changes kept), web committed, the failure output reaches the next step", async () => {
  const s = setup([
    (c) => {
      c.write("api", "test/a.test.js", failingTest("BOOM-API-FAIL"));
      c.write("web", "src/b.js", "export const b = 2;\n");
    },
    (c) => {
      c.write("api", "test/a.test.js", PASSING_TEST);
      return { done: true };
    },
  ]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  const api1 = s.repoResult(1, "api");
  assert.equal(api1.commit.kind, "skipped_checks_failed");
  assert.equal(api1.pendingChanges, true);
  assert.ok(api1.tests.some((t) => t.exitCode !== 0));
  assert.equal(s.repoResult(1, "web").commit.kind, "committed");
  assert.match(s.calls[1]!.prompt, /BOOM-API-FAIL/);
  assert.equal(s.subjects("api").length, 1); // committed only at step 2
  assert.equal(s.subjects("web").length, 1);
});

test("done:true while api tests fail -> another step with the failure output; web's tests ran at done although it did not change", async () => {
  const s = setup([
    (c) => {
      c.write("api", "test/a.test.js", failingTest("STILL-FAILING"));
      return { done: true };
    },
    (c) => {
      c.write("api", "test/a.test.js", PASSING_TEST);
      return { done: true };
    },
  ]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[1]!.prompt, /STILL-FAILING/);
  const web1 = s.repoResult(1, "web");
  assert.equal(web1.commit.kind, "nothing");
  assert.ok(web1.tests.some((t) => t.command === "node --test" && t.exitCode === 0));
});

test("a repo without a test command reaches dev_done marked 'tests not run' (never passing)", async () => {
  const web = { ...WEB_FILES, ".slackoff/config.json": cfg({}) };
  const s = setup([(c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
    return { done: true };
  }], { web });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.match(s.lastIteration().summary ?? "", /web: tests not run \(no test command in \.slackoff\/config\.json\)/);
  assert.deepEqual(s.repoResult(1, "web").tests, []);
});

// ---------------------------------------------------------------- hooks

test("the hook keeps failing: blocked after maxSteps naming web; retry starts iteration 2 (retry) from clean worktrees, commits kept", async () => {
  let afterRetry: { api: string; web: string } | null = null;
  const s = setup((c) => {
    if (c.call <= 3) {
      c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
      c.write("web", "src/b.js", `// TODO ${c.call}\n`);
      return { done: true };
    }
    afterRetry = { api: s.status(c.wt("api")), web: s.status(c.wt("web")) };
    c.write("web", "src/b.js", "export const b = 2;\n");
    return { done: true };
  }, { maxSteps: 3 });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /did not finish within 3 steps/);
  assert.match(s.reason(), /web/);
  assert.equal(s.iterations()[0]!.status, "failed");
  const apiCommits = s.subjects("api").length;
  assert.ok(apiCommits >= 1);

  s.wf.retry(KEY, "device:4");
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(afterRetry, { api: "", web: "" });
  const its = s.iterations();
  assert.equal(its.length, 2);
  assert.equal(its[1]!.trigger, "retry");
  // the retry iteration names who retried (Task 13): audited on the iteration and on the state change
  const started = s.audits("dev_iteration_started").at(-1)!;
  assert.equal(started.trigger, "retry");
  assert.equal(started.decidedBy, "device:4");
  assert.equal(s.subjects("api").length, apiCommits);
});

test("hook timeout: web hook_failed with timedOut, the next prompt says the pre-commit hook timed out after the configured seconds", async () => {
  const web = { ...WEB_FILES, ".githooks/pre-commit": "#!/bin/sh\nsleep 5\nexit 0\n" };
  const s = setup([(c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
  }], { web, maxSteps: 2, hookTimeoutMs: 1000 });
  await s.go();
  const web1 = s.repoResult(1, "web");
  assert.equal(web1.commit.kind, "hook_failed");
  assert.equal(web1.commit.kind === "hook_failed" && web1.commit.timedOut, true);
  assert.match(s.calls[1]!.prompt, /pre-commit hook timed out after 1 s/);
  assert.equal(s.state(), "blocked");
});

test("hook tampering (S-3): the agent rewrites web's pre-commit to exit 0 and adds a TODO -> violation, hook restored, commit still refused", async () => {
  const s = setup([(c) => {
    c.write("web", ".githooks/pre-commit", "#!/bin/sh\nexit 0\n");
    c.write("web", "src/b.js", "// TODO sneaky\n");
  }], { maxSteps: 1 });
  await s.go();
  const web1 = s.repoResult(1, "web");
  assert.deepEqual(web1.violations, [".githooks/pre-commit"]);
  assert.equal(web1.commit.kind, "hook_failed");
  assert.equal(readFileSync(join(s.wt("web"), ".githooks/pre-commit"), "utf8"), TODO_HOOK);
  assert.ok(s.audits("rule_violation").some((v) => v.repo === "web"));
  assert.equal(s.subjects("web").length, 0);
});

test("the agent edits api/.slackoff/config.json -> reverted and recorded, never committed", async () => {
  const s = setup([(c) => {
    c.write("api", ".slackoff/config.json", cfg({ commands: {} }));
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(s.repoResult(1, "api").violations, [".slackoff/config.json"]);
  assert.equal(readFileSync(join(s.wt("api"), ".slackoff/config.json"), "utf8"), API_FILES[".slackoff/config.json"]);
  assert.ok(!sh(s.wt("api"), "log", "--name-only", "--format=", "main..HEAD").includes(".slackoff"));
});

test("api configures core.hooksPath=.husky/_ without an install command -> blocked at the start naming api, agent never called", async () => {
  const s = setup([() => ({ done: true })], { apiRepo: { hooksPath: ".husky/_" } });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /api/);
  assert.match(s.reason(), /not installed/);
  assert.equal(s.calls.length, 0);
});

test("commit signing that needs a passphrase -> blocked with the signing message naming the repo (T7-1)", async () => {
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
  }], { apiRepo: { config: { "commit.gpgsign": "true", "gpg.program": "false" } } });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /Commit signing needs your passphrase — unlock your GPG agent or turn off signing for api/);
});

// ---------------------------------------------------------------- install (S-4)

test("install runs once when web's worktree is created; the files it changed are reset and listed; a reused worktree does not install again", async () => {
  const install = 'import { writeFileSync, appendFileSync } from "node:fs";\nappendFileSync("README.md", "installed\\n");\nwriteFileSync("generated.txt", "x\\n");\n';
  const web = { ...WEB_FILES, "install.mjs": install, ".slackoff/config.json": cfg({ commands: { test: "node --test", install: "node install.mjs" } }) };
  let cleanAtStep1: string | null = null;
  const s = setup([(c) => {
    if (c.call === 1) cleanAtStep1 = s.status(c.wt("web"));
    return { done: true };
  }], { web });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(cleanAtStep1, "");
  const w = listRepoWorkspaces(s.db, KEY).find((x) => x.repo === "web")!;
  assert.deepEqual([...w.install!.resetPaths].sort(), ["README.md", "generated.txt"]);
  assert.equal(w.install!.run.exitCode, 0);
  assert.equal(listRepoWorkspaces(s.db, KEY).find((x) => x.repo === "api")!.install, null);

  s.wf.requestChanges(KEY, "one more thing", "local");
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(s.audits("repo_installed").length, 1);
});

// ---------------------------------------------------------------- forbidden-only loop

test("three consecutive steps that only touch forbidden paths -> blocked naming the repo and path", async () => {
  const s = setup((c) => {
    c.write("api", "infra/x.tf", "resource {}\n");
  }, { maxSteps: 10 });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /agent keeps editing forbidden paths: api\/infra\/x\.tf/);
  assert.equal(s.calls.length, 3);
});

// ---------------------------------------------------------------- restarts

test("restart in the middle of step 2 (unrecorded): both worktrees' uncommitted files are discarded and step 2 runs again", async () => {
  let interrupted = false;
  let seenAtRerun: { api: string; web: string } | null = null;
  const s = setup((c) => {
    if (c.call === 1) {
      c.write("api", "src/a.js", "export const a = 1;\n");
      c.write("web", "src/b.js", "export const b = 1;\n");
      return {};
    }
    if (!interrupted) {
      interrupted = true;
      c.write("api", "src/half.js", "half\n");
      c.write("web", "src/half.js", "half\n");
      throw new AgentInterruptedError();
    }
    seenAtRerun = { api: s.status(c.wt("api")), web: s.status(c.wt("web")) };
    assert.match(c.req.prompt, /^step: 2 of/m);
    return { done: true };
  });
  const apiHead = headOf(s.API);
  await s.go();
  assert.equal(s.state(), "developing");
  assert.ok(existsSync(join(s.wt("api"), "src/half.js")));
  await s.restart();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(seenAtRerun, { api: "", web: "" });
  assert.deepEqual(s.lastIteration().steps.map((x) => x.step), [1, 2]);
  assert.equal(headOf(s.API), apiHead);
  assert.equal(s.status(s.API), "");
  assert.equal(branchOf(s.API), "main");
});

test("restart after a recorded hook-failure step keeps web's changes for the next step", async () => {
  let interrupted = false;
  let webAtRerun = "";
  const s = setup((c) => {
    if (c.call === 1) {
      c.write("web", "src/b.js", "// TODO\n");
      return {};
    }
    if (!interrupted) {
      interrupted = true;
      throw new AgentInterruptedError();
    }
    webAtRerun = readFileSync(join(c.wt("web"), "src/b.js"), "utf8");
    c.write("web", "src/b.js", "export const b = 2;\n");
    return { done: true };
  });
  await s.go();
  assert.equal(s.state(), "developing");
  await s.restart();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(webAtRerun, "// TODO\n");
});

test("restart in developing before the develop job was enqueued (crash after the move) -> recovery starts development", async () => {
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }]);
  // nothing enqueued yet: the ticket sits in developing as after a crash right after the move
  await s.restart();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(s.calls.length, 1);
});

// ---------------------------------------------------------------- unusable / changed repos (P-C8, P-C9)

test("web's base branch is missing -> blocked naming web, api's worktree kept; fixed mapping + retry continues", async () => {
  let fail = true;
  const s = setup((c) => {
    if (fail) throw new Error("agent crashed");
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.ok(existsSync(s.wt("api")) && existsSync(s.wt("web")));
  s.config.projects.FAKE!.repos[1] = { ...s.config.projects.FAKE!.repos[1]!, baseBranch: "develop" };
  s.wf.retry(KEY, "local");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /web/);
  assert.ok(existsSync(s.wt("api")));
  s.config.projects.FAKE!.repos[1] = { ...s.config.projects.FAKE!.repos[1]!, baseBranch: "main" };
  fail = false;
  s.wf.retry(KEY, "local");
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
});

test("a symlinked .githooks pointing outside (WorktreeError) -> blocked naming the repo", async () => {
  const s = setup([(c) => {
    rmSync(join(c.wt("web"), ".githooks"), { recursive: true, force: true });
    const outside = tmpDir("outside");
    writeFileSync(join(outside, "pre-commit"), "#!/bin/sh\nexit 0\n");
    execFileSync("ln", ["-s", outside, join(c.wt("web"), ".githooks")]);
    c.write("web", "src/b.js", "export const b = 2;\n");
  }]);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /web/);
});

test("title changed before development again: the stored branch is reused; web's baseBranch changed: the branch is kept", async () => {
  const s = setup([(c) => {
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  }]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  s.db.prepare("UPDATE ticket SET title = 'A completely new title' WHERE key = ?").run(KEY);
  sh(s.WEB, "branch", "release", "main");
  s.config.projects.FAKE!.repos[1] = { ...s.config.projects.FAKE!.repos[1]!, baseBranch: "release" };
  s.wf.requestChanges(KEY, "again", "local");
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
  const ws = listRepoWorkspaces(s.db, KEY);
  assert.deepEqual(ws.map((w) => w.branch), ["feat/FAKE-1-export-orders", "feat/FAKE-1-export-orders"]);
  assert.equal(ws.find((w) => w.repo === "web")!.baseBranch, "main");
  assert.equal(branchOf(s.wt("web")), "feat/FAKE-1-export-orders");
});

test("web's mapped path changed -> blocked naming web and both paths", async () => {
  const s = setup([(c) => {
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  }]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  const other = makeRepo(tmpDir("dev-other"), "web", WEB_FILES, { hooksPath: ".githooks" });
  s.config.projects.FAKE!.repos[1] = { ...s.config.projects.FAKE!.repos[1]!, path: other };
  s.wf.requestChanges(KEY, "again", "local");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /web: mapped path changed from .* to .*/);
});

/** dev_done -> rechoose -> choose the api-only solution (debate skipped) -> developing again. */
function rechooseApiOnly(s: ReturnType<typeof setup>) {
  s.wf.rechoose(KEY, "local");
  recordChoice(s.db, KEY, s.sols[1]!.id, "api only", ["api"]);
  for (const to of ["designing", "design_final", "checking_snapshot", "developing"] as const) transition(s.db, KEY, to, "system");
}

test("rechoose to api only: web's worktree and workspace row are removed, its branch kept; the agent only sees api", async () => {
  let dirs: string[] = [];
  const s = setup((c) => {
    dirs = readdirSync(c.req.cwd).sort();
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  rechooseApiOnly(s);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(dirs, ["api"]);
  assert.ok(!existsSync(s.wt("web")));
  assert.deepEqual(listRepoWorkspaces(s.db, KEY).map((w) => w.repo), ["api"]);
  assert.match(sh(s.WEB, "branch", "--list", "feat/FAKE-1-export-orders"), /feat\/FAKE-1-export-orders/);
  assert.ok(s.audits("worktree_removed").some((p) => p.repo === "web"));
});

test("rechoose to api only while web has uncommitted files -> blocked naming web, worktree kept", async () => {
  const s = setup((c) => {
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  writeFileSync(join(s.wt("web"), "stray.txt"), "x\n");
  rechooseApiOnly(s);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /web is no longer affected but its worktree has uncommitted changes/);
  assert.ok(existsSync(join(s.wt("web"), "stray.txt")));
});

// ---------------------------------------------------------------- request changes

test("requestChanges: empty note -> ValidationError; with a note -> new iteration 'developer_request' with the note in the prompt", async () => {
  const s = setup((c) => {
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.throws(() => s.wf.requestChanges(KEY, "  ", "local"), ValidationError);
  assert.equal(s.state(), "dev_done");
  s.wf.requestChanges(KEY, "Rename the button to CSV-NOTE-42", "local");
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
  const its = s.iterations();
  assert.equal(its.length, 2);
  assert.equal(its[1]!.trigger, "developer_request");
  assert.equal(its[1]!.note, "Rename the button to CSV-NOTE-42");
  assert.match(s.calls.at(-1)!.prompt, /CSV-NOTE-42/);
  assert.equal(s.started.length, 1); // only on the first development
});

test("repo commands never inherit the platform's own test-runner context (NODE_TEST_CONTEXT would make a nested `node --test` pass)", async () => {
  const { gitEnv } = await import("../src/git/run.ts");
  const env = gitEnv({ PATH: "/bin", NODE_TEST_CONTEXT: "child-v8", HUSKY: "0", GIT_DIR: "/x" });
  assert.deepEqual(env, { PATH: "/bin", GIT_TERMINAL_PROMPT: "0" });
});

// ---------------------------------------------------------------- fix round 1

test("T11-1: a check that writes a forbidden file (api's test writes infra/leak.tf) -> reverted before the commit, recorded as a violation", async () => {
  const leaky = 'import { test } from "node:test";\nimport { mkdirSync, writeFileSync } from "node:fs";\ntest("leak", () => { mkdirSync("infra", { recursive: true }); writeFileSync("infra/leak.tf", "x\\n"); });\n';
  const s = setup([(c) => {
    c.write("api", "test/leak.test.js", leaky);
    return { done: true };
  }]);
  await s.go();
  const api1 = s.repoResult(1, "api");
  assert.equal(api1.commit.kind, "committed");
  assert.ok(api1.violations.includes("infra/leak.tf"), JSON.stringify(api1.violations));
  assert.ok(!sh(s.wt("api"), "log", "--name-only", "--format=", "main..HEAD").includes("infra/"));
  assert.ok(!existsSync(join(s.wt("api"), "infra/leak.tf")));
  assert.ok(s.audits("rule_violation").some((v) => v.repo === "api" && (v.paths as string[]).includes("infra/leak.tf")));
  assert.equal(s.state(), "dev_done", s.reason());
});

test("T11-1: done-time tests that dirty the tree -> not dev_done; the repo is reported with pending changes", async () => {
  const dirty = 'import { test } from "node:test";\nimport { appendFileSync } from "node:fs";\ntest("dirty", () => { appendFileSync("README.md", "x\\n"); });\n';
  const web = { ...WEB_FILES, "test/dirty.test.js": dirty };
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }], { web, maxSteps: 1 });
  await s.go();
  assert.notEqual(s.state(), "dev_done");
  const web1 = s.repoResult(1, "web");
  assert.equal(web1.pendingChanges, true);
  assert.match(s.reason(), /web/);
});

test("T11-2: rechoose then develop -> a new branch -<n> from the base branch; the old branch and its commits are kept", async () => {
  const s = setup((c) => {
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  const oldBranch = "feat/FAKE-1-export-orders";
  const oldHead = sh(s.API, "rev-parse", oldBranch).trim();
  rechooseApiOnly(s);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  const api = listRepoWorkspaces(s.db, KEY).find((w) => w.repo === "api")!;
  assert.equal(api.branch, `${oldBranch}-2`);
  assert.equal(branchOf(s.wt("api")), `${oldBranch}-2`);
  assert.deepEqual(s.subjects("api"), ["FAKE-1: work"]); // only the new choice's commit, from main
  assert.equal(sh(s.API, "rev-parse", oldBranch).trim(), oldHead);
  assert.ok(s.audits("repo_workspace_changed").some((p) => p.repo === "api"));
  // the same choice again (request changes) keeps the branch
  s.wf.requestChanges(KEY, "more", "local");
  await s.queue.idle();
  assert.equal(listRepoWorkspaces(s.db, KEY).find((w) => w.repo === "api")!.branch, `${oldBranch}-2`);
});

test("T11-2: rechoose while the kept repo's worktree is dirty -> blocked naming it, nothing re-branched", async () => {
  const s = setup((c) => {
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  });
  await s.go();
  writeFileSync(join(s.wt("api"), "stray.txt"), "x\n");
  rechooseApiOnly(s);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /^api/);
  assert.equal(listRepoWorkspaces(s.db, KEY).find((w) => w.repo === "api")!.branch, "feat/FAKE-1-export-orders");
});

test("install: a failed install blocks naming the repo; retry runs it again", async () => {
  const marker = join(tmpDir("install"), "ok");
  const install = `import { existsSync } from "node:fs";\nif (!existsSync(${JSON.stringify(marker)})) { console.log("INSTALL-BROKE"); process.exit(3); }\n`;
  const web = { ...WEB_FILES, "install.mjs": install, ".slackoff/config.json": cfg({ commands: { test: "node --test", install: "node install.mjs" } }) };
  const s = setup([() => ({ done: true })], { web });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /^web: install/);
  assert.match(s.reason(), /INSTALL-BROKE/);
  writeFileSync(marker, "");
  s.wf.retry(KEY, "local");
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(listRepoWorkspaces(s.db, KEY).find((w) => w.repo === "web")!.install!.run.exitCode, 0);
});

test("install: a worktree without a recorded install (install declared later) installs on the next development", async () => {
  // the script is on the ticket branch from the start; only the declaration comes later (on the base branch)
  const web = { ...WEB_FILES, "install.mjs": 'import { writeFileSync } from "node:fs";\nwriteFileSync("gen.txt", "x\\n");\n' };
  const s = setup([() => ({ done: true })], { web });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(listRepoWorkspaces(s.db, KEY).find((w) => w.repo === "web")!.install, null);
  writeFileSync(join(s.WEB, ".slackoff/config.json"), cfg({ commands: { test: "node --test", install: "node install.mjs" } }));
  sh(s.WEB, "add", "-A");
  sh(s.WEB, "commit", "-q", "-m", "declare install");
  s.wf.requestChanges(KEY, "again", "local");
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(listRepoWorkspaces(s.db, KEY).find((w) => w.repo === "web")!.install!.resetPaths, ["gen.txt"]);
});

test("the last step is recorded together with the state change: a failing dev_done move leaves no recorded step", async () => {
  const s = setup([() => ({ done: true })]);
  s.db.exec("CREATE TRIGGER no_done BEFORE UPDATE ON ticket WHEN NEW.state = 'dev_done' BEGIN SELECT RAISE(ABORT, 'no done'); END");
  await s.go();
  assert.equal(s.state(), "blocked");
  const it = s.lastIteration();
  assert.equal(it.status, "running");
  assert.equal(it.steps.length, 0);
});

test("a hook that merely prints 'signing failed' is a hook failure, not a signing problem", async () => {
  const web = { ...WEB_FILES, ".githooks/pre-commit": "#!/bin/sh\necho 'signing failed'\nexit 1\n" };
  const s = setup([(c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
  }], { web, maxSteps: 1 });
  await s.go();
  assert.equal(s.repoResult(1, "web").commit.kind, "hook_failed");
  assert.equal(s.state(), "blocked");
  assert.doesNotMatch(s.reason(), /Commit signing/);
  assert.match(s.reason(), /did not finish/);
});

// ---------------------------------------------------------------- fix round 2 (T11-3)

/** dev_done -> rechoose -> a new choice over `repos` (debate skipped) -> developing. */
function rechooseRepos(s: ReturnType<typeof setup>, repos: string[]) {
  s.wf.rechoose(KEY, "local");
  recordChoice(s.db, KEY, s.sols[repos.length > 1 ? 0 : 1]!.id, repos.join("+"), repos);
  for (const to of ["designing", "design_final", "checking_snapshot", "developing"] as const) transition(s.db, KEY, to, "system");
}

test("T11-3: leave and rejoin (api+web -> api -> api -> api+web): every repo on the same new branch, web from base without choice 1's work", async () => {
  const s = setup((c) => {
    for (const r of c.req.repos!) c.write(r.name, `src/${r.name[0]}${c.call}.js`, "export const x = 1;\n");
    return { done: true };
  });
  const root = "feat/FAKE-1-export-orders";
  await s.go(); // choice 1: api+web, writes a1/w1
  assert.equal(s.state(), "dev_done", s.reason());
  for (const repos of [["api"], ["api"], ["api", "web"]]) {
    rechooseRepos(s, repos);
    await s.go();
    assert.equal(s.state(), "dev_done", s.reason());
  }
  const ws = listRepoWorkspaces(s.db, KEY);
  assert.deepEqual(ws.map((w) => [w.repo, w.branch]), [["api", `${root}-4`], ["web", `${root}-4`]]);
  assert.equal(branchOf(s.wt("web")), `${root}-4`);
  assert.ok(!existsSync(join(s.wt("web"), "src/w1.js")));
  assert.deepEqual(s.subjects("web"), ["FAKE-1: work"]);
  // every earlier branch is kept
  for (const b of [root, `${root}-2`, `${root}-3`]) assert.match(sh(s.API, "branch", "--list", b), /feat\/FAKE-1-/);
  assert.match(sh(s.WEB, "branch", "--list", root), /feat\/FAKE-1-/);
});

test("T11-3: one common name even when the repos have different leftover branches", async () => {
  const s = setup((c) => {
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  });
  const root = "feat/FAKE-1-export-orders";
  await s.go();
  sh(s.WEB, "branch", `${root}-2`, "main"); // a leftover only web has
  rechooseRepos(s, ["api", "web"]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(listRepoWorkspaces(s.db, KEY).map((w) => w.branch), [`${root}-3`, `${root}-3`]);
});

test("T11-3: rows written before migration 7 (no choice id) on a ticket with several choices -> a fresh branch", async () => {
  const s = setup((c) => {
    c.write("api", `src/a${c.call}.js`, "export const a = 1;\n");
    return { done: true };
  });
  const root = "feat/FAKE-1-export-orders";
  await s.go();
  // as if written by the pre-migration-7 code: no choice id, no stored choice branch
  s.db.exec("UPDATE ticket_repo SET choice_id = NULL; DELETE FROM choice_branch;");
  rechooseRepos(s, ["api", "web"]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(listRepoWorkspaces(s.db, KEY).map((w) => w.branch), [`${root}-2`, `${root}-2`]);
});

test("install on a reused worktree reverts only what the install changed: kept agent work survives", async () => {
  const web = { ...WEB_FILES, "install.mjs": 'import { writeFileSync } from "node:fs";\nwriteFileSync("gen.txt", "x\\n");\n' };
  let interrupted = false;
  let webAtRerun = "";
  const s = setup((c) => {
    if (c.call === 1) {
      c.write("web", "src/b.js", "// TODO keep me\n");
      return {};
    }
    if (!interrupted) {
      interrupted = true;
      throw new AgentInterruptedError();
    }
    webAtRerun = readFileSync(join(c.wt("web"), "src/b.js"), "utf8");
    c.write("web", "src/b.js", "export const b = 2;\n");
    return { done: true };
  }, { web });
  await s.go();
  assert.equal(s.state(), "developing");
  writeFileSync(join(s.WEB, ".slackoff/config.json"), cfg({ commands: { test: "node --test", install: "node install.mjs" } }));
  sh(s.WEB, "add", "-A");
  sh(s.WEB, "commit", "-q", "-m", "declare install");
  await s.restart();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(webAtRerun, "// TODO keep me\n");
  assert.deepEqual(listRepoWorkspaces(s.db, KEY).find((w) => w.repo === "web")!.install!.resetPaths, ["gen.txt"]);
});

test("feedback lists the uncommitted files the checks produced, separately", async () => {
  const dirty = 'import { test } from "node:test";\nimport { appendFileSync } from "node:fs";\ntest("dirty", () => { appendFileSync("README.md", "x\\n"); });\n';
  const web = { ...WEB_FILES, "test/dirty.test.js": dirty };
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }], { web, maxSteps: 2 });
  await s.go();
  const web1 = s.repoResult(1, "web");
  assert.deepEqual(web1.checkOutputs, ["README.md"]);
  const prompt = s.calls[1]!.prompt;
  assert.match(prompt, /"uncommittedFilesFromChecks": \[\s*"README.md"\s*\]/);
});

// ---------------------------------------------------------------- F2-I1: the hooks gate is pinned at prepare time

/** Task 5: these exercise the platform's own tamper detection, behind the sandbox (which refuses the tampering itself,
 * see "real sandbox: a check cannot touch git metadata"): run with the developer's opt-out. */
const UNSANDBOXED = { sandboxCheck: async (): Promise<SandboxCheck> => ({ ok: false, detail: "sandbox-exec is not available on linux" }), allowUnsandboxed: true, allowUnsandboxedHooks: true };

const HOOKS_CHANGED = /^api: the git hooks changed since development started \(.+\) — check the repository; to accept the new hooks, use 'Accept new git hooks'$/;

test("F2-I1: a check that runs `git config core.hooksPath /tmp/x` -> blocked naming api, audited, nothing committed", async () => {
  // the sandbox refuses `git` as a declared command, so the check runs it from a script
  const redirect = 'import { execFileSync } from "node:child_process";\nexecFileSync("git", ["config", "core.hooksPath", "/tmp/x"]);\n';
  const api = { ...API_FILES, "redirect.mjs": redirect, ".slackoff/config.json": cfg({ commands: { lint: "node redirect.mjs", test: "node --test" } }) };
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
  }], { api, ...UNSANDBOXED });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), HOOKS_CHANGED);
  assert.deepEqual(s.subjects("api"), []);
  assert.ok(s.audits("hooks_changed").some((a) => a.repo === "api"));
});

test("F2-I1: a check that rewrites a hook in the common hooks dir -> blocked naming api, nothing committed", async () => {
  const rewrite =
    'import { execFileSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nimport { join } from "node:path";\n' +
    'const dir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { encoding: "utf8" }).trim();\n' +
    'writeFileSync(join(dir, "pre-commit"), "#!/bin/sh\\nexit 0\\n");\n';
  const api = { ...API_FILES, "rewrite.mjs": rewrite, ".slackoff/config.json": cfg({ commands: { lint: "node rewrite.mjs", test: "node --test" } }) };
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
  }], { api, ...UNSANDBOXED });
  const hooks = join(s.API, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n# original\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), HOOKS_CHANGED);
  assert.deepEqual(s.subjects("api"), []);
});

test("F2-I1: unchanged hooks configuration -> commits normally; the commit runs with the pinned hooks dir", async () => {
  const s = setup([(c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
    return { done: true };
  }]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(s.subjects("web"), ["FAKE-1: work"]);
  assert.equal(s.audits("hooks_changed").length, 0);
});

// ---------------------------------------------------------------- F2-R1: the hooks pin is persisted per (ticket, repo)

/** api's test file: points core.hooksPath at `dir` when `flag` exists (agent-written test code tampering at done time) */
const tamperingTest = (flag: string, dir: string) =>
  'import { test } from "node:test";\nimport { existsSync } from "node:fs";\nimport { execFileSync } from "node:child_process";\n' +
  `test("ok", () => { if (existsSync(${JSON.stringify(flag)})) execFileSync("git", ["config", "core.hooksPath", ${JSON.stringify(dir)}]); });\n`;

test("F2-R1: the pin is stored when the worktree is first prepared, and survives the run", async () => {
  const s = setup([(c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
    return { done: true };
  }]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  const pin = getHooksPin(s.db, KEY, "web");
  assert.equal(pin?.hooksPath, ".githooks");
  assert.match(pin?.hash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(getHooksPin(s.db, KEY, "api")?.hooksPath, null);
  assert.ok(s.audits("hooks_pinned").some((a) => a.repo === "web"));
});

test("F2-R1: agent test code tampers during the done-time tests -> blocked before dev_done; Retry stays blocked (never re-pinned); acceptHooks re-pins, Retry continues", async () => {
  const flag = join(tmpDir("flag"), "tamper");
  const evil = realpathSync(tmpDir("evil-hooks"));
  writeFileSync(join(evil, "pre-commit"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(evil, "pre-commit"), 0o755);
  const s = setup([
    (c) => {
      c.write("api", "test/a.test.js", tamperingTest(flag, evil));
    },
    (c) => {
      writeFileSync(flag, "1");
      c.write("web", "src/b.js", "export const b = 2;\n");
      return { done: true };
    },
    () => ({ done: true }),
  ], UNSANDBOXED);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), HOOKS_CHANGED);
  assert.ok(s.reason().includes(`core.hooksPath unset → ${evil}`), s.reason());
  assert.deepEqual(s.subjects("api"), ["FAKE-1: work"], "step 1 committed before the tampering");
  const pinned = getHooksPin(s.db, KEY, "api");
  assert.equal(pinned?.hooksPath, null);

  // Retry: prepare compares with the stored pin -> blocked again, agent not called, pin unchanged
  const calls = s.calls.length;
  s.wf.retry(KEY, "local");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), HOOKS_CHANGED);
  assert.equal(s.calls.length, calls);
  assert.deepEqual(getHooksPin(s.db, KEY, "api"), pinned);
  // a restart re-pins nothing either
  await s.restart();
  assert.deepEqual(getHooksPin(s.db, KEY, "api"), pinned);
  // the Development view flags the repo for "Accept new git hooks"
  const view = await developmentView(s.db, s.home, s.config, getTicket(s.db, KEY)!);
  assert.deepEqual(view.repos.map((r) => [r.name, r.hooksChanged]), [["api", true], ["web", false]]);

  // the developer accepts the new hooks (this computer), audited with both fingerprints; Retry continues
  rmSync(flag);
  await s.wf.acceptHooks(KEY, "api", "local");
  const re = s.audits("hooks_repinned");
  assert.equal(re.length, 1);
  assert.equal(re[0]!.repo, "api");
  assert.equal(re[0]!.decidedBy, "local");
  assert.equal((re[0]!.old as { hooksPath: string | null }).hooksPath, null);
  assert.equal((re[0]!.new as { hooksPath: string | null }).hooksPath, evil);
  assert.equal(getHooksPin(s.db, KEY, "api")?.hooksPath, evil);
  s.wf.retry(KEY, "local");
  await s.queue.idle();
  assert.equal(s.state(), "dev_done", s.reason());
});

test("F2-R1: hooks changed after dev_done -> Request changes is blocked in prepare naming the repo; acceptHooks needs a blocked ticket and a known repo", async () => {
  const s = setup([(c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
    return { done: true };
  }]);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  await assert.rejects(s.wf.acceptHooks(KEY, "web", "local"), InvalidTransitionError);
  writeFileSync(join(s.WEB, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
  sh(s.WEB, "config", "core.hooksPath", join(s.WEB, ".git", "hooks"));
  const calls = s.calls.length;
  s.wf.requestChanges(KEY, "tweak", "local");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /^web: the git hooks changed since development started/);
  assert.equal(s.calls.length, calls);
  await assert.rejects(s.wf.acceptHooks(KEY, "nope", "local"), NotFoundError);
});

// ---------------------------------------------------------------- Task 5: the local command sandbox (R-LOCAL)

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const noSandbox = async (): Promise<SandboxCheck> => ({ ok: false, detail: "sandbox-exec is not available on linux" });

test("sandbox self-check fails (switch off) -> blocked naming the repo and the sandbox setting; no command and no agent run", async () => {
  const marker = join(tmpDir("sbx-ran"), "ran");
  const install = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`;
  const web = { ...WEB_FILES, "install.mjs": install, ".slackoff/config.json": cfg({ commands: { test: "node --test", install: "node install.mjs" } }) };
  const scopes: SandboxScope[] = [];
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }], { web, sandboxCheck: async (sc) => (scopes.push(sc), noSandbox()) });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /^web: /);
  assert.match(s.reason(), /sandbox/);
  assert.match(s.reason(), /Run repository commands without the sandbox/);
  assert.equal(existsSync(marker), false, "the install never ran");
  assert.equal(s.calls.length, 0);
  const webCommon = realpathSync(join(s.WEB, ".git"));
  assert.deepEqual(scopes[0], {
    kind: "dev-install", home: s.home, allowInHome: s.tdir, repos: [],
    // T5-3: only web's worktree is writable; its git metadata never is
    writable: [s.wt("web")], gitProtect: [webCommon, join(s.wt("web"), ".git")],
  });
  assert.equal(s.audits("commands_unsandboxed").length, 0);
});

test("sandbox self-check fails before the agent's step (no install) -> blocked naming the repos, agent never called", async () => {
  const s = setup([() => ({ done: true })], { sandboxCheck: noSandbox });
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /^api, web: sandbox-exec is not available/);
  assert.equal(s.calls.length, 0);
});

test("sandbox self-check fails with the switch on -> commands run unsandboxed, audited once per step and repo, output says so", async () => {
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    c.write("api", "test/a.test.js", PASSING_TEST);
    return { done: true };
  }], { sandboxCheck: noSandbox, allowUnsandboxed: true, allowUnsandboxedHooks: true });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(s.calls[0]!.shellPrefix, undefined, "no sandbox wrapper without the sandbox");
  // phase 4a Task 6: the agent's Bash runs unsandboxed only with the switch's reason
  assert.equal(s.calls[0]!.unsandboxedReason, "sandbox-exec is not available on linux");
  const api1 = s.repoResult(1, "api");
  assert.ok(api1.tests[0]!.outputTail.startsWith("[not sandboxed: sandbox-exec is not available on linux]"), api1.tests[0]!.outputTail);
  const audits = s.audits("commands_unsandboxed");
  assert.deepEqual(
    audits.map((a) => a.repo).sort(),
    ["api", "web"],
    JSON.stringify(audits),
  );
  for (const a of audits) assert.deepEqual(Object.keys(a).sort(), ["reason", "repo"]);
  assert.equal(audits[0]!.reason, "sandbox-exec is not available on linux");
});

test("real sandbox: a repo's test cannot read SLACKOFF_HOME/slackoff.db but reads its own files; the agent's Bash runs through the sandboxed shell prefix", { skip: HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC}` }, async () => {
  const probe =
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\n' +
    'test("sandboxed", () => {\n  assert.equal(readFileSync("README.md", "utf8"), "# api\\n");\n' +
    '  assert.throws(() => readFileSync(process.env.PROBE_DB ?? "", "utf8"), (e) => e.code === "EPERM");\n});\n';
  const s = setup([(c) => {
    c.write("api", "test/sbx.test.js", probe.replace('process.env.PROBE_DB ?? ""', JSON.stringify(join(c.req.cwd, "..", "..", "slackoff.db"))));
    return { done: true };
  }]);
  writeFileSync(join(s.home, "slackoff.db"), "DB\n");
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason() + JSON.stringify(s.repoResult(1, "api").tests));
  const api1 = s.repoResult(1, "api");
  assert.equal(api1.tests[0]!.exitCode, 0, api1.tests[0]!.outputTail);
  assert.equal(api1.commit.kind, "committed");
  assert.equal(s.audits("commands_unsandboxed").length, 0);
  const wrapper = s.calls[0]!.shellPrefix!;
  assert.equal(wrapper, join(s.home, "sandbox", KEY, "shell-prefix"));
  assert.ok(!wrapper.startsWith(s.tdir), "the wrapper is outside the agent's writable ticket directory");
  assert.ok(readFileSync(wrapper, "utf8").includes(SANDBOX_EXEC));
  assert.equal(s.calls[0]!.policy?.commands?.length, 1);
});

test("T5-1: a declared command whose program is a path (./check.sh) is still offered: every Bash command is sandboxed by the prefix", { skip: HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC}` }, async () => {
  const api = { ...API_FILES, ".slackoff/config.json": cfg({ commands: { lint: "./check.sh", test: "node --test" } }), "check.sh": "#!/bin/sh\nexit 0\n" };
  const s = setup([() => ({ done: true })], { api });
  await s.go();
  assert.deepEqual([...(s.calls[0]!.policy?.commands ?? [])].sort(), ["./check.sh", "node --test"]);
  assert.ok(s.calls[0]!.prompt.includes(`cd ${s.tdir}/api && ./check.sh`));
});

test("real sandbox: a check cannot touch git metadata (hooksPath, hooks) — the tampering fails, nothing changes", { skip: HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC}` }, async () => {
  const tamper =
    'import { execFileSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nimport { join } from "node:path";\n' +
    'const out = [];\n' +
    'try { execFileSync("git", ["config", "core.hooksPath", "/tmp/x"], { stdio: "pipe" }); out.push("config:OK"); } catch { out.push("config:DENIED"); }\n' +
    'const dir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { encoding: "utf8" }).trim();\n' +
    'try { writeFileSync(join(dir, "pre-commit"), "#!/bin/sh\\nexit 0\\n"); out.push("hook:OK"); } catch (e) { out.push("hook:" + e.code); }\n' +
    'try { writeFileSync(".git", "gitdir: /tmp/evil\\n"); out.push("pointer:OK"); } catch (e) { out.push("pointer:" + e.code); }\n' +
    'console.log(out.join(" "));\n';
  const api = { ...API_FILES, "tamper.mjs": tamper, ".slackoff/config.json": cfg({ commands: { lint: "node tamper.mjs", test: "node --test" } }) };
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }], { api });
  const hooks = join(s.API, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n# original\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  await s.go();
  const lint = s.repoResult(1, "api").tests[0]!;
  assert.match(lint.outputTail, /config:DENIED hook:EPERM pointer:EPERM/, lint.outputTail);
  assert.throws(() => sh(s.API, "config", "--get", "core.hooksPath"), "core.hooksPath was never set");
  assert.match(readFileSync(join(hooks, "pre-commit"), "utf8"), /# original/);
  assert.equal(s.state(), "dev_done", s.reason());
});

test("T5-4: sandboxed install and checks use the ticket's own package caches under SLACKOFF_HOME/cache/<KEY>", { skip: HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC}` }, async () => {
  const install = 'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync(process.env.npm_config_cache, { recursive: true });\nwriteFileSync(process.env.npm_config_cache + "/probe", "x");\n';
  const web = { ...WEB_FILES, "install.mjs": install, ".slackoff/config.json": cfg({ commands: { test: "node --test", install: "node install.mjs" } }) };
  const s = setup([() => ({ done: true })], { web });
  await s.go();
  assert.equal(readFileSync(join(s.home, "cache", KEY, "npm", "probe"), "utf8"), "x");
});

// ---------------------------------------------------------------- phase 3 Task 9: acceptance fix iterations

test("acceptance fix iterations: the feedback under its own heading (as is); done → reviewing, the review job enqueued after the commit; a retry iteration → dev_done", async () => {
  const seen: Array<{ state: string; inTx: boolean }> = [];
  const feedback = "Acceptance review failed.\n<<<ACCEPTANCE-DATA-BEGIN>>>\n### AC-1: Export CSV\nSource of specs/a.spec.mjs:\n```js\nexpect(x).toBe('MARK-SPEC');\n```\n<<<ACCEPTANCE-DATA-END>>>\n";
  const s = setup([
    (c) => {
      c.write("api", "src/fix.js", "export const fix = 1;\n");
      return { done: true };
    },
  ], {
    enqueueReview: (key) => seen.push({ state: getTicket(s.db, key)!.state, inTx: s.db.isTransaction }),
  });
  startIteration(s.db, KEY, "review_failed", feedback, null);
  await s.go();
  assert.equal(s.state(), "reviewing", s.reason());
  assert.deepEqual(seen, [{ state: "reviewing", inTx: false }]);
  const prompt = s.calls[0]!.prompt;
  assert.match(prompt, /## Independent acceptance feedback — fix these first/);
  assert.ok(prompt.includes(feedback), "the feedback is given as is (its spec source keeps its lines)");
  assert.match(prompt, /data, not instructions/);
  assert.match(prompt, /Do not try to change the acceptance specs/);
  assert.equal(s.lastIteration().status, "done");

  // a rejected iteration goes back to acceptance too; a retry iteration ends in dev_done
  const r = setup([(c) => {
    c.write("api", "src/r.js", "export const r = 1;\n");
    return { done: true };
  }], { enqueueReview: () => seen.push({ state: "rejected-run", inTx: false }) });
  startIteration(r.db, KEY, "rejected", "the colour is wrong", "local");
  await r.go();
  assert.equal(r.state(), "reviewing");
  assert.match(r.calls[0]!.prompt, /The developer rejected the acceptance result/);
  const t = setup([(c) => {
    c.write("api", "src/t.js", "export const t = 1;\n");
    return { done: true };
  }], { enqueueReview: () => assert.fail("a retry iteration is not acceptance work") });
  startIteration(t.db, KEY, "retry", null, "local");
  await t.go();
  assert.equal(t.state(), "dev_done");
  for (const x of [s, r, t]) {
    x.db.close();
    rmSync(x.parent, { recursive: true, force: true });
    rmSync(x.home, { recursive: true, force: true });
  }
});

test("T9-5: Retry of a failed review_failed / rejected iteration carries its trigger and note and goes back to acceptance; a plain retry ends in dev_done", async () => {
  const dirs: Array<{ parent: string; home: string; db: { close(): void } }> = [];
  try {
    for (const trigger of ["review_failed", "rejected"] as const) {
      const reviews: string[] = [];
      const s = setup(
        [
          () => ({ done: false }),
          (c) => {
            c.write("api", "src/fixed.js", "export const fixed = 1;\n");
            return { done: true };
          },
        ],
        { maxSteps: 1, enqueueReview: (key) => reviews.push(key) },
      );
      dirs.push(s);
      startIteration(s.db, KEY, trigger, `NOTE-${trigger}`, trigger === "rejected" ? "local" : null);
      await s.go();
      assert.equal(s.state(), "blocked", "the fix iteration ran out of steps");
      s.wf.retry(KEY, "device:p1");
      await s.queue.idle();
      const its = s.iterations();
      assert.equal(its.length, 2);
      assert.equal(its[1]!.trigger, trigger, "the retry keeps the acceptance trigger");
      assert.equal(its[1]!.note, `NOTE-${trigger}`, "and its note");
      assert.equal(s.state(), "reviewing", s.reason());
      assert.deepEqual(reviews, [KEY]);
      assert.match(s.calls[1]!.prompt, /Independent acceptance feedback — fix these first/);
    }
  } finally {
    for (const x of dirs) {
      x.db.close();
      rmSync(x.parent, { recursive: true, force: true });
      rmSync(x.home, { recursive: true, force: true });
    }
  }
});

test("F-4 (M-3): with remote access listening on a Tailscale address, the command sandbox's scope carries it for the self-check", async () => {
  const scopes: SandboxScope[] = [];
  const web = { ...WEB_FILES, ".slackoff/config.json": cfg({ commands: { test: "node --test", install: "node install.mjs" } }) };
  const s = setup([() => ({ done: true })], { web, remoteHosts: ["100.101.102.103"], sandboxCheck: async (sc) => (scopes.push(sc), noSandbox()) });
  await s.go();
  assert.ok(scopes.length > 0);
  for (const sc of scopes) assert.deepEqual(sc.remoteHosts, ["100.101.102.103"]);
});

// ---------------------------------------------------------------- phase 4a Task 3: git hooks in the dev-hook sandbox

test("4a: the hook sandbox's self-check fails with the hooks switch off -> blocked naming web and the hooks setting; web not committed", async () => {
  const s = setup([(c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
    c.write("web", "test/b.test.js", PASSING_TEST);
    return { done: true };
  }], { sandboxCheck: noSandbox, allowUnsandboxed: true });
  const before = headOf(s.WEB);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason(), /^web: sandbox-exec is not available on linux — git hooks are not run without the sandbox/);
  assert.match(s.reason(), /"Run git hooks without the sandbox"/);
  assert.deepEqual(s.subjects("web"), [], "nothing committed (never --no-verify)");
  assert.equal(headOf(s.WEB), before);
  assert.equal(s.audits("hooks_unsandboxed").length, 0);
  assert.equal(existsSync(join(s.home, "sandbox", KEY, "web", "hooks")), false);
});

test("4a: the hook sandbox's self-check fails with the hooks switch on -> web committed with its hooks run unsandboxed, audited hooks_unsandboxed per commit", async () => {
  const s = setup([(c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
    c.write("web", "test/b.test.js", PASSING_TEST);
    return { done: true };
  }], { sandboxCheck: noSandbox, allowUnsandboxed: true, allowUnsandboxedHooks: true });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(s.subjects("web"), ["FAKE-1: work"]);
  assert.deepEqual(s.audits("hooks_unsandboxed"), [{ repo: "web", reason: "sandbox-exec is not available on linux" }]);
});

test("4a: a hook-less repo is committed without a hook self-check, through an empty wrapper dir (4A-4: no hook runs)", async () => {
  const scopes: SandboxScope[] = [];
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }], { sandboxCheck: async (sc) => (scopes.push(sc), { ok: true, detail: "ok" }), api: { ...API_FILES, ".slackoff/config.json": cfg({}) } });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(s.subjects("api"), ["FAKE-1: work"]);
  assert.ok(!scopes.some((sc) => sc.kind === "dev-hook"), JSON.stringify(scopes.map((x) => x.kind)));
  assert.deepEqual(readdirSync(join(s.home, "sandbox", KEY, "api", "hooks")), []);
});

test("4a real sandbox: web's pre-commit runs through the platform's wrapper in the dev-hook sandbox; a TODO is still refused", { skip: HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC}` }, async () => {
  const marker = "$TMPDIR/web-hook-ran";
  const web = { ...WEB_FILES, ".githooks/pre-commit": TODO_HOOK.replace("exit 0\n", `echo "$0" > "${marker}"\nexit 0\n`) };
  const s = setup([(c) => {
    c.write("web", "src/b.js", "// TODO later\n");
    c.write("web", "test/b.test.js", PASSING_TEST);
    return { done: false };
  }, (c) => {
    c.write("web", "src/b.js", "export const b = 2;\n");
    return { done: true };
  }], { web });
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.equal(s.repoResult(1, "web").commit.kind, "hook_failed");
  assert.match(s.repoResult(1, "web").commit.kind === "hook_failed" ? (s.repoResult(1, "web").commit as { outputTail: string }).outputTail : "", /TODO found/);
  assert.deepEqual(s.subjects("web"), ["FAKE-1: work"]);
  const wrappers = join(realpathSync(s.home), "sandbox", KEY, "web", "hooks");
  assert.deepEqual(readdirSync(wrappers), ["pre-commit"]);
  const ran = readFileSync(join(s.home, "cache", KEY, "tmp", "web-hook-ran"), "utf8").trim();
  assert.equal(ran, join(realpathSync(s.wt("web")), ".githooks", "pre-commit"), "the hook ran at its pinned path, with the ticket's TMPDIR");
  assert.equal(s.audits("hooks_unsandboxed").length, 0);
});

test("4A-4 (I1): a hook git runs outside HOOK_NAMES (post-index-change) runs only through the platform's wrapper, in the sandbox", { skip: HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC}` }, async () => {
  mkdirSync(join(scratchHome, ".ssh"), { recursive: true });
  writeFileSync(join(scratchHome, ".ssh/id"), "PRIVATE-KEY\n");
  const log = join(tmpDir("dev-pic"), "pic.log");
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }], { api: { ...API_FILES, ".slackoff/config.json": cfg({}) } });
  const hooks = join(s.API, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const probe = `${JSON.stringify(process.execPath)} -e 'try { require("node:fs").readFileSync(process.env.HOME + "/.ssh/id"); console.log("READ") } catch (e) { console.log(e.code) }' >> "${log}"`;
  writeFileSync(join(hooks, "post-index-change"), `#!/bin/sh\n${probe}\n`);
  chmodSync(join(hooks, "post-index-change"), 0o755);
  await s.go();
  assert.equal(s.state(), "dev_done", s.reason());
  assert.deepEqual(s.subjects("api"), ["FAKE-1: work"]);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(lines.length > 0 && lines.every((l) => l === "EPERM"), `post-index-change ran unsandboxed: ${lines.join(",")}`);
  assert.ok(readdirSync(join(s.home, "sandbox", KEY, "api", "hooks")).includes("post-index-change"));
});

test("phase 4a Task 4: allowlist mode — every command, agent and hook scope allows the union of the repos' sandbox.localPorts; denylist mode carries none", async () => {
  for (const mode of ["allowlist", "denylist"] as const) {
    const scopes: SandboxScope[] = [];
    const api = { ...API_FILES, ".slackoff/config.json": cfg({ commands: { test: "node --test" }, sandbox: { localPorts: [5432, 3000] } }) };
    const web = { ...WEB_FILES, ".slackoff/config.json": cfg({ commands: { test: "node --test", install: "node install.mjs" }, sandbox: { localPorts: [3000, 8080] } }) };
    const s = setup([(c) => {
      c.write("web", "src/b.js", "export const b = 2;\n");
      return { done: true };
    }], { api, web, localNetwork: mode, sandboxCheck: async (sc) => (scopes.push(sc), noSandbox()) });
    await s.go();
    assert.ok(scopes.length > 0, mode);
    const kinds = new Set(scopes.map((sc) => sc.kind));
    assert.ok(kinds.has("dev-install") || kinds.has("dev-command"), [...kinds].join(" "));
    for (const sc of scopes) {
      if (mode === "allowlist") assert.deepEqual(sc.localNetwork, { mode: "allowlist", allowPorts: [3000, 5432, 8080] }, sc.kind);
      else assert.equal(sc.localNetwork, undefined, sc.kind);
    }
  }
});

test("husky's generated .husky/_ (git-ignored) in the developer's checkout is copied into the worktree: development runs, the copy is audited", async () => {
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return { done: true };
  }], { api: { ...API_FILES, ".gitignore": ".husky/_\n" }, apiRepo: { hooksPath: ".husky/_" } });
  // what `npm install` (husky) left in the developer's checkout
  mkdirSync(join(s.API, ".husky", "_"), { recursive: true });
  writeFileSync(join(s.API, ".husky", "_", "pre-commit"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(s.API, ".husky", "_", "pre-commit"), 0o755);
  await s.go();
  assert.doesNotMatch(s.reason() ?? "", /not installed/);
  assert.ok(s.calls.length > 0, "the agent ran");
  const adopted = s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'hooks_adopted'").all() as Array<{ payload_json: string }>;
  assert.equal(adopted.length, 1);
  assert.deepEqual(JSON.parse(adopted[0]!.payload_json), { repo: "api", files: [".husky/_/pre-commit"] });
});

test("the agent asks for input (needsInput): development stops at once and the ticket is blocked with its question", async () => {
  const s = setup([() => ({ needsInput: "What focus ring does the reference show (colour, width)?" }), () => ({ done: true })]);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.equal(s.reason(), "Needs your input: What focus ring does the reference show (colour, width)? — answer it on the ticket, then Retry");
  assert.equal(s.calls.length, 1, "no further step");
});

test("two steps in a row that change nothing and are not done stop development instead of using up the steps", async () => {
  const s = setup([() => ({ summary: "gate unmet" }), () => ({ summary: "gate still unmet" }), () => ({ done: true })]);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.match(s.reason() ?? "", /^The agent changed nothing in 2 steps and did not finish: gate still unmet — answer what it needs on the ticket, then Retry$/);
  assert.equal(s.calls.length, 2);
});

test("answering on Retry: the note reaches the next step's prompt as the developer's answer, audited", async () => {
  const s = setup([
    () => ({ needsInput: "What focus ring does the reference show?" }),
    (c) => {
      c.write("api", "src/a.js", "export const ring = 2;\n");
      return { done: true };
    },
  ]);
  await s.go();
  assert.equal(s.state(), "blocked");
  s.wf.retry(KEY, "local", "2px white ring, 2px offset, as in the existing $stroke-focus");
  await s.queue.idle();
  const second = s.calls[1]!;
  assert.match(second.prompt, /developerAnswers/);
  assert.match(second.prompt, /2px white ring, 2px offset/);
  const audited = s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'developer_note_added'").all() as Array<{ payload_json: string }>;
  assert.equal(audited.length, 1);
  assert.throws(() => s.wf.retry(KEY, "local", "x".repeat(2001)));
});

test("the agent's question comes with suggested answers (one recommended); kept until Retry answers it", async () => {
  const s = setup([
    () => ({
      needsInput: "Does the banner CTA use .link?",
      answerOptions: [
        { label: "Yes, apply the fix", text: "Confirmed: the CTA uses .link; apply the .link fix.", recommended: true },
        { label: "It is in another repo", text: "The banner lives in another repository; stop here.", recommended: false },
      ],
    }),
    () => ({ done: true }),
  ]);
  await s.go();
  assert.equal(s.state(), "blocked");
  assert.deepEqual(s.wf.devQuestion(KEY), {
    question: "Does the banner CTA use .link?",
    options: [
      { label: "Yes, apply the fix", text: "Confirmed: the CTA uses .link; apply the .link fix.", recommended: true },
      { label: "It is in another repo", text: "The banner lives in another repository; stop here.", recommended: false },
    ],
  });
  s.wf.retry(KEY, "local", "Confirmed: the CTA uses .link; apply the .link fix.");
  assert.equal(s.wf.devQuestion(KEY), null, "answered: the question is gone");
});

test("resetBranch: an untouched ticket branch (no commits, clean) is removed with its worktrees; the next development names it afresh", async () => {
  const s = setup([() => ({ needsInput: "Which ring?" }), () => ({ done: true })]);
  await s.go();
  assert.equal(s.state(), "blocked");
  const before = s.db.prepare("SELECT branch FROM ticket_repo WHERE ticket_key = ?").all(KEY) as Array<{ branch: string }>;
  assert.ok(before.length > 0);
  const old = before[0]!.branch;
  assert.ok(existsSync(s.wt("api")));
  await s.wf.resetBranch(KEY, "local");
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM ticket_repo WHERE ticket_key = ?").get(KEY) as { n: number }).n, 0);
  assert.equal(existsSync(s.wt("api")), false);
  assert.equal(sh(s.API, "branch", "--list", old).trim(), "", "the empty branch is deleted");
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM choice_branch WHERE ticket_key = ?").get(KEY) as { n: number }).n, 0);
  assert.ok((s.db.prepare("SELECT type FROM audit_event WHERE type = 'branch_reset'").all() as unknown[]).length === 1);
  // the branch type is free again, and the name follows it on the next development
  s.wf.setBranchType(KEY, "chore", "local");
  assert.match(s.wf.branchType(KEY).name, /^chore\/FAKE-1-/);
});

test("resetBranch refuses a branch with commits (or while developing): nothing is removed", async () => {
  const s = setup([(c) => {
    c.write("api", "src/a.js", "export const a = 1;\n");
    return {};
  }, () => ({ needsInput: "stop here" })]);
  await s.go();
  assert.equal(s.state(), "blocked");
  await assert.rejects(s.wf.resetBranch(KEY, "local"), /has commits/);
  assert.ok(existsSync(s.wt("api")));
});
