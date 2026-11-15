// Task 8: propose over every mapped repo (real runAgent + fake claude CLI), choose with the affected repos over HTTP.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FetchedTicket, ProposeResult, Requirement, Solution } from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { EventBus } from "../src/http/events.ts";
import { createApp } from "../src/http/app.ts";
import { ClaudeCodeExecutor, passFakeClaudeEnvForTests } from "../src/executor/claude-code.ts";
// phase 4b (4B-11): claude runs get an allowlisted env; the fake CLI's FAKE_CLAUDE_* settings still pass in tests
passFakeClaudeEnvForTests();
import { runAgent, type RunAgentRequest } from "../src/executor/run-agent.ts";
import { FakeTicketSource } from "../src/dev/fake-source.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow } from "../src/workflow/jobs.ts";
import { noUpdater } from "./fixtures/no-updater.ts";
import { getTicket, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { saveDrift } from "../src/drift/drift-repo.ts";
import { addRequirement, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { gitRepo } from "./fixtures/git-repos.ts";
import { tmpDir } from "./helpers/tmp.ts";
import type { AppAcceptanceRules } from "../src/projects/project-rules.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fakeClaude = resolve(import.meta.dirname, "fixtures/fake-claude.ts");
const API = gitRepo("api");
const WEB = gitRepo("web");

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
const solution = (repos: string[]): Solution => ({
  title: `S ${repos.join("+")}`, approach: "a", changeScope: [], pros: [], cons: [], risks: [], complexity: "S",
  affectedRepos: repos, repoChanges: repos.map((repo) => ({ repo, summary: `change ${repo}` })),
});
const proposal = (...sets: string[][]): ProposeResult => ({ solutions: sets.map(solution) });

let home: string;
let stateFile: string;
beforeEach(() => {
  home = tmpDir("mr");
  stateFile = join(home, "calls.log");
  process.env.FAKE_CLAUDE_STATE_FILE = stateFile;
  process.env.FAKE_CLAUDE_SCENARIO = "ok";
});
const argvs = () => (existsSync(stateFile) ? readFileSync(stateFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

const repos = (...names: Array<"api" | "web">) => names.map((name) => ({ name, path: name === "api" ? API : WEB, baseBranch: "main" }));

/** Workflow over the real runAgent with the fake claude CLI; ticket K-1 is refined (review on) and ready to propose. */
function realSetup(mapped: Config["projects"][string]["repos"], out: ProposeResult) {
  process.env.FAKE_CLAUDE_JSON = JSON.stringify(out);
  const db = openDatabase(join(home, "slackoff.db"));
  const bus = new EventBus();
  const config = loadConfig(home);
  config.projects = { K: { repos: mapped } };
  const executor = new ClaudeCodeExecutor([process.execPath, fakeClaude]);
  const run = <T>(req: RunAgentRequest<T>) => runAgent({ db, repoRoot, executor, home, bus }, req);
  const queue = new JobQueue(1);
  const wf = createWorkflow({ updater: noUpdater, db, home, queue, source: new FakeTicketSource(), run, config, bus });
  upsertDiscovered(db, { key: "K-1", title: "T", url: "https://j/K-1", status: "Ready for Dev" }, true);
  const { snapshotId } = saveSnapshot(db, home, "K-1", fetched("K-1"));
  addRequirement(db, "K-1", snapshotId, requirement, "agent");
  for (const to of ["refining", "refined", "awaiting_ac_review"] as const) transition(db, "K-1", to, "system");
  return { db, wf, queue };
}

const PHASE1_DENIED = [
  "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
  ...["computer", "form_input", "javascript_tool", "file_upload", "upload_image", "shortcuts_execute", "browser_batch", "gif_creator", "resize_window",
    "switch_browser", "select_browser", "list_connected_browsers", "read_console_messages", "read_network_requests"].map((t) => `mcp__claude-in-chrome__${t}`),
];
const READ = ["Read", "Grep", "Glob"];

test("regression (P-C4): single repo propose argv is phase 1's plus only --restricted", async () => {
  const s = realSetup(repos("api"), proposal(["api"]));
  s.wf.propose("K-1", "device:9");
  // Workflow.propose takes who decided: recorded on the move to proposing
  const toProposing = (s.db.prepare("SELECT actor, payload_json FROM audit_event WHERE type = 'state_changed' ORDER BY id").all() as Array<{ actor: string; payload_json: string }>)
    .map((r): Record<string, unknown> => ({ actor: r.actor, ...(JSON.parse(r.payload_json) as Record<string, unknown>) }))
    .filter((p) => p.to === "proposing")
    .at(-1)!;
  assert.equal(toProposing.actor, "developer");
  assert.equal(toProposing.decidedBy, "device:9");
  await s.queue.idle();
  assert.equal(getTicket(s.db, "K-1")!.state, "awaiting_choice");
  const [argv] = argvs();
  assert.equal(argvs().length, 1);
  const sys = argv![argv!.indexOf("--append-system-prompt") + 1]!;
  assert.equal(argv!.filter((a) => a === "--restricted").length, 1);
  // phase 4b (4B-4): plus the file guard's --settings (the only hook)
  const at = argv!.indexOf("--settings");
  const pre = (JSON.parse(argv![at + 1]!) as { hooks: { PreToolUse: Array<{ matcher: string }> } }).hooks.PreToolUse;
  assert.deepEqual(pre.map((x) => x.matcher), ["Read|Edit|Write|MultiEdit|Grep|Glob|NotebookEdit"]);
  assert.deepEqual(argv!.filter((a, i) => a !== "--restricted" && i !== at && i !== at + 1), [
    "-p", argv![1]!, "--output-format", "stream-json", "--verbose", "--append-system-prompt", sys,
    "--strict-mcp-config", "--setting-sources", "",
    "--permission-mode", "default", "--permission-prompts", "none",
    "--tools", ...READ,
    "--disallowedTools", ...PHASE1_DENIED,
    "--allowedTools", ...READ,
  ]);
  assert.match(argv![1]!, /"name": "api"/);
});

test("two mapped repos: argv has --add-dir <second repo> once and the prompt names both repos", async () => {
  const s = realSetup(repos("api", "web"), proposal(["api", "web"], ["web"]));
  s.wf.propose("K-1", "local");
  await s.queue.idle();
  assert.equal(getTicket(s.db, "K-1")!.state, "awaiting_choice");
  const [argv] = argvs();
  const i = argv!.indexOf("--add-dir");
  assert.ok(i > 0);
  assert.equal(argv!.filter((a) => a === "--add-dir").length, 1);
  assert.equal(argv![i + 1], WEB);
  assert.match(argv![1]!, /"name": "api"/);
  assert.match(argv![1]!, /"name": "web"/);
});

test("a solution naming an unmapped repo fails validation, is retried once, then the ticket is blocked", async () => {
  const s = realSetup(repos("api", "web"), proposal(["billing"]));
  s.wf.propose("K-1", "local");
  await s.queue.idle();
  const t = getTicket(s.db, "K-1")!;
  assert.equal(t.state, "blocked");
  assert.equal(argvs().length, 2);
  assert.match(argvs()[1]![1]!, /billing/); // the retry prompt carries the validation error
});

// ---- HTTP /choose ----

const TS = { ip: "100.101.102.103", dnsName: null };
const env = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
const LOOPBACK = env("127.0.0.1");
const PHONE = env("100.88.1.2");

function httpSetup() {
  const db = openDatabase(join(home, "slackoff.db"));
  const config = loadConfig(home);
  config.projects = { K: { repos: repos("api", "web") } };
  const bus = new EventBus();
  const run = async () => {
    throw new Error("agent must not run");
  };
  const workflow = createWorkflow({ updater: noUpdater, db, home, queue: new JobQueue(1, { onError: () => {} }), source: new FakeTicketSource(), run: run as never, config, bus });
  const app = createApp({ db, home, repoRoot, workflow, bus, config, remote: TS, webDist: null, detectTailscale: async () => TS });
  upsertDiscovered(db, { key: "K-1", title: "T", url: "https://j/K-1", status: "Ready for Dev" }, false);
  const { snapshotId } = saveSnapshot(db, home, "K-1", fetched("K-1"));
  const { id } = addRequirement(db, "K-1", snapshotId, requirement, "agent");
  saveSolutions(db, "K-1", id, proposal(["api", "web"]).solutions);
  for (const to of ["refining", "refined", "proposing", "awaiting_choice"] as const) transition(db, "K-1", to, "system");
  const solutionId = (db.prepare("SELECT id FROM solution WHERE ticket_key = 'K-1' ORDER BY id").get() as { id: number }).id;
  const call = (from: ReturnType<typeof env>, method: string, path: string, o: { body?: unknown; cookie?: string } = {}) =>
    app.request(
      path,
      {
        method,
        headers: {
          host: from === LOOPBACK ? "127.0.0.1:4317" : `${TS.ip}:4317`,
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(o.cookie ? { cookie: o.cookie } : {}),
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      },
      from,
    );
  const lastChoiceAudit = () =>
    JSON.parse((db.prepare("SELECT payload_json FROM audit_event WHERE type = 'choice_recorded' ORDER BY id DESC LIMIT 1").get() as { payload_json: string }).payload_json) as Record<string, unknown>;
  return { db, call, solutionId, lastChoiceAudit };
}

test("POST /choose: [] or an unknown repo -> 400 and nothing recorded", async () => {
  const s = httpSetup();
  for (const affectedRepos of [[], ["billing"]]) {
    const res = await s.call(LOOPBACK, "POST", "/api/tickets/K-1/choose", { body: { solutionId: s.solutionId, note: "", affectedRepos } });
    assert.equal(res.status, 400, JSON.stringify(affectedRepos));
  }
  assert.equal(getTicket(s.db, "K-1")!.state, "awaiting_choice");
});

test("POST /choose from this computer with an edited set: saved, decidedBy local", async () => {
  const s = httpSetup();
  const res = await s.call(LOOPBACK, "POST", "/api/tickets/K-1/choose", { body: { solutionId: s.solutionId, note: "web only", affectedRepos: ["web"] } });
  assert.equal(res.status, 200);
  assert.equal(getTicket(s.db, "K-1")!.state, "designing");
  const p = s.lastChoiceAudit();
  assert.deepEqual(p.affectedRepos, ["web"]);
  assert.deepEqual(p.solutionAffectedRepos, ["api", "web"]);
  assert.equal(p.decidedBy, "local");
});

test("POST /choose from a paired phone succeeds; decidedBy is the device, a forged decidedBy in the body is ignored", async () => {
  const s = httpSetup();
  const start = (await (await s.call(LOOPBACK, "POST", "/api/pair/start")).json()) as { code: string };
  const redeem = await s.call(PHONE, "POST", "/api/pair/redeem", { body: { code: start.code, deviceName: "Pixel" } });
  assert.equal(redeem.status, 200);
  const token = /slackoff_session=([^;]+)/.exec(redeem.headers.get("set-cookie") ?? "")![1]!;
  const { device } = (await redeem.json()) as { device: { id: number } };
  const res = await s.call(PHONE, "POST", "/api/tickets/K-1/choose", {
    body: { solutionId: s.solutionId, note: "from phone", decidedBy: "local" },
    cookie: `slackoff_session=${token}`,
  });
  assert.equal(res.status, 200);
  assert.equal(getTicket(s.db, "K-1")!.state, "designing");
  const p = s.lastChoiceAudit();
  assert.deepEqual(p.affectedRepos, ["api", "web"]);
  assert.equal(p.decidedBy, `device:${device.id}`);
});

test("POST /drift/ack from a paired phone: decidedBy is the device (Task 10 fix), from this computer 'local'", async () => {
  const s = httpSetup();
  const audit = (type: string) =>
    JSON.parse((s.db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id DESC LIMIT 1").get(type) as { payload_json: string }).payload_json) as Record<string, unknown>;
  for (const key of ["K-2", "K-3"]) {
    upsertDiscovered(s.db, { key, title: "T", url: `https://j/${key}`, status: "Ready for Dev" }, false);
    const { snapshotId } = saveSnapshot(s.db, home, key, fetched(key));
    const { id } = addRequirement(s.db, key, snapshotId, requirement, "human");
    for (const to of ["refining", "refined", "awaiting_ac_review", "checking_drift", "awaiting_drift_ack"] as const) transition(s.db, key, to, "system");
    saveDrift(s.db, key, id, snapshotId, snapshotId, "ac_edited", {
      baseline: [], current: [{ id: "AC-1", status: "new_unsourced" }], contradictions: [],
    });
  }
  const start = (await (await s.call(LOOPBACK, "POST", "/api/pair/start")).json()) as { code: string };
  const redeem = await s.call(PHONE, "POST", "/api/pair/redeem", { body: { code: start.code, deviceName: "Pixel" } });
  const token = /slackoff_session=([^;]+)/.exec(redeem.headers.get("set-cookie") ?? "")![1]!;
  const { device } = (await redeem.json()) as { device: { id: number } };
  const phone = await s.call(PHONE, "POST", "/api/tickets/K-2/drift/ack", { body: { note: "ok", decidedBy: "local" }, cookie: `slackoff_session=${token}` });
  assert.equal(phone.status, 200);
  assert.equal(audit("drift_acknowledged").decidedBy, `device:${device.id}`);
  const local = await s.call(LOOPBACK, "POST", "/api/tickets/K-3/drift/ack", { body: { note: "ok" } });
  assert.equal(local.status, 200);
  assert.equal(audit("drift_acknowledged").decidedBy, "local");
});

// ---- fake mode (e2e): FAKE is mapped to two real repos and the canned solutions name them ----

test("fake mode: createFakeRepos makes api and web on main (rules on the base branch); idempotent; canned solutions use them", async () => {
  const { createFakeRepos } = await import("../src/dev/fake-repo.ts");
  const { fakeRun } = await import("../src/dev/fake-mode.ts");
  const { loadProjectRules } = await import("../src/projects/project-rules.ts");
  const { proposeResultSchema } = await import("@slackoff/shared");
  const refs = await createFakeRepos(home);
  assert.deepEqual(refs.map((r) => [r.name, r.baseBranch]), [["api", "main"], ["web", "main"]]);
  assert.deepEqual(refs.map((r) => r.path), [join(home, "fake-repos", "api"), join(home, "fake-repos", "web")]);
  const api = await loadProjectRules(refs[0]!.path, "main", "api");
  assert.deepEqual(api.rules.forbiddenPaths, ["infra/**"]);
  assert.equal(api.rules.commands.test, "node --test");
  const web = await loadProjectRules(refs[1]!.path, "main", "web");
  assert.equal(web.rules.commands.test, "node --test");
  assert.deepEqual(await createFakeRepos(home), refs);
  const out = await fakeRun({ role: "propose-solutions", prompt: "", cwd: refs[0]!.path, allowedTools: [], chrome: false, schema: proposeResultSchema(["api", "web"]) });
  // Task 17: option 3 changes only api (no acceptance section → E2E not executed)
  assert.deepEqual(out.solutions.map((x) => x.affectedRepos), [["api", "web"], ["web"], ["api"]]);
  assert.equal((web.rules.acceptance as AppAcceptanceRules | null)?.start, "node server.mjs");
  assert.equal(api.rules.acceptance, null);
});
