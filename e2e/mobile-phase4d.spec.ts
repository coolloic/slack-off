import { expect, test, type Locator } from "@playwright/test";
import { API, discover, expectNoHorizontalScroll, get, post, refineToChoice, solutionIds, visible } from "./helpers.ts";

// Phase 4d on a phone (390x844): the preference hint on the Solutions tab and the read-only Preferences card in
// Settings fit without sideways scroll; the trial-run button is not shown; Restore default confirms in the bottom bar
// and the built-in instructions wrap. Every touch target of the new UI is at least 44px tall.

const W = 390;
test.describe.configure({ mode: "serial" });

async function expectTouchTargets(scope: Locator) {
  const targets = scope.locator("button, a, textarea").filter({ visible: true });
  for (const t of await targets.all()) {
    const box = await t.boundingBox();
    expect(box!.height, (await t.textContent()) ?? "?").toBeGreaterThanOrEqual(44);
  }
}

test("phone: the hint on the Solutions tab and the read-only Preferences card fit at 390", async ({ page, request }) => {
  await discover(request);
  for (const key of ["FAKE-1", "FAKE-2", "FAKE-3"]) {
    await refineToChoice(request, key);
    const ids = await solutionIds(request, key);
    await post(request, `/api/tickets/${key}/choose`, { solutionId: ids[1], note: "" });
  }
  await page.goto("/tickets/FAKE-1/solutions");
  const hint = visible(page.getByTestId("preference-hint"));
  await expect(hint).toContainText("Your past choices: you tended to pick the simplest option");
  await expectNoHorizontalScroll(page, W);
  await expectTouchTargets(hint);

  await page.goto("/settings");
  const card = visible(page.getByTestId("preferences-section"));
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId("preferences-current")).toContainText("In 3 of 3 comparable choices you picked the simplest option");
  // read-only in the phone layout: no editor, no Clear / Re-derive
  await expect(card.getByRole("textbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Clear" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Re-derive" })).toHaveCount(0);
  await expectNoHorizontalScroll(page, W);
});

test("phone: no trial button; Restore default confirms in the bottom bar; the built-in instructions wrap", async ({ page, request }) => {
  const res = await request.put(`${API}/api/prompts/refine-ticket`, { data: { text: "Be terse. ".repeat(60) } });
  expect(res.ok()).toBe(true);
  await page.goto("/settings");
  await page.getByRole("button", { name: /refine-ticket/ }).first().click();
  await expect(page.getByRole("textbox", { name: "Additional instructions" })).toBeVisible();
  await expect(visible(page.getByTestId("trial-button"))).toHaveCount(0);

  await visible(page.getByRole("button", { name: "Restore default" })).click();
  const bar = page.getByTestId("reset-confirm");
  await expect(bar).toContainText("This will: save an empty version v2 for refine-ticket. Repository overrides in .slackoff/config.json are not affected.");
  await expectNoHorizontalScroll(page, W);
  await expectTouchTargets(bar);
  const box = await bar.boundingBox();
  expect(Math.round(box!.y + box!.height)).toBe(844);
  await bar.getByRole("button", { name: "Cancel" }).click();
  expect((await get<{ current: { text: string } }>(request, "/api/prompts/refine-ticket")).current.text).not.toBe("");

  await visible(page.getByRole("button", { name: "View built-in instructions" })).click();
  await expect(visible(page.getByTestId("built-in-instructions"))).toContainText("refine-ticket");
  await expectNoHorizontalScroll(page, W);
});
