// Slack Off (phase 4f, Task 4): the Node entry of the acceptance agent's `slackoff-cases run`. Started by the shim in
// <runRoot>/bin with `env -i` and a fixed environment, inside the agent's acceptance sandbox (sandboxes do not nest,
// T6-3), so it runs the cases without a sandbox of its own (runCases sandbox null). One argument: the platform's
// configuration (CasesShimConfig, in bin/, which the sandbox cannot write). It reads each repo's
// acceptance/<repo>/cases/*.case.json, runs them, prints a summary and writes acceptance/results/cases.json for the
// agent to read. Never through the server, no socket. The platform re-runs everything itself afterwards: this run is
// only the agent's feedback, never evidence.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { loadCases, runCases } = await import("./case-runner.ts");

function main() {
  if (process.argv.length !== 3) {
    process.stderr.write("Slack Off: slackoff-cases is misconfigured\n");
    process.exit(2);
  }
  return JSON.parse(readFileSync(process.argv[2], "utf8"));
}

const cfg = main();
const out = { repos: {} };
const lines = [];
let ok = true;
const seen = new Set();
for (const r of cfg.repos) {
  const acc = join(cfg.acceptanceDir, r.repo);
  const { cases, problems } = loadCases(acc, cfg.acIds, r.caseRules);
  const mine = [];
  for (const c of cases) {
    if (seen.has(c.name)) problems.push(`${c.name}: the case name is used in another repository too`);
    else {
      seen.add(c.name);
      mine.push(c);
    }
  }
  const target = r.kind === "cli" ? { kind: "cli", repo: r.repo, command: r.command, snapshotDir: r.snapshotDir } : { kind: "library", repo: r.repo, importName: r.importName, packageDir: r.packageDir };
  let results = [];
  let error = null;
  try {
    results = await runCases({ cases: mine, target, runRoot: cfg.runRoot, acceptanceDir: acc, sandbox: null, env: r.env, timeoutMs: cfg.timeoutMs, caseRules: r.caseRules });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  out.repos[r.repo] = { problems, results, error };
  lines.push(`== ${r.repo} (${r.kind}): ${mine.length} case(s)`);
  for (const p of problems) lines.push(`PROBLEM ${p}`);
  if (error !== null) lines.push(`ERROR ${error}`);
  for (const x of results) {
    lines.push(`${x.passed ? "PASS" : "FAIL"} ${x.name} (exit ${x.exitCode ?? "—"}${x.timedOut ? ", timed out" : ""})`);
    for (const f of x.failures) lines.push(`  - ${f}`);
  }
  if (problems.length > 0 || error !== null || results.some((x) => !x.passed) || mine.length === 0) ok = false;
}
mkdirSync(join(cfg.acceptanceDir, "results"), { recursive: true });
writeFileSync(join(cfg.acceptanceDir, "results", "cases.json"), JSON.stringify(out, null, 2));
lines.push("Full results (stdout, stderr, failures): acceptance/results/cases.json");
process.stdout.write(`${lines.join("\n")}\n`);
process.exit(ok ? 0 : 1);
