import { expect, test, type Locator } from "@playwright/test";
import { expectDesignOrLater, waitState } from "./helpers.ts";

// F-8: the ticket key links to the ticket in JIRA in a new tab (fake source URL)
async function expectJiraLink(link: Locator) {
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "https://fake-jira.example.com/browse/FAKE-1");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
}


// Phase-1 flow on desktop against the fake-mode server (canned FAKE-1, 2 comments, 2 solutions).
test("fetch -> refine -> edit ACs -> drift ack -> choose solution -> audit chain ok", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Fetch new tickets" }).click();
  // F-I3: the fake source answers after the 202, so the list fills from the SSE discover events
  await expect(page.getByRole("button", { name: "Fetching…" })).toBeDisabled();
  // every open ticket assigned to me is fetched; the list defaults to All open (author decision 2026-11-08)
  await expect(page.getByTestId("discover-status")).toHaveText("Found 3 new · 3 open in total");
  await expectJiraLink(page.getByRole("link", { name: "Open FAKE-1 in JIRA" }));
  const jiraFilter = page.getByRole("combobox", { name: "JIRA status" });
  await expect(jiraFilter).toHaveValue("open");
  await expect(jiraFilter.locator("option")).toHaveText(["All open (3)", "Ready for Dev (2)", "In Progress (1)"]);
  await expect(page.getByRole("link", { name: "Open FAKE-3 in JIRA" })).toBeVisible();
  await jiraFilter.selectOption({ label: "Ready for Dev (2)" });
  await expect(page.getByRole("link", { name: "Open FAKE-2 in JIRA" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open FAKE-3 in JIRA" })).toHaveCount(0);
  await jiraFilter.selectOption({ label: "All open (3)" });
  await expect(page.getByRole("row").filter({ hasText: "FAKE-3" })).toContainText("In Progress");
  await jiraFilter.selectOption({ label: "In Progress (1)" });
  await expect(page.getByRole("link", { name: "Open FAKE-1 in JIRA" })).toHaveCount(0);
  await jiraFilter.selectOption({ label: "Ready for Dev (2)" });
  await expect(page.getByTestId("discover-incomplete")).toHaveCount(0);
  await page.getByRole("button", { name: "Fetch new tickets" }).click();
  await expect(page.getByTestId("discover-status")).toHaveText("Found 0 new · 3 open in total");

  // Review AC first on, then refine
  await page.getByRole("switch", { name: "Review AC first FAKE-1" }).click();
  await expect(page.getByRole("switch", { name: "Review AC first FAKE-1" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Select FAKE-1" }).check();
  await page.getByRole("button", { name: "Start refining (1)" }).click();
  await expect(page.getByText("Awaiting AC review").first()).toBeVisible();

  // original snapshot tab shows the comment ids
  await page.getByRole("link", { name: "Export orders as CSV" }).click();
  await expectJiraLink(page.getByRole("link", { name: "Open in JIRA" }));
  await page.getByRole("tab", { name: "Original snapshot" }).click();
  await expect(page.getByText("#10001", { exact: true })).toBeVisible();
  await expect(page.getByText("#10002", { exact: true })).toBeVisible();
  // an attachment read without its bytes links to the ticket in JIRA, where the developer is signed in
  await expect(page.getByRole("link", { name: "View spec.pdf in JIRA" })).toHaveAttribute("href", "https://fake-jira.example.com/browse/FAKE-1");
  // read again (read-only): an unchanged ticket gets no new version, and nothing else runs
  const stateBefore = (await (await request.get("http://127.0.0.1:5173/api/tickets/FAKE-1")).json()).ticket.state;
  await page.getByTestId("snapshot-read-again").filter({ visible: true }).click();
  await expect(page.getByTestId("snapshot-read-again").filter({ visible: true })).toHaveText("Read again from JIRA");
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:5173/api/tickets/FAKE-1/snapshots")).json()).length).toBe(1);
  expect((await (await request.get("http://127.0.0.1:5173/api/tickets/FAKE-1")).json()).ticket.state).toBe(stateBefore);

  // edit: drop baseline AC-2, add a developer AC (reason required)
  await page.getByRole("tab", { name: "Requirements & AC" }).click();
  await page.getByRole("button", { name: "Delete AC-2" }).click();
  await page.getByRole("textbox", { name: "Enter acceptance criterion statement…" }).fill("Export respects the active filters.");
  await page.getByRole("combobox", { name: "Source" }).selectOption({ label: "Developer-added (reason required)" });
  await page.getByRole("button", { name: "Add to draft" }).click();
  await expect(page.getByText("Pick a source or give a reason.")).toBeVisible();
  await page.getByRole("textbox", { name: "Mandatory rationale (e.g. confirmed with PM in standup)" }).fill("Confirmed with PM in standup");
  await page.getByRole("button", { name: "Add to draft" }).click();
  await expect(page.getByText("Export respects the active filters.").filter({ visible: true })).toBeVisible();
  await page.getByRole("button", { name: "Save as v2" }).click();

  // drift check: 1 missing baseline item, acknowledgement required
  await page.getByRole("tab", { name: /AC coverage/ }).click();
  await expect(page.getByText("1 missing").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Your decision needed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Acknowledge & continue" })).toBeVisible();

  // F-I4: go back to editing first, then acknowledge from AC review; Confirm unlocks afterwards
  await page.getByRole("button", { name: "Go back and edit ACs" }).click();
  await expect(page.getByText("Awaiting AC review").filter({ visible: true }).first()).toBeVisible();
  const ackButton = page.getByRole("button", { name: "Acknowledge drift" });
  await expect(ackButton).toBeVisible();
  await page.getByRole("tab", { name: "Requirements & AC" }).click();
  await expect(page.getByRole("button", { name: "Confirm requirements" })).toBeDisabled();
  await page.getByRole("link", { name: /Acknowledge in AC coverage/ }).click();
  await ackButton.click();
  await expect(page.getByText("A note is required.")).toBeVisible();
  // the check agent suggests notes, one recommended: a click fills the note, which stays editable
  const noteBox = page.getByRole("textbox", { name: "Decision / rationale note (required)" });
  await page.getByTestId("answer-options").getByRole("button", { name: /Dropped on purpose · Recommended/ }).click();
  await expect(noteBox).toHaveValue("AC-2 was dropped on purpose — the download is out of scope for this ticket.");
  await noteBox.fill("Dropped on purpose, confirmed with PM");
  await ackButton.click();
  await expect(ackButton).toHaveCount(0);
  await page.getByRole("tab", { name: "Requirements & AC" }).click();
  await expect(page.getByRole("button", { name: "Confirm requirements" })).toBeEnabled();
  await page.getByRole("button", { name: "Confirm requirements" }).click();

  // two solutions, pick the second
  await page.getByRole("tab", { name: "Solutions" }).click();
  await expect(page.getByText("Option A").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText("Option B").filter({ visible: true }).first()).toBeVisible();
  // the agent recommends one option, with why; it is pre-selected, and the developer may pick another
  await expect(page.getByTestId("recommendation-reason").filter({ visible: true })).toHaveText("Recommended: Streams any size of export and keeps the filters in one place.");
  await page.getByRole("radio", { name: "Option B", exact: true }).check();
  await page.getByRole("button", { name: "Confirm choice" }).click();
  await expect(page.getByText("Chosen: Client-side CSV")).toBeVisible();
  // P-C12: phase 1 ends at the choice; the ticket is now designing or past it (phase 2 is covered by phase2.spec.ts)
  await expectDesignOrLater(request, "FAKE-1");
  await page.getByRole("tab", { name: "Design & debate" }).click();
  await expect(page.getByTestId("design-doc").filter({ visible: true })).toBeVisible();

  // F-I7: FAKE-2 was read with older comments collapsed: the snapshot is flagged and refine adds an open question
  // a discovered ticket has only its list entry: Read from JIRA saves the snapshot without refining
  await page.goto("/tickets/FAKE-2/snapshot");
  await expect(page.getByText("Not read from JIRA yet: fetching new tickets only lists their key, title and status.")).toBeVisible();
  await page.getByTestId("snapshot-read").click();
  await expect(page.getByTestId("snapshot-incomplete").filter({ visible: true })).toHaveText("Incomplete: 3 older comments were not loaded — check JIRA");
  await expect(page.getByText("[slackoff:")).toHaveCount(0);
  expect((await (await request.get("http://127.0.0.1:5173/api/tickets/FAKE-2")).json()).ticket.state).toBe("discovered");
  // the list's running-agent column is cleared once the read is over (in-app navigation keeps the live state)
  await page.getByRole("link", { name: "All tickets" }).click();
  await expect(page.getByRole("row").filter({ hasText: "FAKE-2" })).not.toContainText("JIRA reader");
  await page.getByRole("checkbox", { name: "Select FAKE-2" }).check();
  await page.getByRole("button", { name: "Start refining (1)" }).click();
  await page.goto("/tickets/FAKE-2/snapshot");
  await page.getByRole("tab", { name: "Requirements & AC" }).click();
  await expect(page.getByText("3 older comments were not loaded — check JIRA").filter({ visible: true }).first()).toBeVisible();

  // skip the design debate (FAKE-2's critic is never satisfied): one design, final at once, no critic run
  await waitState(request, "FAKE-2", ["awaiting_choice"]);
  await page.goto("/tickets/FAKE-2/solutions");
  await page.getByRole("radio", { name: "Option A", exact: true }).check();
  await page.getByTestId("skip-debate").filter({ visible: true }).check();
  await expect(page.getByText("The designer writes the design once, final without critic review").first()).toBeVisible();
  await page.getByRole("button", { name: "Confirm choice" }).click();
  await expect(page.getByText("Design debate skipped")).toBeVisible();
  await expectDesignOrLater(request, "FAKE-2");
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:5173/api/tickets/FAKE-2")).json()).ticket.state, { timeout: 30_000 }).not.toMatch(/^(designing|awaiting_debate_ruling)$/);
  const debate = await (await request.get("http://127.0.0.1:5173/api/tickets/FAKE-2/design")).json();
  expect(JSON.stringify(debate)).not.toContain("\"role\":\"critic\"");

  // the base branch per ticket: the repository's default, or another branch (here one only origin has)
  await page.goto("/tickets/FAKE-3");
  const base = page.getByRole("combobox", { name: "Base of api" });
  await expect(base).toHaveValue("main");
  await expect(base.locator("option")).toContainText(["main (default)", "release/1.0.0"]);
  // the branch: a conventional type (guessed from the title, changeable until the branch exists) + key + title
  await expect(page.getByTestId("branch-name").filter({ visible: true })).toHaveText(/^\/FAKE-3-/);
  await page.getByRole("combobox", { name: "Branch type" }).filter({ visible: true }).selectOption("chore");
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:5173/api/tickets/FAKE-3/branch-type")).json()).name).toMatch(/^chore\/FAKE-3-/);
  await base.selectOption("release/1.0.0");
  await expect.poll(async () => (await (await request.get("http://127.0.0.1:5173/api/tickets/FAKE-3/base-branches")).json()).repos.find((r: { name: string }) => r.name === "api").chosen).toBe("release/1.0.0");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Base of api" })).toHaveValue("release/1.0.0");

  const audit = await (await request.get("http://127.0.0.1:5173/api/audit")).json();
  expect(audit.chain.ok).toBe(true);
});
