// Phase 4d Task 6: the preference summary in Settings and on the Solutions tab (models only).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreferenceState } from "@slackoff/shared";
import { clearThisWill, canSavePreference, notEnoughText, preferenceHint, rederiveThisWill, sinceEditText, sourceText } from "./preferences-model.ts";

const state = (o: Partial<PreferenceState> = {}): PreferenceState => ({ current: null, derivedPreview: "", signalsSinceEdit: 0, counted: 0, needed: 3, ...o });
const cur = (text: string, source: "derived" | "edited" | "cleared" = "derived") => ({ version: 1, text, source, createdAt: "2026-11-09T10:00:00.000Z" });

test("hint: none without a summary, or with a cleared / empty one", () => {
  assert.equal(preferenceHint(state()), null);
  assert.equal(preferenceHint(state({ current: cur("", "cleared") })), null);
  assert.equal(preferenceHint(state({ current: cur("   ") })), null);
});

test("hint: a derived summary becomes one short line from its fixed sentences", () => {
  const text = [
    "In 3 of 3 comparable choices you picked the simplest option (lowest complexity).",
    "You avoided new dependencies in 3 of 3 comparable choices (where an option added one).",
  ].join("\n");
  assert.equal(preferenceHint(state({ current: cur(text) })), "Your past choices: you tended to pick the simplest option and avoid new dependencies.");
  const all = [
    "In 4 of 5 comparable choices you picked the most complex option (highest complexity).",
    "You chose an option that adds a new dependency in 3 of 3 comparable choices (where an option added one).",
    "You usually chose the option that changes the fewest repositories (3 of 4 comparable choices).",
    "You usually chose the option with the smallest change scope (3 of 3 comparable choices).",
  ].join("\n");
  assert.equal(
    preferenceHint(state({ current: cur(all) })),
    "Your past choices: you tended to pick the most complex option, accept new dependencies, change the fewest repositories and keep the change scope small.",
  );
});

test("hint: an edited summary shows its first line, shortened", () => {
  assert.equal(preferenceHint(state({ current: cur("Prefer small changes.\nNo queues.", "edited") })), "Your preferences: Prefer small changes.");
  const long = "x".repeat(200);
  const h = preferenceHint(state({ current: cur(long, "edited") }))!;
  assert.ok(h.length <= "Your preferences: ".length + 121);
  assert.ok(h.endsWith("…"));
});

test("not enough choices, choices since an edit, the source", () => {
  assert.equal(notEnoughText(state({ counted: 2 })), "Not enough choices yet (2 of 3)");
  assert.equal(notEnoughText(state({ counted: 3 })), null);
  assert.equal(sinceEditText(state({ current: cur("x", "edited"), signalsSinceEdit: 1 })), "1 new choice since you edited this");
  assert.equal(sinceEditText(state({ current: cur("x", "edited"), signalsSinceEdit: 4 })), "4 new choices since you edited this");
  assert.equal(sinceEditText(state({ current: cur("x", "edited"), signalsSinceEdit: 0 })), null);
  assert.equal(sinceEditText(state({ current: cur("x"), signalsSinceEdit: 2 })), null);
  assert.equal(sourceText(cur("x")), "Derived from your choices");
  assert.equal(sourceText(cur("x", "edited")), "Edited by you");
  assert.equal(sourceText(cur("", "cleared")), "Cleared");
});

test("confirmations and the editor's limit", () => {
  assert.match(clearThisWill(), /^save an empty summary/);
  assert.match(clearThisWill(), /stop counting/);
  assert.equal(rederiveThisWill(4), "replace the current summary with one derived from your choices (4 counted).");
  assert.equal(canSavePreference("Prefer small changes.", "x"), true);
  assert.equal(canSavePreference("   ", ""), false);
  assert.equal(canSavePreference("x".repeat(2001), ""), false);
  assert.equal(canSavePreference("same", "same"), false);
});

// ---- final fix pass (F4D-1 M10): the editor keeps what you typed when the summary changes ----
import { editPrefEditor, INITIAL_PREF_EDITOR, markPrefEditorClean, reloadPrefEditor, syncPrefEditor } from "./preferences-model.ts";
import { t } from "../i18n/en.ts";

test("F4D-1 M10: the first load and an untouched editor follow the summary", () => {
  let e = syncPrefEditor(INITIAL_PREF_EDITOR, "In 3 of 3 comparable choices you picked the simplest option.");
  assert.deepEqual(e, { text: "In 3 of 3 comparable choices you picked the simplest option.", base: "In 3 of 3 comparable choices you picked the simplest option.", changed: false });
  e = syncPrefEditor(e, "Newer.");
  assert.deepEqual(e, { text: "Newer.", base: "Newer.", changed: false });
  // no summary yet
  assert.deepEqual(syncPrefEditor(INITIAL_PREF_EDITOR, null), { text: "", base: "", changed: false });
});

test("F4D-1 M10: text being edited is kept when the summary changes, with a 'changed' note; Reload takes the new one", () => {
  let e = syncPrefEditor(INITIAL_PREF_EDITOR, "Old.");
  e = editPrefEditor(e, "My own words");
  e = syncPrefEditor(e, "Old.");
  assert.equal(e.changed, false, "the same text again is no change");
  e = syncPrefEditor(e, "Derived again.");
  assert.deepEqual(e, { text: "My own words", base: "Old.", changed: true });
  e = editPrefEditor(e, "My own words, more");
  assert.equal(e.changed, true);
  assert.deepEqual(reloadPrefEditor("Derived again."), { text: "Derived again.", base: "Derived again.", changed: false });
});

test("F4D-1 M10: after your own Save the summary equals your text: no note", () => {
  let e = editPrefEditor(syncPrefEditor(INITIAL_PREF_EDITOR, "Old."), "Mine.");
  e = syncPrefEditor(e, "Mine.");
  assert.deepEqual(e, { text: "Mine.", base: "Mine.", changed: false });
});

test("F4D-1 M10: after your own Clear or Re-derive the editor follows the new summary", () => {
  let e = editPrefEditor(syncPrefEditor(INITIAL_PREF_EDITOR, "Old."), "Half typed");
  e = markPrefEditorClean(e);
  assert.equal(e.text, e.base);
  e = syncPrefEditor(e, "");
  assert.deepEqual(e, { text: "", base: "", changed: false });
});

test("F4D-1 M10: the note's text", () => {
  assert.equal(t("prefs.changed"), "The summary changed — reload to see it. Your text below is kept until you do.");
  assert.equal(t("prefs.reload"), "Reload");
});
