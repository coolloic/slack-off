import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceNameFromUa, normalizeCode, pairingPanelState, pairingRedirect, qrModules, qrPath, secondsLeft } from "./remote-model.ts";

test("qrModules: square matrix with finder patterns, quiet zone excluded", () => {
  const m = qrModules("http://100.101.102.103:4317/pair?code=12345678");
  const n = m.length;
  assert.ok(n >= 21 && (n - 17) % 4 === 0, `valid QR size ${n}`);
  for (const row of m) assert.equal(row.length, n);
  // the three 7x7 finder patterns: dark border, light ring, dark 3x3 core
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
    for (let i = 0; i < 7; i++) {
      assert.equal(m[r0]![c0 + i], true);
      assert.equal(m[r0 + 6]![c0 + i], true);
      assert.equal(m[r0 + i]![c0], true);
      assert.equal(m[r0 + i]![c0 + 6], true);
    }
    assert.equal(m[r0 + 1]![c0 + 1], false);
    assert.equal(m[r0 + 3]![c0 + 3], true);
  }
});

test("qrPath draws one unit square per dark module, offset by the quiet zone", () => {
  const { d, size } = qrPath([[true, false], [false, true]], 4);
  assert.equal(size, 10);
  assert.equal(d, "M4 4h1v1h-1zM5 5h1v1h-1z");
});

test("normalizeCode keeps digits only, max 8", () => {
  assert.equal(normalizeCode(" 1234-5678 "), "12345678");
  assert.equal(normalizeCode("12a34567890"), "12345678");
  assert.equal(normalizeCode(null), "");
});

test("deviceNameFromUa gives a sensible default", () => {
  assert.equal(deviceNameFromUa("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "iPhone");
  assert.equal(deviceNameFromUa("Mozilla/5.0 (Linux; Android 15; Pixel 7) Chrome/130"), "Android phone");
  assert.equal(deviceNameFromUa("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "iPad");
  assert.equal(deviceNameFromUa("curl/8"), "My phone");
});

test("secondsLeft counts down and never goes negative", () => {
  const exp = "2026-11-06T10:05:00.000Z";
  assert.equal(secondsLeft(exp, Date.parse("2026-11-06T10:00:00Z")), 300);
  assert.equal(secondsLeft(exp, Date.parse("2026-11-06T10:06:00Z")), 0);
});

test("pairingRedirect: only a 401 off the pairing page redirects", () => {
  assert.equal(pairingRedirect(401, "/"), "/pair");
  assert.equal(pairingRedirect(401, "/tickets/P-1"), "/pair");
  assert.equal(pairingRedirect(401, "/pair"), null);
  assert.equal(pairingRedirect(403, "/"), null);
  assert.equal(pairingRedirect(200, "/"), null);
});

test("pairingPanelState: paired wins, then locked, then expired", () => {
  assert.equal(pairingPanelState({ paired: true, locked: true, secondsLeft: 0 }), "paired");
  assert.equal(pairingPanelState({ paired: false, locked: true, secondsLeft: 120 }), "locked");
  assert.equal(pairingPanelState({ paired: false, locked: false, secondsLeft: 0 }), "expired");
  assert.equal(pairingPanelState({ paired: false, locked: false, secondsLeft: 42 }), "open");
});
