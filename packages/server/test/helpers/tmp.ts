import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Temp dirs created by a test file, removed when that file's process ends. node:test runs each file in its own
// process, and an exit hook (unlike a node:test `after`, which is scoped to whichever suite/test registered it)
// also covers dirs created lazily inside individual tests.
const made = new Set<string>();
let hooked = false;

/**
 * Like `mkdtempSync(join(tmpdir(), "slackoff-<prefix>-"))`, but the directory is removed when the test process exits.
 * `base`: another parent (e.g. /private/var/tmp for a scratch HOME outside every temp dir the dev sandbox may write).
 */
export function tmpDir(prefix: string, base: string = tmpdir()): string {
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const d of made) rmSync(d, { recursive: true, force: true });
    });
  }
  const dir = mkdtempSync(join(base, `slackoff-${prefix}-`));
  made.add(dir);
  return dir;
}
