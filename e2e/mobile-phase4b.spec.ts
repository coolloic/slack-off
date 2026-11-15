import { expect, test, type Locator, type Page } from "@playwright/test";
import { API, expectNoHorizontalScroll, get, visible } from "./helpers.ts";

// Phase 4b (Task 8) on a phone (390x844): Settings' executor and JIRA sections. On this computer at phone width the
// credential boxes fit; on a paired phone both mode switches are read-only and the credentials show their status only
// ("Set on this computer" / "Not set", never an email hint); the comparison tables are one card per row. Nothing
// scrolls sideways and every touch target is at least 44px tall.

const W = 390;
test.describe.configure({ mode: "serial" });

const EMAIL = "you@example.com";
const TOKEN = "test-token-123-not-real";
const KEY = "test-anthropic-key-not-real";

const card = (page: Page, title: string): Locator => visible(page.locator("section").filter({ has: page.getByText(title, { exact: true }) })).first();

async function expectTouchTargets(scope: Locator) {
  // the phase 4b parts: the mode switches, the credential fields and the comparison
  const parts = scope.locator("[data-testid^=mode-], [data-testid^=credential-], [data-testid^=compare-]");
  const targets = parts.locator("button, summary, label:has(input[type=radio])").filter({ visible: true });
  expect(await targets.count()).toBeGreaterThan(0);
  for (const t of await targets.all()) {
    const box = await t.boundingBox();
    expect(box!.height, (await t.textContent()) ?? "").toBeGreaterThanOrEqual(44);
  }
}

test("phone on this computer: the API modes' credential boxes fit at 390px; touch targets ≥ 44px", async ({ page }) => {
  await page.goto("/settings");
  const executor = card(page, "Executor");
  await executor.getByRole("radio", { name: "Anthropic API key" }).check();
  await expect(executor.getByTestId("mode-combo-error")).toHaveText("The API key mode cannot drive Chrome: switch JIRA to the API mode too.");
  const key = executor.getByTestId("credential-anthropic").getByLabel("Anthropic API key");
  await expect(key).toHaveAttribute("type", "text");
  await expect(key).toHaveCSS("-webkit-text-security", "disc");
  await expect(key).toHaveAttribute("autocomplete", "off");
  const jira = card(page, "JIRA");
  await jira.getByRole("radio", { name: /^JIRA API/ }).check();
  await expect(executor.getByTestId("mode-combo-error")).toHaveCount(0);
  await expect(jira.getByTestId("credential-jira").getByLabel("JIRA API token")).toHaveAttribute("type", "text");
  await expect(jira.getByTestId("credential-jira").getByLabel("JIRA API token")).toHaveCSS("-webkit-text-security", "disc");
  await expect(jira.getByRole("button", { name: "Detect browsers" })).toHaveCount(0);
  for (const c of [executor, jira]) {
    await c.getByTestId(/^compare-(executor|jira)$/).locator("summary").click();
    await expectTouchTargets(c);
  }
  await expectNoHorizontalScroll(page, W);
});

test("paired phone: both modes read-only, credentials show their status only, comparison as cards, no sideways scroll", async ({ page, request }) => {
  // set up on this computer (loopback API): both API modes and both credentials
  for (const [path, data] of [["/api/credentials/jira", { email: EMAIL, apiToken: TOKEN }], ["/api/credentials/anthropic", { apiKey: KEY }]] as const) {
    const res = await request.put(`${API}${path}`, { data });
    expect(res.ok(), await res.text()).toBe(true);
  }
  const config = await get<Record<string, Record<string, unknown>>>(request, "/api/config");
  const saved = await request.put(`${API}/api/config`, { data: { ...config, jira: { ...config.jira, source: "api" }, executor: { ...config.executor, kind: "claude-api" } } });
  expect(saved.ok(), await saved.text()).toBe(true);

  await page.route("**/api/status", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), local: false } });
  });
  await page.goto("/settings");
  const executor = card(page, "Executor");
  const jira = card(page, "JIRA");
  for (const r of await executor.getByRole("radio").all()) await expect(r).toBeDisabled();
  for (const r of await jira.getByRole("radio").all()) await expect(r).toBeDisabled();
  await expect(executor.getByRole("radio", { name: "Anthropic API key" })).toBeChecked();
  await expect(jira.getByRole("radio", { name: /^JIRA API/ })).toBeChecked();
  for (const id of ["anthropic.apiKey", "jira.email", "jira.apiToken"]) await expect(visible(page.getByTestId(`credential-status-${id}`))).toHaveText("Set on this computer");
  await expect(visible(page.locator("input[type=password]"))).toHaveCount(0);
  // no Save / Replace / Remove on a paired phone
  await expect(visible(page.locator("[data-testid^=credential-]").getByRole("button"))).toHaveCount(0);
  // the API key and the JIRA token, plus (phase 4c) the OTLP auth headers of Run tracing
  await expect(visible(page.getByText("Credentials can only be entered on the computer running Slack Off."))).toHaveCount(3);
  await expect(visible(page.getByTestId("otlp-headers-status"))).toHaveText("Not set");
  await expect(page.getByText("y…@example.com")).toHaveCount(0);

  for (const [c, kind] of [[executor, "executor"], [jira, "jira"]] as const) {
    const compare = c.getByTestId(`compare-${kind}`);
    await compare.locator("summary").click();
    await expect(compare.locator("table")).toBeHidden();
    await expect(visible(compare.getByTestId("compare-card"))).toHaveCount(kind === "executor" ? 7 : 6);
    await expectTouchTargets(c);
  }
  const html = await page.content();
  for (const s of [TOKEN, KEY, EMAIL]) expect(html).not.toContain(s);
  await expectNoHorizontalScroll(page, W);
});
