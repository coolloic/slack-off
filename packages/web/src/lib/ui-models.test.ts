import assert from "node:assert/strict";
import { test } from "node:test";
import type { DriftResult, Requirement } from "@slackoff/shared";
import { t } from "../i18n/en.ts";
import { ackItems, ackPanelMode, contradictionRows } from "./coverage-model.ts";
import { barCaption, hintPlacement } from "./decision-model.ts";
import { editAc, isDeveloperAdded } from "./requirements-model.ts";
import { shouldScrollActivePill } from "./settings-model.ts";
import { incompleteLabel, jiraImage, pickAfterNavigation, selectedSnapshotId } from "./snapshot-model.ts";
import { agentName } from "./agent-name.ts";

type Ac = Requirement["acceptanceCriteria"][number];

test("editAc (phone and desktop) keeps the AC's original source, id and verifiable flag", () => {
  const ac: Ac = { id: "AC-2", text: "old", verifiable: false, source: { type: "comment", ref: "10001", quote: "the quote" } };
  const edited = editAc(ac, "  new text  ");
  assert.deepEqual(edited, { id: "AC-2", text: "new text", verifiable: false, source: { type: "comment", ref: "10001", quote: "the quote" } });
  assert.equal(edited.source, ac.source);
  assert.deepEqual(editAc(ac, "   "), ac, "blank text keeps the old text");
  assert.equal(isDeveloperAdded(edited), false, "an edited sourced AC is not 'added by you'");
  assert.equal(isDeveloperAdded({ ...ac, source: { type: "developer", reason: "PM said so" } }), true);
});

const drift: DriftResult = {
  baseline: [
    { id: "AC-1@v1", status: "covered", coveredBy: ["AC-1"], note: "" },
    { id: "AC-2@v1", status: "missing", coveredBy: [], note: "dropped" },
  ],
  current: [
    { id: "AC-1", status: "mapped" },
    { id: "AC-3", status: "new_unsourced" },
  ],
  contradictions: [{ acId: "AC-1", quote: "must be free", explanation: "AC-1 charges a fee" }],
};

test("coverage: the ack item list includes contradictions (spec §9.9: an ack trigger)", () => {
  const items = ackItems(drift);
  assert.equal(items.length, 3);
  assert.ok(items.some((i) => i.includes("AC-1") && i.includes("AC-1 charges a fee")));
  assert.ok(items[0]!.startsWith("AC-2@v1"));
});

test("coverage: contradiction rows name the current AC, its text and the baseline quote", () => {
  const rows = contradictionRows(drift, new Map([["AC-1", { text: "costs 1 EUR" }]]));
  assert.deepEqual(rows, [{ acId: "AC-1", acText: "costs 1 EUR", quote: "must be free", explanation: "AC-1 charges a fee" }]);
  assert.equal(contradictionRows(drift, new Map())[0]!.acText, null);
});

test("decision bar: an error shows as an alert regardless of the disabled state; state-changing secondaries get a caption", () => {
  const primary = { thisWill: "lock it." };
  assert.deepEqual(barCaption(primary, undefined, "boom"), { error: "boom", lines: [] });
  assert.deepEqual(barCaption(primary, { label: "Back", thisWill: "go back." }, undefined), {
    error: null,
    lines: [{ label: null, thisWill: "lock it." }, { label: "Back", thisWill: "go back." }],
  });
  assert.deepEqual(barCaption(primary, { label: "← Requirements" }, undefined).lines, [{ label: null, thisWill: "lock it." }], "navigation-only secondary: no caption");
  assert.deepEqual(barCaption(primary, { label: "Back", thisWill: "go back." }, "boom"), { error: "boom", lines: [{ label: "Back", thisWill: "go back." }] });
});

test("settings: the active pill scrolls into view only when it changes and only below lg", () => {
  assert.equal(shouldScrollActivePill("jira", "jira", true), false);
  assert.equal(shouldScrollActivePill(undefined, "jira", true), false);
  assert.equal(shouldScrollActivePill("prompts", "jira", true), true);
  assert.equal(shouldScrollActivePill("prompts", "jira", false), false);
});

test("snapshot: clicking the same source link again drops a manual pick and shows the linked snapshot", () => {
  const ids = [3, 2, 1];
  let pick = { navKey: "a", picked: null as number | null };
  pick = { ...pick, picked: 1 }; // user picks v1 by hand
  assert.equal(selectedSnapshotId(pick.picked, "2", ids), 1);
  pick = pickAfterNavigation(pick, "a"); // a re-render, no navigation
  assert.equal(pick.picked, 1);
  pick = pickAfterNavigation(pick, "b"); // same ?snap=2 link clicked again: new location.key
  assert.equal(pick.picked, null);
  assert.equal(selectedSnapshotId(pick.picked, "2", ids), 2);
  assert.equal(selectedSnapshotId(null, "99", ids), 3, "unknown ?snap= falls back to the latest");
  assert.equal(selectedSnapshotId(null, null, []), null);
});

test("i18n: counts are singular/plural aware", () => {
  assert.equal(t("cov.itemsTotal", { n: 1 }), "1 item total");
  assert.equal(t("cov.itemsTotal", { n: 2 }), "2 items total");
  assert.equal(t("tickets.selected", { n: 1 }), "1 ticket selected");
  assert.equal(t("tickets.selected", { n: 0 }), "0 tickets selected");
  assert.equal(t("tickets.refineThisWill", { n: 1 }), "start the refine agent for 1 ticket (read-only on JIRA).");
  assert.equal(t("cov.attention", { n: 1 }), "1 item needs attention before solutions are proposed:");
  assert.equal(t("cov.attention", { n: 3 }), "3 items need attention before solutions are proposed:");
  assert.equal(t("req.summary.ac", { n: 1 }), "1 acceptance criterion");
  assert.equal(t("tickets.showing", { shown: 1, total: 1 }), "Showing 1 of 1 ticket");
});

test("F-I4 ackPanelMode: proceed in awaiting_drift_ack, review-only after Back to editing, nothing otherwise", () => {
  const drift = { requirementId: 7, needsAck: true, acknowledged: false };
  assert.equal(ackPanelMode("awaiting_drift_ack", drift, 7), "proceed");
  assert.equal(ackPanelMode("awaiting_ac_review", drift, 7), "review");
  assert.equal(ackPanelMode("awaiting_ac_review", drift, 8), null, "drift of an older requirement");
  assert.equal(ackPanelMode("awaiting_ac_review", { ...drift, acknowledged: true }, 7), null);
  assert.equal(ackPanelMode("awaiting_ac_review", { ...drift, needsAck: false }, 7), null);
  assert.equal(ackPanelMode("awaiting_ac_review", null, 7), null);
  assert.equal(ackPanelMode("proposing", drift, 7), null);
});

test("ackPanelMode: the JIRA ticket changed before development → snapshot (ack starts development, or re-plan)", () => {
  const drift = { requirementId: 7, needsAck: true, acknowledged: false };
  assert.equal(ackPanelMode("awaiting_snapshot_ack", drift, 9), "snapshot", "the chosen requirement may be older than the latest");
  assert.equal(ackPanelMode("awaiting_snapshot_ack", { ...drift, acknowledged: true }, 7), null);
  assert.equal(ackPanelMode("developing", drift, 7), null);
});

test("ackPanelMode: the JIRA ticket changed before acceptance → acceptance (ack starts it, or re-plan)", () => {
  const drift = { requirementId: 7, needsAck: true, acknowledged: false };
  assert.equal(ackPanelMode("awaiting_review_ack", drift, 9), "acceptance");
  assert.equal(ackPanelMode("awaiting_review_ack", { ...drift, acknowledged: true }, 7), null);
  assert.equal(ackPanelMode("awaiting_review_ack", null, 7), null);
  assert.equal(ackPanelMode("reviewing", drift, 7), null);
});

test("F-I7 incompleteLabel: null when complete, singular/plural otherwise", () => {
  assert.equal(incompleteLabel(null), null);
  assert.equal(incompleteLabel(undefined), null);
  assert.equal(incompleteLabel(1), "Incomplete: 1 older comment was not loaded — check JIRA");
  assert.equal(incompleteLabel(4), "Incomplete: 4 older comments were not loaded — check JIRA");
  // 0: JIRA did not show how many
  assert.equal(incompleteLabel(0), "Incomplete: some older comments were not loaded — check JIRA");
});

test("hintPlacement: a full hint (JIRA write note) is never clamped in the bar and not repeated in the desktop card", () => {
  const full = hintPlacement("full");
  assert.equal(full.inCard, false);
  assert.doesNotMatch(full.barClass, /line-clamp/);
  const short = hintPlacement("short");
  assert.equal(short.inCard, true);
  assert.match(short.barClass, /line-clamp-2/);
});

test("jiraImage: a metadata-only image with the configured JIRA's attachment address shows its thumbnail and opens the full image", () => {
  const base = "https://jira.example.com";
  const a = { localPath: null, mime: "image/png", url: `${base}/rest/api/3/attachment/content/316935` };
  assert.deepEqual(jiraImage(a, base), {
    thumbnail: `${base}/rest/api/3/attachment/thumbnail/316935`,
    full: `${base}/rest/api/3/attachment/content/316935`,
  });
  // held locally (API mode): Slack Off's own copy is used instead
  assert.equal(jiraImage({ ...a, localPath: "/x" }, base), null);
  // not an image, no address, another host, or no JIRA configured
  assert.equal(jiraImage({ ...a, mime: "application/pdf" }, base), null);
  assert.equal(jiraImage({ ...a, url: "" }, base), null);
  assert.equal(jiraImage({ ...a, url: null }, base), null);
  assert.equal(jiraImage({ ...a, url: "https://evil.example/rest/api/3/attachment/content/1" }, base), null);
  assert.equal(jiraImage(a, undefined), null);
});

test("agentName: a readable name for each agent role; an unknown role shows as it is", () => {
  assert.equal(agentName("propose-solutions"), "Solutions agent");
  assert.equal(agentName("jira-browser"), "JIRA reader");
  assert.equal(agentName("implement-ticket"), "Developer agent");
  assert.equal(agentName("something-new"), "something-new");
});
