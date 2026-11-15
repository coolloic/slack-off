import { expect, test } from "@playwright/test";
import { chooseThroughApi, discoverFour, expectNoHorizontalScroll, post, review, visible, waitState } from "./helpers.ts";

// Phase-4f on a phone (390x844): FAKE-4's acceptance report (command-line entry) — the command blocks sit inside the
// page; they scroll sideways themselves, the page never does. Phases 1–3 go through the API.

const W = 390;
test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

test("phone FAKE-4: the command-and-output evidence fits the 390px page", async ({ page, request }) => {
  await discoverFour(request);
  await chooseThroughApi(request, "FAKE-4", 3);
  await waitState(request, "FAKE-4", ["dev_done"], 120_000);
  await post(request, "/api/tickets/FAKE-4/review/handoff");
  await waitState(request, "FAKE-4", ["awaiting_confirmation"], 240_000);
  expect((await review(request, "FAKE-4")).reports.at(-1)!.verdict).toBe("passed");

  await page.goto("/tickets/FAKE-4/acceptance");
  await expect(page.locator("main").first()).toBeVisible();
  // the first AC card starts expanded: its command block is there
  const block = visible(page.getByTestId("log-evidence")).first();
  await expect(block.getByTestId("log-command")).toHaveText(/^\$ \.\/bin\/tool\.mjs/, { timeout: 15_000 });
  const box = await block.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(W);
  await expectNoHorizontalScroll(page, W);
});

test("phone FAKE-4 (4F-8 I-2): a library case's example code is its own block and fits the 390px page", async ({ page }) => {
  // FAKE-4 is a CLI; the evidence text is replaced by a library case's transcript in the platform's format
  const longLine = `console.log(slugify("${"a very long title with many words ".repeat(8)}"));`;
  const transcript = [
    "$ node examples/slug-long-name-for-a-phone.mjs",
    "--- example examples/slug-long-name-for-a-phone.mjs ---",
    "| import assert from 'node:assert/strict';",
    "| import { slugify } from '@example-org/slug';",
    `| ${longLine}`,
    "--- end of example ---",
    "(no stdin)",
    "--- stdout ---",
    "a-very-long-title-with-many-words",
    "--- stderr ---",
    "exit 0",
    "",
  ].join("\n");
  await page.route("**/api/tickets/FAKE-4/review/evidence/*", (route) => route.fulfill({ status: 200, contentType: "text/plain; charset=utf-8", body: transcript }));
  await page.goto("/tickets/FAKE-4/acceptance");
  const block = visible(page.getByTestId("log-evidence")).first();
  await expect(block.getByTestId("log-command")).toHaveText("$ node examples/slug-long-name-for-a-phone.mjs", { timeout: 15_000 });
  const ex = block.getByTestId("log-example");
  await expect(ex).toContainText("import { slugify } from '@example-org/slug';");
  await expect(block.getByTestId("log-text")).not.toContainText("slugify");
  for (const el of [block, ex]) {
    const box = await el.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(W);
  }
  await expectNoHorizontalScroll(page, W);
});
