import { expect, test, type Locator, type Page } from "@playwright/test";
import { API, discover, expectNoHorizontalScroll, get, post, visible, waitState } from "./helpers.ts";
import { otlpReceiver, spansIn } from "./otlp-receiver.ts";

// Phase 4c (tasks 1-3) on a phone (390x844): the Cost & quota page as single-column cards with the pause / resume in
// the sticky bar and its "This will:" text, the usage banner, the Budget settings. Nothing scrolls sideways and every
// touch target is at least 44px tall.

const W = 390;
test.describe.configure({ mode: "serial" });

async function expectTouchTargets(scope: Locator) {
  const targets = scope.locator("button:not([role=switch]), a, [role=radio], select, input:not([type=checkbox]), label:has(button[role=switch])").filter({ visible: true });
  expect(await targets.count()).toBeGreaterThan(0);
  for (const t of await targets.all()) {
    const box = await t.boundingBox();
    expect(box!.height, (await t.textContent()) ?? (await t.getAttribute("aria-label")) ?? "?").toBeGreaterThanOrEqual(44);
  }
}

test("phone: Cost & quota with runs — cards, list instead of tables, sticky bar; no sideways scroll; touch targets", async ({ page, request }) => {
  await discover(request);
  await post(request, "/api/tickets/FAKE-1/refine");
  await waitState(request, "FAKE-1", ["awaiting_choice"]);
  await page.goto("/");
  // the bottom navigation reaches it
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Cost" }).click();
  await expect(page).toHaveURL(/\/cost$/);
  await expect(page.getByTestId("usage-stat-cost")).toContainText("API-equivalent estimate");
  await expect(page.getByTestId("usage-tickets").locator("ul")).toBeVisible();
  await expect(page.getByTestId("usage-tickets").locator("table")).toBeHidden();
  await expect(page.getByTestId("usage-bars")).toBeVisible();
  const bar = page.getByTestId("cost-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("This will: stop new agent runs; running ones finish. Tickets that would start one wait in Blocked until you resume and retry.");
  await expectNoHorizontalScroll(page, W);
  await expectTouchTargets(page.getByTestId("cost-page"));
  // the sticky bar is the bottom edge: it does not hide the content's end
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const last = await page.getByTestId("usage-roles").boundingBox();
  const barBox = await bar.boundingBox();
  expect(last!.y + last!.height).toBeLessThanOrEqual(barBox!.y + 1);
  await expectNoHorizontalScroll(page, W);
});

test("phone: pause from the sticky bar — the banner, the blocked ticket and its Resumed note fit at 390px", async ({ page, request }) => {
  await page.goto("/cost");
  await page.getByTestId("cost-bar").getByLabel("Note (optional)").fill("on the train, back in an hour");
  await page.getByTestId("cost-bar").getByTestId("usage-action").click();
  const banner = page.getByTestId("usage-banner");
  await expect(banner).toContainText("Usage paused — on the train, back in an hour.");
  expect((await banner.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("cost-bar").getByTestId("usage-action")).toHaveText("Resume");
  await expect(page.getByTestId("cost-bar")).toContainText("allow new agent runs again");
  await expectNoHorizontalScroll(page, W);

  await post(request, "/api/tickets/FAKE-2/refine");
  await waitState(request, "FAKE-2", ["blocked"]);
  await expect(banner).toContainText("1 ticket waiting.");
  await page.goto("/tickets/FAKE-2");
  await expect(page.getByRole("alert").filter({ hasText: "Paused: on the train" })).toBeVisible();
  await expectNoHorizontalScroll(page, W);
  await expectTouchTargets(page.getByRole("alert").filter({ hasText: "Paused: on the train" }));

  await page.getByTestId("usage-banner").click();
  await page.getByTestId("cost-bar").getByTestId("usage-action").click();
  await expect(page.getByTestId("usage-banner")).toHaveCount(0);
  await page.goto("/tickets/FAKE-2");
  await expect(page.getByTestId("resumed-note")).toHaveText("Resumed: retry to continue");
  await expectNoHorizontalScroll(page, W);
  await visible(page.getByRole("button", { name: "Retry" })).first().click();

  // FAKE-2's first propose hits the CLI's usage limit (fake switch usageLimitOnce): an auto-pause, the ticket blocks
  // with the CLI's wording; resume, Retry, and the run goes through
  await waitState(request, "FAKE-2", ["blocked"]);
  expect((await get<{ ticket: { blockedReason: string } }>(request, "/api/tickets/FAKE-2")).ticket.blockedReason).toBe(
    "Paused: Claude usage limit reached · resets 5pm (fake mode) — resume in Cost & quota, then Retry",
  );
  await page.goto("/cost");
  await expect(visible(page.getByTestId("usage-paused"))).toContainText("Paused: the CLI reported its usage limit");
  await expect(page.getByTestId("usage-banner")).toContainText("Claude usage limit reached");
  await expectNoHorizontalScroll(page, W);
  await page.getByTestId("cost-bar").getByTestId("usage-action").click();
  await expect(page.getByTestId("usage-banner")).toHaveCount(0);
  await post(request, "/api/tickets/FAKE-2/retry");
  await waitState(request, "FAKE-2", ["awaiting_choice"]);
});

test("paired phone with the API key: a manual pause can be resumed; a threshold pause says to resume on this computer", async ({ page, request }) => {
  await post(request, "/api/usage/pause", { note: "phone check" });
  // a paired phone (status.local false) and an API-key executor, as the page would see them (F4C-1 M-4)
  let reason = "manual";
  await page.route("**/api/status", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), local: false } });
  });
  await page.route("**/api/usage?*", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, executor: "claude-api", paused: body.paused && { ...body.paused, reason } } });
  });
  await page.goto("/cost");
  const bar = page.getByTestId("cost-bar");
  await expect(bar.getByTestId("usage-action")).toHaveText("Resume");
  await expect(bar.getByTestId("usage-action")).toBeEnabled();
  await expect(bar).not.toContainText("on the computer running Slack Off");
  reason = "threshold";
  await page.reload();
  await expect(bar.getByTestId("usage-action")).toHaveText("Resume");
  await expect(bar.getByTestId("usage-action")).toBeDisabled();
  await expect(bar).toContainText("With the API key (real money), a threshold pause is resumed on the computer running Slack Off. Open Cost & quota there.");
  await expect(page.getByText("only available on this computer")).toHaveCount(0);
  await expectNoHorizontalScroll(page, W);
  await page.unrouteAll();
  await post(request, "/api/usage/resume");
});

test("phone: Settings → Budget and the warning banner at 390px", async ({ page, request }) => {
  const n = (await get<{ totals: { runs: number } }>(request, "/api/usage?window=5h")).totals.runs;
  await page.goto("/settings");
  const card = visible(page.locator("section").filter({ has: page.getByText("Budget", { exact: true }) })).first();
  await expect(card).toBeVisible();
  await expect(card.getByLabel(/Most USD/)).toHaveCount(0);
  await expectNoHorizontalScroll(page, W);
  await expectTouchTargets(card);
  await card.locator("label:has(button[role=switch])").click();
  await card.getByLabel("Most runs in the window").fill(String(n + 1));
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(visible(page.getByText("Saved.", { exact: true }))).toBeVisible();
  await page.goto("/cost");
  const banner = page.getByTestId("usage-banner");
  await expect(banner).toHaveAttribute("data-kind", "warn");
  await expect(banner).toContainText(/Usage at \d+% of your 5-hour budget\./);
  await expect(page.getByRole("progressbar")).toHaveAttribute("data-tone", "warn");
  await expectNoHorizontalScroll(page, W);
  expect((await banner.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // thresholds off again: nothing left behind for the other specs
  const config = await get<{ budget: Record<string, unknown> }>(request, "/api/config");
  expect((await request.put(`${API}/api/config`, { data: { ...config, budget: { ...config.budget, enabled: false } } })).ok()).toBe(true);
});

// ---- phase 4c Task 5 at 390px: Run tracing in Settings, the export card and its confirmation in the sticky bar ----

test("phone: Run tracing settings and a confirmed export from the sticky bar; no sideways scroll; touch targets", async ({ page, request }) => {
  const receiver = await otlpReceiver();
  try {
    await page.goto("/settings");
    const card = visible(page.locator("section").filter({ has: page.getByTestId("tracing-settings") })).first();
    await expect(card.getByTestId("tracing-warning")).toContainText("Each export is confirmed.");
    await card.getByLabel("OTLP endpoint (traces)").fill(receiver.url);
    await card.getByRole("switch", { name: "Include prompts and agent output" }).click();
    await expect(card.getByTestId("tracing-content-warning")).toBeVisible();
    await expectNoHorizontalScroll(page, W);
    await card.getByRole("switch", { name: "Include prompts and agent output" }).click();
    const headers = card.getByTestId("credential-otlpHeaders");
    await headers.getByLabel("Header name 1").fill("x-otlp-auth");
    await headers.getByLabel("Header value 1").fill(`fake-e2e-phone-${Date.now()}-abcdef`);
    await headers.getByRole("button", { name: "Add header" }).click();
    await expect(headers.getByLabel("Header name 2")).toBeVisible();
    await expectNoHorizontalScroll(page, W);
    await expectTouchTargets(card);
    await headers.getByRole("button", { name: "Remove this header" }).last().click();
    await headers.getByRole("button", { name: "Save headers" }).click();
    await expect(headers.getByTestId("otlp-headers-status")).toContainText("Set: x-otlp-auth");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(visible(page.getByText("Saved.", { exact: true }))).toBeVisible();
    await expectNoHorizontalScroll(page, W);

    const preview = await get<{ runCount: number }>(request, "/api/telemetry/preview");
    expect(preview.runCount).toBeGreaterThan(0);
    await page.goto("/cost");
    const exportCard = page.getByTestId("export-card");
    await expect(exportCard.getByTestId("export-open")).toContainText(`to ${receiver.host}`);
    await expectNoHorizontalScroll(page, W);
    await expectTouchTargets(exportCard);
    await exportCard.getByTestId("export-open").click();
    const bar = page.getByTestId("cost-bar");
    await expect(bar.getByTestId("export-this-will")).toContainText(`This will: send ${preview.runCount} agent`);
    await expect(bar.getByTestId("export-this-will")).toContainText(`to ${receiver.host}. Recorded in the audit log.`);
    await expect(bar.getByTestId("usage-action")).toHaveCount(0);
    await expect(page.getByTestId("export-confirm-inline")).toBeHidden();
    await expectNoHorizontalScroll(page, W);
    await expectTouchTargets(bar);
    // Cancel gives the pause bar back; nothing was sent
    await bar.getByTestId("export-cancel").click();
    await expect(bar.getByTestId("usage-action")).toBeVisible();
    expect(receiver.received).toHaveLength(0);
    await exportCard.getByTestId("export-open").click();
    await bar.getByTestId("export-confirm").click();
    await expect(exportCard.getByTestId("export-done")).toContainText(`to ${receiver.host}.`);
    expect(receiver.received).toHaveLength(1);
    expect(spansIn(receiver.received[0]!)).toHaveLength(preview.runCount);
    await expect(bar.getByTestId("usage-action")).toBeVisible();
    await expectNoHorizontalScroll(page, W);
  } finally {
    await receiver.close();
  }
});
