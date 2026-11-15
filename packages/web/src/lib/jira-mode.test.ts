// Phase 4b final fix pass (ruling F4B-4): every JIRA-facing string follows the JIRA mode — the developer's Chrome or
// the JIRA API. A row that recorded its mode is worded by it; anything not sent yet by the current setting.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JiraWriteRecord } from "./api.ts";
import { jiraCard } from "./dev-model.ts";
import { discoverView } from "./discover-model.ts";
import { JIRA_TEXT_KEYS, jiraText } from "./jira-mode.ts";

const write = (over: Partial<JiraWriteRecord> = {}): JiraWriteRecord => ({
  id: 4, targetStatus: "In Development", state: "pending", detail: null, result: null, decidedBy: null,
  requestedAt: "2026-11-07T10:00:00Z", decidedAt: null, finishedAt: null, jiraSource: null, ...over,
});
const vars = { key: "PROJ-1", status: "In Development" };

test("F4B-4: each JIRA-facing string has a browser wording (Chrome) and an API wording that never mentions Chrome", () => {
  assert.deepEqual([...JIRA_TEXT_KEYS].sort(), [
    "dev.jiraRunning", "dev.jiraThisWill", "req.comment.thisWill", "settings.syncStatusThisWill", "snap.fetchedViaValue",
    "tickets.blockedThisWill", "tickets.discoverLogin", "tickets.fetchThisWill",
  ]);
  for (const k of JIRA_TEXT_KEYS) {
    assert.match(jiraText(k, "browser", vars), /Chrome/, k);
    const api = jiraText(k, "api", vars);
    assert.doesNotMatch(api, /Chrome|browser/i, k);
    assert.match(api, /JIRA API|API token/, k);
    // no mode known (a row from before phase 4b): the browser wording
    assert.equal(jiraText(k, null, vars), jiraText(k, "browser", vars), k);
  }
});

test("F4B-4: the JIRA status card — pending by the current mode, running by the mode the write recorded", () => {
  const sync = { enabled: true, targetStatus: "In Progress" };
  const p = jiraCard([write()], sync, "PROJ-1", { mode: "api" });
  assert.ok(p.kind === "pending");
  assert.doesNotMatch(p.thisWill, /Chrome/);
  assert.match(p.thisWill, /JIRA API/);
  assert.match(p.thisWill, /PROJ-1/);
  assert.match(p.thisWill, /In Development/);
  const running = (w: Partial<JiraWriteRecord>, mode: "browser" | "api") => {
    const c = jiraCard([write({ state: "confirmed", ...w })], sync, "PROJ-1", { mode });
    assert.ok(c.kind === "running");
    return c.text;
  };
  assert.match(running({ jiraSource: "api" }, "browser"), /JIRA API/, "the row's mode wins over the setting");
  assert.match(running({ jiraSource: "browser" }, "api"), /your Chrome/);
  assert.match(running({ jiraSource: null }, "api"), /JIRA API/, "not started yet: the setting");
});

test("F4B-4: a discovery that needed a login says to update the API token in the API mode", () => {
  const login = { phase: "finished" as const, result: { created: 0, returned: 0, total: 0, complete: false, loginRequired: true as const, error: "x" } };
  assert.match(discoverView(login, "browser").message!, /Chrome/);
  const api = discoverView(login, "api").message!;
  assert.doesNotMatch(api, /Chrome/);
  assert.match(api, /API token/);
});
