export type TicketState =
  | 'discovered'
  | 'refining'
  | 'refined'
  | 'awaiting_ac_review'
  | 'checking_drift'
  | 'awaiting_drift_ack'
  | 'proposing'
  | 'awaiting_choice'
  | 'designing'
  | 'awaiting_debate_ruling'
  | 'design_final'
  | 'checking_snapshot'
  | 'awaiting_snapshot_ack'
  | 'developing'
  | 'dev_done'
  | 'reviewing'
  | 'awaiting_review_ack'
  | 'awaiting_confirmation'
  | 'delivering'
  | 'pr_opened'
  | 'blocked'
  | 'abandoned';

const TERMINAL: ReadonlySet<TicketState> = new Set(['pr_opened', 'abandoned']);

const TABLE: Partial<Record<TicketState, readonly TicketState[]>> = {
  discovered: ['refining'],
  refining: ['refined'],
  refined: ['awaiting_ac_review', 'proposing', 'refining'],
  awaiting_ac_review: ['checking_drift', 'proposing', 'refining'],
  checking_drift: ['awaiting_drift_ack', 'awaiting_ac_review', 'proposing'],
  awaiting_drift_ack: ['proposing', 'awaiting_ac_review'],
  proposing: ['awaiting_choice'],
  awaiting_choice: ['designing', 'refining'],
  designing: ['design_final', 'awaiting_debate_ruling'],
  // designing: the designer applies non-"designer" rulings, then the design is finalized.
  // awaiting_choice: the developer changes the chosen solution (debate restarts).
  awaiting_debate_ruling: ['designing', 'design_final', 'awaiting_choice'],
  design_final: ['checking_snapshot'],
  checking_snapshot: ['awaiting_snapshot_ack', 'developing'],
  awaiting_snapshot_ack: ['developing', 'refining'],
  // reviewing: a review_failed / rejected fix iteration finished and goes straight back to acceptance.
  developing: ['dev_done', 'reviewing'],
  // developing: the developer requests changes; awaiting_choice: change the chosen solution; reviewing: hand off to acceptance.
  dev_done: ['developing', 'awaiting_choice', 'reviewing'],
  // awaiting_review_ack: the pre-acceptance drift check needs an ack; awaiting_confirmation: a report is ready;
  // developing: acceptance failed and an automatic fix iteration starts.
  reviewing: ['awaiting_review_ack', 'awaiting_confirmation', 'developing'],
  awaiting_review_ack: ['reviewing', 'refining'],
  // developing: reject; reviewing: re-review; delivering: confirm and deliver.
  awaiting_confirmation: ['developing', 'reviewing', 'delivering'],
  // pr_opened: every PR is open (the JIRA steps after it are recorded separately);
  // awaiting_confirmation: the snapshot re-read before opening PRs found drift that needs an ack.
  delivering: ['pr_opened', 'awaiting_confirmation'],
};

export function canTransition(from: TicketState, to: TicketState): boolean {
  if (TERMINAL.has(from)) return false;
  if (to === 'blocked') return from !== 'blocked';
  if (to === 'abandoned') return true;
  // blocked -> previous state: prev_state equality is enforced by the repository.
  if (from === 'blocked') return !TERMINAL.has(to);
  return TABLE[from]?.includes(to) ?? false;
}
