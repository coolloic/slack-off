// Slack Off file-tool guard: the Claude Code PreToolUse hook on Read / Edit / Write / MultiEdit / Grep / Glob /
// NotebookEdit (phase 4b, ruling 4B-4).
//
// Claude Code's own file tools run in the unsandboxed `claude` process, and `--restricted` checks the path as named: a
// symlink the agent (through Bash) or the repository puts in the worktree — `x -> ../../../credentials.json` — would
// reach any file. This hook resolves every path the call names (file_path, notebook_path, path; following each
// symlink, a dangling one too) and lets the call run only when the real path is inside one of the run's roots. A Glob
// pattern or Grep glob that is absolute or climbs with `..` is refused. F4B-1: for Grep and Glob the searched tree is
// walked (links not followed, at most WALK_MAX_ENTRIES entries) and any link in it that leads outside the roots refuses
// the call — a traversal that follows links would otherwise read through it.
//
// Plain JavaScript with node: built-ins only (like nav-guard-hook.mjs and spec-guard-hook.mjs), started by the
// server's own absolute Node in exec form (command + args, never through a shell prefix). It reads the hook JSON on
// stdin; exit 2 blocks the call (reason on stderr) and every failure path exits 2 (fail closed). Configuration: one
// argument `--slackoff-files=<base64url JSON {roots: string[]}>` with absolute roots.
//
// This file lives in the server source, outside every directory an agent may write.
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const WALK_MAX_ENTRIES = 50_000;
export const FILE_TOOLS = ["Read", "Edit", "Write", "MultiEdit", "Grep", "Glob", "NotebookEdit"];
/** the field naming the file each tool must have */
const REQUIRED = { Read: "file_path", Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const PATH_FIELDS = ["file_path", "notebook_path", "path"];

class Blocked extends Error {}

/**
 * The real path of `p`: every symlink followed (a dangling one to where it points), a missing tail appended to its
 * nearest existing ancestor's real path. Any other error (EACCES, ENOTDIR, a loop) blocks.
 */
export function resolveReal(p, depth = 0) {
  if (depth > 40) throw new Blocked("too many symbolic links");
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const parent = dirname(cur);
        if (parent === cur) return join(cur, ...rest);
        rest.unshift(basename(cur));
        cur = parent;
        continue;
      }
      throw new Blocked(`the path cannot be checked (${err && err.code ? err.code : "error"})`);
    }
    if (st.isSymbolicLink()) {
      let target;
      try {
        target = readlinkSync(cur);
      } catch {
        throw new Blocked("the path cannot be checked (a link)");
      }
      return resolveReal(join(resolve(dirname(cur), target), ...rest), depth + 1);
    }
    try {
      return join(realpathSync.native(cur), ...rest);
    } catch (err) {
      throw new Blocked(`the path cannot be checked (${err && err.code ? err.code : "error"})`);
    }
  }
}

const inside = (child, parent) => {
  const r = relative(parent, child);
  return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
};

/**
 * 4B-6 (F1, F2, F4): text Claude Code or the kernel may read differently from path.resolve, refused outright — a
 * `..` segment (after a symlinked dir the kernel follows the link first, resolve() would collapse it), a leading `~`
 * (a home dir expansion), and braces (glob alternatives such as {..,x}). The cost: such names cannot be used at all.
 * Only a segment that is exactly ".." steps up, so a name such as a..b.ts or "..." stays usable in a path.
 */
const tildeOrBraces = (s) => s.startsWith("~") || s.includes("{") || s.includes("}");
const ambiguousPath = (s) => s.split("/").includes("..") || tildeOrBraces(s);

/**
 * A glob that could leave the searched directory: absolute (after a leading "!" negation too), any ".." at all (a
 * segment such as ..* is a pattern), a leading ~, or a brace alternative that starts with "/" or "~" ({/etc/*,x},
 * {a,~/x}, nested too). Braces otherwise stay inside the directory (*.{ts,js}, a negated list of folders): agents
 * write them by habit and a refused call fails the run (author decision 2026-11-09). Paths keep the strict rule.
 */
const escapingGlob = (g) => {
  const body = g.startsWith("!") ? g.slice(1) : g;
  return isAbsolute(body) || g.includes("..") || body.startsWith("~") || /[{,]\s*[/~]/.test(g);
};

/** Throws (message = reason) unless every path the call names is really inside one of `roots` (real paths). */
export function checkFileCall(input, roots, opts = {}) {
  if (input === null || typeof input !== "object") throw new Blocked("unreadable hook input");
  const tool = input.tool_name;
  if (typeof tool !== "string" || !FILE_TOOLS.includes(tool)) throw new Blocked(`unexpected tool ${JSON.stringify(tool)}`);
  const args = input.tool_input;
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Blocked("unreadable tool input");
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? input.cwd : null;
  const named = [];
  for (const field of PATH_FIELDS) {
    const v = args[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v === "" || v.includes("\0")) throw new Blocked(`${field} is not a path`);
    if (ambiguousPath(v)) throw new Blocked(`${field} may not contain a ".." segment, "{" or "}", or start with "~"`);
    named.push(v);
  }
  const required = REQUIRED[tool];
  if (required !== undefined && (typeof args[required] !== "string" || args[required] === "")) throw new Blocked(`${tool} needs ${required}`);
  if (tool === "Grep" || tool === "Glob") {
    // without a path they search the cwd
    if (named.length === 0) {
      if (cwd === null) throw new Blocked("no path and no working directory");
      named.push(cwd);
    }
    // Glob's pattern and Grep's glob filter are paths (Grep's own pattern is a regex)
    for (const g of tool === "Glob" ? [args.pattern, args.glob] : [args.glob]) {
      if (g === undefined || g === null) continue;
      if (typeof g !== "string" || escapingGlob(g)) throw new Blocked("the glob reaches outside the searched directory (\"..\", an absolute path, a leading ~ or a brace alternative starting with / or ~ are refused) — keep the pattern inside the searched directory");
    }
  }
  for (const p of named) {
    if (!isAbsolute(p) && cwd === null) throw new Blocked("a relative path without a working directory");
    const real = resolveReal(isAbsolute(p) ? p : resolve(cwd, p));
    if (!roots.some((r) => inside(real, r))) throw new Blocked("the path is outside the directories of this run (symbolic links are followed)");
    // F4B-1: Grep and Glob traverse the tree (and may follow the links in it): every link in it must stay inside
    if (tool === "Grep" || tool === "Glob") walkTree(real, roots, opts.maxEntries ?? WALK_MAX_ENTRIES);
  }
}

/**
 * F4B-1: walk the tree under `start` (a real path) without following links, at most `max` entries (over → refused).
 * A symlink anywhere in it that resolves outside the roots (a dangling one by where it points) refuses the call; one
 * that resolves to a directory inside the roots is walked too (a traversal that follows links would go there), each
 * real directory once.
 */
function walkTree(start, roots, max) {
  let st;
  try {
    st = lstatSync(start);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    throw new Blocked(`the path cannot be checked (${err && err.code ? err.code : "error"})`);
  }
  if (!st.isDirectory()) return;
  const seen = new Set([start]);
  const queue = [start];
  let entries = 0;
  while (queue.length > 0) {
    const dir = queue.pop();
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Blocked(`the folder cannot be checked (${err && err.code ? err.code : "error"})`);
    }
    for (const ent of list) {
      entries += 1;
      if (entries > max) throw new Blocked(`the searched folder has too many entries to check (over ${max}); search a smaller folder`);
      const p = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        const real = resolveReal(p);
        if (!roots.some((r) => inside(real, r))) throw new Blocked("the searched folder holds a symbolic link that leads outside the directories of this run");
        let target;
        try {
          target = statSync(real);
        } catch {
          continue; // dangling inside the roots: nothing to traverse
        }
        if (target.isDirectory() && !seen.has(real)) {
          seen.add(real);
          queue.push(real);
        }
      } else if (ent.isDirectory() && !seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
}

/** The configured roots as real paths; refused unless each is absolute and not "/". */
export function realRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) throw new Blocked("guard misconfigured: no roots");
  return roots.map((r) => {
    if (typeof r !== "string" || !isAbsolute(r)) throw new Blocked("guard misconfigured: a root is not absolute");
    const real = resolveReal(r);
    if (dirname(real) === real) throw new Blocked("guard misconfigured: a root is the whole disk");
    return real;
  });
}

function config() {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--slackoff-files="));
  const raw = arg === undefined ? undefined : arg.slice("--slackoff-files=".length);
  if (raw === undefined || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Blocked("guard misconfigured: --slackoff-files missing or malformed");
  let v;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Blocked("guard misconfigured: --slackoff-files is not valid");
  }
  if (v === null || typeof v !== "object") throw new Blocked("guard misconfigured");
  return realRoots(v.roots);
}

function block(why) {
  process.stderr.write(`Blocked by Slack Off: ${why}\n`);
  process.exit(2);
}

/**
 * 4B-6 (F6): any exception nobody caught blocks the call (exit 2): Claude Code treats every other exit code as
 * non-blocking. (A hook killed by a signal or its 30 s timeout is not blocking either: a README residual.)
 */
export function installCrashGuard() {
  process.on("uncaughtException", (err) => block(`guard error: ${err && err.message}`));
}

function main() {
  installCrashGuard();
  try {
    const roots = config();
    let input;
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      throw new Blocked("unreadable hook input");
    }
    checkFileCall(input, roots);
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
