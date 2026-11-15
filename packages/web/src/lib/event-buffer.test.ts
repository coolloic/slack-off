import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBuffer, type AgentEventEntry } from "./event-buffer.ts";

const ev = (key: string, n: number, role: AgentEventEntry["role"] = "design-solution"): AgentEventEntry => ({ ticketKey: key, role, runId: "r", kind: "text", text: String(n) });

test("event buffer: keeps the last 500 events per ticket, first in first out; other tickets are untouched", () => {
  const b = new EventBuffer(500);
  for (let i = 1; i <= 3; i++) b.push(ev("B-1", i));
  for (let i = 1; i <= 501; i++) b.push(ev("A-1", i));
  const a = b.get("A-1");
  assert.equal(a.length, 500);
  assert.equal(a[0]!.text, "2");
  assert.equal(a.at(-1)!.text, "501");
  assert.deepEqual(b.get("B-1").map((e) => e.text), ["1", "2", "3"]);
  assert.deepEqual(b.get("C-1"), []);
});

test("event buffer: a push gives the ticket a new array (subscribers see a change) and notifies listeners", () => {
  const b = new EventBuffer(5);
  let calls = 0;
  const off = b.subscribe(() => calls++);
  b.push(ev("A-1", 1));
  const first = b.get("A-1");
  assert.equal(b.get("A-1"), first, "stable between pushes");
  b.push(ev("A-1", 2));
  assert.notEqual(b.get("A-1"), first);
  off();
  b.push(ev("A-1", 3));
  assert.equal(calls, 2);
});

test("event buffer: role filter", () => {
  const b = new EventBuffer(10);
  b.push(ev("A-1", 1, "design-solution"));
  b.push(ev("A-1", 2, "implement-ticket"));
  b.push(ev("A-1", 3, "critique-design"));
  assert.deepEqual(b.filter("A-1", ["design-solution", "critique-design"]).map((e) => e.text), ["1", "3"]);
  assert.equal(b.filter("A-1").length, 3);
});

test("event buffer: an event's text is cut to 2 KB", () => {
  const b = new EventBuffer(5);
  b.push({ ...ev("A-1", 1), text: "x".repeat(5000) });
  b.push(ev("A-1", 2));
  const [big, small] = b.get("A-1");
  assert.ok(big!.text.length <= 2048 && big!.text.endsWith("…"));
  assert.equal(small!.text, "2");
});

test("event buffer: clear(key) empties one key and notifies (a new trial run starts with an empty log)", () => {
  const b = new EventBuffer(10);
  let n = 0;
  b.subscribe(() => n++);
  b.push({ ticketKey: "trial", role: "refine-ticket", runId: "r", kind: "text", text: "a" });
  b.push({ ticketKey: "K-1", role: "refine-ticket", runId: "r", kind: "text", text: "b" });
  b.clear("trial");
  assert.equal(b.get("trial").length, 0);
  assert.equal(b.get("K-1").length, 1);
  assert.equal(n, 3);
  b.clear("trial");
  assert.equal(n, 3);
});
