// Task 12: the pull request description, title, related-PR links and the JIRA delivery comment (pure functions).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AcceptanceReport, Requirement, ReviewReportRecord } from "@slackoff/shared";
import { deliveryCommentText, neutralize, prBody, prTitle, tableCell, withLinks } from "../src/delivery/pr-body.ts";

const requirement: Requirement = {
  background: "Shop owners export orders. ping @carol",
  functional: [{ id: "FR-1", text: "export orders as CSV" }],
  acceptanceCriteria: [
    { id: "AC-1", text: "The export downloads", verifiable: true, source: { type: "description", ref: "description", quote: "q" } },
    { id: "AC-2", text: "An empty shop exports a header row", verifiable: true, source: { type: "developer", reason: "r" } },
  ],
  discussionOutcomes: [],
  openQuestions: [],
  draftComment: null,
};

const acReport = (n: number, verdict: AcceptanceReport["verdict"] = "passed", reason: string | null = null): AcceptanceReport => ({
  verdict,
  notExecutedReason: reason,
  summary: "s",
  targets: [],
  acs: Array.from({ length: n }, (_, i) => ({
    acId: `AC-${i + 1}`,
    text: `criterion ${i + 1} | with a pipe\nand a line`,
    verdict: verdict === "not_executed" ? ("not_tested" as const) : ("pass" as const),
    agentVerdict: verdict === "not_executed" ? null : ("pass" as const),
    flows: verdict === "not_executed"
      ? []
      : [{ kind: "happy" as const, title: `flow ${i + 1}`, steps: ["open"], expected: "ok", actual: "ok", tests: ["t"], evidenceKeys: [`AC-${i + 1}/1`], testsPassed: true }],
    mismatch: null,
  })),
  specRun: null,
  projectE2e: [],
  isolation: { ok: true, checks: [], excluded: [] },
  commits: [{ repo: "api", sha: "a".repeat(40) }],
});

const record = (report: AcceptanceReport): ReviewReportRecord => ({
  id: 7, seriesId: 1, attempt: 2, verdict: report.verdict, report, developerNote: null, snapshotId: 1, createdAt: "2026-11-07T10:00:00.000Z",
});

const body = (report: AcceptanceReport, related: { repo: string; url: string }[] = []) =>
  prBody({
    key: "FAKE-1",
    title: "Export orders",
    jiraUrl: "https://your-company.atlassian.net/browse/FAKE-1",
    requirement,
    solution: { title: "Stream the CSV", approach: "Write rows as they are read. closes #5" },
    report: record(report),
    maxAttempts: 3,
    repo: "api",
    related,
  });

test("neutralize: mentions and closing keywords are put in backticks; HTML comments go, tags are escaped", () => {
  const out = neutralize("ping @alice and fixes #12, closes example-org/api#3");
  assert.ok(!/(^|[^`])@alice/.test(out), out);
  assert.ok(out.includes("`@alice`"), out);
  assert.ok(!out.includes("fixes #12"), out);
  assert.ok(!out.includes("closes example-org/api#3"), out);
  assert.ok(out.includes("`#12`") && out.includes("`example-org/api#3`"), out);
  const html = neutralize("a <!-- slackoff:links --> b <details><summary>x</summary></details> c");
  assert.ok(!html.includes("<!--") && !html.includes("<details>"), html);
  assert.ok(html.includes("&lt;details&gt;"), html);
  // an email address is not a mention; a backtick in the text cannot open a code span that frees a mention
  assert.equal(neutralize("mail me at bob@example.com"), "mail me at bob@example.com");
  assert.ok(!/(^|[^`])@dave/.test(neutralize("` @dave").replace(/`@dave`/g, "")), neutralize("` @dave"));
  assert.equal(neutralize("Resolved: #4").includes("Resolved: #4"), false);
});

test("tableCell: neutralized, pipes escaped, line breaks become spaces, at most 200 characters", () => {
  assert.equal(tableCell("a | b\nc"), "a \\| b c");
  const long = tableCell("x".repeat(500));
  assert.ok(long.length <= 200, String(long.length));
  assert.ok(tableCell("hi @bob").includes("`@bob`"));
});

test("prBody: summary, chosen solution, acceptance with attempt n of max, AC table, evidence note and an empty links section", () => {
  const b = body(acReport(2));
  for (const s of ["## Summary", "Shop owners export orders.", "FR-1", "export orders as CSV", "## Chosen solution", "Stream the CSV", "## Acceptance", "passed", "2 of 3", "2026-11-07", "| AC | Result | Flows tested |"])
    assert.ok(b.includes(s), s);
  assert.ok(b.includes("Screenshots and evidence are in Slack Off (ticket FAKE-1, acceptance report #7)."), b);
  assert.ok(b.includes("`@carol`") && !/(^|[^`])@carol/.test(b.replace(/`@carol`/g, "")), "background is neutralized");
  assert.ok(!b.includes("closes #5"), "solution text is neutralized");
  assert.match(b, /<!-- slackoff:links -->\s*<!-- \/slackoff:links -->\s*$/);
  // a pipe in an AC's text does not break the table
  assert.ok(b.includes("criterion 1 \\| with a pipe and a line"), b);
});

test("prBody: no screenshot links, images or Slack Off URLs", () => {
  const b = body(acReport(3));
  for (const bad of [".png", "![", "/api/tickets/", "http://127.0.0.1", "localhost"]) assert.ok(!b.includes(bad), bad);
});

test("prBody: a not_executed report states its reason", () => {
  const b = body(acReport(2, "not_executed", "port 3000 is already in use"));
  assert.ok(b.includes("not executed"), b);
  assert.ok(b.includes("port 3000 is already in use"), b);
});

test("prBody: 1000 ACs stay under 60000 characters and say how many rows were left out", () => {
  const b = body(acReport(1000));
  assert.ok(b.length <= 60_000, String(b.length));
  // M4: room is kept for the related-PR links added later
  const links = Array.from({ length: 10 }, (_, i) => ({ repo: `repository-number-${i}`, url: `https://github.com/example-org/repository-number-${i}/pull/${100000 + i}` }));
  assert.ok(withLinks(b, links).length <= 60_000, String(withLinks(b, links).length));
  assert.match(b, /\(\d+ more ACs — see Slack Off\)/);
  assert.match(b, /<!-- slackoff:links -->/);
});

test("prBody with related PRs lists them inside the marked section", () => {
  const b = body(acReport(1), [{ repo: "web", url: "https://github.com/example-org/web/pull/9" }]);
  const section = b.slice(b.indexOf("<!-- slackoff:links -->"));
  assert.ok(section.includes("Related pull requests"));
  assert.ok(section.includes("https://github.com/example-org/web/pull/9"));
});

test("prTitle (M3): key and title, control characters stripped, at most 256 characters, no markdown escaping", () => {
  assert.equal(prTitle("FAKE-1", "Export orders"), "FAKE-1: Export orders");
  assert.ok(prTitle("FAKE-1", "y".repeat(400)).length <= 256);
  // a title is plain text on GitHub: nothing is escaped or put in backticks
  assert.equal(prTitle("FAKE-1", "fix #3 for @eve"), "FAKE-1: fix #3 for @eve");
  assert.equal(prTitle("FAKE-1", "a <b> & \u0007c\nd"), "FAKE-1: a <b> & c d");
});

test("neutralize (T12-4): images, link targets, loopback / Tailscale URLs and issue-URL closing are defanged", () => {
  const img = neutralize("look ![shot](https://example.com/a.png) and [click](https://example.com/x)");
  assert.ok(!img.includes("!["), img);
  assert.ok(!img.includes("]("), img);
  const loop = neutralize("see http://127.0.0.1:4317/api/tickets and http://localhost:5173/ and http://[::1]:4317/ and https://my-mac.tail1234.ts.net/x");
  for (const bad of ["http://127.0.0.1", "http://localhost", "http://[::1]", "https://my-mac.tail1234.ts.net"]) assert.ok(!loop.includes(bad), `${bad} in ${loop}`);
  // R-M2: the tailnet range, 0.0.0.0, any bracketed IPv6, the decimal IPv4 form, and Slack Off's own ports anywhere
  const more = neutralize(
    "a http://100.101.102.103:8080/x b http://0.0.0.0:3000/ c http://[fe80::1]/ d http://2130706433/ e https://example.com:4317/api f http://dev-box:5173/ g https://github.com/example-org/api",
  );
  for (const bad of ["http://100.101.102.103", "http://0.0.0.0", "http://[fe80::1]", "http://2130706433", "https://example.com:4317", "http://dev-box:5173"])
    assert.ok(!more.includes(bad), `${bad} in ${more}`);
  assert.ok(more.includes("https://github.com/example-org/api"), "an ordinary URL stays a link");
  const close = neutralize("fixes https://github.com/example-org/api/issues/3 and closes https://github.com/example-org/api/pull/4");
  assert.ok(close.includes("fixes `https://github.com/example-org/api/issues/3`"), close);
  assert.ok(close.includes("closes `https://github.com/example-org/api/pull/4`"), close);
});

test("withLinks: replaces only the marked section; appends one when a human removed it", () => {
  const original = "Human intro paragraph.\n\n<!-- slackoff:links -->\n<!-- /slackoff:links -->\n\nHuman footer.";
  const out = withLinks(original, [{ repo: "web", url: "https://github.com/example-org/web/pull/9" }]);
  assert.ok(out.startsWith("Human intro paragraph.\n\n<!-- slackoff:links -->"), out);
  assert.ok(out.endsWith("<!-- /slackoff:links -->\n\nHuman footer."), out);
  assert.ok(out.includes("https://github.com/example-org/web/pull/9"));
  // idempotent: applying it again changes nothing
  assert.equal(withLinks(out, [{ repo: "web", url: "https://github.com/example-org/web/pull/9" }]), out);
  const removed = withLinks("A human rewrote everything.", [{ repo: "api", url: "https://github.com/example-org/api/pull/1" }]);
  assert.ok(removed.startsWith("A human rewrote everything."));
  assert.match(removed, /<!-- slackoff:links -->[\s\S]*api\/pull\/1[\s\S]*<!-- \/slackoff:links -->\s*$/);
});

test("deliveryCommentText: the heading and one line per PR, no list markers or formatting", () => {
  const t = deliveryCommentText([
    { repo: "api", url: "https://github.com/example-org/api/pull/1" },
    { repo: "web", url: "https://github.com/example-org/web/pull/2" },
  ]);
  assert.ok(t.startsWith("Pull requests ready for review:"));
  assert.ok(t.includes("api pull request: https://github.com/example-org/api/pull/1"));
  assert.ok(t.includes("web pull request: https://github.com/example-org/web/pull/2"));
  assert.ok(!/^\s*- /m.test(t), t);
  assert.ok(!/[*_#`]/.test(t.replace(/https:\/\/\S+/g, "")), t);
});
