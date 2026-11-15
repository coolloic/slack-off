import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { cn, FONT_SIZES } from "./utils.ts";

const SIZES = ["headline-lg", "headline-md", "headline-sm", "body-md", "body-sm", "label-md", "label-sm", "code-lg", "code-md", "code-sm", "kbd"];

test("F-I5 cn: custom font sizes do not conflict with text colours", () => {
  assert.equal(cn("text-white", "text-label-sm"), "text-white text-label-sm");
  assert.equal(cn("text-label-sm", "text-white"), "text-label-sm text-white");
  for (const s of SIZES) assert.equal(cn("text-white", `text-${s}`), `text-white text-${s}`, s);
  // the "Start refining" case: primary variant colour + lg size
  assert.equal(cn("bg-slate-900 text-white", "h-11 px-4 text-headline-sm"), "bg-slate-900 text-white h-11 px-4 text-headline-sm");
});

test("F-I5 cn: custom font sizes still override each other and the built-in sizes", () => {
  assert.equal(cn("text-label-md", "text-label-sm"), "text-label-sm");
  assert.equal(cn("text-sm", "text-body-md"), "text-body-md");
  assert.equal(cn("text-body-md", "text-[10px]"), "text-[10px]");
  assert.equal(cn("text-white", "text-slate-500"), "text-slate-500");
});

test("F-I5 FONT_SIZES lists every --text-* token of the theme", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const tokens = [...new Set([...css.matchAll(/--text-([a-z0-9-]+?):/g)].map((m) => m[1]!).filter((n) => !n.includes("--")))];
  assert.deepEqual([...tokens].sort(), [...FONT_SIZES].sort());
});
