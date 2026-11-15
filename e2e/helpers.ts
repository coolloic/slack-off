// Shared by the phase-2 and phase-3 specs: drive the earlier phases through the API (fast), wait on ticket states, check layout.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

/** The server itself (loopback, so it is "this computer"); the UI goes through Vite at 5173. */
export const API = "http://127.0.0.1:4317";

export async function post(request: APIRequestContext, path: string, data?: unknown): Promise<unknown> {
  const res = await request.post(`${API}${path}`, data === undefined ? {} : { data });
  expect(res.ok(), `POST ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json();
}

export async function get<T = any>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`${API}${path}`);
  expect(res.ok(), `GET ${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as T;
}

export async function stateOf(request: APIRequestContext, key: string): Promise<string> {
  return (await get<{ ticket: { state: string } }>(request, `/api/tickets/${key}`)).ticket.state;
}

/** Waits until the ticket is in one of `states` (fails fast on blocked, with its reason). */
export async function waitState(request: APIRequestContext, key: string, states: string[], timeout = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const { ticket } = await get<{ ticket: { state: string; blockedReason: string | null } }>(request, `/api/tickets/${key}`);
        if (ticket.state === "blocked" && !states.includes("blocked")) return `blocked: ${ticket.blockedReason}`;
        return states.includes(ticket.state) ? "ok" : ticket.state;
      },
      { timeout, message: `${key} reaches ${states.join(" | ")}` },
    )
    .toBe("ok");
}

/** Fetch the fake JIRA tickets (FAKE-1..3) through the API. */
export async function discover(request: APIRequestContext): Promise<void> {
  await post(request, "/api/discover");
  await expect.poll(async () => (await get<Array<{ key: string }>>(request, "/api/tickets")).length, { timeout: 15_000 }).toBe(3);
}

/** Idempotent: fetch the fake JIRA tickets only when they are not there yet (a test that needs them says so). */
export async function ensureDiscovered(request: APIRequestContext): Promise<void> {
  if ((await get<Array<{ key: string }>>(request, "/api/tickets")).length >= 3) return;
  await discover(request);
}

/** Phase 1 through the API: refine (Review AC first is off) until the solutions wait for the developer. */
export async function refineToChoice(request: APIRequestContext, key: string): Promise<void> {
  await post(request, `/api/tickets/${key}/refine`);
  await waitState(request, key, ["awaiting_choice"]);
}

export async function solutionIds(request: APIRequestContext, key: string): Promise<number[]> {
  return (await get<{ solutions: Array<{ id: number }> }>(request, `/api/tickets/${key}`)).solutions.map((s) => s.id);
}

/** Desktop and phone markup coexist in the DOM (one of them display:none): only the visible ones count. */
export const visible = (l: Locator): Locator => l.filter({ visible: true });

export async function expectNoHorizontalScroll(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
}

/** Idempotent: JIRA status sync on (Settings → JIRA), whatever it was. */
export async function enableJiraSync(request: APIRequestContext): Promise<void> {
  const config = await get<{ jira: Record<string, unknown> }>(request, "/api/config");
  const res = await request.put(`${API}/api/config`, { data: { ...config, jira: { ...config.jira, syncStatus: true } } });
  expect(res.ok(), await res.text()).toBe(true);
}

export interface DevView {
  ticketDir: string;
  repos: Array<{ name: string; status: string; commits: Array<{ sha: string; subject: string }> }>;
  iterations: Array<{ trigger: string; status: string; steps: Array<{ step: number; repos: Array<{ repo: string; violations: string[]; commit: { kind: string; outputTail?: string; hookOutput?: string } }> }> }>;
  jiraWrites: Array<{ id: number; state: string; targetStatus: string; detail: string | null }>;
}

export const development = (request: APIRequestContext, key: string) => get<DevView>(request, `/api/tickets/${key}/development`);

/** Phase 1 ends at the choice (P-C12): afterwards the ticket is designing or in a later phase-2 state. */
export async function expectDesignOrLater(request: APIRequestContext, key: string): Promise<void> {
  await waitState(request, key, ["designing", "awaiting_debate_ruling", "design_final", "checking_snapshot", "awaiting_snapshot_ack", "developing", "dev_done"]);
}

// ---- phase 3 (Task 17)

/** The e2e data dir (playwright.config.ts): the fake GitHub (fake-github/prs.json) and bare remotes (fake-remotes/) live there. */
export const E2E_HOME = (): string => {
  const h = process.env.SLACKOFF_E2E_HOME;
  if (!h) throw new Error("SLACKOFF_E2E_HOME is not set (run through playwright.config.ts)");
  return h;
};

export interface FakePr { repo: string; number: number; url: string; head: string; base: string; title: string; body: string; open: boolean }

/** The pull requests the fake gh holds. */
export function fakePrs(): FakePr[] {
  const file = join(E2E_HOME(), "fake-github", "prs.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as FakePr[]) : [];
}

/** The branches of a fake remote (`${home}/fake-remotes/<repo>.git`). */
export function remoteBranches(repo: string): string[] {
  const out = execFileSync("git", ["--git-dir", join(E2E_HOME(), "fake-remotes", `${repo}.git`), "for-each-ref", "--format=%(refname:short)", "refs/heads/"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

/** Phase 1 + the choice through the API: refine, then choose the solution at `index` with its proposed repos. */
export async function chooseThroughApi(request: APIRequestContext, key: string, index: number): Promise<void> {
  await refineToChoice(request, key);
  const ids = await solutionIds(request, key);
  await post(request, `/api/tickets/${key}/choose`, { solutionId: ids[index] });
}

/** A debate that escalated: rule every open disagreement for the critic. */
export async function ruleForCritic(request: APIRequestContext, key: string, commentIds: string[]): Promise<void> {
  await post(request, `/api/tickets/${key}/debate/rulings`, { rulings: commentIds.map((commentId) => ({ commentId, decision: "critic", note: "" })) });
}

export interface ReviewView {
  reports: Array<{ id: number; attempt: number; verdict: string; seriesId: number }>;
  current: { verdict: string; attempt: number } | null;
}
export const review = (request: APIRequestContext, key: string) => get<ReviewView>(request, `/api/tickets/${key}/review`);

export interface PreviewView { actions: Array<{ seq: number; text: string }>; warnings: string[]; blockers: string[]; jiraNote: string | null }
export const deliveryPreview = (request: APIRequestContext, key: string) => get<PreviewView>(request, `/api/tickets/${key}/delivery/preview`);

/** The four fake tickets (FAKE-4 exists only in the phase-4f runs). */
export async function discoverFour(request: APIRequestContext): Promise<void> {
  if ((await get<Array<{ key: string }>>(request, "/api/tickets")).length >= 4) return;
  await post(request, "/api/discover");
  await expect.poll(async () => (await get<Array<{ key: string }>>(request, "/api/tickets")).length, { timeout: 15_000 }).toBe(4);
}
