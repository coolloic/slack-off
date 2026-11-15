import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultJiraFilter, isPlatformActive, jiraStatusTone, isReadyStatus, isVisibleTicket, jiraFilterOptions, matchesJiraFilter, needsMe, needsYouCount,
} from "./jira-filter.ts";

const row = (key: string, jiraStatus: string | null, jiraOpen = true) => ({ key, jiraStatus, jiraOpen });
const rows = [
  row("A-1", "Ready for Dev"),
  row("A-2", "In Progress"),
  row("A-3", "Ready for Dev"),
  row("A-4", "Code Review"),
  row("A-5", "Ready for Dev", false),
];

test("the default JIRA-status filter is All open (author decision 2026-11-08)", () => {
  assert.equal(defaultJiraFilter(), "open");
});

test("options: All open first, then Ready-for-Dev, each other open status, then Closed/reassigned; counts exclude closed tickets", () => {
  assert.deepEqual(jiraFilterOptions(rows, "Ready for Dev", "open"), [
    { value: "open", label: "All open (4)" },
    { value: "status:Ready for Dev", label: "Ready for Dev (2)" },
    { value: "status:Code Review", label: "Code Review (1)" },
    { value: "status:In Progress", label: "In Progress (1)" },
    { value: "closed", label: "Closed/reassigned (1)" },
  ]);
  // the Ready-for-Dev option stays even when no ticket has it; closed only appears when there is one (or it is selected)
  const open = rows.filter((r) => r.jiraOpen);
  assert.deepEqual(jiraFilterOptions(open, "Ready", "open").map((o) => o.value), ["open", "status:Ready", "status:Code Review", "status:In Progress", "status:Ready for Dev"]);
  assert.ok(jiraFilterOptions(open, "Ready", "closed").some((o) => o.value === "closed"));
  assert.ok(jiraFilterOptions([], "", "status:Gone").some((o) => o.value === "status:Gone"), "the selected value is always an option");
});

test("matchesJiraFilter: status and All open hide no-longer-open tickets; Closed/reassigned shows only them", () => {
  const keys = (f: string) => rows.filter((r) => matchesJiraFilter(r, f)).map((r) => r.key);
  assert.deepEqual(keys("status:Ready for Dev"), ["A-1", "A-3"]);
  assert.deepEqual(keys("open"), ["A-1", "A-2", "A-3", "A-4"]);
  assert.deepEqual(keys("closed"), ["A-5"]);
  assert.deepEqual(keys("status:In Progress"), ["A-2"]);
});

test("isReadyStatus highlights open tickets in the Ready-for-Dev status", () => {
  assert.equal(isReadyStatus(row("A", "Ready for Dev"), "Ready for Dev"), true);
  assert.equal(isReadyStatus(row("A", "In Progress"), "Ready for Dev"), false);
  assert.equal(isReadyStatus(row("A", "Ready for Dev"), ""), false);
});

test("Needs me shows every ticket awaiting a decision whatever its JIRA status; under All the JIRA filter applies only to tickets the platform is not working on", () => {
  const t = (key: string, jiraStatus: string, state: string, jiraOpen = true) => ({ key, jiraStatus, jiraOpen, state: state as never });
  const list = [
    t("N-1", "In Progress", "awaiting_choice"),
    t("N-2", "Ready for Dev", "awaiting_ac_review"),
    t("N-3", "Ready for Dev", "awaiting_drift_ack", false), // no longer open but still needs a decision
    t("N-4", "Ready for Dev", "discovered"),
    t("N-5", "Done", "discovered", false),
    t("N-6", "Code Review", "blocked"),
  ];
  const ready = "status:Ready for Dev";
  const keys = (needsOnly: boolean, f: string) => list.filter((r) => isVisibleTicket(r, needsOnly, f)).map((r) => r.key);
  // under Needs me the default Ready-for-Dev filter (or any other) does not hide a decision
  assert.deepEqual(keys(true, ready), ["N-1", "N-2", "N-3", "N-6"]);
  assert.deepEqual(keys(true, "closed"), ["N-1", "N-2", "N-3", "N-6"]);
  assert.ok(keys(true, ready).includes("N-1"), "a needs-me ticket in In Progress is visible under Needs me");
  // under All the JIRA-status filter applies to discovered tickets only (F2-I2): decisions stay visible
  assert.deepEqual(keys(false, ready), ["N-1", "N-2", "N-3", "N-4", "N-6"]);
  assert.deepEqual(keys(false, "open"), ["N-1", "N-2", "N-3", "N-4", "N-6"]);
  // Closed/reassigned shows only tickets no longer open in JIRA (F2-R1 minor), active or not
  assert.deepEqual(keys(false, "closed"), ["N-3", "N-5"]);
});

test("F2-I2: under All a ticket in a platform working or decision state is always shown, whatever the JIRA filter or open flag", () => {
  const ready = "status:Ready for Dev";
  const working = ["refining", "refined", "checking_drift", "proposing", "designing", "design_final", "checking_snapshot", "developing", "dev_done", "blocked",
    "awaiting_ac_review", "awaiting_drift_ack", "awaiting_choice", "awaiting_debate_ruling", "awaiting_snapshot_ack"];
  for (const state of working) {
    for (const jiraOpen of [true, false]) {
      const r = { key: "W-1", jiraStatus: "In Progress", jiraOpen, state: state as never };
      assert.ok(isPlatformActive(r.state), state);
      for (const f of [ready, "open", "status:Code Review"]) assert.ok(isVisibleTicket(r, false, f), `${state} ${jiraOpen} ${f}`);
      assert.equal(isVisibleTicket(r, false, "closed"), !jiraOpen, `${state} ${jiraOpen} closed`);
    }
  }
  // the filter still applies to tickets the platform is not working on
  for (const state of ["discovered", "abandoned"]) {
    assert.equal(isPlatformActive(state as never), false);
    assert.equal(isVisibleTicket({ key: "D-1", jiraStatus: "In Progress", jiraOpen: true, state: state as never }, false, ready), false);
  }
});

test("F2-I2: a pending JIRA write puts the ticket under Needs me", () => {
  const r = { key: "J-1", jiraStatus: "Ready for Dev", jiraOpen: true, state: "developing" as never, jiraWritePending: true };
  assert.equal(needsMe(r), true);
  assert.equal(isVisibleTicket(r, true, "status:Ready for Dev"), true);
  assert.equal(needsMe({ ...r, jiraWritePending: false }), false);
  assert.equal(isVisibleTicket({ ...r, jiraWritePending: false }, true, "open"), false);
  assert.equal(needsMe({ ...r, state: "dev_done" as never, jiraWritePending: false }), true);
});

test("F2-I2: the header Needs you count adds the pending JIRA writes", () => {
  assert.equal(needsYouCount({ needsYou: 2, pendingJiraWrites: 1 }), 3);
  assert.equal(needsYouCount(undefined), 0);
});

test("F2-R1 minor: each option's count matches what that filter shows under All (active tickets included)", () => {
  const t = (key: string, jiraStatus: string, state: string, jiraOpen = true) => ({ key, jiraStatus, jiraOpen, state: state as never });
  const list = [
    t("C-1", "Ready for Dev", "discovered"),
    t("C-2", "In Progress", "developing"),
    t("C-3", "In Progress", "discovered"),
    t("C-4", "Done", "dev_done", false),
    t("C-5", "Done", "discovered", false),
  ];
  for (const o of jiraFilterOptions(list, "Ready for Dev", "status:Ready for Dev")) {
    const shown = list.filter((r) => isVisibleTicket(r, false, o.value)).length;
    assert.match(o.label, new RegExp(`\\(${shown}\\)$`), `${o.value}: ${o.label} vs ${shown}`);
  }
});

test("every JIRA status gets a badge tone: ready, in progress, ready for review, else neutral (case/space-insensitive)", () => {
  const names = { ready: "Ready for Dev", inProgress: "In Progress", review: "Ready for Human Review" };
  assert.equal(jiraStatusTone("Ready for Dev", names), "ready");
  assert.equal(jiraStatusTone(" in progress ", names), "progress");
  assert.equal(jiraStatusTone("READY FOR HUMAN REVIEW", names), "review");
  assert.equal(jiraStatusTone("Blocked by QA", names), "other");
  assert.equal(jiraStatusTone("In Progress", { ready: "Ready for Dev" }), "other");
});

test("task 16: Needs me counts awaiting_review_ack, awaiting_confirmation and a pr_opened row whose delivery step failed", () => {
  const row = (key: string, state: string, extra: object = {}) => ({ key, jiraStatus: "Ready for Dev", jiraOpen: true, state: state as never, ...extra });
  const list = [
    row("D-1", "awaiting_review_ack"),
    row("D-2", "awaiting_confirmation"),
    row("D-3", "pr_opened", { deliveryStepFailed: true }),
    row("D-4", "pr_opened", { deliveryStepFailed: false }),
    row("D-5", "pr_opened"),
    row("D-6", "delivering"),
  ];
  assert.deepEqual(list.filter(needsMe).map((r) => r.key), ["D-1", "D-2", "D-3"]);
  assert.equal(isVisibleTicket(list[2]!, true, "closed"), true);
  assert.equal(isVisibleTicket(list[3]!, true, "open"), false);
});
