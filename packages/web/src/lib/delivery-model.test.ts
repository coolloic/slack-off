import assert from "node:assert/strict";
import { test } from "node:test";
import type { DeliveryPlan, DeliveryStepRecord } from "@slackoff/shared";
import { confirmSheet, stepRows } from "./delivery-model.ts";

const plan = (over: Partial<DeliveryPlan> = {}): DeliveryPlan => ({
  actions: [
    { seq: 1, kind: "push", repo: "api", text: "Push branch slackoff/P-1-x of api to origin (github.com/o/api) — commit abc1234 from acceptance report #1 — never forced" },
    { seq: 2, kind: "pr", repo: "api", text: "Open a pull request in github.com/o/api: slackoff/P-1-x → main" },
    { seq: 3, kind: "jira_status", repo: null, text: 'Set P-1 to "Ready for Human Review" in JIRA (your Chrome)' },
  ],
  prBodies: [{ repo: "api", title: "P-1: x", body: "## Summary\n  keep   spacing\n| a | b |", isPrivate: false }],
  blockers: [],
  warnings: ["E2E was not executed: no acceptance section", "github.com/o/api is public (or its visibility is unknown): the description shows the requirement and AC text"],
  hash: "abcd",
  ...over,
});

test("confirmSheet: action texts, warnings and bodies are kept verbatim; JIRA items are tagged", () => {
  const p = plan();
  const s = confirmSheet(p, null);
  assert.deepEqual(s.items.map((i) => [i.n, i.text, i.jira]), [
    [1, p.actions[0]!.text, false],
    [2, p.actions[1]!.text, false],
    [3, p.actions[2]!.text, true],
  ]);
  assert.deepEqual(s.warnings, p.warnings);
  assert.deepEqual(s.bodies, [{ repo: "api", title: "P-1: x", body: p.prBodies[0]!.body }]);
  assert.equal(s.canConfirm, true);
});

test("confirmSheet: blockers disable confirming and an empty plan cannot be confirmed", () => {
  const s = confirmSheet(plan({ blockers: ["web: gh is not logged in to github.com — run gh auth login"] }), null);
  assert.equal(s.canConfirm, false);
  assert.deepEqual(s.blockers, ["web: gh is not logged in to github.com — run gh auth login"]);
  assert.equal(confirmSheet(plan({ actions: [] }), null).canConfirm, false);
});

test("confirmSheet: the note is required only when the server says the delivery came back for JIRA drift", () => {
  assert.equal(confirmSheet(plan(), null).needsAck, false);
  assert.equal(confirmSheet({ ...plan(), needsAck: false }, null).needsAck, false);
  assert.equal(confirmSheet({ ...plan(), needsAck: true }, null).needsAck, true);
});

test("confirmSheet: the JIRA note is passed on", () => {
  assert.equal(confirmSheet(plan(), "JIRA is not changed").jiraNote, "JIRA is not changed");
  assert.equal(confirmSheet(plan(), null).jiraNote, null);
});

const step = (id: number, kind: DeliveryStepRecord["kind"], state: DeliveryStepRecord["state"], over: Partial<DeliveryStepRecord> = {}): DeliveryStepRecord => ({
  id, deliveryId: 1, seq: id, kind, repo: null, text: `step ${id}`, state, detail: null, result: null, startedAt: null, finishedAt: null, ...over,
});

test("stepRows: only a failed JIRA step can be retried; PR rows carry their link", () => {
  const rows = stepRows({
    steps: [
      step(1, "push", "failed", { detail: "rejected" }),
      step(2, "pr", "done", { repo: "api", result: { number: 42, url: "https://github.com/example-org/api/pull/42" } }),
      step(3, "jira_status", "done"),
      step(4, "jira_comment", "failed", { detail: "Login required" }),
      step(5, "jira_comment", "skipped"),
      step(6, "jira_status", "failed", { detail: "transition unavailable" }),
    ],
  });
  assert.deepEqual(rows.map((r) => r.retry), [false, false, false, true, false, true]);
  assert.equal(rows[1]!.link, "https://github.com/example-org/api/pull/42");
  assert.equal(rows[1]!.linkLabel, "example-org/api#42");
  assert.equal(rows[0]!.link, null);
  assert.equal(rows[3]!.detail, "Login required");
  assert.equal(rows[4]!.state, "skipped");
});

test("stepRows: a result url that is not http(s) is not a link", () => {
  const rows = stepRows({ steps: [step(1, "pr", "done", { result: { number: 1, url: "javascript:alert(1)" } })] });
  assert.equal(rows[0]!.link, null);
});
