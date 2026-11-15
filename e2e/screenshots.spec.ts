import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { ensureDiscovered, expectNoHorizontalScroll, post, refineToChoice, solutionIds, waitState } from "./helpers.ts";

// README screenshots of the running app (fake mode: fictional FAKE-* tickets, no real data), at desktop width and at
// 390x844. Not part of `pnpm e2e`; run `pnpm screenshots` and commit docs/screenshots/*.png when the UI changes.
// Phases are driven through the API, then each page is shot in both viewports from the same data.

const OUT = join(import.meta.dirname, "..", "docs", "screenshots");
const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;

const PAGES: Array<{ name: string; path: string; ready: (page: Page) => Promise<void> }> = [
  { name: "tickets", path: "/", ready: async (p) => void (await expect(p.getByText("FAKE-1").filter({ visible: true }).first()).toBeVisible()) },
  { name: "solutions", path: "/tickets/FAKE-1/solutions", ready: async (p) => void (await expect(p.getByText("Option A").filter({ visible: true }).first()).toBeVisible()) },
  { name: "design-debate", path: "/tickets/FAKE-2/design", ready: async (p) => void (await expect(p.getByText("Debate escalated to you").filter({ visible: true }).first()).toBeVisible()) },
  { name: "acceptance", path: "/tickets/FAKE-3/acceptance", ready: async (p) => void (await expect(p.getByTestId("verdict-banner").filter({ visible: true })).toBeVisible()) },
];

test.setTimeout(600_000);

async function shoot(browser: Browser, kind: keyof typeof VIEWPORTS): Promise<void> {
  const context = await browser.newContext(VIEWPORTS[kind]);
  const page = await context.newPage();
  for (const { name, path, ready } of PAGES) {
    await page.goto(path);
    await ready(page);
    await page.waitForLoadState("networkidle");
    if (kind === "phone") await expectNoHorizontalScroll(page, 390);
    await page.screenshot({ path: join(OUT, `${kind}-${name}.png`) });
  }
  await context.close();
}

test("README screenshots: desktop and phone", async ({ browser, request }) => {
  mkdirSync(OUT, { recursive: true });
  await ensureDiscovered(request);

  // FAKE-1 waits for a solution choice
  await refineToChoice(request, "FAKE-1");

  // FAKE-2's critic never stops blocking: the debate escalates to the developer
  await refineToChoice(request, "FAKE-2");
  const [optionA] = await solutionIds(request, "FAKE-2");
  await post(request, "/api/tickets/FAKE-2/choose", { solutionId: optionA });

  // FAKE-3 goes all the way to an acceptance report that waits for confirmation
  await refineToChoice(request, "FAKE-3");
  const [, optionB] = await solutionIds(request, "FAKE-3");
  await post(request, "/api/tickets/FAKE-3/choose", { solutionId: optionB });
  await waitState(request, "FAKE-3", ["awaiting_snapshot_ack"], 60_000);
  await post(request, "/api/tickets/FAKE-3/snapshot-ack", { note: "Saved searches are out of scope, agreed with PM" });
  await waitState(request, "FAKE-3", ["dev_done"], 120_000);
  await post(request, "/api/tickets/FAKE-3/review/handoff");
  await waitState(request, "FAKE-3", ["awaiting_review_ack"], 60_000);
  await post(request, "/api/tickets/FAKE-3/review/ack", { note: "The search-time display is a follow-up ticket" });
  await waitState(request, "FAKE-3", ["awaiting_confirmation"], 120_000);
  await waitState(request, "FAKE-2", ["awaiting_debate_ruling"], 60_000);

  await shoot(browser, "desktop");
  await shoot(browser, "phone");
});
