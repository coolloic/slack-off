import { redactKnown } from "./credentials/credential-store.ts";

/** The server's error log (phase 4b, 4B-2): every line redacted with every credential value this process knows. */
export function logError(text: string): void {
  console.error(redactKnown(text));
}

/** An error as one loggable text: its stack (or message), and the parts of an AggregateError. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const own = err.stack ?? `${err.name}: ${err.message}`;
  if (!(err instanceof AggregateError)) return own;
  return [own, ...err.errors.map((e, i) => `  [${i}] ${describeError(e)}`)].join("\n");
}
