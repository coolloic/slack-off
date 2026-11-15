// Phase 4d Task 4: "Restore default" asks first (models only).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfirmGate, resetConfirmation } from "./prompt-model.ts";

test("the restore-default confirmation shows the text that goes (first 300 characters) and what will happen", () => {
  const c = resetConfirmation("refine-ticket", "be terse", 3);
  assert.equal(c.preview, "be terse");
  assert.equal(c.truncated, false);
  assert.equal(c.thisWill, "save an empty version v3 for refine-ticket. Repository overrides in .slackoff/config.json are not affected.");
  assert.match(c.thisWill, /Repository overrides/);
  const long = resetConfirmation("propose-solutions", "x".repeat(301), 2);
  assert.equal(long.preview.length, 300);
  assert.equal(long.truncated, true);
});

test("ConfirmGate: nothing runs until confirm; cancel drops the request; confirm runs once", async () => {
  const calls: string[] = [];
  const gate = new ConfirmGate(async (role: string) => {
    calls.push(role);
    return true;
  });
  gate.request("refine-ticket");
  assert.equal(gate.pending, true);
  assert.deepEqual(calls, []);
  gate.cancel();
  assert.equal(gate.pending, false);
  assert.equal(await gate.confirm(), false);
  assert.deepEqual(calls, []);
  gate.request("propose-solutions");
  assert.equal(await gate.confirm(), true);
  assert.deepEqual(calls, ["propose-solutions"]);
  assert.equal(gate.pending, false);
  assert.equal(await gate.confirm(), false);
  assert.deepEqual(calls, ["propose-solutions"]);
});

// ---- final fix pass (F4D-1 M1): a failed action is not a confirmation that ran ----
import { confirmAndClose } from "./prompt-model.ts";

test("F4D-1 M1: confirm returns the action's result; a failed restore is false", async () => {
  const gate = new ConfirmGate(async (_role: string) => false);
  gate.request("refine-ticket");
  assert.equal(await gate.confirm(), false);
  assert.equal(gate.pending, false);
});

test("F4D-1 M1: confirmAndClose closes the bar after the request, and empties the editor only on success", async () => {
  for (const ok of [true, false]) {
    const order: string[] = [];
    let finish!: (v: boolean) => void;
    const gate = new ConfirmGate(
      (_role: string) =>
        new Promise<boolean>((r) => {
          order.push("sent");
          finish = (v) => {
            order.push("answered");
            r(v);
          };
        }),
    );
    gate.request("refine-ticket");
    const done = confirmAndClose(gate, () => order.push("closed"), () => order.push("emptied"));
    await Promise.resolve();
    assert.deepEqual(order, ["sent"], "the bar stays open while the request runs");
    finish(ok);
    assert.equal(await done, ok);
    assert.deepEqual(order, ok ? ["sent", "answered", "emptied", "closed"] : ["sent", "answered", "closed"]);
  }
});

// ---- Task 5: the trial run (models only) ----
import { trialAvailability, trialSummary, trialThisWill } from "./prompt-model.ts";

test("trial availability: the four read-only roles on this computer; others say why; never on a phone", () => {
  for (const r of ["refine-ticket", "propose-solutions", "design-solution", "critique-design"] as const) assert.deepEqual(trialAvailability(r, true), { enabled: true, reason: null });
  for (const r of ["implement-ticket", "acceptance-review", "jira-browser", "jira-update", "jira-comment"] as const) {
    assert.deepEqual(trialAvailability(r, true), { enabled: false, reason: "Not available for this role: it changes code, runs the app or uses JIRA" });
  }
  assert.equal(trialAvailability("refine-ticket", false).enabled, false);
});

test("the trial confirmation says what it does and that it uses quota (D-8)", () => {
  assert.equal(trialThisWill("refine-ticket"), "run refine-ticket once on the sample ticket. Uses your Claude quota (about one agent run).");
});

test("trial summaries per role", () => {
  const refine = trialSummary("refine-ticket", {
    acceptanceCriteria: [{ id: "AC-1", text: "Downloads a CSV" }, { id: "AC-2", text: "Two decimals" }],
    openQuestions: [{ kind: "conflict", text: "12 or 26 weeks?" }],
  });
  assert.deepEqual(refine, { kind: "refine", acs: ["AC-1 Downloads a CSV", "AC-2 Two decimals"], unclear: ["12 or 26 weeks?"] });
  assert.deepEqual(trialSummary("propose-solutions", { solutions: [{ title: "A", complexity: "S" }, { title: "B", complexity: "L" }] }), {
    kind: "propose", solutions: ["A (S)", "B (L)"],
  });
  const md = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const d = trialSummary("design-solution", { contentMd: md });
  assert.equal(d.kind, "design");
  assert.equal(d.kind === "design" && d.lines.length, 40);
  assert.equal(d.kind === "design" && d.more, true);
  const comments = Array.from({ length: 7 }, (_, i) => ({ id: `C-${i + 1}`, blocking: i < 2, text: `c${i + 1}` }));
  assert.deepEqual(trialSummary("critique-design", { comments }), {
    kind: "critique", blocking: 2, nonBlocking: 5, first: ["C-1 (blocking) c1", "C-2 (blocking) c2", "C-3 c3", "C-4 c4", "C-5 c5"],
  });
  // an unexpected shape never throws
  assert.deepEqual(trialSummary("propose-solutions", null), { kind: "propose", solutions: [] });
});
