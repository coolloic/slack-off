import assert from "node:assert/strict";
import { test } from "node:test";
import { orderOptions } from "./answer-options.ts";

test("orderOptions: recommended first, the rest in the agent's order, at most four", () => {
  const o = (label: string, recommended = false) => ({ label, text: `${label} text`, recommended });
  assert.deepEqual(orderOptions([o("a"), o("b", true), o("c"), o("d"), o("e")]).map((x) => x.label), ["b", "a", "c", "d"]);
  assert.deepEqual(orderOptions([]), []);
});
