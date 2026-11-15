import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  AcSource,
  ProposeResult,
  driftNeedsAck,
  DriftResult,
} from '../src/index.ts';

test('canTransition allows the phase-1 happy path', () => {
  assert.equal(canTransition('discovered', 'refining'), true);
  assert.equal(canTransition('refined', 'proposing'), true);
  assert.equal(canTransition('awaiting_choice', 'designing'), true);
});

test('canTransition rejects skipped and later-phase transitions', () => {
  assert.equal(canTransition('discovered', 'proposing'), false);
  assert.equal(canTransition('designing', 'developing'), false);
});

test('terminal states cannot transition', () => {
  assert.equal(canTransition('pr_opened', 'blocked'), false);
  assert.equal(canTransition('abandoned', 'refining'), false);
});

test('any non-terminal state may go to blocked/abandoned; blocked may resume', () => {
  assert.equal(canTransition('developing', 'blocked'), true);
  assert.equal(canTransition('proposing', 'abandoned'), true);
  assert.equal(canTransition('blocked', 'proposing'), true);
  assert.equal(canTransition('blocked', 'pr_opened'), false);
});

test('AcSource rejects empty developer reason', () => {
  assert.throws(() => AcSource.parse({ type: 'developer', reason: '' }));
  assert.ok(AcSource.parse({ type: 'developer', reason: 'because' }));
  assert.ok(AcSource.parse({ type: 'comment', ref: 'c1', quote: 'q' }));
});

test('ProposeResult requires 1..5 solutions', () => {
  assert.throws(() => ProposeResult.parse({ solutions: [] }));
});

test('driftNeedsAck', () => {
  const ok: DriftResult = {
    baseline: [{ id: 'AC-1@v1', status: 'covered', coveredBy: ['AC-1'], note: '' }],
    current: [{ id: 'AC-1', status: 'mapped' }],
    contradictions: [],
  };
  assert.equal(driftNeedsAck(ok), false);
  assert.equal(driftNeedsAck({ ...ok, current: [{ id: 'AC-2', status: 'new_unsourced' }] }), true);
  assert.equal(
    driftNeedsAck({ ...ok, baseline: [{ id: 'D-1', status: 'missing', coveredBy: [], note: '' }] }),
    true,
  );
  assert.equal(
    driftNeedsAck({ ...ok, contradictions: [{ acId: 'AC-1', quote: 'q', explanation: 'e' }] }),
    true,
  );
});

test('H4 AcSource trims ref, quote and reason and rejects blank ones', () => {
  for (const bad of [
    { type: 'developer', reason: '   ' },
    { type: 'developer', reason: '\n\t' },
    { type: 'description', ref: '  ', quote: 'q' },
    { type: 'comment', ref: 'c1', quote: '  ' },
    { type: 'attachment', ref: '', quote: 'q' },
    { type: 'comment', ref: 'c1', quote: '' },
  ]) {
    assert.equal(AcSource.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.deepEqual(AcSource.parse({ type: 'developer', reason: '  because  ' }), { type: 'developer', reason: 'because' });
  assert.deepEqual(AcSource.parse({ type: 'comment', ref: ' c1 ', quote: ' q ' }), { type: 'comment', ref: 'c1', quote: 'q' });
});

// ---------------------------------------------------------------- phase 2

import {
  DEFAULT_CHECKLIST,
  CROSS_REPO_CHECKLIST,
  coverage,
  designDocSchema,
  critiqueSchema,
  proposeResultSchema,
  Solution,
  StoredSolution,
  Ruling,
  DevStepResult,
  JiraUpdateResult,
  FetchedTicket,
  RepoName,
  disagreements,
  repoStatus,
  repoReady,
  type DebateRoundRecord,
  type ChecklistItem,
  type TestRun,
} from '../src/index.ts';

test('phase 2 transitions', () => {
  for (const [from, to] of [
    ['designing', 'design_final'],
    ['designing', 'awaiting_debate_ruling'],
    ['awaiting_debate_ruling', 'designing'],
    ['awaiting_debate_ruling', 'design_final'],
    ['awaiting_debate_ruling', 'awaiting_choice'],
    ['design_final', 'checking_snapshot'],
    ['checking_snapshot', 'awaiting_snapshot_ack'],
    ['checking_snapshot', 'developing'],
    ['awaiting_snapshot_ack', 'developing'],
    ['awaiting_snapshot_ack', 'refining'],
    ['developing', 'dev_done'],
    ['dev_done', 'developing'],
    ['dev_done', 'awaiting_choice'],
  ] as const) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
  }
  assert.equal(canTransition('design_final', 'developing'), false);
  assert.equal(canTransition('dev_done', 'pr_opened'), false);
});

test('checklists: 22 default + 3 cross-repo items with fixed unique ids', () => {
  assert.equal(DEFAULT_CHECKLIST.length, 22);
  assert.equal(CROSS_REPO_CHECKLIST.length, 3);
  const ids = [...DEFAULT_CHECKLIST, ...CROSS_REPO_CHECKLIST].map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]{1,39}$/);
  assert.deepEqual(DEFAULT_CHECKLIST.slice(0, 3).map((i) => i.id), ['readability', 'maintainability', 'extensibility']);
  assert.deepEqual(CROSS_REPO_CHECKLIST.map((i) => i.id), ['api_contracts', 'rollout_order', 'versioning']);
  assert.ok(CROSS_REPO_CHECKLIST.every((i) => i.group === 'cross_repo'));
  assert.equal(DEFAULT_CHECKLIST.filter((i) => i.group === 'edge_cases').length, 6);
});

test('coverage reports missing, unknown and duplicate ids', () => {
  const items: ChecklistItem[] = [
    { id: 'aa', group: 'principles', label: 'A' },
    { id: 'bb', group: 'principles', label: 'B' },
    { id: 'cc', group: 'principles', label: 'C' },
  ];
  assert.deepEqual(coverage([{ item: 'aa' }, { item: 'aa' }, { item: 'zz' }], items), {
    missing: ['bb', 'cc'],
    unknown: ['zz'],
    duplicate: ['aa'],
  });
});

const fullChecklist = (items: readonly ChecklistItem[]) =>
  items.map((i) => ({ item: i.id, status: 'considered' as const, conclusion: 'ok' }));

const doc = (over: Record<string, unknown> = {}) => ({
  contentMd: '# Design',
  repos: [{ repo: 'api', contentMd: 'api part' }],
  checklist: fullChecklist(DEFAULT_CHECKLIST),
  responses: [],
  ...over,
});

test('designDocSchema accepts a complete doc', () => {
  assert.ok(designDocSchema(DEFAULT_CHECKLIST, [], ['api']).parse(doc()));
});

test('designDocSchema names missing checklist items', () => {
  const s = designDocSchema(DEFAULT_CHECKLIST, [], ['api']);
  assert.throws(() => s.parse(doc({ checklist: fullChecklist(DEFAULT_CHECKLIST).slice(1) })), /readability/);
  assert.throws(
    () => s.parse(doc({ checklist: [...fullChecklist(DEFAULT_CHECKLIST), { item: 'vibes', status: 'considered', conclusion: 'x' }] })),
    /vibes/,
  );
  assert.throws(
    () => s.parse(doc({ checklist: [...fullChecklist(DEFAULT_CHECKLIST), { item: 'dry', status: 'considered', conclusion: 'x' }] })),
    /dry/,
  );
});

test('designDocSchema rejects a blank conclusion', () => {
  const cl = fullChecklist(DEFAULT_CHECKLIST);
  cl[0] = { ...cl[0]!, conclusion: '' };
  assert.throws(() => designDocSchema(DEFAULT_CHECKLIST, [], ['api']).parse(doc({ checklist: cl })));
  cl[0] = { ...cl[0]!, conclusion: '   ' };
  assert.throws(() => designDocSchema(DEFAULT_CHECKLIST, [], ['api']).parse(doc({ checklist: cl })));
});

test('designDocSchema requires exactly the affected repos', () => {
  const items = [...DEFAULT_CHECKLIST, ...CROSS_REPO_CHECKLIST];
  const s = designDocSchema(items, [], ['api', 'web']);
  assert.throws(() => s.parse(doc({ checklist: fullChecklist(items) })), /web/);
  assert.throws(
    () =>
      s.parse(
        doc({
          checklist: fullChecklist(items),
          repos: [
            { repo: 'api', contentMd: 'a' },
            { repo: 'web', contentMd: 'w' },
            { repo: 'billing', contentMd: 'b' },
          ],
        }),
      ),
    /billing/,
  );
  assert.ok(
    s.parse(
      doc({
        checklist: fullChecklist(items),
        repos: [
          { repo: 'api', contentMd: 'a' },
          { repo: 'web', contentMd: 'w' },
        ],
      }),
    ),
  );
});

test('designDocSchema requires exactly one response per mustAnswer comment', () => {
  const s = designDocSchema(DEFAULT_CHECKLIST, ['C-1'], ['api']);
  assert.throws(() => s.parse(doc()), /C-1/);
  const r = { commentId: 'C-1', verdict: 'accepted', reason: 'fair' };
  assert.ok(s.parse(doc({ responses: [r] })));
  assert.throws(() => s.parse(doc({ responses: [r, r] })), /C-1/);
  assert.throws(() => s.parse(doc({ responses: [{ ...r, reason: ' ' }] })));
});

test('designDocSchema ignores responses to comments outside mustAnswer (Task 2 carry: "answer at least these ids")', () => {
  const r = { commentId: 'C-1', verdict: 'accepted', reason: 'fair' };
  const extra = { commentId: 'C-9', verdict: 'rebutted', reason: 'old comment' };
  assert.ok(designDocSchema(DEFAULT_CHECKLIST, ['C-1'], ['api']).parse(doc({ responses: [r, extra] })));
  assert.ok(designDocSchema(DEFAULT_CHECKLIST, [], ['api']).parse(doc({ responses: [extra] })));
});

const critique = (over: Record<string, unknown> = {}) => ({
  comments: [
    { id: 'C-1', checklistItem: 'security', repo: 'api', blocking: true, text: 'auth?', suggestion: null },
    ...((over.extra as unknown[]) ?? []),
  ],
  coverage: DEFAULT_CHECKLIST.map((i) => ({ item: i.id, status: 'ok', note: 'fine' })),
});

test('critiqueSchema validates checklist items, repos, ids and coverage', () => {
  const s = critiqueSchema(DEFAULT_CHECKLIST, ['api']);
  assert.ok(s.parse(critique()));
  assert.throws(
    () => s.parse(critique({ extra: [{ id: 'C-2', checklistItem: 'vibes', repo: null, blocking: false, text: 't', suggestion: null }] })),
    /vibes/,
  );
  assert.throws(
    () => s.parse(critique({ extra: [{ id: 'C-2', checklistItem: 'dry', repo: 'billing', blocking: false, text: 't', suggestion: null }] })),
    /billing/,
  );
  assert.throws(
    () => s.parse(critique({ extra: [{ id: 'C-1', checklistItem: 'dry', repo: null, blocking: false, text: 't', suggestion: null }] })),
    /C-1/,
  );
  assert.throws(() => s.parse({ ...critique(), coverage: critique().coverage.slice(1) }), /readability/);
  assert.throws(
    () => s.parse(critique({ extra: [{ id: 'X1', checklistItem: 'dry', repo: null, blocking: false, text: 't', suggestion: null }] })),
  );
});

const sol = (over: Record<string, unknown> = {}) => ({
  title: 'A',
  approach: 'a',
  changeScope: [],
  pros: [],
  cons: [],
  risks: [],
  complexity: 'S',
  affectedRepos: ['api'],
  repoChanges: [{ repo: 'api', summary: 'add endpoint' }],
  ...over,
});

test('proposeResultSchema restricts affected repos to mapped names', () => {
  const s = proposeResultSchema(['api']);
  assert.ok(s.parse({ solutions: [sol()] }));
  assert.throws(() => s.parse({ solutions: [sol({ affectedRepos: ['web'], repoChanges: [{ repo: 'web', summary: 's' }] })] }), /web/);
  assert.throws(() => s.parse({ solutions: [sol({ affectedRepos: [], repoChanges: [] })] }));
  assert.throws(() => s.parse({ solutions: [] }));
});

test('Solution requires unique affected repos matched one-to-one by repoChanges', () => {
  assert.throws(() => Solution.parse(sol({ affectedRepos: ['api', 'api'], repoChanges: [{ repo: 'api', summary: 's' }, { repo: 'api', summary: 's' }] })));
  assert.throws(() => Solution.parse(sol({ repoChanges: [] })));
  assert.throws(() => Solution.parse(sol({ repoChanges: [{ repo: 'web', summary: 's' }] })));
  assert.throws(() => RepoName.parse('Api'));
  assert.throws(() => RepoName.parse('-api'));
  assert.ok(RepoName.parse('api.v2_x-1'));
});

test('StoredSolution reads phase-1 records without repos', () => {
  const { affectedRepos: _a, repoChanges: _r, ...phase1 } = sol();
  const s = StoredSolution.parse(phase1);
  assert.deepEqual(s.affectedRepos, []);
  assert.deepEqual(s.repoChanges, []);
});

test('Ruling: custom needs a note', () => {
  assert.throws(() => Ruling.parse({ commentId: 'C-1', decision: 'custom', note: ' ' }));
  assert.ok(Ruling.parse({ commentId: 'C-1', decision: 'custom', note: 'do X' }));
  assert.ok(Ruling.parse({ commentId: 'C-1', decision: 'designer', note: '' }));
});

test('DevStepResult commit message is a single line of 1..72 chars', () => {
  const base = { summary: 's', commitMessage: 'add csv export', done: false, testsRun: [{ repo: 'api', command: 'pnpm test', passed: true }], notes: '' };
  assert.ok(DevStepResult.parse(base));
  assert.throws(() => DevStepResult.parse({ ...base, commitMessage: 'line one\nline two' }));
  assert.throws(() => DevStepResult.parse({ ...base, commitMessage: 'x'.repeat(73) }));
  assert.ok(DevStepResult.parse({ ...base, commitMessage: 'x'.repeat(72) }));
  assert.throws(() => DevStepResult.parse({ ...base, commitMessage: '' }));
  // Task 2 carry: a leading ticket key is stripped by the server, not rejected here ("UTF-8 …" is a valid message)
  assert.ok(DevStepResult.parse({ ...base, commitMessage: 'UTF-8 safe CSV export' }));
  assert.ok(DevStepResult.parse({ ...base, commitMessage: 'PROJ-12 add csv export' }));
});

test('JiraUpdateResult', () => {
  assert.ok(JiraUpdateResult.parse({ loginRequired: false, outcome: 'already_in_status', observedStatus: 'In Progress', detail: '' }));
  assert.throws(() => JiraUpdateResult.parse({ loginRequired: false, outcome: 'maybe', observedStatus: null, detail: '' }));
});

test('FetchedTicket from phase 1 gets status null', () => {
  const f = FetchedTicket.parse({ loginRequired: false, key: 'P-1', title: 't', description: 'd', jiraUpdatedAt: null, comments: [], attachments: [] });
  assert.equal(f.status, null);
});

test('disagreements: all blocking comments of the last critic round with designer verdicts', () => {
  const c = (id: string, blocking: boolean) => ({ id, checklistItem: 'security', repo: null, blocking, text: `t${id}`, suggestion: null });
  const cov = DEFAULT_CHECKLIST.map((i) => ({ item: i.id, status: 'ok' as const, note: 'n' }));
  const rounds: DebateRoundRecord[] = [
    { id: 1, choiceId: 1, designDocId: 1, round: 1, role: 'critic', content: { comments: [c('C-1', true)], coverage: cov }, createdAt: 't' },
    { id: 2, choiceId: 1, designDocId: 1, round: 1, role: 'designer', content: { responses: [{ commentId: 'C-1', verdict: 'accepted', reason: 'r' }] }, createdAt: 't' },
    {
      id: 5, choiceId: 1, designDocId: 2, round: 3, role: 'critic',
      content: { comments: [c('C-7', true), c('C-8', true), c('C-9', false)], coverage: cov }, createdAt: 't',
    },
    {
      id: 6, choiceId: 1, designDocId: 2, round: 3, role: 'designer',
      content: { responses: [{ commentId: 'C-7', verdict: 'accepted', reason: 'ok' }, { commentId: 'C-8', verdict: 'rebutted', reason: 'no' }] }, createdAt: 't',
    },
  ];
  const d = disagreements(rounds);
  assert.equal(d.length, 2);
  assert.deepEqual(d.map((x) => [x.roundId, x.commentId, x.designer?.verdict]), [
    [5, 'C-7', 'accepted'],
    [5, 'C-8', 'rebutted'],
  ]);
  assert.deepEqual(d[1]!.critic, { text: 'tC-8', suggestion: null });
  assert.equal(disagreements(rounds.slice(0, 1))[0]!.designer, null);
  assert.deepEqual(disagreements([]), []);
});

test('repoStatus derivation order and repoReady', () => {
  const ok: TestRun = { command: 'pnpm test', exitCode: 0, timedOut: false, outputTail: '' };
  const bad: TestRun = { ...ok, exitCode: 1 };
  const base = { running: false, pending: false, hasTestCommand: true, lastTests: [ok], lastCommit: { kind: 'committed', sha: 'abc' } as const };
  assert.equal(repoStatus(base), 'green');
  assert.equal(repoStatus({ ...base, running: true }), 'working');
  assert.equal(
    repoStatus({ ...base, lastTests: [bad], lastCommit: { kind: 'hook_failed', timedOut: false, outputTail: 'x' } }),
    'hook_failed',
  );
  assert.equal(repoStatus({ ...base, lastTests: [{ ...ok, exitCode: null, timedOut: true }] }), 'failing');
  assert.equal(repoStatus({ ...base, lastTests: [bad], lastCommit: { kind: 'skipped_checks_failed' }, pending: true }), 'failing');
  assert.equal(repoStatus({ ...base, pending: true }), 'working');
  const notRun = repoStatus({ running: false, pending: false, hasTestCommand: false, lastTests: null, lastCommit: null });
  assert.equal(notRun, 'not_run');
  // a repo with a test command whose tests have not run (yet) is never shown as passing
  assert.equal(repoStatus({ ...base, lastTests: null }), 'not_run');
  assert.equal(repoStatus({ ...base, lastTests: [] }), 'not_run');
  assert.equal(repoReady(notRun), true);
  assert.equal(repoReady('green'), true);
  for (const s of ['failing', 'hook_failed', 'working'] as const) assert.equal(repoReady(s), false);
});

// ---------------------------------------------------------------- phase 3

import { acceptanceResultSchema, JiraCommentResult } from '../src/index.ts';

test('phase 3 transitions', () => {
  for (const [from, to] of [
    ['dev_done', 'reviewing'],
    ['reviewing', 'awaiting_review_ack'],
    ['reviewing', 'awaiting_confirmation'],
    ['reviewing', 'developing'],
    ['awaiting_review_ack', 'reviewing'],
    ['awaiting_review_ack', 'refining'],
    ['developing', 'reviewing'],
    ['awaiting_confirmation', 'developing'],
    ['awaiting_confirmation', 'reviewing'],
    ['awaiting_confirmation', 'delivering'],
    ['delivering', 'awaiting_confirmation'],
    ['delivering', 'pr_opened'],
  ] as const) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
  }
  for (const [from, to] of [
    ['reviewing', 'pr_opened'],
    ['dev_done', 'awaiting_confirmation'],
    ['pr_opened', 'reviewing'],
    ['awaiting_confirmation', 'pr_opened'],
    ['awaiting_review_ack', 'developing'],
  ] as const) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
  }
  // still phase-2 rules
  assert.equal(canTransition('developing', 'dev_done'), true);
  assert.equal(canTransition('delivering', 'blocked'), true);
});

const flow = (kind: 'happy' | 'error' | 'edge', over: Record<string, unknown> = {}) => ({
  kind,
  title: `${kind} flow`,
  steps: ['open the page'],
  expected: 'shown',
  actual: 'shown',
  tests: ['specs/a.spec.mjs › ok'],
  evidence: [{ kind: 'attachment', test: 'specs/a.spec.mjs › ok', name: 'screenshot', caption: 'the page' }],
  ...over,
});
const ac = (acId: string, over: Record<string, unknown> = {}) => ({
  acId,
  verdict: 'pass',
  flows: [flow('happy'), flow('error'), flow('edge')],
  note: '',
  ...over,
});
const result = (acs: unknown[]) => ({ summary: 'all good', acs });

function rejects(schema: { safeParse(v: unknown): { success: boolean; error?: unknown } }, v: unknown, needle: string | null) {
  const r = schema.safeParse(v);
  assert.equal(r.success, false, `expected rejection${needle ? ` mentioning ${needle}` : ''}`);
  if (needle) assert.match(String(r.error), new RegExp(needle));
}

test('acceptanceResultSchema accepts one complete entry per AC', () => {
  const schema = acceptanceResultSchema(['AC-1', 'AC-2']);
  const ok = schema.parse(result([ac('AC-1'), ac('AC-2', { verdict: 'fail' })]));
  assert.equal(ok.acs.length, 2);
  // no edge flow is fine when the note says why
  schema.parse(result([ac('AC-1', { flows: [flow('happy'), flow('error')], note: 'no relevant boundary' }), ac('AC-2')]));
  // the fallback evidence kind
  schema.parse(
    result([
      ac('AC-1', { flows: [flow('happy', { evidence: [{ kind: 'file', path: 'evidence/ac-1/shot_1.png', caption: 'c' }] }), flow('error'), flow('edge')] }),
      ac('AC-2', { flows: [flow('happy', { evidence: [{ kind: 'file', path: 'evidence/b.jpeg', caption: 'c' }] }), flow('error'), flow('edge')] }),
    ]),
  );
});

test('acceptanceResultSchema requires exactly one entry per AC id', () => {
  const schema = acceptanceResultSchema(['AC-1', 'AC-2']);
  rejects(schema, result([ac('AC-1')]), 'AC-2');
  rejects(schema, result([ac('AC-1'), ac('AC-2'), ac('AC-9')]), 'AC-9');
  rejects(schema, result([ac('AC-1'), ac('AC-2'), ac('AC-1')]), 'AC-1');
});

test('acceptanceResultSchema requires happy and error flows, and a note when there is no edge flow', () => {
  const schema = acceptanceResultSchema(['AC-1']);
  rejects(schema, result([ac('AC-1', { flows: [flow('happy'), flow('edge')] })]), 'error flow');
  rejects(schema, result([ac('AC-1', { flows: [flow('error'), flow('edge')] })]), 'happy flow');
  rejects(schema, result([ac('AC-1', { flows: [flow('happy'), flow('error')], note: '' })]), 'edge flow');
  rejects(schema, result([ac('AC-1', { flows: [flow('happy'), flow('error')], note: '   ' })]), 'edge flow');
});

test('acceptanceResultSchema: evidence paths stay inside evidence/, every flow has tests and evidence', () => {
  const schema = acceptanceResultSchema(['AC-1']);
  for (const path of ['../x.png', 'evidence/../../x.png', '/tmp/x.png', 'evidence/x.svg', 'evidence/a/../../x.png', 'evidence/.png',
    'evidence/./x.png', 'evidence//x.png', 'evidence/a/./b.png', 'evidence/a/.png', 'evidence/.hidden.png', 'evidence\\x.png', 'evidence/%2e%2e/x.png']) {
    rejects(schema, result([ac('AC-1', { flows: [flow('happy', { evidence: [{ kind: 'file', path, caption: 'c' }] }), flow('error'), flow('edge')] })]), null);
  }
  rejects(schema, result([ac('AC-1', { flows: [flow('happy', { evidence: [] }), flow('error'), flow('edge')] })]), null);
  rejects(schema, result([ac('AC-1', { flows: [flow('happy', { tests: [] }), flow('error'), flow('edge')] })]), null);
  rejects(schema, result([ac('AC-1', { flows: [flow('happy', { steps: [] }), flow('error'), flow('edge')] })]), null);
  rejects(schema, result([ac('AC-1', { verdict: 'not_tested' })]), null);
});

test('JiraCommentResult', () => {
  assert.deepEqual(JiraCommentResult.parse({ loginRequired: false, outcome: 'posted', detail: '' }), {
    loginRequired: false,
    outcome: 'posted',
    detail: '',
  });
  assert.equal(JiraCommentResult.safeParse({ loginRequired: false, outcome: 'changed', detail: '' }).success, false);
});

test('phase 4d (D-2): newDependencies is optional on agent output, read as [] from older records, and bounded', () => {
  assert.equal(Solution.parse(sol()).newDependencies, undefined);
  assert.deepEqual(StoredSolution.parse(sol()).newDependencies, []);
  assert.deepEqual(StoredSolution.parse(sol({ newDependencies: ['left-pad'] })).newDependencies, ['left-pad']);
  assert.deepEqual(Solution.parse(sol({ newDependencies: ['redis'] })).newDependencies, ['redis']);
  assert.throws(() => Solution.parse(sol({ newDependencies: [''] })));
  assert.throws(() => Solution.parse(sol({ newDependencies: ['x'.repeat(101)] })));
  assert.throws(() => Solution.parse(sol({ newDependencies: Array.from({ length: 21 }, (_, i) => `d${i}`) })));
  assert.ok(proposeResultSchema(['api']).parse({ solutions: [sol({ newDependencies: ['x'.repeat(100)] })] }));
});

// ---------------------------------------------------------------- phase 4f (Task 2): cases and case evidence

import { AcceptanceCase, CaseResult } from '../src/index.ts';

const kase = (o: Record<string, unknown> = {}) => ({ name: 'list-empty', acId: 'AC-1', kind: 'happy', title: 'Lists nothing', args: ['list'], expect: { exitCode: 0 }, ...o });

test('phase 4f: AcceptanceCase parses a declared case; names, args, stdin and env are bounded', () => {
  const c = AcceptanceCase.parse(kase({ stdin: 'yes\n', env: { COLOR: 'never' }, files: { 'in.txt': 'a', 'data/b.json': '{}', '.toolrc': 'x' }, expect: { exitCode: 2, stdoutIncludes: ['usage'], stderrIncludes: [], stdoutMatches: '^Usage: \\w+' } }));
  assert.equal(c.name, 'list-empty');
  assert.deepEqual(AcceptanceCase.parse(kase({ example: 'slugify-basic.mjs' })).example, 'slugify-basic.mjs');
  for (const name of ['', 'List', '-x', 'a b', 'a_b', 'x'.repeat(65), '../x']) assert.throws(() => AcceptanceCase.parse(kase({ name })), name);
  assert.throws(() => AcceptanceCase.parse(kase({ kind: 'other' })));
  assert.throws(() => AcceptanceCase.parse(kase({ args: ['a\0b'] })));
  assert.throws(() => AcceptanceCase.parse(kase({ args: ['x'.repeat(2001)] })));
  assert.throws(() => AcceptanceCase.parse(kase({ args: Array.from({ length: 51 }, () => 'a') })));
  AcceptanceCase.parse(kase({ args: ['x; touch /tmp/pwned', '$(id)', '`id`', 'a\nb'] }));
  assert.throws(() => AcceptanceCase.parse(kase({ stdin: 'x'.repeat(64 * 1024 + 1) })));
  for (const env of [{ PATH: '/x' }, { HOME: '/x' }, { NODE_OPTIONS: '--require x' }, { SLACKOFF_HOME: 'x' }, { lower: 'x' }, { A: 'a b' }, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`K${i}`, 'v']))]) {
    assert.throws(() => AcceptanceCase.parse(kase({ env })), JSON.stringify(env).slice(0, 60));
  }
  for (const example of ['x.js', '../x.mjs', 'a/b.mjs', 'X.mjs', '.mjs']) assert.throws(() => AcceptanceCase.parse(kase({ example })), example);
});

test('phase 4f: AcceptanceCase: stdoutMatches must compile; files never leave the work dir', () => {
  assert.throws(() => AcceptanceCase.parse(kase({ expect: { stdoutMatches: '(' } })));
  assert.throws(() => AcceptanceCase.parse(kase({ expect: { stdoutMatches: 'x'.repeat(201) } })));
  for (const p of ['../x', 'a/../../x', '/etc/passwd', 'a//b', './x', 'a/./b', '', 'a\\b', '.git/config', 'a/.GIT/x', 'a\0b', 'dir/']) {
    assert.throws(() => AcceptanceCase.parse(kase({ files: { [p]: 'x' } })), JSON.stringify(p));
  }
  assert.throws(() => AcceptanceCase.parse(kase({ files: { 'big.txt': 'x'.repeat(64 * 1024 + 1) } })));
  assert.throws(() => AcceptanceCase.parse(kase({ files: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}.txt`, 'x'])) })));
});

test('phase 4f: CaseResult shape', () => {
  const r = { name: 'list-empty', passed: false, exitCode: null, timedOut: true, durationMs: 1000, stdoutTail: '', stderrTail: '', truncated: false, failures: ['timed out'] };
  assert.deepEqual(CaseResult.parse(r), r);
});

test('phase 4f: acceptanceResultSchema accepts {kind: "case"} evidence naming a case', () => {
  const schema = acceptanceResultSchema(['AC-1']);
  schema.parse(result([ac('AC-1', { flows: [flow('happy', { tests: ['list-empty'], evidence: [{ kind: 'case', case: 'list-empty', caption: 'the empty list' }] }), flow('error'), flow('edge')] })]));
  rejects(schema, result([ac('AC-1', { flows: [flow('happy', { evidence: [{ kind: 'case', case: '../x', caption: 'c' }] }), flow('error'), flow('edge')] })]), null);
});

test('ProposeResult: at most one solution is recommended, with its reason; StoredSolution reads older records as not recommended', () => {
  const sol = (over: Record<string, unknown> = {}) => ({
    title: 't', approach: 'a', changeScope: [], pros: [], cons: [], risks: [], complexity: 'S', affectedRepos: ['api'], repoChanges: [{ repo: 'api', summary: 's' }], ...over,
  });
  const ok = ProposeResult.parse({ solutions: [sol({ recommended: true, recommendationReason: 'Smallest change that meets every AC' }), sol()] });
  assert.equal(ok.solutions[0]!.recommended, true);
  assert.notEqual(ok.solutions[1]!.recommended, true);
  assert.throws(() => ProposeResult.parse({ solutions: [sol({ recommended: true }), sol({ recommended: true })] }), /at most one/);
  assert.equal(StoredSolution.parse(sol()).recommended, undefined);
});

test('DriftResult: optional suggested acknowledgement notes, each tied to an action, at most four', () => {
  const base = { baseline: [], current: [], contradictions: [] };
  assert.equal(DriftResult.parse(base).ackOptions, undefined);
  const withOptions = DriftResult.parse({
    ...base,
    ackOptions: [
      { label: 'Out of scope', text: 'D-2 is out of scope for this ticket — agreed with the reporter.', recommended: true, action: 'acknowledge' },
      { label: 'Add an AC for D-2', text: 'Add an AC for the icon position before development.', recommended: false, action: 'revise' },
    ],
  });
  assert.equal(withOptions.ackOptions!.length, 2);
  assert.throws(() => DriftResult.parse({ ...base, ackOptions: [{ label: 'x', text: 'y', recommended: false, action: 'delete' }] }));
});
