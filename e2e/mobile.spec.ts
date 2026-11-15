import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectDesignOrLater } from "./helpers.ts";

// F-8: the ticket key links to the ticket in JIRA in a new tab (fake source URL)
async function expectJiraLink(link: Locator) {
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://fake-jira.example.com/browse/FAKE-1");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
}


// Phone (390x844) flow on the same fake-mode data: every decision is reachable through the sticky bottom bar,
// and no visited page scrolls horizontally.
async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
}

test("phone: tickets -> ticket -> AC coverage via sticky bar -> choose solution via sticky bar", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Fetch new tickets" }).click();
  await expect(page.getByRole("button", { name: "Fetching…" })).toBeDisabled();
  await expect(page.getByTestId("discover-status")).toHaveText("Found 3 new · 3 open in total");
  await page.getByRole("radio", { name: /^All/ }).click();
  await expectJiraLink(page.getByRole("link", { name: "Open FAKE-1 in JIRA" }));
  await expectNoHorizontalScroll(page);
  // JIRA-status filter: All open by default (author decision 2026-11-08); Ready for Dev hides the In Progress ticket
  const jiraFilter = page.getByRole("combobox", { name: "JIRA status" });
  await expect(jiraFilter).toHaveValue("open");
  await expect(jiraFilter).toHaveCSS("height", "44px");
  await expect(page.getByRole("article").filter({ hasText: "FAKE-3" })).toContainText("In Progress");
  await jiraFilter.selectOption({ label: "Ready for Dev (2)" });
  await expect(page.getByRole("article").filter({ hasText: "FAKE-3" })).toHaveCount(0);
  await jiraFilter.selectOption({ label: "All open (3)" });
  await expectNoHorizontalScroll(page);

  // Review AC first on, then refine (selection bar)
  await page.getByRole("switch", { name: "Review AC first FAKE-1" }).click();
  await expect(page.getByRole("switch", { name: "Review AC first FAKE-1" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Select FAKE-1" }).check();
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Start refining (1)" }).click();
  await expect(page.getByText("Awaiting AC review").filter({ visible: true }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);

  // open the ticket
  const card = page.getByRole("article").filter({ hasText: "FAKE-1" });
  await expect(card.getByRole("link", { name: "Open FAKE-1 in JIRA" })).toHaveCSS("min-height", "44px");
  await card.getByRole("link", { name: /Export orders as CSV/ }).click();
  await expectJiraLink(page.getByRole("link", { name: "Open in JIRA" }));
  await expect(page.getByRole("link", { name: "Open in JIRA" })).toHaveCSS("min-height", "44px");
  await page.getByRole("tab", { name: "Snapshot" }).click();
  await expect(page.getByText("comment#10001")).toBeVisible();
  const viewInJira = page.getByRole("link", { name: "View spec.pdf in JIRA" }).filter({ visible: true });
  await expect(viewInJira).toHaveAttribute("href", "https://fake-jira.example.com/browse/FAKE-1");
  await expect(viewInJira).toHaveCSS("min-height", "44px");
  await expectNoHorizontalScroll(page);

  // requirements: edit on the AC cards, add a developer AC, save through the bar
  await page.getByRole("tab", { name: "Requirements & AC" }).click();
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Edit AC-2" }).click();
  await page.getByRole("button", { name: "Delete AC-2" }).click();
  await page.getByRole("button", { name: "Add acceptance criterion" }).click();
  await page.getByRole("textbox", { name: "Enter acceptance criterion statement…" }).fill("Export respects the active filters.");
  await page.getByRole("combobox", { name: "Source" }).selectOption({ label: "Developer-added (reason required)" });
  await page.getByRole("button", { name: "Add to draft" }).click();
  await expect(page.getByText("Pick a source or give a reason.")).toBeVisible();
  await page.getByRole("textbox", { name: "Mandatory rationale (e.g. confirmed with PM in standup)" }).fill("Confirmed with PM in standup");
  await page.getByRole("button", { name: "Add to draft" }).click();
  await expectNoHorizontalScroll(page);
  const bar = page.getByTestId("decision-bar");
  await bar.getByRole("button", { name: "Save draft" }).click();

  // AC coverage: decision is in the sticky bar
  await page.getByRole("tab", { name: "AC coverage" }).click();
  await expect(page.getByText("Missing", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await bar.getByRole("button", { name: "Acknowledge & continue" }).click();
  await expect(page.getByText("A note is required.")).toBeVisible();
  await page.getByRole("textbox", { name: "Decision / rationale note (required)" }).fill("Dropped on purpose, confirmed with PM");
  await bar.getByRole("button", { name: "Acknowledge & continue" }).click();

  // solutions: pick Option B, confirm through the bar
  await page.getByRole("tab", { name: "Solutions" }).click();
  await expect(page.getByText("Option B: Client-side CSV")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole("radio", { name: "Option B" }).check();
  await bar.getByRole("button", { name: "Choose Option B" }).click();
  await expect(page.getByText("Chosen: Client-side CSV")).toBeVisible();
  await expectNoHorizontalScroll(page);
  // P-C12: phase 1 ends at the choice; the ticket is now designing or past it (phase 2: mobile-phase2.spec.ts)
  await expectDesignOrLater(request, "FAKE-1");
  await page.getByRole("tab", { name: "Design & debate" }).click();
  await expect(page.getByTestId("design-doc").filter({ visible: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  for (const path of ["/", "/settings"]) {
    await page.goto(path);
    await expect(page.locator("main, body").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  }

  const audit = await (await request.get("http://127.0.0.1:5173/api/audit")).json();
  expect(audit.chain.ok).toBe(true);
});

// F-I2: a paired phone (status.local === false) sees agent prompts, the Ready-for-dev status and the executor model read-only.
test("paired phone: agent prompts, the Ready-for-dev status and the phase-2 Mac-only settings are read-only with 'Change this on the Mac'", async ({ page }) => {
  await page.route("**/api/status", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), local: false } });
  });
  await page.goto("/settings");
  const status = page.getByLabel("Ready-for-dev status");
  await expect(status).toBeDisabled();
  await expect(page.getByLabel("Model (optional)")).toBeDisabled();
  await expect(page.getByText("use this model for all agents; leave empty for Claude Code's built-in default (your ~/.claude settings are not used by agents)")).toBeVisible();
  // phase 2 (R21): JIRA status sync, the in-progress status, the JIRA browser and the repository mapping are Mac-only;
  // the debate / development limits stay editable on the phone (P-phone)
  await expect(page.getByRole("switch", { name: "Set tickets to In Progress in JIRA" }).filter({ visible: true })).toBeDisabled();
  await expect(page.getByLabel("In-progress status").filter({ visible: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Detect browsers" })).toHaveCount(0);
  const repoPaths = page.getByRole("textbox", { name: "Repository path" }).filter({ visible: true });
  await expect(repoPaths).toHaveCount(2); // the fake FAKE project: api, web
  for (const p of await repoPaths.all()) await expect(p).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add mapping" }).filter({ visible: true })).toBeDisabled();
  await expect(page.getByLabel("Design debate rounds (1–5)").filter({ visible: true })).toBeEnabled();
  await expect(page.getByLabel("Development steps per iteration (1–50)").filter({ visible: true })).toBeEnabled();
  // phase 3 (R17 / R21): review status, sandbox opt-out, denied ports, Claude config dir and gh binary are Mac-only; attempts and timeouts stay editable
  const visible = (label: string) => page.getByLabel(label).filter({ visible: true });
  await expect(visible("Review status")).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Run repository commands without the sandbox" }).filter({ visible: true })).toBeDisabled();
  await expect(visible("Extra denied local ports")).toBeDisabled();
  await expect(visible("Acceptance Claude config directory")).toBeDisabled();
  await expect(visible("GitHub CLI")).toBeDisabled();
  await expect(visible("Acceptance fix attempts per round (1–5)")).toBeEnabled();
  await expect(visible("Application start timeout (seconds)")).toBeEnabled();
  await expect(visible("Acceptance run timeout (seconds)")).toBeEnabled();
  await expect(page.getByTestId("accept-login-command").filter({ visible: true })).toContainText("claude /login");
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: /refine-ticket/ }).click();
  await expect(page.getByRole("textbox", { name: "Additional instructions" })).toBeDisabled();
  await expect(page.getByText("Agent prompts are read-only on a paired phone. Change this on the Mac.").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Save as v/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restore default" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
