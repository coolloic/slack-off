import assert from "node:assert/strict";
import { test } from "node:test";
import type { AcceptanceReport, AcEvaluation, ReviewReportRecord, ReviewSeriesRecord } from "@slackoff/shared";
import { acCards, attemptTimeline, logModel, projectTests, reviewActions, reviewRecommendation, verdictBanner, visibleLines } from "./review-model.ts";

const ac = (over: Partial<AcEvaluation> = {}): AcEvaluation => ({
  acId: "AC-1",
  text: "A user can pay",
  verdict: "pass",
  agentVerdict: "pass",
  flows: [
    { kind: "happy", title: "pay", steps: ["open", "pay"], expected: "paid", actual: "paid", tests: ["a › pay"], evidenceKeys: ["AC-1/1"], testsPassed: true },
    { kind: "error", title: "empty", steps: ["pay empty"], expected: "error", actual: "no error", tests: ["a › empty"], evidenceKeys: ["AC-1/2"], testsPassed: false },
  ],
  mismatch: null,
  ...over,
});

const report = (over: Partial<AcceptanceReport> = {}): AcceptanceReport => ({
  verdict: "passed",
  notExecutedReason: null,
  summary: "ok",
  targets: [],
  acs: [ac()],
  specRun: null,
  projectE2e: [],
  isolation: { ok: true, checks: [], excluded: [] },
  commits: [],
  ...over,
});

const rec = (over: Partial<ReviewReportRecord> = {}): ReviewReportRecord => ({
  id: 1,
  seriesId: 1,
  attempt: 2,
  verdict: "passed",
  report: report(),
  developerNote: null,
  snapshotId: 1,
  createdAt: "2026-11-07T10:00:00Z",
  ...over,
});

test("verdictBanner: passed, failed and not executed with their tones", () => {
  assert.deepEqual(verdictBanner(rec(), 3), { tone: "done", title: "Passed · attempt 2 of 3", detail: null });
  const failed = verdictBanner(rec({ verdict: "failed", attempt: 3 }), 3);
  assert.equal(failed.tone, "blocked");
  assert.equal(failed.title, "Failed · attempt 3 of 3");
  const ne = verdictBanner(rec({ verdict: "not_executed", report: report({ verdict: "not_executed", notExecutedReason: "no acceptance section in .slackoff/config.json" }) }), 3);
  assert.equal(ne.tone, "decision");
  assert.equal(ne.title, "E2E not executed");
  assert.match(ne.detail ?? "", /no acceptance section in \.slackoff\/config\.json/);
  assert.equal(verdictBanner(null, 3).tone, "muted");
});

const ev = (id: number, acId: string, kind: string, refKey = `${acId}/${id}`) => ({ id, refKey, acId, kind, caption: `c${id}` });

test("acCards: flows, screenshots and logs apart, a mismatch makes the AC fail", () => {
  const r = report({ acs: [ac(), ac({ acId: "AC-2", text: "B", verdict: "pass", mismatch: "Platform re-run disagreed: test 'x' failed" })] });
  const cards = acCards(r, [ev(1, "AC-1", "screenshot"), ev(2, "AC-1", "http"), ev(3, "AC-1", "log"), ev(4, "AC-2", "screenshot")]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.verdict, "pass");
  assert.deepEqual(cards[0]!.shots, [{ id: 1, caption: "c1" }]);
  assert.deepEqual(cards[0]!.logs, [{ id: 2, caption: "c2" }, { id: 3, caption: "c3" }]);
  assert.deepEqual(cards[0]!.flows.map((f) => [f.kind, f.ok]), [["happy", true], ["error", false]]);
  assert.equal(cards[0]!.flows[0]!.expected, "paid");
  assert.equal(cards[1]!.verdict, "fail");
  assert.match(cards[1]!.mismatch ?? "", /Platform re-run disagreed/);
  assert.deepEqual(cards[1]!.shots, [{ id: 4, caption: "c4" }]);
});

test("attemptTimeline: groups attempts by round with the failed ACs and the decision", () => {
  const series: ReviewSeriesRecord[] = [
    { id: 1, startedBy: "handoff", note: null, decidedBy: "local", createdAt: "t" },
    { id: 2, startedBy: "rejected", note: "n", decidedBy: "local", createdAt: "t" },
  ];
  const failedReport = report({ verdict: "failed", acs: [ac({ acId: "AC-2", verdict: "fail" }), ac({ acId: "AC-3" })] });
  const tl = attemptTimeline(series, [
    { id: 2, seriesId: 1, attempt: 2, verdict: "passed", decision: "rejected" },
    { id: 1, seriesId: 1, attempt: 1, verdict: "failed", decision: null, report: failedReport },
    { id: 3, seriesId: 2, attempt: 1, verdict: "passed", decision: null },
  ]);
  assert.deepEqual(tl.map((g) => [g.seriesId, g.startedBy]), [[1, "handoff"], [2, "rejected"]]);
  assert.deepEqual(tl[0]!.items, [
    { attempt: 1, verdict: "failed", failedAcs: ["AC-2"], decision: null },
    { attempt: 2, verdict: "passed", failedAcs: [], decision: "rejected" },
  ]);
  assert.equal(tl[1]!.items.length, 1);
});

test("reviewActions: decisions only while awaiting confirmation; re-review is disabled at the attempt cap", () => {
  const wait = { kind: "await_decision", reportId: 1 } as const;
  const a = reviewActions("awaiting_confirmation", wait, 3, 2);
  assert.equal(a.confirm, true);
  assert.equal(a.reject, true);
  assert.deepEqual(a.reReview, { enabled: true, reason: null });
  const cap = reviewActions("awaiting_confirmation", wait, 3, 3);
  assert.equal(cap.reReview.enabled, false);
  assert.ok(cap.reReview.reason && cap.reReview.reason.length > 0);
  assert.equal(cap.confirm, true);
  const running = reviewActions("reviewing", null, 3, 1);
  assert.equal(running.confirm, false);
  assert.equal(running.reject, false);
  assert.equal(running.reReview.enabled, false);
  assert.equal(reviewActions("awaiting_confirmation", { kind: "fix", reportId: 1 }, 3, 1).confirm, false);
});

test("attemptTimeline: failed AC ids can come with the report summary (no full report needed)", () => {
  const series: ReviewSeriesRecord[] = [{ id: 1, startedBy: "handoff", note: null, decidedBy: "local", createdAt: "t" }];
  const tl = attemptTimeline(series, [{ id: 1, seriesId: 1, attempt: 1, verdict: "failed", decision: null, failedAcs: ["AC-4"] }]);
  assert.deepEqual(tl[0]!.items[0]!.failedAcs, ["AC-4"]);
});

// ---------------------------------------------------------------- phase 4f (Task 5): command and output evidence

test("acCards: log evidence (a case transcript) is also a command block", () => {
  const cards = acCards(report(), [ev(1, "AC-1", "screenshot"), ev(2, "AC-1", "http"), ev(3, "AC-1", "log")]);
  assert.deepEqual(cards[0]!.commands, [{ id: 3, caption: "c3" }]);
});

test("logModel: the command line is the title, the rest plain lines; a truncation mark; more than 20 lines start folded", () => {
  const short = "$ ./bin/tool.mjs add '<img src=x onerror=alert(1)>'\n(no stdin)\n--- stdout ---\nadded <img src=x onerror=alert(1)>\n--- stderr ---\nexit 0\n";
  const m = logModel(short);
  assert.equal(m.kind, "log");
  assert.equal(m.title, "$ ./bin/tool.mjs add '<img src=x onerror=alert(1)>'");
  assert.deepEqual(m.lines, ["(no stdin)", "--- stdout ---", "added <img src=x onerror=alert(1)>", "--- stderr ---", "exit 0"]);
  assert.equal(m.truncated, false);
  assert.equal(m.folded, false);
  assert.deepEqual(visibleLines(m, false), m.lines);
  const long = `$ ./bin/tool.mjs big\n(no stdin)\n--- stdout (last 64 KB) ---\n${Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")}\n--- stderr (last 64 KB) ---\nexit 0\n`;
  const l = logModel(long);
  assert.equal(l.truncated, true);
  assert.equal(l.folded, true);
  assert.equal(visibleLines(l, false).length, 20);
  assert.equal(visibleLines(l, true).length, l.lines.length);
  // a text that is not a transcript: no command title
  assert.equal(logModel("plain text\nmore").title, null);
});

test("4F-8 I-2: logModel takes a library example's code out of the lines (its own block); the output lines stay", () => {
  const text = [
    "$ node examples/slug.mjs",
    "--- example examples/slug.mjs ---",
    "| import { slugify } from 'acceptance-lib';",
    "| console.log(slugify(' Hello World '));",
    "| ",
    "--- end of example ---",
    "(no stdin)",
    "--- stdout ---",
    "hello-world",
    "--- stderr ---",
    "exit 0",
    "",
  ].join("\n");
  const m = logModel(text);
  assert.equal(m.title, "$ node examples/slug.mjs");
  assert.deepEqual(m.example, { name: "examples/slug.mjs", lines: ["import { slugify } from 'acceptance-lib';", "console.log(slugify(' Hello World '));", ""], cut: false });
  assert.deepEqual(m.lines, ["(no stdin)", "--- stdout ---", "hello-world", "--- stderr ---", "exit 0"]);
  const cut = logModel("$ node examples/big.mjs\n--- example examples/big.mjs (first 8 KB) ---\n| x\n--- end of example ---\nexit 0\n");
  assert.equal(cut.example?.cut, true);
  assert.equal(cut.example?.name, "examples/big.mjs");
  // a CLI transcript has no example; output that merely looks like one is not taken (it is not right after the command)
  assert.equal(logModel("$ ./bin/tool.mjs list\n(no stdin)\n--- stdout ---\n\\--- example examples/x.mjs ---\nexit 0\n").example, null);
});

test("4F-8 I-3: projectTests — the project's own test command per run: passed, failed with its exit, or timed out", () => {
  assert.deepEqual(projectTests([]), []);
  assert.deepEqual(
    projectTests([
      { command: "node e2e.mjs", exitCode: 0, timedOut: false, outputTail: "ok" },
      { command: "pnpm e2e", exitCode: 1, timedOut: false, outputTail: "1 failed" },
      { command: "make check", exitCode: null, timedOut: true, outputTail: "" },
    ]),
    [
      { command: "node e2e.mjs", ok: true, status: "passed", tail: "ok" },
      { command: "pnpm e2e", ok: false, status: "failed (exit 1)", tail: "1 failed" },
      { command: "make check", ok: false, status: "timed out", tail: "" },
    ],
  );
});

test("reviewRecommendation: passed and agreed → confirm; a failure or a disagreement → reject naming the ACs; not executed → confirm after your own check", () => {
  const ok = reviewRecommendation(rec());
  assert.equal(ok.action, "confirm");
  assert.equal(ok.reason, "Every acceptance criterion passed, and Slack Off's own re-run agreed.");
  const failed = reviewRecommendation(rec({ verdict: "failed", report: report({ verdict: "failed", acs: [ac({ verdict: "fail" }), ac({ acId: "AC-2" })] }) }));
  assert.equal(failed.action, "reject");
  assert.equal(failed.reason, "AC-1 failed — send it back to development.");
  assert.deepEqual(failed.options.map((o) => [o.label, o.recommended]), [["Fix the failing ACs", true], ["Re-run: looks flaky", false]]);
  assert.equal(failed.options[0]!.text, "AC-1 failed in acceptance — fix it, then hand off again.");
  const disagreed = reviewRecommendation(rec({ report: report({ acs: [ac({ mismatch: "platform re-run failed 'rejects empty cart'" })] }) }));
  assert.equal(disagreed.action, "reject");
  assert.equal(disagreed.reason, "AC-1 failed — send it back to development.");
  const skipped = reviewRecommendation(rec({ verdict: "not_executed", report: report({ verdict: "not_executed", notExecutedReason: "no acceptance section in .slackoff/config.json" }) }));
  assert.equal(skipped.action, "confirm");
  assert.equal(skipped.reason, "E2E did not run (no acceptance section in .slackoff/config.json): confirm only after checking the change yourself.");
  assert.equal(reviewRecommendation(null), null);
});
