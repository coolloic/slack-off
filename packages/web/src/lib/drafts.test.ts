// Phase 4e Task 5 (phase 3 Task 18 minor): a WebMCP draft waiting for its page is dropped after 24 hours.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { clearDrafts, DRAFT_TTL_MS, peekDraft, setDraft, takeDraft } from "./drafts.ts";

const HOUR = 60 * 60 * 1000;
const note = { kind: "note" as const, ticketKey: "AB-1", text: "what is meant by fast?" };

beforeEach(() => clearDrafts());

test("the TTL is 24 hours", () => {
  assert.equal(DRAFT_TTL_MS, 24 * HOUR);
});

test("a draft written 1 hour before the page mounts is applied", () => {
  const now = Date.UTC(2026, 10, 9, 12);
  setDraft(note, now - HOUR);
  assert.deepEqual(takeDraft("note", "AB-1", now), note);
  assert.equal(takeDraft("note", "AB-1", now), undefined, "applied once");
});

test("a draft written 25 hours before the page mounts is not applied, and is gone", () => {
  const now = Date.UTC(2026, 10, 9, 12);
  setDraft(note, now - 25 * HOUR);
  assert.equal(peekDraft("note", "AB-1", now), undefined);
  assert.equal(takeDraft("note", "AB-1", now), undefined);
  assert.equal(peekDraft("note", "AB-1", now - 25 * HOUR), undefined, "dropped, not merely hidden");
});

test("the default clock is the current time (what useDraft uses on mount)", () => {
  setDraft(note, Date.now() - 25 * HOUR);
  assert.equal(takeDraft("note", "AB-1"), undefined);
  setDraft(note);
  assert.deepEqual(takeDraft("note", "AB-1"), note);
});

test("a newer draft for the same ticket and kind replaces the old one and restarts its clock", () => {
  const now = Date.UTC(2026, 10, 9, 12);
  setDraft(note, now - 30 * HOUR);
  setDraft({ ...note, text: "newer" }, now - HOUR);
  assert.equal(takeDraft("note", "AB-1", now)?.text, "newer");
});
