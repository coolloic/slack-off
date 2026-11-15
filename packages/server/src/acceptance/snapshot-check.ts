// T9-4 / phase 4f (ruling 4F-1): whether an exported snapshot is still exactly what was committed. Used before the
// acceptance agent runs and after the platform's own case re-run ("the app under test changed during acceptance").
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";

/** git's blob id of `content`, sha1 or sha256 like `like`. */
export function blobId(content: Buffer, like: string): string {
  const h = createHash(like.length === 64 ? "sha256" : "sha1");
  h.update(`blob ${content.length}\0`);
  h.update(content);
  return h.digest("hex");
}

/** A regular file's bytes through an O_NOFOLLOW fd (never a symlink), at most `max` bytes; null when it is not one or too big. */
export function readFileNoFollow(path: string, max: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** Paths of the export (absolute) whose content is no longer the exported blob: changed, replaced or removed. */
export function changedSince(manifest: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [abs, oid] of manifest) {
    try {
      const st = lstatSync(abs);
      let content: Buffer;
      if (st.isSymbolicLink()) content = Buffer.from(readlinkSync(abs), "utf8");
      else if (st.isFile()) content = readFileNoFollow(abs, Number.MAX_SAFE_INTEGER) ?? Buffer.alloc(0);
      else {
        out.push(abs);
        continue;
      }
      if (blobId(content, oid) !== oid) out.push(abs);
    } catch {
      out.push(abs);
    }
  }
  return out.sort();
}
