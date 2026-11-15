import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chooseThroughApi, development, E2E_HOME, ensureDiscovered, visible, waitState } from "./helpers.ts";

// Phase 4a (Task 8) on a desktop (1440): the fake web repo's pre-commit hook runs in the dev-hook sandbox during
// FAKE-1's development — it writes "<pid> sandboxed" to the ticket's TMPDIR and its probe of Slack Off's port is
// refused (EPERM, decided by the sandbox before any packet), which the step's hook output shows. Settings shows the
// sandbox status card and the two phase-4a switches.

test.describe.configure({ mode: "serial" });

/** what web's fake lint-staged recorded from inside the hook (the ticket's TMPDIR: <home>/cache/<KEY>/tmp) */
const hookMarker = (key: string): string | null => {
  const f = join(E2E_HOME(), "cache", key, "tmp", "slackoff-hook-marker");
  return existsSync(f) ? readFileSync(f, "utf8") : null;
};

test("FAKE-1: web's pre-commit runs sandboxed — marker written, its 4317 probe refused, and the step shows the hook output", async ({ page, request }) => {
  await ensureDiscovered(request);
  await chooseThroughApi(request, "FAKE-1", 0);
  await waitState(request, "FAKE-1", ["dev_done"], 120_000);
  expect(hookMarker("FAKE-1")).toMatch(/^\d+ sandboxed\n$/);
  const dev = await development(request, "FAKE-1");
  const web2 = dev.iterations[0]!.steps[1]!.repos.find((r) => r.repo === "web")!.commit;
  expect(web2.kind).toBe("committed");
  expect(web2.hookOutput).toContain("fake-lint: probe 127.0.0.1:4317 -> EPERM");

  await page.goto("/tickets/FAKE-1/development");
  const web = visible(page.getByTestId("dev-repo-web"));
  const out = web.getByTestId("hook-output");
  await out.locator("summary").click();
  await expect(out).toContainText("fake-lint: probe 127.0.0.1:4317 -> EPERM");
});

test("Settings → Workflow: the sandbox status card and the git-hooks / local-network switches (editable on this computer)", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Workflow", exact: true }).click();
  await expect(visible(page.getByTestId("sandbox-status"))).toContainText("Sandbox: on (macOS sandbox-exec)");
  const hooks = visible(page.getByRole("switch", { name: "Run git hooks without the sandbox" }));
  await expect(hooks).toBeEnabled();
  await expect(hooks).not.toBeChecked();
  await expect(visible(page.getByText("Off (recommended): your pre-commit, commit-msg and pre-push hooks run in a sandbox"))).toBeVisible();
  const net = visible(page.getByLabel("Local network"));
  await expect(net).toBeEnabled();
  await expect(net).toHaveValue("denylist");
  await expect(visible(page.getByTestId("hooks-sandbox-warning"))).toHaveCount(0);
  await hooks.click();
  await expect(visible(page.getByTestId("hooks-sandbox-warning"))).toBeVisible();
});
