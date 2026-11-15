// Slack Off (phase 4f, ruling 4F-5 M1): reads the acceptance agent's cases and examples out of its old run root for the
// platform's re-run in a fresh one. Started by the platform under the OLD run's acceptance sandbox (sandboxArgv), so a
// link planted anywhere leads at most to what that sandbox may read. Plain JavaScript, node: built-ins only.
//
// One argument `--slackoff-read=<base64url JSON {root, dir, caps}>`: `root` the old run root, `dir` the repo's acceptance
// dir under it. Every component from `root` to each file is lstat'd (no symlink, plain dirs); each file is opened
// O_NOFOLLOW, checked on its fd, read, and its path lstat'd again afterwards (the same file, unchanged). Writes one JSON
// object to stdout: {files: [{sub, name, b64}], skipped: ["<sub>/<name>: <why>"]}; exit 2 on a refused layout.
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const ARG = "--slackoff-read=";

function fail(why) {
  process.stderr.write(`Slack Off: ${why}\n`);
  process.exit(2);
}

/** Every path from `root` (exclusive) to `p` (inclusive) is a real directory (lstat), never a link. */
function plainChain(root, p) {
  const rel = relative(resolve(root), resolve(p));
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  let cur = resolve(root);
  for (const part of rel === "" ? [] : rel.split("/")) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return false;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  return true;
}

function readOne(path, max) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    return { why: e && e.code === "ELOOP" ? "a symbolic link" : `unreadable (${e && e.code})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { why: "not a regular file" };
    if (st.size > max) return { why: `larger than ${max / 1024} KB` };
    const buf = Buffer.alloc(st.size + 1);
    let off = 0;
    for (;;) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
      if (off > st.size) break;
    }
    if (off !== st.size) return { why: "it changed while being read" };
    // the same file, unchanged, is still at that name
    let after;
    try {
      after = lstatSync(path);
    } catch {
      return { why: "it vanished while being read" };
    }
    if (after.dev !== st.dev || after.ino !== st.ino || after.size !== st.size || after.mtimeMs !== st.mtimeMs) return { why: "it changed while being read" };
    return { buf: buf.subarray(0, off) };
  } finally {
    closeSync(fd);
  }
}

function main() {
  const args = process.argv.slice(2).filter((a) => a.startsWith(ARG));
  if (args.length !== 1) fail("reader misconfigured");
  let cfg;
  try {
    cfg = JSON.parse(Buffer.from(args[0].slice(ARG.length), "base64url").toString("utf8"));
  } catch {
    fail("reader misconfigured");
  }
  const { root, dir, caps } = cfg;
  if (typeof root !== "string" || typeof dir !== "string" || !isAbsolute(root) || !isAbsolute(dir)) fail("reader misconfigured");
  if (!plainChain(root, dir)) fail(`${dir} is not a plain directory under the run root (a symbolic link on the way)`);
  const files = [];
  const skipped = [];
  let total = 0;
  for (const [sub, re, max, count] of [
    ["cases", /^[A-Za-z0-9._-]{1,200}\.case\.json$/, caps.caseBytes, caps.caseFiles],
    ["examples", /^[a-z0-9-]{1,64}\.mjs$/, caps.exampleBytes, caps.exampleFiles],
  ]) {
    const d = join(dir, sub);
    if (!plainChain(root, d)) {
      skipped.push(`${sub}: not a plain directory`);
      continue;
    }
    let names = readdirSync(d).sort();
    if (names.length > count) {
      skipped.push(`${sub}: more than ${count} entries — only the first ${count} are read`);
      names = names.slice(0, count);
    }
    for (const name of names) {
      if (sub === "examples" && name === "node_modules") continue; // the platform's own link, made again
      if (!re.test(name)) {
        skipped.push(`${sub}/${name}: not a case or example file`);
        continue;
      }
      const r = readOne(join(d, name), max);
      if (r.why !== undefined) {
        skipped.push(`${sub}/${name}: ${r.why}`);
        continue;
      }
      if (total + r.buf.length > caps.totalBytes) {
        skipped.push(`${sub}/${name}: over the ${caps.totalBytes / (1024 * 1024)} MB total`);
        continue;
      }
      total += r.buf.length;
      files.push({ sub, name, b64: r.buf.toString("base64") });
    }
  }
  // the dir itself is still the same plain chain after every read
  if (!plainChain(root, dir)) fail(`${dir} changed while being read`);
  process.stdout.write(JSON.stringify({ files, skipped }));
}

main();
