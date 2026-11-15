import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, discover, get, post, refineToChoice, solutionIds, visible } from "./helpers.ts";

// Phase 4d (tasks 2-6) on desktop (1440), fake mode (no real claude, no network): preferences from three choices, the
// hint on the Solutions tab, edit and clear (this computer); a prompt draft tried on the sample ticket; Restore default
// with its confirmation and the built-in instructions.

test.describe.configure({ mode: "serial" });

/** FAKE-1..3 each choose the simplest option (B, "Client-side CSV", complexity S, no new dependency). */
export async function chooseSimplestThrice(request: APIRequestContext): Promise<void> {
  await discover(request);
  for (const key of ["FAKE-1", "FAKE-2", "FAKE-3"]) {
    await refineToChoice(request, key);
    const ids = await solutionIds(request, key);
    await post(request, `/api/tickets/${key}/choose`, { solutionId: ids[1], note: "" });
  }
}

async function openPreferences(page: Page) {
  await page.goto("/settings");
  await visible(page.getByRole("button", { name: "Preferences" })).click();
}

test("three simplest choices: the derived summary in Settings, the hint on the Solutions tab", async ({ page, request }) => {
  await chooseSimplestThrice(request);
  const state = await get<{ counted: number; current: { source: string; text: string } }>(request, "/api/preferences");
  expect(state.counted).toBe(3);
  expect(state.current.source).toBe("derived");

  await openPreferences(page);
  const section = visible(page.getByTestId("preferences-section"));
  await expect(section.getByTestId("preferences-current")).toContainText("In 3 of 3 comparable choices you picked the simplest option (lowest complexity).");
  await expect(section).toContainText("Derived from your choices");
  await expect(section.getByTestId("preferences-not-enough")).toHaveCount(0);

  await page.goto("/tickets/FAKE-1/solutions");
  const hint = visible(page.getByTestId("preference-hint"));
  await expect(hint).toContainText("Your past choices: you tended to pick the simplest option");
  await expect(hint).toContainText("avoid new dependencies");
  await hint.getByRole("link", { name: "Edit" }).click();
  await expect(page).toHaveURL(/\/settings#preferences$/);
  await expect(visible(page.getByTestId("preferences-section"))).toBeVisible();
});

test("edit the summary, then clear it (each confirmed); the hint follows and disappears", async ({ page, request }) => {
  await openPreferences(page);
  const section = visible(page.getByTestId("preferences-section"));
  await section.getByRole("textbox", { name: "Your preference text" }).fill("Prefer small changes in one repository.");
  await section.getByRole("button", { name: "Save as your text" }).click();
  await expect(section.getByTestId("preferences-current")).toHaveText("Prefer small changes in one repository.");
  await expect(section).toContainText("Edited by you");

  // F4D-1 (M10): the summary changes elsewhere while you type: your text stays, a note offers Reload
  const box = section.getByRole("textbox", { name: "Your preference text" });
  await box.fill("Half typed, not saved");
  const res = await request.put(`${API}/api/preferences`, { data: { text: "Prefer small changes in one repository.\nWrite the tests first." } });
  expect(res.status()).toBe(200);
  await expect(section.getByTestId("preferences-changed")).toContainText("The summary changed — reload to see it.");
  await expect(box).toHaveValue("Half typed, not saved");
  await section.getByTestId("preferences-changed").getByRole("button", { name: "Reload" }).click();
  await expect(box).toHaveValue("Prefer small changes in one repository.\nWrite the tests first.");
  await expect(section.getByTestId("preferences-changed")).toHaveCount(0);

  await page.goto("/tickets/FAKE-2/solutions");
  await expect(visible(page.getByTestId("preference-hint"))).toContainText("Your preferences: Prefer small changes in one repository.");

  await openPreferences(page);
  await visible(page.getByTestId("preferences-section")).getByRole("button", { name: "Clear" }).click();
  const bar = page.getByTestId("preferences-clear-confirm");
  await expect(bar).toContainText("This will: save an empty summary; choices made so far stop counting.");
  // nothing happened before the confirmation
  expect((await get<{ current: { source: string } }>(request, "/api/preferences")).current.source).toBe("edited");
  await bar.getByRole("button", { name: "Clear" }).click();
  await expect(bar).toHaveCount(0);
  await expect(visible(page.getByTestId("preferences-section"))).toContainText("Not enough choices yet (0 of 3)");
  expect((await get<{ current: { source: string; text: string } }>(request, "/api/preferences")).current).toMatchObject({ source: "cleared", text: "" });

  await page.goto("/tickets/FAKE-1/solutions");
  await expect(visible(page.getByTestId("solution-repos")).first()).toBeVisible();
  await expect(page.getByTestId("preference-hint")).toHaveCount(0);
});

test("try a refine-ticket draft on the sample ticket: confirm, the result, nothing saved", async ({ page, request }) => {
  const before = await get<Array<{ version: number }>>(request, "/api/prompts/refine-ticket/versions");
  const tickets = (await get<unknown[]>(request, "/api/tickets")).length;
  await page.goto("/settings");
  const editor = page.getByRole("textbox", { name: "Additional instructions" });
  await editor.fill("Always list what is unclear.");
  await page.getByTestId("trial-button").click();
  const bar = page.getByTestId("trial-confirm");
  await expect(bar).toContainText("This will: run refine-ticket once on the sample ticket. Uses your Claude quota (about one agent run).");
  await bar.getByRole("button", { name: "Run once" }).click();
  const result = page.getByTestId("trial-result");
  await expect(result).toContainText("Ran with your unsaved text on SAMPLE-1. Nothing was saved.");
  await expect(result).toContainText("Acceptance criteria");
  await expect(result.locator("li").first()).toBeVisible();
  // nothing was saved: no new prompt version, no new ticket; the run is a trial in agent_run (Cost & quota "no ticket")
  expect(await get<Array<{ version: number }>>(request, "/api/prompts/refine-ticket/versions")).toEqual(before);
  expect((await get<unknown[]>(request, "/api/tickets")).length).toBe(tickets);
  const audit = await get<{ events: Array<{ type: string; payload: { role: string; draftLength: number } }> }>(request, "/api/audit");
  expect(audit.events.filter((e) => e.type === "prompt_trial_run").map((e) => e.payload)).toEqual([expect.objectContaining({ role: "refine-ticket", draftLength: "Always list what is unclear.".length })]);
  await expect(editor).toHaveValue("Always list what is unclear.");

  // implement-ticket cannot be tried, and says why
  await page.getByRole("button", { name: "implement-ticket" }).click();
  await expect(page.getByTestId("trial-button")).toBeDisabled();
  await expect(page.getByText("Not available for this role: it changes code, runs the app or uses JIRA")).toBeVisible();
});

test("restore default asks first, then the editor is empty; the built-in instructions are read-only", async ({ page, request }) => {
  const res = await page.request.put(`${API}/api/prompts/propose-solutions`, { data: { text: "Mention migrations." } });
  expect(res.ok()).toBe(true);
  await page.goto("/settings");
  await page.getByRole("button", { name: "propose-solutions" }).click();
  const editor = page.getByRole("textbox", { name: "Additional instructions" });
  await expect(editor).toHaveValue("Mention migrations.");
  await page.getByRole("button", { name: "Restore default" }).click();
  const bar = page.getByTestId("reset-confirm");
  await expect(bar).toContainText("Mention migrations.");
  await expect(bar).toContainText("Repository overrides in .slackoff/config.json are not affected.");
  // Cancel sends nothing
  await bar.getByRole("button", { name: "Cancel" }).click();
  expect((await get<{ current: { text: string } }>(request, "/api/prompts/propose-solutions")).current.text).toBe("Mention migrations.");
  await page.getByRole("button", { name: "Restore default" }).click();
  await page.getByTestId("reset-confirm").getByRole("button", { name: "Restore default" }).click();
  await expect(page.getByTestId("reset-confirm")).toHaveCount(0);
  await expect(editor).toHaveValue("");
  expect((await get<{ current: { text: string } }>(request, "/api/prompts/propose-solutions")).current.text).toBe("");
  const audit = await get<{ events: Array<{ type: string }> }>(request, "/api/audit");
  expect(audit.events.some((e) => e.type === "prompt_reset")).toBe(true);

  await page.getByRole("button", { name: "View built-in instructions" }).click();
  const builtIn = page.getByTestId("built-in-instructions");
  await expect(builtIn).toContainText("propose-solutions");
  await expect(builtIn).toContainText("newDependencies");
});
