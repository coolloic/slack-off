import assert from "node:assert/strict";
import { test } from "node:test";
import type { BudgetProgress, UsageSummary, UsageTotals } from "@slackoff/shared";
import { bannerView, barView, budgetNotice, costView, emptyText, formatMinutes, phoneTicketRows, pauseBar, progressView, resumeErrorText, resumedRetryNote, USAGE_WINDOW_OPTIONS } from "./usage-model.ts";

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  runs: 0, failedRuns: 0, runMinutes: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, estimateUsd: 0, ...over,
});
const budget = (over: Partial<BudgetProgress> = {}): BudgetProgress => ({
  window: "5h", warnAt: 0.8, limits: { runs: 50, runMinutes: null, usd: null }, used: { runs: 42, runMinutes: 0, usd: 0 }, ratio: 0.84, state: "warn", item: "runs", ...over,
});
const summary = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  window: "5h", since: "s", now: "n", executor: "claude-code", totals: totals({ runs: 3, estimateUsd: 1.5, usd: 0.25 }),
  byTicket: [], byRole: [], byDay: [], budget: null, paused: null, ...over,
});

test("subscription: the main number is an 'API-equivalent estimate'; API: 'Cost'", () => {
  const sub = costView(summary());
  assert.equal(sub.label, "API-equivalent estimate");
  assert.equal(sub.value, "$1.50");
  const api = costView(summary({ executor: "claude-api" }));
  assert.equal(api.label, "Cost");
  assert.equal(api.value, "$0.25");
});

test("budgetNotice: warn names the percent and the window; ok and no budget say nothing", () => {
  assert.match(budgetNotice(budget())!, /84%/);
  assert.equal(budgetNotice(budget()), "Usage at 84% of your 5-hour budget.");
  assert.equal(budgetNotice(budget({ window: "day" })), "Usage at 84% of your 24-hour budget.");
  assert.equal(budgetNotice(budget({ state: "ok", ratio: 0.2 })), null);
  assert.equal(budgetNotice(null), null);
});

test("progressView: tone follows the state, the bar never exceeds 100%", () => {
  assert.deepEqual([progressView(budget({ state: "ok", ratio: 0.2 }))!.tone, progressView(budget())!.tone, progressView(budget({ state: "over", ratio: 1.3 }))!.tone], ["ok", "warn", "over"]);
  assert.equal(progressView(budget({ state: "over", ratio: 1.3 }))!.percent, 100);
  assert.equal(progressView(budget())!.percent, 84);
  assert.equal(progressView(budget())!.detail, "42 / 50 runs");
  assert.equal(progressView(null), null);
});

test("barView: heights are relative to the largest day (100%), at most 30 days, oldest first", () => {
  const days = Array.from({ length: 35 }, (_, i) => ({ ...totals({ runs: i === 34 ? 10 : 5 }), day: `2026-10-${String(i + 1).padStart(2, "0")}` }));
  const bars = barView(days);
  assert.equal(bars.length, 30);
  assert.equal(bars.at(-1)!.heightPct, 100);
  assert.equal(bars[0]!.heightPct, 50);
  assert.equal(bars[0]!.day, "2026-10-06");
  assert.deepEqual(barView([]), []);
  // a day with no runs at all stays at zero, not NaN
  assert.equal(barView([{ ...totals(), day: "2026-11-01" }])[0]!.heightPct, 0);
});

test("emptyText: no runs in the window", () => {
  assert.equal(emptyText(summary({ totals: totals() })), "No agent runs in this window");
  assert.equal(emptyText(summary()), null);
});

test("bannerView: paused with 3 tickets waiting links to /cost; warn gives the percent; nothing otherwise", () => {
  const paused = { id: 1, reason: "threshold" as const, detail: "runs reached 50/50 in the last 5h", pausedBy: "system", pausedAt: "t" };
  const v = bannerView({ paused, budgetState: "over", budgetRatio: 1, budgetWindow: "5h", waitingTickets: 3 })!;
  assert.equal(v.kind, "paused");
  assert.equal(v.to, "/cost");
  assert.match(v.text, /Usage paused — runs reached 50\/50 in the last 5h\./);
  assert.match(v.text, /3 tickets waiting/);
  assert.match(bannerView({ paused, budgetState: "over", budgetRatio: 1, budgetWindow: "5h", waitingTickets: 1 })!.text, /1 ticket waiting\./);
  assert.doesNotMatch(bannerView({ paused, budgetState: null, budgetRatio: null, budgetWindow: null, waitingTickets: 0 })!.text, /waiting/);
  const warn = bannerView({ paused: null, budgetState: "warn", budgetRatio: 0.84, budgetWindow: "5h", waitingTickets: 0 })!;
  assert.equal(warn.kind, "warn");
  assert.equal(warn.text, "Usage at 84% of your 5-hour budget.");
  assert.equal(bannerView({ paused: null, budgetState: "ok", budgetRatio: 0.1, budgetWindow: "5h", waitingTickets: 2 }), null);
  assert.equal(bannerView(undefined), null);
});

test("pauseBar: Pause when running, Resume when paused, each with its 'This will' text", () => {
  const a = pauseBar(null);
  assert.equal(a.action, "pause");
  assert.equal(a.label, "Pause new agent runs");
  assert.equal(a.thisWill, "stop new agent runs; running ones finish. Tickets that would start one wait in Blocked until you resume and retry.");
  const b = pauseBar({ id: 1, reason: "manual", detail: "x", pausedBy: "local", pausedAt: "t" });
  assert.equal(b.action, "resume");
  assert.equal(b.label, "Resume");
});

test("resumedRetryNote: a Paused: block after the resume says to retry; nothing while still paused or for other blocks", () => {
  assert.equal(resumedRetryNote("Paused: runs reached 3/3 — resume in Cost & quota, then Retry", false), "Resumed: retry to continue");
  assert.equal(resumedRetryNote("Paused: x", true), null);
  assert.equal(resumedRetryNote("claude CLI not found", false), null);
  assert.equal(resumedRetryNote(null, false), null);
});

test("phoneTicketRows: the table's columns fold into one list item per ticket", () => {
  const rows = phoneTicketRows(
    [
      { ...totals({ runs: 2, estimateUsd: 0.5 }), ticketKey: "A-1", title: "First" },
      { ...totals({ runs: 1 }), ticketKey: null, title: null },
    ],
    "claude-code",
  );
  assert.deepEqual(rows, [
    { key: "A-1", heading: "A-1", title: "First", meta: "2 runs · $0.50" },
    { key: "none", heading: "No ticket", title: "Discovery and trial runs", meta: "1 run · $0.00" },
  ]);
  assert.equal(phoneTicketRows([{ ...totals({ runs: 1, usd: 2 }), ticketKey: "A-2", title: "T" }], "claude-api")[0]!.meta, "1 run · $2.00");
});

test("formatMinutes and the window choices", () => {
  assert.equal(formatMinutes(0.2), "0m");
  assert.equal(formatMinutes(9.4), "9m");
  assert.equal(formatMinutes(134), "2h 14m");
  assert.deepEqual(USAGE_WINDOW_OPTIONS.map((o) => o.label), ["5 h", "Day", "Week", "30 days"]);
});

test("L3: resuming a threshold pause without raising the limit says the limit is still reached", async () => {
  const { stillOverNote } = await import("./usage-model.ts");
  const over = summary({ budget: budget({ state: "over", ratio: 1 }) });
  assert.equal(stillOverNote(over), "The limit is still reached: raise it in Settings, or the next run pauses again.");
  assert.equal(stillOverNote({ ...over, paused: { id: 1, reason: "threshold", detail: "x", pausedBy: "system", pausedAt: "t" } }), null);
  assert.equal(stillOverNote(summary({ budget: budget() })), null);
  assert.equal(stillOverNote(summary()), null);
});

test("4c deferred minor: on a paired phone with the API key, Resume of a threshold pause is not offered — it says to resume on this computer", () => {
  const paused = { id: 1, reason: "threshold" as const, detail: "x", pausedBy: "local", pausedAt: "t" };
  const phoneApi = pauseBar(paused, { local: false, executor: "claude-api" });
  assert.equal(phoneApi.action, "resume");
  assert.equal(phoneApi.disabled, true);
  assert.equal(phoneApi.thisWill, "With the API key (real money), a threshold pause is resumed on the computer running Slack Off. Open Cost & quota there.");
  // pausing is always allowed; the subscription and this computer may resume
  assert.equal(pauseBar(null, { local: false, executor: "claude-api" }).disabled, false);
  assert.equal(pauseBar(paused, { local: false, executor: "claude-code" }).disabled, false);
  assert.equal(pauseBar(paused, { local: true, executor: "claude-api" }).disabled, false);
  assert.equal(pauseBar(paused).disabled, false);
});

test("F4C-1 M-4: on a paired phone with the API key, a manual or usage-limit pause can be resumed; a threshold pause cannot", () => {
  const pause = (reason: "manual" | "limit_reached" | "threshold") => ({ id: 1, reason, detail: "x", pausedBy: "local", pausedAt: "t" });
  for (const reason of ["manual", "limit_reached"] as const) {
    const v = pauseBar(pause(reason), { local: false, executor: "claude-api" });
    assert.equal(v.disabled, false, reason);
    assert.equal(v.thisWill, pauseBar(pause(reason)).thisWill, reason);
  }
  const t = pauseBar(pause("threshold"), { local: false, executor: "claude-api" });
  assert.equal(t.disabled, true);
  assert.equal(t.thisWill, "With the API key (real money), a threshold pause is resumed on the computer running Slack Off. Open Cost & quota there.");
  assert.equal(pauseBar(pause("threshold"), { local: false, executor: "claude-code" }).disabled, false);
  assert.equal(pauseBar(pause("threshold"), { local: true, executor: "claude-api" }).disabled, false);
});

test("4c deferred minor: before the page knows where it runs, a threshold pause under the API key is not resumable yet", () => {
  const paused = { id: 1, reason: "threshold" as const, detail: "x", pausedBy: "local", pausedAt: "t" };
  assert.equal(pauseBar(paused, { local: undefined, executor: "claude-api" }).disabled, true);
  // nothing else waits for it
  assert.equal(pauseBar(paused, { local: undefined, executor: "claude-code" }).disabled, false);
  assert.equal(pauseBar({ ...paused, reason: "manual" }, { local: undefined, executor: "claude-api" }).disabled, false);
});

test("4c deferred minor: the server's 'only on this computer' refusal reads as where to resume, other errors pass through", () => {
  assert.equal(
    resumeErrorText("with the API key, a threshold pause can only be resumed on this computer"),
    "With the API key (real money), a threshold pause is resumed on the computer running Slack Off. Open Cost & quota there.",
  );
  assert.equal(resumeErrorText("network down"), "network down");
  assert.equal(resumeErrorText(undefined), undefined);
});
