import { expect, test, type Page } from "@playwright/test";
import {
  chooseThroughApi, deliveryPreview, development, enableJiraSync, ensureDiscovered, fakePrs, get, remoteBranches, review, ruleForCritic, visible, waitState,
} from "./helpers.ts";

// Phase-3 flow on desktop (1440) against the fake-mode server, from dev_done to pull requests. Phases 1–2 go through the
// API; every phase-3 decision goes through the UI. The acceptance agent is fake (dev/fake-acceptance.ts) but the
// platform's re-run is real: the shim runs Playwright's own Chromium in the acceptance sandbox against the fake web app,
// itself started in the sandbox. gh is the fake one (dev/fake-gh.mjs) and origin pushes go to local bare repositories.
// Fake switches (dev/fake-mode.ts): FAKE-1's first acceptance fails AC-2 and refine drafts a comment to the reporter;
// FAKE-2's critic never stops blocking; FAKE-2 takes option 3 (api only: no acceptance section → E2E not executed).

test.describe.configure({ mode: "serial" });
// acceptance runs Playwright for real (twice for FAKE-1), with a fix iteration in between
test.setTimeout(300_000);

const tab = (page: Page, key: string, name: string) => page.goto(`/tickets/${key}/${name}`);

test("FAKE-1: hand off -> AC-2 fails -> fix iteration -> passes on attempt 2 -> comment -> confirm & deliver -> two PRs + JIRA", async ({ page, request }) => {
  await ensureDiscovered(request);
  await chooseThroughApi(request, "FAKE-1", 0); // api + web
  await waitState(request, "FAKE-1", ["dev_done"], 120_000);

  // hand off from the development tab
  await tab(page, "FAKE-1", "development");
  const handOff = visible(page.getByRole("button", { name: "Hand off to acceptance" }));
  await expect(handOff).toBeEnabled();
  await handOff.click();

  // attempt 1 fails AC-2 → an automatic fix iteration (review_failed) → attempt 2 passes
  await waitState(request, "FAKE-1", ["awaiting_confirmation"], 240_000);
  const dev = await development(request, "FAKE-1");
  expect(dev.iterations.map((i) => i.trigger)).toEqual(["initial", "review_failed"]);
  const rv = await review(request, "FAKE-1");
  expect(rv.reports.map((r) => [r.attempt, r.verdict])).toEqual([[1, "failed"], [2, "passed"]]);

  await tab(page, "FAKE-1", "acceptance");
  await expect(visible(page.getByTestId("verdict-banner"))).toContainText("Passed · attempt 2 of 3");
  await expect(visible(page.getByTestId("isolation-note"))).toContainText("saw only the requirements and ACs");
  await visible(page.getByRole("button", { name: /Previous attempts/ })).click();
  const timeline = visible(page.getByTestId("attempt-timeline"));
  await expect(timeline).toContainText("Attempt 1 · Failed · AC-2");
  await expect(timeline).toContainText("Attempt 2 · Passed");

  // the screenshot evidence opens in the lightbox
  const thumb = visible(page.getByRole("button", { name: /^Open evidence: AC-1: the orders page/ })).first();
  await thumb.click();
  const lightbox = page.getByTestId("lightbox");
  await expect(lightbox).toBeVisible();
  await expect(page.getByTestId("lightbox-caption")).toContainText("AC-1: the orders page");
  await expect.poll(async () => lightbox.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);
  await lightbox.getByRole("button", { name: "Close" }).click();
  await expect(lightbox).toHaveCount(0);

  // the requirement-unclear comment: edited, confirmed word for word, sent (sent before delivery: a delivered ticket
  // takes no more comments; the fake drift check treats a comment-only JIRA change as covered)
  await tab(page, "FAKE-1", "requirements");
  const box = visible(page.getByTestId("clarification-comment"));
  const edited = "Should the CSV include cancelled orders? We assume not — please confirm.";
  await box.getByRole("textbox").fill(edited);
  await box.getByRole("button", { name: "Send to JIRA" }).click();
  const sheet = page.getByTestId("comment-sheet");
  await expect(sheet).toContainText(edited);
  await sheet.getByRole("button", { name: "Send to JIRA" }).click();
  await expect(box.getByTestId("comment-history").getByText("Sent", { exact: true })).toBeVisible({ timeout: 15_000 });
  const sent = await get<Array<{ purpose: string; text: string; state: string }>>(request, "/api/tickets/FAKE-1/jira-comments");
  expect(sent).toEqual([expect.objectContaining({ purpose: "clarification", text: edited, state: "done" })]);

  // JIRA status sync on (this computer), then the confirmation lists exactly the plan's 8 actions
  await enableJiraSync(request);
  const plan = await deliveryPreview(request, "FAKE-1");
  expect(plan.blockers).toEqual([]);
  expect(plan.actions).toHaveLength(8);
  await tab(page, "FAKE-1", "acceptance");
  // Slack Off recommends from the report: passed and agreed → confirm
  await expect(visible(page.getByTestId("review-recommendation"))).toHaveText("Recommended: Confirm & deliver — Every acceptance criterion passed, and Slack Off's own re-run agreed.");
  await visible(page.getByRole("button", { name: "Confirm & deliver" })).click();
  const dlv = page.getByTestId("delivery-sheet");
  const items = dlv.getByTestId("delivery-actions").locator("li");
  await expect(items).toHaveCount(8);
  for (const [i, a] of plan.actions.entries()) await expect(items.nth(i)).toContainText(a.text);
  await expect(dlv).toContainText("Ready for Human Review");
  await dlv.getByRole("button", { name: "Deliver" }).click();

  // delivered: both PRs reference each other, both branches on the (fake) remotes, JIRA moved and commented
  await waitState(request, "FAKE-1", ["pr_opened"], 60_000);
  await expect(page).toHaveURL(/\/tickets\/FAKE-1\/delivery$/);
  await expect(visible(page.getByTestId("delivery-done"))).toBeVisible();
  const prs = fakePrs();
  expect(prs.map((p) => p.repo).sort()).toEqual(["github.com/example-org/api", "github.com/example-org/web"]);
  const [a, b] = prs as [(typeof prs)[0], (typeof prs)[0]];
  expect(a.body).toContain(b.url);
  expect(b.body).toContain(a.url);
  for (const p of prs) {
    expect(p.base).toBe("main");
    expect(p.head).toMatch(/^feat\/FAKE-1-/);
    expect(p.body).not.toMatch(/\.png|evidence\//);
    expect(remoteBranches(p.repo.split("/").at(-1)!)).toContain(p.head);
  }
  // the JIRA steps run after the pull requests
  await expect.poll(async () => (await get<{ ticket: { jiraStatus: string } }>(request, "/api/tickets/FAKE-1")).ticket.jiraStatus, { timeout: 30_000 }).toBe("Ready for Human Review");
  const deliveryComment = async () => (await get<Array<{ purpose: string; text: string; state: string }>>(request, "/api/tickets/FAKE-1/jira-comments")).filter((c) => c.purpose === "delivery");
  await expect.poll(async () => (await deliveryComment()).map((c) => c.state), { timeout: 30_000 }).toEqual(["done"]);
  const deliveryComments = await deliveryComment();
  expect(deliveryComments[0]!.text).toContain(a.url);
  expect(deliveryComments[0]!.text).toContain(b.url);
  // the Delivery tab: every step done
  await expect.poll(async () => (await get<{ deliveries: Array<{ steps: Array<{ state: string }> }> }>(request, "/api/tickets/FAKE-1/delivery")).deliveries.at(-1)!.steps.map((x) => x.state), { timeout: 30_000 })
    .toEqual(Array(plan.actions.length).fill("done"));
  await page.reload();
  await expect(visible(page.getByTestId("delivery-steps")).getByRole("img", { name: "Done" })).toHaveCount(plan.actions.length);
  const audit = await get<{ events: Array<{ type: string; ticketKey: string | null }> }>(request, "/api/audit?ticketKey=FAKE-1");
  expect(audit.events.filter((e) => e.type === "pr_opened")).toHaveLength(2);
  expect(audit.events.filter((e) => e.type === "branch_pushed")).toHaveLength(2);
});

test("FAKE-2 (api only, no acceptance section): E2E not executed -> the confirmation warns -> reject -> rejected iteration", async ({ page, request }) => {
  await ensureDiscovered(request);
  await chooseThroughApi(request, "FAKE-2", 2); // option 3: api only
  await waitState(request, "FAKE-2", ["awaiting_debate_ruling"], 60_000);
  await ruleForCritic(request, "FAKE-2", ["C-1", "C-2"]);
  await waitState(request, "FAKE-2", ["dev_done"], 120_000);
  expect((await development(request, "FAKE-2")).repos.map((r) => r.name)).toEqual(["api"]);

  await tab(page, "FAKE-2", "development");
  await visible(page.getByRole("button", { name: "Hand off to acceptance" })).click();
  await waitState(request, "FAKE-2", ["awaiting_confirmation"], 60_000);
  await tab(page, "FAKE-2", "acceptance");
  await expect(visible(page.getByTestId("verdict-banner"))).toContainText("E2E not executed");
  await expect(visible(page.getByTestId("review-recommendation"))).toContainText("confirm only after checking the change yourself");

  // the confirmation says so; not confirmed
  await visible(page.getByRole("button", { name: "Confirm & deliver" })).click();
  const dlv = page.getByTestId("delivery-sheet");
  await expect(dlv.getByTestId("delivery-warnings")).toContainText("E2E was not executed");
  await dlv.getByRole("button", { name: "Cancel" }).click();
  await expect(dlv).toHaveCount(0);

  // reject with a note → a new development iteration (trigger rejected)
  await visible(page.getByRole("textbox", { name: /Your note/ })).fill("Add an acceptance section to api so this can be tested.");
  await visible(page.getByRole("button", { name: "Reject", exact: true })).click();
  await expect(page).toHaveURL(/\/tickets\/FAKE-2\/development$/);
  await expect.poll(async () => (await development(request, "FAKE-2")).iterations.map((i) => i.trigger), { timeout: 30_000 }).toEqual(["initial", "rejected"]);
  // the rejected iteration runs, then acceptance again: still not executed, back to the developer
  await waitState(request, "FAKE-2", ["awaiting_confirmation"], 120_000);
  expect(fakePrs().filter((p) => p.head.includes("FAKE-2"))).toEqual([]);

  const audit = await get<{ chain: { ok: boolean } }>(request, "/api/audit");
  expect(audit.chain.ok).toBe(true);
});
