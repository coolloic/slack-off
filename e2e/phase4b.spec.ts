import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { API, chooseThroughApi, discover, E2E_HOME, enableJiraSync, get, visible, waitState } from "./helpers.ts";

// Phase 4b (Task 8) on desktop (1440): Settings switches JIRA to the API mode and the executor to the API key; the
// credentials are typed in Settings (fake values) and never come back from the server. Discovery and the In Progress
// write then go through the real REST code against fake mode's fake Jira Cloud fetch (dev/fake-jira-api.ts), which
// logs every request it answers to <home>/fake-jira-api/requests.jsonl. No network, no real JIRA, no real claude.

test.describe.configure({ mode: "serial" });

// obviously fake, ≥ 16 characters (4B-3), not shaped like a real key
const EMAIL = "you@example.com";
const TOKEN = "test-token-123-not-real";
const KEY = "test-anthropic-key-not-real";

const requests = (): Array<{ method: string; path: string; body?: unknown }> => {
  const f = join(E2E_HOME(), "fake-jira-api", "requests.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/** Nothing the browser keeps or shows carries a typed credential. */
async function expectNoSecretInPage(page: Page) {
  const leaks = await page.evaluate(
    (secrets) => {
      const where: string[] = [];
      const html = document.documentElement.outerHTML;
      const values = [...document.querySelectorAll("input")].map((i) => i.value).join("\n");
      const storage = [localStorage, sessionStorage].map((s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`).join("\n")).join("\n");
      for (const s of secrets) {
        if (html.includes(s)) where.push(`html:${s}`);
        if (values.includes(s)) where.push(`input:${s}`);
        if (storage.includes(s)) where.push(`storage:${s}`);
        if (location.href.includes(s)) where.push(`url:${s}`);
      }
      return where;
    },
    [TOKEN, KEY, EMAIL],
  );
  expect(leaks).toEqual([]);
}

test("JIRA API mode + API key: credentials typed once in Settings, never echoed; fake REST discovery; one confirmed In Progress transition", async ({ page, request }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "JIRA", exact: true }).click();
  await expect(page.getByRole("button", { name: "Detect browsers" })).toBeVisible();
  await visible(page.getByRole("radio", { name: /^JIRA API/ })).check();
  // the API mode does not use Chrome
  await expect(page.getByRole("button", { name: "Detect browsers" })).toHaveCount(0);

  const jira = visible(page.getByTestId("credential-jira"));
  await expect(jira.getByTestId("credential-status-jira.apiToken")).toHaveText("Not set");
  await expect(jira).toContainText("never your JIRA password");
  const email = jira.getByLabel("JIRA account email");
  const token = jira.getByLabel("JIRA API token");
  // F4B-5 (M-3): text boxes (no browser offers to save a password); the token is masked, the email is not
  for (const box of [email, token]) {
    await expect(box).toHaveAttribute("type", "text");
    await expect(box).toHaveAttribute("autocomplete", "off");
    await expect(box).toHaveValue("");
  }
  await expect(token).toHaveCSS("-webkit-text-security", "disc");
  await expect(email).toHaveCSS("-webkit-text-security", "none");
  await expect(page.locator("input[type=password]")).toHaveCount(0);
  // a short token is refused before anything is sent, without repeating it
  await email.fill(EMAIL);
  await token.fill("too-short");
  await jira.getByRole("button", { name: "Save credential" }).click();
  await expect(jira.getByRole("alert")).toHaveText("Paste the whole token or key (at least 16 characters).");
  await token.fill(TOKEN);
  await jira.getByRole("button", { name: "Save credential" }).click();
  await expect(jira.getByTestId("credential-status-jira.apiToken")).toHaveText(/^Set · updated (just now|1m ago)$/);
  await expect(jira).toContainText("Account: y…@example.com");
  await expect(jira.getByLabel("JIRA API token")).toHaveCount(0); // the boxes close and are cleared
  await expect(jira.getByRole("button", { name: "Replace" })).toBeVisible();
  await jira.getByRole("button", { name: "Replace" }).click();
  await expect(jira.getByLabel("JIRA API token")).toHaveValue(""); // never prefilled
  await jira.getByRole("button", { name: "Cancel" }).click();

  // the comparison table (desktop: a table)
  const compare = visible(page.getByTestId("compare-jira"));
  await compare.locator("summary").click();
  await expect(compare.getByRole("columnheader", { name: "JIRA API" })).toBeVisible();
  await expect(compare.getByRole("rowheader")).toHaveCount(6);

  // the executor: the API key with the browser JIRA mode would be refused; here JIRA is already API
  await page.getByRole("button", { name: "Executor" }).click();
  await visible(page.getByRole("radio", { name: "Anthropic API key" })).check();
  await expect(visible(page.getByTestId("mode-combo-error"))).toHaveCount(0);
  const anthropic = visible(page.getByTestId("credential-anthropic"));
  await expect(anthropic.getByLabel("Anthropic API key")).toHaveAttribute("type", "text");
  await expect(anthropic.getByLabel("Anthropic API key")).toHaveCSS("-webkit-text-security", "disc");
  await anthropic.getByLabel("Anthropic API key").fill(KEY);
  await anthropic.getByRole("button", { name: "Save credential" }).click();
  await expect(anthropic.getByTestId("credential-status-anthropic.apiKey")).toHaveText(/^Set · updated/);
  await visible(page.getByRole("button", { name: "Save settings" })).first().click();
  await expect(visible(page.getByText("Saved.", { exact: true })).first()).toBeVisible();
  await expectNoSecretInPage(page);

  // the server never returns a value: config, credentials, status, audit
  for (const path of ["/api/config", "/api/credentials", "/api/status", "/api/audit"]) {
    const text = await (await request.get(`${API}${path}`)).text();
    for (const s of [TOKEN, KEY]) expect(text, path).not.toContain(s);
  }
  expect(JSON.stringify(await get(request, "/api/credentials"))).not.toContain(EMAIL);
  const status = await get<{ jira: { source: string }; executor: { kind: string; available: boolean } }>(request, "/api/status");
  expect(status.jira.source).toBe("api");
  expect(status.executor).toMatchObject({ kind: "claude-api", available: true });
  await page.reload();
  await expect(visible(page.getByText("JIRA API", { exact: true })).first()).toBeVisible(); // the top bar names the mode
  // F4B-4: the fetch control says how it reads JIRA in this mode
  await page.goto("/");
  await expect(visible(page.getByText(/read every open ticket assigned to you through the JIRA API/)).first()).toBeVisible();

  // discovery through the fake Jira Cloud REST
  expect(requests()).toEqual([]);
  await discover(request);
  expect(requests().filter((r) => r.method === "POST" && r.path === "/rest/api/3/search/jql").length).toBeGreaterThanOrEqual(1);

  // FAKE-1 to dev_done (the phase 2 API fast path) with JIRA status sync on
  await enableJiraSync(request);
  await chooseThroughApi(request, "FAKE-1", 0);
  await waitState(request, "FAKE-1", ["dev_done"], 120_000);
  expect(requests().filter((r) => r.method === "POST" && r.path.endsWith("/transitions"))).toEqual([]);

  // the In Progress write waits for the developer; confirmed once → exactly one transition POST, verified by a read-back
  await page.goto("/tickets/FAKE-1/development");
  await expect(visible(page.getByTestId("jira-target"))).toContainText("In Progress");
  // F4B-4: the confirmation names the JIRA API, never Chrome
  await expect(visible(page.getByText(/change only the status of FAKE-1 to In Progress, through the JIRA API/)).first()).toBeVisible();
  await expect(page.getByText(/in your Chrome/)).toHaveCount(0);
  await visible(page.getByRole("button", { name: "Send to JIRA" })).click();
  await expect(visible(page.getByTestId("jira-card")).getByText("FAKE-1 set to In Progress in JIRA.")).toBeVisible();
  expect(requests().filter((r) => r.method === "POST" && r.path.endsWith("/transitions"))).toEqual([{ method: "POST", path: "/rest/api/3/issue/FAKE-1/transitions", body: { transition: { id: "11" } } }]);
  await expectNoSecretInPage(page);

  const audit = await (await request.get(`${API}/api/audit`)).json();
  expect(audit.chain.ok).toBe(true);
});
