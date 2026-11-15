import { readdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { development, enableJiraSync, ensureDiscovered, get, refineToChoice, solutionIds, stateOf, visible, waitState } from "./helpers.ts";

// Phase-2 flow on desktop (1440) against the fake-mode server. Phase 1 (fetch, refine) goes through the API; every
// phase-2 decision goes through the UI. Fake switches (dev/fake-mode.ts): FAKE-1's critic blocks once; FAKE-2's critic
// never stops blocking and its first JIRA write fails; FAKE-3 changes in JIRA after the design.

// One server for the whole file: the tests share its tickets and settings. Serial, and each test states what it needs
// (ensureDiscovered / enableJiraSync are idempotent) so the order dependence is explicit.
test.describe.configure({ mode: "serial" });

async function openTab(page: Page, key: string, tab: string) {
  await page.goto(`/tickets/${key}/${tab}`);
}

test("FAKE-1: solutions with repos -> debate -> per-repo development to dev_done", async ({ page, request }) => {
  await ensureDiscovered(request);
  await refineToChoice(request, "FAKE-1");

  // Solutions: each option names its repositories; option A (api + web) is chosen as proposed
  await openTab(page, "FAKE-1", "solutions");
  const repos = visible(page.getByTestId("solution-repos"));
  await expect(repos.nth(0)).toContainText("api");
  await expect(repos.nth(0)).toContainText("web");
  await expect(repos.nth(1)).not.toContainText("api");
  await page.getByRole("radio", { name: "Option A", exact: true }).check();
  const picker = visible(page.getByTestId("repo-picker"));
  await expect(picker.getByRole("checkbox", { name: /^api/ })).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: /^web/ })).toBeChecked();
  await expect(picker.getByText("edited from the proposal")).toHaveCount(0);
  await visible(page.getByRole("button", { name: "Confirm choice" })).click();

  // Design & debate: round 1 had a blocking comment, round 2 none; every checklist item answered (22 + 3 cross-repo)
  await waitState(request, "FAKE-1", ["checking_snapshot", "developing", "dev_done"]);
  await openTab(page, "FAKE-1", "design");
  const debate = visible(page.getByTestId("design-debate"));
  await expect(debate.getByText("Round 1", { exact: true })).toBeVisible();
  await expect(debate.getByText("1 blocking")).toBeVisible();
  await expect(debate.getByText("Round 2", { exact: true })).toBeVisible();
  await expect(debate.getByText("no blocking comments")).toBeVisible();
  await expect(visible(page.getByTestId("design-checklist"))).toContainText("25 items · 0 disputed · 0 missing");

  // Development: one group per repository
  await waitState(request, "FAKE-1", ["dev_done"]);
  await openTab(page, "FAKE-1", "development");
  const api = visible(page.getByTestId("dev-repo-api"));
  const web = visible(page.getByTestId("dev-repo-web"));
  await expect(api.getByText(/^FAKE-1: /).first()).toBeVisible();
  await expect(api.getByText("infra/main.tf")).toBeVisible();
  await expect(api.getByText("was reverted — it is a forbidden path")).toBeVisible();
  await expect(web.getByText(/^FAKE-1: /).first()).toBeVisible();
  await expect(api.getByTestId("repo-status")).toHaveText("Passing");
  await expect(web.getByTestId("repo-status")).toHaveText("Passing");
  // web's pre-commit hook refused step 1 (TODO found); step 2 committed. The tab shows the latest step, so step 1's
  // hook failure is checked on the server's record.
  const dev = await development(request, "FAKE-1");
  const step1Web = dev.iterations[0]!.steps[0]!.repos.find((r) => r.repo === "web")!;
  expect(step1Web.commit.kind).toBe("hook_failed");
  expect(step1Web.commit.outputTail).toContain("TODO found");
  expect(dev.iterations[0]!.steps[1]!.repos.find((r) => r.repo === "web")!.commit.kind).toBe("committed");
  await expect(visible(page.getByRole("button", { name: "Hand off to acceptance" }))).toBeEnabled();
});

test("JIRA sync on: FAKE-2 with an edited repo set -> ruling with a custom decision -> development + JIRA write (fail, try again, done)", async ({ page, request }) => {
  await ensureDiscovered(request);
  // Settings on this computer: JIRA status sync on (off by default)
  await page.goto("/settings");
  await page.getByRole("button", { name: "JIRA", exact: true }).click();
  const sync = page.getByRole("switch", { name: "Set tickets to In Progress in JIRA" });
  await expect(sync).not.toBeChecked();
  await sync.click();
  await visible(page.getByRole("button", { name: "Save settings" })).first().click();
  await expect(visible(page.getByText("Saved.", { exact: true })).first()).toBeVisible();

  await refineToChoice(request, "FAKE-2");
  await openTab(page, "FAKE-2", "solutions");
  // option A proposes api + web; keep only web
  await page.getByRole("radio", { name: "Option A", exact: true }).check();
  const picker = visible(page.getByTestId("repo-picker"));
  await picker.getByRole("checkbox", { name: /^api/ }).uncheck();
  await expect(picker.getByText("edited from the proposal")).toBeVisible();
  await expect(visible(page.getByText(/start the design for web \(edited from the proposal\)/)).first()).toBeVisible();
  await visible(page.getByRole("button", { name: "Confirm choice" })).click();

  // the critic keeps blocking: after 3 rounds the debate escalates to the developer
  await waitState(request, "FAKE-2", ["awaiting_debate_ruling"]);
  await openTab(page, "FAKE-2", "design");
  await expect(visible(page.getByText("Debate escalated to you"))).toBeVisible();
  const finalize = visible(page.getByRole("button", { name: "Finalize design" }));
  // a neutral read of both sides recommends a ruling per disagreement, pre-selected; the developer may change any
  await expect(page.getByTestId("ruling-recommended-C-1")).toBeVisible();
  await expect(page.getByTestId("ruling-C-1").getByRole("radio", { name: /^Accept critic/ })).toBeChecked();
  await expect(page.getByTestId("ruling-C-2").getByRole("radio", { name: /^Accept designer/ })).toBeChecked();
  await expect(finalize).toBeEnabled();
  await page.getByTestId("ruling-C-2").getByRole("radio", { name: /^My own decision/ }).check();
  await expect(finalize).toBeDisabled(); // a custom ruling needs its text
  await page.getByTestId("ruling-C-2").getByRole("textbox").fill("Keep archived orders readable by support and finance.");
  await expect(finalize).toBeEnabled();
  await expect(visible(page.getByText(/Ask the designer agent to apply your rulings, then finalize/)).first()).toBeVisible();
  await finalize.click();

  // rulings applied -> final -> development; the JIRA write waits for the developer meanwhile
  await waitState(request, "FAKE-2", ["developing", "dev_done"]);
  await openTab(page, "FAKE-2", "design");
  await expect(visible(page.getByText(/Your ruling: own decision — Keep archived orders readable/)).first()).toBeVisible();
  // F2-I2: the Tickets list flags the pending write and counts it under Needs me and in the header badge
  await page.goto("/");
  const row2 = page.locator("tr", { hasText: "FAKE-2" });
  await expect(row2.getByTestId("jira-write-pending")).toHaveText("JIRA write pending");
  await page.goto("/?needs=1");
  await expect(page.locator("tr", { hasText: "FAKE-2" })).toBeVisible();
  await openTab(page, "FAKE-2", "development");
  await expect(visible(page.getByText("Set FAKE-2 to In Progress in JIRA"))).toBeVisible();
  // the target status is shown before anything is sent
  await expect(visible(page.getByTestId("jira-target"))).toContainText("In Progress");
  await expect(visible(page.getByText(/open FAKE-2 in your Chrome and change only its status to In Progress/)).first()).toBeVisible();
  await visible(page.getByRole("button", { name: "Send to JIRA" })).click();

  // the fake JIRA refuses the first write: failed, nothing about the ticket changes; Try again asks again
  const jira = visible(page.getByTestId("jira-card"));
  await expect(jira.getByText("FAILED", { exact: true })).toBeVisible();
  await expect(jira).toContainText("The status menu did not open");
  const before = (await development(request, "FAKE-2")).jiraWrites.length;
  await jira.getByRole("button", { name: "Try again" }).click();
  await expect(visible(page.getByText("Set FAKE-2 to In Progress in JIRA"))).toBeVisible();
  const writes = (await development(request, "FAKE-2")).jiraWrites;
  expect(writes.length).toBe(before + 1);
  expect(writes.map((w) => w.state).sort()).toEqual(["failed", "pending"]);
  await visible(page.getByRole("button", { name: "Send to JIRA" })).click();
  await expect(jira.getByText("FAKE-2 set to In Progress in JIRA.")).toBeVisible();

  // development of web only, unaffected by the JIRA write
  await waitState(request, "FAKE-2", ["dev_done"]);
  await page.reload();
  const web = visible(page.getByTestId("dev-repo-web"));
  await expect(web.getByText(/^FAKE-2: /).first()).toBeVisible();
  await expect(web.getByTestId("repo-status")).toHaveText("Passing");
  await expect(visible(page.getByTestId("dev-repo-api"))).toHaveCount(0);
  const dev = await development(request, "FAKE-2");
  expect(dev.repos.map((r) => r.name)).toEqual(["web"]);
  // P-C20: the ticket folder holds only the affected repo's worktree
  expect(readdirSync(dev.ticketDir).filter((n) => !n.startsWith("."))).toEqual(["web"]);
  const t2 = await get<{ ticket: { jiraStatus: string } }>(request, "/api/tickets/FAKE-2");
  expect(t2.ticket.jiraStatus).toBe("In Progress");
  // F2-I2: now In Progress in JIRA, the ticket the platform worked on stays on the default list
  await page.goto("/");
  await expect(page.locator("tr", { hasText: "FAKE-2" })).toBeVisible();
  await expect(page.locator("tr", { hasText: "FAKE-2" }).getByTestId("jira-write-pending")).toHaveCount(0);
});

test("FAKE-3 changed in JIRA after the design: acknowledge the change (note required) -> development", async ({ page, request }) => {
  await ensureDiscovered(request);
  await enableJiraSync(request);
  await refineToChoice(request, "FAKE-3");
  const [, optionB] = await solutionIds(request, "FAKE-3");
  const res = await request.post("http://127.0.0.1:4317/api/tickets/FAKE-3/choose", { data: { solutionId: optionB } });
  expect(res.ok()).toBe(true);
  await waitState(request, "FAKE-3", ["awaiting_snapshot_ack"]);

  await openTab(page, "FAKE-3", "development");
  await expect(visible(page.getByText(/The JIRA ticket changed after the design/))).toBeVisible();
  await visible(page.getByRole("link", { name: "Open AC coverage" })).click();
  await expect(visible(page.getByText("Decision needed: the JIRA ticket changed before development")).first()).toBeVisible();
  const ack = visible(page.getByRole("button", { name: "Acknowledge & start development" }));
  await ack.click();
  await expect(visible(page.getByText("A note is required.")).first()).toBeVisible();
  await visible(page.getByRole("textbox", { name: "Decision / rationale note (required)" })).fill("Saved searches are out of scope, agreed with PM");
  await ack.click();
  await waitState(request, "FAKE-3", ["developing", "dev_done"]);
  expect(await stateOf(request, "FAKE-3")).not.toBe("awaiting_snapshot_ack");
  // F2-I2: FAKE-3 is In Progress in JIRA, not Ready for Dev — in development it stays in the default list
  await page.goto("/");
  await expect(page.locator("tr", { hasText: "FAKE-3" })).toBeVisible();
  await waitState(request, "FAKE-3", ["dev_done"]);

  // FAKE-3 already is In Progress in JIRA: nothing to send
  await openTab(page, "FAKE-3", "development");
  await expect(visible(page.getByTestId("jira-card"))).toContainText("Already In Progress in JIRA — nothing was changed.");

  const audit = await get<{ chain: { ok: boolean } }>(request, "/api/audit");
  expect(audit.chain.ok).toBe(true);
});
