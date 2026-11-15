import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Critique, DesignDoc, FetchedTicket, Requirement, Solution, StepRepoResult } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { migrations } from "../src/db/migrations.ts";
import { verifyAuditChain } from "../src/audit/audit-log.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import {
  getTicket, listRepoWorkspaces, recordInstall, removeRepoWorkspace, setJiraStatus, setRepoWorkspace, upsertDiscovered,
} from "../src/tickets/ticket-repo.ts";
import { InvalidTransitionError, ValidationError } from "../src/tickets/errors.ts";
import { addRequirement, currentChoice, listSolutions, recordChoice, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { addDesignDoc, addRound, listDesignDocs, listRounds, listRulings, markFinal, saveRulings } from "../src/design/design-repo.ts";
import { addStep, finishIteration, listIterations, openIteration, startIteration } from "../src/development/dev-repo.ts";
import { decideJiraWrite, finishJiraWrite, listJiraWrites, recordNotNeeded, requestJiraWrite } from "../src/jira/jira-write-repo.ts";
import { tmpDir } from "./helpers/tmp.ts";

type Db = ReturnType<typeof openDatabase>;

const req: Requirement = {
  background: "bg",
  functional: [{ id: "F1", text: "f" }],
  acceptanceCriteria: [{ id: "AC1", text: "a", verifiable: true, source: { type: "description", ref: "desc", quote: "q" } }],
  discussionOutcomes: [],
  openQuestions: [],
  draftComment: null,
};
const sol: Solution = {
  title: "s", approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "S",
  affectedRepos: ["api", "web"], repoChanges: [{ repo: "api", summary: "x" }, { repo: "web", summary: "y" }],
};
const doc = (md: string): DesignDoc => ({
  contentMd: md,
  repos: [{ repo: "api", contentMd: "api part" }],
  checklist: [{ item: "Q01", status: "considered", conclusion: "ok" }],
  responses: [],
});
const critique: Critique = {
  comments: [
    { id: "C-1", checklistItem: "Q01", repo: "api", blocking: true, text: "bad", suggestion: null },
    { id: "C-2", checklistItem: "Q01", repo: null, blocking: false, text: "meh", suggestion: "x" },
  ],
  coverage: [{ item: "Q01", status: "concern", note: "n" }],
};
const repoResult = (repo: string, violations: string[] = []): StepRepoResult => ({
  repo, violations, tests: [{ command: "pnpm test", exitCode: 0, timedOut: false, outputTail: "ok" }],
  commit: { kind: "committed", sha: "abc" }, pendingChanges: false,
});

function setup(): { db: Db; choiceId: number; requirementId: number } {
  const db = openDatabase(":memory:");
  const home = tmpDir("p2");
  upsertDiscovered(db, { key: "T-1", title: "Title", url: "http://j/T-1", status: "To Do" }, false);
  const f: FetchedTicket = { loginRequired: false, key: "T-1", title: "Title", description: "d", jiraUpdatedAt: null, status: null, comments: [], attachments: [] };
  const { snapshotId } = saveSnapshot(db, home, "T-1", f);
  const { id: requirementId } = addRequirement(db, "T-1", snapshotId, req, "agent");
  saveSolutions(db, "T-1", requirementId, [sol]);
  recordChoice(db, "T-1", listSolutions(db, "T-1")[0]!.id, "go", ["api", "web"]);
  return { db, choiceId: currentChoice(db, "T-1")!.id, requirementId };
}

const audits = (db: Db, type: string) =>
  (db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ payload_json: string }>).map(
    (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
  );

// ---------------------------------------------------------------- migration 6

test("migration 6: user_version 6, new tables and columns", () => {
  const db = openDatabase(":memory:");
  assert.ok(migrations.length >= 6);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, migrations.length);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  assert.ok(cols("choice").includes("affected_repos_json"));
  assert.ok(cols("agent_run").includes("rules_hash"));
  assert.ok(cols("agent_run").includes("repo_prompt_hash"));
  for (const t of ["ticket_repo", "design_doc", "debate_round", "debate_ruling", "dev_iteration", "dev_step", "jira_write"])
    assert.ok(cols(t).length > 0, t);
});

test("migration 6 on a version-5 database: old choice rows read affectedRepos null, old solutions read through StoredSolution", () => {
  const dir = tmpDir("m6");
  try {
    const path = join(dir, "m6.db");
    const old = new DatabaseSync(path);
    for (let i = 0; i < 5; i++) old.exec(migrations[i]!);
    old.exec("PRAGMA user_version = 5");
    old.exec(`INSERT INTO ticket (key, title, state, created_at, updated_at) VALUES ('A-1','t','awaiting_choice','x','x')`);
    old.exec(`INSERT INTO ticket_snapshot (ticket_key, fetched_at, title, content_hash) VALUES ('A-1','x','t','h')`);
    old.exec(`INSERT INTO requirement (ticket_key, snapshot_id, version, content_json, source, created_at) VALUES ('A-1',1,1,'{}','agent','x')`);
    const phase1 = { title: "old", approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "S" };
    old.prepare(`INSERT INTO solution (ticket_key, requirement_id, idx, content_json) VALUES ('A-1',1,0,?)`).run(JSON.stringify(phase1));
    old.exec(`INSERT INTO choice (ticket_key, solution_id, requirement_id, note, created_at) VALUES ('A-1',1,1,'n','x')`);
    old.close();
    const db = openDatabase(path);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, migrations.length);
    assert.deepEqual(currentChoice(db, "A-1"), { id: 1, solutionId: 1, requirementId: 1, note: "n", affectedRepos: null, skipDebate: false, createdAt: "x" });
    const [s] = listSolutions(db, "A-1");
    assert.deepEqual(s!.content.affectedRepos, []);
    assert.deepEqual(s!.content.repoChanges, []);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append-only tables refuse UPDATE, DELETE and REPLACE", () => {
  const { db, choiceId, requirementId } = setup();
  const d = addDesignDoc(db, "T-1", { requirementId, choiceId, doc: doc("v1") });
  const r = addRound(db, "T-1", { choiceId, designDocId: d.id, round: 1, role: "critic", content: critique });
  saveRulings(db, "T-1", r.id, [{ commentId: "C-1", decision: "critic", note: "" }], "local");
  const it = startIteration(db, "T-1", "initial", null);
  addStep(db, it.id, { step: 1, summary: "s", repos: [repoResult("api")] });
  for (const sql of [
    `UPDATE debate_round SET round = 2`, `DELETE FROM debate_round`,
    `UPDATE debate_ruling SET note = 'x'`, `DELETE FROM debate_ruling`,
    `UPDATE dev_step SET summary = 'x'`, `DELETE FROM dev_step`,
    `REPLACE INTO debate_round (id, ticket_key, choice_id, design_doc_id, round, role, content_json, created_at) VALUES (${r.id},'T-1',${choiceId},${d.id},9,'critic','{}','x')`,
    `INSERT OR REPLACE INTO dev_step (id, iteration_id, step, summary, repos_json, created_at) VALUES (1,${it.id},1,'forged','[]','x')`,
    `INSERT OR REPLACE INTO debate_ruling (id, ticket_key, debate_round_id, comment_id, decision, note, decided_by, created_at) VALUES (1,'T-1',${r.id},'C-1','designer','','local','x')`,
  ]) assert.throws(() => db.exec(sql), /immutable/, sql);
  assert.equal(listRounds(db, "T-1")[0]!.round, 1);
  assert.equal(listIterations(db, "T-1")[0]!.steps[0]!.summary, "s");
});

test("design_doc: immutable except is_final 0 -> 1; REPLACE refused", () => {
  const { db, choiceId, requirementId } = setup();
  const d1 = addDesignDoc(db, "T-1", { requirementId, choiceId, doc: doc("v1") });
  const d2 = addDesignDoc(db, "T-1", { requirementId, choiceId, doc: doc("v2") });
  assert.deepEqual([d1.version, d2.version], [1, 2]);
  assert.throws(() => db.exec(`UPDATE design_doc SET content_json = '{}' WHERE id = ${d1.id}`), /design docs are immutable/);
  assert.throws(() => db.exec(`UPDATE design_doc SET is_final = 1, content_json = '{}' WHERE id = ${d1.id}`), /design docs are immutable/);
  assert.throws(() => db.exec(`DELETE FROM design_doc WHERE id = ${d1.id}`), /design docs are immutable/);
  assert.throws(
    () => db.exec(`INSERT OR REPLACE INTO design_doc (id, ticket_key, requirement_id, choice_id, version, content_json, checklist_json, responses_json, created_at) VALUES (${d1.id},'T-1',${requirementId},${choiceId},1,'{}','[]','[]','x')`),
    /design docs are immutable/,
  );
  assert.throws(
    () => db.exec(`INSERT OR REPLACE INTO design_doc (ticket_key, requirement_id, choice_id, version, content_json, checklist_json, responses_json, created_at) VALUES ('T-1',${requirementId},${choiceId},1,'{}','[]','[]','x')`),
    /design docs are immutable/,
  );
  db.exec(`UPDATE design_doc SET is_final = 1 WHERE id = ${d1.id}`);
  assert.throws(() => db.exec(`UPDATE design_doc SET is_final = 0 WHERE id = ${d1.id}`), /design docs are immutable/);
  const docs = listDesignDocs(db, "T-1");
  assert.deepEqual(docs.map((d) => [d.version, d.isFinal]), [[1, true], [2, false]]);
  assert.deepEqual(docs[1]!.doc, doc("v2"));
});

// ---------------------------------------------------------------- choice

test("recordChoice with affectedRepos: currentChoice and audit carry them; 4-arg form stores null", () => {
  const { db } = setup();
  const c = currentChoice(db, "T-1")!;
  assert.deepEqual(c.affectedRepos, ["api", "web"]);
  assert.equal(c.note, "go");
  assert.deepEqual(audits(db, "choice_recorded").at(-1)!.affectedRepos, ["api", "web"]);
  recordChoice(db, "T-1", c.solutionId, "again");
  const c2 = currentChoice(db, "T-1")!;
  assert.equal(c2.affectedRepos, null);
  assert.equal(c2.note, "again");
  assert.equal(audits(db, "choice_recorded").at(-1)!.affectedRepos, null);
  assert.equal(currentChoice(db, "NOPE"), null);
});

// ---------------------------------------------------------------- workspaces

test("repo workspaces: upsert, list, remove, install, jira status", () => {
  const { db } = setup();
  const ws = (repo: string) => ({ repo, repoPath: `/src/${repo}`, baseBranch: "main", branch: "slackoff/T-1-x", worktreePath: `/srv/worktrees/T-1/${repo}` });
  setRepoWorkspace(db, "T-1", ws("api"));
  setRepoWorkspace(db, "T-1", ws("web"));
  assert.equal(listRepoWorkspaces(db, "T-1").length, 2);
  const t = getTicket(db, "T-1")!;
  assert.equal(t.worktreePath, "/srv/worktrees/T-1");
  assert.equal(t.branch, "slackoff/T-1-x");
  setRepoWorkspace(db, "T-1", { ...ws("api"), baseBranch: "develop" });
  assert.equal(audits(db, "worktree_created").length, 2);
  assert.equal(audits(db, "worktree_created").filter((p) => p.repo === "api").length, 1);
  const api = listRepoWorkspaces(db, "T-1").find((w) => w.repo === "api")!;
  assert.equal(api.baseBranch, "develop");
  assert.equal(api.install, null);
  assert.equal(typeof api.createdAt, "string");

  const report = { run: { command: "pnpm install", exitCode: 0, timedOut: false, outputTail: "done" }, resetPaths: ["pnpm-lock.yaml"] };
  recordInstall(db, "T-1", "api", report);
  assert.deepEqual(listRepoWorkspaces(db, "T-1").find((w) => w.repo === "api")!.install, report);
  assert.deepEqual(audits(db, "repo_installed")[0]!.resetPaths, ["pnpm-lock.yaml"]);
  setRepoWorkspace(db, "T-1", ws("api"));
  assert.deepEqual(listRepoWorkspaces(db, "T-1").find((w) => w.repo === "api")!.install, report, "upsert keeps the install report");

  removeRepoWorkspace(db, "T-1", "web");
  assert.deepEqual(listRepoWorkspaces(db, "T-1").map((w) => w.repo), ["api"]);
  assert.equal(audits(db, "worktree_removed")[0]!.repo, "web");

  setJiraStatus(db, "T-1", "In Progress");
  assert.equal(getTicket(db, "T-1")!.jiraStatus, "In Progress");
  assert.deepEqual(audits(db, "ticket_refreshed").at(-1), { jiraStatus: { from: "To Do", to: "In Progress" } });
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------- debate

test("design docs, rounds and rulings are audited; rulings for a round can be saved once", () => {
  const { db, choiceId, requirementId } = setup();
  const d = addDesignDoc(db, "T-1", { requirementId, choiceId, doc: doc("v1") });
  const r1 = addRound(db, "T-1", { choiceId, designDocId: d.id, round: 1, role: "critic", content: critique });
  const r2 = addRound(db, "T-1", { choiceId, designDocId: d.id, round: 1, role: "designer", content: { responses: [{ commentId: "C-1", verdict: "rebutted", reason: "no" }] } });
  const rounds = listRounds(db, "T-1");
  assert.deepEqual(rounds.map((r) => [r.id, r.role, r.round, r.choiceId, r.designDocId]), [[r1.id, "critic", 1, choiceId, d.id], [r2.id, "designer", 1, choiceId, d.id]]);
  assert.deepEqual(rounds[0]!.content, critique);
  assert.equal(listRounds(db, "T-1", choiceId).length, 2);
  assert.equal(listRounds(db, "T-1", choiceId + 1000).length, 0);

  saveRulings(db, "T-1", r1.id, [{ commentId: "C-1", decision: "custom", note: "do both" }, { commentId: "C-2", decision: "designer", note: "" }], "device:3");
  assert.throws(() => saveRulings(db, "T-1", r1.id, [{ commentId: "C-1", decision: "critic", note: "" }], "local"), InvalidTransitionError);
  const rulings = listRulings(db, "T-1");
  assert.deepEqual(rulings.map((r) => [r.debateRoundId, r.commentId, r.decision, r.note, r.decidedBy]), [
    [r1.id, "C-1", "custom", "do both", "device:3"],
    [r1.id, "C-2", "designer", "", "device:3"],
  ]);

  markFinal(db, "T-1", d.id);
  assert.equal(listDesignDocs(db, "T-1")[0]!.isFinal, true);

  assert.equal(audits(db, "design_doc_saved").length, 1);
  assert.equal(audits(db, "debate_round_recorded").length, 2);
  assert.equal(audits(db, "debate_ruling").length, 2);
  assert.equal(audits(db, "debate_ruling")[0]!.decidedBy, "device:3");
  assert.equal(audits(db, "design_finalized").length, 1);
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------- development

test("iterations and steps: duplicate step refused, violations audited, retry trigger allowed", () => {
  const { db } = setup();
  assert.equal(openIteration(db, "T-1"), null);
  const it = startIteration(db, "T-1", "initial", null);
  assert.deepEqual(openIteration(db, "T-1"), it);
  assert.equal(it.iteration, 1);
  addStep(db, it.id, { step: 1, summary: "one", repos: [repoResult("api"), repoResult("web", ["infra/x.tf"])] });
  assert.throws(() => addStep(db, it.id, { step: 1, summary: "dup", repos: [] }));
  addStep(db, it.id, { step: 2, summary: "two", repos: [repoResult("api")] });
  finishIteration(db, it.id, "failed", "max steps");
  assert.equal(openIteration(db, "T-1"), null);
  assert.throws(() => finishIteration(db, it.id, "done", "again"), InvalidTransitionError);
  const it2 = startIteration(db, "T-1", "retry", "try again");
  assert.equal(it2.iteration, 2);

  const list = listIterations(db, "T-1");
  assert.deepEqual(list.map((i) => [i.iteration, i.trigger, i.status, i.summary, i.note]), [
    [1, "initial", "failed", "max steps", null],
    [2, "retry", "running", null, "try again"],
  ]);
  assert.equal(typeof list[0]!.endedAt, "string");
  assert.deepEqual(list[0]!.steps.map((s) => s.step), [1, 2]);
  assert.deepEqual(list[0]!.steps[0]!.repos[1], repoResult("web", ["infra/x.tf"]));

  assert.equal(audits(db, "dev_step_recorded").length, 2);
  const v = audits(db, "rule_violation");
  assert.equal(v.length, 1);
  assert.equal(v[0]!.repo, "web");
  assert.deepEqual(v[0]!.paths, ["infra/x.tf"]);
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------- jira writes

test("jira writes: request, decide only pending, finish only confirmed, not_needed", () => {
  const { db } = setup();
  const w = requestJiraWrite(db, "T-1", "In Progress");
  assert.throws(() => finishJiraWrite(db, w.id, "done", "x", null), InvalidTransitionError);
  decideJiraWrite(db, w.id, "confirmed", "device:2");
  assert.throws(() => decideJiraWrite(db, w.id, "skipped", "local"), InvalidTransitionError);
  finishJiraWrite(db, w.id, "done", "moved", { from: "To Do" });
  assert.throws(() => finishJiraWrite(db, w.id, "failed", "x", null), InvalidTransitionError);

  const s = requestJiraWrite(db, "T-1", "In Progress");
  decideJiraWrite(db, s.id, "skipped", "local");
  assert.throws(() => finishJiraWrite(db, s.id, "done", "x", null), InvalidTransitionError);

  const n = recordNotNeeded(db, "T-1", "In Progress", "already In Progress");

  const list = listJiraWrites(db, "T-1");
  assert.deepEqual(list.map((x) => [x.id, x.state, x.decidedBy, x.detail]), [
    [w.id, "done", "device:2", "moved"],
    [s.id, "skipped", "local", null],
    [n.id, "not_needed", null, "already In Progress"],
  ]);
  assert.deepEqual(list[0]!.result, { from: "To Do" });
  assert.equal(typeof list[0]!.finishedAt, "string");
  assert.equal(audits(db, "jira_write_requested").length, 2);
  assert.equal(audits(db, "jira_write_decided").length, 2);
  assert.equal(audits(db, "jira_write_decided")[0]!.decidedBy, "device:2");
  assert.equal(audits(db, "jira_write_finished").length, 2);
  assert.equal(verifyAuditChain(db).ok, true);
});

// ---------------------------------------------------------------- fix round 1

test("iteration lifecycle is audited: dev_iteration_started / dev_iteration_finished", () => {
  const { db } = setup();
  const a = startIteration(db, "T-1", "initial", null);
  finishIteration(db, a.id, "failed", "max steps");
  const b = startIteration(db, "T-1", "retry", "try again", "device:4");
  finishIteration(db, b.id, "done", "ok");
  const rows = db.prepare("SELECT actor, type, payload_json FROM audit_event WHERE type LIKE 'dev_iteration_%' ORDER BY id").all() as Array<{ actor: string; type: string; payload_json: string }>;
  assert.deepEqual(rows.map((r) => [r.actor, r.type, JSON.parse(r.payload_json)]), [
    ["system", "dev_iteration_started", { iteration: 1, trigger: "initial", note: null }],
    ["system", "dev_iteration_finished", { iteration: 1, status: "failed", summary: "max steps" }],
    ["developer", "dev_iteration_started", { iteration: 2, trigger: "retry", note: "try again", decidedBy: "device:4" }],
    ["system", "dev_iteration_finished", { iteration: 2, status: "done", summary: "ok" }],
  ]);
  assert.equal(verifyAuditChain(db).ok, true);
});

test("setRepoWorkspace audits repo_workspace_changed only when a stored value changes", () => {
  const { db } = setup();
  const w = { repo: "api", repoPath: "/src/api", baseBranch: "main", branch: "slackoff/T-1-x", worktreePath: "/srv/worktrees/T-1/api" };
  setRepoWorkspace(db, "T-1", w);
  setRepoWorkspace(db, "T-1", w);
  assert.equal(audits(db, "repo_workspace_changed").length, 0);
  setRepoWorkspace(db, "T-1", { ...w, repoPath: "/src/api2", baseBranch: "develop" });
  assert.deepEqual(audits(db, "repo_workspace_changed"), [
    { repo: "api", changes: { repoPath: { from: "/src/api", to: "/src/api2" }, baseBranch: { from: "main", to: "develop" } } },
  ]);
});

test("saveRulings: duplicate comment ids and missing blocking comments are ValidationErrors", () => {
  const { db, choiceId, requirementId } = setup();
  const d = addDesignDoc(db, "T-1", { requirementId, choiceId, doc: doc("v1") });
  const r = addRound(db, "T-1", {
    choiceId, designDocId: d.id, round: 1, role: "critic",
    content: { ...critique, comments: [...critique.comments, { id: "C-3", checklistItem: "Q01", repo: null, blocking: true, text: "t", suggestion: null }] },
  });
  assert.throws(
    () => saveRulings(db, "T-1", r.id, [{ commentId: "C-1", decision: "critic", note: "" }, { commentId: "C-1", decision: "designer", note: "" }, { commentId: "C-3", decision: "critic", note: "" }], "local"),
    (e: Error) => e instanceof ValidationError && /C-1/.test(e.message),
  );
  assert.throws(
    () => saveRulings(db, "T-1", r.id, [{ commentId: "C-1", decision: "critic", note: "" }], "local"),
    (e: Error) => e instanceof ValidationError && /C-3/.test(e.message),
  );
  assert.equal(listRulings(db, "T-1").length, 0);
  assert.equal(audits(db, "debate_ruling").length, 0);
  saveRulings(db, "T-1", r.id, [{ commentId: "C-3", decision: "designer", note: "" }, { commentId: "C-1", decision: "critic", note: "" }], "local");
  assert.equal(listRulings(db, "T-1").length, 2);
});

test("recordChoice records decidedBy in the choice_recorded payload (default null)", () => {
  const { db } = setup();
  assert.equal(audits(db, "choice_recorded").at(-1)!.decidedBy, null);
  recordChoice(db, "T-1", currentChoice(db, "T-1")!.solutionId, "phone", ["api"], "device:7");
  assert.equal(audits(db, "choice_recorded").at(-1)!.decidedBy, "device:7");
});
