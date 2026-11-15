import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  critiqueSchema, designDocSchema, FetchedTicket, isTrialRole, PROMPT_TEXT_MAX, proposeResultSchema, Requirement, StoredSolution,
  type AgentRole, type TrialResult,
} from "@slackoff/shared";
import type { z } from "zod";
import type { RunAgentRequest } from "../executor/run-agent.ts";
import { resolveChecklist } from "../projects/project-rules.ts";
import { ValidationError } from "../tickets/errors.ts";

/**
 * Phase 4d Task 5 (D-7, D-8): try a prompt draft on the fictional sample ticket (skills/samples). One read-only role,
 * the draft in place of the saved developer additions (nothing is saved), no ticket, no repository rules, no retry. The
 * agent works in a scratch copy of the sample repository, removed afterwards. A failure is returned, never thrown, and
 * never touches a ticket. The run goes through the same runAgent as a real one (usage gate, policy, file guard,
 * redaction): `run` is the server's own.
 */
export interface TrialDeps {
  run: <T>(req: RunAgentRequest<T>) => Promise<T>;
  /** the Slack Off repo root (skills/samples) */
  repoRoot: string;
  /** the parent of the scratch copy (a temp dir outside every mapped repository and SLACKOFF_HOME) */
  tmpRoot: string;
  /** agent_run.cost_usd of a finished run (the route reads it from the DB) */
  costOf?: (runId: string) => number | null;
}

/** The sample repository's name in the prompts (a valid RepoName). */
const SAMPLE_REPO = "sample";
const READ_ONLY = ["Read", "Grep", "Glob"];

const json = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
const sec = (name: string, v: unknown) => `${name}:\n${json(v)}`;

function samples(repoRoot: string) {
  const dir = join(repoRoot, "skills", "samples");
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return {
    repo: join(dir, "sample-repo"),
    ticket: FetchedTicket.parse(JSON.parse(read("sample-ticket.json"))),
    requirement: Requirement.parse(JSON.parse(read("sample-requirement.json"))),
    solution: StoredSolution.parse(JSON.parse(read("sample-solution.json"))),
    design: read("sample-design.md"),
  };
}

type Built = { prompt: string; allowedTools: string[]; schema: z.ZodType<unknown> };

/** The role's input, shaped like its real job (workflow/jobs.ts, design/debate-jobs.ts), over the sample. */
function build(role: AgentRole, s: ReturnType<typeof samples>, cwd: string): Built {
  const repos = [{ name: SAMPLE_REPO, path: cwd, baseBranch: "main" }];
  const items = resolveChecklist([]);
  const common = [
    sec("affectedRepos", repos),
    sec("checklist", items.map(({ id, group, label }) => ({ id, group, label }))),
    sec("requirement", s.requirement),
  ];
  switch (role) {
    case "refine-ticket": {
      const t = s.ticket;
      const snapshot = { key: t.key, title: t.title, description: t.description, comments: t.comments, attachments: t.attachments.map(({ kind, filename, mime, url }) => ({ kind, filename, mime, url })) };
      return {
        prompt: ["mode: refine", "", "snapshot:", json(snapshot), "", "Reply with only the Requirement JSON object in a single ```json block."].join("\n"),
        allowedTools: [],
        schema: Requirement,
      };
    }
    case "propose-solutions":
      return {
        prompt: ["repos:", json(repos), "", "requirement:", json(s.requirement), "", "Reply with only the ProposeResult JSON object in a single ```json block."].join("\n"),
        allowedTools: READ_ONLY,
        schema: proposeResultSchema([SAMPLE_REPO]) as z.ZodType<unknown>,
      };
    case "design-solution":
      return {
        prompt: ["mode: draft", ...common, sec("solution", s.solution), sec("developerNote", ""), "responses must be [].\nReply with only the DesignDoc JSON object in a single ```json block."].join("\n\n"),
        allowedTools: READ_ONLY,
        schema: designDocSchema(items, [], [SAMPLE_REPO]) as z.ZodType<unknown>,
      };
    case "critique-design": {
      const design = {
        version: 1,
        contentMd: s.design,
        repos: [{ repo: SAMPLE_REPO, contentMd: s.design }],
        checklist: items.map((i) => ({ item: i.id, status: "considered", conclusion: "See the design." })),
      };
      return {
        prompt: ["mode: critique", sec("round", 1), ...common, sec("design", design), sec("history", []), "Reply with only the Critique JSON object in a single ```json block."].join("\n\n"),
        allowedTools: READ_ONLY,
        schema: critiqueSchema(items, [SAMPLE_REPO]) as z.ZodType<unknown>,
      };
    }
    default:
      throw new ValidationError("this role cannot be tried on the sample ticket");
  }
}

export async function runTrial(deps: TrialDeps, role: AgentRole, draft: string): Promise<TrialResult> {
  if (!isTrialRole(role)) throw new ValidationError("Not available for this role: it changes code, runs the app or uses JIRA");
  if (draft.length > PROMPT_TEXT_MAX) throw new ValidationError(`the draft is longer than ${PROMPT_TEXT_MAX} characters`);
  const s = samples(deps.repoRoot);
  const dir = mkdtempSync(join(deps.tmpRoot, "slackoff-trial-"));
  const cwd = join(dir, SAMPLE_REPO);
  const started = Date.now();
  let runId: string | null = null;
  try {
    cpSync(s.repo, cwd, { recursive: true });
    const b = build(role, s, cwd);
    const output = await deps.run({
      role,
      prompt: b.prompt,
      cwd,
      allowedTools: b.allowedTools,
      chrome: false,
      schema: b.schema,
      retries: 0,
      purpose: "trial",
      additionsOverride: draft,
      onRunStart: (id) => (runId = id),
    });
    return { runId, role, ok: true, output, error: null, durationMs: Date.now() - started, costUsd: runId === null ? null : (deps.costOf?.(runId) ?? null) };
  } catch (err) {
    const id = runId as string | null;
    return { runId: id, role, ok: false, output: null, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - started, costUsd: id === null ? null : (deps.costOf?.(id) ?? null) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
