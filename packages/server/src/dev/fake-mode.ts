// Dev/e2e only: SLACKOFF_FAKE_EXECUTOR=1 swaps JIRA and the agent for canned data. Never used otherwise.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Critique, DesignDoc, DevStepResult, DriftResult, JiraCommentResult, JiraUpdateResult, Requirement } from "@slackoff/shared";
import { ProposeResult as ProposeResultSchema } from "@slackoff/shared";
import type { z } from "zod";
import { GhClient } from "../delivery/gh.ts";
import type { RunAgentRequest } from "../executor/run-agent.ts";
import { fakeAcceptance } from "./fake-acceptance.ts";
import { assertFakeOrigin } from "./fake-repo.ts";
import { FakeTicketSource } from "./fake-source.ts";

export const FAKE_BASE_URL = "https://fake-jira.example.com";

/** The fake JIRA the fake jira-update changes, so the platform's read-only verification sees the new status. */
let fakeJira: FakeTicketSource | null = null;
/** jira-update runs per ticket since the fake source was created. */
let writeAttempts = new Map<string, number>();

/** Per-ticket switches (Task 17), so e2e reaches every phase-2 decision deterministically. */
export const FAKE_SWITCHES = {
  /** the fake critic keeps two blocking comments in every round: the debate escalates to the developer */
  criticNeverSatisfied: new Set(["FAKE-2"]),
  /** the first jira-update run fails (nothing changed in JIRA); the next one moves the ticket */
  firstJiraWriteFails: new Set(["FAKE-2"]),
  /** JIRA shows a changed description from the second read on: the re-read before development needs an ack */
  changesAfterFirstRead: new Set(["FAKE-3"]),
  /** phase 3: JIRA changes again before the third read (the re-read before acceptance): it needs an ack too */
  changesBeforeReview: new Set(["FAKE-3"]),
  /** phase 3: the first acceptance run reports AC-2 as failed (its test fails too); every later run passes */
  acceptanceFailsOnce: new Set(["FAKE-1", "FAKE-4"]),
  /** phase 3: refine drafts a requirement-unclear comment to the reporter */
  draftsComment: new Set(["FAKE-1"]),
  /**
   * phase 4c task 6: the first propose-solutions run of these tickets reports the CLI's usage limit (an auto-pause).
   * Empty unless SLACKOFF_FAKE_USAGE_LIMIT_ONCE lists keys (the phase-4c e2e sets FAKE-2), so other specs are unchanged.
   */
  usageLimitOnce: new Set((process.env.SLACKOFF_FAKE_USAGE_LIMIT_ONCE ?? "").split(",").map((k) => k.trim()).filter((k) => /^FAKE-\d+$/.test(k))),
};

/** The fake `gh` (dev/fake-gh.mjs) behind a `${home}/fake-bin/gh` wrapper; set by installFakeGh. */
let fakeGhBin: string | null = null;

/**
 * Task 17: writes `${home}/fake-bin/gh` (runs dev/fake-gh.mjs with this Node; pull requests in `${home}/fake-github`).
 * It is never written into config.delivery.ghBin: a PUT /api/config would put the value on disk back in memory and the
 * real gh would run. Instead fakeGh() resolves this path on every call, whatever bin it is given.
 */
export function installFakeGh(home: string): string {
  const script = fileURLToPath(new URL("./fake-gh.mjs", import.meta.url));
  const bin = join(home, "fake-bin", "gh");
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/bin/sh\nSLACKOFF_FAKE_GH_STATE=${q(join(home, "fake-github"))} exec ${q(process.execPath)} ${q(script)} "$@"\n`);
  chmodSync(bin, 0o755);
  fakeGhBin = bin;
  return bin;
}

/** WorkflowDeps.gh in fake mode: always the fake gh, never the configured bin (which may name the real one). */
export function fakeGh(_bin: string): GhClient {
  if (fakeGhBin === null) throw new Error("fake mode: the fake gh is not installed");
  return new GhClient(fakeGhBin);
}

/** WorkflowDeps.beforePush in fake mode: the origin must be the fake GitHub, resolved to a local bare repository. */
export const fakeBeforePush = (home: string) => (wt: string, repo: string): Promise<void> => assertFakeOrigin(home, wt, repo);

/** phase 4f: the phase-4f e2e maps a third fake repo `cli` and discovers FAKE-4 (off otherwise: other specs unchanged). */
export const FAKE_CLI = process.env.SLACKOFF_FAKE_CLI_REPO === "1";

export function createFakeSource(o: { cli?: boolean } = { cli: FAKE_CLI }): FakeTicketSource {
  const source = new FakeTicketSource();
  fakeJira = source;
  writeAttempts = new Map();
  source.delayMs = 600; // F-I3: discovery finishes after the 202, so the UI must follow it over SSE
  source.discoverResult = {
    loginRequired: false,
    tickets: [
      { key: "FAKE-1", title: "Export orders as CSV", url: `${FAKE_BASE_URL}/browse/FAKE-1`, status: "Ready for Dev" },
      { key: "FAKE-2", title: "Archive old orders", url: `${FAKE_BASE_URL}/browse/FAKE-2`, status: "Ready for Dev" },
      // every open ticket assigned to me is discovered, not only "Ready for Dev" ones (author decision 2026-11-06)
      { key: "FAKE-3", title: "Speed up order search", url: `${FAKE_BASE_URL}/browse/FAKE-3`, status: "In Progress" },
    ],
    total: 3,
    complete: true,
  };
  if (o.cli === true) {
    source.discoverResult.tickets.push({ key: "FAKE-4", title: "Command-line export", url: `${FAKE_BASE_URL}/browse/FAKE-4`, status: "Ready for Dev" });
    source.discoverResult.total = 4;
    source.tickets["FAKE-4"] = {
      loginRequired: false, key: "FAKE-4", title: "Command-line export", description: "Ship the to-do list as a command-line tool.",
      jiraUpdatedAt: "2026-11-06T00:00:00Z", status: "Ready for Dev", comments: [], attachments: [],
    };
  }
  source.tickets["FAKE-3"] = {
    loginRequired: false,
    key: "FAKE-3",
    title: "Speed up order search",
    description: "Order search takes several seconds on large accounts.",
    jiraUpdatedAt: "2026-11-06T00:00:00Z",
    status: "In Progress",
    comments: [],
    attachments: [],
  };
  // F-I7: the browser agent could not expand older comments on this one
  source.tickets["FAKE-2"] = {
    loginRequired: false,
    key: "FAKE-2",
    title: "Archive old orders",
    description: "Move orders older than two years to the archive.\n\n[slackoff: 3 older comments not loaded]",
    jiraUpdatedAt: "2026-11-06T00:00:00Z",
    status: "Ready for Dev",
    comments: [{ jiraCommentId: "10010", author: "cat", created: "2026-11-05T11:00:00Z", body: "Keep invoices searchable." }],
    attachments: [],
  };
  source.tickets["FAKE-1"] = {
    loginRequired: false,
    key: "FAKE-1",
    title: "Export orders as CSV",
    description: "Add an export button to the orders page.\n\nIt downloads a CSV file.",
    jiraUpdatedAt: "2026-11-06T00:00:00Z",
    status: "Ready for Dev",
    comments: [
      { jiraCommentId: "10001", author: "ann", created: "2026-11-05T09:00:00Z", body: "Include a VAT column." },
      { jiraCommentId: "10002", author: "bob", created: "2026-11-05T10:00:00Z", body: "Dates must be ISO-8601." },
    ],
    attachments: [{ kind: "attachment", filename: "spec.pdf", mime: "application/pdf", url: `${FAKE_BASE_URL}/secure/attachment/1/spec.pdf`, base64: null }],
  };
  for (const key of FAKE_SWITCHES.changesAfterFirstRead) {
    const t = source.tickets[key];
    if (t === undefined || t instanceof Error) continue;
    const second = { ...t, description: `${t.description}\n\nUpdate: also cover saved searches.`, jiraUpdatedAt: "2026-11-07T00:00:00Z" };
    source.laterReads[key] = [second];
    // read 3 = the re-read before acceptance (phase 3)
    if (FAKE_SWITCHES.changesBeforeReview.has(key)) {
      source.laterReads[key].push({ ...second, description: `${second.description}\n\nUpdate 2: show how long the search took.`, jiraUpdatedAt: "2026-11-08T00:00:00Z" });
    }
  }
  return source;
}

const fakeRequirement: Requirement = {
  background: "Support wants to export orders for reporting.",
  functional: [{ id: "FR-1", text: "Orders page offers a CSV export." }],
  acceptanceCriteria: [
    { id: "AC-1", text: "The orders page has an Export button.", verifiable: true, source: { type: "description", ref: "description#p1", quote: "Add an export button to the orders page." } },
    { id: "AC-2", text: "Clicking Export downloads a CSV file.", verifiable: true, source: { type: "description", ref: "description#p2", quote: "It downloads a CSV file." } },
    { id: "AC-3", text: "The CSV has a VAT column.", verifiable: true, source: { type: "comment", ref: "comment#10001", quote: "Include a VAT column." } },
  ],
  discussionOutcomes: [{ id: "D-1", text: "Dates are exported as ISO-8601.", sourceCommentIds: ["10002"] }],
  openQuestions: [],
  draftComment: null,
};

/** One baseline AC is reported missing, so this drift check needs acknowledgement. */
const fakeDriftNeedsAck: DriftResult = {
  baseline: [
    { id: "AC-1@v1", status: "covered", coveredBy: ["AC-1"], note: "" },
    { id: "AC-2@v1", status: "missing", coveredBy: [], note: "The download requirement was dropped." },
    { id: "AC-3@v1", status: "covered", coveredBy: ["AC-3"], note: "" },
    { id: "D-1", status: "covered", coveredBy: ["AC-1"], note: "" },
  ],
  current: [{ id: "AC-1", status: "mapped" }, { id: "AC-3", status: "mapped" }],
  contradictions: [],
  ackOptions: [
    { label: "Dropped on purpose", text: "AC-2 was dropped on purpose — the download is out of scope for this ticket.", recommended: true, action: "acknowledge" },
    { label: "Restore AC-2", text: "Restore AC-2: the download is still required.", recommended: false, action: "revise" },
  ],
};

/**
 * Option 1 changes both fake repos, option 2 only web, option 3 only api (fake project FAKE → api, web; see
 * fake-repo.ts). Only web declares an acceptance section, so option 3's acceptance is "E2E not executed".
 */
/** what the propose agent writes (parsed like real output: recommended defaults to false) */
type ProposeOutput = z.input<typeof ProposeResultSchema>;

const fakeSolutionsBase: ProposeOutput = {
  solutions: [
    { recommended: true, recommendationReason: "Streams any size of export and keeps the filters in one place.", title: "Server-side CSV endpoint", approach: "Add GET /orders.csv that streams rows; the orders page links to it.", changeScope: ["api/src/orders", "web/src/orders"], pros: ["Handles large exports"], cons: ["New endpoint"], risks: ["Contract: GET /orders.csv returns text/csv", "Release order: api before web"], complexity: "M", affectedRepos: ["api", "web"], repoChanges: [{ repo: "api", summary: "Add the streaming CSV endpoint." }, { repo: "web", summary: "Add the export button linking to it." }], newDependencies: [] },
    { title: "Client-side CSV", approach: "Build the CSV in the browser from loaded rows.", changeScope: ["web/src/orders"], pros: ["No API change"], cons: ["Only exports loaded rows"], risks: ["Large tables"], complexity: "S", affectedRepos: ["web"], repoChanges: [{ repo: "web", summary: "Add the export button and CSV builder." }], newDependencies: [] },
    { title: "Scheduled CSV report", approach: "A nightly job in the API writes the CSV export for download.", changeScope: ["api/src/jobs"], pros: ["No UI change"], cons: ["Not on demand"], risks: ["Job runtime on large accounts"], complexity: "S", affectedRepos: ["api"], repoChanges: [{ repo: "api", summary: "Add the nightly CSV export job." }], newDependencies: ["node-cron"] },
  ],
};

/** phase 4d Task 5: a trial on the sample ticket proposes over the one sample repository */
const fakeTrialSolutions: ProposeOutput = {
  solutions: [
    { recommended: true, recommendationReason: "No new dependency, and the report module already has the rows.", title: "CSV formatter next to the report module", approach: "A pure toCsv over weeklyRows and a download handler.", changeScope: ["src/report/csv.js", "test/csv.test.js"], pros: ["Reuses weeklyRows"], cons: ["Weeks stay an open question"], risks: ["Rounding must match formatMoney"], complexity: "S", affectedRepos: ["sample"], repoChanges: [{ repo: "sample", summary: "Add toCsv and the download handler." }], newDependencies: [] },
    { title: "CSV library", approach: "Write the CSV with a CSV package.", changeScope: ["package.json", "src/report/csv.js"], pros: ["Quoting handled by the library"], cons: ["A new dependency"], risks: [], complexity: "M", affectedRepos: ["sample"], repoChanges: [{ repo: "sample", summary: "Add the package and the export." }], newDependencies: ["csv-stringify"] },
  ],
};

type DriftSnapshot = { title: string; description: string };
type DriftReq = { acceptanceCriteria: Array<{ id: string; text: string }>; discussionOutcomes: Array<{ id: string }> };

/**
 * The fake drift check: an AC edit or a changed title / description needs acknowledgement (fakeDriftNeedsAck). A JIRA
 * change that only adds comments (Task 17: a requirement-unclear comment Slack Off itself sent) is fully covered.
 */
export function fakeDrift(prompt: string): DriftResult {
  const baseline = promptSection<DriftReq>(prompt, "baselineRequirement");
  const current = promptSection<DriftReq>(prompt, "currentRequirement");
  const before = promptSection<DriftSnapshot>(prompt, "baselineSnapshot");
  const after = promptSection<DriftSnapshot>(prompt, "latestSnapshot");
  if (!baseline || !current || !before || !after) return fakeDriftNeedsAck;
  const texts = (r: DriftReq) => JSON.stringify(r.acceptanceCriteria.map((a) => [a.id.replace(/@v\d+$/, ""), a.text]));
  if (before.title !== after.title || before.description !== after.description || texts(baseline) !== texts(current)) return fakeDriftNeedsAck;
  const first = current.acceptanceCriteria[0]?.id;
  return {
    baseline: [
      ...baseline.acceptanceCriteria.map((a) => ({ id: a.id, status: "covered" as const, coveredBy: [a.id.replace(/@v\d+$/, "")], note: "" })),
      ...baseline.discussionOutcomes.map((d) => ({ id: d.id, status: "covered" as const, coveredBy: first ? [first] : [], note: "" })),
    ],
    current: current.acceptanceCriteria.map((a) => ({ id: a.id, status: "mapped" as const })),
    contradictions: [],
  };
}

/** A json section of a platform prompt (`name:` line, then a ```json block), or null. */
function promptSection<T>(prompt: string, name: string): T | null {
  const m = new RegExp(`^${name}:\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``, "m").exec(prompt);
  return m ? (JSON.parse(m[1]!) as T) : null;
}

/** Answers every checklist item, one section per affected repo, and rebuts nothing: accepts every comment it must answer. */
export function fakeDesign(prompt: string): DesignDoc {
  const items = promptSection<Array<{ id: string }>>(prompt, "checklist") ?? [];
  const repos = promptSection<Array<{ name: string }>>(prompt, "affectedRepos") ?? [];
  const must = promptSection<string[]>(prompt, "mustAnswer") ?? [];
  const mode = /^mode: (\w+)/.exec(prompt)?.[1] ?? "draft";
  return {
    contentMd: `## Overview\nExport orders as CSV (${mode}).\n\n## Cross-repo concerns\nContract: GET /orders.csv returns text/csv. Rollout: api before web.`,
    repos: repos.map((r) => ({ repo: r.name, contentMd: `### Implementation steps\n1. Change ${r.name}.\n2. Add tests in ${r.name}.` })),
    checklist: items.map((i) => ({ item: i.id, status: "considered" as const, conclusion: "Handled as in the existing code." })),
    responses: must.map((commentId) => ({ commentId, verdict: "accepted" as const, reason: "Added a row limit." })),
  };
}

/**
 * Round 1: one blocking comment (exercises a revise); later rounds: only a non-blocking remark. A ticket in
 * FAKE_SWITCHES.criticNeverSatisfied gets two blocking comments in every round (the debate escalates).
 */
export function fakeCritique(prompt: string, ticketKey?: string): Critique {
  const items = promptSection<Array<{ id: string }>>(prompt, "checklist") ?? [];
  const round = promptSection<number>(prompt, "round") ?? 1;
  const item = items.find((i) => i.id === "extremes")?.id ?? items[0]?.id ?? "extremes";
  const other = items.find((i) => i.id === "security")?.id ?? item;
  const coverage = items.map((i) => ({ item: i.id, status: "ok" as const, note: "Covered." }));
  if (ticketKey !== undefined && FAKE_SWITCHES.criticNeverSatisfied.has(ticketKey)) {
    return {
      comments: [
        { id: "C-1", checklistItem: item, repo: null, blocking: true, text: "Archiving must be resumable after a crash.", suggestion: "Archive in batches with a checkpoint." },
        { id: "C-2", checklistItem: other, repo: null, blocking: true, text: "Archived orders must stay readable by support only.", suggestion: "Restrict the archive to the support role." },
      ],
      coverage,
    };
  }
  return {
    comments:
      round === 1
        ? [{ id: "C-1", checklistItem: item, repo: null, blocking: true, text: "Large exports have no row limit.", suggestion: "Cap the export." }]
        : [{ id: "C-1", checklistItem: item, repo: null, blocking: false, text: "Consider logging export sizes.", suggestion: null }],
    coverage,
  };
}

/**
 * One development step, written only into the affected repos' worktrees (`<cwd>/<repo>` for each of `req.repos`, P-C20).
 * Step 1: api gets an export, a passing test and a forbidden infra file; web gets a button with a TODO (its pre-commit
 * hook refuses it). Step 2+: the TODO is removed and the step reports done.
 */
/** The canned solutions; phase 4f: option 4 changes only the fake `cli` repo (when it is mapped). */
export function fakeSolutionsFor(cli: boolean): ProposeOutput {
  if (!cli) return fakeSolutionsBase;
  return {
    solutions: [
      ...fakeSolutionsBase.solutions,
      { title: "Command-line tool", approach: "Ship the list as a small command-line tool.", changeScope: ["cli/bin"], pros: ["Scriptable"], cons: ["No UI"], risks: [], complexity: "S", affectedRepos: ["cli"], repoChanges: [{ repo: "cli", summary: "Add the CLI's usage notes." }], newDependencies: [] },
    ],
  };
}

export function fakeImplement(req: RunAgentRequest<unknown>): DevStepResult {
  const step = Number(/^step: (\d+)/m.exec(req.prompt)?.[1] ?? "1");
  const names = (req.repos ?? []).map((r) => r.name);
  const write = (repo: string, path: string, content: string) => {
    if (!names.includes(repo)) return;
    const file = join(req.cwd, repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  // phase 3: an acceptance fix (review_failed) or a rejected result: one fix file per affected repo, done at once (the
  // step-1 TODO file would be refused by web's pre-commit hook again)
  if (req.prompt.includes("## Independent acceptance feedback — fix these first")) {
    const n = Date.now();
    for (const repo of names) write(repo, `fixes/fix-${n}.txt`, `Fixed after the acceptance feedback (${n}).\n`);
    return { summary: "Fixed what the acceptance feedback reported.", commitMessage: "Fix the acceptance findings", done: true, testsRun: [], notes: "", needsInput: null, answerOptions: [] };
  }
  if (step === 1) {
    write("cli", "docs/usage.txt", "tool list | tool add <name>\n");
    write("api", "src/export-csv.js", "export const toCsv = (rows) => rows.map((r) => r.join(\",\")).join(\"\\n\");\n");
    write("api", "test/export-csv.test.js", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { toCsv } from "../src/export-csv.js";\ntest("csv", () => assert.equal(toCsv([["a", 1]]), "a,1"));\n');
    write("api", "infra/main.tf", "# not allowed\n");
    write("web", "src/export-button.js", "// TODO: wire the button\nexport const label = \"Export CSV\";\n");
    return { summary: "Added the CSV export and the button.", commitMessage: "Add the orders CSV export", done: false, testsRun: [], notes: "", needsInput: null, answerOptions: [] };
  }
  write("web", "src/export-button.js", "export const label = \"Export CSV\";\n");
  return { summary: "Removed the TODO the hook refused.", commitMessage: "Finish the export button", done: true, testsRun: [], notes: "", needsInput: null, answerOptions: [] };
}

/**
 * Fake jira-update (Task 12): moves the fake ticket to the prompt's target status. The first run for a ticket in
 * FAKE_SWITCHES.firstJiraWriteFails fails and changes nothing.
 */
export function fakeJiraUpdate(prompt: string): JiraUpdateResult {
  const key = /^key: (.+)$/m.exec(prompt)?.[1] ?? "";
  const target = /^target status: (.+)$/m.exec(prompt)?.[1] ?? "";
  const attempt = (writeAttempts.get(key) ?? 0) + 1;
  writeAttempts.set(key, attempt);
  if (attempt === 1 && FAKE_SWITCHES.firstJiraWriteFails.has(key)) {
    return { loginRequired: false, outcome: "failed", observedStatus: null, detail: "The status menu did not open (fake: the first write fails)." };
  }
  const t = fakeJira?.tickets[key];
  if (t !== undefined && !(t instanceof Error)) t.status = target;
  return { loginRequired: false, outcome: "changed", observedStatus: target, detail: "Clicked the status button and chose the target status." };
}

/** Fake jira-comment (phase 3 Task 10): adds the prompt's comment text to the fake ticket, so the read-back shows it. */
export function fakeJiraComment(prompt: string, text: string): JiraCommentResult {
  const key = /^key: (.+)$/m.exec(prompt)?.[1] ?? "";
  const t = fakeJira?.tickets[key];
  if (t !== undefined && !(t instanceof Error)) {
    t.comments = [...t.comments, { jiraCommentId: `fake-${t.comments.length + 1}`, author: "me", created: new Date().toISOString(), body: text }];
  }
  return { loginRequired: false, outcome: "posted", detail: "Typed the comment once and clicked Save." };
}

/** refine-ticket's requirement; a ticket in FAKE_SWITCHES.draftsComment also gets a draft comment to the reporter. */
function fakeRequirementFor(key: string | undefined): Requirement {
  if (key === undefined || !FAKE_SWITCHES.draftsComment.has(key)) return fakeRequirement;
  return { ...fakeRequirement, draftComment: "Should the CSV include cancelled orders? The ticket does not say." };
}

export async function fakeRun<T>(req: RunAgentRequest<T>): Promise<T> {
  const canned =
    req.role === "acceptance-review" ? fakeAcceptance(req as RunAgentRequest<unknown>, req.ticketKey !== undefined && FAKE_SWITCHES.acceptanceFailsOnce.has(req.ticketKey)) :
    req.role === "jira-comment" ? fakeJiraComment(req.prompt, req.policy?.typeText ?? "") :
    req.role === "jira-update" ? fakeJiraUpdate(req.prompt) :
    req.role === "implement-ticket" ? fakeImplement(req as RunAgentRequest<unknown>)
    : req.role === "propose-solutions" ? (req.purpose === "trial" ? fakeTrialSolutions : fakeSolutionsFor(FAKE_CLI))
    : req.role === "design-solution" ? fakeDesign(req.prompt)
    : req.role === "critique-design" && req.prompt.startsWith("mode: arbitrate") ? fakeArbiter(req.prompt)
    : req.role === "critique-design" ? fakeCritique(req.prompt, req.ticketKey)
    : req.prompt.startsWith("mode: browsers") ? { browsers: [{ deviceId: "fake-mac", name: "Fake Mac" }] }
    : req.prompt.startsWith("mode: check") ? fakeDrift(req.prompt)
    : fakeRequirementFor(req.ticketKey);
  return req.schema.parse(structuredClone(canned));
}

/** The arbiter (mode: arbitrate): the critic on the first disagreement, the designer on the others. */
export function fakeArbiter(prompt: string): { recommendations: Array<{ commentId: string; decision: "designer" | "critic"; note: string; reason: string }> } {
  const dis = promptSection<Array<{ commentId: string }>>(prompt, "disagreements") ?? [];
  return {
    recommendations: dis.map((d, i) => ({
      commentId: d.commentId,
      decision: i === 0 ? "critic" : "designer",
      note: "",
      reason: i === 0 ? "The critic's point holds against the requirement." : "The designer's reason covers it.",
    })),
  };
}
