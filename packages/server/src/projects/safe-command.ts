// A leaf module (no imports) so the executor sandbox can use it without an import cycle through config.ts.

const SAFE_COMMAND = /^[A-Za-z0-9_./:@=+,-]+( [A-Za-z0-9_./:@=+,-]+)*$/;

/** First tokens that run something other than the named program (or change the shell), refused outright. */
const SHELL_FIRST_TOKENS: ReadonlySet<string> = new Set([
  "eval", "exec", "source", ".", "command", "builtin", "export", "alias", "unset", "set", "env", "sudo", "sh", "bash", "zsh",
]);

/** One command line without shell metacharacters, quotes or newlines (split on spaces and run with execFile). */
export function isSafeCommand(cmd: string): boolean {
  if (cmd.length > 200 || !SAFE_COMMAND.test(cmd)) return false;
  const first = cmd.split(" ")[0]!;
  return !first.includes("=") && !first.startsWith("-") && !SHELL_FIRST_TOKENS.has(first);
}
