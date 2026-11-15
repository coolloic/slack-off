// Task 7: the acceptance spec guard — a static scan of the agent's Playwright specs (defense in depth only: the real
// read / connect limits come from the acceptance sandbox every Bash command runs in) and the Bash PreToolUse hook.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./helpers/tmp.ts";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptCommandForms, caseCommandForms } from "../src/executor/sandbox.ts";
import { casesScaffoldDigest, caseViolations, checkExample, SPEC_GUARD_SCRIPT, scaffoldDigest, specGuardSelfCheck, specGuardSettings, specViolations } from "../src/acceptance/spec-guard.ts";

const repoRoot = join(import.meta.dirname, "../../..");
const root = realpathSync(tmpDir("sg"));
after(() => rmSync(root, { recursive: true, force: true }));

const CLEAN_SPEC = `import { test, expect } from '@playwright/test';
import { openOrders } from './helpers.mjs';

// Opens the orders page with a relative path only
test('AC-1: orders are listed', async ({ page }) => {
  await openOrders(page);
  await page.goto('/orders');
  await expect(page.getByRole('heading')).toHaveText("Orders");
});
`;
const HELPERS = `export async function openOrders(page) {\n  await page.goto('/orders?x=1');\n}\n`;

let n = 0;
/** A fresh work dir with the scaffold (config, node_modules link, evidence) and `specs` = the given files. */
function workDir(specs: Record<string, string> = { "a.spec.mjs": CLEAN_SPEC, "helpers.mjs": HELPERS }): { work: string; acc: string } {
  const work = join(root, `w${n++}`, "work");
  const acc = join(work, "acceptance");
  mkdirSync(join(acc, "specs"), { recursive: true });
  mkdirSync(join(acc, "evidence"), { recursive: true });
  writeFileSync(join(acc, "playwright.config.mjs"), "export default {};\n");
  mkdirSync(join(acc, "node_modules", "@playwright"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules", "@playwright", "test"), join(acc, "node_modules", "@playwright", "test"));
  for (const [name, body] of Object.entries(specs)) {
    mkdirSync(join(acc, "specs", name, ".."), { recursive: true });
    writeFileSync(join(acc, "specs", name), body);
  }
  return { work, acc };
}
const one = (body: string) => workDir({ "x.spec.mjs": `import { test } from '@playwright/test';\n${body}\n` }).acc;

test("specViolations: a clean spec importing only @playwright/test and ./helpers.mjs, with relative URLs, has none", () => {
  assert.deepEqual(specViolations(workDir().acc), []);
});

test("specViolations: each forbidden form gives exactly one violation", () => {
  const cases: Array<[string, string]> = [
    ["node:fs import", "import fs from 'node:fs';"],
    ["dynamic import", "test('x', async () => { await import('fs'); });"],
    ["process", "test('x', async () => { console.log(process.env.SLACKOFF_HOME); });"],
    ["globalThis dodge", `test('x', async () => { globalThis["pro"+"cess"]; });`],
    ["persistent context", "import { chromium } from '@playwright/test';\ntest('x', async () => { await chromium.launchPersistentContext('/x'); });"],
    ["channel", "test.use({channel: 'chrome'});"],
    ["launchOptions", "test.use({launchOptions: {}});"],
    ["server URL", "test('x', async ({ page }) => { await page.goto('http://127.0.0.1:4317/api/config'); });"],
    ["file URL", "test('x', async ({ page }) => { await page.goto('file:///etc/hosts'); });"],
    ["require", "const x = require('child_process');"],
    ["eval", "eval('1');"],
    ["Function", "new Function('return 1')();"],
    ["connectOverCDP", "import { chromium } from '@playwright/test';\nchromium.connectOverCDP('ws://x');"],
    ["webkit", "import { webkit } from '@playwright/test';"],
    ["localhost", "test('x', async ({ page }) => { await page.goto('localhost:3000'); });"],
    ["ipv6 loopback", "const u = '[::1]';"],
    ["storageState", "test.use({ storageState: 'x.json' });"],
  ];
  for (const [what, body] of cases) {
    const v = specViolations(one(body));
    assert.equal(v.length, 1, `${what}: ${JSON.stringify(v)}`);
    assert.match(v[0]!, /^specs\/x\.spec\.mjs: /, what);
  }
  // an import from outside specs, even a relative one
  const outside = specViolations(workDir({ "x.spec.mjs": "import x from '../../shop/src/a.js';\n" }).acc);
  assert.equal(outside.length, 1, JSON.stringify(outside));
  assert.match(outside[0]!, /import/);
  // a relative .mjs import that leaves specs
  assert.equal(specViolations(workDir({ "x.spec.mjs": "import x from '../playwright.config.mjs';\n" }).acc).length, 1);
});

test("specViolations: every entry under specs is checked — other extensions, symlinks, node_modules", () => {
  const cjs = workDir({ "x.cjs": "module.exports = 1;\n" });
  assert.deepEqual(specViolations(cjs.acc).length, 1);
  for (const ext of [".js", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".json", ".node"]) {
    assert.equal(specViolations(workDir({ [`x${ext}`]: "1\n" }).acc).length, 1, ext);
  }
  const link = workDir();
  symlinkSync("/etc/hosts", join(link.acc, "specs", "link.mjs"));
  const lv = specViolations(link.acc);
  assert.equal(lv.length, 1, JSON.stringify(lv));
  assert.match(lv[0]!, /link\.mjs/);
  const nm = workDir({ "node_modules/a.mjs": "export const a = 1;\n" });
  assert.equal(specViolations(nm.acc).length, 1);
  // nested directories of clean .mjs files are fine
  assert.deepEqual(specViolations(workDir({ "sub/b.spec.mjs": CLEAN_SPEC, "sub/helpers.mjs": HELPERS }).acc), []);
});

test("specViolations: with the scaffold digest, a changed config, a re-pointed link or a new config file outside specs is a violation", () => {
  const { acc } = workDir();
  const digest = scaffoldDigest(acc);
  assert.deepEqual(specViolations(acc, digest), []);
  // the run's outputs may appear
  writeFileSync(join(acc, "results.json"), "{}");
  mkdirSync(join(acc, "artifacts", "t"), { recursive: true });
  writeFileSync(join(acc, "evidence", "ac-1.png"), "png");
  assert.deepEqual(specViolations(acc, digest), []);
  writeFileSync(join(acc, "playwright.config.ts"), "export default { globalSetup: './g.mjs' };\n");
  assert.equal(specViolations(acc, digest).length, 1);
  rmSync(join(acc, "playwright.config.ts"));
  writeFileSync(join(acc, "playwright.config.mjs"), "export default { webServer: {} };\n");
  assert.equal(specViolations(acc, digest).length, 1);
  writeFileSync(join(acc, "playwright.config.mjs"), "export default {};\n");
  rmSync(join(acc, "node_modules", "@playwright", "test"));
  symlinkSync(root, join(acc, "node_modules", "@playwright", "test"));
  assert.equal(specViolations(acc, digest).length, 1);
});

type HookEntry = { type: string; command: string; args?: string[]; timeout: number };
const hookOf = (settings: string): HookEntry =>
  (JSON.parse(settings) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: HookEntry[] }> } }).hooks.PreToolUse[0]!.hooks[0]!;

/** Runs the hook in exec form (command + args, no shell), as Claude Code does for a hook with `args` (T7-3). */
function runHook(settings: string, input: unknown, argsOverride?: string[]): Promise<{ code: number | null; stderr: string }> {
  const h = hookOf(settings);
  return new Promise((resolve) => {
    const child = spawn(h.command, argsOverride ?? h.args ?? [], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}
const bash = (command: string) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

test("specGuardSettings T7-3: an exec-form PreToolUse hook on Bash (command + args, never through the shell prefix) run by this Node", () => {
  const { work } = workDir();
  const s = JSON.parse(specGuardSettings({ workDir: work, commands: acceptCommandForms(work) })) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: HookEntry[] }> };
  };
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PreToolUse[0]!.matcher, "Bash");
  const h = s.hooks.PreToolUse[0]!.hooks[0]!;
  assert.equal(h.type, "command");
  assert.equal(h.command, process.execPath);
  assert.ok(Array.isArray(h.args));
  assert.deepEqual(h.args!.slice(0, 2), ["--disable-sigusr1", SPEC_GUARD_SCRIPT]);
  assert.ok(h.args!.every((a) => !/[\s'"$`;&|]/.test(a)), JSON.stringify(h.args));
  assert.ok(SPEC_GUARD_SCRIPT.startsWith(join(import.meta.dirname, "../src/acceptance")));
  const src = readFileSync(SPEC_GUARD_SCRIPT, "utf8");
  for (const m of src.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)) assert.match(m[1]!, /^node:/, m[1]!);
});

test("spec guard hook: the exact command forms with clean specs pass; a dirty spec, an extra argument or another tool exit 2", async () => {
  const clean = workDir();
  const settings = specGuardSettings({ workDir: clean.work, commands: acceptCommandForms(clean.work), scaffold: scaffoldDigest(clean.acc) });
  assert.equal((await runHook(settings, bash(`cd ${clean.work}/acceptance && playwright test`))).code, 0);
  assert.equal((await runHook(settings, bash("playwright test"))).code, 0);
  for (const bad of ["playwright test --grep x", "playwright test && touch x", "npx playwright test", " playwright test", "PWDEBUG=1 playwright test"]) {
    const r = await runHook(settings, bash(bad));
    assert.equal(r.code, 2, bad);
    assert.match(r.stderr, /^Blocked by Slack Off: /);
  }
  assert.equal((await runHook(settings, { tool_name: "Read", tool_input: {} })).code, 2);
  assert.equal((await runHook(settings, "not an object")).code, 2);
  writeFileSync(join(clean.acc, "specs", "bad.spec.mjs"), "import fs from 'node:fs';\n");
  const dirty = await runHook(settings, bash("playwright test"));
  assert.equal(dirty.code, 2);
  assert.match(dirty.stderr, /bad\.spec\.mjs/);
});

test("specGuardSelfCheck: the real guard passes; a fail-open script or a missing one is refused", async () => {
  const { work } = workDir();
  const o = { workDir: work, commands: acceptCommandForms(work) };
  await specGuardSelfCheck(specGuardSettings(o));
  const open = join(root, "open.mjs");
  writeFileSync(open, "process.exit(0);\n");
  await assert.rejects(specGuardSelfCheck(specGuardSettings(o, { script: open })), /Spec guard self-check failed/);
  await assert.rejects(specGuardSelfCheck(specGuardSettings(o, { script: join(root, "missing.mjs") })), /Spec guard self-check failed/);
  // a shell-form hook (it would run through CLAUDE_CODE_SHELL_PREFIX) is refused, whatever it does
  const shellForm = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 2", timeout: 30 }] }] } });
  await assert.rejects(specGuardSelfCheck(shellForm), /Spec guard self-check failed: .*exec form/);
});

test("spec guard hook T7-3: fails closed — missing or malformed configuration, unreadable input, a crash inside → exit 2", async () => {
  const { work } = workDir();
  const settings = specGuardSettings({ workDir: work, commands: acceptCommandForms(work) });
  const h = hookOf(settings);
  const ok = bash("playwright test");
  assert.equal((await runHook(settings, ok)).code, 0);
  for (const args of [[...h.args!.slice(0, 2)], [...h.args!.slice(0, 2), "--slackoff-spec=%%%"], [...h.args!.slice(0, 2), "--slackoff-spec=" + Buffer.from("[1]").toString("base64url")]]) {
    const r = await runHook(settings, ok, args);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.stderr, /^Blocked by Slack Off: /);
  }
  // the work dir's acceptance dir is unreadable as a directory → a violation, never a pass
  const gone = specGuardSettings({ workDir: join(root, "no-such-work"), commands: ["playwright test"] });
  assert.equal((await runHook(gone, ok)).code, 2);
});

// ---------------------------------------------------------------- phase 4f (Task 3, F-3): library examples

test("phase 4f checkExample: the declared library (and its subpaths), node:assert, node:assert/strict and node:util only", () => {
  const lib = { libraryName: "acceptance-lib" };
  const clean = [
    "import { slugify } from 'acceptance-lib';",
    "import extra from 'acceptance-lib/extra';",
    "import assert from 'node:assert';",
    "import { strict } from 'node:assert/strict';",
    "import { inspect } from 'node:util';",
    "console.log(slugify('Hello World'), inspect({ a: 1 }));",
    "assert.equal(slugify('A B'), 'a-b');",
  ].join("\n");
  assert.deepEqual(checkExample(clean, lib), []);
  assert.deepEqual(checkExample("import hello from '@example-org/slug';\nconsole.log(hello('x'));\n", { libraryName: "@example-org/slug" }), []);
  const refused: Array<[string, RegExp]> = [
    ["import fs from 'node:fs';", /node:fs/],
    ["import { readFileSync } from 'fs';", /import of "fs"/],
    ["import x from '../../x.mjs';", /import of "\.\.\/\.\.\/x\.mjs"/],
    ["import x from './helper.mjs';", /import of "\.\/helper\.mjs"/],
    ["import x from '/etc/x.mjs';", /import of "\/etc\/x\.mjs"/],
    ["import x from 'file:///etc/x.mjs';", /file:/],
    ["import x from 'acceptance-lib-evil';", /import of "acceptance-lib-evil"/],
    ["import cp from 'node:child_process';", /child_process/],
    ["import net from 'node:net';", /node:net/],
    ["import { createRequire } from 'node:module';", /node:module/],
    ["console.log(process.env.HOME);", /process/],
    ["const m = await import('acceptance-lib');", /import\(/],
    ["console.log(import.meta.resolve('x'));", /import\.meta/],
    ["globalThis.fetch('http://127.0.0.1:4317/');", /globalThis/],
  ];
  for (const [src, reason] of refused) {
    const v = checkExample(`import { slugify } from 'acceptance-lib';\n${src}\n`, lib);
    assert.ok(v.some((x) => reason.test(x)), `${src} → ${JSON.stringify(v)}`);
  }
});

test("phase 4f fix 1 (M2): checkExample refuses the reviewer's dodge — Function.prototype.constructor, getBuiltinModule, Reflect, __proto__", () => {
  const lib = { libraryName: "acceptance-lib" };
  for (const [src, re] of [
    ['const F = Function.prototype.constructor;', /constructor/],
    ['const p = ({}).constructor.constructor("return 1")();', /constructor/],
    ['x.getBuiltinModule("f" + "s");', /getBuiltinModule/],
    ['Reflect.get(a, "b");', /Reflect/],
    ['const o = {}.__proto__;', /__proto__/],
  ] as const) {
    const v = checkExample(`import { slugify } from 'acceptance-lib';\n${src}\n`, lib);
    assert.ok(v.some((x) => re.test(x)), `${src} → ${JSON.stringify(v)}`);
  }
});

// ---------------------------------------------------------------- phase 4f Task 4: the guard for declared cases

test("phase 4f caseViolations: only <repo>/cases/*.case.json, a library's guarded examples, results/; the platform's link unchanged", () => {
  const acc = join(mkdtempSync(join(root, "cv-")), "acceptance");
  const cases = [{ repo: "cli", library: null }, { repo: "lib", library: "acceptance-lib" }];
  for (const r of ["cli", "lib"]) {
    mkdirSync(join(acc, r, "cases"), { recursive: true });
    mkdirSync(join(acc, r, "examples"), { recursive: true });
  }
  mkdirSync(join(acc, "lib", "examples", "node_modules"));
  symlinkSync(root, join(acc, "lib", "examples", "node_modules", "acceptance-lib"));
  const scaffold = casesScaffoldDigest(acc, cases);
  writeFileSync(join(acc, "cli", "cases", "a.case.json"), "{}");
  writeFileSync(join(acc, "lib", "examples", "ok.mjs"), "import { slugify } from 'acceptance-lib';\nconsole.log(slugify('A'));\n");
  mkdirSync(join(acc, "results"));
  assert.deepEqual(caseViolations(acc, cases, scaffold), []);
  writeFileSync(join(acc, "lib", "examples", "fs.mjs"), "import fs from 'node:fs';\n");
  writeFileSync(join(acc, "cli", "examples", "x.mjs"), "console.log(1)\n");
  writeFileSync(join(acc, "cli", "cases", "notes.txt"), "x");
  symlinkSync(join(root, "x.case.json"), join(acc, "cli", "cases", "l.case.json"));
  mkdirSync(join(acc, "specs"));
  rmSync(join(acc, "lib", "examples", "node_modules", "acceptance-lib"));
  symlinkSync(join(root, "elsewhere"), join(acc, "lib", "examples", "node_modules", "acceptance-lib"));
  const v = caseViolations(acc, cases, scaffold).join("\n");
  for (const re of [/lib\/examples\/fs\.mjs: .*node:fs/, /cli\/examples\/x\.mjs: examples are only for a library/, /cli\/cases\/notes\.txt/, /cli\/cases\/l\.case\.json: symbolic links/, /^specs: not allowed/m, /node_modules\/acceptance-lib: changed since/]) {
    assert.match(v, re);
  }
});

test("phase 4f spec guard hook (cases mode): exactly slackoff-cases run passes with clean cases; playwright test and a dirty example are blocked", async () => {
  const work = mkdtempSync(join(root, "cw-"));
  const acc = join(work, "acceptance");
  mkdirSync(join(acc, "cli", "cases"), { recursive: true });
  const cases = [{ repo: "cli", library: null }];
  const settings = specGuardSettings({ workDir: work, commands: caseCommandForms(work), scaffold: casesScaffoldDigest(acc, cases), cases });
  await specGuardSelfCheck(settings);
  const hook = (JSON.parse(settings) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; args: string[] }> }> } }).hooks.PreToolUse[0]!.hooks[0]!;
  const call = (command: string) =>
    spawnSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }), encoding: "utf8" }).status;
  assert.equal(call(`cd ${acc} && slackoff-cases run`), 0);
  assert.equal(call("slackoff-cases run"), 0);
  assert.equal(call("playwright test"), 2);
  assert.equal(call("slackoff-cases run; touch x"), 2);
  mkdirSync(join(acc, "cli", "examples"));
  writeFileSync(join(acc, "cli", "examples", "x.mjs"), "console.log(1)\n");
  assert.equal(call("slackoff-cases run"), 2);
});
