// Scan all git history for non-public content. The report (with values) is written
// OUTSIDE the repository; stdout only prints per-category counts.
//   node scripts/scan-history.mjs --out <dir outside the repo>
// SLACKOFF_PRIVATE_TERMS=<file outside the repo> adds one private term per line.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFile, checkText, loadPrivateTerms } from "./public-content-check.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
if (outIdx < 0 || !args[outIdx + 1]) {
  console.error("usage: node scripts/scan-history.mjs --out <directory outside the repository>");
  process.exit(2);
}
const out = path.resolve(args[outIdx + 1]);

// The deepest existing ancestor is resolved through symlinks (native realpath gives the canonical case);
// the not-yet-existing tail is appended. Containment is tested by path (case-insensitively) and by dev:ino.
function insideRepo(outDir) {
  const repoReal = realpathSync.native(repoDir);
  let existing = outDir;
  const tail = [];
  for (;;) {
    try { statSync(existing); break; } catch { tail.unshift(path.basename(existing)); const up = path.dirname(existing); if (up === existing) break; existing = up; }
  }
  const real = path.join(realpathSync.native(existing), ...tail);
  const a = real.toLowerCase();
  const b = repoReal.toLowerCase();
  if (a === b || a.startsWith(b + path.sep)) return true;
  const repoStat = statSync(repoReal);
  for (let p = realpathSync.native(existing); ; p = path.dirname(p)) {
    const st = statSync(p);
    if (st.ino === repoStat.ino && st.dev === repoStat.dev) return true;
    if (path.dirname(p) === p) return false;
  }
}
if (insideRepo(out)) {
  console.error("the report must be written outside the repository");
  process.exit(2);
}

const terms = loadPrivateTerms(process.env.SLACKOFF_PRIVATE_TERMS);
const git = (a) => execFileSync("git", a, { cwd: repoDir, encoding: "utf8", maxBuffer: 1 << 29 });
const hits = { "author-identity": [], "commit-message": [], "ref-name": [], blob: [] };

// Author / committer identities and commit messages.
const SEP = "\x1e";
const log = git(["log", "--all", `--format=%H${SEP}%an${SEP}%ae${SEP}%cn${SEP}%ce${SEP}%B${SEP}END`]);
for (const rec of log.split(`${SEP}END\n`).filter(Boolean)) {
  const [sha, an, ae, cn, ce, body] = rec.split(SEP);
  const ident = [an, ae, cn, ce].join("\n");
  // Real names are not pattern-detectable; every identity is listed for review, with emails checked by rule.
  hits["author-identity"].push({ sha, value: `${an} <${ae}> / ${cn} <${ce}>`, note: checkText("identity", ident, terms).length ? "rule hit" : "identity listed" });
  for (const f of checkText("commit-message", body ?? "", terms)) hits["commit-message"].push({ sha, rule: f.rule, line: f.line, value: f.excerpt });
}
// Only identities that are not the placeholder pattern count as hits; one hit per distinct identity.
hits["author-identity"] = hits["author-identity"].filter((h) => !/@users\.noreply\.github\.com|@example\.(com|org|net)|noreply@anthropic\.com/.test(h.value) || h.note === "rule hit");
{
  const byIdent = new Map();
  for (const h of hits["author-identity"]) {
    const e = byIdent.get(h.value) ?? { value: h.value, commits: 0, firstSha: h.sha };
    e.commits++;
    byIdent.set(h.value, e);
  }
  hits["author-identity"] = [...byIdent.values()];
}

// Branch and tag names.
for (const ref of git(["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) {
  for (const f of checkText("ref", ref, terms)) hits["ref-name"].push({ value: ref, rule: f.rule });
}

// Every blob, with the commits that carry its path.
const objs = git(["rev-list", "--all", "--objects"]).split("\n").filter(Boolean);
const batch = spawnSync("git", ["cat-file", "--batch"], { cwd: repoDir, input: objs.map((l) => l.split(" ")[0]).join("\n") + "\n", maxBuffer: 1 << 30 });
const buf = batch.stdout;
let pos = 0;
const seen = new Set();
const pathOf = new Map(objs.map((l) => [l.split(" ")[0], l.slice(41) || "(tree)"]));
while (pos < buf.length) {
  const nl = buf.indexOf(0x0a, pos);
  const [sha, type, sizeStr] = buf.subarray(pos, nl).toString().split(" ");
  const size = Number(sizeStr);
  const body = buf.subarray(nl + 1, nl + 1 + size);
  pos = nl + 1 + size + 1;
  if (type !== "blob" || seen.has(sha)) continue;
  const p = pathOf.get(sha) ?? "?";
  const r = checkFile(p, body, terms);
  if (r.binary) continue;
  seen.add(sha);
  for (const f of r.findings) hits.blob.push({ sha, path: p, line: f.line, rule: f.rule, value: f.excerpt });
}

const counts = Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length]));
const byRule = {};
for (const h of [...hits.blob, ...hits["commit-message"], ...hits["ref-name"]]) byRule[h.rule] = (byRule[h.rule] ?? 0) + 1;

let md = `# History scan\n\nPrivate terms file: ${terms.length ? `${terms.length} terms` : "NOT PROVIDED (name-based terms were not scanned)"}\n\n## Counts\n\n`;
for (const [k, v] of Object.entries(counts)) md += `- ${k}: ${v}\n`;
md += `\nBy rule (blobs, messages, refs): ${JSON.stringify(byRule)}\n`;
for (const [k, list] of Object.entries(hits)) {
  md += `\n## ${k} (${list.length})\n\n`;
  for (const h of list) md += `- ${Object.entries(h).filter(([key]) => key !== "note").map(([key, v]) => `${key}=${v}`).join(" | ")}\n`;
}
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "history-scan.md"), md);
for (const [k, v] of Object.entries(counts)) console.log(`${k}: ${v}`);
console.log(`blobs scanned: ${seen.size}; rules: ${JSON.stringify(byRule)}`);
console.log(`report: ${path.join(out, "history-scan.md")}`);
