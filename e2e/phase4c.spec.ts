import { expect, test } from "@playwright/test";
import { API, discover, get, post, visible, waitState } from "./helpers.ts";
import { otlpReceiver, spansIn } from "./otlp-receiver.ts";

// Phase 4c (tasks 1-3) on desktop (1440): the Cost & quota page, the usage pause, the banner and the Budget settings,
// in fake mode (the fake agent records runs like the real one; no real claude, no network).

test.describe.configure({ mode: "serial" });

interface Usage { totals: { runs: number }; budget: { state: string; ratio: number } | null; paused: { reason: string; detail: string } | null }
const usage = (request: Parameters<typeof get>[0], window = "5h") => get<Usage>(request, `/api/usage?window=${window}`);

async function putBudget(request: Parameters<typeof get>[0], budget: Record<string, unknown>) {
  const config = await get<{ budget: Record<string, unknown> }>(request, "/api/config");
  const res = await request.put(`${API}/api/config`, { data: { ...config, budget: { ...config.budget, ...budget } } });
  expect(res.ok(), await res.text()).toBe(true);
}

test("Cost & quota: empty window, subscription wording, the sidebar link", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Cost & quota" }).click();
  await expect(page).toHaveURL(/\/cost$/);
  await expect(page.getByRole("heading", { name: "Cost & quota" })).toBeVisible();
  await expect(page.getByText("Subscription mode (Claude Code)")).toBeVisible();
  await expect(page.getByTestId("usage-empty")).toHaveText("No agent runs in this window");
  await expect(page.getByTestId("usage-stat-cost")).toContainText("API-equivalent estimate");
  await expect(page.getByTestId("usage-budget")).toContainText("Thresholds are off");
  for (const w of ["5 h", "Day", "Week", "30 days"]) await expect(page.getByTestId("usage-window").getByRole("radio", { name: w, exact: true })).toBeVisible();
  await page.getByTestId("usage-window").getByRole("radio", { name: "Week", exact: true }).click();
  await expect(page.getByTestId("usage-window").getByRole("radio", { name: "Week", exact: true })).toHaveAttribute("aria-checked", "true");
});

test("runs show up by ticket, role and day", async ({ page, request }) => {
  await discover(request);
  await post(request, "/api/tickets/FAKE-1/refine");
  await waitState(request, "FAKE-1", ["awaiting_choice"]);
  await page.goto("/cost");
  await expect(page.getByTestId("usage-empty")).toHaveCount(0);
  await expect(page.getByTestId("usage-stat-runs")).not.toContainText(/^Runs\s*0/);
  await expect(visible(page.getByTestId("usage-tickets").getByRole("link", { name: "FAKE-1" }))).toBeVisible();
  await expect(page.getByTestId("usage-roles")).toContainText("refine-ticket");
  await expect(page.getByTestId("usage-bars")).toBeVisible();
});

test("pause by hand: the banner, a blocked ticket with its reason in Needs me, resume, Retry", async ({ page, request }) => {
  await page.goto("/cost");
  await visible(page.getByTestId("usage-action")).click();
  const banner = page.getByTestId("usage-banner");
  await expect(banner).toContainText("Usage paused — paused by hand.");
  await expect(visible(page.getByTestId("usage-paused"))).toContainText("Paused by hand");
  await expect(visible(page.getByTestId("usage-action"))).toHaveText("Resume");

  // a new agent run is refused: FAKE-2 blocks with a reason that says how to continue
  await post(request, "/api/tickets/FAKE-2/refine");
  await waitState(request, "FAKE-2", ["blocked"]);
  const t = await get<{ ticket: { blockedReason: string } }>(request, "/api/tickets/FAKE-2");
  expect(t.ticket.blockedReason).toBe("Paused: paused by hand — resume in Cost & quota, then Retry");
  await expect(banner).toContainText("Usage paused — paused by hand. 1 ticket waiting.");
  await page.goto("/?needs=1");
  await expect(page.locator("tr", { hasText: "FAKE-2" })).toBeVisible();
  await page.goto("/tickets/FAKE-2");
  await expect(page.getByRole("alert").filter({ hasText: "Paused: paused by hand" })).toBeVisible();
  await expect(page.getByTestId("resumed-note")).toHaveCount(0);

  // the banner links to Cost & quota; resuming removes it, the ticket still needs Retry
  await banner.click();
  await expect(page).toHaveURL(/\/cost$/);
  await visible(page.getByTestId("usage-action")).click();
  await expect(page.getByTestId("usage-banner")).toHaveCount(0);
  await page.goto("/tickets/FAKE-2");
  await expect(page.getByTestId("resumed-note")).toHaveText("Resumed: retry to continue");
  expect((await get<{ ticket: { state: string } }>(request, "/api/tickets/FAKE-2")).ticket.state).toBe("blocked");
  await page.getByRole("button", { name: "Retry" }).first().click();

  // FAKE-2's first propose hits the CLI's usage limit (fake switch usageLimitOnce): an auto-pause, the ticket blocks
  // with the CLI's wording; resume, Retry, and the run goes through
  await waitState(request, "FAKE-2", ["blocked"]);
  expect((await get<{ ticket: { blockedReason: string } }>(request, "/api/tickets/FAKE-2")).ticket.blockedReason).toBe(
    "Paused: Claude usage limit reached · resets 5pm (fake mode) — resume in Cost & quota, then Retry",
  );
  await page.goto("/cost");
  await expect(visible(page.getByTestId("usage-paused"))).toContainText("Paused: the CLI reported its usage limit");
  await expect(page.getByTestId("usage-banner")).toContainText("Claude usage limit reached");
  await visible(page.getByTestId("usage-action")).click();
  await expect(page.getByTestId("usage-banner")).toHaveCount(0);
  await post(request, "/api/tickets/FAKE-2/retry");
  await waitState(request, "FAKE-2", ["awaiting_choice"]);

  const audit = await get<{ events: Array<{ type: string; payload: { reason?: string } }> }>(request, "/api/audit");
  expect(audit.events.filter((e) => e.type === "usage_paused" || e.type === "usage_resumed").map((e) => e.type)).toEqual(["usage_paused", "usage_resumed", "usage_paused", "usage_resumed"]);
  expect(audit.events.filter((e) => e.type === "usage_paused").map((e) => e.payload.reason)).toEqual(["manual", "limit_reached"]);
});

test("Settings → Budget: thresholds, the warning banner, then a threshold pause before the next run", async ({ page, request }) => {
  const n = (await usage(request)).totals.runs;
  expect(n).toBeGreaterThanOrEqual(4);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Budget" }).click();
  const section = visible(page.getByTestId("budget-settings"));
  // a subscription: no USD limit field
  await expect(section.getByLabel(/Most USD/)).toHaveCount(0);
  await section.getByRole("switch").click();
  await section.getByLabel("Most runs in the window").fill(String(n + 1));
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(visible(page.getByText("Saved.", { exact: true }))).toBeVisible();
  const b = (await usage(request)).budget!;
  expect(b.state).toBe("warn");
  await page.goto("/cost");
  await expect(page.getByTestId("usage-banner")).toHaveAttribute("data-kind", "warn");
  await expect(page.getByTestId("usage-banner")).toContainText(/Usage at \d+% of your 5-hour budget\./);
  await expect(page.getByRole("progressbar")).toHaveAttribute("data-tone", "warn");

  // the limit is reached: the next run does not start, the pause says why, running work was not touched
  await putBudget(request, { maxRuns: n });
  await post(request, "/api/tickets/FAKE-3/refine");
  await waitState(request, "FAKE-3", ["blocked"]);
  const reason = (await get<{ ticket: { blockedReason: string } }>(request, "/api/tickets/FAKE-3")).ticket.blockedReason;
  expect(reason).toMatch(/^Paused: runs reached \d+\/\d+ in the last 5h — resume in Cost & quota, then Retry$/);
  await page.reload();
  await expect(page.getByTestId("usage-banner")).toHaveAttribute("data-kind", "paused");
  await expect(page.getByTestId("usage-paused")).toContainText("a threshold was reached");
  await expect(page.getByRole("progressbar")).toHaveAttribute("data-tone", "over");

  // turn the thresholds off, resume, Retry
  await putBudget(request, { enabled: false });
  await visible(page.getByTestId("usage-action")).click();
  await expect(page.getByTestId("usage-banner")).toHaveCount(0);
  await post(request, "/api/tickets/FAKE-3/retry");
  await waitState(request, "FAKE-3", ["awaiting_choice"]);
});

test("a warn threshold below the limit never pauses; thresholds off never pause", async ({ request }) => {
  const n = (await usage(request)).totals.runs;
  await putBudget(request, { enabled: true, maxRuns: n + 1000 });
  expect((await usage(request)).paused).toBeNull();
  await putBudget(request, { enabled: false, maxRuns: 1 });
  expect((await usage(request)).paused).toBeNull();
});

// ---- phase 4c Task 5: Run tracing in Settings, then one confirmed export to a local receiver ----

test("Run tracing: the warning, the endpoint, the content switch's warning, the auth headers; then a confirmed export", async ({ page, request }) => {
  const receiver = await otlpReceiver();
  try {
    // off: no export card
    await page.goto("/cost");
    await expect(page.getByTestId("usage-stat-runs")).toBeVisible();
    await expect(page.getByTestId("export-card")).toHaveCount(0);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Run tracing" }).click();
    const section = visible(page.getByTestId("tracing-settings"));
    await expect(section.getByTestId("tracing-warning")).toHaveText(
      "Exporting sends ticket keys and run details (and, if you turn it on, ticket content and code) to this service. Off by default. Each export is confirmed.",
    );
    await section.getByLabel("OTLP endpoint (traces)").fill("http://example.com/v1/traces");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "http:// is only allowed for a collector on this computer" })).toBeVisible();
    await section.getByLabel("OTLP endpoint (traces)").fill(receiver.url);
    await section.getByRole("switch", { name: "Include prompts and agent output" }).click();
    await expect(section.getByTestId("tracing-content-warning")).toHaveText("Prompts and agent output — ticket text and code — are sent too");
    await section.getByRole("switch", { name: "Include prompts and agent output" }).click();
    await expect(section.getByTestId("tracing-content-warning")).toHaveCount(0);
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(visible(page.getByText("Saved.", { exact: true }))).toBeVisible();

    const header = `fake-e2e-otlp-${Date.now()}-abcdef`;
    const headers = section.getByTestId("credential-otlpHeaders");
    await headers.getByLabel("Header name 1").fill("x-otlp-auth");
    await headers.getByLabel("Header value 1").fill(header);
    await headers.getByRole("button", { name: "Save headers" }).click();
    await expect(headers.getByTestId("otlp-headers-status")).toContainText("Set: x-otlp-auth");
    await expect(headers.getByLabel("Header value 1")).toHaveCount(0);
    expect(await page.content()).not.toContain(header);

    // Cost & quota: "Export N runs to <host>", a confirmation naming what is sent, one request to the receiver
    const preview = await get<{ runCount: number; endpointHost: string }>(request, "/api/telemetry/preview");
    expect(preview.runCount).toBeGreaterThan(0);
    await page.goto("/cost");
    const card = page.getByTestId("export-card");
    const runs = `${preview.runCount} ${preview.runCount === 1 ? "run" : "runs"}`;
    await expect(card.getByTestId("export-open")).toHaveText(`Export ${runs} to ${receiver.host}`);
    await expect(card).toContainText("Sends: role, ticket key, duration, tokens, cost, tool names.");
    await card.getByTestId("export-open").click();
    const inline = visible(page.getByTestId("export-confirm-inline"));
    await expect(inline).toContainText(`send ${preview.runCount} agent ${preview.runCount === 1 ? "run" : "runs"} (role, ticket key, duration, tokens, cost, tool names) to ${receiver.host}. Recorded in the audit log.`);
    expect(receiver.received).toHaveLength(0);
    await inline.getByTestId("export-confirm").click();
    await expect(card.getByTestId("export-done")).toHaveText(`Exported ${runs} to ${receiver.host}.`);
    expect(receiver.received).toHaveLength(1);
    const [got] = receiver.received;
    expect(got!.headers["content-type"]).toBe("application/json");
    expect(got!.headers["x-otlp-auth"]).toBe(header);
    expect(spansIn(got!)).toHaveLength(preview.runCount);
    // metadata only: no ticket description text
    for (const text of ["Add an export button to the orders page", "Order search takes several seconds", "Move orders older than two years"]) expect(got!.body).not.toContain(text);
    await expect(card.getByTestId("export-open")).toHaveText(`No new runs to export to ${receiver.host}`);
    await expect(card.getByTestId("export-open")).toBeDisabled();

    const audit = await get<{ events: Array<{ type: string; payload: Record<string, unknown> }> }>(request, "/api/audit");
    const exported = audit.events.filter((e) => e.type === "telemetry_exported");
    expect(exported).toHaveLength(1);
    expect(exported[0]!.payload).toMatchObject({ endpointHost: receiver.host, runCount: preview.runCount, includeContent: false, status: "done", decidedBy: "local" });
    expect(JSON.stringify(audit)).not.toContain(header);
  } finally {
    await receiver.close();
  }
});

// F4C-1 (M-1): the confirmation sends the hash of the preview it showed; runs finished while it is open refuse it
test("an export confirmation opened before new runs is refused (preview again); the fresh preview sends them all", async ({ page, request }) => {
  const receiver = await otlpReceiver();
  try {
    const config = await get<Record<string, unknown>>(request, "/api/config");
    const put = await request.put(`${API}/api/config`, { data: { ...config, telemetry: { endpoint: receiver.url, includeContent: false } } });
    expect(put.ok(), await put.text()).toBe(true);
    const refine = async () => {
      await post(request, "/api/tickets/FAKE-1/refine");
      await waitState(request, "FAKE-1", ["awaiting_choice"]);
    };
    const count = async () => (await get<{ runCount: number }>(request, "/api/telemetry/preview")).runCount;
    const label = (n: number) => `${n} ${n === 1 ? "run" : "runs"}`;
    await refine();
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await page.goto("/cost");
    const card = page.getByTestId("export-card");
    await expect(card.getByTestId("export-open")).toHaveText(`Export ${label(before)} to ${receiver.host}`);
    await card.getByTestId("export-open").click();
    const inline = visible(page.getByTestId("export-confirm-inline"));
    await expect(inline).toContainText(`send ${before} agent ${before === 1 ? "run" : "runs"}`);

    // new runs finish while the confirmation is open: the page refetches its preview, the confirmation keeps what it showed
    await refine();
    const after = await count();
    expect(after).toBeGreaterThan(before);
    await expect(card.getByTestId("export-open")).toHaveText(`Export ${label(after)} to ${receiver.host}`);
    await expect(inline).toContainText(`send ${before} agent ${before === 1 ? "run" : "runs"}`);
    await inline.getByTestId("export-confirm").click();
    await expect(page.getByRole("alert").filter({ hasText: "the runs to export changed — preview again" })).toBeVisible();
    expect(receiver.received).toHaveLength(0);

    // a fresh confirmation sends what it shows
    await card.getByTestId("export-open").click();
    await expect(inline).toContainText(`send ${after} agent runs`);
    await inline.getByTestId("export-confirm").click();
    await expect(card.getByTestId("export-done")).toHaveText(`Exported ${label(after)} to ${receiver.host}.`);
    expect(receiver.received).toHaveLength(1);
    expect(spansIn(receiver.received[0]!)).toHaveLength(after);
  } finally {
    await receiver.close();
  }
});
