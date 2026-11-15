import { expect, test, type Locator, type Page } from "@playwright/test";
import { deliveryPreview, ensureDiscovered, expectNoHorizontalScroll, fakePrs, get, post, refineToChoice, remoteBranches, review, solutionIds, visible, waitState } from "./helpers.ts";

// Phase-3 flow on a phone (390x844) against the fake-mode server: FAKE-3 from dev_done to its pull request, every
// decision through the sticky bottom bar (primary >= 44px tall, "This will:" under it), no visited page scrolling
// horizontally. Phases 1–2 go through the API. Fake switches (dev/fake-mode.ts): FAKE-3 changes in JIRA after the
// design (ack before development) and again before acceptance (changesBeforeReview: ack before acceptance). JIRA status
// sync stays off, so the delivery changes nothing in JIRA.

const W = 390;

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

async function visit(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("main").first()).toBeVisible();
  await expectNoHorizontalScroll(page, W);
}

/** The sticky bar's primary (orange, rightmost) button: a 44px touch target with "This will:" under it. */
async function expectBarPrimary(bar: Locator, name: string | RegExp, exact = false): Promise<Locator> {
  const button = bar.getByRole("button", { name, exact });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expect(bar.getByText("This will:").first()).toBeVisible();
  return button;
}

test("phone FAKE-3: hand off through the bar -> JIRA changed before acceptance: acknowledge -> confirm & deliver (sync off)", async ({ page, request }) => {
  await ensureDiscovered(request);
  const bar = page.getByTestId("decision-bar");

  // phases 1–2 through the API: option B (web only); the change after the design is acknowledged before development
  await refineToChoice(request, "FAKE-3");
  const [, optionB] = await solutionIds(request, "FAKE-3");
  await post(request, "/api/tickets/FAKE-3/choose", { solutionId: optionB });
  await waitState(request, "FAKE-3", ["awaiting_snapshot_ack"], 60_000);
  await post(request, "/api/tickets/FAKE-3/snapshot-ack", { note: "Saved searches are out of scope, agreed with PM" });
  await waitState(request, "FAKE-3", ["dev_done"], 120_000);

  // dev_done: hand off through the bar
  await visit(page, "/tickets/FAKE-3/development");
  await expect(visible(page.getByText("Decision needed: development is done")).first()).toBeVisible();
  const handOff = await expectBarPrimary(bar, "Hand off to acceptance");
  await handOff.click();

  // the re-read before acceptance (third read) changed again: acknowledge through the bar (note required)
  await waitState(request, "FAKE-3", ["awaiting_review_ack"], 60_000);
  await visit(page, "/tickets/FAKE-3/coverage");
  await expect(visible(page.getByText("Decision needed: the JIRA ticket changed before acceptance")).first()).toBeVisible();
  const ack = await expectBarPrimary(bar, "Acknowledge & accept");
  await ack.click();
  await expect(page.getByText("A note is required.").first()).toBeVisible();
  await visible(page.getByRole("textbox", { name: "Decision / rationale note (required)" })).fill("The search-time display is a follow-up ticket");
  await ack.click();

  // acceptance passes on attempt 1
  await waitState(request, "FAKE-3", ["awaiting_confirmation"], 120_000);
  expect((await review(request, "FAKE-3")).reports.map((r) => [r.attempt, r.verdict])).toEqual([[1, "passed"]]);
  await visit(page, "/tickets/FAKE-3/acceptance");
  await expect(visible(page.getByTestId("verdict-banner"))).toContainText("Passed · attempt 1 of 3");

  // evidence lightbox: the close button is a 44px target
  await visible(page.getByRole("button", { name: /^Open evidence: AC-1: the orders page/ })).first().click();
  const lightbox = page.getByTestId("lightbox");
  await expect(lightbox).toBeVisible();
  const close = lightbox.getByRole("button", { name: "Close" });
  const cb = await close.boundingBox();
  expect(cb!.width).toBeGreaterThanOrEqual(44);
  expect(cb!.height).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalScroll(page, W);
  await close.click();
  await expect(lightbox).toHaveCount(0);

  // confirm & deliver through the bar: sync is off, so the confirmation says JIRA is not changed
  const plan = await deliveryPreview(request, "FAKE-3");
  expect(plan.blockers).toEqual([]);
  const confirm = await expectBarPrimary(bar, "Confirm", true); // exact: not "Confirm & deliver" or any other Confirm…
  await confirm.click();
  const dlv = page.getByTestId("delivery-sheet");
  await expect(dlv).toBeVisible();
  const items = dlv.getByTestId("delivery-actions").locator("li");
  await expect(items).toHaveCount(plan.actions.length);
  for (const [i, a] of plan.actions.entries()) await expect(items.nth(i)).toContainText(a.text);
  await expect(dlv).toContainText("JIRA is not changed");
  await expectNoHorizontalScroll(page, W);
  const deliver = dlv.getByRole("button", { name: "Deliver" });
  expect((await deliver.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await deliver.click();

  await waitState(request, "FAKE-3", ["pr_opened"], 60_000);
  await expect(page).toHaveURL(/\/tickets\/FAKE-3\/delivery$/);
  await expect(visible(page.getByTestId("delivery-done"))).toBeVisible();
  await expectNoHorizontalScroll(page, W);
  const prs = fakePrs().filter((p) => /^[a-z]+\/FAKE-3-/.test(p.head));
  expect(prs.map((p) => p.repo)).toEqual(["github.com/example-org/web"]);
  expect(remoteBranches("web")).toContain(prs[0]!.head);
  const t3 = await get<{ ticket: { jiraStatus: string } }>(request, "/api/tickets/FAKE-3");
  expect(t3.ticket.jiraStatus).toBe("In Progress");
  expect(await get<unknown[]>(request, "/api/tickets/FAKE-3/jira-comments")).toEqual([]);

  for (const path of ["/", "/tickets/FAKE-3/acceptance", "/tickets/FAKE-3/delivery", "/tickets/FAKE-3/requirements", "/settings"]) await visit(page, path);
  const audit = await get<{ chain: { ok: boolean } }>(request, "/api/audit");
  expect(audit.chain.ok).toBe(true);
});
