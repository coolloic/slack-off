// Dev/e2e only (SLACKOFF_FAKE_EXECUTOR=1): the fake acceptance agent (Task 17). It writes one Playwright spec into the
// run's acceptance dir and reports a verdict per AC; the platform then re-runs that spec for real (through the
// `playwright` shim, in the acceptance sandbox, against the fake web app it started in the same sandbox). Never used
// otherwise.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceResult } from "@slackoff/shared";
import type { RunAgentRequest } from "../executor/run-agent.ts";

const SPEC_FILE = "specs/ac.spec.mjs";

/** acceptance-review runs per ticket since the server started (FAKE_SWITCHES.acceptanceFailsOnce counts them). */
const runs = new Map<string, number>();

/** The locked AC ids, from the prompt's `## requirement` json block. */
function acIdsOf(prompt: string): string[] {
  const m = /^## requirement\n[\s\S]*?```json\n([\s\S]*?)\n```/m.exec(prompt);
  if (!m) throw new Error("fake acceptance: the prompt has no requirement block");
  const r = JSON.parse(m[1]!) as { acceptanceCriteria?: Array<{ id: string }> };
  return (r.acceptanceCriteria ?? []).map((a) => a.id);
}

/** Anything named .git or ending in .db under `dir` (not following symlinks; node_modules links are not entered). */
function forbiddenEntries(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, e.name);
      if (e.name === ".git" || /\.(db|sqlite3?)(-wal|-shm)?$/.test(e.name)) found.push(abs);
      else if (e.isDirectory() && !e.isSymbolicLink()) walk(abs);
    }
  };
  walk(dir);
  return found;
}

/** One test per AC: open the app, screenshot into evidence/ and attach it; a failing AC's test fails too. */
function spec(acIds: readonly string[], failing: ReadonlySet<string>): string {
  return [
    "import { test, expect } from '@playwright/test';",
    "",
    ...acIds.map((id) => {
      const shot = `evidence/${id.toLowerCase()}.png`;
      return [
        `test(${JSON.stringify(`${id} works`)}, async ({ page }, testInfo) => {`,
        "  await page.goto('/');",
        `  await page.screenshot({ path: '${shot}', fullPage: true });`,
        `  await testInfo.attach('page', { path: '${shot}', contentType: 'image/png' });`,
        "  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();",
        failing.has(id) ? "  await expect(page.getByRole('link', { name: 'Download CSV' }), 'fake: fails on the first attempt').toBeVisible({ timeout: 500 });" : "",
        "});",
        "",
      ].filter((l) => l !== "").join("\n");
    }),
  ].join("\n");
}

/**
 * The fake acceptance-review run. `failsOnce`: the ticket's first run reports AC-2 as failed (its test fails as well);
 * every later run passes. Throws when the agent's cwd or config dir holds a .git or database entry (isolation broken).
 */
export function fakeAcceptance(req: RunAgentRequest<unknown>, failsOnce: boolean): AcceptanceResult {
  const key = req.ticketKey ?? "";
  const workDir = req.policy?.workDir;
  const configDir = req.isolation?.claudeConfigDir;
  if (!workDir || !configDir) throw new Error("fake acceptance: no work dir or config dir in the request");
  const bad = [...forbiddenEntries(req.cwd), ...forbiddenEntries(configDir)];
  if (bad.length > 0) throw new Error(`fake acceptance: isolation broken, found ${bad.join(", ")}`);

  const n = (runs.get(key) ?? 0) + 1;
  runs.set(key, n);
  const acIds = acIdsOf(req.prompt);
  const failing = new Set<string>(failsOnce && n === 1 ? acIds.filter((id) => id === "AC-2") : []);
  if (req.policy?.acceptCases !== undefined) return casesAcceptance(workDir, req.policy.acceptCases, acIds, failing);

  const file = join(workDir, "acceptance", SPEC_FILE);
  mkdirSync(join(workDir, "acceptance", "specs"), { recursive: true });
  writeFileSync(file, spec(acIds, failing));

  const title = (id: string) => `${SPEC_FILE} › ${id} works`;
  return {
    summary: failing.size > 0 ? "The orders page loads, but the CSV download is missing." : "The orders page loads with the Export button and the VAT column.",
    acs: acIds.map((acId) => {
      const fails = failing.has(acId);
      return {
        acId,
        verdict: fails ? ("fail" as const) : ("pass" as const),
        note: "No boundary applies to this criterion in the fake app.",
        flows: (["happy", "error"] as const).map((kind) => ({
          kind,
          title: `${acId} ${kind === "happy" ? "normal use" : "error case"}`,
          steps: ["Open the orders page"],
          expected: "The orders page works as the criterion says",
          actual: fails ? "No CSV download link" : "As expected",
          tests: [title(acId)],
          evidence: [{ kind: "attachment" as const, test: title(acId), name: "page", caption: `${acId}: the orders page` }],
        })),
      };
    }),
  };
}

/**
 * phase 4f: the fake agent for command-line entries (the fake `cli` repo's to-do tool). One declared case per AC in
 * acceptance/<repo>/cases/: AC-1 lists an empty list, AC-2 lists the items of an input file, the others call the tool
 * without arguments (usage, exit 2). A failing AC-2 (the first run of a failsOnce ticket) leaves out the input file, so
 * the platform's own re-run really fails it; the agent reports that honestly.
 */
function casesAcceptance(workDir: string, repos: ReadonlyArray<{ repo: string; library: string | null }>, acIds: readonly string[], failing: ReadonlySet<string>): AcceptanceResult {
  const repo = repos.find((r) => r.library === null)?.repo;
  if (repo === undefined) throw new Error("fake acceptance: only command-line entries are faked");
  const dir = join(workDir, "acceptance", repo, "cases");
  mkdirSync(dir, { recursive: true });
  const caseOf = (id: string) => {
    const name = id.toLowerCase();
    if (id === "AC-1") return { name, acId: id, kind: "happy", title: "An empty list", args: ["list"], expect: { exitCode: 0, stdoutIncludes: ["(no items)"] } };
    if (id === "AC-2") {
      return {
        name, acId: id, kind: "happy", title: "The items of the list", args: ["list"],
        ...(failing.has(id) ? {} : { files: { "items.txt": "milk\n" } }),
        expect: { exitCode: 0, stdoutIncludes: ["1. milk"] },
      };
    }
    return { name, acId: id, kind: "error", title: "No arguments print the usage", args: [], expect: { exitCode: 2, stderrIncludes: ["usage: tool"] } };
  };
  for (const id of acIds) writeFileSync(join(dir, `${id.toLowerCase()}.case.json`), JSON.stringify(caseOf(id), null, 2));
  return {
    summary: failing.size > 0 ? "The tool lists nothing where an item was expected." : "The tool lists, adds and explains its usage as required.",
    acs: acIds.map((acId) => {
      const fails = failing.has(acId);
      return {
        acId,
        verdict: fails ? ("fail" as const) : ("pass" as const),
        note: "No boundary applies to this criterion in the fake tool.",
        flows: (["happy", "error"] as const).map((kind) => ({
          kind,
          title: `${acId} ${kind === "happy" ? "normal use" : "error case"}`,
          steps: [`Run ./bin/tool.mjs ${caseOf(acId).args.join(" ")}`.trim()],
          expected: "The tool behaves as the criterion says",
          actual: fails ? "The list was empty" : "As expected",
          tests: [acId.toLowerCase()],
          evidence: [{ kind: "case" as const, case: acId.toLowerCase(), caption: `${acId}: the command and its output` }],
        })),
      };
    }),
  };
}
