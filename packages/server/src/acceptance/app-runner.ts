// Task 6: the target app lifecycle of an acceptance run. Install, start and stop run in the acceptance sandbox with a
// whitelisted environment (S-3, T6-1); the health check runs in the platform (outside the sandbox). Every process group
// the platform starts is registered (PlatformProcesses) so shutdown and restart recovery can stop it.
import type { AcceptanceTarget } from "@slackoff/shared";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { runCommand } from "../development/run-command.ts";
import { startProcess } from "../git/run.ts";
import type { AppAcceptanceRules } from "../projects/project-rules.ts";
import { isSafeCommand } from "../projects/safe-command.ts";
import { runTmpDir, sandboxArgv, sandboxEnv, type SandboxScope } from "../sandbox/local-sandbox.ts";

export interface StartedTarget extends AcceptanceTarget {
  /** the app's process group while it runs; null when it was never started or is already stopped */
  pgid: number | null;
  /** the rule file's `stop` command, run by stopTargets */
  stop?: string;
}

/** S-3: the only server variables a target app, its install / stop and the project's test command get. */
export const ACCEPT_APP_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "TMPDIR"] as const;
const TMP_ENV = ["TMPDIR", "TMP", "TEMP"] as const;
const OUTPUT_TAIL_BYTES = 8 * 1024;
const HEALTH_INTERVAL_MS = 500;
const HEALTH_REQUEST_MS = 2_000;
const PORT_PROBE_MS = 200;
const STOP_COMMAND_MS = 10_000;
const STOP_GRACE_MS = 5_000;
/** a reason's output part: the last lines only */
const REASON_TAIL = 1_500;

/**
 * The environment of a target app (and its install / stop / the project's test command): ACCEPT_APP_ENV_KEYS from the
 * server's environment, the rule file's acceptance.env, then TMPDIR / TMP / TEMP = <runRoot>/tmp (T6-1: the run's own
 * temp and socket dir, whatever the server or the rule file says) and SLACKOFF_RUN_ROOT (restart recovery recognises
 * the run's processes by it). Nothing else (no SLACKOFF_*, tokens, ssh agent).
 */
export function targetEnv(acceptanceEnv: Record<string, string>, runRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ACCEPT_APP_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, acceptanceEnv);
  for (const k of TMP_ENV) env[k] = runTmpDir(runRoot);
  env.SLACKOFF_RUN_ROOT = runRoot;
  return env;
}

function killGroup(pgid: number, signal: NodeJS.Signals): boolean {
  // never 0 / 1 / negative: kill(-1) would signal every process of the user
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

const groupExists = (pgid: number): boolean => killGroup(pgid, 0 as unknown as NodeJS.Signals);

/** The process groups of target apps the platform started; main.ts kills them all on shutdown and exit (Task 9). */
export class PlatformProcesses {
  private readonly groups = new Map<number, string>();
  add(pgid: number, runRoot: string): void {
    this.groups.set(pgid, runRoot);
  }
  remove(pgid: number): void {
    this.groups.delete(pgid);
  }
  /** how many groups are registered */
  get size(): number {
    return this.groups.size;
  }
  has(pgid: number): boolean {
    return this.groups.has(pgid);
  }
  /** SIGKILL every registered group (synchronous: safe in process.on('exit')). */
  killAll(): void {
    for (const pgid of this.groups.keys()) killGroup(pgid, "SIGKILL");
    this.groups.clear();
  }
}

const portOf = (baseUrl: string): number => {
  const u = new URL(baseUrl);
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
};

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(PORT_PROBE_MS, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Whether something listens on baseUrl's port, on 127.0.0.1 or ::1 (a TCP connect each, 200 ms timeout). */
export async function portInUse(baseUrl: string): Promise<boolean> {
  const port = portOf(baseUrl);
  const r = await Promise.all([tryConnect("127.0.0.1", port), tryConnect("::1", port)]);
  return r.some(Boolean);
}

const lastOutput = (s: string) => {
  const t = s.trim();
  return t.length > REASON_TAIL ? `…${t.slice(-REASON_TAIL)}` : t;
};

/** GET baseUrl+healthPath (string concatenation, never new URL(path, base)); any HTTP answer below 500 is ready. */
async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(HEALTH_REQUEST_MS) });
    await r.body?.cancel();
    return r.status < 500;
  } catch {
    return false;
  }
}

/** SIGTERM the group, SIGKILL after `graceMs` if anything is left. */
async function terminate(pgid: number, graceMs: number): Promise<void> {
  if (!killGroup(pgid, "SIGTERM")) return;
  const end = Date.now() + graceMs;
  while (Date.now() < end) {
    if (!groupExists(pgid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  killGroup(pgid, "SIGKILL");
}

/**
 * Start each repo's app in mapping order: install (acceptance-install sandbox), start (acceptance sandbox, long-running,
 * registered), then poll the health URL every 500 ms from the platform until startTimeoutMs; then the next repo.
 * A port already in use (checked for every target before anything starts), a failed install, an early exit or no answer
 * → notExecutedReason, and the failing app's group is killed. Apps started before the failure keep running: the caller
 * stops them with stopTargets.
 */
export async function startTargets(o: {
  workDir: string;
  repos: readonly { name: string; acceptance: AppAcceptanceRules }[];
  startTimeoutMs: number;
  commandTimeoutMs: number;
  runRoot: string;
  sandbox: SandboxScope;
  processes: PlatformProcesses;
  onPgid(pgid: number): void;
}): Promise<{ targets: StartedTarget[]; notExecutedReason: string | null }> {
  const targets: StartedTarget[] = o.repos.map((r) => ({
    repo: r.name,
    entry: r.acceptance.entry,
    baseUrl: r.acceptance.baseUrl,
    started: false,
    detail: "not started",
    pgid: null,
    ...(r.acceptance.stop ? { stop: r.acceptance.stop } : {}),
  }));
  const scope: SandboxScope = { ...o.sandbox, kind: "acceptance", runRoot: o.runRoot };
  const fail = (t: StartedTarget, reason: string) => {
    t.detail = reason;
    return { targets, notExecutedReason: reason };
  };

  const inUse = (t: StartedTarget) => `port ${portOf(t.baseUrl)} is already in use — stop the process using it, then re-run acceptance`;
  // I5: two targets on one port would health-check each other
  for (const [i, t] of targets.entries()) {
    const other = targets.slice(0, i).find((x) => portOf(x.baseUrl) === portOf(t.baseUrl));
    if (other) return fail(t, `${other.repo} and ${t.repo} both use port ${portOf(t.baseUrl)} — give each target its own port`);
  }
  for (const t of targets) {
    if (await portInUse(t.baseUrl)) return fail(t, inUse(t));
  }

  for (const [i, r] of o.repos.entries()) {
    const t = targets[i]!;
    const a = r.acceptance;
    const cwd = join(o.workDir, r.name);
    const env = targetEnv(a.env, o.runRoot);
    // I5: again right before this target (an app started earlier, or anything else, may have taken the port since)
    if (await portInUse(t.baseUrl)) return fail(t, inUse(t));
    if (a.install) {
      const run = await runCommand(cwd, a.install, o.commandTimeoutMs, { kind: "sandboxed", scope: { ...scope, kind: "acceptance-install" } }, env, {
        // T9-6 (L3): registered for shutdown while it runs (recovery finds it by SLACKOFF_RUN_ROOT); onPgid is for apps
        add: (p) => o.processes.add(p, o.runRoot),
        remove: (p) => o.processes.remove(p),
      });
      if (run.exitCode !== 0) {
        const why = run.timedOut ? "timed out" : `exit ${run.exitCode ?? "—"}`;
        return fail(t, `install of ${r.name} failed (${why}): ${lastOutput(run.outputTail)}`);
      }
    }
    if (!isSafeCommand(a.start)) return fail(t, `start command of ${r.name} is not a plain command`);
    const [file, ...args] = a.start.split(" ");
    let proc;
    try {
      const argv = sandboxArgv(scope, file!, args);
      proc = startProcess(argv.file, argv.args, { cwd, env: sandboxEnv(scope, env), tailBytes: OUTPUT_TAIL_BYTES });
    } catch (err) {
      return fail(t, `${r.name} could not be started: ${(err as Error).message}`);
    }
    t.pgid = proc.pgid;
    o.processes.add(proc.pgid, o.runRoot);
    o.onPgid(proc.pgid);
    let exit: { code: number | null } | null = null;
    void proc.exited.then((code) => (exit = { code }));

    const url = a.baseUrl + a.healthPath;
    const end = Date.now() + o.startTimeoutMs;
    let ready = false;
    while (!ready && exit === null && Date.now() < end) {
      ready = await healthy(url);
      if (ready) {
        // I5: an answer only counts while our app still runs: confirm one interval later (something else on the port
        // answers while the app has already exited)
        await new Promise((res) => setTimeout(res, HEALTH_INTERVAL_MS));
        ready = exit === null && (await healthy(url)) && exit === null;
      }
      if (!ready && exit === null) await new Promise((res) => setTimeout(res, HEALTH_INTERVAL_MS));
    }
    if (!ready) {
      const reason =
        exit !== null
          ? `${r.name} exited before it was ready (exit ${(exit as { code: number | null }).code ?? "by signal"}): ${lastOutput(proc.tail())}`
          : `${r.name} did not respond at ${url} within ${Math.round(o.startTimeoutMs / 1000)} s: ${lastOutput(proc.tail())}`;
      killGroup(proc.pgid, "SIGKILL");
      o.processes.remove(proc.pgid);
      t.pgid = null;
      return fail(t, reason);
    }
    t.started = true;
    t.detail = `started; ${url} is answering`;
  }
  return { targets, notExecutedReason: null };
}

/**
 * Stop in reverse order: the declared `stop` command in the same sandbox (acceptance kind, this run root; 10 s), then SIGTERM the app's group and
 * SIGKILL after 5 s; unregistered. Never throws.
 */
export async function stopTargets(
  targets: readonly StartedTarget[],
  workDir: string,
  o: { env: NodeJS.ProcessEnv; sandbox: SandboxScope; processes: PlatformProcesses; runRoot: string },
): Promise<void> {
  // M7: the acceptance kind and this run's root, as in startTargets
  const scope: SandboxScope = { ...o.sandbox, kind: "acceptance", runRoot: o.runRoot };
  for (const t of [...targets].reverse()) {
    try {
      if (t.stop && t.started) {
        await runCommand(join(workDir, t.repo), t.stop, STOP_COMMAND_MS, { kind: "sandboxed", scope }, o.env);
      }
    } catch {
      // a stop command that cannot run: the group is killed below anyway
    }
    if (t.pgid !== null) {
      try {
        await terminate(t.pgid, STOP_GRACE_MS);
      } catch {
        // never throws
      }
      o.processes.remove(t.pgid);
      t.pgid = null;
    }
  }
}

/** 4F-2: the processes with their cwd or an open file under `dir` (lsof +D, 15 s), never this one or its parent. */
function pidsUnder(dir: string): number[] {
  if (!isAbsolute(dir) || resolve(dir) === "/") return [];
  let out = "";
  try {
    out = execFileSync("/usr/sbin/lsof", ["-t", "-w", "+D", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    // lsof exits 1 when it lists nothing; its output is still the list
    out = String((e as { stdout?: unknown }).stdout ?? "");
  }
  return [...new Set(out.split("\n").map(Number).filter((p) => Number.isInteger(p) && p > 1 && p !== process.pid && p !== process.ppid))];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Stop what is left of a run (restart recovery, and the end of every run before its evidence is read):
 * - SIGKILL each of `pgids` whose processes (`ps`, command line and environment) mention `runRoot` — as
 *   SLACKOFF_RUN_ROOT or a path in it. A group that does not is left alone (its pid may have been reused);
 * - Task 9: SIGKILL every process, whatever its group, whose environment (`ps -E`) carries SLACKOFF_RUN_ROOT=<runRoot>
 *   or TMPDIR=<runRoot>/tmp (the shim's `env -i` keeps only the latter for Playwright and its browser), or a case's
 *   TMPDIR=<runRoot>/cases-tmp/<n> (phase 4f);
 * - phase 4f (ruling 4F-2): SIGKILL every process whose cwd or an open file lies under `runRoot`
 *   (`/usr/sbin/lsof +D`, best effort): a detached escapee that emptied its environment. One with no handle there
 *   survives (README); it stays in its sandbox, which cannot write a later run root.
 * Never this process or its parent.
 */
export function killLeftovers(runRoot: string, pgids: readonly number[]): void {
  for (const pid of pidsUnder(runRoot)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-E", "-ww", "-o", "pid=,pgid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return;
  }
  // the run root as a whole path: followed by "/", whitespace or the end, never a longer name
  const mark = new RegExp(`${escapeRe(runRoot)}(?=/|\\s|$)`);
  // the run's own variables, as `ps -E` prints the environment after the command (preceded by whitespace)
  const envMark = new RegExp(`(?:^|\\s)(?:SLACKOFF_RUN_ROOT=${escapeRe(runRoot)}|TMPDIR=${escapeRe(runRoot)}/(?:tmp|cases-tmp/[0-9]+)/?)(?=\\s|$)`);
  const wanted = new Set(pgids);
  const groups = new Set<number>();
  const pids = new Set<number>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const pgid = Number(m[2]);
    if (wanted.has(pgid) && mark.test(m[3]!)) groups.add(pgid);
    if (envMark.test(m[3]!) && pid !== process.pid && pid !== process.ppid && pid > 1) pids.add(pid);
  }
  for (const pgid of groups) killGroup(pgid, "SIGKILL");
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}
