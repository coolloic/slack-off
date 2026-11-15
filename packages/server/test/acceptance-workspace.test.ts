// Task 6: the acceptance workspace — a history-free export of the ticket's code, the isolation checks, the sandboxed
// `playwright` shim and its scaffold. Real temporary git repos; the shim's sandbox tests need macOS sandbox-exec.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers/tmp.ts";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Critique, DesignDoc, FetchedTicket, Requirement, Solution } from "@slackoff/shared";
import { loadConfig, type Config } from "../src/config.ts";
import { openDatabase } from "../src/db/database.ts";
import { addDesignDoc, addRound, saveRulings } from "../src/design/design-repo.ts";
import { runProcess } from "../src/git/run.ts";
import { addRequirement, currentChoice, listSolutions, recordChoice, saveSolutions } from "../src/requirements/requirement-repo.ts";
import { SANDBOX_EXEC, sandboxArgv, sandboxEnv, type SandboxScope } from "../src/sandbox/local-sandbox.ts";
import { saveSnapshot } from "../src/snapshots/snapshot-store.ts";
import { upsertDiscovered } from "../src/tickets/ticket-repo.ts";
import {
  ACCEPT_BROWSER, ACCEPT_CONFIG_ALLOWED, ACCEPT_CONFIG_DIR_MODE, ACCEPT_CONFIG_PURGE, ACCEPT_PLAYWRIGHT_LINK, AcceptanceIsolationError,
  acceptRunBase, assertAcceptanceIsolation, cleanupRunDirs, designQuoteLines, excludeDesignQuotes, exportRepo, prepareRunDirs,
  withAcceptanceConfigDir, writePlaywrightScaffold, type AcceptanceRunDirs,
} from "../src/acceptance/workspace.ts";
import { gitRepo } from "./fixtures/git-repos.ts";

const HAS_SANDBOX = process.platform === "darwin" && existsSync(SANDBOX_EXEC);
const skip = HAS_SANDBOX ? false : `needs macOS ${SANDBOX_EXEC} (platform ${process.platform})`;

const repoRoot = join(import.meta.dirname, "../../..");
const root = realpathSync(tmpDir("aw"));
const made: AcceptanceRunDirs[] = [];
after(async () => {
  for (const d of made) await cleanupRunDirs(d);
  rmSync(root, { recursive: true, force: true });
});

const home = join(root, "slackoff");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "slackoff.db"), "DB\n");
const reposDir = join(root, "repos");
mkdirSync(reposDir, { recursive: true });

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A config whose acceptance config dir is a scratch dir. */
function configWith(configDir: string): Config {
  const cfgHome = mkdtempSync(join(root, "cfg-"));
  writeFileSync(join(cfgHome, "config.json"), JSON.stringify({ acceptance: { claudeConfigDir: configDir } }));
  return loadConfig(cfgHome);
}

async function runDirs(o: { repoPaths?: string[] } = {}): Promise<AcceptanceRunDirs> {
  const configDir = join(mkdtempSync(join(root, "ccfg-")), "claude-config");
  const d = await prepareRunDirs({ home, repoPaths: o.repoPaths ?? [reposDir], config: configWith(configDir) });
  made.push(d);
  return d;
}

const LINE = "The checkout service must lock the cart row before charging the card again."; // 77 characters

// ---------------------------------------------------------------- decided values

test("decided values from Task 1", () => {
  assert.equal(ACCEPT_CONFIG_DIR_MODE, "dedicated");
  assert.deepEqual(ACCEPT_CONFIG_PURGE, ["projects", "sessions", "todos", "shell-snapshots", "session-env", "file-history", "debug", "backups"]);
  assert.deepEqual(ACCEPT_CONFIG_ALLOWED, [".claude.json", "plugins", ...ACCEPT_CONFIG_PURGE]);
  assert.equal(ACCEPT_PLAYWRIGHT_LINK, "symlink");
  assert.equal(ACCEPT_BROWSER, "chromium");
});

// ---------------------------------------------------------------- exportRepo

test("exportRepo: no .git, the files of that sha (not the working tree's changes), no tar left in the run root", async () => {
  const repo = gitRepo("shop", { "server.mjs": "v1\n", "lib/a.js": "a\n" }, mkdtempSync(join(reposDir, "x-")));
  const sha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "server.mjs"), "uncommitted\n");
  writeFileSync(join(repo, "untracked.txt"), "u\n");
  const d = await runDirs();
  const dest = join(d.workDir, "shop");
  await exportRepo(repo, sha, dest, d.runRoot);
  assert.equal(existsSync(join(dest, ".git")), false);
  assert.equal(readFileSync(join(dest, "server.mjs"), "utf8"), "v1\n");
  assert.equal(readFileSync(join(dest, "lib/a.js"), "utf8"), "a\n");
  assert.equal(existsSync(join(dest, "untracked.txt")), false);
  assert.deepEqual(readdirSync(d.runRoot).filter((n) => n.endsWith(".tar")), []);
});

test("exportRepo: an unknown or option-like sha is an AcceptanceIsolationError naming the repo; no tar left", async () => {
  const repo = gitRepo("cart", undefined, mkdtempSync(join(reposDir, "x-")));
  const d = await runDirs();
  for (const sha of ["0123456789abcdef0123456789abcdef01234567", "--output=/tmp/x", "HEAD"]) {
    await assert.rejects(exportRepo(repo, sha, join(d.workDir, "cart"), d.runRoot), (e: Error) => e instanceof AcceptanceIsolationError && /cart/.test(e.message));
  }
  assert.deepEqual(readdirSync(d.runRoot).filter((n) => n.endsWith(".tar")), []);
});

// ---------------------------------------------------------------- prepareRunDirs

test("prepareRunDirs: layout — run root a realpath outside home and repos, shim dir outside workDir, config dir purged", async () => {
  const configDir = join(mkdtempSync(join(root, "ccfg-")), "claude-config");
  mkdirSync(join(configDir, "projects/p"), { recursive: true });
  mkdirSync(join(configDir, "debug"), { recursive: true });
  mkdirSync(join(configDir, "plugins"), { recursive: true });
  writeFileSync(join(configDir, ".claude.json"), "{}");
  const d = await prepareRunDirs({ home, repoPaths: [reposDir], config: configWith(configDir) });
  made.push(d);
  assert.equal(realpathSync(d.runRoot), d.runRoot);
  assert.match(d.runRoot, /\/slackoff-accept-[A-Za-z0-9]{6}$/);
  assert.equal(d.workDir, join(d.runRoot, "work"));
  assert.equal(d.acceptanceDir, join(d.workDir, "acceptance"));
  assert.equal(d.shimDir, join(d.runRoot, "bin"));
  assert.equal(d.configDir, configDir);
  for (const p of [d.workDir, d.acceptanceDir, d.shimDir, join(d.runRoot, "tmp")]) assert.ok(statSync(p).isDirectory(), p);
  assert.equal(statSync(join(d.runRoot, "tmp")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(configDir).sort(), [".claude.json", "plugins"]);
});

test("prepareRunDirs: a tmpdir inside SLACKOFF_HOME (or a repo) is an AcceptanceIsolationError, nothing left behind", async () => {
  // a short home, so the temp dir is used as is (see acceptRunBase)
  const shortHome = realpathSync(mkdtempSync("/private/tmp/sah-"));
  const saved = process.env.TMPDIR;
  try {
    for (const [h, repos] of [[shortHome, []], [join(shortHome, "other"), [shortHome]]] as const) {
      mkdirSync(join(shortHome, "t"), { recursive: true });
      process.env.TMPDIR = join(shortHome, "t");
      await assert.rejects(prepareRunDirs({ home: h, repoPaths: repos, config: configWith(join(root, "cc-unused")) }), AcceptanceIsolationError);
      assert.deepEqual(readdirSync(join(shortHome, "t")), [], "no run root left in the temp dir");
    }
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(shortHome, { recursive: true, force: true });
  }
});

test("acceptRunBase T6-1: <runRoot>/tmp plus a Chromium-style SingletonSocket path fits sun_path (≤ 103 bytes + NUL)", async () => {
  const chromium = ".org.chromium.Chromium.AbCdEf/SingletonSocket";
  // this machine's temp dir, a macOS-style per-user temp dir (too long: falls back to /tmp) and a short one
  for (const t of [tmpdir(), "/var/folders/p9/t73r6_h94p5fzstn96r5xkrc0000gn/T", "/tmp"]) {
    const base = acceptRunBase(t);
    const p = join(base, "slackoff-accept-AbCdEf", "tmp", chromium);
    assert.ok(Buffer.byteLength(p) <= 103, `${p}: ${Buffer.byteLength(p)} bytes`);
  }
  assert.equal(acceptRunBase("/tmp"), realpathSync("/tmp"));
  const d = await runDirs();
  const p = join(d.runRoot, "tmp", chromium);
  assert.ok(Buffer.byteLength(p) <= 103, `${p}: ${Buffer.byteLength(p)} bytes`);
});

// ---------------------------------------------------------------- withAcceptanceConfigDir

test("withAcceptanceConfigDir: concurrent calls run one at a time (a failure does not block the next)", async () => {
  const events: string[] = [];
  const job = (name: string, fail = false) => async () => {
    events.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, 30));
    events.push(`${name}:end`);
    if (fail) throw new Error(name);
    return name;
  };
  const results = await Promise.allSettled([withAcceptanceConfigDir(job("a", true)), withAcceptanceConfigDir(job("b")), withAcceptanceConfigDir(job("c"))]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  assert.equal(results[0]!.status, "rejected");
  assert.deepEqual(results.slice(1).map((r) => (r as PromiseFulfilledResult<string>).value), ["b", "c"]);
});

// ---------------------------------------------------------------- assertAcceptanceIsolation

const sandboxFor = (d: AcceptanceRunDirs, repos: string[] = [reposDir]): SandboxScope => ({ kind: "acceptance", home, allowInHome: null, repos, runRoot: d.runRoot });

async function scaffolded(): Promise<AcceptanceRunDirs> {
  const d = await runDirs();
  mkdirSync(join(d.workDir, "shop/src"), { recursive: true });
  writeFileSync(join(d.workDir, "shop/src/a.js"), "a\n");
  symlinkSync("a.js", join(d.workDir, "shop/src/b.js"));
  mkdirSync(d.configDir, { recursive: true });
  writeFileSync(join(d.configDir, ".claude.json"), "{}");
  writePlaywrightScaffold(d, repoRoot, [{ repo: "shop", entry: "web", baseUrl: "http://127.0.0.1:3999", started: true, detail: "" }], sandboxFor(d));
  return d;
}
const iso = (d: AcceptanceRunDirs) => assertAcceptanceIsolation(d, { home, repoPaths: [reposDir], repoRoot, quotes: [LINE] });

test("assertAcceptanceIsolation: a normal layout passes with the named checks", async () => {
  const d = await scaffolded();
  const checks = iso(d);
  for (const c of ["no-git", "no-db", "no-escaping-links", "config-dir-allowlist"]) assert.ok(checks.includes(c), checks.join(" "));
});

test("assertAcceptanceIsolation: .git, databases, escaping links, extra config entries and design text in the config dir are violations", async () => {
  const cases: Array<[string, (d: AcceptanceRunDirs) => void, RegExp]> = [
    ["git dir", (d) => mkdirSync(join(d.workDir, "x/.git"), { recursive: true }), /x\/\.git/],
    ["git file", (d) => writeFileSync(join(d.workDir, "shop/.git"), "gitdir: /elsewhere\n"), /shop\/\.git/],
    ["sqlite", (d) => writeFileSync(join(d.workDir, "a.sqlite"), ""), /a\.sqlite/],
    ["db wal", (d) => writeFileSync(join(d.workDir, "shop/data.db-wal"), ""), /data\.db-wal/],
    ["link to home", (d) => symlinkSync(home, join(d.workDir, "link")), /work\/link/],
    ["relative link out", (d) => symlinkSync("../../..", join(d.workDir, "shop/up")), /shop\/up/],
    ["settings.json", (d) => writeFileSync(join(d.configDir, "settings.json"), "{}"), /settings\.json/],
    ["design line", (d) => { mkdirSync(join(d.configDir, "projects"), { recursive: true }); writeFileSync(join(d.configDir, "projects/x.jsonl"), `{"t":"${LINE}"}\n`); }, /projects\/x\.jsonl/],
  ];
  for (const [name, plant, re] of cases) {
    const d = await scaffolded();
    plant(d);
    assert.throws(() => iso(d), (e: Error) => e instanceof AcceptanceIsolationError && re.test(e.message), name);
  }
});

test("assertAcceptanceIsolation: the @playwright/test link may point into <repoRoot>/node_modules only", async () => {
  const d = await scaffolded();
  const link = join(d.acceptanceDir, "node_modules/@playwright/test");
  assert.equal(readlinkSync(link), join(repoRoot, "node_modules/@playwright/test"));
  rmSync(link);
  symlinkSync(join(repoRoot, "packages"), link);
  assert.throws(() => iso(d), AcceptanceIsolationError);
});

// ---------------------------------------------------------------- excludeDesignQuotes / designQuoteLines

test("excludeDesignQuotes: new text files quoting the design are removed (whatever .gitattributes says); code and base files are kept", async () => {
  const repo = gitRepo("shop", { "README.md": `# shop\n${LINE}\n`, "src/main.js": "x\n" }, mkdtempSync(join(reposDir, "x-")));
  const baseFiles = new Set(git(repo, "ls-tree", "-r", "--name-only", "main").split("\n"));
  git(repo, "checkout", "-q", "-b", "slackoff/T-1");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs/notes.md"), `# Notes\n\n   ${LINE}   \n`);
  writeFileSync(join(repo, "docs/short.txt"), "The checkout service must lock the cart row.\n");
  writeFileSync(join(repo, "src/a.js"), `// ${LINE}\n`);
  writeFileSync(join(repo, ".gitattributes"), "docs/** export-ignore\ndocs/notes.md -export-ignore\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "work");
  const d = await runDirs();
  const dest = join(d.workDir, "shop");
  await exportRepo(repo, git(repo, "rev-parse", "HEAD"), dest, d.runRoot);
  assert.ok(existsSync(join(dest, "docs/notes.md")), "exported despite the docs/** export-ignore");
  const removed = await excludeDesignQuotes(dest, baseFiles, [LINE, "too short to count"]);
  assert.deepEqual(removed, ["docs/notes.md"]);
  assert.equal(existsSync(join(dest, "docs/notes.md")), false);
  assert.ok(existsSync(join(dest, "src/a.js")), "code is kept");
  assert.ok(existsSync(join(dest, "README.md")), "a base-branch file is kept");
  assert.equal(await excludeDesignQuotes(dest, baseFiles, ["The checkout service must lock the cart row."]).then((r) => r.length), 0, "quotes under 60 characters are ignored");
});

test("designQuoteLines: ≥60-character lines of the current choice's design docs, debate, approach, choice note and rulings (deduplicated)", () => {
  const db = openDatabase(":memory:");
  const tHome = mkdtempSync(join(root, "dq-"));
  upsertDiscovered(db, { key: "T-1", title: "Title", url: "http://j/T-1", status: "To Do" }, false);
  const f: FetchedTicket = { loginRequired: false, key: "T-1", title: "Title", description: "d", jiraUpdatedAt: null, status: null, comments: [], attachments: [] };
  const { snapshotId } = saveSnapshot(db, tHome, "T-1", f);
  const req: Requirement = {
    background: "bg", functional: [{ id: "F1", text: "f" }],
    acceptanceCriteria: [{ id: "AC1", text: "a", verifiable: true, source: { type: "description", ref: "desc", quote: "q" } }],
    discussionOutcomes: [], openQuestions: [], draftComment: null,
  };
  const L = (s: string) => `${s} ${"x".repeat(60)}`;
  const sol = (approach: string): Solution => ({
    title: "s", approach, changeScope: [], pros: [], cons: [], risks: [], complexity: "S",
    affectedRepos: ["api"], repoChanges: [{ repo: "api", summary: "x" }],
  });
  const { id: requirementId } = addRequirement(db, "T-1", snapshotId, req, "agent");
  saveSolutions(db, "T-1", requirementId, [sol(`short\n${L("approach")}`), sol(L("other approach"))]);
  const [s0] = listSolutions(db, "T-1");
  recordChoice(db, "T-1", s0!.id, L("old note"), ["api"]);
  const oldChoice = currentChoice(db, "T-1")!.id;
  const doc = (md: string, repoMd: string, reason?: string): DesignDoc => ({
    contentMd: md, repos: [{ repo: "api", contentMd: repoMd }], checklist: [{ item: "Q01", status: "considered", conclusion: "ok" }],
    responses: reason ? [{ commentId: "C-1", verdict: "rebutted", reason }] : [],
  });
  addDesignDoc(db, "T-1", { requirementId, choiceId: oldChoice, doc: doc(L("old design"), "short") });
  recordChoice(db, "T-1", s0!.id, `${L("choice note")}\n${L("choice note")}`, ["api"]);
  const choiceId = currentChoice(db, "T-1")!.id;
  const d = addDesignDoc(db, "T-1", { requirementId, choiceId, doc: doc(`# Design\n${L("design")}\n  ${L("indented")}  `, L("repo section"), L("doc response")) });
  const critique: Critique = {
    comments: [{ id: "C-1", checklistItem: "Q01", repo: null, blocking: true, text: L("critic"), suggestion: L("suggestion") }],
    coverage: [{ item: "Q01", status: "concern", note: "n" }],
  };
  const r = addRound(db, "T-1", { choiceId, designDocId: d.id, round: 1, role: "critic", content: critique });
  addRound(db, "T-1", { choiceId, designDocId: d.id, round: 1, role: "designer", content: { responses: [{ commentId: "C-1", verdict: "accepted", reason: L("designer reply") }] } });
  saveRulings(db, "T-1", r.id, [{ commentId: "C-1", decision: "custom", note: L("ruling") }], "local");
  const lines = designQuoteLines(db, "T-1");
  for (const s of ["approach", "choice note", "design", "indented", "repo section", "doc response", "critic", "suggestion", "designer reply", "ruling"]) {
    assert.ok(lines.includes(L(s)), `${s}: ${lines.join("\n")}`);
  }
  for (const s of ["old design", "old note", "other approach"]) assert.ok(!lines.includes(L(s)), s);
  assert.ok(!lines.includes("short") && !lines.includes("# Design"));
  assert.equal(new Set(lines).size, lines.length);
  assert.deepEqual(designQuoteLines(db, "NOPE-1"), []);
});

// ---------------------------------------------------------------- scaffold and shim

test("writePlaywrightScaffold: config (chromium only, no channel, first web target), specs/evidence, the @playwright/test link, a 0755 shim", async () => {
  const d = await runDirs();
  writePlaywrightScaffold(
    d,
    repoRoot,
    [
      { repo: "api", entry: "api", baseUrl: "http://127.0.0.1:3001", started: true, detail: "" },
      { repo: "web", entry: "web", baseUrl: "http://localhost:3002/app", started: true, detail: "" },
    ],
    sandboxFor(d),
  );
  const cfg = readFileSync(join(d.acceptanceDir, "playwright.config.mjs"), "utf8");
  const parsed = JSON.parse(cfg.slice(cfg.indexOf("{"), cfg.lastIndexOf("}") + 1)) as Record<string, any>;
  assert.equal(parsed.testDir, "specs");
  assert.equal(parsed.outputDir, "artifacts");
  assert.deepEqual(parsed.reporter, [["json", { outputFile: "results.json" }]]);
  assert.equal(parsed.workers, 1);
  assert.deepEqual(parsed.use, { baseURL: "http://localhost:3002/app", screenshot: "on" });
  assert.deepEqual(parsed.projects, [{ name: "chromium", use: { browserName: "chromium" } }]);
  assert.doesNotMatch(cfg, /channel|userDataDir|launchOptions|webServer|globalSetup/);
  assert.ok(statSync(join(d.acceptanceDir, "specs")).isDirectory() && statSync(join(d.acceptanceDir, "evidence")).isDirectory());
  assert.ok(lstatSync(join(d.acceptanceDir, "node_modules/@playwright/test")).isSymbolicLink());
  const shim = join(d.shimDir, "playwright");
  assert.equal(statSync(shim).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(d.shimDir), ["playwright"]);
  const body = readFileSync(shim, "utf8");
  assert.match(body, /^#!\/bin\/sh\n/);
  // T6-3: no nested sandbox-exec (the caller's wrapper is the sandbox); I2: a fixed environment under env -i
  assert.ok(!body.includes("sandbox-exec"), body);
  assert.ok(body.includes(`cd '${d.acceptanceDir}' || exit 2`), body);
  assert.match(body, /\nexec \/usr\/bin\/env -i PATH='[^']+' HOME='[^']+' /);
  assert.ok(body.includes(`PATH='${dirname(process.execPath)}:/usr/bin:/bin'`), body);
  assert.ok(body.includes(`'${join(repoRoot, "node_modules/.bin/playwright")}' 'test'\n`), body);
  for (const k of ["TMPDIR", "TMP", "TEMP"]) assert.ok(body.includes(` ${k}='${join(d.runRoot, "tmp")}'`), `T6-1: the run's own ${k}`);
  // only an acceptance scope; a quote in any argument is refused
  assert.throws(() => writePlaywrightScaffold(d, repoRoot, [], { ...sandboxFor(d), kind: "acceptance-install" }), AcceptanceIsolationError);
  assert.throws(() => writePlaywrightScaffold(d, join(root, "it's"), [], sandboxFor(d)), AcceptanceIsolationError);
});

test("shim: anything but exactly `test` exits 2 without running anything", async () => {
  const d = await runDirs();
  writePlaywrightScaffold(d, repoRoot, [], sandboxFor(d));
  const shim = join(d.shimDir, "playwright");
  for (const args of [["test", "--config", "../x"], [], ["--version"], ["test", "--ui"], ["install"]]) {
    const r = await runProcess(shim, args, { cwd: d.acceptanceDir, timeoutMs: 10_000 });
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout} ${r.stderr}`);
    assert.match(r.stderr, /playwright test/);
  }
});

/** A free loopback port (bound then released). */
async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

test("shim (run through sandboxArgv, as the acceptance wrapper will): reading SLACKOFF_HOME's DB, connecting to 4317 and touching the shim fail with EPERM; no caller secrets in the env; the browser starts and the fixture app spec passes", { skip, timeout: 180_000 }, async () => {
  const port = await freePort();
  const app = spawn(process.execPath, [join(import.meta.dirname, "fixtures/acceptance-app/server.mjs")], {
    env: { PATH: dirname(process.execPath), PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  try {
    await new Promise<void>((res, rej) => {
      app.stdout!.on("data", (b: Buffer) => b.toString().includes("listening") && res());
      app.once("exit", (c) => rej(new Error(`fixture app exited ${c}`)));
    });
    const d = await runDirs();
    writePlaywrightScaffold(d, repoRoot, [{ repo: "shop", entry: "web", baseUrl: `http://127.0.0.1:${port}`, started: true, detail: "" }], sandboxFor(d));
    writeFileSync(
      join(d.acceptanceDir, "specs/probe.spec.mjs"),
      `import { test, expect } from '@playwright/test';
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
const SHIM_DIR = ${JSON.stringify(d.shimDir)};
test('reads the db', async () => { readFileSync(${JSON.stringify(join(home, "slackoff.db"))}); });
test('connects to 4317', async () => {
  const r = await new Promise((res) => { const s = connect(4317, '127.0.0.1'); s.on('connect', () => { s.destroy(); res('CONNECTED'); }); s.on('error', (e) => res(e.code)); });
  expect(r).toBe('CONNECTED');
});
test('rewrites the shim', async () => {
  const shim = SHIM_DIR + '/playwright';
  const out = [];
  for (const [k, f] of [['write', () => writeFileSync(shim, '#!/bin/sh\\ncat x\\n')], ['rename', () => renameSync(shim, shim + '.x')], ['chmod', () => chmodSync(shim, 0o777)], ['rm', () => rmSync(shim)], ['add', () => writeFileSync(shim + '2', 'x')]]) {
    try { f(); out.push(k + ':OK'); } catch (e) { out.push(k + ':' + e.code); }
  }
  test.info().annotations.push({ type: 'shim', description: out.join(' ') });
});
test('shop page', async ({ page }) => {
  test.info().annotations.push({ type: 'tmpdir', description: process.env.TMPDIR });
  test.info().annotations.push({ type: 'env', description: Object.keys(process.env).sort().join(' ') });
  await page.goto('/');
  await expect(page.getByRole('heading')).toHaveText('Shop');
  await expect(page.getByRole('button', { name: 'Buy' })).toBeVisible();
});
`,
    );
    const shimBefore = readFileSync(join(d.shimDir, "playwright"), "utf8");
    // the caller's environment carries secrets: the shim's env -i must drop them (I2)
    const caller = {
      PATH: `${d.shimDir}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: process.env.HOME, USER: process.env.USER, CLAUDE_CONFIG_DIR: d.configDir,
      GH_TOKEN: "fake-gh", NPM_TOKEN: "fake-npm", AWS_SECRET_ACCESS_KEY: "fake-aws", AWS_PROFILE: "fake", SLACKOFF_HOME: home,
    };
    const scope = sandboxFor(d);
    const argv = sandboxArgv(scope, join(d.shimDir, "playwright"), ["test"]);
    const r = await runProcess(argv.file, argv.args, { cwd: d.workDir, timeoutMs: 150_000, tailBytes: 16_000, env: sandboxEnv(scope, caller) });
    const results = JSON.parse(readFileSync(join(d.acceptanceDir, "results.json"), "utf8")) as {
      suites: Array<{ specs: Array<{ title: string; tests: Array<{ annotations: Array<{ type: string; description: string }>; results: Array<{ status: string; error?: { message?: string } }> }> }> }>;
    };
    const specs = new Map(results.suites.flatMap((s) => s.specs).map((s) => [s.title, s.tests[0]!] as const));
    const status = (t: string) => specs.get(t)?.results[0]?.status;
    const message = (t: string) => specs.get(t)?.results[0]?.error?.message ?? "";
    assert.equal(status("shop page"), "passed", r.tail);
    assert.equal(status("reads the db"), "failed");
    assert.match(message("reads the db"), /EPERM/);
    assert.equal(status("connects to 4317"), "failed");
    assert.match(message("connects to 4317"), /EPERM/);
    const note = (t: string, type: string) => specs.get(t)!.annotations.find((a) => a.type === type)?.description ?? "";
    assert.equal(note("shop page", "tmpdir"), join(d.runRoot, "tmp"), "T6-1: TMPDIR is the run's tmp dir");
    const keys = note("shop page", "env").split(" ");
    for (const k of ["GH_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_PROFILE", "SLACKOFF_HOME", "CLAUDE_CONFIG_DIR"]) assert.ok(!keys.includes(k), `${k} leaked: ${keys.join(" ")}`);
    // C1: spec code cannot touch the shim the platform runs outside the sandbox
    assert.equal(note("rewrites the shim", "shim"), "write:EPERM rename:EPERM chmod:EPERM rm:EPERM add:EPERM");
    assert.equal(readFileSync(join(d.shimDir, "playwright"), "utf8"), shimBefore);
    assert.deepEqual(readdirSync(d.shimDir), ["playwright"]);
    assert.notEqual(r.code, 0);
  } finally {
    try {
      process.kill(-app.pid!, "SIGKILL");
    } catch {
      // gone
    }
  }
});

test("cleanupRunDirs: removes the run root and the config dir's purge folders, keeps the login", async () => {
  const d = await runDirs();
  mkdirSync(join(d.configDir, "sessions/s"), { recursive: true });
  mkdirSync(join(d.configDir, "plugins"), { recursive: true });
  writeFileSync(join(d.configDir, ".claude.json"), "{}");
  await cleanupRunDirs(d);
  assert.equal(existsSync(d.runRoot), false);
  assert.deepEqual(readdirSync(d.configDir).sort(), [".claude.json", "plugins"]);
});

// ---------------------------------------------------------------- fix round 1 (rulings T6-4, T6-5, T6-6)

test("exportRepo T6-6: blobs from ls-tree + cat-file — export-subst and export-ignore have no effect; bytes, symlinks and the executable bit kept; blob ids returned", async () => {
  const repo = gitRepo("subst", { "README.md": "r\n" }, mkdtempSync(join(reposDir, "x-")));
  const bin = Buffer.alloc(300_000);
  for (let i = 0; i < bin.length; i++) bin[i] = (i * 7919) % 256;
  mkdirSync(join(repo, "bin"), { recursive: true });
  mkdirSync(join(repo, "dir with space"), { recursive: true });
  writeFileSync(join(repo, "v.txt"), "msg: $Format:%B$ id: $Format:%H$\n");
  writeFileSync(join(repo, "hidden.md"), "hidden\n");
  writeFileSync(join(repo, ".gitattributes"), "v.txt export-subst\nhidden.md export-ignore\n");
  writeFileSync(join(repo, "bin/run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  writeFileSync(join(repo, "blob.bin"), bin);
  writeFileSync(join(repo, "dir with space/ü n.txt"), "unicode\n");
  writeFileSync(join(repo, "empty.txt"), "");
  symlinkSync("v.txt", join(repo, "link"));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", `design: ${LINE}`);
  const sha = git(repo, "rev-parse", "HEAD");
  const d = await runDirs();
  const dest = join(d.workDir, "subst");
  const manifest = await exportRepo(repo, sha, dest, d.runRoot);
  const blob = (p: string) => execFileSync("git", ["-C", repo, "cat-file", "blob", `${sha}:${p}`]);
  assert.deepEqual(readFileSync(join(dest, "v.txt")), blob("v.txt"), "byte-identical: no $Format$ expansion (the commit message stays out)");
  assert.doesNotMatch(readFileSync(join(dest, "v.txt"), "utf8"), /design:/);
  assert.ok(existsSync(join(dest, "hidden.md")), "export-ignore has no effect");
  assert.deepEqual(readFileSync(join(dest, "blob.bin")), bin);
  assert.equal(readFileSync(join(dest, "dir with space/ü n.txt"), "utf8"), "unicode\n");
  assert.equal(readFileSync(join(dest, "empty.txt"), "utf8"), "");
  assert.ok(lstatSync(join(dest, "link")).isSymbolicLink());
  assert.equal(readlinkSync(join(dest, "link")), "v.txt");
  assert.equal(statSync(join(dest, "bin/run.sh")).mode & 0o111, 0o111, "executable kept");
  assert.equal(statSync(join(dest, "v.txt")).mode & 0o111, 0, "not executable");
  assert.equal(existsSync(join(dest, ".git")), false);
  assert.equal(manifest.get(join(dest, "v.txt")), git(repo, "rev-parse", `${sha}:v.txt`));
  assert.equal(manifest.get(join(dest, "blob.bin")), git(repo, "rev-parse", `${sha}:blob.bin`));
  assert.equal(manifest.get(join(dest, "link")), git(repo, "rev-parse", `${sha}:link`), "symlinks are in the manifest too (T6-7)");
  assert.deepEqual(readdirSync(d.runRoot).filter((n) => !["work", "bin", "tmp"].includes(n)), [], "no scratch files left in the run root");
});

test("excludeDesignQuotes T6-4: .mdx/.markdown/.html/.json/.yaml and extensionless text files too; whitespace-normalized; binaries and code kept", async () => {
  const dest = mkdtempSync(join(root, "dq4-"));
  const words = LINE.split(" ");
  const reflowed = `${words.slice(0, 6).join("  ")}\n   ${words.slice(6).join(" \t")}`;
  const files: Record<string, string | Buffer> = {
    "docs/a.mdx": `# x\n${LINE}\n`,
    "docs/b.markdown": `${LINE}\n`,
    "site/c.html": `<p>${LINE}</p>`,
    "notes.json": JSON.stringify({ text: LINE }),
    "conf/d.yaml": `note: ${LINE}\n`,
    "conf/e.yml": `note: >\n  ${reflowed}\n`,
    NOTES: `notes\n${reflowed}\n`,
    "BINARY": Buffer.concat([Buffer.from(LINE), Buffer.from([0, 1, 2])]),
    "src/a.ts": `// ${LINE}\n`,
    "page.htm": "nothing here\n",
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dest, p)), { recursive: true });
    writeFileSync(join(dest, p), c);
  }
  const removed = await excludeDesignQuotes(dest, new Set(), [`  ${words.join("   ")}  `]);
  assert.deepEqual(removed, ["NOTES", "conf/d.yaml", "conf/e.yml", "docs/a.mdx", "docs/b.markdown", "notes.json", "site/c.html"]);
  for (const kept of ["BINARY", "src/a.ts", "page.htm"]) assert.ok(existsSync(join(dest, kept)), kept);
});

test("assertAcceptanceIsolation T6-5: a database file committed on the exported sha passes no-db; a changed or new one fails", async () => {
  const repo = gitRepo("dbfix", { "fixtures/seed.db": "SQLite format 3\0seed", "src/a.js": "a\n" }, mkdtempSync(join(reposDir, "x-")));
  const d = await scaffolded();
  const dest = join(d.workDir, "dbfix");
  const exported = await exportRepo(repo, git(repo, "rev-parse", "HEAD"), dest, d.runRoot);
  const checks = assertAcceptanceIsolation(d, { home, repoPaths: [reposDir], repoRoot, quotes: [LINE], exported });
  assert.ok(checks.includes("no-db"), checks.join(" "));
  assert.throws(() => iso(d), /no-db: .*seed\.db/, "without the export's blob ids it is just a database");
  writeFileSync(join(dest, "fixtures/new.sqlite"), "x");
  assert.throws(() => assertAcceptanceIsolation(d, { home, repoPaths: [reposDir], repoRoot, quotes: [LINE], exported }), /no-db: .*new\.sqlite/);
  rmSync(join(dest, "fixtures/new.sqlite"));
  writeFileSync(join(dest, "fixtures/seed.db"), "SQLite format 3\0changed");
  assert.throws(() => assertAcceptanceIsolation(d, { home, repoPaths: [reposDir], repoRoot, quotes: [LINE], exported }), /no-db: .*seed\.db/);
});

test("assertAcceptanceIsolation M6: any symlink in the config dir is a violation, and what it points to is scanned for design text", async () => {
  const d = await scaffolded();
  symlinkSync(".claude.json", join(d.configDir, "plugins-link"));
  assert.throws(() => iso(d), /config-dir-no-links: .*plugins-link/);
  rmSync(join(d.configDir, "plugins-link"));
  const outside = join(root, "design-outside.txt");
  writeFileSync(outside, `${LINE}\n`);
  mkdirSync(join(d.configDir, "plugins"), { recursive: true });
  symlinkSync(outside, join(d.configDir, "plugins/x"));
  assert.throws(() => iso(d), (e: Error) => /config-dir-no-links/.test(e.message) && /config-dir-no-design-text: .*plugins\/x/.test(e.message));
});

// ---------------------------------------------------------------- fix round 2 (ruling T6-7)

test("exportRepo T6-7 (M2): one blob used as a symlink and as a regular file exports as both; both in the manifest", async () => {
  const repo = gitRepo("mixed", { "v.txt": "v\n" }, mkdtempSync(join(reposDir, "x-")));
  // the symlink's blob is its target "v.txt" (no newline); a file with exactly that content shares the blob
  symlinkSync("v.txt", join(repo, "lnk"));
  writeFileSync(join(repo, "same.txt"), "v.txt");
  writeFileSync(join(repo, "zz-same.sh"), "v.txt", { mode: 0o755 });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "mixed");
  const sha = git(repo, "rev-parse", "HEAD");
  assert.equal(git(repo, "rev-parse", `${sha}:lnk`), git(repo, "rev-parse", `${sha}:same.txt`), "precondition: one blob");
  const d = await runDirs();
  const dest = join(d.workDir, "mixed");
  const manifest = await exportRepo(repo, sha, dest, d.runRoot);
  assert.ok(lstatSync(join(dest, "lnk")).isSymbolicLink());
  assert.equal(readlinkSync(join(dest, "lnk")), "v.txt");
  for (const f of ["same.txt", "zz-same.sh"]) {
    assert.ok(lstatSync(join(dest, f)).isFile(), f);
    assert.equal(readFileSync(join(dest, f), "utf8"), "v.txt");
  }
  assert.equal(statSync(join(dest, "zz-same.sh")).mode & 0o111, 0o111);
  assert.equal(statSync(join(dest, "same.txt")).mode & 0o111, 0);
  for (const p of ["lnk", "same.txt", "zz-same.sh", "v.txt"]) assert.ok(manifest.has(join(dest, p)), p);
});

test("exportRepo T6-7 (M5): paths that collide on a case-insensitive file system are an AcceptanceIsolationError", async () => {
  const repo = gitRepo("cases", undefined, mkdtempSync(join(reposDir, "x-")));
  const a = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: "upper\n", encoding: "utf8" }).trim();
  const b = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: "lower\n", encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["-C", repo, "mktree"], { input: `100644 blob ${a}\tREADME.MD\n100644 blob ${b}\treadme.md\n`, encoding: "utf8" }).trim();
  const sha = execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", tree, "-m", "cases"], { encoding: "utf8" }).trim();
  const d = await runDirs();
  const probe = join(d.runRoot, "CaseProbe");
  writeFileSync(probe, "");
  const insensitive = existsSync(join(d.runRoot, "caseprobe"));
  rmSync(probe);
  const dest = join(d.workDir, "cases");
  if (insensitive) {
    await assert.rejects(exportRepo(repo, sha, dest, d.runRoot), (e: Error) => e instanceof AcceptanceIsolationError && /cases/.test(e.message) && /readme\.md/i.test(e.message));
  } else {
    const m = await exportRepo(repo, sha, dest, d.runRoot);
    assert.equal(m.size, 2);
  }
});

test("exportRepo T6-7 (M2): an entry that ends up missing is reported", async () => {
  // a tree entry whose blob does not exist in the repo: cat-file answers "missing", nothing is written for it
  const repo = gitRepo("gone", undefined, mkdtempSync(join(reposDir, "x-")));
  const bogus = "0123456789abcdef0123456789abcdef01234567";
  const tree = execFileSync("git", ["-C", repo, "mktree", "--missing"], { input: `100644 blob ${bogus}\tghost.txt\n`, encoding: "utf8" }).trim();
  const sha = execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit-tree", tree, "-m", "gone"], { encoding: "utf8" }).trim();
  const d = await runDirs();
  await assert.rejects(exportRepo(repo, sha, join(d.workDir, "gone"), d.runRoot), (e: Error) => e instanceof AcceptanceIsolationError && /ghost\.txt/.test(e.message));
});

test("T6-7 (M3): the acceptance sources hold no raw NUL, tab or carriage-return characters", () => {
  for (const f of ["workspace.ts", "app-runner.ts"]) {
    const src = readFileSync(join(import.meta.dirname, "../src/acceptance", f));
    for (const [name, byte] of [["NUL", 0], ["tab", 9], ["CR", 13]] as const) assert.equal(src.indexOf(byte), -1, `${f}: raw ${name}`);
  }
});

test("phase 4a Task 7 item 2: acceptRunBase never returns a dir under /private/tmp/claude-* (a server started from a Claude Code shell)", () => {
  for (const t of ["/private/tmp/claude-abc", "/private/tmp/claude-501/x/y", "/tmp/claude-abc"]) {
    const base = acceptRunBase(t);
    assert.ok(!base.startsWith("/private/tmp/claude-") && !base.startsWith("/tmp/claude-"), `${t} -> ${base}`);
  }
});
