import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverView, incompleteNotice } from "./discover-model.ts";

type R = { created: number; returned: number; total: number; complete: boolean; loginRequired?: true; error?: string };
const done = (r: Partial<R>) => discoverView({ phase: "finished", result: { created: 0, returned: 0, total: 0, complete: true, ...r } });

test("F-I3 discoverView: idle shows nothing, running is busy, finished shows the outcome", () => {
  assert.deepEqual(discoverView({ phase: "idle" }), { busy: false, message: null, tone: "info" });
  assert.equal(discoverView({ phase: "running" }).busy, true);
  assert.equal(discoverView({ phase: "running" }).message, "Looking for open tickets assigned to you…");
  assert.deepEqual(done({ created: 2, returned: 3, total: 3 }), { busy: false, message: "Found 2 new · 3 open in total", tone: "success" });
  assert.deepEqual(done({ created: 0, returned: 3, total: 3 }), { busy: false, message: "Found 0 new · 3 open in total", tone: "info" });
  assert.equal(done({ created: 1, returned: 100, total: 140, complete: false }).message, "Found 1 new · 140 open in total");
  assert.deepEqual(done({}), { busy: false, message: "No open tickets assigned to you", tone: "info" });
  assert.equal(done({ loginRequired: true, error: "x", complete: false }).tone, "error");
  assert.match(done({ loginRequired: true, error: "x", complete: false }).message!, /sign in/i);
  assert.deepEqual(done({ error: "chrome went away", complete: false }), { busy: false, message: "Fetching failed: chrome went away", tone: "error" });
});

test("incompleteNotice: only when the last discovery stopped before reading every open ticket", () => {
  assert.equal(incompleteNotice(null), null);
  assert.equal(incompleteNotice({ finishedAt: "x", returned: 3, total: 3, complete: true }), null);
  assert.equal(incompleteNotice({ finishedAt: "x", returned: 100, total: 140, complete: false }), "Showing 100 of 140 open tickets — raise the limit in Settings");
});
