// F2-I1: the fingerprint of a hooks directory. Its own module (node built-ins only) so the phase 4a hook wrappers can
// re-check it before each hook runs (sandbox/hook-verify.ts) without loading the rest of the server.
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";

const HOOK_WALK_LIMIT = 2000;
/** F4A-3 (M-b): the most bytes read from one hook file, and from the whole directory; over that the hash fails closed. */
export const HOOK_FILE_MAX_BYTES = 1024 * 1024;
export const HOOKS_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

export class HooksTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HooksTooLargeError";
  }
}

/**
 * `p`'s bytes, never more than `max` (a file that grew past it after its lstat is refused too); O_NOFOLLOW, so a file
 * swapped for a symlink is not read through.
 */
function readBounded(p: string, max: number): Buffer {
  const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > max) throw new HooksTooLargeError(`the hook file ${p} is over 1 MiB — the hooks cannot be fingerprinted`);
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Hash every entry under `dir` (sorted, recursive, bounded); a missing directory hashes as empty. F4A-3 (M-b): a hook
 * file over 1 MiB, or over 16 MiB read in all, throws HooksTooLargeError (fail closed: no pin, no hook run).
 */
export function hashHooksDir(dir: string): string {
  const h = createHash("sha256");
  let seen = 0;
  let total = 0;
  const walk = (abs: string, rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (++seen > HOOK_WALK_LIMIT) {
        h.update("\0truncated");
        return;
      }
      const p = join(abs, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) h.update(`L\0${r}\0${readlinkSync(p)}\0`);
      else if (st.isDirectory()) {
        h.update(`D\0${r}\0`);
        if (depth < 8) walk(p, r, depth + 1);
      } else if (st.isFile()) {
        if (st.size > HOOK_FILE_MAX_BYTES) throw new HooksTooLargeError(`the hook file ${p} is over 1 MiB — the hooks cannot be fingerprinted`);
        const bytes = readBounded(p, HOOK_FILE_MAX_BYTES);
        total += bytes.length;
        if (total > HOOKS_TOTAL_MAX_BYTES) throw new HooksTooLargeError(`the hooks directory ${dir} holds over 16 MiB — the hooks cannot be fingerprinted`);
        h.update(`F\0${r}\0${(st.mode & 0o111) !== 0 ? "x" : "-"}\0`);
        h.update(bytes);
        h.update("\0");
      } else h.update(`O\0${r}\0`);
    }
  };
  walk(dir, "", 0);
  return h.digest("hex");
}
