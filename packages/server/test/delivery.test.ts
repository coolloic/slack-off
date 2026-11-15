// Task 12: the delivery plan (exact actions, PR descriptions, blockers, warnings, hash) and the confirmed delivery flow
// (snapshot re-read, safe push, pull requests, cross-links, JIRA review status and comment).
//
// No network, ever: each repository's origin is GitHub-shaped (`https://github.com/example-org/<name>.git`) and
// `url.<file:///…bare>.insteadOf` in the scratch clone's own config maps it to a local bare repository. `gh` is a scratch
// node script with its own state file (PRs, auth, visibility) that records argv and the body files it was given. JIRA
// is an in-memory fake (read, status change, comment). HOME / XDG_CONFIG_HOME / GIT_CONFIG_GLOBAL are scratch values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AcceptanceReport, DiscoverResult, DriftResult, FetchedTicket, JiraCommentResult, JiraUpdateResult, Requirement, Solution,
} from "@slackoff/shared";
import { openDatabase } from "../src/db/database.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { EventBus, type BusEvent } from "../src/http/events.ts";
import type { RunAgentRequest } from "../src/executor/run-agent.ts";
import { JobQueue } from "../src/workflow/queue.ts";
import { createWorkflow, type Workflow } from "../src/workflow/jobs.ts";
import { recoverOnStartup } from "../src/workflow/recovery.ts";
import { GhClient } from "../src/delivery/gh.ts";
import type { PrClient } from "../src/delivery/pr-client.ts";
import { buildDeliveryPlan, planHash } from "../src/delivery/delivery-plan.ts";
import { createDelivery, listDeliveries, startStep, ticketsWithFailedJiraSteps } from "../src/delivery/delivery-repo.ts";
import { ensureWorktree } from "../src/git/worktree.ts";
import { gitBin } from "../src/git/run.ts";
import { getTicket, setRepoWorkspace, upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import { transition } from "../src/tickets/state-machine.ts";
import { InvalidTransitionError } from "../src/tickets/errors.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { addRequirement, listSolutions, recordChoice, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { listReports, recordDecision, saveReport, startSeries } from "../src/acceptance/review-repo.ts";
import { saveDrift } from "../src/drift/drift-repo.ts";
import { listJiraWrites } from "../src/jira/jira-write-repo.ts";
import { listComments } from "../src/jira/jira-comment-repo.ts";
import type { TicketSource } from "../src/jira/ticket-source.ts";
import type { JiraUpdater } from "../src/jira/jira-updater.ts";
import type { JiraCommenter } from "../src/jira/jira-commenter.ts";
import { tmpDir } from "./helpers/tmp.ts";
import { SANDBOX_EXEC, type SandboxCheck, type SandboxScope } from "../src/sandbox/local-sandbox.ts";

// ---------------------------------------------------------------- isolation (scratch HOME, no global git config)

const root = realpathSync(tmpDir("dlv"));
const userHome = join(root, "userhome");
mkdirSync(join(userHome, ".config"), { recursive: true });
const globalCfg = join(userHome, "gitconfig");
writeFileSync(globalCfg, "");
gitBin(); // resolve (xcrun) before HOME changes
assert.notEqual(process.env.HOME, userHome);
process.env.HOME = userHome;
process.env.XDG_CONFIG_HOME = join(userHome, ".config");
process.env.GIT_CONFIG_GLOBAL = globalCfg;

const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  HOME: userHome, XDG_CONFIG_HOME: join(userHome, ".config"), GIT_CONFIG_GLOBAL: globalCfg,
};
/** git for test setup only */
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: GIT_ENV,
  }).trim();

// ---------------------------------------------------------------- fixtures

const KEY = "FAKE-1";
const BRANCH = "slackoff/FAKE-1-export-orders";
const JIRA_BASE = "https://your-company.atlassian.net";

const requirement: Requirement = {
  background: "Shop owners export orders.",
  functional: [{ id: "FR-1", text: "export orders" }],
  acceptanceCriteria: [{ id: "AC-1", text: "The export downloads", verifiable: true, source: { type: "description", ref: "description", quote: "q" } }],
  discussionOutcomes: [],
  openQuestions: [],
  draftComment: null,
};
const solution = (repos: string[]): Solution => ({
  title: "Stream the CSV", approach: "Write rows as they are read.", changeScope: [], pros: [], cons: [], risks: [], complexity: "M",
  affectedRepos: repos, repoChanges: repos.map((r) => ({ repo: r, summary: "x" })),
});
const DRIFT_OK: DriftResult = { baseline: [{ id: "AC-1", status: "covered", coveredBy: ["AC-1"], note: "" }], current: [{ id: "AC-1", status: "mapped" }], contradictions: [] };
const DRIFT_ACK: DriftResult = { baseline: [{ id: "AC-1", status: "missing", coveredBy: [], note: "gone" }], current: [], contradictions: [] };

const acReport = (commits: { repo: string; sha: string }[], o: { verdict?: AcceptanceReport["verdict"]; reason?: string; acText?: string } = {}): AcceptanceReport => {
  const verdict = o.verdict ?? "passed";
  return {
    verdict,
    notExecutedReason: verdict === "not_executed" ? (o.reason ?? "no acceptance section") : null,
    summary: "checked",
    targets: [],
    acs: [{
      acId: "AC-1", text: o.acText ?? "The export downloads", verdict: verdict === "not_executed" ? "not_tested" : "pass",
      agentVerdict: verdict === "not_executed" ? null : "pass",
      flows: verdict === "not_executed" ? [] : [{ kind: "happy", title: "download", steps: ["open"], expected: "ok", actual: "ok", tests: ["t"], evidenceKeys: ["AC-1/1"], testsPassed: true }],
      mismatch: null,
    }],
    specRun: null,
    projectE2e: [],
    isolation: { ok: true, checks: [], excluded: [] },
    commits,
  };
};

/** In-memory JIRA: read (TicketSource), status change (JiraUpdater), comment (JiraCommenter). */
class FakeJira implements TicketSource, JiraUpdater, JiraCommenter {
  ticket: FetchedTicket = {
    loginRequired: false, key: KEY, title: "Export orders", description: "Export the orders.", jiraUpdatedAt: null, status: "In Progress", comments: [], attachments: [],
  };
  fetches = 0;
  statusCalls: string[] = [];
  postCalls: string[] = [];
  /** the next n posts fail without posting */
  failPosts = 0;
  /** the next n status changes fail without changing */
  failStatus = 0;
  async discover(): Promise<DiscoverResult> {
    return { loginRequired: false, tickets: [], total: 0, complete: true };
  }
  async fetchTicket(_key: string): Promise<FetchedTicket> {
    this.fetches++;
    return structuredClone(this.ticket);
  }
  async setStatus(_key: string, target: string): Promise<JiraUpdateResult> {
    this.statusCalls.push(target);
    if (this.failStatus > 0) {
      this.failStatus--;
      return { loginRequired: false, outcome: "failed", observedStatus: null, detail: "no transition button" };
    }
    this.ticket.status = target;
    return { loginRequired: false, outcome: "changed", observedStatus: target, detail: "" };
  }
  async postComment(_key: string, text: string): Promise<JiraCommentResult> {
    this.postCalls.push(text);
    if (this.failPosts > 0) {
      this.failPosts--;
      return { loginRequired: false, outcome: "failed", detail: "the comment box did not open" };
    }
    this.ticket.comments.push({ jiraCommentId: String(this.ticket.comments.length + 1), author: "me", created: "2026-11-07", body: text });
    return { loginRequired: false, outcome: "posted", detail: "" };
  }
}

interface GhPr { repo: string; number: number; url: string; head: string; base: string; title: string; body: string; open: boolean; fork?: boolean }
interface GhState { auth: boolean; private: Record<string, boolean | "unknown">; prs: GhPr[]; next: number; createThenFail?: boolean; failView?: boolean }

/** A stateful fake `gh` (a node script): its own state file and call log. */
function makeGh(dir: string, initial: Partial<GhState> = {}) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "gh");
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "calls.jsonl");
  writeFileSync(statePath, JSON.stringify({ auth: true, private: {}, prs: [], next: 1, ...initial }));
  writeFileSync(logPath, "");
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const S = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(S, "utf8"));
const a = process.argv.slice(2);
const opt = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : null);
const bodyFile = opt("--body-file");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: a, bodyFile, body: bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, "utf8") : null }) + "\\n");
const save = () => fs.writeFileSync(S, JSON.stringify(state));
const k = a.slice(0, 2).join(" ");
if (k === "auth status") {
  if (!state.auth) { process.stderr.write("You are not logged into any GitHub hosts. To log in, run: gh auth login\\n"); process.exit(1); }
  process.exit(0);
}
if (k === "repo view") {
  const v = state.private[a[2]];
  if (v === "unknown") { process.stderr.write("HTTP 404\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ isPrivate: v === undefined ? true : v }));
  process.exit(0);
}
if (k === "pr list") {
  const repo = opt("--repo"), head = opt("--head");
  const list = state.prs.filter((p) => p.repo === repo && p.head === head && p.open).map((p) => ({
    number: p.number, url: p.url, state: "OPEN", headRefName: p.head, baseRefName: p.base, isCrossRepository: !!p.fork,
    headRepositoryOwner: { login: p.fork ? "someone" : repo.split("/")[1] },
  }));
  process.stdout.write(JSON.stringify(list));
  process.exit(0);
}
if (k === "pr create") {
  const repo = opt("--repo");
  const n = state.next++;
  const url = "https://" + repo + "/pull/" + n;
  state.prs.push({ repo, number: n, url, head: opt("--head"), base: opt("--base"), title: opt("--title"), body: fs.readFileSync(bodyFile, "utf8"), open: true });
  save();
  if (state.createThenFail) { process.stderr.write("HTTP 502: the connection dropped\\n"); process.exit(1); }
  process.stdout.write("Creating pull request\\n" + url + "\\n");
  process.exit(0);
}
if (k === "pr view") {
  if (state.failView) { process.stderr.write("HTTP 502\\n"); process.exit(1); }
  const p = state.prs.find((x) => x.repo === opt("--repo") && x.number === Number(a[2]));
  if (!p) { process.stderr.write("no such PR\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ body: p.body }));
  process.exit(0);
}
if (k === "pr edit") {
  const p = state.prs.find((x) => x.repo === opt("--repo") && x.number === Number(a[2]));
  if (!p) { process.stderr.write("no such PR\\n"); process.exit(1); }
  p.body = fs.readFileSync(bodyFile, "utf8");
  save();
  process.exit(0);
}
process.stderr.write("fake gh: unexpected " + a.join(" ") + "\\n");
process.exit(2);
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    state: (): GhState => JSON.parse(readFileSync(statePath, "utf8")) as GhState,
    setState: (s: Partial<GhState>) => writeFileSync(statePath, JSON.stringify({ ...(JSON.parse(readFileSync(statePath, "utf8")) as GhState), ...s })),
    calls: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; bodyFile: string | null; body: string | null }),
  };
}

let n = 0;

interface Opts {
  repos?: string[];
  sync?: boolean;
  /** an origin URL for a repo that is not GitHub-shaped (the bare repo path itself) */
  plainOrigin?: string[];
  /** repos whose origin is an Azure DevOps URL (redirected to the bare repo) */
  azureOrigin?: string[];
  verdict?: AcceptanceReport["verdict"];
  reason?: string;
  gh?: Partial<GhState>;
  drift?: DriftResult;
  /** phase 4a: replaces the hook sandbox's self-check */
  sandboxCheck?: (s: SandboxScope) => Promise<SandboxCheck>;
  allowUnsandboxedHooks?: boolean;
}

async function setup(o: Opts = {}) {
  const id = n++;
  const base = join(root, `t${id}`);
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const repos = o.repos ?? ["api"];
  const db = openDatabase(join(home, "slackoff.db"));
  const jira = new FakeJira();
  upsertDiscovered(db, { key: KEY, title: "Export orders", url: `${JIRA_BASE}/browse/${KEY}`, status: "In Progress" }, false);
  const { snapshotId } = saveSnapshot(db, home, KEY, await jira.fetchTicket(KEY));
  jira.fetches = 0;
  const { id: requirementId } = addRequirement(db, KEY, snapshotId, requirement, "agent");
  saveSolutions(db, KEY, requirementId, [solution(repos)]);
  recordChoice(db, KEY, listSolutions(db, KEY)[0]!.id, "note", repos, "local");

  const info: Record<string, { bare: string; clone: string; wt: string; sha: string }> = {};
  for (const name of repos) {
    const bare = join(base, "bare", `${name}.git`);
    mkdirSync(bare, { recursive: true });
    sh(bare, "init", "-q", "--bare", "-b", "main");
    const clone = join(base, "repos", name);
    mkdirSync(clone, { recursive: true });
    sh(clone, "init", "-q", "-b", "main");
    writeFileSync(join(clone, "README.md"), `# ${name}\n`);
    sh(clone, "add", "-A");
    sh(clone, "commit", "-q", "-m", "init");
    sh(clone, "remote", "add", "origin", `file://${bare}`);
    sh(clone, "push", "-q", "origin", "main");
    if ((o.plainOrigin ?? []).includes(name)) sh(clone, "remote", "set-url", "origin", bare);
    else {
      const gh = (o.azureOrigin ?? []).includes(name) ? `https://dev.azure.com/example-org/Proj/_git/${name}` : `https://github.com/example-org/${name}.git`;
      sh(clone, "config", `url.file://${bare}.insteadOf`, gh);
      sh(clone, "remote", "set-url", "origin", gh);
    }
    const { path: wt } = await ensureWorktree({ home, key: KEY, repo: { name, path: clone, baseBranch: "main" }, branch: BRANCH });
    setRepoWorkspace(db, KEY, { repo: name, repoPath: clone, baseBranch: "main", branch: BRANCH, worktreePath: wt });
    writeFileSync(join(wt, "feature.txt"), `feature of ${name}\n`);
    sh(wt, "add", "-A");
    sh(wt, "commit", "-q", "-m", "work");
    info[name] = { bare, clone, wt, sha: sh(wt, "rev-parse", "HEAD") };
  }
  const commits = repos.map((r) => ({ repo: r, sha: info[r]!.sha }));
  const { id: seriesId } = startSeries(db, KEY, "handoff", null, "local");
  const { id: reportId } = saveReport(db, KEY, {
    seriesId, requirementId, snapshotId, attempt: 1, report: acReport(commits, { verdict: o.verdict, reason: o.reason }), developerNote: null, evidence: [],
  });
  db.prepare("UPDATE ticket SET state = 'awaiting_confirmation' WHERE key = ?").run(KEY);

  const config: Config = loadConfig(home);
  config.projects = { FAKE: { repos: repos.map((r) => ({ name: r, path: info[r]!.clone, baseBranch: "main" })) } };
  config.jira.baseUrl = JIRA_BASE;
  config.jira.syncStatus = o.sync ?? false;
  config.development.hookTimeoutMs = 20_000;
  if (o.allowUnsandboxedHooks) config.development.allowUnsandboxedHooks = true;
  const gh = makeGh(join(base, "gh"), o.gh);
  config.delivery.ghBin = gh.bin;

  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const queue = new JobQueue(1);
  const runs: Array<RunAgentRequest<unknown>> = [];
  const state = { drift: o.drift ?? DRIFT_OK };
  const run = async <T>(req: RunAgentRequest<T>): Promise<T> => {
    runs.push(req as RunAgentRequest<unknown>);
    if (req.role === "refine-ticket") return state.drift as T;
    throw new Error(`unexpected agent run ${req.role}`);
  };
  const ghBins: string[] = [];
  const mk = () =>
    createWorkflow({
      db, home, queue, source: jira, run, config, bus, updater: jira, commenter: jira,
      ...(o.sandboxCheck ? { sandboxCheck: o.sandboxCheck } : {}),
      gh: (bin: string) => {
        ghBins.push(bin);
        return new GhClient(bin, 20_000);
      },
    });
  const wf = mk();
  const branchOn = (repo: string): string | null => {
    try {
      return sh(info[repo]!.bare, "rev-parse", "--verify", "-q", `refs/heads/${BRANCH}`);
    } catch {
      return null;
    }
  };
  return { db, home, jira, info, config, gh, wf, mk, queue, events, runs, state, reportId, seriesId, requirementId, snapshotId, branchOn, ghBins };
}
type Fx = Awaited<ReturnType<typeof setup>>;

const audits = (db: Fx["db"], type: string) =>
  (db.prepare("SELECT payload_json FROM audit_event WHERE type = ? ORDER BY id").all(type) as Array<{ payload_json: string }>).map(
    (r) => JSON.parse(r.payload_json) as Record<string, unknown>,
  );
const stateOf = (f: Fx) => getTicket(f.db, KEY)!.state;
const steps = (f: Fx) => listDeliveries(f.db, KEY).at(-1)?.steps ?? [];
const deliver = async (f: Fx, ackNote: string | null = null, by = "local") => {
  const p = await f.wf.previewDelivery(KEY);
  assert.deepEqual(p.blockers, []);
  await f.wf.confirmDelivery(KEY, p.hash, ackNote, by);
  await f.queue.idle();
  return p;
};
const plan = (f: Fx) => buildDeliveryPlan(f.db, f.home, f.config, { gh: new GhClient(f.config.delivery.ghBin, 20_000) }, KEY);
/** a hook in the developer's repo (worktrees share it) */
const hook = (f: Fx, repo: string, name: string, script: string) => {
  const p = join(f.info[repo]!.clone, ".git", "hooks", name);
  writeFileSync(p, script);
  chmodSync(p, 0o755);
};

// ---------------------------------------------------------------- the plan

test("plan: an Azure DevOps origin is delivered through the Azure client, named by its Azure id", async () => {
  const f = await setup({ azureOrigin: ["api"] });
  const calls: string[] = [];
  const az: PrClient = {
    authStatus: async (id) => (calls.push(`auth ${id}`), { ok: true, detail: "" }),
    findOpenPr: async (id, head, base) => (calls.push(`find ${id} ${head} ${base}`), { kind: "none" as const }),
    repoVisibility: async (id) => (calls.push(`vis ${id}`), true),
    createPr: async () => { throw new Error("not in a plan"); },
    getPrBody: async () => "",
    editPrBody: async () => {},
  };
  const p = await buildDeliveryPlan(f.db, f.home, f.config, { gh: new GhClient("/nonexistent-gh", 20_000), az }, KEY);
  assert.deepEqual(p.blockers, []);
  assert.equal(p.actions[2]!.text, `Open a pull request in dev.azure.com/example-org/Proj/api: ${BRANCH} → main, titled "${KEY}: Export orders"`);
  assert.ok(calls.includes(`find dev.azure.com/example-org/Proj/api ${BRANCH} main`), calls.join("\n"));
});

test("plan: one repo, status sync off → snapshot, push, pr (no JIRA actions), a warning that JIRA is unchanged", async () => {
  const f = await setup();
  const p = await plan(f);
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.actions.map((a) => [a.seq, a.kind, a.repo]), [[1, "snapshot", null], [2, "push", "api"], [3, "pr", "api"]]);
  assert.equal(p.actions[0]!.text, `Re-read ${KEY} from JIRA (read only) and check the ACs against any change`);
  // F-4 (M-1): the confirmed push names the commit and the acceptance report it comes from (both hashed)
  assert.equal(
    p.actions[1]!.text,
    `Push branch ${BRANCH} of api to origin (github.com/example-org/api) — commit ${f.info.api!.sha.slice(0, 7)} from acceptance report #${f.reportId} — never forced`,
  );
  assert.equal(p.actions[2]!.text, `Open a pull request in github.com/example-org/api: ${BRANCH} → main, titled "${KEY}: Export orders"`);
  assert.ok(p.warnings.includes("JIRA is not changed (status sync is off in Settings)"), p.warnings.join("\n"));
  assert.equal(p.prBodies.length, 1);
  assert.equal(p.prBodies[0]!.title, `${KEY}: Export orders`);
  assert.equal(p.prBodies[0]!.isPrivate, true);
  assert.match(p.hash, /^[0-9a-f]{16}$/);
});

test("plan: two repos, status sync on → 8 actions in order, the JIRA status names Ready for Human Review", async () => {
  const f = await setup({ repos: ["api", "web"], sync: true });
  const p = await plan(f);
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(p.actions.map((a) => [a.kind, a.repo]), [
    ["snapshot", null], ["push", "api"], ["push", "web"], ["pr", "api"], ["pr", "web"], ["pr_links", null], ["jira_status", null], ["jira_comment", null],
  ]);
  assert.deepEqual(p.actions.map((a) => a.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(p.actions[5]!.text, "Edit the 2 pull request descriptions to link to each other");
  assert.equal(p.actions[6]!.text, `Set ${KEY} to "Ready for Human Review" in JIRA (your Chrome)`);
  assert.equal(p.actions[7]!.text, `Comment on ${KEY} in JIRA with the pull request links`);
  assert.ok(!p.warnings.some((w) => w.includes("status sync is off")));
});

test("plan blockers: gh not logged in; a non-GitHub origin; a diverged remote branch; a pushurl elsewhere; a fork PR", async () => {
  const a = await setup({ gh: { auth: false } });
  assert.ok((await plan(a)).blockers.some((b) => b.includes("gh auth login")), (await plan(a)).blockers.join("\n"));

  const b = await setup({ plainOrigin: ["api"] });
  const pb = await plan(b);
  assert.ok(pb.blockers.some((x) => x.includes("api") && x.includes("GitHub")), pb.blockers.join("\n"));

  const c = await setup();
  const other = join(root, `other-${n}`);
  sh(root, "clone", "-q", c.info.api!.bare, other);
  sh(other, "checkout", "-q", "-b", BRANCH);
  writeFileSync(join(other, "theirs.txt"), "t\n");
  sh(other, "add", "-A");
  sh(other, "commit", "-q", "-m", "theirs");
  sh(other, "push", "-q", "origin", `${BRANCH}:${BRANCH}`);
  const pc = await plan(c);
  assert.ok(pc.blockers.some((x) => x.includes("resolve")), pc.blockers.join("\n"));

  const d = await setup();
  sh(d.info.api!.clone, "config", "remote.origin.pushurl", "https://github.com/other-org/api.git");
  const pd = await plan(d);
  assert.ok(pd.blockers.some((x) => x.includes("api")), pd.blockers.join("\n"));

  const e = await setup({
    gh: { prs: [{ repo: "github.com/example-org/api", number: 4, url: "https://github.com/example-org/api/pull/4", head: BRANCH, base: "main", title: "x", body: "", open: true, fork: true }] },
  });
  const pe = await plan(e);
  assert.ok(pe.blockers.some((x) => x.includes("#4") && x.includes("fork")), pe.blockers.join("\n"));
});

test("plan hash: stable for the same state; changes with the PR description (a new report)", async () => {
  const f = await setup();
  const p1 = await plan(f);
  const p2 = await plan(f);
  assert.equal(p1.hash, p2.hash);
  saveReport(f.db, KEY, {
    seriesId: f.seriesId, requirementId: f.requirementId, snapshotId: f.snapshotId, attempt: 2,
    report: acReport([{ repo: "api", sha: f.info.api!.sha }], { acText: "The export downloads as CSV" }), developerNote: null, evidence: [],
  });
  const p3 = await plan(f);
  // F-4 (M-1): the push names the new report; everything else is the same
  assert.deepEqual(p3.actions.filter((a) => a.kind !== "push"), p1.actions.filter((a) => a.kind !== "push"));
  assert.equal(p3.actions[1]!.text, p1.actions[1]!.text.replace(`report #${f.reportId}`, `report #${listReports(f.db, KEY).at(-1)!.id}`));
  assert.notEqual(p3.actions[1]!.text, p1.actions[1]!.text);
  assert.notEqual(p3.prBodies[0]!.body, p1.prBodies[0]!.body);
  assert.notEqual(p3.hash, p1.hash);
});

test("plan warnings are not hashed: e2e not executed; a public repository", async () => {
  const f = await setup({ verdict: "not_executed", reason: "port 3000 is already in use" });
  const p = await plan(f);
  assert.ok(p.warnings.includes("E2E was not executed: port 3000 is already in use"), p.warnings.join("\n"));
  assert.equal(p.hash, planHash(p.actions, p.prBodies));
  assert.equal(p.hash, (await plan(f)).hash);

  const g = await setup({ gh: { private: { "github.com/example-org/api": false } } });
  const pg = await plan(g);
  assert.ok(pg.warnings.some((w) => w.startsWith("github.com/example-org/api is public")), pg.warnings.join("\n"));
  assert.equal(pg.prBodies[0]!.isPrivate, false);
  const h = await setup({ gh: { private: { "github.com/example-org/api": "unknown" } } });
  assert.ok((await plan(h)).warnings.some((w) => w.includes("is public (or its visibility is unknown)")));
});

test("previewDelivery reads delivery.ghBin on every call: a changed path applies without a restart", async () => {
  const f = await setup();
  await f.wf.previewDelivery(KEY);
  assert.ok(f.gh.calls().length > 0);
  const other = makeGh(join(root, `gh-other-${n}`));
  f.config.delivery.ghBin = other.bin;
  const before = f.gh.calls().length;
  const p = await f.wf.previewDelivery(KEY);
  assert.equal(f.ghBins.at(-1), other.bin);
  assert.ok(other.calls().length > 0);
  assert.equal(f.gh.calls().length, before);
  assert.equal(p.jiraNote, null);
});

// ---------------------------------------------------------------- confirm

test("confirm with a stale hash → 409-class error, nothing recorded, state unchanged", async () => {
  const f = await setup();
  await assert.rejects(f.wf.confirmDelivery(KEY, "0000000000000000", null, "local"), (e: unknown) => e instanceof InvalidTransitionError && /review it again/.test((e as Error).message));
  assert.deepEqual(listDeliveries(f.db, KEY), []);
  assert.equal(stateOf(f), "awaiting_confirmation");
  assert.equal(f.gh.calls().filter((c) => c.argv[1] === "create").length, 0);
});

test("confirm with the preview's hash and an ack note: no 409, the note is stored and audited; sync off → no JIRA calls", async () => {
  const f = await setup();
  await deliver(f, "known: the title changed", "device:3");
  const d = listDeliveries(f.db, KEY);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.ackNote, "known: the title changed");
  assert.equal(d[0]!.decidedBy, "device:3");
  const a = audits(f.db, "delivery_confirmed");
  assert.equal(a.length, 1);
  assert.equal(a[0]!.acknowledged, "acknowledged: known: the title changed");
  assert.equal((a[0]!.actions as string[]).length, 3);
  const dec = audits(f.db, "review_decided").at(-1)!;
  assert.equal(dec.decision, "confirmed");
  assert.equal(dec.decidedBy, "device:3");
  assert.equal(stateOf(f), "pr_opened");
  assert.deepEqual(steps(f).map((s) => s.state), ["done", "done", "done"]);
  assert.deepEqual(f.jira.statusCalls, []);
  assert.deepEqual(f.jira.postCalls, []);
  assert.equal(listJiraWrites(f.db, KEY).length, 0);
  assert.equal(listComments(f.db, KEY).length, 0);
});

// ---------------------------------------------------------------- the flow

test("deliver two repos with status sync: pushes, two PRs created then cross-linked, JIRA status and comment", async () => {
  const f = await setup({ repos: ["api", "web"], sync: true });
  await deliver(f, null, "device:7");
  assert.equal(stateOf(f), "pr_opened");
  assert.deepEqual(steps(f).map((s) => [s.kind, s.state]), [
    ["snapshot", "done"], ["push", "done"], ["push", "done"], ["pr", "done"], ["pr", "done"], ["pr_links", "done"], ["jira_status", "done"], ["jira_comment", "done"],
  ]);
  assert.equal(f.branchOn("api"), f.info.api!.sha);
  assert.equal(f.branchOn("web"), f.info.web!.sha);
  const calls = f.gh.calls();
  assert.equal(calls.filter((c) => c.argv[0] === "pr" && c.argv[1] === "create").length, 2);
  assert.equal(calls.filter((c) => c.argv[0] === "pr" && c.argv[1] === "edit").length, 2);
  // the created description is exactly the previewed one
  const p = (listDeliveries(f.db, KEY)[0]!);
  const planned = JSON.parse((f.db.prepare("SELECT plan_json FROM delivery WHERE id = ?").get(p.id) as { plan_json: string }).plan_json) as { prBodies: { repo: string; body: string }[] };
  const created = calls.filter((c) => c.argv[1] === "create");
  assert.equal(created[0]!.body, planned.prBodies.find((b) => b.repo === "api")!.body);
  // body files lived under the data dir's tmp/ and are gone
  for (const c of calls.filter((c) => c.bodyFile)) {
    assert.ok(c.bodyFile!.startsWith(join(f.home, "tmp")), c.bodyFile!);
    assert.ok(!existsSync(c.bodyFile!), c.bodyFile!);
  }
  const prs = f.gh.state().prs;
  const api = prs.find((x) => x.repo === "github.com/example-org/api")!;
  const web = prs.find((x) => x.repo === "github.com/example-org/web")!;
  assert.ok(api.body.includes(web.url) && !api.body.includes(api.url), api.body);
  assert.ok(web.body.includes(api.url) && !web.body.includes(web.url), web.body);
  assert.deepEqual(steps(f)[3]!.result, { number: api.number, url: api.url, reused: false });
  // JIRA: one confirmed write, done, decided by whoever confirmed the delivery; one comment with both URLs
  const writes = listJiraWrites(f.db, KEY);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.state, "done");
  assert.equal(writes[0]!.targetStatus, "Ready for Human Review");
  assert.equal(writes[0]!.decidedBy, "device:7");
  assert.deepEqual(f.jira.statusCalls, ["Ready for Human Review"]);
  const comments = listComments(f.db, KEY);
  assert.equal(comments.length, 1);
  assert.equal(comments[0]!.purpose, "delivery");
  assert.equal(comments[0]!.state, "done");
  assert.ok(comments[0]!.text.includes(api.url) && comments[0]!.text.includes(web.url), comments[0]!.text);
  assert.equal(f.jira.postCalls.length, 1);
  const pushed = audits(f.db, "branch_pushed");
  assert.equal(pushed.length, 2);
  assert.ok(String(pushed[0]!.pushTarget).startsWith("file://"));
  assert.equal(audits(f.db, "pr_opened").length, 2);
  assert.ok(f.events.some((e) => e.type === "delivery_updated"));
  // the platform pushed what acceptance recorded, never forced
  for (const c of calls) for (const a of c.argv) assert.ok(!/^(--fill|--web|--editor|--dry-run)$/.test(a), a);
});

test("a failing second push blocks: api pushed, no PR created; after the fix Retry does not push api again and finishes", async () => {
  const f = await setup({ repos: ["api", "web"] });
  const counter = join(f.home, "..", "api-pushes.txt");
  hook(f, "api", "pre-push", `#!/bin/sh\necho push >> "${counter}"\nexit 0\n`);
  const flag = join(f.home, "..", "web-hook-fails");
  writeFileSync(flag, "1");
  hook(f, "web", "pre-push", `#!/bin/sh\nif [ -f "${flag}" ]; then echo "web hook says no" >&2; exit 1; fi\nexit 0\n`);
  await deliver(f);
  const t = getTicket(f.db, KEY)!;
  assert.equal(t.state, "blocked");
  assert.equal(t.prevState, "delivering");
  assert.match(t.blockedReason ?? "", /web/);
  assert.equal(f.branchOn("api"), f.info.api!.sha);
  assert.equal(f.branchOn("web"), null);
  assert.equal(f.gh.calls().filter((c) => c.argv[1] === "create").length, 0);
  assert.deepEqual(steps(f).map((s) => s.state), ["done", "done", "failed", "pending", "pending", "pending"]);
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1);

  // a JIRA-only retry is refused for a push step
  assert.throws(() => f.wf.retryDeliveryStep(KEY, steps(f)[2]!.id, "local"));

  rmSync(flag);
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "pr_opened");
  assert.equal(f.branchOn("web"), f.info.web!.sha);
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "api was not pushed again");
  // the api push step itself did not run again (not even as "already pushed")
  assert.equal(audits(f.db, "delivery_step_finished").filter((a) => a.kind === "push" && a.repo === "api").length, 1);
  assert.equal(audits(f.db, "branch_pushed").filter((a) => a.repo === "api").length, 1);
  assert.equal(f.gh.calls().filter((c) => c.argv[1] === "create").length, 2);
  assert.deepEqual(steps(f).map((s) => s.state), ["done", "done", "done", "done", "done", "done"]);
});

test("an open PR of the same repo and base is reused: no create, the human-written text survives the cross-link edit", async () => {
  const human = "A paragraph a reviewer wrote by hand.";
  const f = await setup({
    repos: ["api", "web"],
    gh: {
      next: 20,
      prs: [{
        repo: "github.com/example-org/api", number: 11, url: "https://github.com/example-org/api/pull/11", head: BRANCH, base: "main", title: "old",
        body: `${human}\n\n<!-- slackoff:links -->\n<!-- /slackoff:links -->\n`, open: true,
      }],
    },
  });
  const p = await f.wf.previewDelivery(KEY);
  assert.ok(p.actions.some((a) => a.kind === "pr" && a.repo === "api" && a.text.startsWith("Reuse the open pull request #11 in github.com/example-org/api")), p.actions.map((a) => a.text).join("\n"));
  await f.wf.confirmDelivery(KEY, p.hash, null, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "pr_opened");
  const creates = f.gh.calls().filter((c) => c.argv[1] === "create");
  assert.equal(creates.length, 1);
  assert.ok(creates[0]!.argv.includes("github.com/example-org/web"));
  const api = f.gh.state().prs.find((x) => x.number === 11)!;
  const web = f.gh.state().prs.find((x) => x.repo === "github.com/example-org/web")!;
  assert.ok(api.body.startsWith(human), api.body);
  assert.ok(api.body.includes(web.url));
  assert.deepEqual(steps(f).find((s) => s.kind === "pr" && s.repo === "api")!.result, { number: 11, url: api.url, reused: true });
  // T12-3: a reused PR keeps its own description; the preview says so instead of showing a body
  assert.equal(p.prBodies.find((b) => b.repo === "api")!.body, "The existing description is kept; only the links section is added");
  assert.ok(p.prBodies.find((b) => b.repo === "web")!.body.includes("## Summary"));
});

test("a failed JIRA comment leaves the ticket pr_opened; retryStep posts it once and the step is done", async () => {
  const f = await setup({ sync: true });
  f.jira.failPosts = 1;
  await deliver(f);
  assert.equal(stateOf(f), "pr_opened");
  const step = steps(f).find((s) => s.kind === "jira_comment")!;
  assert.equal(step.state, "failed");
  assert.equal(steps(f).find((s) => s.kind === "jira_status")!.state, "done");
  f.wf.retryDeliveryStep(KEY, step.id, "device:9");
  await f.queue.idle();
  assert.equal(steps(f).find((s) => s.kind === "jira_comment")!.state, "done");
  assert.equal(f.jira.ticket.comments.length, 1);
  const finished = audits(f.db, "delivery_step_finished").filter((a) => a.kind === "jira_comment");
  assert.deepEqual(finished.map((a) => a.state), ["failed", "done"]);
  assert.ok(JSON.stringify(f.db.prepare("SELECT payload_json FROM audit_event ORDER BY id DESC LIMIT 40").all()).includes("device:9"));
  // a done step cannot be retried
  assert.throws(() => f.wf.retryDeliveryStep(KEY, step.id, "local"));
});

test("JIRA changed since acceptance and the drift needs an ack → back to awaiting_confirmation, nothing pushed; confirm again with a note → delivered", async () => {
  const f = await setup({ drift: DRIFT_ACK });
  f.jira.ticket.description = "Export the orders, and also the refunds.";
  assert.equal((await f.wf.previewDelivery(KEY)).needsAck, false, "a first preview needs no note");
  await deliver(f);
  assert.equal(stateOf(f), "awaiting_confirmation");
  assert.equal((await f.wf.previewDelivery(KEY)).needsAck, true, "sent back for JIRA drift: the next confirm needs a note");
  assert.equal(f.branchOn("api"), null);
  assert.equal(f.gh.calls().filter((c) => c.argv[1] === "create").length, 0);
  const s = steps(f);
  assert.equal(s[0]!.state, "failed");
  assert.match(s[0]!.detail ?? "", /JIRA changed since acceptance — review the drift, then confirm again with a note/);
  assert.ok(f.events.some((e) => e.type === "snapshot_changed" && e.needsAck));
  assert.equal(f.runs.filter((r) => r.role === "refine-ticket").length, 1);

  await deliver(f, "refunds are a separate ticket");
  assert.equal(stateOf(f), "pr_opened");
  assert.equal(f.branchOn("api"), f.info.api!.sha);
  // the drift check was reused (never asked twice) and is now acknowledged with the note
  assert.equal(f.runs.filter((r) => r.role === "refine-ticket").length, 1);
  assert.ok(audits(f.db, "drift_acknowledged").some((a) => a.note === "refunds are a separate ticket"));
});

test("restart during delivery: blocked 'interrupted by restart', the running step failed, nothing pushed automatically", async () => {
  const f = await setup();
  const p = await f.wf.previewDelivery(KEY);
  recordDecision(f.db, KEY, f.reportId, "confirmed", null, "local");
  createDelivery(f.db, KEY, { reportId: f.reportId, plan: p, ackNote: null, decidedBy: "local" });
  transition(f.db, KEY, "delivering", "developer");
  startStep(f.db, steps(f)[0]!.id);
  const wf2: Workflow = f.mk();
  recoverOnStartup(f.db, wf2);
  await f.queue.idle();
  const t = getTicket(f.db, KEY)!;
  assert.equal(t.state, "blocked");
  assert.match(t.blockedReason ?? "", /delivery interrupted by restart — Retry to continue/);
  assert.equal(steps(f)[0]!.state, "failed");
  assert.match(steps(f)[0]!.detail ?? "", /interrupted by restart/);
  assert.equal(f.branchOn("api"), null);
  // Retry continues from the first unfinished step
  wf2.retry(KEY, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "pr_opened");
  assert.equal(f.branchOn("api"), f.info.api!.sha);
});

test("tmp body files never stay behind", async () => {
  const f = await setup({ repos: ["api", "web"] });
  await deliver(f);
  const tmp = join(f.home, "tmp");
  assert.deepEqual(existsSync(tmp) ? readdirSync(tmp) : [], []);
});

// ---------------------------------------------------------------- fix round 1 (T12-1 … T12-4, I1–I3, M1, M2)

const CHANGED = "the pull requests (or remote) changed since you confirmed — preview again";
/** api's pre-push hook fails while the returned flag file exists */
function failingPush(f: Fx, repo = "api"): string {
  const flag = join(f.home, "..", `${repo}-hook-fails`);
  writeFileSync(flag, "1");
  hook(f, repo, "pre-push", `#!/bin/sh\nif [ -f "${flag}" ]; then echo "hook says no" >&2; exit 1; fi\nexit 0\n`);
  return flag;
}
async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const creates = (f: Fx) => f.gh.calls().filter((c) => c.argv[1] === "create").length;

test("I1: origin changed between the block and Retry → the push step fails 'changed since you confirmed', nothing pushed; Preview again", async () => {
  const f = await setup();
  const flag = failingPush(f);
  await deliver(f);
  assert.equal(stateOf(f), "blocked");
  rmSync(flag);
  // the same bare repository under another GitHub identity: without the check it would be pushed there
  const other = "https://github.com/example-org/other.git";
  sh(f.info.api!.clone, "config", `url.file://${f.info.api!.bare}.insteadOf`, other);
  sh(f.info.api!.clone, "remote", "set-url", "origin", other);
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "blocked");
  const push = steps(f).find((s) => s.kind === "push")!;
  assert.equal(push.state, "failed");
  assert.ok((push.detail ?? "").includes(CHANGED), push.detail ?? "");
  assert.equal(f.branchOn("api"), null);
  // T12-1: Preview again → awaiting_confirmation (audited with who)
  f.wf.previewAgain(KEY, "device:4");
  assert.equal(stateOf(f), "awaiting_confirmation");
  assert.ok(audits(f.db, "state_changed").some((a) => a.to === "awaiting_confirmation" && a.decidedBy === "device:4"));
});

test("I1: an open PR that appeared after the confirmation is not silently reused — the pr step fails", async () => {
  const f = await setup();
  const flag = failingPush(f);
  await deliver(f);
  rmSync(flag);
  f.gh.setState({ prs: [{ repo: "github.com/example-org/api", number: 31, url: "https://github.com/example-org/api/pull/31", head: BRANCH, base: "main", title: "x", body: "someone else's", open: true }] });
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "blocked");
  const pr = steps(f).find((s) => s.kind === "pr")!;
  assert.equal(pr.state, "failed");
  assert.ok((pr.detail ?? "").includes(CHANGED), pr.detail ?? "");
  assert.equal(creates(f), 0);
});

test("I1: the confirmed reused PR #n was closed → the pr step fails, no new PR is opened", async () => {
  const pr11 = { repo: "github.com/example-org/api", number: 11, url: "https://github.com/example-org/api/pull/11", head: BRANCH, base: "main", title: "old", body: "mine", open: true };
  const f = await setup({ gh: { next: 20, prs: [pr11] } });
  const flag = failingPush(f);
  await deliver(f);
  rmSync(flag);
  f.gh.setState({ prs: [{ ...pr11, open: false }] });
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  const pr = steps(f).find((s) => s.kind === "pr")!;
  assert.equal(pr.state, "failed");
  assert.ok((pr.detail ?? "").includes(CHANGED), pr.detail ?? "");
  assert.equal(creates(f), 0);
});

test("I1: a create that was attempted but did not report back → Retry adopts the PR carrying the confirmed body", async () => {
  const f = await setup({ gh: { createThenFail: true } });
  await deliver(f);
  assert.equal(stateOf(f), "blocked");
  assert.equal(creates(f), 1);
  f.gh.setState({ createThenFail: false });
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "pr_opened");
  assert.equal(creates(f), 1, "no second PR");
  const pr = f.gh.state().prs[0]!;
  assert.deepEqual(steps(f).find((s) => s.kind === "pr")!.result, { number: pr.number, url: pr.url, reused: false, adopted: true });
});

test("I2: a restart after pr_opened leaves no JIRA step pending: they fail 'not sent' and are never sent automatically", async () => {
  const f = await setup({ sync: true });
  const p = await f.wf.previewDelivery(KEY);
  recordDecision(f.db, KEY, f.reportId, "confirmed", null, "local");
  createDelivery(f.db, KEY, { reportId: f.reportId, plan: p, ackNote: null, decidedBy: "local" });
  transition(f.db, KEY, "delivering", "developer");
  transition(f.db, KEY, "pr_opened", "system");
  const wf2 = f.mk();
  recoverOnStartup(f.db, wf2);
  await f.queue.idle();
  const jira = steps(f).filter((s) => s.kind === "jira_status" || s.kind === "jira_comment");
  assert.deepEqual(jira.map((s) => s.state), ["failed", "failed"]);
  for (const s of jira) assert.match(s.detail ?? "", /not sent — interrupted by restart, retry to send/);
  assert.deepEqual(f.jira.statusCalls, []);
  assert.deepEqual(f.jira.postCalls, []);
});

test("I3: a new commit in the worktree after the block → Retry fails 'not the recorded commit', the new commit is never pushed", async () => {
  const f = await setup({ repos: ["api", "web"] });
  const flag = failingPush(f, "web");
  await deliver(f);
  assert.equal(stateOf(f), "blocked");
  rmSync(flag);
  writeFileSync(join(f.info.web!.wt, "late.txt"), "late\n");
  sh(f.info.web!.wt, "add", "-A");
  sh(f.info.web!.wt, "commit", "-q", "-m", "late");
  const late = sh(f.info.web!.wt, "rev-parse", "HEAD");
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "blocked");
  const push = steps(f).find((s) => s.kind === "push" && s.repo === "web")!;
  assert.equal(push.state, "failed");
  assert.match(push.detail ?? "", /not the recorded commit/);
  assert.equal(f.branchOn("web"), null);
  assert.throws(() => sh(f.info.web!.bare, "cat-file", "-e", `${late}^{commit}`));
});

test("T12-2: an ack note given at confirm does not cover a drift found later — the delivery still goes back for review", async () => {
  const f = await setup({ drift: DRIFT_ACK });
  f.jira.ticket.description = "Export the orders, and also the refunds.";
  await deliver(f, "nothing known yet");
  assert.equal(stateOf(f), "awaiting_confirmation");
  assert.equal(f.branchOn("api"), null);
  assert.equal(audits(f.db, "drift_acknowledged").length, 0);
});

test("M1: retryStep is refused while another step of the delivery is running", async () => {
  const f = await setup({ sync: true });
  f.jira.failPosts = 1;
  f.jira.failStatus = 1;
  await deliver(f);
  const status = steps(f).find((s) => s.kind === "jira_status")!;
  const comment = steps(f).find((s) => s.kind === "jira_comment")!;
  assert.deepEqual([status.state, comment.state], ["failed", "failed"]);
  f.wf.retryDeliveryStep(KEY, status.id, "local");
  assert.throws(() => f.wf.retryDeliveryStep(KEY, comment.id, "local"), /running/);
  await f.queue.idle();
  assert.equal(steps(f).find((s) => s.kind === "jira_status")!.state, "done");
  f.wf.retryDeliveryStep(KEY, comment.id, "local");
  await f.queue.idle();
  assert.equal(f.jira.ticket.comments.length, 1);
});

test("M2: abandoning mid-delivery skips the pending steps; nothing further is pushed or created", async () => {
  const f = await setup({ repos: ["api", "web"] });
  const started = join(f.home, "..", "api-push-started");
  const go = join(f.home, "..", "api-push-go");
  hook(f, "api", "pre-push", `#!/bin/sh\ntouch "${started}"\nwhile [ ! -f "${go}" ]; do sleep 0.05; done\nexit 0\n`);
  const p = await f.wf.previewDelivery(KEY);
  await f.wf.confirmDelivery(KEY, p.hash, null, "local");
  await waitFor(() => existsSync(started));
  f.wf.abandon(KEY, "local");
  writeFileSync(go, "1");
  await f.queue.idle();
  assert.equal(stateOf(f), "abandoned");
  assert.deepEqual(steps(f).map((s) => s.state), ["done", "done", "skipped", "skipped", "skipped", "skipped"]);
  assert.equal(f.branchOn("web"), null);
  assert.equal(creates(f), 0);
});

// ---------------------------------------------------------------- fix round 2 (T12-5)

test("R-I1: pr_links edits the PRs named by the confirmed URLs: origin changed before Retry → the step fails, nothing is edited", async () => {
  const f = await setup({ repos: ["api", "web"] });
  f.gh.setState({ failView: true });
  await deliver(f);
  assert.equal(stateOf(f), "blocked");
  assert.equal(steps(f).find((s) => s.kind === "pr_links")!.state, "failed");
  f.gh.setState({ failView: false });
  const other = "https://github.com/example-org/other.git";
  sh(f.info.api!.clone, "config", `url.file://${f.info.api!.bare}.insteadOf`, other);
  sh(f.info.api!.clone, "remote", "set-url", "origin", other);
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  const links = steps(f).find((s) => s.kind === "pr_links")!;
  assert.equal(links.state, "failed");
  assert.ok((links.detail ?? "").includes(CHANGED), links.detail ?? "");
  assert.equal(f.gh.calls().filter((c) => c.argv[1] === "edit").length, 0);
});

test("R-M1: a push target that is not GitHub-shaped (a pushInsteadOf to a plain path) blocks the plan and fails a Retry", async () => {
  const a = await setup();
  sh(a.info.api!.clone, "config", `url.${a.info.api!.bare}.pushInsteadOf`, "https://github.com/example-org/api.git");
  const pa = await plan(a);
  assert.ok(pa.blockers.some((b) => b.startsWith("api:") && /push/.test(b)), pa.blockers.join("\n"));

  const f = await setup();
  const flag = failingPush(f);
  await deliver(f);
  rmSync(flag);
  sh(f.info.api!.clone, "config", `url.${f.info.api!.bare}.pushInsteadOf`, "https://github.com/example-org/api.git");
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "blocked");
  assert.equal(steps(f).find((s) => s.kind === "push")!.state, "failed");
  assert.equal(f.branchOn("api"), null);
});

test("R-L1: Preview again skips the superseded delivery's pending steps in the same move", async () => {
  const f = await setup();
  const flag = failingPush(f);
  await deliver(f);
  rmSync(flag);
  f.wf.previewAgain(KEY, "local");
  const old = listDeliveries(f.db, KEY)[0]!.steps;
  assert.deepEqual(old.map((s) => s.state), ["done", "failed", "skipped"]);
  assert.equal(old[2]!.detail, "superseded — previewed again");
  await deliver(f);
  assert.equal(stateOf(f), "pr_opened");
});

test("T12-2 (ids, not clocks): a drift that existed at confirm is covered by the note whatever its timestamp says", async () => {
  const f = await setup({ drift: DRIFT_ACK });
  f.jira.ticket.description = "Export the orders, and also the refunds.";
  // the changed ticket was already read and drift-checked before the confirmation; its clock reads far in the future
  const { snapshotId } = saveSnapshot(f.db, f.home, KEY, await f.jira.fetchTicket(KEY));
  const { id } = saveDrift(f.db, KEY, f.requirementId, f.snapshotId, snapshotId, "before_review", DRIFT_ACK);
  f.db.prepare("UPDATE drift_check SET created_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(id);
  await deliver(f, "refunds are a separate ticket");
  assert.equal(stateOf(f), "pr_opened");
  assert.equal(f.runs.filter((r) => r.role === "refine-ticket").length, 0);
});

test("F-1: a delivery bounced by a JIRA change with sync on → its pending steps are skipped; after D2 and a restart no D1 step fails and the ticket is not in Needs me", async () => {
  const f = await setup({ drift: DRIFT_ACK, sync: true });
  f.jira.ticket.description = "Export the orders, and also the refunds.";
  await deliver(f);
  assert.equal(stateOf(f), "awaiting_confirmation");
  const d1 = listDeliveries(f.db, KEY)[0]!;
  assert.ok(d1.steps.some((s) => s.kind === "jira_status"), "sync on: D1 has JIRA steps");
  for (const s of d1.steps.slice(1)) {
    assert.equal(s.state, "skipped", `${s.kind} of D1 is skipped in the same move`);
    assert.equal(s.detail, "sent back: JIRA changed");
  }
  await deliver(f, "refunds are a separate ticket");
  assert.equal(stateOf(f), "pr_opened");
  recoverOnStartup(f.db, f.mk());
  await f.queue.idle();
  const after = listDeliveries(f.db, KEY)[0]!.steps;
  assert.ok(!after.some((s) => (s.kind === "jira_status" || s.kind === "jira_comment") && s.state === "failed"), "no D1 JIRA step failed");
  assert.deepEqual(ticketsWithFailedJiraSteps(f.db), []);
});

test("F-1: only the latest delivery counts — a failed or pending JIRA step of an older delivery neither fails at restart nor puts the ticket in Needs me", async () => {
  const f = await setup({ sync: true });
  const p = await f.wf.previewDelivery(KEY);
  recordDecision(f.db, KEY, f.reportId, "confirmed", null, "local");
  createDelivery(f.db, KEY, { reportId: f.reportId, plan: p, ackNote: null, decidedBy: "local" });
  const old = listDeliveries(f.db, KEY)[0]!.steps;
  // an older delivery left behind with a failed and a pending JIRA step (data from before F-1)
  f.db.prepare("UPDATE delivery_step SET state = 'failed', detail = 'old' WHERE id = ?").run(old.find((s) => s.kind === "jira_status")!.id);
  createDelivery(f.db, KEY, { reportId: f.reportId, plan: p, ackNote: null, decidedBy: "local" });
  const d2 = listDeliveries(f.db, KEY)[1]!;
  for (const s of d2.steps) f.db.prepare("UPDATE delivery_step SET state = 'done' WHERE id = ?").run(s.id);
  transition(f.db, KEY, "delivering", "developer");
  transition(f.db, KEY, "pr_opened", "system");
  assert.deepEqual(ticketsWithFailedJiraSteps(f.db), []);
  recoverOnStartup(f.db, f.mk());
  await f.queue.idle();
  assert.notEqual(listDeliveries(f.db, KEY)[0]!.steps.find((s) => s.kind === "jira_comment")!.state, "failed");
  assert.deepEqual(ticketsWithFailedJiraSteps(f.db), []);
});

test("F-4 (M-1): a push whose confirmed text names another commit or report is refused — nothing pushed", async () => {
  const f = await setup();
  const p = await f.wf.previewDelivery(KEY);
  recordDecision(f.db, KEY, f.reportId, "confirmed", null, "local");
  // what the developer confirmed named another report than the one recorded for this delivery
  const other = { ...p, actions: p.actions.map((a) => (a.kind === "push" ? { ...a, text: a.text.replace(`report #${f.reportId}`, `report #${f.reportId + 1}`) } : a)) };
  assert.notDeepEqual(other.actions, p.actions);
  createDelivery(f.db, KEY, { reportId: f.reportId, plan: other, ackNote: null, decidedBy: "local" });
  f.db.prepare("UPDATE delivery_step SET state = 'done' WHERE id = ?").run(steps(f)[0]!.id);
  transition(f.db, KEY, "delivering", "developer");
  transition(f.db, KEY, "blocked", "system", "test");
  f.wf.retry(KEY, "local");
  await f.queue.idle();
  assert.equal(stateOf(f), "blocked");
  assert.match(steps(f).find((s) => s.kind === "push")!.detail ?? "", /changed since you confirmed/);
  assert.equal(f.branchOn("api"), null);
});

// ---------------------------------------------------------------- phase 4a Task 3: pre-push in the dev-hook sandbox

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const noHookSandbox = async (): Promise<SandboxCheck> => ({ ok: false, detail: "sandbox-exec is not available on linux" });

test("4a: a repo with a pre-push hook and no hook sandbox (switch off) -> the push step fails, blocked naming the hooks setting; nothing pushed", async () => {
  const seen: SandboxScope[] = [];
  const f = await setup({ sandboxCheck: async (s) => (seen.push(s), noHookSandbox()) });
  const ran = join(f.home, "..", "pre-push-ran");
  hook(f, "api", "pre-push", `#!/bin/sh\ntouch "${ran}"\nexit 0\n`);
  await deliver(f);
  const t = getTicket(f.db, KEY)!;
  assert.equal(t.state, "blocked");
  const push = steps(f).find((s) => s.kind === "push")!;
  assert.equal(push.state, "failed");
  assert.match(push.detail ?? "", /^api: sandbox-exec is not available on linux — git hooks are not run without the sandbox/);
  assert.match(t.blockedReason ?? "", /"Run git hooks without the sandbox"/);
  assert.equal(f.branchOn("api"), null);
  assert.equal(existsSync(ran), false, "the hook never ran");
  assert.deepEqual(seen.map((s) => [s.kind, s.writable]), [["dev-hook", [f.info.api!.wt]]], "the scope is the ticket's worktree");
});

test("4a: the hooks switch on -> pre-push runs unsandboxed, the push goes through, audited hooks_unsandboxed", async () => {
  const f = await setup({ sandboxCheck: noHookSandbox, allowUnsandboxedHooks: true });
  const ran = join(f.home, "..", "pre-push-ran");
  hook(f, "api", "pre-push", `#!/bin/sh\ntouch "${ran}"\nexit 0\n`);
  await deliver(f);
  assert.equal(stateOf(f), "pr_opened");
  assert.equal(f.branchOn("api"), f.info.api!.sha);
  assert.equal(existsSync(ran), true);
  assert.deepEqual(audits(f.db, "hooks_unsandboxed"), [{ repo: "api", reason: "sandbox-exec is not available on linux" }]);
});

test("4a: a repo without hooks pushes as before — no hook self-check", async () => {
  const seen: SandboxScope[] = [];
  const f = await setup({ sandboxCheck: async (s) => (seen.push(s), noHookSandbox()) });
  await deliver(f);
  assert.equal(stateOf(f), "pr_opened");
  assert.equal(f.branchOn("api"), f.info.api!.sha);
  assert.deepEqual(seen, []);
});

test("4a real sandbox: pre-push runs in the dev-hook sandbox — the injected HOME's ssh key is EPERM and the push fails with its output", { skip: HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC}` }, async () => {
  mkdirSync(join(userHome, ".ssh"), { recursive: true });
  writeFileSync(join(userHome, ".ssh", "id"), "PRIVATE-KEY\n");
  const f = await setup();
  hook(f, "api", "pre-push", `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'try { require("node:fs").readFileSync(process.env.HOME + "/.ssh/id"); console.error("ssh:READABLE"); } catch (e) { console.error("ssh:" + e.code); } process.exit(1)'\n`);
  await deliver(f);
  assert.equal(stateOf(f), "blocked");
  assert.match(steps(f).find((s) => s.kind === "push")!.detail ?? "", /ssh:EPERM/);
  assert.equal(f.branchOn("api"), null);
});

// ---- final fix pass (ruling F4B-4): the delivery's JIRA wording follows the JIRA mode ----

test("F4B-4: in the JIRA API mode the status action names the JIRA API, not Chrome — and the plan hash changes with it", async () => {
  const f = await setup({ sync: true });
  const browser = await plan(f);
  assert.equal(browser.actions.find((a) => a.kind === "jira_status")!.text, `Set ${KEY} to "Ready for Human Review" in JIRA (your Chrome)`);
  f.config.jira.source = "api";
  const api = await plan(f);
  const text = api.actions.find((a) => a.kind === "jira_status")!.text;
  assert.equal(text, `Set ${KEY} to "Ready for Human Review" in JIRA (through the JIRA API, with your API token)`);
  assert.doesNotMatch(api.actions.map((a) => a.text).join("\n"), /Chrome/);
  assert.notEqual(api.hash, browser.hash);
  assert.equal(api.hash, planHash(api.actions, api.prBodies));
});

test("F4B-4: a delivery re-read that needs a JIRA login in the API mode says the API token was rejected, never 'in Chrome'", async () => {
  const f = await setup();
  f.config.jira.source = "api";
  const p = await f.wf.previewDelivery(KEY);
  assert.deepEqual(p.blockers, []);
  f.jira.ticket.loginRequired = true;
  await f.wf.confirmDelivery(KEY, p.hash, null, "local");
  await f.queue.idle();
  const snap = steps(f).find((s) => s.kind === "snapshot")!;
  assert.equal(snap.state, "failed");
  assert.match(snap.detail ?? "", /API token/);
  assert.doesNotMatch(snap.detail ?? "", /Chrome/);
});
