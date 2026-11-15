import assert from "node:assert/strict";
import { test } from "node:test";
import { safeJiraUrl } from "./jira-link.ts";

const BASE = "https://acme.atlassian.net";

test("F-8 safeJiraUrl: only http(s) URLs on the configured JIRA origin", () => {
  assert.equal(safeJiraUrl("https://acme.atlassian.net/browse/PROJ-1", BASE), "https://acme.atlassian.net/browse/PROJ-1");
  assert.equal(safeJiraUrl("https://acme.atlassian.net/browse/PROJ-1", `${BASE}/jira`), "https://acme.atlassian.net/browse/PROJ-1");
  assert.equal(safeJiraUrl("javascript:alert(1)", BASE), null);
  assert.equal(safeJiraUrl("JavaScript:alert(document.cookie)//https://acme.atlassian.net", BASE), null);
  assert.equal(safeJiraUrl("data:text/html,<script>alert(1)</script>", BASE), null);
  assert.equal(safeJiraUrl("https://evil.example.com/browse/PROJ-1", BASE), null);
  assert.equal(safeJiraUrl("https://acme.atlassian.net.evil.com/browse/PROJ-1", BASE), null);
  assert.equal(safeJiraUrl("http://acme.atlassian.net/browse/PROJ-1", BASE), null, "scheme is part of the origin");
  assert.equal(safeJiraUrl("https://acme.atlassian.net:8443/browse/PROJ-1", BASE), null, "port is part of the origin");
  assert.equal(safeJiraUrl("/browse/PROJ-1", BASE), null, "relative URLs are not trusted");
  assert.equal(safeJiraUrl("not a url", BASE), null);
  assert.equal(safeJiraUrl(null, BASE), null);
  assert.equal(safeJiraUrl("https://acme.atlassian.net/browse/PROJ-1", ""), null, "no configured JIRA");
  assert.equal(safeJiraUrl("https://acme.atlassian.net/browse/PROJ-1", undefined), null);
});
