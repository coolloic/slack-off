import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoney, formatWeek } from "../src/report/format.js";

test("formatMoney writes two decimals", () => {
  assert.equal(formatMoney(1250), "12.50");
  assert.equal(formatMoney(5), "0.05");
});

test("formatWeek labels the week", () => {
  assert.equal(formatWeek("2026-01-05"), "Week of 2026-01-05");
});
