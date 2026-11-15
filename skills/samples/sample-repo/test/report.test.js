import assert from "node:assert/strict";
import { test } from "node:test";
import { COLUMNS, reportTable } from "../src/report/index.js";

test("reportTable has the page's columns and formatted rows", () => {
  const t = reportTable(12);
  assert.deepEqual(t.columns, COLUMNS);
  assert.ok(t.rows.length > 0);
  for (const row of t.rows) assert.match(row[2], /^\d+\.\d{2}$/);
});
