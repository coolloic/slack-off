// Task 9 (T8-2 carry, T9-6): copying an acceptance run's evidence. Scratch dirs only; no sandbox needed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcEvaluation } from "@slackoff/shared";
import { applyDropped, copyEvidence, type EvidenceItem } from "../src/acceptance/evidence-copy.ts";
import { tmpDir } from "./helpers/tmp.ts";

const root = realpathSync(tmpDir("evc"));
after(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);

let n = 0;
function layout() {
  const base = join(root, `case-${++n}`);
  const evidence = join(base, "acceptance", "evidence");
  const artifacts = join(base, "acceptance", "artifacts");
  const dest = join(base, "dest");
  for (const d of [evidence, artifacts, dest]) mkdirSync(d, { recursive: true });
  return { base, evidence, artifacts, dest, roots: [evidence, artifacts] };
}
const item = (source: string, acId = "AC-1", i = 1): EvidenceItem => ({
  refKey: `${acId}/${i}`, acId, source, ref: { kind: "file", path: `evidence/x${i}.png`, caption: "c" },
});
const copy = (l: ReturnType<typeof layout>, items: EvidenceItem[]) => copyEvidence(items, { roots: l.roots, destDir: l.dest, relBase: "FAKE-1/1-1" });

test("copyEvidence: PNG / JPEG by magic bytes, JSON and text are kept with their kind, hash and size", () => {
  const l = layout();
  const files: Array<[string, Buffer | string]> = [["a.png", PNG], ["b.jpg", JPEG], ["c.json", '{"status":200}'], ["d.txt", "plain log line\n"]];
  for (const [f, c] of files) writeFileSync(join(l.evidence, f), c);
  const r = copy(l, files.map(([f], i) => item(join(l.evidence, f), "AC-1", i + 1)));
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.kept.map((k) => [k.kind, k.path]), [["screenshot", "FAKE-1/1-1/1.png"], ["screenshot", "FAKE-1/1-1/2.jpg"], ["http", "FAKE-1/1-1/3.json"], ["log", "FAKE-1/1-1/4.txt"]]);
  assert.deepEqual(readFileSync(join(l.dest, "1.png")), PNG);
  assert.equal(r.kept[0]!.bytes, PNG.length);
});

test("copyEvidence: a symlink as the last component is not followed", () => {
  const l = layout();
  writeFileSync(join(l.base, "secret.png"), PNG);
  symlinkSync(join(l.base, "secret.png"), join(l.evidence, "link.png"));
  const r = copy(l, [item(join(l.evidence, "link.png"))]);
  assert.deepEqual(r.kept, []);
  assert.match(r.dropped[0]!.why, /a symlink/);
  assert.deepEqual(readdirSync(l.dest), []);
});

test("copyEvidence: a FIFO is not a regular file (and opening it does not block)", () => {
  const l = layout();
  execFileSync("mkfifo", [join(l.evidence, "pipe.png")]);
  const r = copy(l, [item(join(l.evidence, "pipe.png"))]);
  assert.deepEqual(r.kept, []);
  assert.match(r.dropped[0]!.why, /not a regular file/);
});

test("copyEvidence: a file over 5 MB is dropped", () => {
  const l = layout();
  writeFileSync(join(l.evidence, "big.png"), Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
  const r = copy(l, [item(join(l.evidence, "big.png"))]);
  assert.deepEqual(r.kept, []);
  assert.match(r.dropped[0]!.why, /larger than 5 MB/);
});

test("copyEvidence: binary that is not a PNG / JPEG image is dropped", () => {
  const l = layout();
  writeFileSync(join(l.evidence, "x.png"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff, 0xfe, 0x00]));
  const r = copy(l, [item(join(l.evidence, "x.png"))]);
  assert.deepEqual(r.kept, []);
  assert.match(r.dropped[0]!.why, /not a PNG or JPEG image, JSON or text/);
});

test("copyEvidence: at most 200 files per report", () => {
  const l = layout();
  const items: EvidenceItem[] = [];
  for (let i = 1; i <= 203; i++) {
    writeFileSync(join(l.evidence, `${i}.txt`), `log ${i}\n`);
    items.push(item(join(l.evidence, `${i}.txt`), "AC-1", i));
  }
  const r = copy(l, items);
  assert.equal(r.kept.length, 200);
  assert.equal(r.dropped.length, 3);
  assert.match(r.dropped[0]!.why, /more than 200 evidence files/);
  assert.equal(readdirSync(l.dest).length, 200);
});

test("copyEvidence: a source outside the platform-known roots is dropped; a vanished file is named", () => {
  const l = layout();
  writeFileSync(join(l.base, "outside.png"), PNG);
  const r = copy(l, [item(join(l.base, "outside.png"), "AC-1", 1), item(join(l.evidence, "gone.png"), "AC-2", 2), item(`${l.evidence}-x/a.png`, "AC-1", 3)]);
  assert.deepEqual(r.kept, []);
  assert.match(r.dropped[0]!.why, /not inside the run's evidence\/ or artifacts\//);
  assert.match(r.dropped[1]!.why, /vanished/);
  assert.match(r.dropped[2]!.why, /not inside/);
});

const ac = (acId: string, verdict: AcEvaluation["verdict"], mismatch: string | null = null): AcEvaluation => ({
  acId, text: acId, verdict, agentVerdict: verdict === "not_tested" ? null : verdict, mismatch,
  flows: [{ kind: "happy", title: "t", steps: ["s"], expected: "e", actual: "a", tests: ["t"], evidenceKeys: [`${acId}/1`], testsPassed: true }],
});

test("applyDropped (T9-6 L2): names the dropped evidence; only a pass is downgraded (none left), never another verdict", () => {
  const dropped = [
    { refKey: "AC-1/1", acId: "AC-1", why: "evidence x not kept: the file vanished" },
    { refKey: "AC-2/1", acId: "AC-2", why: "evidence y not kept: a symlink" },
    { refKey: "AC-3/1", acId: "AC-3", why: "evidence z not kept: a symlink" },
  ];
  const out = applyDropped([ac("AC-1", "pass"), ac("AC-2", "fail"), ac("AC-3", "not_tested")], { kept: [], dropped });
  assert.equal(out[0]!.verdict, "fail");
  assert.match(out[0]!.mismatch ?? "", /vanished; no evidence left/);
  assert.deepEqual(out[0]!.flows[0]!.evidenceKeys, []);
  assert.equal(out[1]!.verdict, "fail");
  assert.equal(out[2]!.verdict, "not_tested", "a not_tested AC stays not_tested");
});
