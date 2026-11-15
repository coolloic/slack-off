// Slack Off acceptance spec guard: a static scan of the acceptance agent's Playwright specs, and the Claude Code
// PreToolUse hook on Bash that runs it before every command (Task 7).
//
// Defense in depth only: a three-line dodge got past a scan like this one in the Task 1 spike (§4.2). The real read,
// write and connect limits come from the acceptance sandbox profile every Bash command of the agent runs in (T7-1) and
// the platform's own re-run under sandboxArgv.
//
// Plain JavaScript with node: built-ins only (like nav-guard-hook.mjs), started by the server's own absolute Node in
// exec form (command + args: never through the agent's CLAUDE_CODE_SHELL_PREFIX, T7-3). It reads the hook JSON on
// stdin; exit 2 blocks the call (reason on stderr), every failure path exits 2 (fail closed). Configuration: one
// argument `--slackoff-spec=<base64url JSON {workDir, commands, scaffold}>` — workDir the run's work dir, commands the
// only command lines allowed (verbatim), scaffold the scaffoldDigest of the acceptance dir before the agent ran, or null.
//
// This file lives in the server source, outside every directory an agent may write.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Top-level entries of the acceptance dir: the scaffold, the agent's specs and what a run writes. */
const ALLOWED_TOP = new Set(["playwright.config.mjs", "node_modules", "specs", "evidence", "artifacts", "results.json", "test-results"]);
/** What a `playwright test` run writes: never part of the scaffold comparison. */
const RUN_OUTPUTS = new Set(["evidence", "artifacts", "results.json", "test-results"]);
const MAX_SPEC_BYTES = 512 * 1024;

/** Forbidden identifiers and forms, matched on the whole file text (strings and comments too: fail closed). */
const FORBIDDEN = [
  ["process", /\bprocess\b/],
  ["require(", /\brequire\s*\(/],
  ["import(", /\bimport\s*\(/],
  ["eval(", /\beval\s*\(/],
  ["Function(", /\bFunction\s*\(/],
  ["globalThis", /\bglobalThis\b/],
  ["child_process", /child_process/],
  ["node:", /\bnode:/],
  ["fs", /\bfs\b/],
  ["launchPersistentContext", /launchPersistentContext/],
  ["connectOverCDP", /connectOverCDP/],
  ["connect(", /\bconnect\s*\(/],
  ["connectOptions", /connectOptions/],
  ["launchOptions", /launchOptions/],
  ["contextOptions", /contextOptions/],
  ["storageState", /storageState/],
  ["executablePath", /executablePath/],
  ["userDataDir", /userDataDir/],
  ["channel:", /\bchannel\s*["'`]?\s*:/],
  ["_electron", /_electron/],
  ["firefox", /firefox/i],
  ["webkit", /webkit/i],
  ["file:", /\bfile:/i],
];
/** Forbidden inside string literals: a spec only uses paths relative to the configured baseURL (S-1). */
const FORBIDDEN_IN_STRINGS = ["://", "//", "localhost", "127.", "[::1]"];

/** The string literals of a source text ('…', "…" and `…` with its ${} parts), comments skipped. Best effort: a regex
 * literal can confuse it, which is why the identifier checks run on the raw text. */
function stringLiterals(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\" && j + 1 < text.length) {
          s += text[j + 1];
          j += 2;
        } else {
          s += text[j];
          j++;
        }
      }
      out.push(s);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

const IMPORT_FROM = /\b(?:import|export)\s*(?:[\w$*{},\s]*?\s*from\s*)?(["'])([^"'\n]*)\1/g;

const inside = (path, dir) => {
  const r = relative(resolve(dir), resolve(path));
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
};

/** Reasons a spec file breaks the rules ([] = none). */
function fileReasons(file, specsDir) {
  let text;
  try {
    if (lstatSync(file).size > MAX_SPEC_BYTES) return [`larger than ${MAX_SPEC_BYTES} bytes`];
    text = readFileSync(file, "utf8");
  } catch (e) {
    return [`unreadable (${e && e.code})`];
  }
  const reasons = [];
  const add = (r) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  for (const m of text.matchAll(IMPORT_FROM)) {
    const spec = m[2];
    const ok =
      spec === "@playwright/test" ||
      ((spec.startsWith("./") || spec.startsWith("../")) && spec.endsWith(".mjs") && inside(resolve(dirname(file), spec), specsDir));
    if (!ok) add(`import of ${JSON.stringify(spec)} is not allowed (only @playwright/test and .mjs files in specs)`);
  }
  for (const [label, re] of FORBIDDEN) if (re.test(text)) add(`uses ${label}`);
  for (const s of stringLiterals(text)) {
    for (const f of FORBIDDEN_IN_STRINGS) {
      if (s.includes(f)) add(`a string contains ${JSON.stringify(f)} (use paths relative to the baseURL)`);
    }
  }
  return reasons;
}

/** phase 4f (F-3): the only node: built-ins a library example may import. */
const EXAMPLE_BUILTINS = new Set(["node:assert", "node:assert/strict", "node:util"]);
/** phase 4f (review focus 3): an example never resolves module paths itself */
const EXAMPLE_FORBIDDEN = [
  ["import.meta", /\bimport\s*\.\s*meta\b/],
  // fix round 1 (M2): the reviewer's way to the process object and the built-ins (a dodge with computed names remains:
  // the sandbox is the boundary)
  ["constructor", /\bconstructor\b/],
  ["getBuiltinModule", /getBuiltinModule/],
  ["Reflect", /\bReflect\b/],
  ["__proto__", /__proto__/],
];

/**
 * phase 4f (ruling F-3): the reasons a library example (`examples/*.mjs`) breaks the rules ([] = none). Imports only
 * `libraryName` (or a subpath of it) and EXAMPLE_BUILTINS; otherwise the Playwright spec rules (FORBIDDEN on the whole
 * text, FORBIDDEN_IN_STRINGS in string literals), with `node:` allowed only as one of EXAMPLE_BUILTINS, plus no
 * `import.meta`. Defense in depth: the acceptance sandbox the example runs in is the boundary.
 */
export function checkExample(text, { libraryName }) {
  const reasons = [];
  const add = (r) => {
    if (!reasons.includes(r)) reasons.push(r);
  };
  for (const m of text.matchAll(IMPORT_FROM)) {
    const spec = m[2];
    const ok = spec === libraryName || spec.startsWith(`${libraryName}/`) || EXAMPLE_BUILTINS.has(spec);
    if (!ok) add(`import of ${JSON.stringify(spec)} is not allowed (only ${JSON.stringify(libraryName)}, node:assert, node:assert/strict and node:util)`);
  }
  for (const [label, re] of [...FORBIDDEN, ...EXAMPLE_FORBIDDEN]) {
    if (label === "node:") {
      for (const n of text.matchAll(/\bnode:[A-Za-z0-9_/]*/g)) if (!EXAMPLE_BUILTINS.has(n[0])) add(`uses ${n[0]}`);
    } else if (re.test(text)) add(`uses ${label}`);
  }
  for (const s of stringLiterals(text)) {
    for (const f of FORBIDDEN_IN_STRINGS) {
      if (s.includes(f)) add(`a string contains ${JSON.stringify(f)}`);
    }
  }
  return reasons;
}

function walkSpecs(dir, specsDir, out) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    out.push(`${relative(dirname(specsDir), dir) || "specs"}: unreadable (${e && e.code})`);
    return;
  }
  for (const name of names) {
    const abs = join(dir, name);
    const rel = relative(dirname(specsDir), abs);
    let st;
    try {
      st = lstatSync(abs);
    } catch (e) {
      out.push(`${rel}: unreadable (${e && e.code})`);
      continue;
    }
    if (st.isSymbolicLink()) out.push(`${rel}: symbolic links are not allowed`);
    else if (st.isDirectory()) {
      if (name === "node_modules") out.push(`${rel}: node_modules is not allowed in specs`);
      else walkSpecs(abs, specsDir, out);
    } else if (!st.isFile()) out.push(`${rel}: only regular .mjs files are allowed`);
    else if (!name.endsWith(".mjs")) out.push(`${rel}: only .mjs files are allowed`);
    else {
      const reasons = fileReasons(abs, specsDir);
      if (reasons.length > 0) out.push(`${rel}: ${reasons.join("; ")}`);
    }
  }
}

/** Every entry of the acceptance dir outside specs/ and the run's outputs: relative path → "dir" | "file:<sha256>" |
 * "link:<target>" | "other". Symlinks are not followed. */
export function scaffoldDigest(acceptanceDir) {
  const out = {};
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      const rel = relative(acceptanceDir, abs);
      if (dir === acceptanceDir && (name === "specs" || RUN_OUTPUTS.has(name))) continue;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
      else if (st.isDirectory()) {
        out[rel] = "dir";
        walk(abs);
      } else if (st.isFile()) out[rel] = `file:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
      else out[rel] = "other";
    }
  };
  walk(acceptanceDir);
  return out;
}

/**
 * The rule violations in `acceptanceDir` ([] = none). Every entry under specs/ (R5): only regular `*.mjs` files (no
 * symlinks, no node_modules, no other extension), importing only '@playwright/test' and relative .mjs files inside
 * specs, without the forbidden identifiers and string contents. Outside specs: only the scaffold's and a run's
 * top-level entries; with `scaffold` (scaffoldDigest before the agent ran) every scaffold entry unchanged and no new one.
 * At most one violation per path.
 */
export function specViolations(acceptanceDir, scaffold = null) {
  const out = [];
  let top = [];
  try {
    top = readdirSync(acceptanceDir).sort();
  } catch (e) {
    return [`${acceptanceDir}: unreadable (${e && e.code})`];
  }
  for (const name of top) if (!ALLOWED_TOP.has(name)) out.push(`${name}: not allowed in the acceptance dir (only specs/ is the agent's)`);
  const specsDir = join(acceptanceDir, "specs");
  let st = null;
  try {
    st = lstatSync(specsDir);
  } catch {
    // missing
  }
  if (st === null || !st.isDirectory() || st.isSymbolicLink()) out.push("specs: missing or not a directory");
  else walkSpecs(specsDir, specsDir, out);
  if (scaffold !== null && scaffold !== undefined) {
    const now = scaffoldDigest(acceptanceDir);
    for (const [rel, v] of Object.entries(scaffold)) {
      if (!(rel in now)) out.push(`${rel}: part of the scaffold, missing`);
      else if (now[rel] !== v) out.push(`${rel}: changed since Slack Off wrote the scaffold`);
    }
    for (const rel of Object.keys(now)) {
      if (!(rel in scaffold) && !out.some((v) => v.startsWith(`${rel.split("/")[0]}: not allowed`))) out.push(`${rel}: not part of the scaffold`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- phase 4f: declared cases (command-line and library entries)

const CASE_FILE = /^[A-Za-z0-9._-]{1,200}\.case\.json$/;
const EXAMPLE_FILE = /^[a-z0-9-]{1,64}\.mjs$/;
const MAX_EXAMPLE_BYTES = 512 * 1024;

/**
 * phase 4f: the platform's part of a cases acceptance dir — each repo's examples/node_modules (the library link): path →
 * "dir" | "link:<target>" | "file:<sha256>" | "other". Symlinks are not followed.
 */
export function casesScaffoldDigest(acceptanceDir, cases) {
  const out = {};
  const walk = (abs) => {
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    const rel = relative(acceptanceDir, abs);
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`;
    else if (st.isDirectory()) {
      out[rel] = "dir";
      for (const n of readdirSync(abs).sort()) walk(join(abs, n));
    } else if (st.isFile()) out[rel] = `file:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
    else out[rel] = "other";
  };
  for (const c of cases) walk(join(acceptanceDir, c.repo, "examples", "node_modules"));
  return out;
}

/**
 * phase 4f: the rule violations of a cases acceptance dir ([] = none): at the top only the repos' dirs and results/;
 * in each repo dir only cases/ (regular *.case.json files) and examples/ (regular *.mjs files that pass checkExample
 * for a library repo — a command-line repo has none — plus the platform's node_modules, unchanged since `scaffold`).
 */
export function caseViolations(acceptanceDir, cases, scaffold = null) {
  const out = [];
  const repos = new Map(cases.map((c) => [c.repo, c.library]));
  const entries = (dir) => {
    try {
      return readdirSync(dir).sort();
    } catch (e) {
      out.push(`${relative(acceptanceDir, dir) || "acceptance"}: unreadable (${e && e.code})`);
      return [];
    }
  };
  const kind = (abs) => {
    try {
      const st = lstatSync(abs);
      return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    } catch {
      return "missing";
    }
  };
  for (const name of entries(acceptanceDir)) {
    if (name === "results") continue;
    if (!repos.has(name)) out.push(`${name}: not allowed in the acceptance dir (only <repo>/cases and <repo>/examples)`);
    else if (kind(join(acceptanceDir, name)) !== "dir") out.push(`${name}: not a directory`);
  }
  for (const [repo, library] of repos) {
    const base = join(acceptanceDir, repo);
    if (kind(base) !== "dir") continue;
    for (const name of entries(base)) if (name !== "cases" && name !== "examples") out.push(`${repo}/${name}: not allowed (only cases/ and examples/)`);
    if (kind(join(base, "cases")) === "dir") {
      for (const name of entries(join(base, "cases"))) {
        const k = kind(join(base, "cases", name));
        if (k === "link") out.push(`${repo}/cases/${name}: symbolic links are not allowed`);
        else if (k !== "file" || !CASE_FILE.test(name)) out.push(`${repo}/cases/${name}: only *.case.json files are allowed`);
      }
    } else if (kind(join(base, "cases")) !== "missing") out.push(`${repo}/cases: not a directory`);
    if (kind(join(base, "examples")) === "dir") {
      for (const name of entries(join(base, "examples"))) {
        if (name === "node_modules") continue;
        const abs = join(base, "examples", name);
        const k = kind(abs);
        if (k === "link") out.push(`${repo}/examples/${name}: symbolic links are not allowed`);
        else if (k !== "file" || !EXAMPLE_FILE.test(name)) out.push(`${repo}/examples/${name}: only *.mjs files named [a-z0-9-] are allowed`);
        else if (library === null) out.push(`${repo}/examples/${name}: examples are only for a library`);
        else {
          let text;
          try {
            if (lstatSync(abs).size > MAX_EXAMPLE_BYTES) {
              out.push(`${repo}/examples/${name}: larger than ${MAX_EXAMPLE_BYTES} bytes`);
              continue;
            }
            text = readFileSync(abs, "utf8");
          } catch (e) {
            out.push(`${repo}/examples/${name}: unreadable (${e && e.code})`);
            continue;
          }
          const r = checkExample(text, { libraryName: library });
          if (r.length > 0) out.push(`${repo}/examples/${name}: ${r.join("; ")}`);
        }
      }
    } else if (kind(join(base, "examples")) !== "missing") out.push(`${repo}/examples: not a directory`);
  }
  if (scaffold !== null && scaffold !== undefined) {
    const now = casesScaffoldDigest(acceptanceDir, cases);
    for (const [rel, v] of Object.entries(scaffold)) {
      if (!(rel in now)) out.push(`${rel}: part of the scaffold, missing`);
      else if (now[rel] !== v) out.push(`${rel}: changed since Slack Off wrote the scaffold`);
    }
    for (const rel of Object.keys(now)) if (!(rel in scaffold)) out.push(`${rel}: not part of the scaffold`);
  }
  return out;
}

class Blocked extends Error {}

/** Throws (message = reason) unless the Bash call is exactly an allowed command and the specs are clean. */
export function checkSpecCall(input, commands, workDir, scaffold = null, cases = null) {
  if (input === null || typeof input !== "object") throw new Blocked("unreadable hook input");
  if (input.tool_name !== "Bash") throw new Blocked(`unexpected tool ${JSON.stringify(input.tool_name)}`);
  const command = input.tool_input !== null && typeof input.tool_input === "object" ? input.tool_input.command : undefined;
  if (typeof command !== "string" || !commands.includes(command)) {
    throw new Blocked(`only ${commands.map((c) => JSON.stringify(c)).join(" or ")} may run (exactly, no other arguments)`);
  }
  if (cases !== null && cases !== undefined) {
    const cv = caseViolations(join(workDir, "acceptance"), cases, scaffold);
    if (cv.length > 0) throw new Blocked(`the cases or examples break the acceptance rules: ${cv.slice(0, 10).join(" | ")}${cv.length > 10 ? ` (+${cv.length - 10} more)` : ""}`);
    return;
  }
  const v = specViolations(join(workDir, "acceptance"), scaffold);
  if (v.length > 0) throw new Blocked(`the specs break the acceptance rules: ${v.slice(0, 10).join(" | ")}${v.length > 10 ? ` (+${v.length - 10} more)` : ""}`);
}

const CONFIG_ARG = "--slackoff-spec=";

function configArg() {
  const args = process.argv.slice(2).filter((a) => a.startsWith(CONFIG_ARG));
  if (args.length !== 1) throw new Blocked("guard misconfigured: configuration argument missing");
  const raw = args[0].slice(CONFIG_ARG.length);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Blocked("guard misconfigured: configuration malformed");
  let v;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Blocked("guard misconfigured: configuration is not valid");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Blocked("guard misconfigured: configuration is not an object");
  return v;
}

function main() {
  const block = (why) => {
    try {
      process.stderr.write(`Blocked by Slack Off: ${why}\n`);
    } finally {
      process.exit(2);
    }
  };
  // T7-3: fail closed — any error, thrown or rejected, blocks the call
  process.on("uncaughtException", (err) => block(`guard error: ${err && err.message}`));
  process.on("unhandledRejection", (err) => block(`guard error: ${err && err.message}`));
  try {
    const { workDir, commands, scaffold = null, cases = null } = configArg();
    if (cases !== null && (!Array.isArray(cases) || !cases.every((c) => c && typeof c.repo === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(c.repo) && (c.library === null || typeof c.library === "string")))) {
      throw new Blocked("guard misconfigured: cases");
    }
    if (typeof workDir !== "string" || !isAbsolute(workDir)) throw new Blocked("guard misconfigured: work dir");
    if (!Array.isArray(commands) || commands.length === 0 || !commands.every((c) => typeof c === "string")) throw new Blocked("guard misconfigured: commands");
    if (scaffold !== null && (typeof scaffold !== "object" || Array.isArray(scaffold))) throw new Blocked("guard misconfigured: scaffold");
    let input;
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      throw new Blocked("unreadable hook input");
    }
    checkSpecCall(input, commands, workDir, scaffold, cases);
  } catch (err) {
    block(err instanceof Blocked ? err.message : `guard error: ${err && err.message}`);
  }
  process.exit(0);
}

function isEntryPoint() {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return realpathSync(resolve(arg)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
