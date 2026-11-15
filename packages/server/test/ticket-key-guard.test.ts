// Phase 4a Task 7 item 4: the ticket-key pattern lives only in @slackoff/shared (ticket-key.ts); the server imports it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : []));

test("no ticket-key regex literal in packages/server/src (TICKET_KEY / isTicketKey come from @slackoff/shared)", () => {
  const hits = files(SRC).filter((f) => readFileSync(f, "utf8").includes("[A-Z][A-Z0-9_]*-"));
  assert.deepEqual(hits.map((f) => f.slice(SRC.length + 1)), []);
});
