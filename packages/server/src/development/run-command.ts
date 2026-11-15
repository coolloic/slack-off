import type { TestRun } from "@slackoff/shared";
import { runProcess } from "../git/worktree.ts";
import { isSafeCommand } from "../projects/safe-command.ts";
import { sandboxArgv, sandboxEnv, type CommandSandbox } from "../sandbox/local-sandbox.ts";

const OUTPUT_TAIL_BYTES = 8 * 1024;

/** The command is not one plain command line (quotes, shell metacharacters, a shell builtin…); it is never run. */
export class UnsafeCommandError extends Error {
  constructor(cmd: string) {
    super(`refusing to run "${cmd}": only a plain command without quotes or shell characters is allowed`);
    this.name = "UnsafeCommandError";
  }
}

/**
 * Run a repo command (build / lint / test / install) in `cwd`: checked with isSafeCommand, split on spaces and run with
 * execFile semantics — no shell, stdin closed, no TTY, its own process group killed whole on timeout. outputTail is the
 * last 8 KB of stdout and stderr interleaved. A program that cannot be started is a failed run (exitCode null).
 *
 * `sandbox` (Task 5, R-LOCAL): sandboxed → run under its sandbox-exec profile; unsandboxed (the developer's switch) →
 * run as is, the output starting with "[not sandboxed: <reason>]"; null only in tests. `env` replaces the server's
 * environment (acceptance: the target whitelist); default: the server's, without GIT_* / HUSKY*.
 */
export async function runCommand(
  cwd: string,
  cmd: string,
  timeoutMs: number,
  sandbox: CommandSandbox | null,
  env?: NodeJS.ProcessEnv,
  /** T9-6 (L3): told the command's process group while it runs (acceptance registers it for shutdown) */
  track?: { add(pgid: number): void; remove(pgid: number): void },
): Promise<TestRun> {
  if (!isSafeCommand(cmd)) throw new UnsafeCommandError(cmd);
  const [file, ...args] = cmd.split(" ");
  const note = sandbox?.kind === "unsandboxed" ? `[not sandboxed: ${sandbox.reason}]\n` : "";
  try {
    const argv = sandbox?.kind === "sandboxed" ? sandboxArgv(sandbox.scope, file!, args) : { file: file!, args };
    // T5-4: a sandboxed command never gets the ssh / gpg agent, and uses the ticket's own package caches
    const runEnv = sandbox?.kind === "sandboxed" ? sandboxEnv(sandbox.scope, env ?? process.env) : env;
    let pgid: number | null = null;
    let r;
    try {
      r = await runProcess(argv.file, argv.args, {
        cwd, timeoutMs, tailBytes: OUTPUT_TAIL_BYTES, ...(runEnv ? { env: runEnv } : {}),
        ...(track ? { onSpawn: (p: number) => track.add((pgid = p)) } : {}),
      });
    } finally {
      if (pgid !== null) track?.remove(pgid);
    }
    return { command: cmd, exitCode: r.timedOut ? null : r.code, timedOut: r.timedOut, outputTail: note + r.tail };
  } catch (err) {
    return { command: cmd, exitCode: null, timedOut: false, outputTail: `${note}cannot run ${file}: ${(err as Error).message}` };
  }
}
