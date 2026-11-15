import { readdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { development, enableJiraSync, ensureDiscovered, expectNoHorizontalScroll, get, refineToChoice, solutionIds, visible, waitState } from "./helpers.ts";

// Phase-2 flow on a phone (390x844) against the fake-mode server: every decision is taken through the sticky bottom
// bar (primary >= 44px tall, "This will:" under it), and no visited page scrolls horizontally. Phase 1 goes through
// the API. Fake switches as in phase2.spec.ts.

const W = 390;

// One server for the whole file: serial, and each test states what it needs (idempotent setup helpers).
test.describe.configure({ mode: "serial" });

async function visit(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("main").first()).toBeVisible();
}

/** The sticky bar's primary (orange, rightmost) button: a 44px touch target with "This will:" under it. */
async function expectBarPrimary(bar: Locator, name: string | RegExp): Promise<Locator> {
  const button = bar.getByRole("button", { name });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expect(bar.getByText("This will:").first()).toBeVisible();
  return button;
}

test("phone FAKE-1: choose through the bar -> development tab switches between api and web", async ({ page, request }) => {
  await ensureDiscovered(request);
  await refineToChoice(request, "FAKE-1");
  const bar = page.getByTestId("decision-bar");

  await visit(page, "/tickets/FAKE-1/solutions");
  await expect(visible(page.getByTestId("solution-repos")).first()).toContainText("api");
  await page.getByRole("radio", { name: "Option A" }).check();
  const picker = visible(page.getByTestId("repo-picker"));
  await expect(picker.getByRole("checkbox", { name: /^api/ })).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: /^web/ })).toBeChecked();
  await expectNoHorizontalScroll(page, W);
  await (await expectBarPrimary(bar, "Choose Option A")).click();

  await waitState(request, "FAKE-1", ["dev_done"]);
  await visit(page, "/tickets/FAKE-1/design");
  await expect(visible(page.getByTestId("design-checklist"))).toContainText("25 items · 0 disputed · 0 missing");
  await expectNoHorizontalScroll(page, W);

  await visit(page, "/tickets/FAKE-1/development");
  const tabs = page.getByRole("tablist", { name: "Repositories" });
  await tabs.getByRole("tab", { name: /^api/ }).click();
  await expect(tabs.getByRole("tab", { name: /^api/ })).toContainText("Passing");
  await expect(visible(page.getByTestId("dev-repo-api")).getByText(/^FAKE-1: /).first()).toBeVisible();
  await expect(visible(page.getByTestId("dev-repo-api")).getByText("infra/main.tf")).toBeVisible();
  await expect(visible(page.getByTestId("dev-repo-web"))).toHaveCount(0);
  await expectNoHorizontalScroll(page, W);
  await tabs.getByRole("tab", { name: /^web/ }).click();
  await expect(tabs.getByRole("tab", { name: /^web/ })).toContainText("Passing");
  await expect(visible(page.getByTestId("dev-repo-web")).getByText(/^FAKE-1: /).first()).toBeVisible();
  await expect(visible(page.getByTestId("dev-repo-api"))).toHaveCount(0);
  await expectNoHorizontalScroll(page, W);
  // dev_done: the hand-off is available (phase 3)
  await expect(bar.getByRole("button", { name: "Hand off to acceptance" })).toBeEnabled();
});

test("phone FAKE-2: edited repo set -> rulings through the bar (custom) -> JIRA write through the bar (fail, try again, done)", async ({ page, request }) => {
  await ensureDiscovered(request);
  const bar = page.getByTestId("decision-bar");
  // Settings on this computer at phone width: JIRA status sync on
  await visit(page, "/settings");
  const sync = visible(page.getByRole("switch", { name: "Set tickets to In Progress in JIRA" }));
  await expect(sync).not.toBeChecked();
  await sync.click();
  await visible(page.getByRole("button", { name: "Save settings" })).first().click();
  await expect(visible(page.getByText("Saved.", { exact: true })).first()).toBeVisible();
  await expectNoHorizontalScroll(page, W);

  await refineToChoice(request, "FAKE-2");
  await visit(page, "/tickets/FAKE-2/solutions");
  await page.getByRole("radio", { name: "Option A" }).check();
  const picker = visible(page.getByTestId("repo-picker"));
  await picker.getByRole("checkbox", { name: /^api/ }).uncheck();
  await expect(picker.getByText("edited from the proposal")).toBeVisible();
  await expect(bar.getByText(/start the design for web \(edited from the proposal\)/)).toBeVisible();
  await expectNoHorizontalScroll(page, W);
  await (await expectBarPrimary(bar, "Choose Option A")).click();

  await waitState(request, "FAKE-2", ["awaiting_debate_ruling"]);
  await visit(page, "/tickets/FAKE-2/design");
  const finalize = await expectBarPrimary(bar, /Finalize design/);
  // the recommended rulings are pre-selected: the developer overrides C-1 and writes their own for C-2
  await expect(page.getByTestId("ruling-recommended-C-1")).toBeVisible();
  await expect(finalize).toBeEnabled();
  await page.getByTestId("ruling-C-1").getByRole("radio", { name: /^Accept designer/ }).check();
  await page.getByTestId("ruling-C-2").getByRole("radio", { name: /^My own decision/ }).check();
  await expect(finalize).toBeDisabled();
  await page.getByTestId("ruling-C-2").getByRole("textbox").fill("Keep archived orders readable by support and finance.");
  await expect(finalize).toBeEnabled();
  await expect(bar.getByTestId("decision-hint")).toHaveCount(0);
  await expectNoHorizontalScroll(page, W);
  await finalize.click();

  await waitState(request, "FAKE-2", ["developing", "dev_done"]);
  // F2-I2: the pending write shows on the card (a 44px link to Development) and under Needs me
  await visit(page, "/?needs=1");
  const chip = visible(page.getByTestId("jira-write-pending"));
  await expect(chip).toHaveText("JIRA write pending");
  expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalScroll(page, W);
  await visit(page, "/tickets/FAKE-2/development");
  // the JIRA write owns the bar; its target status is on the page before anything is sent
  await expect(visible(page.getByTestId("jira-target"))).toContainText("In Progress");
  const send = await expectBarPrimary(bar, /Send to JIRA/);
  await expect(bar).toContainText("open FAKE-2 in your Chrome and change only its status to In Progress");
  await expectNoHorizontalScroll(page, W);
  await send.click();

  const jira = visible(page.getByTestId("jira-card"));
  await expect(jira.getByText("FAILED", { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page, W);
  const tryAgain = jira.getByRole("button", { name: "Try again" });
  expect((await tryAgain.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await tryAgain.click();
  // Try again records a new pending write next to the failed one (nothing is sent until confirmed)
  await expect.poll(async () => (await development(request, "FAKE-2")).jiraWrites.map((w) => w.state).sort()).toEqual(["failed", "pending"]);
  await (await expectBarPrimary(bar, /Send to JIRA/)).click();
  await expect(jira.getByText("FAKE-2 set to In Progress in JIRA.")).toBeVisible();

  await waitState(request, "FAKE-2", ["dev_done"]);
  await page.reload();
  // one affected repo: no picker, the web group only
  await expect(page.getByRole("tablist", { name: "Repositories" })).toHaveCount(0);
  await expect(visible(page.getByTestId("dev-repo-web")).getByText(/^FAKE-2: /).first()).toBeVisible();
  await expectNoHorizontalScroll(page, W);
  const dev = await development(request, "FAKE-2");
  expect(readdirSync(dev.ticketDir).filter((n) => !n.startsWith("."))).toEqual(["web"]);
});

test("phone FAKE-3: the JIRA ticket changed after the design -> acknowledge through the bar -> development", async ({ page, request }) => {
  await ensureDiscovered(request);
  await enableJiraSync(request);
  const bar = page.getByTestId("decision-bar");
  await refineToChoice(request, "FAKE-3");
  const [, optionB] = await solutionIds(request, "FAKE-3");
  const res = await request.post("http://127.0.0.1:4317/api/tickets/FAKE-3/choose", { data: { solutionId: optionB } });
  expect(res.ok()).toBe(true);
  await waitState(request, "FAKE-3", ["awaiting_snapshot_ack"]);

  await visit(page, "/tickets/FAKE-3/coverage");
  await expect(visible(page.getByText("Decision needed: the JIRA ticket changed before development")).first()).toBeVisible();
  const ack = await expectBarPrimary(bar, /Acknowledge & develop/);
  await expectNoHorizontalScroll(page, W);
  await ack.click();
  await expect(page.getByText("A note is required.").first()).toBeVisible();
  await visible(page.getByRole("textbox", { name: "Decision / rationale note (required)" })).fill("Saved searches are out of scope, agreed with PM");
  await ack.click();
  await waitState(request, "FAKE-3", ["dev_done"]);
  // F2-I2: In Progress in JIRA (not Ready for Dev), worked on by the platform: on the default list
  await visit(page, "/");
  await expect(visible(page.locator("article", { hasText: "FAKE-3" }))).toBeVisible();
  await visit(page, "/tickets/FAKE-3/development");
  await expect(visible(page.getByTestId("jira-card"))).toContainText("Already In Progress in JIRA — nothing was changed.");
  await expectNoHorizontalScroll(page, W);

  for (const path of ["/", "/settings", "/tickets/FAKE-2/design", "/tickets/FAKE-3/snapshot", "/tickets/FAKE-1/requirements"]) {
    await visit(page, path);
    await expectNoHorizontalScroll(page, W);
  }
  const audit = await get<{ chain: { ok: boolean } }>(request, "/api/audit");
  expect(audit.chain.ok).toBe(true);
});
