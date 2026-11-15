import assert from "node:assert/strict";
import { test } from "node:test";
import { CROSS_REPO_CHECKLIST, DEFAULT_CHECKLIST, type DebateRoundRecord, type DesignDoc, type Disagreement, type RulingRecord } from "@slackoff/shared";
import {
  affectedDraft, checklistPanel, currentRound, docMarkdown, finalizeCaption, inlineSpans, lineDiff, mdBlocks, parseTable, reposCaption, rulingDraftValid, rulingsPayload,
} from "./debate-model.ts";

const sol = { affectedRepos: ["api", "web"] };

test("affectedDraft: defaults to the solution's repos, not edited", () => {
  assert.deepEqual(affectedDraft(sol, ["api", "web", "docs"], null), { repos: ["api", "web"], edited: false, error: null });
});

test("affectedDraft: none picked is an error", () => {
  const d = affectedDraft(sol, ["api", "web"], []);
  assert.deepEqual(d.repos, []);
  assert.ok(d.error && d.error.length > 0);
});

test("affectedDraft: a subset (or superset) is edited; repos keep the mapped order; unmapped picks are dropped", () => {
  assert.deepEqual(affectedDraft(sol, ["api", "web"], ["web"]), { repos: ["web"], edited: true, error: null });
  assert.deepEqual(affectedDraft({ affectedRepos: ["web"] }, ["api", "web"], ["web", "api", "ghost"]), { repos: ["api", "web"], edited: true, error: null });
  assert.deepEqual(affectedDraft(sol, ["api", "web"], ["web", "api"]).edited, false);
});

test("affectedDraft: a phase-1 solution without repos starts empty (error) unless the project has one repo", () => {
  assert.ok(affectedDraft({ affectedRepos: [] }, ["api", "web"], null).error);
  assert.deepEqual(affectedDraft({ affectedRepos: [] }, ["app"], null), { repos: ["app"], edited: false, error: null });
});

const docFor = (ids: string[], skip: string[] = []): DesignDoc => ({
  contentMd: "## Overview\nx",
  repos: [],
  checklist: ids.filter((id) => !skip.includes(id)).map((id) => ({ item: id, status: id === "reusability" ? ("not_applicable" as const) : ("considered" as const), conclusion: `ok ${id}` })),
  responses: [],
});

let nextId = 1;
const critic = (round: number, comments: Array<{ id: string; item: string; blocking: boolean; repo?: string | null }>): DebateRoundRecord => ({
  id: nextId++, choiceId: 1, designDocId: round, round, role: "critic", createdAt: "",
  content: {
    comments: comments.map((c) => ({ id: c.id, checklistItem: c.item, repo: c.repo ?? null, blocking: c.blocking, text: `t ${c.id}`, suggestion: null })),
    coverage: [],
  },
});
const designer = (round: number, responses: Array<{ id: string; verdict: "accepted" | "rebutted" }>): DebateRoundRecord => ({
  id: nextId++, choiceId: 1, designDocId: round + 1, round, role: "designer", createdAt: "",
  content: { responses: responses.map((r) => ({ commentId: r.id, verdict: r.verdict, reason: "because" })) },
});

test("checklistPanel: single-repo checklist has 3 groups (10/6/6) in order", () => {
  const p = checklistPanel([...DEFAULT_CHECKLIST], docFor(DEFAULT_CHECKLIST.map((i) => i.id)), []);
  assert.deepEqual(p.map((g) => [g.group, g.items.length]), [["non_functional", 10], ["principles", 6], ["edge_cases", 6]]);
  const r = p[0]!.items.find((i) => i.id === "reusability")!;
  assert.equal(r.status, "not_applicable");
  assert.equal(r.conclusion, "ok reusability");
  assert.equal(r.label, "Reusability");
});

test("checklistPanel: 25 items get a cross-repo group; unanswered items are missing; no doc = all missing", () => {
  const all = [...DEFAULT_CHECKLIST, ...CROSS_REPO_CHECKLIST];
  const p = checklistPanel(all, docFor(all.map((i) => i.id), ["versioning"]), []);
  assert.deepEqual(p.map((g) => [g.group, g.items.length]), [["non_functional", 10], ["principles", 6], ["edge_cases", 6], ["cross_repo", 3]]);
  const v = p[3]!.items.find((i) => i.id === "versioning")!;
  assert.equal(v.status, "missing");
  assert.equal(v.conclusion, "");
  assert.ok(checklistPanel(all, null, []).every((g) => g.items.every((i) => i.status === "missing")));
});

test("checklistPanel: comments counted over all critic rounds; disputed = blocking comment of the latest critic round not yet ruled on (accepted or not: the critic has not confirmed)", () => {
  const rounds = [
    critic(1, [{ id: "C-1", item: "security", blocking: true }, { id: "C-2", item: "dry", blocking: false }]),
    designer(1, [{ id: "C-1", verdict: "accepted" }]),
    critic(2, [{ id: "C-1", item: "reliability", blocking: true }, { id: "C-2", item: "yagni", blocking: true }, { id: "C-3", item: "kiss", blocking: true }, { id: "C-4", item: "dry", blocking: false }]),
    designer(2, [{ id: "C-1", verdict: "rebutted" }, { id: "C-2", verdict: "accepted" }]),
  ];
  const p = checklistPanel([...DEFAULT_CHECKLIST], docFor(DEFAULT_CHECKLIST.map((i) => i.id)), rounds);
  const item = (id: string) => p.flatMap((g) => g.items).find((i) => i.id === id)!;
  assert.equal(item("dry").comments, 2);
  assert.equal(item("security").comments, 1);
  assert.equal(item("security").disputed, false, "an earlier round's comment is superseded");
  assert.equal(item("reliability").disputed, true, "rebutted");
  assert.equal(item("kiss").disputed, true, "not answered yet");
  assert.equal(item("yagni").disputed, true, "accepted by the designer, still a disagreement until ruled or re-reviewed");
  assert.equal(item("dry").disputed, false, "non-blocking");
  assert.deepEqual(p.map((g) => g.disputed), [1, 2, 0]);
});

test("checklistPanel: a ruled comment is no longer disputed", () => {
  const c = critic(1, [{ id: "C-1", item: "security", blocking: true }]);
  const rounds = [c, designer(1, [{ id: "C-1", verdict: "rebutted" }])];
  const ruling: RulingRecord = { id: 1, debateRoundId: c.id, commentId: "C-1", decision: "critic", note: "", decidedBy: "local", createdAt: "" };
  const doc = docFor(DEFAULT_CHECKLIST.map((i) => i.id));
  assert.equal(checklistPanel([...DEFAULT_CHECKLIST], doc, rounds)[0]!.disputed, 1);
  assert.equal(checklistPanel([...DEFAULT_CHECKLIST], doc, rounds, [ruling])[0]!.disputed, 0);
});

const dis = (id: string): Disagreement => ({ roundId: 1, commentId: id, checklistItem: "security", repo: null, critic: { text: "x", suggestion: null }, designer: null });

test("rulingDraftValid: every disagreement needs a decision; custom needs a non-blank note", () => {
  const d = [dis("C-1"), dis("C-2")];
  assert.deepEqual(rulingDraftValid(d, { "C-1": { decision: "designer", note: "" }, "C-2": { decision: "critic", note: "" } }), { ok: true, missing: [] });
  assert.deepEqual(rulingDraftValid(d, { "C-1": { decision: "designer", note: "" } }), { ok: false, missing: ["C-2"] });
  assert.deepEqual(rulingDraftValid(d, { "C-1": { note: "" }, "C-2": { decision: "critic", note: "" } }), { ok: false, missing: ["C-1"] });
  assert.deepEqual(rulingDraftValid(d, { "C-1": { decision: "custom", note: "   " }, "C-2": { decision: "custom", note: "do X" } }), { ok: false, missing: ["C-1"] });
});

test("finalizeCaption: all for the designer finalizes as is; otherwise the designer applies the rulings first", () => {
  assert.equal(finalizeCaption({ "C-1": { decision: "designer", note: "" }, "C-2": { decision: "designer", note: "" } }, 3), "Finalize version v3 as is");
  assert.equal(finalizeCaption({ "C-1": { decision: "designer", note: "" }, "C-2": { decision: "critic", note: "" } }, 3), "Ask the designer agent to apply your rulings, then finalize");
  assert.equal(finalizeCaption({ "C-1": { decision: "custom", note: "x" } }, 3), "Ask the designer agent to apply your rulings, then finalize");
});

test("currentRound: the highest critic round", () => {
  assert.equal(currentRound([]), 0);
  assert.equal(currentRound([critic(1, []), designer(1, []), critic(2, [])]), 2);
});

test("docMarkdown: overall design then one section per repo", () => {
  assert.equal(docMarkdown({ contentMd: "## Overview\nA\n", repos: [{ repo: "api", contentMd: "Do api." }] }), "## Overview\nA\n\n## api\n\nDo api.\n");
});

test("lineDiff: unchanged, removed and added lines in order", () => {
  assert.deepEqual(lineDiff("a\nb\nc", "a\nc\nd"), [
    { kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "same", text: "c" }, { kind: "add", text: "d" },
  ]);
  assert.deepEqual(lineDiff("", "x"), [{ kind: "del", text: "" }, { kind: "add", text: "x" }]);
});

test("mdBlocks: headings, paragraphs, lists, code fences — plain text, never HTML", () => {
  const b = mdBlocks("# Title\n\nSome **text**\nmore <b>x</b>\n\n- one\n- two\n1. first\n\n```ts\nconst a = 1;\n```\n");
  assert.deepEqual(b, [
    { kind: "heading", level: 1, text: "Title" },
    { kind: "paragraph", text: "Some **text**\nmore <b>x</b>" },
    { kind: "list", ordered: false, items: ["one", "two"] },
    { kind: "list", ordered: true, items: ["first"] },
    { kind: "code", text: "const a = 1;" },
  ]);
});

test("mdBlocks: line breaks inside a paragraph are kept; tables stay preformatted lines", () => {
  assert.deepEqual(mdBlocks("a\nb\n\n| x | y |\n|---|---|\n| 1 | 2 |\nafter"), [
    { kind: "paragraph", text: "a\nb" },
    { kind: "table", text: "| x | y |\n|---|---|\n| 1 | 2 |" },
    { kind: "paragraph", text: "after" },
  ]);
});

test("inlineSpans: `code` and **bold** spans, everything else literal text (no HTML, no links)", () => {
  assert.deepEqual(inlineSpans("a **b** `c` <i>d</i> [e](http://x) **un`closed"), [
    { kind: "text", text: "a " },
    { kind: "bold", text: "b" },
    { kind: "text", text: " " },
    { kind: "code", text: "c" },
    { kind: "text", text: " <i>d</i> [e](http://x) **un`closed" },
  ]);
  assert.deepEqual(inlineSpans(""), []);
});

test("rulingsPayload: one ruling per disagreement; the note is sent only for my own decision", () => {
  const d = [dis("C-1"), dis("C-2"), dis("C-3")];
  const draft = {
    "C-1": { decision: "designer" as const, note: "stale text typed before switching" },
    "C-2": { decision: "critic" as const, note: "x" },
    "C-3": { decision: "custom" as const, note: "  cap at 50k  " },
  };
  assert.deepEqual(rulingsPayload(d, draft), [
    { commentId: "C-1", decision: "designer", note: "" },
    { commentId: "C-2", decision: "critic", note: "" },
    { commentId: "C-3", decision: "custom", note: "cap at 50k" },
  ]);
  assert.throws(() => rulingsPayload(d, { "C-1": { decision: "designer", note: "" } }), /C-2/);
});

test("reposCaption: the repo list is abbreviated after two names so the edited suffix always fits", () => {
  assert.equal(reposCaption(["api", "web"], false), "record your choice in the audit log and start the design for api, web.");
  const four = reposCaption(["api", "web", "docs", "infra-tools"], true);
  assert.equal(four, "record your choice in the audit log and start the design for api, web +2 (edited from the proposal).");
  assert.ok(four.endsWith("(edited from the proposal)."));
  assert.equal(reposCaption(["api", "web", "docs"], false), "record your choice in the audit log and start the design for api, web +1.");
});

test("parseTable: header and rows from a Markdown table; separators skipped; escaped and code pipes stay in the cell", () => {
  assert.deepEqual(parseTable("| AC | Covered by | Notes |\n|---|:---:|---|\n| AC-1 | §2 | ok |\n| AC-2 | `a|b` | x \\| y |"), {
    header: ["AC", "Covered by", "Notes"],
    rows: [["AC-1", "§2", "ok"], ["AC-2", "`a|b`", "x | y"]],
  });
  // a short row is padded, a long one cut to the header
  assert.deepEqual(parseTable("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")!.rows, [["1", ""], ["1", "2"]]);
  // no separator row: not a table (shown as it is)
  assert.equal(parseTable("| a | b |\n| 1 | 2 |"), null);
  assert.equal(parseTable("| a |"), null);
});
