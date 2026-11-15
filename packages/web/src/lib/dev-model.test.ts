import assert from "node:assert/strict";
import { test } from "node:test";
import type { IterationRecord, JiraWriteRecord, StepRecord, StepRepoResult } from "@slackoff/shared";
import type { DevelopmentRepo, DevelopmentResponse } from "./api.ts";
import { browserChoice, dirtyWorktreeHelp, hooksAcceptView, iterationView, jiraCard, jiraNote, repoViews } from "./dev-model.ts";

const repo = (over: Partial<DevelopmentRepo> = {}): DevelopmentRepo => ({
  name: "api",
  branch: "slackoff/PROJ-1-x",
  worktreePath: "/h/worktrees/PROJ-1/api",
  baseBranch: "main",
  baseBranchChanged: null,
  rulesFound: true,
  rulesError: null,
  commands: { test: "pnpm test" },
  forbiddenPaths: [],
  hooks: null,
  install: null,
  diffStat: null,
  commits: [],
  checkOutputs: [],
  pendingChanges: false,
  status: "green",
  ...over,
});

const result = (over: Partial<StepRepoResult> = {}): StepRepoResult => ({
  repo: "api",
  violations: [],
  tests: [{ command: "pnpm test", exitCode: 0, timedOut: false, outputTail: "ok" }],
  commit: { kind: "committed", sha: "abcdef1234567890" },
  pendingChanges: false,
  ...over,
});

const step = (n: number, repos: StepRepoResult[]): StepRecord => ({ id: n, step: n, summary: `step ${n}`, repos, createdAt: "2026-11-07T10:00:00Z" });

const iteration = (steps: StepRecord[], over: Partial<IterationRecord> = {}): IterationRecord & { steps: StepRecord[] } => ({
  id: 1,
  iteration: 1,
  trigger: "initial",
  note: null,
  status: "running",
  summary: null,
  startedAt: "2026-11-07T10:00:00Z",
  endedAt: null,
  steps,
  ...over,
});

const dev = (repos: DevelopmentRepo[], iterations: Array<IterationRecord & { steps: StepRecord[] }> = []): DevelopmentResponse => ({
  branch: "slackoff/PROJ-1-x",
  ticketDir: "/h/worktrees/PROJ-1",
  repos,
  iterations,
  jiraWrites: [],
  jiraSync: { enabled: false, targetStatus: "In Progress", note: null },
});

test("repoViews: the server's status is used as is (P-C18) — not_run is never shown as green", () => {
  const [v] = repoViews(dev([repo({ status: "not_run", commands: {} })], [iteration([step(1, [result({ tests: [] })])])]));
  assert.equal(v!.status, "not_run");
  const [w] = repoViews(dev([repo({ status: "working" })], [iteration([step(1, [result({ tests: [{ command: "t", exitCode: 1, timedOut: false, outputTail: "" }] })])])]));
  assert.equal(w!.status, "working", "no re-derivation from failing tests either");
});

test("repoViews: commits are shortened to 7 characters, last tests / hook / violations from the repo's steps", () => {
  const failingHook = { kind: "hook_failed" as const, timedOut: false, outputTail: "lint error" };
  const [v] = repoViews(
    dev(
      [repo({ commits: [{ sha: "0123456789abcdef", subject: "PROJ-1: add x" }] })],
      [iteration([step(1, [result({ violations: ["infra/main.tf"] })]), step(2, [result({ commit: failingHook, violations: [".slackoff/config.json"] })])])],
    ),
  );
  assert.deepEqual(v!.commits, [{ sha7: "0123456", subject: "PROJ-1: add x" }]);
  assert.deepEqual(v!.lastHook, failingHook);
  assert.equal(v!.lastTests.length, 1);
  assert.deepEqual(v!.violations, ["infra/main.tf", ".slackoff/config.json"]);
});

test("repoViews: the repo's own results only; nothing recorded yet → empty", () => {
  const [, web] = repoViews(dev([repo(), repo({ name: "web" })], [iteration([step(1, [result()])])]));
  assert.equal(web!.name, "web");
  assert.deepEqual(web!.lastTests, []);
  assert.equal(web!.lastHook, null);
  assert.deepEqual(web!.violations, []);
});

test("repoViews: install reset paths and a changed base branch each give one note", () => {
  const [v] = repoViews(
    dev([
      repo({
        install: { run: { command: "pnpm install", exitCode: 0, timedOut: false, outputTail: "" }, resetPaths: ["pnpm-lock.yaml", "x.json"] },
        baseBranchChanged: { stored: "main", mapped: "develop" },
      }),
    ]),
  );
  assert.equal(v!.notes.length, 2);
  assert.equal(v!.notes[0], "Reset after install: pnpm-lock.yaml, x.json");
  assert.equal(v!.notes[1], "Base branch changed to develop — this ticket keeps slackoff/PROJ-1-x from main");
  const [plain] = repoViews(dev([repo({ install: { run: { command: "i", exitCode: 0, timedOut: false, outputTail: "" }, resetPaths: [] } })]));
  assert.deepEqual(plain!.notes, []);
});

test("iterationView: tests passed / failed / not_run and the hook outcome for one repo", () => {
  const it = iteration([step(1, [result(), result({ repo: "web", tests: [], commit: { kind: "hook_failed", timedOut: true, outputTail: "" } })])]);
  const api = iterationView(it, "api");
  assert.equal(api.tests, "passed");
  assert.equal(api.hook, "passed");
  assert.match(api.title, /Iteration 1/);
  const web = iterationView(it, "web");
  assert.equal(web.hook, "timed_out");
  assert.equal(web.tests, "not_run");
  const failed = iterationView(iteration([step(1, [result({ tests: [{ command: "t", exitCode: null, timedOut: true, outputTail: "" }], commit: { kind: "skipped_checks_failed" } })])]), "api");
  assert.equal(failed.tests, "failed");
  assert.equal(failed.hook, "none");
  assert.equal(iterationView(iteration([step(1, [result({ commit: { kind: "hook_failed", timedOut: false, outputTail: "" } })])]), "api").hook, "failed");
  // a later step with nothing to commit keeps the iteration's last real commit outcome
  assert.equal(iterationView(iteration([step(1, [result()]), step(2, [result({ commit: { kind: "nothing" } })])]), "api").hook, "passed");
  assert.equal(iterationView(iteration([]), "api").tests, "not_run");
  assert.equal(iterationView(iteration([]), "api").hook, "none");
});

const write = (over: Partial<JiraWriteRecord> = {}): JiraWriteRecord => ({
  id: 4,
  targetStatus: "In Progress",
  state: "pending",
  detail: null,
  result: null,
  decidedBy: null,
  requestedAt: "2026-11-07T10:00:00Z",
  decidedAt: null,
  finishedAt: null,
  ...over,
});

test("jiraCard: sync off → off; pending → names the exact target status", () => {
  assert.deepEqual(jiraCard([], { enabled: false, targetStatus: "In Progress" }, "PROJ-1"), { kind: "off" });
  const p = jiraCard([write({ targetStatus: "In Development" })], { enabled: true, targetStatus: "In Progress" }, "PROJ-1");
  assert.equal(p.kind, "pending");
  if (p.kind !== "pending") return;
  assert.equal(p.id, 4);
  assert.equal(p.target, "In Development", "the write's own target, not the setting");
  assert.match(p.thisWill, /In Development/);
  assert.match(p.thisWill, /open PROJ-1 in your Chrome and change only its status to In Development/);
});

test("jiraCard: the latest write decides; running, Already (not_needed), done, skipped, failed with id", () => {
  const sync = { enabled: true, targetStatus: "In Progress" };
  assert.equal(jiraCard([write({ state: "confirmed" })], sync, "K-1").kind, "running");
  const nn = jiraCard([write({ id: 1, state: "failed" }), write({ id: 2, state: "not_needed" })], sync, "K-1");
  assert.equal(nn.kind, "not_needed");
  if (nn.kind === "not_needed") assert.match(nn.text, /Already/);
  const done = jiraCard([write({ state: "done" })], sync, "K-1");
  assert.equal(done.kind, "done");
  assert.equal(jiraCard([write({ state: "skipped" })], sync, "K-1").kind, "skipped");
  const f = jiraCard([write({ id: 9, state: "failed", detail: "Login required — sign in to JIRA in Chrome" })], sync, "K-1");
  assert.equal(f.kind, "failed");
  if (f.kind === "failed") {
    assert.equal(f.id, 9);
    assert.match(f.text, /Login required/);
  }
  // a write still waiting is shown even when sync was turned off afterwards
  assert.equal(jiraCard([write()], { enabled: false, targetStatus: "In Progress" }, "K-1").kind, "pending");
  // sync on, nothing requested yet → off-like info is not shown as a decision
  assert.equal(jiraCard([], sync, "K-1").kind, "none");
});

test("F2-I3: an abandoned ticket never offers Send to JIRA or Try again", () => {
  const sync = { enabled: true, targetStatus: "In Progress" };
  const pending = jiraCard([write()], sync, "K-1", { abandoned: true });
  assert.equal(pending.kind, "skipped");
  if (pending.kind === "skipped") assert.match(pending.text, /abandoned/);
  const skipped = jiraCard([write({ state: "skipped", detail: "ticket abandoned" })], sync, "K-1", { abandoned: true });
  assert.equal(skipped.kind, "skipped");
  if (skipped.kind === "skipped") assert.match(skipped.text, /abandoned/);
  const failed = jiraCard([write({ state: "failed", detail: "boom" })], sync, "K-1", { abandoned: true });
  assert.equal(failed.kind, "skipped", "no Try again");
  if (failed.kind === "skipped") assert.match(failed.text, /boom/);
  // not abandoned: unchanged
  assert.equal(jiraCard([write()], sync, "K-1", { abandoned: false }).kind, "pending");
});

test("browserChoice: detection failed → manual entry; configured device selected and listed", () => {
  assert.equal(browserChoice(null, null).manual, true);
  assert.equal(browserChoice(null, null).selected, null);
  const cfg = { deviceId: "dev-1", name: "Mac" };
  const c = browserChoice(cfg, [{ deviceId: "dev-2", name: "Work laptop" }, { deviceId: "dev-1", name: "Mac" }]);
  assert.equal(c.selected, "dev-1");
  assert.equal(c.manual, false);
  assert.deepEqual(c.options.map((o) => o.deviceId), ["dev-2", "dev-1"]);
  assert.match(c.options[0]!.label, /Work laptop/);
  // the configured browser stays an option even when it was not detected this time
  const gone = browserChoice(cfg, [{ deviceId: "dev-2", name: "" }]);
  assert.deepEqual(gone.options.map((o) => o.deviceId), ["dev-2", "dev-1"]);
  assert.equal(gone.options[0]!.label, "dev-2");
  assert.equal(browserChoice(cfg, null).selected, "dev-1");
});

test("dirtyWorktreeHelp: names the repo and its worktree folder for the uncommitted-changes blocks", () => {
  const a = dirtyWorktreeHelp("web: the worktree of the previous solution has uncommitted changes — commit or discard them first", "/h/worktrees/PROJ-1");
  assert.deepEqual(a, { repo: "web", path: "/h/worktrees/PROJ-1/web" });
  const b = dirtyWorktreeHelp("api is no longer affected but its worktree has uncommitted changes", "/h/worktrees/PROJ-1");
  assert.deepEqual(b, { repo: "api", path: "/h/worktrees/PROJ-1/api" });
  assert.equal(dirtyWorktreeHelp("Login required", "/h/worktrees/PROJ-1"), null);
  assert.equal(dirtyWorktreeHelp(null, "/h"), null);
});

test("jiraNote: the repos-disagree note only when it explains the write's own target; otherwise the target at request time", () => {
  const note = 'The affected repositories declare different In Progress statuses (api: "In Development", web: "Doing"); using the Settings value "In Progress"';
  assert.deepEqual(jiraNote(note, "In Progress"), { kind: "note", text: note });
  assert.deepEqual(jiraNote(note, "in progress "), { kind: "note", text: note }, "same status, case and spaces ignored like the server");
  assert.deepEqual(jiraNote(note, "In Development"), { kind: "target", text: "Target set when the write was requested: In Development" });
  assert.equal(jiraNote(null, "In Progress"), null);
  assert.deepEqual(jiraNote("some other text", "In Progress"), { kind: "target", text: "Target set when the write was requested: In Progress" });
});


test("F2-R1: Accept new git hooks — only for a blocked ticket's repos whose hooks changed; the button only on this computer", () => {
  const repos = [{ name: "api", hooksChanged: true }, { name: "web", hooksChanged: false }];
  const mac = hooksAcceptView("blocked", repos, true);
  assert.deepEqual(mac.map((v) => v.repo), ["api"]);
  assert.equal(mac[0]!.canAccept, true);
  assert.match(mac[0]!.thisWill, /trust the current git hooks of api for this ticket's commits/);
  assert.equal(hooksAcceptView("blocked", repos, false)[0]!.canAccept, false, "a paired phone sees why, not the button");
  assert.deepEqual(hooksAcceptView("developing", repos, true), []);
});
