import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODE_COMPARISON, type ModeComparisonTable } from "@slackoff/shared";

// Phase 4e: the README's structure, its two mode tables, its relative links and its wording are pinned here.
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(path.join(repoDir, rel), "utf8");
const readme = read("README.md");

/** The README's own sections, in order (the H1 intro and screenshot come first). */
const SECTIONS = [
  "Before you start: is this allowed at your company?",
  "What it does",
  "Screenshots",
  "Architecture",
  "Quick start",
  "Choosing how Slack Off talks to Claude",
  "Choosing how Slack Off reads JIRA",
  "Configure",
  "Use it from your phone",
  "Cost & quota",
  "Run tracing",
  "Preferences and agent prompts",
  "Security model and residual risks",
  "Use the skills without the platform",
  "Tests",
  "Contributing",
  "License",
];

/** Markdown outside fenced code blocks, so a `## ` or a link inside an example is not mistaken for README structure. */
function prose(md: string): string {
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

function h2s(md: string): string[] {
  return [...prose(md).matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
}

/** The text of one H2 section, up to the next H2. */
function section(md: string, title: string): string {
  const start = md.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `section "${title}" not found`);
  const next = md.indexOf("\n## ", start + 4);
  return md.slice(start, next < 0 ? undefined : next);
}

/** GitHub's heading anchors: lower case, punctuation other than "-" and "_" dropped, each space a "-". */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function anchors(md: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of prose(md).matchAll(/^#{1,6} (.+?)\s*$/gm)) {
    const base = slug(m[1]!.replace(/<a id="[^"]+"><\/a>/g, "").trim());
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of md.matchAll(/<a id="([^"]+)"/g)) out.add(m[1]!);
  return out;
}

function tableMarkdown(t: ModeComparisonTable): string {
  return [`| | ${t.columns[0]} | ${t.columns[1]} |`, "|---|---|---|", ...t.rows.map((r) => `| ${r.label} | ${r.values[0]} | ${r.values[1]} |`)].join("\n");
}

test("README: the sections, in order", () => {
  assert.deepEqual(h2s(readme), SECTIONS);
  assert.match(readme, /^# Slack Off\n/);
  assert.ok(!/phase \d/i.test(h2s(readme).join("\n")), "no 'phase N' in section titles");
});

test("README: the compliance reminder comes before Quick start and quotes spec §3", () => {
  const compliance = readme.indexOf("\n## Before you start: is this allowed at your company?\n");
  const quick = readme.indexOf("\n## Quick start\n");
  assert.ok(compliance > 0 && quick > compliance);
  const s = section(readme, "Before you start: is this allowed at your company?");
  assert.ok(s.includes("Whether sending code and ticket content to an AI complies with your company's policy is your own call."));
  assert.ok(s.includes("No API token needed: uses your own browser login."));
});

test("README: every outward action is confirmed, and the list of them is spelled out", () => {
  assert.ok(
    section(readme, "What it does").includes(
      "Every outward action — push, pull request, JIRA status, JIRA comment, trace export — happens only after you confirm it.",
    ),
  );
});

test("README: the two mode tables are the shared data, word for word, under their own sections", () => {
  for (const [kind, title] of [
    ["executor", "Choosing how Slack Off talks to Claude"],
    ["jira", "Choosing how Slack Off reads JIRA"],
  ] as const) {
    const table = tableMarkdown(MODE_COMPARISON[kind]);
    assert.ok(section(readme, title).includes(`\n${table}\n`), `the ${kind} table under "${title}":\n${table}`);
  }
});

test("mode comparison data: spec §7.1's six aspects plus the credentials row; the JIRA table of the 4b plan", () => {
  const ex = MODE_COMPARISON.executor;
  assert.deepEqual(ex.columns, ["Claude Code subscription (default)", "Anthropic API key"]);
  assert.deepEqual(
    ex.rows.map((r) => r.label),
    ["Needs", "Cost", "Getting started", "Concurrency and quota", "Control", "Credentials", "Good for"],
  );
  const jira = MODE_COMPARISON.jira;
  assert.deepEqual(jira.columns, ["Browser (default)", "JIRA API"]);
  assert.deepEqual(
    jira.rows.map((r) => r.label),
    ["Needs", "Credentials", "Speed and cost", "Robustness", "Supported", "Good for"],
  );
  // consistent with 4b: API-key runs never use the subscription; only the browser mode reaches Data Center (ruling B-6)
  assert.match(ex.rows.find((r) => r.label === "Concurrency and quota")!.values[1], /not your subscription/i);
  assert.match(jira.rows.find((r) => r.label === "Supported")!.values[0], /Data Center/);
  assert.doesNotMatch(jira.rows.find((r) => r.label === "Supported")!.values[1], /Data Center/);
  for (const r of [...ex.rows, ...jira.rows]) for (const v of [r.label, ...r.values]) assert.ok(v.length > 0 && !v.includes("|"), v);
});

/** Every relative link in a repository Markdown file points at an existing file, and every anchor at a heading. */
function checkLinks(rel: string): number {
  const md = read(rel);
  const links = [...prose(md).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
  for (const link of links) {
    if (/^[a-z]+:/i.test(link)) continue; // https:, mailto:
    const [file, anchor] = link.split("#");
    const target = file === "" ? rel : path.join(path.dirname(rel), decodeURIComponent(file!));
    assert.ok(existsSync(path.join(repoDir, target)), `${rel}: link ${link}`);
    if (anchor !== undefined && target.endsWith(".md")) assert.ok(anchors(read(target)).has(anchor), `${rel}: anchor ${link}`);
  }
  return links.length;
}

test("README: every relative link and every in-page anchor resolves", () => {
  assert.ok(checkLinks("README.md") > 10);
});

test("install guide, CONTRIBUTING and skills README: every relative link and anchor resolves", () => {
  for (const f of ["docs/install.md", "CONTRIBUTING.md", "skills/README.md"]) checkLinks(f);
});

test("README: no 'bypass', 'governance' or 'circumvent' wording", () => {
  for (const word of ["bypass", "governance", "circumvent"]) assert.ok(!readme.toLowerCase().includes(word), word);
});

test("README: what it links for first-time users exists (install guide, contributing, skills)", () => {
  for (const f of ["docs/install.md", "CONTRIBUTING.md", "skills/README.md", "LICENSE"]) assert.ok(existsSync(path.join(repoDir, f)), f);
});

// ---- phase 4e task 4: the install guide, CONTRIBUTING and the skills on their own

test("install guide: Node 26, the pnpm version, fake mode, Playwright, gh; a Check: under every section", () => {
  const install = read("docs/install.md");
  const pnpmVersion = (JSON.parse(read("package.json")) as { packageManager: string }).packageManager.replace(/^pnpm@/, "");
  for (const s of ["Node 26", `pnpm@${pnpmVersion}`, "SLACKOFF_FAKE_EXECUTOR=1", "npx playwright install chromium", "gh auth login", "nvm use", "bad option: --disable-sigusr1"]) {
    assert.ok(install.includes(s), s);
  }
  const sections = prose(install).split(/^## /m).slice(1);
  assert.ok(sections.length >= 10, "one section per step");
  for (const sec of sections) assert.ok(sec.includes("Check:"), `no "Check:" under "## ${sec.split("\n")[0]}"`);
  // uninstalling removes only Slack Off's own folders (and the clone)
  const uninstall = sections.find((x) => x.startsWith("Uninstall"));
  assert.ok(uninstall?.includes("~/.slackoff") && uninstall.includes("~/.slackoff-acceptance"));
  const removed = [...install.matchAll(/\brm -r?f? (.+)$/gm)].flatMap((m) => m[1]!.trim().split(/\s+/));
  assert.ok(removed.length >= 2);
  for (const target of removed) assert.match(target, /^(~\/\.slackoff|~\/\.slackoff-acceptance|slack-off)\/?$/, target);
});

test("skills README: every skills/ folder, cp -Rn (never overwriting), the jira-update warning, the missing protections", () => {
  const skills = read("skills/README.md");
  const dirs = readdirSync(path.join(repoDir, "skills")).filter((d) => statSync(path.join(repoDir, "skills", d)).isDirectory());
  assert.ok(dirs.length >= 9);
  for (const d of dirs) assert.ok(skills.includes(`\`${d}\``), d);
  assert.ok(skills.includes("cp -Rn"));
  assert.ok(!/cp -R(?!n)/.test(skills), "no copy that overwrites");
  assert.match(skills, /`jira-update` and `jira-comment`[^\n]*change JIRA/);
  for (const s of ["schema", "confirm", "isolation", "sandbox", "audit"]) assert.ok(skills.toLowerCase().includes(s), s);
  // the only user folder ever suggested is ~/.claude/skills (or the project's own .claude/skills)
  for (const m of skills.matchAll(/~\/[\w./-]*/g)) assert.match(m[0], /^~\/\.claude\/skills/, m[0]);
});

test("README: the skills section repeats the copy rule and the warning", () => {
  const s = section(readme, "Use the skills without the platform");
  assert.ok(s.includes("cp -Rn") && s.includes("jira-update") && s.includes("jira-comment"));
  assert.ok(!/cp -R(?!n)/.test(s));
});

test("CONTRIBUTING: commands, conventions, the security rules, the public-content rule, no host state in tests", () => {
  const c = read("CONTRIBUTING.md");
  for (const s of ["pnpm check:public", "pnpm test", "pnpm typecheck", "pnpm e2e", "--no-verify", "bypassPermissions", "390", "i18n/en.ts", "@slackoff/shared"]) {
    assert.ok(c.includes(s), s);
  }
  for (const s of ["clipboard", "keychain", "~/.gitconfig", "~/.claude"]) assert.ok(c.includes(s), s);
});
