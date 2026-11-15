// SANDBOX_SELF_CHECK (spike §6.3): `node selfcheck.mjs <deniedPath> <port>... [--unix <socket>] [--unix-scratch <dir>]...
// [--own <dir>] [--signal <pid>] [--launchservices] [--allowed <dir>]`,
// run inside the sandbox profile. Connects to 127.0.0.1:<port> for each port, opens the denied path, sends signal 0 to
// a process outside the sandbox; prints e.g. "4317:EPERM 5173:EPERM 9229:EPERM 9230:EPERM file:EPERM signal:EPERM
// allowed:OK" and exits 0 only when every connect, the open and the signal fail with EPERM (and the allowed directory
// can be listed). The sandbox refuses the connect itself, so nothing needs to listen; signal 0 never disturbs the target.
// T5-7: for each --unix-scratch dir (an empty scratch dir in a temp dir, made and removed by the caller) the check
// listens on its own socket there and connects to it: must be EPERM (a daemon listening in a temp dir is unreachable).
// T5-8, with --own <dir>: moving that socket into the own dir (where sockets are allowed) must be EPERM too.
// T6-2 (acceptance, which cannot create a socket there): --unix-peer <socket> names a socket the caller listens on
// (in a temp dir or /private/var/tmp); connecting to it and moving it into --own must be EPERM. --no-write <dir>:
// creating a file there must be EPERM. --denied-read <path>: reading it (a file, or listing a dir) must be EPERM.
// F-4 (M-3): --remote <ipv4>:<port> (the server's Tailscale listener): connecting must be EPERM — the sandbox refuses
// it before any packet is sent.
// 4a (dev-hook): --git-admin <dir>: creating and removing a file there must work ("gitadmin:OK"); --git-config <file>:
// opening it for writing (no create, no truncate, nothing written) must be EPERM ("gitconfig:EPERM").
// phase 4a Task 4: --undeclared <port>: connecting to it on 127.0.0.1, ::1 and ::ffff:127.0.0.1 must be EPERM.
import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1] ?? "";
  argv.splice(i, 2);
  return v;
};
const allowed = option("--allowed");
const lsIndex = argv.indexOf("--launchservices");
const launchServices = lsIndex !== -1;
if (launchServices) argv.splice(lsIndex, 1);
const signalPid = option("--signal");
const unixProbe = option("--unix");
const ownDir = option("--own");
const many = (name) => {
  const out = [];
  for (let v = option(name); v !== null; v = option(name)) out.push(v);
  return out;
};
const scratchDirs = many("--unix-scratch");
const peers = many("--unix-peer");
const noWrite = many("--no-write");
const deniedRead = many("--denied-read");
const remotes = many("--remote");
const gitAdmin = option("--git-admin");
const gitConfig = option("--git-config");
const undeclared = option("--undeclared");
const [denied, ...ports] = argv;

const tryUnix = (path) =>
  new Promise((resolve) => {
    const s = connect(path);
    s.setTimeout(3000, () => {
      s.destroy();
      resolve("TIMEOUT");
    });
    s.on("connect", () => {
      s.destroy();
      resolve("CONNECTED");
    });
    s.on("error", (e) => resolve(e.code ?? "ERROR"));
  });

const tryConnect = (port, host = "127.0.0.1") =>
  new Promise((resolve) => {
    const s = connect({ host, port: Number(port) });
    s.setTimeout(3000, () => {
      s.destroy();
      resolve("TIMEOUT");
    });
    s.on("connect", () => {
      s.destroy();
      resolve("CONNECTED");
    });
    s.on("error", (e) => resolve(e.code ?? "ERROR"));
  });

const results = [];
let ok = typeof denied === "string" && denied !== "" && ports.length > 0;
for (const port of ports) {
  const r = await tryConnect(port);
  results.push(`${port}:${r}`);
  if (r !== "EPERM") ok = false;
}
try {
  closeSync(openSync(denied ?? "", "r"));
  results.push("file:READABLE");
  ok = false;
} catch (e) {
  results.push(`file:${e.code ?? "ERROR"}`);
  if (e.code !== "EPERM") ok = false;
}
// phase 4a Task 4 (allowlist mode): a port nobody declared — the caller listens there on every loopback form — must be
// refused by the sandbox on 127.0.0.1, ::1 and the IPv4-mapped ::ffff:127.0.0.1 (spike §3)
if (undeclared !== null) {
  const bad = [];
  for (const host of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const r = await tryConnect(undeclared, host);
    if (r !== "EPERM") bad.push(`${host}=${r}`);
  }
  results.push(`undeclared:${bad.length === 0 ? "EPERM" : bad.join(",")}`);
  if (bad.length > 0) ok = false;
}
for (const [i, r0] of remotes.entries()) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(r0);
  const r = m === null ? "BADADDR" : `${m[1]}:${m[2]}:${await tryConnect(m[2], m[1])}`;
  results.push(`remote${i}:${r}`);
  if (!r.endsWith(":EPERM")) ok = false;
}
// T5-6: a unix socket outside the allowed dirs must be refused by the sandbox (EPERM), not by the peer
if (unixProbe !== null) {
  const r = await tryUnix(unixProbe);
  results.push(`unix:${r}`);
  if (r !== "EPERM") ok = false;
}
// T5-7: a socket listening in a temp dir (where VS Code, Chrome, proxies listen) must be refused too
for (const [i, dir] of scratchDirs.entries()) {
  let r;
  let mv = null;
  let server = null;
  const sock = join(dir, "s");
  try {
    server = await new Promise((resolve, reject) => {
      const sv = createServer((c) => c.destroy());
      sv.once("error", reject);
      sv.listen(sock, () => resolve(sv));
    });
    r = await tryUnix(sock);
    if (ownDir !== null) {
      const target = join(ownDir, `slackoff-sc-${process.pid}-${i}`);
      try {
        renameSync(sock, target);
        mv = "MOVED";
        rmSync(target, { force: true });
      } catch (e) {
        mv = e.code ?? "ERROR";
      }
    }
  } catch (e) {
    r = `SETUP_${e.code ?? "ERROR"}`;
  } finally {
    if (server !== null) await new Promise((resolve) => server.close(() => resolve()));
    // best effort: inside the dev sandbox nothing in a temp dir can be removed (T5-8); the caller removes the dir
    try {
      rmSync(sock, { force: true });
    } catch {
      // left for the caller
    }
  }
  results.push(`unixtmp${i}:${r}`);
  if (r !== "EPERM") ok = false;
  if (ownDir !== null) {
    results.push(`unixmv${i}:${mv ?? "NOT_RUN"}`);
    if (mv !== "EPERM") ok = false;
  }
}
// T6-2: a socket the caller listens on outside the run root: unreachable, and not movable into the own dir
for (const [i, sock] of peers.entries()) {
  const r = await tryUnix(sock);
  results.push(`unixtmp${i}:${r}`);
  if (r !== "EPERM") ok = false;
  if (ownDir !== null) {
    const target = join(ownDir, `slackoff-sc-${process.pid}-${i}`);
    let mv;
    try {
      renameSync(sock, target);
      mv = "MOVED";
      try {
        renameSync(target, sock);
      } catch {
        rmSync(target, { force: true });
      }
    } catch (e) {
      mv = e.code ?? "ERROR";
    }
    results.push(`unixmv${i}:${mv}`);
    if (mv !== "EPERM") ok = false;
  }
}
for (const [i, dir] of noWrite.entries()) {
  const f = join(dir, `slackoff-sc-w-${process.pid}`);
  let r;
  try {
    closeSync(openSync(f, "wx"));
    r = "WRITTEN";
    rmSync(f, { force: true });
  } catch (e) {
    r = e.code ?? "ERROR";
  }
  results.push(`nowrite${i}:${r}`);
  if (r !== "EPERM") ok = false;
}
for (const [i, path] of deniedRead.entries()) {
  let r;
  try {
    if (statSync(path).isDirectory()) readdirSync(path);
    else closeSync(openSync(path, "r"));
    r = "READABLE";
  } catch (e) {
    r = e.code ?? "ERROR";
  }
  results.push(`deniedread${i}:${r}`);
  if (r !== "EPERM") ok = false;
}
if (signalPid !== null) {
  const pid = Number(signalPid);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    results.push("signal:BADPID");
    ok = false;
  } else {
    try {
      process.kill(pid, 0);
      results.push("signal:DELIVERED");
      ok = false;
    } catch (e) {
      results.push(`signal:${e.code ?? "ERROR"}`);
      if (e.code !== "EPERM") ok = false;
    }
  }
}
// T5-4: LaunchServices must be unreachable (opening an app would run it outside the sandbox). `lsappinfo front` is
// read-only: with the service it prints the front app's "ASN:…", without it "[ NULL ]".
if (launchServices) {
  let r;
  try {
    const out = execFileSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    // T5-6: exactly "[ NULL ]" passes; anything else (an ASN, an empty or unexpected answer) fails closed
    r = out.trim() === "[ NULL ]" ? "DENIED" : /^ASN:/m.test(out) ? "REACHABLE" : "UNEXPECTED";
  } catch {
    r = "ERROR";
  }
  results.push(`launchservices:${r}`);
  if (r !== "DENIED") ok = false;
}
if (allowed !== null) {
  try {
    readdirSync(allowed);
    results.push("allowed:OK");
  } catch (e) {
    results.push(`allowed:${e.code ?? "ERROR"}`);
    ok = false;
  }
}
if (gitAdmin !== null) {
  const f = join(gitAdmin, `slackoff-sc-${process.pid}`);
  let r;
  try {
    closeSync(openSync(f, "wx"));
    unlinkSync(f);
    r = "OK";
  } catch (e) {
    r = e.code ?? "ERROR";
  }
  results.push(`gitadmin:${r}`);
  if (r !== "OK") ok = false;
}
if (gitConfig !== null) {
  let r;
  try {
    closeSync(openSync(gitConfig, constants.O_WRONLY));
    r = "WRITABLE";
  } catch (e) {
    r = e.code ?? "ERROR";
  }
  results.push(`gitconfig:${r}`);
  if (r !== "EPERM") ok = false;
}
console.log(results.join(" "));
process.exit(ok ? 0 : 1);
