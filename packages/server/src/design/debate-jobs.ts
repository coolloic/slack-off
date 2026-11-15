// Task 9: the design + debate loop. design-solution drafts / revises / applies rulings, critique-design (a fresh run that
// sees only platform-assembled JSON, never the designer's run) reviews, up to debate.maxRounds; then the developer rules.
import {
  critiqueSchema, designDocSchema, disagreements, isCritique, Ruling, type ChecklistItem, type DesignDoc, ArbiterResult,
} from "@slackoff/shared";
import { AgentInterruptedError } from "../executor/types.ts";
import { resolveChecklist, type RepoContext } from "../projects/project-rules.ts";
import { currentChoice, getRequirement, getSolution, type CurrentChoice } from "../requirements/requirement-repo.ts";
import { InvalidTransitionError, ValidationError } from "../tickets/errors.ts";
import { getTicket } from "../tickets/ticket-repo.ts";
import type { WorkflowCtx } from "../workflow/jobs.ts";
import { addDesignDoc, addRound, listDesignDocs, listRounds, listRulings, markFinal, saveDebateAdvice, saveRulings, type DesignDocRecord } from "./design-repo.ts";
import { latestDoc as latestOf, nextDebateStep, type DebateState, type DebateStep } from "./debate-step.ts";
import { describeError, logError } from "../log.ts";

export interface DebateJobs {
  /** Enqueue `design:<KEY>`: run debate steps until the design is final or needs the developer's ruling. */
  enqueue(key: string): void;
  ruleDebate(key: string, rulings: Ruling[], decidedBy: string): void;
}

const READ_ONLY = ["Read", "Grep", "Glob"];

const json = (v: unknown) => "```json\n" + JSON.stringify(v, null, 2) + "\n```";
/** A named prompt section: the heading line, then one json block. Agent-written text only ever appears inside the JSON. */
const sec = (name: string, v: unknown) => `${name}:\n${json(v)}`;

const docForPrompt = (d: DesignDocRecord) => ({ version: d.version, ...d.doc });

export function createDebateJobs(ctx: WorkflowCtx): DebateJobs {
  const { db, bus, config } = ctx;

  const updated = (key: string) => bus.emit({ type: "debate_updated", ticketKey: key });

  /** The current choice's debate (P-C1b: earlier choices' docs and rounds are kept but never mixed in). */
  const debateState = (key: string, choiceId: number): DebateState => {
    const rounds = listRounds(db, key, choiceId);
    const ids = new Set(rounds.map((r) => r.id));
    return {
      docs: listDesignDocs(db, key).filter((d) => d.choiceId === choiceId),
      rounds,
      rulings: listRulings(db, key).filter((r) => ids.has(r.debateRoundId)),
      maxRounds: config.debate.maxRounds,
    };
  };

  /** Still designing the same choice (the developer may have abandoned the ticket, or chosen again, while an agent ran). */
  const stillOn = (key: string, choiceId: number) => getTicket(db, key)?.state === "designing" && currentChoice(db, key)?.id === choiceId;

  const latestDoc = (st: DebateState): DesignDocRecord => {
    const d = latestOf(st.docs);
    if (!d) throw new Error("no design doc");
    return d;
  };

  const finalized = (key: string) => {
    updated(key);
    try {
      ctx.afterDesignFinal(key);
    } catch (err) {
      logError(`afterDesignFinal(${key}) failed: ${describeError(err)}`);
    }
  };

  /** What both roles read: the locked requirement, the affected repos and the checklist. */
  const common = (key: string, choice: CurrentChoice, repos: RepoContext[], items: ChecklistItem[]) => {
    const req = getRequirement(db, choice.requirementId);
    if (!req) throw new Error(`${key}: the chosen requirement ${choice.requirementId} is missing`);
    return [
      sec("affectedRepos", repos.map(({ name, path, baseBranch }) => ({ name, path, baseBranch }))),
      sec("checklist", items.map(({ id, group, label }) => ({ id, group, label }))),
      sec("requirement", req.content),
    ];
  };

  const designPrompt = (key: string, choice: CurrentChoice, repos: RepoContext[], items: ChecklistItem[], st: DebateState, step: DebateStep): string => {
    const sol = getSolution(db, choice.solutionId);
    if (!sol) throw new Error(`${key}: the chosen solution ${choice.solutionId} is missing`);
    const mode = step.kind === "draft" ? "draft" : step.kind === "revise" ? "revise" : "apply_rulings";
    const parts = [`mode: ${mode}`, ...common(key, choice, repos, items), sec("solution", sol.content), sec("developerNote", choice.note ?? null)];
    if (step.kind === "revise") {
      const critic = st.rounds.filter((r) => r.role === "critic" && r.round === step.round).at(-1)!;
      parts.push(
        sec("currentDesign", docForPrompt(latestDoc(st))),
        sec("critique", { round: step.round, comments: isCritique(critic.content) ? critic.content.comments : [] }),
        sec("mustAnswer", step.mustAnswer),
      );
    } else if (step.kind === "apply_rulings") {
      const rulings = st.rulings.filter((r) => r.debateRoundId === step.roundId);
      parts.push(
        sec("currentDesign", docForPrompt(latestDoc(st))),
        sec("disagreements", disagreements(st.rounds)),
        sec("rulings", rulings.map(({ commentId, decision, note }) => ({ commentId, decision, note }))),
        sec("mustAnswer", step.mustAnswer),
      );
    }
    const answer =
      step.kind === "draft"
        ? "responses must be []."
        : "In responses, answer at least these comment ids (mustAnswer), one response each: accept and change the design, or rebut with a reason.";
    return [...parts, `${answer}\nReply with only the DesignDoc JSON object in a single \`\`\`json block.`].join("\n\n");
  };

  const critiquePrompt = (key: string, choice: CurrentChoice, repos: RepoContext[], items: ChecklistItem[], st: DebateState, round: number): string => {
    // earlier rounds: the critic's own comments and the designer's structured responses only (spec §6 isolation)
    const history = st.rounds
      .filter((r) => r.role === "critic")
      .map((c) => {
        const d = st.rounds.filter((r) => r.role === "designer" && r.round === c.round).at(-1);
        return {
          round: c.round,
          comments: isCritique(c.content) ? c.content.comments : [],
          designerResponses: d && !isCritique(d.content) ? d.content.responses : [],
        };
      });
    const doc = latestDoc(st);
    return [
      "mode: critique",
      sec("round", round),
      ...common(key, choice, repos, items),
      sec("design", { version: doc.version, contentMd: doc.doc.contentMd, repos: doc.doc.repos, checklist: doc.doc.checklist }),
      sec("history", history),
      "Reply with only the Critique JSON object in a single ```json block.",
    ].join("\n\n");
  };

  /**
   * Escalation: a neutral read of each disagreement (the critic's skill in mode: arbitrate, read-only, the same
   * isolation as the critic) recommends a ruling with its reason; the developer still rules. Best effort: a failed
   * run escalates without recommendations (an interrupted one stops the job like any other).
   */
  const arbitrate = async (key: string, choice: CurrentChoice, repos: RepoContext[], items: ChecklistItem[], st: DebateState, base: object): Promise<void> => {
    const dis = disagreements(st.rounds);
    if (dis.length === 0) return;
    const doc = latestDoc(st);
    const prompt = [
      "mode: arbitrate",
      ...common(key, choice, repos, items),
      sec("design", { version: doc.version, contentMd: doc.doc.contentMd, repos: doc.doc.repos, checklist: doc.doc.checklist }),
      sec("disagreements", dis),
      "Reply with only the ArbiterResult JSON object in a single ```json block.",
    ].join("\n\n");
    try {
      const out = await ctx.run({ ...(base as Record<string, unknown>), ticketKey: key, role: "critique-design", prompt, schema: ArbiterResult } as never) as ArbiterResult;
      const ids = new Set(dis.map((d) => d.commentId));
      const seen = new Set<string>();
      const advice = out.recommendations.filter((a) => ids.has(a.commentId) && !seen.has(a.commentId) && seen.add(a.commentId) && (a.decision !== "custom" || a.note !== ""));
      saveDebateAdvice(db, choice.id, dis[0]!.roundId, advice);
    } catch (err) {
      if (err instanceof AgentInterruptedError) throw err;
      logError(`arbitrate:${key} failed, escalating without recommendations: ${describeError(err)}`);
    }
  };

  const runDesign = async (key: string): Promise<void> => {
    for (;;) {
      if (ctx.mustGet(key).state !== "designing") return;
      const choice = currentChoice(db, key);
      if (!choice) throw new InvalidTransitionError(`${key}: no solution has been chosen`);
      // the mapping may have changed since the last step: a repo that is gone blocks the ticket, named
      const repos = await ctx.repoContexts(key);
      if (!stillOn(key, choice.id)) continue; // re-read: left designing → stop; a new choice → its own debate
      const items = resolveChecklist(repos);
      const names = repos.map((r) => r.name);
      const st = debateState(key, choice.id);
      const step = nextDebateStep(st);
      const base = {
        ticketKey: key,
        cwd: repos[0]!.path,
        addDirs: repos.slice(1).map((r) => r.path),
        repos,
        allowedTools: READ_ONLY,
        chrome: false,
      };

      if (step.kind === "finalize") {
        ctx.atomic(() => {
          markFinal(db, key, step.docId);
          ctx.move(key, "design_final", "system");
        });
        finalized(key);
        return;
      }
      if (step.kind === "escalate") {
        await arbitrate(key, choice, repos, items, st, base);
        if (!stillOn(key, choice.id)) continue; // left designing while the arbiter ran
        const n = disagreements(st.rounds).length;
        ctx.move(key, "awaiting_debate_ruling", "system", `${n} disagreement(s) need your ruling`, { disagreements: n });
        updated(key);
        return;
      }
      // the developer skipped the debate when choosing: the designer's draft is final, no critic runs
      if (step.kind === "critique" && choice.skipDebate) {
        const docId = latestDoc(st).id;
        ctx.atomic(() => {
          markFinal(db, key, docId);
          ctx.move(key, "design_final", "system");
        });
        finalized(key);
        return;
      }
      if (step.kind === "critique") {
        const doc = latestDoc(st);
        const critique = await ctx.run({
          ...base,
          role: "critique-design",
          prompt: critiquePrompt(key, choice, repos, items, st, step.round),
          schema: critiqueSchema(items, names),
        });
        if (!stillOn(key, choice.id)) continue; // re-read: left designing → stop; a new choice → its own debate
        addRound(db, key, { choiceId: choice.id, designDocId: doc.id, round: step.round, role: "critic", content: critique });
        updated(key);
        continue;
      }

      const mustAnswer = step.kind === "draft" ? [] : step.mustAnswer;
      const out = await ctx.run({
        ...base,
        role: "design-solution",
        prompt: designPrompt(key, choice, repos, items, st, step),
        schema: designDocSchema(items, mustAnswer, names),
      });
      if (!stillOn(key, choice.id)) continue; // re-read: left designing → stop; a new choice → its own debate
      // responses to comments not asked for are ignored (Task 2 carry)
      const doc: DesignDoc = { ...out, responses: out.responses.filter((r) => mustAnswer.includes(r.commentId)) };
      const save = () => addDesignDoc(db, key, { requirementId: choice.requirementId, choiceId: choice.id, doc });
      if (step.kind === "revise") {
        // the revised doc and its designer round are written together or not at all (P-C1b)
        ctx.atomic(() => {
          const { id } = save();
          addRound(db, key, { choiceId: choice.id, designDocId: id, round: step.round, role: "designer", content: { responses: doc.responses } });
        });
      } else save();
      updated(key);
    }
  };

  const enqueue = (key: string): void =>
    ctx.job(`design:${key}`, key, async () => {
      try {
        await runDesign(key);
      } catch (err) {
        // the ticket left designing while the step ran (abandoned, rechosen): nothing to block, but say what failed
        if (!(err instanceof AgentInterruptedError) && getTicket(db, key)?.state !== "designing") {
          logError(`design:${key} failed after the ticket left designing: ${describeError(err)}`);
          return;
        }
        throw err;
      }
    });

  const ruleDebate = (key: string, rulings: Ruling[], decidedBy: string): void => {
    ctx.requireState(ctx.mustGet(key), "awaiting_debate_ruling");
    const choice = currentChoice(db, key);
    if (!choice) throw new InvalidTransitionError(`${key}: no solution has been chosen`);
    const st = debateState(key, choice.id);
    const dis = disagreements(st.rounds);
    if (dis.length === 0) throw new InvalidTransitionError(`${key}: there is no disagreement to rule on`);
    const parsed: Ruling[] = rulings.map((r, i) => {
      const p = Ruling.safeParse(r);
      if (!p.success) throw new ValidationError(`ruling ${i + 1}: ${p.error.issues.map((x) => x.message).join("; ")}`);
      return p.data;
    });
    const want = dis.map((d) => d.commentId);
    const given = parsed.map((r) => r.commentId);
    const twice = [...new Set(given.filter((id, i) => given.indexOf(id) !== i))];
    const unknown = given.filter((id) => !want.includes(id));
    const missing = want.filter((id) => !given.includes(id));
    if (twice.length) throw new ValidationError(`more than one ruling for: ${twice.join(", ")}`);
    if (unknown.length) throw new ValidationError(`not a disagreement of this debate: ${unknown.join(", ")}`);
    if (missing.length) throw new ValidationError(`every disagreement needs a ruling; missing: ${missing.join(", ")}`);
    const allDesigner = parsed.every((r) => r.decision === "designer");
    ctx.atomic(() => {
      saveRulings(db, key, dis[0]!.roundId, parsed, decidedBy);
      if (allDesigner) {
        markFinal(db, key, latestDoc(st).id);
        ctx.move(key, "design_final", "developer", undefined, { decidedBy });
      } else ctx.move(key, "designing", "developer", undefined, { decidedBy });
    });
    if (allDesigner) finalized(key);
    else {
      updated(key);
      enqueue(key);
    }
  };

  return { enqueue, ruleDebate };
}
