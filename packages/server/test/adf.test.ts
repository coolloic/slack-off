// Phase 4b Task 4: Atlassian Document Format <-> plain text (descriptions and comments of the JIRA API mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adfToText, textToAdf } from "../src/jira/adf.ts";
import { normalizeCommentText } from "../src/jira/jira-commenter.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "jira-rest", name), "utf8")) as Record<string, unknown>;

test("adfToText: the fixture's description — heading, marks, hard break, mention, lists, code block, inline card, media", () => {
  const issue = fixture("issue-PROJ-1.json") as { fields: { description: unknown } };
  assert.equal(
    adfToText(issue.fields.description),
    [
      "Problem",
      "The total ignores the discount.",
      "Seen by @Test User 1.",
      "- Add an item",
      "- Apply code SAVE10",
      "1. Open the cart",
      "2. Check the total",
      "total = sum - discount;",
      "Spec: https://docs.example.com/spec",
      "[image: screenshot.png]",
    ].join("\n"),
  );
});

test("adfToText: unknown nodes give their text children; media without alt uses its id; junk gives an empty text", () => {
  const doc = { type: "doc", content: [{ type: "panel", content: [{ type: "paragraph", content: [{ type: "text", text: "inside a panel" }] }] }, { type: "media", attrs: { id: "m-1" } }] };
  assert.equal(adfToText(doc), "inside a panel\n[image: m-1]");
  assert.equal(adfToText(null), "");
  assert.equal(adfToText("plain string"), "plain string");
  assert.equal(adfToText({ type: "doc", content: "nope" }), "");
});

test("textToAdf: one paragraph per line, an empty line an empty paragraph, no Markdown parsing", () => {
  const doc = textToAdf("Line one\n\n- not a list\n**not bold**") as { type: string; version: number; content: Array<{ type: string; content: Array<{ type: string; text: string }> }> };
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.content.map((p) => p.type), ["paragraph", "paragraph", "paragraph", "paragraph"]);
  assert.deepEqual(doc.content[1]!.content, []);
  assert.equal(doc.content[2]!.content[0]!.text, "- not a list");
  assert.equal(doc.content[3]!.content[0]!.text, "**not bold**");
});

test("a comment survives textToAdf -> adfToText under normalizeCommentText", () => {
  for (const t of ["One line", "Question for the PO:\n- is the discount per item?\n- or per cart?\n\nThanks", "  spaced  \nlines\t"]) {
    assert.equal(normalizeCommentText(adfToText(textToAdf(t))), normalizeCommentText(t), JSON.stringify(t));
  }
});
