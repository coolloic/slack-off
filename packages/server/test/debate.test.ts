// Task 9: the design + debate loop (design-solution / critique-design) with a round cap and developer rulings.
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Critique, DebateRoundRecord, DesignDoc, FetchedTicket, ProposeResult, Requirement, RulingRecord } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import { runAgent, type RunAgentRequest } from "../src/executor/run-agent.ts";
import { AgentInterruptedError, type ExecRequest, type Executor } from "../src/executor/types.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { recoverOnStartup } from "../src/workflow/recovery.ts";
import { getTicket, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { InvalidTransitionError, ValidationError } from "../src/tickets/errors.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { addRequirement, currentChoice, listSolutions, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { listDesignDocs, listRounds, listRulings, type DesignDocRecord } from "../src/design/design-repo.ts";
import { nextDebateStep } from "../src/design/debate-step.ts";
import { gitRepo } from "./fixtures/git-repos.ts";
import { tmpDir } from "./helpers/tmp.ts";

// ---------------------------------------------------------------- nextDebateStep (pure)

const at = (n: number) => new Date(Date.UTC(2026, 10, 7, 10, 0, n)).toISOString();
const D = (id: number, version: number, created = at(id * 10)): DesignDocRecord => ({
  id, version, choiceId: 1, requirementId: 1, isFinal: false, createdAt: created,
  doc: { contentMd: `v${version}`, repos: [], checklist: [], responses: [] },
});
const C = (id: number, round: number, docId: number, blocking: string[], other: string[] = []): DebateRoundRecord => ({
  id, choiceId: 1, designDocId: docId, round, role: "critic", createdAt: at(id * 10 + 1),
  content: {
    coverage: [],
    comments: [...blocking.map((c) => [c, true] as const), ...other.map((c) => [c, false] as const)].map(([cid, b]) => ({
      id: cid, checklistItem: "security", repo: null, blocking: b, text: `t ${cid}`, suggestion: null,
    })),
  },
});
const R = (id: number, round: number, docId: number, ids: string[]): DebateRoundRecord => ({
  id, choiceId: 1, designDocId: docId, round, role: "designer", createdAt: at(docId * 10),
  content: { responses: ids.map((commentId) => ({ commentId, verdict: "rebutted" as const, reason: "no" })) },
});
const ruled = (roundId: number, decisions: Array<[string, RulingRecord["decision"]]>, created = at(200)): RulingRecord[] =>
  decisions.map(([commentId, decision], i) => ({ id: i + 1, debateRoundId: roundId, commentId, decision, note: decision === "custom" ? "do X" : "", decidedBy: "local", createdAt: created }));

// three blocked rounds, max 3: v1 c1 v2(r1) c2 v3(r2) c3 v4(r3)
const escalatedDocs = [D(1, 1), D(2, 2), D(3, 3), D(4, 4)];
const escalatedRounds = [
  C(1, 1, 1, ["C-1"]), R(2, 1, 2, ["C-1"]),
  C(3, 2, 2, ["C-1"]), R(4, 2, 3, ["C-1"]),
  C(5, 3, 3, ["C-1", "C-2", "C-3"], ["C-4"]), R(6, 3, 4, ["C-1", "C-2", "C-3"]),
];

test("nextDebateStep: table", () => {
  const s = (docs: DesignDocRecord[], rounds: DebateRoundRecord[], rulings: RulingRecord[] = [], maxRounds = 3) =>
    nextDebateStep({ docs, rounds, rulings, maxRounds });
  assert.deepEqual(s([], []), { kind: "draft" });
  assert.deepEqual(s([D(1, 1)], []), { kind: "critique", round: 1 });
  assert.deepEqual(s([D(1, 1)], [C(1, 1, 1, ["C-1", "C-2"], ["C-3"])]), { kind: "revise", round: 1, mustAnswer: ["C-1", "C-2"] });
  assert.deepEqual(s([D(1, 1)], [C(1, 1, 1, [], ["C-3"])]), { kind: "finalize", docId: 1 });
  assert.deepEqual(s([D(1, 1), D(2, 2)], [C(1, 1, 1, ["C-1"]), R(2, 1, 2, ["C-1"])]), { kind: "critique", round: 2 });
  // round cap reached, nothing ruled yet
  assert.deepEqual(s(escalatedDocs, escalatedRounds), { kind: "escalate" });
  // all rulings for the designer: finalize the latest doc, no agent
  assert.deepEqual(s(escalatedDocs, escalatedRounds, ruled(5, [["C-1", "designer"], ["C-2", "designer"], ["C-3", "designer"]])), { kind: "finalize", docId: 4 });
  // critic / custom rulings: apply them; mustAnswer = exactly those comments (P-C1b)
  const mixed = ruled(5, [["C-1", "critic"], ["C-2", "designer"], ["C-3", "custom"]]);
  assert.deepEqual(s(escalatedDocs, escalatedRounds, mixed), { kind: "apply_rulings", roundId: 5, mustAnswer: ["C-1", "C-3"] });
  // rulings applied: v5 is newer than every ruling -> finalize v5 (P-C1, no apply loop)
  assert.deepEqual(s([...escalatedDocs, D(5, 5, at(300))], escalatedRounds, mixed), { kind: "finalize", docId: 5 });
  // same timestamp as the rulings: v5 is still the applied doc (it follows the escalated v4)
  assert.deepEqual(s([...escalatedDocs, D(5, 5, at(200))], escalatedRounds, mixed), { kind: "finalize", docId: 5 });
  // clock stepped back: v5 older than the rulings is still the applied doc
  assert.deepEqual(s([...escalatedDocs, D(5, 5, at(100))], escalatedRounds, mixed), { kind: "finalize", docId: 5 });
  // clock stepped forward: the escalated v4 dated after the rulings must not finalize without applying them
  const v4Late = [D(1, 1), D(2, 2), D(3, 3), D(4, 4, at(500))];
  assert.deepEqual(s(v4Late, escalatedRounds, mixed), { kind: "apply_rulings", roundId: 5, mustAnswer: ["C-1", "C-3"] });
});

test("nextDebateStep: rulings already given win over a raised maxRounds (no critique 4, the developer's rulings stay)", () => {
  const s = (docs: DesignDocRecord[], rulings: RulingRecord[], maxRounds: number) => nextDebateStep({ docs, rounds: escalatedRounds, rulings, maxRounds });
  // without rulings a raised cap just continues the debate
  assert.deepEqual(s(escalatedDocs, [], 5), { kind: "critique", round: 4 });
  const c1 = ruled(5, [["C-1", "critic"], ["C-2", "designer"], ["C-3", "designer"]]);
  assert.deepEqual(s(escalatedDocs, c1, 5), { kind: "apply_rulings", roundId: 5, mustAnswer: ["C-1"] });
  assert.deepEqual(s([...escalatedDocs, D(5, 5, at(300))], c1, 5), { kind: "finalize", docId: 5 });
  const allDesigner = ruled(5, [["C-1", "designer"], ["C-2", "designer"], ["C-3", "designer"]]);
  assert.deepEqual(s(escalatedDocs, allDesigner, 5), { kind: "finalize", docId: 4 });
});

test("nextDebateStep: rulings on a critic round without the designer's revision are inconsistent -> throws", () => {
  const rounds = [C(1, 1, 1, ["C-1"])];
  // unreachable through the flow (a blocked round is always revised before escalation): fail closed
  assert.throws(() => nextDebateStep({ docs: [D(1, 1), D(2, 2)], rounds, rulings: ruled(1, [["C-1", "critic"]]), maxRounds: 1 }), /inconsistent/i);
});

test("nextDebateStep: maxRounds = 1", () => {
  const s = (docs: DesignDocRecord[], rounds: DebateRoundRecord[], rulings: RulingRecord[] = []) => nextDebateStep({ docs, rounds, rulings, maxRounds: 1 });
  assert.deepEqual(s([D(1, 1)], []), { kind: "critique", round: 1 });
  const c1 = C(1, 1, 1, ["C-1"]);
  assert.deepEqual(s([D(1, 1)], [c1]), { kind: "revise", round: 1, mustAnswer: ["C-1"] });
  const rounds = [c1, R(2, 1, 2, ["C-1"])];
  assert.deepEqual(s([D(1, 1), D(2, 2)], rounds), { kind: "escalate" });
  assert.deepEqual(s([D(1, 1), D(2, 2)], rounds, ruled(1, [["C-1", "designer"]])), { kind: "finalize", docId: 2 });
  assert.deepEqual(s([D(1, 1), D(2, 2)], rounds, ruled(1, [["C-1", "critic"]])), { kind: "apply_rulings", roundId: 1, mustAnswer: ["C-1"] });
  assert.deepEqual(s([D(1, 1), D(2, 2), D(3, 3, at(300))], rounds, ruled(1, [["C-1", "critic"]])), { kind: "finalize", docId: 3 });
});

// ---------------------------------------------------------------- flow (real runAgent, in-process fake executor)

const repoRoot = resolve(import.meta.dirname, "../../..");
const REPOS = { api: gitRepo("api"), web: gitRepo("web") } as const;
type Name = keyof typeof REPOS;
const MARKER = "DESIGNER-FREE-TEXT-7f3a";
const SESSION = "sess-0c9e-secret";

const requirement: Requirement = {
  background: "bg",
  functional: [{ id: "FR-1", text: "export" }],
  acceptanceCriteria: [{ id: "AC-1", text: "Export CSV", verifiable: true, source: { type: "description", ref: "description#p1", quote: "q" } }],
  discussionOutcomes: [],
  openQuestions: [],
  draftComment: null,
};
const fetched = (key: string): FetchedTicket => ({
  loginRequired: false, key, title: "T", description: "d", jiraUpdatedAt: null, status: null, comments: [], attachments: [],
});
const proposal: ProposeResult = {
  solutions: [
    { title: "Both", approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "M", affectedRepos: ["api", "web"], repoChanges: [{ repo: "api", summary: "x" }, { repo: "web", summary: "y" }] },
    { title: "Web only", approach: "b", changeScope: [], pros: [], cons: [], risks: [], complexity: "S", affectedRepos: ["web"], repoChanges: [{ repo: "web", summary: "y" }] },
  ],
};

/** A json block of the prompt by its heading (`name:` then a ```json block). */
function section<T>(prompt: string, name: string): T {
  const m = new RegExp(`^${name}:\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``, "m").exec(prompt);
  assert.ok(m, `prompt section ${name}`);
  return JSON.parse(m[1]!) as T;
}
const has = (prompt: string, name: string) => new RegExp(`^${name}:\\n`, "m").test(prompt);

/** A valid design doc for what the prompt asks: every checklist item, one section per affected repo, every mustAnswer id. */
function designFor(prompt: string, over: Partial<DesignDoc> = {}): DesignDoc {
  const items = section<Array<{ id: string }>>(prompt, "checklist");
  const repos = section<Array<{ name: string }>>(prompt, "affectedRepos");
  const must = has(prompt, "mustAnswer") ? section<string[]>(prompt, "mustAnswer") : [];
  const mode = /^mode: (\w+)/.exec(prompt)![1];
  return {
    contentMd: `design (${mode})`,
    repos: repos.map((r) => ({ repo: r.name, contentMd: `steps for ${r.name}` })),
    checklist: items.map((i) => ({ item: i.id, status: "considered" as const, conclusion: "ok" })),
    responses: must.map((commentId) => ({ commentId, verdict: "rebutted" as const, reason: `structured reason ${commentId}` })),
    ...over,
  };
}
function critiqueFor(prompt: string, blocking: string[], other: string[] = []): Critique {
  const items = section<Array<{ id: string }>>(prompt, "checklist");
  return {
    comments: [...blocking.map((id) => [id, true] as const), ...other.map((id) => [id, false] as const)].map(([id, b]) => ({
      id, checklistItem: items[0]!.id, repo: null, blocking: b, text: `problem ${id}`, suggestion: null,
    })),
    coverage: items.map((i) => ({ item: i.id, status: "ok" as const, note: "fine" })),
  };
}

type Script = (prompt: string, n: number) => unknown;

function setup(o: { repos?: Name[]; maxRounds?: number; designer?: Script; critic?: Script; arbiter?: Script } = {}) {
  const home = tmpDir("debate");
  const db = openDatabase(":memory:");
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const config: Config = loadConfig(home);
  config.projects = { K: { repos: (o.repos ?? ["api", "web"]).map((name) => ({ name, path: REPOS[name], baseBranch: "main" })) } };
  config.debate.maxRounds = o.maxRounds ?? 3;
  const script = {
    designer: o.designer ?? ((p: string) => designFor(p)),
    critic: o.critic ?? ((p: string) => critiqueFor(p, [])),
    arbiter: o.arbiter ?? (() => ({ recommendations: [] })),
  };
  const execs: Array<{ who: "designer" | "critic" | "arbiter"; req: ExecRequest }> = [];
  const count = { designer: 0, critic: 0, arbiter: 0 };
  const executor: Executor = {
    kind: "claude-code",
    async exec(req) {
      const who = req.prompt.startsWith("mode: critique") ? "critic" : req.prompt.startsWith("mode: arbitrate") ? "arbiter" : "designer";
      execs.push({ who, req });
      const n = ++count[who];
      mkdirSync(dirname(req.rawLogPath), { recursive: true });
      appendFileSync(req.rawLogPath, JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }) + "\n");
      const out = script[who](req.prompt, n);
      if (out instanceof Error) throw out;
      // free text around the json block: it must never reach the critic
      const text = `${MARKER} I also considered something else (session ${SESSION}).\n\`\`\`json\n${JSON.stringify(out)}\n\`\`\`\n`;
      return { text, usage: null, costUsd: null, permissionDenials: [] };
    },
  };
  const calls: Array<RunAgentRequest<unknown>> = [];
  const run = <T>(req: RunAgentRequest<T>) => {
    calls.push(req as RunAgentRequest<unknown>);
    return runAgent({ db, repoRoot, executor, home, bus }, req);
  };
  const finals: string[] = [];
  const make = () => {
    const queue = new JobQueue(1);
    const wf = createWorkflow({ updater: noUpdater, db, home, queue, source: new FakeTicketSource(), run, config, bus, hooks: { afterDesignFinal: (k) => finals.push(k) } });
    return { queue, wf };
  };
  const first = make();
  upsertDiscovered(db, { key: "K-1", title: "T", url: "https://j/K-1", status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(db, home, "K-1", fetched("K-1"));
  const { id } = addRequirement(db, "K-1", snapshotId, requirement, "agent");
  saveSolutions(db, "K-1", id, proposal.solutions);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice"] as const) transition(db, "K-1", to, "system");
  const sols = listSolutions(db, "K-1");
  const state = () => getTicket(db, "K-1")!.state;
  const choiceId = () => currentChoice(db, "K-1")!.id;
  const docs = () => listDesignDocs(db, "K-1").filter((d) => d.choiceId === choiceId());
  const rounds = () => listRounds(db, "K-1", choiceId());
  return { db, home, config, bus, events, execs, calls, finals, sols, state, choiceId, docs, rounds, make, ...first };
}

const designerExecs = (s: ReturnType<typeof setup>) => s.execs.filter((e) => e.who === "designer");
const criticExecs = (s: ReturnType<typeof setup>) => s.execs.filter((e) => e.who === "critic");

/** Critic always blocks; round 3 has C-1, C-2 blocking and C-3 not blocking. */
const alwaysBlocks: Script = (p, n) => (n >= 3 ? critiqueFor(p, ["C-1", "C-2"], ["C-3"]) : critiqueFor(p, ["C-1"]));

async function escalated(o: Parameters<typeof setup>[0] = {}) {
  const s = setup({ critic: alwaysBlocks, ...o });
  s.wf.choose("K-1", s.sols[0]!.id, "note from dev", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state(), "awaiting_debate_ruling", getTicket(s.db, "K-1")!.blockedReason ?? "");
  return s;
}

test("round 1 blocks, round 2 is clean -> design_final; afterDesignFinal once; 2 docs, 3 rounds; read-only runs over the affected repos", async () => {
  const s = setup({ critic: (p, n) => (n === 1 ? critiqueFor(p, ["C-1"], ["C-2"]) : critiqueFor(p, [], ["C-5"])) });
  s.wf.choose("K-1", s.sols[0]!.id, "keep it small", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state(), "design_final");
  assert.deepEqual(s.finals, ["K-1"]);
  assert.equal(s.docs().length, 2);
  assert.deepEqual(s.rounds().map((r) => `${r.role}${r.round}`), ["critic1", "designer1", "critic2"]);
  assert.equal(s.docs()[1]!.isFinal, true);
  assert.equal(s.docs()[0]!.isFinal, false);
  // the designer round holds exactly the asked responses
  const designerRound = s.rounds()[1]!;
  assert.equal(designerRound.designDocId, s.docs()[1]!.id);
  assert.deepEqual("responses" in designerRound.content ? designerRound.content.responses.map((r) => r.commentId) : null, ["C-1"]);
  assert.deepEqual(s.calls.map((c) => c.role), ["design-solution", "critique-design", "design-solution", "critique-design"]);
  for (const c of s.calls) {
    assert.equal(c.cwd, REPOS.api);
    assert.deepEqual(c.addDirs, [REPOS.web]);
    assert.deepEqual(c.allowedTools, ["Read", "Grep", "Glob"]);
    assert.equal(c.chrome, false);
    assert.deepEqual(c.repos?.map((r) => r.name), ["api", "web"]);
  }
  const [draft, revise] = designerExecs(s).map((e) => e.req.prompt);
  assert.match(draft!, /^mode: draft/);
  assert.match(draft!, /keep it small/); // developer note
  assert.match(draft!, /"AC-1"/); // locked requirement
  assert.match(draft!, /"title": "Both"/); // chosen solution
  assert.match(revise!, /^mode: revise/);
  assert.deepEqual(section(revise!, "mustAnswer"), ["C-1"]);
  assert.match(revise!, /at least/);
  assert.match(revise!, /problem C-1/);
  assert.ok(s.events.some((e) => e.type === "debate_updated" && e.ticketKey === "K-1"));
  const types = (s.db.prepare("SELECT type FROM audit_event ORDER BY id").all() as Array<{ type: string }>).map((r) => r.type);
  assert.ok(types.includes("design_finalized"));
});

test("critic keeps blocking -> awaiting_debate_ruling after round 3; disagreements = round-3 blocking comments; audit has the count", async () => {
  const s = await escalated();
  assert.equal(criticExecs(s).length, 3);
  assert.equal(designerExecs(s).length, 4);
  assert.equal(s.docs().length, 4);
  assert.deepEqual(s.finals, []);
  const p = JSON.parse((s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'state_changed' ORDER BY id DESC LIMIT 1").get() as { payload_json: string }).payload_json) as Record<string, unknown>;
  assert.equal(p.to, "awaiting_debate_ruling");
  assert.equal(p.disagreements, 2);
});

test("ruleDebate: missing, unknown, duplicate or blank-custom rulings -> ValidationError; nothing saved", async () => {
  const s = await escalated();
  const bad = [
    [{ commentId: "C-1", decision: "designer", note: "" }],
    [{ commentId: "C-1", decision: "designer", note: "" }, { commentId: "C-2", decision: "designer", note: "" }, { commentId: "C-3", decision: "designer", note: "" }],
    [{ commentId: "C-1", decision: "designer", note: "" }, { commentId: "C-1", decision: "critic", note: "" }],
    [{ commentId: "C-1", decision: "designer", note: "" }, { commentId: "C-2", decision: "custom", note: "  " }],
  ] as const;
  for (const r of bad) assert.throws(() => s.wf.ruleDebate("K-1", r.map((x) => ({ ...x })), "local"), ValidationError, JSON.stringify(r));
  assert.equal(listRulings(s.db, "K-1").length, 0);
  assert.equal(s.state(), "awaiting_debate_ruling");
});

test("ruleDebate all for the designer -> v4 final without another agent run; a second ruling -> InvalidTransitionError", async () => {
  const s = await escalated();
  const before = s.execs.length;
  s.wf.ruleDebate("K-1", [{ commentId: "C-1", decision: "designer", note: "" }, { commentId: "C-2", decision: "designer", note: "fine as is" }], "device:3");
  await s.queue.idle();
  assert.equal(s.state(), "design_final");
  assert.equal(s.execs.length, before);
  assert.equal(s.docs().find((d) => d.isFinal)!.version, 4);
  assert.deepEqual(s.finals, ["K-1"]);
  assert.deepEqual(listRulings(s.db, "K-1").map((r) => r.decidedBy), ["device:3", "device:3"]);
  assert.throws(() => s.wf.ruleDebate("K-1", [{ commentId: "C-1", decision: "designer", note: "" }, { commentId: "C-2", decision: "designer", note: "" }], "local"), InvalidTransitionError);
});

test("ruleDebate: the state change it makes records decidedBy (design_final and designing)", async () => {
  const lastChange = (s: { db: { prepare(q: string): { get(): unknown } } }) =>
    JSON.parse((s.db.prepare("SELECT payload_json FROM audit_event WHERE type = 'state_changed' ORDER BY id DESC LIMIT 1").get() as { payload_json: string }).payload_json) as Record<string, unknown>;
  const a = await escalated();
  a.wf.ruleDebate("K-1", [{ commentId: "C-1", decision: "designer", note: "" }, { commentId: "C-2", decision: "designer", note: "" }], "device:3");
  assert.equal(lastChange(a).to, "design_final");
  assert.equal(lastChange(a).decidedBy, "device:3");
  await a.queue.idle();
  const b = await escalated();
  b.wf.ruleDebate("K-1", [{ commentId: "C-1", decision: "critic", note: "" }, { commentId: "C-2", decision: "designer", note: "" }], "device:4");
  assert.equal(lastChange(b).to, "designing");
  assert.equal(lastChange(b).decidedBy, "device:4");
  await b.queue.idle();
});

test("ruleDebate with critic/custom rulings -> one apply_rulings design run (disagreements + rulings in the prompt), then final, no more runs", async () => {
  const s = await escalated();
  const before = s.execs.length;
  s.wf.ruleDebate("K-1", [{ commentId: "C-1", decision: "critic", note: "" }, { commentId: "C-2", decision: "custom", note: "use a feature flag" }], "local");
  assert.equal(s.state(), "designing");
  await s.queue.idle();
  assert.equal(s.state(), "design_final");
  assert.equal(s.execs.length, before + 1);
  const p = s.execs.at(-1)!;
  assert.equal(p.who, "designer");
  assert.match(p.req.prompt, /^mode: apply_rulings/);
  assert.deepEqual(section(p.req.prompt, "mustAnswer"), ["C-1", "C-2"]);
  const dis = section<Array<{ commentId: string }>>(p.req.prompt, "disagreements");
  assert.deepEqual(dis.map((d) => d.commentId), ["C-1", "C-2"]);
  assert.match(p.req.prompt, /use a feature flag/);
  assert.equal(s.docs().length, 5);
  assert.equal(s.docs().at(-1)!.isFinal, true);
  assert.equal(s.rounds().length, 6); // apply_rulings writes only the doc
  assert.deepEqual(s.finals, ["K-1"]);
});

test("revise write fails halfway -> neither the new doc nor the designer round exists; ticket blocked", async () => {
  const s = setup({ critic: (p) => critiqueFor(p, ["C-1"]) });
  s.db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON debate_round WHEN NEW.role = 'designer' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  s.wf.choose("K-1", s.sols[0]!.id, "", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.equal(s.docs().length, 1);
  assert.deepEqual(s.rounds().map((r) => r.role), ["critic"]);
});

test("rechoose from awaiting_debate_ruling -> awaiting_choice; a new choice debates from draft; old docs stay", async () => {
  const s = await escalated();
  const oldChoice = s.choiceId();
  s.wf.rechoose("K-1", "local");
  assert.equal(s.state(), "awaiting_choice");
  s.wf.choose("K-1", s.sols[1]!.id, "web only now", undefined, "local");
  await s.queue.idle();
  assert.notEqual(s.choiceId(), oldChoice);
  // the new debate started from a draft over web only (critic now clean)
  // 4 designer + 3 critic runs, then the arbiter at the escalation: the new debate starts at call 8
  const firstNew = s.calls.findIndex((c, i) => i >= 8 && c.role === "design-solution");
  assert.equal(firstNew, 8);
  assert.match(designerExecs(s)[4]!.req.prompt, /^mode: draft/);
  assert.deepEqual(s.calls[8]!.repos?.map((r) => r.name), ["web"]);
  assert.equal(s.calls[8]!.cwd, REPOS.web);
  assert.equal(listDesignDocs(s.db, "K-1").filter((d) => d.choiceId === oldChoice).length, 4);
  assert.equal(listRounds(s.db, "K-1", oldChoice).length, 6);
});

test("two affected repos: 25 checklist items; a doc without the web section is retried once, then blocked naming web", async () => {
  const s = setup({ designer: (p) => {
    const d = designFor(p);
    return { ...d, repos: d.repos.filter((r) => r.repo !== "web") };
  } });
  s.wf.choose("K-1", s.sols[0]!.id, "", undefined, "local");
  await s.queue.idle();
  assert.equal(section<unknown[]>(designerExecs(s)[0]!.req.prompt, "checklist").length, 25);
  assert.equal(designerExecs(s).length, 2);
  assert.equal(s.state(), "blocked");
  assert.match(getTicket(s.db, "K-1")!.blockedReason!, /web/);
});

test("web removed from the mapping mid-debate -> the next step blocks naming web", async () => {
  let s: ReturnType<typeof setup>;
  s = setup({ critic: (p) => {
    s.config.projects.K!.repos = s.config.projects.K!.repos.filter((r) => r.name !== "web");
    return critiqueFor(p, ["C-1"]);
  } });
  s.wf.choose("K-1", s.sols[0]!.id, "", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state(), "blocked");
  assert.match(getTicket(s.db, "K-1")!.blockedReason!, /web/);
  assert.equal(designerExecs(s).length, 1);
});

test("restart before the critique: recovery resumes with the critique, the draft is not repeated", async () => {
  const s = setup({ critic: (p, n) => (n === 1 ? new AgentInterruptedError() : critiqueFor(p, [])) });
  s.wf.choose("K-1", s.sols[0]!.id, "", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state(), "designing");
  assert.equal(s.docs().length, 1);
  const again = s.make();
  recoverOnStartup(s.db, again.wf);
  await again.queue.idle();
  assert.equal(s.state(), "design_final");
  assert.equal(designerExecs(s).length, 1);
  assert.equal(criticExecs(s).length, 2);
});

test("isolation (P-TESTS): the round-2 critic prompt carries only platform JSON — no designer free text, no session or run id", async () => {
  const s = setup({ critic: (p, n) => (n === 1 ? critiqueFor(p, ["C-1"]) : critiqueFor(p, [])) });
  s.wf.choose("K-1", s.sols[0]!.id, "", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state(), "design_final");
  const prompt = criticExecs(s)[1]!.req.prompt;
  assert.match(prompt, /^mode: critique/);
  assert.ok(!prompt.includes(MARKER));
  assert.ok(!prompt.includes(SESSION));
  assert.ok(!/session/i.test(prompt));
  const runIds = (s.db.prepare("SELECT id FROM agent_run").all() as Array<{ id: string }>).map((r) => r.id);
  assert.ok(runIds.length >= 3);
  for (const id of runIds) assert.ok(!prompt.includes(id));
  // the designer's structured responses and the current doc do reach the critic
  assert.match(prompt, /structured reason C-1/);
  assert.match(prompt, /design \(revise\)/);
  // everything outside the headings is platform text; every section is a json block
  const stripped = prompt.replace(/^\w+:\n```json\n[\s\S]*?\n```$/gm, "");
  assert.ok(!stripped.includes("I also considered"));
});

test("fake mode (e2e): canned design-solution / critique-design outputs drive FAKE through one revise to design_final, then development to dev_done", async () => {
  const { createFakeRepos } = await import("../src/dev/fake-repo.ts");
  const { fakeRun } = await import("../src/dev/fake-mode.ts");
  const home = tmpDir("debate-fake");
  const db = openDatabase(":memory:");
  const bus = new EventBus();
  const config = loadConfig(home);
  config.projects = { FAKE: { repos: await createFakeRepos(home) } };
  const queue = new JobQueue(1);
  const roles: string[] = [];
  const run = <T>(req: RunAgentRequest<T>) => {
    roles.push(req.role);
    return fakeRun(req);
  };
  const source = new FakeTicketSource();
  source.tickets["FAKE-1"] = fetched("FAKE-1");
  const wf = createWorkflow({ updater: noUpdater, db, home, queue, source, run, config, bus });
  upsertDiscovered(db, { key: "FAKE-1", title: "T", url: "https://j/FAKE-1", status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(db, home, "FAKE-1", fetched("FAKE-1"));
  const { id } = addRequirement(db, "FAKE-1", snapshotId, requirement, "agent");
  saveSolutions(db, "FAKE-1", id, proposal.solutions);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice"] as const) transition(db, "FAKE-1", to, "system");
  wf.choose("FAKE-1", listSolutions(db, "FAKE-1")[0]!.id, "", undefined, "local");
  await queue.idle();
  // Task 10: the design is final, the re-read snapshot is unchanged -> development; Task 11 (B-1): the fake
  // implement-ticket writes only into the affected worktrees; web's hook refuses step 1's TODO, step 2 fixes it -> dev_done
  assert.equal(getTicket(db, "FAKE-1")!.state, "dev_done", getTicket(db, "FAKE-1")!.blockedReason ?? "");
  assert.ok(listDesignDocs(db, "FAKE-1").at(-1)!.isFinal);
  assert.deepEqual(roles, ["design-solution", "critique-design", "design-solution", "critique-design", "implement-ticket", "implement-ticket"]);
  const { listIterations } = await import("../src/development/dev-repo.ts");
  const steps = listIterations(db, "FAKE-1")[0]!.steps;
  const api1 = steps[0]!.repos.find((r) => r.repo === "api")!;
  assert.equal(api1.commit.kind, "committed");
  assert.deepEqual(api1.violations, ["infra/main.tf"]);
  assert.equal(steps[0]!.repos.find((r) => r.repo === "web")!.commit.kind, "hook_failed");
  assert.equal(steps[1]!.repos.find((r) => r.repo === "web")!.commit.kind, "committed");
  // phase 4a Task 8: web's pre-commit ran its fake lint-staged in the dev-hook sandbox: Slack Off's port refused
  const web2 = steps[1]!.repos.find((r) => r.repo === "web")!.commit;
  assert.match(web2.kind === "committed" ? (web2.hookOutput ?? "") : "", /fake-lint: probe 127\.0\.0\.1:4317 -> EPERM/);
  assert.match(readFileSync(join(home, "cache", "FAKE-1", "tmp", "slackoff-hook-marker"), "utf8"), /^\d+ sandboxed\n$/);
  // the developer-facing fake repos are never touched
  for (const r of config.projects.FAKE!.repos) {
    const st = execFileSync("git", ["-C", r.path, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(st, "");
  }
  const docs = listDesignDocs(db, "FAKE-1");
  assert.equal(docs.length, 2);
  assert.deepEqual(docs[1]!.doc.repos.map((r) => r.repo), ["api", "web"]);
  assert.equal(docs[1]!.doc.checklist.length, 25);
});

test("an agent error after the ticket left designing is logged, not swallowed, and does not block the ticket", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  let s: ReturnType<typeof setup>;
  s = setup({ designer: () => {
    s.wf.abandon("K-1", "local");
    return { not: "a design doc" };
  } });
  s.wf.choose("K-1", s.sols[0]!.id, "", undefined, "local");
  await s.queue.idle();
  assert.equal(s.state(), "abandoned");
  assert.ok(logged.mock.calls.some((c) => String(c.arguments.join(" ")).includes("design:K-1")));
});

// ---- the arbiter: a neutral recommendation per disagreement when the debate is escalated ----

import { debateAdvice } from "../src/design/design-repo.ts";

test("escalation runs the arbiter once (read-only critic skill, mode: arbitrate); one recommendation per disagreement is kept", async () => {
  const s = await escalated({
    arbiter: () => ({
      recommendations: [
        { commentId: "C-1", decision: "critic", note: "", reason: "The requirement's AC-2 backs the critic." },
        { commentId: "C-2", decision: "custom", note: "Keep the cache but cap it at 100 entries.", reason: "Both points hold; a cap settles it." },
        { commentId: "C-9", decision: "designer", note: "", reason: "not a disagreement" },
      ],
    }),
  });
  const arb = s.execs.filter((e) => e.who === "arbiter");
  assert.equal(arb.length, 1);
  assert.match(arb[0]!.req.prompt, /^mode: arbitrate/);
  assert.match(arb[0]!.req.prompt, /disagreements:/);
  const advice = debateAdvice(s.db, s.choiceId());
  assert.deepEqual(advice.map((a) => [a.commentId, a.decision, a.note]), [["C-1", "critic", ""], ["C-2", "custom", "Keep the cache but cap it at 100 entries."]]);
  assert.equal(advice[0]!.reason, "The requirement's AC-2 backs the critic.");
});

test("a failing arbiter still escalates the debate, with no recommendation", async () => {
  const s = await escalated({ arbiter: () => new Error("arbiter down") });
  assert.equal(s.state(), "awaiting_debate_ruling");
  assert.deepEqual(debateAdvice(s.db, s.choiceId()), []);
});
