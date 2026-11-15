import assert from "node:assert/strict";
import { test } from "node:test";
import { endpointError, exportBar, exportCard, headersError, headersBody, MAX_OTLP_HEADERS } from "./telemetry-model.ts";
import type { TelemetryPreview } from "./api.ts";

const preview = (over: Partial<TelemetryPreview> = {}): TelemetryPreview => ({
  endpointHost: "otel.example.com", runCount: 37, includeContent: false, attributes: ["slackoff.role"], runIdsHash: "a".repeat(64), ...over,
});

test("exportCard: hidden when export is off; 'Export 37 runs to <host>'; nothing to send disables it", () => {
  assert.equal(exportCard(null), null);
  const c = exportCard(preview())!;
  assert.equal(c.label, "Export 37 runs to otel.example.com");
  assert.equal(c.disabled, false);
  assert.equal(exportCard(preview({ runCount: 1 }))!.label, "Export 1 run to otel.example.com");
  const none = exportCard(preview({ runCount: 0 }))!;
  assert.equal(none.disabled, true);
  assert.equal(none.label, "No new runs to export to otel.example.com");
});

test("exportBar: the 'This will' names the count, the fields and the host; content on adds its warning", () => {
  const b = exportBar(preview());
  assert.equal(b.thisWill, "send 37 agent runs (role, ticket key, duration, tokens, cost, tool names) to otel.example.com. Recorded in the audit log.");
  assert.equal(b.contentWarning, null);
  assert.equal(b.confirm, "Confirm export");
  assert.equal(exportBar(preview({ includeContent: true })).contentWarning, "Prompts and agent output — ticket text and code — are sent too");
  assert.match(exportBar(preview({ includeContent: true })).thisWill, /prompts and agent output/);
});

test("endpointError: the server's rule, client side", () => {
  for (const ok of ["", "https://otel.example.com/v1/traces", "http://127.0.0.1:4318/v1/traces", "http://localhost:4318/v1/traces", "http://[::1]:4318/v1/traces"]) assert.equal(endpointError(ok), null, ok);
  for (const bad of ["http://example.com/v1/traces", "http://127.0.0.1:4317/v1/traces", "http://localhost:5173/x", "https://u:p@otel.example.com/v1/traces", "https://otel.example.com/v1/traces?k=v", "https://otel.example.com/#x", "ftp://otel.example.com", "nope"]) {
    assert.notEqual(endpointError(bad), null, bad);
  }
});

test("headers: name rule, at most 10, single-line values; never echoes a value", () => {
  const value = "fake-otlp-value-0123456789";
  assert.equal(headersError([{ name: "x-api-key", value }]), null);
  assert.notEqual(headersError([]), null);
  assert.notEqual(headersError([{ name: "bad name", value }]), null);
  assert.notEqual(headersError([{ name: "x-a", value: "" }]), null);
  assert.notEqual(headersError([{ name: "x-a", value: "a\nb" }]), null);
  assert.notEqual(headersError([{ name: "x-a", value }, { name: "X-A", value }]), null);
  const many = Array.from({ length: MAX_OTLP_HEADERS + 1 }, (_, i) => ({ name: `x-h${i}`, value }));
  assert.notEqual(headersError(many), null);
  for (const rows of [[{ name: "bad name", value }], [{ name: "x-a", value: `${value}\nx` }]]) assert.ok(!headersError(rows)!.includes(value));
  assert.deepEqual(headersBody([{ name: " x-api-key ", value: ` ${value} ` }, { name: "", value: "" }]), { headers: { "x-api-key": value } });
});

test("4C-2: the server's header rules (no host, framing, connection or proxy-* names; Latin-1 values) and mapped IPv6 loopback", () => {
  const value = "fake-otlp-value-0123456789";
  for (const name of ["host", "Content-Length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect", "proxy-authorization"]) {
    assert.notEqual(headersError([{ name, value }]), null, name);
  }
  assert.notEqual(headersError([{ name: "x-a", value: `${value}€` }]), null);
  assert.equal(headersError([{ name: "x-a", value: `Bearer ${value}é` }]), null);
  for (const bad of ["http://[::ffff:127.0.0.1]:4317/v1/traces", "https://[::ffff:7f00:1]:5173/x"]) assert.notEqual(endpointError(bad), null, bad);
});
