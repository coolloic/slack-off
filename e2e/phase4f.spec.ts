import { expect, test } from "@playwright/test";
import { chooseThroughApi, development, discoverFour, review, visible, waitState } from "./helpers.ts";

// Phase-4f flow on desktop (1440) against the fake-mode server with the third fake repo `cli` (SLACKOFF_FAKE_CLI_REPO,
// set by playwright.config.ts for the phase-4f projects only). FAKE-4 takes option 4 (cli only: a command-line entry).
// The acceptance agent is fake (dev/fake-acceptance.ts) and declares one case per AC; the platform re-runs every case
// for real in a fresh run root, each in its own acceptance sandbox. Fake switch: FAKE-4's first acceptance leaves out
// AC-2's input file, so the platform's re-run fails it → a fix iteration → attempt 2 passes.

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test("FAKE-4 (CLI): hand off -> AC-2 fails in the platform's re-run -> fix iteration -> passes on attempt 2; the evidence is the command and its output", async ({ page, request }) => {
  await discoverFour(request);
  await chooseThroughApi(request, "FAKE-4", 3); // cli only
  await waitState(request, "FAKE-4", ["dev_done"], 120_000);

  await page.goto("/tickets/FAKE-4/development");
  const handOff = visible(page.getByRole("button", { name: "Hand off to acceptance" }));
  await expect(handOff).toBeEnabled();
  await handOff.click();

  await waitState(request, "FAKE-4", ["awaiting_confirmation"], 240_000);
  expect((await development(request, "FAKE-4")).iterations.map((i) => i.trigger)).toEqual(["initial", "review_failed"]);
  expect((await review(request, "FAKE-4")).reports.map((r) => [r.attempt, r.verdict])).toEqual([[1, "failed"], [2, "passed"]]);

  await page.goto("/tickets/FAKE-4/acceptance");
  await expect(visible(page.getByTestId("verdict-banner"))).toContainText("Passed · attempt 2 of 3");
  const blocks = visible(page.getByTestId("log-evidence"));
  await expect(blocks.first().getByTestId("log-command")).toHaveText(/^\$ \.\/bin\/tool\.mjs/, { timeout: 15_000 });
  // AC-2's transcript: the platform's own run of `list` with the case's input file
  const ac2 = blocks.filter({ hasText: "AC-2: the command and its output" }).first();
  await expect(ac2.getByTestId("log-command")).toHaveText("$ ./bin/tool.mjs list");
  await expect(ac2.getByTestId("log-text")).toContainText("1. milk");
  await expect(ac2.getByTestId("log-text")).toContainText("exit 0");
});
