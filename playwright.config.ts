import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Fresh scratch dir per run; the server runs in fake mode (canned JIRA + agent output, fake gh and GitHub remotes, no
// network, no Claude). The data dir is <scratch>/home and fake mode puts the acceptance config dir next to it
// (<scratch>/home-acceptance), so nothing outside the scratch dir is used.
// The config is re-evaluated in every Playwright worker, which inherit the env of the process that first loaded it:
// only that main process creates the dir (and removes it on exit, after the webServers have stopped).
let home = process.env.SLACKOFF_E2E_HOME;
if (!home) {
  const created = mkdtempSync(join(tmpdir(), "slackoff-e2e-"));
  home = process.env.SLACKOFF_E2E_HOME = join(created, "home");
  mkdirSync(home);
  process.on("exit", () => rmSync(created, { recursive: true, force: true }));
}

// phase 4c task 6: in the phase-4c runs, FAKE-2's first propose reports the CLI's usage limit (the auto-pause);
// every other project keeps the fake agent unchanged
const usageLimitOnce = process.argv.some((a) => a.includes("phase4c")) ? "FAKE-2" : "";
// phase 4f: only the phase-4f runs map the third fake repo (cli) and discover FAKE-4; every other project is unchanged
const fakeCliRepo = process.argv.some((a) => a.includes("phase4f")) ? "1" : "";

const desktop = { viewport: { width: 1440, height: 900 } };
const phone = { ...devices["Pixel 7"], channel: "chrome", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: "http://127.0.0.1:5173", channel: "chrome", trace: "retain-on-failure" },
  // Every project walks the FAKE tickets through the whole workflow, so each needs a pristine server: `pnpm e2e` runs
  // them as twelve playwright invocations (fresh data dir and servers each). `playwright test --project=<name>` runs one alone.
  projects: [
    { name: "desktop", testMatch: /\/phase1\.spec\.ts$/, use: desktop },
    { name: "mobile", testMatch: /\/mobile\.spec\.ts$/, use: phone },
    // phase 2 (Task 17): design debate, development, JIRA write, snapshot-change ack
    { name: "desktop-phase2", testMatch: /\/phase2\.spec\.ts$/, use: desktop },
    { name: "mobile-phase2", testMatch: /\/mobile-phase2\.spec\.ts$/, use: phone },
    // phase 3 (Task 17): acceptance (a real sandboxed Playwright re-run), review decisions, delivery to fake GitHub
    { name: "desktop-phase3", testMatch: /\/phase3\.spec\.ts$/, use: desktop },
    { name: "mobile-phase3", testMatch: /\/mobile-phase3\.spec\.ts$/, use: phone },
    // phase 4a (Task 8): git hooks in the dev-hook sandbox, the sandbox status in Settings
    { name: "desktop-phase4a", testMatch: /\/phase4a\.spec\.ts$/, use: desktop },
    { name: "mobile-phase4a", testMatch: /\/mobile-phase4a\.spec\.ts$/, use: phone },
    // phase 4b (Task 8): the JIRA API mode and the API key through Settings (fake REST), credentials never echoed, 390px
    { name: "desktop-phase4b", testMatch: /\/phase4b\.spec\.ts$/, use: desktop },
    { name: "mobile-phase4b", testMatch: /\/mobile-phase4b\.spec\.ts$/, use: phone },
    // phase 4c (tasks 3, 7): Cost & quota, the usage banner and the pause, the Budget settings; 390px
    { name: "desktop-phase4c", testMatch: /\/phase4c\.spec\.ts$/, use: desktop },
    { name: "mobile-phase4c", testMatch: /\/mobile-phase4c\.spec\.ts$/, use: phone },
    // phase 4d (task 6): preferences (summary, hint, edit, clear), a prompt draft tried on the sample ticket, restore default; 390px
    { name: "desktop-phase4d", testMatch: /\/phase4d\.spec\.ts$/, use: desktop },
    { name: "mobile-phase4d", testMatch: /\/mobile-phase4d\.spec\.ts$/, use: phone },
    // phase 4f (task 6): a command-line entry — declared cases, the platform's re-run, a fix round, command blocks at 390px
    { name: "desktop-phase4f", testMatch: /\/phase4f\.spec\.ts$/, use: desktop },
    { name: "mobile-phase4f", testMatch: /\/mobile-phase4f\.spec\.ts$/, use: phone },
    // README screenshots (desktop and 390x844 from the same data); not in `pnpm e2e`, run with `pnpm screenshots`
    { name: "screenshots", testMatch: /\/screenshots\.spec\.ts$/, use: desktop },
  ],
  webServer: [
    {
      command: "node --disable-sigusr1 packages/server/src/main.ts",
      url: "http://127.0.0.1:4317/api/audit",
      env: { SLACKOFF_FAKE_EXECUTOR: "1", SLACKOFF_HOME: home, SLACKOFF_FAKE_USAGE_LIMIT_ONCE: usageLimitOnce, SLACKOFF_FAKE_CLI_REPO: fakeCliRepo },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    { command: "node node_modules/vite/bin/vite.js", cwd: "packages/web", url: "http://127.0.0.1:5173", reuseExistingServer: false, timeout: 60_000 },
  ],
});
