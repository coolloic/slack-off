import assert from "node:assert/strict";
import { test } from "node:test";
import { weekStart, weeklyRows } from "../src/report/weekly.js";

test("weekStart is the Monday of the week", () => {
  assert.equal(weekStart("2026-01-07"), "2026-01-05");
  assert.equal(weekStart("2026-01-05"), "2026-01-05");
});

test("weeklyRows groups by week, newest first, limited", () => {
  const rows = weeklyRows([{ placedAt: "2026-01-05", total: 100 }, { placedAt: "2026-01-06", total: 50 }, { placedAt: "2026-01-13", total: 10 }], 1);
  assert.deepEqual(rows, [{ week: "2026-01-12", orders: 1, revenueCents: 10 }]);
});
