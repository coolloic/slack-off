import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { checkText, checkTree } from "../../../scripts/public-content-check.mjs";

// Samples that must be flagged are built by concatenation so this file stays clean itself.
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const privateHost = "big" + "co.atlassian" + ".net";

test("checkText flags a non-allowed JIRA host and never echoes the subdomain", () => {
  const f = checkText("a.md", `see https://${privateHost}/browse/X-1`, []);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.rule, "jira-host");
  assert.equal(f[0]!.line, 1);
  assert.ok(!f[0]!.excerpt.includes("big" + "co"));
  assert.ok(f[0]!.excerpt.includes("***"));
});

test("checkText allows the placeholder JIRA host", () => {
  assert.deepEqual(checkText("a.md", "https://your-company.atlassian.net/browse/X-1", []), []);
});

test("checkText flags real-looking emails, allows placeholders", () => {
  assert.equal(checkText("a.md", "mail a" + "@b" + ".io now", [])[0]?.rule, "email");
  assert.deepEqual(checkText("a.md", "you@example.com noreply@anthropic.com git@github.com x@y.invalid", []), []);
});

test("checkText flags user paths other than placeholders", () => {
  assert.deepEqual(checkText("a.md", "/Users/<you>/x", []), []);
  assert.equal(checkText("a.md", "/Us" + "ers/alice/x", [])[0]?.rule, "user-path");
});

test("checkText matches private terms case-insensitively on word boundaries", () => {
  const f = checkText("a.md", "by alice example today", ["Alice Example"]);
  assert.equal(f[0]?.rule, "private-term");
  assert.ok(!f[0]!.excerpt.toLowerCase().includes("alice"));
  assert.deepEqual(checkText("a.md", "malice examples", ["Alice Example"]), []);
});

test("checkText flags non-npmjs registries in pnpm-lock.yaml only", () => {
  const line = "tarball: https://npm.internal.example/x.tgz";
  assert.equal(checkText("pnpm-lock.yaml", line, [])[0]?.rule, "registry");
  assert.deepEqual(checkText("pnpm-lock.yaml", "tarball: https://registry.npmjs.org/x.tgz", []), []);
  assert.deepEqual(checkText("docs/a.md", line, []), []);
});

test("scan-history refuses an --out inside the repository", () => {
  const r = spawnSync(process.execPath, [path.join(repoDir, "scripts/scan-history.mjs"), "--out", path.join(repoDir, "tmp")], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the report must be written outside the repository/);
});

test("the current tree has no findings; PNGs are listed for manual review", () => {
  const { findings, binaries } = checkTree(repoDir, []);
  assert.deepEqual(findings.map((f) => `${f.path}:${f.line}:${f.rule}`), []);
  assert.ok(binaries.some((b) => b.endsWith(".png")));
});

// ---- fix round 1 (ruling 4E-3) ----
const scan = path.join(repoDir, "scripts/scan-history.mjs");
const runScan = (out: string) => spawnSync(process.execPath, [scan, "--out", out], { encoding: "utf8" });

test("scan-history refuses an --out that reaches the repository through a symlink, and writes nothing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "so-link-"));
  const link = path.join(dir, "link");
  symlinkSync(repoDir, link);
  try {
    const r = runScan(path.join(link, "newout-xyz"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /outside the repository/);
    assert.equal(existsSync(path.join(repoDir, "newout-xyz")), false);
  } finally {
    unlinkSync(link);
    rmSync(dir, { recursive: true });
  }
});

test("scan-history refuses a case variant of the repository path", (t) => {
  const variant = path.join(repoDir.toUpperCase(), "newout-case");
  if (!existsSync(repoDir.toUpperCase())) return t.skip("case-sensitive file system");
  const r = runScan(variant);
  assert.equal(r.status, 2);
  assert.equal(existsSync(path.join(repoDir, "newout-case")), false);
});

test("jira-host: upper case, a subdomain in front of an allowed host", () => {
  assert.equal(checkText("a.md", `https://${privateHost.toUpperCase()}/x`, [])[0]?.rule, "jira-host");
  const sub = "x." + "your-company.atlassian" + ".net";
  const f = checkText("a.md", `see ${sub}`, []);
  assert.equal(f[0]?.rule, "jira-host");
  assert.ok(!f[0]!.excerpt.includes("x."));
});

test("jira-host: JSON-escaped, percent-encoded and line-split hosts are found with an approximate line", () => {
  const esc = "big" + "\\u0063" + "o.atlassian" + ".net";
  assert.equal(checkText("a.json", `{"u":"https://${esc}"}`, [])[0]?.rule, "jira-host");
  const pct = "big" + "%63" + "o%2Eatlassian" + ".net";
  assert.equal(checkText("a.md", `link ${pct}`, [])[0]?.rule, "jira-host");
  const split = "line one\nhost big" + "co.\natlassian" + ".net\nend";
  const f = checkText("a.md", split, []);
  assert.equal(f[0]?.rule, "jira-host");
  assert.ok(f[0]!.line >= 2 && f[0]!.line <= 3);
});

test("jira-host: a placeholder host split by prose is not a finding", () => {
  assert.deepEqual(checkText("a.md", "use\n" + "your-company.atlassian" + ".net here", []), []);
  assert.deepEqual(checkText("a.md", "use the your-company.atlassian.net host", []), []);
});

test("user-path: near-placeholder names, case variants and /home", () => {
  const u = "/Us" + "ers/";
  for (const p of [u + "me-x/a", u + "u.alice/a", "/US" + "ERS/alice/a", "/ho" + "me/alice/a"]) assert.equal(checkText("a.md", p, [])[0]?.rule, "user-path", p);
  for (const p of [u + "me/a", u + "<you>/a", "/ho" + "me/runner/a", "/ho" + "me/<you>/a"]) assert.deepEqual(checkText("a.md", p, []), [], p);
});

test("email: only noreply@anthropic.com is allowed at anthropic.com", () => {
  assert.equal(checkText("a.md", "al" + "ice@anthropic" + ".com", [])[0]?.rule, "email");
  assert.deepEqual(checkText("a.md", "noreply@anthropic.com", []), []);
});

function tempRepo(files: Record<string, Buffer | string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "so-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

test("checkTree: .mmd is scanned; binary only by extension or magic; NUL in a text file is a finding", () => {
  const dir = tempRepo({
    "d.mmd": `graph TD\n A[${privateHost}]\n`,
    "pic.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    "magic.dat": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]),
    "hide.md": Buffer.concat([Buffer.from("x\0y "), Buffer.from(privateHost)]),
  });
  try {
    const { findings, binaries } = checkTree(dir, []);
    const keys = findings.map((f) => `${f.path}:${f.rule}`).sort();
    assert.deepEqual(keys, ["d.mmd:jira-host", "hide.md:jira-host", "hide.md:nul-in-text"]);
    assert.deepEqual(binaries.sort(), ["magic.dat", "pic.png"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("scan-history runs end to end and writes its report outside the repository", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "so-scan-"));
  try {
    const r = runScan(out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /author-identity: \d+/);
    assert.equal(existsSync(path.join(out, "history-scan.md")), true);
  } finally {
    rmSync(out, { recursive: true });
  }
});
