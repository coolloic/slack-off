import type { CommitOutcome, IterationRecord, JiraWriteRecord, RepoStatus, StepRecord, StepRepoResult, TestRun } from "@slackoff/shared";
import { t } from "../i18n/en.ts";
import type { Config, DevelopmentResponse } from "./api.ts";
import { jiraText, type JiraMode } from "./jira-mode.ts";

type Iteration = IterationRecord & { steps: StepRecord[] };

/** Every recorded result of `repo`, oldest first, across all iterations. */
function resultsOf(iterations: readonly Iteration[], repo: string): StepRepoResult[] {
  return iterations.flatMap((it) => it.steps.flatMap((s) => s.repos.filter((r) => r.repo === repo)));
}

export interface RepoView {
  name: string;
  /** dev.repos[i].status as the server computed it — never re-derived here (P-C18) */
  status: RepoStatus;
  commits: Array<{ sha7: string; subject: string }>;
  lastTests: TestRun[];
  lastHook: CommitOutcome | null;
  violations: string[];
  /** install reset paths, base branch changed since the worktree was made */
  notes: string[];
}

/** One view per affected repo, in the server's order. */
export function repoViews(dev: DevelopmentResponse): RepoView[] {
  return dev.repos.map((r) => {
    const results = resultsOf(dev.iterations, r.name);
    const last = results.at(-1) ?? null;
    const notes: string[] = [];
    if (r.install && r.install.resetPaths.length > 0) notes.push(t("dev.noteInstallReset", { paths: r.install.resetPaths.join(", ") }));
    if (r.baseBranchChanged) {
      notes.push(t("dev.noteBaseChanged", { mapped: r.baseBranchChanged.mapped, branch: r.branch ?? dev.branch ?? "—", stored: r.baseBranchChanged.stored }));
    }
    return {
      name: r.name,
      status: r.status,
      commits: r.commits.map((c) => ({ sha7: c.sha.slice(0, 7), subject: c.subject })),
      lastTests: last?.tests ?? [],
      lastHook: last?.commit ?? null,
      violations: results.flatMap((x) => x.violations),
      notes,
    };
  });
}

export interface IterationView {
  title: string;
  tests: "passed" | "failed" | "not_run";
  hook: "passed" | "failed" | "timed_out" | "none";
  violations: string[];
}

const failed = (r: TestRun) => r.timedOut || r.exitCode !== 0;

/** One iteration as seen from one repo: its latest step's tests and commit, and every blocked edit. */
export function iterationView(it: Iteration, repo: string): IterationView {
  const results = resultsOf([it], repo);
  const last = results.at(-1);
  const tests = !last || last.tests.length === 0 ? "not_run" : last.tests.some(failed) ? "failed" : "passed";
  // the latest step that tried to commit (a later "nothing to commit" step does not hide it)
  const c = results.filter((r) => r.commit.kind !== "nothing").at(-1)?.commit;
  const hook = !c ? "none" : c.kind === "committed" ? "passed" : c.kind === "hook_failed" ? (c.timedOut ? "timed_out" : "failed") : "none";
  return {
    title: t("dev.iterationTitle", { n: it.iteration, trigger: t(`dev.trigger.${it.trigger}`) }),
    tests,
    hook,
    violations: results.flatMap((x) => x.violations),
  };
}

export type JiraCard =
  | { kind: "off" }
  /** sync on, nothing requested for this ticket (yet) */
  | { kind: "none" }
  | { kind: "pending"; id: number; target: string; thisWill: string }
  /** text: worded by the mode the write recorded (F4B-4), else the current one */
  | { kind: "running"; target: string; text: string }
  | { kind: "done" | "not_needed" | "skipped"; text: string }
  | { kind: "failed"; id: number; text: string };

/** The JIRA status card from the ticket's writes (latest one decides) and the sync setting. The target shown is the write's own. */
export function jiraCard(
  writes: readonly JiraWriteRecord[],
  sync: { enabled: boolean; targetStatus: string },
  key: string,
  /** mode: the JIRA mode set now (F4B-4: the wording of a write that has not run yet) */
  o: { abandoned?: boolean; mode?: JiraMode } = {},
): JiraCard {
  const w = writes.reduce<JiraWriteRecord | null>((a, b) => (a === null || b.id > a.id ? b : a), null);
  // F2-I3: nothing is sent for an abandoned ticket — no Send to JIRA, no Try again
  if (o.abandoned && w) {
    if (w.state === "pending" || w.state === "skipped") return { kind: "skipped", text: t("dev.jiraAbandoned") };
    if (w.state === "failed") return { kind: "skipped", text: w.detail ? t("dev.jiraFailedDetail", { detail: w.detail }) : t("dev.jiraFailed") };
  }
  // a write waiting for the developer is always shown, even if sync was turned off since
  if (w?.state === "pending") return { kind: "pending", id: w.id, target: w.targetStatus, thisWill: jiraText("dev.jiraThisWill", o.mode, { key, status: w.targetStatus }) };
  if (!sync.enabled) return { kind: "off" };
  if (!w) return { kind: "none" };
  switch (w.state) {
    case "confirmed":
      return { kind: "running", target: w.targetStatus, text: jiraText("dev.jiraRunning", w.jiraSource ?? o.mode, { key, status: w.targetStatus }) };
    case "done":
      return { kind: "done", text: t("dev.jiraDone", { key, status: w.targetStatus }) };
    case "not_needed":
      return { kind: "not_needed", text: t("dev.jiraNotNeeded", { key, status: w.targetStatus }) };
    case "skipped":
      return { kind: "skipped", text: t("dev.jiraSkipped") };
    default:
      return { kind: "failed", id: w.id, text: w.detail ? t("dev.jiraFailedDetail", { detail: w.detail }) : t("dev.jiraFailed") };
  }
}

export interface BrowserChoice {
  selected: string | null;
  options: Array<{ deviceId: string; label: string }>;
  /** detection not run or failed: type the device id */
  manual: boolean;
}

const browserLabel = (b: { deviceId: string; name: string }) => (b.name.trim() === "" ? b.deviceId : `${b.name} (${b.deviceId})`);

/** The "Chrome browser for JIRA" choice (S-2): detected browsers, plus the configured one when it was not detected. */
export function browserChoice(cfg: Config["jira"]["browser"], detected: ReadonlyArray<{ deviceId: string; name: string }> | null): BrowserChoice {
  const options = (detected ?? []).map((b) => ({ deviceId: b.deviceId, label: browserLabel(b) }));
  if (cfg && !options.some((o) => o.deviceId === cfg.deviceId)) options.push({ deviceId: cfg.deviceId, label: browserLabel(cfg) });
  return { selected: cfg?.deviceId ?? null, options: detected === null ? [] : options, manual: detected === null };
}

/**
 * The development blocks for a worktree with uncommitted changes (previous solution, or a repo no longer affected):
 * which repo and folder, so the page can explain what to do. Slack Off never discards the developer's changes itself.
 */
export function dirtyWorktreeHelp(blockedReason: string | null, ticketDir: string): { repo: string; path: string } | null {
  if (!blockedReason) return null;
  const m = /^([a-z0-9][a-z0-9._-]{0,39})(?::| is no longer affected but) .*uncommitted changes/.exec(blockedReason);
  if (!m) return null;
  return { repo: m[1]!, path: `${ticketDir.replace(/\/+$/, "")}/${m[1]}` };
}

/**
 * The repos-disagree note, shown only when it explains the write's own target (the server's note ends with
 * `using the Settings value "<status>"`; statuses compare like the server: trimmed, case-insensitive). Otherwise the
 * note describes today's settings, not this write: say which target the write was requested with.
 */
export function jiraNote(note: string | null, target: string): { kind: "note" | "target"; text: string } | null {
  if (note === null) return null;
  const chosen = /using the Settings value "([^"]*)"\s*$/.exec(note)?.[1];
  if (chosen !== undefined && chosen.trim().toLowerCase() === target.trim().toLowerCase()) return { kind: "note", text: note };
  return { kind: "target", text: t("dev.jiraTargetAtRequest", { target }) };
}

/** F2-R1: one "Accept new git hooks" banner per repo whose hooks differ from the pin of a blocked ticket. */
export interface HooksAcceptView {
  repo: string;
  /** this computer only (R21: it changes what runs on commit) */
  canAccept: boolean;
  thisWill: string;
}

export function hooksAcceptView(
  state: string,
  repos: ReadonlyArray<{ name: string; hooksChanged: boolean }>,
  local: boolean,
): HooksAcceptView[] {
  if (state !== "blocked") return [];
  return repos
    .filter((r) => r.hooksChanged)
    .map((r) => ({ repo: r.name, canAccept: local, thisWill: t("dev.hooksAcceptThisWill", { repo: r.name }) }));
}
