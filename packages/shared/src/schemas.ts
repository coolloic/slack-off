import { z } from 'zod';
import { coverage, type ChecklistItem } from './checklist.ts';
import { TICKET_KEY } from './ticket-key.ts';

/** Traceability (H4): every source points somewhere and quotes something; a developer AC says why. Trimmed, never blank. */
const nonBlank = z.string().trim().min(1, 'must not be blank');

export const TicketSummary = z.object({
  key: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.string(),
});
export type TicketSummary = z.infer<typeof TicketSummary>;

/**
 * Discovery reads every open ticket assigned to the developer, page by page, up to `jira.discoverLimit`.
 * `total` is the result count JIRA shows; `complete` is false when the agent stopped at the limit or could not read a page.
 */
export const DiscoverResult = z.object({
  loginRequired: z.boolean(),
  tickets: z.array(TicketSummary),
  total: z.number().int().min(0),
  complete: z.boolean(),
});
export type DiscoverResult = z.infer<typeof DiscoverResult>;

export const FetchedTicket = z.object({
  loginRequired: z.boolean(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  jiraUpdatedAt: z.string().nullable(),
  /** The JIRA status the page showed; phase-1 output has none. */
  status: z.string().nullable().default(null),
  comments: z.array(
    z.object({
      jiraCommentId: z.string(),
      author: z.string(),
      created: z.string(),
      body: z.string(),
    }),
  ),
  attachments: z.array(
    z.object({
      kind: z.enum(['attachment', 'inline_image']),
      filename: z.string(),
      mime: z.string(),
      url: z.string(),
      base64: z.string().nullable(),
    }),
  ),
});
export type FetchedTicket = z.infer<typeof FetchedTicket>;

export const AcSource = z.union([
  z.object({
    type: z.enum(['description', 'comment', 'attachment']),
    ref: nonBlank,
    quote: nonBlank,
  }),
  z.object({ type: z.literal('developer'), reason: nonBlank }),
]);
export type AcSource = z.infer<typeof AcSource>;

export const Requirement = z.object({
  background: z.string(),
  functional: z.array(z.object({ id: z.string(), text: z.string() })),
  acceptanceCriteria: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      verifiable: z.boolean(),
      source: AcSource,
    }),
  ),
  discussionOutcomes: z.array(
    z.object({ id: z.string(), text: z.string(), sourceCommentIds: z.array(z.string()) }),
  ),
  openQuestions: z.array(
    z.object({ kind: z.enum(['missing', 'conflict', 'unverifiable']), text: z.string() }),
  ),
  draftComment: z.string().nullable(),
});
export type Requirement = z.infer<typeof Requirement>;

export const DriftResult = z.object({
  baseline: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['covered', 'partial', 'missing']),
      coveredBy: z.array(z.string()),
      note: z.string(),
    }),
  ),
  current: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['mapped', 'new_sourced', 'new_developer', 'new_unsourced']),
    }),
  ),
  contradictions: z.array(
    z.object({ acId: z.string(), quote: z.string(), explanation: z.string() }),
  ),
  /**
   * Suggested notes for the developer's acknowledgement (when the result needs one): each fills the note, goes with
   * acknowledging or with revising the requirement (back to editing / re-plan), one recommended. Older results: none.
   */
  ackOptions: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        text: z.string().min(1).max(500),
        recommended: z.boolean().default(false),
        action: z.enum(["acknowledge", "revise"]),
      }),
    )
    .max(4)
    .optional(),
});
export type DriftResult = z.infer<typeof DriftResult>;

export const RepoName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, 'repo name must match ^[a-z0-9][a-z0-9._-]{0,39}$');
export type RepoName = z.infer<typeof RepoName>;

const RepoChange = z.object({ repo: RepoName, summary: z.string() });

const solutionFields = {
  title: z.string(),
  approach: z.string(),
  changeScope: z.array(z.string()),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  risks: z.array(z.string()),
  complexity: z.enum(['S', 'M', 'L']),
  /** Affected repos (≥1, unique); locked on the choice. */
  affectedRepos: z.array(RepoName).min(1),
  /** One entry per affected repo, same set. */
  repoChanges: z.array(RepoChange),
  /** Phase 4d (D-2): third-party packages or external services this solution adds; optional in agent output. */
  newDependencies: z.array(z.string().min(1).max(100)).max(20).optional(),
  /** The option the agent recommends (at most one per set), with why in one line; absent = not recommended (older records too). */
  recommended: z.boolean().optional(),
  recommendationReason: z.string().max(300).optional(),
};

function checkRepos(
  s: { affectedRepos: string[]; repoChanges: { repo: string }[] },
  ctx: z.RefinementCtx,
  mapped: readonly string[] | null,
): void {
  const dup = duplicates(s.affectedRepos);
  if (dup.length) ctx.addIssue({ code: 'custom', path: ['affectedRepos'], message: `duplicate affected repos: ${dup.join(', ')}` });
  if (mapped) {
    const unknown = s.affectedRepos.filter((r) => !mapped.includes(r));
    if (unknown.length)
      ctx.addIssue({
        code: 'custom',
        path: ['affectedRepos'],
        message: `unknown repos: ${unknown.join(', ')} (mapped repos: ${mapped.join(', ') || 'none'})`,
      });
  }
  const changed = s.repoChanges.map((c) => c.repo);
  const dupC = duplicates(changed);
  const missing = s.affectedRepos.filter((r) => !changed.includes(r));
  const extra = changed.filter((r) => !s.affectedRepos.includes(r));
  if (dupC.length || missing.length || extra.length)
    ctx.addIssue({
      code: 'custom',
      path: ['repoChanges'],
      message:
        'repoChanges must have exactly one entry per affected repo' +
        (missing.length ? `; missing: ${missing.join(', ')}` : '') +
        (extra.length ? `; not affected: ${extra.join(', ')}` : '') +
        (dupC.length ? `; duplicate: ${dupC.join(', ')}` : ''),
    });
}

export const Solution = z.object(solutionFields).superRefine((s, ctx) => checkRepos(s, ctx, null));
export type Solution = z.infer<typeof Solution>;

/** Reading saved solutions: phase-1 records have no repos. Agent output always goes through proposeResultSchema. */
export const StoredSolution = z.object({
  ...solutionFields,
  affectedRepos: z.array(RepoName).default([]),
  repoChanges: z.array(RepoChange).default([]),
  /** Phase 4d (D-2): records without the field (older, or an agent that left it out) read as []. */
  newDependencies: z.array(z.string().min(1).max(100)).max(20).default([]),
});
export type StoredSolution = z.infer<typeof StoredSolution>;

export const ProposeResult = z.object({
  solutions: z
    .array(Solution)
    .min(1)
    .max(5)
    .refine((list) => list.filter((x) => x.recommended).length <= 1, { message: "at most one solution may be recommended" }),
});
export type ProposeResult = z.infer<typeof ProposeResult>;

/** ProposeResult whose affected repos must be names mapped for the project. */
export function proposeResultSchema(repoNames: readonly string[]): z.ZodType<ProposeResult> {
  const sol = z.object(solutionFields).superRefine((s, ctx) => checkRepos(s, ctx, repoNames));
  return z.object({ solutions: z.array(sol).min(1).max(5) });
}

// ---------------------------------------------------------------- design debate

export const ChecklistEntry = z.object({
  item: z.string(),
  status: z.enum(['considered', 'not_applicable']),
  conclusion: nonBlank,
});
export type ChecklistEntry = z.infer<typeof ChecklistEntry>;

export const CritiqueComment = z.object({
  id: z.string().regex(/^C-\d+$/, 'comment id must look like C-1'),
  checklistItem: z.string(),
  repo: RepoName.nullable(),
  blocking: z.boolean(),
  text: nonBlank,
  suggestion: z.string().nullable(),
});
export type CritiqueComment = z.infer<typeof CritiqueComment>;

export const CommentResponse = z.object({
  commentId: z.string(),
  verdict: z.enum(['accepted', 'rebutted']),
  reason: nonBlank,
});
export type CommentResponse = z.infer<typeof CommentResponse>;

export const DesignDoc = z.object({
  /** Overall design + cross-repo concerns. */
  contentMd: z.string(),
  repos: z.array(z.object({ repo: RepoName, contentMd: z.string() })),
  checklist: z.array(ChecklistEntry),
  responses: z.array(CommentResponse),
});
export type DesignDoc = z.infer<typeof DesignDoc>;

export const CoverageEntry = z.object({ item: z.string(), status: z.enum(['ok', 'concern']), note: nonBlank });

export const Critique = z.object({
  comments: z.array(CritiqueComment),
  coverage: z.array(CoverageEntry),
});
export type Critique = z.infer<typeof Critique>;

function duplicates(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const x of xs) (seen.has(x) ? dup : seen).add(x);
  return [...dup];
}

function checkCoverage(entries: { item: string }[], items: readonly ChecklistItem[], path: string, ctx: z.RefinementCtx): void {
  const c = coverage(entries, items);
  if (c.missing.length) ctx.addIssue({ code: 'custom', path: [path], message: `missing checklist items: ${c.missing.join(', ')}` });
  if (c.unknown.length) ctx.addIssue({ code: 'custom', path: [path], message: `unknown checklist items: ${c.unknown.join(', ')}` });
  if (c.duplicate.length) ctx.addIssue({ code: 'custom', path: [path], message: `checklist items answered more than once: ${c.duplicate.join(', ')}` });
}

/**
 * A design doc answers every checklist item once, has exactly one section per affected repo,
 * and exactly one response per comment id in `mustAnswer`. Responses to other ids are ignored, not rejected (the designer
 * is asked to answer "at least these ids"; the platform keeps only the ones it asked for).
 */
export function designDocSchema(
  items: readonly ChecklistItem[],
  mustAnswer: readonly string[],
  repos: readonly string[],
): z.ZodType<DesignDoc> {
  return DesignDoc.superRefine((d, ctx) => {
    checkCoverage(d.checklist, items, 'checklist', ctx);
    const got = d.repos.map((r) => r.repo);
    const missing = repos.filter((r) => !got.includes(r));
    const extra = got.filter((r) => !repos.includes(r));
    const dup = duplicates(got);
    if (missing.length) ctx.addIssue({ code: 'custom', path: ['repos'], message: `missing sections for affected repos: ${missing.join(', ')}` });
    if (extra.length) ctx.addIssue({ code: 'custom', path: ['repos'], message: `sections for repos that are not affected: ${extra.join(', ')}` });
    if (dup.length) ctx.addIssue({ code: 'custom', path: ['repos'], message: `more than one section for: ${dup.join(', ')}` });
    const answered = d.responses.map((r) => r.commentId);
    const unanswered = mustAnswer.filter((id) => !answered.includes(id));
    const twice = duplicates(answered.filter((id) => mustAnswer.includes(id)));
    if (unanswered.length) ctx.addIssue({ code: 'custom', path: ['responses'], message: `missing responses to comments: ${unanswered.join(', ')}` });
    if (twice.length) ctx.addIssue({ code: 'custom', path: ['responses'], message: `more than one response to: ${twice.join(', ')}` });
  });
}

/** A critique covers every checklist item once; comments cite a checklist item, an affected repo (or null) and unique ids. */
export function critiqueSchema(items: readonly ChecklistItem[], repos: readonly string[]): z.ZodType<Critique> {
  const known = new Set(items.map((i) => i.id));
  return Critique.superRefine((c, ctx) => {
    checkCoverage(c.coverage, items, 'coverage', ctx);
    c.comments.forEach((m, i) => {
      if (!known.has(m.checklistItem))
        ctx.addIssue({ code: 'custom', path: ['comments', i, 'checklistItem'], message: `${m.id}: unknown checklist item: ${m.checklistItem}` });
      if (m.repo !== null && !repos.includes(m.repo))
        ctx.addIssue({
          code: 'custom',
          path: ['comments', i, 'repo'],
          message: `${m.id}: repo ${m.repo} is not affected (affected: ${repos.join(', ')}); use null for cross-repo comments`,
        });
    });
    const dup = duplicates(c.comments.map((m) => m.id));
    if (dup.length) ctx.addIssue({ code: 'custom', path: ['comments'], message: `duplicate comment ids: ${dup.join(', ')}` });
  });
}

export const Ruling = z
  .object({
    commentId: z.string().max(64),
    decision: z.enum(['designer', 'critic', 'custom']),
    note: z.string().trim().max(4000),
  })
  .superRefine((r, ctx) => {
    if (r.decision === 'custom' && r.note.length === 0)
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'a custom ruling needs a note' });
  });
export type Ruling = z.infer<typeof Ruling>;

/**
 * The arbiter (critique-design, mode: arbitrate) when a debate is escalated: for each disagreement, the ruling it
 * recommends (designer / critic / custom with the decision as its note) and why. The developer still rules.
 */
export const ArbiterResult = z.object({
  recommendations: z
    .array(
      z.object({
        commentId: z.string().max(64),
        decision: z.enum(['designer', 'critic', 'custom']),
        note: z.string().trim().max(4000),
        reason: z.string().trim().min(1).max(400),
      }),
    )
    .max(50),
});
export type ArbiterResult = z.infer<typeof ArbiterResult>;
export type DebateAdvice = ArbiterResult['recommendations'][number];

// ---------------------------------------------------------------- development

export const DevStepResult = z.object({
  summary: z.string(),
  /** Single line, 1–72 chars; the platform strips a leading "<KEY>:" / "<KEY> " of the ticket and adds its own prefix. */
  commitMessage: z
    .string()
    .min(1)
    .max(72)
    .regex(/^[^\r\n]*$/, 'commit message must be a single line')
    .refine((m) => m.trim().length > 0, 'commit message must not be blank'),
  done: z.boolean(),
  testsRun: z.array(z.object({ repo: RepoName, command: z.string(), passed: z.boolean() })),
  notes: z.string(),
  /**
   * A question only the developer can answer (information the step needs and cannot get: a reference value, access,
   * a decision). Set: the platform stops development and asks; null when the step can go on.
   */
  needsInput: z.string().max(500).nullable().default(null),
  /** With needsInput: up to 4 answers the developer can pick (and edit), one of them recommended. */
  answerOptions: z
    .array(z.object({ label: z.string().min(1).max(80), text: z.string().min(1).max(500), recommended: z.boolean().default(false) }))
    .max(4)
    .default([]),
});
export type AnswerOption = DevStepResult["answerOptions"][number];
export type DevStepResult = z.infer<typeof DevStepResult>;

export const JiraUpdateResult = z.object({
  loginRequired: z.boolean(),
  outcome: z.enum(['changed', 'already_in_status', 'transition_unavailable', 'failed']),
  observedStatus: z.string().nullable(),
  detail: z.string(),
});
export type JiraUpdateResult = z.infer<typeof JiraUpdateResult>;

// ---------------------------------------------------------------- acceptance

/** A rules-file `acceptance.env` key (and an acceptance case's `env` key). */
export const ACCEPT_ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A rules-file `acceptance.env` value: the characters isSafeCommand allows in a word. */
export const ACCEPT_ENV_VALUE = /^[A-Za-z0-9_./:@=+,-]{0,200}$/;
const RESERVED_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'BASH_ENV', 'ENV', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'SSH_AUTH_SOCK',
]);
/** loader / git / npm-config / platform / secret prefixes, proxy and secret-named suffixes (keys are upper case already) */
const RESERVED_ENV_PREFIXES = ['SLACKOFF_', 'LD_', 'DYLD_', 'GIT_', 'NPM_CONFIG_', 'AWS_', 'ANTHROPIC_'];
const RESERVED_ENV_SUFFIXES = ['_PROXY', '_TOKEN', '_SECRET', '_PASSWORD'];

/** A variable neither the rules file's acceptance.env nor an acceptance case may set. */
export function isReservedEnvKey(key: string): boolean {
  const k = key.toUpperCase();
  return RESERVED_ENV_KEYS.has(k) || RESERVED_ENV_PREFIXES.some((p) => k.startsWith(p)) || RESERVED_ENV_SUFFIXES.some((s) => k.endsWith(s));
}

export const RESERVED_ENV_MESSAGE =
  'must not set PATH, HOME, NODE_OPTIONS, NODE_PATH, NODE_EXTRA_CA_CERTS, CLAUDE_CONFIG_DIR, BASH_ENV, ENV, SSH_AUTH_SOCK, ' +
  'SLACKOFF_*, LD_*, DYLD_*, GIT_*, NPM_CONFIG_*, AWS_*, ANTHROPIC_*, *_PROXY or secret variables (*_TOKEN, *_SECRET, *_PASSWORD)';

/** phase 4f: an acceptance case's name (its file is cases/<name>.case.json; evidence names it). */
export const CASE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** phase 4f: a library example, a file in acceptance/examples/. */
export const CASE_EXAMPLE = /^[a-z0-9-]{1,64}\.mjs$/;
const CASE_FILE_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
const KB64 = 64 * 1024;

/**
 * Ruling F-5: an input file of a case, relative to its own work dir — plain segments only (no "", ".", "..", `.git`,
 * no absolute path, no backslash), at most 8 deep and 200 characters. The runner still writes it without following a
 * symlink.
 */
export function isCaseFilePath(p: string): boolean {
  if (p.length === 0 || p.length > 200 || p.startsWith('/')) return false;
  const segs = p.split('/');
  return segs.length <= 8 && segs.every((s) => CASE_FILE_SEGMENT.test(s) && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
}

const compiles = (src: string) => {
  try {
    new RegExp(src);
    return true;
  } catch {
    return false;
  }
};

/**
 * phase 4f (ruling F-1): one declared acceptance case of a command-line tool (`args` after the rules file's
 * cli.command) or a Node library (`example`, run with `args`). Never run through a shell.
 */
export const AcceptanceCase = z.object({
  name: z.string().regex(CASE_NAME, 'case names must match ^[a-z0-9][a-z0-9-]{0,63}$'),
  acId: z.string().min(1).max(64),
  kind: z.enum(['happy', 'error', 'edge']),
  title: z.string().min(1).max(200),
  args: z
    .array(z.string().max(2000).refine((a) => !a.includes('\0'), 'arguments must not contain NUL'))
    .max(50),
  stdin: z.string().refine((s) => utf8Bytes(s) <= KB64, 'stdin must be at most 64 KB').optional(),
  env: z
    .record(
      z
        .string()
        .regex(ACCEPT_ENV_KEY, 'keys must match ^[A-Z][A-Z0-9_]{0,63}$')
        .refine((k) => !isReservedEnvKey(k), RESERVED_ENV_MESSAGE),
      z.string().regex(ACCEPT_ENV_VALUE, 'values must be at most 200 letters, digits or _ . / : @ = + , -'),
    )
    .refine((e) => Object.keys(e).length <= 10, 'at most 10 variables')
    .optional(),
  files: z
    .record(
      z.string().refine(isCaseFilePath, 'file paths must be relative plain names (no "..", no absolute path, no .git)'),
      z.string().refine((s) => utf8Bytes(s) <= KB64, 'files must be at most 64 KB each'),
    )
    .refine((f) => Object.keys(f).length <= 20, 'at most 20 files')
    .optional(),
  example: z.string().regex(CASE_EXAMPLE, 'examples must be a file name in examples/ matching ^[a-z0-9-]{1,64}\\.mjs$').optional(),
  expect: z
    .object({
      exitCode: z.number().int().min(0).max(255).optional(),
      stdoutIncludes: z.array(z.string().min(1).max(2000)).max(20).optional(),
      stderrIncludes: z.array(z.string().min(1).max(2000)).max(20).optional(),
      stdoutMatches: z.string().max(200).refine(compiles, 'stdoutMatches must be a valid regular expression').optional(),
    })
    .refine(
      (e) => e.exitCode !== undefined || (e.stdoutIncludes?.length ?? 0) > 0 || (e.stderrIncludes?.length ?? 0) > 0 || e.stdoutMatches !== undefined,
      'expect must check something (exitCode, stdoutIncludes, stderrIncludes or stdoutMatches)',
    ),
});
export type AcceptanceCase = z.infer<typeof AcceptanceCase>;

/** phase 4f: the platform runner's own result of one case (ruling F-4: each output's last 64 KB). */
export const CaseResult = z.object({
  name: z.string(),
  passed: z.boolean(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  truncated: z.boolean(),
  /** one English sentence per unmet expectation */
  failures: z.array(z.string()),
});
export type CaseResult = z.infer<typeof CaseResult>;

/**
 * Evidence for a flow. `attachment` (preferred) names a testInfo.attach entry, or the automatic 'screenshot', of a test;
 * `file` is the fallback: a path under the acceptance dir's evidence/ the platform checks (Task 8).
 */
export const AcceptanceEvidenceRef = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('attachment'),
    /** full test name, "file › title" */
    test: z.string().min(1),
    /** the testInfo.attach name, or 'screenshot' for the automatic one */
    name: z.string().min(1),
    caption: z.string(),
  }),
  z.object({
    kind: z.literal('file'),
    path: z
      .string()
      .regex(/^evidence\/[A-Za-z0-9._/-]{1,200}\.(png|jpe?g)$/, 'evidence path must be evidence/<name>.png|jpg|jpeg')
      // the regex already excludes absolute paths, backslashes and percent-encoding; every segment after evidence/
      // must be a plain name (non-empty, not "." or "..", not hidden) so one file has exactly one spelling
      .refine((p) => p.split('/').slice(1).every((seg) => seg.length > 0 && !seg.startsWith('.')), 'evidence path segments must be plain names (no "", ".", ".." or hidden files)'),
    caption: z.string(),
  }),
  /** phase 4f: a case of the platform's own re-run (command and output), command-line and library entries */
  z.object({
    kind: z.literal('case'),
    case: z.string().regex(CASE_NAME, 'case names must match ^[a-z0-9][a-z0-9-]{0,63}$'),
    caption: z.string(),
  }),
]);
export type AcceptanceEvidenceRef = z.infer<typeof AcceptanceEvidenceRef>;

export const AcceptanceFlow = z.object({
  kind: z.enum(['happy', 'error', 'edge']),
  title: z.string(),
  steps: z.array(z.string()).min(1),
  expected: z.string(),
  actual: z.string(),
  /** full test names, "file › title" */
  tests: z.array(z.string().min(1)).min(1),
  /** every AC has evidence (spec §5.3 step 6, ruling R1) */
  evidence: z.array(AcceptanceEvidenceRef).min(1),
});
export type AcceptanceFlow = z.infer<typeof AcceptanceFlow>;

const AcceptanceAc = z
  .object({
    acId: z.string(),
    verdict: z.enum(['pass', 'fail']),
    flows: z.array(AcceptanceFlow),
    note: z.string(),
  })
  .superRefine((a, ctx) => {
    const kinds = new Set(a.flows.map((f) => f.kind));
    if (!kinds.has('happy')) ctx.addIssue({ code: 'custom', path: ['flows'], message: `${a.acId}: needs at least one happy flow` });
    if (!kinds.has('error')) ctx.addIssue({ code: 'custom', path: ['flows'], message: `${a.acId}: needs at least one error flow` });
    if (!kinds.has('edge') && a.note.trim().length === 0)
      ctx.addIssue({ code: 'custom', path: ['note'], message: `${a.acId}: no edge flow — the note must say why no boundary applies` });
  });

export const AcceptanceResult = z.object({ summary: z.string(), acs: z.array(AcceptanceAc) });
export type AcceptanceResult = z.infer<typeof AcceptanceResult>;

/** An acceptance result with exactly one entry per locked AC id. */
export function acceptanceResultSchema(acIds: readonly string[]): z.ZodType<AcceptanceResult> {
  return AcceptanceResult.superRefine((r, ctx) => {
    const got = r.acs.map((a) => a.acId);
    const missing = acIds.filter((id) => !got.includes(id));
    const unknown = got.filter((id) => !acIds.includes(id));
    const dup = duplicates(got);
    if (missing.length) ctx.addIssue({ code: 'custom', path: ['acs'], message: `missing acceptance criteria: ${missing.join(', ')}` });
    if (unknown.length)
      ctx.addIssue({ code: 'custom', path: ['acs'], message: `unknown acceptance criteria: ${unknown.join(', ')} (expected: ${acIds.join(', ')})` });
    if (dup.length) ctx.addIssue({ code: 'custom', path: ['acs'], message: `acceptance criteria reported more than once: ${dup.join(', ')}` });
  });
}

// ---------------------------------------------------------------- jira comment

export const JiraCommentResult = z.object({
  loginRequired: z.boolean(),
  outcome: z.enum(['posted', 'failed']),
  detail: z.string(),
});
export type JiraCommentResult = z.infer<typeof JiraCommentResult>;

export function driftNeedsAck(r: DriftResult): boolean {
  return (
    r.baseline.some((b) => b.status === 'missing') ||
    r.current.some((c) => c.status === 'new_unsourced') ||
    r.contradictions.length > 0
  );
}

export const TicketKey = z.string().max(64).regex(TICKET_KEY, 'ticket key must look like ABC-123');
