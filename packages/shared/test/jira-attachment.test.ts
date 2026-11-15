import assert from "node:assert/strict";
import { test } from "node:test";
import { jiraAttachmentContentUrl, jiraAttachmentId, jiraImageOrigin, jiraImageSources, jiraThumbnailUrl } from "../src/jira-attachment.ts";

const BASE = "https://example.atlassian.net";

test("jiraAttachmentId: only the configured JIRA's attachment content address, with a numeric id", () => {
  assert.equal(jiraAttachmentId(`${BASE}/rest/api/3/attachment/content/316935`, BASE), "316935");
  assert.equal(jiraAttachmentId(`${BASE}/rest/api/2/attachment/content/42`, BASE), "42");
  // a trailing slash on the base is fine
  assert.equal(jiraAttachmentId(`${BASE}/rest/api/3/attachment/content/7`, `${BASE}/`), "7");
  for (const bad of [
    "",
    `${BASE}/rest/api/3/attachment/content/abc`,
    `${BASE}/rest/api/3/attachment/content/1?x=1`,
    `${BASE}/rest/api/3/attachment/content/1#x`,
    `${BASE}/rest/api/3/attachment/thumbnail/1`,
    `${BASE}/secure/attachment/1/a.png`,
    "https://evil.example/rest/api/3/attachment/content/1",
    `${BASE}.evil.example/rest/api/3/attachment/content/1`,
    "http://example.atlassian.net/rest/api/3/attachment/content/1",
    // credentials in the address (built in two parts so the public-content check does not read it as an email)
    `https://user:pw${"@"}example.atlassian.net/rest/api/3/attachment/content/1`,
    `${BASE}/rest/api/3/attachment/content/1/../../../../logout`,
  ]) assert.equal(jiraAttachmentId(bad, BASE), null, bad);
  assert.equal(jiraAttachmentId(`${BASE}/rest/api/3/attachment/content/1`, ""), null);
  assert.equal(jiraAttachmentId(`${BASE}/rest/api/3/attachment/content/1`, "not a url"), null);
});

test("content and thumbnail addresses are built from the id under the base", () => {
  assert.equal(jiraAttachmentContentUrl(BASE, "316935"), `${BASE}/rest/api/3/attachment/content/316935`);
  assert.equal(jiraThumbnailUrl(`${BASE}/`, "316935"), `${BASE}/rest/api/3/attachment/thumbnail/316935`);
});

test("jiraImageOrigin: the https origin of the base, or null", () => {
  assert.equal(jiraImageOrigin(`${BASE}/`), BASE);
  assert.equal(jiraImageOrigin("https://jira.example.com/sub"), "https://jira.example.com");
  assert.equal(jiraImageOrigin("http://jira.example.com"), null);
  assert.equal(jiraImageOrigin(""), null);
  assert.equal(jiraImageOrigin("https://u:p@jira.example.com"), null);
  // nothing that could break out of a CSP source list
  assert.equal(jiraImageOrigin("https://jira.example.com;script-src *"), null);
});

test("jiraImageSources: Jira Cloud adds Atlassian's media host (attachments redirect there); a self-hosted JIRA only itself", () => {
  assert.deepEqual(jiraImageSources("https://example.atlassian.net"), ["https://example.atlassian.net", "https://api.media.atlassian.com"]);
  assert.deepEqual(jiraImageSources("https://jira.example.com"), ["https://jira.example.com"]);
  // a look-alike is not Jira Cloud
  assert.deepEqual(jiraImageSources("https://atlassian.net.evil.example"), ["https://atlassian.net.evil.example"]);
  assert.deepEqual(jiraImageSources("http://example.atlassian.net"), []);
  assert.deepEqual(jiraImageSources(""), []);
});
