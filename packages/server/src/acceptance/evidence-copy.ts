// Task 9: copying an acceptance run's evidence into SLACKOFF_HOME (T8-2 carry). The files come from a directory the
// sandboxed run could write: every file is opened without following links, checked on its fd and copied from it.
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { AcceptanceResult, AcEvaluation } from "@slackoff/shared";
import type { EvidenceInput } from "./review-repo.ts";

const MAX_EVIDENCE_FILE = 5 * 1024 * 1024;
const MAX_EVIDENCE_FILES = 200;
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- evidence copy (T8-2 carry)

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

export type EvidenceItem = { refKey: string; acId: string; ref: AcceptanceResult["acs"][number]["flows"][number]["evidence"][number]; source: string };
export type Copied = { kept: EvidenceInput[]; dropped: Array<{ refKey: string; acId: string; why: string }> };

/** What kind of evidence `buf` is, or null: PNG / JPEG by their magic bytes, JSON, or UTF-8 text without NUL. */
export function evidenceKind(buf: Buffer): { kind: EvidenceInput["kind"]; ext: string } | null {
  if (buf.subarray(0, PNG.length).equals(PNG)) return { kind: "screenshot", ext: "png" };
  if (buf.subarray(0, JPEG.length).equals(JPEG)) return { kind: "screenshot", ext: "jpg" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
  if (text.includes("\0")) return null;
  try {
    JSON.parse(text);
    return { kind: "http", ext: "json" };
  } catch {
    return { kind: "log", ext: "txt" };
  }
}

/**
 * Copy the evaluated evidence into the review dir. Called once every process of the run is dead. Each source must lie
 * inside one of `roots` (the platform-known realpath(runRoot)/work/acceptance/{evidence,artifacts}, never a path taken
 * from the agent-writable tree), is opened with O_NOFOLLOW, fstat'ed (a regular file, ≤5 MB) and copied from that fd;
 * only PNG / JPEG images, JSON and text are kept, at most 200 per report. Anything else — vanished files included — is
 * dropped and named.
 */
export function copyEvidence(items: readonly EvidenceItem[], o: { roots: readonly string[]; destDir: string; relBase: string }): Copied {
  const kept: EvidenceInput[] = [];
  const dropped: Copied["dropped"] = [];
  const label = (e: EvidenceItem) => (e.ref.kind === "file" ? e.ref.path : e.ref.kind === "case" ? `case '${e.ref.case}'` : `attachment '${e.ref.name}'`);
  for (const e of items) {
    const drop = (why: string) => dropped.push({ refKey: e.refKey, acId: e.acId, why: `evidence ${label(e)} not kept: ${why}` });
    if (kept.length >= MAX_EVIDENCE_FILES) {
      drop(`more than ${MAX_EVIDENCE_FILES} evidence files in one report`);
      continue;
    }
    if (!o.roots.some((r) => e.source.startsWith(r + sep))) {
      drop("not inside the run's evidence/ or artifacts/");
      continue;
    }
    let fd: number;
    try {
      fd = openSync(e.source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      drop(code === "ENOENT" ? "the file vanished" : code === "ELOOP" ? "a symlink" : `cannot open it (${code ?? errMessage(err)})`);
      continue;
    }
    let buf: Buffer | null = null;
    let why = "";
    try {
      const st = fstatSync(fd);
      // T9-3: the fd must be the file the path names right now (no swap between the checks and the open)
      let same = false;
      try {
        const l = lstatSync(e.source);
        same = l.dev === st.dev && l.ino === st.ino;
      } catch {
        same = false;
      }
      if (!same) why = "it changed while being read";
      else if (!st.isFile()) why = "not a regular file";
      else if (st.size > MAX_EVIDENCE_FILE) why = "larger than 5 MB";
      else {
        const b = Buffer.alloc(st.size + 1);
        let off = 0;
        for (;;) {
          const n = readSync(fd, b, off, b.length - off, off);
          if (n === 0) break;
          off += n;
          if (off > st.size) break;
        }
        if (off > MAX_EVIDENCE_FILE || off !== st.size) why = "it changed while being read";
        else buf = b.subarray(0, off);
      }
    } finally {
      closeSync(fd);
    }
    if (buf === null) {
      drop(why);
      continue;
    }
    const k = evidenceKind(buf);
    if (k === null) {
      drop("not a PNG or JPEG image, JSON or text");
      continue;
    }
    const name = `${kept.length + 1}.${k.ext}`;
    writeFileSync(join(o.destDir, name), buf, { flag: "wx", mode: 0o600 });
    kept.push({
      refKey: e.refKey,
      acId: e.acId,
      kind: k.kind,
      path: `${o.relBase}/${name}`,
      caption: e.ref.caption,
      sha256: createHash("sha256").update(buf).digest("hex"),
      bytes: buf.length,
    });
  }
  return { kept, dropped };
}

/** Name the dropped evidence in its AC's mismatch and drop its keys; an AC left with no evidence cannot pass. */
export function applyDropped(acs: AcEvaluation[], c: Copied): AcEvaluation[] {
  if (c.dropped.length === 0) return acs;
  const gone = new Set(c.dropped.map((d) => d.refKey));
  const keptBy = new Set(c.kept.map((k) => k.acId));
  return acs.map((a) => {
    const notes = c.dropped.filter((d) => d.acId === a.acId).map((d) => d.why);
    if (notes.length === 0) return a;
    const flows = a.flows.map((f) => ({ ...f, evidenceKeys: f.evidenceKeys.filter((k) => !gone.has(k)) }));
    const none = !keptBy.has(a.acId);
    const why = [...notes, ...(none && a.verdict === "pass" ? ["no evidence left"] : [])].join("; ");
    // T9-6 (L2): only a pass is downgraded (an AC with no evidence left cannot pass); other verdicts stay as they are
    return { ...a, flows, verdict: none && a.verdict === "pass" ? "fail" : a.verdict, mismatch: a.mismatch ? `${a.mismatch}; ${why}` : why };
  });
}
