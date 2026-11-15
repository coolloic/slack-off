// Public-content check: nothing that identifies a company or person may be tracked.
// Pure functions are exported for tests; run directly it checks every `git ls-files` file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_JIRA_HOSTS = ["your-company.atlassian.net", "your-jira.atlassian.net", "acme.atlassian.net", "jira.atlassian.net", "example.atlassian.net"];
export const ALLOWED_EMAIL = /^git@github\.com$|@([a-z0-9-]+\.)*example\.(com|org|net)$|^noreply@anthropic\.com$|\.invalid$/i;

const JIRA_RE = /(?:[a-z0-9-]+\.)*[a-z0-9-]+\.atlassian\.net/gi; // the whole host, so a prefix in front of an allowed host is caught
// The TLD must be alphabetic, so package specs such as name@1.2.3 are not emails.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;
const USER_PATH_RE = /\/(?:Users|home)\/(?!<you>|(?:you|me|u|o|runner)(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+/gi;
const URL_RE = /https?:\/\/([A-Za-z0-9.-]+)/g;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerptOf(line, matches) {
  let out = line;
  for (const m of [...new Set(matches)]) out = out.split(m).join("***");
  out = out.trim();
  return out.length > 120 ? out.slice(0, 120) + "..." : out;
}

/** @returns {{path:string,line:number,rule:string,excerpt:string}[]} */
export function checkText(filePath, text, privateTerms) {
  const findings = [];
  const termRes = privateTerms
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, "gi"));
  const isLock = path.basename(filePath) === "pnpm-lock.yaml";
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const add = (rule, matches) => {
      if (matches.length) findings.push({ path: filePath, line: i + 1, rule, excerpt: excerptOf(line, matches) });
    };
    add("jira-host", (line.match(JIRA_RE) ?? []).filter((h) => !ALLOWED_JIRA_HOSTS.includes(h.toLowerCase())));
    add("email", (line.match(EMAIL_RE) ?? []).filter((e) => !ALLOWED_EMAIL.test(e)));
    add("user-path", line.match(USER_PATH_RE) ?? []);
    add("private-term", termRes.flatMap((re) => line.match(re) ?? []));
    if (isLock) {
      const hosts = [...line.matchAll(URL_RE)].filter((m) => m[1] !== "registry.npmjs.org").map((m) => m[0]);
      add("registry", hosts);
    }
  });
  findings.push(...checkNormalised(filePath, lines, findings));
  return findings;
}

// Hosts hidden by line breaks, whitespace, JSON \uXXXX escapes or percent-encoding.
function checkNormalised(filePath, lines, already) {
  const decoded = lines.map((l) =>
    l.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
  );
  const starts = [];
  let joined = "";
  decoded.forEach((l) => {
    starts.push(joined.length);
    joined += l.replace(/\s+/g, "");
  });
  const seen = new Set(already.filter((f) => f.rule === "jira-host").map((f) => f.line));
  const out = [];
  for (const m of joined.matchAll(JIRA_RE)) {
    const host = m[0].toLowerCase();
    // Joining words can glue a word onto a placeholder host; ignore matches that end with an allowed host.
    if (ALLOWED_JIRA_HOSTS.some((h) => host.endsWith(h))) continue;
    let line = starts.length;
    const end = m.index + m[0].length - 1;
    for (let i = 0; i < starts.length; i++) if (starts[i] > end) { line = i; break; } // line holding the end of the host: approximate
    if (seen.has(line)) continue;
    out.push({ path: filePath, line, rule: "jira-host", excerpt: "*** (host found only after joining lines or decoding escapes)" });
  }
  return out;
}

export function loadPrivateTerms(file) {
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
}

const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".pdf", ".zip"]);
const MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x25, 0x50, 0x44, 0x46], [0x50, 0x4b, 0x03, 0x04], [0x77, 0x4f, 0x46, 0x46], [0x77, 0x4f, 0x46, 0x32], [0x00, 0x00, 0x01, 0x00], [0x00, 0x01, 0x00, 0x00], [0x4f, 0x54, 0x54, 0x4f]];

/** Binary only by extension or magic bytes; NUL alone does not make a file binary. */
export function isBinaryFile(filePath, buf) {
  if (BINARY_EXT.has(path.extname(filePath).toLowerCase())) return true;
  return MAGIC.some((m) => m.every((b, i) => buf[i] === b));
}

/** Scan a file's bytes; a NUL in a text file is itself a finding (it can hide content from grep). */
export function checkFile(filePath, buf, privateTerms) {
  if (isBinaryFile(filePath, buf)) return { binary: true, findings: [] };
  const findings = [];
  let text = buf.toString("utf8");
  if (text.includes("\0")) {
    findings.push({ path: filePath, line: text.slice(0, text.indexOf("\0")).split("\n").length, rule: "nul-in-text", excerpt: "NUL byte in a text file" });
    text = text.replaceAll("\0", "");
  }
  findings.push(...checkText(filePath, text, privateTerms));
  return { binary: false, findings };
}

export function checkTree(repoDir, privateTerms) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoDir, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
  const findings = [];
  const binaries = [];
  for (const f of files) {
    let buf;
    try {
      buf = readFileSync(path.join(repoDir, f));
    } catch {
      continue; // deleted in the working tree
    }
    const r = checkFile(f, buf, privateTerms);
    if (r.binary) binaries.push(f);
    else findings.push(...r.findings);
  }
  return { findings, binaries };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { findings, binaries } = checkTree(repoDir, loadPrivateTerms(process.env.SLACKOFF_PRIVATE_TERMS));
  for (const f of findings) console.error(`${f.path}:${f.line} [${f.rule}] ${f.excerpt}`);
  console.log(`public-content: ${findings.length} finding(s); ${binaries.length} binary file(s) need a manual look`);
  process.exit(findings.length ? 1 : 0);
}
