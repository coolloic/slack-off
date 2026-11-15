import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStatus, describeToolUse } from "../src/executor/activity.ts";

const C = (t: string) => `mcp__claude-in-chrome__${t}`;

test("tool calls read as what the agent is doing, with the file or pattern, short", () => {
  assert.equal(describeToolUse("Read", { file_path: "/Users/me/code/shop-web/blocks/header/header.js" }), "Reading blocks/header/header.js");
  assert.equal(describeToolUse("Grep", { pattern: "site-?wide|banner", path: "/Users/me/code/shop-web" }), "Searching the code for “site-?wide|banner”");
  assert.equal(describeToolUse("Glob", { pattern: "**/*banner*" }), "Looking for files matching **/*banner*");
  assert.equal(describeToolUse("Edit", { file_path: "/w/styles/styles.css" }), "Editing w/styles/styles.css");
  assert.equal(describeToolUse("MultiEdit", { file_path: "/a/b/c/d.ts" }), "Editing b/c/d.ts");
  assert.equal(describeToolUse("Write", { file_path: "/a/b/c/d.ts" }), "Writing b/c/d.ts");
  assert.equal(describeToolUse("Bash", { command: "npm run lint:css" }), "Running npm run lint:css");
  assert.equal(describeToolUse(C("navigate"), { url: "https://jira.example.com/browse/P-1", tabId: 1 }), "Opening jira.example.com/browse/P-1");
  assert.equal(describeToolUse(C("get_page_text"), {}), "Reading the page");
  assert.equal(describeToolUse(C("find"), { query: "attachment links" }), "Looking on the page for “attachment links”");
  // long values are cut
  const long = describeToolUse("Bash", { command: "x".repeat(300) })!;
  assert.ok(long.length <= 110 && long.endsWith("…"));
  // a tool with no reader-facing meaning is not shown; an unknown one shows its plain name
  assert.equal(describeToolUse("ToolSearch", { query: "select:x" }), null);
  assert.equal(describeToolUse(C("tabs_context_mcp"), {}), null);
  assert.equal(describeToolUse("NotebookRead", {}), "NotebookRead");
  assert.equal(describeToolUse("Read", {}), "Reading a file");
});

test("internal status events are hidden; the start reads as started", () => {
  assert.equal(describeStatus("init"), "Started");
  for (const s of ["thinking_tokens", "compact_boundary", "hook_response", ""]) assert.equal(describeStatus(s), null);
});
