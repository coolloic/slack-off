import type { AcceptanceReport, AcVerdict, ReviewReportRecord, ReviewSeriesRecord, ReviewStep, TicketState } from "@slackoff/shared";
import { t } from "../i18n/en.ts";
import type { AnswerOption } from "./answer-options.ts";

export interface VerdictBanner {
  tone: "done" | "blocked" | "decision" | "muted";
  title: string;
  detail: string | null;
}

/** The report's headline. `not_executed` is never shown as a pass (spec §11 risk 5): amber, with the reason. */
export function verdictBanner(r: ReviewReportRecord | null, maxAttempts: number): VerdictBanner {
  if (!r) return { tone: "muted", title: t("acc.noReport"), detail: null };
  const vars = { n: r.attempt, max: maxAttempts };
  if (r.verdict === "passed") return { tone: "done", title: t("acc.passed", vars), detail: null };
  if (r.verdict === "failed") return { tone: "blocked", title: t("acc.failed", vars), detail: null };
  return { tone: "decision", title: t("acc.notExecuted"), detail: r.report.notExecutedReason ?? t("acc.notExecutedNoReason") };
}

export interface EvidenceItem {
  id: number;
  refKey: string;
  acId: string;
  kind: string;
  caption: string;
}

export interface AcCard {
  acId: string;
  text: string;
  verdict: AcVerdict;
  flows: { kind: string; title: string; steps: string[]; expected: string; actual: string; ok: boolean }[];
  shots: { id: number; caption: string }[];
  logs: { id: number; caption: string }[];
  /** phase 4f: `log` evidence (a case's command and output), shown inline as a command block */
  commands: { id: number; caption: string }[];
  mismatch: string | null;
}

/** One card (or table row) per AC. A platform/agent mismatch is a failure whatever the stored verdict says. */
export function acCards(r: AcceptanceReport, evidence: readonly EvidenceItem[]): AcCard[] {
  return r.acs.map((a) => {
    const own = evidence.filter((e) => e.acId === a.acId);
    const mismatch = a.mismatch && a.mismatch.trim() !== "" ? a.mismatch : null;
    return {
      acId: a.acId,
      text: a.text,
      verdict: mismatch ? "fail" : a.verdict,
      flows: a.flows.map((f) => ({ kind: f.kind, title: f.title, steps: f.steps, expected: f.expected, actual: f.actual, ok: f.testsPassed })),
      shots: own.filter((e) => e.kind === "screenshot").map((e) => ({ id: e.id, caption: e.caption })),
      logs: own.filter((e) => e.kind !== "screenshot").map((e) => ({ id: e.id, caption: e.caption })),
      commands: own.filter((e) => e.kind === "log").map((e) => ({ id: e.id, caption: e.caption })),
      mismatch,
    };
  });
}

export interface TimelineReport {
  id: number;
  seriesId: number;
  attempt: number;
  verdict: ReviewReportRecord["verdict"];
  decision: string | null;
  /** the failed AC ids (the /review list carries them) */
  failedAcs?: string[];
  /** or the full report, when one was loaded */
  report?: AcceptanceReport;
}

export interface TimelineGroup {
  seriesId: number;
  startedBy: ReviewSeriesRecord["startedBy"];
  items: { attempt: number; verdict: ReviewReportRecord["verdict"]; failedAcs: string[]; decision: string | null }[];
}

export function attemptTimeline(series: readonly ReviewSeriesRecord[], reports: readonly TimelineReport[]): TimelineGroup[] {
  return series.map((s) => ({
    seriesId: s.id,
    startedBy: s.startedBy,
    items: reports
      .filter((r) => r.seriesId === s.id)
      .sort((a, b) => a.attempt - b.attempt)
      .map((r) => ({
        attempt: r.attempt,
        verdict: r.verdict,
        failedAcs: r.failedAcs ?? (r.report ? r.report.acs.filter((a) => a.verdict === "fail").map((a) => a.acId) : []),
        decision: r.decision,
      })),
  }));
}

export interface ReviewActions {
  confirm: boolean;
  reject: boolean;
  reReview: { enabled: boolean; reason: string | null };
}

/** Which decisions the developer can make now. The server re-checks every one of them. */
export function reviewActions(state: TicketState, step: ReviewStep | null, maxAttempts: number, attemptsInSeries: number): ReviewActions {
  const waiting = state === "awaiting_confirmation" && (step === null || step.kind === "await_decision");
  if (!waiting) return { confirm: false, reject: false, reReview: { enabled: false, reason: null } };
  const capped = attemptsInSeries >= maxAttempts;
  return {
    confirm: true,
    reject: true,
    reReview: capped ? { enabled: false, reason: t("acc.reReviewCap", { n: attemptsInSeries, max: maxAttempts }) } : { enabled: true, reason: null },
  };
}

// ---------------------------------------------------------------- phase 4f (Task 5): command and output evidence

/** Lines shown before "Show all". */
export const LOG_FOLDED_LINES = 20;

export interface LogModel {
  kind: "log";
  /** the command line (`$ …`) of a case transcript; null for other text */
  title: string | null;
  /** 4F-8 (I-2): a library case's example code (right after the command line), shown as its own block; null otherwise */
  example: { name: string; lines: string[]; cut: boolean } | null;
  /** every other line, as plain text (rendered as text, never HTML or Markdown) */
  lines: string[];
  /** the platform kept only the last 64 KB of an output */
  truncated: boolean;
  /** more than LOG_FOLDED_LINES lines: starts folded */
  folded: boolean;
}

/** A log evidence file (a case transcript: "$ <command>", stdin, files, stdout, stderr, exit) as a display model. */
export function logModel(text: string): LogModel {
  const all = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const title = all[0]?.startsWith("$ ") ? all[0] : null;
  let lines = title === null ? all : all.slice(1);
  // 4F-8 (I-2): "--- example examples/<x> ---", "| <code line>"…, "--- end of example ---" right after the command line
  let example: LogModel["example"] = null;
  const head = title !== null ? /^--- example (examples\/\S+)( \(first \d+ KB\))? ---$/.exec(lines[0] ?? "") : null;
  if (head) {
    const end = lines.indexOf("--- end of example ---");
    const body = end > 0 ? lines.slice(1, end) : [];
    if (end > 0 && body.every((l) => l.startsWith("| "))) {
      example = { name: head[1]!, lines: body.map((l) => l.slice(2)), cut: head[2] !== undefined };
      lines = lines.slice(end + 1);
    }
  }
  return { kind: "log", title, example, lines, truncated: /^--- (stdout|stderr) \(last 64 KB\) ---$/m.test(text), folded: lines.length > LOG_FOLDED_LINES };
}

/** The lines to show: all of them when expanded (or short), else the first LOG_FOLDED_LINES. */
export function visibleLines(m: LogModel, expanded: boolean): string[] {
  return expanded || !m.folded ? m.lines : m.lines.slice(0, LOG_FOLDED_LINES);
}

/** 4F-8 (I-3): the project's own test command of a run (`report.projectE2e`) — extra evidence only, never an AC verdict. */
export function projectTests(runs: AcceptanceReport["projectE2e"]): { command: string; ok: boolean; status: string; tail: string }[] {
  return runs.map((r) => ({
    command: r.command,
    ok: !r.timedOut && r.exitCode === 0,
    status: r.timedOut ? t("acc.projectTimedOut") : r.exitCode === 0 ? t("acc.projectPassed") : t("acc.projectFailed", { code: r.exitCode ?? "—" }),
    tail: r.outputTail,
  }));
}

/**
 * Slack Off's recommendation for the acceptance decision (memory: decisions with options), from the report alone:
 * passed and agreed → confirm; any failed AC (or a platform/agent mismatch) → reject, naming them; E2E not run →
 * confirm only after the developer's own check. `options` are notes for rejecting or re-running, one recommended.
 */
export function reviewRecommendation(r: ReviewReportRecord | null): { action: "confirm" | "reject"; reason: string; options: AnswerOption[] } | null {
  if (!r) return null;
  const failed = r.report.acs.filter((a) => a.verdict === "fail" || (a.mismatch !== null && a.mismatch.trim() !== "")).map((a) => a.acId);
  if (r.verdict === "failed" || failed.length > 0) {
    const ids = failed.length > 0 ? failed.join(", ") : t("acc.someAcs");
    return {
      action: "reject",
      reason: t("acc.recReject", { ids }),
      options: [
        { label: t("acc.optFix"), text: t("acc.optFixText", { ids, n: Math.max(failed.length, 1) }), recommended: true },
        { label: t("acc.optRerun"), text: t("acc.optRerunText"), recommended: false },
      ],
    };
  }
  if (r.verdict === "not_executed") {
    return { action: "confirm", reason: t("acc.recNotExecuted", { why: r.report.notExecutedReason ?? t("acc.notExecutedNoReason") }), options: [] };
  }
  return { action: "confirm", reason: t("acc.recConfirm"), options: [] };
}
