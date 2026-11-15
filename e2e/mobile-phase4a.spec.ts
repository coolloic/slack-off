import { expect, test, type Page } from "@playwright/test";
import { chooseThroughApi, development, ensureDiscovered, expectNoHorizontalScroll, visible, waitState } from "./helpers.ts";

// Phase 4a (Task 8) on a phone (390x844): the sandboxed hook's output in FAKE-1's development tab, and Settings on a
// paired phone — the sandbox status card shown, the git-hooks switch and the local-network mode read-only. No visited
// page scrolls horizontally.

const W = 390;
test.describe.configure({ mode: "serial" });

async function visit(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("main").first()).toBeVisible();
}

test("phone FAKE-1: web's sandboxed hook output (4317 refused) in the development tab", async ({ page, request }) => {
  await ensureDiscovered(request);
  await chooseThroughApi(request, "FAKE-1", 0);
  await waitState(request, "FAKE-1", ["dev_done"], 120_000);
  const dev = await development(request, "FAKE-1");
  expect(dev.iterations[0]!.steps[1]!.repos.find((r) => r.repo === "web")!.commit.hookOutput).toContain("-> EPERM");

  await visit(page, "/tickets/FAKE-1/development");
  const tabs = page.getByRole("tablist", { name: "Repositories" });
  await tabs.getByRole("tab", { name: /^web/ }).click();
  const out = visible(page.getByTestId("dev-repo-web")).getByTestId("hook-output");
  await out.locator("summary").click();
  await expect(out).toContainText("fake-lint: probe 127.0.0.1:4317 -> EPERM");
  const box = await out.locator("summary").boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalScroll(page, W);
});

test("paired phone Settings: the sandbox card is shown; 'Run git hooks without the sandbox' and the local-network mode are read-only", async ({ page }) => {
  await page.route("**/api/status", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), local: false } });
  });
  await visit(page, "/settings");
  await expect(visible(page.getByTestId("sandbox-status"))).toContainText("Sandbox: on (macOS sandbox-exec)");
  await expect(page.getByRole("switch", { name: "Run git hooks without the sandbox" }).filter({ visible: true })).toBeDisabled();
  await expect(page.getByLabel("Local network").filter({ visible: true })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Run repository commands without the sandbox" }).filter({ visible: true })).toBeDisabled();
  await expectNoHorizontalScroll(page, W);
});
