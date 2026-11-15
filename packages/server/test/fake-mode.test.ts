// Task 17: the fake mode's per-ticket switches, so the e2e specs can reach every phase-2 decision deterministically:
// FAKE-2's critic never stops blocking (awaiting_debate_ruling), FAKE-2's first JIRA write fails (Try again),
// FAKE-3's JIRA ticket changes after the first read (awaiting_snapshot_ack); phase 3: FAKE-3 changes again before
// acceptance, comment-only changes need no ack, acceptance fixes finish at once, fake GitHub remotes and gh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Critique, JiraUpdateResult, ProposeResult, Requirement } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig } from "../src/config.ts";
import { EventBus } from "../src/http/events.ts";
import type { RunAgentRequest } from "../src/executor/run-agent.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { getTicket, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { addRequirement, listSolutions, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { listRounds } from "../src/design/design-repo.ts";
import { assertFakeOrigin, createFakeRepos } from "../src/dev/fake-repo.ts";
import { createFakeSource, fakeDrift, fakeGh, fakeImplement, fakeJiraComment, fakeRun, fakeSolutionsFor, installFakeGh } from "../src/dev/fake-mode.ts";
import { fakeAcceptance } from "../src/dev/fake-acceptance.ts";
import { tmpDir } from "./helpers/tmp.ts";

const critiquePrompt = (round: number) =>
  ["mode: critique", `round:\n\`\`\`json\n${round}\n\`\`\``, `checklist:\n\`\`\`json\n${JSON.stringify([{ id: "extremes" }, { id: "security" }])}\n\`\`\``].join("\n\n");
const critique = (ticketKey: string, round: number) =>
  fakeRun({ role: "critique-design", ticketKey, prompt: critiquePrompt(round), cwd: "/", allowedTools: [], chrome: false, schema: Critique });
const blocking = (c: Critique) => c.comments.filter((x) => x.blocking).length;

test("fake critic: FAKE-1 blocks once in round 1 only; FAKE-2 keeps two blocking comments every round", async () => {
  assert.equal(blocking(await critique("FAKE-1", 1)), 1);
  assert.equal(blocking(await critique("FAKE-1", 2)), 0);
  for (const round of [1, 2, 3]) {
    const c = await critique("FAKE-2", round);
    assert.equal(blocking(c), 2, `round ${round}`);
    assert.deepEqual(c.comments.map((x) => x.id), ["C-1", "C-2"]);
  }
});

const update = (key: string, target = "In Progress") =>
  fakeRun({ role: "jira-update", ticketKey: key, prompt: `mode: update\nkey: ${key}\ntarget status: ${target}`, cwd: "/", allowedTools: [], chrome: true, schema: JiraUpdateResult });

test("fake jira-update: FAKE-2's first write fails and changes nothing; the next one moves it; other tickets move at once", async () => {
  const source = createFakeSource();
  source.delayMs = 0;
  const first = await update("FAKE-2");
  assert.equal(first.outcome, "failed");
  assert.equal((await source.fetchTicket("FAKE-2")).status, "Ready for Dev");
  const second = await update("FAKE-2");
  assert.equal(second.outcome, "changed");
  assert.equal((await source.fetchTicket("FAKE-2")).status, "In Progress");
  assert.equal((await update("FAKE-1")).outcome, "changed");
  // a new fake source (a new server) starts over
  const again = createFakeSource();
  again.delayMs = 0;
  assert.equal((await update("FAKE-2")).outcome, "failed");
});

test("fake source: FAKE-3 changes after its first read and again before its third (laterReads); FAKE-1 never does", async () => {
  const source = createFakeSource();
  source.delayMs = 0;
  const a = await source.fetchTicket("FAKE-3");
  const b = await source.fetchTicket("FAKE-3");
  const c = await source.fetchTicket("FAKE-3");
  const d = await source.fetchTicket("FAKE-3");
  assert.notEqual(b.description, a.description);
  assert.notEqual(c.description, b.description, "read 3 (the re-read before acceptance) changed again");
  assert.deepEqual(d, c, "later reads repeat the last entry");
  assert.equal(b.status, a.status);
  assert.deepEqual(await source.fetchTicket("FAKE-1"), await source.fetchTicket("FAKE-1"));
  // a read is a copy: a later change to the fake JIRA does not alter it
  const before = await source.fetchTicket("FAKE-1");
  fakeJiraComment("mode: comment\nkey: FAKE-1", "hello");
  assert.equal((await source.fetchTicket("FAKE-1")).comments.length, before.comments.length + 1);
  assert.equal(before.comments.length, 2);
});

test("fake drift: a comment-only JIRA change is covered; a description change or an AC edit needs acknowledgement", () => {
  const sec = (name: string, v: unknown) => `${name}:\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
  const req = (text: string) => ({ acceptanceCriteria: [{ id: "AC-1", text }], discussionOutcomes: [{ id: "D-1" }] });
  const prompt = (o: { desc?: string; text?: string; comments?: number }) =>
    [
      "mode: check",
      sec("baselineRequirement", { ...req("Export works."), acceptanceCriteria: [{ id: "AC-1@v1", text: "Export works." }] }),
      sec("currentRequirement", req(o.text ?? "Export works.")),
      sec("baselineSnapshot", { title: "T", description: "D", comments: [] }),
      sec("latestSnapshot", { title: "T", description: o.desc ?? "D", comments: Array(o.comments ?? 0).fill({ body: "x" }) }),
    ].join("\n\n");
  const needsAck = (r: ReturnType<typeof fakeDrift>) => r.baseline.some((b) => b.status !== "covered");
  assert.equal(needsAck(fakeDrift(prompt({ comments: 1 }))), false);
  assert.deepEqual(fakeDrift(prompt({ comments: 1 })).current, [{ id: "AC-1", status: "mapped" }]);
  assert.equal(needsAck(fakeDrift(prompt({ desc: "D2" }))), true);
  assert.equal(needsAck(fakeDrift(prompt({ text: "Export works fast." }))), true);
});

test("fake implement: an acceptance-feedback iteration writes one fix file per affected repo and is done at once", async () => {
  const cwd = tmpDir("fake-impl");
  const repos = [{ name: "web" }] as unknown as RunAgentRequest<unknown>["repos"];
  const out = fakeImplement({
    role: "implement-ticket", ticketKey: "FAKE-1", cwd, repos, allowedTools: [], chrome: false, schema: Requirement,
    prompt: "step: 1 of 6\n\niterationNote:\n## Independent acceptance feedback — fix these first\nAC-2 failed",
  } as RunAgentRequest<unknown>);
  assert.equal(out.done, true);
  assert.deepEqual(readdirSync(join(cwd, "web", "fixes")).length, 1);
  assert.equal(existsSync(join(cwd, "web", "src", "export-button.js")), false, "not the step-1 TODO file");
});

test("fake repos and gh (Task 17): origin names example-org on GitHub but resolves to local bare repos; the fake gh keeps PRs on disk", async () => {
  const home = tmpDir("fake-gh");
  const [api] = await createFakeRepos(home);
  const git = (...args: string[]) => execFileSync("git", ["-C", api!.path, ...args], { encoding: "utf8" }).trim();
  assert.equal(git("config", "--get", "remote.origin.url"), "https://github.com/example-org/api.git");
  assert.equal(git("remote", "get-url", "--push", "origin"), `file://${join(home, "fake-remotes")}/api.git`);
  assert.equal(execFileSync("git", ["--git-dir", join(home, "fake-remotes", "api.git"), "rev-parse", "main"], { encoding: "utf8" }).trim(), git("rev-parse", "main"));
  await assertFakeOrigin(home, api!.path, "api");
  git("remote", "set-url", "--push", "origin", "https://github.com/someone-else/api.git");
  await assert.rejects(assertFakeOrigin(home, api!.path, "api"), /not a fake remote/);

  // web declares acceptance on a 47xx port; api does not
  const webCfg = JSON.parse(readFileSync(join(home, "fake-repos", "web", ".slackoff", "config.json"), "utf8"));
  assert.match(webCfg.acceptance.baseUrl, /^http:\/\/127\.0\.0\.1:47\d\d$/);
  assert.equal(JSON.parse(readFileSync(join(home, "fake-repos", "api", ".slackoff", "config.json"), "utf8")).acceptance, undefined);

  installFakeGh(home);
  const gh = fakeGh("gh"); // whatever bin it is given: always the fake one
  const id = "github.com/example-org/api";
  assert.deepEqual(await gh.authStatus("github.com"), { ok: true, detail: "gh is logged in to github.com" });
  assert.equal(await gh.repoVisibility(id), true);
  assert.deepEqual(await gh.findOpenPr(id, "slackoff/FAKE-1", "main"), { kind: "none" });
  const body = join(home, "body.md");
  writeFileSync(body, "first");
  const pr = await gh.createPr({ repo: id, base: "main", head: "slackoff/FAKE-1", title: "FAKE-1", bodyFile: body });
  assert.deepEqual(pr, { number: 1, url: "https://github.com/example-org/api/pull/1" });
  assert.deepEqual(await gh.findOpenPr(id, "slackoff/FAKE-1", "main"), { kind: "reusable", number: 1, url: pr.url });
  writeFileSync(body, "second");
  await gh.editPrBody(id, 1, body);
  assert.equal(await gh.getPrBody(id, 1), "second");
  assert.equal(JSON.parse(readFileSync(join(home, "fake-github", "prs.json"), "utf8")).length, 1);
});

/** A FAKE ticket refined from the fake source's first read, with the canned solutions, awaiting a choice. */
async function setup(key: string) {
  const home = tmpDir("fake-mode");
  const db = openDatabase(":memory:");
  const config = loadConfig(home);
  config.projects = { FAKE: { repos: await createFakeRepos(home) } };
  const queue = new JobQueue(1);
  const source = createFakeSource();
  source.delayMs = 0;
  const wf = createWorkflow({ updater: noUpdater, db, home, queue, source, run: fakeRun, config, bus: new EventBus() });
  upsertDiscovered(db, { key, title: "T", url: `https://j/${key}`, status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(db, home, key, await source.fetchTicket(key));
  const base = { prompt: "", cwd: home, allowedTools: [], chrome: false, ticketKey: key } satisfies Partial<RunAgentRequest<unknown>>;
  const req = await fakeRun({ ...base, role: "refine-ticket", schema: Requirement });
  const { id } = addRequirement(db, key, snapshotId, req, "agent");
  saveSolutions(db, key, id, (await fakeRun({ ...base, role: "propose-solutions", schema: ProposeResult })).solutions);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice"] as const) transition(db, key, to, "system");
  return { db, wf, queue, sols: listSolutions(db, key) };
}

test("fake mode workflow: FAKE-2 escalates to awaiting_debate_ruling after the round cap (two disagreements)", async () => {
  const s = await setup("FAKE-2");
  s.wf.choose("FAKE-2", s.sols[0]!.id, "", ["web"], "local");
  await s.queue.idle();
  assert.equal(getTicket(s.db, "FAKE-2")!.state, "awaiting_debate_ruling", getTicket(s.db, "FAKE-2")!.blockedReason ?? "");
  const critics = listRounds(s.db, "FAKE-2").filter((r) => r.role === "critic");
  assert.equal(critics.length, 3);
});

test("fake mode workflow: FAKE-3's re-read snapshot changed after the design -> awaiting_snapshot_ack", async () => {
  const s = await setup("FAKE-3");
  s.wf.choose("FAKE-3", s.sols[1]!.id, "", undefined, "local");
  await s.queue.idle();
  assert.equal(getTicket(s.db, "FAKE-3")!.state, "awaiting_snapshot_ack", getTicket(s.db, "FAKE-3")!.blockedReason ?? "");
});

// ---------------------------------------------------------------- phase 4f (Task 6): the fake CLI repo and FAKE-4

test("phase 4f fake mode (SLACKOFF_FAKE_CLI_REPO): a third repo `cli` with an executable ./bin/tool.mjs and a cli acceptance entry; FAKE-4; option 4 changes only cli", async () => {
  const home = tmpDir("fake-cli");
  const refs = await createFakeRepos(home, { cli: true });
  assert.deepEqual(refs.map((r) => r.name), ["api", "web", "cli"]);
  const cli = refs[2]!.path;
  assert.match(execFileSync("git", ["-C", cli, "ls-files", "-s", "bin/tool.mjs"], { encoding: "utf8" }), /^100755 /);
  assert.deepEqual(JSON.parse(readFileSync(join(cli, ".slackoff", "config.json"), "utf8")).acceptance, { entry: "cli", cli: { command: "./bin/tool.mjs" } });
  assert.deepEqual((await createFakeRepos(tmpDir("fake-nocli"))).map((r) => r.name), ["api", "web"], "off by default");
  assert.equal((createFakeSource({ cli: true }).discoverResult as { tickets: Array<{ key: string }> }).tickets.some((t) => t.key === "FAKE-4"), true);
  assert.equal((createFakeSource().discoverResult as { tickets: Array<{ key: string }> }).tickets.some((t) => t.key === "FAKE-4"), false);
  const four = fakeSolutionsFor(true).solutions;
  assert.equal(four.length, 4);
  assert.deepEqual(four[3]!.affectedRepos, ["cli"]);
  assert.equal(fakeSolutionsFor(false).solutions.length, 3);
});

test("phase 4f fake acceptance for a cli entry: declared cases per AC, {kind: case} evidence; FAKE-4's first run omits AC-2's input file (the platform's re-run fails it)", () => {
  const work = tmpDir("fake-acc-cli");
  const cfg = tmpDir("fake-acc-cfg");
  const prompt = "mode: accept\n\n## requirement\n\nx\n\n```json\n" + JSON.stringify({ acceptanceCriteria: [{ id: "AC-1" }, { id: "AC-2" }, { id: "AC-3" }] }) + "\n```\n";
  const req = {
    role: "acceptance-review", ticketKey: "FAKE-4", prompt, cwd: work, allowedTools: [], chrome: false, schema: Requirement,
    policy: { workDir: work, acceptCases: [{ repo: "cli", library: null }] }, isolation: { claudeConfigDir: cfg },
  } as unknown as RunAgentRequest<unknown>;
  const first = fakeAcceptance(req, true);
  const dir = join(work, "acceptance", "cli", "cases");
  const cases = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { name: string; acId: string; files?: Record<string, string> });
  assert.deepEqual(cases.map((c) => c.acId).sort(), ["AC-1", "AC-2", "AC-3"]);
  assert.equal(cases.find((c) => c.acId === "AC-2")!.files, undefined, "first run: AC-2 has no input file");
  assert.ok(first.acs.every((a) => a.flows.every((f) => f.evidence.every((e) => e.kind === "case"))));
  fakeAcceptance(req, true);
  const again = JSON.parse(readFileSync(join(dir, "ac-2.case.json"), "utf8")) as { files?: Record<string, string> };
  assert.deepEqual(again.files, { "items.txt": "milk\n" });
});
