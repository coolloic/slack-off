import assert from "node:assert/strict";
import { test } from "node:test";
import type { TicketState } from "@slackoff/shared";
import { defaultTab, TABS } from "./tabs.ts";

test("TABS: the ticket tabs in order, with design and development", () => {
  assert.deepEqual([...TABS], ["snapshot", "requirements", "coverage", "solutions", "design", "development", "acceptance", "delivery"]);
});

/** Phase 1's TicketsPage.tabFor (state only), kept verbatim as the reference. */
function phase1TabFor(state: TicketState): string {
  if (state === "awaiting_drift_ack") return "coverage";
  if (state === "awaiting_choice" || state === "proposing" || state === "designing") return "solutions";
  if (state === "discovered") return "snapshot";
  return "requirements";
}

test("defaultTab: phase-1 states open the same tab as before", () => {
  const phase1: TicketState[] = [
    "discovered", "refining", "refined", "awaiting_ac_review", "checking_drift", "awaiting_drift_ack", "proposing", "awaiting_choice", "blocked", "abandoned",
  ];
  for (const s of phase1) assert.equal(defaultTab(s), phase1TabFor(s), s);
});

test("defaultTab: the design states open Design & debate", () => {
  for (const s of ["designing", "awaiting_debate_ruling", "design_final"] as const) assert.equal(defaultTab(s), "design", s);
});

test("defaultTab: the snapshot-change acknowledgement opens AC coverage, development states open Development", () => {
  assert.equal(defaultTab("awaiting_snapshot_ack"), "coverage");
  for (const s of ["checking_snapshot", "developing", "dev_done"] as const) assert.equal(defaultTab(s), "development", s);
});

test("defaultTab: phase 3 — acceptance, the review acknowledgement on AC coverage, delivery", () => {
  assert.equal(defaultTab("reviewing"), "acceptance");
  assert.equal(defaultTab("awaiting_confirmation"), "acceptance");
  assert.equal(defaultTab("awaiting_review_ack"), "coverage");
  assert.equal(defaultTab("delivering"), "delivery");
  assert.equal(defaultTab("pr_opened"), "delivery");
});

test("defaultTab: a blocked ticket opens where it was blocked (delivery, acceptance), else as before", () => {
  assert.equal(defaultTab("blocked", "delivering"), "delivery");
  assert.equal(defaultTab("blocked", "reviewing"), "acceptance");
  assert.equal(defaultTab("blocked", "developing"), "requirements", "phase 2 behaviour kept");
  assert.equal(defaultTab("blocked", null), "requirements");
  assert.equal(defaultTab("blocked"), "requirements");
  assert.equal(defaultTab("developing", "delivering"), "development");
});
