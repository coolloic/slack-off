// Phase 4f Task 3: the acceptance case runner — a declared CLI or a Node example per case, never through a shell, in
// the real acceptance sandbox (macOS sandbox-exec; skipped elsewhere: the runner refuses to run a case without it
// unless the caller is already inside it, the shim path). Fixtures: test/fixtures/acceptance-cli (a to-do CLI) and
// test/fixtures/acceptance-lib (slugify).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AcceptanceCase } from "@slackoff/shared";
import { loadConfig } from "../src/config.ts";
import { SANDBOX_EXEC, sandboxArgv, sandboxEnv, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { cleanupRunDirs, prepareRunDirs, writeCasesScaffold, writeCasesShim, type AcceptanceRunDirs } from "../src/acceptance/workspace.ts";
import { targetEnv } from "../src/acceptance/app-runner.ts";
import {
  caseEnv, caseTranscript, CaseTargetError, cliTarget, plainOutput, CASE_OUTPUT_TAIL_BYTES, copyCaseInputs, libraryTarget, loadCases, matchWithinWorker, runCases, writeCaseFiles, type CliTarget, type LibTarget,
} from "../src/acceptance/case-runner.ts";
import { checkExample } from "../src/acceptance/spec-guard.ts";
import { tmpDir } from "./helpers/tmp.ts";

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const skip = HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;

const CLI_FIXTURE = join(import.meta.dirname, "fixtures/acceptance-cli");
const LIB_FIXTURE = join(import.meta.dirname, "fixtures/acceptance-lib");
const root = realpathSync(tmpDir("cr"));
const made: AcceptanceRunDirs[] = [];
after(async () => {
  for (const d of made) await cleanupRunDirs(d);
  rmSync(root, { recursive: true, force: true });
});
const home = join(root, "slackoff");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "slackoff.db"), "DB\n");

async function runDirs(): Promise<AcceptanceRunDirs> {
  const cfgHome = mkdtempSync(join(root, "cfg-"));
  writeFileSync(join(cfgHome, "config.json"), JSON.stringify({ acceptance: { claudeConfigDir: join(mkdtempSync(join(root, "ccfg-")), "claude-config") } }));
  const d = await prepareRunDirs({ home, repoPaths: [], config: loadConfig(cfgHome) });
  made.push(d);
  return d;
}
const scopeOf = (d: AcceptanceRunDirs): SandboxScope => ({ kind: "acceptance", home, allowInHome: null, repos: [], runRoot: d.runRoot });

/** The CLI fixture exported to <workDir>/cli, its target for `command` and the run dirs. */
async function cliRun(command = "./bin/tool.mjs"): Promise<{ d: AcceptanceRunDirs; target: CliTarget }> {
  const d = await runDirs();
  cpSync(CLI_FIXTURE, join(d.workDir, "cli"), { recursive: true });
  chmodSync(join(d.workDir, "cli", "bin", "tool.mjs"), 0o755);
  writeCasesScaffold(d.acceptanceDir, {});
  return { d, target: cliTarget("cli", join(d.workDir, "cli"), command) };
}

const kase = (name: string, args: string[], o: Partial<AcceptanceCase> = {}): AcceptanceCase => ({
  name, acId: "AC-1", kind: "happy", title: name, args, expect: { exitCode: 0 }, ...o,
});

async function runCli(cases: AcceptanceCase[], o: { timeoutMs?: number; command?: string; caseRules?: { envKeys?: string[]; dotfiles?: string[] }; regexBudgetMs?: number } = {}) {
  const { d, target } = await cliRun(o.command);
  const results = await runCases({ cases, target, runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, sandbox: scopeOf(d), env: targetEnv({}, d.runRoot), timeoutMs: o.timeoutMs ?? 20_000, caseRules: o.caseRules, regexBudgetMs: o.regexBudgetMs });
  return { d, results };
}

/** Is any process of group `pgid` still running? (`ps`, not a signal) */
function groupAlive(pgid: number): boolean {
  const out = execFileSync("ps", ["-A", "-o", "pgid=,stat="], { encoding: "utf8" });
  return out.split("\n").some((l) => {
    const [g, stat] = l.trim().split(/\s+/);
    return Number(g) === pgid && !stat?.startsWith("Z");
  });
}

test("cli: shell metacharacters in an argument reach the CLI verbatim; nothing is run by a shell", { skip }, async () => {
  // a shell would create ./pwned in the case's work dir (writable inside the sandbox)
  const evil = "x; touch pwned";
  const { d, results } = await runCli([
    kase("add-evil", ["add", evil], { expect: { exitCode: 0, stdoutIncludes: [`added ${evil}`] } }),
    kase("add-subst", ["add", "$(touch pwned)"], { expect: { exitCode: 0, stdoutIncludes: ["added $(touch pwned)"] } }),
    kase("add-backtick", ["add", "`touch pwned`\nsecond line"], { expect: { exitCode: 0, stdoutIncludes: ["added `touch pwned`\nsecond line"] } }),
  ]);
  for (const r of results) assert.equal(r.passed, true, JSON.stringify(r));
  for (const n of ["1", "2", "3"]) {
    assert.equal(existsSync(join(d.runRoot, "cases-work", n, "pwned")), false, n);
    assert.ok(existsSync(join(d.runRoot, "cases-work", n, "items.txt")), n);
  }
  assert.equal(existsSync("/tmp/pwned"), false);
});

test("cli: no arguments → exit 2 with the usage; expect.exitCode 2 passes, an unmet stdoutIncludes is a failure naming it", { skip }, async () => {
  const { results } = await runCli([
    kase("no-args", [], { kind: "error", expect: { exitCode: 2, stderrIncludes: ["usage: tool"] } }),
    kase("list-missing", ["list"], { expect: { exitCode: 0, stdoutIncludes: ["1. milk"] } }),
    kase("wrong-exit", [], { expect: { exitCode: 0 } }),
    kase("matches", ["list"], { expect: { stdoutMatches: "^\\(no items\\)\\s*$" } }),
  ]);
  const [noArgs, missing, wrongExit, matches] = results;
  assert.deepEqual([noArgs!.passed, noArgs!.exitCode, noArgs!.failures], [true, 2, []]);
  assert.equal(missing!.passed, false);
  assert.ok(missing!.failures.some((f) => f.includes('"1. milk"') && /stdout/.test(f)), JSON.stringify(missing!.failures));
  assert.equal(wrongExit!.passed, false);
  assert.ok(wrongExit!.failures.some((f) => /exit code 0.*got 2/.test(f)), JSON.stringify(wrongExit!.failures));
  assert.equal(matches!.passed, true, JSON.stringify(matches));
});

test("cli: the sandbox applies — Slack Off's port and the real ~/.ssh are EPERM; HOME is the case's own work dir", { skip }, async () => {
  const { d, results } = await runCli([
    kase("probe", ["probe"], { expect: { stdoutIncludes: ["probe: EPERM"] } }),
    kase("read-ssh", ["read", join(homedir(), ".ssh")], { expect: { stdoutIncludes: ["read: EPERM"] } }),
    kase("read-home-db", ["read", home], { expect: { stdoutIncludes: ["read: EPERM"] } }),
    kase("home", ["env", "HOME"], { expect: { exitCode: 0 } }),
    kase("tmpdir", ["env", "TMPDIR"], { expect: { exitCode: 0 } }),
  ]);
  for (const r of results.slice(0, 3)) assert.equal(r.passed, true, JSON.stringify(r));
  assert.equal(results[3]!.stdoutTail.trim(), `HOME=${join(d.runRoot, "cases-work", "4")}`);
  // 4F-1: each case its own tmp dir
  assert.equal(results[4]!.stdoutTail.trim(), `TMPDIR=${join(d.runRoot, "cases-tmp", "5")}`);
});

test("cli: a case over its timeout is killed with its process group → timedOut, a failure, the group gone", { skip }, async () => {
  const { d, target } = await cliRun();
  const pgids: number[] = [];
  const t0 = Date.now();
  const [r] = await runCases({
    cases: [kase("sleep", ["sleep"])], target, runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, sandbox: scopeOf(d), env: targetEnv({}, d.runRoot), timeoutMs: 1000,
    onSpawn: (p) => pgids.push(p),
  });
  assert.ok(Date.now() - t0 < 10_000);
  assert.equal(r!.timedOut, true);
  assert.equal(r!.passed, false);
  assert.ok(r!.failures.some((f) => /timed out after 1 s/.test(f)), JSON.stringify(r!.failures));
  assert.equal(pgids.length, 1);
  assert.equal(groupAlive(pgids[0]!), false);
});

test("cli: ANSI colours are stripped; output over 64 KB keeps its last 64 KB and is marked truncated", { skip }, async () => {
  const { results } = await runCli([kase("color", ["color"]), kase("big", ["big"], { expect: { stdoutIncludes: ["THE END"] } })]);
  assert.equal(results[0]!.stdoutTail, "red plain bold green\n");
  assert.equal(results[0]!.truncated, false);
  const big = results[1]!;
  assert.equal(big.truncated, true);
  assert.equal(big.passed, true, JSON.stringify(big.failures));
  assert.ok(Buffer.byteLength(big.stdoutTail) <= CASE_OUTPUT_TAIL_BYTES);
  assert.ok(big.stdoutTail.endsWith("THE END\n"));
});

test("cli: files are written into the case's fresh work dir; stdin is written then closed; case env is passed", { skip }, async () => {
  const { d, results } = await runCli([
    kase("show", ["show", "in.txt"], { files: { "in.txt": "a", "data/items.txt": "milk\n" }, expect: { stdoutIncludes: ["a"] } }),
    kase("list-data", ["list"], { files: { "items.txt": "milk\neggs\n" }, expect: { stdoutIncludes: ["1. milk", "2. eggs"] } }),
    kase("fresh", ["list"], { expect: { stdoutIncludes: ["(no items)"] } }),
    kase("stdin", ["stdin"], { stdin: "yes\n", expect: { stdoutIncludes: ['stdin: "yes\\n"'] } }),
    kase("no-stdin", ["stdin"], { expect: { stdoutIncludes: ['stdin: ""'] } }),
    kase("env", ["env", "TOOL_MODE"], { env: { TOOL_MODE: "strict" }, expect: { stdoutIncludes: ["TOOL_MODE=strict"] } }),
  ], { caseRules: { envKeys: ["TOOL_MODE"] } });
  for (const r of results) assert.equal(r.passed, true, `${r.name}: ${JSON.stringify(r.failures)} ${r.stderrTail}`);
  assert.equal(readFileSync(join(d.runRoot, "cases-work", "1", "data", "items.txt"), "utf8"), "milk\n");
});

test("cli: a catastrophic stdoutMatches cannot stall the platform — evaluated with a time limit, a failure", { skip }, async () => {
  const { results } = await runCli([kase("redos", ["add", `${"a".repeat(40)}!`], { expect: { stdoutMatches: "^added (a+)+$" } })]);
  assert.equal(results[0]!.passed, false);
  assert.ok(results[0]!.failures.some((f) => /stdoutMatches/.test(f) && /time limit/.test(f)), JSON.stringify(results[0]!.failures));
});

test("cli: a program name is never the command (4F-5); a case runs without a nested sandbox when the caller is inside one (shim path)", { skip }, async () => {
  const { d } = await cliRun();
  assert.throws(() => cliTarget("cli", join(d.workDir, "cli"), "printf"), (e: unknown) => e instanceof CaseTargetError && /\.\/ path/.test(e.message));
  const own = cliTarget("cli", join(d.workDir, "cli"), "./bin/tool.mjs");
  const [r] = await runCases({ cases: [kase("list", ["list"], { expect: { stdoutIncludes: ["(no items)"] } })], target: own, runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, sandbox: null, env: targetEnv({}, d.runRoot), timeoutMs: 20_000 });
  assert.equal(r!.passed, true, JSON.stringify(r));
});

test("cliTarget (CLI_RESOLVE): a ./ path must be an executable regular file inside the snapshot", async () => {
  const snap = join(mkdtempSync(join(root, "snap-")), "cli");
  cpSync(CLI_FIXTURE, snap, { recursive: true });
  chmodSync(join(snap, "bin", "tool.mjs"), 0o755);
  assert.deepEqual(cliTarget("cli", snap, "./bin/tool.mjs --no-color"), { kind: "cli", repo: "cli", command: [join(snap, "bin", "tool.mjs"), "--no-color"], snapshotDir: snap });
  assert.throws(() => cliTarget("cli", snap, "./bin/missing.mjs"), (e: unknown) => e instanceof CaseTargetError && /\.\/bin\/missing\.mjs does not exist in the exported snapshot/.test(e.message));
  writeFileSync(join(snap, "bin", "plain.mjs"), "console.log(1)\n", { mode: 0o644 });
  assert.throws(() => cliTarget("cli", snap, "./bin/plain.mjs"), /is not executable/);
  symlinkSync(homedir(), join(snap, "bin", "out"));
  assert.throws(() => cliTarget("cli", snap, "./bin/out"), /outside the exported snapshot/);
  symlinkSync("/bin/sh", join(snap, "bin", "sh"));
  assert.throws(() => cliTarget("cli", snap, "./bin/sh"), /outside the exported snapshot/);
  assert.throws(() => cliTarget("cli", snap, "./bin"), /is not a regular file/);
  assert.throws(() => cliTarget("cli", snap, "node ../x.mjs"), /\.\./);
  // 4F-3: never a generic interpreter
  assert.throws(() => cliTarget("cli", snap, "node ./bin/tool.mjs"), (e: unknown) => e instanceof CaseTargetError && /interpreter/.test(e.message));
  assert.throws(() => cliTarget("cli", snap, "/usr/bin/curl x"), /absolute/);
});

test("library: an example importing the declared package through the platform's node_modules link runs; a guarded import is refused unrun", { skip }, async () => {
  const d = await runDirs();
  cpSync(LIB_FIXTURE, join(d.workDir, "lib"), { recursive: true });
  const target: LibTarget = libraryTarget("lib", join(d.workDir, "lib"), "acceptance-lib", ".");
  writeCasesScaffold(d.acceptanceDir, { library: target });
  const ex = join(d.acceptanceDir, "examples");
  writeFileSync(join(ex, "slug.mjs"), "import assert from 'node:assert/strict';\nimport { slugify } from 'acceptance-lib';\nassert.equal(slugify(' Hello World '), 'hello-world');\nconsole.log(slugify('Hello World'));\n");
  writeFileSync(join(ex, "throws.mjs"), "import { slugify } from 'acceptance-lib';\nslugify(42);\n");
  writeFileSync(join(ex, "fs.mjs"), "import fs from 'node:fs';\nconsole.log(fs.readdirSync('/'));\n");
  writeFileSync(join(ex, "up.mjs"), "import x from '../../x.mjs';\nconsole.log(x);\n");
  const results = await runCases({
    cases: [
      kase("slug", [], { example: "slug.mjs", expect: { exitCode: 0, stdoutIncludes: ["hello-world"] } }),
      kase("throws", [], { kind: "error", example: "throws.mjs", expect: { exitCode: 1, stderrIncludes: ["TypeError: slugify: text must be a string"] } }),
      kase("fs", [], { example: "fs.mjs" }),
      kase("up", [], { example: "up.mjs" }),
      kase("missing", [], { example: "nope.mjs" }),
      kase("no-example", []),
    ],
    target, runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, sandbox: scopeOf(d), env: targetEnv({}, d.runRoot), timeoutMs: 20_000,
  });
  const by = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(by.slug!.passed, true, JSON.stringify(by.slug));
  assert.equal(by.throws!.passed, true, JSON.stringify(by.throws));
  for (const [n, re] of [["fs", /node:fs/], ["up", /\.\.\/\.\.\/x\.mjs/], ["missing", /nope\.mjs/], ["no-example", /example/]] as const) {
    assert.equal(by[n]!.passed, false, n);
    assert.equal(by[n]!.exitCode, null, n);
    assert.ok(by[n]!.failures.some((f) => re.test(f)), `${n}: ${JSON.stringify(by[n]!.failures)}`);
  }
});

test("writeCasesScaffold: cases/ and examples/; a scoped library gets node_modules/@scope/<name>; a package dir outside the snapshot is refused", () => {
  const acc = join(mkdtempSync(join(root, "acc-")), "acceptance");
  const snap = mkdtempSync(join(root, "snap-"));
  mkdirSync(join(snap, "packages", "slug"), { recursive: true });
  writeCasesScaffold(acc, { library: libraryTarget("lib", snap, "@example-org/slug", "packages/slug") });
  assert.ok(existsSync(join(acc, "cases")) && existsSync(join(acc, "examples")));
  assert.equal(realpathSync(join(acc, "examples", "node_modules", "@example-org", "slug")), realpathSync(join(snap, "packages", "slug")));
  symlinkSync(homedir(), join(snap, "away"));
  assert.throws(() => libraryTarget("lib", snap, "x", "away"), (e: unknown) => e instanceof CaseTargetError && /outside the exported snapshot/.test(e.message));
  assert.throws(() => libraryTarget("lib", snap, "x", "nope"), /does not exist in the exported snapshot/);
});

test("writeCaseFiles: never through a symlink planted in the work dir; refuses a path the schema would refuse", () => {
  const work = mkdtempSync(join(root, "cw-"));
  const outside = mkdtempSync(join(root, "outside-"));
  symlinkSync(outside, join(work, "data"));
  assert.throws(() => writeCaseFiles(work, { "data/x.txt": "x" }), /symlink|not a plain directory/);
  assert.equal(existsSync(join(outside, "x.txt")), false);
  symlinkSync(join(outside, "target.txt"), join(work, "f.txt"));
  assert.throws(() => writeCaseFiles(work, { "f.txt": "x" }));
  assert.equal(existsSync(join(outside, "target.txt")), false);
  assert.throws(() => writeCaseFiles(work, { "../x.txt": "x" }), /not a plain relative path/);
  writeCaseFiles(work, { "a/b/c.txt": "c" });
  assert.equal(readFileSync(join(work, "a", "b", "c.txt"), "utf8"), "c");
});

test("loadCases: one case per cases/*.case.json; invalid files, symlinks, duplicate names and unknown AC ids are problems", () => {
  const acc = join(mkdtempSync(join(root, "lc-")), "acceptance");
  writeCasesScaffold(acc, {});
  const c = join(acc, "cases");
  const write = (f: string, v: unknown) => writeFileSync(join(c, f), typeof v === "string" ? v : JSON.stringify(v));
  write("a.case.json", kase("list-empty", ["list"]));
  write("b.case.json", kase("list-empty", ["list"]));
  write("c.case.json", kase("other-ac", ["list"], { acId: "AC-9" }));
  write("d.case.json", "{ not json");
  write("e.case.json", { ...kase("bad-regex", []), expect: { stdoutMatches: "(" } });
  write("notes.txt", "x");
  writeFileSync(join(root, "target.case.json"), JSON.stringify(kase("linked", ["list"])));
  symlinkSync(join(root, "target.case.json"), join(c, "f.case.json"));
  write("g.case.json", kase("add-one", ["add", "x"], { acId: "AC-2" }));
  const { cases, problems } = loadCases(acc, ["AC-1", "AC-2"]);
  assert.deepEqual(cases.map((x) => x.name), ["list-empty", "add-one"]);
  const has = (re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `${re} in ${JSON.stringify(problems)}`);
  has(/^b\.case\.json: .*list-empty.*more than once/);
  has(/^c\.case\.json: .*AC-9/);
  has(/^d\.case\.json: .*JSON/);
  has(/^e\.case\.json: .*stdoutMatches/);
  has(/^f\.case\.json: .*symbolic link/);
  has(/^notes\.txt: /);
  assert.deepEqual(loadCases(join(root, "nowhere"), ["AC-1"]).problems.length, 1);
});

test("caseTranscript: the command with shell-quoted arguments, stdin, both outputs and the exit", () => {
  const c = kase("add-evil", ["add", "x; touch /tmp/pwned", "plain"], { stdin: "yes\n" });
  const t = caseTranscript(c, { name: c.name, passed: false, exitCode: 2, timedOut: false, durationMs: 12, stdoutTail: "out\n", stderrTail: "err\n", truncated: true, failures: ["expected exit code 0, got 2"] }, "./bin/tool.mjs");
  assert.ok(t.startsWith("$ ./bin/tool.mjs add 'x; touch /tmp/pwned' plain\n"), t);
  assert.match(t, /stdin: 4 bytes/);
  assert.match(t, /--- stdout \(last 64 KB\) ---\nout\n/);
  assert.match(t, /--- stderr \(last 64 KB\) ---\nerr\n/);
  assert.match(t, /\nexit 2\n/);
  assert.match(t, /expected exit code 0, got 2/);
  const timed = caseTranscript(kase("s", ["sleep"]), { name: "s", passed: false, exitCode: null, timedOut: true, durationMs: 1000, stdoutTail: "", stderrTail: "", truncated: false, failures: [] }, "./bin/tool.mjs");
  assert.match(timed, /exit — \(timed out\)/);
});

// ---------------------------------------------------------------- fix round 1 (rulings 4F-1 … 4F-4): the reviewer's probes

/** A run whose snapshot CLI is `body` (the reviewer's probe CLIs), and an "outside" scratch dir. */
async function customCli(body: string): Promise<{ d: AcceptanceRunDirs; target: CliTarget; outside: string }> {
  const d = await runDirs();
  const bin = join(d.workDir, "cli", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "tool.mjs"), `#!/usr/bin/env node\n${body}`);
  chmodSync(join(bin, "tool.mjs"), 0o755);
  writeCasesScaffold(d.acceptanceDir, {});
  return { d, target: cliTarget("cli", join(d.workDir, "cli"), "./bin/tool.mjs"), outside: mkdtempSync(join(root, "outside-")) };
}
const run = (d: AcceptanceRunDirs, target: CliTarget | LibTarget, cases: AcceptanceCase[], o: Partial<Parameters<typeof runCases>[0]> = {}) =>
  runCases({ cases, target, runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, sandbox: scopeOf(d), env: targetEnv({}, d.runRoot), timeoutMs: 10_000, ...o });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const strays: number[] = [];
after(() => {
  for (const p of strays) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // gone
    }
  }
});
const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, "written by the platform\n"]));

test("C1 (race.ts): a detached child of case 1 cannot swap cases-work/2 for a link — case 2's files never land outside the run root", { skip }, async () => {
  const { d, target, outside } = await customCli(`
import { spawn } from "node:child_process";
const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === "spawn") {
  const code = \`const fs=require("fs");const w=process.argv[1],t=process.argv[2];const end=Date.now()+15000;
  while(Date.now()<end){ try{ if(fs.lstatSync(w).isDirectory()){ fs.renameSync(w,w+"-old"); fs.symlinkSync(t,w); break; } }catch{} }\`;
  const c = spawn(process.execPath, ["-e", code, a1, a2], { detached: true, stdio: "ignore" });
  c.unref();
  console.log(c.pid);
  await new Promise((r) => setTimeout(r, 400));
} else console.log("ok");
`);
  const r = await run(d, target, [kase("one", ["spawn", join(d.runRoot, "cases-work", "2"), outside]), kase("two", ["x"], { files: twenty })]);
  strays.push(Number(r[0]!.stdoutTail.trim()));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(r[1]!.passed, true, JSON.stringify(r[1]));
  assert.equal(lstatSync(join(d.runRoot, "cases-work", "2")).isDirectory(), true);
  assert.equal(readdirSync(join(d.runRoot, "cases-work", "2")).length, 20);
});

test("C1 (race-lib.ts): the same from a guard-passing library example — nothing lands outside", { skip }, async () => {
  const d = await runDirs();
  const pkg = join(d.workDir, "lib");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "scratch-lib", type: "module", exports: "./index.js" }));
  writeFileSync(join(pkg, "index.js"), "export const slug = (s) => s.toLowerCase();\n");
  const target = libraryTarget("lib", d.workDir, "scratch-lib", "lib");
  writeCasesScaffold(d.acceptanceDir, { library: target });
  const outside = mkdtempSync(join(root, "outside-"));
  // a dodge of the (defense-in-depth) guard: no literal constructor / getBuiltinModule / process
  const one = `import { slug } from "scratch-lib";
const F = [][\"fil\" + \"ter\"][\"constr\" + \"uctor\"];
const p = F("return pro" + "cess")();
const cp = p["getBuilt" + "inModule"]("child_" + "pro" + "cess");
const code = 'const f=requ'+'ire("f"+"s");const a=pro'+'cess.argv,w=a[1],t=a[2];try{f.symlinkSync(t,w+"-l")}catch{}const end=Date.now()+15000;while(Date.now()<end){try{if(f.lstatSync(w).isDirectory()&&f.existsSync(w+"/f0.txt")){f.renameSync(w,w+"-old");f.renameSync(w+"-l",w);break}}catch{}}';
const P = p; const c = cp.spawn(P.execPath, ["-e", code, P.argv[2], P.argv[3]], { detached: true, stdio: "ignore", env: {} }); c.unref();
console.log(c.pid);
await new Promise((r) => setTimeout(r, 400));
`;
  assert.deepEqual(checkExample(one, { libraryName: "scratch-lib" }), [], "the probe passes the guard");
  writeFileSync(join(d.acceptanceDir, "examples", "one.mjs"), one);
  writeFileSync(join(d.acceptanceDir, "examples", "two.mjs"), `import { slug } from "scratch-lib";\nconsole.log(slug("X"));\n`);
  const r = await run(d, target, [
    kase("one", [join(d.runRoot, "cases-work", "2"), outside], { example: "one.mjs" }),
    kase("two", [], { example: "two.mjs", files: twenty, expect: { stdoutIncludes: ["x"] } }),
  ]);
  if (/^\d+$/.test(r[0]!.stdoutTail.trim())) strays.push(Number(r[0]!.stdoutTail.trim()));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(readdirSync(join(d.runRoot, "cases-work", "2")).length, 20);
  assert.equal(r[1]!.passed, true, JSON.stringify(r[1]));
});

test("C1 (rm.ts): case 1 cannot swap cases-work itself for a link — nothing outside is deleted", { skip }, async () => {
  const { d, target, outside } = await customCli(`
import { renameSync, symlinkSync } from "node:fs";
const [cmd, cw, t] = process.argv.slice(2);
if (cmd === "swap") { symlinkSync(t, cw + "-l"); renameSync(cw, cw + "-old"); renameSync(cw + "-l", cw); }
console.log("ok");
`);
  mkdirSync(join(outside, "2", "deep"), { recursive: true });
  writeFileSync(join(outside, "2", "deep", "precious.txt"), "scratch data\n");
  const r = await run(d, target, [kase("one", ["swap", join(d.runRoot, "cases-work"), outside]), kase("two", ["x"])]);
  assert.equal(r[0]!.passed, false, "the swap is refused by the case's sandbox");
  assert.equal(existsSync(join(outside, "2", "deep", "precious.txt")), true);
  assert.equal(lstatSync(join(d.runRoot, "cases-work")).isDirectory(), true);
});

test("I1 (forge.ts): case 1 cannot replace examples/node_modules/<lib> with a stub — the broken library still fails case 2", { skip }, async () => {
  const d = await runDirs();
  const pkg = join(d.workDir, "lib");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "scratch-lib", type: "module", exports: "./index.js" }));
  writeFileSync(join(pkg, "index.js"), "export const slug = (s) => 'BUG';\n");
  const target = libraryTarget("lib", d.workDir, "scratch-lib", "lib");
  writeCasesScaffold(d.acceptanceDir, { library: target });
  const one = `import { slug } from "scratch-lib";
const p = [][\"fil\" + \"ter\"][\"constr\" + \"uctor\"]("return pro" + "cess")();
const f = p["getBuilt" + "inModule"]("f" + "s");
const ex = p.argv[1].replace(/one\\.mjs$/, "");
const stub = ex + "../stub";
f.mkdirSync(stub, { recursive: true });
f.writeFileSync(stub + "/package.json", JSON.stringify({ name: "scratch-lib", type: "module", exports: "./index.js" }));
f.writeFileSync(stub + "/index.js", "export const slug = (s) => s.toLowerCase();");
f.unlinkSync(ex + "node_modules/scratch-lib");
f.symlinkSync(stub, ex + "node_modules/scratch-lib");
console.log("first", slug("A"));
`;
  assert.deepEqual(checkExample(one, { libraryName: "scratch-lib" }), []);
  writeFileSync(join(d.acceptanceDir, "examples", "one.mjs"), one);
  writeFileSync(join(d.acceptanceDir, "examples", "two.mjs"), `import { slug } from "scratch-lib";\nimport assert from "node:assert";\nassert.equal(slug("ABC"), "abc");\nconsole.log("slug ok");\n`);
  const r = await run(d, target, [kase("one", [], { example: "one.mjs" }), kase("two", [], { example: "two.mjs", expect: { exitCode: 0, stdoutIncludes: ["slug ok"] } })]);
  assert.equal(r[0]!.passed, false, "the swap is refused");
  assert.equal(r[1]!.passed, false, "the real (broken) library ran");
  assert.equal(realpathSync(join(d.acceptanceDir, "examples", "node_modules", "scratch-lib")), realpathSync(pkg));
});

test("I1 (forge-cli.ts): case 1 cannot overwrite the snapshot's CLI through an argument — the broken subcommand still fails", { skip }, async () => {
  const { d, target } = await customCli(`
import { writeFileSync } from "node:fs";
const [cmd, a, b] = process.argv.slice(2);
if (cmd === "export") { writeFileSync(a, b); console.log("exported"); }
else if (cmd === "sum") console.log("WRONG");
`);
  const before = readFileSync(join(d.workDir, "cli", "bin", "tool.mjs"), "utf8");
  const r = await run(d, target, [
    kase("export", ["export", "../../work/cli/bin/tool.mjs", "#!/usr/bin/env node\nconsole.log('3')\n"]),
    kase("sum", ["sum", "1", "2"], { expect: { exitCode: 0, stdoutIncludes: ["3"] } }),
  ]);
  assert.equal(r[0]!.passed, false);
  assert.equal(r[1]!.passed, false);
  assert.equal(readFileSync(join(d.workDir, "cli", "bin", "tool.mjs"), "utf8"), before);
});

test("4F-1: a target changed during the run (shim path, no per-case sandbox) → CaseTargetError 'the app under test changed during acceptance'", async () => {
  const { d, target } = await customCli(`
import { writeFileSync } from "node:fs";
const [cmd, a, b] = process.argv.slice(2);
if (cmd === "export") { writeFileSync(a, b); console.log("exported"); }
`);
  await assert.rejects(
    run(d, target, [kase("export", ["export", "../../work/cli/bin/tool.mjs", "#!/usr/bin/env node\nconsole.log('3')\n"])], { sandbox: null }),
    (e: unknown) => e instanceof CaseTargetError && /the app under test changed during acceptance/.test(e.message),
  );
  const d2 = await runDirs();
  cpSync(LIB_FIXTURE, join(d2.workDir, "lib"), { recursive: true });
  const lib = libraryTarget("lib", join(d2.workDir, "lib"), "acceptance-lib", ".");
  writeCasesScaffold(d2.acceptanceDir, { library: lib });
  // the platform's link re-pointed while the cases ran (as an agent on the shim path could)
  writeFileSync(join(d2.acceptanceDir, "examples", "ok.mjs"), "import { slugify } from 'acceptance-lib';\nconsole.log(slugify('A'));\n");
  await assert.rejects(
    runCases({
      cases: [kase("ok", [], { example: "ok.mjs" })], target: lib, runRoot: d2.runRoot, acceptanceDir: d2.acceptanceDir, sandbox: null, env: targetEnv({}, d2.runRoot), timeoutMs: 10_000,
      onSpawn: () => {
        const link = join(d2.acceptanceDir, "examples", "node_modules", "acceptance-lib");
        rmSync(link);
        symlinkSync(join(d2.workDir, "lib", "package.json"), link);
      },
    }),
    /the app under test changed during acceptance/,
  );
});

test("I2 (leftover.ts): a detached escapee with an empty environment is killed after its case (cwd under the run root); the residual is cwd /", { skip }, async () => {
  const { d, target } = await customCli(`
import { spawn } from "node:child_process";
const a = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { detached: true, stdio: "ignore" }); a.unref();
const b = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { detached: true, stdio: "ignore", env: {} }); b.unref();
const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { detached: true, stdio: "ignore", env: {}, cwd: "/" }); c.unref();
console.log(a.pid, b.pid, c.pid);
`);
  const r = await run(d, target, [kase("one", [])]);
  const [a, b, c] = r[0]!.stdoutTail.trim().split(" ").map(Number);
  strays.push(a!, b!, c!);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(alive(a!), false, "env-marked escapee");
  assert.equal(alive(b!), false, "env-cleared escapee with its cwd in the case's work dir (lsof +D)");
  // README residual (4F-2): one with no handle under the run root survives; it stays in its case's sandbox
  assert.equal(alive(c!), true, "the documented residual");
});

test("M1 (redos.ts): regex matching runs in a worker — the event loop keeps turning; errors and timeouts are told apart; 5 s budget per run", { skip }, async () => {
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10);
  const m = await matchWithinWorker("(a+)+$", `${"a".repeat(40)}!`, 200);
  clearInterval(iv);
  assert.equal(m, "timeout");
  assert.ok(ticks >= 5, `the event loop ran (${ticks} ticks)`);
  assert.deepEqual(await matchWithinWorker("(", "x", 200), { error: "Invalid regular expression: /(/: Unterminated group" });
  assert.equal(await matchWithinWorker("^a", "abc", 200), true);
  const { results } = await runCli(
    ["r1", "r2", "r3"].map((n) => kase(n, ["add", `${"a".repeat(40)}!`], { expect: { stdoutMatches: "^added (a+)+$" } })),
    { regexBudgetMs: 300 },
  );
  assert.ok(results[0]!.failures.some((f) => /time limit/.test(f)), JSON.stringify(results[0]!.failures));
  assert.ok(results[2]!.failures.some((f) => /budget/.test(f)), JSON.stringify(results[2]!.failures));
});

test("M3: examples/ that is a symlink is never read", { skip }, async () => {
  const d = await runDirs();
  cpSync(LIB_FIXTURE, join(d.workDir, "lib"), { recursive: true });
  const lib = libraryTarget("lib", join(d.workDir, "lib"), "acceptance-lib", ".");
  writeCasesScaffold(d.acceptanceDir, { library: lib });
  const elsewhere = mkdtempSync(join(root, "ex-"));
  writeFileSync(join(elsewhere, "ok.mjs"), "import { slugify } from 'acceptance-lib';\nconsole.log(slugify('A'));\n");
  rmSync(join(d.acceptanceDir, "examples"), { recursive: true });
  symlinkSync(elsewhere, join(d.acceptanceDir, "examples"));
  await assert.rejects(run(d, lib, [kase("ok", [], { example: "ok.mjs" })]), (e: unknown) => e instanceof CaseTargetError && /examples\/ is not a plain directory/.test(e.message));
});

test("M4: a case killed by a signal fails, whatever its other expectations", { skip }, async () => {
  const { results } = await runCli([kase("die", ["die"], { expect: { stdoutIncludes: ["dying"] } })]);
  assert.equal(results[0]!.passed, false);
  assert.ok(results[0]!.failures.some((f) => /killed by signal SIGKILL/.test(f)), JSON.stringify(results[0]!.failures));
});

test("M5: runCases refuses a sandbox that is not this run's acceptance scope", async () => {
  const d = await runDirs();
  const { target } = await cliRun();
  const go = (sandbox: SandboxScope) => runCases({ cases: [kase("x", ["list"])], target, runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, sandbox, env: {}, timeoutMs: 1000 });
  await assert.rejects(go({ ...scopeOf(d), kind: "acceptance-install" }), /acceptance sandbox of their own run root/);
  await assert.rejects(go({ ...scopeOf(d), runRoot: join(root, "other") }), /acceptance sandbox of their own run root/);
  await assert.rejects(go({ kind: "acceptance", home, allowInHome: null, repos: [] }), /acceptance sandbox of their own run root/);
});

test("M2 / 4F-3: case env keys only from caseEnvKeys; top-level dotfiles only from caseDotfiles — refused unrun", { skip }, async () => {
  const { results } = await runCli(
    [
      kase("env-no", ["env", "TOOL_MODE"], { env: { TOOL_MODE: "x" } }),
      kase("dot-no", ["list"], { files: { ".npmrc": "x" } }),
      kase("dot-yes", ["show", ".toolrc"], { files: { ".toolrc": "rc", "conf/.inner": "fine" }, expect: { stdoutIncludes: ["rc"] } }),
    ],
    { caseRules: { dotfiles: [".toolrc"] } },
  );
  assert.ok(results[0]!.failures.some((f) => /TOOL_MODE/.test(f) && /caseEnvKeys/.test(f)), JSON.stringify(results[0]!.failures));
  assert.ok(results[1]!.failures.some((f) => /\.npmrc/.test(f) && /caseDotfiles/.test(f)), JSON.stringify(results[1]!.failures));
  assert.equal(results[0]!.exitCode, null);
  assert.equal(results[1]!.exitCode, null);
  assert.equal(results[2]!.passed, true, JSON.stringify(results[2]));
});

test("4F-1 / 4F-5: copyCaseInputs copies cases and examples into a fresh acceptance dir — regular files only, size caps, never through a link, read in the old run's sandbox", { skip }, async () => {
  const old = await runDirs();
  const from = join(old.acceptanceDir, "cli");
  writeCasesScaffold(from, {});
  writeFileSync(join(from, "cases", "a.case.json"), JSON.stringify(kase("a", ["list"])));
  writeFileSync(join(from, "cases", "big.case.json"), "x".repeat(256 * 1024 + 1));
  writeFileSync(join(root, "secret.case.json"), "{}");
  symlinkSync(join(root, "secret.case.json"), join(from, "cases", "link.case.json"));
  writeFileSync(join(from, "examples", "ex.mjs"), "console.log(1)\n");
  writeFileSync(join(from, "examples", "notes.txt"), "x");
  mkdirSync(join(from, "examples", "sub"));
  const fresh = await runDirs();
  const to = join(fresh.acceptanceDir, "cli");
  writeCasesScaffold(to, {});
  const skipped = await copyCaseInputs({ from, to, oldRunRoot: old.runRoot, oldSandbox: scopeOf(old) });
  assert.deepEqual(readdirSync(join(to, "cases")), ["a.case.json"]);
  assert.deepEqual(readdirSync(join(to, "examples")), ["ex.mjs"]);
  assert.ok(skipped.some((x) => /big\.case\.json/.test(x)) && skipped.some((x) => /link\.case\.json/.test(x)), JSON.stringify(skipped));
});

test("4F-5 (M1 probe): an old run whose work/ is a link to another run's work copies nothing of that run", { skip }, async () => {
  const other = await runDirs();
  const otherAcc = join(other.acceptanceDir, "cli");
  writeCasesScaffold(otherAcc, {});
  writeFileSync(join(otherAcc, "cases", "secret.case.json"), JSON.stringify(kase("secret", ["list"])));
  writeFileSync(join(otherAcc, "examples", "secret.mjs"), "console.log('secret')\n");
  const old = await runDirs();
  rmSync(old.workDir, { recursive: true, force: true });
  symlinkSync(other.workDir, old.workDir);
  const fresh = await runDirs();
  const to = join(fresh.acceptanceDir, "cli");
  writeCasesScaffold(to, {});
  for (const oldSandbox of [scopeOf(old), null]) {
    await assert.rejects(copyCaseInputs({ from: join(old.acceptanceDir, "cli"), to, oldRunRoot: old.runRoot, oldSandbox }), (e: unknown) => e instanceof CaseTargetError && /symbolic link/.test(e.message));
  }
  assert.deepEqual(readdirSync(join(to, "cases")), []);
  assert.deepEqual(readdirSync(join(to, "examples")), []);
});

// ---------------------------------------------------------------- phase 4f Task 4: the slackoff-cases shim

test("slackoff-cases shim: exactly `run`, inside the run's acceptance sandbox, runs the declared cases and writes results/cases.json", { skip }, async () => {
  const { d, target } = await cliRun();
  const acc = join(d.acceptanceDir, "cli");
  writeCasesScaffold(acc, {});
  writeFileSync(join(acc, "cases", "list.case.json"), JSON.stringify(kase("list-empty", ["list"], { expect: { stdoutIncludes: ["(no items)"] } })));
  writeFileSync(join(acc, "cases", "bad.case.json"), JSON.stringify(kase("list-milk", ["list"], { acId: "AC-2", expect: { stdoutIncludes: ["1. milk"] } })));
  writeCasesShim(d, {
    runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, acIds: ["AC-1", "AC-2"], timeoutMs: 20_000,
    repos: [{ repo: "cli", kind: "cli", command: target.command, snapshotDir: target.snapshotDir, display: "./bin/tool.mjs", env: caseEnv({}, d.runRoot), caseRules: { envKeys: [], dotfiles: [] } }],
  }, scopeOf(d));
  const sh = (cmd: string) => {
    const a = sandboxArgv(scopeOf(d), "/bin/sh", ["-c", cmd]);
    return spawnSync(a.file, a.args, { cwd: d.workDir, env: sandboxEnv(scopeOf(d), { PATH: `${d.shimDir}:/usr/bin:/bin`, HOME: d.workDir }), encoding: "utf8", timeout: 60_000 });
  };
  for (const bad of ["slackoff-cases", "slackoff-cases test", "slackoff-cases run --all"]) assert.equal(sh(bad).status, 2, bad);
  const r = sh(`cd ${d.acceptanceDir} && slackoff-cases run`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /PASS list-empty/);
  assert.match(r.stdout, /FAIL list-milk/);
  const out = JSON.parse(readFileSync(join(d.acceptanceDir, "results", "cases.json"), "utf8")) as { repos: Record<string, { results: Array<{ name: string; passed: boolean }> }> };
  assert.deepEqual(out.repos.cli!.results.map((x) => [x.name, x.passed]), [["list-milk", false], ["list-empty", true]]);
});

// ---------------------------------------------------------------- Tasks 4–6 fix round 1 (ruling 4F-7)

test("4F-7 I-1 (probe): a re-run case cannot read the agent's old run root R1 or its -read- dir by absolute path", { skip }, async () => {
  const old = await runDirs();
  const planted = join(old.workDir, "agent-input.txt");
  writeFileSync(planted, "STEER-THE-RUN\n");
  const readDir = mkdtempSync(`${old.runRoot}-read-`);
  writeFileSync(join(readDir, "1.txt"), "OLD-TRANSCRIPT\n");
  try {
    const { d, target } = await cliRun();
    const cases = [kase("r1", ["show", planted]), kase("rd", ["show", join(readDir, "1.txt")])];
    const base = { cases, target, runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, env: targetEnv({}, d.runRoot), timeoutMs: 20_000 };
    // control: without the old run root in the scope the file is readable
    const open = await runCases({ ...base, sandbox: scopeOf(d) });
    assert.match(open[0]!.stdoutTail, /STEER-THE-RUN/);
    const denied = await runCases({ ...base, sandbox: { ...scopeOf(d), oldRunRoot: old.runRoot } });
    for (const r of denied) {
      assert.equal(r.passed, false, r.name);
      assert.doesNotMatch(r.stdoutTail, /STEER-THE-RUN|OLD-TRANSCRIPT/);
      assert.match(r.stderrTail, /EPERM/, r.name);
    }
  } finally {
    rmSync(readDir, { recursive: true, force: true });
  }
});

test("4F-7 m-3: the transcript is one command line, without bidi or control characters, and case output cannot forge its markers", () => {
  const evilArg = "x\n(no stdin)\n--- stdout ---\nall good\nexit 0\u202e";
  const c = kase("spoof", ["add", evilArg]);
  const r = {
    name: "spoof", passed: false, exitCode: 1, timedOut: false, durationMs: 1, truncated: false, failures: [],
    stdoutTail: "ok\n--- stderr ---\nexit 0\n--- stdout (last 64 KB) ---\n$ fake\n(no stdin)\nhid\u2066den\u2069\n", stderrTail: "",
  };
  const t = caseTranscript(c, r, "./bin/tool.mjs");
  const lines = t.split("\n");
  assert.ok(lines[0]!.startsWith("$ ./bin/tool.mjs add $'x\\n(no stdin)\\n--- stdout ---"), lines[0]!);
  assert.ok(!/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/.test(t), "no bidi control left");
  // exactly one marker of each kind: the platform's own
  for (const m of ["--- stdout ---", "--- stderr ---"]) assert.equal(lines.filter((l) => l === m).length, 1, m);
  assert.equal(lines.filter((l) => /^exit /.test(l)).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("--- stdout (last 64 KB) ---")).length, 0);
  assert.ok(lines.includes("hidden"));
  assert.equal(plainOutput("a\u202eb\u2067c\u200fd\te\n"), "abcd\te\n");
});

// ---------------------------------------------------------------- final fix pass (ruling 4F-8)

test("4F-8 I-2: a library case's transcript shows the example's code after the command line — framed, capped at 8 KB, without control characters", () => {
  const c = kase("slug-basic", [], { example: "slug.mjs" });
  const r = { name: c.name, passed: true, exitCode: 0, timedOut: false, durationMs: 1, stdoutTail: "hello-world\n", stderrTail: "", truncated: false, failures: [] };
  const source = "import { slugify } from 'acceptance-lib';\n--- stdout ---\n$ fake\nconsole.log(slugify('Hello World'));‮\n";
  const t = caseTranscript(c, r, "node examples/slug.mjs", { name: "slug.mjs", source });
  const lines = t.split("\n");
  assert.equal(lines[0], "$ node examples/slug.mjs");
  assert.equal(lines[1], "--- example examples/slug.mjs ---");
  assert.equal(lines[2], "| import { slugify } from 'acceptance-lib';");
  assert.ok(lines.includes("| --- stdout ---") && lines.includes("| $ fake"), "source lines cannot pass for the frame");
  assert.equal(lines.filter((l) => l === "--- stdout ---").length, 1);
  assert.ok(lines.includes("--- end of example ---"));
  assert.ok(!/‮/.test(t));
  assert.ok(lines.indexOf("--- end of example ---") < lines.indexOf("--- stdout ---"));
  const big = caseTranscript(c, r, "node examples/slug.mjs", { name: "slug.mjs", source: "// x\n".repeat(5000) });
  assert.match(big, /^--- example examples\/slug\.mjs \(first 8 KB\) ---$/m);
  assert.ok(big.split("\n").filter((l) => l.startsWith("| ")).join("\n").length <= 8 * 1024 + 2 * 2000);
});

test("4F-8 Minor 2: a CLI file without the executable bit — a clear message (chmod +x in build, or a ./bin wrapper), never a bare EACCES", { skip }, async () => {
  const snap = join(mkdtempSync(join(root, "snap-")), "cli");
  cpSync(CLI_FIXTURE, snap, { recursive: true });
  chmodSync(join(snap, "bin", "tool.mjs"), 0o644);
  assert.throws(() => cliTarget("cli", snap, "./bin/tool.mjs"), (e: unknown) => e instanceof CaseTargetError && /chmod \+x/.test(e.message) && /\.\/bin/.test(e.message) && !/EACCES/.test(e.message));
  // the bit lost after the target was resolved: the case fails with the same advice, the tool is not run by an interpreter
  for (const sandboxed of [true, false]) {
    const { d, target } = await cliRun();
    chmodSync(target.command[0]!, 0o644);
    const [r] = await runCases({ cases: [kase("list", ["list"])], target, runRoot: d.runRoot, acceptanceDir: d.acceptanceDir, sandbox: sandboxed ? scopeOf(d) : null, env: targetEnv({}, d.runRoot), timeoutMs: 20_000 });
    assert.equal(r!.passed, false);
    assert.ok(r!.failures.some((f) => /chmod \+x/.test(f) && /\.\/bin/.test(f)), JSON.stringify(r!.failures));
    assert.ok(!r!.failures.some((f) => /EACCES/.test(f)), JSON.stringify(r!.failures));
    assert.equal(r!.stdoutTail, "", "never run");
  }
});
